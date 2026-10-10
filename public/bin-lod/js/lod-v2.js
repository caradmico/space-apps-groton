/**
 * StarIS v2 viewer. Loaded only when the page is opened with ?lod=v2.
 * Order 0 stays resident (the far layer). Near keeps at most 12 cells.
 */

import { decodeQ8, Q8_BYTES } from "../scripts/q8.js";
import { ang2pixNest, children, pix2vecNest } from "./healpix.js";

let THREE = null;
let OrbitControls = null;

const FAR_BUDGET = 12288;
const NEAR_BUDGET = 12288;
const NEAR_ENTER = 36;
const NEAR_EXIT = 44;
const SKY_RADIUS = 100;
const REFINE_PX = 256;
const CACHE_LIMIT = 128;
const MAX_IN_FLIGHT = 2;
const COALESCE_BYTES = 64 * 1024;
const INDEX_URL = "data/v2-pilot/tiles.json";
const HYG_MAG0 = -27;
const HYG_STEP = 0.2;
const HEADER_RANGE = 64 * 1024;
const RETRY_CAP = 4;
const HYG_URL = "https://github.com/astronexus/HYG-Database";
const HYG_CREDIT = "HYG database by astronexus (David Nash), CC BY-SA 4.0";
const ESA_CREDIT =
  "This work has made use of data from the European Space Agency (ESA) mission Gaia (https://www.cosmos.esa.int/gaia), processed by the Gaia Data Processing and Analysis Consortium (DPAC, https://www.cosmos.esa.int/web/gaia/dpac/consortium).";

const el = {
  mode: document.getElementById("lod-mode"),
  count: document.getElementById("draw-count"),
  status: document.getElementById("hud-status"),
  canvasWrap: document.getElementById("canvas-wrap"),
};

const state = {
  index: null,
  packs: new Map(),
  cache: new Map(),
  lru: [],
  farCount: 0,
  nearCount: 0,
  mode: "far",
  budgetExceeded: false,
  maxInFlight: 0,
  inFlight: 0,
  fetches: 0,
  painted: false,
  firstFrameMs: 0,
  pointsDrawn: 0,
  hygAlpha: 0,
  labels: [],
  hiddenGaia: 0,
  dedupeProbe: null,
  indexUrl: INDEX_URL,
  retries: new Map(),
  absent: new Set(),
  errorCount: 0,
};

let active = 0;
const waiters = [];
let camera;
let controls;
let renderer;
let scene;
let farPoints;
let nearPoints;
let hygPoints;
let labelLayer;
let hyg = null;
let scratch = null;

function setStatus(html) {
  el.status.innerHTML = html;
}

function noteFlight() {
  state.inFlight = active;
  state.maxInFlight = Math.max(state.maxInFlight, active);
}

