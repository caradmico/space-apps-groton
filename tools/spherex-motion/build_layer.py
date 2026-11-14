#!/usr/bin/env python3
"""Build a SPHEREx x Gaia DR3 motion layer from MEF exposures, Gaia CSV, and JPL SBDB."""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import shutil
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
from astropy.coordinates import get_body_barycentric
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS
from astropy.wcs.utils import proj_plane_pixel_scales

sys.path.insert(0, str(Path(__file__).resolve().parent))
import motion  # noqa: E402
from band_to_color import CAPTIONS, INSUFFICIENT_TAG, colorize  # noqa: E402

NOMINAL_DETECTOR_WAVE_UM = {
    1: 0.93,
    2: 1.36,
    3: 2.02,
    4: 3.12,
    5: 4.12,
    6: 4.71,
}


IR_COLOR_CAPTION = (
    "False color: SPHEREx sees infrared light, invisible to the eye. "
    "Blue = shorter infrared, red = longer."
)
IR_COLOR_SOURCE = (
    "tools/spherex-motion/band_to_color.py "
    "(official 1.63 / 3.83 um group edges, WCS-WAVE wavelengths)"
)
INSUFFICIENT_CAPTION = CAPTIONS[INSUFFICIENT_TAG]


DEFAULT_BUILD_CFG = {
    **motion.DEFAULT_CFG,
    "bad_flag_names": [
        "TRANSIENT",
        "OVERFLOW",
        "SUR_ERROR",
        "NONFUNC",
        "MISSING_DATA",
        "HOT",
        "COLD",
        "NONLINEAR",
        "PERSIST",
        "OUTLIER",
    ],
    "detect_k": 5.0,
    "match_radius_px": 1.5,
    "band_edges_um": [0.75, 1.6, 3.0, 5.0],
}


def load_config(path: str | None) -> dict:
    cfg = dict(DEFAULT_BUILD_CFG)
    if path:
        with open(path, "r", encoding="utf-8") as fh:
            user_cfg = json.load(fh)
        cfg.update(user_cfg)
    return cfg


def build_bad_flag_mask(flags_header, bad_flag_names) -> int:
    bad_set = {str(n).strip().upper() for n in bad_flag_names}
    bad_set.discard("SOURCE")
    name_to_mask = {}
    for key, val in flags_header.items():
        if key.startswith("MSKN") and len(key) > 4:
            suffix = key[4:]
            mask_key = f"MSKM{suffix}"
            if mask_key in flags_header:
                try:
                    name_to_mask[str(val).strip().upper()] = int(flags_header[mask_key])
                except (TypeError, ValueError):
                    continue
    mask = 0
    for name in bad_set:
        if name in name_to_mask:
            mask |= name_to_mask[name]
    return mask


def wavelength_at(hdul, x0, y0) -> tuple[np.ndarray | float, bool]:
    """Bilinear interpolation of HDU 'WCS-WAVE' at 0-based pixel coordinates (x0, y0).

    Returns (wave_um, from_detector_fallback).
    """
    scalar_in = np.ndim(x0) == 0 and np.ndim(y0) == 0
    xa = np.asarray(x0, dtype=float)
    ya = np.asarray(y0, dtype=float)

    if "WCS-WAVE" in hdul:
        tab = hdul["WCS-WAVE"].data
        if tab is not None and len(tab) >= 1:
            row = tab[0]
            xg = np.asarray(row["X"], dtype=float).ravel() - 1.0
            yg = np.asarray(row["Y"], dtype=float).ravel() - 1.0
            vals = np.asarray(row["VALUES"], dtype=float)
            if vals.ndim == 3 and vals.shape[2] >= 1:
                wgrid = vals[:, :, 0]
            else:
                wgrid = vals
            nx = len(xg)
            ny = len(yg)
            if nx >= 2 and ny >= 2 and wgrid.shape == (ny, nx):
                xc = np.clip(xa, xg[0], xg[-1])
                yc = np.clip(ya, yg[0], yg[-1])
                ix = np.clip(np.searchsorted(xg, xc, side="right") - 1, 0, nx - 2)
                iy = np.clip(np.searchsorted(yg, yc, side="right") - 1, 0, ny - 2)
                x1, x2 = xg[ix], xg[ix + 1]
                y1, y2 = yg[iy], yg[iy + 1]
                tx = np.where(x2 > x1, (xc - x1) / (x2 - x1), 0.0)
                ty = np.where(y2 > y1, (yc - y1) / (y2 - y1), 0.0)
                w00 = wgrid[iy, ix]
                w10 = wgrid[iy, ix + 1]
                w01 = wgrid[iy + 1, ix]
                w11 = wgrid[iy + 1, ix + 1]
                w = (
                    (1.0 - tx) * (1.0 - ty) * w00
                    + tx * (1.0 - ty) * w10
                    + (1.0 - tx) * ty * w01
                    + tx * ty * w11
                )
                if scalar_in:
                    return float(w), False
                return w, False

    det = 1
    if "IMAGE" in hdul and "DETECTOR" in hdul["IMAGE"].header:
        try:
            det = int(hdul["IMAGE"].header["DETECTOR"])
        except (TypeError, ValueError):
            det = 1
    elif "PRIMARY" in hdul and "DETECTOR" in hdul["PRIMARY"].header:
        try:
            det = int(hdul["PRIMARY"].header["DETECTOR"])
        except (TypeError, ValueError):
            det = 1
    w_nom = float(NOMINAL_DETECTOR_WAVE_UM.get(det, 1.36))
    if scalar_in:
        return w_nom, True
    return np.full_like(xa, w_nom, dtype=float), True


