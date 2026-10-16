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

`hats_stream/scan.json` (every 64 partitions and on a RAM stop, so a resume redoes up to 63 partitions), `hats_stream/pass2.json` (per partition), `hats_stream/finalize.json` (per order-6 cell, 256 per order-2 cell) and `pyramid/stream_ckpt.json` (per order-2 shard) are the resume checkpoints. The finished shard is fsynced and renamed before pass2.json marks it ready. If a run dies in that gap resume adopts the renamed shard after checking its size equals the row count in finalize.json and refuses (RuntimeError, exit 1) rather than rebuild over a finished shard. Resume refuses (RuntimeError) a .tmp shorter than finalize.json's tmp_size, and a run whose scan.json says thresholds were saved but thresholds.npz (or, before that, cand/) is missing, instead of building 0 coarse stars. All state files are fsynced before rename. Disk guard now also runs after every pass-2 partition, every 16 order-6 cells while building a shard, and every 64 chunks (65,536 rows each) in the pyramid write pass, as well as in final pack assembly. Exit 2 or 6 reruns resume from the last written checkpoint. Box CLI adds disk guards (`--disk-cap-gb`, `--min-free-gb`; exit code 2 = guard stop, rerun resumes).

## Packs

Orders 0–4 are one pack each. Order 5 is 12 packs (one per base cell). Order 6 is 48 packs (one per order-1 cell). Header: `Q8PK`, order, parent order, `n_cells`, then `n_cells` × `{u32 local cell, u32 start, u32 count}`, then the 8-byte records. Deep packs land on R2.

New runs write G1BK packs by default (`--pack-format g1b`; `q10` keeps Q8PK). G1BK: `G1BK`, u8 version (1), u8 order, u8 parent order, u8 0, u32 `n_cells`, then `n_cells` × `{u32 local, u32 start, u32 count, u32 byte_offset, u32 byte_len}`, then one zlib stream per cell of that cell's Q10 records split into 10 byte planes. It decodes to the exact Q10 bytes, so the Q10 error limits are unchanged, and the viewer can still range-read one cell. Codec: `public/bin-lod/scripts/g1b.py` and `g1b.js`; `q10_to_g1b.py` converts an existing pack folder. tiles.json `record` gains `"pack": "g1b"`. The viewer reads both formats by magic.

## Input

