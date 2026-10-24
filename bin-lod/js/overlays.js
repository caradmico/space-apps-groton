/**
 * Optional FRB and exoplanet host markers for the BIN LOD viewer.
 *
 * Loaded only after a checkbox is turned on, and only once the star tiles
 * have finished. Positions use the same RA/Dec frame as readStar():
 *   x = cos(dec) cos(ra) * d
 *   y = cos(dec) sin(ra) * d
 *   z = sin(dec) * d
 * d is dist_pc for an exoplanet host, otherwise the sky-sphere radius.
 */

import * as THREE from "three";

const DEG2RAD = Math.PI / 180;

const vertexShader = /* glsl */ `
  attribute float aSize;
  attribute float aKind;
  varying vec3 vColor;
  varying float vKind;
  void main() {
    vColor = color;
    vKind = aKind;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(aSize * (96.0 / max(-mvPosition.z, 0.35)), 2.5, 22.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vKind;
  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv);
    if (d > 0.5) discard;
    float disk = smoothstep(0.5, 0.1, d);
    float ring = smoothstep(0.5, 0.4, d) * smoothstep(0.2, 0.3, d);
    float alpha = mix(disk, max(disk, ring), step(0.5, vKind));
    if (alpha < 0.04) discard;
    gl_FragColor = vec4(vColor, alpha);
  }
`;

function makeOverlayPoints(pos, col, size, kind, count) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
  geo.setAttribute("aKind", new THREE.BufferAttribute(kind, 1));
  geo.setDrawRange(0, count);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const points = new THREE.Points(geo, material);
  points.frustumCulled = false;
  points.renderOrder = 4;
  points.visible = false;
  return points;
}

function radec(raDeg, decDeg, dist) {
  const ra = raDeg * DEG2RAD;
  const dec = decDeg * DEG2RAD;
  const cosDec = Math.cos(dec);
  const ux = cosDec * Math.cos(ra);
  const uy = cosDec * Math.sin(ra);
  const uz = Math.sin(dec);
  return { x: ux * dist, y: uy * dist, z: uz * dist };
}

function fmt(value, digits) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function fmtDec(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const body = Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 4 });
  return (n >= 0 ? "+" : "−") + body;
}

