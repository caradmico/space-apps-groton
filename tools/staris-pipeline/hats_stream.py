"""Stream Gaia HATS catalogue in two network passes without ever writing the full 65 GB raw cache to disk.

Pass 1 (scan): reads partitions, separates stragglers per order-2 unit into spill files,
keeps top HEAP_M candidates per order-6 cell in per-base cand/*.npz files.
Pass 2 (iter_units): re-fetches only the home partitions for each order-2 unit in order,
merges with stragglers, writes one .hatsx shard per unit, feeds to pyramid.run_stream.
Peak disk usage is roughly one order-2 unit of raw rows plus small straggler/candidate files.
"""

import numpy as np
import json
import os
import shutil
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
import io

import hats
import pyramid
import tap

STRAGGLER_MAX = 4096
CHECKPOINT_EVERY = 64
MERGE_ROWS = 2_000_000


def topk_per_cell(local, mag, sid, k):
    if len(local) == 0:
        return (
            local.astype(np.int64, copy=False),
            mag.astype(np.float32, copy=False),
            sid.astype(np.int64, copy=False),
        )
    o = np.lexsort((mag, sid))
    local = local[o]
    mag = mag[o]
    sid = sid[o]

    keep_mask = np.concatenate(([True], np.diff(sid) != 0))
    local = local[keep_mask]
    mag = mag[keep_mask]
    sid = sid[keep_mask]

    order = np.lexsort((sid, mag, local))
    local = local[order]
    mag = mag[order]
    sid = sid[order]

    diff = np.diff(local, prepend=local[0] - 1)
    starts = np.flatnonzero(diff)
    group_sizes = np.diff(np.concatenate((starts, [len(local)])))
    ranks = np.arange(len(local)) - np.repeat(starts, group_sizes)
    keep = ranks < k

    return (
        local[keep].astype(np.int64),
        mag[keep].astype(np.float32),
        sid[keep].astype(np.int64),
    )


def _scan_state_path(work_dir):
    return os.path.join(work_dir, "scan.json")


def _ensure_dir(path):
    os.makedirs(path, exist_ok=True)