def reproject_north_up(
    image: np.ndarray,
    variance: np.ndarray,
    flags: np.ndarray | None,
    bad_mask: int,
    src_wcs: WCS,
    center_radec: tuple[float, float],
    size_deg: float,
):
    """Reproject onto a north-up TAN grid centered on center_radec."""
    cel_wcs = src_wcs.celestial
    scales_deg = proj_plane_pixel_scales(cel_wcs)
    s_deg = float(np.mean(scales_deg[:2]))
    npix = max(8, int(round(float(size_deg) / s_deg)))

    target_wcs = WCS(naxis=2)
    target_wcs.wcs.crpix = [(npix + 1) / 2.0, (npix + 1) / 2.0]
    target_wcs.wcs.cdelt = [-s_deg, s_deg]
    target_wcs.wcs.crval = [float(center_radec[0]), float(center_radec[1])]
    target_wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]

    yy, xx = np.indices((npix, npix), dtype=float)
    ra_grid, dec_grid = target_wcs.all_pix2world(xx, yy, 0)
    try:
        sx, sy = src_wcs.all_world2pix(
            ra_grid, dec_grid, 0, quiet=True, maxiter=20, tolerance=1e-5, detect_divergence=True
        )
    except Exception:
        sx, sy = cel_wcs.all_world2pix(ra_grid, dec_grid, 0)

    ny_src, nx_src = image.shape
    finite_coord = np.isfinite(sx) & np.isfinite(sy)
    in_bounds = finite_coord & (sx >= 0.0) & (sx <= nx_src - 1.000001) & (sy >= 0.0) & (sy <= ny_src - 1.000001)

    sx_safe = np.where(in_bounds, sx, 0.0)
    sy_safe = np.where(in_bounds, sy, 0.0)
    ix0 = np.floor(sx_safe).astype(int)
    iy0 = np.floor(sy_safe).astype(int)
    ix0 = np.clip(ix0, 0, max(0, nx_src - 2))
    iy0 = np.clip(iy0, 0, max(0, ny_src - 2))
    ix1 = ix0 + 1
    iy1 = iy0 + 1

    fx = sx_safe - ix0
    fy = sy_safe - iy0
    w00 = (1.0 - fx) * (1.0 - fy)
    w10 = fx * (1.0 - fy)
    w01 = (1.0 - fx) * fy
    w11 = fx * fy

    im00, im10, im01, im11 = image[iy0, ix0], image[iy0, ix1], image[iy1, ix0], image[iy1, ix1]
    va00, va10, va01, va11 = variance[iy0, ix0], variance[iy0, ix1], variance[iy1, ix0], variance[iy1, ix1]

    valid = (
        in_bounds
        & np.isfinite(im00)
        & np.isfinite(im10)
        & np.isfinite(im01)
        & np.isfinite(im11)
        & np.isfinite(va00)
        & np.isfinite(va10)
        & np.isfinite(va01)
        & np.isfinite(va11)
    )
    if flags is not None and bad_mask != 0:
        f00 = (flags[iy0, ix0] & bad_mask) == 0
        f10 = (flags[iy0, ix1] & bad_mask) == 0
        f01 = (flags[iy1, ix0] & bad_mask) == 0
        f11 = (flags[iy1, ix1] & bad_mask) == 0
        valid = valid & f00 & f10 & f01 & f11

    out_im = np.where(valid, w00 * im00 + w10 * im10 + w01 * im01 + w11 * im11, np.nan)
    out_var = np.where(
        valid,
        (w00 * w00) * va00 + (w10 * w10) * va10 + (w01 * w01) * va01 + (w11 * w11) * va11,
        np.nan,
    )
    src_x = np.where(valid, sx, np.nan)
    src_y = np.where(valid, sy, np.nan)
    return out_im, out_var, valid, target_wcs, (src_x, src_y)