export function installOverlays(deps) {
  const skyRadius = deps.skyRadius;
  const layers = {
    frb: {
      id: "frb",
      url: "overlays/frb.json",
      label: "FRBs",
      wanted: false,
      loading: false,
      items: null,
      points: null,
      count: 0,
      repeaters: 0,
      sky: 0,
      planets: 0,
      task: null,
    },
    exo: {
      id: "exo",
      url: "overlays/exoplanets.json",
      label: "Exoplanet hosts",
      wanted: false,
      loading: false,
      items: null,
      points: null,
      count: 0,
      repeaters: 0,
      sky: 0,
      planets: 0,
      task: null,
    },
  };

  const ctx = { scene: null, camera: null, renderer: null };
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const projectVec = new THREE.Vector3();
  let pointersBound = false;
  let pinned = null;
  let pinX = 0;
  let pinY = 0;
  let tipItem = null;
  let overlayError = "";

  const tip = document.createElement("div");
  tip.id = "overlay-tip";
  tip.className = "overlay-tip";
  tip.hidden = true;
  tip.setAttribute("role", "tooltip");
  deps.canvasWrap.appendChild(tip);

  function drawn(layer) {
    if (!layer.points || !layer.points.visible) return 0;
    return layer.points.geometry.drawRange.count;
  }

  function build(layer, rows) {
    const n = rows.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const kind = new Float32Array(n);
    const items = [];
    layer.repeaters = 0;
    layer.sky = 0;
    layer.planets = 0;
    let w = 0;
    for (let i = 0; i < n; i++) {
      const row = rows[i];
      const ra = Number(row.ra_deg);
      const dec = Number(row.dec_deg);
      if (!Number.isFinite(ra) || !Number.isFinite(dec)) continue;
      let dist = skyRadius;
      let onSky = true;
      if (layer.id === "exo") {
        const pc = row.dist_pc == null ? NaN : Number(row.dist_pc);
        if (Number.isFinite(pc) && pc > 0) {
          dist = pc;
          onSky = false;
        } else {
          layer.sky += 1;
        }
      }
      const p = radec(ra, dec, dist);
      const o = w * 3;
      pos[o] = p.x;
      pos[o + 1] = p.y;
      pos[o + 2] = p.z;
      if (layer.id === "frb") {
        const repeater = typeof row.repeater === "string" && row.repeater ? row.repeater : null;
        if (repeater) {
          layer.repeaters += 1;
          col[o] = 1;
          col[o + 1] = 0.42;
          col[o + 2] = 0.95;
          size[w] = 8;
          kind[w] = 1;
        } else {
          col[o] = 0.35;
          col[o + 1] = 0.95;
          col[o + 2] = 1;
          size[w] = 5;
          kind[w] = 0;
        }
        items.push({
          layer: "frb",
          name: String(row.name ?? ""),
          ra,
          dec,
          x: p.x,
          y: p.y,
          z: p.z,
          dm: row.dm,
          snr: row.snr,
          repeater,
        });
      } else {
        const planets = Array.isArray(row.planets) ? row.planets : [];
        layer.planets += planets.length;
        col[o] = 1;
        col[o + 1] = 0.74;
        col[o + 2] = 0.28;
        size[w] = 5.5;
        kind[w] = 0;
        items.push({
          layer: "exo",
          name: String(row.host ?? ""),
          ra,
          dec,
          x: p.x,
          y: p.y,
          z: p.z,
          dist: onSky ? null : dist,
          onSky,
          planets,
        });
      }
      w += 1;
    }
    layer.count = w;
    layer.items = items;
    const posA = w === n ? pos : pos.slice(0, w * 3);
    const colA = w === n ? col : col.slice(0, w * 3);
    const sizeA = w === n ? size : size.slice(0, w);
    const kindA = w === n ? kind : kind.slice(0, w);
    layer.points = makeOverlayPoints(posA, colA, sizeA, kindA, w);
  }

  function load(layer) {
    if (layer.items) return Promise.resolve(layer);
    if (layer.task) return layer.task;
    const task = (async () => {
      layer.loading = true;
      deps.updateHud();
      try {
        const res = await fetch(layer.url);
        if (!res.ok) throw new Error(`${layer.url} ${res.status}`);
        const rows = await res.json();
        if (!Array.isArray(rows)) throw new Error(`${layer.url} is not a list`);
        build(layer, rows);
        return layer;
      } finally {
        layer.loading = false;
      }
    })();
    layer.task = task;
    task.catch(() => {
      if (layer.task === task) layer.task = null;
    });
    return task;
  }

  function bumpFar() {
    const camera = ctx.camera;
    if (!camera) return;
    if (camera.far < 100000) {
      camera.far = 100000;
      camera.updateProjectionMatrix();
    }
  }

  function hideTip() {
    tip.hidden = true;
    tip.innerHTML = "";
    tipItem = null;
  }

  function clearTip(id) {
    if (pinned && pinned.layer === id) pinned = null;
    if (tipItem && tipItem.layer === id) hideTip();
  }

  function planetLine(planet) {
    const bits = [];
    if (planet.rade != null && Number.isFinite(Number(planet.rade))) bits.push(`${fmt(planet.rade, 2)} R⊕`);
    if (planet.orbper != null && Number.isFinite(Number(planet.orbper))) bits.push(`${fmt(planet.orbper, 2)} d`);
    if (planet.disc_year != null && Number.isFinite(Number(planet.disc_year))) bits.push(String(planet.disc_year));
    const name = deps.escapeHtml(planet.name ?? "");
    return bits.length ? `${name} — ${bits.join(" · ")}` : name;
  }

  function tipHtml(item) {
    const sky = `<div class="tip-meta">RA ${fmt(item.ra, 4)}° · Dec ${fmtDec(item.dec)}°</div>`;
    if (item.layer === "frb") {
      const rep = item.repeater
        ? `<div class="tip-repeater">Repeater${item.repeater !== item.name ? ` · ${deps.escapeHtml(item.repeater)}` : ""}</div>`
        : `<div class="tip-meta">Single burst</div>`;
      return (
        `<strong>${deps.escapeHtml(item.name)}</strong>${sky}` +
        `<div class="tip-meta">DM ${fmt(item.dm, 2)} pc cm⁻³ · SNR ${fmt(item.snr, 2)}</div>${rep}`
      );
    }
    const dist = item.onSky ? "Distance unknown · sky sphere" : `${fmt(item.dist, 2)} pc`;
    const n = item.planets.length;
    const list = item.planets.map((planet) => `<li>${planetLine(planet)}</li>`).join("");
    return (
      `<strong>${deps.escapeHtml(item.name)}</strong>${sky}` +
      `<div class="tip-meta">${dist} · ${n} confirmed planet${n === 1 ? "" : "s"}</div>` +
      (list ? `<ul>${list}</ul>` : "")
    );
  }

  function showTip(item, clientX, clientY) {
    tipItem = item;
    tip.hidden = false;
    tip.innerHTML = tipHtml(item);
    const rect = deps.canvasWrap.getBoundingClientRect();
    let x = clientX - rect.left + 14;
    let y = clientY - rect.top + 14;
    tip.style.left = "0px";
    tip.style.top = "0px";
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    if (x + tw > rect.width - 8) x = Math.max(8, clientX - rect.left - tw - 14);
    if (y + th > rect.height - 8) y = Math.max(8, clientY - rect.top - th - 14);
    tip.style.left = `${Math.round(x)}px`;
    tip.style.top = `${Math.round(y)}px`;
  }

  function pick(clientX, clientY) {
    const camera = ctx.camera;
    const canvas = ctx.renderer && ctx.renderer.domElement;
    if (!camera || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(pointer, camera);
    const origin = raycaster.ray.origin;
    const dir = raycaster.ray.direction;
    const pxScale = rect.height / (2 * Math.tan((camera.fov * DEG2RAD) / 2));
    let best = null;
    let bestPx = 18;
    for (const layer of [layers.frb, layers.exo]) {
      if (!layer.points || !layer.points.visible || !layer.items) continue;
      const items = layer.items;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const vx = item.x - origin.x;
        const vy = item.y - origin.y;
        const vz = item.z - origin.z;
        const along = vx * dir.x + vy * dir.y + vz * dir.z;
        if (along <= camera.near || along >= camera.far) continue;
        const perp2 = vx * vx + vy * vy + vz * vz - along * along;
        const px = (Math.sqrt(Math.max(0, perp2)) / along) * pxScale;
        if (px < bestPx) {
          bestPx = px;
          best = item;
        }
      }
    }
    return best;
  }

  function bindPointers() {
    if (pointersBound || !ctx.renderer) return;
    pointersBound = true;
    const canvas = ctx.renderer.domElement;
    let downX = 0;
    let downY = 0;
    let moved = false;
    let pressed = false;
    canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      downX = event.clientX;
      downY = event.clientY;
      moved = false;
      pressed = true;
    });
    canvas.addEventListener("pointermove", (event) => {
      if ((event.buttons & 1) && Math.hypot(event.clientX - downX, event.clientY - downY) > 5) moved = true;
      if (moved && (event.buttons & 1)) return;
      const hit = pick(event.clientX, event.clientY);
      if (hit) showTip(hit, event.clientX, event.clientY);
      else if (!pinned) hideTip();
    });
    canvas.addEventListener("click", (event) => {
      if (event.button !== 0) return;
      const drag = pressed && (moved || Math.hypot(event.clientX - downX, event.clientY - downY) > 5);
      moved = false;
      pressed = false;
      if (drag) return;
      const hit = pick(event.clientX, event.clientY);
      if (hit) {
        pinned = hit;
        pinX = event.clientX;
        pinY = event.clientY;
        showTip(hit, event.clientX, event.clientY);
      } else {
        pinned = null;
        hideTip();
      }
    });
    canvas.addEventListener("pointerleave", () => {
      if (pinned) showTip(pinned, pinX, pinY);
      else hideTip();
    });
  }

  function attach(scene, camera, renderer) {
    ctx.scene = scene;
    ctx.camera = camera;
    ctx.renderer = renderer;
    bindPointers();
    for (const layer of [layers.frb, layers.exo]) {
      if (layer.points && !layer.points.parent) scene.add(layer.points);
    }
  }

  async function setEnabled(id, on) {
    const layer = layers[id];
    if (!layer) throw new Error(`unknown overlay ${id}`);
    layer.wanted = Boolean(on);
    overlayError = "";
    if (!layer.wanted) {
      if (layer.points) layer.points.visible = false;
      clearTip(layer.id);
      deps.updateHud();
      return 0;
    }
    try {
      await load(layer);
    } catch (err) {
      overlayError = err && err.message ? err.message : String(err);
      deps.updateHud();
      throw err;
    }
    if (!layer.wanted) {
      if (layer.points) layer.points.visible = false;
      deps.updateHud();
      return 0;
    }
    if (!ctx.scene || !layer.points) throw new Error("viewer is not ready for overlays");
    if (!layer.points.parent) ctx.scene.add(layer.points);
    layer.points.visible = true;
    if (layer.id === "exo") bumpFar();
    deps.updateHud();
    return drawn(layer);
  }

  function hudNote() {
    const parts = [];
    if (layers.frb.loading) parts.push("Loading FRBs…");
    else if (drawn(layers.frb) > 0) {
      parts.push(
        `FRBs ${layers.frb.count.toLocaleString()} on the sky sphere (${layers.frb.repeaters.toLocaleString()} repeaters)`
      );
    }
    if (layers.exo.loading) parts.push("Loading exoplanet hosts…");
    else if (drawn(layers.exo) > 0) {
      const sky = layers.exo.sky ? `, ${layers.exo.sky.toLocaleString()} without a distance on the sky sphere` : "";
      parts.push(`Exoplanet hosts ${layers.exo.count.toLocaleString()}${sky}`);
    }
    if (overlayError) parts.push(deps.escapeHtml(overlayError));
    return parts.length ? `<br>${parts.join("<br>")}` : "";
  }

  function project(id, index) {
    const layer = layers[id];
    const item = layer && layer.items && layer.items[index];
    if (!item || !ctx.camera || !ctx.renderer) return null;
    const rect = ctx.renderer.domElement.getBoundingClientRect();
    projectVec.set(item.x, item.y, item.z).project(ctx.camera);
    const geo = layer.points.geometry;
    return {
      name: item.name,
      index,
      x: item.x,
      y: item.y,
      z: item.z,
      r: Math.hypot(item.x, item.y, item.z),
      onSky: item.layer === "frb" ? true : !!item.onSky,
      dist: item.dist ?? null,
      repeater: item.repeater ?? null,
      kind: geo.getAttribute("aKind").getX(index),
      size: geo.getAttribute("aSize").getX(index),
      ndcZ: projectVec.z,
      clientX: rect.left + ((projectVec.x + 1) / 2) * rect.width,
      clientY: rect.top + ((1 - projectVec.y) / 2) * rect.height,
    };
  }

  function snapshot() {
    return {
      frbDrawn: drawn(layers.frb),
      exoDrawn: drawn(layers.exo),
      frbLoaded: !!layers.frb.items,
      exoLoaded: !!layers.exo.items,
      frbCount: layers.frb.count,
      exoCount: layers.exo.count,
      frbRepeaters: layers.frb.repeaters,
      exoSky: layers.exo.sky,
      exoPlanets: layers.exo.planets,
    };
  }

  return { attach, setEnabled, hudNote, project, snapshot };
}
