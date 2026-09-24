// STF1 far decoder and STN1 near decoder.
// Near files have no magic. The 16-byte header is pix, n, and f16 origin/scale.
// Bit widths and the shared magnitude range come from manifest.json.
// Bit order is LSB-first: qx, then qy, then qz, then mag.

function readBits(bytes, bitOffset, n) {
  let v = 0;
  for (let i = 0; i < n; i++) {
    const p = bitOffset + i;
    const bit = (bytes[p >> 3] >> (p & 7)) & 1;
    v += bit * 2 ** i;
  }
  return v;
}

export function f16(u) {
  const s = (u & 0x8000) >> 15;
  const e = (u & 0x7c00) >> 10;
  const f = u & 0x03ff;
  let out;
  if (e === 0) out = f * 2 ** -24;
  else if (e === 31) out = f ? NaN : Infinity;
  else out = (1 + f / 1024) * 2 ** (e - 15);
  return s ? -out : out;
}

function magicOf(dv) {
  return String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
}

export function decodeFar(buffer) {
  const dv = new DataView(buffer);
  const magic = magicOf(dv);
  if (magic !== "STF1") throw new Error(`far.bin magic ${magic}`);
  const version = dv.getUint16(4, true);
  const nside = dv.getUint16(6, true);
  const nTiles = dv.getUint32(8, true);
  const tiles = [];
  let o = 16;
  for (let i = 0; i < nTiles; i++) {
    tiles.push({
      pix: dv.getUint32(o, true),
      count: dv.getUint16(o + 4, true),
      fluxSumQ: dv.getUint16(o + 6, true),
      cx: f16(dv.getUint16(o + 8, true)),
      cy: f16(dv.getUint16(o + 10, true)),
      cz: f16(dv.getUint16(o + 12, true)),
      meanMagQ: dv.getUint8(o + 14),
    });
    o += 15;
  }
  if (o !== buffer.byteLength) throw new Error(`far.bin length ${buffer.byteLength} != ${o}`);
  return { version, nside, nTiles, tiles };
}

export function dequantMeanMag(q, mag0, mag1) {
  return mag0 + (q / 255) * (mag1 - mag0);
}

export function decodeNear(buffer, manifest) {
  if (!manifest || manifest.codec !== "STN1") throw new Error("manifest codec");
  const xyzBits = manifest.xyz_bits;
  const magBits = manifest.mag_bits;
  const mag0 = manifest.mag0;
  const magScale = manifest.mag_scale;
  const dv = new DataView(buffer);
  const pix = dv.getUint16(0, true);
  const n = dv.getUint16(2, true);
  const ox = f16(dv.getUint16(4, true));
  const oy = f16(dv.getUint16(6, true));
  const oz = f16(dv.getUint16(8, true));
  const sx = f16(dv.getUint16(10, true));
  const sy = f16(dv.getUint16(12, true));
  const sz = f16(dv.getUint16(14, true));
  const bodyBits = n * (xyzBits * 3 + magBits);
  const bodyBytes = Math.ceil(bodyBits / 8);
  const bytes = new Uint8Array(buffer, 16, bodyBytes);
  const xyz = new Float32Array(n * 3);
  const mag = new Float32Array(n);
  const qmax = (1 << xyzBits) - 1;
  const mmax = (1 << magBits) - 1;
  let bit = 0;
  for (let i = 0; i < n; i++) {
    const qx = readBits(bytes, bit, xyzBits);
    bit += xyzBits;
    const qy = readBits(bytes, bit, xyzBits);
    bit += xyzBits;
    const qz = readBits(bytes, bit, xyzBits);
    bit += xyzBits;
    const qm = readBits(bytes, bit, magBits);
    bit += magBits;
    xyz[i * 3] = ox + (sx ? (qx / qmax) * sx : 0);
    xyz[i * 3 + 1] = oy + (sy ? (qy / qmax) * sy : 0);
    xyz[i * 3 + 2] = oz + (sz ? (qz / qmax) * sz : 0);
    mag[i] = mag0 + (magScale ? (qm / mmax) * magScale : 0);
  }
  const rowId = new Uint16Array(n);
  const idOff = 16 + bodyBytes;
  for (let i = 0; i < n; i++) rowId[i] = dv.getUint16(idOff + i * 2, true);
  if (idOff + n * 2 !== buffer.byteLength) {
    throw new Error(`near ${pix} length ${buffer.byteLength} != ${idOff + n * 2}`);
  }
  return { pix, n, xyzBits, magBits, xyz, mag, rowId };
}
