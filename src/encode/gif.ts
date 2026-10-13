import { GifWriter } from 'omggif';
import type { Frame } from '../types.js';
import { crop, diffBox } from './frames.js';

export interface GifInput {
  width: number;
  height: number;
  /** 8-bit full canvases, canonicalised and de-duplicated. */
  frames: Frame[];
  loops: number;
}

const rgbKey = (d: Uint8Array, i: number) => (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];

/** Why these frames can't be a GIF as-is, or null if they can. */
export function gifIncompatibility(frames: Frame[]): string | null {
  const colors = new Set<number>();
  let transparent = false;
  for (const f of frames) {
    const d = f.data as Uint8Array;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) transparent = true;
      else if (d[i + 3] !== 255) return 'GIF cannot store partial transparency';
      else colors.add(rgbKey(d, i));
    }
  }
  if (colors.size + (transparent ? 1 : 0) > 256) return `GIF holds at most 256 colours and this image has ${colors.size}${transparent ? ' plus transparency' : ''}`;
  return null;
}

/** Make alpha binary (GIF has no partial transparency). */
export function binarizeAlpha(frames: Frame[]): Frame[] {
  return frames.map((f) => {
    const d = (f.data as Uint8Array).slice();
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0;
      else d[i + 3] = 255;
    }
    return { ...f, data: d };
  });
}

/**
 * Encode frames that already fit GIF (binary alpha, ≤256 colours) with one global
 * palette. Later frames are cropped to what changed, and unchanged pixels become
 * transparent so LZW sees long runs.
 */
export function encodeGif(input: GifInput): { data: Uint8Array; description: string } {
  const { width, height, frames } = input;
  const problem = gifIncompatibility(frames);
  if (problem) throw new Error(problem);

  const counts = new Map<number, number>();
  let hasTransparent = false;
  for (const f of frames) {
    const d = f.data as Uint8Array;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) hasTransparent = true;
      else {
        const k = rgbKey(d, i);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
  }
  // Pixels going from visible to transparent need "restore to background" disposal,
  // which means redrawing whole frames; otherwise unchanged pixels can be skipped.
  let vanishing = false;
  for (let n = 1; n < frames.length && !vanishing; n++) {
    const a = frames[n - 1].data;
    const b = frames[n].data;
    for (let i = 3; i < a.length; i += 4) {
      if (a[i] !== 0 && b[i] === 0) {
        vanishing = true;
        break;
      }
    }
  }
  const animated = frames.length > 1;
  const needTransparent = hasTransparent || (animated && !vanishing && counts.size < 256);

  const colors = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const transparentIndex = needTransparent ? colors.length : -1;
  let size = 2;
  while (size < colors.length + (needTransparent ? 1 : 0)) size *= 2;
  const palette = new Array<number>(size).fill(0);
  colors.forEach((c, i) => (palette[i] = c));
  const index = new Map<number, number>(colors.map((c, i) => [c, i]));

  const toIndices = (d: Uint8Array, w: number, h: number, skip?: Uint8Array) => {
    const out = new Array<number>(w * h);
    for (let p = 0, i = 0; p < w * h; p++, i += 4) {
      const same = skip && d[i] === skip[i] && d[i + 1] === skip[i + 1] && d[i + 2] === skip[i + 2] && d[i + 3] === skip[i + 3];
      out[p] = d[i + 3] === 0 || (same && transparentIndex >= 0) ? transparentIndex : index.get(rgbKey(d, i))!;
    }
    return out;
  };

  const buf = new Uint8Array(1024 + frames.length * (width * height * 2 + 1024) + size * 3);
  const gopts: { palette: number[]; loop?: number } = { palette };
  if (animated && input.loops !== 1) gopts.loop = input.loops;
  const writer = new GifWriter(buf, width, height, gopts);

  frames.forEach((f, n) => {
    const delay = animated ? Math.max(2, Math.round((f.delayNum / (f.delayDen || 100)) * 100)) : 0;
    const d = f.data as Uint8Array;
    const opts = { delay, disposal: vanishing ? 2 : 1, transparent: transparentIndex >= 0 ? transparentIndex : undefined };
    let box = { x: 0, y: 0, width, height };
    let skip: Uint8Array | undefined;
    if (vanishing) {
      // Canvas is cleared after every frame, so draw the visible area in full.
      const blank = new Uint8Array(d.length);
      box = diffBox(blank, d, width, height) ?? { x: 0, y: 0, width: 1, height: 1 };
    } else if (n > 0) {
      const prev = frames[n - 1].data as Uint8Array;
      box = diffBox(prev, d, width, height) ?? { x: 0, y: 0, width: 1, height: 1 };
      skip = crop(prev, width, box) as Uint8Array;
    }
    const sub = crop(d, width, box) as Uint8Array;
    writer.addFrame(box.x, box.y, box.width, box.height, toIndices(sub, box.width, box.height, skip), opts);
  });
  const data = buf.slice(0, writer.end());
  return { data, description: `GIF ${colors.length} colours${animated ? ', animated' : ''}` };
}
