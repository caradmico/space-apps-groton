"""LSDB HATS copy of Gaia DR3 at https://data.lsdb.io/hats/gaia_dr3/gaia/ ; reads only the 7 needed columns with parallel HTTP range reads; de-duplicates by source_id; parallax kept only at SNR>=5 (dr3.good_parallax); fetch_hats writes source_id-sorted .hatsx files (tap DR3X 36-byte records) per order-2 cell for the pyramid "hats" adapter
"""

import io
import os
import json
import time
import random
import urllib.parse
import http.client
import ssl
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Tuple, Dict, Any
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pyarrow.compute as pc

import dr3
import tap


CONNECT_TIMEOUT = float(os.environ.get("HATS_CONNECT_TIMEOUT", "20"))
READ_TIMEOUT = float(os.environ.get("HATS_READ_TIMEOUT", "60"))
REQUEST_DEADLINE = float(os.environ.get("HATS_REQUEST_DEADLINE", "300"))
MAX_ATTEMPTS = int(os.environ.get("HATS_MAX_ATTEMPTS", "5"))
BACKOFF_BASE = float(os.environ.get("HATS_BACKOFF_BASE", "2.0"))
BACKOFF_MAX = float(os.environ.get("HATS_BACKOFF_MAX", "60"))

HATS_BASE = "https://data.lsdb.io/hats/gaia_dr3/gaia/"
COLUMNS = ["source_id", "ra", "dec", "parallax", "parallax_error",
           "phot_g_mean_mag", "bp_rp"]


class HatsReadError(RuntimeError):
    def __init__(self, url: str, what: str, attempts: int, last: Exception):
        self.url = url
        self.what = what
        self.attempts = attempts
        self.last = last
        msg = f"{what} {url} failed after {attempts} attempts: {last!r}; rerun the same command to resume"
        super().__init__(msg)


class _Retryable(Exception):
    pass


def _http(url: str, method: str = "GET", headers: dict = None) -> tuple[int, dict, bytes]:
    if headers is None:
        headers = {}
    headers = dict(headers)
    headers.setdefault("User-Agent", "staris-pipeline")

    parsed = urllib.parse.urlsplit(url)
    host = parsed.hostname
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    path = parsed.path
    if parsed.query:
        path += "?" + parsed.query

    start = time.monotonic()
    deadline = start + REQUEST_DEADLINE

    for hop in range(5):
        if time.monotonic() > deadline:
            raise TimeoutError(f"request deadline {REQUEST_DEADLINE}s exceeded")

        if parsed.scheme == "https":
            conn = http.client.HTTPSConnection(
                host, port, timeout=CONNECT_TIMEOUT, context=ssl.create_default_context()
            )
        else:
            conn = http.client.HTTPConnection(host, port, timeout=CONNECT_TIMEOUT)

        try:
            conn.connect()
            if conn.sock is not None:
                conn.sock.settimeout(READ_TIMEOUT)

            conn.request(method, path, headers=headers)
            resp = conn.getresponse()

            if resp.status in (301, 302, 303, 307, 308):
                location = resp.getheader("Location")
                if not location:
                    raise http.client.HTTPException("redirect without Location")
                url = urllib.parse.urljoin(url, location)
                parsed = urllib.parse.urlsplit(url)
                conn.close()
                continue

            status = resp.status
            hdrs = dict(resp.getheaders())

            if method == "HEAD":
                body = b""
            else:
                body = []
                while True:
                    if time.monotonic() > deadline:
                        raise TimeoutError(f"request deadline {REQUEST_DEADLINE}s exceeded")
                    chunk = resp.read1(1 << 16)
                    if not chunk:
                        break
                    body.append(chunk)
                body = b"".join(body)

            return status, hdrs, body
        finally:
            conn.close()

    raise http.client.HTTPException("too many redirects")


def _retry(what: str, url: str, fn):
    last = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            return fn()
        except (OSError, http.client.HTTPException, TimeoutError, _Retryable) as e:
            last = e
            if attempt == MAX_ATTEMPTS:
                break
            backoff = min(BACKOFF_MAX, BACKOFF_BASE ** (attempt - 1))
            time.sleep(backoff * random.uniform(0.5, 1.0))
        except HatsReadError:
            raise
    raise HatsReadError(url, what, attempt, last) from last


