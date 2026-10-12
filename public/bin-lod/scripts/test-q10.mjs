import fs from 'fs';
import assert from 'node:assert/strict';
import { decodeQ10, Q10_BYTES } from './q8.js';

const tiles = JSON.parse(fs.readFileSync('data/v2-pilot/tiles.json', 'utf8'));

let records = 0;
let withDist = 0;
let minPc = Infinity;
let maxPc = -Infinity;

for (const level of tiles.levels || []) {
  const path = `data/v2-pilot/${level.pack}`;
  const buf = fs.readFileSync(path);
  const dv = new DataView(buf.buffer, buf.byteOffset);
  if (String.fromCharCode(dv.getUint8(0),dv.getUint8(1),dv.getUint8(2),dv.getUint8(3)) !== "Q8PK") throw new Error(`bad magic in ${level.pack}`);
  const nCells = dv.getUint32(8, true);
  const headerLen = 12 + nCells * 12;
  const n = level.n || ((buf.length - headerLen) / Q10_BYTES);
  for (let i = 0; i < n; i++) {
    const offset = headerLen + i * Q10_BYTES;
    const rec = decodeQ10(dv, offset);
    records++;
    if (Number.isFinite(rec.distPc) && rec.distPc > 0) {
      withDist++;
      minPc = Math.min(minPc, rec.distPc);
      maxPc = Math.max(maxPc, rec.distPc);
    }
  }
}

assert(records > 0);
assert(!tiles.total_records || records === tiles.total_records);
assert(withDist > 0);
assert(minPc >= 0.1*(1-1e-3));
assert(maxPc <= 1e5*(1+1e-3));
console.log(JSON.stringify({records, withDist, minPc, maxPc}));
