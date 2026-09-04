/**
 * StarIS BIN LOD v0
 * Record layout recovered from pre-strip SpaceIS (main.616b3d84.js):
 *   62 bytes / star
 *   +32 float64 LE x, +40 y, +48 z  (stored / 206265)
 *   +56 uint16 color class
 *   +58 float32 mag
 * Never materializes the full catalog as JS objects (that froze her).
 * Far: coarse grid density samples. Near: accurate records for nearby cells.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const RECORD = 62;
const SCALE = 206265;
const CATALOG_URL = './data/catalog.bin';
const GRID = 32; // spatial hash cells per axis (relative to bbox)
const FAR_STRIDE = 32; // sample every Nth record when far
const NEAR_CELL_CAP = 4000;

const wrap = document.getElementById('canvas-wrap');
const hud = document.getElementById('hud');

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(wrap.clientWidth, wrap.clientHeight);
wrap.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070d);
const camera = new THREE.PerspectiveCamera(60, wrap.clientWidth / wrap.clientHeight, 0.05, 1e6);
camera.position.set(0, 0, 80);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

let catalogBytes = null;
let recordCount = 0;
let bbox = { min: [0,0,0], max: [1,1,1] };
let points = null;
let lastMode = '';

function setHud(t) { hud.textContent = t; }

function readRecord(view, i) {
  const e = i * RECORD;
  const x = view.getFloat64(e + 32, true) * SCALE;
  const y = view.getFloat64(e + 40, true) * SCALE;
  const z = view.getFloat64(e + 48, true) * SCALE;
  const mag = view.getFloat32(e + 58, true);
  return { x, y, z, mag };
}

async function loadCatalog() {
  setHud('Fetching catalog.bin…');
  const res = await fetch(CATALOG_URL);
  if (!res.ok) throw new Error(`catalog fetch ${res.status}`);
  catalogBytes = await res.arrayBuffer();
  recordCount = Math.floor(catalogBytes.byteLength / RECORD);
  const view = new DataView(catalogBytes);
  // bbox from sparse sample (not full scan of objects)
  let minx=Infinity,miny=Infinity,minz=Infinity,maxx=-Infinity,maxy=-Infinity,maxz=-Infinity;
  const step = Math.max(1, Math.floor(recordCount / 2000));
  for (let i = 0; i < recordCount; i += step) {
    const { x, y, z } = readRecord(view, i);
    if (!Number.isFinite(x+y+z)) continue;
    minx=Math.min(minx,x); miny=Math.min(miny,y); minz=Math.min(minz,z);
    maxx=Math.max(maxx,x); maxy=Math.max(maxy,y); maxz=Math.max(maxz,z);
  }
  bbox = { min:[minx,miny,minz], max:[maxx,maxy,maxz] };
  setHud(`${recordCount.toLocaleString()} records · ${(catalogBytes.byteLength/1e6).toFixed(1)} MB · LOD ready`);
}

function cellOf(x, y, z) {
  const { min, max } = bbox;
  const nx = (x - min[0]) / Math.max(1e-9, max[0] - min[0]);
  const ny = (y - min[1]) / Math.max(1e-9, max[1] - min[1]);
  const nz = (z - min[2]) / Math.max(1e-9, max[2] - min[2]);
  const cx = Math.min(GRID - 1, Math.max(0, Math.floor(nx * GRID)));
  const cy = Math.min(GRID - 1, Math.max(0, Math.floor(ny * GRID)));
  const cz = Math.min(GRID - 1, Math.max(0, Math.floor(nz * GRID)));
  return (cx * GRID + cy) * GRID + cz;
}

function cameraDist() {
  return camera.position.distanceTo(controls.target);
}

function rebuildPoints(positions, colors) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: true, vertexColors: true });
  if (points) {
    scene.remove(points);
    points.geometry.dispose();
    points.material.dispose();
  }
  points = new THREE.Points(geo, mat);
  scene.add(points);
}

function magColor(mag, out, i) {
  const t = Math.min(1, Math.max(0, (mag + 1) / 12));
  out[i] = 0.55 + (1 - t) * 0.4;
  out[i + 1] = 0.65 + (1 - t) * 0.25;
  out[i + 2] = 0.95;
}

function renderFar(view) {
  const n = Math.ceil(recordCount / FAR_STRIDE);
  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  let w = 0;
  for (let i = 0; i < recordCount; i += FAR_STRIDE) {
    const { x, y, z, mag } = readRecord(view, i);
    positions[w * 3] = x; positions[w * 3 + 1] = y; positions[w * 3 + 2] = z;
    magColor(mag, colors, w * 3);
    w++;
  }
  rebuildPoints(positions.subarray(0, w * 3), colors.subarray(0, w * 3));
  setHud(`FAR generalized · ${w.toLocaleString()} / ${recordCount.toLocaleString()} · dist ${cameraDist().toFixed(1)}`);
}

function renderNear(view) {
  const target = controls.target;
  // nearest cell + neighbors to target
  const home = cellOf(target.x, target.y, target.z);
  const want = new Set([home]);
  // also include cells near camera for fly-through
  const camCell = cellOf(camera.position.x, camera.position.y, camera.position.z);
  want.add(camCell);

  const picked = [];
  for (let i = 0; i < recordCount && picked.length < NEAR_CELL_CAP; i++) {
    const rec = readRecord(view, i);
    const c = cellOf(rec.x, rec.y, rec.z);
    if (!want.has(c)) continue;
    // near accuracy: keep if within band of target
    const dx = rec.x - target.x, dy = rec.y - target.y, dz = rec.z - target.z;
    if (dx*dx + dy*dy + dz*dz > 40 * 40) continue;
    picked.push(rec);
  }
  // if too few in cell, fall back to nearest-N by stride around file (still bounded)
  if (picked.length < 200) {
    const step = Math.max(1, Math.floor(recordCount / NEAR_CELL_CAP));
    for (let i = 0; i < recordCount && picked.length < NEAR_CELL_CAP; i += step) {
      picked.push(readRecord(view, i));
    }
  }
  const positions = new Float32Array(picked.length * 3);
  const colors = new Float32Array(picked.length * 3);
  for (let i = 0; i < picked.length; i++) {
    positions[i * 3] = picked[i].x;
    positions[i * 3 + 1] = picked[i].y;
    positions[i * 3 + 2] = picked[i].z;
    magColor(picked[i].mag, colors, i * 3);
  }
  rebuildPoints(positions, colors);
  setHud(`NEAR accurate · ${picked.length.toLocaleString()} pts · dist ${cameraDist().toFixed(1)}`);
}

function tickLod() {
  if (!catalogBytes) return;
  const view = new DataView(catalogBytes);
  const d = cameraDist();
  const mode = d > 55 ? 'far' : 'near';
  if (mode === lastMode && mode === 'far') return; // far stable
  // throttle near rebuilds lightly via mode flip or movement
  if (mode !== lastMode) {
    lastMode = mode;
    if (mode === 'far') renderFar(view);
    else renderNear(view);
  } else if (mode === 'near') {
    renderNear(view);
  }
}

function onResize() {
  const w = wrap.clientWidth, h = wrap.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
window.addEventListener('resize', onResize);

let lodTimer = 0;
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  lodTimer++;
  if (lodTimer % 15 === 0) tickLod();
  renderer.render(scene, camera);
}

try {
  await loadCatalog();
  lastMode = '';
  tickLod();
  animate();
} catch (e) {
  setHud(String(e));
  console.error(e);
}