function acquire() {
  if (active < MAX_IN_FLIGHT) {
    active += 1;
    noteFlight();
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function release() {
  active -= 1;
  noteFlight();
  if (waiters.length && active < MAX_IN_FLIGHT) {
    active += 1;
    noteFlight();
    waiters.shift()();
  }
}

async function gatedFetch(url, init) {
  await acquire();
  state.fetches += 1;
  try {
    return await fetch(url, init);
  } finally {
    release();
  }
}

function prefetchOrder0() {
  const pending = window.__V2_PREFETCH__ && window.__V2_PREFETCH__.order0;
  if (!pending) return null;
  active += 1;
  noteFlight();
  state.fetches += 1;
  return pending.finally(release);
}

async function readBuffer(res, label) {
  if (!res.ok) throw new Error(`${label} ${res.status}`);
  return res.arrayBuffer();
}

function resourceUrl(relative) {
  if (!relative) return "";
  if (/^https?:\/\//i.test(relative)) return relative;
  return new URL(relative, new URL(state.indexUrl, location.href)).href;
}

function contentRangeOf(res) {
  const raw = res.headers.get("content-range");
  if (!raw) return null;
  const match = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(raw);
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === "*" ? null : Number(match[3]),
  };
}

function addSpan(held, start, bytes) {
  held.spans.push({ start, bytes });
}

function readBytes(held, start, length) {
  if (length <= 0) return new Uint8Array(0);
  for (const span of held.spans) {
    const spanEnd = span.start + span.bytes.length;
    if (span.start <= start && spanEnd >= start + length) {
      const off = start - span.start;
      return span.bytes.subarray(off, off + length);
    }
  }
  const out = new Uint8Array(length);
  const got = new Uint8Array(length);
  let any = false;
  for (const span of held.spans) {
    const spanEnd = span.start + span.bytes.length;
    const lo = Math.max(start, span.start);
    const hi = Math.min(start + length, spanEnd);
    if (hi <= lo) continue;
    out.set(span.bytes.subarray(lo - span.start, hi - span.start), lo - start);
    got.fill(1, lo - start, hi - start);
    any = true;
  }
  if (!any) return null;
  for (let i = 0; i < length; i++) if (!got[i]) return null;
  return out;
}

function prefixLength(held) {
  let end = 0;
  const spans = held.spans.slice().sort((a, b) => a.start - b.start);
  for (const span of spans) {
    if (span.start > end) break;
    end = Math.max(end, span.start + span.bytes.length);
  }
  return end;
}

function parseHeaderBytes(bytes) {
  if (bytes.byteLength < 12) {
    return { incomplete: true, recordsAt: 12, cells: [], order: 0, parent: 255, nCells: 0 };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== "Q8PK") throw new Error("pack magic");
  const order = view.getUint8(4);
  const parent = view.getUint8(5);
  const nCells = view.getUint32(8, true);
  const recordsAt = 12 + nCells * 12;
  if (recordsAt < 12 || recordsAt > 2_000_000) throw new Error("pack header size");
  if (bytes.byteLength < recordsAt) {
    return { incomplete: true, recordsAt, cells: [], order, parent, nCells };
  }
  const cells = [];
  let offset = 12;
  for (let i = 0; i < nCells; i++) {
    cells.push({
      local: view.getUint32(offset, true),
      start: view.getUint32(offset + 4, true),
      count: view.getUint32(offset + 8, true),
    });
    offset += 12;
  }
  return { incomplete: false, recordsAt, cells, order, parent, nCells };
}

function storeBody(held, res, requestedStart, body) {
  if (res.status === 200) {
    held.spans = [{ start: 0, bytes: body }];
    held.whole = true;
    held.fileSize = body.length;
    return;
  }
  if (res.status !== 206) throw new Error(`${held.url} ${res.status}`);
  // A 206 body is only this range. Never store it as the whole pack.
  const info = contentRangeOf(res);
  const start = info ? info.start : requestedStart;
  addSpan(held, start, body);
  held.whole = false;
  if (info && info.total != null) held.fileSize = info.total;
}

function headerFromHeld(held) {
  const probe = readBytes(held, 0, Math.min(12, prefixLength(held)));
  if (!probe || probe.length < 12) throw new Error(`${held.url} header short`);
  const partial = parseHeaderBytes(probe.length >= 12 ? readBytes(held, 0, prefixLength(held)) || probe : probe);
  const recordsAt = partial.recordsAt;
  const header = readBytes(held, 0, recordsAt);
  if (!header) return partial;
  const headerBuf = new Uint8Array(recordsAt);
  headerBuf.set(header.subarray(0, recordsAt), 0);
  return parseHeaderBytes(headerBuf);
}

function globalCell(level, local) {
  if (level.order <= 4) return local;
  return level.pack_id * 1024 + local;
}

function levelFor(order, cell) {
  const levels = state.index.levels.filter((level) => level.order === order);
  if (order <= 4) return levels[0] || null;
  const packId = cell >> 10;
  return levels.find((level) => level.pack_id === packId) || null;
}

function decodeCell(held, level, local) {
  const pack = held.pack;
  const meta = pack.cells.find((cell) => cell.local === local);
  if (!meta || meta.count === 0) return null;
  const cell = globalCell(level, local);
  const raw = readBytes(held, pack.recordsAt + meta.start * Q8_BYTES, meta.count * Q8_BYTES);
  if (!raw) return null;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const ra = new Float64Array(meta.count);
  const dec = new Float64Array(meta.count);
  const mag = new Float32Array(meta.count);
  const colour = new Uint8Array(meta.count);
  const pos = new Float32Array(meta.count * 3);
  const col = new Float32Array(meta.count * 3);
  const size = new Float32Array(meta.count);
  for (let i = 0; i < meta.count; i++) {
    const star = decodeQ8(view, i * Q8_BYTES);
    ra[i] = star.ra;
    dec[i] = star.dec;
    mag[i] = star.mag;
    colour[i] = star.colour;
    const raR = (star.ra * Math.PI) / 180;
    const decR = (star.dec * Math.PI) / 180;
    const c = Math.cos(decR);
    pos[i * 3] = c * Math.cos(raR) * SKY_RADIUS;
    pos[i * 3 + 1] = c * Math.sin(raR) * SKY_RADIUS;
    pos[i * 3 + 2] = Math.sin(decR) * SKY_RADIUS;
    const rgb = colourRGB(star.colour);
    col[i * 3] = rgb[0];
    col[i * 3 + 1] = rgb[1];
    col[i * 3 + 2] = rgb[2];
    size[i] = Math.max(0.8, Math.min(5, (13 - star.mag) * 0.25));
  }
  return {
    key: `${level.order}:${cell}`,
    order: level.order,
    cell,
    count: meta.count,
    ra,
    dec,
    mag,
    colour,
    pos,
    col,
    size,
    raw,
    hide: new Uint8Array(meta.count),
    used: performance.now(),
  };
}

function colourRGB(colour) {
  return [
    [0.62, 0.74, 1],
    [0.72, 0.8, 1],
    [0.95, 0.94, 0.88],
    [1, 0.78, 0.45],
  ][colour & 3];
}

function touch(entry) {
  entry.used = performance.now();
  state.cache.set(entry.key, entry);
  state.lru = state.lru.filter((key) => key !== entry.key);
  state.lru.push(entry.key);
  while (state.lru.length > CACHE_LIMIT) {
    let victim = state.lru[0];
    let victimPx = Infinity;
    for (const key of state.lru) {
      const item = state.cache.get(key);
      if (!item || item.order === 0) continue;
      const px = projectedPx(item.order, item.cell);
      if (px < victimPx) {
        victimPx = px;
        victim = key;
      }
    }
    if (!victim || victim.startsWith("0:")) break;
    state.cache.delete(victim);
    state.lru = state.lru.filter((key) => key !== victim);
  }
}

function projectedPx(order, cell) {
  if (!camera) return 0;
  const vec = pix2vecNest(order, cell);
  scratch.set(vec[0] * SKY_RADIUS, vec[1] * SKY_RADIUS, vec[2] * SKY_RADIUS);
  const dist = Math.max(camera.position.distanceTo(scratch), 0.5);
  const side = Math.sqrt(Math.PI / (3 * (1 << (2 * order))));
  const fov = (camera.fov * Math.PI) / 180;
  const height = renderer ? renderer.domElement.clientHeight : 800;
  return ((side * SKY_RADIUS) / dist / fov) * height;
}

function hasFiner(order) {
  return state.index.levels.some((level) => level.order === order + 1);
}

function selectNear() {
  if (!state.index) return [];
  const leaves = [];
  const walk = (order, cell) => {
    const px = projectedPx(order, cell);
    if (order < 6 && px > REFINE_PX && hasFiner(order)) {
      const kids = children(cell).filter((child) => {
        if (state.absent.has(`${order + 1}:${child}`)) return false;
        return Boolean(levelFor(order + 1, child));
      });
      if (kids.length) {
        for (const child of kids) walk(order + 1, child);
        return;
      }
    }
    if (px > 8 && !state.absent.has(`${order}:${cell}`)) leaves.push({ order, cell, px });
  };
  for (let cell = 0; cell < 12; cell++) walk(0, cell);
  leaves.sort((a, b) => b.px - a.px || a.order - b.order);
  return leaves.slice(0, 12);
}

function wantedDownloads(leaves) {
  const wanted = [];
  for (const leaf of leaves) {
    let order = leaf.order;
    let cell = leaf.cell;
    const chain = [{ order, cell }];
    while (order > 0) {
      order -= 1;
      cell >>= 2;
      chain.push({ order, cell });
    }
    chain.sort((a, b) => a.order - b.order);
    for (const item of chain) {
      if (item.order === 0) continue;
      const key = `${item.order}:${item.cell}`;
      if (state.cache.has(key) || state.absent.has(key)) continue;
      const level = levelFor(item.order, item.cell);
      if (!level) continue;
      wanted.push({ ...item, level, key });
    }
  }
  return wanted;
}

function holdFull(level, url, bytes) {
  const pack = parseHeaderBytes(bytes);
  if (pack.incomplete) throw new Error(`${url} header truncated`);
  const held = {
    level,
    url,
    spans: [{ start: 0, bytes }],
    pack,
    whole: true,
    fileSize: bytes.length,
  };
  state.packs.set(url, held);
  return held;
}

const headerLoads = new Map();

async function ensureHeader(level) {
  const url = resourceUrl(level.pack);
  const existing = state.packs.get(url);
  if (existing && existing.pack && !existing.pack.incomplete) return existing;
  const inflight = headerLoads.get(url);
  if (inflight) return inflight;
  const job = fetchHeader(level, url, existing);
  headerLoads.set(url, job);
  try {
    return await job;
  } finally {
    headerLoads.delete(url);
  }
}

async function fetchHeader(level, url, existing) {
  const held = existing || { level, url, spans: [], pack: null, whole: false, fileSize: null };
  held.level = level;
  held.url = url;
  if (prefixLength(held) < 12) {
    const res = await gatedFetch(url, { headers: { Range: `bytes=0-${HEADER_RANGE - 1}` } });
    const body = new Uint8Array(await readBuffer(res, url));
    storeBody(held, res, 0, body);
  }
  let pack = headerFromHeld(held);
  if (pack.incomplete) {
    const have = prefixLength(held);
    if (have < pack.recordsAt) {
      const res = await gatedFetch(url, { headers: { Range: `bytes=${have}-${pack.recordsAt - 1}` } });
      const body = new Uint8Array(await readBuffer(res, url));
      storeBody(held, res, have, body);
      if (res.status === 200) pack = parseHeaderBytes(body);
      else pack = headerFromHeld(held);
    }
  }
  if (!pack || pack.incomplete) throw new Error(`${url} header incomplete`);
  held.pack = pack;
  state.packs.set(url, held);
  return held;
}

async function loadCells(group) {
  const level = group[0].level;
  const held = await ensureHeader(level);
  const byLocal = new Map(held.pack.cells.map((cell) => [cell.local, cell]));
  const pieces = [];
  for (const item of group) {
    const local = level.order <= 4 ? item.cell : item.cell & 1023;
    const meta = byLocal.get(local);
    if (!meta || meta.count === 0) {
      state.absent.add(item.key);
      continue;
    }
    pieces.push({ item, local, meta });
  }
  pieces.sort((a, b) => a.meta.start - b.meta.start);
  if (!pieces.length) return;
  const missing = [];
  for (const piece of pieces) {
    const start = held.pack.recordsAt + piece.meta.start * Q8_BYTES;
    const end = start + piece.meta.count * Q8_BYTES;
    if (!readBytes(held, start, end - start)) missing.push({ start, end });
  }
  if (missing.length) {
    if (held.whole) throw new Error(`${held.url} missing records`);
    const start = missing[0].start;
    const end = missing[missing.length - 1].end;
    const res = await gatedFetch(held.url, { headers: { Range: `bytes=${start}-${end - 1}` } });
    const body = new Uint8Array(await readBuffer(res, held.url));
    storeBody(held, res, start, body);
    if (res.status === 200) {
      const parsed = parseHeaderBytes(body);
      if (!parsed.incomplete) held.pack = parsed;
    }
  }
  for (const piece of pieces) {
    if (!piece.meta.count) continue;
    const entry = decodeCell(held, level, piece.local);
    if (!entry) throw new Error(`${held.url} cell ${piece.local} not in loaded ranges`);
    markHidden(entry);
    touch(entry);
  }
}

function coalesce(wanted) {
  const groups = new Map();
  for (const item of wanted) {
    const list = groups.get(item.level.pack) || [];
    list.push(item);
    groups.set(item.level.pack, list);
  }
  const jobs = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.cell - b.cell);
    let batch = [];
    for (const item of list) {
      const local = item.level.order <= 4 ? item.cell : item.cell & 1023;
      const prev = batch[batch.length - 1];
      const prevLocal = prev ? (prev.level.order <= 4 ? prev.cell : prev.cell & 1023) : -1;
      const contiguous = prev && local === prevLocal + 1;
      const bytes = (batch.length + 1) * 1024 * Q8_BYTES;
      if (batch.length && (!contiguous || (bytes > COALESCE_BYTES && batch.length > 1))) {
        jobs.push(batch);
        batch = [];
      }
      batch.push(item);
    }
    if (batch.length) jobs.push(batch);
  }
  return jobs;
}

