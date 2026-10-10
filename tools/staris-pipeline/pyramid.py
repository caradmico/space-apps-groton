"""Gaia HEALPix LOD pyramid, pass 0-2.

Plain NumPy. One shard at a time. Order-k nested cell = source_id >> (59 - 2k).
A star's coarse order is the minimum k <= 6 whose (mag, source_id) is <= tau_k.
Deep stars (orders 7..12) are counted, and written only when write_deep is set.
"""

from __future__ import annotations

import json
import os
import struct
import sys

import numpy as np

CAP = 1024
HEAP_M = CAP * 7
COARSE_ORDERS = range(7)
DEEP_ORDERS = range(7, 13)
REC = 62
REC_DTYPE = np.dtype(
    [
        ("source_id", "<i8"),
        ("ra", "<f8"),
        ("dec", "<f8"),
        ("parallax", "<f8"),
        ("x", "<f8"),
        ("y", "<f8"),
        ("z", "<f8"),
        ("colour", "<u2"),
        ("mag", "<f4"),
    ]
)
PILOT_SHARDS = [
    "GaiaSource_000-000-000.bin",
    "GaiaSource_000-000-150.bin",
    "GaiaSource_000-001-044.bin",
    "GaiaSource_000-001-144.bin",
    "GaiaSource_000-002-088.bin",
    "GaiaSource_000-003-132.bin",
    "GaiaSource_000-004-126.bin",
    "GaiaSource_000-004-176.bin",
    "GaiaSource_000-005-220.bin",
    "GaiaSource_000-008-052.bin",
    "GaiaSource_000-010-140.bin",
    "GaiaSource_000-011-084.bin",
    "GaiaSource_000-011-184.bin",
    "GaiaSource_000-012-228.bin",
    "GaiaSource_000-014-016.bin",
    "GaiaSource_000-015-060.bin",
    "GaiaSource_000-017-048.bin",
    "GaiaSource_000-018-192.bin",
    "GaiaSource_000-019-136.bin",
    "GaiaSource_000-020-110.bin",
]


class RssExceeded(RuntimeError):
    def __init__(self, rss, cap, checkpoint):
        super().__init__(f"RSS {rss} exceeded cap {cap}; checkpoint {checkpoint}")
        self.rss = rss
        self.cap = cap
        self.checkpoint = checkpoint


def rss_bytes():
    """Current resident set, from /proc when Linux provides it."""
    try:
        with open("/proc/self/status", "r", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) * 1024
    except OSError:
        pass
    import resource

    # macOS reports bytes; Linux reports KiB. Colab is Linux and uses /proc above.
    raw = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    if sys.platform == "darwin":
        return int(raw)
    return int(raw) * 1024


def cell_of(source_id, order):
    return np.right_shift(np.asarray(source_id, dtype=np.int64), np.int64(59 - 2 * order))


def n_cells(order):
    return 12 * (4**order)


def load_q8():
    here = os.path.dirname(os.path.abspath(__file__))
    codec = os.path.abspath(os.path.join(here, "..", "..", "public", "bin-lod", "scripts"))
    if codec not in sys.path:
        sys.path.insert(0, codec)
    import q8

    return q8


def check_rss(cap, checkpoint):
    rss = rss_bytes()
    if rss > cap:
        raise RssExceeded(rss, cap, checkpoint)
    return rss


def iter_bin_records(path, chunk=65536):
    """Yield 62-byte Gaia DR1 records. Does not load the shard all at once."""
    with open(path, "rb") as handle:
        while True:
            blob = handle.read(chunk * REC)
            if not blob:
                break
            if len(blob) % REC != 0:
                raise ValueError(f"{path} length is not a multiple of 62")
            yield np.frombuffer(blob, dtype=REC_DTYPE).copy()


