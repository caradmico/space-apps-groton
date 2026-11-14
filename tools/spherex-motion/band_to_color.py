#!/usr/bin/env python3
"""Map a SPHEREx spectrum to a false-color hex value and a one-word tag.

StarIS helper for Space Boi. Input is a per-source spectrum from the
nominal 102 SPHEREx channels, or from the IRSA Spectrophotometry Tool /
All-Sky Cube channel products. Output is a hex color, a tag, and a
one-line caption.

This is false color: SPHEREx measures infrared light, which is invisible
to the eye. Short-wavelength infrared is drawn as blue, mid as green,
and long as red.

Band edges and the 102-channel layout are taken from official SPHEREx
pages listed in README.md. Resolving-power values disagree slightly
between the 2021 instrument table and the 2026 IRSA archive pages;
this script uses the band wavelength edges, which those pages share,
and does not depend on R.

Default classification cuts (IR-excess threshold, color-index bounds,
log-clip width) are tunable display parameters, not physical constants.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import os
import sys
from typing import Any, Iterable, Mapping, MutableMapping, Sequence

# ---------------------------------------------------------------------------
# Official band layout (wavelength edges in microns)
#
# IRSA Data Products, 12 Nov 2026:
#   https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/
#   Band 1: 0.75-1.09 um, R=39
#   Band 2: 1.10-1.62 um, R=41
#   Band 3: 1.63-2.41 um, R=41
#   Band 4: 2.42-3.82 um, R=35
#   Band 5: 3.83-4.41 um, R=112
#   Band 6: 4.42-5.00 um, R=128
#   All-Sky Cube: 102 spectral channels (channels 1-17 of each of 6 detectors).
#
# SPHEREx Instrument table, updated September 2021:
#   https://spherex.caltech.edu/page/instrument
#   Same band edges; R=41, 41, 41, 35, 110, 130 (differs for bands 1, 5, 6).
#
# Coverage and channel count also stated at:
#   https://irsa.ipac.caltech.edu/spherex-archive-documentation/
#     "0.75-5 micron spectroscopy"
#   https://spherex.caltech.edu/page/about-the-mission
#     "near-infrared 0.75-5.0 um spectra"
#   https://spherex.caltech.edu/page/possible-use
#     "102 channels from 0.75 to 5 microns"
#   https://spherex.caltech.edu/page/survey
#     "images of the entire sky in 102 colors"
#
# Three display groups, two official bands each. Half-open edges soak up
# the 0.01 um gaps in the published band limits (1.09-1.10, 1.62-1.63,
# 2.41-2.42, 3.82-3.83, 4.41-4.42) so a channel in a gap is not dropped.
#   short (B): lambda < 1.63 um   (Bands 1-2, 0.75-1.62 um)
#   mid   (G): 1.63 <= lambda < 3.83 um  (Bands 3-4, 1.63-3.82 um)
#   long  (R): lambda >= 3.83 um  (Bands 5-6, 3.83-5.00 um)
# ---------------------------------------------------------------------------

BAND_EDGES_UM = (
    ("Band 1", 0.75, 1.09, 39),
    ("Band 2", 1.10, 1.62, 41),
    ("Band 3", 1.63, 2.41, 41),
    ("Band 4", 2.42, 3.82, 35),
    ("Band 5", 3.83, 4.41, 112),
    ("Band 6", 4.42, 5.00, 128),
)
# R values above are the IRSA Data Products (12 Nov 2026) figures.

SHORT_MAX_UM = 1.63  # Band 3 official start
MID_MAX_UM = 3.83  # Band 5 official start
COVERAGE_UM = (0.75, 5.00)
N_DETECTORS = 6
CHANNELS_PER_DETECTOR = 17
N_NOMINAL_CHANNELS = N_DETECTORS * CHANNELS_PER_DETECTOR  # 102

# Spectrophotometry Tool core columns (IRSA):
#   wavelength (um), flux (uJy), flux_err (uJy)
#   https://irsa.ipac.caltech.edu/onlinehelp/spherex/spherex/sp.html

DEFAULT_SNR_MIN = 3.0
# Tunable display cut, not a physical constant. Long-group flux must be
# at least this many times the stellar slope extrapolated from the short
# group before the source is tagged dusty/IR excess.
DEFAULT_IR_EXCESS_THRESHOLD = 2.5
# Log stretch is clipped to this many dex below the peak of the three
# group values, then scaled to 0-1. Tunable display parameter.
DEFAULT_LOG_CLIP_DEX = 1.0
# Color-index cuts, log10(F_short / F_long). Tunable display parameters.
DEFAULT_HOT_INDEX = 0.30
DEFAULT_COOL_INDEX = -0.10

GRAY_HEX = "#808080"
INSUFFICIENT_TAG = "insufficient data"
TAGS = (
    "blue/hot",
    "neutral",
    "red/cool",
    "dusty/IR excess",
    INSUFFICIENT_TAG,
)

CAPTIONS = {
    "general": (
        "False color: SPHEREx sees infrared light, invisible to the eye. "
        "Blue = shorter infrared, red = longer."
    ),
    "blue/hot": (
        "Brighter at shorter infrared wavelengths, the pattern of a hotter star."
    ),
    "neutral": (
        "Similar brightness across short, mid, and long infrared, a middling color."
    ),
    "red/cool": (
        "Brighter at longer infrared wavelengths, the pattern of a cooler star."
    ),
    "dusty/IR excess": (
        "The longest infrared light is brighter than a smooth stellar slope "
        "from the short infrared would predict, a sign of warm dust."
    ),
    INSUFFICIENT_TAG: (
        "Not enough good measurements in all three infrared groups to assign a color."
    ),
}


class SpectrumError(ValueError):
    """Input spectrum is missing required columns or is the wrong shape."""


def group_name(wavelength_um: float) -> str:
    """Return 'short', 'mid', or 'long' for a wavelength in microns."""
    if not math.isfinite(wavelength_um):
        raise SpectrumError(f"non-finite wavelength: {wavelength_um!r}")
    if wavelength_um < SHORT_MAX_UM:
        return "short"
    if wavelength_um < MID_MAX_UM:
        return "mid"
    return "long"


def _as_float_list(values: Iterable[Any], label: str) -> list[float]:
    out: list[float] = []
    for i, value in enumerate(values):
        try:
            out.append(float(value))
        except (TypeError, ValueError) as exc:
            raise SpectrumError(f"{label}[{i}] is not a number: {value!r}") from exc
    return out


def _first_key(row: Mapping[str, Any], *names: str) -> Any:
    lower = {str(k).strip().lower(): k for k in row}
    for name in names:
        key = lower.get(name.lower())
        if key is not None:
            return row[key]
    return None


def parse_spectrum(payload: Any) -> dict[str, Any]:
    """Normalize JSON, CSV rows, or a dict into wavelength / flux / error lists.

    Accepted column names, case-insensitive:
      wavelength, wavelength_um, lambda, lambda_um
      flux
      flux_err, flux_error, error
    Optional: source_id, name, id
    """
    if isinstance(payload, Mapping) and "sources" in payload:
        raise SpectrumError("a multi-source object must be split before parse_spectrum")

    source_id = None
    records: list[Mapping[str, Any]] | None = None
    if isinstance(payload, Mapping):
        source_id = _first_key(payload, "source_id", "name", "id", "source")
        wave = _first_key(
            payload, "wavelength_um", "wavelength", "lambda_um", "lambda", "wave"
        )
        flux = _first_key(payload, "flux", "flux_ujy", "fnu")
        err = _first_key(
            payload, "flux_error", "flux_err", "error", "flux_uncertainty", "unc"
        )
        if wave is not None and flux is not None:
            if err is None:
                raise SpectrumError("spectrum is missing flux_error / flux_err")
            return {
                "source_id": source_id,
                "wavelength_um": _as_float_list(wave, "wavelength"),
                "flux": _as_float_list(flux, "flux"),
                "flux_error": _as_float_list(err, "flux_error"),
            }
        if "channels" in payload and isinstance(payload["channels"], list):
            records = payload["channels"]
        else:
            raise SpectrumError(
                "spectrum needs wavelength, flux, and flux_error arrays, "
                "or a list of per-channel records"
            )
    elif isinstance(payload, list):
        records = payload
    else:
        raise SpectrumError(f"unsupported spectrum type: {type(payload).__name__}")

    if not records:
        raise SpectrumError("spectrum has no channels")

    wavelength_um: list[float] = []
    flux: list[float] = []
    flux_error: list[float] = []
    for i, row in enumerate(records):
        if not isinstance(row, Mapping):
            raise SpectrumError(f"channel {i} is not an object")
        w = _first_key(
            row, "wavelength_um", "wavelength", "lambda_um", "lambda", "wave"
        )
        f = _first_key(row, "flux", "flux_ujy", "fnu")
        e = _first_key(
            row, "flux_error", "flux_err", "error", "flux_uncertainty", "unc"
        )
        if w is None or f is None or e is None:
            raise SpectrumError(
                f"channel {i} needs wavelength, flux, and flux_error"
            )
        wavelength_um.append(float(w))
        flux.append(float(f))
        flux_error.append(float(e))
    return {
        "source_id": source_id,
        "wavelength_um": wavelength_um,
        "flux": flux,
        "flux_error": flux_error,
    }


def _snr(flux: float, error: float) -> float:
    if not math.isfinite(flux) or not math.isfinite(error) or error <= 0.0:
        return float("-inf")
    return flux / error


def average_groups(
    wavelength_um: Sequence[float],
    flux: Sequence[float],
    flux_error: Sequence[float],
    snr_min: float = DEFAULT_SNR_MIN,
) -> dict[str, Any]:
    """Unweighted average of channels in each group, after an SNR cut.

    Channels with SNR < snr_min, non-finite values, or non-positive errors
    are skipped. A simple mean is used, not an inverse-variance mean:
    the channels in a group are at different wavelengths, and weighting
    by 1/error^2 would let the faintest (or lowest-error) channel set
    the color.
    """
    if not (len(wavelength_um) == len(flux) == len(flux_error)):
        raise SpectrumError(
            "wavelength, flux, and flux_error must have the same length "
            f"(got {len(wavelength_um)}, {len(flux)}, {len(flux_error)})"
        )

    buckets: dict[str, dict[str, list[float]]] = {
        name: {"wave": [], "flux": [], "error": []}
        for name in ("short", "mid", "long")
    }
    skipped = 0
    for wave, fnu, err in zip(wavelength_um, flux, flux_error):
        if _snr(fnu, err) < snr_min:
            skipped += 1
            continue
        name = group_name(wave)
        buckets[name]["wave"].append(wave)
        buckets[name]["flux"].append(fnu)
        buckets[name]["error"].append(err)

    groups: dict[str, Any] = {}
    for name in ("short", "mid", "long"):
        waves = buckets[name]["wave"]
        fluxes = buckets[name]["flux"]
        errors = buckets[name]["error"]
        n = len(fluxes)
        if n == 0:
            groups[name] = {
                "flux": None,
                "flux_error": None,
                "mean_wavelength_um": None,
                "n_channels": 0,
                "channels": {"wavelength_um": [], "flux": [], "flux_error": []},
            }
            continue
        fmean = sum(fluxes) / n
        lmean = sum(waves) / n
        # Error of an unweighted mean of independent points.
        ferr = math.sqrt(sum(e * e for e in errors)) / n
        groups[name] = {
            "flux": fmean,
            "flux_error": ferr,
            "mean_wavelength_um": lmean,
            "n_channels": n,
            "channels": {
                "wavelength_um": waves,
                "flux": fluxes,
                "flux_error": errors,
            },
        }
    groups["_skipped_channels"] = skipped
    groups["_input_channels"] = len(wavelength_um)
    return groups


def _powerlaw_fit(waves: Sequence[float], fluxes: Sequence[float]) -> tuple[float, float] | None:
    """Least-squares fit of log F = intercept + index * log lambda.

    Returns (intercept, spectral_index) in natural log space, so
    F_pred = exp(intercept + index * log(lambda)). Needs at least two
    finite, positive points. Not a physical calibration, just a smooth
    slope through the short-group channels.
    """
    xs: list[float] = []
    ys: list[float] = []
    for wave, fnu in zip(waves, fluxes):
        if wave > 0.0 and fnu > 0.0 and math.isfinite(wave) and math.isfinite(fnu):
            xs.append(math.log(wave))
            ys.append(math.log(fnu))
    n = len(xs)
    if n < 2:
        return None
    xbar = sum(xs) / n
    ybar = sum(ys) / n
    xx = sum((x - xbar) ** 2 for x in xs)
    if xx <= 0.0:
        return None
    xy = sum((x - xbar) * (y - ybar) for x, y in zip(xs, ys))
    index = xy / xx
    intercept = ybar - index * xbar
    return intercept, index


def ir_excess_ratio(groups: Mapping[str, Any]) -> dict[str, Any]:
    """Long-group flux divided by a short-group slope evaluated at that wavelength.

    If at least two short-group channels are usable, the slope is a
    power-law fit to those channels. If only one short channel is
    available, the script falls back to a Rayleigh-Jeans F_nu ∝ lambda^{-2}
    curve pinned at that channel. That fallback is an assumption, not a
    SPHEREx measurement.

    The ratio is None when the long group is empty or the predicted
    stellar flux is not positive and finite.
    """
    short = groups["short"]
    long = groups["long"]
    result: dict[str, Any] = {
        "ratio": None,
        "predicted_long_flux": None,
        "method": None,
        "spectral_index": None,
    }
    if short["n_channels"] == 0 or long["n_channels"] == 0:
        return result
    if long["flux"] is None or long["mean_wavelength_um"] is None:
        return result

    fit = _powerlaw_fit(
        short["channels"]["wavelength_um"],
        short["channels"]["flux"],
    )
    lam_long = long["mean_wavelength_um"]
    if fit is not None:
        intercept, index = fit
        # Steep short-group slopes can overflow exp(); treat as non-finite
        # so ratio stays None (documented) and classify_tag can still use
        # short/long fluxes for hot/cool/neutral.
        try:
            predicted = math.exp(intercept + index * math.log(lam_long))
        except OverflowError:
            predicted = float("inf")
        method = "short-group power-law fit"
        result["spectral_index"] = index
    elif short["flux"] and short["mean_wavelength_um"] and short["mean_wavelength_um"] > 0:
        # Fallback assumption: Rayleigh-Jeans F_nu ∝ lambda^{-2}.
        predicted = short["flux"] * (short["mean_wavelength_um"] / lam_long) ** 2
        method = "rayleigh-jeans fallback (F_nu ~ lambda^-2)"
        result["spectral_index"] = -2.0
    else:
        return result

    if not math.isfinite(predicted) or predicted <= 0.0:
        return result
    result["predicted_long_flux"] = predicted
    result["ratio"] = long["flux"] / predicted
    result["method"] = method
    return result


def log_stretch_rgb(
    short_flux: float,
    mid_flux: float,
    long_flux: float,
    clip_dex: float = DEFAULT_LOG_CLIP_DEX,
) -> tuple[int, int, int]:
    """Map the three group fluxes to 8-bit (R, G, B) = (long, mid, short).

    Each flux is log10-stretched. Values more than clip_dex below the
    peak of the three logs clip to 0; the peak clips to 1. Equal group
    fluxes therefore map to white, a short-bright spectrum to blue, and
    a long-bright spectrum to red.
    """
    fluxes = (long_flux, mid_flux, short_flux)  # R, G, B
    logs: list[float] = []
    for value in fluxes:
        if not math.isfinite(value) or value <= 0.0:
            # Should not happen for a complete group average of SNR>=3
            # positive-flux channels; treat as the floor.
            logs.append(float("-inf"))
        else:
            logs.append(math.log10(value))
    finite = [v for v in logs if math.isfinite(v)]
    if not finite or clip_dex <= 0.0:
        return (128, 128, 128)
    peak = max(finite)
    floor = peak - clip_dex
    rgb: list[int] = []
    for value in logs:
        if not math.isfinite(value):
            norm = 0.0
        else:
            norm = (value - floor) / clip_dex
            if norm < 0.0:
                norm = 0.0
            elif norm > 1.0:
                norm = 1.0
        rgb.append(int(round(norm * 255.0)))
    return rgb[0], rgb[1], rgb[2]


def rgb_to_hex(r: int, g: int, b: int) -> str:
    return f"#{r:02x}{g:02x}{b:02x}"


def classify_tag(
    groups: Mapping[str, Any],
    excess: Mapping[str, Any],
    ir_excess_threshold: float = DEFAULT_IR_EXCESS_THRESHOLD,
    hot_index: float = DEFAULT_HOT_INDEX,
    cool_index: float = DEFAULT_COOL_INDEX,
) -> str:
    """Pick a tag. Dusty is tested before cool, so a dust bump wins."""
    if any(groups[name]["n_channels"] == 0 for name in ("short", "mid", "long")):
        return INSUFFICIENT_TAG
    ratio = excess.get("ratio")
    if (
        ratio is not None
        and math.isfinite(ratio)
        and ir_excess_threshold is not None
        and ratio >= ir_excess_threshold
    ):
        return "dusty/IR excess"
    short = groups["short"]["flux"]
    long = groups["long"]["flux"]
    if short is None or long is None or short <= 0.0 or long <= 0.0:
        return INSUFFICIENT_TAG
    color_index = math.log10(short / long)
    if color_index >= hot_index:
        return "blue/hot"
    if color_index <= cool_index:
        return "red/cool"
    return "neutral"


def colorize(
    payload: Any,
    *,
    snr_min: float = DEFAULT_SNR_MIN,
    ir_excess_threshold: float = DEFAULT_IR_EXCESS_THRESHOLD,
    log_clip_dex: float = DEFAULT_LOG_CLIP_DEX,
    hot_index: float = DEFAULT_HOT_INDEX,
    cool_index: float = DEFAULT_COOL_INDEX,
) -> dict[str, Any]:
    """Return hex color, tag, group averages, and caption for one source."""
    spectrum = parse_spectrum(payload)
    groups = average_groups(
        spectrum["wavelength_um"],
        spectrum["flux"],
        spectrum["flux_error"],
        snr_min=snr_min,
    )
    skipped = groups.pop("_skipped_channels")
    n_input = groups.pop("_input_channels")
    excess = ir_excess_ratio(groups)
    tag = classify_tag(
        groups,
        excess,
        ir_excess_threshold=ir_excess_threshold,
        hot_index=hot_index,
        cool_index=cool_index,
    )
    if tag == INSUFFICIENT_TAG:
        hex_color = GRAY_HEX
        rgb = (128, 128, 128)
    else:
        rgb = log_stretch_rgb(
            groups["short"]["flux"],
            groups["mid"]["flux"],
            groups["long"]["flux"],
            clip_dex=log_clip_dex,
        )
        hex_color = rgb_to_hex(*rgb)

    # Public group block: drop the raw channel lists to keep pipeline
    # JSON small. Channel counts and averages are enough for the viewer.
    public_groups = {}
    for name in ("short", "mid", "long"):
        item = groups[name]
        public_groups[name] = {
            "flux": item["flux"],
            "flux_error": item["flux_error"],
            "mean_wavelength_um": item["mean_wavelength_um"],
            "n_channels": item["n_channels"],
        }

    return {
        "source_id": spectrum.get("source_id"),
        "hex": hex_color,
        "rgb": {"r": rgb[0], "g": rgb[1], "b": rgb[2]},
        "tag": tag,
        "caption": CAPTIONS[tag],
        "general_caption": CAPTIONS["general"],
        "groups": public_groups,
        "ir_excess": {
            "ratio": excess["ratio"],
            "predicted_long_flux": excess["predicted_long_flux"],
            "method": excess["method"],
            "spectral_index": excess["spectral_index"],
            "threshold": ir_excess_threshold,
        },
        "color_index_log10_short_over_long": (
            None
            if public_groups["short"]["flux"] in (None, 0)
            or public_groups["long"]["flux"] in (None, 0)
            or public_groups["short"]["flux"] <= 0
            or public_groups["long"]["flux"] <= 0
            else math.log10(
                public_groups["short"]["flux"] / public_groups["long"]["flux"]
            )
        ),
        "parameters": {
            "snr_min": snr_min,
            "ir_excess_threshold": ir_excess_threshold,
            "log_clip_dex": log_clip_dex,
            "hot_index": hot_index,
            "cool_index": cool_index,
            "short_max_um": SHORT_MAX_UM,
            "mid_max_um": MID_MAX_UM,
            "group_edges_um": {
                "short": [None, SHORT_MAX_UM],
                "mid": [SHORT_MAX_UM, MID_MAX_UM],
                "long": [MID_MAX_UM, None],
            },
        },
        "n_input_channels": n_input,
        "n_skipped_channels": skipped,
    }


# ---------------------------------------------------------------------------
# Synthetic 102-channel grid used only by the self-test.
# Channel centers are geometric midpoints of 17 equal log-wavelength steps
# inside each official band. These are not the flight band-center values
# from the Spectral Channels product or the calibration PDF.
# ---------------------------------------------------------------------------

H_PLANCK = 6.62607015e-34
C_LIGHT = 2.99792458e8
K_BOLTZMANN = 1.380649e-23


def synthetic_channel_wavelengths() -> list[float]:
    waves: list[float] = []
    for _name, lo, hi, _r in BAND_EDGES_UM:
        log_lo = math.log(lo)
        log_hi = math.log(hi)
        for i in range(CHANNELS_PER_DETECTOR):
            # Midpoint of the i-th of 17 equal log steps.
            frac = (i + 0.5) / CHANNELS_PER_DETECTOR
            waves.append(math.exp(log_lo + frac * (log_hi - log_lo)))
    return waves


def planck_fnu(wavelength_um: float, temperature_k: float) -> float:
    """Spectral radiance B_nu in SI units (W m^-2 Hz^-1 sr^-1)."""
    if wavelength_um <= 0.0 or temperature_k <= 0.0:
        return 0.0
    lam = wavelength_um * 1e-6
    nu = C_LIGHT / lam
    x = H_PLANCK * nu / (K_BOLTZMANN * temperature_k)
    if x > 700.0:
        return 0.0
    return 2.0 * H_PLANCK * (nu**3) / (C_LIGHT**2) / math.expm1(x)


def synthetic_spectrum(
    temperature_k: float,
    *,
    dust_temperature_k: float | None = None,
    dust_scale: float = 0.0,
    snr: float = 50.0,
    source_id: str | None = None,
) -> dict[str, Any]:
    waves = synthetic_channel_wavelengths()
    flux: list[float] = []
    error: list[float] = []
    for wave in waves:
        value = planck_fnu(wave, temperature_k)
        if dust_temperature_k and dust_scale:
            value += dust_scale * planck_fnu(wave, dust_temperature_k)
        # Scale to a comfortable number; only ratios matter.
        value *= 1e26
        flux.append(value)
        error.append(value / snr if value > 0.0 else 1.0)
    return {
        "source_id": source_id,
        "wavelength_um": waves,
        "flux": flux,
        "flux_error": error,
    }


def self_test() -> int:
    """Assert tags for a hot star, a cool star, and a cool star plus warm dust."""
    cases = [
        (
            "hot blackbody",
            synthetic_spectrum(10000.0, source_id="hot-10000K"),
            "blue/hot",
        ),
        (
            "cool blackbody",
            synthetic_spectrum(1500.0, source_id="cool-1500K"),
            "red/cool",
        ),
        (
            "cool blackbody plus warm dust",
            synthetic_spectrum(
                2500.0,
                dust_temperature_k=500.0,
                # 500 K dust is negligible in the short group (Wien side)
                # and strong in bands 5-6. Scale is a test knob, not a
                # physical dust mass.
                dust_scale=4.0e4,
                source_id="cool-2500K-dust-500K",
            ),
            "dusty/IR excess",
        ),
    ]
    failures: list[str] = []
    reports: list[dict[str, Any]] = []
    for label, spectrum, expected in cases:
        result = colorize(spectrum)
        reports.append(
            {
                "label": label,
                "expected": expected,
                "got": result["tag"],
                "hex": result["hex"],
                "ir_excess_ratio": result["ir_excess"]["ratio"],
                "color_index": result["color_index_log10_short_over_long"],
                "groups": {
                    name: {
                        "n": result["groups"][name]["n_channels"],
                        "flux": result["groups"][name]["flux"],
                        "wave": result["groups"][name]["mean_wavelength_um"],
                    }
                    for name in ("short", "mid", "long")
                },
            }
        )
        if result["tag"] != expected:
            failures.append(
                f"{label}: expected {expected!r}, got {result['tag']!r} "
                f"(hex={result['hex']}, color_index="
                f"{result['color_index_log10_short_over_long']}, "
                f"ir_excess={result['ir_excess']['ratio']})"
            )

    # Insufficient-data path: drop every long-group channel.
    incomplete = synthetic_spectrum(10000.0, source_id="no-long-group")
    waves = []
    flux = []
    err = []
    for wave, fnu, e in zip(
        incomplete["wavelength_um"], incomplete["flux"], incomplete["flux_error"]
    ):
        if wave >= MID_MAX_UM:
            continue
        waves.append(wave)
        flux.append(fnu)
        err.append(e)
    missing = colorize(
        {"source_id": "no-long-group", "wavelength_um": waves, "flux": flux, "flux_error": err}
    )
    reports.append(
        {
            "label": "insufficient data (no long group)",
            "expected": INSUFFICIENT_TAG,
            "got": missing["tag"],
            "hex": missing["hex"],
        }
    )
    if missing["tag"] != INSUFFICIENT_TAG or missing["hex"] != GRAY_HEX:
        failures.append(
            f"insufficient data: expected tag={INSUFFICIENT_TAG!r} hex={GRAY_HEX}, "
            f"got tag={missing['tag']!r} hex={missing['hex']}"
        )

    # Low-SNR channels must be skipped, not averaged in.
    noisy = synthetic_spectrum(10000.0, snr=50.0, source_id="snr-cut")
    # Poison one mid-group channel with huge error (SNR < 3).
    for i, wave in enumerate(noisy["wavelength_um"]):
        if SHORT_MAX_UM <= wave < MID_MAX_UM:
            noisy["flux_error"][i] = abs(noisy["flux"][i]) * 10.0  # SNR = 0.1
            break
    intact_mid = colorize(synthetic_spectrum(10000.0, source_id="snr-cut-ref"))
    cut = colorize(noisy)
    if cut["groups"]["mid"]["n_channels"] != intact_mid["groups"]["mid"]["n_channels"] - 1:
        failures.append(
            "SNR cut did not drop the poisoned mid-group channel: "
            f"{cut['groups']['mid']['n_channels']} vs "
            f"{intact_mid['groups']['mid']['n_channels'] - 1}"
        )

    n_waves = len(synthetic_channel_wavelengths())
    if n_waves != N_NOMINAL_CHANNELS:
        failures.append(
            f"synthetic grid has {n_waves} channels, expected {N_NOMINAL_CHANNELS}"
        )

    print(json.dumps({"self_test": "fail" if failures else "pass", "cases": reports, "failures": failures}, indent=2))
    if failures:
        for line in failures:
            print(f"FAIL: {line}", file=sys.stderr)
        return 1
    print("self-test passed", file=sys.stderr)
    return 0


def _read_json(text: str) -> Any:
    return json.loads(text)


def _looks_like_csv(text: str) -> bool:
    first = next((line for line in text.splitlines() if line.strip()), "")
    lower = first.lower()
    return ("," in first or "\t" in first) and (
        "wavelength" in lower or "lambda" in lower or "flux" in lower
    )


def parse_csv_spectrum(text: str) -> dict[str, Any]:
    sample = text.lstrip()
    dialect = csv.Sniffer().sniff(sample.splitlines()[0] + "\n" + (sample.splitlines()[1] if len(sample.splitlines()) > 1 else ""))
    reader = csv.DictReader(io.StringIO(text), dialect=dialect)
    rows = [row for row in reader]
    if not rows:
        raise SpectrumError("CSV spectrum has no data rows")
    return parse_spectrum(rows)


def load_payload(path: str | None, stdin: bool) -> Any:
    if stdin or path in (None, "-"):
        text = sys.stdin.read()
    else:
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
    if not text.strip():
        raise SpectrumError("empty input")
    stripped = text.lstrip()
    if stripped[0] in "{[":
        # JSON or JSONL. JSONL if more than one stripped line starts with { and
        # json.loads of the whole file fails.
        try:
            return _read_json(text)
        except json.JSONDecodeError:
            sources = []
            for line_no, line in enumerate(text.splitlines(), 1):
                if not line.strip():
                    continue
                try:
                    sources.append(json.loads(line))
                except json.JSONDecodeError as exc:
                    raise SpectrumError(f"JSONL line {line_no}: {exc}") from exc
            return {"sources": sources}
    if _looks_like_csv(text):
        return parse_csv_spectrum(text)
    raise SpectrumError("input is neither JSON, JSONL, nor a CSV with wavelength/flux columns")


def iter_sources(payload: Any) -> list[Any]:
    if isinstance(payload, Mapping) and isinstance(payload.get("sources"), list):
        return payload["sources"]
    return [payload]


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Map a SPHEREx per-source spectrum to a false-color hex value "
            "and a tag for the StarIS viewer."
        )
    )
    parser.add_argument(
        "input",
        nargs="?",
        help="JSON, JSONL, or CSV spectrum. Omit or use - to read stdin.",
    )
    parser.add_argument("-o", "--output", help="Write JSON here instead of stdout.")
    parser.add_argument(
        "--stdin",
        action="store_true",
        help="Read the spectrum from stdin (same as passing -).",
    )
    parser.add_argument("--self-test", action="store_true", help="Run synthetic-spectrum assertions and exit.")
    parser.add_argument("--snr-min", type=float, default=DEFAULT_SNR_MIN)
    parser.add_argument(
        "--ir-excess-threshold",
        type=float,
        default=DEFAULT_IR_EXCESS_THRESHOLD,
        help="Tunable dusty/IR excess cut (long / extrapolated short-group slope).",
    )
    parser.add_argument("--log-clip-dex", type=float, default=DEFAULT_LOG_CLIP_DEX)
    parser.add_argument("--hot-index", type=float, default=DEFAULT_HOT_INDEX)
    parser.add_argument("--cool-index", type=float, default=DEFAULT_COOL_INDEX)
    args = parser.parse_args(argv)

    if args.self_test:
        return self_test()

    if not args.stdin and args.input is None and sys.stdin.isatty():
        parser.error("provide a spectrum file, --stdin, or --self-test")

    try:
        payload = load_payload(args.input, stdin=args.stdin)
        results = [
            colorize(
                source,
                snr_min=args.snr_min,
                ir_excess_threshold=args.ir_excess_threshold,
                log_clip_dex=args.log_clip_dex,
                hot_index=args.hot_index,
                cool_index=args.cool_index,
            )
            for source in iter_sources(payload)
        ]
    except SpectrumError as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 2

    body: Any = results[0] if len(results) == 1 else {"sources": results}
    text = json.dumps(body, indent=2)
    if args.output:
        parent = os.path.dirname(os.path.abspath(args.output))
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(args.output, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.write("\n")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
