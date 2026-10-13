import { webpDecoder, webpEncoder } from '../codecs.js';
import { riff, riffChunks, type RiffChunk } from '../decode/webp.js';
import { fourcc } from '../util/bytes.js';
import { portableMeta } from '../util/meta.js';
import type { Effort, Frame, MetaChunk } from '../types.js';
import { planFrames } from './frames.js';

export interface WebpInput {
  width: number;
  height: number;
  /** 8-bit full canvases, canonicalised and de-duplicated. */
  frames: Frame[];
  loops: number;
  chunks: MetaChunk[];
  lossless: boolean;
  quality: number;
  effort: Effort;
  onProgress?: (stage: string, fraction: number) => void;
}

function options(lossless: boolean, quality: number, effort: Effort): Record<string, unknown> {
  if (lossless) {
    // For lossless WebP, `quality` is compression effort; `exact: 0` lets libwebp
    // rewrite the colour of fully transparent pixels, which is invisible.
    return { lossless: 1, method: effort === 'fast' ? 4 : 6, quality: effort === 'fast' ? 75 : 100, exact: 0 };
  }
  return { quality, method: effort === 'fast' ? 4 : 6, use_sharp_yuv: 1, alpha_quality: 100, pass: effort === 'max' ? 10 : 1 };
}

const u24 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff];

function hasAlpha(d: Uint8Array): boolean {
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return true;
  return false;
}

/** Image-bearing chunks (ALPH, VP8, VP8L) of a still WebP produced by libwebp. */
function imageChunks(file: Uint8Array): RiffChunk[] {
  return riffChunks(file, 12, file.length).filter((c) => c.type === 'ALPH' || c.type === 'VP8 ' || c.type === 'VP8L');
}

export async function encodeWebp(input: WebpInput): Promise<{ data: Uint8Array; description: string; warnings: string[] }> {
  const { width, height, frames, lossless, quality, effort } = input;
  const progress = input.onProgress ?? (() => {});
  const encode = await webpEncoder();
  const opts = options(lossless, quality, effort);
  const warnings: string[] = [];
  const meta = portableMeta(input.chunks);
  const dropped = meta.dropped.filter((t) => t !== 'sRGB');
  if (dropped.length) warnings.push(`WebP cannot store ${[...new Set(dropped)].join(', ')} metadata; it was dropped`);
  const description = lossless ? 'WebP lossless' : `WebP lossy q${quality}`;

  const encodeRect = async (data: Uint8Array, w: number, h: number) =>
    new Uint8Array(await encode({ data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width: w, height: h }, opts));

  const animated = frames.length > 1;
  const body: RiffChunk[] = [];
  let alpha = false;

  if (!animated) {
    progress('compress', 0);
    const file = await encodeRect(frames[0].data as Uint8Array, width, height);
    progress('compress', 1);
    if (!meta.icc && !meta.exif && !meta.xmp) return { data: file, description, warnings };
    alpha = fourcc(file, 12) === 'VP8L' ? hasAlpha(frames[0].data as Uint8Array) : imageChunks(file).some((c) => c.type === 'ALPH');
    body.push(...imageChunks(file));
  } else {
    const subs = planFrames(frames, width, height, 255, true, 2);
    for (let i = 0; i < subs.length; i++) {
      progress('compress', i / subs.length);
      const s = subs[i];
      const data = s.data as Uint8Array;
      if (hasAlpha(data)) alpha = true;
      const file = await encodeRect(data, s.width, s.height);
      const header = new Uint8Array([
        ...u24(s.x / 2),
        ...u24(s.y / 2),
        ...u24(s.width - 1),
        ...u24(s.height - 1),
        ...u24(Math.min(0xffffff, Math.round((s.delayNum / (s.delayDen || 100)) * 1000))),
        s.blend === 1 ? 0 : 0x02, // bit 1 = do not blend; dispose is always "none"
      ]);
      const inner = riff(imageChunks(file)).subarray(12);
      const anmf = new Uint8Array(header.length + inner.length);
      anmf.set(header);
      anmf.set(inner, header.length);
      body.push({ type: 'ANMF', data: anmf });
    }
    progress('compress', 1);
    const anim = new Uint8Array(6);
    anim[4] = input.loops & 0xff;
    anim[5] = (input.loops >> 8) & 0xff;
    body.unshift({ type: 'ANIM', data: anim });
  }

  const flags = (meta.icc ? 0x20 : 0) | (alpha ? 0x10 : 0) | (meta.exif ? 0x08 : 0) | (meta.xmp ? 0x04 : 0) | (animated ? 0x02 : 0);
  const vp8x = new Uint8Array([flags, 0, 0, 0, ...u24(width - 1), ...u24(height - 1)]);
  const chunks: RiffChunk[] = [{ type: 'VP8X', data: vp8x }];
  if (meta.icc) chunks.push({ type: 'ICCP', data: meta.icc });
  chunks.push(...body);
  if (meta.exif) chunks.push({ type: 'EXIF', data: meta.exif });
  if (meta.xmp) chunks.push({ type: 'XMP ', data: meta.xmp });
  return { data: riff(chunks), description: animated ? `${description}, animated` : description, warnings };
}

/** Encode one still at `quality` and decode it again, for the target search. */
export async function webpRoundTrip(rgba: Uint8Array, width: number, height: number, quality: number, effort: Effort): Promise<Uint8Array> {
  const [encode, decode] = await Promise.all([webpEncoder(), webpDecoder()]);
  const file = await encode({ data: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), width, height }, options(false, quality, effort));
  const img = await decode(file);
  return new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.length);
}
