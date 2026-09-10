# StarIS BIN LOD — multi-tile Gaia batch

Walkable multi-tile LOD on GitHub Pages (Spark / $0). No Firebase Storage.

## Layout
- `data/tiles.json` — tile index (`id`, `url`, RA/Dec bounds, `n_records`, `bytes`, `stride`)
- `data/tiles/tile-XXX.bin` — stride-sampled 62-byte GaiaSource records (≤~5 MiB each)
- `data/catalog.bin` — legacy single-file fallback
- `js/lod-app.js` — loads `tiles.json`, fetches all LOD tiles, FAR unions across them

## Record layout
62 B LE: RA@+8, Dec@+16, parallax@+24, color@+56, mag@+58.

## Build note
Raw Drive shards stay off Pages. Only LOD tiles are published.
