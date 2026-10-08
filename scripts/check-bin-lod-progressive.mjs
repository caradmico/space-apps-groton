/**
 * Confirms the BIN LOD viewer draws the first arrived tile before the rest,
 * then fills those tiles into the same page.
 *
 * Usage: node scripts/check-bin-lod-progressive.mjs
 * Node 20: node --experimental-websocket scripts/check-bin-lod-progressive.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const ROOT = path.resolve("public/bin-lod");
const FAST_TILE = "tile-004.bin";
const FAST_RECORDS = 72818;
const TOTAL_RECORDS = 639404;
const SLOW_MS = 4500;
const PORT = 8765;
const CDP_PORT = 9333;

const requests = [];
const FAIL_TILES = process.env.FAIL_TILES === "1";

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
      const base = path.basename(file);
      requests.push({ base, t: Date.now() });
      if (FAIL_TILES && (base === "tiles.json" || /^tile-\d+\.bin$/.test(base))) {
        res.writeHead(404, { "cache-control": "no-store" });
        res.end("missing");
        return;
      }
      const delay = /^tile-.*\.bin$/.test(base) && base !== FAST_TILE ? SLOW_MS : 0;
      res.writeHead(200, {
        "content-type": contentType(file),
        "cache-control": "no-store",
      });
      if (delay) setTimeout(() => res.end(data), delay);
      else res.end(data);
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
  const userData = fs.mkdtempSync("/tmp/bin-lod-chrome-");
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
  chrome.stdout.on("data", (chunk) => {
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
    if (msg.method === "Runtime.consoleAPICalled") {
      const text = (msg.params.args || [])
        .map((arg) => arg.value ?? arg.description ?? "")
        .join(" ");
      consoleLines.push(`${msg.params.type}: ${text}`);
    }
    if (msg.method === "Runtime.exceptionThrown") {
      consoleLines.push(`exception: ${msg.params.exceptionDetails?.text || ""} ${msg.params.exceptionDetails?.exception?.description || ""}`);
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

  const opened = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", () => reject(new Error("cdp websocket failed")));
  });

  return { ws, send, opened, consoleLines };
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

async function pollSnapshot(send, predicate, timeoutMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await evaluate(send, "window.__BIN_LOD ? window.__BIN_LOD.snapshot() : null");
    if (last && predicate(last)) return last;
    await sleep(40);
  }
  throw new Error(`timed out waiting for viewer state: ${JSON.stringify(last)}`);
}

async function brightCount(send) {
  await evaluate(send, "window.__BIN_LOD.requestBrightSample()");
  return pollSnapshot(send, (snap) => snap.brightPixels >= 0, 2000);
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function main() {
  const server = await startServer();
  const { chrome, userData, getLog } = launchChrome();
  try {
    const version = await waitJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
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

    if (FAIL_TILES) {
      const snap = await pollSnapshot(
        cdp.send,
        (state) => state.painted && state.pointsDrawn > 0 && state.records > 1000 && state.tileTotal === 1,
        20000
      );
      const bright = await brightCount(cdp.send);
      assert(bright.brightPixels > 30, `catalog.bin fallback drew no stars (${bright.brightPixels})`);
      assert(requests.some((req) => req.base === "catalog.bin"), "did not request catalog.bin");
      console.log(JSON.stringify({ fallback: { records: snap.records, farCount: snap.farCount, pointsDrawn: snap.pointsDrawn, brightPixels: bright.brightPixels, layout: snap.layout } }, null, 2));
      return;
    }

    const early = await pollSnapshot(
      cdp.send,
      (snap) =>
        snap.painted &&
        snap.firstFrameMs > 0 &&
        snap.firstFrameMs < SLOW_MS &&
        snap.pointsDrawn > 0 &&
        snap.streamDone === false &&
        snap.paints[0] &&
        snap.paints[0].id === "preview" &&
        snap.paints[0].records === 0 &&
        snap.paints.some((paint) => paint.id === "tile-004" && paint.records === FAST_RECORDS),
      12000
    );
    const earlyBright = await brightCount(cdp.send);
    const earlyShot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync("/tmp/bin-lod-first-tile.png", Buffer.from(earlyShot.data, "base64"));
    assert(earlyBright.brightPixels > 30, `first tile drew no visible stars (${earlyBright.brightPixels})`);
    assert(early.firstFrameMs < SLOW_MS, `first frame waited for the slow tiles (${early.firstFrameMs} ms)`);
    assert(!requests.some((req) => req.base === "catalog.bin"), "fell back to catalog.bin");

    const full = await pollSnapshot(
      cdp.send,
      (snap) => snap.streamDone && snap.loadedTiles === 9 && snap.records === TOTAL_RECORDS,
      45000
    );
    assert(full.previewFarCount === 0, "preview points were still drawn after the tiles filled FAR");
    assert(full.tileFarCount > early.paints[0].far * 0.5, "tiles did not replace the preview");
    assert(
      full.paints.filter((paint) => paint.id !== "preview").length === 9,
      `expected 9 tile paints, got ${full.paints.map((paint) => paint.id).join(",")}`
    );
    assert(full.tileTotal === 9, "tile total changed");
    assert(full.layout === "radec", `layout ${full.layout}`);
    assert(full.errors.length === 0, `tile errors: ${full.errors.join("; ")}`);

    const nav = await evaluate(
      cdp.send,
      "performance.getEntriesByType('navigation').length"
    );
    assert(nav === 1, `page reloaded (${nav} navigations)`);

    const nearAim = await evaluate(cdp.send, `(() => {
      const t = ${JSON.stringify(early.target)};
      const len = Math.hypot(t[0], t[1], t[2]) || 1;
      return window.__BIN_LOD.frameDirection(t[0] / len, t[1] / len, t[2] / len, 6);
    })()`);
    assert(nearAim === true, "could not zoom into the first tile");
    const nearSnap = await pollSnapshot(
      cdp.send,
      (snap) => snap.mode === "near" && snap.nearCount > 0,
      3000
    );

    const aimed = await evaluate(cdp.send, `(() => {
      const ra = ((2.813896 + 17.389108) / 2) * Math.PI / 180;
      const dec = ((35.706694 + 48.121286) / 2) * Math.PI / 180;
      const c = Math.cos(dec);
      return window.__BIN_LOD.frameDirection(c * Math.cos(ra), c * Math.sin(ra), Math.sin(dec));
    })()`);
    assert(aimed === true, "could not aim at a later tile");
    await sleep(80);
    const laterView = await brightCount(cdp.send);
    assert(
      laterView.pointsDrawn > 0 && laterView.brightPixels > 30,
      `later tile did not fill into the live view (${laterView.pointsDrawn} pts, ${laterView.brightPixels} px)`
    );
    assert(
      laterView.target && laterView.target[2] > 40,
      `camera did not move to the later tile (${JSON.stringify(laterView.target)})`
    );
    assert(early.paints[0].records === 0, "preview was counted in the catalog");
    assert(full.records === TOTAL_RECORDS, "preview records were added to the catalog");

    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    const shotPath = "/tmp/bin-lod-later-tile.png";
    fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));

    console.log(
      JSON.stringify(
        {
          earlyMs: early.firstFrameMs,
          early: {
            farCount: early.farCount,
            pointsDrawn: early.pointsDrawn,
            brightPixels: earlyBright.brightPixels,
            records: early.records,
            paint: early.paints[0],
          },
          full: {
            farCount: full.farCount,
            records: full.records,
            loadedTiles: full.loadedTiles,
            paints: full.paints.map((paint) => paint.id),
          },
          near: { mode: nearSnap.mode, nearCount: nearSnap.nearCount },
          laterView: {
            pointsDrawn: laterView.pointsDrawn,
            brightPixels: laterView.brightPixels,
            target: laterView.target,
          },
          shotPath,
        },
        null,
        2
      )
    );
  } catch (err) {
    console.error(err);
    console.error(getLog().slice(-4000));
    process.exitCode = 1;
  } finally {
    chrome.kill("SIGKILL");
    server.close();
    await sleep(300);
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main();
