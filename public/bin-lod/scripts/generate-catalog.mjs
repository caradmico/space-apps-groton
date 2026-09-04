#!/usr/bin/env node
/**
 * Write a format-compatible 62-byte LE catalog (SpaceIS pre-strip layout).
 * Synthetic galactic-disk jitter — not live Gaia. Storage gaia_processed.bin
 * returned HTTP 404 on 2026-09-04.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RECORD_SIZE = 62;
const COUNT = 65536;
const UNIT = 206265;
const SEED = 20260904;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const rng = mulberry32(SEED);
const buf = Buffer.alloc(COUNT * RECORD_SIZE);

for (let i = 0; i < COUNT; i++) {
  const roll = rng();
  let x;
  let y;
  let z;
  let mag;
  let colorClass;

  if (i < 48) {
    x = gaussian(rng) * 2.4;
    y = gaussian(rng) * 2.4;
    z = gaussian(rng) * 1.6;
    mag = -1.2 + rng() * 3.2;
    colorClass = Math.floor(rng() * 5);
  } else if (roll < 0.16) {
    x = gaussian(rng) * 7.5;
    y = gaussian(rng) * 7.5;
    z = gaussian(rng) * 3.6;
    mag = 3.5 + rng() * 8;
    colorClass = Math.floor(rng() * 5);
  } else if (roll < 0.9) {
    const r = Math.abs(gaussian(rng)) * 40 + rng() * 10;
    const arm = Math.floor(rng() * 2);
    const theta = rng() * Math.PI * 2;
    const spiral = theta + r * 0.11 + arm * Math.PI;
    x = r * Math.cos(spiral) + gaussian(rng) * 1.7;
    y = r * Math.sin(spiral) + gaussian(rng) * 1.7;
    z = gaussian(rng) * (1.15 + r * 0.018);
    mag = 2.8 + rng() * 10.5;
    colorClass = 2 + Math.floor(rng() * 5);
  } else {
    const r = 28 + rng() * 72;
    const theta = rng() * Math.PI * 2;
    const phi = Math.acos(2 * rng() - 1);
    x = r * Math.sin(phi) * Math.cos(theta);
    y = r * Math.sin(phi) * Math.sin(theta);
    z = r * Math.cos(phi);
    mag = 6 + rng() * 8;
    colorClass = Math.floor(rng() * 7);
  }

  const off = i * RECORD_SIZE;
  buf.writeUInt32LE(i + 1, off);
  buf.writeDoubleLE(x / UNIT, off + 32);
  buf.writeDoubleLE(y / UNIT, off + 40);
  buf.writeDoubleLE(z / UNIT, off + 48);
  buf.writeUInt16LE(colorClass, off + 56);
  buf.writeFloatLE(mag, off + 58);
}

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "catalog.bin");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, buf);
console.log(`wrote ${COUNT} records × ${RECORD_SIZE} B = ${buf.length} bytes → ${out}`);
