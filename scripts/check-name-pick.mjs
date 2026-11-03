import fs from "node:fs";
import { pickNearest } from "../public/bin-lod/js/name-pick.js";

// pickNearest returns the candidate object; compare by name.
const pickName = (...args) => pickNearest(...args)?.name ?? null;

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

// Unit checks on pickNearest
check(pickName([], 10, 10) === null, "empty list -> null");
check(pickName(null, 10, 10) === null, "null list -> null");

check(
  pickName(
    [
      { name: "Far", sx: 10, sy: 20 },
      { name: "Near", sx: 10, sy: 15 },
    ],
    10,
    10
  ) === "Near",
  "nearest of two within range wins"
);

check(
  pickName([{ name: "Edge", sx: 12, sy: 0 }], 0, 0, 12) === "Edge",
  "point exactly at maxPx (distance 12) is picked"
);

check(
  pickName([{ name: "Out", sx: 12.01, sy: 0 }], 0, 0, 12) === null,
  "point at 12.01 is not picked with maxPx 12"
);

check(
  pickName(
    [
      { name: "", sx: 0, sy: 0 },
      { sx: 0, sy: 0 },
      { name: "BadX", sx: NaN, sy: 0 },
      { name: "BadY", sx: 0, sy: NaN },
      { name: "Valid", sx: 5, sy: 0 },
    ],
    0,
    0,
    12
  ) === "Valid",
  "candidates with empty/missing name or NaN coords are ignored"
);

check(
  pickName([{ name: "Mobile", sx: 20, sy: 0 }], 0, 0) === null,
  "default maxPx (12) does not pick at 20 px"
);

check(
  pickName([{ name: "Mobile", sx: 20, sy: 0 }], 0, 0, 22) === "Mobile",
  "custom maxPx 22 picks at 20 px"
);

check(
  pickName(
    [
      { name: "First", sx: 5, sy: 0 },
      { name: "Second", sx: -5, sy: 0 },
    ],
    0,
    0,
    12
  ) === "First",
  "tie -> first candidate wins"
);

// Real data check: public/bin-lod/data/hyg-near.bin
const binUrl = new URL("../public/bin-lod/data/hyg-near.bin", import.meta.url);
const buf = fs.readFileSync(binUrl);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

const magic = dv.getUint32(0, true);
const n = dv.getUint32(4, true);
const scale_pc = dv.getFloat32(8, true);
const max_dist_pc = dv.getFloat32(12, true);
const name_count = dv.getUint32(16, true);
const name_bytes = dv.getUint32(20, true);

console.log(
  `hyg-near.bin: size=${buf.byteLength} bytes, n=${n}, scale_pc=${scale_pc}, max_dist_pc=${max_dist_pc}, name_count=${name_count}, name_bytes=${name_bytes}`
);

check(magic === 0x32475948, "hyg-near.bin magic matches 0x32475948");

const posOffset = 24;
const magOffset = posOffset + n * 6;
const tableOffset = magOffset + n;
const strOffset = tableOffset + name_count * 3;

const dec = new TextDecoder("utf-8");
const names = new Array(n).fill("");
const namedStars = [];

let curStr = strOffset;
for (let i = 0; i < name_count; i++) {
  const entryOff = tableOffset + i * 3;
  const idx = dv.getUint16(entryOff, true);
  const len = dv.getUint8(entryOff + 2);
  const name = dec.decode(buf.subarray(curStr, curStr + len));
  curStr += len;
  names[idx] = name;

  const pOff = posOffset + idx * 6;
  const x = dv.getInt16(pOff, true) * scale_pc;
  const y = dv.getInt16(pOff + 2, true) * scale_pc;
  const z = dv.getInt16(pOff + 4, true) * scale_pc;
  namedStars.push({ idx, name, x, y, z });
}

const byName = new Map(namedStars.map((s) => [s.name, s]));
check(byName.has("Sirius"), "Sirius present in hyg-near.bin");
check(byName.has("Vega"), "Vega present in hyg-near.bin");

function norm(v) {
  const m = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / m, v[1] / m, v[2] / m];
}
function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

for (const targetName of ["Sirius", "Vega"]) {
  const t = byName.get(targetName);
  if (!t) continue;
  const f = norm([t.x, t.y, t.z]);
  const upGuess = Math.abs(f[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1];
  const right = norm(cross(f, upGuess));
  const u = cross(right, f);

  const cands = [];
  for (const s of namedStars) {
    const p = [s.x, s.y, s.z];
    const depth = dot(p, f);
    if (depth <= 0) continue;
    const sx = 720 + (800 * dot(p, right)) / depth;
    const sy = 450 - (800 * dot(p, u)) / depth;
    cands.push({ name: s.name, sx, sy });
  }

  const pickedNear = pickName(cands, 723, 452);
  check(
    pickedNear === targetName,
    `pinhole projection picks ${targetName} near screen center (got ${pickedNear})`
  );

  const pickedFar = pickName(cands, 720 + 300, 450 + 300);
  check(
    pickedFar !== targetName,
    `pinhole projection does not pick ${targetName} 300px away (got ${pickedFar})`
  );
}

console.log(`name-pick checks: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
