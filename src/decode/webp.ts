import { concat, fourcc, latin1, u24le, u32le } from '../util/bytes.js';
import { exifChunk, iccpChunk, xmpChunk } from '../util/meta.js';
import { toArrayBuffer, webpDecoder } from '../codecs.js';
import { blit } from './png.js';
import type { Frame, MetaChunk, RasterImage } from '../types.js';

export interface RiffChunk {
  type: string;
  data: Uint8Array;
}

export function riffChunks(buf: Uint8Array, start: number, end: number): RiffChunk[] {
  const out: RiffChunk[] = [];
  let o = start;
  while (o + 8 <= end) {
    const type = fourcc(buf, o);
    const size = u32le(buf, o + 4);
    const dataEnd = Math.min(end, o + 8 + size);
    out.push({ type, data: buf.subarray(o + 8, dataEnd) });
    o = o + 8 + size + (size & 1);
  }
  return out;
}

export function riff(chunks: RiffChunk[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const c of chunks) {
    const h = new Uint8Array(8);
    h.set(latin1(c.type));
    new DataView(h.buffer).setUint32(4, c.data.length, true);
    parts.push(h, c.data);
    if (c.data.length & 1) parts.push(new Uint8Array(1));
  }
  const body = concat(parts);
  const head = new Uint8Array(12);
  head.set(latin1('RIFF'));
  new DataView(head.buffer).setUint32(4, body.length + 4, true);
  head.set(latin1('WEBP'), 8);
  return concat([head, body]);
}

export async function decodeWebp(buf: Uint8Array): Promise<RasterImage> {
  const warnings: string[] = [];
  if (fourcc(buf, 0) !== 'RIFF' || fourcc(buf, 8) !== 'WEBP') throw new Error('Not a WebP file');
  const end = Math.min(buf.length, 8 + u32le(buf, 4));
  const chunks = riffChunks(buf, 12, end);
  const decode = await webpDecoder();

  const meta: MetaChunk[] = [];
  for (const c of chunks) {
    if (c.type === 'ICCP') meta.push(iccpChunk(c.data));
    else if (c.type === 'EXIF') {
      const e = exifChunk(c.data);
      if (e) meta.push(e);
    } else if (c.type === 'XMP ') meta.push(xmpChunk(c.data));
  }

  const vp8x = chunks.find((c) => c.type === 'VP8X');
  const animated = vp8x && vp8x.data[0] & 0x02;
  if (!animated) {
    const img = await decode(toArrayBuffer(buf));
    return {
      width: img.width,
      height: img.height,
      depth: 8,
      frames: [{ data: new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.length), delayNum: 0, delayDen: 100 }],
      loops: 0,
      chunks: meta,
      format: 'webp',
      warnings,
    };
  }

  const width = 1 + u24le(vp8x.data, 4);
  const height = 1 + u24le(vp8x.data, 7);
  const anim = chunks.find((c) => c.type === 'ANIM');
  const loops = anim && anim.data.length >= 6 ? anim.data[4] | (anim.data[5] << 8) : 0;

  const canvas = new Uint8Array(width * height * 4);
  const frames: Frame[] = [];
  let shortDelays = false;
  let index = 0;
  for (const c of chunks) {
    if (c.type !== 'ANMF' || c.data.length < 16) continue;
    const f = c.data;
    const x = 2 * u24le(f, 0);
    const y = 2 * u24le(f, 3);
    const fw = 1 + u24le(f, 6);
    const fh = 1 + u24le(f, 9);
    let duration = u24le(f, 12);
    const disposeBg = f[15] & 0x01;
    const noBlend = f[15] & 0x02;
    const sub = riffChunks(f, 16, f.length);
    const alph = sub.find((s) => s.type === 'ALPH');
    const bits = sub.find((s) => s.type === 'VP8 ' || s.type === 'VP8L');
    if (!bits) {
      warnings.push(`WebP frame ${index} has no image data and was skipped`);
      index++;
      continue;
    }
    let file: Uint8Array;
    if (alph && bits.type === 'VP8 ') {
      const hdr = new Uint8Array(10);
      hdr[0] = 0x10;
      hdr[4] = (fw - 1) & 0xff;
      hdr[5] = ((fw - 1) >> 8) & 0xff;
      hdr[6] = ((fw - 1) >> 16) & 0xff;
      hdr[7] = (fh - 1) & 0xff;
      hdr[8] = ((fh - 1) >> 8) & 0xff;
      hdr[9] = ((fh - 1) >> 16) & 0xff;
      file = riff([{ type: 'VP8X', data: hdr }, alph, bits]);
    } else {
      file = riff([bits]);
    }
    const img = await decode(toArrayBuffer(file));
    const w = Math.min(img.width, width - x);
    const h = Math.min(img.height, height - y);
    if (w <= 0 || h <= 0) {
      warnings.push(`WebP frame ${index} lies outside the canvas and was skipped`);
      index++;
      continue;
    }
    let px = new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.length);
    if (w !== img.width || h !== img.height) {
      warnings.push(`WebP frame ${index} was clipped to the canvas`);
      const clipped = new Uint8Array(w * h * 4);
      for (let r = 0; r < h; r++) clipped.set(px.subarray(r * img.width * 4, (r * img.width + w) * 4), r * w * 4);
      px = clipped;
    }
    const rect = { x, y, width: w, height: h };
    blit(canvas, width, px, rect, !noBlend, 255);
    // Chromium shows frames of 10 ms or less for 100 ms, as with GIF.
    if (duration <= 10) {
      duration = 100;
      shortDelays = true;
    }
    frames.push({ data: canvas.slice(), delayNum: duration, delayDen: 1000 });
    if (disposeBg) for (let r = y; r < y + h; r++) canvas.fill(0, (r * width + x) * 4, (r * width + x + w) * 4);
    index++;
  }
  if (!frames.length) throw new Error('Animated WebP has no decodable frames');
  if (shortDelays) warnings.push('WebP frame durations of 10 ms or less were set to 100 ms, matching how browsers play them');
  for (const fr of frames) {
    if (fr.delayNum > 0xffff) {
      fr.delayNum = Math.round(fr.delayNum / 10);
      fr.delayDen = 100;
    }
  }
  return { width, height, depth: 8, frames, loops, chunks: meta, format: 'webp', warnings };
}