function packReady(url) {
  const rec = state.retries.get(url);
  if (!rec) return true;
  if (rec.n >= RETRY_CAP) return false;
  return performance.now() >= rec.until;
}

function noteFailure(url, err) {
  const rec = state.retries.get(url) || { n: 0, until: 0, logged: false };
  rec.n += 1;
  state.errorCount += 1;
  if (rec.n >= RETRY_CAP) rec.until = Infinity;
  else rec.until = performance.now() + Math.min(8000, 200 * 2 ** (rec.n - 1));
  if (!rec.logged) {
    console.warn("v2 near pack failed; backing off", url, err && err.message ? err.message : err);
    rec.logged = true;
  }
  state.retries.set(url, rec);
}

let loading = false;
async function pumpNear() {
  if (loading || state.mode !== "near") return;
  const leaves = selectNear();
  const wanted = wantedDownloads(leaves)
    .filter((item) => packReady(resourceUrl(item.level.pack)))
    .slice(0, 24);
  const jobs = coalesce(wanted).slice(0, MAX_IN_FLIGHT);
  if (!jobs.length) {
    drawNear(leaves);
    return;
  }
  loading = true;
  try {
    await Promise.all(
      jobs.map(async (group) => {
        const url = resourceUrl(group[0].level.pack);
        try {
          await loadCells(group);
          state.retries.delete(url);
        } catch (err) {
          noteFailure(url, err);
        }
      })
    );
  } catch (err) {
    noteFailure("near", err);
  } finally {
    loading = false;
  }
  drawNear(selectNear());
}

