import fs from "node:fs";
import {
  normalizeEmission,
  closeupWeight,
  tempToRGB,
  RECIPES,
  DEMO_SYSTEM,
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

console.log(`closeup checks: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
