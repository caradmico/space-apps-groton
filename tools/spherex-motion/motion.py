"""Star and asteroid motion rules for the SPHEREx layer (Quantum Desk spec + addendum).

Pure numpy. The viewer's public/bin-lod/js/spherex-motion.js implements the same rules;
tests check both against astropy (apply_space_motion) and against each other.
"""
from __future__ import annotations

import math

import numpy as np

KAPPA = 4.740470446          # km/s per (arcsec/yr * pc)
KMS_TO_PC_PER_YR = 1.0227121650537077e-6  # 1 km/s in pc/yr
GAUSS_K = 0.01720209895      # rad/day (Gaussian gravitational constant)
OBLIQUITY_J2000_DEG = 23.4392911
AU_KM = 149597870.7
C_AU_PER_DAY = 173.1446326846693

DEFAULT_CFG = {
    "plx_snr_min": 5.0,        # FULL_3D needs parallax/parallax_error >= this (and an RV)
    "pm_snr_min": 3.0,         # STATIC when total pm / its error < this
    "theta_max_deg": 0.1,      # error budget: t_trust = theta_max / sigma_pm
    "sigma_v_frac": 0.10,      # FULL_3D: stop trusting when sigma_v * t > frac * current distance
    "v_assumed_kms": 50.0,     # SIDEWAYS_ONLY perspective limit 0.1 * d / v_assumed
    "sideways_frac": 0.1,
    "cap_years": 1.0e6,        # global cap, then "approximate: galactic orbits not modeled"
    "fade_floor": 0.25,        # viewer alpha floor past t_trust
    "gaia_epoch": 2016.0,
}

LABELS = {
    "SIDEWAYS_ONLY": "sideways only",
    "STATIC": "motion not measured",
    "uncertain": "uncertain",
    "approximate": "approximate: galactic orbits not modeled",
}


def _cfg(cfg):
    out = dict(DEFAULT_CFG)
    if cfg:
        out.update(cfg)
    return out


def _f(star, *names):
    for n in names:
        v = star.get(n)
        if v is None or v == "":
            continue
        try:
            v = float(v)
        except (TypeError, ValueError):
            continue
        if math.isfinite(v):
            return v
    return None


def _pm(star):
    pmra, pmdec = _f(star, "pmra") or 0.0, _f(star, "pmdec") or 0.0
    era, edec = _f(star, "pmra_error"), _f(star, "pmdec_error")
    pm = math.hypot(pmra, pmdec)
    if era is None or edec is None:
        return pmra, pmdec, pm, None
    # error of the total pm, propagated (falls back to quadrature sum at pm ~ 0)
    if pm > 0:
        sig = math.sqrt((pmra * era) ** 2 + (pmdec * edec) ** 2) / pm
    else:
        sig = math.hypot(era, edec)
    return pmra, pmdec, pm, sig


def distance_pc(star):
    plx = _f(star, "parallax")
    return 1000.0 / plx if plx and plx > 0 else None


def classify_motion(star, cfg=None):
    c = _cfg(cfg)
    plx, eplx = _f(star, "parallax"), _f(star, "parallax_error")
    rv = _f(star, "radial_velocity", "rv")
    plx_snr = plx / eplx if plx and eplx and eplx > 0 else 0.0
    if rv is not None and plx and plx > 0 and plx_snr >= c["plx_snr_min"]:
        return "FULL_3D"
    _, _, pm, sig = _pm(star)
    if sig is None or sig <= 0 or pm / sig < c["pm_snr_min"]:
        return "STATIC"
    return "SIDEWAYS_ONLY"


def _sigma_v_kms(star):
    """1-sigma space-velocity error (km/s) from pm, parallax and RV errors."""
    d = distance_pc(star)
    _, _, pm, sig = _pm(star)
    plx, eplx = _f(star, "parallax"), _f(star, "parallax_error") or 0.0
    erv = _f(star, "radial_velocity_error", "rv_error") or 0.0
    s_vtan = KAPPA * d * math.hypot((sig or 0.0) / 1000.0, (pm / 1000.0) * (eplx / plx))
    return math.hypot(s_vtan, erv)


