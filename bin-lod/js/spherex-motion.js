/**
 * SPHEREx x Gaia DR3 star & asteroid motion rules + 3D viewer layer.
 * Mirrors tools/spherex-motion/motion.py exactly.
 */

export const KAPPA = 4.740470446;
export const KMS_TO_PC_PER_YR = 1.0227121650537077e-6;
export const GAUSS_K = 0.01720209895;
export const OBLIQUITY_J2000_DEG = 23.4392911;
export const AU_KM = 149597870.7;
export const C_AU_PER_DAY = 173.1446326846693;

export const DEFAULT_CFG = {
  plx_snr_min: 5.0,
  pm_snr_min: 3.0,
  theta_max_deg: 0.1,
  sigma_v_frac: 0.10,
  v_assumed_kms: 50.0,
  sideways_frac: 0.1,
  cap_years: 1.0e6,
  fade_floor: 0.25,
  gaia_epoch: 2016.0,
};

export const LABELS = {
  SIDEWAYS_ONLY: "sideways only",
  STATIC: "motion not measured",
  uncertain: "uncertain",
  approximate: "approximate: galactic orbits not modeled",
};

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

function mergeCfg(cfg) {
  return cfg ? { ...DEFAULT_CFG, ...cfg } : { ...DEFAULT_CFG };
}

function numField(star, ...names) {
  if (!star) return null;
  for (const n of names) {
    const v = star[n];
    if (v === null || v === undefined || v === "") continue;
    const f = Number(v);
    if (Number.isFinite(f)) return f;
  }
  return null;
}

function pmStats(star) {
  const pmra = numField(star, "pmra") ?? 0.0;
  const pmdec = numField(star, "pmdec") ?? 0.0;
  const era = numField(star, "pmra_error");
  const edec = numField(star, "pmdec_error");
  const pm = Math.hypot(pmra, pmdec);
  if (era === null || edec === null) {
    return { pmra, pmdec, pm, sig: null };
  }
  const sig = pm > 0 ? Math.hypot(pmra * era, pmdec * edec) / pm : Math.hypot(era, edec);
  return { pmra, pmdec, pm, sig };
}

export function distancePc(star) {
  const plx = numField(star, "parallax");
  return plx !== null && plx > 0 ? 1000.0 / plx : null;
}

export function classifyMotion(star, cfg = null) {
  const c = mergeCfg(cfg);
  const plx = numField(star, "parallax");
  const eplx = numField(star, "parallax_error");
  const rv = numField(star, "radial_velocity", "rv");
  const plxSnr = plx !== null && eplx !== null && eplx > 0 ? plx / eplx : 0.0;
  if (rv !== null && plx !== null && plx > 0 && plxSnr >= c.plx_snr_min) {
    return "FULL_3D";
  }
  const { pm, sig } = pmStats(star);
  if (sig === null || sig <= 0 || pm / sig < c.pm_snr_min) {
    return "STATIC";
  }
  return "SIDEWAYS_ONLY";
}

function basis(raDeg, decDeg) {
  const a = raDeg * DEG2RAD;
  const d = decDeg * DEG2RAD;
  const u = [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
  const eRa = [-Math.sin(a), Math.cos(a), 0.0];
  const eDec = [-Math.sin(d) * Math.cos(a), -Math.sin(d) * Math.sin(a), Math.cos(d)];
  return { u, eRa, eDec };
}

export function stateVector(star) {
  const d = distancePc(star);
  const ra0 = numField(star, "ra") ?? 0.0;
  const dec0 = numField(star, "dec") ?? 0.0;
  const { u, eRa, eDec } = basis(ra0, dec0);
  const { pmra, pmdec } = pmStats(star);
  const rv = numField(star, "radial_velocity", "rv") ?? 0.0;
  const r0 = [d * u[0], d * u[1], d * u[2]];
  const v = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const vKms = KAPPA * d * (pmra / 1000.0) * eRa[i] + KAPPA * d * (pmdec / 1000.0) * eDec[i] + rv * u[i];
    v[i] = vKms * KMS_TO_PC_PER_YR;
  }
  return [r0, v];
}

