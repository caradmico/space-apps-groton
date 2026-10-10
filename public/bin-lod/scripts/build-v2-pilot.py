#!/usr/bin/env python3
"""Build the v2 pilot packs and the HYG binary from the 9 public tiles.

Does not rewrite tiles.json, preview.bin, catalog.bin, or any v1 tile.
Output: public/bin-lod/data/v2-pilot/
"""

from __future__ import annotations

import json
import os
import struct
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from q8 import encode_q8  # noqa: E402

REC = 62
CAP = 1024
HEAP_M = CAP * 7
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
TILES = os.path.join(ROOT, "data", "tiles")
OUT = os.path.join(ROOT, "data", "v2-pilot")
HYG_URL = "https://staris-b01f2.firebaseapp.com/data/stars.json"
HYG_MAG0 = -27.0
HYG_STEP = 0.2


def cell_of(source_id, order):
    return np.right_shift(np.asarray(source_id, dtype=np.int64), np.int64(59 - 2 * order))


def load_tiles():
    names = sorted(name for name in os.listdir(TILES) if name.startswith("tile-") and name.endswith(".bin"))
    chunks = []
    for name in names:
        raw = np.fromfile(os.path.join(TILES, name), dtype=np.uint8)
        n = raw.size // REC
        rec = raw[: n * REC].reshape(n, REC)
        sid = rec[:, 0:8].copy().view("<i8").reshape(n)
        ra = rec[:, 8:16].copy().view("<f8").reshape(n)
        dec = rec[:, 16:24].copy().view("<f8").reshape(n)
        plx = rec[:, 24:32].copy().view("<f8").reshape(n)
        colour = rec[:, 56:58].copy().view("<u2").reshape(n)
        mag = rec[:, 58:62].copy().view("<f4").reshape(n)
        ok = np.isfinite(ra) & np.isfinite(dec) & np.isfinite(mag)
        chunks.append((sid[ok], ra[ok], dec[ok], plx[ok], colour[ok], mag[ok].astype(np.float64)))
    return tuple(np.concatenate(part) for part in zip(*chunks))


def thresholds(sid, mag):
    o6 = cell_of(sid, 6)
    order = np.argsort(o6, kind="mergesort")
    o6 = o6[order]
    sid = sid[order]
    mag = mag[order]
    # brightest HEAP_M in each order-6 cell, grouped by base cell
    cuts = np.flatnonzero(np.diff(o6)) + 1
    starts = np.concatenate([[0], cuts])
    ends = np.concatenate([cuts, [o6.size]])
    cand_sid = []
    cand_mag = []
    cand_o6 = []
    for start, end in zip(starts, ends):
        group_sid = sid[start:end]
        group_mag = mag[start:end]
        if group_sid.size > HEAP_M:
            pick = np.lexsort((group_sid, group_mag))[:HEAP_M]
            group_sid = group_sid[pick]
            group_mag = group_mag[pick]
        cand_sid.append(group_sid)
        cand_mag.append(group_mag)
        cand_o6.append(np.full(group_sid.size, int(o6[start]), np.int64))
    cand_sid = np.concatenate(cand_sid)
    cand_mag = np.concatenate(cand_mag)
    cand_o6 = np.concatenate(cand_o6)
    tau_mag = [np.full(12 * 4**k, np.inf) for k in range(7)]
    tau_sid = [np.full(12 * 4**k, -1, np.int64) for k in range(7)]
    tau_on = [np.zeros(12 * 4**k, np.bool_) for k in range(7)]
    bases = np.unique(cell_of(cand_sid, 0))
    for base in bases:
        base = int(base)
        sel = cell_of(cand_sid, 0) == base
        local = cand_o6[sel] - base * 4096
        mags = cand_mag[sel]
        sids = cand_sid[sel]
        used = np.zeros(sids.size, np.bool_)
        for order_k in range(7):
            parent = local >> (2 * (6 - order_k))
            for loc in np.unique(parent):
                choose = np.flatnonzero((parent == loc) & ~used)
                if choose.size == 0:
                    continue
                rank = np.lexsort((sids[choose], mags[choose]))
                take = choose[rank[: min(CAP, rank.size)]]
                used[take] = True
                last = take[-1]
                gcell = base * (4**order_k) + int(loc)
                tau_mag[order_k][gcell] = mags[last]
                tau_sid[order_k][gcell] = sids[last]
                tau_on[order_k][gcell] = True
    return tau_mag, tau_sid, tau_on


def assign(sid, mag, tau_mag, tau_sid, tau_on):
    order = np.full(sid.shape[0], -1, np.int8)
    mag32 = mag.astype(np.float32).astype(np.float64)
    for k in range(7):
        cells = cell_of(sid, k)
        on = tau_on[k][cells]
        tm = tau_mag[k][cells]
        ts = tau_sid[k][cells]
        leq = (mag32 < tm) | ((mag32 == tm) & (sid <= ts))
        take = (order < 0) & on & leq
        order[take] = k
    return order


