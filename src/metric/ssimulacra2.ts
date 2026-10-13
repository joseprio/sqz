/**
 * SSIMULACRA2 (Jon Sneyers, libjxl): a perceptual similarity score where 100 means
 * identical and ~90 is visually lossless at 1:1. Port of the reference algorithm:
 * sRGB → linear → XYB, six scales, blurred SSIM plus edge-artifact/detail-loss maps,
 * combined with the published weights. Images with transparency are scored on a dark
 * and a light background and the worse score counts.
 *
 * The reference image's per-scale data is computed once, so scoring many candidates
 * against the same source (as a quality search does) only processes the candidate.
 */

const NUM_SCALES = 6;
const C2 = 0.0009;
const SIGMA = 1.5;

// prettier-ignore
const WEIGHTS = [
  0.0, 0.0007376606707406586, 0.0, 0.0, 0.0007793481682867309, 0.0, 0.0, 0.0004371155730107379, 0.0,
  1.1041726426657346, 0.00066284834129271, 0.00015231632783718752, 0.0, 0.0016406437456599754, 0.0,
  1.8422455520539298, 11.441172603757666, 0.0, 0.0007989109436015163, 0.000176816438078653, 0.0,
  1.8787594979546387, 10.94906990605142, 0.0, 0.0007289346991508072, 0.9677937080626833, 0.0,
  0.00014003424285435884, 0.9981766977854967, 0.00031949755934435053, 0.0004550992113792063, 0.0, 0.0,
  0.0013648766163243398, 0.0, 0.0, 0.0, 0.0, 0.0, 7.466890328078848, 0.0, 17.445833984131262,
  0.0006235601634041466, 0.0, 0.0, 6.683678146179332, 0.00037724407979611296, 1.027889937768264,
  225.20515300849274, 0.0, 0.0, 19.213238186143016, 0.0011401524586618361, 0.001237755635509985,
  176.39317598450694, 0.0, 0.0, 24.43300999870476, 0.28520802612117757, 0.0004485436923833408, 0.0, 0.0,
  0.0, 34.77906344483772, 44.835625328877896, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
  0.0008680556573291698, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0005313191874358747, 0.0, 0.00016533814161379112,
  0.0, 0.0, 0.0, 0.0, 0.0, 0.0004179171803251336, 0.0017290828234722833, 0.0, 0.0020827005846636437,
  0.0, 0.0, 8.826982764996862, 23.19243343998926, 0.0, 95.1080498811086, 0.9863978034400682,
  0.9834382792465353, 0.0012286405048278493, 171.2667255897307, 0.9807858872435379, 0.0, 0.0, 0.0,
  0.0005130064588990679, 0.0, 0.00010854057858411537,
];

// Opsin absorbance (libjxl opsin_params.h).
const M = [0.3, 0.622, 0.078, 0.23, 0.692, 0.078, 0.24342268924547819, 0.20476744424496821, 1 - 0.24342268924547819 - 0.20476744424496821];
const BIAS = 0.0037930732552754493;
const CBRT_BIAS = Math.cbrt(BIAS);

const SRGB_TO_LINEAR = new Float32Array(256).map((_, i) => {
  const v = i / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
});

type Planes = [Float32Array, Float32Array, Float32Array];

interface Level {
  w: number;
  h: number;
}

/** sRGB RGBA → linear RGB planes, compositing over `bg` (0..1) when alpha is present. */
function toLinear(rgba: Uint8Array, w: number, h: number, bg: number | null): Planes {
  const n = w * h;
  const p: Planes = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const bg255 = (bg ?? 0) * 255;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = rgba[j + 3];
    for (let c = 0; c < 3; c++) {
      if (bg === null || a === 255) p[c][i] = SRGB_TO_LINEAR[rgba[j + c]];
      else {
        const v = ((rgba[j + c] * a) / 255 + (bg255 * (255 - a)) / 255) / 255;
        p[c][i] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      }
    }
  }
  return p;
}

