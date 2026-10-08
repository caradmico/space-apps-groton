/**
 * Error text names the file that failed.
 *
 * Case 1: HTTP 404 for data/tiles/tile-003.bin only. The HUD and errors
 * list name that file and 404, do not mention tiles.json, and the other
 * eight tiles still load.
 * Case 2: HTTP 404 for tiles.json. The error names tiles.json and 404.
 *
 * Usage: node scripts/check-bin-lod-errors.mjs
 * Node 20: node --experimental-websocket scripts/check-bin-lod-errors.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const ROOT = path.resolve("public/bin-lod");
const INDEX = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "tiles.json"), "utf8"));
const CATALOG_RECORDS = fs.statSync(path.join(ROOT, "data", "catalog.bin")).size / 62;
const MISSING_TILE = "tile-003.bin";
const MISSING_RECORDS = INDEX.tiles.find((tile) => tile.id === "tile-003").n_records;
const EIGHT_RECORDS = INDEX.total_records - MISSING_RECORDS;
const PORT = 8767;
const CDP_PORT = 9336;

const requests = [];
let mode = "tile";

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
    const missTile = mode === "tile" && base === MISSING_TILE && rel.includes("/data/tiles/");
    const missIndex = mode === "index" && base === "tiles.json";
    if (missTile || missIndex) {
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
  const userData = fs.mkdtempSync("/tmp/bin-lod-errors-");
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
  return { chrome, userData };
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
  return {
    snap,
    status: status ? status.textContent : "",
    statusError: status ? status.classList.contains("status-error") : false,
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

async function openPage() {
  const launched = launchChrome();
  await waitJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
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

async function closeChrome(opened) {
  opened.chrome.kill("SIGKILL");
  await sleep(300);
  fs.rmSync(opened.userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function main() {
  const server = await startServer();
  try {
    requests.length = 0;
    mode = "tile";
    const tileCase = await openPage();
    try {
      const page = await pollPage(
        tileCase.send,
        (state) =>
          state.snap &&
          state.snap.streamDone &&
          state.snap.loadedTiles === 8 &&
          state.snap.records === EIGHT_RECORDS &&
          state.snap.errors.some((err) => err.includes(MISSING_TILE) && err.includes("404")),
        30000
      );
      const errors = page.snap.errors.join(" | ");
      assert(!/tiles\.json/i.test(page.status), `HUD blamed tiles.json: ${page.status}`);
      assert(!/tiles\.json/i.test(errors), `errors list blamed tiles.json: ${errors}`);
      assert(page.status.includes(MISSING_TILE) && page.status.includes("404"), `HUD did not name the tile 404: ${page.status}`);
      assert(page.snap.tileTotal === 9, `tile total ${page.snap.tileTotal}`);
      assert(!requests.some((req) => req.base === "catalog.bin"), "fell back to catalog.bin after one tile 404");
      const otherTiles = requests.filter((req) => /^tile-.*\.bin$/.test(req.base) && req.base !== MISSING_TILE && req.status === 200);
      assert(new Set(otherTiles.map((req) => req.base)).size === 8, "the other eight tiles did not load");
      console.log(JSON.stringify({
        oneTile404: {
          records: page.snap.records,
          loadedTiles: page.snap.loadedTiles,
          tileTotal: page.snap.tileTotal,
          errors: page.snap.errors,
          status: page.status,
        },
      }, null, 2));
    } finally {
      await closeChrome(tileCase);
    }

    requests.length = 0;
    mode = "index";
    const indexCase = await openPage();
    try {
      const page = await pollPage(
        indexCase.send,
        (state) =>
          state.snap &&
          /tiles\.json/.test(state.status) &&
          /404/.test(state.status) &&
          (state.snap.records === CATALOG_RECORDS || state.statusError),
        30000
      );
      assert(/tiles\.json/.test(page.status) && /404/.test(page.status), `index error did not name tiles.json 404: ${page.status}`);
      console.log(JSON.stringify({
        tilesJson404: {
          records: page.snap.records,
          loadedTiles: page.snap.loadedTiles,
          tileTotal: page.snap.tileTotal,
          pointsDrawn: page.snap.pointsDrawn,
          errors: page.snap.errors,
          statusError: page.statusError,
          catalogRequested: requests.some((req) => req.base === "catalog.bin"),
          catalogStatus: (requests.find((req) => req.base === "catalog.bin") || {}).status || null,
          status: page.status,
        },
      }, null, 2));
    } finally {
      await closeChrome(indexCase);
    }
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
