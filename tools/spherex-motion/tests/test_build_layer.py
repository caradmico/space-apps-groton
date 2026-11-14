from __future__ import annotations

import csv
import json
import math
import sys
from pathlib import Path

import astropy.units as u
import numpy as np
import pytest
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build_layer  # noqa: E402
import motion  # noqa: E402


BARNARD = {
    "source_id": "4472832130942575872",
    "ra": 269.44850252543836,
    "dec": 4.739420051112412,
    "parallax": 546.975939730948,
    "parallax_error": 0.040116355,
    "pmra": -801.5509783684709,
    "pmra_error": 0.031820867,
    "pmdec": 10362.394206546573,
    "pmdec_error": 0.036070455,
    "radial_velocity": -110.46822,
    "radial_velocity_error": 0.13125522,
    "phot_g_mean_mag": 8.19,
}


def make_mef(
    path: Path,
    rot_deg: float = 37.0,
    stars: list[tuple[float, float, float]] | None = None,
    det: int = 2,
    mjd: float = 60500.0,
    center: tuple[float, float] = (269.45, 4.74),
    wave_range: tuple[float, float] = (1.0, 1.6),
) -> Path:
    ny, nx = 256, 256
    scale_deg = 6.15 / 3600.0
    theta = math.radians(rot_deg)
    ct, st = math.cos(theta), math.sin(theta)

    hdr = fits.Header()
    hdr["NAXIS"] = 2
    hdr["NAXIS1"] = nx
    hdr["NAXIS2"] = ny
    hdr["CTYPE1"] = "RA---TAN-SIP"
    hdr["CTYPE2"] = "DEC--TAN-SIP"
    hdr["CRPIX1"] = 128.5
    hdr["CRPIX2"] = 128.5
    hdr["CRVAL1"] = float(center[0])
    hdr["CRVAL2"] = float(center[1])
    hdr["CDELT1"] = -scale_deg
    hdr["CDELT2"] = scale_deg
    hdr["PC1_1"] = ct
    hdr["PC1_2"] = -st
    hdr["PC2_1"] = st
    hdr["PC2_2"] = ct
    hdr["A_ORDER"] = 2
    hdr["A_2_0"] = 1e-6
    hdr["B_ORDER"] = 2
    hdr["B_0_2"] = -1e-6
    hdr["DATE-AVG"] = "2024-07-09T00:00:00.000"
    hdr["MJD-AVG"] = float(mjd)
    hdr["DETECTOR"] = int(det)
    hdr["X_SC_START"] = 6800.0
    hdr["Y_SC_START"] = -1200.0
    hdr["Z_SC_START"] = 500.0

    src_wcs = WCS(hdr)
    rng = np.random.default_rng(42 + int(det))
    img = rng.normal(10.0, 0.2, size=(ny, nx)).astype(np.float32)
    yy, xx = np.indices((ny, nx), dtype=float)
    sigma_psf = 1.2

    if stars:
        for s_ra, s_dec, flux in stars:
            sx, sy = src_wcs.all_world2pix([s_ra], [s_dec], 0, quiet=True)
            x0, y0 = float(sx[0]), float(sy[0])
            psf = np.exp(-0.5 * ((xx - x0) ** 2 + (yy - y0) ** 2) / (sigma_psf**2))
            psf /= np.sum(psf)
            img += (float(flux) * psf).astype(np.float32)

    var = np.full((ny, nx), 0.04, dtype=np.float32)

    flags_arr = np.zeros((ny, nx), dtype=np.int32)
    flags_arr[10:15, 10:15] = 1024  # HOT bad block
    flags_arr[120:136, 120:136] = 2097152  # SOURCE bit (must NOT be masked)
    fhdr = fits.Header()
    bit_defs = [
        ("TRANSIENT", 1),
        ("OVERFLOW", 2),
        ("SUR_ERROR", 4),
        ("NONFUNC", 64),
        ("MISSING_DATA", 512),
        ("HOT", 1024),
        ("COLD", 2048),
        ("NONLINEAR", 32768),
        ("PERSIST", 131072),
        ("OUTLIER", 524288),
        ("SOURCE", 2097152),
    ]
    for idx, (bname, bmask) in enumerate(bit_defs, start=1):
        fhdr[f"MSKN{idx:04d}"] = bname
        fhdr[f"MSKM{idx:04d}"] = bmask

    xg = np.linspace(1, nx, 11).round().astype(np.int32)
    yg = np.linspace(1, ny, 11).round().astype(np.int32)
    values = np.zeros((11, 11, 2), dtype=np.float32)
    w_line = np.linspace(wave_range[0], wave_range[1], 11, dtype=np.float32)
    for iy in range(11):
        values[iy, :, 0] = w_line[iy]
        values[iy, :, 1] = 0.03
    col_x = fits.Column(name="X", format="11J", dim="(11)", array=xg[None, :])
    col_y = fits.Column(name="Y", format="11J", dim="(11)", array=yg[None, :])
    col_v = fits.Column(name="VALUES", format="242E", dim="(2,11,11)", array=values[None, ...])
    wave_hdu = fits.BinTableHDU.from_columns([col_x, col_y, col_v], name="WCS-WAVE")

    hdul = fits.HDUList(
        [
            fits.PrimaryHDU(),
            fits.ImageHDU(data=img, header=hdr, name="IMAGE"),
            fits.CompImageHDU(data=flags_arr, header=fhdr, name="FLAGS"),
            fits.ImageHDU(data=var, header=hdr, name="VARIANCE"),
            wave_hdu,
        ]
    )
    hdul.writeto(path, overwrite=True)
    return path


