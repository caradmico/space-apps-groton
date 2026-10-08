/**
 * StarIS BIN LOD viewer.
 *
 * Reads Cara’s 62-byte LE point-catalog records from an ArrayBuffer.
 * NEVER materializes an Array of star objects for the whole file.
 *
 * GaiaSource (Drive shards / live catalog.bin):
 *   +8  float64 RA degrees
 *   +16 float64 Dec degrees
 *   +24 float64 parallax mas (often NaN; used only when finite and > 0)
 *   +56 uint16  color class
 *   +58 float32 mag
 *   +32/+40/+48 are NOT usable xyz on these bins (almost all zero → origin dot)
 *
 * Legacy StarIS / synthetic HYG-style:
 *   +32/+40/+48 float64 xyz stored as value/206265 (multiply on read)
 *
 * Auto-detect: if >50% of a sample has nonzero finite xyz@32, use the old path.
 * Otherwise RA/Dec → Cartesian (parallax distance, else fixed-radius sphere).
 *
 * LOD:
 *   FAR  — stride-sample generalized points (one GPU buffer)
 *   NEAR — bounded accurate subset around the camera target (typed arrays only)
 *
 * Tiles stream in. The first tile that arrives is sampled and drawn immediately.
 * Later tiles append into the same buffers and spatial indexes — no reload.
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const RECORD_SIZE = 62;
const OFF_RA = 8;
const OFF_DEC = 16;
const OFF_PLX = 24;
const OFF_X = 32;
const OFF_Y = 40;
const OFF_Z = 48;
const OFF_COLOR = 56;
const OFF_MAG = 58;
const UNIT = 206265;
const DEG2RAD = Math.PI / 180;
const SKY_RADIUS = 100;
const DETECT_SAMPLE = 512;

const FAR_BUDGET = 12288;
const NEAR_BUDGET = 12288;
const NEAR_ENTER = 36;
const NEAR_EXIT = 44;
const NEAR_RADIUS = 14;
const GRID = 20;
const YIELD_EVERY = 8000;

const CLASS_RGB = [
  [0.55, 0.7, 1.0],
  [0.65, 0.78, 1.0],
  [0.85, 0.9, 1.0],
  [0.98, 0.96, 0.88],
  [1.0, 0.93, 0.7],
  [1.0, 0.75, 0.45],
  [1.0, 0.48, 0.32],
];

const el = {
  mode: document.getElementById("lod-mode"),
  count: document.getElementById("draw-count"),
  status: document.getElementById("hud-status"),
  canvasWrap: document.getElementById("canvas-wrap"),
};

const catalog = {
  buffer: null,
  view: null,
  count: 0,
  validCount: 0,
  stride: 1,
  layout: "radec",
  bbox: null,
  cellStart: null,
  cellCount: null,
  cellIndex: null,
  frame: null,
  nearRadius: NEAR_RADIUS,
  nearEnter: NEAR_ENTER,
  nearExit: NEAR_EXIT,
  tileCount: 0,
  tilesMeta: [],
  sourceLabel: "catalog.bin",
  segments: [],
  storage: null,
  writeOffset: 0,
  loadedTileCount: 0,
  tileTotal: 0,
  streamDone: false,
  tileErrors: [],
  layoutReady: false,
};

const lod = {
  farCount: 0,
  tileFarCount: 0,
  previewFarCount: 0,
  nearCount: 0,
  mode: "far",
  lastTarget: new THREE.Vector3(Infinity, Infinity, Infinity),
  lastDist: Infinity,
};

const gpu = {
  far: null,
  near: null,
  farPos: null,
  farCol: null,
  farSize: null,
  nearPos: null,
  nearCol: null,
  nearSize: null,
};

const scratch = { x: 0, y: 0, z: 0, ux: 0, uy: 0, uz: 0 };

let sceneStarted = false;
let nearRefresh = () => {};
let viewCamera = null;
let viewControls = null;
const trace = {
  firstFrameMs: 0,
  pointsDrawn: 0,
  paints: [],
  brightPixels: 0,
  sampleBright: false,
};

function countBrightPixels(renderer) {
  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  if (!w || !h) return 0;
  const pixels = new Uint8Array(w * h * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let bright = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 70) bright += 1;
  }
  return bright;
}

function setStatus(html, isError = false) {
  el.status.innerHTML = html;
  el.status.classList.toggle("status-error", isError);
}

function yieldFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function detectLayout(view, count) {
  const sample = Math.min(count, DETECT_SAMPLE);
  if (sample === 0) return "radec";
  let xyzOk = 0;
  for (let i = 0; i < sample; i++) {
    const x = view.getFloat64(i * RECORD_SIZE + OFF_X, true);
    const y = view.getFloat64(i * RECORD_SIZE + OFF_Y, true);
    const z = view.getFloat64(i * RECORD_SIZE + OFF_Z, true);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) && (x !== 0 || y !== 0 || z !== 0)) {
      xyzOk += 1;
    }
  }
  return xyzOk / sample > 0.5 ? "xyz" : "radec";
}

function readStar(view, i, out) {
  if (catalog.layout === "xyz") {
    const x = view.getFloat64(i * RECORD_SIZE + OFF_X, true) * UNIT;
    const y = view.getFloat64(i * RECORD_SIZE + OFF_Y, true) * UNIT;
    const z = view.getFloat64(i * RECORD_SIZE + OFF_Z, true) * UNIT;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
    out.x = x;
    out.y = y;
    out.z = z;
    const len = Math.hypot(x, y, z);
    if (len > 1e-12) {
      out.ux = x / len;
      out.uy = y / len;
      out.uz = z / len;
    } else {
      out.ux = 0;
      out.uy = 0;
      out.uz = 1;
    }
    return true;
  }

  const ra = view.getFloat64(i * RECORD_SIZE + OFF_RA, true);
  const dec = view.getFloat64(i * RECORD_SIZE + OFF_DEC, true);
  if (!Number.isFinite(ra) || !Number.isFinite(dec)) return false;

  const raR = ra * DEG2RAD;
  const decR = dec * DEG2RAD;
  const cosDec = Math.cos(decR);
  const ux = cosDec * Math.cos(raR);
  const uy = cosDec * Math.sin(raR);
  const uz = Math.sin(decR);
  out.ux = ux;
  out.uy = uy;
  out.uz = uz;

  const plx = view.getFloat64(i * RECORD_SIZE + OFF_PLX, true);
  let dist = SKY_RADIUS;
  if (Number.isFinite(plx) && plx > 0) {
    const pc = 1000 / plx;
    if (Number.isFinite(pc) && pc > 0) dist = pc;
  }
  out.x = ux * dist;
  out.y = uy * dist;
  out.z = uz * dist;
  return true;
}

function readColorClass(view, i) {
  return view.getUint16(i * RECORD_SIZE + OFF_COLOR, true);
}

function readMag(view, i) {
  const mag = view.getFloat32(i * RECORD_SIZE + OFF_MAG, true);
  return Number.isFinite(mag) ? mag : 18;
}

function magToSize(mag, scale) {
  const m = Math.min(Math.max(mag, -1.5), 22);
  const t = (22 - m) / 23.5;
  return Math.max(0.32, (0.38 + t * t * 2.1) * scale);
}

function writeAppearance(col, size, offset, colorClass, mag, sizeScale) {
  const rgb = CLASS_RGB[colorClass % CLASS_RGB.length];
  const t = Math.min(Math.max((22 - mag) / 23.5, 0), 1);
  const bright = 0.38 + t * 0.62;
  col[offset * 3] = rgb[0] * bright;
  col[offset * 3 + 1] = rgb[1] * bright;
  col[offset * 3 + 2] = rgb[2] * bright;
  size[offset] = magToSize(mag, sizeScale);
}

function cellOf(x, y, z, bbox) {
  const ix = Math.min(
    GRID - 1,
    Math.max(0, Math.floor(((x - bbox.minX) / bbox.sx) * GRID))
  );
  const iy = Math.min(
    GRID - 1,
    Math.max(0, Math.floor(((y - bbox.minY) / bbox.sy) * GRID))
  );
  const iz = Math.min(
    GRID - 1,
    Math.max(0, Math.floor(((z - bbox.minZ) / bbox.sz) * GRID))
  );
  return ix + iy * GRID + iz * GRID * GRID;
}

function setFrame(targetX, targetY, targetZ, extent) {
  const size = Math.max(extent, 0.08);
  const fov = 55 * Math.PI / 180;
  const dist = (size * 1.35) / Math.tan(fov / 2);
  const tlen = Math.hypot(targetX, targetY, targetZ);
  let ox;
  let oy;
  let oz;
  if (tlen > 1e-8) {
    ox = targetX / tlen;
    oy = targetY / tlen;
    oz = targetZ / tlen;
  } else {
    ox = 0;
    oy = 0.28;
    oz = 0.96;
    const olen = Math.hypot(ox, oy, oz);
    ox /= olen;
    oy /= olen;
    oz /= olen;
  }
  catalog.frame = {
    targetX,
    targetY,
    targetZ,
    cameraX: targetX + ox * dist,
    cameraY: targetY + oy * dist,
    cameraZ: targetZ + oz * dist,
    extent: size,
    dist,
  };
  if (catalog.layout === "radec") {
    catalog.nearRadius = Math.max(size * 0.42, 1.2);
    catalog.nearEnter = Math.max(dist * 0.74, size * 0.9);
    catalog.nearExit = Math.max(dist * 0.94, size * 1.2);
  } else {
    catalog.nearRadius = NEAR_RADIUS;
    catalog.nearEnter = NEAR_ENTER;
    catalog.nearExit = NEAR_EXIT;
  }
}

const vertexShader = /* glsl */ `
  attribute float aSize;
  varying vec3 vColor;
  void main() {
    vColor = color;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (64.0 / max(-mvPosition.z, 0.35));
    gl_PointSize = clamp(gl_PointSize, 0.75, 16.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vColor;
  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv);
    if (d > 0.5) discard;
    float alpha = smoothstep(0.5, 0.08, d);
    gl_FragColor = vec4(vColor, alpha);
  }
`;

