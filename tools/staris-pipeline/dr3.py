import json
import os
import hashlib
import urllib.request
import urllib.parse
import re
from typing import List, Tuple, Dict, Any, Iterator, Optional
from collections import defaultdict

import numpy as np

DR3_BASE = "https://cdn.gea.esac.esa.int/Gaia/gdr3/gaia_source/"
DR3_COLUMNS = ["source_id", "ra", "dec", "parallax", "parallax_error", "phot_g_mean_mag"]
PLX_SNR_MIN = 5.0
DR3C_REC = 32
DR3C_DTYPE = np.dtype(
    [
        ("source_id", "<i8"),
        ("ra", "<f8"),
        ("dec", "<f8"),
        ("parallax", "<f4"),
        ("mag", "<f4"),
    ]
)


class _DR3RedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if code in (301, 302, 303, 307, 308):
            location = headers.get("Location") or headers.get("location")
            if location:
                parsed = urllib.parse.urlparse(location)
                if parsed.scheme != "https" or parsed.hostname != "cdn.gea.esac.esa.int":
                    raise RuntimeError(f"Redirect violation: {location}")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def good_parallax(plx, plx_err, snr_min=PLX_SNR_MIN):
    """plx (f64) if finite, >0, err finite >0 and snr >= min, else NaN."""
    plx = np.asarray(plx, dtype=np.float64).copy()
    plx_err = np.asarray(plx_err, dtype=np.float64)
    bad = ~(
        np.isfinite(plx)
        & (plx > 0)
        & np.isfinite(plx_err)
        & (plx_err > 0)
        & (plx / plx_err >= snr_min)
    )
    plx[bad] = np.nan
    return plx


def parse_md5sum(text: str) -> List[Tuple[str, str]]:
    results = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(None, 1)
        if len(parts) == 2 and re.match(r"^GaiaSource_\d{6}-\d{6}\.csv\.gz$", parts[1]):
            results.append((parts[1], parts[0]))
    return results


def fetch_md5_list(base=DR3_BASE):
    url = base + "_MD5SUM.txt"
    with urllib.request.urlopen(url, timeout=30) as resp:
        text = resp.read().decode("utf-8")
    return parse_md5sum(text)


def convert_csv(gz_path, out_path, snr_min=PLX_SNR_MIN):
    import pandas as pd
    tmp_path = out_path + ".tmp"
    stats = {
        "n": 0,
        "n_plx_positive": 0,
        "n_plx_good": 0,
        "n_mag_null": 0,
        "bytes": 0,
    }
    prev_sid = None
    dtype = {
        "source_id": "int64",
        "ra": "float64",
        "dec": "float64",
        "parallax": "float64",
        "parallax_error": "float64",
        "phot_g_mean_mag": "float64",
    }
    reader = pd.read_csv(
        gz_path,
        comment="#",
        usecols=DR3_COLUMNS,
        na_values=["null", ""],
        keep_default_na=True,
        chunksize=500_000,
        dtype=dtype,
        compression="infer",
    )
    with open(tmp_path, "wb") as f:
        for df in reader:
            n_chunk = len(df)
            stats["n"] += n_chunk
            plx = df["parallax"].values
            plx_err = df["parallax_error"].values
            is_pos = (
                np.isfinite(plx)
                & (plx > 0)
                & np.isfinite(plx_err)
                & (plx_err > 0)
            )
            stats["n_plx_positive"] += int(np.sum(is_pos))
            plx_good = good_parallax(plx, plx_err, snr_min)
            stats["n_plx_good"] += int(np.sum(np.isfinite(plx_good)))
            mag = df["phot_g_mean_mag"].values
            stats["n_mag_null"] += int(np.sum(np.isnan(mag)))
            arr = np.zeros(n_chunk, dtype=DR3C_DTYPE)
            arr["source_id"] = df["source_id"].values
            arr["ra"] = df["ra"].values
            arr["dec"] = df["dec"].values
            arr["parallax"] = plx_good.astype(np.float32)
            arr["mag"] = mag.astype(np.float32)
            sids = arr["source_id"]
            if prev_sid is not None and (sids.size > 0 and int(sids[0]) < prev_sid):
                raise ValueError(
                    f"{gz_path} source_id decreased: {prev_sid} -> {sids[0]}"
                )
            if sids.size > 1 and np.any(sids[1:] < sids[:-1]):
                raise ValueError(f"{gz_path} not sorted by source_id")
            if sids.size > 0:
                prev_sid = int(sids[-1])
            f.write(arr.tobytes())
    os.replace(tmp_path, out_path)
    stats["bytes"] = stats["n"] * DR3C_REC
    return stats


