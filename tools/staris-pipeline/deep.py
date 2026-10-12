"""Deep (order >=7) star pipeline for StarIS Gaia using TAP.

Loads coarse thresholds, fetches per order-2 unit via tap.iter_deep_unit, applies
thresholds to identify deep stars, splits into LOD packs, uploads to R2 if sink
provided. Updates manifest and tiles.json.
"""

import json
import os
from collections import defaultdict

import numpy as np


def run_deep(config, progress=print):
    output_dir = config["output_dir"]
    tap_cache = config.get("tap_cache")
    region = config.get("region")
    deep_workers = config.get("deep_workers", 6)
    guard = config.get("guard")
    rss_cap = config.get("rss_cap", 2 * 1024 ** 3)
    r2_base = config.get("r2_base")
    deep_sink_factory = config.get("deep_sink_factory")
    deep_delete_after_upload = bool(config.get("deep_delete_after_upload", False))
    runner = config.get("runner")

    import pyramid
    import tap

    if runner is None:
        runner = tap.run_async

    manifest = pyramid.load_manifest(output_dir)
    if not manifest or manifest.get("pass") != "done":
        raise ValueError(f"output_dir {output_dir} must have manifest with pass=='done'")

    state = pyramid._load_state(os.path.join(output_dir, "thresholds.npz"))
    q8 = pyramid.load_q8()

    deep_dir = os.path.join(output_dir, "deep")
    os.makedirs(deep_dir, exist_ok=True)
    job_dir = os.path.join(output_dir, "deep_jobs")
    os.makedirs(job_dir, exist_ok=True)

    if "deep_levels" not in manifest:
        manifest["deep_levels"] = []
    if "deep_written" not in manifest:
        manifest["deep_written"] = {str(o): 0 for o in pyramid.DEEP_ORDERS}
    if "deep_seen" not in manifest:
        manifest["deep_seen"] = 0
    if "deep_coarse_seen" not in manifest:
        manifest["deep_coarse_seen"] = 0
    if "deep_units_done" not in manifest:
        manifest["deep_units_done"] = []

    tau_on = state["tau_on"]
    tau_mag = state["tau_mag"]
    tau_sid = state["tau_sid"]

    # Units (order-2 cells)
    if region is None:
        units = list(range(192))
    else:
        r_order, r_cells = region
        r_cells = sorted(set(r_cells))
        if r_order == 2:
            units = r_cells
        elif r_order > 2:
            factor = 4 ** (r_order - 2)
            units = sorted({c // factor for c in r_cells})
        else:
            factor = 4 ** (2 - r_order)
            units = []
            for rc in r_cells:
                base = rc * factor
                for i in range(factor):
                    u = base + i
                    if 0 <= u < 192:
                        units.append(u)
            units = sorted(set(units))

    r_order_for_filter = None
    r_cell_set = None
    if region:
        r_order_for_filter, r_cells_list = region
        r_cell_set = set(r_cells_list)

    def cell_of(sid, order):
        return pyramid.cell_of(sid, order)

    for unit in units:
        if unit in manifest["deep_units_done"] or str(unit) in manifest["deep_units_done"]:
            progress(f"deep unit {unit} already done")
            continue
        if guard is not None:
            guard()
        sink = deep_sink_factory() if deep_sink_factory is not None else None
        buffers = defaultdict(list)  # (order, parent) -> list[(local, encoded)]
        seen = 0
        coarse_seen = 0
        for c6, arr in tap.iter_deep_unit(
            unit,
            workers=deep_workers,
            job_dir=job_dir,
            guard=guard,
            runner=runner,
            progress=progress,
        ):
            # drop non-finite mag/ra/dec
            finite_mask = (
                np.isfinite(arr["ra"])
                & np.isfinite(arr["dec"])
                & np.isfinite(arr["mag"])
            )
            arr = arr[finite_mask].copy()
            # region filter
            if r_cell_set is not None and r_order_for_filter is not None:
                cells_r = cell_of(arr["source_id"], r_order_for_filter)
                in_r = np.isin(cells_r, list(r_cell_set))
                arr = arr[in_r].copy()
            n_finite_in_region = len(arr)
            seen += n_finite_in_region
            if n_finite_in_region == 0:
                pyramid.check_rss(rss_cap, pyramid.manifest_path(output_dir))
                continue
            # vectorised coarse mask
            coarse = np.zeros(n_finite_in_region, dtype=bool)
            sids = arr["source_id"]
            mags = arr["mag"].astype(np.float32)
            for k in range(7):
                cells = cell_of(sids, k)
                on = tau_on[k][cells]
                tm = tau_mag[k][cells].astype(np.float32)
                ts = tau_sid[k][cells]
                coarse |= on & (
                    (mags < tm) | ((mags == tm) & (sids <= ts))
                )
            deep_arr = arr[~coarse].copy()
            coarse_seen += int(np.sum(coarse))
            # split
            counts, written = pyramid.split_deep(deep_arr, True, q8)
            for order in pyramid.DEEP_ORDERS:
                for cell, indexes in written.get(order, {}).items():
                    rec = pyramid._encode_rows(deep_arr, indexes, q8)
                    p, po, local = pyramid._pack_key(order, int(cell))
                    buffers[(order, p)].append((local, rec))
            pyramid.check_rss(rss_cap, pyramid.manifest_path(output_dir))
        # after unit: write packs
        for (order, parent), cell_recs in buffers.items():
            parent_order = order - 5
            name = f"o{order}_p{parent}.pack"
            path = os.path.join(deep_dir, name)
            n, nbytes = pyramid.write_pack(path, order, parent_order, cell_recs)
            if sink is not None:
                sink(str(path), name)
            if deep_delete_after_upload and sink is not None:
                try:
                    os.remove(path)
                except OSError:
                    pass
            level_dict = {
                "order": int(order),
                "host": "r2",
                "pack": name,
                "pack_parent_order": int(parent_order),
                "pack_id": int(parent),
                "n": int(n),
                "bytes": int(nbytes),
            }
            replaced = False
            for i, lev in enumerate(manifest["deep_levels"]):
                if lev.get("pack") == name:
                    manifest["deep_levels"][i] = level_dict
                    replaced = True
                    break
            if not replaced:
                manifest["deep_levels"].append(level_dict)
            manifest["deep_written"][str(order)] += n
        manifest["deep_seen"] += seen
        manifest["deep_coarse_seen"] += coarse_seen
        if unit not in manifest["deep_units_done"]:
            manifest["deep_units_done"].append(unit)
        pyramid.save_manifest(output_dir, manifest)
        tap.cleanup_deep_unit(job_dir, unit)
        progress(f"deep unit {unit} done: seen={seen} coarse={coarse_seen}")

    # final verify
    deep_written = sum(manifest["deep_written"].values())
    v = {
        "seen": int(manifest["deep_seen"]),
        "coarse_seen": int(manifest["deep_coarse_seen"]),
        "deep_written": int(deep_written),
        "ok": False,
    }
    if manifest["deep_coarse_seen"] + deep_written == manifest["deep_seen"]:
        v["ok"] = True
        coarse_sum = sum(int(vv) for vv in manifest.get("coarse_counts", {}).values())
        if region is None or manifest.get("region") == region:
            if manifest["deep_coarse_seen"] != coarse_sum:
                v["ok"] = False
    manifest["deep_verify"] = v
    total_records = manifest.get("total_records", 0) + deep_written
    tile_config = {
        "write_deep": True,
        "r2_base": r2_base,
    }
    pyramid.write_viewer_tiles(
        output_dir,
        manifest.get("levels", []) + manifest.get("deep_levels", []),
        total_records,
        tile_config,
    )
    pyramid.save_manifest(output_dir, manifest)
    return manifest
