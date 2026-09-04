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

const FAR_BUDGET = 8192;
const NEAR_BUDGET = 12288;
const NEAR_ENTER = 36;
const NEAR_EXIT = 44;
const NEAR_RADIUS = 14;
const GRID = 20;
const YIELD_EVERY = 12000;

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
};

const lod = {
  farCount: 0,
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
  return Math.max(0.55, (5.2 - m * 0.2) * scale);
}

function writeAppearance(col, size, offset, colorClass, mag, sizeScale) {
  const rgb = CLASS_RGB[colorClass % CLASS_RGB.length];
  const t = Math.min(Math.max((mag + 1) / 18, 0), 1);
  const bright = 0.42 + (1 - t) * 0.58;
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
  const dist = (size * 1.02) / Math.tan(fov / 2);
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
    catalog.nearRadius = Math.max(size * 0.28, 0.9);
    catalog.nearEnter = Math.max(size * 0.78, 2.4);
    catalog.nearExit = Math.max(size * 1.12, 3.2);
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
    gl_PointSize = aSize * (200.0 / max(-mvPosition.z, 0.4));
    gl_PointSize = clamp(gl_PointSize, 1.0, 42.0);
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
  geo.setAttribute("position", posAttr);
  geo.setAttribute("color", colAttr);
  geo.setAttribute("aSize", sizeAttr);
  geo.setDrawRange(0, count);
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

async function loadCatalog() {
  setStatus("Fetching <code>data/catalog.bin</code> as bytes…");
  const res = await fetch("data/catalog.bin", { cache: "no-cache" });
  if (!res.ok) {
    throw new Error(`Failed to load catalog.bin (${res.status})`);
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
  return count;
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
        writeAppearance(gpu.farCol, gpu.farSize, far, readColorClass(view, pick), bestMag, 0.85);
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
    const targetX = (sumUx / dirLen) * SKY_RADIUS;
    const targetY = (sumUy / dirLen) * SKY_RADIUS;
    const targetZ = (sumUz / dirLen) * SKY_RADIUS;
    const frameExtent = Math.max(
      frameMaxX - frameMinX,
      frameMaxY - frameMinY,
      frameMaxZ - frameMinZ,
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

  gpu.nearPos = new Float32Array(NEAR_BUDGET * 3);
  gpu.nearCol = new Float32Array(NEAR_BUDGET * 3);
  gpu.nearSize = new Float32Array(NEAR_BUDGET);
}

function fillNear(target) {
  const { view, bbox, cellStart, cellCount, cellIndex } = catalog;
  if (!bbox) return 0;

  const r = catalog.nearRadius;
  const r2 = r * r;
  const minIX = Math.min(
    GRID - 1,
    Math.max(0, Math.floor(((target.x - r - bbox.minX) / bbox.sx) * GRID))
  );
  const maxIX = Math.min(
    GRID - 1,
    Math.max(0, Math.floor(((target.x + r - bbox.minX) / bbox.sx) * GRID))
  );
  const minIY = Math.min(
    GRID - 1,
    Math.max(0, Math.floor(((target.y - r - bbox.minY) / bbox.sy) * GRID))
  );
  const maxIY = Math.min(
    GRID - 1,
    Math.max(0, Math.floor(((target.y + r - bbox.minY) / bbox.sy) * GRID))
  );
  const minIZ = Math.min(
    GRID - 1,
    Math.max(0, Math.floor(((target.z - r - bbox.minZ) / bbox.sz) * GRID))
  );
  const maxIZ = Math.min(
    GRID - 1,
    Math.max(0, Math.floor(((target.z + r - bbox.minZ) / bbox.sz) * GRID))
  );

  const pos = scratch;
  let n = 0;
  for (let iz = minIZ; iz <= maxIZ; iz++) {
    for (let iy = minIY; iy <= maxIY; iy++) {
      for (let ix = minIX; ix <= maxIX; ix++) {
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
            1.15
          );
          n += 1;
        }
      }
    }
  }

  lod.nearCount = n;
  if (gpu.near) {
    gpu.near.geometry.attributes.position.needsUpdate = true;
    gpu.near.geometry.attributes.color.needsUpdate = true;
    gpu.near.geometry.attributes.aSize.needsUpdate = true;
    gpu.near.geometry.setDrawRange(0, n);
    gpu.near.geometry.computeBoundingSphere();
  }
  return n;
}

function updateHud() {
  const mb = (catalog.buffer.byteLength / (1024 * 1024)).toFixed(2);
  const layoutNote =
    catalog.layout === "radec"
      ? "GaiaSource RA/Dec → Cartesian"
      : "StarIS precomputed xyz × 206265";
  el.mode.textContent = lod.mode === "near" ? "LOD NEAR" : "LOD FAR";
  el.mode.dataset.mode = lod.mode;
  el.count.textContent = `${lod.farCount.toLocaleString()} far · ${lod.nearCount.toLocaleString()} near`;
  setStatus(
    `<strong>${catalog.count.toLocaleString()} records</strong> · ${mb} MiB · 62 B LE · ${layoutNote}<br>` +
      `FAR stride ${catalog.stride} → ${lod.farCount.toLocaleString()} generalized<br>` +
      (lod.mode === "near"
        ? `NEAR accurate subset ${lod.nearCount.toLocaleString()} (cap ${NEAR_BUDGET.toLocaleString()}) within ${catalog.nearRadius.toFixed(1)} of target`
        : `Zoom in toward a region to load an accurate nearby subset`) +
      `<br>No full star-object array. Drag to orbit · scroll to zoom · right-drag to pan`
  );
}

function initScene() {
  const frame = catalog.frame;
  const scene = new THREE.Scene();
  const fogDensity = Math.min(0.012, 0.45 / Math.max(frame.dist, 8));
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
  controls.maxDistance = Math.max(frame.extent * 14, frame.dist * 6);
  controls.target.set(frame.targetX, frame.targetY, frame.targetZ);

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

  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    maybeRefreshNear();
    renderer.render(scene, camera);
  }
  animate();
}

async function main() {
  try {
    await loadCatalog();
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

main();
