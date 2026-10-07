/**
 * Time-to-first-frame under one shared network pipe.
 *
 * DevTools network emulation: 4000 kbps (500000 bytes/s) aggregate
 * download and upload, 0 ms extra latency. No per-tile delays.
 *
 * Usage: node scripts/check-bin-lod-throttle.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const ROOT = path.resolve("public/bin-lod");
const PORT = 8765;
const CDP_PORT = 9334;
const TOTAL_RECORDS = 639404;
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
      res.writeHead(200, {
        "content-type": contentType(file),
        "cache-control": "no-store",
        "content-length": data.length,
      });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
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
  const userData = fs.mkdtempSync("/tmp/bin-lod-throttle-");
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
      if (msg.error) reject(new Error(`${msg.error.message || "cdp"} ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") {
      consoleLines.push(
        `exception: ${msg.params.exceptionDetails?.text || ""} ${msg.params.exceptionDetails?.exception?.description || ""}`
      );
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      const text = (msg.params.args || []).map((arg) => arg.value ?? arg.description ?? "").join(" ");
      consoleLines.push(`error: ${text}`);
    }
    for (const listener of listeners) listener(msg);
  });

  function send(method, params = {}) {
    const msgId = ++id;
    return new Promise((resolve, reject) => {
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }

  function on(method, fn) {
    listeners.push((msg) => {
      if (msg.method === method) fn(msg.params);
    });
  }

  const opened = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", () => reject(new Error("cdp websocket failed")));
  });

  return { send, opened, on, consoleLines };
}

async function evaluate(send, expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(detail || "evaluate failed");
  }
  return result.result?.value;
}

async function main() {
  const server = await startServer();
  const { chrome, userData, getLog } = launchChrome();
  const urls = new Map();
  let totalBytes = 0;
  let tileBytes = 0;
  const tileBytesByFile = new Map();
  const finishedTiles = new Set();

  try {
    await waitJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
    const pages = await waitJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const page = pages.find((entry) => entry.type === "page");
    if (!page) throw new Error("chrome opened no page");
    const cdp = connectCdp(page.webSocketDebuggerUrl);
    await cdp.opened;
    cdp.on("Network.requestWillBeSent", (params) => {
      urls.set(params.requestId, params.request.url);
    });
    cdp.on("Network.dataReceived", (params) => {
      const url = urls.get(params.requestId) || "";
      const n = params.encodedDataLength || 0;
      totalBytes += n;
      if (/\/data\/tiles\/tile-.*\.bin(?:\?|$)/.test(url)) {
        tileBytes += n;
        const name = url.split("/").pop().split("?")[0];
        tileBytesByFile.set(name, (tileBytesByFile.get(name) || 0) + n);
      }
    });
    cdp.on("Network.loadingFinished", (params) => {
      const url = urls.get(params.requestId) || "";
      if (/\/data\/tiles\/tile-.*\.bin(?:\?|$)/.test(url)) {
        finishedTiles.add(url.split("/").pop().split("?")[0]);
      }
    });
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
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const navAt = Date.now();
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });

    let first = null;
    const firstDeadline = Date.now() + 180000;
    let last = null;
    while (Date.now() < firstDeadline) {
      last = await evaluate(cdp.send, "window.__BIN_LOD ? window.__BIN_LOD.snapshot() : null");
      if (last && last.firstFrameMs > 0 && last.pointsDrawn > 0) {
        first = {
          firstFrameMs: last.firstFrameMs,
          wallMs: Date.now() - navAt,
          pointsDrawn: last.pointsDrawn,
          loadedTiles: last.loadedTiles,
          records: last.records,
          paint: last.paints[0] || null,
          tileBytes,
          totalBytes,
          finishedTiles: [...finishedTiles],
          tileBytesByFile: Object.fromEntries(tileBytesByFile),
        };
        break;
      }
      await sleep(15);
    }
    if (!first) {
      throw new Error(`no first frame: ${JSON.stringify(last)} ${cdp.consoleLines.slice(-8).join(" | ")}`);
    }

    const doneDeadline = Date.now() + 240000;
    let full = null;
    while (Date.now() < doneDeadline) {
      full = await evaluate(cdp.send, "window.__BIN_LOD ? window.__BIN_LOD.snapshot() : null");
      if (full && full.streamDone && full.loadedTiles === 9 && full.records === TOTAL_RECORDS) break;
      await sleep(100);
    }
    if (!full || !full.streamDone || full.loadedTiles !== 9 || full.records !== TOTAL_RECORDS) {
      throw new Error(`catalog did not finish: ${JSON.stringify(full)}`);
    }

    const result = {
      label: process.env.LABEL || "run",
      sha256: null,
      throttle: "4000 kbps aggregate, 0 ms latency",
      first,
      final: {
        loadedTiles: full.loadedTiles,
        tileTotal: full.tileTotal,
        records: full.records,
        farCount: full.farCount,
        paints: full.paints.map((paint) => paint.id),
        errors: full.errors,
        wallMs: Date.now() - navAt,
        tileBytes,
        totalBytes,
      },
    };
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(err);
    console.error(getLog().slice(-2000));
    process.exitCode = 1;
  } finally {
    chrome.kill("SIGKILL");
    server.close();
    await sleep(300);
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main();
