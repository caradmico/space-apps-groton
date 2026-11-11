# StarIS one-store design (backend fix)

**Owner goal (Cara):** Keep all space data in a single unified store to enable cross-dataset queries and rendering otherwise impossible. Storage format is secondary to fast, efficient client pulls.

---

## 1. One Store, One Shared 3D Frame

All objects are normalized into a single coordinate system before tiling: **Heliocentric ICRS Cartesian $(x, y, z)$ in parsecs (pc)**, epoch J2016.0 (Gaia DR3 reference; J2000.0 sources precessed or treated as co-aligned within arcsec tolerance).

### Coordinate Conversions by Source
*   **Gaia Stars (DR1/DR3):** $\alpha, \delta$ (ICRS) + distance $d$ (pc). Where $d = 1000 / \varpi_{\text{mas}}$ (naive) or Bailer-Jones photogeometric median $r_{\text{med\_photogeo}}$.
*   **SDSS DR17 Galaxies:** `AllGalaxies_caradmico.csv` (3,008,695 rows, 177.8 MB; `specObjID,ra,dec,z,g`, $z > 0.01$). Convert redshift $z \to$ comoving distance $D_C$ using **Planck18** cosmology ($H_0 = 67.66\text{ km s}^{-1}\text{ Mpc}^{-1}, \Omega_{m0} = 0.30966$, flat $\Lambda\text{CDM}$). Multiply $D_C\text{ [Mpc]} \times 10^6 \to \text{pc}$. *( replaces legacy galaxy codec v2 12-bit $\ln r$ cell quantization for the unified store, or wraps it).*
*   **Exoplanets (NASA Exoplanet Archive — size/rows UNVERIFIED):** Host star ICRS $\alpha, \delta$ and `sy_dist` (pc). Planets share host $(x,y,z)$ with a sub-record or child pointer.
*   **Small Bodies (JPL/MPC — size/rows UNVERIFIED):** Heliocentric ecliptic Keplerian elements propagated to fixed epoch $t_0 \to$ heliocentric ecliptic $(x_{\text{ecl}}, y_{\text{ecl}}, z_{\text{ecl}})$ in AU $\to$ rotate by obliquity $\varepsilon_{2000} = 23.4392911^\circ$ ($R_x(-\varepsilon)$) to ICRS equatorial $\to$ scale by $1\text{ AU} = 4.8481368 \times 10^{-6}\text{ pc}$.

### Precision Note
At galaxy scales ($D_C \sim 10^9\text{ pc}$) and solar system scales ($d \sim 10^{-5}\text{ pc}$), IEEE-754 `f32` (7 decimal digits, $\sim 60\text{ pc}$ ULP at $1\text{ Gpc}$) is sufficient for rendering LODs; `f64` is required if sub-AU relative precision is needed inside the same global coordinate float, OR store unit vector $(\hat{x},\hat{y},\hat{z})$ as `f32` / quantized oct-encoding + `f64` radial distance $r$ (pc).

### Unified Record Schema (32 Bytes, Little-Endian)
Fixed-width 32 B record (down from 62 B in DR1 bins):

| Offset | Type | Field | Description |
| :--- | :--- | :--- | :--- |
| 0 | `u64` | `id` | Source ID (`source_id`, `specObjID`, MPC packed ID, etc.) |
| 8 | `f32` | `x` | ICRS $x$ (pc) — or $\hat{x}$ if split radial |
| 12 | `f32` | `y` | ICRS $y$ (pc) |
| 16 | `f32` | `z` | ICRS $z$ (pc) |
| 20 | `f32` | `mag` | Apparent magnitude ($G$ or SDSS $g$) |
| 24 | `f32` | `lum_or_z` | Absolute lum $L$ ($L_\odot$) for stars, or redshift $z$ for galaxies |
| 28 | `u8` | `obj_type` | `1`=Star, `2`=Galaxy, `3`=ExoplanetHost, `4`=SmallBody, `5`=QSO (UNVERIFIED) |
| 29 | `u8` | `dist_qual` | Bitfield: `0`=No dist (2D sky shell), `1`=$\varpi/\sigma_\varpi>10$, `2`=$\varpi>0$ low SNR, `3`=Bailer-Jones prior, `4`=Spectroscopic $z$, `5`=Ephemeris |
| 30 | `u16` | `color` | $G_{\text{BP}}-G_{\text{RP}}$ or $g-r$ quantized (milli-mag offset) or legacy class `1/2/3` |

