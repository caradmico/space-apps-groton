"""Stream Gaia HATS catalogue in two network passes without ever writing the full 65 GB raw cache to disk.

Bounded in-flight downloads, per-(base, order-3) candidate files, order-6 spills,
pass 2 resumes per partition/sub-cell/unit. Peak RAM bounded independent of
partition count and order-2 cell size. A RAM-guard stop always makes progress
on rerun.
"""

import numpy as np
import json
import os
import shutil
import warnings
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
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


def _bounded_fetch(keys, job, workers):
    """Generator yielding results while keeping at most `workers` futures in flight.
    Caller must `del` each yielded array before pulling the next. On close/raise
    the pool is shut down and pending futures cancelled.
    """
    if not keys:
        return
    pool = ThreadPoolExecutor(max_workers=workers)
    future_to_key = {}
    remaining = iter(keys)
    try:
        # Initial fill
        for k in remaining:
            future_to_key[pool.submit(job, k)] = k
            if len(future_to_key) >= workers:
                break

        while future_to_key:
            done_set, _ = wait(future_to_key, return_when=FIRST_COMPLETED)
            fut = next(iter(done_set))
            key = future_to_key.pop(fut)
            try:
                res = fut.result()
                fut = None
                done_set = None
                yield res
                del res
            finally:
                del fut

            # Refill to keep `workers` in flight
            while len(future_to_key) < workers:
                try:
                    k = next(remaining)
                    future_to_key[pool.submit(job, k)] = k
                except StopIteration:
                    break
    finally:
        for fut in list(future_to_key):
            fut.cancel()
        pool.shutdown(wait=True, cancel_futures=True)


def scan(
    work_dir,
    partitions,
    base=hats.HATS_BASE,
    workers=4,
    range_workers=8,
    guard=None,
    progress=print,
    straggler_max=STRAGGLER_MAX,
    rss_cap=None,
):
    keys = [f"{o}/{p}" for o, p in partitions]
    state_path = _scan_state_path(work_dir)
    strag_dir = os.path.join(work_dir, "strag")
    cand_dir = os.path.join(work_dir, "cand")
    thresh_path = os.path.join(work_dir, "thresholds.npz")

    if os.path.exists(state_path):
        with open(state_path) as f:
            sc = json.load(f)
        if sc.get("version") == 2 and sc.get("base") == base and sc.get("partitions") == keys:
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
                if fn.endswith((".spill", ".tmp")):
                    os.unlink(os.path.join(cand_dir, fn))
            if os.path.exists(thresh_path):
                os.unlink(thresh_path)
        else:
            if os.path.exists(strag_dir):
                shutil.rmtree(strag_dir)
            if os.path.exists(cand_dir):
                shutil.rmtree(cand_dir)
            if os.path.exists(thresh_path):
                os.unlink(thresh_path)
            sc = None
    else:
        if os.path.exists(strag_dir):
            shutil.rmtree(strag_dir)
        if os.path.exists(cand_dir):
            shutil.rmtree(cand_dir)
        if os.path.exists(thresh_path):
            os.unlink(thresh_path)
        sc = None

    if sc is None:
        _ensure_dir(strag_dir)
        _ensure_dir(cand_dir)
        sc = {
            "version": 2,
            "base": base,
            "partitions": keys,
            "done": [],
            "plan": {},
            "strag_sizes": {},
            "finished": False,
        }

    done_set = set(sc["done"])
    todo = [k for k in keys if k not in done_set]

    pending = {}  # (b, g) -> (local_list, mag_list, sid_list)
    pending_rows = 0

    def job(key):
        o, p = map(int, key.split("/"))
        url = hats.partition_url(o, p, base)
        arr, stats = hats.read_partition(url, workers=range_workers)
        arr, dups = hats.clean(arr)
        return key, arr, stats, dups

    gen = _bounded_fetch(todo, job, workers)
    try:
        for i, (key, arr, stats, dups) in enumerate(gen, len(sc["done"]) + 1):
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

            # candidates - per (base, order-3)
            finite = np.isfinite(arr["ra"]) & np.isfinite(arr["dec"]) & np.isfinite(arr["mag"])
            if np.any(finite):
                c_arr = arr[finite]
                c_sid = sid[finite]
                base_cell = c_sid >> 59
                local = ((c_sid >> 47) - base_cell * 4096).astype(np.int16)
                mag_f32 = c_arr["mag"].astype(np.float32)
                sid64 = c_sid.astype(np.int64)

                for b in np.unique(base_cell):
                    m_b = base_cell == b
                    lb = local[m_b]
                    mb = mag_f32[m_b]
                    sb = sid64[m_b]
                    g_arr = (lb >> 6).astype(np.int16)
                    for g in np.unique(g_arr):
                        mg = g_arr == g
                        l2, m2, s2 = topk_per_cell(
                            lb[mg], mb[mg], sb[mg], pyramid.HEAP_M
                        )
                        ck = (int(b), int(g))
                        if ck not in pending:
                            pending[ck] = ([], [], [])
                        pending[ck][0].append(l2)
                        pending[ck][1].append(m2)
                        pending[ck][2].append(s2)

                        pending_rows += len(l2)
                        if pending_rows > MERGE_ROWS:
                            _merge_all_pending(pending, cand_dir)
                            pending_rows = 0

            progress(f"scan {key}: rows={n} dups={dups} stragglers={int(mask_strag.sum())} {stats['seconds']:.1f}s done={len(sc['done'])}/{len(partitions)}")

            if i % CHECKPOINT_EVERY == 0:
                _merge_all_pending(pending, cand_dir)
                pending_rows = 0
                _write_scan_state(state_path, sc)
                if guard:
                    guard()

            if rss_cap is not None:
                rss = pyramid.rss_bytes()
                if rss > rss_cap:
                    _merge_all_pending(pending, cand_dir)
                    pending_rows = 0
                    _write_scan_state(state_path, sc)
                    raise pyramid.RssExceeded(rss, rss_cap, state_path)

            # Clean up all large temporary arrays
            arr = sid = unit = uniq = counts = plan_entry = None
            strag_arr = s_unit = c_arr = c_sid = base_cell = local = mag_f32 = sid64 = None
            del arr, sid, unit, uniq, counts, plan_entry
            del strag_arr, s_unit, c_arr, c_sid, base_cell, local, mag_f32, sid64
    except hats.HatsReadError:
        _merge_all_pending(pending, cand_dir)
        pending_rows = 0
        _write_scan_state(state_path, sc)
        raise
    finally:
        gen.close()

    _merge_all_pending(pending, cand_dir)
    pending_rows = 0
    sc["finished"] = True
    _write_scan_state(state_path, sc)
    return sc