function downsample(src: Planes, w: number, h: number): { planes: Planes; w: number; h: number } {
  const ow = (w + 1) >> 1;
  const oh = (h + 1) >> 1;
  const out: Planes = [new Float32Array(ow * oh), new Float32Array(ow * oh), new Float32Array(ow * oh)];
  for (let c = 0; c < 3; c++) {
    const s = src[c];
    const o = out[c];
    for (let y = 0; y < oh; y++) {
      const y0 = y * 2;
      const y1 = Math.min(y0 + 1, h - 1);
      const ny = y1 - y0 + 1;
      for (let x = 0; x < ow; x++) {
        const x0 = x * 2;
        const x1 = Math.min(x0 + 1, w - 1);
        const nx = x1 - x0 + 1;
        let sum = s[y0 * w + x0];
        if (nx === 2) sum += s[y0 * w + x1];
        if (ny === 2) {
          sum += s[y1 * w + x0];
          if (nx === 2) sum += s[y1 * w + x1];
        }
        o[y * ow + x] = sum / (nx * ny);
      }
    }
  }
  return { planes: out, w: ow, h: oh };
}

/** Linear RGB → XYB, shifted positive the way SSIMULACRA2 does. */
function toXyb(lin: Planes): Planes {
  const n = lin[0].length;
  const out: Planes = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const [r, g, b] = lin;
  for (let i = 0; i < n; i++) {
    const l = Math.cbrt(Math.max(0, M[0] * r[i] + M[1] * g[i] + M[2] * b[i] + BIAS)) - CBRT_BIAS;
    const m = Math.cbrt(Math.max(0, M[3] * r[i] + M[4] * g[i] + M[5] * b[i] + BIAS)) - CBRT_BIAS;
    const s = Math.cbrt(Math.max(0, M[6] * r[i] + M[7] * g[i] + M[8] * b[i] + BIAS)) - CBRT_BIAS;
    const x = 0.5 * (l - m);
    const y = 0.5 * (l + m);
    out[0][i] = x * 14 + 0.42;
    out[1][i] = y + 0.01;
    out[2][i] = s - y + 0.55;
  }
  return out;
}

const KERNEL = (() => {
  const radius = Math.round(3.2795 * SIGMA + 0.2546);
  const k = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) sum += k[i + radius] = Math.exp(-(i * i) / (2 * SIGMA * SIGMA));
  return k.map((v) => v / sum);
})();
const R = (KERNEL.length - 1) >> 1;

/** Separable Gaussian blur; samples outside the image count as zero, like libjxl's recursive Gaussian. */
function blur(src: Float32Array, w: number, h: number, tmp: Float32Array, out: Float32Array) {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      const k0 = Math.max(-R, -x);
      const k1 = Math.min(R, w - 1 - x);
      for (let k = k0; k <= k1; k++) s += KERNEL[k + R] * src[row + x + k];
      tmp[row + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    const k0 = Math.max(-R, -y);
    const k1 = Math.min(R, h - 1 - y);
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = k0; k <= k1; k++) s += KERNEL[k + R] * tmp[(y + k) * w + x];
      out[y * w + x] = s;
    }
  }
}

interface RefScale {
  w: number;
  h: number;
  xyb: Planes;
  mu: Planes;
  sigmaSq: Planes;
}

function prepare(rgba: Uint8Array, w: number, h: number, bg: number | null): RefScale[] {
  let lin = toLinear(rgba, w, h, bg);
  let lw = w;
  let lh = h;
  const scales: RefScale[] = [];
  for (let s = 0; s < NUM_SCALES; s++) {
    // Like libjxl, the size check happens before downscaling, so the last level may be
    // smaller than 8 px; the weights are indexed by how many levels were computed.
    if (lw < 8 || lh < 8) break;
    if (s > 0) {
      const d = downsample(lin, lw, lh);
      lin = d.planes;
      lw = d.w;
      lh = d.h;
    }
    const xyb = toXyb(lin);
    const n = lw * lh;
    const tmp = new Float32Array(n);
    const mu = [0, 1, 2].map(() => new Float32Array(n)) as Planes;
    const sigmaSq = [0, 1, 2].map(() => new Float32Array(n)) as Planes;
    const sq = new Float32Array(n);
    for (let c = 0; c < 3; c++) {
      blur(xyb[c], lw, lh, tmp, mu[c]);
      for (let i = 0; i < n; i++) sq[i] = xyb[c][i] * xyb[c][i];
      blur(sq, lw, lh, tmp, sigmaSq[c]);
    }
    scales.push({ w: lw, h: lh, xyb, mu, sigmaSq });
  }
  return scales;
}

