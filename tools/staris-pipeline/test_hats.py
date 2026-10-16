import sys
import os
import tempfile
import threading
import http.server
import socketserver
from pathlib import Path
import time
import urllib.parse
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hats
import pyramid
import tap


def _make_test_data(rng):
    n0 = 300
    n1 = 200
    src0 = np.concatenate([
        rng.integers(0, 1<<55, 150, dtype=np.int64),
        rng.integers(1<<55, 2<<55, 150, dtype=np.int64)
    ])
    src0[10:12] = src0[20:22]  # two internal dups
    src1 = np.concatenate([
        rng.integers(1<<55, 2<<55, 100, dtype=np.int64),
        rng.integers(2<<55, 3<<55, 100, dtype=np.int64)
    ])
    src1[5] = src0[15]  # cross-partition dup

    def make_table(src):
        ra = rng.uniform(0, 360, len(src)).astype(np.float64)
        dec = rng.uniform(-90, 90, len(src)).astype(np.float64)
        plx = rng.uniform(0.1, 10.0, len(src)).astype(np.float32)
        plx_err = plx / rng.uniform(3, 20, len(src)).astype(np.float32)
        # some bad parallax
        bad = rng.random(len(src)) < 0.1
        plx[bad] = np.nan
        plx_err[bad] = np.nan
        mag = rng.uniform(5, 20, len(src)).astype(np.float32)
        mag[rng.random(len(src)) < 0.05] = np.nan
        bp_rp = rng.uniform(-0.5, 3.0, len(src)).astype(np.float32)
        bp_rp[rng.random(len(src)) < 0.05] = np.nan
        ruwe = rng.uniform(0.8, 1.5, len(src)).astype(np.float32)
        return pa.Table.from_arrays([
            pa.array(src, type=pa.int64()),
            pa.array(ra, type=pa.float64()),
            pa.array(dec, type=pa.float64()),
            pa.array(plx, type=pa.float32()),
            pa.array(plx_err, type=pa.float32()),
            pa.array(mag, type=pa.float32()),
            pa.array(bp_rp, type=pa.float32()),
            pa.array(ruwe, type=pa.float32()),
        ], names=["source_id","ra","dec","parallax","parallax_error",
                  "phot_g_mean_mag","bp_rp","ruwe"])

    t0 = make_table(src0)
    t1 = make_table(src1)
    return t0, t1, src0, src1


class RangeHandler(http.server.BaseHTTPRequestHandler):
    def do_HEAD(self):
        path = os.path.join(self.server.root, urllib.parse.unquote(self.path.split("?")[0]).lstrip("/"))
        if not os.path.isfile(path):
            self.send_error(404)
            return
        size = os.path.getsize(path)
        self.send_response(200)
        self.send_header("Content-Length", str(size))
        self.end_headers()

    def do_GET(self):
        path = os.path.join(self.server.root, urllib.parse.unquote(self.path.split("?")[0]).lstrip("/"))
        if not os.path.isfile(path):
            self.send_error(404)
            return
        size = os.path.getsize(path)
        if "Range" in self.headers:
            rng = self.headers["Range"]
            if rng.startswith("bytes="):
                parts = rng[6:].split("-")
                s = int(parts[0])
                e = int(parts[1]) if parts[1] else size - 1
                if s >= size:
                    self.send_error(416)
                    return
                e = min(e, size - 1)
                length = e - s + 1
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {s}-{e}/{size}")
                self.send_header("Content-Length", str(length))
                self.end_headers()
                with open(path, "rb") as f:
                    f.seek(s)
                    self.wfile.write(f.read(length))
                return
        self.send_response(200)
        self.send_header("Content-Length", str(size))
        self.end_headers()
        with open(path, "rb") as f:
            self.wfile.write(f.read())

    def log_message(self, format, *args):
        pass


@pytest.fixture
def hats_server(tmp_path):
    t0, t1, _, _ = _make_test_data(np.random.default_rng(42))
    base = tmp_path / "hats"
    base.mkdir()
    (base / "partition_info.csv").write_text("Norder,Npix\n2,0\n2,1\n")

    p0 = base / "dataset/Norder=2/Dir=0/Npix=0.parquet"
    p1 = base / "dataset/Norder=2/Dir=0/Npix=1.parquet"
    p0.parent.mkdir(parents=True, exist_ok=True)
    p1.parent.mkdir(parents=True, exist_ok=True)

    pq.write_table(t0, p0, row_group_size=50)
    pq.write_table(t1, p1, row_group_size=50)

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), RangeHandler)
    server.root = str(base)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://{server.server_address[0]}:{server.server_address[1]}"
    time.sleep(0.1)
    yield url, tmp_path, t0, t1, p0, p1
    server.shutdown()
    server.server_close()
    thread.join()


