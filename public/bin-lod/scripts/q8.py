"""Q8 star records: 8 bytes, for Colab and the BIN LOD viewer.

Little-endian layout
  uint24 ra_q     RA  = ra_q / 2^24 * 360 degrees, wrapped
  uint24 dec_q    Dec = dec_q / (2^24 - 1) * 180 - 90 degrees
  uint8  mag_q    mag = -2 + mag_q * 0.1
  uint8  flags    bits 0-1 colour class 0-3, bit 2 parallax present, bits 3-7 zero

Q10 (v2): the above 8 bytes + uint16 dist_q (LE at bytes 8-9).
dist_q = 0 means no distance (parallax missing/non-positive/non-finite or out of range).
Otherwise log10(d_pc) = LOG_D_MIN + (dist_q - 1) * LOG_D_STEP with LOG_D_MIN=-1.0,
LOG_D_MAX=5.0, STEP=(5-(-1))/65534. d=1000/plx_mas (mas); clamp log10(d); 
dist_q=1 + round((logd - MIN)/STEP). Flags bit 2 stays "parallax present".
Max relative distance error <= DIST_REL_ERR.

Round to nearest for all. Q8 decoding works unchanged on first 8 bytes.
"""

from __future__ import annotations

import math

import numpy as np

Q8_BYTES = 8
RA_CODES = 1 << 24
DEC_CODES = RA_CODES - 1
MAG0 = -2.0
MAG_STEP = 0.1
# Exact half-code limits. The spec quotes these to 4 decimal places: 0.0386″ and 0.0193″.
RA_ERR_ARCSEC = 0.5 * 360.0 * 3600.0 / RA_CODES
DEC_ERR_ARCSEC = 0.5 * 180.0 * 3600.0 / DEC_CODES
MAG_ERR = 0.05

Q10_BYTES = 10
LOG_D_MIN = -1.0
LOG_D_MAX = 5.0
LOG_D_STEP = (LOG_D_MAX - LOG_D_MIN) / 65534
DIST_REL_ERR = 10 ** (LOG_D_STEP / 2) - 1


def _as_f64(values):
    arr = np.asarray(values, dtype=np.float64)
    if arr.ndim != 1:
        raise ValueError("expected a 1-d array")
    return arr


def encode_q8(ra_deg, dec_deg, mag, colour=None, has_parallax=None):
    """Encode parallel arrays to an (n, 8) uint8 array. Finite inputs only."""
    ra = _as_f64(ra_deg)
    dec = _as_f64(dec_deg)
    g = _as_f64(mag)
    n = ra.shape[0]
    if dec.shape[0] != n or g.shape[0] != n:
        raise ValueError("ra, dec, and mag lengths differ")
    if not (np.isfinite(ra).all() and np.isfinite(dec).all() and np.isfinite(g).all()):
        raise ValueError("ra, dec, and mag must be finite")
    if colour is None:
        colour_q = np.zeros(n, dtype=np.int64)
    else:
        colour_q = np.asarray(colour, dtype=np.int64) & 3
        if colour_q.shape[0] != n:
            raise ValueError("colour length differs")
    if has_parallax is None:
        plx = np.zeros(n, dtype=np.int64)
    else:
        plx = np.asarray(has_parallax, dtype=np.int64) & 1
        if plx.shape[0] != n:
            raise ValueError("has_parallax length differs")

    ra_wrapped = np.mod(ra, 360.0)
    ra_q = np.rint(ra_wrapped / 360.0 * RA_CODES).astype(np.int64) % RA_CODES
    dec_q = np.rint((dec + 90.0) / 180.0 * DEC_CODES).astype(np.int64)
    np.clip(dec_q, 0, DEC_CODES, out=dec_q)
    mag_q = np.rint((g - MAG0) / MAG_STEP).astype(np.int64)
    np.clip(mag_q, 0, 255, out=mag_q)
    flags = colour_q | (plx << 2)

    out = np.empty((n, Q8_BYTES), dtype=np.uint8)
    out[:, 0] = ra_q & 0xFF
    out[:, 1] = (ra_q >> 8) & 0xFF
    out[:, 2] = (ra_q >> 16) & 0xFF
    out[:, 3] = dec_q & 0xFF
    out[:, 4] = (dec_q >> 8) & 0xFF
    out[:, 5] = (dec_q >> 16) & 0xFF
    out[:, 6] = mag_q
    out[:, 7] = flags
    return out