def pack_parts(order, cell):
    cell = int(cell)
    if order <= 4:
        return 0, 255, cell
    if order == 5:
        return cell >> 10, 0, cell & 1023
    return cell >> 10, 1, cell & 1023


def write_pack(path, order, parent, cells):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    cells = sorted(cells, key=lambda item: item[0])
    tmp = path + ".tmp"
    header = bytearray(b"Q8PK")
    header += struct.pack("<BBHI", order & 255, parent & 255, 0, len(cells))
    start = 0
    blobs = []
    for local, encoded in cells:
        header += struct.pack("<III", int(local), start, int(encoded.shape[0]))
        blobs.append(encoded.tobytes())
        start += int(encoded.shape[0])
    with open(tmp, "wb") as handle:
        handle.write(header)
        for blob in blobs:
            handle.write(blob)
    os.replace(tmp, path)
    return start, os.path.getsize(path)


def build_packs(sid, ra, dec, plx, colour, mag):
    tau_mag, tau_sid, tau_on = thresholds(sid, mag)
    assigned = assign(sid, mag, tau_mag, tau_sid, tau_on)
    buckets = {}
    for k in range(7):
        sel = np.flatnonzero(assigned == k)
        if sel.size == 0:
            continue
        cells = cell_of(sid[sel], k)
        uniq = np.unique(cells)
        for cell in uniq:
            rows = sel[cells == cell]
            rank = np.lexsort((sid[rows], mag[rows]))
            rows = rows[rank]
            encoded = encode_q8(
                ra[rows],
                dec[rows],
                mag[rows],
                colour[rows],
                np.isfinite(plx[rows]) & (plx[rows] > 0),
            )
            pack_id, parent, local = pack_parts(k, cell)
            buckets.setdefault((k, pack_id, parent), []).append((local, encoded))
    os.makedirs(OUT, exist_ok=True)
    levels = []
    total = 0
    for (order, pack_id, parent), cells in sorted(buckets.items()):
        name = f"o{order}_p{pack_id}.pack"
        nrec, nbytes = write_pack(os.path.join(OUT, name), order, parent, cells)
        total += nrec
        levels.append(
            {
                "order": int(order),
                "host": "pages",
                "pack": f"data/v2-pilot/{name}",
                "pack_parent_order": -1 if parent == 255 else int(parent),
                "pack_id": int(pack_id),
                "n": int(nrec),
                "bytes": int(nbytes),
            }
        )
    return levels, total, int(np.sum(assigned < 0))


def build_hyg(stars):
    n = len(stars)
    xyz = np.zeros((n, 3), np.float32)
    mag_q = np.zeros(n, np.uint8)
    names = []
    for i, star in enumerate(stars):
        xyz[i] = (star["x"], star["y"], star["z"])
        q = int(np.rint((float(star["mag"]) - HYG_MAG0) / HYG_STEP))
        mag_q[i] = max(0, min(255, q))
        proper = star.get("proper") or ""
        if proper:
            names.append((i, proper))
    blob = bytearray()
    blob += b"HYG1"
    blob += struct.pack("<I", n)
    blob += xyz.tobytes()
    blob += mag_q.tobytes()
    encoded = [name.encode("utf-8") for _i, name in names]
    blob += struct.pack("<I", len(names))
    offset = 0
    table = bytearray()
    name_blob = bytearray()
    for (index, _name), raw in zip(names, encoded):
        table += struct.pack("<HHH", index, offset, len(raw))
        name_blob += raw
        offset += len(raw)
    blob += table
    blob += name_blob
    path = os.path.join(OUT, "hyg-v1.bin")
    tmp = path + ".tmp"
    with open(tmp, "wb") as handle:
        handle.write(blob)
    os.replace(tmp, path)
    return path, len(blob), len(names)


def main():
    sid, ra, dec, plx, colour, mag = load_tiles()
    levels, total, deep = build_packs(sid, ra, dec, plx, colour, mag)
    hyg_path = os.path.join(os.path.dirname(__file__), "..", "..", "..", "tmp-stars.json")
    # The HYG catalog is fetched beside the script output by the caller, or read from /tmp.
    source = "/tmp/stars.json"
    if not os.path.exists(source):
        raise SystemExit("missing /tmp/stars.json (HYG catalog)")
    with open(source, "r", encoding="utf-8") as handle:
        stars = json.load(handle)
    _path, hyg_bytes, n_names = build_hyg(stars)
    manifest = {
        "version": 2,
        "scheme": "healpix_nested_exclusive",
        "cap": CAP,
        "record": {"format": "q8", "bytes": 8},
        "total_records": total,
        "hosts": {"pages": "", "r2": None},
        "levels": levels,
        "hyg": "data/v2-pilot/hyg-v1.bin",
        "legacy": "data/tiles.json",
        "deep_unwritten": deep,
        "hyg_bytes": hyg_bytes,
        "hyg_names": n_names,
    }
    path = os.path.join(OUT, "tiles.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
        handle.write("\n")
    os.replace(tmp, path)
    print(json.dumps({"records": total, "deep": deep, "levels": len(levels), "hygBytes": hyg_bytes, "names": n_names}))


if __name__ == "__main__":
    main()
