#!/usr/bin/env python3
import sys
import json
import shutil
import numpy as np
from pathlib import Path
import os

# Fix import when run from another directory
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import g1b


def convert(src: Path, dst: Path):
    dst.mkdir(parents=True, exist_ok=True)

    tiles = json.loads((src / "tiles.json").read_text())
    summary = {"packs": 0, "stars": 0, "q10_bytes": 0, "g1b_bytes": 0}

    converted_packs = set()

    for level in tiles["levels"]:
        pack_name = level.get("pack")
        if not pack_name:
            continue
        q8pk_path = src / pack_name
        if not q8pk_path.exists():
            continue

        buf = q8pk_path.read_bytes()
        if buf[:4] != b"Q8PK":
            continue

        info = g1b.read_pack_bytes(buf)

        # Use the exact order/parent_order from the source pack header
        order = info["order"]
        parent_order = info["parent_order"]

        cells = []
        for local, start, count in info["cells"]:
            cell_bytes = info["payload"][start*10:(start+count)*10].reshape(count, 10)
            cells.append((local, cell_bytes))

        g1b_bytes = g1b.pack_bytes(order, parent_order, cells)

        (dst / pack_name).write_bytes(g1b_bytes)
        converted_packs.add(pack_name)

        verified = g1b.read_pack_bytes(g1b_bytes)
        assert np.array_equal(verified["payload"], info["payload"]), "verification failed"

        level["bytes"] = len(g1b_bytes)
        summary["packs"] += 1
        summary["stars"] += sum(c[2] for c in info["cells"])
        summary["q10_bytes"] += len(info["payload"])
        summary["g1b_bytes"] += len(g1b_bytes)

    tiles["record"] = {"format": "q10", "bytes": 10, "pack": "g1b"}
    (dst / "tiles.json").write_text(json.dumps(tiles, indent=2))

    # Copy everything except tiles.json and converted .pack files
    for f in src.iterdir():
        if f.name == "tiles.json":
            continue
        if f.name in converted_packs:
            continue
        if f.is_file():
            shutil.copy2(f, dst / f.name)

    summary["bytes_per_star"] = round(summary["g1b_bytes"] / summary["stars"], 3) if summary["stars"] else 0
    return summary


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python q10_to_g1b.py SRC_PACK_DIR DST_PACK_DIR")
        sys.exit(1)
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2])
    summary = convert(src, dst)
    print(json.dumps(summary, indent=2))