function makePoints(capacity) {
  const pos = new Float32Array(capacity * 3);
  const col = new Float32Array(capacity * 3);
  const size = new Float32Array(capacity);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
  geo.setDrawRange(0, 0);
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
    uniforms: { uAlpha: { value: 1 } },
    vertexShader: `
      attribute float aSize;
      varying vec3 vColor;
      void main() {
        vColor = color;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = clamp(aSize * (64.0 / max(-mvPosition.z, 0.35)), 0.75, 16.0);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform float uAlpha;
      varying vec3 vColor;
      void main() {
        vec2 uv = gl_PointCoord - vec2(0.5);
        if (length(uv) > 0.5) discard;
        gl_FragColor = vec4(vColor, uAlpha);
      }
    `,
  });
  const points = new THREE.Points(geo, material);
  points.frustumCulled = false;
  return { points, pos, col, size, capacity };
}

function writeEntries(buf, entries, cap) {
  let n = 0;
  for (const entry of entries) {
    for (let i = 0; i < entry.count && n < cap; i++) {
      if (state.hygAlpha > 0.05 && entry.hide[i]) continue;
      buf.pos[n * 3] = entry.pos[i * 3];
      buf.pos[n * 3 + 1] = entry.pos[i * 3 + 1];
      buf.pos[n * 3 + 2] = entry.pos[i * 3 + 2];
      buf.col[n * 3] = entry.col[i * 3];
      buf.col[n * 3 + 1] = entry.col[i * 3 + 1];
      buf.col[n * 3 + 2] = entry.col[i * 3 + 2];
      buf.size[n] = entry.size[i];
      n += 1;
    }
  }
  if (n > cap) state.budgetExceeded = true;
  const geo = buf.points.geometry;
  geo.attributes.position.needsUpdate = true;
  geo.attributes.color.needsUpdate = true;
  geo.attributes.aSize.needsUpdate = true;
  geo.setDrawRange(0, n);
  return n;
}

