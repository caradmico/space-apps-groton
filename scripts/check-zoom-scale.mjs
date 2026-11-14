#!/usr/bin/env node
// scripts/check-zoom-scale.mjs
// Verification suite for zoom-scale.js and viewer integration.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const zoomScaleRel = fs.existsSync(path.join(rootDir, "public/bin-lod/js/zoom-scale.js"))
  && !fs.existsSync(path.join(rootDir, "public/js/zoom-scale.js"))
  ? "../public/bin-lod/js/zoom-scale.js"
  : "../public/js/zoom-scale.js";
const {
  AU_PER_PC,
  MAX_DIST_PC,
  ZOOM_LEVELS,
  DEFAULT_ZOOM,
  ZOOM_STORAGE_KEY,
  parseZoomLevel,
  resolveZoomLevel,
  persistZoomLevel,
  zoomStepPc,
  zoomReferenceDistance,
  formatZoomStep,
} = await import(zoomScaleRel);

let passed = 0;
let failed = 0;

function check(condition, message) {
  if (condition) {
    passed++;
    console.log(`PASS: ${message}`);
  } else {
    failed++;
    console.error(`FAIL: ${message}`);
  }
}

function makeMockStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem(k) {
      return store.has(k) ? store.get(k) : null;
    },
    setItem(k, v) {
      store.set(k, String(v));
    },
    raw: store,
  };
}

// 1. Constants & parse/resolve/persist
check(Math.abs(AU_PER_PC - 206264.806) < 1e-3, "AU_PER_PC is 206264.806");
check(MAX_DIST_PC === 1e5, "MAX_DIST_PC is 1e5");
check(
  Array.isArray(ZOOM_LEVELS) &&
    ZOOM_LEVELS.join(",") === "fine,medium,coarse",
  "ZOOM_LEVELS is fine,medium,coarse"
);
check(DEFAULT_ZOOM === "medium", "DEFAULT_ZOOM is medium");
check(ZOOM_STORAGE_KEY === "staris-zoom", "ZOOM_STORAGE_KEY is staris-zoom");

check(parseZoomLevel("fine") === "fine", "parseZoomLevel('fine')");
check(parseZoomLevel("COARSE") === "coarse", "parseZoomLevel('COARSE') case-insensitive");
check(parseZoomLevel("invalid") === null, "parseZoomLevel('invalid') -> null");
check(parseZoomLevel(null) === null, "parseZoomLevel(null) -> null");

const storeFine = makeMockStorage({ [ZOOM_STORAGE_KEY]: "fine" });
check(
  resolveZoomLevel({ search: "?zoom=coarse", storage: storeFine }) === "coarse",
  "resolveZoomLevel: URL ?zoom=coarse overrides storage"
);
check(
  resolveZoomLevel({ search: "?zoom=bogus", storage: storeFine }) === "fine",
  "resolveZoomLevel: invalid URL falls back to storage"
);
check(
  resolveZoomLevel({ search: "", storage: null }) === "medium",
  "resolveZoomLevel: empty search and null storage falls back to medium"
);

const storeWrite = makeMockStorage();
const testUrl = new URL("https://example.org/staris/?lod=v2");
persistZoomLevel("fine", storeWrite, testUrl);
check(
  storeWrite.getItem(ZOOM_STORAGE_KEY) === "fine",
  "persistZoomLevel writes valid level to storage"
);
check(
  testUrl.searchParams.get("zoom") === "fine",
  "persistZoomLevel updates URL searchParam"
);
persistZoomLevel("not-a-level", storeWrite, testUrl);
check(
  storeWrite.getItem(ZOOM_STORAGE_KEY) === "fine",
  "persistZoomLevel ignores invalid level"
);

// 2. Distance grid tests
const gridDistances = [
  { label: "1 AU", pc: 1 / AU_PER_PC },
  { label: "10 AU", pc: 10 / AU_PER_PC },
  { label: "1 pc", pc: 1 },
  { label: "10 pc", pc: 10 },
  { label: "1 kpc", pc: 1e3 },
  { label: "10 kpc", pc: 1e4 },
  { label: "1e5 pc", pc: 1e5 },
];

for (const { label, pc } of gridDistances) {
  const sFine = zoomStepPc(pc, "fine", 1);
  const sMed = zoomStepPc(pc, "medium", 1);
  const sCoarse = zoomStepPc(pc, "coarse", 1);

  check(
    Number.isFinite(sFine) && sFine > 0 &&
    Number.isFinite(sMed) && sMed > 0 &&
    Number.isFinite(sCoarse) && sCoarse > 0,
    `zoomStepPc finite > 0 at ${label}`
  );
  check(
    sFine < sMed && sMed < sCoarse,
    `fine < medium < coarse at ${label} (${sFine} < ${sMed} < ${sCoarse})`
  );
}

// 3. Monotone non-decreasing across the grid for each level
for (const level of ZOOM_LEVELS) {
  let monotone = true;
  let prev = -Infinity;
  for (const { pc } of gridDistances) {
    const step = zoomStepPc(pc, level, 1);
    if (step < prev) {
      monotone = false;
      break;
    }
    prev = step;
  }
  check(monotone, `zoomStepPc is monotone non-decreasing across grid for ${level}`);
}