---

## 2. One Tile Format

Spatial partitioning via **3D Octree** (or nested **HEALPix + radial log-shells**). Every node/tile maps to a contiguous slice in a packfile (or 1 file per coarse macro-tile) fetched via **HTTP `Range: bytes=start-end`**.

### In-Tile Ordering & LOD
Within every tile, records are **strictly sorted brightest-first** (descending flux / ascending apparent magnitude, or descending absolute luminosity $L$ for 3D spatial octrees).
*   **Prefix Fetch = Top-$N$:** A client needing only $k$ objects for the current screen-space solid angle issues a single byte-range request for `offset .. offset + k * 32`. No server compute required.
*   **Node Metadata:** Each tile index entry stores `L_max` (brightest object luminosity/flux in node) and `L_total` (integrated luminosity/flux of all children) for deterministic screen-space error / LOD culling.

### Binary File Layout (`.stis` pack)
1.  **Global Header (64 B):** Magic `"STIS"`, version (`u16`), frame flag (`u16`), total nodes (`u32`), total records (`u64`), radial bounds (`f64 min_pc, max_pc`), reserved.
2.  **Tile Index Table (`N_nodes * 32 B`):**
    *   `u64 tile_id` (Morton octree key or `(healpix_nested << 8) | r_shell`)
    *   `u64 byte_offset` (start of record array)
    *   `u32 record_count`
    *   `f32 L_max` (brightest object in tile)
    *   `f32 L_total` (sum of $L$ in tile for unresolved glow)
    *   `u32 flags` (object type bitmask present in tile)
3.  **Payload Section:** Back-to-back 32 B records, sorted brightest-first per tile.

---

## 3. Gaia DR3 Ingest Paths

Gaia DR3 full `gaia_source` on ESA CDN is **3,386 `GaiaSource_*.csv.gz` files, 753,025,661,884 B (~701.3 GiB), 1.81B sources (~1.47B with parallax)** (verified).

### Path A: TAP Bright / High-SNR Subset
Query ESA/ARI Gaia TAP for high-quality 3D stars.
*   **Row count / size:** **UNVERIFIED** (estimated $\sim 20\text{M}–100\text{M}$ rows depending on cuts; at 32 B/record = $0.64–3.2\text{ GB}$ binary).
*   **Effort:** Low (single async TAP job or chunked by `source_id` / HEALPix).
*   **ADQL:**
```sql
SELECT source_id, ra, dec, parallax, parallax_over_error,
       phot_g_mean_mag, bp_rp
FROM gaiadr3.gaia_source
WHERE parallax_over_error > 10
  AND phot_g_mean_mag < 18.0
```

### Path B: Full 753 GB Streaming Ingest
Stream all 3,386 `.csv.gz` files sequentially or in small worker pools: download $\to$ gunzip in memory $\to$ parse columns $\to$ append to local spatial bucket files $\to$ delete `.csv.gz` $\to$ mark completed in `manifest.json` (for crash/resume).
*   **Output Size:**
    *   Full 1.47B 3D stars @ 32 B = ~47 GB.
    *   Free-tier Q8 quantized depth variant = **~14.5 GB** (exceeds R2 10 GB free cap).
    *   HEALPix orders 0–6 cap (**67.1M stars**) = **537 MB** (fits free static hosts).
*   **Effort:** Medium-High (network I/O bound on 753 GB download + disk sort for tile building).

### Path C: Bailer-Jones EDR3 Distances Join
Join `external.gaiaedr3_distance` (~1.47B rows; **total byte size on CDN/TAP UNVERIFIED**) by `source_id` to replace naive $1000/\varpi$ with `r_med_photogeo` (handles negative/low-SNR parallaxes gracefully).
*   **Effort:** High if joining 1.47B rows locally (requires co-partitioned `source_id` merge-join stream); Low if done server-side inside Path A TAP query (`JOIN external.gaiaedr3_distance USING (source_id)`).

---

## 4. Hosting & Cost per Path

*(All pricing and tier quotas below are **UNVERIFIED / to be re-checked** against current provider terms).*