function makePoints(pos, col, size, count) {
  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3);
  const colAttr = new THREE.BufferAttribute(col, 3);
  const sizeAttr = new THREE.BufferAttribute(size, 1);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  colAttr.setUsage(THREE.DynamicDrawUsage);
  sizeAttr.setUsage(THREE.DynamicDrawUsage);
  if (count > 0) {
    posAttr.count = count;
    colAttr.count = count;
    sizeAttr.count = count;
  }
  geo.setAttribute("position", posAttr);
  geo.setAttribute("color", colAttr);
  geo.setAttribute("aSize", sizeAttr);
  geo.setDrawRange(0, count);
  if (count > 0) geo.computeBoundingSphere();
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  return new THREE.Points(geo, material);
}

async function loadTilesIndex() {
  const urls = ["data/tiles.json", "data/tiles/tiles.json"];
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: "no-cache" });
      if (!res.ok) {
        lastErr = new Error(`tiles.json ${res.status} at ${url}`);
        continue;
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("tiles.json not found");
}

function tileCenterScore(tile, lookUx, lookUy, lookUz) {
  const ra = (((tile.ra_min + tile.ra_max) * 0.5) % 360) * DEG2RAD;
  const dec = ((tile.dec_min + tile.dec_max) * 0.5) * DEG2RAD;
  const cosDec = Math.cos(dec);
  const ux = cosDec * Math.cos(ra);
  const uy = cosDec * Math.sin(ra);
  const uz = Math.sin(dec);
  return ux * lookUx + uy * lookUy + uz * lookUz;
}

async function fetchTileBuffer(tile) {
  const res = await fetch(tile.url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`tile ${tile.id} fetch ${res.status}`);
  const buffer = await res.arrayBuffer();
  if (buffer.byteLength < RECORD_SIZE) {
    throw new Error(`tile ${tile.id} too small`);
  }
  return buffer;
}

