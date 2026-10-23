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
 *   FAR  — every loaded tile star in one preallocated GPU buffer (brightness-scaled size/colour),
 *          written in chunks with frame yields and partial uploads; the 12,288-star preview.bin
 *          paints first in its own layer and hides once all tiles are in
 *   NEAR — bounded subset (cap 12,288) around the orbit target, re-centred on the star nearest
 *          the screen centre if the target region is empty
 *   HYG  — data/hyg-near.bin, the 7,999 nearest named/real-distance stars, fading in near the
 *          Sun, and Gaia records inside its max distance are skipped
 *
 * Tiles still stream two at a time in look order and append without reload.
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
const AU_PER_PC = 206264.806;
const SS_SCALE = 0.05; // Scaled solar-system frame: 1 AU = 0.05 pc (not to scale vs stars)
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

const PREVIEW_BUDGET = 12288;

const FAR_INGEST_CHUNK = 16384;

const FAR_SIZE_SCALE = 0.5;

const HYG_FILE = "data/hyg-near.bin";

const HYG_FADE_NEAR = 160;

const HYG_FADE_FAR = 260;

const HYG_LABEL_MAG = 2.5;

const HYG_LABEL_NEAR_PC = 12;

const HYG_LABEL_MAX = 24;

// Approximate J2000 Keplerian elements + rates per Julian century (Standish / JPL)
const PLANET_ELEMENTS = {
  mercury: { name: "Mercury", a: [0.38709927, 0.00000037], e: [0.20563593, 0.00001906], I: [7.00497902, -0.00594749], L: [252.25032350, 149472.67411175], wbar: [77.45779628, 0.16047689], Omega: [48.33076593, -0.12534081] },
  venus:   { name: "Venus",   a: [0.72333566, 0.00000390], e: [0.00677672, -0.00004107], I: [3.39467605, -0.00078890], L: [181.97909950, 58517.81538729], wbar: [131.60246718, 0.00268329], Omega: [76.67984255, -0.27769418] },
  earth:   { name: "Earth",   a: [1.00000261, 0.00000562], e: [0.01671123, -0.00004392], I: [-0.00001531, -0.01294668], L: [100.46457166, 35999.37244981], wbar: [102.93768193, 0.32327364], Omega: [0.0, 0.0] },
  mars:    { name: "Mars",    a: [1.52371034, 0.00001847], e: [0.09339410, 0.00007882], I: [1.84969142, -0.00813131], L: [-4.55343205, 19140.30268499], wbar: [-23.94362959, 0.44441088], Omega: [49.55953891, -0.29257343] },
  jupiter: { name: "Jupiter", a: [5.20288700, -0.00011607], e: [0.04838624, -0.00013253], I: [1.30439695, -0.00183714], L: [34.39644051, 3034.74612775], wbar: [14.72847983, 0.21252668], Omega: [100.47390909, 0.20469106] },
  saturn:  { name: "Saturn",  a: [9.53667594, -0.00125060], e: [0.05386179, -0.00050991], I: [2.48599187, 0.00193609], L: [49.95424423, 1222.49362201], wbar: [92.59887831, -0.41897216], Omega: [113.66242448, -0.28867794] },
  uranus:  { name: "Uranus",  a: [19.18916464, -0.00196176], e: [0.04725744, -0.00004397], I: [0.77263783, -0.00242939], L: [313.23810451, 428.48202785], wbar: [170.95427630, 0.40805281], Omega: [74.01692503, 0.04240589] },
  neptune: { name: "Neptune", a: [30.06992276, 0.00026291], e: [0.00859048, 0.00005105], I: [1.77004347, 0.00035372], L: [-55.12002969, 218.45945325], wbar: [44.96476227, -0.32241464], Omega: [131.78422574, -0.00508664] },
};

function computePlanetPosition(key, date = new Date()) {
  const p = PLANET_ELEMENTS[key];
  if (!p) return null;
  // Julian centuries since J2000.0 (2000-01-01T12:00:00Z = 946728000000 ms)
  const T = (date.getTime() - 946728000000) / (86400000 * 36525);
  const a = p.a[0] + p.a[1] * T;
  const e = p.e[0] + p.e[1] * T;
  const I = (p.I[0] + p.I[1] * T) * DEG2RAD;
  const L = p.L[0] + p.L[1] * T;
  const wbar = p.wbar[0] + p.wbar[1] * T;
  const Omega = (p.Omega[0] + p.Omega[1] * T) * DEG2RAD;
  const omega = (wbar - (p.Omega[0] + p.Omega[1] * T)) * DEG2RAD;

  let M = ((L - wbar) % 360) * DEG2RAD;
  if (M > Math.PI) M -= 2 * Math.PI;
  if (M < -Math.PI) M += 2 * Math.PI;

  let E = M + e * Math.sin(M);
  for (let iter = 0; iter < 6; iter++) {
    const dE = (M - (E - e * Math.sin(E))) / (1 - e * Math.cos(E));
    E += dE;
  }

  const xv = a * (Math.cos(E) - e);
  const yv = a * Math.sqrt(Math.max(0, 1 - e * e)) * Math.sin(E);
  const rAU = Math.hypot(xv, yv);

  const cosO = Math.cos(Omega), sinO = Math.sin(Omega);
  const cosw = Math.cos(omega), sinw = Math.sin(omega);
  const cosI = Math.cos(I), sinI = Math.sin(I);

  // Ecliptic heliocentric coordinates (AU)
  const xecl = (cosw * cosO - sinw * sinO * cosI) * xv + (-sinw * cosO - cosw * sinO * cosI) * yv;
  const yecl = (cosw * sinO + sinw * cosO * cosI) * xv + (-sinw * sinO + cosw * cosO * cosI) * yv;
  const zecl = (sinw * sinI) * xv + (cosw * sinI) * yv;

  // Convert ecliptic J2000 to equatorial J2000 (matching RA/Dec & HYG xyz frame)
  const eps = 23.43928 * DEG2RAD;
  const xAU = xecl;
  const yAU = yecl * Math.cos(eps) - zecl * Math.sin(eps);
  const zAU = yecl * Math.sin(eps) + zecl * Math.cos(eps);

  return {
    name: p.name,
    rAU,
    xAU,
    yAU,
    zAU,
    xScaled: xAU * SS_SCALE,
    yScaled: yAU * SS_SCALE,
    zScaled: zAU * SS_SCALE,
    xPc: xAU / AU_PER_PC,
    yPc: yAU / AU_PER_PC,
    zPc: zAU / AU_PER_PC,
  };
}

function getScaledPlanetPos(name, date = new Date()) {
  if (!name) return null;
  const k = String(name).trim().toLowerCase();
  if (k === "sun" || k === "sol") return [0, 0, 0];
  const p = computePlanetPosition(k, date);
  if (!p) return null;
  return [p.xScaled, p.yScaled, p.zScaled];
}

export function zoomStepFor(distance) {
  const d = Number.isFinite(distance) && distance > 0 ? distance : 1;
  return Math.max(1e-4, Math.min(d * 0.18, 400));
}

const PLANET_KEYS = ["mercury", "venus", "earth", "mars", "jupiter", "saturn", "uranus", "neptune"];
const PLANET_COLORS = {
  sun:     [1.0, 0.92, 0.55],
  mercury: [0.78, 0.76, 0.74],
  venus:   [0.98, 0.88, 0.66],
  earth:   [0.45, 0.75, 1.0],
  mars:    [1.0, 0.52, 0.36],
  jupiter: [0.95, 0.82, 0.66],
  saturn:  [0.94, 0.86, 0.62],
  uranus:  [0.62, 0.9, 0.95],
  neptune: [0.46, 0.66, 1.0],
};

