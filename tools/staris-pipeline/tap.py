import csv
import http.cookiejar
import io
import json
import os
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict, Iterator, List, Optional, Tuple

import numpy as np

try:
    from google.colab import userdata
except ImportError:
    userdata = None

TAP_URL = "https://gea.esac.esa.int/tap-server/tap"
TAP_HOST = "gea.esac.esa.int"
COLUMNS = [
    "source_id",
    "ra",
    "dec",
    "parallax",
    "parallax_error",
    "phot_g_mean_mag",
    "bp_rp",
]
ANON_MAX_ROWS = 50_000
CELLS_PER_JOB = 48
CAP = 1024
DR3X_DTYPE = np.dtype(
    [
        ("source_id", "<i8"),
        ("ra", "<f8"),
        ("dec", "<f8"),
        ("parallax", "<f4"),
        ("mag", "<f4"),
        ("bp_rp", "<f4"),
    ]
)
REC_DTYPE_LOCAL = np.dtype(
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

_opener: Optional[urllib.request.OpenerDirector] = None
_job_dir_default = "jobs"


class TapError(RuntimeError):
    pass


class DiskFull(TapError):
    pass


class _Redirect(Exception):
    def __init__(self, location: str):
        self.location = location


class _TapRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if code in (301, 302, 303, 307, 308):
            location = headers.get("Location") or headers.get("location")
            if location:
                parsed = urllib.parse.urlparse(location)
                if parsed.hostname != TAP_HOST:
                    raise TapError(f"Host pinning violation: {location}")
                if req.get_method() == "POST" and code == 303:
                    if parsed.scheme != "https":
                        raise TapError(f"Non-https redirect: {location}")
                    raise _Redirect(location)
                if parsed.hostname != TAP_HOST:
                    raise TapError(f"Host pinning violation on GET redirect: {newurl}")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _get_credential(name: str, secrets_dir: Optional[str] = None) -> Optional[str]:
    if userdata is not None:
        try:
            return userdata.get(name)
        except Exception:
            pass
    val = os.environ.get(name)
    if val:
        return val
    if secrets_dir and os.path.isdir(secrets_dir):
        direct = os.path.join(secrets_dir, name)
        if os.path.isfile(direct):
            with open(direct) as f:
                return f.read().strip()
        for fn in os.listdir(secrets_dir):
            if fn.endswith((".env", ".json")) or fn == ".env":
                p = os.path.join(secrets_dir, fn)
                try:
                    with open(p) as f:
                        txt = f.read()
                    if "=" in txt:
                        for line in txt.splitlines():
                            line = line.strip()
                            if line.startswith(name + "="):
                                return line.split("=", 1)[1].strip().strip('"').strip("'")
                except Exception:
                    continue
    return None


def login(secrets_dir: Optional[str] = None) -> bool:
    global _opener
    user = _get_credential("GAIA_USER", secrets_dir)
    pw = _get_credential("GAIA_PASSWORD", secrets_dir)
    if not user or not pw:
        return False
    cj = http.cookiejar.CookieJar()
    _opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(cj), _TapRedirectHandler()
    )
    data = urllib.parse.urlencode({"username": user, "password": pw}).encode("ascii")
    req = urllib.request.Request(
        "https://gea.esac.esa.int/tap-server/login", data=data, method="POST"
    )
    try:
        with _opener.open(req, timeout=30) as resp:
            if resp.getcode() != 200:
                raise TapError("Login HTTP error")
        return True
    except Exception as e:
        _opener = None
        raise TapError(f"Login failed: {e}") from e


def _urlopen(url: str, data: Optional[bytes] = None, timeout: int = 30) -> bytes:
    parsed = urllib.parse.urlparse(url)
    if parsed.hostname != TAP_HOST:
        raise TapError(f"Host pinning violation: {url}")
    req = urllib.request.Request(url, data=data)
    opener = _opener or urllib.request.build_opener(_TapRedirectHandler())
    with opener.open(req, timeout=timeout) as resp:
        return resp.read()