function sortTilesForLook(tiles) {
  // Request the camera-nearest tile first so it usually arrives first.
  // Whichever tile finishes first is still the one that paints.
  const defaultLookRa = 280 * DEG2RAD;
  const defaultLookDec = -5 * DEG2RAD;
  const cosDec = Math.cos(defaultLookDec);
  const lookUx = cosDec * Math.cos(defaultLookRa);
  const lookUy = cosDec * Math.sin(defaultLookRa);
  const lookUz = Math.sin(defaultLookDec);
  tiles.sort(
    (a, b) =>
      tileCenterScore(b, lookUx, lookUy, lookUz) -
      tileCenterScore(a, lookUx, lookUy, lookUz)
  );
}

function tileRecordEstimate(tile) {
  if (Number.isFinite(tile.n_records) && tile.n_records > 0) return tile.n_records;
  if (Number.isFinite(tile.bytes) && tile.bytes > 0) return Math.floor(tile.bytes / RECORD_SIZE);
  return 0;
}

function farQuotas(tiles) {
  const counts = tiles.map((tile) => tileRecordEstimate(tile));
  const total = counts.reduce((sum, n) => sum + n, 0) || 1;
  const quotas = new Map();
  let assigned = 0;
  tiles.forEach((tile, i) => {
    let quota;
    if (i === tiles.length - 1) {
      quota = Math.max(0, FAR_BUDGET - assigned);
    } else {
      quota = Math.round((FAR_BUDGET * counts[i]) / total);
      if (counts[i] > 0) quota = Math.max(1, quota);
      quota = Math.min(quota, Math.max(0, FAR_BUDGET - assigned));
    }
    quota = Math.min(quota, counts[i] > 0 ? counts[i] : quota);
    assigned += quota;
    quotas.set(tile.id, quota);
  });
  return quotas;
}

function loadedBytes() {
  if (catalog.writeOffset > 0) return catalog.writeOffset;
  if (catalog.buffer) return catalog.buffer.byteLength;
  return 0;
}

function ensureStorage(minBytes) {
  const need = Math.max(minBytes, RECORD_SIZE);
  if (catalog.storage && catalog.storage.length >= need) return;
  const nextLen = catalog.storage ? Math.max(need, catalog.storage.length * 2) : need;
  const next = new Uint8Array(nextLen);
  if (catalog.storage && catalog.writeOffset > 0) {
    next.set(catalog.storage.subarray(0, catalog.writeOffset), 0);
  }
  catalog.storage = next;
  catalog.buffer = next.buffer;
  catalog.view = new DataView(catalog.buffer);
}

function ensureFarBuffers() {
  if (gpu.farPos) return;
  gpu.farPos = new Float32Array(FAR_BUDGET * 3);
  gpu.farCol = new Float32Array(FAR_BUDGET * 3);
  gpu.farSize = new Float32Array(FAR_BUDGET);
}

function ensureNearBuffers() {
  if (gpu.nearPos) return;
  gpu.nearPos = new Float32Array(NEAR_BUDGET * 3);
  gpu.nearCol = new Float32Array(NEAR_BUDGET * 3);
  gpu.nearSize = new Float32Array(NEAR_BUDGET);
}

function appendTileBytes(buffer) {
  const raw = new Uint8Array(buffer);
  const bytes = raw.byteLength - (raw.byteLength % RECORD_SIZE);
  const count = bytes / RECORD_SIZE;
  ensureStorage(catalog.writeOffset + bytes);
  catalog.storage.set(raw.subarray(0, bytes), catalog.writeOffset);
  const seg = {
    base: catalog.count,
    count,
    bbox: null,
    cellStart: null,
    cellCount: null,
    cellIndex: null,
    valid: 0,
  };
  catalog.writeOffset += bytes;
  catalog.count += count;
  catalog.segments.push(seg);
  catalog.loadedTileCount += 1;
  return seg;
}

function emptyFrameStats() {
  return {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity,
    frameMinX: Infinity,
    frameMinY: Infinity,
    frameMinZ: Infinity,
    frameMaxX: -Infinity,
    frameMaxY: -Infinity,
    frameMaxZ: -Infinity,
    sumUx: 0,
    sumUy: 0,
    sumUz: 0,
    valid: 0,
  };
}

function accumulateFrame(stats, pos) {
  stats.valid += 1;
  if (pos.x < stats.minX) stats.minX = pos.x;
  if (pos.y < stats.minY) stats.minY = pos.y;
  if (pos.z < stats.minZ) stats.minZ = pos.z;
  if (pos.x > stats.maxX) stats.maxX = pos.x;
  if (pos.y > stats.maxY) stats.maxY = pos.y;
  if (pos.z > stats.maxZ) stats.maxZ = pos.z;
  const fx = pos.ux * SKY_RADIUS;
  const fy = pos.uy * SKY_RADIUS;
  const fz = pos.uz * SKY_RADIUS;
  stats.sumUx += pos.ux;
  stats.sumUy += pos.uy;
  stats.sumUz += pos.uz;
  if (fx < stats.frameMinX) stats.frameMinX = fx;
  if (fy < stats.frameMinY) stats.frameMinY = fy;
  if (fz < stats.frameMinZ) stats.frameMinZ = fz;
  if (fx > stats.frameMaxX) stats.frameMaxX = fx;
  if (fy > stats.frameMaxY) stats.frameMaxY = fy;
  if (fz > stats.frameMaxZ) stats.frameMaxZ = fz;
}

function applyFrameFromStats(stats) {
  if (catalog.layout === "radec") {
    const dirLen = Math.hypot(stats.sumUx, stats.sumUy, stats.sumUz) || 1;
    const frameExtent = Math.max(
      stats.frameMaxX - stats.frameMinX,
      stats.frameMaxY - stats.frameMinY,
      stats.frameMaxZ - stats.frameMinZ,
      0.08
    );
    setFrame(
      (stats.sumUx / dirLen) * SKY_RADIUS,
      (stats.sumUy / dirLen) * SKY_RADIUS,
      (stats.sumUz / dirLen) * SKY_RADIUS,
      frameExtent
    );
    return;
  }
  const targetX = (stats.minX + stats.maxX) * 0.5;
  const targetY = (stats.minY + stats.maxY) * 0.5;
  const targetZ = (stats.minZ + stats.maxZ) * 0.5;
  const frameExtent = Math.max(
    stats.maxX - stats.minX,
    stats.maxY - stats.minY,
    stats.maxZ - stats.minZ,
    0.08
  );
  setFrame(targetX, targetY, targetZ, frameExtent);
}

