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

## Q10 records (10 bytes, v2 with distance)

Q10 = the 8 Q8 bytes above, unchanged, plus `uint16 dist_q` at bytes 8–9 (LE). `tiles.json` says `"record": {"format": "q10", "bytes": 10}`; the viewer still reads Q8 packs.

- `dist_q = 0`: no distance (parallax missing, ≤ 0, or not finite). The star sits on the radius-100 shell, as in v1.
- otherwise `log10(d_pc) = -1 + (dist_q - 1) × 6/65534`, so 0.1 pc to 100 kpc (clamped), with `d = 1000 / parallax_mas`.
- Max relative distance error is half a step: `10^(3/65534) − 1` ≈ 0.0105 % (`DIST_REL_ERR` in `q8.py`).

v2 places Q10 stars at that distance in pc, the same as v1. Check the pilot packs: `cd public/bin-lod && node scripts/test-q10.mjs`.

## v2 pilot (`?lod=v2`)

`data/v2-pilot/tiles.json` is its own index (version 2). Pack paths inside it are relative to that file. `data/tiles.json` stays where it is. With no `lod` flag the page still loads the v1 tiles, preview, and queue.

Order 0 is the resident far layer (cap 12,288) and replaces the preview in this mode. Near keeps at most 12 HEALPix cells (cap 12,288), picked by projected size, ancestors first, refined past about 256 px. Two pack fetches at a time. Contiguous cells share one Range GET. The decoded cache evicts the farthest cells past 128. A `206` body is only the requested byte range: the header is parsed from the header bytes, and a cell already inside a loaded range is not fetched again.

`data/v2-pilot/hyg-v1.bin` is HYG v1, the 8,000-star catalog: float32 xyz, one magnitude byte, and 206 names (about 104 KB plus the name table). It fades in near the Sun and in NEAR mode. Matched Gaia points are hidden while it is visible. Names are drawn only while that layer is visible.

Rebuild from the nine tiles (does not touch the v1 files). Download the HYG catalog yourself and pass that path (the script does not fetch it):

```bash
curl -L -o stars.json https://staris-b01f2.firebaseapp.com/data/stars.json
python3 public/bin-lod/scripts/build-v2-pilot.py stars.json
```

HYG database by [astronexus (David Nash)](https://github.com/astronexus/HYG-Database), CC BY-SA 4.0. Share-alike: adaptations of the HYG catalog stay under CC BY-SA 4.0.

This work has made use of data from the European Space Agency (ESA) mission Gaia (https://www.cosmos.esa.int/gaia), processed by the Gaia Data Processing and Analysis Consortium (DPAC, https://www.cosmos.esa.int/web/gaia/dpac/consortium).

## Live viewer: all stars, near view, HYG close-up

FAR now draws every loaded tile star (639,404 when all 9 tiles are in) as GPU points in one preallocated buffer sized from `tiles.json` `total_records`. Each tile is written into it in 16,384-record chunks with a frame yield between chunks, and only the new range is uploaded (`addUpdateRange`). Size and brightness follow magnitude (faint stars small and dim). The 12,288-star `preview.bin` still paints first in its own layer and is hidden once every tile is in. Download order and two-at-a-time tile streaming are unchanged.

In a headless 412x915 touch run on the old code, a centred pinch at the default view reached near 12,288. Aiming at empty sky with no Gaia tile produced an empty near query. The likely cause on phones is that OrbitControls' default two-finger gesture combines dolly and pan, so a pinch slides the orbit target off the small Gaia patches. iOS Safari can also treat the pinch as page zoom. The fix changes two-finger gesture to dolly plus rotate with no pan, cancels Safari `gesture*` events on the canvas, and re-centres the target on the loaded star nearest screen centre (within 20 degrees) when the near query is empty before querying again. Thresholds are unchanged. After the fix the same empty-sky pinch gives 12,288 near.

Close-up stars use `data/hyg-near.bin` (58,222 bytes). It contains the 7,999 nearest stars from the StarIS Firebase app's `stars.json` (Sun removed), with real 3D positions in parsecs out to 47.6 pc and 206 proper names. They form a separate layer that fades in as the camera comes within 260 to 160 pc of the Sun. Names appear for named stars brighter than magnitude 2.5 or closer than 12 pc to the camera (24 labels max).

HYG2 format (little-endian): 24-byte header (`HYG2`, uint32 n, float32 scale_pc, float32 max_dist_pc, uint32 name_count, uint32 name_bytes); int16 x,y,z × n (pc = value × scale_pc, about 0.0014 pc steps); uint8 mag_q × n (mag = −2 + 0.1 × mag_q); name_count × (uint16 star index, uint8 byte length); then the UTF-8 names in table order.

Rebuild with: `curl -L -o stars.json https://staris-b01f2.firebaseapp.com/data/stars.json` then `python3 public/bin-lod/scripts/build-hyg-near.py stars.json` (writes only `data/hyg-near.bin`, re-reads and verifies it).

No double drawing occurs. HYG owns the solar neighbourhood. A Gaia record with a finite positive parallax whose distance 1000/parallax is at or inside the HYG file's max distance (47.6 pc) is skipped in both FAR and NEAR (4 records in the current tiles). HYG is the complete nearby set with names; the Gaia tiles have parallax for only 1,435 of 639,404 records and their brightest star is about magnitude 4.9, so a distance cutoff removes the overlap without positional cross-matching.

Data credit: HYG database by astronexus (David Nash), https://github.com/astronexus/HYG-Database, CC BY-SA 4.0. `data/hyg-near.bin` is a derived file and stays under CC BY-SA 4.0. `stars.json` was downloaded once from the app's public hosting to build the file. The viewer does not contact Firebase and nothing in Firebase was changed. The HYG layer uses the same point shader as the Gaia layers; fading is done by scaling colours, so it adds no shader compile when it first appears.

## Build note
Raw Drive shards stay off Pages. Only LOD tiles are published.

Headless checks use a global `WebSocket`. On Node 20, pass `--experimental-websocket` (`node --experimental-websocket scripts/check-bin-lod-progressive.mjs`, and the same flag for `scripts/check-bin-lod-throttle.mjs`, `scripts/check-bin-lod-fallback.mjs`, `scripts/check-bin-lod-errors.mjs`, `scripts/check-bin-lod-v2.mjs`, `scripts/check-bin-lod-v2-range.mjs`, and `scripts/check-bin-lod-mobile.mjs`). The mobile check loads the page at 412×915 (DPR 2, touch) throttled to 4 Mbps, pinches with real touch events, repeats the pinch after aiming at empty sky, and prints far / near / HYG counts, time to first draw, main-thread blocking and bytes; `REPORT_ONLY=1` prints without asserting.