def scan(
    work_dir,
    partitions,
    base=hats.HATS_BASE,
    workers=4,
    range_workers=8,
    guard=None,
    progress=print,
    straggler_max=STRAGGLER_MAX,
):
    keys = [f"{o}/{p}" for o, p in partitions]
    state_path = _scan_state_path(work_dir)
    strag_dir = os.path.join(work_dir, "strag")
    cand_dir = os.path.join(work_dir, "cand")

    if os.path.exists(state_path):
        with open(state_path) as f:
            sc = json.load(f)
        if sc.get("version") == 1 and sc.get("base") == base and sc.get("partitions") == keys:
            if sc.get("finished", False):
                return sc
            _ensure_dir(strag_dir)
            for name, size in sc.get("strag_sizes", {}).items():
                p = os.path.join(strag_dir, name)
                if os.path.exists(p):
                    with open(p, "r+b") as f:
                        f.truncate(size)
            for fn in os.listdir(strag_dir):
                if fn.endswith(".spill") and fn not in sc.get("strag_sizes", {}):
                    os.unlink(os.path.join(strag_dir, fn))
            for fn in os.listdir(cand_dir) if os.path.exists(cand_dir) else ():
                if fn.endswith(".spill"):
                    os.unlink(os.path.join(cand_dir, fn))
        else:
            if os.path.exists(strag_dir):
                shutil.rmtree(strag_dir)
            if os.path.exists(cand_dir):
                shutil.rmtree(cand_dir)
            sc = None
    else:
        if os.path.exists(strag_dir):
            shutil.rmtree(strag_dir)
        if os.path.exists(cand_dir):
            shutil.rmtree(cand_dir)
        sc = None

    if sc is None:
        _ensure_dir(strag_dir)
        _ensure_dir(cand_dir)
        sc = {
            "version": 1,
            "base": base,
            "partitions": keys,
            "done": [],
            "plan": {},
            "strag_sizes": {},
            "finished": False,
        }

    done_set = set(sc["done"])
    todo = [k for k in keys if k not in done_set]
    pending = {}  # base -> (local_list, mag_list, sid_list)

    def job(key):
        o, p = map(int, key.split("/"))
        url = hats.partition_url(o, p, base)
        arr, stats = hats.read_partition(url, workers=range_workers)
        arr, dups = hats.clean(arr)
        return key, arr, stats, dups

    with ThreadPoolExecutor(max_workers=workers) as pool:
        future_to_key = {pool.submit(job, key): key for key in todo}
        for i, fut in enumerate(as_completed(future_to_key), 1):
            key, arr, stats, dups = fut.result()
            n = len(arr)
            sid = arr["source_id"].astype(np.int64)
            unit = sid >> 55
            uniq, counts = np.unique(unit, return_counts=True)
            if np.any(counts > straggler_max):
                home = [int(x) for x in uniq[counts > straggler_max]]
            else:
                home = [int(uniq[np.argmax(counts)])]
            home_set = set(home)
            first_home = min(home)

            plan_entry = {
                "units": dict(zip(uniq.astype(str).tolist(), counts.tolist())),
                "home": home,
                "rows": int(n),
                "dups": int(dups),
                "bytes": int(stats["bytes"]),
                "seconds": float(stats["seconds"]),
                "plx_kept": int(np.isfinite(arr["parallax"]).sum()),
            }
            sc["plan"][key] = plan_entry
            sc["done"].append(key)

            # stragglers
            mask_strag = np.isin(unit, home, invert=True)
            if np.any(mask_strag):
                strag_arr = arr[mask_strag]
                s_unit = unit[mask_strag]
                for u in np.unique(s_unit):
                    m = s_unit == u
                    fname = f"o2_{u:03d}.spill"
                    path = os.path.join(strag_dir, fname)
                    with open(path, "ab") as f:
                        strag_arr[m].tofile(f)
                    sc["strag_sizes"][fname] = os.path.getsize(path)

            # candidates
            finite = np.isfinite(arr["ra"]) & np.isfinite(arr["dec"]) & np.isfinite(arr["mag"])
            if np.any(finite):
                c_arr = arr[finite]
                c_sid = sid[finite]
                base_cell = c_sid >> 59
                local = ((c_sid >> 47) - base_cell * 4096).astype(np.int16)
                mag_f32 = c_arr["mag"].astype(np.float32)
                sid64 = c_sid.astype(np.int64)

                for b in np.unique(base_cell):
                    m = base_cell == b
                    l2, m2, s2 = topk_per_cell(local[m], mag_f32[m], sid64[m], pyramid.HEAP_M)
                    if b not in pending:
                        pending[b] = ([], [], [])
                    pending[b][0].append(l2)
                    pending[b][1].append(m2)
                    pending[b][2].append(s2)

                    rows_pending = sum(len(x) for x in pending[b][0])
                    if rows_pending > MERGE_ROWS:
                        _merge_pending(b, pending[b], cand_dir, pyramid.HEAP_M)
                        pending[b] = ([], [], [])

            progress(f"scan {key}: rows={n} dups={dups} stragglers={int(mask_strag.sum())} {stats['seconds']:.1f}s done={i}/{len(partitions)}")

            if i % CHECKPOINT_EVERY == 0:
                for b in list(pending.keys()):
                    if pending[b][0]:
                        _merge_pending(b, pending[b], cand_dir, pyramid.HEAP_M)
                        pending[b] = ([], [], [])
                _write_scan_state(state_path, sc)
                if guard:
                    guard()

    for b in list(pending.keys()):
        if pending[b][0]:
            _merge_pending(b, pending[b], cand_dir, pyramid.HEAP_M)
            pending[b] = ([], [], [])
    sc["finished"] = True
    _write_scan_state(state_path, sc)
    return sc


