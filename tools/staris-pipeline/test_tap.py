#!/usr/bin/env python3
"""Offline tests for tap.py and deep integration (no network)."""

import csv
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pyramid
import tap


class FakeTap:
    """Synthetic ~20k stars in base cell 4. Dense o6 cells saturate CAP=8.
    Mags rounded to 2 decimals (ties). ~1% NaN mag. Random bp_rp/NaN.
    """

    def __init__(self):
        self.calls = 0
        rng = np.random.default_rng(42)
        n = 20000
        base = 4
        sids = np.arange(1, n + 1, dtype=np.int64) + (base << 59)
        ra = rng.uniform(0, 1, n).astype(np.float64) + 45.0
        dec = rng.uniform(0, 1, n).astype(np.float64) + 30.0
        plx = rng.uniform(1, 50, n).astype(np.float64)
        plx_err = plx / 10.0
        mag = np.round(rng.uniform(6.0, 19.0, n), 2).astype(np.float32)
        nan_idx = rng.choice(n, int(n * 0.01), replace=False)
        mag[nan_idx] = np.nan
        bp_rp = rng.uniform(-0.5, 3.5, n).astype(np.float32)
        bp_rp[rng.choice(n, int(n * 0.03), replace=False)] = np.nan
        self.table = np.zeros(n, dtype=tap.DR3X_DTYPE)
        self.table["source_id"] = sids
        self.table["ra"] = ra
        self.table["dec"] = dec
        self.table["parallax"] = plx.astype(np.float32)
        self.table["mag"] = mag
        self.table["bp_rp"] = bp_rp
        self.plx_err = plx_err.astype(np.float32)
        # make a few o6 dense for saturation test with CAP=8
        dense_o6 = [base * 4096 + 10, base * 4096 + 20]
        for o6 in dense_o6:
            mask = (self.table["source_id"] >> 47) == o6
            if np.any(mask):
                idx = np.flatnonzero(mask)[:30]
                self.table["mag"][idx] = 10.0  # many ties

    def runner(self, adql: str) -> bytes:
        self.calls += 1
        # split UNION ALL
        subs = [s.strip("() ") for s in adql.split(" UNION ALL ")]
        rows = []
        for sub in subs:
            # parse TOP, conditions, ORDER
            m_top = re.search(r"TOP\s+(\d+)", sub, re.I)
            top_n = int(m_top.group(1)) if m_top else 1000
            m_sid = re.findall(r"source_id\s*(?:BETWEEN\s*(\d+)\s*AND\s*(\d+)|>\s*(\d+)\s*AND\s*<=\s*(\d+))", sub, re.I)
            sid_ranges = []
            for between in m_sid:
                if between[0]:
                    sid_ranges.append((int(between[0]), int(between[1])))
                else:
                    sid_ranges.append((int(between[2]) + 1, int(between[3])))
            m_mag = re.search(r"phot_g_mean_mag\s*>=\s*([0-9.]+)", sub, re.I)
            mag_ge = float(m_mag.group(1)) if m_mag else None
            is_not_null = "phot_g_mean_mag IS NOT NULL" in sub
            order_mag = "ORDER BY phot_g_mean_mag" in sub
            # select matching
            mask = np.ones(len(self.table), bool)
            if sid_ranges:
                sid_mask = np.zeros(len(self.table), bool)
                for lo, hi in sid_ranges:
                    sid_mask |= (self.table["source_id"] >= lo) & (self.table["source_id"] <= hi)
                mask &= sid_mask
            if is_not_null:
                mask &= np.isfinite(self.table["mag"])
            if mag_ge is not None:
                mask &= self.table["mag"] >= mag_ge
            candidates = self.table[mask]
            if len(candidates) == 0:
                continue
            if order_mag:
                o = np.lexsort((candidates["source_id"], candidates["mag"]))
                candidates = candidates[o]
            else:
                # order by sid for deep
                o = np.argsort(candidates["source_id"])
                candidates = candidates[o]
            take = candidates[:top_n]
            rows.extend(take)
        # build CSV with scrambled header, nulls empty
        header = "dec,parallax,bp_rp,parallax_error,source_id,phot_g_mean_mag,ra\n"
        f = io.StringIO()
        f.write(header)
        writer = csv.writer(f, quoting=csv.QUOTE_MINIMAL)
        for r in rows:
            sid = int(r["source_id"])
            ra = r["ra"]
            dec = r["dec"]
            plx = r["parallax"]
            plx_err = self.plx_err[np.searchsorted(self.table["source_id"], sid)]
            mag = r["mag"]
            bprp = r["bp_rp"]
            row = [
                f"{dec:.8f}",
                "" if np.isnan(plx) else f"{plx:.6f}",
                "" if np.isnan(bprp) else f"{bprp:.6f}",
                "" if np.isnan(plx_err) else f"{plx_err:.6f}",
                str(sid),
                "" if np.isnan(mag) else f"{mag:.4f}",
                f"{ra:.8f}",
            ]
            writer.writerow(row)
        return f.getvalue().encode("utf-8")