function writeFarPoint(far, view, record, pos, mag) {
  gpu.farPos[far * 3] = pos.x;
  gpu.farPos[far * 3 + 1] = pos.y;
  gpu.farPos[far * 3 + 2] = pos.z;
  writeAppearance(gpu.farCol, gpu.farSize, far, readColorClass(view, record), mag, 0.55);
}

function sampleFarRange(base, count, quota, stats) {
  if (count <= 0 || quota <= 0) return;
  const stride = Math.max(1, Math.floor(count / quota));
  // Tile points overwrite the preview from the front. They do not append past it.
  const farCap = Math.min(FAR_BUDGET, lod.tileFarCount + quota);
  const { view } = catalog;
  const pos = scratch;
  let far = lod.tileFarCount;

  for (let i = 0; i < count; i += stride) {
    let pick = -1;
    let bestMag = Infinity;
    const end = Math.min(i + stride, count);
    for (let j = i; j < end; j++) {
      const record = base + j;
      if (!readStar(view, record, pos)) continue;
      if (stats) accumulateFrame(stats, pos);
      const mag = readMag(view, record);
      if (mag < bestMag) {
        bestMag = mag;
        pick = j;
      }
    }
    if (pick >= 0 && far < farCap) {
      const record = base + pick;
      readStar(view, record, pos);
      writeFarPoint(far, view, record, pos, bestMag);
      far += 1;
    }
  }
  lod.tileFarCount = far;
  if (lod.tileFarCount >= lod.previewFarCount) lod.previewFarCount = 0;
  lod.farCount = Math.max(lod.tileFarCount, lod.previewFarCount);
}

async function showPreview(layoutHint) {
  try {
    const res = await fetch("data/preview.bin", { cache: "no-cache" });
    if (!res.ok) return false;
    const buffer = await res.arrayBuffer();
    const count = Math.floor(buffer.byteLength / RECORD_SIZE);
    if (count < 1) return false;
    const view = new DataView(buffer);
    if (!catalog.layoutReady) {
      // Brightest-star subsets can trip the xyz detector. The tile index is authoritative.
      catalog.layout = layoutHint === "gaia_radec" ? "radec" : detectLayout(view, count);
      catalog.layoutReady = true;
    }
    const stats = emptyFrameStats();
    const pos = scratch;
    const limit = Math.min(count, FAR_BUDGET);
    let far = 0;
    for (let i = 0; i < limit; i++) {
      if (!readStar(view, i, pos)) continue;
      accumulateFrame(stats, pos);
      writeFarPoint(far, view, i, pos, readMag(view, i));
      far += 1;
    }
    if (far === 0 || stats.valid === 0) return false;
    lod.previewFarCount = far;
    lod.tileFarCount = 0;
    lod.farCount = far;
    applyFrameFromStats(stats);
    if (catalog.frame && catalog.layout === "radec") {
      const wide = Math.max(catalog.frame.extent, SKY_RADIUS * 0.55);
      if (wide !== catalog.frame.extent) {
        setFrame(catalog.frame.targetX, catalog.frame.targetY, catalog.frame.targetZ, wide);
      }
    }
    ensureNearBuffers();
    initScene();
    updateHud();
    trace.paints.push({
      id: "preview",
      loaded: catalog.loadedTileCount,
      far,
      records: catalog.count,
      t: performance.now(),
    });
    await yieldFrame();
    return true;
  } catch (err) {
    console.warn(err);
    return false;
  }
}

function publishFar() {
  if (!gpu.far) return;
  const n = lod.farCount;
  const geo = gpu.far.geometry;
  const pos = geo.attributes.position;
  const col = geo.attributes.color;
  const size = geo.attributes.aSize;
  pos.count = n;
  col.count = n;
  size.count = n;
  pos.needsUpdate = true;
  col.needsUpdate = true;
  size.needsUpdate = true;
  geo.setDrawRange(0, n);
  if (n > 0) geo.computeBoundingSphere();
}

function buildSegmentIndex(seg) {
  const { view } = catalog;
  const { base, count } = seg;
  const pos = scratch;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let valid = 0;

  for (let i = 0; i < count; i++) {
    if (!readStar(view, base + i, pos)) continue;
    valid += 1;
    if (pos.x < minX) minX = pos.x;
    if (pos.y < minY) minY = pos.y;
    if (pos.z < minZ) minZ = pos.z;
    if (pos.x > maxX) maxX = pos.x;
    if (pos.y > maxY) maxY = pos.y;
    if (pos.z > maxZ) maxZ = pos.z;
  }

  seg.valid = valid;
  catalog.validCount += valid;
  if (valid === 0) return;

  const pad = catalog.layout === "radec" ? Math.max(SKY_RADIUS * 0.02, 1.5) : 1.5;
  const bbox = {
    minX: minX - pad,
    minY: minY - pad,
    minZ: minZ - pad,
    maxX: maxX + pad,
    maxY: maxY + pad,
    maxZ: maxZ + pad,
  };
  bbox.sx = Math.max(bbox.maxX - bbox.minX, 1);
  bbox.sy = Math.max(bbox.maxY - bbox.minY, 1);
  bbox.sz = Math.max(bbox.maxZ - bbox.minZ, 1);
  seg.bbox = bbox;

  const cellN = GRID * GRID * GRID;
  const counts = new Uint32Array(cellN);
  for (let i = 0; i < count; i++) {
    if (!readStar(view, base + i, pos)) continue;
    counts[cellOf(pos.x, pos.y, pos.z, bbox)] += 1;
  }

  const start = new Uint32Array(cellN);
  let running = 0;
  for (let c = 0; c < cellN; c++) {
    start[c] = running;
    running += counts[c];
  }

  const index = new Uint32Array(valid);
  const cursor = start.slice();
  for (let i = 0; i < count; i++) {
    if (!readStar(view, base + i, pos)) continue;
    const c = cellOf(pos.x, pos.y, pos.z, bbox);
    index[cursor[c]] = base + i;
    cursor[c] += 1;
  }

  seg.cellStart = start;
  seg.cellCount = counts;
  seg.cellIndex = index;
}

let ingestChain = Promise.resolve();