def sigma_clipped_stats(values: np.ndarray, sigma: float = 3.0, iters: int = 5) -> tuple[float, float]:
    v = values[np.isfinite(values)]
    if v.size == 0:
        return 0.0, 1.0
    for _ in range(iters):
        if v.size == 0:
            break
        med = float(np.median(v))
        mad = float(np.median(np.abs(v - med)))
        std = 1.4826 * mad if mad > 0 else float(np.std(v))
        if std <= 0:
            break
        keep = np.abs(v - med) <= sigma * std
        if np.all(keep) or not np.any(keep):
            break
        v = v[keep]
    med = float(np.median(v))
    mad = float(np.median(np.abs(v - med)))
    std = 1.4826 * mad if mad > 0 else float(np.std(v))
    return med, (std if std > 0 else 1.0)


def detect_sources(
    image: np.ndarray,
    variance: np.ndarray | None,
    valid: np.ndarray,
    target_wcs: WCS,
    detect_k: float = 5.0,
) -> list[dict]:
    vals = image[valid & np.isfinite(image)]
    if vals.size == 0:
        return []
    bg, mad_sigma = sigma_clipped_stats(vals, sigma=3.0, iters=5)

    noise = mad_sigma
    if variance is not None:
        vvals = variance[valid & np.isfinite(variance) & (variance > 0)]
        if vvals.size > 0:
            var_noise = math.sqrt(float(np.median(vvals)))
            if math.isfinite(var_noise) and var_noise > 0:
                noise = var_noise
    if not math.isfinite(noise) or noise <= 0:
        noise = mad_sigma if mad_sigma > 0 else 1.0

    sub = np.where(valid & np.isfinite(image), image - bg, -np.inf)
    ny, nx = sub.shape
    if ny < 5 or nx < 5:
        return []

    thresh = float(detect_k) * noise
    detections = []
    for iy in range(2, ny - 2):
        for ix in range(2, nx - 2):
            if not valid[iy, ix]:
                continue
            val = sub[iy, ix]
            if not np.isfinite(val) or val <= thresh:
                continue
            patch3 = sub[iy - 1 : iy + 2, ix - 1 : ix + 2]
            if val < np.max(patch3):
                continue
            if np.sum(patch3 == val) > 1:
                max_pos = np.argwhere(patch3 == val)[0]
                if max_pos[0] != 1 or max_pos[1] != 1:
                    continue

            patch5 = np.clip(sub[iy - 2 : iy + 3, ix - 2 : ix + 3], 0.0, None)
            patch5_valid = valid[iy - 2 : iy + 3, ix - 2 : ix + 3] & np.isfinite(patch5)
            w = np.where(patch5_valid, patch5, 0.0)
            wsum = float(np.sum(w))
            if wsum <= 0:
                continue
            dy_grid, dx_grid = np.mgrid[-2:3, -2:3]
            cx = float(ix) + float(np.sum(w * dx_grid)) / wsum
            cy = float(iy) + float(np.sum(w * dy_grid)) / wsum
            ra_arr, dec_arr = target_wcs.all_pix2world([cx], [cy], 0)
            ra = float(ra_arr[0]) % 360.0
            dec = float(dec_arr[0])
            snr = float(val / noise)
            detections.append(
                {
                    "x": cx,
                    "y": cy,
                    "ra": ra,
                    "dec": dec,
                    "snr": snr,
                    "flux": wsum,
                    "peak": float(val),
                }
            )
    return detections


