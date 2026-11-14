# SPHEREx motion layer

Builds `public/bin-lod/data/spherex/<name>.json`, a static layer that bin-lod draws only with `?spherex=1`.

```
python tools/spherex-motion/build_layer.py \
  --visits tools/spherex-motion/fixtures/visits_barnard.json \
  --gaia tools/spherex-motion/fixtures/barnard_field_gaia_dr3.csv \
  --out public/bin-lod/data/spherex/barnard-field.json \
  --center 269.4580,4.7600 --size 0.25 --offline-dir <dir with the six FITS> --name "Barnard's Star field"
python -m pytest tools/spherex-motion -q
node scripts/check-spherex-motion.mjs
```

- Data: SPHEREx L2 spectral images (IRSA; public AWS mirror `nasa-irsa-spherex` when IRSA's cutout service is down), Gaia DR3, JPL SBDB.
- Visits: `fixtures/visits_barnard.json` was found by reading the FITS headers on the AWS mirror (IRSA SIA2/TAP returned 502 on 2026-11-14), DR1 2026-03-15..22 and QR3 2026-09-22.
- Motion rules (Quantum Desk spec, all thresholds in `DEFAULT_CFG` of `motion.py` and `spherex-motion.js`): FULL_3D (RV and parallax/error >= 5) straight-line 3D motion; SIDEWAYS_ONLY (label "sideways only"); STATIC (pm/error < 3, "motion not measured"); trust limit 0.1 deg / sigma_pm, FULL_3D also sigma_v*t <= 10% of distance, SIDEWAYS_ONLY also 0.1*d/50 km/s; fade + "uncertain" past it; cap +/-1 Myr ("approximate: galactic orbits not modeled").
- Barnard's Star: 10.39"/yr; 3.074 deg after 1,000 yr (full 3D, matches astropy apply_space_motion and Math Desk's staris_check.py), 2.887 deg sideways-only.
