/**
 * Q8 decoder for the BIN LOD viewer. 8 bytes, little-endian.
 * See public/bin-lod/README.md for the spec. Encoder: q8.py.
 */

export const Q8_BYTES = 8;
export const RA_CODES = 16777216;
export const DEC_CODES = 16777215;
export const MAG0 = -2;
export const MAG_STEP = 0.1;

export function decodeQ8(view, byteOffset = 0) {
  const raQ =
    view.getUint8(byteOffset) |
    (view.getUint8(byteOffset + 1) << 8) |
    (view.getUint8(byteOffset + 2) << 16);
  const decQ =
    view.getUint8(byteOffset + 3) |
    (view.getUint8(byteOffset + 4) << 8) |
    (view.getUint8(byteOffset + 5) << 16);
  const magQ = view.getUint8(byteOffset + 6);
  const flags = view.getUint8(byteOffset + 7);
  return {
    ra: (raQ / RA_CODES) * 360,
    dec: (decQ / DEC_CODES) * 180 - 90,
    mag: MAG0 + magQ * MAG_STEP,
    flags,
    colour: flags & 3,
    hasParallax: (flags & 4) !== 0,
  };
}

export function decodeQ8Buffer(buffer, byteOffset = 0, count = 0) {
  const view = buffer instanceof DataView ? buffer : new DataView(buffer);
  const bytes = view.byteLength - byteOffset;
  const n = count > 0 ? count : Math.floor(bytes / Q8_BYTES);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = decodeQ8(view, byteOffset + i * Q8_BYTES);
  return out;
}
