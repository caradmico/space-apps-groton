/**
 * StarIS BIN LOD viewer.
 *
 * Reads Cara's 62-byte LE point-catalog records from an ArrayBuffer.
 * NEVER materializes an Array of star objects for the whole file.
 *
 * Record (exact, pre-strip SpaceIS bundle):
 *   +32 float64 x, +40 y, +48 z  — stored as value/206265 (multiply on read)
 *   +56 uint16  color class
 *   +58 float32 mag
 *
 * LOD:
 *   FAR  — stride-sample generalized points (one GPU buffer)
 *   NEAR — bounded accurate subset around the camera target (typed arrays only)
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const RECORD_SIZE = 62;
const OFF_X = 32;
const OFF_Y = 40;
const OFF_Z = 48;
const OFF_COLOR = 56;
const OFF_MAG = 58;
const UNIT = 206265;

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
  stride: 1,
  bbox: null,
  cellStart: null,
  cellCount: null,
  cellIndex: null,
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

function readX(view, i) {
  return view.getFloat64(i * RECORD_SIZE + OFF_X, true) * UNIT;
}

function readY(view, i) {
  return view.getFloat64(i * RECORD_SIZE + OFF_Y, true) * UNIT;
}

function readZ(view, i) {
  return view.getFloat64(i * RECORD_SIZE + OFF_Z, true) * UNIT;
}

function readColorClass(view, i) {
  return view.getUint16(i * RECORD_SIZE + OFF_COLOR, true);
}

function readMag(view, i) {
  return view.getFloat32(i * RECORD_SIZE + OFF_MAG, true);
}

function magToSize(mag, scale) {
  const m = Math.min(Math.max(mag, -1.5), 16);
  return Math.max(0.7, (5.2 - m * 0.26) * scale);
}

function writeAppearance(col, size, offset, colorClass, mag, sizeScale) {
  const rgb = CLASS_RGB[colorClass % CLASS_RGB.length];
  const t = Math.min(Math.max((mag + 1) / 14, 0), 1);
  const bright = 0.45 + (1 - t) * 0.55;
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

  const cellN = GRID * GRID * GRID;
  const counts = new Uint32Array(cellN);
  let far = 0;

  for (let i = 0; i < count; i++) {
    const x = readX(view, i);
    const y = readY(view, i);
    const z = readZ(view, i);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;

    if (i % stride === 0 && far < farCap) {
      let pick = i;
      let bestMag = readMag(view, i);
      const end = Math.min(i + stride, count);
      for (let j = i + 1; j < end; j++) {
        const m = readMag(view, j);
        if (m < bestMag) {
          bestMag = m;
          pick = j;
        }
      }
      gpu.farPos[far * 3] = readX(view, pick);
      gpu.farPos[far * 3 + 1] = readY(view, pick);
      gpu.farPos[far * 3 + 2] = readZ(view, pick);
      writeAppearance(gpu.farCol, gpu.farSize, far, readColorClass(view, pick), bestMag, 0.85);
      far += 1;
    }

    if (i > 0 && i % YIELD_EVERY === 0) {
      setStatus(
        `Indexing catalog as bytes… <strong>${i.toLocaleString()}</strong> / ${count.toLocaleString()}`
      );
      await yieldFrame();
    }
  }

  const pad = 1.5;
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

  for (let i = 0; i < count; i++) {
    const c = cellOf(readX(view, i), readY(view, i), readZ(view, i), bbox);
    counts[c] += 1;
    if (i > 0 && i % YIELD_EVERY === 0) await yieldFrame();
  }

  const start = new Uint32Array(cellN);
  let running = 0;
  for (let c = 0; c < cellN; c++) {
    start[c] = running;
    running += counts[c];
  }

  const index = new Uint32Array(count);
  const cursor = start.slice();
  for (let i = 0; i < count; i++) {
    const c = cellOf(readX(view, i), readY(view, i), readZ(view, i), bbox);
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

  const r = NEAR_RADIUS;
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

  let n = 0;
  for (let iz = minIZ; iz <= maxIZ; iz++) {
    for (let iy = minIY; iy <= maxIY; iy++) {
      for (let ix = minIX; ix <= maxIX; ix++) {
        const c = ix + iy * GRID + iz * GRID * GRID;
        const begin = cellStart[c];
        const end = begin + cellCount[c];
        for (let k = begin; k < end && n < NEAR_BUDGET; k++) {
          const i = cellIndex[k];
          const x = readX(view, i);
          const y = readY(view, i);
          const z = readZ(view, i);
          const dx = x - target.x;
          const dy = y - target.y;
          const dz = z - target.z;
          if (dx * dx + dy * dy + dz * dz > r2) continue;
          gpu.nearPos[n * 3] = x;
          gpu.nearPos[n * 3 + 1] = y;
          gpu.nearPos[n * 3 + 2] = z;
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
  el.mode.textContent = lod.mode === "near" ? "LOD NEAR" : "LOD FAR";
  el.mode.dataset.mode = lod.mode;
  el.count.textContent = `${lod.farCount.toLocaleString()} far · ${lod.nearCount.toLocaleString()} near`;
  setStatus(
    `<strong>${catalog.count.toLocaleString()} records</strong> · ${mb} MiB · 62 B LE<br>` +
      `FAR stride ${catalog.stride} → ${lod.farCount.toLocaleString()} generalized<br>` +
      (lod.mode === "near"
        ? `NEAR accurate subset ${lod.nearCount.toLocaleString()} (cap ${NEAR_BUDGET.toLocaleString()}) within ${NEAR_RADIUS} of target`
        : `Zoom in toward a region to load an accurate nearby subset`) +
      `<br>No full star-object array. Drag to orbit · scroll to zoom · right-drag to pan`
  );
}

function initScene() {
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x05070d, 0.008);

  const camera = new THREE.PerspectiveCamera(
    55,
    el.canvasWrap.clientWidth / Math.max(el.canvasWrap.clientHeight, 1),
    0.08,
    800
  );
  camera.position.set(0, 28, 92);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(el.canvasWrap.clientWidth, el.canvasWrap.clientHeight, false);
  renderer.setClearColor(0x000000, 0);
  el.canvasWrap.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enablePan = true;
  controls.minDistance = 2;
  controls.maxDistance = 280;
  controls.target.set(0, 0, 0);

  gpu.far = makePoints(gpu.farPos, gpu.farCol, gpu.farSize, lod.farCount);
  gpu.near = makePoints(gpu.nearPos, gpu.nearCol, gpu.nearSize, 0);
  gpu.near.visible = false;
  scene.add(gpu.far);
  scene.add(gpu.near);

  const origin = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xffe08a })
  );
  scene.add(origin);

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
    const wantNear = lod.mode === "near" ? dist < NEAR_EXIT : dist < NEAR_ENTER;
    const moved =
      controls.target.distanceToSquared(lod.lastTarget) > 1.2 ||
      Math.abs(dist - lod.lastDist) > 2.5;

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
        `Drop a format-compatible 62-byte LE catalog (or Cara’s <code>gaia_processed.bin</code>) as <code>data/catalog.bin</code>.`,
      true
    );
    el.count.textContent = "0 drawn";
    el.mode.textContent = "LOD error";
  }
}

main();
