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

// 4. tempToRGB(5800) validation
const rgb = tempToRGB(5800);
const REF = [1, 0.950274, 0.891356];
check(Array.isArray(rgb) && rgb.length === 3, "tempToRGB(5800) array length 3");
for (let i = 0; i < 3; i++) {
  check(
    Math.abs(rgb[i] - REF[i]) <= 1e-5,
    `tempToRGB(5800) channel ${i}: actual=${rgb[i]} ref=${REF[i]}`
  );
}

console.log(`closeup checks: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
