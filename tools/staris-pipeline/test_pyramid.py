#!/usr/bin/env python3
"""Local check of the pyramid on two public tiles. No Drive, no DR3 download."""

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


def main():
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
        deep = sum(manifest["deep_counts"].values())
        assert report["pass1_coarse"] + deep == total_in
        print("pipeline", report, "deep", deep, "in", total_in)
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