function distAt(star, t) {
  const [r0, v] = stateVector(star);
  return Math.hypot(r0[0] + v[0] * t, r0[1] + v[1] * t, r0[2] + v[2] * t);
}

function sigmaVKms(star) {
  const d = distancePc(star);
  const { pm, sig } = pmStats(star);
  const plx = numField(star, "parallax");
  const eplx = numField(star, "parallax_error") ?? 0.0;
  const erv = numField(star, "radial_velocity_error", "rv_error") ?? 0.0;
  const sVtan = KAPPA * d * Math.hypot((sig ?? 0.0) / 1000.0, (pm / 1000.0) * (eplx / plx));
  return Math.hypot(sVtan, erv);
}

export function trustLimitYears(star, cfg = null) {
  const c = mergeCfg(cfg);
  const cls = classifyMotion(star, c);
  const cap = c.cap_years;
  if (cls === "STATIC") return cap;
  const { sig } = pmStats(star);
  let t = sig !== null && sig > 0 ? (c.theta_max_deg * 3.6e6) / sig : cap;
  const d = distancePc(star);
  if (cls === "FULL_3D") {
    const sv = sigmaVKms(star) * KMS_TO_PC_PER_YR;
    if (sv > 0) {
      for (const sgn of [1.0, -1.0]) {
        let lo = 0.0;
        let hi = Math.min(t, cap);
        if (sv * hi <= c.sigma_v_frac * distAt(star, sgn * hi)) continue;
        for (let iter = 0; iter < 80; iter++) {
          const mid = 0.5 * (lo + hi);
          if (sv * mid > c.sigma_v_frac * distAt(star, sgn * mid)) {
            hi = mid;
          } else {
            lo = mid;
          }
        }
        t = Math.min(t, hi);
      }
    }
  } else if (cls === "SIDEWAYS_ONLY" && d) {
    const tSide = (c.sideways_frac * d) / (c.v_assumed_kms * KMS_TO_PC_PER_YR);
    t = Math.min(t, tSide);
  }
  return Math.min(t, cap);
}

export function propagateStar(star, tYears, cfg = null) {
  const c = mergeCfg(cfg);
  const cls = classifyMotion(star, c);
  const ra0 = numField(star, "ra") ?? 0.0;
  const dec0 = numField(star, "dec") ?? 0.0;
  const d0 = distancePc(star);
  if (cls === "STATIC") {
    return { ra: ra0, dec: dec0, dist_pc: d0, state: "static", alpha: 1.0, label: LABELS.STATIC };
  }
  let state = "ok";
  let t = Number(tYears);
  const tTrust = trustLimitYears(star, c);
  if (Math.abs(t) > c.cap_years) {
    t = t < 0 ? -c.cap_years : c.cap_years;
    state = "approximate";
  } else if (Math.abs(t) > tTrust) {
    state = "uncertain";
  }

  let ra;
  let dec;
  let dist;
  if (cls === "FULL_3D") {
    const [r0, v] = stateVector(star);
    const rx = r0[0] + v[0] * t;
    const ry = r0[1] + v[1] * t;
    const rz = r0[2] + v[2] * t;
    dist = Math.hypot(rx, ry, rz);
    ra = ((Math.atan2(ry, rx) * RAD2DEG) % 360.0 + 360.0) % 360.0;
    dec = Math.asin(Math.max(-1.0, Math.min(1.0, rz / dist))) * RAD2DEG;
  } else {
    const { pmra, pmdec, pm } = pmStats(star);
    const { u, eRa, eDec } = basis(ra0, dec0);
    let px = u[0];
    let py = u[1];
    let pz = u[2];
    if (pm > 0) {
      const ang = ((pm / 3.6e6) * t) * DEG2RAD;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const dx = (pmra * eRa[0] + pmdec * eDec[0]) / pm;
      const dy = (pmra * eRa[1] + pmdec * eDec[1]) / pm;
      const dz = (pmra * eRa[2] + pmdec * eDec[2]) / pm;
      px = u[0] * ca + dx * sa;
      py = u[1] * ca + dy * sa;
      pz = u[2] * ca + dz * sa;
    }
    ra = ((Math.atan2(py, px) * RAD2DEG) % 360.0 + 360.0) % 360.0;
    dec = Math.asin(Math.max(-1.0, Math.min(1.0, pz))) * RAD2DEG;
    dist = d0;
  }

  let alpha = 1.0;
  let label = LABELS[cls] || "";
  if (state === "uncertain") {
    alpha = Math.max(c.fade_floor, Math.min(1.0, tTrust / Math.abs(t)));
    label = (label ? label + "; " : "") + LABELS.uncertain;
  } else if (state === "approximate") {
    alpha = c.fade_floor;
    label = (label ? label + "; " : "") + LABELS.approximate;
  }
  return { ra, dec, dist_pc: dist, state, alpha, label };
}

