export const MAX_BODIES = 4;
export const FLY_SECONDS = 4;

export const RECIPES = {
  1: { name: "G-star", kind: 0 },
  2: { name: "gas-giant", kind: 1 },
};

export const DEMO_SYSTEM = [
  { type: 1, colorOrTempK: 5800, radius: 1.0, seed: 7, haze: 0.6, dbLum: 1.0, offset: [0, 0, 0] },
  { type: 2, colorOrTempK: [0.85, 0.72, 0.52], radius: 0.35, seed: 3, haze: 0.2, dbLum: 0.0, offset: [6, 0, 0] },
];

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function pwGauss(x, mu, s1, s2) {
  const t = (x - mu) / (x < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
}

// Blackbody color temperature -> LINEAR sRGB normalized to max channel = 1.
// Integrates Planck B(lambda, T) over 380..780 nm against the analytic CIE 1931
// 2-deg CMF multi-lobe fit of Wyman, Sloan & Shirley 2013 (JCGT 2(2)).
export function tempToRGB(k) {
  const T = clamp(k, 1000, 40000);
  const c2 = 1.438776877e-2;
  let X = 0, Y = 0, Z = 0;
  for (let l = 380; l <= 780; l += 1) {
    const lm = l * 1e-9;
    const B = 1 / (Math.pow(lm, 5) * (Math.exp(c2 / (lm * T)) - 1));
    const xbar = 1.056 * pwGauss(l, 599.8, 37.9, 31.0) + 0.362 * pwGauss(l, 442.0, 16.0, 26.7) - 0.065 * pwGauss(l, 501.1, 20.4, 26.2);
    const ybar = 0.821 * pwGauss(l, 568.8, 46.9, 40.5) + 0.286 * pwGauss(l, 530.9, 16.3, 31.1);
    const zbar = 1.217 * pwGauss(l, 437.0, 11.8, 36.0) + 0.681 * pwGauss(l, 459.0, 26.0, 13.8);
    X += B * xbar;
    Y += B * ybar;
    Z += B * zbar;
  }
  const r = Math.max(0,  3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z);
  const g = Math.max(0, -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z);
  const b = Math.max(0,  0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z);
  const m = Math.max(r, g, b, 1e-20);
  return [r / m, g / m, b / m];
}

export function closeupWeight(fraction, f0 = 0.02, f1 = 0.06) {
  const t = clamp((fraction - f0) / (f1 - f0), 0, 1);
  return t * t * (3 - 2 * t);
}

function discSolidAngle(d, radius) {
  if (d <= radius) return 2 * Math.PI;
  const sinT = radius / d;
  const cosT = Math.sqrt(Math.max(0, 1 - sinT * sinT));
  return 2 * Math.PI * (1 - cosT);
}

// Exact near-field solid-angle integral of linear limb darkening I(mu) = 1 - limb*(1 - mu),
// where mu = sqrt(1 - sin^2(a)/s^2), s = radius/d, integrated over sky angle a in [0, asin(s)].
function discFluxFactor(d, radius, limb) {
  if (d <= radius) return 2 * Math.PI * (1 - limb) + limb * Math.PI;
  const s = radius / d;
  const c = Math.sqrt(Math.max(0, 1 - s * s));
  const omega = 2 * Math.PI * (1 - c);
  const J = Math.PI * (s - c * c * Math.log((1 + s) / c)) / s;
  return (1 - limb) * omega + limb * J;
}

export function discFlux({ S, d, radius, limb = 0.6 }) {
  return S * discFluxFactor(d, radius, limb);
}

// Handoff math: computes radiance S so that discFlux equals dbLum / d^2.
// Corona/haze is controlled by uHazeFrac (default 0) so total handoff flux is exact by default.
export function normalizeEmission({ dbLum, d, radius, limb = 0.6 }) {
  const targetFlux = dbLum / (d * d);
  const denom = discFluxFactor(d, radius, limb);
  return denom > 0 ? targetFlux / denom : 0;
}

function posArray(p) {
  return Array.isArray(p) ? [p[0], p[1], p[2]] : [p.x, p.y, p.z];
}

const DEFAULT_DIR_RAW = [1.2, 0.6, 4.3];
const DEFAULT_DIR_LEN = Math.hypot(DEFAULT_DIR_RAW[0], DEFAULT_DIR_RAW[1], DEFAULT_DIR_RAW[2]);
const DEFAULT_DIR = [
  DEFAULT_DIR_RAW[0] / DEFAULT_DIR_LEN,
  DEFAULT_DIR_RAW[1] / DEFAULT_DIR_LEN,
  DEFAULT_DIR_RAW[2] / DEFAULT_DIR_LEN,
];

export function frameBodies(bodies, fovDeg = 55, aspect = 1, margin = 1.15) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const pts = bodies.map((b) => {
    const p = posArray(b.position);
    const r = b.radius || 0;
    if (p[0] - r < minX) minX = p[0] - r;
    if (p[1] - r < minY) minY = p[1] - r;
    if (p[2] - r < minZ) minZ = p[2] - r;
    if (p[0] + r > maxX) maxX = p[0] + r;
    if (p[1] + r > maxY) maxY = p[1] + r;
    if (p[2] + r > maxZ) maxZ = p[2] + r;
    return { p, r };
  });

  const target = [0.5 * (minX + maxX), 0.5 * (minY + maxY), 0.5 * (minZ + maxZ)];
  let boundR = 1e-4;
  for (const { p, r } of pts) {
    const d = Math.hypot(p[0] - target[0], p[1] - target[1], p[2] - target[2]) + r;
    if (d > boundR) boundR = d;
  }

  const vHalf = ((fovDeg || 55) * Math.PI) / 360;
  const tanV = Math.max(1e-6, Math.tan(vHalf));
  const safeAspect = Math.max(1e-6, aspect || 1);
  const hHalf = Math.atan(tanV * safeAspect);
  const minHalfAngle = Math.max(1e-4, Math.min(vHalf, hHalf));
  const effR = boundR * Math.max(1, margin);
  const distance = effR / Math.sin(minHalfAngle);

  const dir = [DEFAULT_DIR[0], DEFAULT_DIR[1], DEFAULT_DIR[2]];
  const cameraPos = [
    target[0] + dir[0] * distance,
    target[1] + dir[1] * distance,
    target[2] + dir[2] * distance,
  ];
  return { target, distance, dir, cameraPos };
}

