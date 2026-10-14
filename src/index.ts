import { decode, detectFormat } from './decode/index.js';
import { readChunks, PNG_SIGNATURE } from './decode/png.js';
import { riffChunks } from './decode/webp.js';
import { encodePng } from './encode/png.js';
import { encodeWebp, webpRoundTrip } from './encode/webp.js';
import { avifDepth, avifRoundTrip, encodeAvif } from './encode/avif.js';
import { encodeJpeg, flatten, jpegRoundTrip } from './encode/jpeg.js';
import { binarizeAlpha, encodeGif } from './encode/gif.js';
import { canonicalize, mergeDuplicates } from './encode/frames.js';
import { countColors, quantizeFrames } from './process/quantize.js';
import { tuneColors, tunePngStep, tuneQuality } from './process/target.js';
import { lossyFilter } from './process/lossy.js';
import { transformFrames } from './process/animate.js';
import { cicpOf, clliOf, hdrTransfer, renderGainMap, sdrChunks, splitHdr, toneMapToSdr, TRANSFER, type Colour } from './process/hdr.js';
import { concat } from './util/bytes.js';
import type { ConvertOptions, ConvertResult, Frame, GainMap, MetaChunk, Mode, OutputFormat, RasterImage, Variant, VariantResult } from './types.js';

export type * from './types.js';
export { decode, detectFormat } from './decode/index.js';
export { wasmLoaders } from './codecs.js';
export { TARGET_BANDS, describeTarget, type TargetBand } from './process/bands.js';
export { ssimulacra2, Ssimulacra2 } from './metric/ssimulacra2.js';

