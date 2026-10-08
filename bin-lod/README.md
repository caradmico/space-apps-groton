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

## Build note
Raw Drive shards stay off Pages. Only LOD tiles are published.

Headless checks use a global `WebSocket`. On Node 20, pass `--experimental-websocket` (`node --experimental-websocket scripts/check-bin-lod-progressive.mjs`, and the same flag for `scripts/check-bin-lod-throttle.mjs`, `scripts/check-bin-lod-fallback.mjs`, and `scripts/check-bin-lod-errors.mjs`).