def iter_esa_csv(path, chunk=65536):
    """Stub adapter for ESA gaia_source csv.gz.

    Columns: source_id, ra, dec, parallax, phot_g_mean_mag.
    The 14 missing DR1 files are at
    https://cdn.gea.esac.esa.int/Gaia/gdr1/gaia_source/csv/
    This function only reads a path it is given. It does not download DR3.
    """
    import csv
    import gzip

    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt", newline="") as handle:
        reader = csv.DictReader(handle)
        need = ["source_id", "ra", "dec", "parallax", "phot_g_mean_mag"]
        missing = [name for name in need if reader.fieldnames is None or name not in reader.fieldnames]
        if missing:
            raise ValueError(f"{path} is missing columns {missing}")
        buf = []
        for row in reader:
            buf.append(row)
            if len(buf) >= chunk:
                yield _csv_chunk(buf)
                buf = []
        if buf:
            yield _csv_chunk(buf)


def _csv_chunk(rows):
    n = len(rows)
    out = np.zeros(n, dtype=REC_DTYPE)
    for i, row in enumerate(rows):
        out[i]["source_id"] = int(row["source_id"])
        out[i]["ra"] = float(row["ra"])
        out[i]["dec"] = float(row["dec"])
        plx = row.get("parallax") or ""
        out[i]["parallax"] = float(plx) if plx not in ("", "null", "nan") else np.nan
        out[i]["mag"] = float(row["phot_g_mean_mag"])
        out[i]["colour"] = 0
    return out


ADAPTERS = {
    "drive_bin_dr1": iter_bin_records,
    "esa_csv": iter_esa_csv,
}


def discover_shards(input_dirs, mode, pilot_names, shard_paths=None):
    if shard_paths:
        return list(shard_paths)
    found = {}
    for folder in input_dirs:
        for dirpath, _dirs, files in os.walk(folder):
            for name in files:
                if name.startswith("GaiaSource_") and name.endswith(".bin"):
                    found[name] = os.path.join(dirpath, name)
    if mode == "PILOT":
        missing = [name for name in pilot_names if name not in found]
        if missing:
            raise FileNotFoundError("pilot shards not in the StarIS Drive folders: " + ", ".join(missing))
        return [found[name] for name in pilot_names]
    if mode != "FULL":
        raise ValueError(f"unknown mode {mode}")
    return [found[name] for name in sorted(found)]


def probe_shard(path, adapter):
    size = os.path.getsize(path)
    first = last = None
    n = 0
    bases = set()
    prev = None
    for chunk in adapter(path):
        sids = chunk["source_id"]
        if sids.size == 0:
            continue
        if prev is not None and int(sids[0]) < prev:
            raise ValueError(f"{path} is not sorted by source_id")
        if np.any(sids[1:] < sids[:-1]):
            raise ValueError(f"{path} is not sorted by source_id")
        prev = int(sids[-1])
        if first is None:
            first = int(sids[0])
        last = int(sids[-1])
        n += int(sids.size)
        bases.update(int(v) for v in np.unique(cell_of(sids, 0)))
    return {
        "name": os.path.basename(path),
        "path": path,
        "size": size,
        "size_mod_62": size % 62,
        "n": n,
        "first_id": first,
        "last_id": last,
        "first_base": None if first is None else int(cell_of(first, 0)),
        "last_base": None if last is None else int(cell_of(last, 0)),
        "bases": sorted(bases),
    }


def _heap_insert(mag_h, sid_h, n_h, local, mag, sid):
    count = int(n_h[local])
    if count < HEAP_M:
        mag_h[local, count] = mag
        sid_h[local, count] = sid
        n_h[local] = count + 1
        _sift_up(mag_h, sid_h, local, count)
        return
    if mag > mag_h[local, 0] or (mag == mag_h[local, 0] and sid >= sid_h[local, 0]):
        return
    mag_h[local, 0] = mag
    sid_h[local, 0] = sid
    _sift_down(mag_h, sid_h, n_h, local, 0)


def _worse(mag_a, sid_a, mag_b, sid_b):
    return mag_a > mag_b or (mag_a == mag_b and sid_a > sid_b)


def _sift_up(mag_h, sid_h, local, index):
    while index > 0:
        parent = (index - 1) // 2
        if not _worse(mag_h[local, index], sid_h[local, index], mag_h[local, parent], sid_h[local, parent]):
            break
        mag_h[local, index], mag_h[local, parent] = mag_h[local, parent], mag_h[local, index]
        sid_h[local, index], sid_h[local, parent] = sid_h[local, parent], sid_h[local, index]
        index = parent


