import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CFG,
  classifyMotion,
  trustLimitYears,
  stateVector,
  propagateStar,
  angularSepDeg,
  keplerSolve,
  asteroidHelioEcl,
  eclToEq,
  asteroidRaDec,
  earthHelioEqAU,
  sliderToYears,
  yearsToSlider,
  formatYears,
  clampInsetLabel,
  IR_COLOR_CAPTION,
  KNOWN_IR_TAGS,
  starDisplayColor,
  formatStarPopup,
} from "../public/bin-lod/js/spherex-motion.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;

function check(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error("FAIL:", msg);
  }
}

const BARNARD = {
  ra: 269.44850252543836,
  dec: 4.739420051112412,
  parallax: 546.975939730948,
  parallax_error: 0.040116355,
  pmra: -801.5509783684709,
  pmra_error: 0.031820867,
  pmdec: 10362.394206546573,
  pmdec_error: 0.036070455,
  rv: -110.46822,
  rv_error: 0.13125522,
};

// 1. Barnard FULL_3D checks
check(classifyMotion(BARNARD) === "FULL_3D", "Barnard classified as FULL_3D");

const p1 = propagateStar(BARNARD, 1.0);
const sep1Arcsec = angularSepDeg(BARNARD.ra, BARNARD.dec, p1.ra, p1.dec) * 3600.0;
check(sep1Arcsec >= 10.3 && sep1Arcsec <= 10.4, `Barnard 1-yr shift in 10.3..10.4" (got ${sep1Arcsec})`);

const p1000 = propagateStar(BARNARD, 1000.0);
const sep1000Deg = angularSepDeg(BARNARD.ra, BARNARD.dec, p1000.ra, p1000.dec);
check(sep1000Deg >= 3.0 && sep1000Deg <= 3.15, `Barnard 1000-yr shift in 3.0..3.15 deg (got ${sep1000Deg})`);

const barnardSideways = { ...BARNARD, rv: null };
check(classifyMotion(barnardSideways, { plx_snr_min: 1e9 }) === "SIDEWAYS_ONLY", "Barnard without RV is SIDEWAYS_ONLY");
const ps1000 = propagateStar(barnardSideways, 1000.0, { plx_snr_min: 1e9 });
const sepSidewaysDeg = angularSepDeg(BARNARD.ra, BARNARD.dec, ps1000.ra, ps1000.dec);
check(
  sepSidewaysDeg >= 2.85 && sepSidewaysDeg <= 2.92,
  `Barnard sideways-only 1000-yr shift in 2.85..2.92 deg (got ${sepSidewaysDeg})`
);

// 2. SIDEWAYS_ONLY 10 pc trust limit
const sideways10pc = {
  ra: 180.0,
  dec: 0.0,
  parallax: 100.0,
  parallax_error: 1.0,
  pmra: 50.0,
  pmra_error: 0.001,
  pmdec: 0.0,
  pmdec_error: 0.001,
  rv: null,
};
check(classifyMotion(sideways10pc) === "SIDEWAYS_ONLY", "10 pc star without RV is SIDEWAYS_ONLY");
const tTrust10pc = trustLimitYears(sideways10pc);
check(tTrust10pc >= 19000 && tTrust10pc <= 20100, `10 pc SIDEWAYS_ONLY t_trust in 19000..20100 yr (got ${tTrust10pc})`);

// 3. STATIC classification and uncertain/approximate states
const staticStar = {
  ra: 12.0,
  dec: -10.0,
  parallax: 1.0,
  parallax_error: 0.9,
  pmra: 1.0,
  pmra_error: 1.0,
  pmdec: 1.0,
  pmdec_error: 1.0,
};
check(classifyMotion(staticStar) === "STATIC", "Low pm SNR star is STATIC");

const unc = propagateStar(sideways10pc, tTrust10pc * 1.5);
check(unc.state === "uncertain" && unc.alpha >= DEFAULT_CFG.fade_floor, "Past t_trust is uncertain with alpha >= fade_floor");

const approx = propagateStar(BARNARD, 1.5e6);
check(approx.state === "approximate" && approx.alpha === DEFAULT_CFG.fade_floor, "Beyond 1e6 yr is approximate");

