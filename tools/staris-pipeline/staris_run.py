import argparse
import json
import os
import shutil
import sys
import time
from datetime import datetime
from pathlib import Path

import tap
import pyramid
import deep
from r2_upload import make_sink, upload_file, object_exists


def main():
    parser = argparse.ArgumentParser(description="StarIS Gaia DR3 pipeline CLI")
    parser.add_argument("--out", type=Path, required=True, help="Output directory")
    parser.add_argument("--coarse", action="store_true", help="Run coarse pass")
    parser.add_argument("--deep", action="store_true", help="Run deep pass")
    parser.add_argument("--region", type=str, help="ORDER:CELL[,CELL...]")
    parser.add_argument("--upload", action="store_true", help="Upload to R2")
    parser.add_argument("--prefix", type=str, required=True)
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--bucket", type=str, default="staris-gaia-dr3")
    parser.add_argument("--disk-cap-gb", type=float, default=20.0)
    parser.add_argument("--min-free-gb", type=float, default=10.0)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--secrets-dir", type=str, default="/workspace/box-secrets")
    parser.add_argument("--r2-base", type=str, default="https://stars.graphicoregon.com")
    parser.add_argument("--estimate", action="store_true")
    args = parser.parse_args()

    out = args.out
    out.mkdir(parents=True, exist_ok=True)
    log_path = out / "run.log"

    def log(msg):
        ts = datetime.now().isoformat(timespec="seconds")
        line = f"{ts} {msg}"
        print(line)
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(line + "\n")

    if args.estimate:
        est = tap.estimate(workers=args.workers, deep_workers=args.workers)
        log("estimate: " + json.dumps(est, indent=2))
        print(json.dumps(est, indent=2))
        sys.exit(0)

    if not args.coarse and not args.deep:
        args.coarse = True

    if args.prefix == 'auto':
        args.prefix = 'v2-dr3-' + datetime.now().strftime('%Y%m%d') + '/'

    full = args.region is None
    if full and args.overwrite:
        log('refusing: full runs must use a fresh versioned prefix, not --overwrite')
        sys.exit(4)

    if args.upload:
        tiles_key = args.prefix.rstrip('/') + '/packs/tiles.json'
        if object_exists(tiles_key, bucket=args.bucket, secrets_dir=args.secrets_dir) and not args.overwrite:
            log('refusing: ' + tiles_key + ' exists; pass --overwrite or use a new prefix')
            sys.exit(4)

    def get_disk_usage_gb(directory):
        total = 0
        for p in Path(directory).rglob("*"):
            if p.is_file():
                total += p.stat().st_size
        return total / (1024 ** 3)

    def guard():
        usage = shutil.disk_usage(out)
        free_gb = usage.free / (1024 ** 3)
        used_gb = get_disk_usage_gb(out)
        if free_gb < args.min_free_gb or used_gb > args.disk_cap_gb:
            raise tap.DiskFull(f"Disk constraint violated: free={free_gb:.2f}GB, used={used_gb:.2f}GB (cap={args.disk_cap_gb})")

    tap_cache = out / "tap_cache"
    pyramid_dir = out / "pyramid"
    region = None
    pilot_order2 = None
    if args.region:
        order_s, cells_s = args.region.split(":", 1)
        order = int(order_s)
        cells = [int(x.strip()) for x in cells_s.split(",")]
        if order == 6:
            limit_cells = cells
            region = (6, cells)
            pilot_order2 = None
        else:
            region = (order, cells)
            limit_cells = None
            if order == 2:
                pilot_order2 = cells

    if args.coarse:
        log("starting coarse TAP fetch")
        tap_manifest = tap.fetch_coarse(
            str(tap_cache),
            workers=args.workers,
            pilot_order2=pilot_order2,
            limit_cells=limit_cells,
            region=region,
            guard=guard,
            secrets_dir=args.secrets_dir,
            progress=log,
        )
        dr3_names = [Path(f).name for f in tap_manifest.get("files", [])]
        config = {
            "output_dir": str(pyramid_dir),
            "adapter": "dr3_tap",
            "mode": "PILOT" if (region is not None) else "FULL",
            "pilot_dr3": dr3_names,
            "input_dirs": [str(tap_cache)],
            "r2_base": args.r2_base,
            "write_deep": False,
            "deep_source": "tap",
            "rss_cap": 2 * 1024**3,
            "guard": guard,
            "region": region,
            "deep_workers": args.workers,
            "tap_cache": str(tap_cache),
        }
        log("starting pyramid coarse")
        pyr_manifest = pyramid.run_pipeline(config, progress=log)
        tap_rows = tap_manifest.get("rows", 0)
        pyr_coarse = sum(int(v) for v in pyr_manifest.get("coarse_counts", {}).values())
        log(f"counts: tap={tap_rows} pyramid_coarse={pyr_coarse}")
        if tap_rows != pyr_coarse:
            log("COUNT MISMATCH")
            sys.exit(3)
        log("coarse counts match")

    if args.upload:
        log("uploading coarse packs")
        prefix_packs = args.prefix.rstrip("/") + "/packs/"
        sink_packs = make_sink(args.bucket, prefix_packs, args.secrets_dir)
        packs_d = pyramid_dir / "packs"
        uploaded = 0
        for pack_f in packs_d.glob("*.pack"):
            sink_packs(str(pack_f), pack_f.name)
            uploaded += 1
        log(f"uploaded {uploaded} coarse packs")
        if not args.deep:
            tiles_p = packs_d / "tiles.json"
            upload_file(
                tiles_p,
                args.prefix.rstrip("/") + "/packs/tiles.json",
                args.bucket,
                cache_control="public, max-age=300",
                secrets_dir=args.secrets_dir,
            )
        log("coarse upload done")

    if args.deep:
        log("starting deep pass")
        def make_deep_sink():
            return make_sink(
                args.bucket,
                (args.prefix.rstrip("/") + "/deep/"),
                args.secrets_dir,
            )
        deep_config = {
            "output_dir": str(pyramid_dir),
            "deep_sink_factory": make_deep_sink if args.upload else None,
            "deep_delete_after_upload": bool(args.upload),
            "r2_base": args.r2_base.rstrip("/") + "/" + args.prefix.strip("/") + "/deep/",
            "deep_workers": args.workers,
            "guard": guard,
            "region": region,
            "rss_cap": 2 * 1024**3,
            "tap_cache": str(tap_cache),
            "runner": tap.run_async,
        }
        deep_manifest = deep.run_deep(deep_config, progress=log)
        log("deep pass finished with verify " + json.dumps(deep_manifest.get("deep_verify", {})))
        if args.upload:
            log("re-uploading updated tiles.json")
            tiles_p = (pyramid_dir / "packs") / "tiles.json"
            upload_file(
                tiles_p,
                args.prefix.rstrip("/") + "/packs/tiles.json",
                args.bucket,
                cache_control="public, max-age=300",
                secrets_dir=args.secrets_dir,
            )
            log("deep upload done")

    if args.upload and args.region is None:
        data = {
            'prefix': args.prefix,
            'tiles': args.r2_base.rstrip('/') + '/' + args.prefix.strip('/') + '/packs/tiles.json'
        }
        path = out / 'current.json'
        with open(path, 'w') as f:
            json.dump(data, f)
        upload_file(str(path), 'v2-dr3/current.json', args.bucket, cache_control='public, max-age=60', secrets_dir=args.secrets_dir)
        log('published ' + args.prefix)

    log("staris_run completed successfully")
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except tap.DiskFull as e:
        print(f"DiskFull: {e}")
        sys.exit(2)
    except Exception as e:
        print(f"ERROR: {e}")
        sys.exit(1)