function compare(ref: RefScale[], rgba: Uint8Array, w: number, h: number, bg: number | null): number {
  let lin = toLinear(rgba, w, h, bg);
  let lw = w;
  let lh = h;
  let total = 0;
  let wi = 0;
  // Accumulate per channel × scale × norm in the reference order.
  const ssimParts: number[][] = [];
  const edgeParts: number[][] = [];
  ref.forEach((r, s) => {
    if (s > 0) {
      const d = downsample(lin, lw, lh);
      lin = d.planes;
      lw = d.w;
      lh = d.h;
    }
    const xyb = toXyb(lin);
    const n = lw * lh;
    const tmp = new Float32Array(n);
    const mu2 = new Float32Array(n);
    const s22 = new Float32Array(n);
    const s12 = new Float32Array(n);
    const prod = new Float32Array(n);
    const ssim: number[] = [];
    const edge: number[] = [];
    for (let c = 0; c < 3; c++) {
      const a = r.xyb[c];
      const b = xyb[c];
      blur(b, lw, lh, tmp, mu2);
      for (let i = 0; i < n; i++) prod[i] = b[i] * b[i];
      blur(prod, lw, lh, tmp, s22);
      for (let i = 0; i < n; i++) prod[i] = a[i] * b[i];
      blur(prod, lw, lh, tmp, s12);
      const mu1 = r.mu[c];
      const s11 = r.sigmaSq[c];
      let sum1 = 0;
      let sum4 = 0;
      let art1 = 0;
      let art4 = 0;
      let det1 = 0;
      let det4 = 0;
      for (let i = 0; i < n; i++) {
        const m1 = mu1[i];
        const m2 = mu2[i];
        const md = m1 - m2;
        const numM = 1 - md * md;
        const numS = 2 * (s12[i] - m1 * m2) + C2;
        const denS = s11[i] - m1 * m1 + (s22[i] - m2 * m2) + C2;
        const d = Math.max(0, 1 - (numM * numS) / denS);
        sum1 += d;
        sum4 += d * d * d * d;
        const e = (1 + Math.abs(b[i] - m2)) / (1 + Math.abs(a[i] - m1)) - 1;
        if (e > 0) {
          art1 += e;
          art4 += e * e * e * e;
        } else {
          det1 -= e;
          det4 += e * e * e * e;
        }
      }
      ssim.push(sum1 / n, (sum4 / n) ** 0.25);
      edge.push(art1 / n, (art4 / n) ** 0.25, det1 / n, (det4 / n) ** 0.25);
    }
    ssimParts.push(ssim);
    edgeParts.push(edge);
  });
  for (let c = 0; c < 3; c++) {
    for (let s = 0; s < ssimParts.length; s++) {
      for (let k = 0; k < 2; k++) {
        total += WEIGHTS[wi++] * Math.abs(ssimParts[s][c * 2 + k]);
        total += WEIGHTS[wi++] * Math.abs(edgeParts[s][c * 4 + k]);
        total += WEIGHTS[wi++] * Math.abs(edgeParts[s][c * 4 + k + 2]);
      }
    }
  }
  let v = total * 0.9562382616834844;
  v = 2.326765642916932 * v - 0.020884521182843837 * v * v + 6.248496625763138e-5 * v * v * v;
  return v > 0 ? 100 - 10 * v ** 0.6276336467831387 : 100;
}

function hasAlpha(d: Uint8Array): boolean {
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return true;
  return false;
}

/** Score candidates against one fixed reference image. */
export class Ssimulacra2 {
  private refs: { bg: number | null; scales: RefScale[] }[];

  constructor(
    reference: Uint8Array,
    private width: number,
    private height: number,
  ) {
    const bgs = hasAlpha(reference) ? [0.1, 0.9] : [null];
    this.refs = bgs.map((bg) => ({ bg, scales: prepare(reference, width, height, bg) }));
  }

  score(distorted: Uint8Array): number {
    if (!this.refs[0].scales.length) return 100; // smaller than 8×8: nothing to measure
    return Math.min(...this.refs.map((r) => compare(r.scales, distorted, this.width, this.height, r.bg)));
  }
}

export function ssimulacra2(reference: Uint8Array, distorted: Uint8Array, width: number, height: number): number {
  return new Ssimulacra2(reference, width, height).score(distorted);
}
