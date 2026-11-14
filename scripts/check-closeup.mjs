import fs from "node:fs";
import {
  normalizeEmission,
  closeupWeight,
  tempToRGB,
  RECIPES,
  DEMO_SYSTEM,
  FLY_SECONDS,
  frameBodies,
  projectToNdc,
  lockedTarget,
  flyStartDistance,
  flyEase,
  flyInDistance,
  handoffMix,
} from "../public/bin-lod/js/closeup.js";

let passed = 0;
let failed = 0;

function check(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error("FAIL:", msg);
  }
}

// 1. Handoff flux normalization tests
const dbLum = 1.5;
const radius = 1;
const N = 200000;
for (const d of [5, 20, 100, 1000]) {
  for (const limb of [0, 0.6]) {
    const S = normalizeEmission({ dbLum, d, radius, limb });
    const theta = Math.asin(radius / d);
    const sinTheta = Math.sin(theta);
    const da = theta / N;
    let sum = 0;
    for (let i = 0; i < N; i++) {
      const a = (i + 0.5) * da;
      const sinA = Math.sin(a);
      const ratio = sinA / sinTheta;
      const mu = Math.sqrt(Math.max(0, 1 - ratio * ratio));
      sum += (1 - limb * (1 - mu)) * 2 * Math.PI * sinA * da;
    }
    const flux = S * sum;
    const expected = dbLum / (d * d);
    const relErr = Math.abs(flux - expected) / expected;
    check(relErr < 1e-6, `handoff d=${d} limb=${limb} relErr=${relErr}`);
  }
}

// 2. closeupWeight boundary and monotonicity checks
check(closeupWeight(0.01) === 0, "closeupWeight(0.01) === 0");
check(closeupWeight(0.1) === 1, "closeupWeight(0.1) === 1");

let prev = -1;
let monotone = true;
for (let i = 0; i <= 100; i++) {
  const f = i / 1000;
  const w = closeupWeight(f);
  if (w < prev - 1e-12) monotone = false;
  prev = w;
}
check(monotone, "closeupWeight is monotone on grid");

// 3. RECIPES and DEMO_SYSTEM structure
const recipeKeys = Object.keys(RECIPES);
const recipeKinds = recipeKeys.map((k) => RECIPES[k].kind).sort();
check(
  recipeKeys.length === 2 && recipeKinds[0] === 0 && recipeKinds[1] === 1,
  "RECIPES has 2 entries with kinds 0 and 1"
);

const demoTypes = DEMO_SYSTEM.map((b) => String(b.type)).sort();
check(
  DEMO_SYSTEM.length === 2 &&
    demoTypes[0] === recipeKeys.sort()[0] &&
    demoTypes[1] === recipeKeys.sort()[1],
  "DEMO_SYSTEM has 2 bodies matching RECIPES types"
);

// 4. tempToRGB(5800) validation against CIE 1931 2-deg CMF table + Planck law
// Data source: CIE 018:2019 Table 6, https://files.cie.co.at/Publications-datasets/CIE_xyz_1931_2deg.csv (CC BY-SA 4.0)
const csvPath = new URL("./data/CIE_xyz_1931_2deg.csv", import.meta.url);
const rows = fs
  .readFileSync(csvPath, "utf8")
  .trim()
  .split(/\r?\n/)
  .map((line) => line.split(",").map(Number));

const h = 6.62607015e-34;
const c = 2.99792458e8;
const kB = 1.380649e-23;
const T = 5800;
let X = 0, Y = 0, Z = 0;
for (const [nm, xbar, ybar, zbar] of rows) {
  const lam = nm * 1e-9;
  const B = (2 * h * c * c) / (Math.pow(lam, 5) * (Math.exp((h * c) / (lam * kB * T)) - 1));
  X += B * xbar;
  Y += B * ybar;
  Z += B * zbar;
}
// IEC 61966-2-1 XYZ -> linear sRGB
const rLin = Math.max(0,  3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z);
const gLin = Math.max(0, -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z);
const bLin = Math.max(0,  0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z);
const maxC = Math.max(rLin, gLin, bLin);
const ref = [rLin / maxC, gLin / maxC, bLin / maxC];

const rgb = tempToRGB(5800);
check(Array.isArray(rgb) && rgb.length === 3, "tempToRGB(5800) array length 3");
for (let i = 0; i < 3; i++) {
  check(
    Math.abs(rgb[i] - ref[i]) <= 2e-2,
    `tempToRGB(5800) channel ${i}: actual=${rgb[i]} ref=${ref[i]}`
  );
}