const solarSystem = {
  points: null,
  pos: null,
  col: null,
  size: null,
  bodies: [],
  labelLayer: null,
  labelEls: [],
};

const hyg = { cutoffPc: 0, n: 0, maxDistPc: 0, pos: null, mag: null, names: [], named: [], points: null, alpha: 0, labels: 0, labelLayer: null, labelEls: [], error: "", bytes: 0 };

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
  viewSelect: document.getElementById("viewpoint-select"),
  freeRoamToggle: document.getElementById("free-roam-toggle"),
  viewBanner: document.getElementById("viewpoint-banner"),
  starSearch: document.getElementById("star-search"),
  starSearchList: document.getElementById("star-search-list"),
};

const nav = {
  freeRoam: el.freeRoamToggle ? el.freeRoamToggle.checked : true,
  viewpoint: "free",
  viewpointLabel: "",
  searchNotice: "",
  lastZoomStep: 0,
  nearestStarDist: Infinity,
  nearestStarFrame: -999,
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
  fallbackNote: "",
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
let attachHyg = () => {};
let hygReady = Promise.resolve(false);
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

function escapeHtml(value) {
  return String(value).replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]));
}

function tileFileName(tile) {
  const url = String(tile && tile.url ? tile.url : "");
  const name = url.split("/").pop().split("?")[0];
  if (name && name.endsWith(".bin")) return name;
  return `${tile && tile.id ? tile.id : "tile"}.bin`;
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
    let res;
    try {
      res = await fetch(url, { cache: "no-cache" });
    } catch (err) {
      lastErr = new Error("tiles.json network error");
      continue;
    }
    if (!res.ok) {
      lastErr = new Error(`tiles.json ${res.status}`);
      continue;
    }
    try {
      return await res.json();
    } catch (err) {
      const detail = err && err.message ? err.message : "invalid JSON";
      throw new Error(`tiles.json parse error: ${detail}`);
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
  const file = tileFileName(tile);
  let res;
  try {
    res = await fetch(tile.url, { cache: "no-cache" });
  } catch (err) {
    throw new Error(`${file} network error`);
  }
  if (!res.ok) throw new Error(`${file} ${res.status}`);
  const buffer = await res.arrayBuffer();
  if (buffer.byteLength < RECORD_SIZE) {
    throw new Error(`${file} too small`);
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

function ensureFarBuffers(capacity) {
  if (!isFinite(capacity) || capacity <= 0) capacity = FAR_BUDGET;
  if (gpu.farPos && gpu.farPos.length / 3 >= capacity) return;
  const cap = capacity;
  const oldPos = gpu.farPos;
  const oldCol = gpu.farCol;
  const oldSize = gpu.farSize;
  gpu.farPos = new Float32Array(cap * 3);
  gpu.farCol = new Float32Array(cap * 3);
  gpu.farSize = new Float32Array(cap);
  if (oldPos && lod.tileFarCount > 0) {
    gpu.farPos.set(oldPos.subarray(0, lod.tileFarCount * 3));
    gpu.farCol.set(oldCol.subarray(0, lod.tileFarCount * 3));
    gpu.farSize.set(oldSize.subarray(0, lod.tileFarCount));
  }
  gpu.farCapacity = cap;
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
    const limit = Math.min(count, PREVIEW_BUDGET);
    let far = 0;
    for (let i = 0; i < limit; i++) {
      if (!readStar(view, i, pos)) continue;
      accumulateFrame(stats, pos);
      gpu.previewPos[far*3] = pos.x;
      gpu.previewPos[far*3+1] = pos.y;
      gpu.previewPos[far*3+2] = pos.z;
      writeFarAppearance(gpu.previewCol, gpu.previewSize, far, readColorClass(view, i), readMag(view, i));
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
  const n = lod.tileFarCount || lod.farCount;
  const geo = gpu.far.geometry;
  const pos = geo.attributes.position;
  const col = geo.attributes.color;
  const size = geo.attributes.aSize;
  pos.clearUpdateRanges();
  col.clearUpdateRanges();
  size.clearUpdateRanges();
  pos.needsUpdate = true;
  col.needsUpdate = true;
  size.needsUpdate = true;
  geo.setDrawRange(0, n);
  publishPreview();
}

function clearPreviewState() {
  lod.previewFarCount = 0;
  lod.tileFarCount = 0;
  lod.farCount = 0;
  if (gpu.far) gpu.far.geometry.setDrawRange(0, 0);
  publishPreview();
}

function retargetFarMesh() {
  if (!sceneStarted || !gpu.far || !gpu.farPos) return;
  const geo = gpu.far.geometry;
  const pos = new THREE.BufferAttribute(gpu.farPos, 3);
  const col = new THREE.BufferAttribute(gpu.farCol, 3);
  const size = new THREE.BufferAttribute(gpu.farSize, 1);
  pos.setUsage(THREE.DynamicDrawUsage);
  col.setUsage(THREE.DynamicDrawUsage);
  size.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("position", pos);
  geo.setAttribute("color", col);
  geo.setAttribute("aSize", size);
  publishFar();
  const frame = catalog.frame;
  if (!frame || !viewCamera || !viewControls) return;
  viewControls.target.set(frame.targetX, frame.targetY, frame.targetZ);
  viewCamera.position.set(frame.cameraX, frame.cameraY, frame.cameraZ);
  viewCamera.lookAt(frame.targetX, frame.targetY, frame.targetZ);
  viewCamera.updateProjectionMatrix();
  viewControls.update();
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

async function ingestTile(tile, buffer) {
  await hygReady;
  if (!catalog.layoutReady) {
    const probe = new DataView(buffer);
    catalog.layout = detectLayout(probe, Math.floor(buffer.byteLength / RECORD_SIZE));
    catalog.layoutReady = true;
  }

  const seg = appendTileBytes(buffer);
  const stats = sceneStarted ? null : emptyFrameStats();
  await ingestFarRange(seg.base, seg.count, stats);

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
    publishPreview();
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

function downloadTilesInOrder(tiles) {
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
              return enqueueIngest(() => ingestTile(tile, buffer));
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
  const capacity = Number(index.total_records) || tiles.reduce((sum, tile) => sum + tileRecordEstimate(tile), 0);
  ensureFarBuffers(capacity);
  ensureNearBuffers();
  ensurePreviewBuffers();

  startHygLoad();
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
  await downloadTilesInOrder(tiles);

  if (lod.tileFarCount > 0) {
    dropPreview();
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
  markFallbackFar(far);

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
            if (isHygDuplicate(view, i)) {
              continue;
            }
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
  const hygN = hyg.points && hyg.points.visible ? hyg.n : 0;
  const dupSkipped = lod.hygDupSkipped || 0;
  el.mode.textContent = lod.mode === "near" ? "LOD NEAR" : "LOD FAR";
  el.mode.dataset.mode = lod.mode;
  el.count.textContent = `${lod.farCount.toLocaleString()} far · ${lod.nearCount.toLocaleString()} near · ${hygN} HYG · ${tileNote}`;
  const farLine = previewing
    ? `FAR preview ${lod.farCount.toLocaleString()} stars, not counted in the catalog`
    : total > 1
      ? `FAR all ${lod.tileFarCount.toLocaleString()} loaded stars drawn in one GPU buffer`
      : `FAR stride ${catalog.stride} → ${lod.farCount.toLocaleString()} generalized across loaded tiles`;
  let hygLine = "";
  if (hyg.error) {
    hygLine = `<br>HYG close-up: ${escapeHtml(hyg.error)}`;
  } else if (hyg.n > 0) {
    hygLine = `<br>HYG close-up: ${hyg.n} nearest stars ≤ ${hyg.maxDistPc.toFixed(1)} pc, ${hyg.named.length} named` +
      (dupSkipped > 0 ? ` · ${dupSkipped} Gaia duplicates hidden` : "") +
      (hyg.alpha > 0.02 ? " · visible" : " · zoom in to see");
  }
  const errLines = catalog.tileErrors.length
    ? catalog.tileErrors
    : catalog.fallbackNote
      ? [catalog.fallbackNote]
      : [];
  const errNote = errLines.length ? `<br>${errLines.map(escapeHtml).join("<br>")}` : "";
  const vpLine = nav.viewpointLabel ? `<strong>${escapeHtml(nav.viewpointLabel)}</strong><br>` : "";
  const searchLine = nav.searchNotice ? `<strong>${escapeHtml(nav.searchNotice)}</strong><br>` : "";
  setStatus(
    searchLine +
    vpLine +
    `<strong>${catalog.count.toLocaleString()} records</strong> · ${mb} MiB loaded · ${tileNote} · 62 B LE · ${layoutNote}<br>` +
      `${farLine}${hygLine}<br>` +
      (previewing
        ? `Coarse sky preview is on screen. Tile records replace those points as they arrive.`
        : waiting
          ? `Showing stars from the first tiles in. The rest fill in on this same view.`
          : lod.mode === "near"
          ? `NEAR accurate subset ${lod.nearCount.toLocaleString()} (cap ${NEAR_BUDGET.toLocaleString()}) within ${catalog.nearRadius.toFixed(1)} of target`
          : `Zoom in toward a region to load an accurate nearby subset`) +
      errNote +
      `<br>No full star-object array. Drag to orbit · pinch or scroll to zoom · two-finger twist to rotate · right-drag to pan`
  );
}

function makeSolarSystemPoints() {
  if (solarSystem.points) return solarSystem.points;
  const count = 1 + PLANET_KEYS.length;
  solarSystem.pos = new Float32Array(count * 3);
  solarSystem.col = new Float32Array(count * 3);
  solarSystem.size = new Float32Array(count);
  const pts = makePoints(solarSystem.pos, solarSystem.col, solarSystem.size, count);
  pts.frustumCulled = false;
  pts.visible = false;
  pts.renderOrder = 3;
  solarSystem.points = pts;
  updateSolarSystemPositions();
  return pts;
}

function updateSolarSystemPositions(date = new Date()) {
  if (!solarSystem.pos) return;
  const bodies = [];
  // Index 0: Sun at origin
  solarSystem.pos[0] = 0;
  solarSystem.pos[1] = 0;
  solarSystem.pos[2] = 0;
  const sunCol = PLANET_COLORS.sun;
  solarSystem.col[0] = sunCol[0];
  solarSystem.col[1] = sunCol[1];
  solarSystem.col[2] = sunCol[2];
  solarSystem.size[0] = 7.5;
  bodies.push({ key: "sun", name: "Sun", x: 0, y: 0, z: 0, rAU: 0 });

  for (let i = 0; i < PLANET_KEYS.length; i++) {
    const key = PLANET_KEYS[i];
    const p = computePlanetPosition(key, date);
    const idx = i + 1;
    const x = p ? p.xScaled : 0;
    const y = p ? p.yScaled : 0;
    const z = p ? p.zScaled : 0;
    solarSystem.pos[idx * 3] = x;
    solarSystem.pos[idx * 3 + 1] = y;
    solarSystem.pos[idx * 3 + 2] = z;
    const rgb = PLANET_COLORS[key] || [0.9, 0.9, 1.0];
    solarSystem.col[idx * 3] = rgb[0];
    solarSystem.col[idx * 3 + 1] = rgb[1];
    solarSystem.col[idx * 3 + 2] = rgb[2];
    solarSystem.size[idx] = 5.0;
    bodies.push({
      key,
      name: p ? p.name : key,
      x,
      y,
      z,
      rAU: p ? p.rAU : 0,
    });
  }
  solarSystem.bodies = bodies;
  if (solarSystem.points) {
    const geo = solarSystem.points.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.attributes.aSize.needsUpdate = true;
    geo.setDrawRange(0, bodies.length);
  }
}

function ensureSolarSystemLabelLayer(parent) {
  if (!solarSystem.labelLayer) {
    solarSystem.labelLayer = document.createElement("div");
    solarSystem.labelLayer.className = "star-labels";
    parent.appendChild(solarSystem.labelLayer);
  }
  return solarSystem.labelLayer;
}

function updateSolarSystemVisibility() {
  const show = nav.viewpoint !== "free";
  if (solarSystem.points) {
    if (show) updateSolarSystemPositions();
    solarSystem.points.visible = show;
  }
  if (!show && solarSystem.labelEls.length) {
    for (const el of solarSystem.labelEls) el.style.display = "none";
  }
}

function updateSolarSystemLabels(camera, width, height) {
  const show = nav.viewpoint !== "free";
  if (!show || !solarSystem.labelLayer || !solarSystem.points || !solarSystem.points.visible) {
    for (const el of solarSystem.labelEls) el.style.display = "none";
    return;
  }
  updateSolarSystemLabels.v ||= new THREE.Vector3();
  const v = updateSolarSystemLabels.v;
  let shown = 0;
  for (let i = 0; i < solarSystem.bodies.length; i++) {
    const b = solarSystem.bodies[i];
    if (b.key === nav.viewpoint) continue; // Camera is on this planet
    v.set(b.x, b.y, b.z);
    v.project(camera);
    const x = v.x, y = v.y, z = v.z;
    if (z <= -1 || z >= 1 || Math.abs(x) > 1 || Math.abs(y) > 1) continue;
    const sx = (x + 1) / 2 * width;
    const sy = (1 - y) / 2 * height;
    let lbl = solarSystem.labelEls[shown];
    if (!lbl) {
      lbl = document.createElement("span");
      lbl.className = "star-label planet-label";
      solarSystem.labelLayer.appendChild(lbl);
      solarSystem.labelEls.push(lbl);
    }
    if (lbl.textContent !== b.name) lbl.textContent = b.name;
    lbl.style.transform = `translate(${sx | 0}px, ${sy | 0}px)`;
    lbl.style.display = "block";
    lbl.style.opacity = "1";
    shown++;
  }
  for (let i = shown; i < solarSystem.labelEls.length; i++) {
    solarSystem.labelEls[i].style.display = "none";
  }
}

function computeNearPlane(frame) {
  return nav.freeRoam || nav.viewpoint !== "free"
    ? 0.0001
    : Math.max(frame.dist * 0.01, 0.05);
}

function applyNavigationMode() {
  if (!viewControls || !viewCamera || !catalog.frame) return;
  const frame = catalog.frame;
  const skyReach = catalog.tileTotal > 1 ? SKY_RADIUS * 16 : 0;
  const maxDist = Math.max(frame.extent * 14, frame.dist * 6, skyReach);
  const clampedMinDist = Math.max(frame.extent * 0.12, 0.4);

  updateSolarSystemVisibility();

  if (nav.viewpoint === "solar") {
    nav.searchNotice = "";
    updateSolarSystemPositions();
    // Frame the whole scaled solar system (Neptune ~ 30 AU * 0.05 pc/AU = 1.5 pc)
    const sysRadius = 30.2 * SS_SCALE;
    const fov = (viewCamera.fov || 55) * DEG2RAD;
    const camDist = (sysRadius * 1.45) / Math.tan(fov * 0.5);
    viewControls.target.set(0, 0, 0);
    viewCamera.position.set(0, -camDist * 0.65, camDist * 0.76);
    viewCamera.lookAt(0, 0, 0);
    viewControls.minDistance = 0;
    viewControls.maxDistance = maxDist;
    viewControls.enableZoom = false;
    viewControls.enablePan = true;
    viewControls.rotateSpeed = 1.0;
    viewCamera.near = 0.0001;
    viewCamera.updateProjectionMatrix();
    viewControls.update();

    const label = `Solar system (scaled: 1 AU = ${SS_SCALE} pc, not to scale vs stars · Neptune ≈ ${(30.07 * SS_SCALE).toFixed(2)} pc)`;
    nav.viewpointLabel = label;
    if (el.viewBanner) {
      el.viewBanner.textContent = label;
      el.viewBanner.hidden = false;
    }
    updateHud();
    nearRefresh();
    return;
  }

  if (nav.viewpoint !== "free") {
    const p = computePlanetPosition(nav.viewpoint);
    if (p) {
      // First-person look-around from planet's SCALED position in the solar-system frame (1 AU = SS_SCALE pc)
      const lookAhead = 1e-4;
      const px = p.xScaled;
      const py = p.yScaled;
      const pz = p.zScaled;
      viewCamera.position.set(px, py, pz);
      // Aim outward from the Sun (or default galactic center direction)
      const rLen = Math.hypot(px, py, pz);
      const dx = rLen > 0 ? px / rLen : 0;
      const dy = rLen > 0 ? py / rLen : -0.98;
      const dz = rLen > 0 ? pz / rLen : -0.17;
      viewControls.target.set(
        px + dx * lookAhead,
        py + dy * lookAhead,
        pz + dz * lookAhead
      );
      viewControls.minDistance = lookAhead;
      viewControls.maxDistance = lookAhead;
      viewControls.enableZoom = false;
      viewControls.enablePan = false;
      viewControls.rotateSpeed = -0.5;
      viewCamera.near = computeNearPlane(frame);
      viewCamera.updateProjectionMatrix();
      viewControls.update();

      const label = `Viewing from ${p.name} (approx. ${p.rAU.toFixed(2)} AU from Sun · solar system drawn at 1 AU = ${SS_SCALE} pc)`;
      nav.viewpointLabel = label;
      if (el.viewBanner) {
        el.viewBanner.textContent = label;
        el.viewBanner.hidden = false;
      }
      updateHud();
      nearRefresh();
      return;
    }
  }

  if (!nav.searchNotice) {
    nav.viewpointLabel = "";
    if (el.viewBanner) {
      el.viewBanner.textContent = "";
      el.viewBanner.hidden = true;
    }
  }
  viewControls.minDistance = nav.freeRoam ? 0 : clampedMinDist;
  viewControls.maxDistance = maxDist;
  viewControls.enableZoom = false;
  viewControls.enablePan = true;
  viewControls.rotateSpeed = 1.0;
  viewCamera.near = computeNearPlane(frame);
  viewCamera.updateProjectionMatrix();
  updateHud();
}

function setViewpoint(value) {
  nav.viewpoint = value || "free";
  nav.searchNotice = "";
  if (el.viewSelect && el.viewSelect.value !== nav.viewpoint) {
    el.viewSelect.value = nav.viewpoint;
  }
  if (!viewCamera || !viewControls || !catalog.frame) return;
  if (nav.viewpoint === "free") {
    const frame = catalog.frame;
    viewControls.target.set(frame.targetX, frame.targetY, frame.targetZ);
    viewCamera.position.set(frame.cameraX, frame.cameraY, frame.cameraZ);
    viewCamera.lookAt(frame.targetX, frame.targetY, frame.targetZ);
    applyNavigationMode();
    viewControls.update();
    nearRefresh();
  } else {
    applyNavigationMode();
  }
}

function setFreeRoam(enabled) {
  nav.freeRoam = Boolean(enabled);
  if (el.freeRoamToggle && el.freeRoamToggle.checked !== nav.freeRoam) {
    el.freeRoamToggle.checked = nav.freeRoam;
  }
  if (nav.viewpoint !== "free") {
    updateHud();
    return;
  }
  applyNavigationMode();
  nearRefresh();
}

if (el.viewSelect) {
  el.viewSelect.addEventListener("change", (e) => {
    setViewpoint(e.target.value);
  });
}

if (el.freeRoamToggle) {
  el.freeRoamToggle.addEventListener("change", (e) => {
    setFreeRoam(e.target.checked);
  });
}

function populateSearchSuggestions() {
  if (!el.starSearchList || !hyg.named.length) return;
  el.starSearchList.innerHTML = "";
  const cap = Math.min(hyg.named.length, 250);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < cap; i++) {
    const idx = hyg.named[i];
    const name = hyg.names[idx];
    if (!name) continue;
    const opt = document.createElement("option");
    opt.value = name;
    frag.appendChild(opt);
  }
  el.starSearchList.appendChild(frag);
}

function searchStarCatalog(rawQuery) {
  const q = String(rawQuery == null ? "" : rawQuery).trim();
  if (!q) return { hit: false, name: "", pos: null };

  // Check HIP / HD prefix first
  if (/^(hip|hd)\b/i.test(q) || /^(hip|hd)\s*\d+/i.test(q)) {
    nav.searchNotice = "HIP/HD IDs not in this dataset";
    if (el.viewBanner) {
      el.viewBanner.textContent = nav.searchNotice;
      el.viewBanner.hidden = false;
    }
    updateHud();
    return { hit: false, name: "", pos: null, reason: "HIP/HD IDs not in this dataset" };
  }

  let hitName = "";
  let hitPos = null;

  // 1) All-digit query (>= 6 digits): linear scan of loaded tile buffers for int64 LE Gaia DR3 source_id at offset 0
  if (/^\d{6,}$/.test(q) && catalog.view && catalog.count > 0) {
    let targetId = null;
    try {
      targetId = BigInt(q);
    } catch (_) {
      targetId = null;
    }
    if (targetId !== null) {
      const view = catalog.view;
      const total = catalog.count;
      const pos = scratch;
      for (let i = 0; i < total; i++) {
        const sid = view.getBigInt64(i * RECORD_SIZE, true);
        if (sid === targetId) {
          if (readStar(view, i, pos)) {
            hitName = `Gaia DR3 ${q}`;
            hitPos = [pos.x, pos.y, pos.z];
          }
          break;
        }
      }
    }
  }

  // 2) HYG name search: case-insensitive exact -> prefix -> substring
  if (!hitPos && hyg.n > 0 && hyg.names && hyg.pos) {
    const ql = q.toLowerCase();
    let bestIdx = -1;
    // Check named list (already sorted brightest first)
    for (let k = 0; k < hyg.named.length; k++) {
      const idx = hyg.named[k];
      const nm = hyg.names[idx];
      if (nm && nm.toLowerCase() === ql) {
        bestIdx = idx;
        break;
      }
    }
    if (bestIdx < 0) {
      for (let k = 0; k < hyg.named.length; k++) {
        const idx = hyg.named[k];
        const nm = hyg.names[idx];
        if (nm && nm.toLowerCase().startsWith(ql)) {
          bestIdx = idx;
          break;
        }
      }
    }
    if (bestIdx < 0) {
      for (let k = 0; k < hyg.named.length; k++) {
        const idx = hyg.named[k];
        const nm = hyg.names[idx];
        if (nm && nm.toLowerCase().includes(ql)) {
          bestIdx = idx;
          break;
        }
      }
    }
    if (bestIdx >= 0) {
      hitName = hyg.names[bestIdx];
      hitPos = [
        hyg.pos[bestIdx * 3],
        hyg.pos[bestIdx * 3 + 1],
        hyg.pos[bestIdx * 3 + 2],
      ];
    }
  }

  if (!hitPos) {
    nav.searchNotice = `No star found for "${q}"`;
    if (el.viewBanner) {
      el.viewBanner.textContent = nav.searchNotice;
      el.viewBanner.hidden = false;
    }
    updateHud();
    return { hit: false, name: "", pos: null };
  }

  // Stop any planet / solar system view -> set viewpoint to Free view
  nav.viewpoint = "free";
  if (el.viewSelect && el.viewSelect.value !== "free") {
    el.viewSelect.value = "free";
  }

  const [sx, sy, sz] = hitPos;
  const distFromSun = Math.hypot(sx, sy, sz);
  const label = `Star: ${hitName} · d=${distFromSun.toFixed(2)} pc`;
  nav.viewpointLabel = label;
  nav.searchNotice = label;
  if (el.viewBanner) {
    el.viewBanner.textContent = label;
    el.viewBanner.hidden = false;
  }

  if (viewCamera && viewControls && catalog.frame) {
    applyNavigationMode();
    // Determine current view direction (camera -> target), fallback to Sun->star or +Z
    const dir = new THREE.Vector3().subVectors(viewControls.target, viewCamera.position);
    if (dir.lengthSq() < 1e-10) {
      viewCamera.getWorldDirection(dir);
    }
    if (dir.lengthSq() < 1e-10) {
      dir.set(0, 0, -1);
    } else {
      dir.normalize();
    }
    // Sensible standoff distance: max(0.05, min(0.5, 2% of distance from Sun))
    const standoff = Math.max(0.05, Math.min(0.5, distFromSun > 0 ? distFromSun * 0.02 : 0.5));
    viewControls.target.set(sx, sy, sz);
    viewCamera.position.set(
      sx - dir.x * standoff,
      sy - dir.y * standoff,
      sz - dir.z * standoff
    );
    viewCamera.lookAt(sx, sy, sz);
    viewCamera.updateProjectionMatrix();
    viewControls.update();
    nearRefresh();
  }
  updateHud();

  return { hit: true, name: hitName, pos: [sx, sy, sz] };
}

if (el.starSearch) {
  el.starSearch.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      searchStarCatalog(el.starSearch.value);
    }
  });
  el.starSearch.addEventListener("change", () => {
    if (el.starSearch.value.trim()) {
      searchStarCatalog(el.starSearch.value);
    }
  });
  el.starSearch.addEventListener("search", () => {
    if (el.starSearch.value.trim()) {
      searchStarCatalog(el.starSearch.value);
    }
  });
}

function computeNearestLocalDistance(camera, controls, frameIdx) {
  const distToTarget = camera.position.distanceTo(controls.target);
  if (frameIdx - nav.nearestStarFrame >= 4) {
    nav.nearestStarFrame = frameIdx;
    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;
    let bestD2 = Infinity;
    if (hyg.pos && hyg.n > 0) {
      const p = hyg.pos;
      const n3 = hyg.n * 3;
      for (let i = 0; i < n3; i += 3) {
        const dx = p[i] - cx;
        const dy = p[i + 1] - cy;
        const dz = p[i + 2] - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD2) bestD2 = d2;
      }
    }
    if (gpu.nearPos && lod.nearCount > 0) {
      const p = gpu.nearPos;
      const n3 = lod.nearCount * 3;
      for (let i = 0; i < n3; i += 3) {
        const dx = p[i] - cx;
        const dy = p[i + 1] - cy;
        const dz = p[i + 2] - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD2) bestD2 = d2;
      }
    }
    nav.nearestStarDist = bestD2 < Infinity ? Math.sqrt(bestD2) : Infinity;
  }
  const dStar = nav.nearestStarDist;
  const dRef = Math.min(
    distToTarget > 1e-6 ? distToTarget : Infinity,
    dStar > 1e-6 ? dStar : Infinity
  );
  return Number.isFinite(dRef) ? dRef : Math.max(distToTarget, 0.1);
}

function initScene() {
  if (sceneStarted) return;
  trace.frame = 0;
  const frame = catalog.frame;
  const scene = new THREE.Scene();
  const fogDist = catalog.tileTotal > 1 ? Math.max(frame.dist, SKY_RADIUS * 2) : frame.dist;
  const fogDensity = Math.min(0.012, 0.45 / Math.max(fogDist, 8));
  scene.fog = new THREE.FogExp2(0x05070d, fogDensity);

  const camera = new THREE.PerspectiveCamera(
    55,
    el.canvasWrap.clientWidth / Math.max(el.canvasWrap.clientHeight, 1),
    computeNearPlane(frame),
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
  controls.minDistance = nav.freeRoam ? 0 : Math.max(frame.extent * 0.12, 0.4);
  const skyReach = catalog.tileTotal > 1 ? SKY_RADIUS * 16 : 0;
  controls.maxDistance = Math.max(frame.extent * 14, frame.dist * 6, skyReach);
  controls.target.set(frame.targetX, frame.targetY, frame.targetZ);
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_ROTATE };
  controls.enableZoom = false;
  controls.zoomSpeed = 1.2;

  viewCamera = camera;
  viewControls = controls;
  if (new URLSearchParams(location.search).has("debug")) {
    window.__nav = {
      camera,
      controls,
      lastZoomStep: 0,
      zoomStepFor,
      search: searchStarCatalog,
      planetPos: getScaledPlanetPos,
    };
  }

  const ssPoints = makeSolarSystemPoints();
  if (ssPoints) scene.add(ssPoints);
  ensureSolarSystemLabelLayer(el.canvasWrap);

  if (nav.viewpoint !== "free") {
    applyNavigationMode();
  }

  gpu.far = makePoints(gpu.farPos, gpu.farCol, gpu.farSize, lod.tileFarCount);
  gpu.far.geometry.attributes.position.count = gpu.farPos.length / 3;
  gpu.far.geometry.attributes.color.count = gpu.farCol.length / 3;
  gpu.far.geometry.attributes.aSize.count = gpu.farSize.length;
  gpu.far.geometry.setDrawRange(0, lod.tileFarCount);
  gpu.far.frustumCulled = false;

  gpu.near = makePoints(gpu.nearPos, gpu.nearCol, gpu.nearSize, 0);
  gpu.near.visible = false;

  scene.add(gpu.far);
  scene.add(gpu.near);

  if (gpu.previewPos) {
    gpu.preview = makePoints(gpu.previewPos, gpu.previewCol, gpu.previewSize, lod.previewFarCount);
    gpu.preview.geometry.attributes.position.count = gpu.previewPos.length / 3;
    gpu.preview.geometry.attributes.color.count = gpu.previewCol.length / 3;
    gpu.preview.geometry.attributes.aSize.count = gpu.previewSize.length;
    gpu.preview.geometry.setDrawRange(0, lod.previewFarCount);
    gpu.preview.frustumCulled = false;
    gpu.preview.visible = lod.previewFarCount > 0;
    scene.add(gpu.preview);
  }

  if (catalog.layout === "xyz") {
    const origin = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xffe08a })
    );
    scene.add(origin);
  }

  attachHyg = () => {
    if (hyg.points || !hyg.n) return;
    const pts = makeHygPoints();
    if (pts) scene.add(pts);
    ensureHygLabelLayer(el.canvasWrap);
    populateSearchSuggestions();
  };
  attachHyg();

  function onResize() {
    const w = el.canvasWrap.clientWidth;
    const h = Math.max(el.canvasWrap.clientHeight, 1);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
  window.addEventListener("resize", onResize);

  const wrap = el.canvasWrap;
  wrap.style.touchAction = "none";
  ["gesturestart", "gesturechange", "gestureend"].forEach(ev => {
    wrap.addEventListener(ev, e => e.preventDefault(), { passive: false });
  });

  // Unified distance-scaled (exponential) zoom + fly-through dolly along the view ray.
  // OrbitControls zoom is disabled; wheel and two-finger pinch move the camera by
  // step = zoomStepFor(dRef) * notches (with dRef = min(dist to target, dist to nearest star)).
  // When Free roam is enabled and the camera approaches controls.target, target is pushed
  // forward along the view ray so the camera flies smoothly through the origin and beyond.
  const DOLLY_FLOOR = 0.25;
  const viewDir = new THREE.Vector3();

  function applyZoomDolly(notches) {
    if (nav.viewpoint !== "free" && nav.viewpoint !== "solar") return;
    if (!Number.isFinite(notches) || Math.abs(notches) < 1e-6) return;

    const dRef = computeNearestLocalDistance(camera, controls, trace.frame || 0);
    const baseStep = zoomStepFor(dRef);
    const signedMove = baseStep * notches;
    const stepMag = Math.abs(signedMove);
    nav.lastZoomStep = stepMag;
    if (window.__nav) window.__nav.lastZoomStep = stepMag;

    viewDir.subVectors(controls.target, camera.position);
    const distToTarget = viewDir.length();
    if (distToTarget > 1e-8) {
      viewDir.divideScalar(distToTarget);
    } else {
      camera.getWorldDirection(viewDir);
    }

    const canFlyThrough = nav.freeRoam && nav.viewpoint === "free";
    if (signedMove > 0) {
      // Zooming in (moving forward along viewDir)
      if (canFlyThrough) {
        camera.position.addScaledVector(viewDir, signedMove);
        const remaining = distToTarget - signedMove;
        if (remaining < DOLLY_FLOOR) {
          controls.target.copy(camera.position).addScaledVector(viewDir, DOLLY_FLOOR);
        }
      } else {
        const minDist = Math.max(controls.minDistance || 0, 0.02);
        const maxAdvance = Math.max(0, distToTarget - minDist);
        const advance = Math.min(signedMove, maxAdvance);
        camera.position.addScaledVector(viewDir, advance);
      }
    } else {
      // Zooming out (moving backward along viewDir)
      const retreat = Math.min(-signedMove, controls.maxDistance || 1e6);
      camera.position.addScaledVector(viewDir, -retreat);
    }
  }

  renderer.domElement.addEventListener(
    "wheel",
    (e) => {
      if (nav.viewpoint !== "free" && nav.viewpoint !== "solar") return;
      e.preventDefault();
      const raw = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY;
      const notches = Math.max(-4, Math.min(4, -raw / 100));
      applyZoomDolly(notches);
    },
    { passive: false }
  );

  let pinchPrevSpan = 0;
  renderer.domElement.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        pinchPrevSpan = Math.hypot(dx, dy);
      } else {
        pinchPrevSpan = 0;
      }
    },
    { passive: true }
  );

  renderer.domElement.addEventListener(
    "touchmove",
    (e) => {
      if ((nav.viewpoint !== "free" && nav.viewpoint !== "solar") || e.touches.length !== 2) return;
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const span = Math.hypot(dx, dy);
      if (pinchPrevSpan > 0 && span > 0) {
        const notches = Math.log(span / pinchPrevSpan) * 3.5;
        if (Math.abs(notches) > 1e-4) {
          applyZoomDolly(notches);
        }
      }
      pinchPrevSpan = span;
    },
    { passive: true }
  );

  function maybeRefreshNear() {
    const dist = camera.position.distanceTo(controls.target);
    const wantNear = lod.mode === "near" ? dist < catalog.nearExit : dist < catalog.nearEnter;
    const moveEps = Math.max(frame.extent * 0.05, 0.2);
    const moved =
      controls.target.distanceToSquared(lod.lastTarget) > moveEps * moveEps ||
      Math.abs(dist - lod.lastDist) > moveEps * 1.6;

    if (wantNear && (lod.mode !== "near" || moved)) {
      let n = fillNear(controls.target);
      if (n === 0 && !nav.freeRoam && nav.viewpoint === "free") {
        const snap = findStarNearRay(camera, controls.target);
        if (snap) {
          controls.target.copy(snap);
          lod.nearSnaps = (lod.nearSnaps || 0) + 1;
          n = fillNear(controls.target);
        }
      }
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
    let n = fillNear(controls.target);
    if (n === 0 && lod.mode === "near" && !nav.freeRoam && nav.viewpoint === "free") {
      const snap = findStarNearRay(camera, controls.target);
      if (snap) {
        controls.target.copy(snap);
        lod.nearSnaps = (lod.nearSnaps || 0) + 1;
        n = fillNear(controls.target);
      }
    }
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
    const curDist = camera.position.distanceTo(controls.target);
    maybeRefreshNear();
    updateHygFade(camera);
    trace.cameraDist = curDist;
    if ((trace.frame || 0) % 6 === 0) {
      const cw = el.canvasWrap.clientWidth;
      const ch = el.canvasWrap.clientHeight;
      updateHygLabels(camera, cw, ch);
      updateSolarSystemLabels(camera, cw, ch);
    }
    renderer.render(scene, camera);
    trace.pointsDrawn = renderer.info.render.points;
    if (!trace.firstFrameMs && trace.pointsDrawn > 0) {
      trace.firstFrameMs = performance.now();
    }
    if (trace.sampleBright) {
      trace.brightPixels = countBrightPixels(renderer);
      trace.sampleBright = false;
    }
    trace.frame = (trace.frame || 0) + 1;
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
  const why = cause && cause.message ? cause.message : "No tile records loaded";
  let res;
  try {
    res = await fetch("data/catalog.bin", { cache: "no-cache" });
  } catch (err) {
    throw new Error(`${why}. catalog.bin network error`);
  }
  if (!res.ok) throw new Error(`${why}. catalog.bin ${res.status}`);
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

async function fallbackToCatalog(cause) {
  const listed = catalog.tileErrors.slice();
  catalog.fallbackNote = listed.length
    ? listed.join("; ")
    : (cause && cause.message) || "No tile records loaded";
  clearPreviewState();
  updateHud();
  try {
    await loadSingleCatalog(cause);
    setStatus(
      `Building FAR stride + spatial index over <strong>${catalog.count.toLocaleString()}</strong> records…`
    );
    await buildFarAndIndex();
    retargetFarMesh();
    initScene();
    updateHud();
  } catch (err) {
    clearPreviewState();
    console.error(err);
    setStatus(
      `Could not load <code>data/catalog.bin</code>. ${escapeHtml(err.message)}<br>` +
        `Drop a GaiaSource 62-byte LE shard (RA/Dec at +8/+16) or a StarIS xyz catalog as <code>data/catalog.bin</code>.`,
      true
    );
    el.count.textContent = "0 drawn";
    el.mode.textContent = "LOD error";
  }
}

async function main() {
  let tileErr = null;
  try {
    setStatus("Fetching <code>data/tiles.json</code>…");
    const index = await loadTilesIndex();
    const tiles = Array.isArray(index.tiles) ? index.tiles.slice() : [];
    if (!tiles.length) throw new Error("tiles.json has no tiles");
    await streamTiles(index, tiles);
  } catch (err) {
    tileErr = err;
  }

  if (sceneStarted && catalog.count > 0) {
    if (tileErr) {
      console.warn(tileErr);
      catalog.streamDone = true;
      if (lod.tileFarCount > 0) {
        lod.previewFarCount = 0;
        lod.farCount = lod.tileFarCount;
        publishFar();
      }
      updateHud();
    }
    return;
  }

  const cause =
    tileErr || new Error(catalog.tileErrors[0] || "No tile records loaded");
  await fallbackToCatalog(cause);
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

function ensurePreviewBuffers() {
  if (gpu.previewPos) return;
  gpu.previewPos = new Float32Array(PREVIEW_BUDGET * 3);
  gpu.previewCol = new Float32Array(PREVIEW_BUDGET * 3);
  gpu.previewSize = new Float32Array(PREVIEW_BUDGET);
}

function writeFarAppearance(col, size, offset, colorClass, mag) {
  const t = Math.min(Math.max((21.5 - mag) / 16.5, 0), 1);
  const brightness = 0.10 + 0.90 * Math.pow(t, 1.6);
  const rgb = CLASS_RGB[colorClass % CLASS_RGB.length];
  const i = offset * 3;
  col[i] = rgb[0] * brightness;
  col[i + 1] = rgb[1] * brightness;
  col[i + 2] = rgb[2] * brightness;
  let s = (0.30 + 2.2 * t * t) * FAR_SIZE_SCALE;
  size[offset] = s < 0.22 ? 0.22 : s;
}

function isHygDuplicate(view, record) {
  if (hyg.cutoffPc <= 0) return false;
  const plx = view.getFloat64(record * RECORD_SIZE + OFF_PLX, true);
  if (!(plx > 0)) return false;
  const d = 1000 / plx;
  return d <= hyg.cutoffPc;
}

async function ingestFarRange(base, count, stats) {
  if (count <= 0) return;
  const { view } = catalog;
  const pos = scratch;
  ensureFarBuffers(lod.tileFarCount + count);
  let idx = lod.tileFarCount;
  let chunkStartIdx = idx;
  let processed = 0;
  for (let i = 0; i < count; i++) {
    const record = base + i;
    if (isHygDuplicate(view, record)) {
      lod.hygDupSkipped = (lod.hygDupSkipped || 0) + 1;
      continue;
    }
    if (!readStar(view, record, pos)) continue;
    if (stats) accumulateFrame(stats, pos);
    const colorClass = readColorClass(view, record);
    const mag = readMag(view, record);
    writeFarAppearance(gpu.farCol, gpu.farSize, idx, colorClass, mag);
    gpu.farPos[idx * 3] = pos.x;
    gpu.farPos[idx * 3 + 1] = pos.y;
    gpu.farPos[idx * 3 + 2] = pos.z;
    idx++;
    processed++;
    if (processed % FAR_INGEST_CHUNK === 0 && sceneStarted) {
      publishFarRange(chunkStartIdx, idx);
      await yieldFrame();
      chunkStartIdx = idx;
    }
  }
  lod.tileFarCount = idx;
  if (sceneStarted) {
    publishFarRange(chunkStartIdx, idx);
  }
  lod.farCount = lod.tileFarCount + lod.previewFarCount;
}

function publishFarRange(start, end) {
  if (!gpu.far) return;
  const geo = gpu.far.geometry;
  const pos = geo.attributes.position;
  const col = geo.attributes.color;
  const aSize = geo.attributes.aSize;
  if (end > start) {
    const itemCount = end - start;
    pos.addUpdateRange(start * 3, itemCount * 3);
    col.addUpdateRange(start * 3, itemCount * 3);
    aSize.addUpdateRange(start, itemCount);
    pos.needsUpdate = true;
    col.needsUpdate = true;
    aSize.needsUpdate = true;
  }
  geo.setDrawRange(0, lod.tileFarCount);
}

function publishPreview() {
  if (!gpu.preview) return;
  const n = lod.previewFarCount;
  const geo = gpu.preview.geometry;
  const pos = geo.attributes.position;
  const col = geo.attributes.color;
  const size = geo.attributes.aSize;
  pos.needsUpdate = true;
  col.needsUpdate = true;
  size.needsUpdate = true;
  geo.setDrawRange(0, n);
  gpu.preview.visible = n > 0;
}

function dropPreview() {
  lod.previewFarCount = 0;
  lod.farCount = lod.tileFarCount;
  publishPreview();
}

function parseHygNear(buffer) {
  const dv = new DataView(buffer);
  if (buffer.byteLength < 24) throw new Error("hyg-near.bin: too small");
  if (dv.getUint32(0, true) !== 0x32475948) throw new Error("hyg-near.bin: bad magic");
  const n = dv.getUint32(4, true);
  const scale_pc = dv.getFloat32(8, true);
  const max_dist_pc = dv.getFloat32(12, true);
  const name_count = dv.getUint32(16, true);
  const name_bytes = dv.getUint32(20, true);
  const posBytes = n * 3 * 2;
  const magBytes = n;
  const nameTableBytes = name_count * 3;
  const minSize = 24 + posBytes + magBytes + nameTableBytes + name_bytes;
  if (buffer.byteLength < minSize) throw new Error("hyg-near.bin: truncated");

  const pos = new Float32Array(n * 3);
  const mag = new Float32Array(n);
  const names = new Array(n).fill("");
  const dec = new TextDecoder();
  let off = 24;

  for (let i = 0; i < n * 3; i++) {
    pos[i] = dv.getInt16(off, true) * scale_pc;
    off += 2;
  }
  for (let i = 0; i < n; i++) {
    mag[i] = -2 + dv.getUint8(off++) * 0.1;
  }

  const idxs = new Uint16Array(name_count);
  const lens = new Uint8Array(name_count);
  for (let k = 0; k < name_count; k++) {
    const idx = dv.getUint16(off, true);
    if (idx >= n) throw new Error("hyg-near.bin: bad name index");
    idxs[k] = idx;
    lens[k] = dv.getUint8(off + 2);
    off += 3;
  }
  for (let k = 0; k < name_count; k++) {
    const len = lens[k];
    if (len > 0) {
      const name = dec.decode(new Uint8Array(buffer, off, len));
      names[idxs[k]] = name;
      off += len;
    }
  }

  const namedList = [];
  for (let i = 0; i < n; i++) {
    if (names[i]) namedList.push(i);
  }
  namedList.sort((a, b) => mag[a] - mag[b]);

  hyg.n = n;
  hyg.maxDistPc = max_dist_pc;
  hyg.cutoffPc = max_dist_pc;
  hyg.pos = pos;
  hyg.mag = mag;
  hyg.names = names;
  hyg.named = namedList;
  hyg.bytes = buffer.byteLength;
}

async function loadHygNear() {
  try {
    const res = await fetch(HYG_FILE, { cache: "no-cache" });
    if (!res.ok) throw new Error(`hyg-near.bin ${res.status}`);
    const buf = await res.arrayBuffer();
    parseHygNear(buf);
    return true;
  } catch (err) {
    hyg.error = `hyg-near.bin: ${err.message}`;
    hyg.cutoffPc = 0;
    hyg.n = 0;
    hyg.pos = null;
    hyg.mag = null;
    hyg.names = [];
    hyg.named = [];
    console.warn(hyg.error, err);
    return false;
  }
}

function makeHygPoints() {
  if (hyg.n === 0) return null;
  const color = new Float32Array(hyg.n * 3);
  const aSize = new Float32Array(hyg.n);
  hyg.baseCol = new Float32Array(hyg.n * 3);
  for (let i = 0; i < hyg.n; i++) {
    const mag = hyg.mag[i];
    const t = Math.max(0, Math.min(1, (12 - mag) / 13.5));
    const brightness = 0.3 + 0.7 * t;
    const idx = i * 3;
    const r = 1.0 * brightness;
    const g = 0.95 * brightness;
    const b = 0.86 * brightness;
    hyg.baseCol[idx] = r; hyg.baseCol[idx + 1] = g; hyg.baseCol[idx + 2] = b;
    color[idx] = 0; color[idx + 1] = 0; color[idx + 2] = 0;
    aSize[i] = 1.4 + 5.0 * t * t;
  }
  const points = makePoints(hyg.pos, color, aSize, hyg.n);
  points.frustumCulled = false;
  points.visible = false;
  points.renderOrder = 2;
  hyg.points = points;
  hyg.col = color;
  hyg.shownAlpha = -1;
  return points;
}

function updateHygFade(camera) {
  const r = camera.position.length();
  const alpha = Math.max(0, Math.min(1, (HYG_FADE_FAR - r) / (HYG_FADE_FAR - HYG_FADE_NEAR)));
  hyg.alpha = alpha;
  if (!hyg.points) return;
  const q = Math.round(alpha * 32) / 32;
  if (q !== hyg.shownAlpha) {
    for (let i = 0; i < hyg.n * 3; i++) {
      hyg.col[i] = hyg.baseCol[i] * q;
    }
    hyg.points.geometry.attributes.color.needsUpdate = true;
    hyg.shownAlpha = q;
  }
  hyg.points.visible = q > 0;
}

function ensureHygLabelLayer(parent) {
  if (!hyg.labelLayer) {
    hyg.labelLayer = document.createElement("div");
    hyg.labelLayer.className = "star-labels";
    parent.appendChild(hyg.labelLayer);
  }
  return hyg.labelLayer;
}

function updateHygLabels(camera, width, height) {
  if (!hyg.labelLayer || hyg.alpha <= 0.3 || !hyg.points) {
    for (let el of hyg.labelEls) el.style.display = "none";
    hyg.labels = 0;
    return;
  }
  updateHygLabels.v ||= new THREE.Vector3();
  const v = updateHygLabels.v;
  let shown = 0;
  for (let i = 0; i < hyg.named.length; i++) {
    const idx = hyg.named[i];
    const mag = hyg.mag[idx];
    v.set(hyg.pos[idx * 3], hyg.pos[idx * 3 + 1], hyg.pos[idx * 3 + 2]);
    const dist = v.distanceTo(camera.position);
    if (mag > HYG_LABEL_MAG && dist >= HYG_LABEL_NEAR_PC) continue;
    v.project(camera);
    const x = v.x, y = v.y, z = v.z;
    if (z <= -1 || z >= 1 || Math.abs(x) > 1 || Math.abs(y) > 1) continue;
    const sx = (x + 1) / 2 * width;
    const sy = (1 - y) / 2 * height;
    let el = hyg.labelEls[shown];
    if (!el) {
      el = document.createElement("span");
      el.className = "star-label";
      hyg.labelLayer.appendChild(el);
      hyg.labelEls.push(el);
    }
    const name = hyg.names[idx];
    if (el.textContent !== name) el.textContent = name;
    el.style.transform = `translate(${sx | 0}px, ${sy | 0}px)`;
    el.style.display = "block";
    el.style.opacity = hyg.alpha;
    shown++;
    if (shown >= HYG_LABEL_MAX) break;
  }
  for (let i = shown; i < hyg.labelEls.length; i++) {
    hyg.labelEls[i].style.display = "none";
  }
  hyg.labels = shown;
}

function findStarNearRay(camera, target) {
  const d = new THREE.Vector3().subVectors(target, camera.position).normalize();
  const pos = gpu.farPos;
  const n = lod.tileFarCount * 3;
  let bestScore = Infinity;
  let bestIdx = -1;
  const camX = camera.position.x;
  const camY = camera.position.y;
  const camZ = camera.position.z;
  const dx = d.x, dy = d.y, dz = d.z;

  for (let i = 0; i < n; i += 3) {
    const vx = pos[i] - camX;
    const vy = pos[i + 1] - camY;
    const vz = pos[i + 2] - camZ;
    const along = vx * dx + vy * dy + vz * dz;
    if (along <= 0) continue;
    const v2 = vx * vx + vy * vy + vz * vz;
    const perp2 = v2 - along * along;
    const score = perp2 / (along * along);
    if (score < bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  if (bestIdx === -1 || bestScore > 0.132) return null; // tan(20°)^2 ≈ 0.132
  return new THREE.Vector3(pos[bestIdx], pos[bestIdx + 1], pos[bestIdx + 2]);
}

function startHygLoad() {
  hygReady = loadHygNear().then((ok) => {
    if (ok) attachHyg();
    if (sceneStarted) updateHud();
    return ok;
  });
  return hygReady;
}

function markFallbackFar(far) {
  lod.tileFarCount = far;
  lod.farCount = far;
  lod.previewFarCount = 0;
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
      position: viewCamera
        ? [viewCamera.position.x, viewCamera.position.y, viewCamera.position.z]
        : null,
      freeRoam: nav.freeRoam,
      viewpoint: nav.viewpoint,
      viewpointLabel: nav.viewpointLabel,
      hygCount: hyg.points && hyg.points.visible ? hyg.n : 0,
      hygLoaded: hyg.n,
      hygVisible: !!(hyg.points && hyg.points.visible),
      hygAlpha: hyg.alpha,
      hygCutoffPc: hyg.cutoffPc,
      hygDupSkipped: lod.hygDupSkipped || 0,
      hygError: hyg.error,
      labels: hyg.labels,
      cameraDist: trace.cameraDist ?? null,
      nearSnaps: lod.nearSnaps || 0,
      farCapacity: gpu.farCapacity || 0,
    };
  },
  requestBrightSample() {
    trace.sampleBright = true;
    trace.brightPixels = -1;
  },
  frameDirection,
  setViewpoint,
  setFreeRoam,
  computePlanetPosition,
};

main();