def download(url, dest, md5, retries=3, timeout=120, allow_file=False):
    if not url.startswith("https://cdn.gea.esac.esa.int") and not (allow_file and url.startswith("file://")):
        raise RuntimeError(f"Disallowed URL: {url}")
    filename = os.path.basename(url)
    if not re.match(r"^GaiaSource_\d{6}-\d{6}\.csv\.gz$", filename):
        raise ValueError(f"Invalid Gaia DR3 filename: {filename}")
    opener = urllib.request.build_opener(_DR3RedirectHandler())
    for attempt in range(retries):
        part_path = dest + ".part"
        hasher = hashlib.md5()
        try:
            with opener.open(url, timeout=timeout) as resp:
                with open(part_path, "wb") as f:
                    while True:
                        block = resp.read(8 * 1024 * 1024)
                        if not block:
                            break
                        hasher.update(block)
                        f.write(block)
            if hasher.hexdigest() != md5:
                if os.path.exists(part_path):
                    os.unlink(part_path)
                raise ValueError(f"MD5 mismatch for {url}")
            os.replace(part_path, dest)
            return
        except Exception as e:
            if os.path.exists(part_path):
                os.unlink(part_path)
            if attempt == retries - 1:
                raise RuntimeError(f"Download failed for {url}: {e}") from e


def fetch_dr3(
    cache_dir,
    names=None,
    limit=None,
    base=DR3_BASE,
    snr_min=PLX_SNR_MIN,
    rss_cap=2 * 1024**3,
    keep_gz=False,
    progress=print,
    md5_list=None,
    allow_file=False,
):
    os.makedirs(cache_dir, exist_ok=True)
    if md5_list is None:
        md5_list = fetch_md5_list(base)
    if names is not None:
        for n in names:
            if not re.match(r"^GaiaSource_\d{6}-\d{6}\.csv\.gz$", n):
                raise ValueError(f"Invalid name: {n}")
        name_set = {n for n in names}
        md5_list = [item for item in md5_list if item[0] in name_set]
    if limit is not None and limit > 0:
        md5_list = md5_list[:limit]
    fetch_json_path = os.path.join(cache_dir, "fetch.json")
    if os.path.exists(fetch_json_path):
        with open(fetch_json_path, "r", encoding="utf-8") as f:
            fetch = json.load(f)
    else:
        fetch = {
            "files_done": 0,
            "n": 0,
            "n_plx_good": 0,
            "pct_plx_good": 0.0,
            "gz_bytes": 0,
            "files": {},
        }
    for name, md5 in md5_list:
        stem = name.replace(".csv.gz", "")
        dr3c_path = os.path.join(cache_dir, f"{stem}.dr3c")
        file_info = fetch["files"].get(name, {})
        if file_info.get("done", False) and os.path.exists(dr3c_path):
            expected_bytes = file_info.get("n", 0) * DR3C_REC
            if os.path.getsize(dr3c_path) == expected_bytes:
                progress(f"skip {name} (done)")
                continue
        gz_path = os.path.join(cache_dir, name)
        url = f"{base}{name}"
        if os.path.exists(gz_path):
            hasher = hashlib.md5()
            with open(gz_path, "rb") as f:
                while True:
                    b = f.read(8 * 1024 * 1024)
                    if not b:
                        break
                    hasher.update(b)
            if hasher.hexdigest() != md5:
                progress(f"MD5 mismatch for cached {name}, deleting")
                os.unlink(gz_path)
            else:
                progress(f"cached gz {name} MD5 ok")
        if not os.path.exists(gz_path):
            progress(f"download {name}")
            download(url, gz_path, md5, allow_file=allow_file)
        gz_bytes = os.path.getsize(gz_path)
        progress(f"convert {name}")
        stats = convert_csv(gz_path, dr3c_path, snr_min)
        stats["md5"] = md5
        stats["gz_bytes"] = gz_bytes
        stats["done"] = True
        fetch["files"][name] = stats
        done_files = [v for v in fetch["files"].values() if v.get("done")]
        fetch["files_done"] = len(done_files)
        fetch["n"] = sum(v.get("n", 0) for v in done_files)
        fetch["n_plx_good"] = sum(v.get("n_plx_good", 0) for v in done_files)
        fetch["gz_bytes"] = sum(v.get("gz_bytes", 0) for v in done_files)
        if fetch["n"] > 0:
            fetch["pct_plx_good"] = round(
                100.0 * fetch["n_plx_good"] / fetch["n"], 2
            )
        tmp_path = fetch_json_path + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(fetch, f, indent=2)
        os.replace(tmp_path, fetch_json_path)
        import pyramid
        rss = pyramid.check_rss(rss_cap, fetch_json_path)
        progress(
            f"fetch {name} n={stats['n']} plx_good={stats['n_plx_good']} "
            f"pct={fetch['pct_plx_good']:.1f} rss={rss}"
        )
        if not keep_gz and os.path.exists(gz_path):
            os.unlink(gz_path)
    produced = []
    for name, _md5 in md5_list:
        stem = name.replace(".csv.gz", "")
        dr3c_name = f"{stem}.dr3c"
        if os.path.exists(os.path.join(cache_dir, dr3c_name)):
            produced.append(dr3c_name)
    fetch["names"] = sorted(produced)
    return fetch