def _merge_pending(b, pending, cand_dir, k):
    locals_l = pending[0]
    mags_l = pending[1]
    sids_l = pending[2]
    if not locals_l:
        return
    local_all = np.concatenate(locals_l)
    mag_all = np.concatenate(mags_l)
    sid_all = np.concatenate(sids_l)

    cand_path = os.path.join(cand_dir, f"b{b:02d}.npz")
    if os.path.exists(cand_path):
        with np.load(cand_path) as data:
            local_all = np.concatenate((local_all, data["local"]))
            mag_all = np.concatenate((mag_all, data["mag"]))
            sid_all = np.concatenate((sid_all, data["sid"]))

    local_t, mag_t, sid_t = topk_per_cell(local_all, mag_all, sid_all, k)

    tmp_path = cand_path + ".tmp"
    with open(tmp_path, "wb") as f:
        np.savez(f, local=local_t.astype(np.int16), mag=mag_t.astype(np.float32), sid=sid_t.astype(np.int64))
    os.replace(tmp_path, cand_path)


def _write_scan_state(path, sc):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(sc, f, indent=2)
    os.replace(tmp, path)


def thresholds(work_dir):
    state = pyramid._new_state()
    cand_dir = os.path.join(work_dir, "cand")
    heap_m = pyramid.HEAP_M
    for i in range(12):
        path = os.path.join(cand_dir, f"b{i:02d}.npz")
        if not os.path.exists(path):
            continue
        with np.load(path) as data:
            local = data["local"]
            mag = data["mag"]
            sid = data["sid"]
        mag_h = np.full((4096, heap_m), np.inf, dtype=np.float32)
        sid_h = np.zeros((4096, heap_m), dtype=np.int64)
        n_h = np.zeros(4096, dtype=np.int32)
        o = np.argsort(local, kind="stable")
        locs, starts, counts = np.unique(local[o], return_index=True, return_counts=True)
        for loc, start, count in zip(locs, starts, counts):
            sl = o[start : start + count]
            n_h[loc] = count
            mag_h[loc, :count] = mag[sl]
            sid_h[loc, :count] = sid[sl]
        pyramid.close_base_cell(i, mag_h, sid_h, n_h, state)
    return state


def iter_units(
    work_dir,
    cache_dir,
    scan_state,
    base=hats.HATS_BASE,
    workers=4,
    range_workers=8,
    guard=None,
    progress=print,
    keep_files=False,
    stats=None,
):
    if stats is None:
        stats = {}
    stats.setdefault("rows_out", 0)
    stats.setdefault("dups_global", 0)
    stats.setdefault("files", [])

    spill_dir = os.path.join(work_dir, "spill")
    strag_dir = os.path.join(work_dir, "strag")
    if os.path.exists(spill_dir):
        shutil.rmtree(spill_dir)
    _ensure_dir(spill_dir)
    _ensure_dir(cache_dir)

    plan = scan_state["plan"]
    all_units = set()
    for entry in plan.values():
        all_units.update(int(u) for u in entry["units"])
    units = sorted(all_units)

    first_home_map = {}
    for key, entry in plan.items():
        first_home_map[key] = min(entry["home"])

    fetched = set()

    def job(key):
        o, p = map(int, key.split("/"))
        url = hats.partition_url(o, p, base)
        arr, _ = hats.read_partition(url, workers=range_workers)
        arr, dups = hats.clean(arr)
        return key, arr, dups

    for u in units:
        need = [k for k, v in first_home_map.items() if v == u and k not in fetched]
        if need:
            with ThreadPoolExecutor(max_workers=workers) as pool:
                future_to_key = {pool.submit(job, key): key for key in need}
                for fut in as_completed(future_to_key):
                    key, arr, _ = fut.result()
                    unit_arr = arr["source_id"] >> 55
                    home_list = plan[key]["home"]
                    mask_home = np.isin(unit_arr, home_list)
                    if np.any(mask_home):
                        home_arr = arr[mask_home]
                        sub = home_arr["source_id"] >> 51
                        for s in np.unique(sub):
                            with open(os.path.join(spill_dir, f"o4_{int(s):04d}.spill"), "ab") as f:
                                home_arr[sub == s].tofile(f)
                    fetched.add(key)

        # finalize unit
        strag_path = os.path.join(strag_dir, f"o2_{u:03d}.spill")
        if os.path.exists(strag_path):
            strag_arr = np.fromfile(strag_path, dtype=tap.DR3X_DTYPE)
            strag_sub = strag_arr["source_id"] >> 51
        else:
            strag_arr = np.array([], dtype=tap.DR3X_DTYPE)
            strag_sub = np.array([], dtype=np.int64)

        tmp_path = os.path.join(cache_dir, f"GaiaSource_hats_o2_{u:03d}.hatsx.tmp")
        with open(tmp_path, "wb") as f:
            n = 0
            dups_u = 0
            for s in range(u * 16, u * 16 + 16):
                pieces = []
                spill_path = os.path.join(spill_dir, f"o4_{s:04d}.spill")
                if os.path.exists(spill_path):
                    pieces.append(np.fromfile(spill_path, dtype=tap.DR3X_DTYPE))
                    os.unlink(spill_path)
                if len(strag_arr) > 0:
                    mask = strag_sub == s
                    if np.any(mask):
                        pieces.append(strag_arr[mask])
                if pieces:
                    arr, d = hats.clean(np.concatenate(pieces))
                    f.write(arr.tobytes())
                    n += len(arr)
                    dups_u += d
        stats["dups_global"] += dups_u
        stats["rows_out"] += n
        if n == 0:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
            continue

        fname = f"GaiaSource_hats_o2_{u:03d}.hatsx"
        out_path = os.path.join(cache_dir, fname)
        os.replace(tmp_path, out_path)
        stats["files"].append(fname)

        if guard:
            guard()

        info = pyramid.probe_shard(out_path, pyramid.ADAPTERS["hats"], 36)
        progress(f"unit {u:03d}: rows={n} fetched={len(need)}")
        yield info
        if not keep_files:
            os.unlink(out_path)

    if len(fetched) != len(plan):
        raise RuntimeError(f"Not all partitions fetched: {len(fetched)}/{len(plan)}")