// A. Framing (Gap 1): both star and planet fit inside desktop & mobile viewports
const anchorCenter = [65, -66, -33];
const demoBodies = DEMO_SYSTEM.map((b) => ({
  ...b,
  position: [
    anchorCenter[0] + b.offset[0],
    anchorCenter[1] + b.offset[1],
    anchorCenter[2] + b.offset[2],
  ],
}));
const viewports = [
  { name: "desktop", w: 1440, h: 900 },
  { name: "mobile", w: 390, h: 844 },
];
const fovDeg = 55;
const tanHalfFov = Math.tan((fovDeg * Math.PI) / 360);

for (const vp of viewports) {
  const aspect = vp.w / vp.h;
  const framed = frameBodies(demoBodies, fovDeg, aspect);

  // Camera basis for limb-offset checks
  let fx = framed.target[0] - framed.cameraPos[0];
  let fy = framed.target[1] - framed.cameraPos[1];
  let fz = framed.target[2] - framed.cameraPos[2];
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl; fy /= fl; fz /= fl;
  let rx = -fz, ry = 0, rz = fx;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;

  for (let bi = 0; bi < demoBodies.length; bi++) {
    const b = demoBodies[bi];
    const [nx, ny, depth] = projectToNdc(b.position, framed.cameraPos, framed.target, fovDeg, aspect);
    check(depth > 0, `framing ${vp.name} body ${bi} depth > 0 (${depth})`);
    check(Math.abs(nx) <= 1 && Math.abs(ny) <= 1, `framing ${vp.name} body ${bi} center in NDC (${nx}, ${ny})`);

    const extremes = [
      [b.position[0] + rx * b.radius, b.position[1] + ry * b.radius, b.position[2] + rz * b.radius],
      [b.position[0] - rx * b.radius, b.position[1] - ry * b.radius, b.position[2] - rz * b.radius],
      [b.position[0] + ux * b.radius, b.position[1] + uy * b.radius, b.position[2] + uz * b.radius],
      [b.position[0] - ux * b.radius, b.position[1] - uy * b.radius, b.position[2] - uz * b.radius],
    ];
    for (const ex of extremes) {
      const [exX, exY] = projectToNdc(ex, framed.cameraPos, framed.target, fovDeg, aspect);
      check(
        Math.abs(exX) <= 1 && Math.abs(exY) <= 1,
        `framing ${vp.name} body ${bi} limb inside NDC (${exX.toFixed(3)}, ${exY.toFixed(3)})`
      );
    }
  }

  const star = demoBodies[0];
  const dStar = Math.hypot(
    framed.cameraPos[0] - star.position[0],
    framed.cameraPos[1] - star.position[1],
    framed.cameraPos[2] - star.position[2]
  );
  const projStarPx = (star.radius / dStar) * (vp.h / (2 * tanHalfFov));
  const minHalf = Math.min(vp.w, vp.h) * 0.5;
  const starFrac = projStarPx / minHalf;
  check(
    closeupWeight(starFrac) === 1,
    `framing ${vp.name} star fraction=${starFrac.toFixed(4)} gives closeupWeight === 1`
  );

  const planet = demoBodies[1];
  const dPlanet = Math.hypot(
    framed.cameraPos[0] - planet.position[0],
    framed.cameraPos[1] - planet.position[1],
    framed.cameraPos[2] - planet.position[2]
  );
  const projPlanetPx = (planet.radius / dPlanet) * (vp.h / (2 * tanHalfFov));
  check(projPlanetPx >= 2, `framing ${vp.name} planet radius >= 2px (${projPlanetPx.toFixed(2)}px)`);
}

