# Gaia LOD pyramid (Colab + Box CLI)

Builds the StarIS v2 HEALPix packs from the LSDB HATS copy of Gaia DR3 (default), via TAP, or legacy DR1. Plain NumPy. One shard at a time. No compiler and no GitHub token. Deep orders 7-12 are written to R2.

`gaia_lod_pyramid.ipynb` calls `pyramid.py`. Order-k nested cell = `source_id >> (59 - 2k)`. The Q8 encoder is `public/bin-lod/scripts/q8.py`.

`packs/tiles.json` is version 2, the index the viewer reads (`?lod=v2`). It sits in `packs/` next to the pack files, and each `pack` name is a bare filename such as `o0_p0.pack`. Upload that `packs/` folder unchanged as `data/v2-pilot` (or `v2-dr3/deep/`). `manifest.json` stays at the output root as the resume checkpoint and still stores the bare pack filename.

This work has made use of data from the European Space Agency (ESA) mission Gaia (https://www.cosmos.esa.int/gaia), processed by the Gaia Data Processing and Analysis Consortium (DPAC, https://www.cosmos.esa.int/web/gaia/dpac/consortium). Gaia DR3: Gaia Collaboration, Vallenari et al. (2023), A&A 674, A1.

## What it does

1. **Probe.** For each shard: size, `size % 62`, first and last `source_id`, base cells touched.
2. **Thresholds.** One base cell at a time. Each order-6 cell keeps the brightest `M = 1024 * 7` stars by `(mag, source_id)`. When the base cell closes, picks run top-down for orders 0..6, cap 1024 per cell. That stores `tau_k`, counts, and a `(sum, xor)` id hash per order-6 cell.
3. **Write.** A star's order is the minimum `k <= 6` with key `<= tau_k`. Stars that miss every threshold are deep: they are counted into orders 7..12, and written only if enabled. Cells are brightest-first, Q8-encoded, written as part files (`.tmp` then rename), then assembled into packs. Deep uses `deep.py` (per order-2 unit, resumable, uploads each pack via `deep_sink_factory` then deletes it).
4. **Check.** Pack bytes / 8, pass-1 counts, pass-2 records, and pack `n` agree. Per-cell hashes agree. Up to 10,000 decoded records per order stay inside the Q8 error limits. `verify.bytes_over_62` is the input record count. `verify.identity_ok` is true when that equals the coarse records written plus the deep counts.

`manifest.json` in the output folder is the resume checkpoint. Units are base cells in the threshold pass and order-2 cells in the write pass. After every shard the notebook checks RSS. Over 2 GB it writes the checkpoint and stops. Box CLI adds disk guards (`--disk-cap-gb`, `--min-free-gb`; exit code 2 = guard stop, rerun resumes).

## Packs

Orders 0–4 are one pack each. Order 5 is 12 packs (one per base cell). Order 6 is 48 packs (one per order-1 cell). Header: `Q8PK`, order, parent order, `n_cells`, then `n_cells` × `{u32 local cell, u32 start, u32 count}`, then the 8-byte records. Deep packs land on R2.

New runs write G1BK packs by default (`--pack-format g1b`; `q10` keeps Q8PK). G1BK: `G1BK`, u8 version (1), u8 order, u8 parent order, u8 0, u32 `n_cells`, then `n_cells` × `{u32 local, u32 start, u32 count, u32 byte_offset, u32 byte_len}`, then one zlib stream per cell of that cell's Q10 records split into 10 byte planes. It decodes to the exact Q10 bytes, so the Q10 error limits are unchanged, and the viewer can still range-read one cell. Codec: `public/bin-lod/scripts/g1b.py` and `g1b.js`; `q10_to_g1b.py` converts an existing pack folder. tiles.json `record` gains `"pack": "g1b"`. The viewer reads both formats by magic.

## Input

**HATS mode (default):** `--source hats` in the CLI. `hats.fetch_hats` reads the LSDB HATS copy of Gaia DR3 (https://data.lsdb.io/hats/gaia_dr3/gaia/, 2,016 parquet partitions, 1,812,731,847 rows). It range-reads only source_id, ra, dec, parallax, parallax_error, phot_g_mean_mag and bp_rp (78.8 GB of the 764.7 GB catalogue), drops duplicate source_ids, keeps parallax only at SNR >= 5, and writes source_id-sorted `.hatsx` files (36-byte DR3X records) per order-2 cell into `OUT/hats_cache`. The pyramid adapter `hats` reads them. Use `--partitions first:N` or `--partitions 2/0,2/1` for a test. `pip install -r requirements.txt`.

**TAP mode (`--source tap`):** `SOURCE="dr3_tap"` in notebook or `--coarse` in CLI. Uses `tap.fetch_coarse(cache_dir, workers=4, region=(order,cells)|None, ...)` to produce `.dr3x` files (36 B records). `pyramid` adapter `"dr3_tap"` reads them and derives colour class from `bp_rp`. Coarse queries target orders 0-6 (≤67.1 M rows, ~1,820 async jobs, ~7 GB CSV transfer → 2.4 GB `.dr3x`). Pilot uses `pilot_dr3` config key = exact list of input `.dr3x` basenames. Authenticated TAP (optional `GAIA_USER`/`GAIA_PASSWORD`) allows unlimited rows.

**Legacy DR3 CDN fallback:** `dr3.fetch_dr3` (returns `"names"`). Produces cache for `dr3_tap` adapter.

**DR1:** Default adapter `drive_bin_dr1`. Shards are 62-byte little-endian records, sorted by `source_id` (see table below). They live under a Drive folder named `StarIS`, in `BinFiles_2025` (4,433 files) and `BinFiles_2025_Continued` (784 files).

`esa_csv` is a stub for ESA `gaia_source` csv.gz. The 14 missing DR1 files are at `https://cdn.gea.esac.esa.int/Gaia/gdr1/gaia_source/csv/`.

**Colour:** Now set from `bp_rp` in DR3 TAP (removed old note that it was always 0).

## TAP mode

- Coarse (0-6): 67.1 M rows max, ~0.67 GB Q10 packs on GitHub Pages / R2. ~1-2 h at 4 workers (one free Colab session).
- Uses shared TAP pool (anonymous: 50k rows/query, 10 s sync / 1 min async, 100 active; auth: unlimited, 120 min, 5 active).
- `tap.py` also provides `estimate(workers, deep_workers) -> dict` for projections.
- Deep (7-12): all remaining ~1.74 B finite-mag stars, ~36,000 keyset pages of 50 k rows, ~194 GB CSV transfer, ~17.5 GB packs on R2. Run on box (resumable per order-2 unit, 192 units total).

## Deep levels on R2

Deep packs are hosted on `staris-gaia-dr3` (default `https://stars.graphicoregon.com/v2-dr3/deep/`). Temporary fallback: `https://pub-dcca7c4a73bc4891abfc485697bc1072.r2.dev` (rate-limited; viewer supports `?r2=` param). `r2_upload.py` provides `make_sink(bucket, prefix, secrets_dir=None)` (returns callable `sink(path, name)`) and `upload_file`. Credentials from env, secrets dir, or Colab `userdata` (`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_ACCOUNT_ID`), read fresh each call, never printed. `deep.py:run_deep(config)` handles per-order-2 units and upload-then-delete.

## Box CLI

Default source is HATS (`--source hats`, flags `--partitions`, `--hats-workers`, `--range-workers`, `--pack-format`). TAP stays available with `--source tap` (`--region`, `--estimate`, deep via `deep.py`). With HATS, `--deep` makes the same pyramid pass write orders 7-12.

Use on a persistent Linux box for full coarse + deep + upload:

Full runs must use a fresh versioned prefix (--prefix auto gives v2-dr3-YYYYMMDD/; --overwrite is refused for full runs); --prefix is required; runs refuse (exit 4) if PREFIX/packs/tiles.json exists unless --overwrite (test regions only); --deep without --upload makes no R2 calls; tiles.json uploads last, and only after a successful full run v2-dr3/current.json is updated to point at the new prefix. The viewer can load it with ?lod=v2&index=https://stars.graphicoregon.com/<prefix>/packs/tiles.json; switch the default INDEX_URL in a PR only after the run.