def decode_q8(raw):
    """Inverse of encode_q8. Returns ra degrees, dec degrees, mag, flags."""
    buf = np.asarray(raw, dtype=np.uint8)
    if buf.size % Q8_BYTES != 0:
        raise ValueError("Q8 buffer length is not a multiple of 8")
    rec = buf.reshape(-1, Q8_BYTES).astype(np.int64)
    ra_q = rec[:, 0] | (rec[:, 1] << 8) | (rec[:, 2] << 16)
    dec_q = rec[:, 3] | (rec[:, 4] << 8) | (rec[:, 5] << 16)
    mag_q = rec[:, 6]
    flags = rec[:, 7]
    ra = ra_q / RA_CODES * 360.0
    dec = dec_q / DEC_CODES * 180.0 - 90.0
    mag = MAG0 + mag_q * MAG_STEP
    return ra, dec, mag, flags


def encode_q10(ra_deg, dec_deg, mag, colour=None, parallax_mas=None):
    """Encode parallel arrays to (n, 10) uint8 Q10 records. parallax_mas is raw array in mas (or None)."""
    ra = _as_f64(ra_deg)
    dec = _as_f64(dec_deg)
    g = _as_f64(mag)
    n = ra.shape[0]
    if dec.shape[0] != n or g.shape[0] != n:
        raise ValueError("ra, dec, and mag lengths differ")
    if parallax_mas is None:
        has_parallax = None
    else:
        plx = _as_f64(parallax_mas)
        if plx.shape[0] != n:
            raise ValueError("parallax_mas length differs")
        has_parallax = np.isfinite(plx) & (plx > 0.0)
    q8 = encode_q8(ra, dec, g, colour, has_parallax)
    out = np.empty((n, Q10_BYTES), dtype=np.uint8)
    out[:, :8] = q8
    if parallax_mas is None:
        dist_q = np.zeros(n, dtype=np.uint16)
    else:
        plx = _as_f64(parallax_mas)
        d = 1000.0 / plx
        logd = np.log10(d)
        logd = np.clip(logd, LOG_D_MIN, LOG_D_MAX)
        dist_q = np.rint(1 + (logd - LOG_D_MIN) / LOG_D_STEP).astype(np.uint16)
        dist_q[~np.isfinite(plx) | (plx <= 0)] = 0
    out[:, 8] = dist_q & 0xFF
    out[:, 9] = (dist_q >> 8) & 0xFF
    return out


def decode_q10(raw):
    """Inverse of encode_q10. Returns dict of arrays; 'dist_pc' is nan when dist_q==0."""
    buf = np.asarray(raw, dtype=np.uint8)
    if buf.size % Q10_BYTES != 0:
        raise ValueError("Q10 buffer length is not a multiple of 10")
    rec = buf.reshape(-1, Q10_BYTES).astype(np.int64)
    ra_q = rec[:, 0] | (rec[:, 1] << 8) | (rec[:, 2] << 16)
    dec_q = rec[:, 3] | (rec[:, 4] << 8) | (rec[:, 5] << 16)
    mag_q = rec[:, 6]
    flags = rec[:, 7]
    dist_q = rec[:, 8] | (rec[:, 9] << 8)
    ra = ra_q / RA_CODES * 360.0
    dec = dec_q / DEC_CODES * 180.0 - 90.0
    mag = MAG0 + mag_q * MAG_STEP
    dist_pc = np.full(ra.shape[0], np.nan, dtype=np.float64)
    valid = dist_q > 0
    if np.any(valid):
        logd = LOG_D_MIN + (dist_q[valid].astype(np.float64) - 1) * LOG_D_STEP
        dist_pc[valid] = 10 ** logd
    return {
        "ra": ra,
        "dec": dec,
        "mag": mag,
        "flags": flags,
        "dist_pc": dist_pc,
        "colour": flags & 3,
        "hasParallax": (flags & 4) != 0,
    }


def angular_errors(ra_deg, dec_deg, ra_out, dec_out):
    """|dRA cos Dec| and |dDec| in arcseconds. cos(Dec) uses the source Dec."""
    dra = (ra_out - ra_deg + 180.0) % 360.0 - 180.0
    cos_dec = np.cos(np.deg2rad(dec_deg))
    return np.abs(dra * 3600.0 * cos_dec), np.abs(dec_out - dec_deg) * 3600.0
