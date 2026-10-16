import sys
import os
import json
import re
import threading
import time
import gc
import hashlib
import weakref
import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hats
import hats_stream
import pyramid
import tap
import staris_run
from test_hats import hats_server  # noqa: F401
from test_hats_cli import base_argv, run_cli


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------

def file_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def make_fake(rows, order):
    reads = {"n": 0}
    lock = threading.Lock()

    def fake(url, workers=8):
        m = re.search(r"Norder=(\d+).*Npix=(\d+)", url)
        o = int(m.group(1))
        p = int(m.group(2))
        with lock:
            reads["n"] += 1
        rng = np.random.default_rng(p)
        n = 1 << (59 - 2 * o)
        source_id = (p << (59 - 2 * o)) + np.sort(
            rng.integers(0, n, rows, dtype=np.int64)
        )
        ra = rng.uniform(0, 360, rows)
        dec = rng.uniform(-90, 90, rows)
        parallax = rng.uniform(-10, 100, rows).astype(np.float32)
        parallax[::3] = np.nan
        mag = rng.uniform(5, 21, rows).astype(np.float32)
        bp_rp = rng.uniform(-0.5, 3, rows).astype(np.float32)

        arr = np.empty(rows, dtype=tap.DR3X_DTYPE)
        arr["source_id"] = source_id
        arr["ra"] = ra
        arr["dec"] = dec
        arr["parallax"] = parallax
        arr["mag"] = mag
        arr["bp_rp"] = bp_rp
        return arr, {
            "rows": rows,
            "bytes": rows * 36,
            "requests": 1,
            "seconds": 0.0,
        }

    return fake, reads


def track_clean(monkeypatch):
    live = {"live": 0, "max": 0}
    lock = threading.Lock()
    real_clean = hats.clean

    def wrapped(arr):
        cleaned, dups = real_clean(arr)
        with lock:
            live["live"] += 1
            if live["live"] > live["max"]:
                live["max"] = live["live"]

        def finalize():
            with lock:
                live["live"] -= 1

        weakref.finalize(cleaned, finalize)
        return cleaned, dups

    monkeypatch.setattr(hats, "clean", wrapped)
    return live


class RssSampler:
    def __init__(self):
        self.base = 0
        self.peak = 0
        self._stop = False
        self._thread = None

    def __enter__(self):
        gc.collect()
        self.base = pyramid.rss_bytes()
        self.peak = self.base
        self._stop = False

        def sample():
            while not self._stop:
                self.peak = max(self.peak, pyramid.rss_bytes())
                time.sleep(0.005)

        self._thread = threading.Thread(target=sample, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *args):
        self._stop = True
        if self._thread is not None:
            self._thread.join(timeout=0.1)

    @property
    def delta(self):
        return self.peak - self.base


def report(name, **values):
    js = json.dumps(values, separators=(",", ":"))
    print(f"MEM {name} {js}")
    if os.environ.get("HATS_MEM_REPORT"):
        path = os.environ["HATS_MEM_REPORT"]
        with open(path, "a") as f:
            obj = dict(values, test=name)
            f.write(json.dumps(obj) + "\n")


# ----------------------------------------------------------------------
# Tests
# ----------------------------------------------------------------------


def test_pass1_many_partitions_bounded(monkeypatch, tmp_path):
    monkeypatch.setattr(pyramid, "HEAP_M", 64)
    parts = [(3, p) for p in range(220)]
    fake, reads = make_fake(400_000, 3)
    monkeypatch.setattr(hats, "read_partition", fake)
    clean_stats = track_clean(monkeypatch)

    work = str(tmp_path / "w")
    with RssSampler() as sampler:
        sc = hats_stream.scan(
            work,
            parts,
            base="http://fake/",
            workers=4,
            range_workers=1,
            progress=lambda m: None,
        )

    assert reads["n"] == 220
    assert sc["finished"]
    assert len(sc["plan"]) == 220
    assert clean_stats["max"] <= 6
    assert sampler.delta < 500 * 2**20

    report(
        "pass1_bounded",
        delta_mb=round(sampler.delta / 2**20, 1),
        clean_max=clean_stats["max"],
        reads=reads["n"],
    )


