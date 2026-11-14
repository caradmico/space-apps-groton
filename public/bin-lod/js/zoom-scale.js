// public/js/zoom-scale.js
// Shared logarithmic zoom-resolution math and UI binding for StarIS viewers.

export const AU_PER_PC = 206264.806;
export const MAX_DIST_PC = 1e5;
export const ZOOM_LEVELS = ["fine", "medium", "coarse"];
export const DEFAULT_ZOOM = "medium";
export const ZOOM_STORAGE_KEY = "staris-zoom";

// Proportionality constants k[level] such that step = k * d * strength:
// - fine:   k = 0.05  -> at 10 AU, step = 0.5 AU (in [0.05, 1] AU); at 1 AU, step = 0.05 AU (< 0.25 AU)
// - medium: k = 0.20  -> at 10 pc, step = 2.0 pc (in [1.5, 2.5] pc)
// - coarse: k = 2.20  -> multiplier (1 + 2.2) = 3.2x per step:
//                        from 1 pc: 3.2^10 ≈ 1.12e5 pc (10 steps <= 12)
//                        from 100 AU (4.848e-4 pc): 4.848e-4 * 3.2^16 ≈ 5.84e4, 16 steps with floor boost reaches > 1e5
const LEVEL_FACTORS = {
  fine: 0.05,
  medium: 0.20,
  coarse: 2.60, // 3.6^10 > 1e5 (9 steps from 1 pc); from 100 AU (4.848e-4 pc), 4.848e-4 * 3.6^15 = 1.07e5 (15 steps <= 16)
};

const LEVEL_FLOORS_PC = {
  fine: 0.02 / AU_PER_PC,    // 0.02 AU floor
  medium: 0.05 / AU_PER_PC,  // 0.05 AU floor
  coarse: 0.20 / AU_PER_PC,  // 0.20 AU floor
};

const LEVEL_CAPS_PC = {
  fine: 5e3,
  medium: 2.5e4,
  coarse: 2.5e5,
};

export function parseZoomLevel(raw) {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().toLowerCase();
  return ZOOM_LEVELS.includes(cleaned) ? cleaned : null;
}

export function resolveZoomLevel({ search, storage } = {}) {
  try {
    let params = null;
    if (search instanceof URLSearchParams) {
      params = search;
    } else if (typeof search === "string") {
      params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
    } else if (typeof location !== "undefined" && location && typeof location.search === "string") {
      params = new URLSearchParams(location.search);
    }
    if (params) {
      const fromUrl = parseZoomLevel(params.get("zoom"));
      if (fromUrl) return fromUrl;
    }
  } catch (_) {
    // ignore URL parsing errors
  }

  try {
    const store =
      storage !== undefined
        ? storage
        : typeof localStorage !== "undefined"
        ? localStorage
        : null;
    if (store && typeof store.getItem === "function") {
      const fromStorage = parseZoomLevel(store.getItem(ZOOM_STORAGE_KEY));
      if (fromStorage) return fromStorage;
    }
  } catch (_) {
    // ignore storage access errors
  }

  return DEFAULT_ZOOM;
}

export function persistZoomLevel(level, storage, url) {
  const valid = parseZoomLevel(level);
  if (!valid) return null;

  try {
    const store =
      storage !== undefined
        ? storage
        : typeof localStorage !== "undefined"
        ? localStorage
        : null;
    if (store && typeof store.setItem === "function") {
      store.setItem(ZOOM_STORAGE_KEY, valid);
    }
  } catch (_) {
    // ignore storage write errors
  }

  try {
    if (url instanceof URL) {
      if (valid === DEFAULT_ZOOM) {
        url.searchParams.delete("zoom");
      } else {
        url.searchParams.set("zoom", valid);
      }
      if (typeof history !== "undefined" && history && typeof history.replaceState === "function") {
        history.replaceState(null, "", url.toString());
      }
    }
  } catch (_) {
    // ignore history/URL errors
  }

  return valid;
}

export function cycleZoomLevel(current, dir = 1) {
  const valid = parseZoomLevel(current) || DEFAULT_ZOOM;
  const idx = ZOOM_LEVELS.indexOf(valid);
  const step = dir >= 0 ? 1 : -1;
  const nextIdx = (idx + step + ZOOM_LEVELS.length) % ZOOM_LEVELS.length;
  return ZOOM_LEVELS[nextIdx];
}