def test_reproject_and_detect_accuracy(tmp_path: Path):
    center = (269.45, 4.74)
    truth = [
        (269.45, 4.74, 400.0),
        (269.435, 4.752, 350.0),
        (269.462, 4.728, 380.0),
    ]
    mef_path = make_mef(tmp_path / "exp1.fits", rot_deg=37.0, stars=truth, center=center)
    with fits.open(mef_path) as hdul:
        img = hdul["IMAGE"].data
        var = hdul["VARIANCE"].data
        flg = hdul["FLAGS"].data
        bad_mask = build_layer.build_bad_flag_mask(hdul["FLAGS"].header, build_layer.DEFAULT_BUILD_CFG["bad_flag_names"])
        src_wcs = WCS(hdul["IMAGE"].header)
        rep_im, rep_var, rep_valid, target_wcs, _ = build_layer.reproject_north_up(
            img, var, flg, bad_mask, src_wcs, center, size_deg=0.08
        )

    assert target_wcs.wcs.cdelt[0] < 0
    assert target_wcs.wcs.cdelt[1] > 0
    assert np.allclose(target_wcs.wcs.get_pc(), np.eye(2))

    dets = build_layer.detect_sources(rep_im, rep_var, rep_valid, target_wcs, detect_k=5.0)
    px_scale_deg = abs(target_wcs.wcs.cdelt[1])
    for tra, tdec, _ in truth:
        seps_px = [motion.angular_sep_deg(tra, tdec, d["ra"], d["dec"]) / px_scale_deg for d in dets]
        assert min(seps_px) < 0.3


def test_wavelength_at_bilinear(tmp_path: Path):
    mef_path = make_mef(tmp_path / "wave.fits", wave_range=(1.0, 1.6))
    with fits.open(mef_path) as hdul:
        w0, fb0 = build_layer.wavelength_at(hdul, 128.0, 0.0)
        w1, fb1 = build_layer.wavelength_at(hdul, 128.0, 255.0)
        wm, fbm = build_layer.wavelength_at(hdul, 64.0, 127.5)
        assert not (fb0 or fb1 or fbm)
        assert abs(w0 - 1.0) < 1e-4
        assert abs(w1 - 1.6) < 1e-4
        assert abs(wm - 1.3) < 1e-2


def test_bad_flag_mask_excludes_source(tmp_path: Path):
    mef_path = make_mef(tmp_path / "flags.fits")
    with fits.open(mef_path) as hdul:
        fhdr = hdul["FLAGS"].header
        mask = build_layer.build_bad_flag_mask(fhdr, build_layer.DEFAULT_BUILD_CFG["bad_flag_names"])
        assert (mask & 1024) != 0
        assert (mask & 2097152) == 0


