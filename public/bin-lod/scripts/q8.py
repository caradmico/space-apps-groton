"""Q8 star records: 8 bytes, for Colab and the BIN LOD viewer.

Little-endian layout
  uint24 ra_q     RA  = ra_q / 2^24 * 360 degrees, wrapped
  uint24 dec_q    Dec = dec_q / (2^24 - 1) * 180 - 90 degrees
  uint8  mag_q    mag = -2 + mag_q * 0.1
  uint8  flags    bits 0-1 colour class 0-3, bit 2 parallax present, bits 3-7 zero

Round to nearest. Worst-case error is half a code:
  |dRA * cos(Dec)| <= 360 * 3600 / 2^25 = 0.0386238… arcsec (0.0386″ to 4 d.p.)
  |dDec|          <= 180 * 3600 / (2 * (2^24 - 1)) = 0.0193119… arcsec (0.0193″)
  |dmag|          <= 0.05

Dec uses 2^24 - 1 so ±90° land on a code. RA uses 2^24 because 0° and 360° are the same direction.
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


def angular_errors(ra_deg, dec_deg, ra_out, dec_out):
    """|dRA cos Dec| and |dDec| in arcseconds. cos(Dec) uses the source Dec."""
    dra = (ra_out - ra_deg + 180.0) % 360.0 - 180.0
    cos_dec = np.cos(np.deg2rad(dec_deg))
    return np.abs(dra * 3600.0 * cos_dec), np.abs(dec_out - dec_deg) * 3600.0