def iter_dr3c(path, chunk=65536):
    size = os.path.getsize(path)
    if size % DR3C_REC != 0:
        raise ValueError(f"{path} size {size} not multiple of {DR3C_REC}")
    with open(path, "rb") as handle:
        while True:
            blob = handle.read(chunk * DR3C_REC)
            if not blob:
                break
            n_bytes = len(blob)
            if n_bytes % DR3C_REC != 0:
                raise ValueError(f"{path} partial record at end")
            arr_c = np.frombuffer(blob, dtype=DR3C_DTYPE).copy()
            n = len(arr_c)
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
            out = np.zeros(n, dtype=REC_DTYPE)
            out["source_id"] = arr_c["source_id"]
            out["ra"] = arr_c["ra"]
            out["dec"] = arr_c["dec"]
            out["parallax"] = arr_c["parallax"].astype(np.float64)
            out["mag"] = arr_c["mag"]
            yield out


def run_deep(config, progress=print):
    import tap
    import pyramid
    output_dir = config["output_dir"]
    manifest = pyramid.load_manifest(output_dir)
    if not manifest or manifest.get("pass") != "done":
        raise ValueError("Coarse must be done (pass==done) before deep")
    if manifest.get("adapter") != "dr3_tap":
        raise ValueError("run_deep only supported for dr3_tap adapter")
    state_path = os.path.join(output_dir, "thresholds.npz")
    state = pyramid._load_state(state_path)
    q8 = pyramid.load_q8()
    cap = int(config.get("rss_cap", 2 * 1024**3))
    deep_dir = os.path.join(output_dir, "deep")
    os.makedirs(deep_dir, exist_ok=True)
    job_dir_base = os.path.join(output_dir, "deep_jobs")
    os.makedirs(job_dir_base, exist_ok=True)
    manifest.setdefault("deep_units_done", [])
    manifest.setdefault("deep_levels", [])
    manifest.setdefault("deep_written", {str(k): 0 for k in pyramid.DEEP_ORDERS})
    manifest.setdefault("deep_counts", {str(k): 0 for k in pyramid.DEEP_ORDERS})
    done_set = set(manifest["deep_units_done"])
    region = config.get("region")
    if region:
        r_order, r_cells = region
        if r_order < 2:
            factor = 4 ** (2 - r_order)
            units = []
            for rc in r_cells:
                base = rc * factor
                for i in range(factor):
                    units.append(base + i)
            units = sorted(set([u % 192 for u in units]))  # order-2 modulo
        else:
            shift = 2 * (r_order - 2)
            units = sorted(set(c >> shift for c in r_cells))
    else:
        units = list(range(192))
    total_finite_seen = 0
    tap_cache = config.get("tap_cache", os.path.join(os.path.dirname(output_dir), "tap_cache"))
    coarse_npz_path = os.path.join(tap_cache, "coarse_counts.npz")
    tap_coarse_total = 0
    if os.path.exists(coarse_npz_path):
        with np.load(coarse_npz_path) as blob:
            if "counts" in blob:
                counts_d = json.loads(str(blob["counts"].item()))
                tap_coarse_total = sum(int(v) for v in counts_d.values())
    for unit in units:
        if unit in done_set:
            progress(f"deep unit {unit} already done")
            continue
        unit_job_dir = os.path.join(job_dir_base, f"u{unit:03d}")
        os.makedirs(unit_job_dir, exist_ok=True)
        guard = config.get("guard")
        if guard:
            guard()
        pyramid.check_rss(cap, pyramid.manifest_path(output_dir))
        if "deep_sink_factory" in config and callable(config["deep_sink_factory"]):
            sink = config["deep_sink_factory"]()
        else:
            sink = config.get("deep_sink")
        delete_after = bool(config.get("deep_delete_after_upload", False))
        pack_accum = defaultdict(list)
        unit_deep_counts = {order: 0 for order in pyramid.DEEP_ORDERS}
        for cell6, arr in tap.iter_deep_unit(
            unit,
            workers=config.get("deep_workers", 6),
            job_dir=unit_job_dir,
            guard=guard,
            progress=progress,
        ):
            if len(arr) == 0:
                continue
            mag_f32 = arr["mag"].astype(np.float32)
            sids = arr["source_id"]
            finite_mag = np.isfinite(mag_f32)
            total_finite_seen += int(np.sum(finite_mag))
            is_coarse = np.zeros(len(arr), dtype=bool)
            for k in pyramid.COARSE_ORDERS:
                cells = pyramid.cell_of(sids, k)
                on = state["tau_on"][k][cells]
                tau_m = state["tau_mag"][k][cells].astype(np.float32)
                tau_s = state["tau_sid"][k][cells]
                inkey = (mag_f32 < tau_m) | ((mag_f32 == tau_m) & (sids <= tau_s))
                is_coarse |= on & inkey
            kept_mask = finite_mag & ~is_coarse
            kept = arr[kept_mask]
            if len(kept) == 0:
                continue
            counts, written = pyramid.split_deep(kept, True, q8)
            for order, cdict in counts.items():
                for cnt in cdict.values():
                    unit_deep_counts[order] += cnt
            for order, cdict in written.items():
                for cell, indexes in cdict.items():
                    if len(indexes) == 0:
                        continue
                    encoded = pyramid._encode_rows(kept, indexes, q8)
                    pkey = pyramid._pack_key(order, cell)
                    parent = pkey[0]
                    local = pkey[2] if len(pkey) > 2 else pkey[1]
                    pack_accum[(order, parent)].append((local, encoded))
            pyramid.check_rss(cap, unit_job_dir)
        for (order, parent), cells_items in pack_accum.items():
            name = f"o{order}_p{parent}.pack"
            local_path = os.path.join(deep_dir, name)
            parent_order = order - 5
            nrec, nbytes = pyramid.write_pack(local_path, order, parent_order, cells_items)
            level_entry = {
                "order": int(order),
                "host": "r2",
                "pack": name,
                "pack_parent_order": int(parent_order),
                "pack_id": int(parent),
                "n": int(nrec),
                "bytes": int(nbytes),
            }
            manifest["deep_levels"].append(level_entry)
            manifest["deep_written"][str(order)] = manifest["deep_written"].get(str(order), 0) + nrec
            if sink:
                sink(local_path, name)
            if delete_after and os.path.exists(local_path):
                os.unlink(local_path)
        for order in pyramid.DEEP_ORDERS:
            manifest["deep_counts"][str(order)] = manifest["deep_counts"].get(str(order), 0) + unit_deep_counts[order]
        manifest["deep_units_done"].append(int(unit))
        pyramid.save_manifest(output_dir, manifest)
        tap.cleanup_deep_unit(unit_job_dir, unit)
        progress(f"finished deep unit {unit}")
    coarse_total = sum(int(v) for v in manifest.get("coarse_counts", {}).values())
    deep_total = sum(int(v) for v in manifest.get("deep_written", {}).values())
    verify_match = (coarse_total + deep_total == total_finite_seen)
    manifest["deep_verify"] = {
        "coarse": coarse_total,
        "deep": deep_total,
        "total_finite_seen": total_finite_seen,
        "tap_coarse": tap_coarse_total,
        "match": verify_match,
    }
    manifest["pass"] = "deep_done"
    pyramid.save_manifest(output_dir, manifest)
    all_levels = manifest.get("levels", []) + manifest.get("deep_levels", [])
    total_r = manifest.get("total_records", 0) + deep_total
    r2_base_cfg = config.get("r2_base", "https://stars.graphicoregon.com")
    write_config = {"r2_base": r2_base_cfg, "write_deep": True}
    pyramid.write_viewer_tiles(output_dir, all_levels, total_r, write_config)
    progress(f"deep verify: {json.dumps(manifest['deep_verify'])}")
    if not verify_match:
        progress("deep_verify mismatch")
    return manifest
