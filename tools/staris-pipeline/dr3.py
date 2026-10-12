import json
import os
import hashlib
import urllib.request
from typing import List, Tuple, Dict, Any, Iterator

import numpy as np
import pandas as pd

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
        if len(parts) == 2 and parts[1].endswith(".csv.gz"):
            results.append((parts[1], parts[0]))
    return results


def fetch_md5_list(base=DR3_BASE):
    url = base + "_MD5SUM.txt"
    with urllib.request.urlopen(url, timeout=30) as resp:
        text = resp.read().decode("utf-8")
    return parse_md5sum(text)


def iter_dr3_csv(path, chunk=500_000) -> Iterator[np.ndarray]:
    dtype = {"source_id": "int64"}
    for c in DR3_COLUMNS[1:]:
        dtype[c] = "float64"
    reader = pd.read_csv(
        path,
        comment="#",
        usecols=DR3_COLUMNS,
        na_values=["null", ""],
        keep_default_na=True,
        chunksize=chunk,
        dtype=dtype,
        compression="infer",
    )
    for df in reader:
        plx_good = good_parallax(
            df["parallax"].values, df["parallax_error"].values
        )
        mag = df["phot_g_mean_mag"].values.astype(np.float32)
        n = len(df)
        out = np.zeros(n, dtype=DR3C_DTYPE)
        out["source_id"] = df["source_id"].values
        out["ra"] = df["ra"].values
        out["dec"] = df["dec"].values
        out["parallax"] = plx_good.astype(np.float32)
        out["mag"] = mag
        yield out


def convert_csv(gz_path, out_path, snr_min=PLX_SNR_MIN):
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


def download(url, dest, md5, retries=3, timeout=120):
    for attempt in range(retries):
        part_path = dest + ".part"
        hasher = hashlib.md5()
        try:
            with urllib.request.urlopen(url, timeout=timeout) as resp:
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
):
    os.makedirs(cache_dir, exist_ok=True)
    fetch_json_path = os.path.join(cache_dir, "fetch.json")
    if md5_list is None:
        md5_list = fetch_md5_list(base)
    if names is not None:
        name_set = {n for n in names}
        md5_list = [item for item in md5_list if item[0] in name_set]
    if limit is not None and limit > 0:
        md5_list = md5_list[:limit]
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
        if not os.path.exists(gz_path):
            progress(f"download {name}")
            download(url, gz_path, md5)
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
        # atomic write
        tmp_path = fetch_json_path + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(fetch, f, indent=2)
        os.replace(tmp_path, fetch_json_path)
        # lazy import to avoid cycle
        import pyramid

        rss = pyramid.check_rss(rss_cap, fetch_json_path)
        progress(
            f"fetch {name} n={stats['n']} plx_good={stats['n_plx_good']} "
            f"pct={fetch['pct_plx_good']:.1f} rss={rss}"
        )
        if not keep_gz and os.path.exists(gz_path):
            os.unlink(gz_path)
    return fetch


def iter_dr3c(path, chunk=65536):
    size = os.path.getsize(path)
    if size % DR3C_REC != 0:
        raise ValueError(f"{path} size {size} not multiple of {DR3C_REC}")
    # local to avoid import cycle
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
            out = np.zeros(n, dtype=REC_DTYPE)
            out["source_id"] = arr_c["source_id"]
            out["ra"] = arr_c["ra"]
            out["dec"] = arr_c["dec"]
            out["parallax"] = arr_c["parallax"].astype(np.float64)
            out["mag"] = arr_c["mag"]
            # x,y,z,colour default to 0
            yield out