def run_async(
    adql: str, timeout: int = 600, poll: float = 2.0, retries: int = 4
) -> bytes:
    if _opener is None:
        login()
    params = {
        "REQUEST": "doQuery",
        "LANG": "ADQL",
        "FORMAT": "csv",
        "PHASE": "RUN",
        "QUERY": adql,
    }
    data = urllib.parse.urlencode(params).encode("ascii")
    post_url = f"{TAP_URL}/async"
    last_error = None
    for attempt in range(retries):
        try:
            opener = _opener or urllib.request.build_opener(_TapRedirectHandler())
            req = urllib.request.Request(post_url, data=data, method="POST")
            try:
                with opener.open(req, timeout=30) as resp:
                    job_url = resp.geturl()
            except _Redirect as redir:
                job_url = redir.location
            p = urllib.parse.urlparse(job_url)
            if p.scheme != "https" or p.hostname != TAP_HOST or "/async/" not in p.path:
                raise TapError(f"Invalid job redirect: {job_url}")
            job_base = job_url.rstrip("/")
            phase_url = f"{job_base}/phase"
            start_time = time.time()
            while True:
                time.sleep(poll)
                phase_bytes = _urlopen(phase_url, timeout=10)
                phase = phase_bytes.decode("utf-8").strip().upper()
                if phase in ("COMPLETED", "ERROR", "ABORTED"):
                    break
                if time.time() - start_time > timeout:
                    raise TapError("Job timeout")
            if phase == "COMPLETED":
                result_url = f"{job_base}/results/result"
                return _urlopen(result_url, timeout=60)
            if phase == "ERROR":
                err_url = f"{job_base}/error"
                err_text = _urlopen(err_url, timeout=10).decode("utf-8")
                raise TapError(err_text)
            raise TapError(f"Unexpected phase: {phase}")
        except Exception as e:
            last_error = e
            is_http = isinstance(e, urllib.error.HTTPError)
            if is_http and 400 <= e.code < 500 and e.code != 429:
                raise
            if is_http and e.code >= 500 or isinstance(e, urllib.error.URLError):
                pass
            elif "ERROR" in str(e).upper():
                pass
            else:
                raise
            time.sleep(1.5 * (2**attempt))
    raise TapError(f"Async failed after {retries} attempts: {last_error}") from last_error


def parse_csv(blob: bytes) -> np.ndarray:
    if not blob or not blob.strip():
        return np.empty(0, dtype=DR3X_DTYPE)
    text = blob.decode("utf-8", errors="replace")
    f = io.StringIO(text)
    reader = csv.reader(f)
    try:
        header = next(reader)
    except StopIteration:
        return np.empty(0, dtype=DR3X_DTYPE)
    header = [h.strip().lower() for h in header]
    col_idx = {h: i for i, h in enumerate(header)}
    rows = list(reader)
    if not rows:
        return np.empty(0, dtype=DR3X_DTYPE)
    cols = list(zip(*rows)) if rows else []
    n = len(rows)

    def strcol(name: str):
        idx = col_idx.get(name)
        if idx is None or idx >= len(cols):
            return [""] * n
        return cols[idx]

    def fcol(name, dtype):
        return np.array([float(v) if v not in ("", "null", "NaN", "nan") else np.nan for v in strcol(name)], dtype=dtype)

    out = np.empty(n, dtype=DR3X_DTYPE)
    out["source_id"] = np.array(strcol("source_id"), dtype=np.int64)
    out["ra"] = fcol("ra", np.float64)
    out["dec"] = fcol("dec", np.float64)
    import dr3
    out["parallax"] = dr3.good_parallax(fcol("parallax", np.float64), fcol("parallax_error", np.float64)).astype(np.float32)
    out["mag"] = fcol("phot_g_mean_mag", np.float32)
    out["bp_rp"] = fcol("bp_rp", np.float32)
    return out


def colour_class(bp_rp: Any) -> np.ndarray:
    arr = np.asarray(bp_rp, dtype=np.float32)
    scalar_input = np.isscalar(bp_rp) or arr.ndim == 0
    if scalar_input:
        arr = arr.reshape((1,))
    out = np.zeros(arr.shape, dtype=np.uint16)
    finite = np.isfinite(arr)
    out[finite & (arr < 0.8)] = 1
    out[finite & (arr >= 0.8) & (arr < 1.6)] = 2
    out[finite & (arr >= 1.6)] = 3
    if scalar_input:
        return out[0]
    return out


