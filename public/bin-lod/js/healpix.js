/**
 * Nested HEALPix, no build step.
 * Order-k cell of a Gaia source_id is source_id >> (59 - 2k).
 * pix2ang follows the HEALPix nest scheme (face, then z-order x/y).
 */

const JRLL = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4];
const JPLL = [1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7];

export function nside(order) {
  return 1 << order;
}

export function npix(order) {
  return 12 * (1 << (2 * order));
}

export function cellOfSource(sourceId, order) {
  const sid = BigInt(sourceId);
  return Number(sid >> BigInt(59 - 2 * order));
}

function deinterleave(ipf, order) {
  let ix = 0;
  let iy = 0;
  for (let bit = 0; bit < order; bit++) {
    ix |= (ipf & 1) << bit;
    ipf >>= 1;
    iy |= (ipf & 1) << bit;
    ipf >>= 1;
  }
  return [ix, iy];
}

function interleave(ix, iy, order) {
  let ipf = 0;
  for (let bit = 0; bit < order; bit++) {
    ipf |= ((ix >> bit) & 1) << (2 * bit);
    ipf |= ((iy >> bit) & 1) << (2 * bit + 1);
  }
  return ipf;
}

export function pix2angNest(order, ipix) {
  const ns = nside(order);
  const face = Math.floor(ipix / (ns * ns));
  const ipf = ipix - face * ns * ns;
  const [ix, iy] = deinterleave(ipf, order);
  const jr = JRLL[face] * ns - ix - iy - 1;
  let nr;
  let z;
  let kshift;
  if (jr < ns) {
    nr = jr;
    z = 1 - (nr * nr) / (3 * ns * ns);
    kshift = 0;
  } else if (jr > 3 * ns) {
    nr = 4 * ns - jr;
    z = (nr * nr) / (3 * ns * ns) - 1;
    kshift = 0;
  } else {
    nr = ns;
    z = ((2 * ns - jr) * 2) / (3 * ns);
    kshift = (jr - ns) & 1;
  }
  let jp = Math.floor((JPLL[face] * nr + ix - iy + 1 + kshift) / 2);
  const nphi = 4 * nr;
  if (jp > nphi) jp -= nphi;
  if (jp < 1) jp += nphi;
  const phi = (jp - (kshift + 1) * 0.5) * (Math.PI / (2 * nr));
  const theta = Math.acos(Math.max(-1, Math.min(1, z)));
  return { theta, phi };
}

export function pix2vecNest(order, ipix) {
  const { theta, phi } = pix2angNest(order, ipix);
  const st = Math.sin(theta);
  return [st * Math.cos(phi), st * Math.sin(phi), Math.cos(theta)];
}

export function ang2pixNest(order, theta, phi) {
  const ns = nside(order);
  const z = Math.cos(theta);
  const za = Math.abs(z);
  let ph = phi % (2 * Math.PI);
  if (ph < 0) ph += 2 * Math.PI;
  const tt = (ph / (Math.PI / 2)) % 4;
  let face;
  let ix;
  let iy;
  if (za <= 2 / 3) {
    const temp1 = ns * (0.5 + tt);
    const temp2 = ns * (z * 0.75);
    const jp = Math.floor(temp1 - temp2);
    const jm = Math.floor(temp1 + temp2);
    const ifp = Math.floor(jp / ns);
    const ifm = Math.floor(jm / ns);
    if (ifp === ifm) face = ifp | 4;
    else if (ifp < ifm) face = ifp;
    else face = ifm + 8;
    ix = jm & (ns - 1);
    iy = ns - (jp & (ns - 1)) - 1;
  } else {
    const ntt = Math.floor(tt);
    const tp = tt - ntt;
    const tmp = ns * Math.sqrt(3 * (1 - za));
    const jp = Math.floor(tp * tmp);
    const jm = Math.floor((1 - tp) * tmp);
    if (jp >= ns) {
      ix = ns - 1;
    } else {
      ix = jp;
    }
    if (jm >= ns) {
      iy = ns - 1;
    } else {
      iy = jm;
    }
    if (z >= 0) face = ntt;
    else face = ntt + 8;
    if (z < 0) {
      const swap = ix;
      ix = iy;
      iy = swap;
    }
  }
  if (ix < 0) ix = 0;
  if (iy < 0) iy = 0;
  if (ix >= ns) ix = ns - 1;
  if (iy >= ns) iy = ns - 1;
  return face * ns * ns + interleave(ix, iy, order);
}

export function children(cell) {
  const base = cell * 4;
  return [base, base + 1, base + 2, base + 3];
}

export function parent(cell) {
  return cell >> 2;
}