function enqueueIngest(fn) {
  const run = ingestChain.then(fn);
  ingestChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function ingestTile(tile, buffer, quota) {
  if (!catalog.layoutReady) {
    const probe = new DataView(buffer);
    catalog.layout = detectLayout(probe, Math.floor(buffer.byteLength / RECORD_SIZE));
    catalog.layoutReady = true;
  }

  const seg = appendTileBytes(buffer);
  const stats = sceneStarted ? null : emptyFrameStats();
  sampleFarRange(seg.base, seg.count, quota, stats);

  if (!sceneStarted && lod.farCount > 0 && stats && stats.valid > 0) {
    applyFrameFromStats(stats);
    ensureNearBuffers();
    initScene();
    updateHud();
    trace.paints.push({
      id: tile.id,
      loaded: catalog.loadedTileCount,
      far: lod.farCount,
      records: catalog.count,
      t: performance.now(),
    });
    await yieldFrame();
  } else if (sceneStarted) {
    publishFar();
    updateHud();
    trace.paints.push({
      id: tile.id,
      loaded: catalog.loadedTileCount,
      far: lod.farCount,
      records: catalog.count,
      t: performance.now(),
    });
    await yieldFrame();
  }

  buildSegmentIndex(seg);
  if (sceneStarted) nearRefresh();
}

const DOWNLOADS_AT_A_TIME = 2;

function rememberTileError(err) {
  console.warn(err);
  catalog.tileErrors.push(err && err.message ? err.message : String(err));
}

function downloadTilesInOrder(tiles, quotas) {
  let cursor = 0;
  let active = 0;
  let settled = 0;
  if (!tiles.length) return Promise.resolve();

  return new Promise((resolve) => {
    const launch = () => {
      while (active < DOWNLOADS_AT_A_TIME && cursor < tiles.length) {
        const tile = tiles[cursor];
        cursor += 1;
        active += 1;
        fetchTileBuffer(tile)
          .then(
            (buffer) => {
              active -= 1;
              launch();
              return enqueueIngest(() => ingestTile(tile, buffer, quotas.get(tile.id) || 0));
            },
            (err) => {
              active -= 1;
              rememberTileError(err);
              launch();
            }
          )
          .then(
            () => {
              settled += 1;
              if (settled === tiles.length) resolve();
            },
            (err) => {
              rememberTileError(err);
              settled += 1;
              if (settled === tiles.length) resolve();
            }
          );
      }
    };
    launch();
  });
}

async function streamTiles(index, tiles) {
  sortTilesForLook(tiles);
  catalog.tileTotal = tiles.length;
  catalog.tileCount = tiles.length;
  catalog.tilesMeta = tiles;
  catalog.sourceLabel = `${tiles.length} tiles`;
  const hintedBytes =
    Number(index.total_bytes) ||
    tiles.reduce((sum, tile) => sum + (Number(tile.bytes) || 0), 0);
  ensureStorage(Math.max(hintedBytes, RECORD_SIZE));
  ensureFarBuffers();
  ensureNearBuffers();

  const quotas = farQuotas(tiles);
  const showedPreview = await showPreview(index.layout);
  // Chrome's network throttle aborts tile fetches that start in the same
  // task as the preview frame. A macrotask boundary lets the queue open.
  if (showedPreview) await new Promise((resolve) => setTimeout(resolve, 0));
  if (!showedPreview) {
    setStatus(
      `Fetching <strong>${tiles.length}</strong> LOD tiles. Stars draw as soon as the first one arrives…`
    );
  }

  // Two downloads at a time, in look order. A finished tile is ingested
  // immediately and the freed slot starts the next file.
  await downloadTilesInOrder(tiles, quotas);

  if (lod.tileFarCount > 0) {
    lod.previewFarCount = 0;
    lod.farCount = lod.tileFarCount;
    publishFar();
  }
  catalog.streamDone = true;
  if (!sceneStarted || catalog.count === 0) {
    const detail = catalog.tileErrors[0] || "No finite positions in LOD tiles";
    throw new Error(detail);
  }
  updateHud();
}

async function buildFarAndIndex() {
  const { view, count } = catalog;
  const stride = Math.max(1, Math.floor(count / FAR_BUDGET));
  catalog.stride = stride;

  const farCap = Math.min(FAR_BUDGET, Math.ceil(count / stride));
  gpu.farPos = new Float32Array(farCap * 3);
  gpu.farCol = new Float32Array(farCap * 3);
  gpu.farSize = new Float32Array(farCap);

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let frameMinX = Infinity;
  let frameMinY = Infinity;
  let frameMinZ = Infinity;
  let frameMaxX = -Infinity;
  let frameMaxY = -Infinity;
  let frameMaxZ = -Infinity;
  let sumUx = 0;
  let sumUy = 0;
  let sumUz = 0;
  let valid = 0;

  const cellN = GRID * GRID * GRID;
  const counts = new Uint32Array(cellN);
  let far = 0;
  const pos = scratch;

  for (let i = 0; i < count; i++) {
    if (readStar(view, i, pos)) {
      valid += 1;
      if (pos.x < minX) minX = pos.x;
      if (pos.y < minY) minY = pos.y;
      if (pos.z < minZ) minZ = pos.z;
      if (pos.x > maxX) maxX = pos.x;
      if (pos.y > maxY) maxY = pos.y;
      if (pos.z > maxZ) maxZ = pos.z;

      const fx = pos.ux * SKY_RADIUS;
      const fy = pos.uy * SKY_RADIUS;
      const fz = pos.uz * SKY_RADIUS;
      sumUx += pos.ux;
      sumUy += pos.uy;
      sumUz += pos.uz;
      if (fx < frameMinX) frameMinX = fx;
      if (fy < frameMinY) frameMinY = fy;
      if (fz < frameMinZ) frameMinZ = fz;
      if (fx > frameMaxX) frameMaxX = fx;
      if (fy > frameMaxY) frameMaxY = fy;
      if (fz > frameMaxZ) frameMaxZ = fz;
    }

    if (i % stride === 0 && far < farCap) {
      let pick = -1;
      let bestMag = Infinity;
      const end = Math.min(i + stride, count);
      for (let j = i; j < end; j++) {
        if (!readStar(view, j, pos)) continue;
        const m = readMag(view, j);
        if (m < bestMag) {
          bestMag = m;
          pick = j;
        }
      }
      if (pick >= 0) {
        readStar(view, pick, pos);
        gpu.farPos[far * 3] = pos.x;
        gpu.farPos[far * 3 + 1] = pos.y;
        gpu.farPos[far * 3 + 2] = pos.z;
        writeAppearance(gpu.farCol, gpu.farSize, far, readColorClass(view, pick), bestMag, 0.55);
        far += 1;
      }
    }

    if (i > 0 && i % YIELD_EVERY === 0) {
      setStatus(
        `Indexing catalog as bytes… <strong>${i.toLocaleString()}</strong> / ${count.toLocaleString()}`
      );
      await yieldFrame();
    }
  }

  catalog.validCount = valid;
  if (valid === 0 || far === 0) {
    throw new Error("No finite RA/Dec (or xyz) positions in catalog.bin");
  }

  const pad = catalog.layout === "radec" ? Math.max(SKY_RADIUS * 0.02, 1.5) : 1.5;
  const bbox = {
    minX: minX - pad,
    minY: minY - pad,
    minZ: minZ - pad,
    maxX: maxX + pad,
    maxY: maxY + pad,
    maxZ: maxZ + pad,
  };
  bbox.sx = Math.max(bbox.maxX - bbox.minX, 1);
  bbox.sy = Math.max(bbox.maxY - bbox.minY, 1);
  bbox.sz = Math.max(bbox.maxZ - bbox.minZ, 1);
  catalog.bbox = bbox;
  lod.farCount = far;

  if (catalog.layout === "radec") {
    const dirLen = Math.hypot(sumUx, sumUy, sumUz) || 1;
    const meanStrength = dirLen / Math.max(valid, 1);
    let targetX = (sumUx / dirLen) * SKY_RADIUS;
    let targetY = (sumUy / dirLen) * SKY_RADIUS;
    let targetZ = (sumUz / dirLen) * SKY_RADIUS;
    // Multi-tile / wide-sky: mean vector cancels — aim at densest look region on the sphere.
    if (catalog.tileCount > 1 && meanStrength < 0.45) {
      const t0 = catalog.tilesMeta[0];
      if (t0 && Number.isFinite(t0.ra_min)) {
        const ra = (((t0.ra_min + t0.ra_max) * 0.5) % 360) * DEG2RAD;
        const dec = ((t0.dec_min + t0.dec_max) * 0.5) * DEG2RAD;
        const c = Math.cos(dec);
        targetX = c * Math.cos(ra) * SKY_RADIUS;
        targetY = c * Math.sin(ra) * SKY_RADIUS;
        targetZ = Math.sin(dec) * SKY_RADIUS;
      }
    }
    const frameExtent = Math.max(
      frameMaxX - frameMinX,
      frameMaxY - frameMinY,
      frameMaxZ - frameMinZ,
      catalog.tileCount > 1 ? SKY_RADIUS * 0.55 : 0.08,
      0.08
    );
    setFrame(targetX, targetY, targetZ, frameExtent);
  } else {
    const targetX = (minX + maxX) * 0.5;
    const targetY = (minY + maxY) * 0.5;
    const targetZ = (minZ + maxZ) * 0.5;
    const frameExtent = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 0.08);
    setFrame(targetX, targetY, targetZ, frameExtent);
  }

  for (let i = 0; i < count; i++) {
    if (!readStar(view, i, pos)) continue;
    const c = cellOf(pos.x, pos.y, pos.z, bbox);
    counts[c] += 1;
    if (i > 0 && i % YIELD_EVERY === 0) await yieldFrame();
  }

  const start = new Uint32Array(cellN);
  let running = 0;
  for (let c = 0; c < cellN; c++) {
    start[c] = running;
    running += counts[c];
  }

  const index = new Uint32Array(valid);
  const cursor = start.slice();
  for (let i = 0; i < count; i++) {
    if (!readStar(view, i, pos)) continue;
    const c = cellOf(pos.x, pos.y, pos.z, bbox);
    index[cursor[c]] = i;
    cursor[c] += 1;
    if (i > 0 && i % YIELD_EVERY === 0) await yieldFrame();
  }

  catalog.cellStart = start;
  catalog.cellCount = counts;
  catalog.cellIndex = index;
  catalog.segments.push({
    base: 0,
    count,
    bbox,
    cellStart: start,
    cellCount: counts,
    cellIndex: index,
    valid,
  });
  catalog.loadedTileCount = Math.max(catalog.loadedTileCount, 1);
  if (!catalog.writeOffset) catalog.writeOffset = catalog.buffer.byteLength;

  ensureNearBuffers();
}