def iter_dr3x(path: str, chunk: int = 65536) -> Iterator[np.ndarray]:
    if not os.path.isfile(path):
        return
    size = os.path.getsize(path)
    if size % 36 != 0:
        raise ValueError(f"{path} size not multiple of 36")
    with open(path, "rb") as handle:
        while True:
            blob = handle.read(chunk * 36)
            if not blob:
                break
            arr_x = np.frombuffer(blob, dtype=DR3X_DTYPE).copy()
            n = len(arr_x)
            out = np.zeros(n, dtype=REC_DTYPE_LOCAL)
            out["source_id"] = arr_x["source_id"]
            out["ra"] = arr_x["ra"]
            out["dec"] = arr_x["dec"]
            out["parallax"] = arr_x["parallax"].astype(np.float64)
            out["mag"] = arr_x["mag"]
            out["colour"] = colour_class(arr_x["bp_rp"])
            yield out


def _cell_range(order: int, cell: int) -> Tuple[int, int]:
    shift = 59 - 2 * order
    lo = cell << shift
    hi = ((cell + 1) << shift) - 1
    return lo, hi


def _intersect_range(lo1: int, hi1: int, lo2: int, hi2: int) -> Tuple[int, int]:
    lo = max(lo1, lo2)
    hi = min(hi1, hi2)
    return (lo, hi) if lo <= hi else (0, -1)


def _source_id_condition(
    order: int, cell: int, region: Optional[Tuple[int, List[int]]] = None
) -> str:
    lo, hi = _cell_range(order, cell)
    if not region:
        return f"source_id BETWEEN {lo} AND {hi}"
    r_order, r_cells = region
    conditions = []
    for rc in r_cells:
        rlo, rhi = _cell_range(r_order, rc)
        ilo, ihi = _intersect_range(lo, hi, rlo, rhi)
        if ilo <= ihi:
            conditions.append(f"source_id BETWEEN {ilo} AND {ihi}")
    if not conditions:
        return "source_id = -1"
    if len(conditions) == 1:
        return conditions[0]
    return "(" + " OR ".join(conditions) + ")"


def _make_cell_query(
    order: int,
    cell: int,
    last_key: Optional[Tuple[float, int]],
    t_c: int,
    region: Optional[Tuple[int, List[int]]] = None,
) -> str:
    cols = ", ".join(COLUMNS)
    sid_cond = _source_id_condition(order, cell, region)
    where = f"{sid_cond} AND phot_g_mean_mag IS NOT NULL"
    top_n = CAP + t_c
    m_cond = ""
    if last_key is not None:
        m_c, _ = last_key
        m_lit = repr(float(np.float32(m_c)))
        m_cond = f" AND phot_g_mean_mag >= {m_lit}"
    q = f"SELECT TOP {top_n} {cols} FROM gaiadr3.gaia_source WHERE {where}{m_cond} ORDER BY phot_g_mean_mag, source_id"
    return f"({q})"


def _build_union_adql(
    cells: List[Tuple[int, int, Optional[Tuple[float, int]], int]],
    region: Optional[Tuple[int, List[int]]] = None,
) -> str:
    subs = [_make_cell_query(o, c, lk, tc, region) for o, c, lk, tc in cells]
    subs = [s for s in subs if s]
    if not subs:
        return "SELECT 1 AS source_id WHERE 1=0"
    return " UNION ALL ".join(subs)


def _load_tap_manifest(cache_dir: str) -> Dict:
    path = os.path.join(cache_dir, "tap.json")
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return {"level": 0, "done_jobs": {}, "counts": {}, "bytes": 0, "elapsed": 0.0}


def _save_tap_manifest(cache_dir: str, manifest: Dict):
    path = os.path.join(cache_dir, "tap.json")
    tmp = path + ".tmp"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(tmp, "w") as f:
        json.dump(manifest, f, indent=2)
    os.replace(tmp, path)


