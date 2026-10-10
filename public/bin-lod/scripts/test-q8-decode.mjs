/**
 * Decode a Q8 buffer produced by test_q8.py and print max errors.
 * Usage: node public/bin-lod/scripts/test-q8-decode.mjs <q8.bin> <sidecar.json>
 */
import fs from "node:fs";
import { decodeQ8 } from "./q8.js";

const [binPath, sidePath] = process.argv.slice(2);
const raw = fs.readFileSync(binPath);
const side = JSON.parse(fs.readFileSync(sidePath, "utf8"));
const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
if (raw.byteLength !== side.n * 8) {
  throw new Error(`byte length ${raw.byteLength} != ${side.n} records`);
}

let maxRa = 0;
let maxDec = 0;
let maxMag = 0;
for (let i = 0; i < side.n; i++) {
  const star = decodeQ8(view, i * 8);
  let dra = star.ra - side.ra[i];
  dra = ((dra + 180) % 360) - 180;
  const raErr = Math.abs(dra * 3600 * Math.cos((side.dec[i] * Math.PI) / 180));
  const decErr = Math.abs(star.dec - side.dec[i]) * 3600;
  const magErr = Math.abs(star.mag - side.mag[i]);
  if (raErr > maxRa) maxRa = raErr;
  if (decErr > maxDec) maxDec = decErr;
  if (magErr > maxMag) maxMag = magErr;
  if ((star.flags & 3) !== side.colour[i]) {
    throw new Error(`colour mismatch at ${i}`);
  }
  if (((star.flags & 4) !== 0) !== side.parallax[i]) {
    throw new Error(`parallax flag mismatch at ${i}`);
  }
}

const result = { n: side.n, maxRa, maxDec, maxMag };
if (maxRa > side.raLimit || maxDec > side.decLimit || maxMag > side.magLimit) {
  console.error(JSON.stringify(result));
  process.exit(1);
}
console.log(JSON.stringify(result));
