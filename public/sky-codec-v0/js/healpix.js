// HEALPix nest ang2pix. Replace this function if the tile key changes.
// Same arithmetic as tools/healpix.py.

function spread(v) {
  let x = 0;
  let i = 0;
  let n = v;
  while (n > 0) {
    if (n & 1) x += 2 ** (2 * i);
    n = Math.floor(n / 2);
    i += 1;
  }
  return x;
}

export function xyzToThetaPhi(x, y, z) {
  const r = Math.hypot(x, y, z);
  if (r === 0) return { theta: 0, phi: 0 };
  let zOverR = z / r;
  if (zOverR > 1) zOverR = 1;
  else if (zOverR < -1) zOverR = -1;
  const dec = Math.asin(zOverR);
  const ra = ((Math.atan2(y, x) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  return { theta: Math.PI / 2 - dec, phi: ra };
}

export function ang2pixNest(nside, theta, phi) {
  const z = Math.cos(theta);
  const za = Math.abs(z);
  let p = phi % (Math.PI * 2);
  if (p < 0) p += Math.PI * 2;
  let tt = p / (Math.PI * 0.5);
  if (tt >= 4) tt = 0;
  let face;
  let ix;
  let iy;
  if (za <= 2 / 3) {
    const temp1 = nside * (0.5 + tt);
    const temp2 = nside * z * 0.75;
    const jp = Math.floor(temp1 - temp2);
    const jm = Math.floor(temp1 + temp2);
    const ifp = Math.floor(jp / nside);
    const ifm = Math.floor(jm / nside);
    if (ifp === ifm) face = (ifp % 4) + 4;
    else if (ifp < ifm) face = ifp;
    else face = ifm + 8;
    ix = jm % nside;
    iy = nside - (jp % nside) - 1;
  } else {
    const ntt = Math.floor(tt);
    const tp = tt - ntt;
    const tmp = nside * Math.sqrt(3 * (1 - za));
    let jp = Math.floor(tp * tmp);
    let jm = Math.floor((1 - tp) * tmp);
    if (jp > nside - 1) jp = nside - 1;
    if (jm > nside - 1) jm = nside - 1;
    if (z >= 0) {
      face = ntt;
      ix = nside - jm - 1;
      iy = nside - jp - 1;
    } else {
      face = ntt + 8;
      ix = jp;
      iy = jm;
    }
  }
  return face * nside * nside + spread(ix) + spread(iy) * 2;
}
