import { fourcc, u32be } from '../util/bytes.js';
import { cicpChunk, exifChunk, iccpChunk, toDelay, xmpChunk } from '../util/meta.js';
import { avifModule } from '../codecs.js';
import { clliChunk } from '../process/hdr.js';
import type { Frame, MetaChunk, RasterImage } from '../types.js';

export function isAvif(b: Uint8Array): boolean {
  if (b.length < 16 || fourcc(b, 4) !== 'ftyp') return false;
  const size = Math.min(u32be(b, 0), b.length);
  for (let o = 8; o + 4 <= size; o += 4) {
    if (o === 12) continue; // minor version
    const brand = fourcc(b, o);
    if (brand === 'avif' || brand === 'avis') return true;
  }
  return false;
}

/** libavif counts repetitions after the first play; APNG-style loops count plays (0 = forever). */
export const loopsFromRepetitions = (reps: number) => (reps < 0 ? 0 : reps + 1);
export const repetitionsFromLoops = (loops: number) => (loops === 0 ? -1 : loops - 1);

export async function decodeAvif(buf: Uint8Array): Promise<RasterImage> {
  const m = await avifModule();
  const r = m.decode(buf, true);
  if ('error' in r && r.error) throw new Error(`AVIF decoding failed (${r.error})`);
  const img = r as Exclude<typeof r, { error: string }>;
  if (!img.frames.length) throw new Error('AVIF has no frames');

  const chunks: MetaChunk[] = [];
  if (img.icc) chunks.push(iccpChunk(img.icc));
  else {
    // The decoder already produced full-range RGB; only primaries and transfer remain to signal.
    const [prim, trc] = img.cicp;
    const srgb = (prim === 1 || prim === 2) && (trc === 13 || trc === 2);
    if (!srgb) chunks.push(cicpChunk(prim === 2 ? 1 : prim, trc === 2 ? 13 : trc, true));
  }
  if (img.clli[0]) chunks.push(clliChunk(img.clli[0], img.clli[1]));
  if (img.exif) {
    const e = exifChunk(img.exif);
    if (e) chunks.push(e);
  }
  if (img.xmp) chunks.push(xmpChunk(img.xmp));

  const frames: Frame[] = img.frames.map((f) => {
    const [delayNum, delayDen] = img.animated ? toDelay(f.duration) : [0, 100];
    return { data: f.data, delayNum, delayDen };
  });
  return {
    width: img.width,
    height: img.height,
    depth: img.depth,
    frames,
    loops: img.animated ? loopsFromRepetitions(img.repetitionCount) : 0,
    chunks,
    format: 'avif',
    warnings: [],
    gainMap: img.gainMap,
  };
}