def _merge_all_pending(pending, cand_dir):
    for (b, g), lists in list(pending.items()):
        if lists and lists[0]:
            _merge_pending(b, g, lists, cand_dir, pyramid.HEAP_M)
            pending.pop((b, g))


def _merge_pending(b, g, pending, cand_dir, k):
    locals_l = pending[0]
    mags_l = pending[1]
    sids_l = pending[2]
    if not locals_l:
        return
    local_all = np.concatenate(locals_l)
    mag_all = np.concatenate(mags_l)
    sid_all = np.concatenate(sids_l)

    cand_path = os.path.join(cand_dir, f"b{b:02d}_g{g:02d}.npz")
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


def _fsync_dir(path):
    try:
        fd = os.open(path, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError as e:
        warnings.warn(f"fsync of directory {path} failed: {e!r}", RuntimeWarning)


def _write_scan_state(path, sc):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(sc, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    _fsync_dir(os.path.dirname(path) or ".")


def _atomic_write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    _fsync_dir(os.path.dirname(path) or ".")


def thresholds(work_dir):
    state = pyramid._new_state()
    cand_dir = os.path.join(work_dir, "cand")
    heap_m = pyramid.HEAP_M
    if not os.path.exists(cand_dir):
        return state
    for i in range(12):
        files = [f for f in os.listdir(cand_dir) if f.startswith(f"b{i:02d}_g") and f.endswith(".npz")]
        if not files:
            continue
        files.sort()
        mag_h = np.full((4096, heap_m), np.inf, dtype=np.float32)
        sid_h = np.zeros((4096, heap_m), dtype=np.int64)
        n_h = np.zeros(4096, dtype=np.int32)
        for fn in files:
            with np.load(os.path.join(cand_dir, fn)) as data:
                local = data["local"]
                mag = data["mag"]
                sid = data["sid"]
            o = np.argsort(local, kind="stable")
            locs, starts, counts = np.unique(local[o], return_index=True, return_counts=True)
            for loc, start, count in zip(locs, starts, counts):
                sl = o[start : start + count]
                n_h[loc] = count
                mag_h[loc, :count] = mag[sl]
                sid_h[loc, :count] = sid[sl]
        pyramid.close_base_cell(i, mag_h, sid_h, n_h, state)
    return state


def _pass2_state_path(work_dir):
    return os.path.join(work_dir, "pass2.json")


def _finalize_state_path(work_dir):
    return os.path.join(work_dir, "finalize.json")


def _load_pass2(work_dir, cache_dir, scan_state, base, skip_names):
    state_path = _pass2_state_path(work_dir)
    if not os.path.exists(state_path):
        return None, True
    with open(state_path) as f:
        st = json.load(f)
    if (st.get("version") != 2 or st.get("base") != base or
            st.get("partitions") != scan_state["partitions"]):
        return None, True
    ready = set(st.get("ready", []))
    for name in skip_names:
        u = int(name.split("_o2_")[1].split(".")[0])
        if u not in ready:
            return None, True
    for u in ready:
        fname = f"GaiaSource_hats_o2_{u:03d}.hatsx"
        if fname not in skip_names and not os.path.exists(os.path.join(cache_dir, fname)):
            return None, True

    spill_dir = os.path.join(work_dir, "spill")
    _ensure_dir(spill_dir)
    known = set(st.get("spill_sizes", {}))
    for fn in os.listdir(spill_dir):
        p = os.path.join(spill_dir, fn)
        if fn in known:
            with open(p, "r+b") as f:
                f.truncate(st["spill_sizes"][fn])
        else:
            os.unlink(p)
    return st, False


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
    rss_cap=None,
    skip_names=frozenset(),
):
    if stats is None:
        stats = {}
    stats.setdefault("rows_out", 0)
    stats.setdefault("dups_global", 0)
    stats.setdefault("files", [])

    spill_dir = os.path.join(work_dir, "spill")
    strag_dir = os.path.join(work_dir, "strag")
    _ensure_dir(cache_dir)

    plan = scan_state["plan"]
    all_units = set()
    for entry in plan.values():
        all_units.update(int(u) for u in entry["units"])
    units = sorted(all_units)

    first_home_map = {}
    for key, entry in plan.items():
        first_home_map[key] = min(entry["home"])

    state, fresh = _load_pass2(work_dir, cache_dir, scan_state, base, skip_names)
    if fresh:
        if os.path.exists(spill_dir):
            shutil.rmtree(spill_dir)
        if os.path.exists(_finalize_state_path(work_dir)):
            os.unlink(_finalize_state_path(work_dir))
        for fn in os.listdir(cache_dir):
            if fn.startswith("GaiaSource_hats_o2_") and fn.endswith((".hatsx", ".tmp")):
                os.unlink(os.path.join(cache_dir, fn))
        state = {
            "version": 2,
            "base": base,
            "partitions": scan_state["partitions"],
            "fetched": [],
            "spill_sizes": {},
            "ready": [],
            "stats": {"rows_out": 0, "dups_global": 0, "files": []},
        }
        _ensure_dir(spill_dir)
    else:
        stats["rows_out"] = state["stats"]["rows_out"]
        stats["dups_global"] = state["stats"]["dups_global"]
        stats["files"] = state["stats"]["files"][:]

    fetched = set(state["fetched"])
    spill_sizes = state["spill_sizes"]

    def job(key):
        o, p = map(int, key.split("/"))
        url = hats.partition_url(o, p, base)
        arr, _ = hats.read_partition(url, workers=range_workers)
        arr, dups = hats.clean(arr)
        return key, arr, dups

    for u in units:
        if u in state.get("ready", []):
            fname = f"GaiaSource_hats_o2_{u:03d}.hatsx"
            out_path = os.path.join(cache_dir, fname)
            if fname in skip_names:
                if os.path.exists(out_path):
                    os.unlink(out_path)
                continue
            info = pyramid.probe_shard(out_path, pyramid.ADAPTERS["hats"], 36)
            progress(f"unit {u:03d}: rows=already-ready fetched=0")
            yield info
            if not keep_files:
                os.unlink(out_path)
            continue

        need = [k for k, v in first_home_map.items() if v == u and k not in fetched]
        gen = _bounded_fetch(need, job, workers)
        try:
            home_arr = o6 = None
            for key, arr, dups in gen:
                unit_arr = arr["source_id"] >> 55
                home_list = plan[key]["home"]
                mask_home = np.isin(unit_arr, home_list)
                if np.any(mask_home):
                    home_arr = arr[mask_home]
                    o6 = home_arr["source_id"] >> 47
                    for s in np.unique(o6):
                        fname = f"o6_{int(s):05d}.spill"
                        path = os.path.join(spill_dir, fname)
                        with open(path, "ab") as f:
                            home_arr[o6 == s].tofile(f)
                        spill_sizes[fname] = os.path.getsize(path)
                fetched.add(key)
                state["fetched"] = list(fetched)
                state["spill_sizes"] = dict(spill_sizes)
                _write_pass2_state(_pass2_state_path(work_dir), state)

                if guard:
                    guard()

                if rss_cap is not None:
                    rss = pyramid.rss_bytes()
                    if rss > rss_cap:
                        raise pyramid.RssExceeded(rss, rss_cap, f"pass 2 unit {u:03d} fetch")
                arr = unit_arr = home_arr = o6 = None
                del arr, unit_arr, home_arr, o6
        finally:
            gen.close()

        # finalize unit
        finalize_path = _finalize_state_path(work_dir)
        tmp_path = os.path.join(cache_dir, f"GaiaSource_hats_o2_{u:03d}.hatsx.tmp")
        out_path = os.path.join(cache_dir, f"GaiaSource_hats_o2_{u:03d}.hatsx")

        fin = None
        if os.path.exists(finalize_path):
            with open(finalize_path) as f:
                fin = json.load(f)
            if fin.get("unit") != u:
                fin = None

        adopted = False
        if fin is not None:
            expected = fin.get("tmp_size")
            if os.path.exists(tmp_path):
                # a
                got = os.path.getsize(tmp_path)
                if got < expected:
                    raise RuntimeError(
                        f"unit {u:03d}: {tmp_path} is {got} bytes but finalize.json recorded "
                        f"tmp_size={expected} (a crash lost appended data); refusing to resume. "
                        "Delete hats_stream/pass2.json and hats_stream/finalize.json to redo pass 2."
                    )
                with open(tmp_path, "r+b") as f:
                    f.truncate(expected)
                    f.seek(0, 2)
                n = fin["n"]
                dups_u = fin["dups"]
                next_s_idx = fin["next"]
            elif fin.get("next") == 256 and os.path.exists(out_path):
                got = os.path.getsize(out_path)
                if (
                    fin.get("next") == 256
                    and fin.get("n") is not None
                    and got == expected == fin["n"] * 36
                ):
                    # b
                    n = fin["n"]
                    dups_u = fin["dups"]
                    adopted = True
                    progress(f"unit {u:03d}: adopted finished shard after interrupted rename")
                else:
                    raise RuntimeError(
                        f"unit {u:03d}: finished shard {out_path} is {got} bytes but finalize.json "
                        f"expects tmp_size={expected} (n={fin.get('n')} rows x 36 = "
                        f"{(fin.get('n') or 0) * 36}); refusing to adopt or rebuild it. "
                        "Delete hats_stream/pass2.json and hats_stream/finalize.json to redo pass 2."
                    )
            elif fin.get("next") == 256 and fin.get("n") == 0 and not os.path.exists(out_path):
                # c
                n = 0
                dups_u = 0
                open(tmp_path, "wb").close()
                next_s_idx = 256
            else:
                # d
                raise RuntimeError(
                    f"unit {u:03d}: finalize.json says next={fin.get('next')} n={fin.get('n')} "
                    f"but the .tmp is missing; refusing to rebuild over existing data. "
                    f"Delete hats_stream/pass2.json and hats_stream/finalize.json to redo pass 2."
                )
        else:
            # e
            if os.path.exists(out_path) and u not in state.get("ready", []):
                raise RuntimeError(
                    f"unit {u:03d}: {out_path} already exists for a unit that is not in ready; "
                    "refusing to overwrite. Delete hats_stream/pass2.json and hats_stream/finalize.json to redo pass 2."
                )
            n = 0
            dups_u = 0
            next_s_idx = 0
            with open(tmp_path, "wb") as f:
                pass

        if not adopted:
            strag_path = os.path.join(strag_dir, f"o2_{u:03d}.spill")
            if os.path.exists(strag_path):
                strag_arr = np.fromfile(strag_path, dtype=tap.DR3X_DTYPE)
                strag_o6 = strag_arr["source_id"] >> 47
            else:
                strag_arr = np.array([], dtype=tap.DR3X_DTYPE)
                strag_o6 = np.array([], dtype=np.int64)

            o6_start = u * 256
            for i in range(next_s_idx, 256):
                s = o6_start + i
                pieces = []
                spill_path = os.path.join(spill_dir, f"o6_{s:05d}.spill")
                if os.path.exists(spill_path):
                    pieces.append(np.fromfile(spill_path, dtype=tap.DR3X_DTYPE))
                mask = strag_o6 == s
                if np.any(mask):
                    pieces.append(strag_arr[mask])
                if pieces:
                    arr, d = hats.clean(np.concatenate(pieces))
                    with open(tmp_path, "ab") as f:
                        f.write(arr.tobytes())
                        os.fsync(f.fileno())
                    n += len(arr)
                    dups_u += d
                    del arr
                _atomic_write_json(
                    finalize_path,
                    {"unit": u, "next": i + 1, "tmp_size": os.path.getsize(tmp_path), "n": n, "dups": dups_u},
                )
                if os.path.exists(spill_path):
                    os.unlink(spill_path)
                if i % 16 == 15 and guard:
                    guard()
                if rss_cap is not None:
                    rss = pyramid.rss_bytes()
                    if rss > rss_cap:
                        raise pyramid.RssExceeded(rss, rss_cap, f"pass 2 unit {u:03d} sub-cell {s}")

        stats["dups_global"] += dups_u
        stats["rows_out"] += n

        if n == 0:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
            if os.path.exists(finalize_path):
                os.unlink(finalize_path)
            # Do NOT add to ready - it has no shard
            _write_pass2_state(_pass2_state_path(work_dir), state)
            if guard:
                guard()
            continue

        fname = f"GaiaSource_hats_o2_{u:03d}.hatsx"
        out_path = os.path.join(cache_dir, fname)

        if not adopted:
            # finalize tmp, rename, fsync, then state
            with open(tmp_path, "rb+") as f:
                os.fsync(f.fileno())
            os.replace(tmp_path, out_path)
            _fsync_dir(cache_dir)

        state["ready"].append(u)
        state["stats"] = {"rows_out": stats["rows_out"], "dups_global": stats["dups_global"], "files": list(stats["files"])}
        stats["files"].append(fname)
        state["stats"]["files"].append(fname)

        for s in range(u * 256, u * 256 + 256):
            k = f"o6_{s:05d}.spill"
            spill_sizes.pop(k, None)
        state["spill_sizes"] = dict(spill_sizes)

        _write_pass2_state(_pass2_state_path(work_dir), state)

        # Cleanup after state is safely written
        if os.path.exists(finalize_path):
            os.unlink(finalize_path)
        for s in range(u * 256, u * 256 + 256):
            spill_path = os.path.join(spill_dir, f"o6_{s:05d}.spill")
            if os.path.exists(spill_path):
                os.unlink(spill_path)

        if guard:
            guard()

        info = pyramid.probe_shard(out_path, pyramid.ADAPTERS["hats"], 36)
        progress(f"unit {u:03d}: rows={n} fetched={len(need)}")
        strag_arr = strag_o6 = None
        del strag_arr, strag_o6
        yield info
        if not keep_files:
            os.unlink(out_path)

    if len(fetched) != len(plan):
        raise RuntimeError(f"Not all partitions fetched: {len(fetched)}/{len(plan)}")


def _write_pass2_state(path, st):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    _fsync_dir(os.path.dirname(path) or ".")


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
    rss_cap=None,
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
        rss_cap=rss_cap,
    )
    progress("scan finished")

    thresh_path = os.path.join(work_dir, "thresholds.npz")
    cand = os.path.join(work_dir, "cand")
    if sc.get("thresholds_file"):
        if not os.path.exists(thresh_path):
            raise RuntimeError(
                f"{thresh_path} is missing but scan.json says pass 1 finished and saved it; "
                "refusing to build with empty thresholds (0 coarse stars). "
                "Delete hats_stream/scan.json to redo pass 1."
            )
        state = pyramid._load_state(thresh_path)
    else:
        if not os.path.exists(cand):
            raise RuntimeError(
                f"{cand} is missing and no thresholds.npz was saved; "
                "refusing to build with empty thresholds. "
                "Delete hats_stream/scan.json to redo pass 1."
            )
        state = thresholds(work_dir)
        tmp = os.path.join(work_dir, "thresholds.tmp.npz")
        pyramid._save_state(tmp, state)
        with open(tmp, "rb") as f:
            os.fsync(f.fileno())
        os.replace(tmp, thresh_path)
        _fsync_dir(work_dir)
        sc["thresholds_file"] = "thresholds.npz"
        _write_scan_state(_scan_state_path(work_dir), sc)
        if os.path.exists(cand):
            shutil.rmtree(cand)

    run_stats = {"rows_out": 0, "dups_global": 0, "files": []}

    done = pyramid.stream_done_shards(config["output_dir"], config) if config else set()

    pass2_state, _ = _load_pass2(work_dir, cache_dir, sc, base, done)
    if pass2_state is None and done:
        pyramid.clear_stream_ckpt(config["output_dir"])
        done = set()

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
        rss_cap=rss_cap,
        skip_names=done,
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
    for p in (_pass2_state_path(work_dir), _finalize_state_path(work_dir)):
        if os.path.exists(p):
            os.unlink(p)

    return hm, pm
