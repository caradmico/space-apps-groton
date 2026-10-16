import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const ROOT = path.resolve("public/bin-lod");
const PORT = Number(process.env.BIN_LOD_PORT || 8797);
const CDP_PORT = 9337;
const BYTES_PER_SEC = 500000;
const REPORT_ONLY = process.env.REPORT_ONLY === "1";

let servedBytes = 0;
const servedByFile = new Map();

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
      const bytes = data.length;
      servedBytes += bytes;
      servedByFile.set(base, (servedByFile.get(base) || 0) + bytes);
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
  const userData = fs.mkdtempSync("/tmp/bin-lod-mobile-");
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
      "--window-size=412,915",
      `--user-data-dir=${userData}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let log = "";
  chrome.stderr.on("data", (chunk) => { log += chunk.toString(); });
  chrome.stdout.on("data", (chunk) => { log += chunk.toString(); });
  return { chrome, userData, getLog: () => log };
}

function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  const consoleLines = [];

  function on(method, fn) {
    listeners.push((msg) => {
      if (msg.method === method) fn(msg);
    });
  }

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

  return { ws, send, opened, consoleLines, on };
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

async function pinch(send, cx, cy, fromHalf, toHalf, steps) {
  const points = (spread) => [
    { id: 1, x: cx - spread, y: cy },
    { id: 2, x: cx + spread, y: cy }
  ];

  await send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: points(fromHalf)
  });

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const spread = fromHalf + (toHalf - fromHalf) * t;
    await send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: points(spread)
    });
    await sleep(16);
  }

  await send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: []
  });
}

async function main() {
  let server, chrome, cdp, userDataDir;
  const consoleLines = [];
  try {
    server = await startServer();
    const { chrome: ch, userData, getLog } = launchChrome();
    chrome = ch;
    userDataDir = userData;

    const pages = await waitJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const page = pages.find((e) => e.type === "page");
    if (!page) throw new Error("chrome opened no page");
    cdp = connectCdp(page.webSocketDebuggerUrl);
    await cdp.opened;
    const { send, on } = cdp;

    let networkBytes = 0;
    on("Network.loadingFinished", (msg) => {
      if (msg.params?.encodedDataLength) networkBytes += msg.params.encodedDataLength;
    });

    await send("Runtime.enable");
    await send("Page.enable");
    await send("Network.enable");
    await send("Network.setCacheDisabled", { cacheDisabled: true });
    await send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: BYTES_PER_SEC,
      uploadThroughput: BYTES_PER_SEC
    });
    await send("Emulation.setDeviceMetricsOverride", {
      width: 412,
      height: 915,
      deviceScaleFactor: 2,
      mobile: true
    });
    await send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 5
    });

    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        try {
          const obs = new PerformanceObserver((list) => {
            const entries = list.getEntries();
            if (!window.__LT) window.__LT = {max:0, count:0, entries:[]};
            for (const e of entries) {
              window.__LT.entries.push({start: e.startTime, dur: e.duration});
              window.__LT.count++;
              if (e.duration > window.__LT.max) window.__LT.max = e.duration;
            }
          });
          obs.observe({type:"longtask", buffered:true});

          window.__HB = {maxGap:0, gaps:[], last: performance.now()};
          setInterval(() => {
            const now = performance.now();
            const gap = now - window.__HB.last - 50;
            window.__HB.last = now;
            if (gap > window.__HB.maxGap) window.__HB.maxGap = gap;
            if (gap > 100) window.__HB.gaps.push({at: now, gap});
          }, 50);
        } catch(e) {}
      `
    });

    const navStart = Date.now();
    await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });

    const firstSnap = await pollSnapshot(send, (s) => s && s.painted && s.firstFrameMs > 0 && s.pointsDrawn > 0, 60000);
    const firstDrawMs = firstSnap.firstFrameMs;
    const firstDrawWallMs = Date.now() - navStart;
    const farAtFirstDraw = firstSnap.farCount;

    let fullSnap;
    const fullLoadStart = Date.now();
    while (Date.now() - fullLoadStart < 240000) {
      fullSnap = await evaluate(send, "window.__BIN_LOD.snapshot()");
      if (fullSnap && fullSnap.streamDone && fullSnap.loadedTiles === fullSnap.tileTotal) break;
      await sleep(250);
    }
    if (!fullSnap || !fullSnap.streamDone || fullSnap.loadedTiles !== fullSnap.tileTotal) {
      throw new Error(`full load timeout after 240s, last snapshot: ${JSON.stringify(fullSnap)}`);
    }

    await sleep(1500);
    fullSnap = await evaluate(send, "window.__BIN_LOD.snapshot()");

    const canvasRect = await evaluate(send, `(() => {
      const c = document.querySelector('#canvas-wrap canvas');
      const r = c.getBoundingClientRect();
      return {cx: r.left + r.width/2, cy: r.top + r.height/2};
    })()`);
    const cx = canvasRect.cx;
    const cy = canvasRect.cy;

    // Calibration probe
    const probeStart = await evaluate(send, "performance.now()");
    await evaluate(send, `new Promise((r) => setTimeout(() => {
      const t = performance.now();
      while (performance.now() - t < 250) {}
      setTimeout(r, 300);
    }, 0))`);
    const probeEnd = probeStart + 600;

    const ltAfterProbe = await evaluate(send, "window.__LT || {max:0,count:0,entries:[]}");
    const hbAfterProbe = await evaluate(send, "window.__HB || {maxGap:0,gaps:[]}");
    const longtaskApiWorks = ltAfterProbe.entries.some(e => e.dur >= 200 && e.start > probeStart);
    const heartbeatWorks = hbAfterProbe.gaps.some(g => g.at > probeStart && g.gap >= 150);

    let pinchesDone = 0;
    let pinchStartPerf;
    for (let i = 0; i < 10; i++) {
      if (i === 0) {
        pinchStartPerf = await evaluate(send, "performance.now()");
      }
      await pinch(send, cx, cy, 30, 170, 12);
      await sleep(400);
      pinchesDone++;
      const snap = await evaluate(send, "window.__BIN_LOD.snapshot()");
      if (snap.mode === "near" && snap.nearCount > 0) break;
    }
    await sleep(1500);
    const zoomedSnap = await evaluate(send, "window.__BIN_LOD.snapshot()");

    // empty sky scenario
    await evaluate(send, `(() => { const ra = 180 * Math.PI / 180, dec = -20 * Math.PI / 180, c = Math.cos(dec); return window.__BIN_LOD.frameDirection(c * Math.cos(ra), c * Math.sin(ra), Math.sin(dec), 700); })()`);
    await sleep(1200);
    const emptyBefore = await evaluate(send, "window.__BIN_LOD.snapshot()");

    let emptyPinches = 0;
    for (let i = 0; i < 10; i++) {
      await pinch(send, cx, cy, 30, 170, 12);
      await sleep(400);
      emptyPinches++;
      const snap = await evaluate(send, "window.__BIN_LOD.snapshot()");
      if (snap.mode === "near" && snap.nearCount > 0) break;
    }
    await sleep(1500);
    const emptyAfter = await evaluate(send, "window.__BIN_LOD.snapshot()");

    const lt = await evaluate(send, "window.__LT || {max:0,count:0,entries:[]}");
    const hb = await evaluate(send, "window.__HB || {maxGap:0,gaps:[]}");

    const isOutsideProbe = t => t < probeStart || t > probeEnd;

    const ltOutside = lt.entries.filter(e => isOutsideProbe(e.start));
    const hbOutside = hb.gaps.filter(g => isOutsideProbe(g.at));

    const longestTaskMs = ltOutside.length ? Math.max(...ltOutside.map(e => e.dur)) : 0;
    const maxMainThreadBlockMs = hbOutside.length ? Math.max(...hbOutside.map(g => g.gap)) : (hb.maxGap || 0);

    const freezeMs = Math.max(longestTaskMs, maxMainThreadBlockMs);

    const duringPinchLt = lt.entries.filter(e => e.start >= pinchStartPerf && isOutsideProbe(e.start));
    const duringPinchHb = hb.gaps.filter(g => g.at >= pinchStartPerf && isOutsideProbe(g.at));

    const longestTaskDuringPinchMs = duringPinchLt.length ? Math.max(...duringPinchLt.map(e => e.dur)) : 0;
    const maxMainThreadBlockDuringPinchMs = duringPinchHb.length ? Math.max(...duringPinchHb.map(g => g.gap)) : 0;

    const blocksOver200ms = hbOutside.filter(g => g.gap > 200).length;

    const fullLoadWallMs = Date.now() - navStart;

    const result = {
      viewport: "412x915 dpr2 mobile touch",
      throttle: "4 Mbps down/up, 0 ms latency",
      firstDrawMs,
      firstDrawWallMs,
      fullLoadWallMs,
      farAtFirstDraw,
      full: {
        records: fullSnap.records,
        farCount: fullSnap.farCount,
        pointsDrawn: fullSnap.pointsDrawn,
        nearCount: fullSnap.nearCount,
        hygCount: fullSnap.hygCount ?? null,
        mode: fullSnap.mode,
        loadedTiles: fullSnap.loadedTiles,
        tileTotal: fullSnap.tileTotal,
        errors: fullSnap.errors,
        farCapacity: fullSnap.farCapacity
      },
      pinches: pinchesDone,
      zoomed: {
        mode: zoomedSnap.mode,
        nearCount: zoomedSnap.nearCount,
        farCount: zoomedSnap.farCount,
        hygCount: zoomedSnap.hygCount ?? null,
        hygVisible: zoomedSnap.hygVisible ?? null,
        cameraDist: zoomedSnap.cameraDist ?? null,
        labels: zoomedSnap.labels ?? null,
        pointsDrawn: zoomedSnap.pointsDrawn,
        hygLoaded: zoomedSnap.hygLoaded ?? null,
        hygDupSkipped: zoomedSnap.hygDupSkipped ?? null,
        hygError: zoomedSnap.hygError ?? null
      },
      emptySky: {
        aimedRaDec: [180, -20],
        modeBefore: emptyBefore.mode,
        cameraDistBefore: emptyBefore.cameraDist ?? null,
        pinches: emptyPinches,
        mode: emptyAfter.mode,
        nearCount: emptyAfter.nearCount,
        nearSnaps: emptyAfter.nearSnaps ?? null,
        cameraDist: emptyAfter.cameraDist ?? null,
        target: emptyAfter.target
      },
      cameraDistBefore: fullSnap.cameraDist ?? null,
      longestTaskMs,
      longestTaskDuringPinchMs,
      maxMainThreadBlockMs,
      maxMainThreadBlockDuringPinchMs,
      blocksOver200ms,
      freezeMs,
      longtaskApiWorks,
      heartbeatWorks,
      servedBytes,
      networkBytes,
      servedByFile: Object.fromEntries(servedByFile),
      pinchStartPerf
    };

    console.log(JSON.stringify(result, null, 2));

    if (!REPORT_ONLY) {
      if (fullSnap.errors && fullSnap.errors.length > 0) throw new Error(`full.errors = ${JSON.stringify(fullSnap.errors)}`);
      if ((fullSnap.farCount || 0) < 600000) throw new Error(`full.farCount = ${fullSnap.farCount} (< 600000)`);
      if (zoomedSnap.mode !== "near") throw new Error(`zoomed.mode = ${zoomedSnap.mode} (expected "near")`);
      if ((zoomedSnap.nearCount || 0) <= 0) throw new Error(`zoomed.nearCount = ${zoomedSnap.nearCount} (<= 0)`);
      if ((zoomedSnap.hygCount || 0) <= 0) throw new Error(`zoomed.hygCount = ${zoomedSnap.hygCount || 0} (<= 0)`);
      if (firstDrawMs >= 4000) throw new Error(`firstDrawMs = ${firstDrawMs} (>= 4000)`);
      if (freezeMs >= 1000) throw new Error(`freezeMs = ${freezeMs} (>= 1000)`);
      if (!heartbeatWorks) throw new Error(`heartbeatWorks = false`);
      if (emptyAfter.mode !== "near") throw new Error(`emptyAfter.mode = ${emptyAfter.mode} (expected "near")`);
      if ((emptyAfter.nearCount || 0) <= 0) throw new Error(`emptyAfter.nearCount = ${emptyAfter.nearCount} (<= 0)`);
      if (zoomedSnap.hygError) throw new Error(`zoomed.hygError = ${zoomedSnap.hygError}`);
    }
  } catch (err) {
    console.error(err.message || err);
    if (cdp && cdp.consoleLines) {
      console.error("--- last console lines ---");
      console.error(cdp.consoleLines.slice(-8).join("\n"));
    }
    process.exitCode = 1;
  } finally {
    if (chrome) chrome.kill();
    if (server) server.close();
    if (userDataDir) {
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
    }
  }
}

main();