// 4. Kepler quarter orbit & Earth ephemeris sanity
const circ = { a: 1.0, e: 0.0, i: 0.0, om: 0.0, w: 0.0, ma: 0.0, epoch_jd: 2460000.5 };
const r0 = asteroidHelioEcl(circ, 2460000.5);
check(Math.hypot(r0[0] - 1, r0[1], r0[2]) < 1e-6, "Kepler circular orbit at epoch is (1,0,0)");
const rq = asteroidHelioEcl(circ, 2460000.5 + 365.2568983 / 4.0);
check(Math.hypot(rq[0], rq[1] - 1, rq[2]) < 1e-6, "Kepler circular orbit at quarter period is (0,1,0)");

const earthEq = earthHelioEqAU(2451545.0);
const earthR = Math.hypot(earthEq[0], earthEq[1], earthEq[2]);
check(earthR > 0.98 && earthR < 1.02, `Earth heliocentric distance ~1 AU (got ${earthR})`);

// 5. Slider mapping round-trip & endpoints
check(sliderToYears(0) === 0 && yearsToSlider(0) === 0, "Slider zero mapping");
check(Math.abs(sliderToYears(1000) - (1e6 - 1)) < 1e-6, "Slider +1000 -> ~1e6 yr");
check(Math.abs(sliderToYears(-1000) + (1e6 - 1)) < 1e-6, "Slider -1000 -> ~-1e6 yr");
for (const v of [-750, -250, -10, 10, 250, 750]) {
  const rt = yearsToSlider(sliderToYears(v));
  check(Math.abs(rt - v) < 1e-9, `Slider round-trip for ${v}`);
}
check(typeof formatYears(120) === "string" && formatYears(0) === "0 yr", "formatYears output");

// 6. Verify lod-app.js integration
const lodAppPath = path.resolve(__dirname, "../public/bin-lod/js/lod-app.js");
const lodAppSrc = fs.readFileSync(lodAppPath, "utf-8");
check(lodAppSrc.includes('get("spherex") === "1"'), 'lod-app.js checks get("spherex") === "1"');
check(!/^\s*import\s+.*spherex-motion\.js/m.test(lodAppSrc), "lod-app.js has no static import of spherex-motion.js");


// 7b. IR false-color helpers and rebuilt layer
const EXPECTED_CAPTION =
  "False color: SPHEREx sees infrared light, invisible to the eye. Blue = shorter infrared, red = longer.";
check(IR_COLOR_CAPTION === EXPECTED_CAPTION, "IR_COLOR_CAPTION matches caption.md general line");

const hotStar = {
  name: "Test Hot Star",
  ir_tag: "blue/hot",
  ir_hex: "#4a8cff",
  ir_rgb: [0.2902, 0.549, 1.0],
  ir_caption: "Brighter at shorter infrared wavelengths, the pattern of a hotter star.",
  gmag: 8.25,
  detections: [{}, {}],
};
const rgbHot = starDisplayColor(hotStar);
check(
  rgbHot[0] === 0.2902 && rgbHot[1] === 0.549 && rgbHot[2] === 1.0,
  "starDisplayColor uses ir_rgb for a colored tag"
);

const insufWithGray = {
  name: "Test Insufficient Star",
  ir_tag: "insufficient data",
  ir_hex: "#808080",
  ir_rgb: [0.502, 0.502, 0.502],
};
const rgbInsuf = starDisplayColor(insufWithGray);
check(
  rgbInsuf[0] === 1 && rgbInsuf[1] === 1 && rgbInsuf[2] === 1,
  "starDisplayColor ignores #808080 / gray on insufficient data and returns [1,1,1]"
);
const rgbNull = starDisplayColor({ ir_tag: "insufficient data", ir_hex: "#808080", ir_rgb: null });
check(
  rgbNull[0] === 1 && rgbNull[1] === 1 && rgbNull[2] === 1,
  "starDisplayColor returns [1,1,1] when ir_rgb is null"
);

const popupText = formatStarPopup(hotStar);
check(
  popupText.includes("Test Hot Star") && popupText.includes("blue/hot"),
  "formatStarPopup includes star name and ir_tag"
);
check(popupText.includes("G = 8.25 mag") && popupText.includes("2 SPHEREx det."), "formatStarPopup uses gmag, not phot_g_mean_mag");
check(!popupText.includes("phot_g_mean_mag"), "formatStarPopup does not mention phot_g_mean_mag");