function order0Entries() {
  return [...state.cache.values()].filter((entry) => entry.order === 0);
}

function drawFar() {
  const n = writeEntries(farPoints, order0Entries(), FAR_BUDGET);
  state.farCount = n;
  if (n > FAR_BUDGET) state.budgetExceeded = true;
}

function resolveNear(leaves) {
  const entries = [];
  const seen = new Set();
  for (const leaf of leaves || []) {
    let order = leaf.order;
    let cell = leaf.cell;
    let entry = null;
    while (order >= 1) {
      const found = state.cache.get(`${order}:${cell}`);
      if (found) {
        entry = found;
        break;
      }
      order -= 1;
      cell >>= 2;
    }
    if (entry && !seen.has(entry.key)) {
      seen.add(entry.key);
      entries.push(entry);
    }
  }
  return entries;
}

function drawNear(leaves) {
  const entries = resolveNear(leaves);
  const n = writeEntries(nearPoints, entries.slice(0, 12), NEAR_BUDGET);
  state.nearCount = state.mode === "near" ? n : 0;
  nearPoints.points.visible = state.mode === "near" && n > 0;
  if (n > NEAR_BUDGET) state.budgetExceeded = true;
}

function angSep(ra1, dec1, ra2, dec2) {
  const dRa = ra1 - ra2;
  const c =
    Math.sin(dec1) * Math.sin(dec2) + Math.cos(dec1) * Math.cos(dec2) * Math.cos(dRa);
  return Math.acos(Math.max(-1, Math.min(1, c)));
}

function matchRadius(distancePc) {
  const five = (5 / 3600) * (Math.PI / 180);
  const sixty = (60 / 3600) * (Math.PI / 180);
  const grow = 1.2 * (0.00087 / Math.max(distancePc, 1e-4));
  let radius = Math.max(five, grow);
  if (distancePc < 20) radius += sixty;
  return radius;
}

function raDecOf(x, y, z) {
  const d = Math.hypot(x, y, z);
  const dec = Math.asin(Math.max(-1, Math.min(1, z / Math.max(d, 1e-12))));
  let ra = Math.atan2(y, x);
  if (ra < 0) ra += Math.PI * 2;
  return { ra, dec, d };
}

function markHidden(entry) {
  if (!hyg) return;
  entry.hide.fill(0);
  for (let i = 0; i < entry.count; i++) {
    const gaiaRa = (entry.ra[i] * Math.PI) / 180;
    const gaiaDec = (entry.dec[i] * Math.PI) / 180;
    const pix = ang2pixNest(8, Math.PI / 2 - gaiaDec, gaiaRa);
    const list = hyg.grid.get(pix) || [];
    for (const index of list) {
      const star = hyg.stars[index];
      if (star.d < 0.01) continue;
      if (Math.abs(star.mag - entry.mag[i]) > 2) continue;
      const sep = angSep(gaiaRa, gaiaDec, star.ra, star.dec);
      if (sep <= matchRadius(star.d)) {
        entry.hide[i] = 1;
        state.hiddenGaia += 1;
        break;
      }
    }
  }
}

function parseHyg(buffer) {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== "HYG1") throw new Error("hyg magic");
  const n = view.getUint32(4, true);
  const stars = [];
  const grid = new Map();
  let offset = 8;
  const xyz = new Float32Array(buffer, offset, n * 3);
  offset += n * 12;
  const magQ = new Uint8Array(buffer, offset, n);
  offset += n;
  const nNames = view.getUint32(offset, true);
  offset += 4;
  const nameAt = offset + nNames * 6;
  const bytes = new Uint8Array(buffer);
  const byName = {};
  const names = new Array(n);
  for (let i = 0; i < nNames; i++) {
    const index = view.getUint16(offset, true);
    const nameOff = view.getUint16(offset + 2, true);
    const nameLen = view.getUint16(offset + 4, true);
    offset += 6;
    names[index] = new TextDecoder().decode(bytes.subarray(nameAt + nameOff, nameAt + nameOff + nameLen));
  }
  for (let i = 0; i < n; i++) {
    const x = xyz[i * 3];
    const y = xyz[i * 3 + 1];
    const z = xyz[i * 3 + 2];
    const mag = HYG_MAG0 + magQ[i] * HYG_STEP;
    const { ra, dec, d } = raDecOf(x, y, z);
    const star = { x, y, z, mag, ra, dec, d, name: names[i] || "" };
    stars.push(star);
    if (star.name) byName[star.name] = star;
    if (d < 0.01) continue;
    const pix = ang2pixNest(8, Math.PI / 2 - dec, ra);
    const list = grid.get(pix) || [];
    list.push(i);
    grid.set(pix, list);
    for (const neighbor of neighborCells(pix)) {
      const extra = grid.get(neighbor) || [];
      if (!extra.includes(i)) extra.push(i);
      grid.set(neighbor, extra);
    }
  }
  return { stars, byName, grid, n };
}