def test_pass1_guard_stops_downloads_then_resumes(monkeypatch, tmp_path):
    monkeypatch.setattr(pyramid, "HEAP_M", 64)
    parts = [(3, p) for p in range(220)]
    fake, reads = make_fake(50_000, 3)
    monkeypatch.setattr(hats, "read_partition", fake)
    clean_stats = track_clean(monkeypatch)

    clean_work = str(tmp_path / "clean")
    sc_clean = hats_stream.scan(
        clean_work,
        parts,
        base="http://fake/",
        workers=4,
        range_workers=1,
        progress=lambda m: None,
    )
    state_clean = hats_stream.thresholds(clean_work)

    trip_work = str(tmp_path / "trip")
    reads["n"] = 0
    with pytest.raises(pyramid.RssExceeded):
        hats_stream.scan(
            trip_work,
            parts,
            base="http://fake/",
            workers=4,
            range_workers=1,
            progress=lambda m: None,
            rss_cap=1,
        )

    trip_reads = reads["n"]
    assert trip_reads <= 8
    with open(os.path.join(trip_work, "scan.json")) as f:
        sc_trip = json.load(f)
    assert not sc_trip.get("finished", False)
    assert len(sc_trip.get("done", [])) >= 1

    # resume without cap
    reads["n"] = 0
    sc_final = hats_stream.scan(
        trip_work,
        parts,
        base="http://fake/",
        workers=4,
        range_workers=1,
        progress=lambda m: None,
    )
    assert sc_final["finished"]
    assert len(sc_final["plan"]) == 220

    state_final = hats_stream.thresholds(trip_work)
    for k in ("tau_mag", "tau_sid", "counts"):
        assert len(state_final[k]) == len(state_clean[k])
        for a, b in zip(state_final[k], state_clean[k]):
            assert np.array_equal(a, b)
    for k in ("hash_sum", "hash_xor", "hash_count"):
        assert np.array_equal(state_final[k], state_clean[k])

    report("pass1_trip", trip_reads=trip_reads, resume_reads=reads["n"])


def test_pass2_many_partitions_bounded_and_resume(monkeypatch, tmp_path):
    monkeypatch.setattr(pyramid, "HEAP_M", 64)
    parts = [(6, p) for p in range(220)]
    fake, reads = make_fake(60_000, 6)
    monkeypatch.setattr(hats, "read_partition", fake)
    clean_stats = track_clean(monkeypatch)

    def pass2(work, rss_cap=None):
        sc = hats_stream.scan(
            work,
            parts,
            base="http://fake/",
            workers=4,
            range_workers=1,
            progress=lambda m: None,
        )
        reads["n"] = 0
        digests = []
        total_rows = 0
        for info in hats_stream.iter_units(
            work,
            os.path.join(work, "cache"),
            sc,
            base="http://fake/",
            workers=4,
            range_workers=1,
            progress=lambda m: None,
            keep_files=True,
            rss_cap=rss_cap,
        ):
            digests.append(file_sha256(info["path"]))
            total_rows += info["n"]
        return digests, total_rows

    # clean run
    a = str(tmp_path / "a")
    with RssSampler() as sampler:
        clean_digests, clean_rows = pass2(a)
    assert clean_rows > 0
    assert reads["n"] == 220
    assert clean_stats["max"] <= 6
    assert sampler.delta < 400 * 2**20
    report("pass2_bounded", delta_mb=round(sampler.delta / 2**20, 1))

    # trip run
    b = str(tmp_path / "b")
    sc_b = hats_stream.scan(
        b,
        parts,
        base="http://fake/",
        workers=4,
        range_workers=1,
        progress=lambda m: None,
    )
    reads["n"] = 0
    with pytest.raises(pyramid.RssExceeded):
        list(
            hats_stream.iter_units(
                b,
                os.path.join(b, "cache"),
                sc_b,
                base="http://fake/",
                workers=4,
                range_workers=1,
                progress=lambda m: None,
                keep_files=True,
                rss_cap=1,
            )
        )
    assert reads["n"] <= 8
    report("pass2_trip", trip_reads=reads["n"])
    assert os.path.exists(os.path.join(b, "pass2.json"))
    with open(os.path.join(b, "pass2.json")) as f:
        pass2_state = json.load(f)
    assert len(pass2_state.get("fetched", [])) >= 1

    # resume
    reads["n"] = 0
    sc_b2 = hats_stream.scan(
        b,
        parts,
        base="http://fake/",
        workers=4,
        range_workers=1,
        progress=lambda m: None,
    )
    resume_digests, resume_rows = pass2(b)
    assert resume_digests == clean_digests
    assert resume_rows == clean_rows
    assert reads["n"] == 220 - len(pass2_state.get("fetched", []))