def _get_cells_for_level(
    level: int,
    region: Optional[Tuple[int, List[int]]] = None,
    limit_cells: Optional[List[int]] = None,
) -> List[int]:
    if limit_cells is not None:
        if level == 6:
            return sorted(set(limit_cells))
        shift = 6 - level
        factor = 4**shift
        ancestors = {c6 // factor for c6 in limit_cells}
        return sorted(ancestors)
    if region is None:
        return list(range(12 * (4**level)))
    r_order, r_cells = region
    cells = set()
    for rc in set(r_cells):
        if r_order == level:
            cells.add(rc)
            continue
        if r_order < level:
            factor = 4 ** (level - r_order)
            base_c = rc * factor
            for i in range(factor):
                cells.add(base_c + i)
        else:
            factor = 4 ** (r_order - level)
            anc = rc // factor
            cells.add(anc)
    return sorted(cells)


def _compute_last_keys_and_tcs(
    picks: np.ndarray, level: int, cell_of
) -> Tuple[Dict[int, Tuple[float, int]], Dict[int, int]]:
    if len(picks) == 0:
        return {}, {}
    sids = picks["source_id"].astype(np.int64)
    mags = picks["mag"]
    cells = cell_of(sids, level)
    order = np.lexsort((sids, mags, cells))
    cells_s = cells[order]
    mags_s = mags[order]
    sids_s = sids[order]
    unique, starts = np.unique(cells_s, return_index=True)
    ends = np.concatenate((starts[1:], [len(cells_s)]))
    last_dict: Dict[int, Tuple[float, int]] = {}
    tc_dict: Dict[int, int] = {}
    for u, st, en in zip(unique, starts, ends):
        last_m = float(mags_s[en - 1])
        last_s = int(sids_s[en - 1])
        last_dict[u] = (last_m, last_s)
        last_m_f32 = np.float32(last_m)
        tc = 0
        for i in range(en - 1, st - 1, -1):
            if np.float32(mags_s[i]) == last_m_f32:
                tc += 1
            else:
                break
        tc_dict[u] = tc
    return last_dict, tc_dict


def _filter_and_cap(
    arr: np.ndarray,
    batch_cells: List[int],
    level: int,
    last_dict: Dict,
    tc_dict: Dict,
    cell_of,
) -> np.ndarray:
    if len(arr) == 0:
        return arr
    sids = arr["source_id"]
    mags = arr["mag"]
    cells = cell_of(sids, level)
    batch_set = set(batch_cells)
    if not np.all(np.isin(cells, list(batch_set))):
        raise TapError(f"Rows outside requested cells at level {level}")
    keep_mask = np.ones(len(arr), dtype=bool)
    for c in batch_set:
        mask_c = cells == c
        if not np.any(mask_c):
            continue
        last = last_dict.get(c)
        if last is None:
            continue
        m_c, s_c = last
        key_le = (mags < m_c) | ((mags == m_c) & (sids <= s_c))
        keep_mask[mask_c & key_le] = False
    arr = arr[keep_mask]
    if len(arr) == 0:
        return arr
    cells = cell_of(arr["source_id"], level)
    mags = arr["mag"]
    sids = arr["source_id"]
    order = np.lexsort((sids, mags, cells))
    arr = arr[order]
    cells = cells[order]
    unique_c, starts = np.unique(cells, return_index=True)
    ends = np.concatenate((starts[1:], [len(cells)]))
    keep_idx = []
    for st, en, _ in zip(starts, ends, unique_c):
        keep_idx.extend(range(st, min(st + CAP, en)))
    if not keep_idx:
        return np.empty(0, dtype=DR3X_DTYPE)
    return arr[np.array(keep_idx)]


def _build_picks_for_level(cache_dir: str, level: int, cell_of):
    jobs_dir = os.path.join(cache_dir, "jobs")
    picks_dir = os.path.join(cache_dir, "picks")
    os.makedirs(picks_dir, exist_ok=True)
    pick_arrays = defaultdict(list)
    for fn in os.listdir(jobs_dir):
        if fn.startswith(f"L{level}_") and fn.endswith(".dr3x"):
            path = os.path.join(jobs_dir, fn)
            if os.path.getsize(path) == 0:
                continue
            arr = np.fromfile(path, dtype=DR3X_DTYPE)
            if len(arr) == 0:
                continue
            sids = arr["source_id"]
            mags = arr["mag"]
            bases = cell_of(sids, 0)
            for b in range(12):
                mask = bases == b
                if np.any(mask):
                    pdt = [("source_id", "i8"), ("mag", "f4")]
                    pa = np.zeros(np.sum(mask), dtype=pdt)
                    pa["source_id"] = sids[mask]
                    pa["mag"] = mags[mask]
                    pick_arrays[b].append(pa)
    for b, lst in pick_arrays.items():
        if lst:
            allp = np.concatenate(lst)
            ppath = os.path.join(picks_dir, f"L{level}_b{b:02d}.npy")
            tmpp = ppath + ".tmp"
            with open(tmpp, "wb") as fh:
                np.save(fh, allp)
            os.replace(tmpp, ppath)


def _load_previous_picks(cache_dir: str, k: int, base: int) -> np.ndarray:
    picks_dir = os.path.join(cache_dir, "picks")
    arrays = []
    for lvl in range(k):
        ppath = os.path.join(picks_dir, f"L{lvl}_b{base:02d}.npy")
        if os.path.exists(ppath):
            arrays.append(np.load(ppath))
    if not arrays:
        dt = [("source_id", "i8"), ("mag", "f4")]
        return np.empty(0, dtype=dt)
    return np.concatenate(arrays)


def fetch_coarse(
    cache_dir: str,
    cells_per_job: int = CELLS_PER_JOB,
    workers: int = 4,
    rss_cap: int = 2 * 1024**3,
    progress=print,
    levels=range(7),
    limit_cells: Optional[List[int]] = None,
    region: Optional[Tuple[int, List[int]]] = None,
    runner=run_async,
    pilot_order2: Optional[List[int]] = None,
    secrets_dir: Optional[str] = None,
    guard=None,
) -> Dict:
    t_start = time.time()
    os.makedirs(cache_dir, exist_ok=True)
    manifest = _load_tap_manifest(cache_dir)
    if region is None:
        region = (2, pilot_order2) if pilot_order2 else None
    if limit_cells is not None:
        region = (6, limit_cells)
    from pyramid import cell_of, check_rss
    for level in levels:
        if manifest.get("level", 0) > level:
            continue
        progress(f"Starting level {level}")
        jobs_dir = os.path.join(cache_dir, "jobs")
        os.makedirs(jobs_dir, exist_ok=True)
        picks_dir = os.path.join(cache_dir, "picks")
        os.makedirs(picks_dir, exist_ok=True)
        cells = _get_cells_for_level(level, region, limit_cells)
        if not cells:
            manifest["level"] = level + 1
            _save_tap_manifest(cache_dir, manifest)
            continue
        cell_to_last = {}
        cell_to_tc = {}
        for b in range(12):
            prev = _load_previous_picks(cache_dir, level, b)
            if len(prev) > 0:
                last_d, tc_d = _compute_last_keys_and_tcs(prev, level, cell_of)
                cell_to_last.update(last_d)
                cell_to_tc.update(tc_d)
        max_tc = max(cell_to_tc.values()) if cell_to_tc else 0
        eff = CAP + max_tc
        cur_cpj = min(cells_per_job, max(1, ANON_MAX_ROWS // eff))
        jobs = []
        for i in range(0, len(cells), cur_cpj):
            batch = cells[i : i + cur_cpj]
            job_idx = i // cur_cpj
            jobs.append((job_idx, batch))
        done_jobs = manifest.get("done_jobs", {})
        with ThreadPoolExecutor(max_workers=workers) as pool:
            future_to_job = {}
            for job_idx, batch in jobs:
                key = f"L{level}_{job_idx}"
                job_path = os.path.join(jobs_dir, f"L{level}_{job_idx:05d}.dr3x")
                if os.path.exists(job_path) or key in done_jobs:
                    progress(f"Skipping done {key}")
                    continue
                if guard is not None:
                    guard()
                cell_list = []
                for c in batch:
                    lk = cell_to_last.get(c)
                    tc = cell_to_tc.get(c, 0)
                    cell_list.append((level, c, lk, tc))
                adql = _build_union_adql(cell_list, region)
                fut = pool.submit(runner, adql)
                future_to_job[fut] = (job_idx, batch, job_path, key)
            for fut in as_completed(future_to_job):
                job_idx, batch, job_path, key = future_to_job[fut]
                csvb = fut.result()
                manifest["bytes"] = manifest.get("bytes", 0) + len(csvb)
                arr = parse_csv(csvb)
                accepted = _filter_and_cap(
                    arr, batch, level, cell_to_last, cell_to_tc, cell_of
                )
                if len(accepted) > 0:
                    tmp = job_path + ".tmp"
                    accepted.tofile(tmp)
                    os.replace(tmp, job_path)
                    check_rss(rss_cap, job_path)
                count = len(accepted)
                manifest.setdefault("done_jobs", {})[key] = count
                manifest.setdefault("counts", {})[key] = count
                _save_tap_manifest(cache_dir, manifest)
                progress(f"Level {level} job {job_idx}: {count} rows")
        _build_picks_for_level(cache_dir, level, cell_of)
        manifest["level"] = level + 1
        _save_tap_manifest(cache_dir, manifest)
    jobs_dir = os.path.join(cache_dir, "jobs")
    final_files = []
    total_r = 0
    for b in range(12):
        base_arrs = []
        for lvl in levels:
            for fn in os.listdir(jobs_dir):
                if fn.startswith(f"L{lvl}_") and fn.endswith(".dr3x"):
                    pth = os.path.join(jobs_dir, fn)
                    if os.path.getsize(pth) > 0:
                        a = np.fromfile(pth, dtype=DR3X_DTYPE)
                        if len(a) > 0:
                            bs = cell_of(a["source_id"], 0)
                            m = bs == b
                            if np.any(m):
                                base_arrs.append(a[m])
        if base_arrs:
            allb = np.concatenate(base_arrs)
            allb.sort(order="source_id")
            outp = os.path.join(cache_dir, f"GaiaSource_tap_b{b:02d}.dr3x")
            tmp = outp + ".tmp"
            allb.tofile(tmp)
            os.replace(tmp, outp)
            final_files.append(outp)
            total_r += len(allb)
    np.savez(
        os.path.join(cache_dir, "coarse_counts.npz"),
        counts=json.dumps(manifest.get("counts", {})),
    )
    manifest["files"] = final_files
    manifest["rows"] = total_r
    manifest["elapsed"] = manifest.get("elapsed", 0.0) + (time.time() - t_start)
    _save_tap_manifest(cache_dir, manifest)
    for dname in ("jobs", "picks"):
        pth = os.path.join(cache_dir, dname)
        if os.path.isdir(pth):
            shutil.rmtree(pth)
    progress("coarse fetch completed")
    return manifest


def estimate(
    workers: int = 4,
    deep_workers: int = 6,
    coarse_job_s: float = 7.4,
    deep_page_s: float = 14.0,
    total_rows: int = 1_811_709_771,
) -> Dict[str, Any]:
    max_coarse = 67_104_768
    cells_per_lvl = [12 * (4**l) for l in range(7)]
    jobs_per_lvl = [(c + CELLS_PER_JOB - 1) // CELLS_PER_JOB for c in cells_per_lvl]
    coarse_jobs = sum(jobs_per_lvl)
    csv_b = int(max_coarse * 107)
    dr3x_b = int(max_coarse * 36)
    deep_r = total_rows - max_coarse
    page_rows = ANON_MAX_ROWS
    deep_pages = (deep_r + page_rows - 1) // page_rows
    deep_pack_b = int(deep_r * 10)
    coarse_h = (coarse_jobs * coarse_job_s) / workers / 3600.0
    deep_h = (deep_pages * deep_page_s) / deep_workers / 3600.0
    return {
        "rows": total_rows,
        "jobs": coarse_jobs,
        "csv_bytes": csv_b,
        "dr3x_bytes": dr3x_b,
        "deep_pages": deep_pages,
        "deep_q10_pack_bytes": deep_pack_b,
        "coarse_hours": round(coarse_h, 2),
        "deep_hours": round(deep_h, 2),
    }


def iter_deep_unit(
    order2_cell: int,
    workers: int = 6,
    page_rows: int = ANON_MAX_ROWS,
    runner=run_async,
    job_dir: Optional[str] = None,
    guard=None,
    progress=print,
    stats: Optional[Dict] = None,
    o6_cells: Optional[List[int]] = None,
) -> Iterator[Tuple[int, np.ndarray]]:
    if job_dir is None:
        job_dir = _job_dir_default
    os.makedirs(job_dir, exist_ok=True)
    if stats is None:
        stats = {}
    stats.setdefault("null_mag", 0)
    if _opener is None:
        login()
    if _opener:
        page_rows = 2_000_000
        workers = min(5, workers)
    base_o6 = order2_cell * 256
    worker_ranges = []
    if o6_cells is None:
        for w in range(workers):
            start_o6 = base_o6 + (w * 256 // workers)
            end_o6 = base_o6 + ((w + 1) * 256 // workers)
            lo = start_o6 << 47
            hi = ((end_o6 << 47) - 1) if end_o6 > start_o6 else (start_o6 << 47) + (1 << 47) - 1
            worker_ranges.append((w, lo, hi, start_o6, end_o6))
    else:
        runs = []
        for c in sorted(o6_cells):
            if not runs or runs[-1][1] + 1 != c:
                runs.append([c, c])
            else:
                runs[-1][1] = c
        for w, (first, last) in enumerate(runs):
            lo = first << 47
            hi = ((last + 1) << 47) - 1
            worker_ranges.append((w, lo, hi, first, last + 1))
    def worker_func(w: int, lo: int, hi: int):
        if guard is not None:
            guard()
        done_path = os.path.join(job_dir, f"d{order2_cell:03d}_w{w}.done")
        if os.path.exists(done_path):
            return
        last_sid = lo - 1
        page = 0
        page_path_pat = os.path.join(
            job_dir, f"d{order2_cell:03d}_w{w}_p{{:05d}}.dr3x"
        )
        while True:
            existing_pages = [
                int(fn.split("_p")[1].split(".")[0])
                for fn in os.listdir(job_dir)
                if fn.startswith(f"d{order2_cell:03d}_w{w}_p") and fn.endswith(".dr3x")
            ]
            if existing_pages:
                max_p = max(existing_pages)
                last_page_path = page_path_pat.format(max_p)
                if os.path.exists(last_page_path):
                    last_arr = np.fromfile(last_page_path, dtype=DR3X_DTYPE)
                    if len(last_arr) > 0:
                        last_sid = int(last_arr["source_id"][-1])
                        page = max_p + 1
            adql = (
                f"SELECT TOP {page_rows} {', '.join(COLUMNS)} FROM gaiadr3.gaia_source "
                f"WHERE source_id > {last_sid} AND source_id <= {hi} "
                f"ORDER BY source_id"
            )
            csvb = runner(adql)
            arr = parse_csv(csvb)
            if len(arr) == 0:
                with open(done_path, "w") as f:
                    f.write("done")
                break
            ppath = page_path_pat.format(page)
            tmp = ppath + ".tmp"
            arr.tofile(tmp)
            os.replace(tmp, ppath)
            last_sid = int(arr["source_id"][-1])
            page += 1
            if len(arr) < page_rows:
                with open(done_path, "w") as f:
                    f.write("done")
                break
            if guard is not None:
                guard()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = []
        for w, lo, hi, _, _ in worker_ranges:
            futures.append(pool.submit(worker_func, w, lo, hi))
        for fut in as_completed(futures):
            fut.result()
    from pyramid import cell_of, REC_DTYPE
    for o6_offset in range(256):
        o6 = base_o6 + o6_offset
        o6_lo, o6_hi = _cell_range(6, o6)
        collected = []
        page_files = sorted(
            [
                os.path.join(job_dir, fn)
                for fn in os.listdir(job_dir)
                if fn.startswith(f"d{order2_cell:03d}_") and fn.endswith(".dr3x")
            ],
            key=lambda p: int(p.split("_p")[-1].split(".")[0]) + int(p.split("_w")[-1].split("_p")[0]) * 100000,
        )
        for pfile in page_files:
            for chunk in iter_dr3x(pfile):
                if "mag" in chunk.dtype.names and np.any(np.isnan(chunk["mag"])):
                    stats["null_mag"] += int(np.sum(np.isnan(chunk["mag"])))
                mask = (chunk["source_id"] >= o6_lo) & (chunk["source_id"] <= o6_hi)
                if np.any(mask):
                    collected.append(chunk[mask].copy())
        if collected:
            unit = np.concatenate(collected)
            unit.sort(order="source_id")
            yield o6, unit.astype(REC_DTYPE)
    progress(f"Deep unit for order2_cell {order2_cell} completed")


def cleanup_deep_unit(job_dir: str, order2_cell: int):
    if not os.path.isdir(job_dir):
        return
    for fn in list(os.listdir(job_dir)):
        if fn.startswith(f"d{order2_cell:03d}_") and (
            fn.endswith(".dr3x") or fn.endswith(".done")
        ):
            try:
                os.remove(os.path.join(job_dir, fn))
            except Exception:
                pass


def main_estimate():
    est = estimate()
    print(json.dumps(est, indent=2))


if __name__ == "__main__":
    main_estimate()
