import { applyPaletteSync, distance, palette as paletteNs, utils } from 'image-q';
import type { Frame } from '../types.js';
import { transformFrames } from './animate.js';

const MAX_SAMPLES = 1 << 22;

export function countColors(frames: Frame[], limit: number): number {
  const seen = new Set<number>();
  for (const f of frames) {
    const d = f.data;
    for (let i = 0; i < d.length; i += 4) {
      seen.add(d[i + 3] === 0 ? 0 : ((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]) >>> 0);
      if (seen.size > limit) return seen.size;
    }
  }
  return seen.size;
}

/**
 * Reduce all frames to one shared palette of at most `colors` entries (APNG frames
 * share a single PLTE). Fully transparent pixels keep a dedicated transparent entry.
 */
export function quantizeFrames(frames: Frame[], width: number, height: number, colors: number, dither: boolean): Frame[] {
  colors = Math.max(2, Math.min(256, Math.round(colors)));
  if (countColors(frames, colors) <= colors) return frames;

  // Sample visible pixels from every frame into one point list.
  let visible = 0;
  let hasTransparent = false;
  for (const f of frames) for (let i = 3; i < f.data.length; i += 4) f.data[i] ? visible++ : (hasTransparent = true);
  const stride = Math.max(1, Math.ceil(visible / MAX_SAMPLES));
  const sample = new Uint8Array(Math.ceil(visible / stride) * 4 + 4);
  let n = 0;
  let k = 0;
  for (const f of frames) {
    const d = f.data;
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      if (k++ % stride) continue;
      sample.set(d.subarray(i, i + 4), n * 4);
      n++;
    }
  }

  const dist = new distance.EuclideanBT709();
  const quantizer = new paletteNs.WuQuant(dist, hasTransparent ? colors - 1 : colors);
  quantizer.sample(utils.PointContainer.fromUint8Array(sample.subarray(0, Math.max(1, n) * 4), Math.max(1, n), 1));
  const pal = quantizer.quantizeSync();
  if (hasTransparent) pal.add(utils.Point.createByRGBA(0, 0, 0, 0));

  const map = (rgba: Uint8Array, w: number, h: number): Uint8Array => {
    const pc = utils.PointContainer.fromUint8Array(rgba, w, h);
    const out = applyPaletteSync(pc, pal, {
      colorDistanceFormula: 'euclidean-bt709',
      imageQuantization: dither ? 'floyd-steinberg' : 'nearest',
    }).toUint8Array();
    // The transparent entry is in the palette, so fully transparent pixels map to it with
    // no error to diffuse; force it anyway in case a near-identical colour won.
    for (let i = 0; i < out.length; i += 4) if (rgba[i + 3] === 0) out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0;
    return out;
  };
  return transformFrames(frames, width, height, map);
}
