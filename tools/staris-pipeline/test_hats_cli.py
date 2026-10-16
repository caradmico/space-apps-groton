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


def run_cli(argv, calls, monkeypatch, cap=8, heap_m=56):
    def upload_file(*a, **k):
        calls.append(("upload_file", a))

    def object_exists(*a, **k):
        calls.append(("object_exists", a))
        return False

    def make_sink(*a, **k):
        calls.append(("make_sink", a))
        return lambda p, n: calls.append(("sink", n))

    monkeypatch.setattr(sys, "argv", ["staris_run.py", "--source", "hats"] + argv)
    monkeypatch.setattr(staris_run, "make_sink", make_sink)
    monkeypatch.setattr(staris_run, "upload_file", upload_file)
    monkeypatch.setattr(staris_run, "object_exists", object_exists)
    monkeypatch.setattr(pyramid, "CAP", cap)
    monkeypatch.setattr(pyramid, "HEAP_M", heap_m)

    try:
        staris_run.main()
        return 0
    except SystemExit as e:
        return e.code


def test_hats_deep_upload_partitions_refused(hats_server, monkeypatch, tmp_path):
    url, tmp_path, t0, t1, p0, p1 = hats_server
    base = url + "/"
    out = tmp_path / "out"
    calls = []
    argv = [
        "--out", str(out),
        "--prefix", "probe/",
        "--partitions", "2/0,2/1",
        "--hats-base", base,
        "--deep",
        "--upload",
        "--secrets-dir", str(tmp_path),
    ]
    code = run_cli(argv, calls, monkeypatch)
    assert code == 4
    assert calls == []
    assert not (out / "hats_stream").exists()
    assert not (out / "current.json").exists()
    log = (out / "run.log").read_text()
    assert "refusing: --upload is disabled for --source hats" in log


def test_hats_coarse_upload_refused(hats_server, monkeypatch, tmp_path):
    url, tmp_path, t0, t1, p0, p1 = hats_server
    base = url + "/"
    out = tmp_path / "out"
    calls = []
    argv = [
        "--out", str(out),
        "--prefix", "probe/",
        "--partitions", "2/0,2/1",
        "--hats-base", base,
        "--coarse",
        "--upload",
        "--secrets-dir", str(tmp_path),
    ]
    code = run_cli(argv, calls, monkeypatch)
    assert code == 4
    assert calls == []


def test_hats_deep_local_no_r2(hats_server, monkeypatch, tmp_path):
    url, tmp_path, t0, t1, p0, p1 = hats_server
    base = url + "/"
    out = tmp_path / "out"
    calls = []
    argv = [
        "--out", str(out),
        "--prefix", "probe/",
        "--partitions", "2/0,2/1",
        "--hats-base", base,
        "--deep",
        "--secrets-dir", str(tmp_path),
        "--hats-workers", "2",
        "--range-workers", "4",
        "--pack-format", "g1b",
    ]
    code = run_cli(argv, calls, monkeypatch, cap=1, heap_m=7)
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
    argv = [
        "--out", str(out_a),
        "--prefix", "probe/",
        "--partitions", "2/0,2/1",
        "--hats-base", base,
        "--coarse",
        "--secrets-dir", str(tmp_path),
        "--hats-workers", "2",
        "--range-workers", "4",
        "--pack-format", "g1b",
    ]
    code = run_cli(argv, calls, monkeypatch)
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
    calls = []
    argv = [
        "--out", str(out),
        "--prefix", "probe/",
        "--partitions", "2/0,2/1",
        "--hats-base", base,
        "--coarse",
        "--deep",
        "--secrets-dir", str(tmp_path),
        "--hats-workers", "2",
        "--range-workers", "4",
        "--pack-format", "g1b",
    ]
    code = run_cli(argv, calls, monkeypatch)
    assert code == 0
    assert calls == []
    assert list(out.rglob("current.json")) == []