| Host | Free Tier Limits (UNVERIFIED) | Fit for Orders 0–6 (537 MB + ~96 MB Galaxies) | Fit for Q8 (14.5 GB) / Full (47 GB) | HTTP Range Support |
| :--- | :--- | :--- | :--- | :--- |
| **GitHub Pages** | 1 GB site soft limit, **100 MB max file size**, 100 GB/mo bandwidth | **Yes**, if sharded into $<100\text{ MB}$ packfiles | **No** | Yes (via Fastly CDN) |
| **Firebase Hosting (Spark / Free)** | 10 GB storage, 360 MB/day (~10.8 GB/mo) transfer | **Yes** (storage), tight on daily bandwidth | **No** | Yes |
| **Hugging Face Datasets / Internet Archive** | Multi-TB free public datasets (fair use) | **Yes** | **Yes** (latency/throttling UNVERIFIED) | Yes |
| **Cloudflare R2** | **10 GB-month storage free**, 1M Class A / 10M Class B ops free, **zero egress ($0/GB)** | **Yes ($0/mo)** | **Paid** over 10 GB ($0.015/GB-month) | Yes |

### Cara Review List (Paid Options)
*   **Cloudflare R2 overage (Q8 14.5 GB build):** ~4.5 GB over free tier $\times \$0.015/\text{GB-mo} \approx \mathbf{\$0.07/\text{month}}$ (+ Class A/B request overages if >10M Range reads/mo). *(Price to be re-checked).*
*   **Cloudflare R2 overage (Full 1.47B star 32 B build, ~47 GB):** ~37 GB over free tier $\times \$0.015/\text{GB-mo} \approx \mathbf{\$0.56/\text{month}}$. *(Price to be re-checked).*

---

## 5. DR1 Bins Policy

*   **Verified State:** 5,217 `.bin` files on Drive (65.80 GiB / 70,656,528,474 B), 14 missing slots (`.fits`); 1,139,621,427 stars (99.73% of DR1's 1,142,679,769). 62 B LE records (`int64 source_id, f64 ra, f64 dec, f64 plx, 3xf64 xyz, u16 color 1/2/3, f32 G_mag`). Only ~0.2% (~2M TGAS stars) have `plx > 0` (`|xyz| = 1000/plx`).
*   **Retention Rule:** **Keep untouched on Drive. Never delete.**
*   **Role in One-Store:**
    1.  The ~2M TGAS 3D positions in DR1 are completely superseded in accuracy and volume by Gaia DR3 (~1.47B parallaxes).
    2.  DR1 bins remain the archival 2D sky fallback (`dist_qual = 0`).
    3.  **Crosswalk Caveat:** Gaia `source_id` values are **not guaranteed identical** between DR1 and DR3 (astrometric solution splits/merges). Cross-matching requires official neighbourhood tables (e.g., `gaiadr3.dr2_neighbourhood` chained with DR1$\leftrightarrow$DR2, or `gaiadr1_neighbourhood` — **exact table names UNVERIFIED**). Do not blindly key-join DR1 `.bin` records to DR3 by `source_id`.

---

## 6. Open Decisions for Cara

1.  **DR3 Ingest Scope:** Start with **Orders 0–6 (67.1M stars, 537 MB)** + SDSS Galaxies (~96 MB binary) to stay 100% inside free tiers (R2 / GitHub Pages), or authorize the **R2 paid overage (~$0.07–$0.56/mo)** for the 14.5 GB / 47 GB store?
2.  **Distance Estimator:** Is naive $d = 1000/\varpi$ (filtered by $\varpi/\sigma_\varpi > 10$) acceptable for v1 of the unified store, or is the **Bailer-Jones photogeometric join** required immediately?
3.  **Coordinate Precision in Record:** Use **32 B record with `f32` $(x,y,z)$** (fast, compact, ~60 pc quantization at 1 Gpc, blurs intra-AU solar system offsets unless heliocentric rendering shifts origin), or expand to **36 B (`f32` unit vector + `f64` radial distance)** to preserve sub-meter precision from 1 AU out to 10 Gpc?
4.  **Colour Rule Backfill:** Keep legacy `u16` colour class (`1/2/3`) for backwards compatibility with the existing shader, or switch `u16 color` to quantized $G_{\text{BP}}-G_{\text{RP}}$ / SDSS $g-r$?