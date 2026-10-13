import type { Frame } from '../types.js';
import { addDelays } from '../util/meta.js';

/** One APNG frame as written: a rectangle drawn onto the previous canvas (dispose_op is always NONE). */
export interface SubFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  data: Uint8Array | Uint16Array;
  /** 0 = APNG_BLEND_OP_SOURCE, 1 = APNG_BLEND_OP_OVER */
  blend: 0 | 1;
  delayNum: number;
  delayDen: number;
}

/** Zero the colour of fully transparent pixels so equal-looking pixels compare equal. */
export function canonicalize(frames: Frame[]): Frame[] {
  return frames.map((f) => {
    const d = f.data.slice();
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] === 0) d[i] = d[i + 1] = d[i + 2] = 0;
    return { ...f, data: d };
  });
}

function equal(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Drop frames identical to their predecessor, folding their delay into it. */
export function mergeDuplicates(frames: Frame[]): Frame[] {
  const out: Frame[] = [];
  for (const f of frames) {
    const last = out[out.length - 1];
    if (last && equal(last.data, f.data)) {
      const [num, den] = addDelays(last.delayNum, last.delayDen, f.delayNum, f.delayDen);
      out[out.length - 1] = { ...last, delayNum: num, delayDen: den };
    } else out.push(f);
  }
  return out;
}

export function diffBox(a: ArrayLike<number>, b: ArrayLike<number>, width: number, height: number) {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

export function crop(d: Uint8Array | Uint16Array, width: number, r: { x: number; y: number; width: number; height: number }) {
  const out = new (d.constructor as Uint8ArrayConstructor)(r.width * r.height * 4) as Uint8Array | Uint16Array;
  for (let y = 0; y < r.height; y++) out.set(d.subarray(((r.y + y) * width + r.x) * 4, ((r.y + y) * width + r.x + r.width) * 4), y * r.width * 4);
  return out;
}

/**
 * Turn full canvases into minimal APNG frames. With `useOver`, pixels that do not change
 * become transparent and are drawn with BLEND_OP_OVER, which usually compresses far better.
 */
export function planFrames(frames: Frame[], width: number, height: number, max: number, useOver: boolean, align: 1 | 2 = 1): SubFrame[] {
  const out: SubFrame[] = [];
  frames.forEach((f, i) => {
    if (i === 0) {
      out.push({ x: 0, y: 0, width, height, data: f.data, blend: 0, delayNum: f.delayNum, delayDen: f.delayDen });
      return;
    }
    const prev = frames[i - 1].data;
    const box = diffBox(prev, f.data, width, height) ?? { x: 0, y: 0, width: 1, height: 1 };
    if (align === 2) {
      // WebP frame offsets must be even.
      box.width += box.x & 1;
      box.height += box.y & 1;
      box.x &= ~1;
      box.y &= ~1;
    }
    const data = crop(f.data, width, box);
    let blend: 0 | 1 = 0;
    if (useOver) {
      const before = crop(prev, width, box);
      let feasible = true;
      let helps = false;
      for (let p = 0; p < data.length && feasible; p += 4) {
        const same = data[p] === before[p] && data[p + 1] === before[p + 1] && data[p + 2] === before[p + 2] && data[p + 3] === before[p + 3];
        if (same) helps ||= data[p + 3] !== 0;
        // OVER can only reproduce a changed pixel that is opaque or drawn onto transparency.
        else if (data[p + 3] !== max && before[p + 3] !== 0) feasible = false;
      }
      if (feasible && helps) {
        blend = 1;
        for (let p = 0; p < data.length; p += 4) {
          if (data[p] === before[p] && data[p + 1] === before[p + 1] && data[p + 2] === before[p + 2] && data[p + 3] === before[p + 3]) {
            data[p] = data[p + 1] = data[p + 2] = data[p + 3] = 0;
          }
        }
      }
    }
    out.push({ ...box, data, blend, delayNum: f.delayNum, delayDen: f.delayDen });
  });
  return out;
}
