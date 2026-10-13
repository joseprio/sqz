import { decode, detectFormat } from './decode/index.js';
import { readChunks, PNG_SIGNATURE } from './decode/png.js';
import { riffChunks } from './decode/webp.js';
import { encodePng } from './encode/png.js';
import { encodeWebp, webpRoundTrip } from './encode/webp.js';
import { avifRoundTrip, encodeAvif } from './encode/avif.js';
import { binarizeAlpha, encodeGif } from './encode/gif.js';
import { canonicalize, mergeDuplicates } from './encode/frames.js';
import { countColors, quantizeFrames } from './process/quantize.js';
import { tuneColors, tunePngStep, tuneQuality } from './process/target.js';
import { lossyFilter } from './process/lossy.js';
import { transformFrames } from './process/animate.js';
import { concat } from './util/bytes.js';
import type { ConvertOptions, ConvertResult, Frame, Mode, OutputFormat, RasterImage, Variant, VariantResult } from './types.js';

export type * from './types.js';
export { decode, detectFormat } from './decode/index.js';
export { wasmLoaders } from './codecs.js';
export { TARGET_BANDS, describeTarget, type TargetBand } from './process/bands.js';
export { ssimulacra2, Ssimulacra2 } from './metric/ssimulacra2.js';

export const OUTPUT_FORMATS: OutputFormat[] = ['png', 'webp', 'avif', 'gif'];
const MIME: Record<OutputFormat, string> = { png: 'image/png', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif' };

/**
 * The variants a format produces for a mode. GIF is always palette-based, so its only
 * lossy variant is `quantized`; AVIF has no palette coding, so quantizing first only
 * makes it bigger and its only lossy variant is `lossy`.
 */
export function variantsFor(format: OutputFormat, mode?: Mode): Variant[] {
  const lossy: Variant[] = format === 'gif' ? ['quantized'] : format === 'avif' ? ['lossy'] : ['quantized', 'lossy'];
  if (mode === 'lossless') return ['lossless'];
  if (mode === 'lossy') return lossy;
  return ['lossless', ...lossy];
}

/** Decode once, then produce every requested variant in the requested output format. */
export async function convert(input: Uint8Array, options: ConvertOptions = {}): Promise<ConvertResult> {
  const format = options.format ?? 'png';
  const effort = options.effort ?? 'default';
  if (!OUTPUT_FORMATS.includes(format)) throw new Error(`Unknown output format "${format}"`);
  if (!['fast', 'default', 'max'].includes(effort)) throw new Error(`Unknown effort "${effort}"`);
  const variants = options.variants ?? variantsFor(format);
  for (const v of variants) {
    if (!variantsFor(format).includes(v)) throw new Error(`${format.toUpperCase()} has no "${v}" variant`);
  }

  const report = options.onProgress ?? (() => {});
  report(null, 'decode', 0);
  const img = await decode(input);
  report(null, 'decode', 1);

  const results: VariantResult[] = [];
  for (const variant of variants) {
    let r: VariantResult;
    try {
      r = await makeVariant(input, img, format, variant, options, (stage, f) => report(variant, stage, f));
    } catch (e) {
      r = { variant, format, size: 0, mimeType: MIME[format], extension: format, description: '', keptOriginal: false, warnings: [], error: (e as Error).message };
    }
    results.push(r);
    options.onVariant?.(r);
  }

  return {
    inputFormat: img.format,
    inputSize: input.length,
    width: img.width,
    height: img.height,
    frames: img.frames.length,
    warnings: img.warnings,
    variants: results,
  };
}

function frames8(img: RasterImage): Frame[] {
  if (img.depth === 8) return img.frames;
  return img.frames.map((f) => {
    const d = f.data;
    const out = new Uint8Array(d.length);
    for (let i = 0; i < d.length; i++) out[i] = (d[i] * 255 + 32767) / 65535;
    return { ...f, data: out };
  });
}

async function makeVariant(
  input: Uint8Array,
  img: RasterImage,
  format: OutputFormat,
  variant: Variant,
  o: ConvertOptions,
  progress: (stage: string, fraction: number) => void,
): Promise<VariantResult> {
  const effort = o.effort ?? 'default';
  const target = Math.max(0, Math.min(100, o.target ?? 80));
  const warnings: string[] = [];
  const keep16 = format === 'png' && variant === 'lossless';
  if (img.depth === 16 && !keep16) warnings.push('16-bit image reduced to 8 bits per channel');

  let frames = keep16 ? img.frames : frames8(img);
  let hint: Uint8Array | undefined;
  let score: number | undefined = variant === 'lossless' ? 100 : undefined;
  let setting: string | undefined;
  let quality = 100;
  let subsample = true;
  const { width, height } = img;
  const missed = (s: number) => warnings.push(`Could not reach SSIMULACRA2 ${target}; best possible is ${s.toFixed(1)}`);
  const step = () => progress('tune', 0.5);

  progress('tune', 0);
  if (variant === 'quantized') {
    if (format === 'gif') frames = binarizeAlpha(frames);
    // An animated GIF keeps one palette slot free for the transparency that frame diffing uses.
    const maxColors = format === 'gif' && frames.length > 1 ? 255 : 256;
    const dither = o.dither ?? true;
    const t = await tuneColors(frames, width, height, target, dither, maxColors, step);
    if (!t.reached) missed(t.score);
    frames = quantizeFrames(frames, width, height, t.value, dither);
    score = t.score;
    setting = `${t.value} colours`;
  } else if (variant === 'lossy' && format === 'png') {
    if (countColors(frames, 256) > 256) {
      const t = await tunePngStep(frames, width, height, target, step);
      if (!t.reached) missed(t.score);
      score = t.score;
      setting = `step ${t.value}`;
      if (frames.length === 1) {
        const r = lossyFilter(frames[0].data as Uint8Array, width, height, t.value);
        frames = [{ ...frames[0], data: r.data }];
        hint = r.rows;
      } else {
        frames = transformFrames(frames, width, height, (d, w, h) => lossyFilter(d, w, h, t.value).data);
      }
    } else {
      // Images that fit a palette are stored losslessly smaller than lossy filtering could make them.
      score = 100;
      setting = 'fits a palette, kept lossless';
    }
  } else if (variant === 'lossy' && format === 'webp') {
    const t = await tuneQuality(frames, width, height, target, (d, q) => webpRoundTrip(d, width, height, q, effort), step);
    if (!t.reached) missed(t.score);
    quality = t.value;
    score = t.score;
    setting = `quality ${t.value}`;
  } else if (variant === 'lossy' && format === 'avif') {
    // 4:2:0 is smaller, but smears sharp colour edges; fall back to 4:4:4 when it can't reach the target.
    let t = await tuneQuality(frames, width, height, target, (d, q) => avifRoundTrip(d, width, height, q, effort, true), step);
    if (!t.reached) {
      const full = await tuneQuality(frames, width, height, target, (d, q) => avifRoundTrip(d, width, height, q, effort, false), step);
      if (full.reached || full.score > t.score) {
        t = full;
        subsample = false;
      }
    }
    if (!t.reached) missed(t.score);
    quality = t.value;
    score = t.score;
    setting = `quality ${t.value}${subsample ? '' : ', 4:4:4'}`;
  }
  progress('tune', 1);
  frames = mergeDuplicates(canonicalize(frames));
  const chunks = o.strip ? [] : img.chunks;

  let data: Uint8Array;
  let description: string;
  const lossless = variant !== 'lossy';
  switch (format) {
    case 'png': {
      const enc = await encodePng({ width, height, depth: keep16 ? img.depth : 8, frames, loops: img.loops, chunks, effort, hint, onProgress: progress });
      data = enc.data;
      description = enc.colorType;
      break;
    }
    case 'webp': {
      const enc = await encodeWebp({ width, height, frames, loops: img.loops, chunks, lossless, quality, effort, onProgress: progress });
      data = enc.data;
      description = enc.description;
      warnings.push(...enc.warnings);
      break;
    }
    case 'avif': {
      const enc = await encodeAvif({ width, height, frames, loops: img.loops, chunks, lossless, quality, subsample, effort, onProgress: progress });
      data = enc.data;
      description = enc.description;
      warnings.push(...enc.warnings);
      break;
    }
    case 'gif': {
      const enc = encodeGif({ width, height, frames, loops: img.loops });
      data = enc.data;
      description = enc.description;
      if (chunks.length) warnings.push('GIF output does not carry metadata; it was dropped');
      break;
    }
  }
  if (variant === 'quantized' && format !== 'gif') description = `${description}, quantized`;

  // Never hand back something bigger than an equally lossless file we were given.
  let keptOriginal = false;
  const original = reusableOriginal(input, format, !!o.strip);
  if (original && original.length <= data.length) {
    data = original;
    keptOriginal = true;
    description = 'original';
    score = 100;
    setting = undefined;
  }

  return { variant, format, data, size: data.length, mimeType: MIME[format], extension: format, description, keptOriginal, score, setting, warnings };
}

/** The input itself, if it is already a lossless file of the target format (stripped when asked). */
function reusableOriginal(input: Uint8Array, format: OutputFormat, strip: boolean): Uint8Array | null {
  if (detectFormat(input) !== format) return null;
  if (format === 'png') return strip ? stripPng(input) : input;
  if (format === 'gif') return strip ? null : input;
  if (format === 'webp') {
    const chunks = riffChunks(input, 12, input.length);
    const lossy = chunks.some((c) => c.type === 'VP8 ' || (c.type === 'ANMF' && riffChunks(c.data, 16, c.data.length).some((s) => s.type === 'VP8 ')));
    const meta = chunks.some((c) => c.type === 'ICCP' || c.type === 'EXIF' || c.type === 'XMP ');
    return lossy || (strip && meta) ? null : input;
  }
  return null;
}

const IMAGE_CHUNKS = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND', 'acTL', 'fcTL', 'fdAT']);

/** Copy a PNG keeping only the chunks needed to display it. */
export function stripPng(png: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [PNG_SIGNATURE];
  for (const c of readChunks(png)) if (IMAGE_CHUNKS.has(c.type)) parts.push(png.subarray(c.offset, c.offset + c.size));
  return concat(parts);
}