// B. Target lock (Gap 1): undoes host catalog snap while active
const desktopFramed = frameBodies(demoBodies, fovDeg, 1440 / 900);
const snappedTarget = [-12, 44, 108];
const locked1 = lockedTarget(snappedTarget, desktopFramed.target, true, true);
check(
  locked1[0] === desktopFramed.target[0] &&
    locked1[1] === desktopFramed.target[1] &&
    locked1[2] === desktopFramed.target[2],
  "lockedTarget returns anchor when active and lockEnabled"
);
const locked2 = lockedTarget(snappedTarget, desktopFramed.target, false, true);
check(
  locked2[0] === snappedTarget[0] && locked2[1] === snappedTarget[1] && locked2[2] === snappedTarget[2],
  "lockedTarget returns current when inactive"
);
const locked3 = lockedTarget(snappedTarget, desktopFramed.target, true, false);
check(
  locked3[0] === snappedTarget[0] && locked3[1] === snappedTarget[1] && locked3[2] === snappedTarget[2],
  "lockedTarget returns current when lock disabled"
);
for (let bi = 0; bi < demoBodies.length; bi++) {
  const [nx, ny, depth] = projectToNdc(
    demoBodies[bi].position,
    desktopFramed.cameraPos,
    locked1,
    fovDeg,
    1440 / 900
  );
  check(
    depth > 0 && Math.abs(nx) <= 1 && Math.abs(ny) <= 1,
    `post-lock body ${bi} remains in frame (${nx.toFixed(3)}, ${ny.toFixed(3)})`
  );
}

// C. Handoff & fly-in (Gap 2)
check(flyEase(0) === 0 && flyEase(1) === 1, "flyEase endpoints exact");
let prevEase = -1;
let easeMono = true;
for (let i = 0; i <= 100; i++) {
  const e = flyEase(i / 100);
  if (e < prevEase - 1e-12) easeMono = false;
  prevEase = e;
}
check(easeMono, "flyEase is monotone on [0,1]");
check(
  flyInDistance(0, 100, 10) === 100 &&
    flyInDistance(1, 100, 10) === 10 &&
    flyInDistance(-0.5, 100, 10) === 100 &&
    flyInDistance(1.5, 100, 10) === 10,
  "flyInDistance endpoints and clamping"
);

for (const vp of viewports) {
  const aspect = vp.w / vp.h;
  const framed = frameBodies(demoBodies, fovDeg, aspect);
  const shortSide = Math.min(vp.w, vp.h);
  const minHalf = shortSide * 0.5;
  const star = demoBodies[0];
  const startDist = flyStartDistance(star.radius, fovDeg, shortSide, vp.h);

  const totalFrames = Math.round((FLY_SECONDS + 0.5) * 60);
  let prevW = -1;
  let monoW = true;
  let mixSumOk = true;
  let midFrames = 0;
  let wStart = -1;
  let wEnd = -1;

  for (let f = 0; f <= totalFrames; f++) {
    const t = (f / 60) / FLY_SECONDS;
    const dist = flyInDistance(t, startDist, framed.distance);
    const camPos = [
      framed.target[0] + framed.dir[0] * dist,
      framed.target[1] + framed.dir[1] * dist,
      framed.target[2] + framed.dir[2] * dist,
    ];
    const dStar = Math.hypot(
      camPos[0] - star.position[0],
      camPos[1] - star.position[1],
      camPos[2] - star.position[2]
    );
    const projPx = (star.radius / dStar) * (vp.h / (2 * tanHalfFov));
    const frac = projPx / minHalf;
    const w = closeupWeight(frac);
    const mix = handoffMix(w);
    if (f === 0) wStart = w;
    if (f === totalFrames) wEnd = w;
    if (w < prevW - 1e-12) monoW = false;
    prevW = w;
    if (Math.abs(mix.point + mix.disc - 1) > 1e-12) mixSumOk = false;
    if (w > 0 && w < 1) midFrames++;
  }

  check(wStart === 0 && handoffMix(wStart).point === 1, `handoff ${vp.name} starts at weight 0 / point 1`);
  check(wEnd === 1 && handoffMix(wEnd).disc === 1, `handoff ${vp.name} ends at weight 1 / disc 1`);
  check(monoW, `handoff ${vp.name} weight is monotone non-decreasing`);
  check(mixSumOk, `handoff ${vp.name} point + disc === 1 every frame`);
  check(midFrames >= 30, `handoff ${vp.name} transition spans >= 30 frames (${midFrames})`);
}

// D. No-freeze performance guard
const t0 = performance.now();
let sink = 0;
for (let i = 0; i < 10000; i++) {
  const u = (i % 1000) * 0.001;
  const d = flyInDistance(u, 250, 12);
  const w = closeupWeight(1 / d);
  const m = handoffMix(w);
  sink += m.disc;
}
const elapsedMs = performance.now() - t0;
check(elapsedMs < 50 && sink >= 0, `10k fly/handoff iterations took ${elapsedMs.toFixed(2)}ms (< 50ms)`);

console.log(`closeup checks: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
