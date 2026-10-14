import type { GainMap, RasterImage } from '../types.js';

/**
 * Resizing and cropping. Resampling is separable and per axis: Lanczos3 when an axis
 * shrinks (the kernel widens with the scale, so every source pixel contributes),
 * bicubic (Keys, a = −0.5) when it grows. Colour is resampled premultiplied by alpha,
 * so transparent pixels don't bleed their invisible colour into the edges.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

export const MAX_SIDE = 32768;

const lanczos3 = (x: number) => {
  if (x === 0) return 1;
  if (x <= -3 || x >= 3) return 0;
  const p = Math.PI * x;
  return (3 * Math.sin(p) * Math.sin(p / 3)) / (p * p);
};

const bicubic = (x: number) => {
  const a = -0.5;
  x = Math.abs(x);
  if (x < 1) return ((a + 2) * x - (a + 3)) * x * x + 1;
  if (x < 2) return ((a * x - 5 * a) * x + 8 * a) * x - 4 * a;
  return 0;
};

interface Taps {
  start: Int32Array;
  count: Int32Array;
  weights: Float32Array;
  stride: number;
}

/** For each destination pixel along one axis: the first source pixel and the normalised weights. */
function taps(src: number, dst: number): Taps {
  const scale = dst / src;
  const down = scale < 1;
  const support = down ? 3 / scale : 2;
  const stride = Math.ceil(2 * support) + 1;
  const start = new Int32Array(dst);
  const count = new Int32Array(dst);
  const weights = new Float32Array(dst * stride);
  for (let i = 0; i < dst; i++) {
    const center = (i + 0.5) / scale - 0.5;
    const lo = Math.max(0, Math.ceil(center - support));
    const hi = Math.min(src - 1, Math.floor(center + support));
    let sum = 0;
    for (let s = lo; s <= hi; s++) {
      const w = down ? lanczos3((s - center) * scale) : bicubic(s - center);
      weights[i * stride + s - lo] = w;
      sum += w;
    }
    start[i] = lo;
    count[i] = hi - lo + 1;
    if (sum === 0) {
      // Cannot happen for sane sizes, but never divide by zero: take the nearest pixel.
      start[i] = Math.min(src - 1, Math.max(0, Math.round(center)));
      count[i] = 1;
      weights[i * stride] = 1;
    } else {
      for (let k = 0; k < count[i]; k++) weights[i * stride + k] /= sum;
    }
  }
  return { start, count, weights, stride };
}

/** Resample RGBA pixels (8 or 16 bits per channel) to `W × H`. */
export function resample<T extends Uint8Array | Uint16Array>(data: T, w: number, h: number, W: number, H: number): T {
  if (W === w && H === h) return data;
  const max = data instanceof Uint16Array ? 65535 : 255;

  let cur = new Float32Array(w * h * 4);
  for (let i = 0; i < cur.length; i += 4) {
    const a = data[i + 3] / max;
    cur[i] = data[i] * a;
    cur[i + 1] = data[i + 1] * a;
    cur[i + 2] = data[i + 2] * a;
    cur[i + 3] = data[i + 3];
  }

  if (W !== w) {
    const t = taps(w, W);
    const next = new Float32Array(W * h * 4);
    for (let y = 0; y < h; y++) {
      const row = y * w * 4;
      const out = y * W * 4;
      for (let x = 0; x < W; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        const base = x * t.stride;
        for (let k = 0; k < t.count[x]; k++) {
          const wt = t.weights[base + k];
          const s = row + (t.start[x] + k) * 4;
          r += cur[s] * wt;
          g += cur[s + 1] * wt;
          b += cur[s + 2] * wt;
          a += cur[s + 3] * wt;
        }
        const o = out + x * 4;
        next[o] = r;
        next[o + 1] = g;
        next[o + 2] = b;
        next[o + 3] = a;
      }
    }
    cur = next;
  }

  if (H !== h) {
    const t = taps(h, H);
    const rowLen = W * 4;
    const next = new Float32Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      const out = y * rowLen;
      const base = y * t.stride;
      for (let k = 0; k < t.count[y]; k++) {
        const wt = t.weights[base + k];
        const s = (t.start[y] + k) * rowLen;
        for (let i = 0; i < rowLen; i++) next[out + i] += cur[s + i] * wt;
      }
    }
    cur = next;
  }

  const out = (max === 255 ? new Uint8Array(W * H * 4) : new Uint16Array(W * H * 4)) as T;
  for (let i = 0; i < out.length; i += 4) {
    const a = Math.min(max, Math.max(0, cur[i + 3]));
    if (a < 0.5) continue; // fully transparent: colour is irrelevant, keep it zero
    const k = max / a;
    out[i] = Math.min(max, Math.max(0, Math.round(cur[i] * k)));
    out[i + 1] = Math.min(max, Math.max(0, Math.round(cur[i + 1] * k)));
    out[i + 2] = Math.min(max, Math.max(0, Math.round(cur[i + 2] * k)));
    out[i + 3] = Math.round(a);
  }
  return out;
}

