/**
 * v2 near layer against a server that answers Range with 206, the way GitHub Pages does.
 *
 * The near-cell records decoded through those ranges must match the same cells
 * decoded from the full pack. Near stars must be greater than 0, and the GET
 * count must stay bounded (no per-frame retry).
 *
 * Usage: node scripts/check-bin-lod-v2-range.mjs
 * Node 20: node --experimental-websocket scripts/check-bin-lod-v2-range.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { decodeQ8, Q8_BYTES } from "../public/bin-lod/scripts/q8.js";

const ROOT = path.resolve("public/bin-lod");
const PORT = 8781;
const CDP_PORT = 9351;
const GET_CAP = 48;
const ESA_CREDIT =
  "This work has made use of data from the European Space Agency (ESA) mission Gaia (https://www.cosmos.esa.int/gaia), processed by the Gaia Data Processing and Analysis Consortium (DPAC, https://www.cosmos.esa.int/web/gaia/dpac/consortium).";

const hits = [];

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
        hits.push({ rel, range: req.headers.range || "", status: 404 });
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
          hits.push({ rel, range, status: 416 });
          res.writeHead(416);
          res.end();
          return;
        }
        hits.push({ rel, range, status: 206 });
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
      hits.push({ rel, range: "", status: 200 });
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
  const userData = fs.mkdtempSync("/tmp/bin-lod-v2-range-");
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
    if (msg.method === "Runtime.consoleAPICalled" && (msg.params.type === "error" || msg.params.type === "warning")) {
      consoleLines.push((msg.params.args || []).map((arg) => arg.value ?? arg.description ?? "").join(" "));
    }
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

function parsePack(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
  if (magic !== "Q8PK") throw new Error(`pack magic ${magic}`);
  const nCells = view.getUint32(8, true);
  const recordsAt = 12 + nCells * 12;
  const cells = [];
  for (let i = 0; i < nCells; i++) {
    const offset = 12 + i * 12;
    cells.push({
      local: view.getUint32(offset, true),
      start: view.getUint32(offset + 4, true),
      count: view.getUint32(offset + 8, true),
    });
  }
  return { recordsAt, cells };
}

function decodeRecords(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = bytes.byteLength / Q8_BYTES;
  const out = [];
  for (let i = 0; i < n; i++) {
    const star = decodeQ8(view, i * Q8_BYTES);
    out.push([star.ra, star.dec, star.mag, star.colour]);
  }
  return out;
}

function sameStars(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1] || a[i][2] !== b[i][2] || a[i][3] !== b[i][3]) return false;
  }
  return true;
}

function packedCell() {
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, "data/v2-pilot/tiles.json"), "utf8"));
  const level = index.levels.find((item) => item.order === 6 && item.n > 0);
  if (!level) throw new Error("no order-6 pack");
  const file = path.join(ROOT, "data/v2-pilot", level.pack);
  const buf = fs.readFileSync(file);
  const pack = parsePack(buf);
  const meta = pack.cells.find((cell) => cell.count > 0);
  if (!meta) throw new Error(`${level.pack} has no records`);
  const cell = level.pack_id * 1024 + meta.local;
  return { index, cell };
}

function packHits() {
  return hits.filter((hit) => hit.rel.endsWith(".pack"));
}

async function main() {
  const { index, cell } = packedCell();
  const server = await startServer();
  const { chrome, userData, getLog } = launchChrome();
  try {
    await waitJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
    const pages = await waitJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const page = pages.find((entry) => entry.type === "page");
    const cdp = connectCdp(page.webSocketDebuggerUrl);
    await cdp.opened;
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/?lod=v2` });

    let last = null;
    let aimed = false;
    let stableSince = 0;
    let stableFetches = -1;
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      last = await evaluate(cdp.send, "window.__BIN_LOD ? window.__BIN_LOD.snapshot() : null");
      if (last && last.version === 2 && last.firstFrameMs > 0 && !aimed) {
        aimed = Boolean(await evaluate(cdp.send, `window.__BIN_LOD.focusCell(6, ${cell})`));
      }
      const ready =
        aimed &&
        last &&
        last.nearCount > 0 &&
        last.nearCells &&
        last.nearCells.length > 0 &&
        last.inFlight === 0 &&
        last.errorCount === 0;
      if (ready && last.fetches === stableFetches) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince > 1200) break;
      } else {
        stableSince = 0;
        stableFetches = last ? last.fetches : -1;
      }
      await sleep(50);
    }
    if (!last || last.nearCount <= 0) {
      throw new Error(`near stars ${JSON.stringify({ nearCount: last && last.nearCount, mode: last && last.mode, errorCount: last && last.errorCount, fetches: last && last.fetches, cells: last && last.nearCells && last.nearCells.length })} ${cdp.consoleLines.slice(-6).join(" | ")}`);
    }
    if (!last.nearCells || !last.nearCells.length) throw new Error("no near cells");
    if (last.errorCount !== 0) throw new Error(`near errors ${last.errorCount} ${cdp.consoleLines.slice(-6).join(" | ")}`);

    const settled = packHits().length;
    await sleep(1500);
    const after = packHits().length;
    if (after !== settled) throw new Error(`pack GETs kept climbing ${settled} -> ${after}`);

    const packs = packHits();
    const same = new Map();
    let saw206 = 0;
    for (const hit of packs) {
      const key = `${hit.rel} ${hit.range}`;
      same.set(key, (same.get(key) || 0) + 1);
      if (hit.status === 206) saw206 += 1;
    }
    const maxSame = Math.max(0, ...same.values());
    if (packs.length > GET_CAP) throw new Error(`pack GETs ${packs.length} over ${GET_CAP}`);
    if (maxSame > 4) throw new Error(`repeated GET ${maxSame}`);
    if (saw206 < 1) throw new Error("expected a 206 pack response");

    let records = 0;
    for (const near of last.nearCells) {
      const level = index.levels.find((item) => {
        if (item.order !== near.order) return false;
        if (near.order <= 4) return true;
        return item.pack_id === near.cell >> 10;
      });
      if (!level) throw new Error(`no pack for ${near.order}:${near.cell}`);
      const buf = fs.readFileSync(path.join(ROOT, "data/v2-pilot", level.pack));
      const pack = parsePack(buf);
      const local = near.order <= 4 ? near.cell : near.cell & 1023;
      const meta = pack.cells.find((item) => item.local === local);
      if (!meta || meta.count !== near.count) throw new Error(`cell ${near.order}:${near.cell} count ${near.count} != ${meta && meta.count}`);
      const slice = buf.subarray(pack.recordsAt + meta.start * Q8_BYTES, pack.recordsAt + (meta.start + meta.count) * Q8_BYTES);
      const fromRange = decodeRecords(Buffer.from(near.hex, "hex"));
      const fromFile = decodeRecords(slice);
      if (!sameStars(fromRange, fromFile)) throw new Error(`records differ ${near.order}:${near.cell}`);
      records += near.count;
    }
    if (records <= 0) throw new Error("decoded no near records");

    const footer = await evaluate(cdp.send, "document.querySelector('.footer') ? document.querySelector('.footer').innerText : ''");
    const footerHtml = await evaluate(cdp.send, "document.querySelector('.footer') ? document.querySelector('.footer').innerHTML : ''");
    if (!footer.includes("HYG database by astronexus (David Nash), CC BY-SA 4.0")) {
      throw new Error(`missing HYG credit: ${footer}`);
    }
    if (!footerHtml.includes("https://github.com/astronexus/HYG-Database")) {
      throw new Error("HYG source is not linked");
    }
    if (!footer.includes("Share-alike")) throw new Error("missing HYG share-alike note");
    if (!footer.includes(ESA_CREDIT)) throw new Error(`missing ESA credit: ${footer}`);

    console.log(JSON.stringify({
      nearCount: last.nearCount,
      nearCells: last.nearCells.length,
      records,
      packGets: packs.length,
      pack206: saw206,
      maxSameGet: maxSame,
      errorCount: last.errorCount,
      mode: last.mode,
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