def partition_list(base: str = HATS_BASE) -> List[Tuple[int, int]]:
    url = base.rstrip("/") + "/partition_info.csv"
    def get():
        status, _, body = _http(url)
        if status != 200:
            if 500 <= status < 600 or status in (408, 429):
                raise _Retryable(f"bad status {status}")
            raise HatsReadError(url, "partition list", 1, RuntimeError(f"bad status {status}"))
        return body.decode("utf-8").strip().split("\n")
    lines = _retry("partition list", url, get)
    parts = []
    for line in lines[1:]:
        if line.strip():
            o, p = map(int, line.strip().split(","))
            parts.append((o, p))
    return parts


def partition_url(order: int, npix: int, base: str = HATS_BASE) -> str:
    d = (npix // 10000) * 10000
    return f"{base.rstrip('/')}/dataset/Norder={order}/Dir={d}/Npix={npix}.parquet"


class RangeFile(io.RawIOBase):
    def __init__(self, url: str):
        self.url = url
        self.pos = 0
        self.size = self._get_size()
        self.cache: List[Tuple[int, bytes]] = []
        self.n_requests = 0
        self.n_bytes = 0
        self._lock = threading.Lock()

    def _get_size(self) -> int:
        def head():
            status, hdrs, _ = _http(self.url, method="HEAD")
            if status != 200:
                if 500 <= status < 600 or status in (408, 429):
                    raise _Retryable(f"bad status {status}")
                raise HatsReadError(self.url, "HEAD", 1, RuntimeError(f"bad status {status}"))
            return int(hdrs.get("Content-Length", 0))
        return _retry("HEAD", self.url, head)

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        if whence == io.SEEK_SET:
            self.pos = offset
        elif whence == io.SEEK_CUR:
            self.pos += offset
        elif whence == io.SEEK_END:
            self.pos = self.size + offset
        return self.pos

    def tell(self) -> int:
        return self.pos

    def _fetch(self, start: int, end: int) -> bytes:
        def get_range():
            status, hdrs, body = _http(
                self.url,
                method="GET",
                headers={"Range": f"bytes={start}-{end-1}"},
            )
            if status not in (206, 200) or (status == 200 and start != 0):
                if 500 <= status < 600 or status in (408, 429):
                    raise _Retryable(f"bad status {status}")
                raise HatsReadError(self.url, f"range {start}-{end-1}", 1, RuntimeError(f"bad status {status}"))
            got = len(body)
            want = end - start
            if got < want and not (status == 200 and start == 0 and got >= want):
                raise _Retryable(f"short read {got}/{want}")
            if status == 200 and start == 0:
                body = body[:want]
            with self._lock:
                self.n_requests += 1
                self.n_bytes += len(body)
            return body
        return _retry(f"range {start}-{end-1}", self.url, get_range)

    def prefetch(self, ranges: List[Tuple[int, int]], workers: int = 8) -> None:
        if not ranges:
            return
        ranges = sorted(ranges)
        merged = []
        for s, l in ranges:
            e = s + l
            if merged and s - merged[-1][1] < 1_048_576:
                merged[-1] = (merged[-1][0], max(merged[-1][1], e))
            else:
                merged.append((s, e))

        spans = []
        for s, e in merged:
            while e - s > 8_388_608:
                spans.append((s, s + 8_388_608))
                s += 8_388_608
            spans.append((s, e))

        def worker(span):
            return (span[0], self._fetch(span[0], span[1]))

        with ThreadPoolExecutor(max_workers=workers) as pool:
            for start, data in pool.map(worker, spans):
                self.cache.append((start, data))

        self.cache.sort()
        i = 0
        while i < len(self.cache) - 1:
            s1, d1 = self.cache[i]
            s2, d2 = self.cache[i + 1]
            if s2 == s1 + len(d1):
                self.cache[i] = (s1, d1 + d2)
                del self.cache[i + 1]
                continue
            i += 1

    def readinto(self, b: bytearray) -> int:
        n = len(b)
        if self.pos >= self.size:
            return 0
        want_end = self.pos + n
        for start, data in self.cache:
            end = start + len(data)
            if start <= self.pos and want_end <= end:
                off = self.pos - start
                b[:n] = data[off : off + n]
                self.pos += n
                return n
        data = self._fetch(self.pos, min(want_end, self.size))
        self.cache.append((self.pos, data))
        self.cache.sort()
        got = min(len(data), n)
        b[:got] = data[:got]
        self.pos += got
        return got

    def read(self, n: int = -1) -> bytes:
        if n < 0:
            n = self.size - self.pos
        b = bytearray(n)
        got = self.readinto(b)
        return bytes(b[:got])


def read_partition(url: str, workers: int = 8) -> Tuple[np.ndarray, Dict[str, Any]]:
    t0 = time.time()
    f = RangeFile(url)
    tail = min(65536, f.size)
    f.prefetch([(f.size - tail, tail)], workers=workers)
    pf = pq.ParquetFile(f, pre_buffer=False)
    meta = pf.metadata

    ranges = []
    for rg_idx in range(meta.num_row_groups):
        rg = meta.row_group(rg_idx)
        for c_idx in range(rg.num_columns):
            col = rg.column(c_idx)
            if col.path_in_schema not in COLUMNS:
                continue
            if col.has_dictionary_page:
                off = col.dictionary_page_offset
            else:
                off = col.data_page_offset
            if off is not None and off > 0:
                ranges.append((off, col.total_compressed_size))

    f.prefetch(ranges, workers=workers)

    table = pf.read(columns=COLUMNS, use_threads=False)

    valid = pc.is_valid(table.column("source_id"))
    table = table.filter(valid)

    arrays = {}
    for name in COLUMNS:
        col = table.column(name)
        if pa.types.is_integer(col.type) or name == "source_id":
            arr = col.to_numpy(zero_copy_only=False)
        else:
            if pc.any(pc.is_null(col)):
                col = pc.fill_null(col.cast(pa.float64()), float("nan"))
            arr = col.to_numpy(zero_copy_only=False)
        arrays[name] = arr

    plx = dr3.good_parallax(arrays["parallax"], arrays["parallax_error"])
    arr = np.empty(len(arrays["source_id"]), dtype=tap.DR3X_DTYPE)
    arr["source_id"] = arrays["source_id"].astype("i8")
    arr["ra"] = arrays["ra"].astype("f8")
    arr["dec"] = arrays["dec"].astype("f8")
    arr["parallax"] = plx.astype("f4")
    arr["mag"] = arrays["phot_g_mean_mag"].astype("f4")
    arr["bp_rp"] = arrays["bp_rp"].astype("f4")

    stats = {
        "rows": len(arr),
        "bytes": f.n_bytes,
        "requests": f.n_requests,
        "seconds": time.time() - t0,
    }
    return arr, stats


def clean(arr: np.ndarray) -> Tuple[np.ndarray, int]:
    """Winner is the smallest (mag, ra, dec, parallax, bp_rp)."""
    if len(arr) == 0:
        return arr, 0
    order = np.lexsort((arr["bp_rp"], arr["parallax"], arr["dec"], arr["ra"], arr["mag"], arr["source_id"]))
    sorted_arr = arr[order]
    diff = np.diff(sorted_arr["source_id"])
    mask = np.concatenate(([True], diff != 0))
    kept = sorted_arr[mask]
    n_dropped = len(arr) - len(kept)
    return kept, n_dropped


def iter_hats(path: str, chunk: int = 65536, workers: int = 8):
    if path.startswith("http://") or path.startswith("https://"):
        arr, _ = read_partition(path, workers=workers)
        arr, _ = clean(arr)
        rec = np.zeros(len(arr), dtype=tap.REC_DTYPE_LOCAL)
        rec["source_id"] = arr["source_id"]
        rec["ra"] = arr["ra"]
        rec["dec"] = arr["dec"]
        rec["parallax"] = arr["parallax"].astype("f8")
        rec["mag"] = arr["mag"]
        rec["colour"] = tap.colour_class(arr["bp_rp"])
        for i in range(0, len(rec), chunk):
            yield rec[i : i + chunk]
    else:
        yield from tap.iter_dr3x(path, chunk=chunk)


def _manifest_path(cache_dir: str) -> str:
    return os.path.join(cache_dir, "hats.json")


def _save_manifest(manifest: Dict, cache_dir: str):
    path = _manifest_path(cache_dir)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(manifest, f, indent=2)
    os.replace(tmp, path)


def fetch_hats(
    cache_dir: str,
    partitions: List[Tuple[int, int]] = None,
    workers: int = 4,
    range_workers: int = 8,
    guard: Any = None,
    progress=print,
    base: str = HATS_BASE,
) -> Dict[str, Any]:
    os.makedirs(cache_dir, exist_ok=True)
    manifest_path = _manifest_path(cache_dir)

    if partitions is None:
        partitions = partition_list(base)

    manifest: Dict[str, Any] = {
        "version": 1,
        "base": base,
        "partitions": [f"{o}/{p}" for o, p in partitions],
        "done": [],
        "spill_sizes": {},
        "rows_in": 0,
        "dups_within": 0,
        "rows_spilled": 0,
        "plx_kept": 0,
        "seconds": [],
        "bytes_in": 0,
        "files": [],
        "dups_global": 0,
        "rows_out": 0,
        "finished": False,
    }

    if os.path.exists(manifest_path):
        with open(manifest_path) as f:
            old = json.load(f)
        if old.get("base") == base and old.get("partitions") == manifest["partitions"]:
            manifest = old
            if manifest.get("finished"):
                return manifest
            spill_dir = os.path.join(cache_dir, "spill")
            os.makedirs(spill_dir, exist_ok=True)
            for name, sz in manifest.get("spill_sizes", {}).items():
                spill = os.path.join(spill_dir, name)
                if os.path.exists(spill):
                    with open(spill, "r+b") as f:
                        f.truncate(sz)
            for name in os.listdir(spill_dir):
                if name.endswith(".spill") and name not in manifest.get("spill_sizes", {}):
                    os.unlink(os.path.join(spill_dir, name))

    done_set = set(manifest["done"])
    todo = [p for p in partitions if f"{p[0]}/{p[1]}" not in done_set]

    spill_dir = os.path.join(cache_dir, "spill")
    os.makedirs(spill_dir, exist_ok=True)

    def job(part: Tuple[int, int]):
        o, npix = part
        url = partition_url(o, npix, base)
        arr, stats = read_partition(url, workers=range_workers)
        cleaned, dups = clean(arr)
        return (o, npix, cleaned, stats, dups)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        future_to_part = {pool.submit(job, p): p for p in todo}
        for fut in as_completed(future_to_part):
            o, npix, arr, stats, dups_within = fut.result()
            key = f"{o}/{npix}"
            t_sec = stats["seconds"]

            cells = arr["source_id"] >> 55
            order = np.argsort(cells, kind="stable")
            sorted_arr = arr[order]
            sorted_cells = cells[order]

            idx = 0
            while idx < len(sorted_arr):
                cell = sorted_cells[idx]
                j = idx + 1
                while j < len(sorted_arr) and sorted_cells[j] == cell:
                    j += 1
                chunk = sorted_arr[idx:j]
                spill_path = os.path.join(spill_dir, f"o2_{cell:03d}.spill")
                with open(spill_path, "ab") as f:
                    f.write(chunk.tobytes())
                    f.flush()
                    os.fsync(f.fileno())
                manifest["spill_sizes"][f"o2_{cell:03d}.spill"] = os.path.getsize(spill_path)
                idx = j

            manifest["rows_in"] += stats["rows"]
            manifest["dups_within"] += dups_within
            manifest["rows_spilled"] += len(arr)
            manifest["bytes_in"] += stats["bytes"]
            manifest["seconds"].append(t_sec)
            manifest["done"].append(key)
            manifest["plx_kept"] += int(np.isfinite(arr["parallax"]).sum())

            _save_manifest(manifest, cache_dir)
            if guard:
                guard()

            mb = stats["bytes"] / (1024 * 1024)
            mbs = mb / t_sec if t_sec > 0 else 0.0
            progress(f"hats {o}/{npix}: rows={len(arr)} dups={dups_within} {t_sec:.1f}s {mbs:.1f} MB/s done={len(manifest['done'])}/{len(partitions)}")

    for cell in range(192):
        spill_name = f"o2_{cell:03d}.spill"
        spill_path = os.path.join(spill_dir, spill_name)
        if not os.path.exists(spill_path):
            continue
        data = np.fromfile(spill_path, dtype=tap.DR3X_DTYPE)
        cleaned, dups = clean(data)
        manifest["dups_global"] += dups
        manifest["rows_out"] += len(cleaned)

        out_name = f"GaiaSource_hats_o2_{cell:03d}.hatsx"
        out_path = os.path.join(cache_dir, out_name)
        tmp = out_path + ".tmp"
        cleaned.tofile(tmp)
        os.replace(tmp, out_path)
        os.unlink(spill_path)

    manifest["files"] = sorted([f for f in os.listdir(cache_dir) if f.endswith(".hatsx")])
    manifest["finished"] = True
    _save_manifest(manifest, cache_dir)
    return manifest
