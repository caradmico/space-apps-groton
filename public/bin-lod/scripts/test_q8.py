#!/usr/bin/env python3
"""Round-trip the 9 public tiles through Q8 in slices of at most 1 MB.

Python encodes. Node decodes with q8.js. Each read is aligned to 62 bytes
and is never larger than 1_000_000 bytes.
"""

from __future__ import annotations

import json
import os
import struct
import subprocess
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from q8 import (  # noqa: E402
    DEC_ERR_ARCSEC,
    MAG_ERR,
    Q8_BYTES,
    RA_ERR_ARCSEC,
    angular_errors,
    decode_q8,
    encode_q8,
)

REC = 62
SLICE_MAX = 1_000_000
SLICE_BYTES = (SLICE_MAX // REC) * REC
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data", "tiles"))
# Spec figures, 4 decimal places. The enforced limits are the exact half-codes.
SPEC_RA = 0.0386
SPEC_DEC = 0.0193
SPEC_MAG = 0.05


def read_slice(path, which):
    size = os.path.getsize(path)
    if size % REC != 0:
        raise SystemExit(f"{path} is not a whole number of 62-byte records")
    span = min(SLICE_BYTES, size)
    if span > SLICE_MAX:
        raise SystemExit("slice exceeds 1 MB")
    if which == "start":
        offset = 0
    elif which == "end":
        offset = size - span
    else:
        offset = ((size // 2) // REC) * REC
        if offset + span > size:
            offset = size - span
    with open(path, "rb") as handle:
        handle.seek(offset)
        blob = handle.read(span)
    if len(blob) != span or len(blob) > SLICE_MAX:
        raise SystemExit(f"read {len(blob)} bytes from {path}")
    n = len(blob) // REC
    ra = np.empty(n, np.float64)
    dec = np.empty(n, np.float64)
    mag = np.empty(n, np.float64)
    colour = np.empty(n, np.int64)
    parallax = np.empty(n, np.bool_)
    finite = np.ones(n, np.bool_)
    for i in range(n):
        rec = blob[i * REC : (i + 1) * REC]
        sid, ra_i, dec_i, plx = struct.unpack_from("<qddd", rec, 0)
        col = struct.unpack_from("<H", rec, 56)[0]
        mag_i = struct.unpack_from("<f", rec, 58)[0]
        del sid
        ra[i] = ra_i
        dec[i] = dec_i
        mag[i] = mag_i
        colour[i] = col & 3
        parallax[i] = math_isfinite(plx) and plx > 0
        if not (math_isfinite(ra_i) and math_isfinite(dec_i) and math_isfinite(mag_i)):
            finite[i] = False
    return offset, span, ra[finite], dec[finite], mag[finite], colour[finite], parallax[finite]


def math_isfinite(value):
    return value == value and abs(value) != float("inf")


def main():
    names = sorted(n for n in os.listdir(ROOT) if n.startswith("tile-") and n.endswith(".bin"))
    if len(names) != 9:
        raise SystemExit(f"expected 9 tiles, found {names}")
    where = ["start", "middle", "end", "middle", "start", "end", "middle", "start", "end"]
    max_ra = 0.0
    max_dec = 0.0
    max_mag = 0.0
    total = 0
    chunks = []
    for name, place in zip(names, where):
        offset, span, ra, dec, mag, colour, parallax = read_slice(os.path.join(ROOT, name), place)
        encoded = encode_q8(ra, dec, mag, colour, parallax)
        if encoded.nbytes != ra.shape[0] * Q8_BYTES:
            raise SystemExit("encoder wrote the wrong number of bytes")
        back_ra, back_dec, back_mag, flags = decode_q8(encoded)
        ra_err, dec_err = angular_errors(ra, dec, back_ra, back_dec)
        mag_err = np.abs(back_mag - mag)
        max_ra = max(max_ra, float(ra_err.max()))
        max_dec = max(max_dec, float(dec_err.max()))
        max_mag = max(max_mag, float(mag_err.max()))
        if ((flags & 3) != colour).any() or (((flags & 4) != 0) != parallax).any():
            raise SystemExit(f"flag mismatch in {name}")
        total += int(ra.shape[0])
        chunks.append((encoded, ra, dec, mag, colour, parallax, name, offset, span))
        print(f"{name} offset={offset} bytes={span} n={ra.shape[0]} ra={ra_err.max():.6f} dec={dec_err.max():.6f} mag={mag_err.max():.4f}")

    if max_ra > RA_ERR_ARCSEC + 1e-6 or max_dec > DEC_ERR_ARCSEC + 1e-6 or max_mag > MAG_ERR + 1e-9:
        raise SystemExit(f"python round trip exceeded half-code limits {max_ra} {max_dec} {max_mag}")
    if round(RA_ERR_ARCSEC, 4) != SPEC_RA or round(DEC_ERR_ARCSEC, 4) != SPEC_DEC or MAG_ERR != SPEC_MAG:
        raise SystemExit("half-code limits no longer match the spec figures")

    encoded = np.concatenate([c[0] for c in chunks], axis=0)
    side = {
        "n": int(encoded.shape[0]),
        "ra": np.concatenate([c[1] for c in chunks]).tolist(),
        "dec": np.concatenate([c[2] for c in chunks]).tolist(),
        "mag": np.concatenate([c[3] for c in chunks]).tolist(),
        "colour": np.concatenate([c[4] for c in chunks]).astype(int).tolist(),
        "parallax": np.concatenate([c[5] for c in chunks]).astype(bool).tolist(),
        "raLimit": RA_ERR_ARCSEC + 1e-6,
        "decLimit": DEC_ERR_ARCSEC + 1e-6,
        "magLimit": MAG_ERR + 1e-9,
    }
    out_dir = "/tmp/q8-roundtrip"
    os.makedirs(out_dir, exist_ok=True)
    bin_path = os.path.join(out_dir, "stars.q8")
    side_path = os.path.join(out_dir, "side.json")
    encoded.tofile(bin_path)
    with open(side_path, "w", encoding="utf-8") as handle:
        json.dump(side, handle)
    script = os.path.join(os.path.dirname(__file__), "test-q8-decode.mjs")
    proc = subprocess.run(
        ["node", script, bin_path, side_path],
        check=False,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        raise SystemExit(f"js decoder failed ({proc.returncode})")
    print(proc.stdout.strip())
    print(
        json.dumps(
            {
                "tiles": len(names),
                "records": total,
                "sliceBytesMax": SLICE_BYTES,
                "maxRaArcsec": max_ra,
                "maxDecArcsec": max_dec,
                "maxMag": max_mag,
                "raLimit": RA_ERR_ARCSEC,
                "decLimit": DEC_ERR_ARCSEC,
                "specRa": SPEC_RA,
                "specDec": SPEC_DEC,
                "specMag": SPEC_MAG,
            }
        )
    )


if __name__ == "__main__":
    main()
