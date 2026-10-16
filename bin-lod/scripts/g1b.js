export const G1B_MAGIC = "G1BK";

export function parseG1bHeader(bytes, fileSize = null) {
    if (bytes.length < 4 || String.fromCharCode(...bytes.slice(0, 4)) !== G1B_MAGIC) {
        throw new Error("bad magic");
    }
    if (bytes.length < 12) {
        return {incomplete:true, recordsAt:12, cells:[], nCells:0};
    }
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = dv.getUint8(4);
    if (version !== 1) throw new Error(`unsupported version ${version}`);
    const order = dv.getUint8(5);
    const parent = dv.getUint8(6);
    const nCells = dv.getUint32(8, true);
    const recordsAt = 12 + 20 * nCells;
    if (recordsAt > 2_000_000) throw new Error("pack header size");
    const cells = [];
    let incomplete = false;
    if (bytes.length < recordsAt) {
        incomplete = true;
    } else {
        for (let i = 0; i < nCells; i++) {
            const off = 12 + i * 20;
            const local = dv.getUint32(off, true);
            const start = dv.getUint32(off + 4, true);
            const count = dv.getUint32(off + 8, true);
            const byteOffset = dv.getUint32(off + 12, true);
            const byteLen = dv.getUint32(off + 16, true);
            if (count > 0 && byteLen === 0) throw new Error(`cell ${local} bad table entry`);
            if (byteOffset + byteLen > 0xFFFFFFFF) throw new Error(`cell ${local} bad table entry`);
            cells.push({local, start, count, byteOffset, byteLen});
        }
        if (Number.isFinite(fileSize)) {
            checkG1bBounds({recordsAt, cells}, fileSize);
        }
    }
    return {incomplete, version, order, parent, nCells, recordsAt, cells};
}

export function checkG1bBounds(pack, fileSize) {
    if (!Number.isFinite(fileSize)) return pack;
    for (const c of pack.cells) {
        if (pack.recordsAt + c.byteOffset + c.byteLen > fileSize) {
            throw new Error(`cell ${c.local} body out of range`);
        }
    }
    return pack;
}

export async function inflateCell(blob, count) {
    if (count === 0) return new Uint8Array(0);
    const ds = new DecompressionStream("deflate");
    const reader = new Response(new Blob([blob]).stream().pipeThrough(ds)).body.getReader();
    const chunks = [];
    while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        chunks.push(value);
    }
    const inflated = new Uint8Array((await new Blob(chunks).arrayBuffer()));
    if (inflated.length !== count * 10) {
        throw new Error(`inflated length ${inflated.length} != ${count * 10}`);
    }
    const out = new Uint8Array(count * 10);
    for (let p = 0; p < 10; p++) {
        for (let i = 0; i < count; i++) {
            out[i * 10 + p] = inflated[p * count + i];
        }
    }
    return out;
}
