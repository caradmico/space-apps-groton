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


def test_dr3_offline():
    import dr3
    import gzip
    import hashlib
    import tempfile
    import os
    import numpy as np
    import pyramid
    import json
    import pandas as pd
    import glob
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "src")
        os.makedirs(src)
        cache = os.path.join(tmp, "dr3_cache")
        os.makedirs(cache)
        name = "GaiaSource_synthetic_000000-000001.csv.gz"
        gz_path = os.path.join(src, name)
        n_rows = 3000
        sid_base = 3 << 59
        rng = np.random.default_rng(1)
        sids = sid_base + np.arange(n_rows, dtype=np.int64) * (1 << 40)
        ra = np.full(n_rows, 45.0, dtype=np.float64)
        dec = np.full(n_rows, 30.0, dtype=np.float64)
        plx = rng.uniform(1.0, 10.0, n_rows).astype(np.float64)
        plx_err = (plx / 10.0).astype(np.float64)
        mag = rng.uniform(10.0, 18.0, n_rows).astype(np.float64)
        null_mag_idx = rng.choice(n_rows, 31, replace=False)
        mag[null_mag_idx] = np.nan
        bad_plx_idx = rng.choice(n_rows, 1200, replace=False)
        plx[bad_plx_idx[:600]] = np.nan
        plx[bad_plx_idx[600:900]] = -2.0
        plx_err[bad_plx_idx[900:]] = plx[bad_plx_idx[900:]] / 2.0
        good_mask = np.isfinite(plx) & (plx > 0) & (plx_err > 0) & (plx / plx_err >= 5.0)
        n_plx_good = int(np.sum(good_mask))
        if n_plx_good > 0:
            plx_min_good = float(plx[good_mask].min())
            plx_max_good = float(plx[good_mask].max())
        df = pd.DataFrame({
            "solution_id": np.ones(n_rows, dtype=int),
            "designation": ["Gaia DR3 test"] * n_rows,
            "source_id": sids,
            "ra": ra,
            "dec": dec,
            "parallax": plx,
            "parallax_error": plx_err,
            "pm": np.zeros(n_rows, dtype=float),
            "phot_g_mean_mag": mag,
        })
        header = """# %ECSV 1.0
# ---
solution_id,designation,source_id,ra,dec,parallax,parallax_error,pm,phot_g_mean_mag
"""
        with gzip.open(gz_path, "wt", encoding="utf-8") as f:
            f.write(header)
            df.to_csv(f, index=False, header=False, na_rep="null")
        with open(gz_path, "rb") as f:
            md5 = hashlib.md5(f.read()).hexdigest()
        assert len(dr3.parse_md5sum(f"{md5}  {name}")) == 1
        plx_t = np.array([10.0, np.nan, -1.0, 4.0, 20.0])
        err_t = np.array([1.0, 1.0, 1.0, 1.0, 5.0])
        good_t = dr3.good_parallax(plx_t, err_t, 5.0)
        assert np.isfinite(good_t[0]) and good_t[0] == 10.0
        assert np.sum(np.isfinite(good_t)) == 1  # 10/1 passes; 4/1 and 20/5 are below SNR 5
        base = "file://" + src + "/"
        md5_list = [(name, md5)]
        fetch = dr3.fetch_dr3(cache, md5_list=md5_list, base=base, limit=None, snr_min=5.0, progress=lambda x: None)
        with open(os.path.join(cache, "fetch.json")) as f:
            fetch_j = json.load(f)
        assert fetch_j["n"] == n_rows
        assert fetch["n_plx_good"] == n_plx_good
        assert fetch_j["files"][name]["n_mag_null"] == 31
        cache2 = os.path.join(tmp, "cache2")
        os.makedirs(cache2)
        bad_md5_list = [(name, "deadbeef" * 8)]
        raised = False
        try:
            dr3.fetch_dr3(cache2, md5_list=bad_md5_list, base=base, limit=1, progress=lambda x: None)
        except RuntimeError:
            raised = True
        assert raised, "bad md5 should raise RuntimeError"
        fetch2 = dr3.fetch_dr3(cache, md5_list=md5_list, base=base, limit=None, snr_min=5.0, progress=lambda x: None)
        assert fetch2["files_done"] == 1
        out_dir = os.path.join(tmp, "out")
        os.makedirs(out_dir)
        q8 = pyramid.load_q8()
        manifest = pyramid.run_pipeline(
            {"output_dir": out_dir, "mode": "PILOT", "adapter": "dr3_cache", "input_dirs": [cache], "rss_cap": 2*1024**3, "write_deep": False},
            progress=lambda s: None
        )
        report = manifest["verify"]
        assert report["identity_ok"] is True
        assert report["skipped_nonfinite"] == 31
        assert report["pct_with_distance"] > 0
        deep_counts = manifest.get("deep_counts", {})
        assert report["pass2_coarse"] + sum(deep_counts.values()) + 31 == n_rows
        total_finite_dist = 0
        if n_plx_good > 0:
            dist_rel_err = q8.DIST_REL_ERR
            lower = 1000.0 / plx_max_good * (1 - dist_rel_err)
            upper = 1000.0 / plx_min_good * (1 + dist_rel_err)
            for pack_path in glob.glob(os.path.join(out_dir, "**", "*.pack"), recursive=True):
                pack = pyramid.read_pack(pack_path)
                payload = pack["payload"].reshape(-1, 10)
                decoded = q8.decode_q10(payload)
                dist_pc = decoded["dist_pc"]
                finite_mask = np.isfinite(dist_pc)
                total_finite_dist += int(np.sum(finite_mask))
                d_dec = dist_pc[finite_mask]
                if len(d_dec) > 0:
                    assert np.all((d_dec >= lower) & (d_dec <= upper))
        assert total_finite_dist == manifest.get("pass2_with_distance", 0)
    print("dr3 offline ok")


def main():
    test_bytes_over_62_identity()
    test_dr3_offline()
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
        tiles_path = os.path.join(out, "packs", "tiles.json")
        with open(tiles_path, "r", encoding="utf-8") as handle:
            tiles = json.load(handle)
        assert not os.path.exists(os.path.join(out, "tiles.json"))
        assert tiles["version"] == 2
        assert tiles["scheme"] == "healpix_nested_exclusive"
        assert tiles["record"] == {"format": "q10", "bytes": 10}
        assert tiles["total_records"] == report["pack_records"]
        assert tiles["levels"]
        saw_root = False
        for level in tiles["levels"]:
            assert "/" not in level["pack"]
            assert level["pack"].endswith(".pack")
            assert os.path.isfile(os.path.join(out, "packs", level["pack"]))
            if level["order"] == 0:
                saw_root = True
                assert level["pack"] == "o0_p0.pack"
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