export function projectToNdc(point, cameraPos, target, fovDeg = 55, aspect = 1) {
  const pt = posArray(point);
  const cam = posArray(cameraPos);
  const tgt = posArray(target);

  let fx = tgt[0] - cam[0];
  let fy = tgt[1] - cam[1];
  let fz = tgt[2] - cam[2];
  const fLen = Math.hypot(fx, fy, fz) || 1;
  fx /= fLen; fy /= fLen; fz /= fLen;

  // right = normalize(cross(fwd, [0,1,0])) = normalize([-fz, 0, fx])
  let rx = -fz, ry = 0, rz = fx;
  const rLen = Math.hypot(rx, ry, rz) || 1;
  rx /= rLen; ry /= rLen; rz /= rLen;

  // up = cross(right, fwd)
  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;

  const vx = pt[0] - cam[0];
  const vy = pt[1] - cam[1];
  const vz = pt[2] - cam[2];

  const cx = vx * rx + vy * ry + vz * rz;
  const cy = vx * ux + vy * uy + vz * uz;
  const depth = vx * fx + vy * fy + vz * fz;

  const tanHalf = Math.tan(((fovDeg || 55) * Math.PI) / 360);
  const safeDepth = Math.max(1e-9, Math.abs(depth)) * (depth < 0 ? -1 : 1);
  const ndcX = cx / (safeDepth * tanHalf * (aspect || 1));
  const ndcY = cy / (safeDepth * tanHalf);
  return [ndcX, ndcY, depth];
}

export function lockedTarget(current, anchor, active, lockEnabled = true) {
  const cur = posArray(current);
  if (!active || !lockEnabled || !anchor) return cur;
  const a = posArray(anchor);
  return [a[0], a[1], a[2]];
}

export function flyStartDistance(radius, fovDeg = 55, viewportShortSidePx = 800, viewportHeightPx = 800, f0 = 0.02) {
  const tanHalf = Math.max(1e-6, Math.tan(((fovDeg || 55) * Math.PI) / 360));
  const h = Math.max(1, viewportHeightPx);
  const minHalf = Math.max(1, viewportShortSidePx * 0.5);
  const targetFrac = Math.max(1e-6, 0.5 * f0);
  // fraction = (radius / d) * (h / (2 * tanHalf)) / minHalf = targetFrac
  return (radius * h) / (2 * tanHalf * minHalf * targetFrac);
}