// 4. Specific numeric bounds
const fine10AuInAu = zoomStepPc(10 / AU_PER_PC, "fine", 1) * AU_PER_PC;
check(
  fine10AuInAu >= 0.05 && fine10AuInAu <= 1.0,
  `Fine at 10 AU is between 0.05 AU and 1 AU (got ${fine10AuInAu.toFixed(4)} AU)`
);

const fine1AuInAu = zoomStepPc(1 / AU_PER_PC, "fine", 1) * AU_PER_PC;
check(
  fine1AuInAu < 0.25 && fine1AuInAu > 0,
  `Fine at 1 AU takes a step < 0.25 AU (got ${fine1AuInAu.toFixed(4)} AU)`
);

const med10Pc = zoomStepPc(10, "medium", 1);
check(
  med10Pc >= 1.5 && med10Pc <= 2.5,
  `Medium at 10 pc is between 1.5 and 2.5 pc (got ${med10Pc.toFixed(3)} pc)`
);

// 5. Coarse reach tests
{
  let d = 1;
  let stepsFrom1Pc = 0;
  while (d < MAX_DIST_PC && stepsFrom1Pc < 50) {
    d += zoomStepPc(d, "coarse", 1);
    stepsFrom1Pc++;
  }
  check(
    d >= MAX_DIST_PC && stepsFrom1Pc <= 12,
    `Coarse from 1 pc reaches 1e5 pc in <= 12 steps (took ${stepsFrom1Pc} steps)`
  );
}

{
  let d = 100 / AU_PER_PC;
  let stepsFrom100Au = 0;
  while (d < MAX_DIST_PC && stepsFrom100Au < 50) {
    d += zoomStepPc(d, "coarse", 1);
    stepsFrom100Au++;
  }
  check(
    d >= MAX_DIST_PC && stepsFrom100Au <= 16,
    `Coarse from 100 AU reaches 1e5 pc in <= 16 steps (took ${stepsFrom100Au} steps)`
  );
}

// 6. zoomReferenceDistance tests
{
  // First-person look-ahead (target is 0.5 pc away == lookGap, camera at 20 pc from origin)
  const dFp = zoomReferenceDistance({
    cameraPos: { x: 0, y: 0, z: 20 },
    targetPos: { x: 0, y: 0, z: 19.5 },
    lookGap: 0.5,
    interestPoints: [],
  });
  check(
    Math.abs(dFp - 20) < 1e-6,
    `zoomReferenceDistance ignores first-person lookGap target and uses origin distance (got ${dFp})`
  );

  // Real focus target (camera at 20 pc, looking at a star 3 pc away)
  const dTarget = zoomReferenceDistance({
    cameraPos: [0, 0, 20],
    targetPos: [0, 0, 17],
    lookGap: 0.5,
    interestPoints: [],
  });
  check(
    Math.abs(dTarget - 3) < 1e-6,
    `zoomReferenceDistance uses real focus target distance when closer than origin (got ${dTarget})`
  );

  // Interest point closer than origin during first-person look-ahead
  const dInterest = zoomReferenceDistance({
    cameraPos: { x: 10, y: 0, z: 0 },
    targetPos: { x: 9.5, y: 0, z: 0 },
    lookGap: 0.5,
    interestPoints: [{ x: 9.8, y: 0, z: 0 }],
  });
  check(
    Math.abs(dInterest - 0.2) < 1e-6,
    `zoomReferenceDistance uses nearest interest point when closer than origin (got ${dInterest})`
  );
}

// 7. formatZoomStep
const fmtAu = formatZoomStep(2 / AU_PER_PC);
const fmtPc = formatZoomStep(2);
check(
  typeof fmtAu === "string" && fmtAu.includes("AU/step"),
  `formatZoomStep under 0.1 pc includes 'AU/step' (got '${fmtAu}')`
);
check(
  typeof fmtPc === "string" && fmtPc.includes("pc/step"),
  `formatZoomStep >= 0.1 pc includes 'pc/step' (got '${fmtPc}')`
);

// 8. Viewer source wiring checks
const viewerDirs = ["public/js", "public/bin-lod/js"].map((d) => path.join(rootDir, d));
const viewerDir = viewerDirs.find((d) => fs.existsSync(path.join(d, "lod-v2.js")) || fs.existsSync(path.join(d, "lod-app.js")));
const lodV2Path = path.join(viewerDir || viewerDirs[0], "lod-v2.js");
const lodAppPath = path.join(viewerDir || viewerDirs[0], "lod-app.js");

const lodV2Src = fs.existsSync(lodV2Path) ? fs.readFileSync(lodV2Path, "utf8") : "";
const lodAppSrc = fs.existsSync(lodAppPath) ? fs.readFileSync(lodAppPath, "utf8") : "";

check(
  lodV2Src.includes("zoom-scale.js") && lodV2Src.includes("zoomStepPc"),
  path.relative(rootDir, lodV2Path) + " imports zoom-scale.js and uses zoomStepPc"
);
check(
  lodAppSrc.includes("zoom-scale.js") && lodAppSrc.includes("zoomStepPc"),
  path.relative(rootDir, lodAppPath) + " imports zoom-scale.js and uses zoomStepPc"
);

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
}