/** Copy a rectangle out of RGBA pixels. */
export function cropPixels<T extends Uint8Array | Uint16Array>(data: T, w: number, r: Rect): T {
  const out = new (data.constructor as { new (n: number): T })(r.width * r.height * 4);
  for (let y = 0; y < r.height; y++) {
    const s = ((r.y + y) * w + r.x) * 4;
    out.set(data.subarray(s, s + r.width * 4), y * r.width * 4);
  }
  return out;
}

const whole = (n: number) => Number.isInteger(n);

/**
 * Resize to `resize` (if given), then keep the `crop` rectangle (in resized
 * coordinates, if given). Every frame and the gain map follow.
 */
export function transformImage(img: RasterImage, resize?: Size, crop?: Rect): RasterImage {
  let { width: w, height: h, frames, gainMap } = img;

  if (resize && (resize.width !== w || resize.height !== h)) {
    const { width: W, height: H } = resize;
    if (!whole(W) || !whole(H) || W < 1 || H < 1 || W > MAX_SIDE || H > MAX_SIDE) {
      throw new Error(`Resize size must be whole numbers from 1 to ${MAX_SIDE}`);
    }
    frames = frames.map((f) => ({ ...f, data: resample(f.data, w, h, W, H) }));
    if (gainMap) gainMap = resizeGainMap(gainMap, Math.max(1, Math.round((gainMap.width * W) / w)), Math.max(1, Math.round((gainMap.height * H) / h)));
    w = W;
    h = H;
  }

  if (crop && (crop.x !== 0 || crop.y !== 0 || crop.width !== w || crop.height !== h)) {
    const { x, y, width: cw, height: ch } = crop;
    if (![x, y, cw, ch].every(whole) || x < 0 || y < 0 || cw < 1 || ch < 1 || x + cw > w || y + ch > h) {
      throw new Error(`Crop rectangle must be whole pixels inside the ${w}×${h} image`);
    }
    frames = frames.map((f) => ({ ...f, data: cropPixels(f.data, w, crop) }));
    if (gainMap) {
      // The map is usually smaller than the image: take the matching (rounded outwards) area.
      const sx = gainMap.width / w;
      const sy = gainMap.height / h;
      const gx = Math.floor(x * sx);
      const gy = Math.floor(y * sy);
      const r = {
        x: gx,
        y: gy,
        width: Math.max(1, Math.min(gainMap.width, Math.ceil((x + cw) * sx)) - gx),
        height: Math.max(1, Math.min(gainMap.height, Math.ceil((y + ch) * sy)) - gy),
      };
      gainMap = { ...gainMap, data: cropPixels(gainMap.data, gainMap.width, r), width: r.width, height: r.height };
    }
    w = cw;
    h = ch;
  }

  return frames === img.frames ? img : { ...img, width: w, height: h, frames, gainMap };
}

function resizeGainMap(gm: GainMap, W: number, H: number): GainMap {
  return { ...gm, data: resample(gm.data, gm.width, gm.height, W, H), width: W, height: H };
}
