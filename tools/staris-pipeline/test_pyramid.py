#!/usr/bin/env python3
"""Local check of the pyramid on two public tiles. No Drive, no DR3 download."""

import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pyramid

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TILES = [
    os.path.join(ROOT, "public/bin-lod/data/tiles/tile-004.bin"),
    os.path.join(ROOT, "public/bin-lod/data/tiles/tile-008.bin"),
]


def test_bytes_over_62_identity():
    # Cara's 20-shard pilot: bytes/62 is the input total, not the coarse count.
    coarse = 1_207_311
    total = 4_321_186
    deep = total - coarse
    shards = [{"size": 62 * coarse}, {"size": 62 * deep}]
    input_records = pyramid.input_record_count(shards)
    assert input_records == total
    assert input_records == sum(shard["size"] for shard in shards) // 62
    assert pyramid.identity_ok(input_records, coarse, {"7": deep}) is True
    assert pyramid.identity_ok(input_records, coarse, {"7": deep - 1}) is False
    assert pyramid.identity_ok(input_records, coarse, {"7": deep // 2, "8": deep - deep // 2}) is True


def main():
    test_bytes_over_62_identity()
    out = tempfile.mkdtemp(prefix="pyramid-")
    try:
        manifest = pyramid.run_pipeline(
            {
                "output_dir": out,
                "mode": "PILOT",
                "adapter": "drive_bin_dr1",
                "shard_paths": TILES,
                "rss_cap": 2 * 1024**3,
                "write_deep": False,
            }
        )
        report = manifest["verify"]
        assert manifest["pass"] == "done"
        assert report["hashes_match"] is True
        assert report["pass1_coarse"] == report["pass2_coarse"] == report["pack_records"]
        assert report["maxRaArcsec"] <= pyramid.load_q8().RA_ERR_ARCSEC + 1e-6
        assert report["maxDecArcsec"] <= pyramid.load_q8().DEC_ERR_ARCSEC + 1e-6
        assert report["maxMag"] <= 0.05 + 1e-9
        total_in = sum(shard["n"] for shard in manifest["shards"])
        byte_records = sum(shard["size"] // 62 for shard in manifest["shards"])
        deep = sum(manifest["deep_counts"].values())
        assert report["pass1_coarse"] + deep == total_in
        assert report["bytes_over_62"] == byte_records == total_in
        assert report["identity_ok"] is True
        assert report["bytes_over_62"] == report["pass2_coarse"] + deep
        with open(os.path.join(out, "tiles.json"), "r", encoding="utf-8") as handle:
            tiles = json.load(handle)
        assert tiles["version"] == 2
        assert tiles["scheme"] == "healpix_nested_exclusive"
        assert tiles["record"] == {"format": "q8", "bytes": 8}
        assert tiles["total_records"] == report["pack_records"]
        assert tiles["levels"]
        saw_root = False
        for level in tiles["levels"]:
            assert level["pack"].startswith("packs/")
            assert os.path.isfile(os.path.join(out, level["pack"]))
            if level["order"] == 0:
                saw_root = True
                assert level["pack_parent_order"] == -1
        assert saw_root
        assert all("/" not in level["pack"] for level in manifest["levels"])
        print("pipeline", report, "deep", deep, "in", total_in, "tiles", len(tiles["levels"]))
    finally:
        shutil.rmtree(out, ignore_errors=True)

    out = tempfile.mkdtemp(prefix="pyramid-rss-")
    try:
        try:
            pyramid.run_pipeline(
                {
                    "output_dir": out,
                    "mode": "PILOT",
                    "adapter": "drive_bin_dr1",
                    "shard_paths": TILES[:1],
                    "rss_cap": 1,
                    "write_deep": False,
                }
            )
        except pyramid.RssExceeded as exc:
            manifest = pyramid.load_manifest(out)
            assert manifest["aborted"] == "rss"
            assert os.path.exists(pyramid.manifest_path(out))
            print("rss abort", exc.rss, "checkpoint", os.path.basename(exc.checkpoint))
        else:
            raise SystemExit("expected the 1-byte RSS cap to abort")
    finally:
        shutil.rmtree(out, ignore_errors=True)


if __name__ == "__main__":
    main()