def test_match_and_ambiguous_and_unmatched():
    px_scale_deg = 6.15 / 3600.0
    gaia_stars = [
        {
            "gaia_id": "1001",
            "ra": 269.4500,
            "dec": 4.7400,
            "parallax": 10.0,
            "parallax_error": 0.1,
            "pmra": 0.0,
            "pmra_error": 0.05,
            "pmdec": 0.0,
            "pmdec_error": 0.05,
            "rv": 0.0,
            "rv_error": 0.1,
        },
        {
            "gaia_id": "1002",
            "ra": 269.4500,
            "dec": 4.7400 + (2.0 / 3600.0),
            "parallax": 10.0,
            "parallax_error": 0.1,
            "pmra": 0.0,
            "pmra_error": 0.05,
            "pmdec": 0.0,
            "pmdec_error": 0.05,
            "rv": 0.0,
            "rv_error": 0.1,
        },
    ]
    detections = [
        {"ra": 269.4500, "dec": 4.7400 + (0.4 / 3600.0), "snr": 25.0, "flux": 100.0},
        {"ra": 269.4800, "dec": 4.7600, "snr": 12.0, "flux": 50.0},
    ]
    matched, ambig, unmatched = build_layer.match_detections_to_gaia(
        detections, gaia_stars, mjd=57388.5, pixel_scale_deg=px_scale_deg, cfg=build_layer.DEFAULT_BUILD_CFG
    )
    assert "1001" in matched
    assert "1001" in ambig
    assert len(unmatched) == 1


def test_false_colour_short_only():
    samples = [(1.1, 50.0), (1.4, 70.0)]
    rgb, partial = build_layer.compute_false_color(samples, [0.75, 1.6, 3.0, 5.0])
    assert rgb == [0.0, 0.0, 1.0]
    assert partial is True


