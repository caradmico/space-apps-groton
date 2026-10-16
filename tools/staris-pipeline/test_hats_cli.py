import sys
import os
import json
import shutil
from pathlib import Path
import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import staris_run
import hats
import hats_stream
import pyramid
from test_hats import hats_server  # noqa: F401


def base_argv(out, base, tmp, *extra):
    return [
        "--out", str(out),
        "--partitions", "2/0,2/1",
        "--hats-base", base,
        "--secrets-dir", str(tmp),
        "--hats-workers", "2",
        "--range-workers", "4",
        "--pack-format", "g1b",
        *extra
    ]


def run_cli(argv, monkeypatch, cap=8, heap_m=56, corrupt=None):
    store = {}
    calls = []
    published = {}

    def make_sink(*a, **k):
        prefix = a[1]
        calls.append(("make_sink", prefix))
        def sink(local_path, name):
            key = prefix + name
            size = os.path.getsize(local_path)
            if corrupt and key.endswith(corrupt):
                size += 1
            store[key] = size
            calls.append(("sink", key))
        return sink

    def upload_file(*a, **k):
        path, key = a[0], a[1]
        size = os.path.getsize(path)
        store[key] = size
        calls.append(("upload_file", key))
        if key == "v2-dr3/current.json":
            published["current"] = json.load(open(path))
        if key.endswith("tiles.json"):
            published["tiles"] = json.load(open(path))

    def object_exists(key, size=None, **k):
        calls.append(("object_exists", key, size))
        if key not in store:
            return False
        if size is None:
            return True
        return store[key] == size

    if "--max-rss-gb" not in argv:
        argv = argv + ["--max-rss-gb", "1.0"]

    monkeypatch.setattr(sys, "argv", ["staris_run.py", "--source", "hats"] + argv)
    monkeypatch.setattr(staris_run, "make_sink", make_sink)
    monkeypatch.setattr(staris_run, "upload_file", upload_file)
    monkeypatch.setattr(staris_run, "object_exists", object_exists)
    monkeypatch.setattr(pyramid, "CAP", cap)
    monkeypatch.setattr(pyramid, "HEAP_M", heap_m)

    try:
        staris_run.main()
        return 0, calls, store, published
    except SystemExit as e:
        return e.code, calls, store, published


def test_hats_coarse_upload_refused(hats_server, monkeypatch, tmp_path):
    url, tmp_path, t0, t1, p0, p1 = hats_server
    base = url + "/"
    out = tmp_path / "out"
    argv = base_argv(out, base, tmp_path, "--coarse", "--upload", "--prefix", "probe/")
    code, calls, store, published = run_cli(argv, monkeypatch)
    assert code == 4
    assert calls == []
    assert not (out / "hats_stream").exists()


def test_hats_partitions_deep_upload_no_publish(hats_server, monkeypatch, tmp_path):
    url, tmp_path, t0, t1, p0, p1 = hats_server
    base = url + "/"
    out = tmp_path / "out"
    argv = base_argv(out, base, tmp_path, "--deep", "--upload", "--prefix", "probe/")
    code, calls, store, published = run_cli(argv, monkeypatch, cap=1, heap_m=7)
    assert code == 0

    packs = list((out / "pyramid" / "packs").glob("*.pack"))
    for p in packs:
        key = f"probe/packs/{p.name}"
        assert key in store
        assert store[key] == p.stat().st_size

    names = [k.rsplit("/", 1)[1] for k in store if k.startswith("probe/packs/") and k.endswith(".pack")]
    assert any(int(n[1:n.index("_")]) >= 7 for n in names)

    sink_calls = [c[1] for c in calls if c[0] == "sink"]
    upload_calls = [c[1] for c in calls if c[0] == "upload_file"]
    assert "probe/packs/tiles.json" in store
    tiles_i = calls.index(("upload_file", "probe/packs/tiles.json"))
    last_sink = max(i for i, c in enumerate(calls) if c[0] == "sink")
    assert tiles_i > last_sink

    assert "v2-dr3/current.json" not in store
    log = (out / "run.log").read_text()
    assert "not publishing current.json: --partitions is a test run" in log


def test_hats_full_deep_upload_publishes(hats_server, monkeypatch, tmp_path):
    url, tmp_path, t0, t1, p0, p1 = hats_server
    base = url + "/"
    out = tmp_path / "out"
    argv = [
        "--out", str(out),
        "--hats-base", base,
        "--deep",
        "--upload",
        "--prefix", "v2-dr3-test/",
        "--secrets-dir", str(tmp_path),
        "--hats-workers", "2",
        "--range-workers", "4",
        "--pack-format", "g1b",
    ]
    code, calls, store, published = run_cli(argv, monkeypatch, cap=1, heap_m=7)
    assert code == 0

    assert "v2-dr3/current.json" in store
    upload_keys = [c[1] for c in calls if c[0] == "upload_file"]
    assert upload_keys[-1] == "v2-dr3/current.json"

    assert published["current"]["prefix"] == "v2-dr3-test/"
    assert published["current"]["tiles"].endswith("/v2-dr3-test/packs/tiles.json")

    packs = list((out / "pyramid" / "packs").glob("*.pack"))
    for p in packs:
        key = f"v2-dr3-test/packs/{p.name}"
        assert key in store
        assert store[key] == p.stat().st_size
    assert "v2-dr3-test/packs/tiles.json" in store