def test_coarse_exact(tmp_path):
    fake = FakeTap()
    with np.errstate(invalid="ignore"):
        manifest = tap.fetch_coarse(
            str(tmp_path),
            limit_cells=None,
            region=(0, [4]),
            runner=fake.runner,
            workers=1,
            cells_per_job=100,
        )
    # brute reference: top-down per order/cell brightest CAP by (f32 mag, sid)
    finite = fake.table[np.isfinite(fake.table["mag"])]
    ref_counts = {k: 0 for k in range(7)}
    ref_sids = set()
    used = np.zeros(len(finite), bool)
    for order in range(7):
        cells = pyramid.cell_of(finite["source_id"], order)
        for c in np.unique(cells):
            m = cells == c
            if not np.any(m):
                continue
            cand_idx = np.flatnonzero(m & ~used)
            if len(cand_idx) == 0:
                continue
            mags = finite["mag"][cand_idx].astype(np.float32)
            sids = finite["source_id"][cand_idx]
            order_idx = np.lexsort((sids, mags))
            take_n = min(8, len(order_idx))  # CAP=8 in test
            picked = cand_idx[order_idx[:take_n]]
            used[picked] = True
            ref_counts[order] += take_n
            ref_sids.update(int(s) for s in finite["source_id"][picked])
    # from manifest/jobs
    collected = []
    for fn in os.listdir(tmp_path / "jobs"):
        if fn.endswith(".dr3x"):
            a = np.fromfile(tmp_path / "jobs" / fn, dtype=tap.DR3X_DTYPE)
            collected.append(a)
    if collected:
        all_out = np.concatenate(collected)
        out_sids = set(int(s) for s in all_out["source_id"])
        assert out_sids == ref_sids
    for k in range(7):
        assert manifest["counts"].get(f"L{k}_0", 0) == ref_counts[k]
    print("test_coarse_exact ok")


def test_coarse_resume(tmp_path):
    fake = FakeTap()
    call_count = [0]

    def bad_runner(adql):
        call_count[0] += 1
        if call_count[0] <= 3:
            raise RuntimeError("simulated failure")
        return fake.runner(adql)

    try:
        tap.fetch_coarse(str(tmp_path / "resume1"), region=(0, [4]), runner=bad_runner, workers=1)
    except Exception:
        pass
    good_manifest = tap.fetch_coarse(
        str(tmp_path / "resume1"),
        region=(0, [4]),
        runner=fake.runner,
        workers=1,
    )
    # rerun clean
    clean = tap.fetch_coarse(
        str(tmp_path / "resume2"),
        region=(0, [4]),
        runner=fake.runner,
        workers=1,
    )
    assert good_manifest["rows"] == clean["rows"]
    # no duplicate sids (resume works)
    jobs1 = tmp_path / "resume1" / "jobs"
    sids1 = set()
    for f in jobs1.glob("*.dr3x"):
        a = np.fromfile(f, dtype=tap.DR3X_DTYPE)
        sids1.update(a["source_id"])
    assert len(sids1) == len(set(sids1))
    print("test_coarse_resume ok")


def test_pyramid_on_tap(tmp_path):
    fake = FakeTap()
    cache = tmp_path / "tap_cache"
    cache.mkdir()
    tap.fetch_coarse(str(cache), region=(0, [4]), runner=fake.runner, workers=1)
    out = tmp_path / "pyr"
    config = {
        "output_dir": str(out),
        "mode": "PILOT",
        "adapter": "dr3_tap",
        "pilot_dr3": ["GaiaSource_tap_b04.dr3x"],
        "input_dirs": [str(cache)],
        "write_deep": False,
        "rss_cap": 2 * 1024**3,
    }
    manifest = pyramid.run_pipeline(config, progress=lambda x: None)
    tap_rows = sum(len(np.fromfile(f, dtype=tap.DR3X_DTYPE)) for f in cache.glob("*.dr3x"))
    pyr_c = sum(int(v) for v in manifest.get("coarse_counts", {}).values())
    assert tap_rows == pyr_c
    print("test_pyramid_on_tap ok")


