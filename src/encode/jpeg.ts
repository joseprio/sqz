import { jpegDecoder, jpegEncoder } from '../codecs.js';
import { portableMeta } from '../util/meta.js';
import { concat } from '../util/bytes.js';
import {
  containerXmp,
  exifSegment,
  hdrgmXmp,
  iccSegments,
  isoSegment,
  MAX_EXIF,
  MAX_XMP,
  MPF_SEGMENT_SIZE,
  mpfSegment,
  segment,
  withSegments,
  xmpSegment,
} from '../util/jpeg.js';
import type { Effort, GainMap, MetaChunk } from '../types.js';

export interface JpegInput {
  width: number;
  height: number;
  /** Opaque 8-bit RGBA. */
  data: Uint8Array;
  chunks: MetaChunk[];
  quality: number;
  /** 4:2:0 (smaller) instead of 4:4:4. */
  subsample: boolean;
  effort: Effort;
  /** Written as an Ultra HDR / ISO 21496-1 second image. */
  gainMap?: GainMap;
}

function options(quality: number, subsample: boolean, effort: Effort, grey = false): Record<string, unknown> {
  return {
    quality,
    progressive: true,
    optimize_coding: true,
    auto_subsample: false,
    chroma_subsample: subsample ? 2 : 1,
    color_space: grey ? 1 : 3,
    trellis_multipass: effort === 'max',
    trellis_loops: effort === 'max' ? 2 : 1,
  };
}

async function encodeRgba(data: Uint8Array, width: number, height: number, opts: Record<string, unknown>): Promise<Uint8Array> {
  const encode = await jpegEncoder();
  return new Uint8Array(await encode({ data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width, height }, opts));
}

/** Composite onto white: JPEG has no alpha channel. */
export function flatten(rgba: Uint8Array): { data: Uint8Array; hadAlpha: boolean } {
  let hadAlpha = false;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) {
      hadAlpha = true;
      break;
    }
  }
  if (!hadAlpha) return { data: rgba, hadAlpha };
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    for (let c = 0; c < 3; c++) out[i + c] = Math.round((rgba[i + c] * a + 255 * (255 - a)) / 255);
    out[i + 3] = 255;
  }
  return { data: out, hadAlpha };
}

export async function encodeJpeg(input: JpegInput): Promise<{ data: Uint8Array; description: string; warnings: string[] }> {
  const { width, height, quality, subsample, effort } = input;
  const warnings: string[] = [];
  const meta = portableMeta(input.chunks);
  const dropped = meta.dropped.filter((t) => t !== 'sRGB');
  if (dropped.length) warnings.push(`JPEG cannot store ${[...new Set(dropped)].join(', ')} metadata; it was dropped`);

  const segs: Uint8Array[] = [];
  if (meta.exif) {
    if (meta.exif.length <= MAX_EXIF) segs.push(exifSegment(meta.exif));
    else warnings.push('EXIF metadata is too large for JPEG; it was dropped');
  }
  if (meta.icc) segs.push(...iccSegments(meta.icc));

  const base = await encodeRgba(input.data, width, height, options(quality, subsample, effort));
  const kind = `JPEG q${quality}${subsample ? '' : ' 4:4:4'}`;

  const gm = input.gainMap;
  if (!gm) {
    if (meta.xmp) {
      if (meta.xmp.length <= MAX_XMP) segs.push(xmpSegment(meta.xmp));
      else warnings.push('XMP metadata is too large for JPEG; it was dropped');
    }
    return { data: withSegments(base, segs), description: kind, warnings };
  }

  // Ultra HDR: the gain map is a second JPEG after the first, found through MPF and XMP.
  const gmSegs = [xmpSegment(hdrgmXmp(gm)), segment(0xe2, isoSegment(gm))];
  if (gm.altIcc) gmSegs.push(...iccSegments(gm.altIcc));
  const gmJpeg = withSegments(await encodeRgba(gm.data, gm.width, gm.height, options(Math.max(quality, 85), false, effort, gm.channels === 1)), gmSegs);

  let xmp = containerXmp(meta.xmp, gmJpeg.length);
  if (xmp.length > MAX_XMP) {
    warnings.push('XMP metadata is too large for JPEG; it was dropped');
    xmp = containerXmp(undefined, gmJpeg.length);
  }
  const head = [...segs, xmpSegment(xmp), segment(0xe2, isoSegment(null))];
  const before = withSegments(base, head);
  // MPF goes last among the inserted segments; its offsets count from its own TIFF header.
  const mpfAt = before.length - (base.length - insertionPoint(base));
  const primarySize = before.length + MPF_SEGMENT_SIZE;
  const tiffStart = mpfAt + 8;
  const mpf = segment(0xe2, mpfSegment(primarySize, gmJpeg.length, primarySize - tiffStart));
  const primary = concat([before.subarray(0, mpfAt), mpf, before.subarray(mpfAt)]);
  return { data: concat([primary, gmJpeg]), description: `${kind}, Ultra HDR`, warnings };
}

function insertionPoint(jpeg: Uint8Array): number {
  return jpeg[2] === 0xff && jpeg[3] === 0xe0 ? 4 + ((jpeg[4] << 8) | jpeg[5]) : 2;
}

/** Encode one still at `quality` and decode it again, for the target search. */
export async function jpegRoundTrip(rgba: Uint8Array, width: number, height: number, quality: number, effort: Effort, subsample = true): Promise<Uint8Array> {
  const [file, decode] = await Promise.all([encodeRgba(rgba, width, height, options(quality, subsample, effort)), jpegDecoder()]);
  const img = await decode(file.buffer as ArrayBuffer);
  return new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.length);
}