def trust_limit_years(star, cfg=None):
    """t_trust in years (always <= cap_years)."""
    c = _cfg(cfg)
    cls = classify_motion(star, c)
    cap = c["cap_years"]
    if cls == "STATIC":
        return cap  # never moves, nothing to distrust
    _, _, _, sig = _pm(star)
    t = (c["theta_max_deg"] * 3.6e6) / sig if sig and sig > 0 else cap
    d = distance_pc(star)
    if cls == "FULL_3D":
        sv = _sigma_v_kms(star) * KMS_TO_PC_PER_YR  # pc/yr
        if sv > 0:
            # smallest |t| with sv*|t| > frac*|r(t)|, checked both directions
            for sgn in (1.0, -1.0):
                lo, hi = 0.0, min(t, cap)
                if sv * hi <= c["sigma_v_frac"] * _dist_at(star, sgn * hi):
                    continue
                for _ in range(80):
                    mid = 0.5 * (lo + hi)
                    if sv * mid > c["sigma_v_frac"] * _dist_at(star, sgn * mid):
                        hi = mid
                    else:
                        lo = mid
                t = min(t, hi)
    elif cls == "SIDEWAYS_ONLY" and d:
        t_side = c["sideways_frac"] * d / (c["v_assumed_kms"] * KMS_TO_PC_PER_YR)
        t = min(t, t_side)
    return float(min(t, cap))


def _basis(ra_deg, dec_deg):
    a, d = math.radians(ra_deg), math.radians(dec_deg)
    u = np.array([math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d)])
    e_ra = np.array([-math.sin(a), math.cos(a), 0.0])
    e_dec = np.array([-math.sin(d) * math.cos(a), -math.sin(d) * math.sin(a), math.cos(d)])
    return u, e_ra, e_dec


def state_vector(star):
    """r0 (pc) and v (pc/yr) in ICRS cartesian at the catalog epoch."""
    d = distance_pc(star)
    u, e_ra, e_dec = _basis(_f(star, "ra"), _f(star, "dec"))
    pmra, pmdec, _, _ = _pm(star)
    rv = _f(star, "radial_velocity", "rv") or 0.0
    v_kms = KAPPA * d * (pmra / 1000.0) * e_ra + KAPPA * d * (pmdec / 1000.0) * e_dec + rv * u
    return d * u, v_kms * KMS_TO_PC_PER_YR


def _dist_at(star, t):
    r0, v = state_vector(star)
    return float(np.linalg.norm(r0 + v * t))


def propagate_star(star, t_years, cfg=None):
    """Position t_years after the catalog epoch.

    Returns dict(ra, dec, dist_pc, state, alpha, label). state is ok, uncertain, approximate or static.
    """
    c = _cfg(cfg)
    cls = classify_motion(star, c)
    ra0, dec0 = _f(star, "ra"), _f(star, "dec")
    d0 = distance_pc(star)
    if cls == "STATIC":
        return dict(ra=ra0, dec=dec0, dist_pc=d0, state="static", alpha=1.0, label=LABELS["STATIC"])
    state, t = "ok", float(t_years)
    if abs(t) > c["cap_years"]:
        t = math.copysign(c["cap_years"], t)
        state = "approximate"
    elif abs(t) > trust_limit_years(star, c):
        state = "uncertain"
    if cls == "FULL_3D":
        r0, v = state_vector(star)
        r = r0 + v * t
        dist = float(np.linalg.norm(r))
        ra = math.degrees(math.atan2(r[1], r[0])) % 360.0
        dec = math.degrees(math.asin(r[2] / dist))
    else:
        # sideways only: move along the great circle set by the pm vector, distance fixed
        pmra, pmdec, pm, _ = _pm(star)
        u, e_ra, e_dec = _basis(ra0, dec0)
        if pm > 0:
            ang = math.radians(pm / 3.6e6 * t)
            dirv = (pmra * e_ra + pmdec * e_dec) / pm
            p = u * math.cos(ang) + dirv * math.sin(ang)
        else:
            p = u
        ra = math.degrees(math.atan2(p[1], p[0])) % 360.0
        dec = math.degrees(math.asin(max(-1.0, min(1.0, p[2]))))
        dist = d0
    alpha = 1.0
    label = LABELS.get(cls, "")
    if state == "uncertain":
        tt = trust_limit_years(star, c)
        alpha = max(c["fade_floor"], min(1.0, tt / abs(t)))
        label = (label + "; " if label else "") + LABELS["uncertain"]
    elif state == "approximate":
        alpha = c["fade_floor"]
        label = (label + "; " if label else "") + LABELS["approximate"]
    return dict(ra=ra, dec=dec, dist_pc=dist, state=state, alpha=alpha, label=label)


