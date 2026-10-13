import { paeth } from '../decode/png.js';

/** Quality 0–100 → residual quantisation step. 100 is lossless; 75 allows ±3 per channel. */
export function lossyStep(quality: number): number {
  const q = Math.max(0, Math.min(100, quality));
  return 1 + Math.round((100 - q) * 0.25);
}

/**
 * Truecolour lossy PNG ("lossy filtering"). Each pixel is predicted from already
 * reconstructed neighbours, exactly like a PNG filter, and the prediction residual
 * is rounded to a multiple of `step`. Every channel stays within ±step/2 of the
 * source, but residuals collapse onto a handful of values that deflate squeezes
 * very well. Alpha is kept exact so opaque stays opaque and transparent stays
 * transparent. Returns the new pixels and the filter type chosen for every row,
 * which the encoder tries as one of its strategies.
 */
export function lossyFilter(rgba: Uint8Array, width: number, height: number, step: number): { data: Uint8Array; rows: Uint8Array } {
  const out = new Uint8Array(rgba.length);
  const rows = new Uint8Array(height);
  if (step <= 1) {
    out.set(rgba);
    rows.fill(4);
    return { data: out, rows };
  }
  const stride = width * 4;
  const zero = new Uint8Array(stride);
  const scratch = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));

  for (let y = 0; y < height; y++) {
    const up = y > 0 ? out.subarray((y - 1) * stride, y * stride) : zero;
    const src = y * stride;
    let best = 0;
    let bestCost = Infinity;
    for (let ft = 0; ft < 5; ft++) {
      const r = scratch[ft];
      let cost = 0;
      for (let i = 0; i < stride; i++) {
        const c = i & 3;
        const left = i >= 4 ? r[i - 4] : 0;
        const u = up[i];
        const ul = i >= 4 ? up[i - 4] : 0;
        const pred = ft === 0 ? 0 : ft === 1 ? left : ft === 2 ? u : ft === 3 ? (left + u) >> 1 : paeth(left, u, ul);
        const a = rgba[src + (i | 3)];
        let v: number;
        if (c === 3) v = a;
        else if (a === 0) v = pred;
        else {
          v = pred + Math.round((rgba[src + i] - pred) / step) * step;
          v = v < 0 ? 0 : v > 255 ? 255 : v;
        }
        r[i] = v;
        const d = (v - pred) & 0xff;
        cost += d < 128 ? d : 256 - d;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = ft;
      }
    }
    out.set(scratch[best], src);
    rows[y] = best;
  }
  return { data: out, rows };
}