// 7. Optional data layer check if barnard-field.json exists
const layerPath = path.resolve(__dirname, "../public/bin-lod/data/spherex/barnard-field.json");
if (fs.existsSync(layerPath)) {
  const layer = JSON.parse(fs.readFileSync(layerPath, "utf-8"));
  check(layer.schema_version === 1, "barnard-field.json schema_version === 1");
  const validClasses = new Set(["FULL_3D", "SIDEWAYS_ONLY", "STATIC"]);
  const allValid = (layer.stars || []).every((s) => validClasses.has(s.motion_class));
  check(allValid, "All stars in barnard-field.json have valid motion_class");
  check(layer.meta && layer.meta.ir_color_caption === EXPECTED_CAPTION, "layer.meta.ir_color_caption matches caption.md line");
  const knownSet = new Set(KNOWN_IR_TAGS);
  const allTagsValid = (layer.stars || []).every((s) => knownSet.has(s.ir_tag));
  check(allTagsValid, "every star in barnard-field.json has a valid ir_tag");
  const insufNullOk = (layer.stars || []).every((s) => {
    const noDet = !Array.isArray(s.detections) || s.detections.length === 0;
    if (s.ir_tag === "insufficient data" || noDet) return s.ir_rgb === null;
    return true;
  });
  check(insufNullOk, "insufficient data or empty-detection stars have ir_rgb === null");
  const coloredStars = (layer.stars || []).filter((s) => s.ir_tag && s.ir_tag !== "insufficient data");
  const coloredOk =
    coloredStars.length > 0 &&
    coloredStars.every(
      (s) =>
        typeof s.ir_hex === "string" &&
        /^#[0-9a-fA-F]{6}$/.test(s.ir_hex) &&
        s.ir_hex.toLowerCase() !== "#808080" &&
        Array.isArray(s.ir_rgb) &&
        s.ir_rgb.length === 3 &&
        s.ir_rgb.every((c) => typeof c === "number" && c >= 0 && c <= 1)
    );
  check(coloredOk, "colored stars have non-gray #rrggbb ir_hex and 3-vector ir_rgb in 0..1");
}


// 8. clampInsetLabel keeps the Barnard caption inside the inset
{
  const fit = clampInsetLabel(30, 40, 80, 10, 240, 240, 6, 16);
  check(fit.x === 30 && fit.y === 40, "Preferred label position that already fits is unchanged");

  const right = clampInsetLabel(180, 50, 90, 10, 240, 240, 6, 16);
  check(right.x === 180 - 5 - 90, "Right overflow moves the label left of the preferred point");
  check(right.x >= 6 && right.x + 90 <= 240 - 6, "Right-overflow label stays inside horizontal pad");
  check(right.y === 50, "Right overflow does not change y when y already fits");

  const top = clampInsetLabel(20, 8, 80, 10, 240, 240, 6, 16);
  check(top.y === 16 && top.y - 10 >= 6, "Top overflow is clamped so y-textHeight >= pad");

  const bottom = clampInsetLabel(20, 235, 80, 10, 240, 240, 6, 16);
  check(bottom.y === 240 - 16 && bottom.y <= 240 - 16, "Bottom label stays above the caption reserve");

  const long = clampInsetLabel(100, 140, 180, 10, 148, 148, 6, 16);
  check(long.x === 6, "180px label on a 148px inset is clamped to the left pad");
  check(long.x + 180 <= 148 - 6 || long.x === 6, "Long label starts at pad when wider than the inset");
  check(long.y - 10 >= 6 && long.y <= 148 - 16, "Long label stays inside the vertical box");
}


const spherexSrc = fs.readFileSync(path.resolve(__dirname, "../public/bin-lod/js/spherex-motion.js"), "utf-8");
check(spherexSrc.includes("starDisplayColor("), "spherex-motion.js uses starDisplayColor");
check(spherexSrc.includes("spherex-ir-caption"), "spherex-motion.js renders the IR caption in the chip");
check(spherexSrc.includes("spherex-star-popup"), "spherex-motion.js defines #spherex-star-popup");
check(!spherexSrc.includes("renderer.domElement.addEventListener"), "spherex-motion.js does not hook the main canvas (free-fly click-to-pivot)");
check(!spherexSrc.includes("phot_g_mean_mag"), "spherex-motion.js does not use phot_g_mean_mag");
const cssSrc = fs.readFileSync(path.resolve(__dirname, "../public/bin-lod/css/styles.css"), "utf-8");
check(/#spherex-inset[\s\S]*?pointer-events:\s*auto/.test(cssSrc), "#spherex-inset allows pointer events for inset clicks");

console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