def _sift_down(mag_h, sid_h, n_h, local, index):
    count = int(n_h[local])
    while True:
        left = index * 2 + 1
        right = left + 1
        worst = index
        if left < count and _worse(mag_h[local, left], sid_h[local, left], mag_h[local, worst], sid_h[local, worst]):
            worst = left
        if right < count and _worse(mag_h[local, right], sid_h[local, right], mag_h[local, worst], sid_h[local, worst]):
            worst = right
        if worst == index:
            return
        mag_h[local, index], mag_h[local, worst] = mag_h[local, worst], mag_h[local, index]
        sid_h[local, index], sid_h[local, worst] = sid_h[local, worst], sid_h[local, index]
        index = worst


def _new_state():
    tau_mag = [np.full(n_cells(k), np.inf, np.float64) for k in COARSE_ORDERS]
    tau_sid = [np.full(n_cells(k), -1, np.int64) for k in COARSE_ORDERS]
    tau_on = [np.zeros(n_cells(k), np.bool_) for k in COARSE_ORDERS]
    counts = [np.zeros(n_cells(k), np.int64) for k in COARSE_ORDERS]
    hsum = np.zeros(n_cells(6), np.uint64)
    hxor = np.zeros(n_cells(6), np.uint64)
    hcount = np.zeros(n_cells(6), np.int64)
    return {
        "tau_mag": tau_mag,
        "tau_sid": tau_sid,
        "tau_on": tau_on,
        "counts": counts,
        "hash_sum": hsum,
        "hash_xor": hxor,
        "hash_count": hcount,
        "closed_bases": [],
    }


def _save_state(path, state):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    np.savez(
        path,
        **{f"tau_mag_{k}": state["tau_mag"][k] for k in COARSE_ORDERS},
        **{f"tau_sid_{k}": state["tau_sid"][k] for k in COARSE_ORDERS},
        **{f"tau_on_{k}": state["tau_on"][k] for k in COARSE_ORDERS},
        **{f"counts_{k}": state["counts"][k] for k in COARSE_ORDERS},
        hash_sum=state["hash_sum"],
        hash_xor=state["hash_xor"],
        hash_count=state["hash_count"],
        closed_bases=np.asarray(state["closed_bases"], dtype=np.int32),
    )


def _load_state(path):
    state = _new_state()
    if not os.path.exists(path):
        return state
    with np.load(path) as blob:
        for k in COARSE_ORDERS:
            state["tau_mag"][k] = blob[f"tau_mag_{k}"]
            state["tau_sid"][k] = blob[f"tau_sid_{k}"]
            state["tau_on"][k] = blob[f"tau_on_{k}"]
            state["counts"][k] = blob[f"counts_{k}"]
        state["hash_sum"] = blob["hash_sum"]
        state["hash_xor"] = blob["hash_xor"]
        state["hash_count"] = blob["hash_count"]
        state["closed_bases"] = [int(v) for v in blob["closed_bases"]]
    return state


def close_base_cell(base, mag_h, sid_h, n_h, state):
    present = np.flatnonzero(n_h > 0)
    if present.size == 0:
        state["closed_bases"].append(int(base))
        return
    o6s = np.concatenate([np.full(int(n_h[i]), i, np.int32) for i in present])
    mags = np.concatenate([mag_h[i, : int(n_h[i])].astype(np.float64) for i in present])
    sids = np.concatenate([sid_h[i, : int(n_h[i])] for i in present])
    used = np.zeros(o6s.shape[0], np.bool_)
    for order in COARSE_ORDERS:
        n_local = 4**order
        parent = o6s >> (2 * (6 - order))
        for local in range(n_local):
            sel = np.flatnonzero((parent == local) & ~used)
            if sel.size == 0:
                continue
            order_idx = np.lexsort((sids[sel], mags[sel]))
            take = min(CAP, int(order_idx.size))
            pick = sel[order_idx[:take]]
            used[pick] = True
            last = pick[-1]
            gcell = base * n_local + local
            state["tau_mag"][order][gcell] = mags[last]
            state["tau_sid"][order][gcell] = sids[last]
            state["tau_on"][order][gcell] = True
            state["counts"][order][gcell] = take
            o6_global = base * 4096 + o6s[pick]
            picked_sids = sids[pick].astype(np.uint64)
            with np.errstate(over="ignore"):
                np.add.at(state["hash_sum"], o6_global, picked_sids)
            np.bitwise_xor.at(state["hash_xor"], o6_global, picked_sids)
            np.add.at(state["hash_count"], o6_global, 1)
    state["closed_bases"].append(int(base))