def _write_gaia_csv(path: Path, rows: list[dict]):
    cols = [
        "source_id",
        "ra",
        "dec",
        "parallax",
        "parallax_error",
        "pmra",
        "pmra_error",
        "pmdec",
        "pmdec_error",
        "radial_velocity",
        "radial_velocity_error",
        "phot_g_mean_mag",
    ]
    with open(path, "w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in cols})


def test_end_to_end_and_pending_build_layer(tmp_path: Path):
    offline = tmp_path / "offline"
    offline.mkdir()
    mjd1, mjd2 = 60400.0, 60580.0
    p1 = motion.propagate_star(BARNARD, (mjd1 - 57388.5) / 365.25)
    p2 = motion.propagate_star(BARNARD, (mjd2 - 57388.5) / 365.25)

    make_mef(offline / "exp_a.fits", rot_deg=25.0, stars=[(p1["ra"], p1["dec"], 500.0)], det=1, mjd=mjd1)
    make_mef(offline / "exp_b.fits", rot_deg=-40.0, stars=[(p2["ra"], p2["dec"], 520.0)], det=2, mjd=mjd2)

    visits = [
        {
            "obsid": "obs1",
            "collection": "spherex_qr1",
            "date_avg_utc": "2024-03-31T00:00:00Z",
            "mjd_avg": mjd1,
            "detector": 1,
            "s3_url": "https://example.invalid/spherex/1/D1_exp_a.fits",
            "irsa_url": "https://example.invalid/cutout/exp_a.fits",
        },
        {
            "obsid": "obs2",
            "collection": "spherex_qr1",
            "date_avg_utc": "2024-09-27T00:00:00Z",
            "mjd_avg": mjd2,
            "detector": 2,
            "s3_url": "https://example.invalid/spherex/2/D2_exp_b.fits",
            "irsa_url": "https://example.invalid/cutout/exp_b.fits",
        },
    ]
    # Rename offline files to match basename of s3_url
    (offline / "exp_a.fits").rename(offline / "D1_exp_a.fits")
    (offline / "exp_b.fits").rename(offline / "D2_exp_b.fits")

    visits_path = tmp_path / "visits.json"
    visits_path.write_text(json.dumps(visits), encoding="utf-8")
    gaia_path = tmp_path / "gaia.csv"
    _write_gaia_csv(gaia_path, [BARNARD])

    out_real = tmp_path / "out_real.json"
    build_layer.build_layer(
        visits_path=str(visits_path),
        gaia_path=str(gaia_path),
        out_path=str(out_real),
        center=(269.45, 4.76),
        size_deg=0.08,
        offline_dir=str(offline),
    )
    txt = out_real.read_text(encoding="utf-8")
    assert "NaN" not in txt
    data = json.loads(txt)
    assert data["schema_version"] == 1
    assert data["meta"]["pixels"] == "real"
    assert len(data["stars"]) == 1
    assert len(data["stars"][0]["detections"]) == 2
    # Both synthetic exposures cover only the short group (1.0–1.6 µm).
    assert data["stars"][0]["ir_tag"] == "insufficient data"
    assert data["stars"][0]["ir_rgb"] is None
    assert data["meta"]["ir_color_caption"] == build_layer.IR_COLOR_CAPTION

    empty_dir = tmp_path / "empty_offline"
    empty_dir.mkdir()
    out_pending = tmp_path / "out_pending.json"
    build_layer.build_layer(
        visits_path=str(visits_path),
        gaia_path=str(gaia_path),
        out_path=str(out_pending),
        center=(269.45, 4.76),
        size_deg=0.08,
        offline_dir=str(empty_dir),
    )
    pdata = json.loads(out_pending.read_text(encoding="utf-8"))
    assert pdata["meta"]["pixels"] == "pending"
    assert len(pdata["stars"]) == 1
    assert pdata["stars"][0]["detections"] == []


def test_official_group_edges_and_real_wavelengths():
    # 1.62 -> short (<1.63), 1.63 & 3.82 -> mid ([1.63, 3.83)), 3.83 -> long (>=3.83)
    waves = [1.62, 1.63, 3.82, 3.83]
    fluxes = [100.0, 80.0, 60.0, 50.0]
    errs = [5.0, 4.0, 3.0, 2.5]
    from band_to_color import INSUFFICIENT_TAG, colorize
    res = colorize({"wavelength_um": waves, "flux": fluxes, "flux_error": errs})
    assert res["tag"] != INSUFFICIENT_TAG
    groups = res["groups"]
    assert groups["short"]["n_channels"] == 1
    assert abs(groups["short"]["mean_wavelength_um"] - 1.62) < 1e-6
    assert groups["mid"]["n_channels"] == 2
    assert abs(groups["mid"]["mean_wavelength_um"] - ((1.63 + 3.82) / 2.0)) < 1e-6
    assert groups["long"]["n_channels"] == 1
    assert abs(groups["long"]["mean_wavelength_um"] - 3.83) < 1e-6


def test_compute_star_ir_color_hot_vs_insufficient():
    from band_to_color import INSUFFICIENT_TAG

    hot_samples = [
        (1.10, 300.0, 10.0),
        (1.50, 260.0, 10.0),
        (2.20, 100.0, 5.0),
        (4.10, 40.0, 2.0),
    ]
    hot = build_layer.compute_star_ir_color(hot_samples)
    assert hot["ir_tag"] == "blue/hot"
    assert hot["ir_rgb"] is not None
    assert len(hot["ir_rgb"]) == 3
    assert hot["ir_rgb"][2] > hot["ir_rgb"][0]  # B > R
    assert hot["ir_hex"].startswith("#") and hot["ir_hex"].lower() != "#808080"

    no_long = [
        (1.20, 100.0, 5.0),
        (2.40, 100.0, 5.0),
    ]
    insuf = build_layer.compute_star_ir_color(no_long)
    assert insuf["ir_tag"] == INSUFFICIENT_TAG
    assert insuf["ir_hex"].lower() == "#808080"
    assert insuf["ir_rgb"] is None

    empty = build_layer.compute_star_ir_color([])
    assert empty["ir_tag"] == INSUFFICIENT_TAG
    assert empty["ir_rgb"] is None


def test_steep_short_slope_does_not_abort_colorize():
    """A steep short-group power law overflowed math.exp in ir_excess_ratio
    on real FITS; the guard must keep colorize() from aborting the build.
    With all three groups present, a color tag (not a crash) is returned.
    """
    from band_to_color import INSUFFICIENT_TAG, colorize

    samples = [
        (1.00, 1e-6, 1e-8),
        (1.50, 1e6, 1e4),
        (2.50, 1.0, 0.05),
        (4.20, 1.0, 0.05),
    ]
    res = colorize(
        {
            "wavelength_um": [s[0] for s in samples],
            "flux": [s[1] for s in samples],
            "flux_error": [s[2] for s in samples],
        }
    )
    assert res["tag"] in ("blue/hot", "neutral", "red/cool", "dusty/IR excess", INSUFFICIENT_TAG)
    out = build_layer.compute_star_ir_color(samples)
    assert out["ir_tag"] in ("blue/hot", "neutral", "red/cool", "dusty/IR excess", INSUFFICIENT_TAG)
    if out["ir_tag"] == INSUFFICIENT_TAG:
        assert out["ir_rgb"] is None
    else:
        assert out["ir_rgb"] is not None and len(out["ir_rgb"]) == 3


def test_motion_physics_and_astropy_agreement():
    assert motion.classify_motion(BARNARD) == "FULL_3D"

    p1 = motion.propagate_star(BARNARD, 1.0)
    sep1_arcsec = motion.angular_sep_deg(BARNARD["ra"], BARNARD["dec"], p1["ra"], p1["dec"]) * 3600.0
    assert 10.3 <= sep1_arcsec <= 10.4

    p1000 = motion.propagate_star(BARNARD, 1000.0)
    sep1000_deg = motion.angular_sep_deg(BARNARD["ra"], BARNARD["dec"], p1000["ra"], p1000["dec"])
    assert 3.0 <= sep1000_deg <= 3.15

    sc0 = SkyCoord(
        ra=BARNARD["ra"] * u.deg,
        dec=BARNARD["dec"] * u.deg,
        distance=(1000.0 / BARNARD["parallax"]) * u.pc,
        pm_ra_cosdec=BARNARD["pmra"] * u.mas / u.yr,
        pm_dec=BARNARD["pmdec"] * u.mas / u.yr,
        radial_velocity=BARNARD["radial_velocity"] * u.km / u.s,
        obstime=Time(2016.0, format="jyear"),
    )
    sc1000 = sc0.apply_space_motion(new_obstime=Time(3016.0, format="jyear"))
    diff_arcsec = motion.angular_sep_deg(p1000["ra"], p1000["dec"], sc1000.ra.deg, sc1000.dec.deg) * 3600.0
    assert diff_arcsec < 1.0

    barnard_sideways = dict(BARNARD)
    barnard_sideways["radial_velocity"] = None
    assert motion.classify_motion(barnard_sideways, {"plx_snr_min": 1e9}) == "SIDEWAYS_ONLY"
    ps = motion.propagate_star(barnard_sideways, 1000.0, {"plx_snr_min": 1e9})
    seps_deg = motion.angular_sep_deg(BARNARD["ra"], BARNARD["dec"], ps["ra"], ps["dec"])
    assert 2.85 <= seps_deg <= 2.92

    sideways_10pc = {
        "ra": 180.0,
        "dec": 0.0,
        "parallax": 100.0,
        "parallax_error": 1.0,
        "pmra": 50.0,
        "pmra_error": 0.001,
        "pmdec": 0.0,
        "pmdec_error": 0.001,
        "rv": None,
    }
    assert motion.classify_motion(sideways_10pc) == "SIDEWAYS_ONLY"
    t_trust = motion.trust_limit_years(sideways_10pc)
    assert 19000.0 <= t_trust <= 20100.0

    static_star = {
        "ra": 10.0,
        "dec": -5.0,
        "parallax": 1.0,
        "parallax_error": 0.8,
        "pmra": 1.0,
        "pmra_error": 1.0,
        "pmdec": 1.0,
        "pmdec_error": 1.0,
    }
    assert motion.classify_motion(static_star) == "STATIC"

    past_trust = motion.propagate_star(sideways_10pc, t_trust * 1.5)
    assert past_trust["state"] == "uncertain"
    assert past_trust["alpha"] >= motion.DEFAULT_CFG["fade_floor"]

    past_cap = motion.propagate_star(BARNARD, 1.5e6)
    assert past_cap["state"] == "approximate"


def test_kepler_and_asteroid_parallax():
    el = {"a": 1.0, "e": 0.0, "i": 0.0, "om": 0.0, "w": 0.0, "ma": 0.0, "epoch_jd": 2460000.5}
    r0 = motion.asteroid_helio_ecl(el, 2460000.5)
    assert np.allclose(r0, [1.0, 0.0, 0.0], atol=1e-6)
    quarter_period = 365.2568983 / 4.0
    rq = motion.asteroid_helio_ecl(el, 2460000.5 + quarter_period)
    assert np.allclose(rq, [0.0, 1.0, 0.0], atol=1e-6)

    el_ast = {"a": 2.5, "e": 0.0, "i": 0.0, "om": 0.0, "w": 0.0, "ma": 0.0, "epoch_jd": 2460000.5}
    obs_geo = np.array([1.0, 0.0, 0.0])  # asteroid is at (2.5, 0, 0) -> geocentric distance 1.5 AU
    obs_off = obs_geo + np.array([0.0, 7000.0 / motion.AU_KM, 0.0])
    ra1, dec1, _ = motion.asteroid_radec(el_ast, 2460000.5, obs_geo)
    ra2, dec2, _ = motion.asteroid_radec(el_ast, 2460000.5, obs_off)
    shift_arcsec = motion.angular_sep_deg(ra1, dec1, ra2, dec2) * 3600.0
    assert 5.5 <= shift_arcsec <= 7.5