function cellRange(minValue, maxValue, minBound, span) {
  return [
    Math.min(GRID - 1, Math.max(0, Math.floor(((minValue - minBound) / span) * GRID))),
    Math.min(GRID - 1, Math.max(0, Math.floor(((maxValue - minBound) / span) * GRID))),
  ];
}

function fillNear(target) {
  const { view, segments } = catalog;
  if (!segments.length) return 0;

  const r = catalog.nearRadius;
  const r2 = r * r;
  const pos = scratch;
  let n = 0;

  for (let s = 0; s < segments.length && n < NEAR_BUDGET; s++) {
    const seg = segments[s];
    const { bbox, cellStart, cellCount, cellIndex } = seg;
    if (!bbox || !cellStart || !cellCount || !cellIndex) continue;

    const [minIX, maxIX] = cellRange(target.x - r, target.x + r, bbox.minX, bbox.sx);
    const [minIY, maxIY] = cellRange(target.y - r, target.y + r, bbox.minY, bbox.sy);
    const [minIZ, maxIZ] = cellRange(target.z - r, target.z + r, bbox.minZ, bbox.sz);

    for (let iz = minIZ; iz <= maxIZ && n < NEAR_BUDGET; iz++) {
      for (let iy = minIY; iy <= maxIY && n < NEAR_BUDGET; iy++) {
        for (let ix = minIX; ix <= maxIX && n < NEAR_BUDGET; ix++) {
          const c = ix + iy * GRID + iz * GRID * GRID;
          const begin = cellStart[c];
          const end = begin + cellCount[c];
          for (let k = begin; k < end && n < NEAR_BUDGET; k++) {
            const i = cellIndex[k];
            if (!readStar(view, i, pos)) continue;
            const dx = pos.x - target.x;
            const dy = pos.y - target.y;
            const dz = pos.z - target.z;
            if (dx * dx + dy * dy + dz * dz > r2) continue;
            gpu.nearPos[n * 3] = pos.x;
            gpu.nearPos[n * 3 + 1] = pos.y;
            gpu.nearPos[n * 3 + 2] = pos.z;
            writeAppearance(
              gpu.nearCol,
              gpu.nearSize,
              n,
              readColorClass(view, i),
              readMag(view, i),
              0.72
            );
            n += 1;
          }
        }
      }
    }
  }

  lod.nearCount = n;
  if (gpu.near) {
    const geo = gpu.near.geometry;
    if (n > 0) {
      geo.attributes.position.count = n;
      geo.attributes.color.count = n;
      geo.attributes.aSize.count = n;
      geo.computeBoundingSphere();
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.attributes.aSize.needsUpdate = true;
    geo.setDrawRange(0, n);
  }
  return n;
}

function updateHud() {
  const mb = (loadedBytes() / (1024 * 1024)).toFixed(2);
  const layoutNote =
    catalog.layout === "radec"
      ? "GaiaSource RA/Dec → Cartesian"
      : "StarIS precomputed xyz × 206265";
  const total = catalog.tileTotal || catalog.tileCount;
  const loaded = catalog.loadedTileCount;
  const tileNote = total > 1 ? `${loaded}/${total} tiles` : catalog.sourceLabel;
  const waiting = total > 1 && loaded < total;
  const previewing = lod.previewFarCount > lod.tileFarCount && loaded === 0;
  el.mode.textContent = lod.mode === "near" ? "LOD NEAR" : "LOD FAR";
  el.mode.dataset.mode = lod.mode;
  el.count.textContent = `${lod.farCount.toLocaleString()} far · ${lod.nearCount.toLocaleString()} near · ${tileNote}`;
  const farLine = previewing
    ? `FAR preview ${lod.farCount.toLocaleString()} stars, not counted in the catalog`
    : total > 1
      ? `FAR sample ${lod.farCount.toLocaleString()} from tiles that have arrived`
      : `FAR stride ${catalog.stride} → ${lod.farCount.toLocaleString()} generalized across loaded tiles`;
  const errNote = catalog.tileErrors.length
    ? `<br>${catalog.tileErrors.length} tile${catalog.tileErrors.length === 1 ? "" : "s"} failed to load`
    : "";
  setStatus(
    `<strong>${catalog.count.toLocaleString()} records</strong> · ${mb} MiB loaded · ${tileNote} · 62 B LE · ${layoutNote}<br>` +
      `${farLine}<br>` +
      (previewing
        ? `Coarse sky preview is on screen. Tile records replace those points as they arrive.`
        : waiting
          ? `Showing stars from the first tiles in. The rest fill in on this same view.`
          : lod.mode === "near"
          ? `NEAR accurate subset ${lod.nearCount.toLocaleString()} (cap ${NEAR_BUDGET.toLocaleString()}) within ${catalog.nearRadius.toFixed(1)} of target`
          : `Zoom in toward a region to load an accurate nearby subset`) +
      errNote +
      `<br>No full star-object array. Drag to orbit · scroll to zoom · right-drag to pan`
  );
}

function initScene() {
  if (sceneStarted) return;
  const frame = catalog.frame;
  const scene = new THREE.Scene();
  const fogDist = catalog.tileTotal > 1 ? Math.max(frame.dist, SKY_RADIUS * 2) : frame.dist;
  const fogDensity = Math.min(0.012, 0.45 / Math.max(fogDist, 8));
  scene.fog = new THREE.FogExp2(0x05070d, fogDensity);

  const camera = new THREE.PerspectiveCamera(
    55,
    el.canvasWrap.clientWidth / Math.max(el.canvasWrap.clientHeight, 1),
    Math.max(frame.dist * 0.01, 0.05),
    Math.max(frame.dist + SKY_RADIUS * 12, 2500)
  );
  camera.position.set(frame.cameraX, frame.cameraY, frame.cameraZ);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(el.canvasWrap.clientWidth, el.canvasWrap.clientHeight, false);
  renderer.setClearColor(0x000000, 0);
  el.canvasWrap.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enablePan = true;
  controls.minDistance = Math.max(frame.extent * 0.12, 0.4);
  const skyReach = catalog.tileTotal > 1 ? SKY_RADIUS * 16 : 0;
  controls.maxDistance = Math.max(frame.extent * 14, frame.dist * 6, skyReach);
  controls.target.set(frame.targetX, frame.targetY, frame.targetZ);

  viewCamera = camera;
  viewControls = controls;

  gpu.far = makePoints(gpu.farPos, gpu.farCol, gpu.farSize, lod.farCount);
  gpu.near = makePoints(gpu.nearPos, gpu.nearCol, gpu.nearSize, 0);
  gpu.near.visible = false;
  scene.add(gpu.far);
  scene.add(gpu.near);

  if (catalog.layout === "xyz") {
    const origin = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xffe08a })
    );
    scene.add(origin);
  }

  function onResize() {
    const w = el.canvasWrap.clientWidth;
    const h = Math.max(el.canvasWrap.clientHeight, 1);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
  window.addEventListener("resize", onResize);

  function maybeRefreshNear() {
    const dist = camera.position.distanceTo(controls.target);
    const wantNear = lod.mode === "near" ? dist < catalog.nearExit : dist < catalog.nearEnter;
    const moveEps = Math.max(frame.extent * 0.05, 0.2);
    const moved =
      controls.target.distanceToSquared(lod.lastTarget) > moveEps * moveEps ||
      Math.abs(dist - lod.lastDist) > moveEps * 1.6;

    if (wantNear && (lod.mode !== "near" || moved)) {
      fillNear(controls.target);
      gpu.near.visible = lod.nearCount > 0;
      lod.mode = "near";
      lod.lastTarget.copy(controls.target);
      lod.lastDist = dist;
      updateHud();
    } else if (!wantNear && lod.mode !== "far") {
      lod.mode = "far";
      lod.nearCount = 0;
      gpu.near.visible = false;
      gpu.near.geometry.setDrawRange(0, 0);
      lod.lastTarget.set(Infinity, Infinity, Infinity);
      lod.lastDist = dist;
      updateHud();
    }
  }

  nearRefresh = () => {
    const dist = camera.position.distanceTo(controls.target);
    const wantNear = lod.mode === "near" ? dist < catalog.nearExit : dist < catalog.nearEnter;
    if (!wantNear && lod.mode !== "near") return;
    fillNear(controls.target);
    gpu.near.visible = lod.nearCount > 0;
    if (lod.nearCount > 0) {
      lod.mode = "near";
      lod.lastTarget.copy(controls.target);
      lod.lastDist = dist;
    }
    updateHud();
  };

  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    maybeRefreshNear();
    renderer.render(scene, camera);
    trace.pointsDrawn = renderer.info.render.points;
    if (!trace.firstFrameMs && trace.pointsDrawn > 0) {
      trace.firstFrameMs = performance.now();
    }
    if (trace.sampleBright) {
      trace.brightPixels = countBrightPixels(renderer);
      trace.sampleBright = false;
    }
  }
  animate();
  sceneStarted = true;
}

