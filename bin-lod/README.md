# StarIS BIN LOD (Spark, $0)

In-browser viewer for Cara’s SpaceIS **62-byte LE** point catalog. Product win is LOD: **far = generalized stride sample**, **near = bounded accurate subset** around the camera target. The file stays an `ArrayBuffer`. This demo **never** builds a full JavaScript array of star objects (that path froze at a 100k cap).

Live stranger URL (GitHub Pages, after merge):  
https://caradmico.github.io/space-apps-groton/bin-lod/

No GCP, Blaze, Functions, or Firebase Storage. Three.js is loaded from unpkg via importmap, same pattern as Path A (`https://staris-b01f2.firebaseapp.com/`). This page is **not** a polish of the HYG local-star sphere.

## Record layout (exact — pre-strip bundle)

62 bytes / record, little-endian:

| Offset | Type | Field |
|--------|------|--------|
| +0 … +31 | — | unused by this viewer (id / reserved) |
| +32 | float64 | x stored as `value / 206265` |
| +40 | float64 | y stored as `value / 206265` |
| +48 | float64 | z stored as `value / 206265` |
| +56 | uint16 | color class |
| +58 | float32 | mag |

On read, multiply x/y/z by **206265**.

## `data/catalog.bin` in this repo

**Format-compatible synthetic catalog** (65,536 records; galactic-disk jitter). It is **not** the live Gaia dump.

The viewer fetches **`./data/catalog.bin`** (Pages URL: `https://caradmico.github.io/space-apps-groton/bin-lod/data/catalog.bin`). That file must exist on the `gh-pages` branch at `bin-lod/data/catalog.bin`. A 2026-09-04 Pages 404 happened because an earlier main slice shipped HTML/CSS/JS without the sample catalog.

On **2026-09-04**, Firebase Storage `gaia_processed.bin` for project `staris-b01f2` also returned **HTTP 404**, so this Spark demo ships a generated stand-in instead of a Storage fetch. Do not fetch Storage.

Regenerate:

```bash
node public/bin-lod/scripts/generate-catalog.mjs
```

## Drop the real catalog

1. Copy Cara’s `gaia_processed.bin` over `public/bin-lod/data/catalog.bin` (same 62-byte records).
2. Redeploy Pages (`main` → `gh-pages` via the existing workflow), or open `public/bin-lod/` locally.
3. Keep the file Hosting/Pages-sized. The viewer indexes with typed arrays and yields so a large file does not freeze the tab the way a full JS object graph did.

Do not point this demo at Cloud Functions or the Storage bucket. Spark only.