export function zoomStepPc(distancePc, level, strength = 1) {
  const validLevel = parseZoomLevel(level) || DEFAULT_ZOOM;
  const k = LEVEL_FACTORS[validLevel];
  const floor = LEVEL_FLOORS_PC[validLevel];
  const cap = LEVEL_CAPS_PC[validLevel];

  const rawDist = Number(distancePc);
  const baseDist = Number.isFinite(rawDist) && rawDist > 0 ? rawDist : 1;
  const d = Math.max(baseDist, floor);

  const rawStrength = Number(strength);
  const s = Number.isFinite(rawStrength) && rawStrength > 0 ? rawStrength : 1;

  const step = k * d * s;
  return Math.min(cap, Math.max(1e-11, step));
}

function toXYZ(pt) {
  if (!pt) return null;
  if (Array.isArray(pt) && pt.length >= 3) {
    const x = Number(pt[0]);
    const y = Number(pt[1]);
    const z = Number(pt[2]);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      return { x, y, z };
    }
    return null;
  }
  if (typeof pt === "object") {
    const x = Number(pt.x);
    const y = Number(pt.y);
    const z = Number(pt.z);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      return { x, y, z };
    }
  }
  return null;
}

function dist3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function zoomReferenceDistance({
  cameraPos,
  targetPos,
  lookGap = 0.5,
  interestPoints = [],
} = {}) {
  const cam = toXYZ(cameraPos) || { x: 0, y: 0, z: 1 };
  const origin = { x: 0, y: 0, z: 0 };

  let best = dist3(cam, origin);

  if (Array.isArray(interestPoints)) {
    for (const pt of interestPoints) {
      const p = toXYZ(pt);
      if (p) {
        const d = dist3(cam, p);
        if (d < best) best = d;
      }
    }
  }

  const tgt = toXYZ(targetPos);
  if (tgt) {
    const dTarget = dist3(cam, tgt);
    const gap = Number(lookGap);
    const isLookAhead =
      Number.isFinite(gap) && gap > 0 && Math.abs(dTarget - gap) <= 0.25 * gap;
    if (!isLookAhead && dTarget < best) {
      best = dTarget;
    }
  }

  if (!Number.isFinite(best) || best < 1e-9) {
    return 1e-9;
  }
  return best;
}

export function formatZoomStep(stepPc) {
  const s = Number(stepPc);
  const val = Number.isFinite(s) && s > 0 ? s : 1;
  if (val < 0.1) {
    const au = val * AU_PER_PC;
    if (au < 0.1) return `${au.toFixed(3)} AU/step`;
    if (au < 10) return `${au.toFixed(2)} AU/step`;
    return `${au.toFixed(1)} AU/step`;
  }
  if (val < 10) return `${val.toFixed(2)} pc/step`;
  if (val < 1000) return `${val.toFixed(1)} pc/step`;
  return `${Math.round(val)} pc/step`;
}

export function formatZoomLabel(level) {
  const valid = parseZoomLevel(level) || DEFAULT_ZOOM;
  return valid.charAt(0).toUpperCase() + valid.slice(1);
}

export function installZoomControl({ level, onChange, controlsEl } = {}) {
  if (typeof document === "undefined") return null;

  const valid = parseZoomLevel(level) || DEFAULT_ZOOM;
  const container =
    controlsEl ||
    (typeof document.querySelector === "function" ? document.querySelector(".controls") : null);

  let select =
    typeof document.getElementById === "function"
      ? document.getElementById("zoom-select")
      : null;

  if (!select && container && typeof document.createElement === "function") {
    const label = document.createElement("label");
    label.className = "ctrl-chip";
    label.setAttribute("for", "zoom-select");

    const span = document.createElement("span");
    span.textContent = "Zoom:";
    label.appendChild(span);

    select = document.createElement("select");
    select.id = "zoom-select";
    select.setAttribute("aria-label", "Zoom resolution");

    for (const lvl of ZOOM_LEVELS) {
      const opt = document.createElement("option");
      opt.value = lvl;
      opt.textContent = formatZoomLabel(lvl);
      if (lvl === valid) opt.selected = true;
      select.appendChild(opt);
    }

    label.appendChild(select);
    container.appendChild(label);
  }

  if (!select) return null;

  select.value = valid;

  if (select._starisZoomHandler && typeof select.removeEventListener === "function") {
    select.removeEventListener("change", select._starisZoomHandler);
  }

  const handler = (e) => {
    const next = parseZoomLevel(e?.target?.value ?? select.value) || DEFAULT_ZOOM;
    select.value = next;
    if (typeof onChange === "function") {
      onChange(next);
    }
  };

  select._starisZoomHandler = handler;
  if (typeof select.addEventListener === "function") {
    select.addEventListener("change", handler);
  }

  return select;
}