function resetStreamBuffers() {
  catalog.segments = [];
  catalog.storage = null;
  catalog.buffer = null;
  catalog.view = null;
  catalog.count = 0;
  catalog.validCount = 0;
  catalog.writeOffset = 0;
  catalog.loadedTileCount = 0;
  catalog.tileTotal = 0;
  catalog.streamDone = false;
  catalog.layoutReady = false;
  lod.farCount = 0;
  lod.tileFarCount = 0;
  lod.previewFarCount = 0;
  gpu.farPos = null;
  gpu.farCol = null;
  gpu.farSize = null;
}

async function loadSingleCatalog(cause) {
  console.warn("Multi-tile load failed; falling back to catalog.bin", cause);
  resetStreamBuffers();
  setStatus("Fetching <code>data/catalog.bin</code> as bytes…");
  const res = await fetch("data/catalog.bin", { cache: "no-cache" });
  if (!res.ok) {
    const why = cause && cause.message ? cause.message : "tiles unavailable";
    throw new Error(`Failed to load tiles.json (${why}) and catalog.bin (${res.status})`);
  }
  const buffer = await res.arrayBuffer();
  if (buffer.byteLength < RECORD_SIZE) {
    throw new Error("catalog.bin is too small to hold one 62-byte record");
  }
  const count = Math.floor(buffer.byteLength / RECORD_SIZE);
  catalog.buffer = buffer;
  catalog.view = new DataView(buffer);
  catalog.count = count;
  catalog.layout = detectLayout(catalog.view, count);
  catalog.layoutReady = true;
  catalog.tileCount = 1;
  catalog.tileTotal = 1;
  catalog.tilesMeta = [];
  catalog.sourceLabel = "catalog.bin";
  catalog.writeOffset = buffer.byteLength;
  return count;
}