def _open_heaps():
    return (
        np.full((4096, HEAP_M), np.inf, np.float32),
        np.zeros((4096, HEAP_M), np.int64),
        np.zeros(4096, np.int32),
    )


def key_leq(mag, sid, tau_mag, tau_sid):
    return mag < tau_mag or (mag == tau_mag and sid <= tau_sid)


def assign_coarse(sid, mag, state):
    """Return order 0..6, or None if the star is deep."""
    sid_i = int(sid)
    mag_f = float(np.float32(mag))
    for order in COARSE_ORDERS:
        cell = int(cell_of(sid_i, order))
        if not state["tau_on"][order][cell]:
            continue
        if key_leq(mag_f, sid_i, float(state["tau_mag"][order][cell]), int(state["tau_sid"][order][cell])):
            return order
    return None


def _reservoir(sample, order, record, limit, rng):
    bucket = sample[order]
    bucket["seen"] += 1
    if len(bucket["rows"]) < limit:
        bucket["rows"].append(record)
        return
    draw = int(rng.integers(0, bucket["seen"]))
    if draw < limit:
        bucket["rows"][draw] = record


def split_deep(chunk, write_deep, q8):
    """Exclusive orders 7..12 inside one order-6 cell. Returns counts and optional records."""
    counts = {order: {} for order in DEEP_ORDERS}
    written = {order: {} for order in DEEP_ORDERS}
    if chunk["source_id"].size == 0:
        return counts, written
    remaining = np.ones(chunk["source_id"].size, np.bool_)
    sids = chunk["source_id"]
    mags = chunk["mag"].astype(np.float64)
    for order in DEEP_ORDERS:
        cells = cell_of(sids, order)
        active = np.flatnonzero(remaining)
        if active.size == 0:
            break
        order_idx = np.lexsort((sids[active], mags[active], cells[active]))
        ordered = active[order_idx]
        cell_vals = cells[ordered]
        # walk groups, take the brightest CAP that are still remaining (all are)
        start = 0
        while start < ordered.size:
            cell = int(cell_vals[start])
            end = start + 1
            while end < ordered.size and int(cell_vals[end]) == cell:
                end += 1
            group = ordered[start:end]
            take = group[: min(CAP, group.size)]
            remaining[take] = False
            counts[order][cell] = int(take.size)
            if write_deep:
                written[order][cell] = take
            start = end
    return counts, written


def _encode_rows(chunk, indexes, q8):
    ra = chunk["ra"][indexes]
    dec = chunk["dec"][indexes]
    mag = chunk["mag"][indexes].astype(np.float64)
    colour = chunk["colour"][indexes]
    plx = np.isfinite(chunk["parallax"][indexes]) & (chunk["parallax"][indexes] > 0)
    # brightest first: indexes arrive already sorted by mag, sid
    return q8.encode_q8(ra, dec, mag, colour, plx)


def _pack_key(order, cell):
    if order <= 4:
        return 0, 255, int(cell)
    if order == 5:
        return int(cell >> 10), 0, int(cell & 1023)
    if order == 6:
        return int(cell >> 10), 1, int(cell & 1023)
    parent_order = order - 5
    parent = int(cell >> 10)
    return parent, parent_order, int(cell & 1023)