def test_read_partition_and_clean(hats_server):
    url, _, t0, t1, p0, p1 = hats_server
    u0 = hats.partition_url(2, 0, url + "/")
    arr0, stats0 = hats.read_partition(u0, workers=2)
    assert len(arr0) == len(t0)
    file_size = p0.stat().st_size
    assert stats0["requests"] >= 1 and stats0["bytes"] <= file_size + 65536
    # good parallax rule
    ref_good = (
        np.isfinite(t0["parallax"].to_numpy()) &
        (t0["parallax"].to_numpy() > 0) &
        np.isfinite(t0["parallax_error"].to_numpy()) &
        (t0["parallax_error"].to_numpy() > 0) &
        (t0["parallax"].to_numpy() / t0["parallax_error"].to_numpy() >= 5)
    )
    assert np.sum(ref_good) == np.sum(np.isfinite(arr0["parallax"]))
    cleaned, ndrop = hats.clean(arr0)
    assert ndrop == 2
    assert np.all(np.diff(cleaned["source_id"]) > 0)


def test_iter_hats_url(hats_server):
    url, tmp, t0, t1, p0, p1 = hats_server
    base = url + "/"
    chunks = list(hats.iter_hats(hats.partition_url(2, 0, base), chunk=100))
    all_rec = np.concatenate(chunks)
    arr, _ = hats.read_partition(hats.partition_url(2, 0, base), workers=2)
    cleaned, _ = hats.clean(arr)
    expected = hats.clean(cleaned)[0]
    reference = cleaned
    assert len(all_rec) > 1
    assert len(all_rec) == len(expected)
    assert np.array_equal(all_rec["source_id"], expected["source_id"])
    assert np.allclose(all_rec["ra"], expected["ra"], atol=1e-9)
    assert np.allclose(all_rec["dec"], expected["dec"], atol=1e-9)
    assert np.allclose(all_rec["parallax"], expected["parallax"], atol=1e-9, equal_nan=True)
    assert all_rec.dtype == tap.REC_DTYPE_LOCAL
    assert np.array_equal(all_rec["colour"], tap.colour_class(reference["bp_rp"]))


def test_fetch_hats_and_resume(hats_server):
    url, tmp, t0, t1, p0, p1 = hats_server
    cache = tmp / "cache"
    cache.mkdir()
    manifest = hats.fetch_hats(cache, partitions=[(2,0),(2,1)], workers=2,
                               range_workers=4, base=url+"/", progress=lambda x: None)
    assert manifest["rows_out"] == len(np.unique(np.concatenate([t0["source_id"].to_numpy(), t1["source_id"].to_numpy()])))
    assert manifest["dups_within"] == 2
    assert manifest["dups_global"] == 1
    assert manifest["plx_kept"] > 0
    files = sorted(manifest["files"])
    assert files == ["GaiaSource_hats_o2_000.hatsx", "GaiaSource_hats_o2_001.hatsx", "GaiaSource_hats_o2_002.hatsx"]
    for f in files:
        p = cache / f
        data = np.fromfile(p, dtype=tap.DR3X_DTYPE)
        assert len(data) > 0
        assert data.dtype == tap.DR3X_DTYPE
        assert np.all(np.diff(data["source_id"]) > 0)
        assert len(data) * 36 == p.stat().st_size

    manifest2 = hats.fetch_hats(cache, partitions=[(2,0),(2,1)], workers=2,
                                range_workers=4, base=url+"/", progress=lambda x: None)
    assert manifest2 == manifest
    assert manifest2["finished"]


def test_pyramid_hats_g1b(hats_server, tmp_path):
    url, cache_base, t0, t1, p0, p1 = hats_server
    cache = cache_base / "cache2"
    cache.mkdir()
    manifest = hats.fetch_hats(cache, partitions=[(2,0),(2,1)], workers=2,
                               range_workers=4, base=url+"/", progress=lambda x: None)
    out = tmp_path / "out"
    out.mkdir()
    cfg = {
        "output_dir": str(out),
        "adapter": "hats",
        "mode": "PILOT",
        "pilot_dr3": manifest["files"],
        "input_dirs": [str(cache)],
        "write_deep": False,
        "pack_format": "g1b",
        "rss_cap": 4 * 1024**3,
    }
    pm = pyramid.run_pipeline(cfg, progress=lambda m: None)
    assert pm["verify"]["identity_ok"]
    assert pm["verify"]["skipped_nonfinite"] > 0
    assert sum(lvl["n"] for lvl in pm["levels"]) == pm["verify"]["pass2_coarse"]

    for p in out.glob("packs/*.pack"):
        assert p.read_bytes().startswith(b"G1BK")
    for lvl in pm["levels"]:
        path = out / "packs" / lvl["pack"]
        assert path.exists()
        assert path.read_bytes().startswith(b"G1BK")
        pk = pyramid.read_pack(path)
        assert pk["payload"].size == lvl["n"] * 10

    tiles_path = out / "packs" / "tiles.json"
    with open(tiles_path) as f:
        tiles = json.load(f)
    assert tiles["record"] == {"format": "q10", "bytes": 10, "pack": "g1b"}