def test_pass2_finalize_resumes_at_next_subcell(monkeypatch, tmp_path):
    monkeypatch.setattr(pyramid, "HEAP_M", 64)
    parts = [(5, p) for p in range(4)]
    fake, reads = make_fake(20_000, 5)
    monkeypatch.setattr(hats, "read_partition", fake)

    a = str(tmp_path / "a")
    clean_digests = []
    sc_a = hats_stream.scan(
        a,
        parts,
        base="http://fake/",
        workers=4,
        range_workers=1,
        progress=lambda m: None,
    )
    for info in hats_stream.iter_units(
        a,
        os.path.join(a, "cache"),
        sc_a,
        base="http://fake/",
        workers=4,
        range_workers=1,
        progress=lambda m: None,
        keep_files=True,
    ):
        clean_digests.append(file_sha256(info["path"]))

    b = str(tmp_path / "b")
    flag = {"set": False}
    calls = {"n": 0}
    real_atomic = hats_stream._atomic_write_json

    def wrap_atomic(path, obj):
        calls["n"] += 1
        if calls["n"] == 3:
            flag["set"] = True
        real_atomic(path, obj)

    monkeypatch.setattr(hats_stream, "_atomic_write_json", wrap_atomic)
    real_rss = pyramid.rss_bytes

    def fake_rss():
        if flag["set"]:
            return 2**41
        return real_rss()

    monkeypatch.setattr(pyramid, "rss_bytes", fake_rss)

    sc_b = hats_stream.scan(
        b,
        parts,
        base="http://fake/",
        workers=4,
        range_workers=1,
        progress=lambda m: None,
    )
    with pytest.raises(pyramid.RssExceeded):
        list(
            hats_stream.iter_units(
                b,
                os.path.join(b, "cache"),
                sc_b,
                base="http://fake/",
                workers=4,
                range_workers=1,
                progress=lambda m: None,
                keep_files=True,
                rss_cap=2**40,
            )
        )
    assert os.path.exists(os.path.join(b, "finalize.json"))
    with open(os.path.join(b, "finalize.json")) as f:
        fin = json.load(f)
    assert fin["next"] >= 3

    # resume
    flag["set"] = False
    calls["n"] = 0
    sc_b2 = hats_stream.scan(
        b,
        parts,
        base="http://fake/",
        workers=4,
        range_workers=1,
        progress=lambda m: None,
    )
    resume_digests = []
    for info in hats_stream.iter_units(
        b,
        os.path.join(b, "cache"),
        sc_b2,
        base="http://fake/",
        workers=4,
        range_workers=1,
        progress=lambda m: None,
        keep_files=True,
    ):
        resume_digests.append(file_sha256(info["path"]))
    assert resume_digests == clean_digests


def test_cli_write_pass_stop_resumes_byte_identical(
    hats_server, monkeypatch, tmp_path
):
    url, tmp, *_ = hats_server
    base = url + "/"
    clean_dir = tmp_path / "clean"
    stop_dir = tmp_path / "stop"

    argv = base_argv(clean_dir, base, tmp_path, "--coarse", "--deep", "--prefix", "probe/")
    ret, _, _, _ = run_cli(argv, monkeypatch, cap=1, heap_m=7)
    assert ret == 0

    # stop on first check_rss
    calls = {"n": 0}
    real_check = pyramid.check_rss

    def stop_first(cap, checkpoint):
        calls["n"] += 1
        if calls["n"] == 1:
            raise pyramid.RssExceeded(10**12, 1, "test")
        return real_check(cap, checkpoint)

    monkeypatch.setattr(pyramid, "check_rss", stop_first)

    argv_stop = base_argv(stop_dir, base, tmp_path, "--coarse", "--deep", "--prefix", "probe/")
    ret, _, _, _ = run_cli(argv_stop, monkeypatch, cap=1, heap_m=7)
    assert ret == 6

    ckpt_path = stop_dir / "pyramid" / "stream_ckpt.json"
    assert ckpt_path.exists()
    with open(ckpt_path) as f:
        ckpt = json.load(f)
    assert len(ckpt.get("shards", [])) == 1

    # resume
    monkeypatch.setattr(pyramid, "check_rss", real_check)
    ret, _, _, _ = run_cli(argv_stop, monkeypatch, cap=1, heap_m=7)
    assert ret == 0
    log_text = (stop_dir / "run.log").read_text()
    assert "resuming write pass after 1 shards" in log_text

    clean_pack = clean_dir / "pyramid" / "packs"
    stop_pack = stop_dir / "pyramid" / "packs"
    clean_packs = {f for f in os.listdir(clean_pack) if f.endswith(".pack")}
    stop_packs = {f for f in os.listdir(stop_pack) if f.endswith(".pack")}
    assert clean_packs == stop_packs
    for f in clean_packs:
        c = clean_pack / f
        s = stop_pack / f
        assert c.read_bytes() == s.read_bytes()
    clean_tiles = clean_dir / "pyramid" / "packs" / "tiles.json"
    stop_tiles = stop_dir / "pyramid" / "packs" / "tiles.json"
    assert clean_tiles.read_bytes() == stop_tiles.read_bytes()
