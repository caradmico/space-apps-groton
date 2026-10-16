import assert from "node:assert/strict";
import { InflatedCache } from "../js/inflated-cache.js";

const c = new InflatedCache(3);

// (1) basic eviction
for (let i = 1; i <= 5; i++) c.set(i, `v${i}`);
assert.equal(c.size, 5);
assert.equal(c.trim(), 2);
assert.equal(c.size, 3);
assert.equal(c.has(1), false);
assert.equal(c.has(2), false);
assert.equal(c.has(3), true);
assert.equal(c.has(4), true);
assert.equal(c.has(5), true);

// (2) get refreshes recency
c.get(3);
assert.equal(c.trim(), 0);
c.set(6, "v6");
assert.equal(c.trim(), 1);
assert.equal(c.has(3), true);
assert.equal(c.has(4), false);
assert.equal(c.has(5), true);
assert.equal(c.has(6), true);

// (3) pinned keys are never evicted
c.pin([5]);
c.set(7, "v7");
c.set(8, "v8");
assert.equal(c.trim(), 2); // 5 is least-recent but pinned: 3 and 6 go
assert.equal(c.has(3), false);
assert.equal(c.has(5), true);
assert.equal(c.has(6), false);
assert.equal(c.has(7), true);
assert.equal(c.has(8), true);
c.unpin([5]);

// (4) pinned batch > max
const big = [10, 11, 12, 13, 14];
c.pin(big);
for (const k of big) c.set(k, `v${k}`);
assert.equal(c.size, 8);
assert.equal(c.trim(), 3); // only the unpinned 5, 7, 8 can go
assert.equal(c.size, 5);
assert.equal(big.every((k) => c.has(k)), true);
c.unpin(big);
assert.equal(c.trim(), 2);
assert.equal(c.size, 3);
assert.equal(c.has(12), true);
assert.equal(c.has(13), true);
assert.equal(c.has(14), true);

// (5) overlapping loads
const A = new InflatedCache(3);
A.pin([1, 2, 3]);
for (let i = 1; i <= 3; i++) A.set(i, i);
const Bkeys = [4, 5, 6];
A.pin(Bkeys); // overlap on nothing but same cache
for (let i = 4; i <= 6; i++) A.set(i, i);
A.unpin(Bkeys);
assert.equal(A.trim(), 3);
assert.equal(A.has(1), true);
assert.equal(A.has(2), true);
assert.equal(A.has(3), true);
assert.equal(A.has(4), false);
assert.equal(A.has(5), false);
assert.equal(A.has(6), false);

// (6) trim returns count
assert.equal(A.trim(), 0);
A.set(7, 7);
A.set(8, 8);
assert.equal(A.trim(), 2);

console.log(JSON.stringify({ ok: true, checks: 6 }));
