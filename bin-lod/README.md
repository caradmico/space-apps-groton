# StarIS BIN LOD v0 (Spark)

Done-when slice: load a massive `.BIN` point catalog in-browser **without freezing**.

## Format (from Cara’s pre-strip SpaceIS)

62 bytes / record, little-endian:
- `+32` float64 x, `+40` y, `+48` z (store as value/206265)
- `+56` uint16 color class
- `+58` float32 mag

Her old client fetched `gaia_processed.bin` from Firebase Storage and parsed up to 100k into JS objects — that one-file path froze.

## LOD

- **Far:** stride sample (generalized)
- **Near:** bounded accurate subset for cells near the camera target
- Never builds a full `Array<{…}>` of the catalog

## Data note

`public/data/catalog.bin` is a **format-compatible** 250k-record catalog (HYG-derived jitter) for Spark demo because live Storage `gaia_processed.bin` returned **404** on 2026-09-04. Drop her real BIN at the same path when restored.
