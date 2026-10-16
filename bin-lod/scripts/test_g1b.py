import sys
import os
from pathlib import Path
import tempfile
import numpy as np
import pytest
import struct

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import g1b
import q10_to_g1b


def test_g1b_roundtrip():
    rng = np.random.default_rng(123)
    n_cells = 5
    cells = []
    for i in range(n_cells):
        if i == 0:
            q = np.zeros((0, 10), dtype=np.uint8)
        elif i == 1:
            q = rng.integers(0, 256, (1, 10), dtype=np.uint8)
        else:
            q = rng.integers(0, 256, (rng.integers(10, 100), 10), dtype=np.uint8)
        cells.append((i, q))

    buf = g1b.pack_bytes(4, 255, cells)
    parsed = g1b.read_pack_bytes(buf)
    assert parsed["magic"] == "G1BK"
    assert parsed["version"] == 1
    assert parsed["order"] == 4
    assert parsed["parent_order"] == 255
    assert len(parsed["cells"]) == n_cells
    for (local, q), (loc2, start, count) in zip(cells, parsed["cells"]):
        assert local == loc2
        assert count == len(q)
        assert np.array_equal(q, parsed["payload"][start*10:(start+count)*10].reshape(-1,10))


def test_q8pk_handbuilt():
    # minimal Q8PK
    header = struct.pack("<4sBBHI", b"Q8PK", 3, 255, 0, 2)
    entries = struct.pack("<III", 0, 0, 1) + struct.pack("<III", 1, 1, 10)
    payload = np.zeros(20, dtype=np.uint8).tobytes()
    buf = header + entries + payload
    parsed = g1b.read_pack_bytes(buf)
    assert parsed["magic"] == "Q8PK"
    assert parsed["order"] == 3
    assert parsed["parent_order"] == 255
    assert len(parsed["cells"]) == 2


def test_decode_cell_raises():
    with pytest.raises(ValueError):
        g1b.decode_cell(b"abc", 10)


def test_q10_to_g1b(tmp_path):
    src = Path(__file__).resolve().parent.parent / "data" / "v2-pilot"
    if not src.exists():
        pytest.skip("pilot data not present")
    dst = tmp_path / "g1b_out"
    summary = q10_to_g1b.convert(src, dst)
    assert summary["stars"] > 1000
    assert summary["bytes_per_star"] < 10.0

    with open(src / "tiles.json") as f:
        import json
        tiles = json.load(f)
    total = sum(l["n"] for l in tiles.get("levels", []))
    assert summary["stars"] == total

    for level in tiles.get("levels", []):
        name = level["pack"]
        src_pack = g1b.read_pack_bytes((src / name).read_bytes())
        dst_pack = g1b.read_pack_bytes((dst / name).read_bytes())  # *.pack kept
        assert np.array_equal(src_pack["payload"], dst_pack["payload"])