export function flyEase(t) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

export function flyInDistance(t, startDist, endDist) {
  const s = Math.max(1e-6, startDist);
  const e = Math.max(1e-6, endDist);
  const u = flyEase(t);
  if (u <= 0) return s;
  if (u >= 1) return e;
  return Math.exp(Math.log(s) * (1 - u) + Math.log(e) * u);
}

export function handoffMix(weight) {
  const w = clamp(weight, 0, 1);
  return { point: 1 - w, disc: w };
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

#define MAX_BODIES 4

uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;
uniform int uCount;
uniform int uSteps;
uniform int uKind[MAX_BODIES];
uniform vec3 uPos[MAX_BODIES];
uniform float uRadius[MAX_BODIES];
uniform float uHaze[MAX_BODIES];
uniform float uSeed[MAX_BODIES];
uniform vec3 uColor[MAX_BODIES];
uniform float uS[MAX_BODIES];
uniform float uLimb;
uniform float uHazeFrac;
uniform float uExposure;
uniform float uWeight;

vec3 tanhVec3(vec3 x) {
  vec3 c = clamp(x, -10.0, 10.0);
  vec3 e2x = exp(2.0 * c);
  return (e2x - 1.0) / (e2x + 1.0);
}

float hash3(vec3 p, float seed) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3) + seed * 0.173);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