def write_pack(path, order, parent_order, cells):
    """cells: list of (local, records uint8 (n, 8)) sorted by local cell."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    cells = sorted(cells, key=lambda item: item[0])
    n_cells = len(cells)
    blob = b"".join(rec.tobytes() for _local, rec in cells)
    header = bytearray()
    header += b"Q8PK"
    header += struct.pack("<BBH I", order & 0xFF, parent_order & 0xFF, 0, n_cells)
    start = 0
    for local, rec in cells:
        count = int(rec.shape[0])
        header += struct.pack("<III", int(local), start, count)
        start += count
    with open(tmp, "wb") as handle:
        handle.write(header)
        handle.write(blob)
    os.replace(tmp, path)
    return start, os.path.getsize(path)


def read_pack(path):
    with open(path, "rb") as handle:
        magic = handle.read(4)
        if magic != b"Q8PK":
            raise ValueError(f"{path} magic {magic!r}")
        order, parent, _reserved, n_cells = struct.unpack("<BBHI", handle.read(8))
        table = []
        for _ in range(n_cells):
            local, start, count = struct.unpack("<III", handle.read(12))
            table.append((local, start, count))
        payload = np.frombuffer(handle.read(), dtype=np.uint8).copy()
    return {"order": order, "parent_order": parent, "cells": table, "payload": payload}


def manifest_path(output_dir):
    return os.path.join(output_dir, "manifest.json")


def load_manifest(output_dir):
    path = manifest_path(output_dir)
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def save_manifest(output_dir, manifest):
    os.makedirs(output_dir, exist_ok=True)
    path = manifest_path(output_dir)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
    os.replace(tmp, path)


def run_pipeline(config, progress=print):
    """Run probe, thresholds, write, and verify. Resume from manifest.json."""
    output_dir = config["output_dir"]
    cap = int(config.get("rss_cap", 2 * 1024**3))
    adapter_name = config.get("adapter", "drive_bin_dr1")
    adapter = ADAPTERS[adapter_name]
    mode = config.get("mode", "PILOT")
    write_deep = bool(config.get("write_deep", False))
    os.makedirs(output_dir, exist_ok=True)
    manifest = load_manifest(output_dir) or {
        "version": 1,
        "adapter": adapter_name,
        "mode": mode,
        "write_deep": write_deep,
        "cap": CAP,
        "pass": "probe",
        "shards": [],
        "aborted": None,
    }
    paths = discover_shards(
        config.get("input_dirs") or [],
        mode,
        config.get("pilot_shards") or PILOT_SHARDS,
        config.get("shard_paths"),
    )
    if not paths:
        raise FileNotFoundError("no shards")

    q8 = load_q8()
    try:
        return _run_passes(config, manifest, paths, adapter, output_dir, cap, progress, q8)
    except RssExceeded as exc:
        manifest["aborted"] = "rss"
        manifest["rss"] = exc.rss
        manifest["checkpoint"] = exc.checkpoint
        save_manifest(output_dir, manifest)
        raise


def _run_passes(config, manifest, paths, adapter, output_dir, cap, progress, q8):
    if manifest["pass"] == "probe" or not manifest["shards"]:
        shards = []
        prev_last = None
        for path in paths:
            info = probe_shard(path, adapter)
            if info["size_mod_62"] != 0:
                raise ValueError(f"{info['name']} size {info['size']} is not divisible by 62")
            if prev_last is not None and info["first_id"] is not None and info["first_id"] < prev_last:
                raise ValueError(f"{info['name']} starts before the previous shard ended")
            prev_last = info["last_id"]
            shards.append(info)
            manifest["shards"] = shards
            progress(f"probe {info['name']} n={info['n']} bytes={info['size']} mod62={info['size_mod_62']} ids={info['first_id']}..{info['last_id']} bases={info['bases']}")
            rss = check_rss(cap, manifest_path(output_dir))
            manifest["rss"] = rss
            save_manifest(output_dir, manifest)
        manifest["shards"] = shards
        manifest["pass"] = "thresholds"
        save_manifest(output_dir, manifest)
    else:
        shards = manifest["shards"]

    state_path = os.path.join(output_dir, "thresholds.npz")
    if manifest["pass"] == "thresholds":
        state = _load_state(state_path)
        closed = set(state["closed_bases"])
        mag_h = sid_h = n_h = None
        open_base = None
        for info in shards:
            if info["n"] == 0:
                continue
            if all(b in closed for b in info["bases"]):
                continue
            for chunk in adapter(info["path"]):
                sids = chunk["source_id"]
                mags = chunk["mag"].astype(np.float32)
                finite = np.isfinite(chunk["ra"]) & np.isfinite(chunk["dec"]) & np.isfinite(mags)
                for i in range(sids.shape[0]):
                    if not finite[i]:
                        continue
                    sid = int(sids[i])
                    base = int(cell_of(sid, 0))
                    if base in closed:
                        continue
                    if open_base is None:
                        open_base = base
                        mag_h, sid_h, n_h = _open_heaps()
                    elif base != open_base:
                        close_base_cell(open_base, mag_h, sid_h, n_h, state)
                        closed.add(open_base)
                        _save_state(state_path, state)
                        open_base = base
                        mag_h, sid_h, n_h = _open_heaps()
                    local = int(cell_of(sid, 6)) - base * 4096
                    _heap_insert(mag_h, sid_h, n_h, local, float(mags[i]), sid)
            rss = check_rss(cap, state_path)
            manifest["rss"] = rss
            manifest["closed_bases"] = sorted(closed)
            save_manifest(output_dir, manifest)
            progress(f"thresholds {info['name']} rss={rss} closed={len(closed)}")
        if open_base is not None and open_base not in closed:
            close_base_cell(open_base, mag_h, sid_h, n_h, state)
            closed.add(open_base)
            _save_state(state_path, state)
        manifest["pass"] = "write"
        manifest["closed_bases"] = sorted(closed)
        manifest["coarse_counts"] = {str(k): int(state["counts"][k].sum()) for k in COARSE_ORDERS}
        save_manifest(output_dir, manifest)
    else:
        state = _load_state(state_path)

    if manifest["pass"] == "write":
        _write_pass(config, adapter, shards, state, q8, manifest, cap, progress)
        manifest["pass"] = "verify"
        save_manifest(output_dir, manifest)

    if manifest["pass"] == "verify":
        report = verify(output_dir, state, q8)
        manifest["verify"] = report
        manifest["pass"] = "done"
        manifest["aborted"] = None
        save_manifest(output_dir, manifest)
        progress("verify " + json.dumps(report))
        return manifest
    return manifest


def _encode_block(block, q8):
    order_idx = np.lexsort((block["source_id"], block["mag"].astype(np.float64)))
    block = block[order_idx]
    encoded = q8.encode_q8(
        block["ra"],
        block["dec"],
        block["mag"].astype(np.float64),
        block["colour"],
        np.isfinite(block["parallax"]) & (block["parallax"] > 0),
    )
    return block, encoded


def _write_part(path, order, entries):
    """entries are (global_cell, encoded). Same cell may appear once."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "wb") as handle:
        handle.write(struct.pack("<II", order, len(entries)))
        for cell, encoded in entries:
            handle.write(struct.pack("<II", int(cell), int(encoded.shape[0])))
            handle.write(encoded.tobytes())
    os.replace(tmp, path)