def test_hats_upload_size_mismatch_exit7(hats_server, monkeypatch, tmp_path):
    url, tmp_path, t0, t1, p0, p1 = hats_server
    base = url + "/"
    out = tmp_path / "out"
    argv = base_argv(out, base, tmp_path, "--deep", "--upload", "--prefix", "probe/")
    code, calls, store, published = run_cli(argv, monkeypatch, cap=1, heap_m=7, corrupt="o0_p0.pack")
    assert code == 7
    assert "probe/packs/tiles.json" not in store
    assert "v2-dr3/current.json" not in store
    log = (out / "run.log").read_text()
    assert "UPLOAD VERIFY FAILED" in log


def test_hats_deep_verify_mismatch_exit5(hats_server, monkeypatch, tmp_path):
    url, tmp_path, t0, t1, p0, p1 = hats_server
    base = url + "/"
    out = tmp_path / "out"
    orig_run = hats_stream.run

    def bad_run(*a, **k):
        hm, pm = orig_run(*a, **k)
        for level in pm["levels"]:
            if int(level.get("order", 0)) >= 7:
                level["n"] -= 1
                break
        return hm, pm

    monkeypatch.setattr(hats_stream, "run", bad_run)
    argv = base_argv(out, base, tmp_path, "--deep", "--upload", "--prefix", "probe/")
    code, calls, store, published = run_cli(argv, monkeypatch, cap=1, heap_m=7)
    assert code == 5
    log = (out / "run.log").read_text()
    assert "DEEP VERIFY FAILED" in log
    assert not any(c[0] == "sink" for c in calls)
    assert not any(c[0] == "upload_file" for c in calls)


def test_hats_rss_guard_exit6_then_resume(hats_server, monkeypatch, tmp_path):
    url, tmp_path, t0, t1, p0, p1 = hats_server
    base = url + "/"
    out = tmp_path / "out"
    flag = [False]
    calls_t = [0]

    def guarded_rss():
        return 10**12 if flag[0] else 0

    orig_thresh = hats_stream.thresholds

    def thresh_wrapper(*a, **k):
        res = orig_thresh(*a, **k)
        calls_t[0] += 1
        if calls_t[0] == 1:
            flag[0] = True
        return res

    monkeypatch.setattr(pyramid, "rss_bytes", guarded_rss)
    monkeypatch.setattr(hats_stream, "thresholds", thresh_wrapper)

    argv = base_argv(out, base, tmp_path, "--coarse", "--prefix", "probe/")
    code, calls, store, published = run_cli(argv, monkeypatch, cap=1, heap_m=7)
    assert code == 6
    assert "RSS guard stop" in (out / "run.log").read_text()
    scan = json.loads((out / "hats_stream" / "scan.json").read_text())
    assert scan["finished"] is True

    flag[0] = False
    code2, _, _, _ = run_cli(argv, monkeypatch, cap=1, heap_m=7)
    assert code2 == 0

    out3 = tmp_path / "out3"
    argv3 = base_argv(out3, base, tmp_path, "--coarse", "--prefix", "probe/")
    code3, _, _, _ = run_cli(argv3, monkeypatch, cap=1, heap_m=7)
    assert code3 == 0

    packs1 = sorted((out / "pyramid" / "packs").glob("*.pack"))
    packs3 = sorted((out3 / "pyramid" / "packs").glob("*.pack"))
    assert packs1 and [p.name for p in packs1] == [p.name for p in packs3]
    for a, b in zip(packs1, packs3):
        assert a.read_bytes() == b.read_bytes()


def test_hats_rss_guard_pass1_checkpoint(hats_server, monkeypatch, tmp_path):
    url, tmp_path, t0, t1, p0, p1 = hats_server
    base = url + "/"
    out = tmp_path / "out"

    monkeypatch.setattr(pyramid, "rss_bytes", lambda: 10**12)
    argv = base_argv(out, base, tmp_path, "--coarse", "--prefix", "probe/")
    code, calls, store, published = run_cli(argv, monkeypatch, cap=1, heap_m=7)
    assert code == 6
    scan_path = out / "hats_stream" / "scan.json"
    assert scan_path.exists()
    scan = json.loads(scan_path.read_text())
    assert scan["finished"] is False
    assert len(scan.get("done", [])) > 0

    monkeypatch.setattr(pyramid, "rss_bytes", lambda: 0)
    code2, _, _, _ = run_cli(argv, monkeypatch, cap=1, heap_m=7)
    assert code2 == 0


def test_hats_low_memavailable_exit6(hats_server, monkeypatch, tmp_path):
    url, tmp_path, t0, t1, p0, p1 = hats_server
    base = url + "/"
    out = tmp_path / "out"
    monkeypatch.setattr(staris_run, "mem_available_gb", lambda: 0.5)
    argv = base_argv(out, base, tmp_path, "--coarse", "--prefix", "probe/", "--max-rss-gb", "1.0")
    code, calls, store, published = run_cli(argv, monkeypatch)
    assert code == 6
    log = (out / "run.log").read_text()
    assert "MemAvailable" in log
    assert not (out / "hats_stream").exists()