export function angularSepDeg(ra1, dec1, ra2, dec2) {
  const a1 = ra1 * DEG2RAD;
  const d1 = dec1 * DEG2RAD;
  const a2 = ra2 * DEG2RAD;
  const d2 = dec2 * DEG2RAD;
  const s =
    Math.sin((d2 - d1) / 2) ** 2 +
    Math.cos(d1) * Math.cos(d2) * Math.sin((a2 - a1) / 2) ** 2;
  return 2 * Math.asin(Math.min(1.0, Math.sqrt(s))) * RAD2DEG;
}

export function keplerSolve(M, e, tol = 1e-12) {
  let E = e < 0.8 ? M : Math.PI;
  for (let i = 0; i < 100; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < tol) break;
  }
  return E;
}

export function asteroidHelioEcl(el, jd) {
  const a = Number(el.a);
  const e = Number(el.e);
  const i = Number(el.i) * DEG2RAD;
  const om = Number(el.om) * DEG2RAD;
  const w = Number(el.w) * DEG2RAD;
  const n = GAUSS_K / Math.pow(a, 1.5);
  let M = Number(el.ma) * DEG2RAD + n * (Number(jd) - Number(el.epoch_jd));
  M = ((((M + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
  const E = keplerSolve(M, e);
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const co = Math.cos(om);
  const so = Math.sin(om);
  const ci = Math.cos(i);
  const si = Math.sin(i);
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const x = (co * cw - so * sw * ci) * xp + (-co * sw - so * cw * ci) * yp;
  const y = (so * cw + co * sw * ci) * xp + (-so * sw + co * cw * ci) * yp;
  const z = sw * si * xp + cw * si * yp;
  return [x, y, z];
}

export function eclToEq(v) {
  const eps = OBLIQUITY_J2000_DEG * DEG2RAD;
  const [x, y, z] = v;
  return [x, y * Math.cos(eps) - z * Math.sin(eps), y * Math.sin(eps) + z * Math.cos(eps)];
}

export function asteroidRaDec(el, jd, observerHelioEqAU) {
  const v1 = eclToEq(asteroidHelioEcl(el, jd));
  let dx = v1[0] - observerHelioEqAU[0];
  let dy = v1[1] - observerHelioEqAU[1];
  let dz = v1[2] - observerHelioEqAU[2];
  const tau = Math.hypot(dx, dy, dz) / C_AU_PER_DAY;
  const v2 = eclToEq(asteroidHelioEcl(el, jd - tau));
  dx = v2[0] - observerHelioEqAU[0];
  dy = v2[1] - observerHelioEqAU[1];
  dz = v2[2] - observerHelioEqAU[2];
  const r = Math.hypot(dx, dy, dz);
  const ra = ((Math.atan2(dy, dx) * RAD2DEG) % 360.0 + 360.0) % 360.0;
  const dec = Math.asin(Math.max(-1.0, Math.min(1.0, dz / r))) * RAD2DEG;
  return { ra, dec, dist_au: r };
}

export function earthHelioEqAU(jd) {
  const T = (Number(jd) - 2451545.0) / 36525.0;
  const a = 1.00000261 + 0.00000562 * T;
  const e = 0.01671123 - 0.00004392 * T;
  const I = -0.00001531 - 0.01294668 * T;
  const L = 100.46457166 + 35999.37244981 * T;
  const wbar = 102.93768193 + 0.32327364 * T;
  const Omega = 0.0;
  const w = wbar - Omega;
  const ma = L - wbar;
  const ecl = asteroidHelioEcl(
    { a, e, i: I, om: Omega, w, ma, epoch_jd: jd },
    jd
  );
  return eclToEq(ecl);
}

export function sliderToYears(v) {
  const vn = Number(v);
  if (!Number.isFinite(vn) || vn === 0) return 0.0;
  const sgn = vn < 0 ? -1.0 : 1.0;
  return sgn * (Math.pow(10.0, (6.0 * Math.abs(vn)) / 1000.0) - 1.0);
}

export function yearsToSlider(y) {
  const yn = Number(y);
  if (!Number.isFinite(yn) || yn === 0) return 0.0;
  const sgn = yn < 0 ? -1.0 : 1.0;
  return sgn * (1000.0 / 6.0) * Math.log10(Math.abs(yn) + 1.0);
}

export function formatYears(y) {
  const yn = Number(y);
  if (!Number.isFinite(yn) || Math.abs(yn) < 0.05) return "0 yr";
  const sign = yn >= 0 ? "+" : "\u2212";
  const ay = Math.abs(yn);
  if (ay < 10) return `${sign}${ay.toFixed(1)} yr`;
  if (ay < 1e4) return `${sign}${Math.round(ay).toLocaleString("en-US")} yr`;
  return `${sign}${(ay / 1000).toFixed(0)}k yr`;
}

function sanitizeLayerUrl(url) {
  const fallback = "data/spherex/barnard-field.json";
  if (typeof url !== "string" || !url) return fallback;
  if (!url.startsWith("data/spherex/")) return fallback;
  if (url.includes("..") || url.includes("//") || url.includes(":")) return fallback;
  return url;
}

function currentDecimalYear() {
  const now = new Date();
  const yr = now.getUTCFullYear();
  const start = Date.UTC(yr, 0, 1);
  const end = Date.UTC(yr + 1, 0, 1);
  return yr + (now.getTime() - start) / (end - start);
}

function raDecDistToXYZ(raDeg, decDeg, distPc) {
  const d = Number.isFinite(distPc) && distPc > 0 ? distPc : 100.0;
  const a = raDeg * DEG2RAD;
  const dec = decDeg * DEG2RAD;
  return [
    Math.cos(dec) * Math.cos(a) * d,
    Math.cos(dec) * Math.sin(a) * d,
    Math.sin(dec) * d,
  ];
}

export function attachSpherexMotion({ THREE, scene, camera, controls, layerUrl, nowYear }) {
  const safeUrl = sanitizeLayerUrl(layerUrl);
  const baseNowYear = Number.isFinite(nowYear) ? Number(nowYear) : currentDecimalYear();

  let layer = null;
  let yearsFromNow = 0.0;
  let dirty = true;
  let pointsMesh = null;
  let trailsMesh = null;
  let insetCanvas = null;
  let insetCtx = null;
  let sliderEl = null;
  let readoutEl = null;

  function setupDom(layerData) {
    const ctrlBar = document.querySelector(".controls");
    if (ctrlBar && !document.getElementById("spherex-time")) {
      const chip = document.createElement("label");
      chip.className = "ctrl-chip spherex-chip";
      chip.innerHTML = `
        <span>SPHEREx t</span>
        <input id="spherex-time" type="range" min="-1000" max="1000" step="1" value="0" />
        <span id="spherex-readout">0 yr</span>
        <button type="button" data-spherex-btn="now">Now</button>
        <button type="button" data-spherex-btn="v1">Visit 1</button>
        <button type="button" data-spherex-btn="v2">Visit 2</button>
        <button type="button" data-spherex-btn="goto">Go to patch</button>
      `;
      ctrlBar.appendChild(chip);
      sliderEl = chip.querySelector("#spherex-time");
      readoutEl = chip.querySelector("#spherex-readout");

      sliderEl.addEventListener("input", () => {
        setYears(sliderToYears(Number(sliderEl.value)));
      });

      const visits = layerData?.meta?.visits || [];
      const visitYear = (idx) => {
        const v = visits[idx];
        if (!v || !Number.isFinite(v.mjd)) return 0.0;
        const yr = 2016.0 + (v.mjd - 57388.5) / 365.25;
        return yr - baseNowYear;
      };

      chip.querySelector('[data-spherex-btn="now"]').addEventListener("click", () => setYears(0));
      chip.querySelector('[data-spherex-btn="v1"]').addEventListener("click", () => setYears(visitYear(0)));
      chip.querySelector('[data-spherex-btn="v2"]').addEventListener("click", () => setYears(visitYear(1)));
      chip.querySelector('[data-spherex-btn="goto"]').addEventListener("click", () => {
        if (!layerData?.stars?.length || !controls || !camera) return;
        const st = layerData.stars[0];
        const tStar = baseNowYear - (st.epoch ?? 2016.0) + yearsFromNow;
        const p = propagateStar(st, tStar, layerData.meta?.config);
        const [x, y, z] = raDecDistToXYZ(p.ra, p.dec, p.dist_pc ?? 1.83);
        const r = Math.hypot(x, y, z) || 1.83;
        controls.target.set(x, y, z);
        const backScale = Math.max(0.1, (r - 0.05) / r);
        camera.position.set(x * backScale, y * backScale, z * backScale);
        controls.update?.();
      });
    }

    const wrap = document.getElementById("canvas-wrap") || document.body;
    if (wrap && !document.getElementById("spherex-inset")) {
      insetCanvas = document.createElement("canvas");
      insetCanvas.id = "spherex-inset";
      insetCanvas.width = 240;
      insetCanvas.height = 240;
      wrap.appendChild(insetCanvas);
      insetCtx = insetCanvas.getContext("2d");
    }
  }

  function buildSceneMeshes(layerData) {
    const stars = layerData.stars || [];
    const n = stars.length;
    if (n === 0 || !THREE || !scene) return;

    const posArr = new Float32Array(n * 3);
    const colArr = new Float32Array(n * 3);
    const trailPosArr = new Float32Array(n * 6);
    const trailColArr = new Float32Array(n * 6);

    for (let i = 0; i < n; i++) {
      const rgb = stars[i].ir_rgb || [1, 1, 1];
      colArr[i * 3] = rgb[0];
      colArr[i * 3 + 1] = rgb[1];
      colArr[i * 3 + 2] = rgb[2];
      trailColArr[i * 6] = rgb[0] * 0.4;
      trailColArr[i * 6 + 1] = rgb[1] * 0.4;
      trailColArr[i * 6 + 2] = rgb[2] * 0.4;
      trailColArr[i * 6 + 3] = rgb[0] * 0.85;
      trailColArr[i * 6 + 4] = rgb[1] * 0.85;
      trailColArr[i * 6 + 5] = rgb[2] * 0.85;
    }

    const ptGeom = new THREE.BufferGeometry();
    ptGeom.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
    ptGeom.setAttribute("color", new THREE.BufferAttribute(colArr, 3));
    const ptMat = new THREE.PointsMaterial({
      size: 0.025,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    pointsMesh = new THREE.Points(ptGeom, ptMat);
    pointsMesh.name = "spherex-stars";
    scene.add(pointsMesh);

    const trGeom = new THREE.BufferGeometry();
    trGeom.setAttribute("position", new THREE.BufferAttribute(trailPosArr, 3));
    trGeom.setAttribute("color", new THREE.BufferAttribute(trailColArr, 3));
    const trMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.65,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    trailsMesh = new THREE.LineSegments(trGeom, trMat);
    trailsMesh.name = "spherex-trails";
    scene.add(trailsMesh);
  }

  function updatePositions() {
    if (!layer) return;
    const stars = layer.stars || [];
    const cfg = layer.meta?.config || DEFAULT_CFG;

    if (pointsMesh && trailsMesh) {
      const posAttr = pointsMesh.geometry.getAttribute("position");
      const colAttr = pointsMesh.geometry.getAttribute("color");
      const trPosAttr = trailsMesh.geometry.getAttribute("position");

      for (let i = 0; i < stars.length; i++) {
        const st = stars[i];
        const epoch = st.epoch ?? 2016.0;
        const t0 = baseNowYear - epoch;
        const tNow = t0 + yearsFromNow;
        const p0 = propagateStar(st, t0, cfg);
        const p1 = propagateStar(st, tNow, cfg);

        const [x0, y0, z0] = raDecDistToXYZ(p0.ra, p0.dec, p0.dist_pc);
        const [x1, y1, z1] = raDecDistToXYZ(p1.ra, p1.dec, p1.dist_pc);

        posAttr.setXYZ(i, x1, y1, z1);
        const rgb = st.ir_rgb || [1, 1, 1];
        colAttr.setXYZ(i, rgb[0] * p1.alpha, rgb[1] * p1.alpha, rgb[2] * p1.alpha);

        trPosAttr.setXYZ(i * 2, x0, y0, z0);
        trPosAttr.setXYZ(i * 2 + 1, x1, y1, z1);
      }
      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
      trPosAttr.needsUpdate = true;
    }

    drawInset();
  }

  function drawInset() {
    if (!insetCtx || !insetCanvas || !layer) return;
    const ctx = insetCtx;
    const W = insetCanvas.width;
    const H = insetCanvas.height;
    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = "rgba(8, 12, 22, 0.88)";
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(140, 170, 220, 0.35)";
    ctx.strokeRect(0.5, 0.5, W - 1, H - 1);

    const center = layer.meta?.center || [269.45, 4.74];
    const cRa = center[0];
    const cDec = center[1];
    const cosDec = Math.max(1e-4, Math.cos(cDec * DEG2RAD));
    const cfg = layer.meta?.config || DEFAULT_CFG;
    const stars = layer.stars || [];

    let maxSpanDeg = Math.max(0.04, (layer.meta?.size_deg || 0.1) * 0.6);
    let barnardIdx = -1;
    let maxPm = -1;

    const computed = stars.map((st, idx) => {
      const epoch = st.epoch ?? 2016.0;
      const t0 = baseNowYear - epoch;
      const t1 = t0 + yearsFromNow;
      const p0 = propagateStar(st, t0, cfg);
      const p1 = propagateStar(st, t1, cfg);
      const dx0 = (((p0.ra - cRa + 540) % 360) - 180) * cosDec;
      const dy0 = p0.dec - cDec;
      const dx1 = (((p1.ra - cRa + 540) % 360) - 180) * cosDec;
      const dy1 = p1.dec - cDec;
      maxSpanDeg = Math.max(maxSpanDeg, Math.abs(dx0) * 1.25, Math.abs(dy0) * 1.25, Math.abs(dx1) * 1.25, Math.abs(dy1) * 1.25);
      const pmTot = Math.hypot(st.pmra || 0, st.pmdec || 0);
      if (pmTot > maxPm) {
        maxPm = pmTot;
        barnardIdx = idx;
      }
      return { st, p0, p1, dx0, dy0, dx1, dy1 };
    });

    const pad = 24;
    const halfPlot = (Math.min(W, H) - 2 * pad) / 2;
    const toPx = (dx, dy) => [W / 2 - (dx / maxSpanDeg) * halfPlot, H / 2 - (dy / maxSpanDeg) * halfPlot];

    for (const item of computed) {
      const [x0, y0] = toPx(item.dx0, item.dy0);
      const [x1, y1] = toPx(item.dx1, item.dy1);
      const rgb = item.st.ir_rgb || [1, 1, 1];
      const colStr = `rgba(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)},${item.p1.alpha.toFixed(2)})`;

      ctx.save();
      if (item.p1.state === "uncertain" || item.p1.state === "approximate") {
        ctx.setLineDash([3, 3]);
      }
      ctx.strokeStyle = colStr;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = colStr;
      ctx.beginPath();
      ctx.arc(x1, y1, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    if (barnardIdx >= 0) {
      const b = computed[barnardIdx];
      const [bx, by] = toPx(b.dx1, b.dy1);
      const offsetDeg = angularSepDeg(b.p0.ra, b.p0.dec, b.p1.ra, b.p1.dec);
      const clsLabel = classifyMotion(b.st, cfg);
      ctx.fillStyle = "#ffdd88";
      ctx.font = "10px sans-serif";
      ctx.fillText(`Barnard (${clsLabel}) \u0394=${offsetDeg.toFixed(3)}\u00b0`, Math.min(W - 135, Math.max(6, bx + 5)), Math.max(14, by - 5));
    }

    const asteroids = layer.asteroids || [];
    if (asteroids.length > 0) {
      const jdNow = 2457388.5 + (baseNowYear + yearsFromNow - 2016.0) * 365.25;
      const obsEq = earthHelioEqAU(jdNow);
      for (const ast of asteroids) {
        if (ast.elements) {
          const pos = asteroidRaDec(ast.elements, jdNow, obsEq);
          const adx = (((pos.ra - cRa + 540) % 360) - 180) * cosDec;
          const ady = pos.dec - cDec;
          const [ax, ay] = toPx(adx, ady);
          ctx.fillStyle = "#66ff99";
          ctx.beginPath();
          ctx.arc(ax, ay, 3.0, 0, Math.PI * 2);
          ctx.fill();
        }
        for (const tr of ast.track || []) {
          const tdx = (((tr.ra - cRa + 540) % 360) - 180) * cosDec;
          const tdy = tr.dec - cDec;
          const [tx, ty] = toPx(tdx, tdy);
          ctx.strokeStyle = "#66ff99";
          ctx.beginPath();
          ctx.arc(tx, ty, 4.0, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    ctx.fillStyle = "#cbd5e1";
    ctx.font = "10px sans-serif";
    ctx.fillText(`SPHEREx x Gaia DR3 \u2014 t = ${formatYears(yearsFromNow)} from now`, 8, H - 8);
  }

  function setYears(y) {
    const yn = Number(y);
    if (!Number.isFinite(yn)) return;
    if (yn !== yearsFromNow) {
      yearsFromNow = yn;
      dirty = true;
    }
    if (sliderEl) {
      sliderEl.value = String(Math.round(yearsToSlider(yearsFromNow)));
    }
    if (readoutEl) {
      readoutEl.textContent = formatYears(yearsFromNow);
    }
    render();
  }

  function render() {
    if (!dirty || !layer) return;
    dirty = false;
    updatePositions();
  }

  function getState() {
    return {
      layerUrl: safeUrl,
      yearsFromNow,
      loaded: Boolean(layer),
      starCount: layer?.stars?.length || 0,
      pixels: layer?.meta?.pixels || null,
    };
  }

  const api = { render, setYears, getState };
  if (typeof window !== "undefined" && typeof location !== "undefined" && location.search.includes("debug")) {
    window.__spherex = api;
  }

  if (typeof fetch === "function") {
    fetch(safeUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        layer = data;
        setupDom(data);
        buildSceneMeshes(data);
        dirty = true;
        render();
      })
      .catch((err) => {
        console.warn("spherex layer load failed:", err);
      });
  }

  return api;
}
