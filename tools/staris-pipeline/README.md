# Gaia LOD pyramid (Colab)

Builds the StarIS v2 HEALPix packs. Input is either Cara's Gaia DR1 shards on Drive or Gaia DR3 files streamed from ESA (see Gaia DR3 distances below). Plain NumPy. One shard at a time. No compiler and no GitHub token.

`gaia_lod_pyramid.ipynb` calls `pyramid.py`. Order-k nested cell = `source_id >> (59 - 2k)`. The Q8 encoder is `public/bin-lod/scripts/q8.py`.

`packs/tiles.json` is version 2, the index the viewer reads (`?lod=v2`). It sits in `packs/` next to the pack files, and each `pack` name is a bare filename such as `o0_p0.pack`. Upload that `packs/` folder unchanged as `data/v2-pilot`. `manifest.json` stays at the output root as the resume checkpoint and still stores the bare pack filename.

This work has made use of data from the European Space Agency (ESA) mission Gaia (https://www.cosmos.esa.int/gaia), processed by the Gaia Data Processing and Analysis Consortium (DPAC, https://www.cosmos.esa.int/web/gaia/dpac/consortium).

## What it does

1. **Probe.** For each shard: size, `size % 62`, first and last `source_id`, base cells touched.
2. **Thresholds.** One base cell at a time. Each order-6 cell keeps the brightest `M = 1024 * 7` stars by `(mag, source_id)`. When the base cell closes, picks run top-down for orders 0..6, cap 1024 per cell. That stores `tau_k`, counts, and a `(sum, xor)` id hash per order-6 cell.
3. **Write.** A star's order is the minimum `k <= 6` with key `<= tau_k`. Stars that miss every threshold are deep: they are counted into orders 7..12, and written only if `WRITE_DEEP` is on (the R2 flag). Cells are brightest-first, Q8-encoded, written as part files (`.tmp` then rename), then assembled into packs.
4. **Check.** Pack bytes / 8, pass-1 counts, pass-2 records, and pack `n` agree. Per-cell hashes agree. Up to 10,000 decoded records per order stay inside the Q8 error limits. `verify.bytes_over_62` is the input record count (sum of shard bytes / 62). `verify.identity_ok` is true when that equals the coarse records written plus the deep counts.

`manifest.json` in the output folder is the resume checkpoint. Units are base cells in the threshold pass and order-2 cells in the write pass. After every shard the notebook checks RSS. Over 2 GB it writes the checkpoint and stops.

## Packs

Orders 0–4 are one pack each. Order 5 is 12 packs (one per base cell). Order 6 is 48 packs (one per order-1 cell). Header: `Q8PK`, order, parent order, `n_cells`, then `n_cells` × `{u32 local cell, u32 start, u32 count}`, then the 8-byte records.

## Input

Default adapter `drive_bin_dr1`. Shards are 62-byte little-endian records, sorted by `source_id`:

| offset | type | field |
| --- | --- | --- |
| 0 | int64 | source_id |
| 8 | float64 | ra degrees |
| 16 | float64 | dec degrees |
| 24 | float64 | parallax (NaN if none) |
| 32 | 3× float64 | xyz (not used) |
| 56 | uint16 | colour class 1–3 |
| 58 | float32 | G mag |

They live under a Drive folder named `StarIS`, in `BinFiles_2025` (4,433 files) and `BinFiles_2025_Continued` (784 files, inside `BinFiles_2025`).

`esa_csv` is a stub for ESA `gaia_source` csv.gz (`source_id`, `ra`, `dec`, `parallax`, `phot_g_mean_mag`). The 14 missing DR1 files are at `https://cdn.gea.esac.esa.int/Gaia/gdr1/gaia_source/csv/`. Point the stub at a file you already have. For DR3 use `dr3.py` and the `dr3_cache` adapter instead.

## Run the 20-shard pilot in Colab

1. Open `https://colab.research.google.com/github/caradmico/space-apps-groton/blob/main/tools/staris-pipeline/gaia_lod_pyramid.ipynb`.
2. Runtime → Run all. The first cell clones this branch. Allow the Google Drive mount and pick the account that holds `StarIS`.
3. Leave `MODE = "PILOT"`, `ADAPTER = "drive_bin_dr1"`, and `WRITE_DEEP = False`. The pilot list is the 20 `GaiaSource_000-….bin` names in the notebook (267.9 MB, 4,321,186 records).
4. If the folder search does not find `StarIS`, set `STARIS` in that cell to the Drive path, for example `/content/drive/MyDrive/StarIS`.
5. Output goes to a new folder `/content/drive/MyDrive/StarIS_lod_v2`. It does not write into `BinFiles_2025`.
6. Wait until the last cell prints `pass done` and the verify counts match. `packs/tiles.json` is then beside the `.pack` files, with bare names (`o0_p0.pack` and so on). Upload that `packs/` folder unchanged as `data/v2-pilot`. If a cell raises `RssExceeded`, RSS went over 2 GB: the checkpoint is `manifest.json` in the output folder. Re-run the notebook later and it resumes.
7. For the full survey, set `MODE = "FULL"` in a copy of the output folder (or delete the pilot output first). `FULL` reads every `GaiaSource_*.bin` under `BinFiles_2025` and `BinFiles_2025_Continued`.

Local check, no Drive: `python3 tools/staris-pipeline/test_pyramid.py`.

## Gaia DR3 distances

The pipeline now uses Gaia DR3 positions and parallaxes for the whole sky instead of a DR1 source_id cross-match. DR1 and DR3 source_ids are not stable identifiers across releases. ESA ships dr2_neighbourhood / dr1_neighbourhood tables that are many-to-many, and the cross-match would still need every DR3 file for parallax, so it adds a join and ambiguity for zero download savings.

Distance is computed only when parallax > 0 and parallax_over_error >= 5. At SNR 5 the fractional distance error is ~20% and 1/plx is a tolerable estimator. Lower SNR biases 1/plx badly. No zero-point correction is applied; the ~-0.017 mas global offset is negligible for SNR>=5 visualisation.

DR3 data is cached in a compact 32-byte .dr3c binary format (source_id, ra, dec, parallax, mag) after the initial CSV.gz conversion.

Download totals: 3,386 files, 753 GB gzip, ~1.81 billion rows. Only 6 columns are kept but the gzip CSV must be fetched whole.

Test result on GaiaSource_786097-786431.csv.gz (294,422 rows, 317 null G mag): 72.0% positive parallax, 19.9% pass SNR>=5, 90.8% of records written to the coarse orders 0-6 packs have distance (bright stars have good parallax). RSS stays near 230 MB. Colour class is 0 for DR3 (bp_rp not fetched).

This work has made use of data from the European Space Agency (ESA) mission Gaia (https://www.cosmos.esa.int/gaia), processed by the Gaia Data Processing and Analysis Consortium (DPAC, https://www.cosmos.esa.int/web/gaia/dpac/consortium). Gaia DR3: Gaia Collaboration, Vallenari et al. (2023), A&A 674, A1.

### Run the DR3 pilot in Colab

1. Open the notebook from this branch: `https://colab.research.google.com/github/caradmico/space-apps-groton/blob/staris-dr3-distances/tools/staris-pipeline/gaia_lod_pyramid.ipynb`. In the first code cell set `BRANCH = "staris-dr3-distances"` (until it is merged).
2. Runtime → Run all. Allow the Drive mount.
3. The DR3 cell has `USE_DR3 = True` and `DR3_LIMIT = 20`. It downloads the first 20 DR3 files (about 4.5 GB) one at a time to `/content/dr3_cache`, checks each MD5, keeps 6 columns, and deletes the gz.
4. Output goes to `/content/drive/MyDrive/StarIS_lod_v2_dr3`. Wait for `pass done`. `verify.pct_with_distance` is the share of written stars that have a distance. Upload `packs/` as before.
5. Full sky: set `DR3_LIMIT = None`. That is 3,386 files and 753 GB of download. The cache needs about 58 GB of local disk. The run takes more than one 12-hour free session. If the session resets, `/content` is wiped and fetched files are fetched again; the Drive output manifest resumes the pyramid passes.

Local check: `python3 tools/staris-pipeline/test_pyramid.py` (includes an offline DR3 test with a synthetic file).
