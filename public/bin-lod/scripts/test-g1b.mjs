import { parseG1bHeader, inflateCell } from "./g1b.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const q10Dir = process.argv[2];
const g1bDir = process.argv[3];
if (!q10Dir || !g1bDir) {
    console.error("Usage: node test-g1b.mjs Q10_DIR G1B_DIR");
    process.exit(1);
}

const tiles = JSON.parse(readFileSync(`${g1bDir}/tiles.json`, "utf8"));
const summary = { packs: 0, cells: 0, stars: 0, ok: true };

for (const level of tiles.levels) {
    if (tiles.record?.pack !== "g1b" && level.record?.pack !== "g1b") continue;
    const packName = level.pack;
    const q8pk = readFileSync(`${q10Dir}/${packName}`);
    const g1bBuf = readFileSync(`${g1bDir}/${packName}`);

    const q8 = parseQ8pk(q8pk);
    const g1 = parseG1bHeader(new Uint8Array(g1bBuf));

    assert.equal(q8.cells.length, g1.cells.length);

    let payloadOffset = 12 + 12 * q8.cells.length;
    for (let i = 0; i < q8.cells.length; i++) {
        const qc = q8.cells[i];
        const gc = g1.cells[i];
        assert.equal(qc.local, gc.local);
        assert.equal(qc.count, gc.count);

        const q10bytes = q8pk.slice(payloadOffset, payloadOffset + qc.count * 10);
        if (qc.count > 0) {
            const inflated = await inflateCell(
                g1bBuf.slice(12 + 20 * g1.nCells + gc.byteOffset,
                            12 + 20 * g1.nCells + gc.byteOffset + gc.byteLen),
                qc.count
            );
            assert.deepEqual(new Uint8Array(q10bytes), inflated);
        }
        payloadOffset += qc.count * 10;
        summary.cells++;
        summary.stars += qc.count;
    }
    summary.packs++;
}

console.log(JSON.stringify(summary, null, 2));

function parseQ8pk(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset);
    const n = dv.getUint32(8, true);
    const cells = [];
    for (let i = 0; i < n; i++) {
        const off = 12 + i * 12;
        cells.push({
            local: dv.getUint32(off, true),
            count: dv.getUint32(off + 8, true)
        });
    }
    return { cells, nCells: n };
}
