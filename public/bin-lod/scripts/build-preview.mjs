#!/usr/bin/env node
/**
 * Write public/bin-lod/data/preview.bin from the tiles in data/tiles.json.
 *
 * The preview is a coarse whole-sky FAR sample: up to 12,288 records in the
 * same 62-byte layout as the tiles. Global brightest-only selection leaves
 * some tiles almost empty (tile-005 contributes about 99 of the top 12,288),
 * so each tile keeps its brightest stars up to that tile's share of the
 * budget. Shares match the viewer's FAR quotas.
 *
 * Regenerate (does not modify the source tiles, tiles.json, or catalog.bin):
 *   node public/bin-lod/scripts/build-preview.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RECORD_SIZE = 62;
const OFF_RA = 8;
const OFF_DEC = 16;
const OFF_MAG = 58;
const BUDGET = 12288;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = join(root, "data", "tiles.json");
const outPath = join(root, "data", "preview.bin");
const index = JSON.parse(readFileSync(indexPath, "utf8"));
if (index.layout !== "gaia_radec") {
  throw new Error(`expected layout gaia_radec, got ${index.layout}`);
}
const tiles = index.tiles;
if (!Array.isArray(tiles) || tiles.length === 0) {
  throw new Error("tiles.json has no tiles");
}

function readMag(buf, i) {
  return buf.readFloatLE(i * RECORD_SIZE + OFF_MAG);
}

function isFiniteStar(buf, i) {
  const ra = buf.readDoubleLE(i * RECORD_SIZE + OFF_RA);
  const dec = buf.readDoubleLE(i * RECORD_SIZE + OFF_DEC);
  const mag = readMag(buf, i);
  return Number.isFinite(ra) && Number.isFinite(dec) && Number.isFinite(mag);
}

const loaded = tiles.map((tile) => {
  const file = join(root, "data", "tiles", `${tile.id}.bin`);
  const buf = readFileSync(file);
  const count = Math.floor(buf.length / RECORD_SIZE);
  const finite = [];
  for (let i = 0; i < count; i++) {
    if (!isFiniteStar(buf, i)) continue;
    finite.push(i);
  }
  finite.sort((a, b) => readMag(buf, a) - readMag(buf, b) || a - b);
  return { tile, buf, count, finite };
});

const counts = loaded.map((entry) => entry.finite.length);
const total = counts.reduce((sum, n) => sum + n, 0) || 1;
const quotas = [];
let assigned = 0;
counts.forEach((n, i) => {
  let quota;
  if (i === counts.length - 1) {
    quota = Math.max(0, BUDGET - assigned);
  } else {
    quota = Math.round((BUDGET * n) / total);
    if (n > 0) quota = Math.max(1, quota);
    quota = Math.min(quota, Math.max(0, BUDGET - assigned));
  }
  quota = Math.min(quota, n > 0 ? n : quota);
  assigned += quota;
  quotas.push(quota);
});

const globalPick = [];
for (const entry of loaded) {
  for (const index of entry.finite) {
    globalPick.push({ mag: readMag(entry.buf, index), tile: entry.tile.id });
  }
}
globalPick.sort((a, b) => a.mag - b.mag);
const brightestOnly = {};
for (const star of globalPick.slice(0, BUDGET)) {
  brightestOnly[star.tile] = (brightestOnly[star.tile] || 0) + 1;
}

const parts = [];
const chosen = {};
loaded.forEach((entry, i) => {
  const quota = quotas[i];
  const picked = entry.finite.slice(0, quota);
  chosen[entry.tile.id] = picked.length;
  for (const index of picked) {
    const start = index * RECORD_SIZE;
    parts.push(entry.buf.subarray(start, start + RECORD_SIZE));
  }
});

const preview = Buffer.concat(parts);
if (preview.length !== BUDGET * RECORD_SIZE) {
  throw new Error(`preview is ${preview.length} bytes, expected ${BUDGET * RECORD_SIZE}`);
}
writeFileSync(outPath, preview);
console.log(
  JSON.stringify(
    {
      out: outPath,
      records: preview.length / RECORD_SIZE,
      bytes: preview.length,
      brightestOnly,
      perTile: chosen,
      quotas,
    },
    null,
    2
  )
);