export const OUTPUT_FORMATS: OutputFormat[] = ['png', 'webp', 'avif', 'gif', 'jpeg'];
const MIME: Record<OutputFormat, string> = { png: 'image/png', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif', jpeg: 'image/jpeg' };
/** File extension (without the dot) for each output format. */
export const EXTENSION: Record<OutputFormat, string> = { png: 'png', webp: 'webp', avif: 'avif', gif: 'gif', jpeg: 'jpg' };
const LABEL: Record<OutputFormat, string> = { png: 'PNG', webp: 'WebP', avif: 'AVIF', gif: 'GIF', jpeg: 'JPEG' };

/**
 * The variants a format produces for a mode. GIF is always palette-based, so its only
 * lossy variant is `quantized`; AVIF has no palette coding, so quantizing first only
 * makes it bigger and its only lossy variant is `lossy`. JPEG is always `lossy`, in
 * either mode.
 */
export function variantsFor(format: OutputFormat, mode?: Mode): Variant[] {
  if (format === 'jpeg') return ['lossy'];
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
    if (!variantsFor(format).includes(v)) throw new Error(`${LABEL[format]} has no "${v}" variant`);
  }

  const report = options.onProgress ?? (() => {});
  report(null, 'decode', 0);
  let img = await decode(input);
  const hdr = img.gainMap ? 'gain map' : hdrTransfer(img) ? (cicpOf(img.chunks)!.transfer === TRANSFER.PQ ? 'PQ' : 'HLG') : undefined;
  const hadHdr = !!hdr;
  if (options.stripHdr && hadHdr) img = sdrVersion(img);
  report(null, 'decode', 1);

  const results: VariantResult[] = [];
  for (const variant of variants) {
    let r: VariantResult;
    try {
      r = await makeVariant(input, img, format, variant, options, hadHdr, (stage, f) => report(variant, stage, f));
    } catch (e) {
      r = { variant, format, size: 0, mimeType: MIME[format], extension: EXTENSION[format], description: '', keptOriginal: false, warnings: [], error: (e as Error).message };
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
    hdr,
    warnings: img.warnings,
    variants: results,
  };
}

/** The image as plain SDR: without its gain map, and PQ / HLG tone mapped to sRGB. */
function sdrVersion(img: RasterImage): RasterImage {
  if (hdrTransfer(img)) return { ...img, gainMap: undefined, depth: 8, frames: toneMapToSdr(img.frames, cicpOf(img.chunks)!), chunks: sdrChunks(img.chunks) };
  return { ...img, gainMap: undefined };
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
  hadHdr: boolean,
  progress: (stage: string, fraction: number) => void,
): Promise<VariantResult> {
  const effort = o.effort ?? 'default';
  const target = Math.max(0, Math.min(100, o.target ?? 80));
  const warnings: string[] = [];
  const { width, height } = img;
  const label = format === 'png' && variant !== 'lossless' ? `${variant} PNG` : LABEL[format];
  if (format === 'jpeg' && img.frames.length > 1) throw new Error('JPEG cannot store animations');

  // Settle what the output carries: 16-bit frames, an HDR transfer, a gain map, or plain SDR.
  let frames: Frame[];
  let depth: 8 | 16 = 8;
  let chunks: MetaChunk[] = o.strip ? [] : img.chunks;
  let gainMap: GainMap | undefined;
  let colour: Colour | undefined;
  const pq = hdrTransfer(img);
  if (pq && format === 'png' && variant === 'lossless') {
    frames = img.frames;
    depth = 16;
    // Without its colour chunks a PQ / HLG image would display as washed-out SDR.
    if (o.strip) chunks = img.chunks.filter((c) => c.type === 'cICP' || c.type === 'mDCV' || c.type === 'cLLI');
  } else if (pq && format === 'avif') {
    frames = img.frames;
    colour = cicpOf(img.chunks)!;
  } else if (pq && format === 'jpeg') {
    const split = await splitHdr(img);
    frames = [split.frame];
    gainMap = split.gainMap;
    chunks = sdrChunks(chunks);
  } else if (pq) {
    frames = toneMapToSdr(img.frames, cicpOf(img.chunks)!);
    chunks = sdrChunks(chunks);
    warnings.push(`HDR tone mapped to SDR: ${label} cannot store HDR`);
  } else if (img.gainMap && format === 'png' && variant === 'lossless') {
    const rendered = await renderGainMap(img);
    if (rendered) {
      frames = [rendered.frame];
      depth = 16;
      chunks = o.strip ? rendered.chunks.filter((c) => c.type === 'cICP' || c.type === 'cLLI') : rendered.chunks;
    } else {
      frames = img.frames;
      warnings.push('The gain map could not be applied in this colour space; only the SDR image was kept');
    }
  } else if (img.gainMap && (format === 'avif' || format === 'jpeg')) {
    frames = img.frames;
    gainMap = img.gainMap;
  } else {
    if (img.gainMap) warnings.push(`HDR gain map dropped: ${label} cannot store it`);
    frames = img.frames;
  }
  if (frames[0].data instanceof Uint16Array && format === 'png' && variant === 'lossless') depth = 16;
  else if (frames[0].data instanceof Uint16Array && format !== 'avif') {
    warnings.push('16-bit image reduced to 8 bits per channel');
    frames = frames8({ ...img, frames });
  }
  const high = frames[0].data instanceof Uint16Array;
  // Lossy AVIF uses 10 bits, which every AV1 profile decodes; 12 needs the Professional profile.
  const avifBits = format === 'avif' && high ? (variant === 'lossless' ? avifDepth(frames) : 10) : 8;
  if (format === 'avif' && high) colour ??= cicpOf(img.chunks) ?? undefined;
  if (format === 'jpeg') {
    const f = flatten(frames[0].data as Uint8Array);
    if (f.hadAlpha) warnings.push('JPEG has no transparency; transparent areas were filled with white');
    frames = [{ ...frames[0], data: f.data }];
  }

  let hint: Uint8Array | undefined;
  let score: number | undefined = variant === 'lossless' ? 100 : undefined;
  let setting: string | undefined;
  let quality = 100;
  let subsample = true;
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
    const t = await tuneQuality(frames, width, height, target, (d: Uint8Array, q) => webpRoundTrip(d, width, height, q, effort), step);
    if (!t.reached) missed(t.score);
    quality = t.value;
    score = t.score;
    setting = `quality ${t.value}`;
  } else if (variant === 'lossy' && (format === 'avif' || format === 'jpeg')) {
    // 4:2:0 is smaller, but smears sharp colour edges; fall back to 4:4:4 when it can't reach the target.
    const roundTrip = (sub: boolean) => (d: Uint8Array | Uint16Array, q: number) =>
      format === 'avif' ? avifRoundTrip(d, width, height, q, effort, sub, avifBits, colour) : jpegRoundTrip(d as Uint8Array, width, height, q, effort, sub);
    let t = await tuneQuality(frames, width, height, target, roundTrip(true), step);
    if (!t.reached) {
      const full = await tuneQuality(frames, width, height, target, roundTrip(false), step);
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

  let data: Uint8Array;
  let description: string;
  const lossless = variant !== 'lossy';
  switch (format) {
    case 'png': {
      const enc = await encodePng({ width, height, depth, frames, loops: img.loops, chunks, effort, hint, onProgress: progress });
      data = enc.data;
      description = enc.colorType;
      if (depth === 16 && (pq || img.gainMap)) description += ', HDR';
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
      const clli = clliOf(img.chunks);
      const enc = await encodeAvif({ width, height, frames, loops: img.loops, chunks, lossless, quality, subsample, effort, depth: avifBits, colour, clli, gainMap, onProgress: progress });
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
    case 'jpeg': {
      progress('compress', 0);
      const enc = await encodeJpeg({ width, height, data: frames[0].data as Uint8Array, chunks, quality, subsample, effort, gainMap });
      progress('compress', 1);
      data = enc.data;
      description = enc.description;
      warnings.push(...enc.warnings);
      break;
    }
  }
  if (variant === 'quantized' && format !== 'gif') description = `${description}, quantized`;

  // Never hand back something bigger than an equally good file we were given.
  let keptOriginal = false;
  // Stripping must not take HDR signalling with it, and stripHdr must not hand HDR back.
  const original = (o.stripHdr || o.strip) && hadHdr ? null : reusableOriginal(input, format, !!o.strip);
  if (original && original.length <= data.length) {
    data = original;
    keptOriginal = true;
    description = 'original';
    score = 100;
    setting = undefined;
  }

  return { variant, format, data, size: data.length, mimeType: MIME[format], extension: EXTENSION[format], description, keptOriginal, score, setting, warnings };
}

/**
 * The input itself, if it is already a lossless file of the target format (stripped
 * when asked), or for JPEG, the JPEG itself: re-encoding cannot improve on it.
 */
function reusableOriginal(input: Uint8Array, format: OutputFormat, strip: boolean): Uint8Array | null {
  if (detectFormat(input) !== format) return null;
  if (format === 'png') return strip ? stripPng(input) : input;
  if (format === 'gif' || format === 'jpeg') return strip ? null : input;
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