**HATS mode (default):** `--source hats` in the CLI. `hats_stream.py` streams the LSDB HATS copy of Gaia DR3 (https://data.lsdb.io/hats/gaia_dr3/gaia/, 2,016 parquet partitions, 1,812,731,847 rows) in two network passes. Pass 1 keeps at most `--hats-workers` downloads in flight and folds each result in as soon as it arrives (bounded fetch); candidates are stored per base cell and order-3 group and merged when the pending rows reach 2 M in total. Pass 2 streams one order-6 cell at a time (256 per order-2 cell): each partition's rows are spilled per order-6 cell to disk, then each order-6 cell is cleaned and appended to the order-2 shard; peak RAM depends on the largest order-6 cell's spill. The full raw cache is never on disk at once. After pass 1 the thresholds are saved to `hats_stream/thresholds.npz` and `hats_stream/cand/` (up to about 4.9 GB on the full sky, estimate) is deleted; reruns load the saved thresholds. `hats.clean` keeps the row with the smallest `(mag, ra, dec, parallax, bp_rp)` for duplicate source_ids. Pass 1 checkpoints every 64 partitions. Pass 2 resumes at the next unfetched partition or next order-6 cell. Use `--partitions first:N` or `--partitions 2/0,2/1` for a test. `pip install -r requirements.txt` installs numpy, pyarrow, pytest, pandas and boto3 (needed for --upload). `--hats-base URL` points at another HATS copy (tests use a local server).

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

`--disk-cap-gb` now defaults to 30 (was 20). `--min-free-gb` stays 10. With `--deep`, the HATS run now checks that the deep pack records equal the deep counts and that coarse pack records equal the pass-2 coarse count; a mismatch exits 5.

`--source hats --upload` is refused (exit 4) before any download unless `--deep` is also given. With `--deep`, after the deep check passes, the CLI checks that the local pack files match the manifest levels, uploads every pack (coarse and deep) to `PREFIX/packs/`, checks each object exists on R2 with the same byte size, then uploads `PREFIX/packs/tiles.json` last and checks its size. The sink skips any object whose stored md5 metadata matches the local file, so a rerun after exit 7 only re-uploads packs that are missing or changed. Any missing file or size mismatch exits 7 and nothing is published. `v2-dr3/current.json` is published only after all of that passes, and never for `--partitions` runs. Prefix rules are unchanged (fresh versioned prefix, `--prefix auto` gives v2-dr3-YYYYMMDD/; --overwrite is refused for full runs).

`--partitions ... --deep --upload` is a real upload: it writes the packs and tiles.json to R2 under PREFIX (only current.json is skipped). Use a throwaway test prefix.

**Recovery after tiles.json is on R2.** Any rerun with the same prefix is refused with exit 4 (the output folder is tied to its prefix in OUT/prefix.txt, and --overwrite is refused for full runs). If the log shows the deep check passed and no exit 7, but current.json was not published (for example the run died during that last step), publish it by hand: upload OUT/current.json (or a JSON `{"prefix": "PREFIX", "tiles": "https://stars.graphicoregon.com/PREFIX/packs/tiles.json"}`) to `v2-dr3/current.json` with `r2_upload.upload_file`, cache-control `public, max-age=60`. If tiles.json failed its size check (exit 7) or anything else is in doubt, start again with a new explicit prefix (for example `v2-dr3-YYYYMMDD-b/`) and a new empty --out folder.

`--max-rss-gb` (default 4.0): before any download the run reads MemAvailable and exits 6 if it is below the cap; pass 1 stops submitting and cancels pending downloads before writing scan.json; pass 2 checks after each partition and each order-6 cell; the write pass checks after each shard; rerun resumes as described above.

Exit codes: 1 error, 2 disk guard, 3 count mismatch, 4 refused, 5 deep check failed, 6 RAM guard stop, 7 upload verify failed, 8 remote read failed after retries (rerun resumes).

**Network timeouts.** Every HATS request (partition list, HEAD, range GETs) has a connect timeout (20 s), an idle read timeout (60 s per socket read) and a total deadline per request (300 s), and is retried up to 5 times with exponential backoff (2^n s with jitter, capped at 60 s); 4xx other than 408/429 fail at once. Override with env HATS_CONNECT_TIMEOUT, HATS_READ_TIMEOUT, HATS_REQUEST_DEADLINE, HATS_MAX_ATTEMPTS, HATS_BACKOFF_BASE, HATS_BACKOFF_MAX. When retries run out the run writes its checkpoint (pass 1 saves scan.json; pass 2 already saves pass2.json per partition) and exits 8; rerun the same command. (Before this, a stalled HTTPS read could hang a run indefinitely.)

Use on a persistent Linux box for full coarse + deep. Full runs must use a fresh versioned prefix (--prefix auto gives v2-dr3-YYYYMMDD/; --overwrite is refused for full runs); --prefix is required; runs refuse (exit 4) if PREFIX/packs/tiles.json exists unless --overwrite (test regions only); --deep without --upload makes no R2 calls; tiles.json uploads last. With `--source tap`, only after a successful full run (no `--region`) is v2-dr3/current.json updated to point at the new prefix. The viewer can load it with ?lod=v2&index=https://stars.graphicoregon.com/<prefix>/packs/tiles.json; switch the default INDEX_URL in a PR only after the run.

## Large-cell test

Real large cell (24 real HATS partitions inside order-2 cell 112, 30,661,736 rows, including the densest order-4 sub-cell 1795 with 16,765,532 rows; `--deep --max-rss-gb 3`): peak RSS (VmHWM) 1,671,876 kB (about 1.6 GiB); per phase max RSS: pass 1 1,540,528 kB, pass 2 1,570,660 kB, write and check 1,410,508 kB. Wall time: pass 1 50 s, pass 2 65 s, write pass 776 s (25.3 microseconds per row with deep), check 15 s. Peak output folder 2.28 GB (the shard was 1.10 GB); final part files 305 MB (10.0 B per record) and packs 131 MB (4.3 B per record) for 30,484,414 records. Deep check ok, identity ok.

## 2-partition test

`--partitions 2/0,2/1 --coarse`: packs and tiles.json still byte-identical (7 packs, 688 cells, 700,429 records); peak output folder 102.4 MB; peak RSS 884,436 kB; about 86 s.

## Full-run estimates

**Estimates (scaled from the measured large-cell run; not measured on the full sky):**
- RAM: about 1.7-2 GB peak, since the measured run included the densest order-4 sub-cell and partitions up to 1,939,635 rows (the largest partition anywhere has 1,988,183 rows). Use `--max-rss-gb 3`.
- Disk: about 26 GB peak in the output folder, estimate (deep part files about 17.3 GB plus deep packs about 7.4 GB plus about 1 GB coarse, all on disk at the end before upload); up to about 31 GB if the unexplained 2x shard spike from the large-cell run also happens next to the largest shard (6.1 GB). Candidates (about 4.9 GB) are deleted after pass 1 and no longer count. The guard measures free space in GiB: with `--min-free-gb 15` start with at least about 42 GB (39 GiB) free for the 26 GB estimate, or about 47 GB (44 GiB) for the 31 GB case. Do not lower `--min-free-gb`.
- Time: pass 1 about 1-1.2 h, pass 2 downloads about 1.5 h, write pass about 12.7 h (1.81 B rows at the measured 25.3 microseconds per row), check about 15 min; about 15-16 h before upload. Upload of about 7.4 GB packs is unmeasured; allow 16-18 h.

## Full-run command (coarse + deep + upload)
```bash
cd tools/staris-pipeline
python3 staris_run.py --source hats --coarse --deep --upload --prefix auto \
  --out /path/to/staris-hats-full --max-rss-gb 3 --disk-cap-gb 45 --min-free-gb 15
```
- Disk: about 26 GB peak in the output folder, estimate (deep part files about 17.3 GB plus deep packs about 7.4 GB plus about 1 GB coarse, all on disk at the end before upload); up to about 31 GB if the unexplained 2x shard spike from the large-cell run also happens next to the largest shard (6.1 GB). Candidates (about 4.9 GB) are deleted after pass 1 and no longer count. The guard measures free space in GiB: with `--min-free-gb 15` start with at least about 42 GB (39 GiB) free for the 26 GB estimate, or about 47 GB (44 GiB) for the 31 GB case. Do not lower `--min-free-gb`.
- RAM: about 1.7-2 GB peak, since the measured run included the densest order-4 sub-cell and partitions up to 1,939,635 rows (the largest partition anywhere has 1,988,183 rows). Use `--max-rss-gb 3`.
- Time: pass 1 about 1-1.2 h, pass 2 downloads about 1.5 h, write pass about 12.7 h (1.81 B rows at the measured 25.3 microseconds per row), check about 15 min; about 15-16 h before upload. Upload of about 7.4 GB packs is unmeasured; allow 16-18 h.
- If it stops with exit 2 or 6, rerun the same command. See "Recovery after tiles.json is on R2" above.

## Memory tests

Memory tests (`test_hats_memory.py`, 220 fake partitions with real payload sizes): pass 1 RSS grew 268.7 MB over 220 partitions with at most 4 cleaned partitions alive at once (keeping all would be about 3.2 GB, estimate); a RAM stop in pass 1 happened after 4 downloads and the resume gave identical thresholds; pass 2 RSS grew 12.5 MB over 220 partitions; a pass-2 stop happened after 4 downloads and the resume gave identical shards.

## Known gaps

- HATS `--deep` and the upload path have only run on small test data with mocked R2. No full deep run and no real HATS upload yet (only mocked R2 and local tests).
- The full-sky disk, RAM and time figures are estimates scaled from one large cell.
- Upload speed to R2 unmeasured.
- The brief 2× disk peak in the large-cell run is not explained yet.
- Disk guards run between steps; a single step can still write up to one order-6 spill or 64 chunks of parts past the limit.