vec2 raySphere(vec3 ro, vec3 rd, vec3 center, float r) {
  vec3 oc = ro - center;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - r * r;
  float h = b * b - c;
  if (h < 0.0) return vec2(1e20, -1e20);
  float s = sqrt(h);
  return vec2(-b - s, -b + s);
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(
    uCamFwd +
    ndc.x * uAspect * uTanHalfFov * uCamRight +
    ndc.y * uTanHalfFov * uCamUp
  );
  vec3 ro = uCamPos;

  float tHit = 1e20;
  int hitIdx = -1;

  for (int i = 0; i < MAX_BODIES; i++) {
    if (i >= uCount) break;
    vec2 hit = raySphere(ro, rd, uPos[i], uRadius[i]);
    if (hit.x > 0.0 && hit.x < tHit) {
      tHit = hit.x;
      hitIdx = i;
    }
  }

  vec3 acc = vec3(0.0);
  vec3 starPos = uPos[0];

  // Surface emission counted once at analytic hit
  if (hitIdx >= 0) {
    for (int i = 0; i < MAX_BODIES; i++) {
      if (i == hitIdx) {
        vec3 p = ro + rd * tHit;
        vec3 n = normalize(p - uPos[i]);
        float mu = clamp(dot(n, -rd), 0.0, 1.0);
        if (uKind[i] == 0) {
          float limbFactor = 1.0 - uLimb * (1.0 - mu);
          float gran = 0.94 + 0.12 * hash3(n * 14.0, uSeed[i]);
          acc += uColor[i] * (uS[i] * limbFactor * gran);
        } else {
          vec3 lDir = normalize(starPos - p);
          float diff = max(dot(n, lDir), 0.0);
          float bands = 0.5 + 0.5 * sin(n.y * 20.0 + uSeed[i] * 3.1 + 1.5 * sin(n.x * 5.0 + uSeed[i]));
          vec3 bandCol = mix(uColor[i] * 0.65, uColor[i] * 1.25, bands);
          acc += bandCol * diff * (0.25 * max(uS[0], 0.5));
        }
      }
    }
  }

  // Bounded raymarch inside each body's haze bounding sphere
  for (int i = 0; i < MAX_BODIES; i++) {
    if (i >= uCount) break;
    float r = uRadius[i];
    float hScale = max(uHaze[i] * r, 1e-4);
    float rBound = r + 3.0 * hScale;
    vec2 bHit = raySphere(ro, rd, uPos[i], rBound);
    float t0 = max(bHit.x, 0.0);
    float t1 = min(bHit.y, tHit);
    if (t1 <= t0) continue;

    float seg = t1 - t0;
    float freq = 3.0;
    float smallestFeature = hScale / freq;
    float dt = min(seg / float(uSteps), 0.25 * smallestFeature);
    dt = max(dt, 1e-4);

    float sum = 0.0;
    for (int s = 0; s < 64; s++) {
      if (s >= uSteps) break;
      float t = t0 + (float(s) + 0.5) * dt;
      if (t >= t1) break;
      vec3 p = ro + rd * t;
      float d = length(p - uPos[i]);
      if (d < r) continue;
      // Normalized radial density so integral over [r, rBound] is bounded ~ 1
      float rho = exp(-(d - r) / hScale) / hScale;
      float n = 0.85 + 0.3 * hash3((p - uPos[i]) / smallestFeature, uSeed[i]);
      sum += rho * n * dt;
    }

    if (uKind[i] == 0) {
      acc += uColor[i] * (uS[i] * uHazeFrac * sum);
    } else {
      vec3 pRim = ro + rd * (0.5 * (t0 + t1));
      float lit = max(0.15, dot(normalize(pRim - uPos[i]), normalize(starPos - uPos[i])));
      acc += uColor[i] * (0.15 * max(uS[0], 0.5) * lit * sum);
    }
  }

  vec3 col = tanhVec3(acc * uExposure) * uWeight;
  gl_FragColor = vec4(col, 0.0);
}
`;

export function attachCloseup({ THREE, scene, camera, renderer, controls }) {
  const params = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
  const scale = clamp(parseFloat(params.get("closeupScale")) || 0.5, 0.1, 1.0);
  const lockEnabled = params.get("closeupLock") !== "0";
  const flyEnabled = params.get("closeup") === "1" && params.get("closeupFly") !== "0";
  const isCoarse = typeof matchMedia === "function" && matchMedia("(pointer:coarse)").matches;
  const steps = isCoarse ? 32 : 48;

  const demoCenter = controls?.target ? controls.target.clone() : new THREE.Vector3();
  const bodies = DEMO_SYSTEM.map((b) => {
    const col = Array.isArray(b.colorOrTempK) ? b.colorOrTempK : tempToRGB(b.colorOrTempK);
    return {
      ...b,
      kind: RECIPES[b.type]?.kind ?? 0,
      color: new THREE.Color(col[0], col[1], col[2]),
      position: new THREE.Vector3().fromArray(b.offset).add(demoCenter),
    };
  });

  const size = new THREE.Vector2();
  renderer.getDrawingBufferSize(size);
  const initAspect = size.y > 0 ? size.x / size.y : camera.aspect || 1.0;
  const initFov = camera.fov || 55;
  let framed = frameBodies(bodies, initFov, initAspect);
  const anchorTargetVec = new THREE.Vector3().fromArray(framed.target);
  const anchorDirVec = new THREE.Vector3().fromArray(framed.dir);

  const star = bodies[0];
  const shortSidePx = Math.max(1, Math.min(size.x, size.y));
  const heightPx = Math.max(1, size.y);
  let startDist = Math.max(
    framed.distance,
    flyStartDistance(star.radius, initFov, shortSidePx, heightPx)
  );

  let flyT = flyEnabled ? 0 : 1;
  let flyDone = !flyEnabled;
  let lastTimeMs = typeof performance !== "undefined" ? performance.now() : Date.now();

  if (flyEnabled) {
    camera.position.copy(anchorTargetVec).addScaledVector(anchorDirVec, startDist);
    if (controls?.target) {
      controls.target.copy(anchorTargetVec);
      controls.update?.();
    } else {
      camera.lookAt(anchorTargetVec);
    }
  }

  const onControlsStart = () => {
    flyDone = true;
    state.flyDone = true;
  };
  if (controls && typeof controls.addEventListener === "function") {
    controls.addEventListener("start", onControlsStart);
  }

  // Far-view point sprite for the demo star so the point -> disc handoff is visible
  const spriteGeo = new THREE.BufferGeometry();
  const spritePositions = new Float32Array([star.position.x, star.position.y, star.position.z]);
  spriteGeo.setAttribute("position", new THREE.BufferAttribute(spritePositions, 3));
  const dpr = typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
  const spriteMat = new THREE.PointsMaterial({
    size: 6 * dpr,
    sizeAttenuation: false,
    color: star.color.clone(),
    transparent: true,
    opacity: 1.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
  });
  const spritePoints = new THREE.Points(spriteGeo, spriteMat);
  spritePoints.frustumCulled = false;
  const spriteScene = new THREE.Scene();
  spriteScene.add(spritePoints);

  // Optional HUD indicator
  let hudEl = null;
  let hudFrame = 0;
  const parentEl = renderer?.domElement?.parentElement;
  if (typeof document !== "undefined" && parentEl) {
    hudEl = document.createElement("div");
    hudEl.setAttribute("aria-hidden", "true");
    hudEl.style.cssText =
      "position:absolute;right:12px;top:12px;pointer-events:none;font:12px system-ui,sans-serif;color:#cde;background:rgba(8,12,20,0.55);padding:3px 7px;border-radius:4px;z-index:5;";
    hudEl.textContent = "Close-up: point 100% · disc 0%";
    parentEl.appendChild(hudEl);
  }

  const rtW = Math.max(1, Math.floor(size.x * scale));
  const rtH = Math.max(1, Math.floor(size.y * scale));

  const rt = new THREE.WebGLRenderTarget(rtW, rtH, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    stencilBuffer: false,
  });
  if ("colorSpace" in rt.texture && THREE.NoColorSpace !== undefined) {
    rt.texture.colorSpace = THREE.NoColorSpace;
  }

  const uKind = new Array(MAX_BODIES).fill(0);
  const uPos = Array.from({ length: MAX_BODIES }, () => new THREE.Vector3());
  const uRadius = new Array(MAX_BODIES).fill(1);
  const uHaze = new Array(MAX_BODIES).fill(0.1);
  const uSeed = new Array(MAX_BODIES).fill(1);
  const uColor = Array.from({ length: MAX_BODIES }, () => new THREE.Color(1, 1, 1));
  const uS = new Array(MAX_BODIES).fill(0);

  const uniforms = {
    uCamPos: { value: new THREE.Vector3() },
    uCamRight: { value: new THREE.Vector3(1, 0, 0) },
    uCamUp: { value: new THREE.Vector3(0, 1, 0) },
    uCamFwd: { value: new THREE.Vector3(0, 0, -1) },
    uTanHalfFov: { value: Math.tan(THREE.MathUtils.degToRad(50) * 0.5) },
    uAspect: { value: 1.0 },
    uCount: { value: bodies.length },
    uSteps: { value: steps },
    uKind: { value: uKind },
    uPos: { value: uPos },
    uRadius: { value: uRadius },
    uHaze: { value: uHaze },
    uSeed: { value: uSeed },
    uColor: { value: uColor },
    uS: { value: uS },
    uLimb: { value: 0.6 },
    uHazeFrac: { value: 0.0 },
    uExposure: { value: 1.8 },
    uWeight: { value: 0.0 },
  };

  const quadGeo = new THREE.PlaneGeometry(2, 2);
  const marchMat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
  });
  const marchScene = new THREE.Scene();
  const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const marchMesh = new THREE.Mesh(quadGeo, marchMat);
  marchMesh.frustumCulled = false;
  marchScene.add(marchMesh);

  const compMat = new THREE.MeshBasicMaterial({
    map: rt.texture,
    transparent: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    premultipliedAlpha: false,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
  });
  const compScene = new THREE.Scene();
  const compMesh = new THREE.Mesh(quadGeo, compMat);
  compMesh.frustumCulled = false;
  compScene.add(compMesh);

  const state = {
    weight: 0,
    fraction: 0,
    scale,
    steps,
    pointAlpha: 1,
    flyT,
    flyDone,
    relocks: 0,
    anchor: { target: framed.target.slice(), distance: framed.distance },
  };

  let lastAspect = initAspect;

  function render() {
    renderer.getDrawingBufferSize(size);
    const targetW = Math.max(1, Math.floor(size.x * scale));
    const targetH = Math.max(1, Math.floor(size.y * scale));
    if (rt.width !== targetW || rt.height !== targetH) {
      rt.setSize(targetW, targetH);
    }

    const fovDeg = camera.fov || 55;
    const aspect = size.y > 0 ? size.x / size.y : camera.aspect || 1.0;

    if (!flyDone && Math.abs(aspect - lastAspect) > 1e-4) {
      lastAspect = aspect;
      framed = frameBodies(bodies, fovDeg, aspect);
      anchorTargetVec.fromArray(framed.target);
      anchorDirVec.fromArray(framed.dir);
      state.anchor.target = framed.target.slice();
      state.anchor.distance = framed.distance;
    }

    const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
    const dt = clamp((nowMs - lastTimeMs) * 0.001, 0, 0.1);
    lastTimeMs = nowMs;

    if (!flyDone) {
      flyT = clamp(flyT + dt / FLY_SECONDS, 0, 1);
      const curDist = flyInDistance(flyT, startDist, framed.distance);
      camera.position.copy(anchorTargetVec).addScaledVector(anchorDirVec, curDist);
      if (controls?.target) {
        controls.target.copy(anchorTargetVec);
      } else {
        camera.lookAt(anchorTargetVec);
      }
      if (flyT >= 1) {
        flyDone = true;
      }
      state.flyT = flyT;
      state.flyDone = flyDone;
    }

    // Target lock: if host snapped controls.target away while closeup is active, restore anchor target
    const isActive = !flyDone || state.weight > 0;
    if (controls?.target && isActive && lockEnabled) {
      if (controls.target.distanceToSquared(anchorTargetVec) > 1e-12) {
        const nextTgt = lockedTarget(controls.target, framed.target, isActive, lockEnabled);
        controls.target.set(nextTgt[0], nextTgt[1], nextTgt[2]);
        state.relocks++;
      }
    }

    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    uniforms.uCamRight.value.set(e[0], e[1], e[2]).normalize();
    uniforms.uCamUp.value.set(e[4], e[5], e[6]).normalize();
    uniforms.uCamFwd.value.set(-e[8], -e[9], -e[10]).normalize();
    uniforms.uCamPos.value.set(e[12], e[13], e[14]);

    const fovRad = THREE.MathUtils.degToRad(fovDeg);
    uniforms.uTanHalfFov.value = Math.tan(fovRad * 0.5);
    uniforms.uAspect.value = aspect;

    const d = Math.max(1e-4, uniforms.uCamPos.value.distanceTo(star.position));
    const projRadiusPx = (star.radius / d) * (size.y / (2 * uniforms.uTanHalfFov.value));
    const minHalf = Math.max(1, Math.min(size.x, size.y) * 0.5);
    const fraction = projRadiusPx / minHalf;
    const weight = closeupWeight(fraction);
    const mix = handoffMix(weight);

    state.fraction = fraction;
    state.weight = weight;
    state.pointAlpha = mix.point;

    if (hudEl && (hudFrame++ % 6 === 0 || weight === 0 || weight === 1)) {
      hudEl.textContent = `Close-up: point ${Math.round(mix.point * 100)}% · disc ${Math.round(mix.disc * 100)}%`;
    }

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    if (mix.point >= 1e-3) {
      spriteMat.opacity = mix.point;
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = false;
      renderer.render(spriteScene, camera);
    }

    if (weight <= 0) {
      renderer.autoClear = prevAutoClear;
      return;
    }

    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      uKind[i] = b.kind;
      uPos[i].copy(b.position);
      uRadius[i] = b.radius;
      uHaze[i] = b.haze;
      uSeed[i] = b.seed;
      uColor[i].copy(b.color);
      const dist = Math.max(b.radius * 1.001, uniforms.uCamPos.value.distanceTo(b.position));
      uS[i] = b.dbLum > 0 ? normalizeEmission({ dbLum: b.dbLum, d: dist, radius: b.radius, limb: uniforms.uLimb.value }) : 0;
    }

    uniforms.uWeight.value = weight;

    renderer.setRenderTarget(rt);
    renderer.autoClear = true;
    renderer.render(marchScene, orthoCam);

    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = false;
    renderer.render(compScene, orthoCam);
    renderer.autoClear = prevAutoClear;
  }

  function dispose() {
    if (controls && typeof controls.removeEventListener === "function") {
      controls.removeEventListener("start", onControlsStart);
    }
    if (hudEl && hudEl.parentElement) {
      hudEl.parentElement.removeChild(hudEl);
    }
    rt.dispose();
    quadGeo.dispose();
    marchMat.dispose();
    compMat.dispose();
    spriteGeo.dispose();
    spriteMat.dispose();
  }

  const api = { render, dispose, state };
  if (typeof window !== "undefined" && params.has("debug")) {
    window.__closeup = api;
  }
  return api;
}