function neighborCells(pix) {
  // Order-8 neighbors are the adjacent nested pixels in the same face, plus we
  // also drop the star into the parent order-6 cell's worth of search by
  // storing it on the pixel itself. Boundary stars are caught because the
  // match loop checks this pixel, which already received its neighbors' stars.
  const parent = pix >> 4;
  const base = parent << 4;
  const out = [];
  for (let i = 0; i < 16; i++) if (base + i !== pix) out.push(base + i);
  return out;
}

function dedupeProbe() {
  const probe = {};
  for (const name of ["Sirius", "Vega"]) {
    const star = hyg.byName[name];
    const radius = matchRadius(star.d);
    const sep = angSep(star.ra, star.dec, star.ra, star.dec);
    const far = angSep(star.ra, star.dec, star.ra + 2 / 180 * Math.PI, star.dec);
    probe[name] = sep <= radius && Math.abs(star.mag - star.mag) <= 2 && far > radius;
  }
  state.dedupeProbe = probe;
}

function gaiaNear(name) {
  const star = hyg && hyg.byName[name];
  if (!star) return 0;
  const radius = matchRadius(star.d);
  let n = 0;
  const entries = state.mode === "near" ? [...order0Entries(), ...drawnNearEntries()] : order0Entries();
  for (const entry of entries) {
    for (let i = 0; i < entry.count; i++) {
      if (state.hygAlpha > 0.05 && entry.hide[i]) continue;
      const sep = angSep((entry.ra[i] * Math.PI) / 180, (entry.dec[i] * Math.PI) / 180, star.ra, star.dec);
      if (sep <= radius && Math.abs(entry.mag[i] - star.mag) <= 2) n += 1;
    }
  }
  return n;
}

function drawnNearEntries() {
  return resolveNear(selectNear());
}