def _read_parts(part_dir):
    grouped = {}
    if not os.path.isdir(part_dir):
        return grouped
    for name in sorted(os.listdir(part_dir)):
        if not name.endswith(".part"):
            continue
        with open(os.path.join(part_dir, name), "rb") as handle:
            order, n_cells = struct.unpack("<II", handle.read(8))
            for _ in range(n_cells):
                cell, count = struct.unpack("<II", handle.read(8))
                raw = np.frombuffer(handle.read(count * 8), dtype=np.uint8).copy().reshape(count, 8)
                pack_id, _parent, local = _pack_key(order, cell)
                grouped.setdefault((order, pack_id), {}).setdefault(local, []).append(raw)
    return grouped


def _write_pass(config, adapter, shards, state, q8, manifest, cap, progress):
    output_dir = config["output_dir"]
    write_deep = bool(config.get("write_deep", False))
    part_dir = os.path.join(output_dir, "parts")
    os.makedirs(part_dir, exist_ok=True)
    rng = np.random.default_rng(7)
    sample = {order: {"seen": 0, "rows": []} for order in list(COARSE_ORDERS) + list(DEEP_ORDERS)}
    pass2_counts = {order: 0 for order in list(COARSE_ORDERS) + list(DEEP_ORDERS)}
    hsum = np.zeros_like(state["hash_sum"])
    hxor = np.zeros_like(state["hash_xor"])
    hcount = np.zeros_like(state["hash_count"])
    deep_counts = {order: {} for order in DEEP_ORDERS}
    part_index = 0

    def remember(order, block, encoded):
        for i in range(min(block.shape[0], encoded.shape[0])):
            _reservoir(
                sample,
                order,
                {
                    "ra": float(block["ra"][i]),
                    "dec": float(block["dec"][i]),
                    "mag": float(block["mag"][i]),
                    "q8": encoded[i].tobytes().hex(),
                },
                10000,
                rng,
            )

    def flush_unit(unit, store):
        nonlocal part_index
        if unit is None or not store:
            store.clear()
            return
        by_order = {}
        for (order, cell), rows in store.items():
            block, encoded = _encode_block(np.concatenate(rows), q8)
            by_order.setdefault(order, []).append((cell, encoded))
            remember(order, block, encoded)
        for order, entries in by_order.items():
            _write_part(os.path.join(part_dir, f"u{unit}_o{order}_{part_index}.part"), order, entries)
            part_index += 1
        store.clear()

    store = {}
    deep_buf = []
    cur_o6 = None
    cur_unit = None

    def flush_deep():
        nonlocal part_index
        if not deep_buf:
            return
        chunk = np.concatenate(deep_buf)
        deep_buf.clear()
        counts, written = split_deep(chunk, write_deep, q8)
        for order, cells in counts.items():
            for cell, count in cells.items():
                deep_counts[order][cell] = deep_counts[order].get(cell, 0) + count
                pass2_counts[order] += count
        if write_deep:
            for order, cells in written.items():
                entries = []
                for cell, indexes in cells.items():
                    encoded = _encode_rows(chunk, indexes, q8)
                    remember(order, chunk[indexes], encoded)
                    entries.append((cell, encoded))
                if entries:
                    _write_part(os.path.join(part_dir, f"deep_o{order}_{part_index}.part"), order, entries)
                    part_index += 1

    for info in shards:
        for chunk in adapter(info["path"]):
            finite = np.isfinite(chunk["ra"]) & np.isfinite(chunk["dec"]) & np.isfinite(chunk["mag"])
            sids = chunk["source_id"]
            for i in range(sids.shape[0]):
                if not finite[i]:
                    continue
                sid = int(sids[i])
                mag = float(np.float32(chunk["mag"][i]))
                order = assign_coarse(sid, mag, state)
                o6 = int(cell_of(sid, 6))
                unit = int(cell_of(sid, 2))
                if cur_o6 is None:
                    cur_o6 = o6
                    cur_unit = unit
                if o6 != cur_o6:
                    flush_deep()
                    cur_o6 = o6
                if unit != cur_unit:
                    flush_unit(cur_unit, store)
                    cur_unit = unit
                row = chunk[i : i + 1]
                if order is None:
                    deep_buf.append(row.copy())
                    continue
                pass2_counts[order] += 1
                hsum[o6] = np.uint64((int(hsum[o6]) + sid) & 0xFFFFFFFFFFFFFFFF)
                hxor[o6] = np.bitwise_xor(np.uint64(hxor[o6]), np.uint64(sid))
                hcount[o6] += 1
                store.setdefault((order, int(cell_of(sid, order))), []).append(row.copy())
        rss = check_rss(cap, part_dir)
        manifest["rss"] = rss
        progress(f"write {info['name']} rss={rss}")
    flush_deep()
    flush_unit(cur_unit, store)

    grouped = _read_parts(part_dir)
    pack_dir = os.path.join(output_dir, "packs")
    os.makedirs(pack_dir, exist_ok=True)
    levels = []
    total_records = 0
    total_bytes = 0
    for (order, pack_id), locals_map in sorted(grouped.items()):
        merged = []
        for local, pieces in locals_map.items():
            encoded = np.concatenate(pieces, axis=0)
            # Q8 mag byte is the sort key; source order inside a mag uses the existing order.
            mags = encoded[:, 6]
            encoded = encoded[np.argsort(mags, kind="stable")]
            merged.append((local, encoded))
        if order <= 4:
            parent = 255
        elif order == 5:
            parent = 0
        elif order == 6:
            parent = 1
        else:
            parent = order - 5
        name = f"o{order}_p{pack_id}.pack"
        nrec, nbytes = write_pack(os.path.join(pack_dir, name), order, parent, merged)
        total_records += nrec
        total_bytes += nbytes
        levels.append(
            {
                "order": int(order),
                "host": "pages",
                "pack": name,
                "pack_parent_order": int(parent),
                "pack_id": int(pack_id),
                "n": int(nrec),
                "bytes": int(nbytes),
            }
        )
    sample_path = os.path.join(output_dir, "samples.json")
    serial = {str(order): rows["rows"] for order, rows in sample.items() if rows["rows"]}
    with open(sample_path, "w", encoding="utf-8") as handle:
        json.dump(serial, handle)
    np.savez(os.path.join(output_dir, "pass2_hashes.npz"), hash_sum=hsum, hash_xor=hxor, hash_count=hcount)
    manifest["pass2_counts"] = {str(k): int(v) for k, v in pass2_counts.items()}
    manifest["deep_counts"] = {str(order): int(sum(cells.values())) for order, cells in deep_counts.items()}
    manifest["levels"] = levels
    manifest["total_records"] = int(total_records)
    manifest["total_bytes"] = int(total_bytes)
    manifest["coarse_hashes_match"] = bool(
        np.array_equal(hsum, state["hash_sum"])
        and np.array_equal(hxor, state["hash_xor"])
        and np.array_equal(hcount, state["hash_count"])
    )
    save_manifest(output_dir, manifest)