def run(
    out_dir,
    partitions=None,
    config=None,
    base=hats.HATS_BASE,
    workers=4,
    range_workers=8,
    guard=None,
    progress=print,
    keep_files=False,
):
    work_dir = os.path.join(out_dir, "hats_stream")
    cache_dir = os.path.join(out_dir, "hats_cache")
    _ensure_dir(work_dir)
    _ensure_dir(cache_dir)

    if partitions is None:
        partitions = hats.partition_list(base)

    sc = scan(
        work_dir,
        partitions,
        base=base,
        workers=workers,
        range_workers=range_workers,
        guard=guard,
        progress=progress,
    )
    progress("scan finished")

    state = thresholds(work_dir)
    run_stats = {"rows_out": 0, "dups_global": 0, "files": []}

    gen = iter_units(
        work_dir,
        cache_dir,
        sc,
        base=base,
        workers=workers,
        range_workers=range_workers,
        guard=guard,
        progress=progress,
        keep_files=keep_files,
        stats=run_stats,
    )

    pm = pyramid.run_stream(
        config,
        state,
        gen,
        progress=progress,
    )

    hm_path = os.path.join(work_dir, "hats.json")
    if run_stats["files"] == [] and os.path.exists(hm_path):
        with open(hm_path) as f:
            hm = json.load(f)
    else:
        hm = {
            "rows_in": sum(p["rows"] for p in sc["plan"].values()),
            "dups_within": sum(p["dups"] for p in sc["plan"].values()),
            "bytes_in": sum(p["bytes"] for p in sc["plan"].values()),
            "plx_kept": sum(p["plx_kept"] for p in sc["plan"].values()),
            "rows_out": run_stats["rows_out"],
            "dups_global": run_stats["dups_global"],
            "files": run_stats["files"],
            "partitions": len(sc["plan"]),
        }

        tmp = hm_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(hm, f, indent=2)
        os.replace(tmp, hm_path)

    if os.path.exists(os.path.join(work_dir, "strag")):
        shutil.rmtree(os.path.join(work_dir, "strag"))
    if os.path.exists(os.path.join(work_dir, "spill")):
        shutil.rmtree(os.path.join(work_dir, "spill"))

    return hm, pm