function hexOf(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

function updateLabels() {
  if (!hyg || !labelLayer) return;
  if (state.hygAlpha <= 0.05) {
    state.labels = [];
    labelLayer.textContent = "";
    return;
  }
  const width = el.canvasWrap.clientWidth;
  const height = el.canvasWrap.clientHeight;
  const visible = [];
  for (const star of hyg.stars) {
    if (!star.name) continue;
    scratch.set(star.x, star.y, star.z);
    const projected = scratch.clone().project(camera);
    if (star.name !== "Sol" && (projected.z < -1 || projected.z > 1)) continue;
    const x = (projected.x * 0.5 + 0.5) * width;
    const y = (-projected.y * 0.5 + 0.5) * height;
    const onScreen = x >= 0 && y >= 0 && x <= width && y <= height && projected.z < 1;
    if (star.name !== "Sol" && !onScreen) continue;
    visible.push({ name: star.name, mag: star.mag, x, y, onScreen });
  }
  visible.sort((a, b) => a.mag - b.mag);
  const chosen = [];
  const sol = visible.find((item) => item.name === "Sol");
  for (const item of visible) {
    if (chosen.length >= 40) break;
    if (item.name === "Sol") continue;
    chosen.push(item);
  }
  if (sol) chosen.unshift(sol);
  else chosen.unshift({ name: "Sol", mag: -26.7, x: 12, y: 18, onScreen: true });
  state.labels = chosen.slice(0, 40).map((item) => item.name);
  labelLayer.textContent = "";
  for (const item of chosen.slice(0, 40)) {
    const node = document.createElement("div");
    node.textContent = item.name;
    node.style.cssText = `position:absolute;left:${Math.max(4, Math.min(width - 80, item.x))}px;top:${Math.max(4, Math.min(height - 16, item.y))}px;color:#d7e4ff;font:12px/1.2 sans-serif;text-shadow:0 1px 2px #000;white-space:nowrap;`;
    labelLayer.appendChild(node);
  }
}

function updateHygFade() {
  if (!hygPoints) return;
  const dist = camera.position.length();
  let alpha = 0;
  if (state.mode === "near") alpha = 1;
  else if (dist < 80) alpha = 1 - dist / 80;
  state.hygAlpha = alpha;
  hygPoints.material.opacity = alpha;
  hygPoints.visible = alpha > 0.02;
}

function updateMode() {
  const dist = camera.position.distanceTo(controls.target);
  if (state.mode === "far" && dist < NEAR_ENTER) state.mode = "near";
  else if (state.mode === "near" && dist > NEAR_EXIT) state.mode = "far";
}

function hud() {
  el.mode.textContent = state.mode === "near" ? "LOD NEAR v2" : "LOD FAR v2";
  el.count.textContent = `${state.farCount.toLocaleString()} far · ${state.nearCount.toLocaleString()} near`;
  setStatus(
    `<strong>v2</strong> · order 0 resident ${state.farCount.toLocaleString()} · near ${state.nearCount.toLocaleString()} · fetches in flight ${state.inFlight}<br>` +
      `HYG ${state.hygAlpha > 0.05 ? "on" : "off"} · labels ${state.labels.length}`
  );
}

function frame() {
  requestAnimationFrame(frame);
  if (!controls) return;
  controls.update();
  updateMode();
  updateHygFade();
  if (state.mode === "near") pumpNear();
  else if (state.nearCount !== 0) drawNear([]);
  updateLabels();
  renderer.render(scene, camera);
  state.pointsDrawn = state.farCount + (state.mode === "near" ? state.nearCount : 0);
  if (!state.painted && state.farCount > 0) {
    state.painted = true;
    state.firstFrameMs = performance.now();
  }
  hud();
}

function focus(name) {
  const star = hyg && hyg.byName[name];
  if (!star || !controls) return false;
  controls.target.set(star.x, star.y, star.z);
  camera.position.set(star.x + 1.2, star.y + 0.4, star.z + 3.5);
  camera.near = 0.01;
  camera.far = 5000;
  camera.updateProjectionMatrix();
  return true;
}

function aimAt(ux, uy, uz) {
  controls.target.set(ux * SKY_RADIUS, uy * SKY_RADIUS, uz * SKY_RADIUS);
  // Close enough for NEAR, far enough that the leaf is an order-4 cell (those packs cover the sky).
  camera.position.set(ux * (SKY_RADIUS + 12), uy * (SKY_RADIUS + 12), uz * (SKY_RADIUS + 12));
  camera.near = 0.01;
  camera.far = 5000;
  camera.updateProjectionMatrix();
  return true;
}

function focusSky() {
  const entry = order0Entries()[0];
  if (!entry || !entry.count || !controls) return false;
  const len = Math.hypot(entry.pos[0], entry.pos[1], entry.pos[2]) || 1;
  return aimAt(entry.pos[0] / len, entry.pos[1] / len, entry.pos[2] / len);
}

function focusCell(order, cell) {
  if (!controls) return false;
  const vec = pix2vecNest(order, cell);
  return aimAt(vec[0], vec[1], vec[2]);
}

function showCredits() {
  const footer = document.querySelector(".footer");
  if (!footer) return;
  const linked = HYG_CREDIT.replace(
    "astronexus (David Nash)",
    `<a href="${HYG_URL}">astronexus (David Nash)</a>`
  );
  footer.innerHTML =
    `$0 Spark demo — StarIS v2 HEALPix packs.<br>` +
    `${linked}. Share-alike: adaptations of the HYG catalog stay under CC BY-SA 4.0.<br>` +
    ESA_CREDIT;
}

function paintOrder0Now() {
  const entries = order0Entries();
  let count = 0;
  for (const entry of entries) count += entry.count;
  count = Math.min(count, FAR_BUDGET);
  const canvas = document.createElement("canvas");
  const width = Math.max(el.canvasWrap.clientWidth, 300);
  const height = Math.max(el.canvasWrap.clientHeight, 200);
  canvas.width = width;
  canvas.height = height;
  canvas.style.cssText = "width:100%;height:100%;display:block;";
  el.canvasWrap.appendChild(canvas);
  const gl = canvas.getContext("webgl", { antialias: false, alpha: true });
  if (!gl || count === 0) return;
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(
    vs,
    "attribute vec3 aPos; attribute vec3 aCol; varying vec3 vCol; void main(){ vCol=aCol; gl_Position=vec4(aPos.xy/140.0, 0.0, 1.0); gl_PointSize=2.5; }"
  );
  gl.compileShader(vs);
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, "precision mediump float; varying vec3 vCol; void main(){ gl_FragColor=vec4(vCol,1.0); }");
  gl.compileShader(fs);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const interleaved = new Float32Array(count * 6);
  let n = 0;
  for (const entry of entries) {
    for (let i = 0; i < entry.count && n < count; i++) {
      interleaved[n * 6] = entry.pos[i * 3];
      interleaved[n * 6 + 1] = entry.pos[i * 3 + 1];
      interleaved[n * 6 + 2] = entry.pos[i * 3 + 2];
      interleaved[n * 6 + 3] = entry.col[i * 3];
      interleaved[n * 6 + 4] = entry.col[i * 3 + 1];
      interleaved[n * 6 + 5] = entry.col[i * 3 + 2];
      n += 1;
    }
  }
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, interleaved, gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, "aPos");
  const aCol = gl.getAttribLocation(prog, "aCol");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 24, 0);
  gl.enableVertexAttribArray(aCol);
  gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, 24, 12);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0.02, 0.03, 0.06, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.POINTS, 0, n);
  state.farCount = n;
  state.pointsDrawn = n;
  state.painted = true;
  state.firstFrameMs = performance.now();
  state.scratchCanvas = canvas;
}