def test_hats_deep_local_no_r2(hats_server, monkeypatch, tmp_path):
    url, tmp_path, t0, t1, p0, p1 = hats_server
    base = url + "/"
    out = tmp_path / "out"
    argv = base_argv(out, base, tmp_path, "--deep", "--prefix", "probe/")
    code, calls, store, published = run_cli(argv, monkeypatch, cap=1, heap_m=7)
    assert code == 0
    assert calls == []
    log = (out / "run.log").read_text()
    assert "deep check:" in log
    assert "ok=True" in log
    tiles = out / "pyramid" / "packs" / "tiles.json"
    assert tiles.exists()
    data = json.loads(tiles.read_text())
    assert any(level.get("order", 0) >= 7 for level in data.get("levels", []))
    cache = out / "hats_cache"
    assert not list(cache.glob("*.hatsx"))
    assert list(out.rglob("current.json")) == []


def test_hats_stream_matches_batch(hats_server, monkeypatch, tmp_path):
    url, tmp_path, t0, t1, p0, p1 = hats_server
    base = url + "/"
    out_a = tmp_path / "out_a"
    calls = []
    argv = base_argv(out_a, base, tmp_path, "--coarse", "--prefix", "probe/")
    code, calls, store, published = run_cli(argv, monkeypatch)
    assert code == 0

    batch_cache = tmp_path / "batch_cache"
    batch_out = tmp_path / "batch_out"
    batch_cache.mkdir()
    manifest = hats.fetch_hats(
        str(batch_cache),
        partitions=[(2, 0), (2, 1)],
        workers=2,
        range_workers=4,
        base=base,
        progress=lambda m: None,
    )
    cfg = {
        "output_dir": str(batch_out),
        "adapter": "hats",
        "mode": "PILOT",
        "pilot_dr3": manifest["files"],
        "input_dirs": [str(batch_cache)],
        "write_deep": False,
        "pack_format": "g1b",
        "rss_cap": 4 * 1024**3,
    }
    monkeypatch.setattr(pyramid, "CAP", 8)
    monkeypatch.setattr(pyramid, "HEAP_M", 56)
    pyramid.run_pipeline(cfg, progress=lambda m: None)

    packs_a = sorted((out_a / "pyramid" / "packs").glob("*.pack"))
    packs_b = sorted((batch_out / "packs").glob("*.pack"))
    assert [p.name for p in packs_a] == [p.name for p in packs_b]
    for pa, pb in zip(packs_a, packs_b):
        assert pa.read_bytes() == pb.read_bytes()

    tiles_a = json.loads((out_a / "pyramid" / "packs" / "tiles.json").read_text())
    tiles_b = json.loads((batch_out / "packs" / "tiles.json").read_text())
    assert tiles_a == tiles_b


def test_topk_matches_heap(monkeypatch):
    rng = np.random.default_rng(3)
    n = 5000
    local = rng.integers(0, 8, n, dtype=np.int32)
    mag = rng.integers(0, 50, n).astype(np.float32)
    sid = rng.choice(10**9, n, replace=False).astype(np.int64)
    k = 20

    monkeypatch.setattr(pyramid, "HEAP_M", k)

    mag_h = np.full((8, k), np.inf, dtype=np.float32)
    sid_h = np.zeros((8, k), dtype=np.int64)
    n_h = np.zeros(8, dtype=np.int32)

    for i in range(n):
        pyramid._heap_insert(mag_h, sid_h, n_h, local[i], mag[i], sid[i])

    topk = hats_stream.topk_per_cell(local, mag, sid, k)
    topk_dup = hats_stream.topk_per_cell(
        np.concatenate([local, local]),
        np.concatenate([mag, mag]),
        np.concatenate([sid, sid]),
        k,
    )

    for loc in range(8):
        heap_items = [(float(mag_h[loc, j]), int(sid_h[loc, j])) for j in range(n_h[loc])]
        topk_items = [
            (float(topk[1][i]), int(topk[2][i]))
            for i in range(len(topk[0]))
            if topk[0][i] == loc
        ]
        assert set(heap_items) == set(topk_items)

        topk_items_dup = [
            (float(topk_dup[1][i]), int(topk_dup[2][i]))
            for i in range(len(topk_dup[0]))
            if topk_dup[0][i] == loc
        ]
        assert set(heap_items) == set(topk_items_dup)


def test_partitions_run_never_publishes(hats_server, monkeypatch, tmp_path):
    url, tmp_path, t0, t1, p0, p1 = hats_server
    base = url + "/"
    out = tmp_path / "out"
    argv = base_argv(out, base, tmp_path, "--coarse", "--deep", "--prefix", "probe/")
    code, calls, store, published = run_cli(argv, monkeypatch)
    assert code == 0
    assert calls == []
    assert list(out.rglob("current.json")) == []
