# StarIS BIN LOD (Spark, $0)

In-browser viewer for Cara’s SpaceIS **62-byte LE** point catalog. Product win is LOD: **far = generalized stride sample**, **near = bounded accurate subset** around the camera target. The file stays an `ArrayBuffer`. This demo **never** builds a full JavaScript array of star objects (that path froze at a 100k cap).

Live stranger URL (GitHub Pages, after merge):  
https://caradmico.github.io/space-apps-groton/bin-lod/

No GCP, Blaze, Functions, or Firebase Storage. Three.js is loaded from unpkg via importmap, same pattern as Path A (`https://staris-b01f2.firebaseapp.com/`). This page is **not** a polish of the HYG local-star sphere.

## Record layout

62 bytes / record, little-endian. **GaiaSource Drive shards are RA/Dec (+ optional parallax), not precomputed xyz.** The previous synthetic HYG catalog stored xyz at +32/+40/+48; Cara’s GaiaSource bins do not (those slots are ~0 / unused, which is why an xyz-only reader collapsed to a center dot).

### GaiaSource (live `catalog.bin`)

| Offset | Type | Field |
|--------|------|--------|
| +8 | float64 | RA degrees |
| +16 | float64 | Dec degrees |
| +24 | float64 | parallax mas (often NaN; only ~0.3% finite) |
| +56 | uint16 | color class |
| +58 | float32 | mag |

On read: skip NaN RA/Dec. If parallax is finite and `> 0`, `distance_pc = 1000 / parallax_mas` and convert RA/Dec/distance to Cartesian (standard equatorial). Otherwise place the star on a fixed-radius sphere from RA/Dec so the sky tile is visible. Mag at +58 still drives point size. The camera auto-frames the mean sky direction / projected bbox.

### Legacy StarIS / synthetic xyz

| Offset | Type | Field |
|--------|------|--------|
| +32 | float64 | x stored as `value / 206265` |
| +40 | float64 | y stored as `value / 206265` |
| +48 | float64 | z stored as `value / 206265` |
| +56 | uint16 | color class |
| +58 | float32 | mag |

On read, multiply x/y/z by **206265**. The viewer auto-detects this path when `>50%` of a sample has nonzero finite xyz at +32/+40/+48.

## `data/catalog.bin` in this repo

**Drive-derived GaiaSource sample** (85,290 × 62 B). It is a sky-tile shard (RA ~311–318°, Dec ~−4.8–0°), not a precomputed xyz cube and not the old generated HYG stand-in.

The viewer fetches **`./data/catalog.bin`** (Pages URL: `https://caradmico.github.io/space-apps-groton/bin-lod/data/catalog.bin`). That file must exist on the `gh-pages` branch at `bin-lod/data/catalog.bin`. Do not replace it with the synthetic generator unless you are testing the xyz path.

The xyz generator still exists for format experiments:

```bash
node public/bin-lod/scripts/generate-catalog.mjs
```

## Drop another shard

1. Copy a GaiaSource 62-byte LE shard over `public/bin-lod/data/catalog.bin` (RA/Dec at +8/+16).
2. Redeploy Pages (`main` → `gh-pages` via the existing workflow), or open `public/bin-lod/` locally.
3. Keep the file Hosting/Pages-sized. The viewer indexes with typed arrays and yields so a large file does not freeze the tab the way a full JS object graph did.

Do not point this demo at Cloud Functions or the Storage bucket. Spark only.
