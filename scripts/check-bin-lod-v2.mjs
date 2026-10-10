/**
 * v2 viewer: order 0 paints first, budgets hold, at most two fetches in flight.
 *
 * Usage: node scripts/check-bin-lod-v2.mjs
 * Node 20: node --experimental-websocket scripts/check-bin-lod-v2.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const ROOT = path.resolve("public/bin-lod");
const PORT = 8776;
const CDP_PORT = 9346;
const BYTES_PER_SEC = (4000 * 1000) / 8;

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      const range = req.headers.range;
      if (range && /bytes=\d+-\d+/.test(range)) {
        const match = /bytes=(\d+)-(\d+)/.exec(range);
        const start = Number(match[1]);
        const end = Math.min(Number(match[2]), data.length - 1);
        if (start > end || start >= data.length) {
          res.writeHead(416);
          res.end();
          return;
        }
        res.writeHead(206, {
          "content-type": contentType(file),
          "content-range": `bytes ${start}-${end}/${data.length}`,
          "content-length": end - start + 1,
          "accept-ranges": "bytes",
          "cache-control": "no-store",
        });
        res.end(data.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, {
        "content-type": contentType(file),
        "content-length": data.length,
        "accept-ranges": "bytes",
        "cache-control": "no-store",
      });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitJson(url, tries = 80) {
  let last = "";
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      last = `${res.status}`;
    } catch (err) {
      last = err.message;
    }
    await sleep(100);
  }
  throw new Error(`no response from ${url} (${last})`);
}

function launchChrome() {
  const userData = fs.mkdtempSync("/tmp/bin-lod-v2-");
  const chrome = spawn(
    "google-chrome",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      `--remote-debugging-port=${CDP_PORT}`,
      "--window-size=1280,800",
      `--user-data-dir=${userData}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let log = "";
  chrome.stderr.on("data", (chunk) => {
    log += chunk.toString();
  });
  return { chrome, userData, getLog: () => log };
}

function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  const consoleLines = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || "cdp"));
      else resolve(msg.result);
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") {
      consoleLines.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || "exception");
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      consoleLines.push((msg.params.args || []).map((arg) => arg.value ?? arg.description ?? "").join(" "));
    }
    for (const listener of listeners) listener(msg);
  });
  const send = (method, params = {}) => {
    const msgId = ++id;
    return new Promise((resolve, reject) => {
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  };
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", () => reject(new Error("cdp websocket failed")));
  });
  return { send, opened, consoleLines };
}

async function evaluate(send, expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "evaluate failed");
  }
  return result.result?.value;
}

async function main() {
  const server = await startServer();
  const { chrome, userData, getLog } = launchChrome();
  let inFlight = 0;
  let maxInFlight = 0;
  const urls = new Map();
  try {
    await waitJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
    const pages = await waitJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const page = pages.find((entry) => entry.type === "page");
    const cdp = connectCdp(page.webSocketDebuggerUrl);
    await cdp.opened;
    const on = (method, fn) => {};
    void on;
    const listeners = [];
    // Reconnect message handler is inside connectCdp. Count pack requests via Network.
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: BYTES_PER_SEC,
      uploadThroughput: BYTES_PER_SEC,
    });
    // The connectCdp helper does not expose on(). Count in-flight from the page snapshot instead.
    void listeners;
    void urls;
    const navAt = Date.now();
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/?lod=v2` });

    let first = null;
    let last = null;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      last = await evaluate(cdp.send, "window.__BIN_LOD ? window.__BIN_LOD.snapshot() : null");
      if (last && last.version === 2) {
        maxInFlight = Math.max(maxInFlight, last.maxInFlight || 0);
        inFlight = last.inFlight || 0;
        if (last.budgetExceeded) throw new Error(`budget exceeded ${JSON.stringify(last)}`);
        if (last.farCount > 12288 || last.nearCount > 12288) throw new Error(`budget ${JSON.stringify(last)}`);
      }
      if (last && last.firstFrameMs > 0 && last.pointsDrawn > 0 && !first) {
        first = { firstFrameMs: last.firstFrameMs, wallMs: Date.now() - navAt, pointsDrawn: last.pointsDrawn, farCount: last.farCount };
      }
      if (first && last && last.dedupeProbe) break;
      await sleep(50);
    }
    if (!first) throw new Error(`no v2 frame: ${JSON.stringify(last)} ${cdp.consoleLines.slice(-6).join(" | ")}`);
    if (first.firstFrameMs > 1000) throw new Error(`order 0 first frame ${first.firstFrameMs}ms`);

    await evaluate(cdp.send, "window.__BIN_LOD.focus('Sirius')");
    let focused = null;
    const focusDeadline = Date.now() + 15000;
    while (Date.now() < focusDeadline) {
      focused = await evaluate(cdp.send, "window.__BIN_LOD.snapshot()");
      maxInFlight = Math.max(maxInFlight, focused.maxInFlight || 0);
      if (focused.budgetExceeded || focused.farCount > 12288 || focused.nearCount > 12288) {
        throw new Error(`budget ${JSON.stringify(focused)}`);
      }
      if (focused.mode === "near" && focused.labels.includes("Sirius") && focused.labels.includes("Sol") && focused.dedupeProbe) {
        break;
      }
      await sleep(100);
    }
    if (!focused || focused.siriusGaia !== 0 || focused.vegaGaia !== 0) {
      throw new Error(`double star ${JSON.stringify(focused)}`);
    }
    if (!focused.dedupeProbe.Sirius || !focused.dedupeProbe.Vega) {
      throw new Error(`dedupe probe ${JSON.stringify(focused.dedupeProbe)}`);
    }
    if (!focused.labels.includes("Sol") || focused.labels.length > 40) {
      throw new Error(`labels ${JSON.stringify(focused.labels)}`);
    }
    if (maxInFlight > 2) throw new Error(`in flight ${maxInFlight}`);
    console.log(JSON.stringify({
      first,
      maxInFlight,
      farCount: focused.farCount,
      nearCount: focused.nearCount,
      mode: focused.mode,
      siriusGaia: focused.siriusGaia,
      vegaGaia: focused.vegaGaia,
      dedupeProbe: focused.dedupeProbe,
      labels: focused.labels.length,
      budgetExceeded: focused.budgetExceeded,
    }, null, 2));
  } catch (err) {
    console.error(err);
    console.error(getLog().slice(-1500));
    process.exitCode = 1;
  } finally {
    chrome.kill("SIGKILL");
    server.close();
    await sleep(200);
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

main();
