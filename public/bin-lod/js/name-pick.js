/**
 * Pure nearest-neighbor pick in 2D screen space.
 * @param {Array<{name: string, sx: number, sy: number}>} cands
 * @param {number} x
 * @param {number} y
 * @param {number} [maxPx=12]
 */
export function pickNearest(cands, x, y, maxPx = 12) {
  if (!Array.isArray(cands) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const maxD2 = maxPx * maxPx;
  let best = null;
  let bestD2 = Infinity;

  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    if (!c || typeof c.name !== "string" || c.name.length === 0) continue;
    if (!Number.isFinite(c.sx) || !Number.isFinite(c.sy)) continue;
    const dx = c.sx - x;
    const dy = c.sy - y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= maxD2 && d2 < bestD2) {
      bestD2 = d2;
      best = c;
    }
  }
  return best;
}

/**
 * Installs hover and click-to-pin tooltip picking for named stars.
 */
export function installNamePick({ canvas, canvasWrap, getCandidates, overlayHit, escapeHtml }) {
  const esc = typeof escapeHtml === "function"
    ? escapeHtml
    : (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const tip = document.createElement("div");
  tip.id = "name-tip";
  tip.className = "overlay-tip name-tip";
  tip.hidden = true;
  tip.setAttribute("role", "tooltip");
  canvasWrap.appendChild(tip);

  let pinned = null; // { key, name } | null
  let downX = 0;
  let downY = 0;
  let downValid = false;
  let lastPointerType = "mouse";

  function placeTip(sx, sy, name) {
    tip.innerHTML = `<strong>${esc(name)}</strong>`;
    tip.hidden = false;

    const wrapW = canvasWrap.clientWidth || 0;
    const wrapH = canvasWrap.clientHeight || 0;
    const tipW = tip.offsetWidth || 0;
    const tipH = tip.offsetHeight || 0;
    const pad = 4;
    const off = 14;

    let left = sx + off;
    let top = sy + off;
    if (wrapW > 0 && left + tipW + pad > wrapW) left = sx - off - tipW;
    if (wrapH > 0 && top + tipH + pad > wrapH) top = sy - off - tipH;
    if (wrapW > 0) left = Math.max(pad, Math.min(wrapW - tipW - pad, left));
    if (wrapH > 0) top = Math.max(pad, Math.min(wrapH - tipH - pad, top));

    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  function showPinnedOrHide() {
    if (!pinned) {
      tip.hidden = true;
      return;
    }
    const cands = getCandidates() || [];
    const match = cands.find((c) => c && c.key === pinned.key && Number.isFinite(c.sx) && Number.isFinite(c.sy));
    if (match) {
      placeTip(match.sx, match.sy, pinned.name);
    } else {
      tip.hidden = true;
    }
  }

  function unpin() {
    pinned = null;
    tip.hidden = true;
  }

  function pickAt(x, y, maxPx = 12) {
    return pickNearest(getCandidates() || [], x, y, maxPx);
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    downX = e.clientX;
    downY = e.clientY;
    downValid = true;
    lastPointerType = e.pointerType || "mouse";
  });

  canvas.addEventListener("pointermove", (e) => {
    if (e.buttons !== 0 || e.pointerType === "touch") return;
    if (overlayHit && overlayHit(e.clientX, e.clientY)) {
      showPinnedOrHide();
      return;
    }
    const rect = canvasWrap.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const hit = pickAt(x, y, 12);
    if (hit) {
      placeTip(hit.sx, hit.sy, hit.name);
    } else {
      showPinnedOrHide();
    }
  });

  canvas.addEventListener("pointerleave", () => {
    showPinnedOrHide();
  });

  canvas.addEventListener("click", (e) => {
    if (e.button !== 0) return;
    if (downValid) {
      const dx = e.clientX - downX;
      const dy = e.clientY - downY;
      downValid = false;
      if (dx * dx + dy * dy > 25) return; // dragged > 5 px
    }
    if (overlayHit && overlayHit(e.clientX, e.clientY)) {
      unpin();
      return;
    }
    const rect = canvasWrap.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const maxPx = lastPointerType === "touch" ? 22 : 12;
    const hit = pickAt(x, y, maxPx);
    if (hit) {
      pinned = { key: hit.key, name: hit.name };
      placeTip(hit.sx, hit.sy, hit.name);
    } else {
      unpin();
    }
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") unpin();
  });

  function update() {
    if (pinned) showPinnedOrHide();
  }

  function state() {
    return {
      pinned: pinned ? pinned.name : null,
      shown: !tip.hidden,
      text: tip.textContent || "",
    };
  }

  return { update, pickAt, state, unpin };
}
