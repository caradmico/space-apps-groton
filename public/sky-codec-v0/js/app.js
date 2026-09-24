import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { ang2pixNest, xyzToThetaPhi } from "./healpix.js";
import { decodeFar, decodeNear, dequantMeanMag } from "./codec.js";

const el = {
  wrap: document.getElementById("canvas-wrap"),
  hud: document.getElementById("hud"),
  count: document.getElementById("star-count"),
  far: document.getElementById("btn-far"),
  near: document.getElementById("btn-near"),
};

const state = {
  mode: "far",
  frame: 1,
  config: null,
  manifest: null,
  farTiles: [],
  generation: 0,
  active: 0,
  queue: [],
  pending: new Map(),
  cache: new Map(),
  wanted: new Set(),
  worstSyncMs: 0,
  loadedStars: 0,
};

const vertexShader = /* glsl */ `
  attribute float aSize;
  varying vec3 vColor;
  void main() {
    vColor = color;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (180.0 / -mvPosition.z);
    gl_PointSize = clamp(gl_PointSize, 1.0, 48.0);
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

function magColor(mag) {
  const t = Math.min(Math.max((mag - -1) / 12, 0), 1);
  const c = new THREE.Color();
  c.setHSL(0.58 - t * 0.08, 0.35 + (1 - t) * 0.25, 0.55 + (1 - t) * 0.3);
  return c;
}

function magSize(mag) {
  const m = Math.min(Math.max(mag, -1.5), 15);
  return Math.max(0.8, 4.8 - m * 0.28);
}

function makeMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

function setHud(html, isError = false) {
  el.hud.innerHTML = html;
  el.hud.classList.toggle("error", isError);
}

function thresholds() {
  const enter = state.config.lod.enter_frame_fraction * state.frame;
  const exit = state.config.lod.exit_frame_fraction * state.frame;
  return { enter, exit };
}

function formatPc(v) {
  return v.toFixed(1);
}

function updateHud(dist) {
  const { enter, exit } = thresholds();
  const farCount = state.farTiles.reduce((n, t) => n + (t.count > 0 ? 1 : 0), 0);
  if (state.mode === "far") {
    el.count.textContent = `${farCount.toLocaleString()} cells`;
    setHud(
      `<strong>Far</strong> · ${farCount.toLocaleString()} cell centroids<br>` +
        `Camera ${formatPc(dist)} pc · near view below ${formatPc(enter)} pc · back to far above ${formatPc(exit)} pc<br>` +
        `Drag to orbit · scroll to zoom · ${state.manifest.codec_bytes.toLocaleString()} B of tiles`,
    );
    return;
  }
  const waiting = [...state.wanted].filter((pix) => !state.cache.has(pix)).length;
  el.count.textContent = `${state.loadedStars.toLocaleString()} stars`;
  setHud(
    `<strong>Near</strong> · ${state.wanted.size} cells in view · ${state.loadedStars.toLocaleString()} stars drawn<br>` +
      `${waiting ? `Loading ${waiting} · ` : ""}camera ${formatPc(dist)} pc · sync ${state.worstSyncMs.toFixed(2)} ms<br>` +
      `Accurate quantized points for the cells in frame`,
  );
}

function buildFarPoints(tiles, mag0, mag1) {
  const drawn = tiles.filter((t) => t.count > 0);
  const positions = new Float32Array(drawn.length * 3);
  const colors = new Float32Array(drawn.length * 3);
  const sizes = new Float32Array(drawn.length);
  drawn.forEach((tile, i) => {
    positions[i * 3] = tile.cx;
    positions[i * 3 + 1] = tile.cy;
    positions[i * 3 + 2] = tile.cz;
    const col = magColor(dequantMeanMag(tile.meanMagQ, mag0, mag1));
    colors[i * 3] = col.r;
    colors[i * 3 + 1] = col.g;
    colors[i * 3 + 2] = col.b;
    sizes[i] = Math.max(7, 4 + Math.sqrt(tile.count) * 1.6);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  return new THREE.Points(geo, makeMaterial());
}

function buildNearPoints(near) {
  const colors = new Float32Array(near.n * 3);
  const sizes = new Float32Array(near.n);
  for (let i = 0; i < near.n; i++) {
    const col = magColor(near.mag[i]);
    colors[i * 3] = col.r;
    colors[i * 3 + 1] = col.g;
    colors[i * 3 + 2] = col.b;
    sizes[i] = magSize(near.mag[i]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(near.xyz, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  const points = new THREE.Points(geo, makeMaterial());
  points.userData.starCount = near.n;
  return points;
}

function dropNear() {
  state.generation += 1;
  for (const ctrl of state.pending.values()) ctrl.abort();
  state.pending.clear();
  state.queue.length = 0;
  state.wanted.clear();
  for (const pts of state.cache.values()) {
    state.nearGroup.remove(pts);
    pts.geometry.dispose();
    pts.material.dispose();
  }
  state.cache.clear();
  state.loadedStars = 0;
  if (state.farPoints) state.farPoints.visible = true;
}

function countLoaded() {
  let n = 0;
  for (const pix of state.wanted) {
    const pts = state.cache.get(pix);
    if (pts && pts.parent) n += pts.userData.starCount;
  }
  state.loadedStars = n;
}

function kick() {
  const cap = state.config.viewer.max_concurrent_near;
  while (state.active < cap && state.queue.length) {
    const pix = state.queue.shift();
    if (state.cache.has(pix) || state.pending.has(pix)) continue;
    const ctrl = new AbortController();
    const gen = state.generation;
    state.pending.set(pix, ctrl);
    state.active += 1;
    loadTile(pix, ctrl.signal, gen)
      .catch((err) => {
        if (err.name !== "AbortError") console.error(err);
      })
      .finally(() => {
        state.active -= 1;
        state.pending.delete(pix);
        if (gen === state.generation && state.mode === "near") kick();
      });
  }
}

async function loadTile(pix, signal, gen) {
  const res = await fetch(`tiles/near/${pix}.bin`, { signal });
  if (!res.ok) throw new Error(`near/${pix}.bin ${res.status}`);
  const buf = await res.arrayBuffer();
  if (gen !== state.generation) return;
  const t0 = performance.now();
  const near = decodeNear(buf, state.manifest);
  const points = buildNearPoints(near);
  state.worstSyncMs = Math.max(state.worstSyncMs, performance.now() - t0);
  if (gen !== state.generation) {
    points.geometry.dispose();
    points.material.dispose();
    return;
  }
  state.cache.set(pix, points);
  if (state.wanted.has(pix)) state.nearGroup.add(points);
  countLoaded();
  updateHud(state.controls.getDistance());
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const _view = new THREE.Vector3();
const _ndc = new THREE.Vector3();
const _probe = new THREE.Vector3();

function inFrustum(world, camera, margin) {
  _view.copy(world);
  _view.applyMatrix4(camera.matrixWorldInverse);
  // Three.js cameras look down -Z. Points behind the camera fail the test
  // even if a perspective divide folds them back into NDC.
  if (_view.z > -0.25) return false;
  _ndc.copy(world);
  _ndc.project(camera);
  return (
    Number.isFinite(_ndc.x) &&
    _ndc.z >= -1 &&
    _ndc.z <= 1 &&
    Math.abs(_ndc.x) <= 1 + margin &&
    Math.abs(_ndc.y) <= 1 + margin
  );
}

function cellsInView(camera) {
  camera.updateMatrixWorld();
  const set = new Set();
  const nside = state.manifest.nside;
  const target = state.controls.target;
  if (target.length() > 0.4) {
    const aimed = xyzToThetaPhi(target.x, target.y, target.z);
    set.add(ang2pixNest(nside, aimed.theta, aimed.phi));
  }
  for (const tile of state.farTiles) {
    if (!tile.count) continue;
    _probe.set(tile.cx, tile.cy, tile.cz);
    if (inFrustum(_probe, camera, 0.02)) set.add(tile.pix);
  }
  return set;
}

function refreshWanted() {
  const next = cellsInView(state.camera);
  state.wanted = next;
  state.queue = state.queue.filter((pix) => next.has(pix));
  for (const [pix, pts] of state.cache) {
    if (next.has(pix)) {
      if (!pts.parent) state.nearGroup.add(pts);
    } else if (pts.parent) {
      state.nearGroup.remove(pts);
    }
  }
  for (const pix of next) {
    if (!state.cache.has(pix) && !state.pending.has(pix) && !state.queue.includes(pix)) {
      state.queue.push(pix);
    }
  }
  if (state.farPoints) state.farPoints.visible = false;
  countLoaded();
  kick();
}

function poseKey() {
  const p = state.camera.position;
  const t = state.controls.target;
  const q = (v) => Math.round(v * 20);
  return [state.mode, q(p.x), q(p.y), q(p.z), q(t.x), q(t.y), q(t.z)].join(",");
}

let lastPose = "";

function onCamera() {
  const dist = state.controls.getDistance();
  const { enter, exit } = thresholds();
  const prev = state.mode;
  if (state.mode === "far" && dist < enter) state.mode = "near";
  else if (state.mode === "near" && dist > exit) state.mode = "far";
  if (prev !== state.mode && state.mode === "far") {
    lastPose = "";
    dropNear();
  }
  const pose = poseKey();
  if (state.mode === "near" && pose !== lastPose) refreshWanted();
  else if (state.mode === "far" && state.farPoints) state.farPoints.visible = true;
  lastPose = pose;
  updateHud(dist);
}

function placeCamera(distance, target) {
  state.controls.target.copy(target);
  const offset = new THREE.Vector3(0.34, 0.22, 0.91).normalize().multiplyScalar(distance);
  state.camera.position.copy(target).add(offset);
  state.controls.update();
  onCamera();
}

function densestCentroid() {
  let best = null;
  for (const tile of state.farTiles) {
    if (!best || tile.count > best.count) best = tile;
  }
  return new THREE.Vector3(best.cx, best.cy, best.cz);
}

async function main() {
  const [config, manifest, farBuf] = await Promise.all([
    fetch("codec-config.json").then((r) => r.json()),
    fetch("tiles/manifest.json").then((r) => r.json()),
    fetch("tiles/far.bin").then((r) => r.arrayBuffer()),
  ]);
  state.config = config;
  state.manifest = manifest;
  const far = decodeFar(farBuf);
  if (manifest.codec !== "STN1" || manifest.xyz_bits !== 12 || manifest.mag_bits !== 8) {
    throw new Error("manifest codec");
  }
  if (far.nside !== config.nside || far.nside !== manifest.nside) {
    throw new Error("nside mismatch");
  }
  state.farTiles = far.tiles;

  const fov = (config.viewer.fov_deg * Math.PI) / 180;
  state.frame = (manifest.catalog_radius_pc * config.viewer.frame_margin) / Math.tan(fov / 2);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(config.viewer.fov_deg, 1, 0.05, state.frame * 8);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  el.wrap.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enablePan = true;
  controls.minDistance = 0.3;
  controls.maxDistance = state.frame * 1.5;
  state.camera = camera;
  state.controls = controls;

  const farPoints = buildFarPoints(far.tiles, config.mean_mag_u8.mag0, config.mean_mag_u8.mag1);
  scene.add(farPoints);
  state.farPoints = farPoints;
  const nearGroup = new THREE.Group();
  scene.add(nearGroup);
  state.nearGroup = nearGroup;

  function resize() {
    const w = el.wrap.clientWidth;
    const h = Math.max(el.wrap.clientHeight, 1);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
  window.addEventListener("resize", resize);
  resize();

  controls.addEventListener("change", onCamera);
  // Close enough that one cell fills the view, and still under the 0.74 frame threshold.
  const cellZoomDistance = 10;
  el.far.addEventListener("click", () => placeCamera(state.frame, new THREE.Vector3()));
  el.near.addEventListener("click", () => placeCamera(cellZoomDistance, densestCentroid()));

  placeCamera(state.frame, new THREE.Vector3());

  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();
}

main().catch((err) => {
  console.error(err);
  el.count.textContent = "error";
  setHud(`Could not load tiles. ${err.message}`, true);
});