export async function startV2() {
  window.__BIN_LOD = {
    snapshot() {
      return {
        painted: state.painted,
        firstFrameMs: state.firstFrameMs,
        pointsDrawn: state.pointsDrawn,
        farCount: state.farCount,
        nearCount: state.nearCount,
        mode: state.mode,
        inFlight: state.inFlight,
        maxInFlight: state.maxInFlight,
        fetches: state.fetches,
        budgetExceeded: state.budgetExceeded,
        farBudget: FAR_BUDGET,
        nearBudget: NEAR_BUDGET,
        hygAlpha: state.hygAlpha,
        labels: state.labels.slice(),
        siriusGaia: hyg ? gaiaNear("Sirius") : null,
        vegaGaia: hyg ? gaiaNear("Vega") : null,
        dedupeProbe: state.dedupeProbe,
        hiddenGaia: state.hiddenGaia,
        order0: state.farCount,
        errorCount: state.errorCount,
        nearCells: drawnNearEntries().map((entry) => ({
          order: entry.order,
          cell: entry.cell,
          count: entry.count,
          hex: hexOf(entry.raw),
        })),
        version: 2,
      };
    },
    focus,
    focusSky,
    focusCell,
  };
  showCredits();
  setStatus("Fetching v2 order 0…");
  const order0Promise = prefetchOrder0();
  const indexPromise = gatedFetch(INDEX_URL);
  const order0Url = resourceUrl("o0_p0.pack");
  const order0Res = order0Promise ? await order0Promise : await gatedFetch(order0Url);
  if (order0Res.status !== 200) throw new Error(`o0_p0.pack ${order0Res.status}`);
  const order0Bytes = new Uint8Array(await readBuffer(order0Res, "o0_p0.pack"));
  const order0 = { order: 0, pack: "o0_p0.pack", pack_id: 0, pack_parent_order: -1 };
  const held0 = holdFull(order0, order0Res.url || order0Url, order0Bytes);
  state.packs.set(order0Url, held0);
  for (const cell of held0.pack.cells) {
    const entry = decodeCell(held0, order0, cell.local);
    if (entry) touch(entry);
  }
  paintOrder0Now();
  const indexRes = await indexPromise;
  state.index = await indexRes.json();

  THREE = await import("three");
  ({ OrbitControls } = await import("three/addons/controls/OrbitControls.js"));
  scratch = new THREE.Vector3();

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(55, 1, 0.05, 4000);
  const mean = new THREE.Vector3();
  const entry0 = order0Entries()[0];
  if (entry0) mean.set(entry0.pos[0], entry0.pos[1], entry0.pos[2]);
  camera.position.copy(mean).multiplyScalar(1.8);
  if (camera.position.length() < 1) camera.position.set(0, 40, 160);
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(el.canvasWrap.clientWidth, Math.max(el.canvasWrap.clientHeight, 1), false);
  renderer.setClearColor(0x000000, 0);
  el.canvasWrap.style.position = "relative";
  if (state.scratchCanvas) state.scratchCanvas.remove();
  el.canvasWrap.appendChild(renderer.domElement);
  labelLayer = document.createElement("div");
  labelLayer.style.cssText = "position:absolute;inset:0;pointer-events:none;";
  el.canvasWrap.appendChild(labelLayer);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.copy(mean);
  controls.minDistance = 0.2;
  controls.maxDistance = SKY_RADIUS * 16;
  farPoints = makePoints(FAR_BUDGET);
  nearPoints = makePoints(NEAR_BUDGET);
  scene.add(farPoints.points);
  scene.add(nearPoints.points);
  drawFar();
  const resize = () => {
    const w = el.canvasWrap.clientWidth;
    const h = Math.max(el.canvasWrap.clientHeight, 1);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  };
  resize();
  window.addEventListener("resize", resize);
  frame();

  if (state.index.hyg) {
    const hygUrl = resourceUrl(state.index.hyg);
    const hygRes = await gatedFetch(hygUrl);
    hyg = parseHyg(await readBuffer(hygRes, hygUrl));
    dedupeProbe();
    for (const entry of state.cache.values()) markHidden(entry);
    drawFar();
    const hygPos = new Float32Array(hyg.n * 3);
    const hygCol = new Float32Array(hyg.n * 3);
    for (let i = 0; i < hyg.n; i++) {
      const star = hyg.stars[i];
      hygPos[i * 3] = star.x;
      hygPos[i * 3 + 1] = star.y;
      hygPos[i * 3 + 2] = star.z;
      const shade = Math.max(0.35, Math.min(1, (8 - star.mag) / 10));
      hygCol[i * 3] = shade;
      hygCol[i * 3 + 1] = shade * 0.95;
      hygCol[i * 3 + 2] = 1;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(hygPos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(hygCol, 3));
    hygPoints = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ size: 0.15, vertexColors: true, transparent: true, opacity: 0, depthWrite: false })
    );
    hygPoints.frustumCulled = false;
    scene.add(hygPoints);
  }
}
