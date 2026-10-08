/**
 * All-tiles-fail fallback.
 *
 * Serves preview.bin, then 404s every data/tiles/tile-*.bin. The viewer
 * should drop the preview and load data/catalog.bin. A second case also
 * 404s catalog.bin and expects a plain error with the preview not counted.
 *
 * Usage: node scripts/check-bin-lod-fallback.mjs
 * Node 20: node --experimental-websocket scripts/check-bin-lod-fallback.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const ROOT = path.resolve("public/bin-lod");
const CATALOG_RECORDS = fs.statSync(path.join(ROOT, "data", "catalog.bin")).size / 62;
const PORT = 8766;
const CDP_PORT = 9335;

const requests = [];
let failCatalog = false;

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
    const base = path.basename(file);
    const tileMiss = /\/data\/tiles\/tile-.*\.bin$/.test(rel);
    const catalogMiss = failCatalog && base === "catalog.bin";
    if (tileMiss || catalogMiss) {
      requests.push({ base, status: 404 });
      res.writeHead(404, { "cache-control": "no-store" });
      res.end("missing");
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        requests.push({ base, status: 404 });
        res.writeHead(404);
        res.end("missing");
        return;
      }
      requests.push({ base, status: 200 });
      res.writeHead(200, {
        "content-type": contentType(file),
        "cache-control": "no-store",
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

async function waitJson(url, tries = 50) {
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
  const userData = fs.mkdtempSync("/tmp/bin-lod-fallback-");
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
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || "cdp"));
      else resolve(msg.result);
    }
  });
  function send(method, params = {}) {
    const msgId = ++id;
    return new Promise((resolve, reject) => {
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", () => reject(new Error("cdp websocket failed")));
  });
  return { send, opened };
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

const PAGE_STATE = `(() => {
  const snap = window.__BIN_LOD ? window.__BIN_LOD.snapshot() : null;
  const status = document.getElementById("hud-status");
  const count = document.getElementById("draw-count");
  const mode = document.getElementById("lod-mode");
  return {
    snap,
    status: status ? status.textContent : "",
    statusError: status ? status.classList.contains("status-error") : false,
    countText: count ? count.textContent : "",
    modeText: mode ? mode.textContent : "",
  };
})()`;

async function pollPage(send, predicate, timeoutMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await evaluate(send, PAGE_STATE);
    if (last && predicate(last)) return last;
    await sleep(40);
  }
  throw new Error(`timed out waiting for viewer state: ${JSON.stringify(last)}`);
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function previewMentioned(text) {
  return /coarse sky preview|FAR preview/i.test(text);
}

async function openPage() {
  const launched = launchChrome();
  const version = await waitJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
  if (!version) throw new Error("chrome did not open a debugger");
  const pages = await waitJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const page = pages.find((entry) => entry.type === "page");
  if (!page) throw new Error("chrome opened no page");
  const cdp = connectCdp(page.webSocketDebuggerUrl);
  await cdp.opened;
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
  return { ...launched, send: cdp.send };
}

async function main() {
  if (!Number.isInteger(CATALOG_RECORDS) || CATALOG_RECORDS < 1000) {
    throw new Error(`unexpected catalog.bin length (${CATALOG_RECORDS} records)`);
  }
  const server = await startServer();
  try {
    requests.length = 0;
    failCatalog = false;
    const ok = await openPage();
    try {
      const page = await pollPage(
        ok.send,
        (state) =>
          state.snap &&
          state.snap.records === CATALOG_RECORDS &&
          state.snap.previewFarCount === 0 &&
          state.snap.farCount > 0 &&
          state.snap.pointsDrawn > 0 &&
          state.snap.tileTotal === 1 &&
          !previewMentioned(state.status),
        30000
      );
      assert(requests.some((req) => req.base === "preview.bin" && req.status === 200), "preview.bin was not served");
      const tileReqs = requests.filter((req) => /^tile-.*\.bin$/.test(req.base));
      assert(tileReqs.length >= 9, `expected every tile to be requested, saw ${tileReqs.map((req) => req.base).join(",")}`);
      assert(tileReqs.every((req) => req.status === 404), "a tile request was not forced to 404");
      assert(requests.some((req) => req.base === "catalog.bin" && req.status === 200), "catalog.bin fallback did not run");
      assert(page.snap.records === CATALOG_RECORDS, `records ${page.snap.records} are not catalog.bin`);
      assert(page.snap.previewFarCount === 0, "previewFarCount was still set after fallback");
      assert(page.snap.farCount > 0, "catalog.bin drew no FAR points");
      assert(!previewMentioned(page.status), `HUD still shows the preview: ${page.status}`);
      assert(!previewMentioned(page.countText), `count line still shows the preview: ${page.countText}`);
      console.log(JSON.stringify({
        catalogFallback: {
          records: page.snap.records,
          farCount: page.snap.farCount,
          previewFarCount: page.snap.previewFarCount,
          tileTotal: page.snap.tileTotal,
          status: page.status.slice(0, 180),
        },
      }, null, 2));
    } finally {
      ok.chrome.kill("SIGKILL");
      await sleep(300);
      fs.rmSync(ok.userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }

    requests.length = 0;
    failCatalog = true;
    const bad = await openPage();
    try {
      const page = await pollPage(
        bad.send,
        (state) =>
          state.statusError &&
          state.snap &&
          state.snap.previewFarCount === 0 &&
          state.snap.farCount === 0 &&
          state.snap.records === 0 &&
          state.snap.pointsDrawn === 0,
        20000
      );
      assert(requests.some((req) => req.base === "preview.bin" && req.status === 200), "preview.bin was not served in the error case");
      assert(requests.some((req) => req.base === "catalog.bin" && req.status === 404), "catalog.bin was not forced to fail");
      assert(page.statusError, "plain error was not shown");
      assert(/could not load/i.test(page.status), `error text missing: ${page.status}`);
      assert(page.snap.records === 0, `preview or other records were counted (${page.snap.records})`);
      assert(page.snap.previewFarCount === 0, "previewFarCount survived the error");
      assert(page.snap.farCount === 0, `preview FAR points were still reported (${page.snap.farCount})`);
      assert(!previewMentioned(page.status), `error HUD still describes the preview: ${page.status}`);
      assert(page.countText === "0 drawn", `count line counted the preview: ${page.countText}`);
      assert(page.modeText === "LOD error", `mode was ${page.modeText}`);
      console.log(JSON.stringify({
        catalogFailed: {
          records: page.snap.records,
          farCount: page.snap.farCount,
          previewFarCount: page.snap.previewFarCount,
          status: page.status.slice(0, 180),
          countText: page.countText,
          modeText: page.modeText,
        },
      }, null, 2));
    } finally {
      bad.chrome.kill("SIGKILL");
      await sleep(300);
      fs.rmSync(bad.userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