def angular_sep_deg(ra1, dec1, ra2, dec2):
    a1, d1, a2, d2 = map(math.radians, (ra1, dec1, ra2, dec2))
    s = math.sin((d2 - d1) / 2) ** 2 + math.cos(d1) * math.cos(d2) * math.sin((a2 - a1) / 2) ** 2
    return math.degrees(2 * math.asin(min(1.0, math.sqrt(s))))


# ---------------- asteroids: two-body Kepler ----------------

def kepler_solve(M, e, tol=1e-12):
    E = M if e < 0.8 else math.pi
    for _ in range(100):
        dE = (E - e * math.sin(E) - M) / (1 - e * math.cos(E))
        E -= dE
        if abs(dE) < tol:
            break
    return E


def asteroid_helio_ecl(el, jd):
    """Heliocentric ecliptic J2000 position (AU). el: a, e, i, om, w, ma (deg), epoch_jd."""
    a, e = float(el["a"]), float(el["e"])
    i, om, w = (math.radians(float(el[k])) for k in ("i", "om", "w"))
    n = GAUSS_K / a ** 1.5
    M = math.radians(float(el["ma"])) + n * (jd - float(el["epoch_jd"]))
    M = (M + math.pi) % (2 * math.pi) - math.pi
    E = kepler_solve(M, e)
    xp, yp = a * (math.cos(E) - e), a * math.sqrt(1 - e * e) * math.sin(E)
    co, so, ci, si, cw, sw = math.cos(om), math.sin(om), math.cos(i), math.sin(i), math.cos(w), math.sin(w)
    x = (co * cw - so * sw * ci) * xp + (-co * sw - so * cw * ci) * yp
    y = (so * cw + co * sw * ci) * xp + (-so * sw + co * cw * ci) * yp
    z = (sw * si) * xp + (cw * si) * yp
    return np.array([x, y, z])


def ecl_to_eq(v):
    eps = math.radians(OBLIQUITY_J2000_DEG)
    x, y, z = v
    return np.array([x, y * math.cos(eps) - z * math.sin(eps), y * math.sin(eps) + z * math.cos(eps)])


def asteroid_radec(el, jd, observer_helio_eq_au):
    """Astrometric RA/Dec (deg) seen from an observer (heliocentric equatorial AU), one light-time step."""
    obs = np.asarray(observer_helio_eq_au, float)
    rho = ecl_to_eq(asteroid_helio_ecl(el, jd)) - obs
    tau = np.linalg.norm(rho) / C_AU_PER_DAY
    rho = ecl_to_eq(asteroid_helio_ecl(el, jd - tau)) - obs
    r = np.linalg.norm(rho)
    return math.degrees(math.atan2(rho[1], rho[0])) % 360.0, math.degrees(math.asin(rho[2] / r)), float(r)