async function main() {
  try {
    setStatus("Fetching <code>data/tiles.json</code>…");
    const index = await loadTilesIndex();
    const tiles = Array.isArray(index.tiles) ? index.tiles.slice() : [];
    if (!tiles.length) throw new Error("tiles.json has no tiles");
    await streamTiles(index, tiles);
  } catch (tileErr) {
    if (sceneStarted) {
      console.warn(tileErr);
      catalog.streamDone = true;
      if (lod.tileFarCount > 0) {
        lod.previewFarCount = 0;
        lod.farCount = lod.tileFarCount;
        publishFar();
      }
      updateHud();
      return;
    }
    try {
      await loadSingleCatalog(tileErr);
      setStatus(
        `Building FAR stride + spatial index over <strong>${catalog.count.toLocaleString()}</strong> records…`
      );
      await buildFarAndIndex();
      initScene();
      updateHud();
    } catch (err) {
      console.error(err);
      setStatus(
        `Could not load <code>data/catalog.bin</code>. ${err.message}<br>` +
          `Drop a GaiaSource 62-byte LE shard (RA/Dec at +8/+16) or a StarIS xyz catalog as <code>data/catalog.bin</code>.`,
        true
      );
      el.count.textContent = "0 drawn";
      el.mode.textContent = "LOD error";
    }
  }
}

function frameDirection(ux, uy, uz, dist = 28) {
  if (!viewCamera || !viewControls) return false;
  const len = Math.hypot(ux, uy, uz) || 1;
  const ox = ux / len;
  const oy = uy / len;
  const oz = uz / len;
  const reach = Number.isFinite(dist) ? dist : 28;
  const tx = ox * SKY_RADIUS;
  const ty = oy * SKY_RADIUS;
  const tz = oz * SKY_RADIUS;
  viewControls.target.set(tx, ty, tz);
  viewCamera.position.set(tx + ox * reach, ty + oy * reach, tz + oz * reach);
  viewCamera.lookAt(tx, ty, tz);
  viewCamera.updateProjectionMatrix();
  viewControls.update();
  return true;
}

window.__BIN_LOD = {
  snapshot() {
    return {
      painted: sceneStarted,
      firstFrameMs: trace.firstFrameMs,
      pointsDrawn: trace.pointsDrawn,
      brightPixels: trace.brightPixels,
      farCount: lod.farCount,
      tileFarCount: lod.tileFarCount,
      previewFarCount: lod.previewFarCount,
      nearCount: lod.nearCount,
      records: catalog.count,
      loadedTiles: catalog.loadedTileCount,
      tileTotal: catalog.tileTotal,
      layout: catalog.layout,
      streamDone: catalog.streamDone,
      paints: trace.paints.map((paint) => ({ ...paint })),
      errors: catalog.tileErrors.slice(),
      mode: lod.mode,
      target: viewControls
        ? [viewControls.target.x, viewControls.target.y, viewControls.target.z]
        : null,
    };
  },
  requestBrightSample() {
    trace.sampleBright = true;
    trace.brightPixels = -1;
  },
  frameDirection,
};

main();