def verify(output_dir, state, q8):
    manifest = load_manifest(output_dir)
    pack_records = 0
    header_n = 0
    for level in manifest.get("levels") or []:
        path = os.path.join(output_dir, "packs", level["pack"])
        pack = read_pack(path)
        n = sum(count for _local, _start, count in pack["cells"])
        if n != level["n"]:
            raise ValueError(f"{level['pack']} header n {n} != manifest {level['n']}")
        if pack["payload"].size != n * 8:
            raise ValueError(f"{level['pack']} payload bytes != n*8")
        pack_records += n
        header_n += n
    coarse = sum(int(manifest["coarse_counts"][str(k)]) for k in COARSE_ORDERS)
    written_coarse = sum(int(manifest["pass2_counts"][str(k)]) for k in COARSE_ORDERS)
    if not manifest.get("write_deep"):
        if pack_records != coarse or written_coarse != coarse or header_n != coarse:
            raise ValueError(
                f"counts disagree pass1={coarse} pass2={written_coarse} packs={pack_records} header={header_n}"
            )
    if not manifest.get("coarse_hashes_match"):
        raise ValueError("per-cell hashes do not match")
    with open(os.path.join(output_dir, "samples.json"), "r", encoding="utf-8") as handle:
        samples = json.load(handle)
    max_err = {"ra": 0.0, "dec": 0.0, "mag": 0.0}
    checked = 0
    for _order, rows in samples.items():
        if not rows:
            continue
        ra = np.array([row["ra"] for row in rows], np.float64)
        dec = np.array([row["dec"] for row in rows], np.float64)
        mag = np.array([row["mag"] for row in rows], np.float64)
        encoded = np.vstack([np.frombuffer(bytes.fromhex(row["q8"]), dtype=np.uint8) for row in rows])
        back_ra, back_dec, back_mag, _flags = q8.decode_q8(encoded)
        ra_err, dec_err = q8.angular_errors(ra, dec, back_ra, back_dec)
        mag_err = np.abs(back_mag - mag)
        max_err["ra"] = max(max_err["ra"], float(ra_err.max()))
        max_err["dec"] = max(max_err["dec"], float(dec_err.max()))
        max_err["mag"] = max(max_err["mag"], float(mag_err.max()))
        checked += int(ra.shape[0])
        if float(ra_err.max()) > q8.RA_ERR_ARCSEC + 1e-6 or float(dec_err.max()) > q8.DEC_ERR_ARCSEC + 1e-6:
            raise ValueError("decoded sample exceeds the Q8 angular limits")
        if float(mag_err.max()) > q8.MAG_ERR + 1e-9:
            raise ValueError("decoded sample exceeds the Q8 mag limit")
    return {
        "pass1_coarse": coarse,
        "pass2_coarse": written_coarse,
        "pack_records": pack_records,
        "bytes_over_62": pack_records,
        "hashes_match": True,
        "samples": checked,
        "maxRaArcsec": max_err["ra"],
        "maxDecArcsec": max_err["dec"],
        "maxMag": max_err["mag"],
    }
