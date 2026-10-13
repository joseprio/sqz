import type { Frame } from '../types.js';
import { crop, diffBox } from '../encode/frames.js';

export type PixelTransform = (rgba: Uint8Array, width: number, height: number) => Uint8Array;

/**
 * Apply a lossy transform to an animation without destroying inter-frame redundancy.
 * Transforms like error diffusion or predictive quantisation spread changes across the
 * image, so each frame only re-processes the rectangle that actually changed and
 * copies everything else from the previous processed frame.
 */
export function transformFrames(frames: Frame[], width: number, height: number, fn: PixelTransform): Frame[] {
  const out: Frame[] = [];
  frames.forEach((f, i) => {
    const cur = f.data as Uint8Array;
    if (i === 0) {
      out.push({ ...f, data: fn(cur, width, height) });
      return;
    }
    const prevSrc = frames[i - 1].data as Uint8Array;
    const prevOut = out[i - 1].data as Uint8Array;
    const box = diffBox(prevSrc, cur, width, height);
    if (!box) {
      out.push({ ...f, data: prevOut });
      return;
    }
    const processed = fn(crop(cur, width, box) as Uint8Array, box.width, box.height);
    const next = prevOut.slice();
    for (let y = 0; y < box.height; y++) {
      for (let x = 0; x < box.width; x++) {
        const s = ((box.y + y) * width + box.x + x) * 4;
        if (cur[s] === prevSrc[s] && cur[s + 1] === prevSrc[s + 1] && cur[s + 2] === prevSrc[s + 2] && cur[s + 3] === prevSrc[s + 3]) continue;
        const p = (y * box.width + x) * 4;
        next[s] = processed[p];
        next[s + 1] = processed[p + 1];
        next[s + 2] = processed[p + 2];
        next[s + 3] = processed[p + 3];
      }
    }
    out.push({ ...f, data: next });
  });
  return out;
}
