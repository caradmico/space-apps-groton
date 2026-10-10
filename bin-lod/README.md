# StarIS BIN LOD — multi-tile Gaia batch

Walkable multi-tile LOD on GitHub Pages (Spark / $0). No Firebase Storage.

## Layout
- `data/tiles.json` — tile index (`id`, `url`, RA/Dec bounds, `n_records`, `bytes`, `stride`)
- `data/tiles/tile-XXX.bin` — stride-sampled 62-byte GaiaSource records (≤~5 MiB each)
- `data/preview.bin` — coarse whole-sky FAR preview (12,288 records, ~0.75 MB). Drawn first. Not part of the catalog count.
- `data/catalog.bin` — legacy single-file fallback
- `js/lod-app.js` — loads `preview.bin` first, then the two-at-a-time tile queue

Regenerate the preview from the existing tiles (does not rewrite those tiles, `tiles.json`, or `catalog.bin`):

```bash
node public/bin-lod/scripts/build-preview.mjs
```

## Record layout
62 B LE: RA@+8, Dec@+16, parallax@+24, color@+56, mag@+58.

## Q8 records (8 bytes)

Encoder: `public/bin-lod/scripts/q8.py` (NumPy, for Colab). Decoder: `public/bin-lod/scripts/q8.js` (viewer).

Little-endian:

| bytes | field | meaning |
| --- | --- | --- |
| 0–2 | uint24 `ra_q` | RA degrees = `ra_q / 2^24 * 360`, wrapped |
| 3–5 | uint24 `dec_q` | Dec degrees = `dec_q / (2^24 − 1) * 180 − 90` |
| 6 | uint8 `mag_q` | mag = `-2 + mag_q * 0.1` |
| 7 | uint8 flags | bits 0–1 colour class 0–3, bit 2 set when parallax is finite and positive, bits 3–7 zero |

Values are rounded to nearest. Half a code is the maximum error:

- `|ΔRA cos Dec|` ≤ 0.0386″ (`360 × 3600 / 2^25` arcsec, 0.0386238…, quoted to 4 decimals)
- `|ΔDec|` ≤ 0.0193″ (`180 × 3600 / (2 × (2^24 − 1))` arcsec, 0.0193119…)
- `|Δmag|` ≤ 0.05

Dec uses `2^24 − 1` codes so −90° and +90° are exact. RA uses `2^24` codes because 0° and 360° are the same direction.

Round-trip check, one ≤ 1 MB slice from each of the 9 tiles: `python3 public/bin-lod/scripts/test_q8.py`.

## v2 pilot (`?lod=v2`)

`data/v2-pilot/tiles.json` is its own index (version 2). Pack paths inside it are relative to that file. `data/tiles.json` stays where it is. With no `lod` flag the page still loads the v1 tiles, preview, and queue.

Order 0 is the resident far layer (cap 12,288) and replaces the preview in this mode. Near keeps at most 12 HEALPix cells (cap 12,288), picked by projected size, ancestors first, refined past about 256 px. Two pack fetches at a time. Contiguous cells share one Range GET. The decoded cache evicts the farthest cells past 128. A `206` body is only the requested byte range: the header is parsed from the header bytes, and a cell already inside a loaded range is not fetched again.

`data/v2-pilot/hyg-v1.bin` is HYG v1, the 8,000-star catalog: float32 xyz, one magnitude byte, and 207 names (about 104 KB plus the name table). It fades in near the Sun and in NEAR mode. Matched Gaia points are hidden while it is visible. Names are drawn only while that layer is visible.

Rebuild from the nine tiles (does not touch the v1 files). Download the HYG catalog yourself and pass that path (the script does not fetch it):

```bash
curl -L -o stars.json https://staris-b01f2.firebaseapp.com/data/stars.json
python3 public/bin-lod/scripts/build-v2-pilot.py stars.json
```

HYG database by [astronexus (David Nash)](https://github.com/astronexus/HYG-Database), CC BY-SA 4.0. Share-alike: adaptations of the HYG catalog stay under CC BY-SA 4.0.

This work has made use of data from the European Space Agency (ESA) mission Gaia (https://www.cosmos.esa.int/gaia), processed by the Gaia Data Processing and Analysis Consortium (DPAC, https://www.cosmos.esa.int/web/gaia/dpac/consortium).

## Build note
Raw Drive shards stay off Pages. Only LOD tiles are published.

Headless checks use a global `WebSocket`. On Node 20, pass `--experimental-websocket` (`node --experimental-websocket scripts/check-bin-lod-progressive.mjs`, and the same flag for `scripts/check-bin-lod-throttle.mjs`, `scripts/check-bin-lod-fallback.mjs`, `scripts/check-bin-lod-errors.mjs`, `scripts/check-bin-lod-v2.mjs`, and `scripts/check-bin-lod-v2-range.mjs`).