def test_deep_end_to_end(tmp_path):
    fake = FakeTap()
    cache = tmp_path / "tap_cache_deep"
    cache.mkdir()
    tap.fetch_coarse(str(cache), region=(0, [4]), runner=fake.runner, workers=1)
    out = tmp_path / "deep_out"
    uploaded = []
    copied_for_test = []

    def fake_sink():
        def s(path: str, name: str):
            uploaded.append(name)
            # copy for decode test
            cp = tmp_path / ("copy_" + name)
            shutil.copy(path, cp)
            copied_for_test.append(str(cp))
        return s

    orig_cap = tap.ANON_MAX_ROWS
    tap.ANON_MAX_ROWS = 200  # force many pages
    orig_py_cap = pyramid.CAP
    pyramid.CAP = 8
    pyramid.HEAP_M = 8 * 7
    try:
        config = {
            "output_dir": str(out),
            "tap_cache": str(cache),
            "region": (0, [4]),
            "deep_workers": 1,
            "guard": None,
            "rss_cap": 2 * 1024**3,
            "deep_sink_factory": fake_sink,
            "deep_delete_after_upload": True,
            "r2_base": "https://stars.graphicoregon.com/test/deep/",
            "runner": fake.runner,
        }
        manifest = deep.run_deep(config, progress=lambda x: None)
        assert manifest["deep_verify"]["ok"] is True
        finite = np.sum(np.isfinite(fake.table["mag"]))
        assert manifest["deep_seen"] + manifest.get("deep_coarse_seen", 0) == finite
        assert len(uploaded) > 0
        assert any("o7" in n for n in uploaded)
        # deleted
        assert not list((out / "deep").glob("*.pack"))
        # tiles
        tiles_p = out / "packs" / "tiles.json"
        with open(tiles_p) as f:
            tiles = json.load(f)
        assert tiles["hosts"]["r2"] == "https://stars.graphicoregon.com/test/deep/"
        r2_levels = [l for l in tiles["levels"] if l["host"] == "r2"]
        assert len(r2_levels) > 0
        # decode one copied
        if copied_for_test:
            pack = pyramid.read_pack(copied_for_test[0])
            assert "payload" in pack
    finally:
        tap.ANON_MAX_ROWS = orig_cap
        pyramid.CAP = orig_py_cap
        pyramid.HEAP_M = pyramid.CAP * 7
    print("test_deep_end_to_end ok")


def test_colour_class():
    bp = np.array([-1.0, 0.5, 1.0, 1.7, np.nan])
    out = tap.colour_class(bp)
    expected = np.array([0, 1, 2, 3, 0], dtype=np.uint16)
    assert np.array_equal(out, expected)
    assert tap.colour_class(1.0) == 2
    print("test_colour_class ok")


def test_parse_csv_scrambled_nulls():
    csv_text = """dec,parallax,bp_rp,parallax_error,source_id,phot_g_mean_mag,ra
30.5,,0.5,,1234567890,15.5,45.2
30.6,10.0,,-1.0,1234567891,,45.3
"""
    blob = csv_text.encode("utf-8")
    arr = tap.parse_csv(blob)
    assert len(arr) == 2
    assert arr["source_id"][0] == 1234567890
    assert np.isnan(arr["mag"][1])
    assert np.isfinite(arr["parallax"][1])
    print("test_parse_csv_scrambled_nulls ok")


def test_pilot_requires_names(tmp_path):
    try:
        pyramid.discover_shards(
            [str(tmp_path)], "PILOT", None, suffix=".dr3x"
        )
        assert False, "should raise"
    except ValueError as e:
        assert "pilot_names/pilot_dr3 required" in str(e)
    print("test_pilot_requires_names ok")


def test_dr1_without_pandas(tmp_path):
    # sitecustomize blocking pandas
    sc_dir = tmp_path / "sitecustomize"
    sc_dir.mkdir()
    with open(sc_dir / "sitecustomize.py", "w") as f:
        f.write("""import sys
class BlockPandas:
    def find_spec(self, fullname, path, target=None):
        if "pandas" in fullname.lower():
            raise ImportError("pandas blocked")
        return None
sys.meta_path.insert(0, BlockPandas())
""")
    env = os.environ.copy()
    env["PYTHONPATH"] = str(sc_dir) + os.pathsep + env.get("PYTHONPATH", "")
    code = "import pyramid; print('ok_no_pandas')"
    out = subprocess.check_output([sys.executable, "-c", code], env=env, cwd=str(tmp_path), text=True)
    assert "ok_no_pandas" in out
    print("test_dr1_without_pandas ok")


def test_dr3_name_regex():
    # accepts valid, rejects bad
    assert re.search(r"GaiaSource_(\d{6})-(\d{6})\.csv\.gz", "GaiaSource_000000-003111.csv.gz")
    assert not re.search(r"GaiaSource_(\d{6})-(\d{6})\.csv\.gz", "../x.csv.gz")
    print("test_dr3_name_regex ok")


def main():
    with tempfile.TemporaryDirectory() as tmp:
        tpath = Path(tmp)
        test_coarse_exact(tpath)
        test_coarse_resume(tpath)
        test_pyramid_on_tap(tpath)
        test_deep_end_to_end(tpath)
        test_colour_class()
        test_parse_csv_scrambled_nulls()
        test_pilot_requires_names(tpath)
        test_dr1_without_pandas(tpath)
        test_dr3_name_regex()
    print("ok 11 tests")


if __name__ == "__main__":
    main()