def parse_gaia_csv(path: str) -> list[dict]:
    def _num(row, key):
        v = row.get(key)
        if v is None:
            return None
        v = str(v).strip()
        if v == "":
            return None
        try:
            f = float(v)
        except ValueError:
            return None
        return f if math.isfinite(f) else None

    stars = []
    with open(path, "r", encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            ra = _num(row, "ra")
            dec = _num(row, "dec")
            if ra is None or dec is None:
                continue
            sid = str(row.get("source_id", "")).strip()
            rv = _num(row, "radial_velocity")
            if rv is None:
                rv = _num(row, "rv")
            rve = _num(row, "radial_velocity_error")
            if rve is None:
                rve = _num(row, "rv_error")
            gmag = _num(row, "phot_g_mean_mag")
            if gmag is None:
                gmag = _num(row, "gmag")
            stars.append(
                {
                    "gaia_id": sid,
                    "ra": ra,
                    "dec": dec,
                    "epoch": 2016.0,
                    "parallax": _num(row, "parallax"),
                    "parallax_error": _num(row, "parallax_error"),
                    "pmra": _num(row, "pmra"),
                    "pmra_error": _num(row, "pmra_error"),
                    "pmdec": _num(row, "pmdec"),
                    "pmdec_error": _num(row, "pmdec_error"),
                    "rv": rv,
                    "rv_error": rve,
                    "gmag": gmag,
                }
            )
    return stars


def match_detections_to_gaia(
    detections: list[dict],
    gaia_stars: list[dict],
    mjd: float,
    pixel_scale_deg: float,
    cfg: dict,
) -> tuple[dict[str, list[dict]], set[str], list[dict]]:
    """Match one exposure's detections to propagated Gaia stars."""
    t_years = (float(mjd) - 57388.5) / 365.25
    radius_deg = float(cfg.get("match_radius_px", 1.5)) * float(pixel_scale_deg)

    prop_coords = []
    for st in gaia_stars:
        p = motion.propagate_star(st, t_years, cfg)
        prop_coords.append((st["gaia_id"], float(p["ra"]), float(p["dec"])))

    matched_by_id: dict[str, list[dict]] = {}
    ambiguous_ids: set[str] = set()
    unmatched: list[dict] = []

    for det in detections:
        dra_candidates = []
        for gid, pra, pdec in prop_coords:
            sep = motion.angular_sep_deg(det["ra"], det["dec"], pra, pdec)
            if sep <= radius_deg:
                dra_candidates.append((sep, gid))
        if not dra_candidates:
            unmatched.append(
                {
                    "ra": round(float(det["ra"]), 7),
                    "dec": round(float(det["dec"]), 7),
                    "mjd": round(float(mjd), 6),
                    "snr": round(float(det["snr"]), 3),
                }
            )
        else:
            dra_candidates.sort(key=lambda t: t[0])
            best_gid = dra_candidates[0][1]
            if len(dra_candidates) >= 2:
                ambiguous_ids.add(best_gid)
            matched_by_id.setdefault(best_gid, []).append(det)

    return matched_by_id, ambiguous_ids, unmatched



def compute_star_ir_color(samples: list[tuple[float, float, float]]) -> dict:
    """Run colorize() on real (wave_um, flux, flux_error) samples.

    Insufficient-data stars keep ir_rgb=None so the viewer can leave them
    in their normal color. The script's #808080 gray is not written to ir_rgb.
    Midpoint / detector-fallback wavelengths should not be passed in.
    """
    usable = []
    for item in samples:
        if not item or len(item) < 3:
            continue
        w, f, fe = item[0], item[1], item[2]
        if w is None or f is None or fe is None:
            continue
        try:
            w = float(w)
            f = float(f)
            fe = float(fe)
        except (TypeError, ValueError):
            continue
        if math.isfinite(w) and math.isfinite(f) and math.isfinite(fe) and f > 0.0 and fe > 0.0:
            usable.append((w, f, fe))
    if not usable:
        return {
            "ir_tag": INSUFFICIENT_TAG,
            "ir_hex": "#808080",
            "ir_caption": INSUFFICIENT_CAPTION,
            "ir_rgb": None,
        }

    try:
        res = colorize(
            {
                "wavelength_um": [u[0] for u in usable],
                "flux": [u[1] for u in usable],
                "flux_error": [u[2] for u in usable],
            }
        )
    except (OverflowError, ValueError):
        return {
            "ir_tag": INSUFFICIENT_TAG,
            "ir_hex": "#808080",
            "ir_caption": INSUFFICIENT_CAPTION,
            "ir_rgb": None,
        }
    tag = res.get("tag") or INSUFFICIENT_TAG
    hex_code = res.get("hex") or "#808080"
    caption = res.get("caption") or INSUFFICIENT_CAPTION
    if tag == INSUFFICIENT_TAG:
        return {
            "ir_tag": tag,
            "ir_hex": hex_code,
            "ir_caption": caption,
            "ir_rgb": None,
        }
    rgb_dict = res.get("rgb") or {}
    ir_rgb = [
        round(float(rgb_dict["r"]) / 255.0, 4),
        round(float(rgb_dict["g"]) / 255.0, 4),
        round(float(rgb_dict["b"]) / 255.0, 4),
    ]
    return {
        "ir_tag": tag,
        "ir_hex": hex_code,
        "ir_caption": caption,
        "ir_rgb": ir_rgb,
    }


def compute_false_color(samples: list[tuple[float, float]], band_edges_um: list[float]) -> tuple[list[float] | None, bool]:
    """Compute [R, G, B] false color from (wavelength_um, flux) samples."""
    if not samples:
        return None, False
    e0, e1, e2, e3 = [float(x) for x in band_edges_um[:4]]
    short_flux = []
    mid_flux = []
    long_flux = []
    for w, f in samples:
        if w is None or f is None or not (math.isfinite(w) and math.isfinite(f)) or f <= 0:
            continue
        if e0 <= w < e1:
            short_flux.append(float(f))
        elif e1 <= w < e2:
            mid_flux.append(float(f))
        elif e2 <= w <= e3:
            long_flux.append(float(f))

    means = [
        float(np.mean(long_flux)) if long_flux else 0.0,   # Red = long
        float(np.mean(mid_flux)) if mid_flux else 0.0,     # Green = mid
        float(np.mean(short_flux)) if short_flux else 0.0, # Blue = short
    ]
    max_val = max(means)
    if max_val <= 0.0:
        return None, False
    partial = any(m <= 0.0 for m in means)
    rgb = [round(m / max_val, 4) for m in means]
    return rgb, partial


def star_in_field(ra: float, dec: float, center: tuple[float, float], size_deg: float) -> bool:
    half = 0.5 * float(size_deg)
    ddec = abs(float(dec) - float(center[1]))
    if ddec > half:
        return False
    cos_dec = max(1e-6, math.cos(math.radians(center[1])))
    dra = ((float(ra) - float(center[0]) + 180.0) % 360.0) - 180.0
    if abs(dra) * cos_dec > half:
        return False
    return True


def _twin_mwir_row(row: dict) -> dict | None:
    try:
        det = int(row.get("detector", 0))
    except (TypeError, ValueError):
        return None
    if det not in (1, 2, 3):
        return None
    twin_det = det + 3
    twin = dict(row)
    twin["detector"] = twin_det
    for key in ("s3_url", "irsa_url", "irsa_cutout"):
        val = twin.get(key)
        if isinstance(val, str) and val:
            val = val.replace(f"/{det}/", f"/{twin_det}/").replace(f"D{det}_", f"D{twin_det}_")
            twin[key] = val
    return twin


def fetch_visit_fits(
    row: dict,
    center: tuple[float, float],
    size_deg: float,
    offline_dir: str | None,
    tmpdir: str,
) -> str | None:
    s3_url = str(row.get("s3_url") or "")
    basename = os.path.basename(urllib.parse.urlparse(s3_url).path) if s3_url else ""
    if offline_dir is not None:
        if not basename:
            return None
        candidate = os.path.join(offline_dir, basename)
        return candidate if os.path.isfile(candidate) else None

    irsa_url = str(row.get("irsa_url") or row.get("irsa_cutout") or "")
    if irsa_url:
        sep = "&" if "?" in irsa_url else "?"
        cut_url = f"{irsa_url}{sep}center={center[0]},{center[1]}&size={size_deg}"
        dest = os.path.join(tmpdir, f"irsa_{basename or 'cutout.fits'}")
        try:
            with urllib.request.urlopen(cut_url, timeout=60) as resp, open(dest, "wb") as out:
                shutil.copyfileobj(resp, out)
            return dest
        except Exception:
            pass

    if s3_url:
        dest = os.path.join(tmpdir, basename or "s3_visit.fits")
        try:
            with urllib.request.urlopen(s3_url, timeout=300) as resp, open(dest, "wb") as out:
                shutil.copyfileobj(resp, out)
            return dest
        except Exception:
            return None
    return None


def earth_helio_eq_au_astropy(mjd: float) -> np.ndarray:
    t = Time(float(mjd), format="mjd", scale="utc")
    eb = get_body_barycentric("earth", t)
    sb = get_body_barycentric("sun", t)
    vec = (eb - sb).xyz.to_value("AU")
    return np.asarray(vec, dtype=float)


def fetch_asteroid_elements(des: str) -> dict:
    q = urllib.parse.quote(str(des).strip())
    url = f"https://ssd-api.jpl.nasa.gov/sbdb.api?sstr={q}&full-prec=1"
    with urllib.request.urlopen(url, timeout=60) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    orbit = data["orbit"]
    el_map = {}
    for item in orbit.get("elements", []):
        name = item.get("name")
        val = item.get("value")
        if name and val is not None:
            el_map[name] = float(val)
    epoch_jd = float(orbit["epoch"])
    return {
        "designation": str(des).strip(),
        "a": el_map["a"],
        "e": el_map["e"],
        "i": el_map["i"],
        "om": el_map["om"],
        "w": el_map["w"],
        "ma": el_map["ma"],
        "epoch_jd": epoch_jd,
    }


def sanitize_for_json(obj):
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, (np.floating,)):
        f = float(obj)
        return f if math.isfinite(f) else None
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, dict):
        return {k: sanitize_for_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [sanitize_for_json(v) for v in obj]
    return obj


def build_layer(
    visits_path: str,
    gaia_path: str,
    out_path: str,
    center: tuple[float, float] | None = None,
    size_deg: float = 0.1,
    config_path: str | None = None,
    offline_dir: str | None = None,
    asteroids_arg: str | None = None,
    name: str | None = None,
    max_exposures: int | None = None,
) -> dict:
    cfg = load_config(config_path)
    gaia_stars = parse_gaia_csv(gaia_path)

    with open(visits_path, "r", encoding="utf-8") as fh:
        visits_raw = json.load(fh)
    if isinstance(visits_raw, dict):
        visit_rows = visits_raw.get("visits", [])
    else:
        visit_rows = list(visits_raw)

    expanded_rows = []
    seen_urls = set()
    for r in visit_rows:
        u = r.get("s3_url") or r.get("obsid") or id(r)
        if u not in seen_urls:
            seen_urls.add(u)
            expanded_rows.append(dict(r))
        twin = _twin_mwir_row(r)
        if twin is not None:
            tu = twin.get("s3_url") or f"{twin.get('obsid')}_{twin.get('detector')}"
            if tu not in seen_urls:
                seen_urls.add(tu)
                expanded_rows.append(twin)

    if center is None:
        if gaia_stars:
            ra_med = float(np.median([s["ra"] for s in gaia_stars]))
            dec_med = float(np.median([s["dec"] for s in gaia_stars]))
            center = (ra_med, dec_med)
        else:
            center = (0.0, 0.0)

    star_records: dict[str, dict] = {}
    star_samples: dict[str, list[tuple[float, float]]] = {}
    star_flags: dict[str, set[str]] = {}
    for st in gaia_stars:
        gid = st["gaia_id"]
        star_records[gid] = dict(st)
        star_samples[gid] = []
        star_flags[gid] = set()
        star_records[gid]["detections"] = []

    meta_visits = []
    unmatched_all = []
    visit_sc_vectors: list[tuple[float, np.ndarray]] = []
    pixel_scales_arcsec = []
    exposures_used = 0

    with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as tmpdir:
        for row in expanded_rows:
            mjd_row = row.get("mjd_avg") or row.get("mjd")
            date_row = row.get("date_avg_utc") or row.get("date") or ""
            coll_row = row.get("collection") or ""
            obsid_row = row.get("obsid") or ""
            det_row = row.get("detector")

            if max_exposures is not None and exposures_used >= max_exposures:
                meta_visits.append(
                    {
                        "mjd": round(float(mjd_row), 6) if mjd_row is not None else None,
                        "date": str(date_row),
                        "collection": str(coll_row),
                        "obsid": str(obsid_row),
                        "detector": int(det_row) if det_row is not None else None,
                        "used": False,
                    }
                )
                continue

            fits_path = fetch_visit_fits(row, center, size_deg, offline_dir, tmpdir)
            if fits_path is None:
                if mjd_row is not None and "sc_xyz_km_geocenter_start" in row and row["sc_xyz_km_geocenter_start"]:
                    sc_km = np.asarray(row["sc_xyz_km_geocenter_start"], dtype=float)
                    visit_sc_vectors.append((float(mjd_row), sc_km))
                meta_visits.append(
                    {
                        "mjd": round(float(mjd_row), 6) if mjd_row is not None else None,
                        "date": str(date_row),
                        "collection": str(coll_row),
                        "obsid": str(obsid_row),
                        "detector": int(det_row) if det_row is not None else None,
                        "used": False,
                    }
                )
                continue

            try:
                with fits.open(fits_path) as hdul:
                    im_hdu = hdul["IMAGE"]
                    hdr = im_hdu.header
                    img = np.asarray(im_hdu.data, dtype=np.float32)
                    var = (
                        np.asarray(hdul["VARIANCE"].data, dtype=np.float32)
                        if "VARIANCE" in hdul
                        else np.ones_like(img, dtype=np.float32)
                    )
                    if "FLAGS" in hdul:
                        flg = np.asarray(hdul["FLAGS"].data, dtype=np.int64)
                        bad_mask = build_bad_flag_mask(hdul["FLAGS"].header, cfg["bad_flag_names"])
                    else:
                        flg = None
                        bad_mask = 0

                    src_wcs = WCS(hdr)
                    scales_deg = proj_plane_pixel_scales(src_wcs.celestial)
                    px_scale_deg = float(np.mean(scales_deg[:2]))
                    pixel_scales_arcsec.append(px_scale_deg * 3600.0)

                    mjd_exp = float(hdr.get("MJD-AVG", mjd_row if mjd_row is not None else 60000.0))
                    date_exp = str(hdr.get("DATE-AVG", date_row))
                    det_exp = int(hdr.get("DETECTOR", det_row if det_row is not None else 1))

                    sc_km = np.array(
                        [
                            float(hdr.get("X_SC_START", 0.0)),
                            float(hdr.get("Y_SC_START", 0.0)),
                            float(hdr.get("Z_SC_START", 0.0)),
                        ],
                        dtype=float,
                    )
                    if not np.any(sc_km) and row.get("sc_xyz_km_geocenter_start"):
                        sc_km = np.asarray(row["sc_xyz_km_geocenter_start"], dtype=float)
                    visit_sc_vectors.append((mjd_exp, sc_km))

                    rep_im, rep_var, rep_valid, target_wcs, (src_x, src_y) = reproject_north_up(
                        img, var, flg, bad_mask, src_wcs, center, size_deg
                    )
                    dets = detect_sources(rep_im, rep_var, rep_valid, target_wcs, detect_k=float(cfg["detect_k"]))

                    for d in dets:
                        iy = int(np.clip(round(d["y"]), 0, rep_im.shape[0] - 1))
                        ix = int(np.clip(round(d["x"]), 0, rep_im.shape[1] - 1))
                        sx0 = float(src_x[iy, ix]) if np.isfinite(src_x[iy, ix]) else 0.0
                        sy0 = float(src_y[iy, ix]) if np.isfinite(src_y[iy, ix]) else 0.0
                        w_um, from_det = wavelength_at(hdul, sx0, sy0)
                        d["wave_um"] = float(w_um)
                        d["wave_from_detector"] = bool(from_det)

                    matched, ambig_ids, unmatched = match_detections_to_gaia(
                        dets, gaia_stars, mjd_exp, px_scale_deg, cfg
                    )
                    unmatched_all.extend(unmatched)
                    for gid in ambig_ids:
                        star_flags[gid].add("ambiguous")
                    for gid, dlist in matched.items():
                        for d in dlist:
                            flux = float(d["flux"])
                            snr = float(d["snr"])
                            flux_err = (flux / snr) if (flux > 0.0 and snr > 0.0) else None
                            rec = {
                                "mjd": round(mjd_exp, 6),
                                "ra": round(float(d["ra"]), 7),
                                "dec": round(float(d["dec"]), 7),
                                "snr": round(snr, 3),
                                "wave_um": round(float(d["wave_um"]), 4),
                            }
                            if flux_err is not None:
                                rec["flux"] = round(flux, 3)
                                rec["flux_err"] = round(flux_err, 3)
                            star_records[gid]["detections"].append(rec)
                            # Use real WCS-WAVE wavelengths only, never detector-band midpoints.
                            if (not d.get("wave_from_detector")) and flux_err is not None:
                                star_samples[gid].append((float(d["wave_um"]), flux, flux_err))
                            if d.get("wave_from_detector"):
                                star_flags[gid].add("wave_from_detector")

                    exposures_used += 1
                    meta_visits.append(
                        {
                            "mjd": round(mjd_exp, 6),
                            "date": date_exp,
                            "collection": str(coll_row),
                            "obsid": str(obsid_row),
                            "detector": det_exp,
                            "used": True,
                        }
                    )
            except Exception:
                meta_visits.append(
                    {
                        "mjd": round(float(mjd_row), 6) if mjd_row is not None else None,
                        "date": str(date_row),
                        "collection": str(coll_row),
                        "obsid": str(obsid_row),
                        "detector": int(det_row) if det_row is not None else None,
                        "used": False,
                    }
                )

    visit_mjds = [v["mjd"] for v in meta_visits if v.get("mjd") is not None]
    if not visit_mjds:
        visit_mjds = [57388.5]

    out_stars = []
    for st in gaia_stars:
        gid = st["gaia_id"]
        inside = star_in_field(st["ra"], st["dec"], center, size_deg)
        if not inside:
            for vmjd in visit_mjds:
                t_yr = (float(vmjd) - 57388.5) / 365.25
                p = motion.propagate_star(st, t_yr, cfg)
                if star_in_field(p["ra"], p["dec"], center, size_deg):
                    inside = True
                    break
        if not inside and not star_records[gid]["detections"]:
            continue

        ir_info = compute_star_ir_color(star_samples[gid])

        m_class = motion.classify_motion(st, cfg)
        t_trust = motion.trust_limit_years(st, cfg)

        out_stars.append(
            {
                "gaia_id": str(gid),
                "ra": round(float(st["ra"]), 7),
                "dec": round(float(st["dec"]), 7),
                "epoch": 2016.0,
                "parallax": round(float(st["parallax"]), 6) if st["parallax"] is not None else None,
                "parallax_error": round(float(st["parallax_error"]), 6) if st["parallax_error"] is not None else None,
                "pmra": round(float(st["pmra"]), 6) if st["pmra"] is not None else None,
                "pmra_error": round(float(st["pmra_error"]), 6) if st["pmra_error"] is not None else None,
                "pmdec": round(float(st["pmdec"]), 6) if st["pmdec"] is not None else None,
                "pmdec_error": round(float(st["pmdec_error"]), 6) if st["pmdec_error"] is not None else None,
                "rv": round(float(st["rv"]), 4) if st["rv"] is not None else None,
                "rv_error": round(float(st["rv_error"]), 4) if st["rv_error"] is not None else None,
                "gmag": round(float(st["gmag"]), 4) if st["gmag"] is not None else None,
                "motion_class": m_class,
                "t_trust_yr": round(float(t_trust), 2),
                "ir_rgb": ir_info["ir_rgb"],
                "ir_tag": ir_info["ir_tag"],
                "ir_hex": ir_info["ir_hex"],
                "ir_caption": ir_info["ir_caption"],
                "detections": star_records[gid]["detections"],
                "flags": sorted(star_flags[gid]),
            }
        )

    asteroids_out = []
    if asteroids_arg:
        des_list = [d.strip() for d in str(asteroids_arg).split(",") if d.strip()]
        for des in des_list:
            el = fetch_asteroid_elements(des)
            track = []
            for vmjd, sc_km in visit_sc_vectors:
                jd = float(vmjd) + 2400000.5
                earth_eq = earth_helio_eq_au_astropy(vmjd)
                sc_eq = earth_eq + (np.asarray(sc_km, dtype=float) / motion.AU_KM)
                ra_sp, dec_sp, _ = motion.asteroid_radec(el, jd, sc_eq)
                ra_geo, dec_geo, _ = motion.asteroid_radec(el, jd, earth_eq)
                plx_arcsec = motion.angular_sep_deg(ra_sp, dec_sp, ra_geo, dec_geo) * 3600.0
                track.append(
                    {
                        "mjd": round(float(vmjd), 6),
                        "ra": round(float(ra_sp), 7),
                        "dec": round(float(dec_sp), 7),
                        "observer": "SPHEREx",
                        "geocentric_ra": round(float(ra_geo), 7),
                        "geocentric_dec": round(float(dec_geo), 7),
                        "parallax_arcsec": round(float(plx_arcsec), 4),
                    }
                )
            asteroids_out.append(
                {
                    "designation": el["designation"],
                    "elements": el,
                    "track": track,
                }
            )

    px_scale_out = round(float(np.mean(pixel_scales_arcsec)), 4) if pixel_scales_arcsec else 6.15
    payload = sanitize_for_json(
        {
            "schema_version": 1,
            "meta": {
                "name": name or Path(out_path).stem,
                "center": [round(float(center[0]), 7), round(float(center[1]), 7)],
                "size_deg": round(float(size_deg), 6),
                "pixel_scale_arcsec": px_scale_out,
                "visits": meta_visits,
                "pixels": "real" if exposures_used > 0 else "pending",
                "config": cfg,
                "generated_by": "tools/spherex-motion/build_layer.py",
                "sources": "IRSA SPHEREx (AWS mirror) + Gaia DR3 + JPL SBDB",
                "ir_color_caption": IR_COLOR_CAPTION,
                "ir_color_source": IR_COLOR_SOURCE,
            },
            "stars": out_stars,
            "unmatched": unmatched_all,
            "asteroids": asteroids_out,
        }
    )

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, allow_nan=False, separators=(",", ":"))
    return payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build SPHEREx x Gaia DR3 motion layer JSON.")
    parser.add_argument("--visits", required=True, help="Path to visits.json")
    parser.add_argument("--gaia", required=True, help="Path to gaia.csv")
    parser.add_argument("--out", required=True, help="Output JSON path")
    parser.add_argument("--center", default=None, help="Center RA,DEC in degrees")
    parser.add_argument("--size", type=float, default=0.1, help="Cutout size in degrees (default 0.1)")
    parser.add_argument("--config", default=None, help="Optional JSON config override")
    parser.add_argument("--offline-dir", default=None, help="Directory with local FITS files")
    parser.add_argument("--asteroids", default=None, help="Comma-separated asteroid designations")
    parser.add_argument("--name", default=None, help="Layer display name")
    parser.add_argument("--max-exposures", type=int, default=None, help="Max exposures to process")
    args = parser.parse_args(argv)

    center = None
    if args.center:
        parts = [float(p.strip()) for p in args.center.split(",")]
        center = (parts[0], parts[1])

    build_layer(
        visits_path=args.visits,
        gaia_path=args.gaia,
        out_path=args.out,
        center=center,
        size_deg=args.size,
        config_path=args.config,
        offline_dir=args.offline_dir,
        asteroids_arg=args.asteroids,
        name=args.name,
        max_exposures=args.max_exposures,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
