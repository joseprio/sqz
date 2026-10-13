import { unzlibSync } from 'fflate';
import { concat, fourcc, u16be, u32be } from '../util/bytes.js';
import type { Frame, MetaChunk, RasterImage } from '../types.js';

/** Ancillary chunks whose meaning survives re-encoding the pixels. */
export const METADATA_CHUNKS = new Set([
  'iCCP', 'sRGB', 'gAMA', 'cHRM', 'cICP', 'mDCV', 'cLLI', 'pHYs', 'sCAL', 'oFFs', 'pCAL', 'sTER',
  'tEXt', 'zTXt', 'iTXt', 'tIME', 'eXIf',
]);
/** Chunks sqz regenerates itself or that describe the old encoding. */
const STRUCTURAL = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'acTL', 'fcTL', 'fdAT', 'bKGD', 'sBIT', 'hIST', 'sPLT',
]);

export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface RawChunk {
  type: string;
  data: Uint8Array;
  /** Offset of the length field in the file. */
  offset: number;
  /** Total bytes including length, type and CRC. */
  size: number;
}

export function readChunks(buf: Uint8Array): RawChunk[] {
  for (let i = 0; i < 8; i++) if (buf[i] !== PNG_SIGNATURE[i]) throw new Error('Not a PNG file');
  const chunks: RawChunk[] = [];
  let o = 8;
  while (o + 8 <= buf.length) {
    const len = u32be(buf, o);
    const type = fourcc(buf, o + 4);
    const end = o + 12 + len;
    if (end > buf.length) {
      chunks.push({ type, data: buf.subarray(o + 8, Math.min(buf.length, o + 8 + len)), offset: o, size: buf.length - o });
      break;
    }
    chunks.push({ type, data: buf.subarray(o + 8, o + 8 + len), offset: o, size: 12 + len });
    o = end;
    if (type === 'IEND') break;
  }
  return chunks;
}

interface Header {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
  palette?: Uint8Array;
  trns?: Uint8Array;
}

interface FrameControl {
  width: number;
  height: number;
  x: number;
  y: number;
  delayNum: number;
  delayDen: number;
  dispose: number;
  blend: number;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

export function decodePng(buf: Uint8Array): RasterImage {
  const warnings: string[] = [];
  const chunks = readChunks(buf);
  const ihdr = chunks[0];
  if (!ihdr || ihdr.type !== 'IHDR' || ihdr.data.length < 13) throw new Error('PNG is missing IHDR');
  const d = ihdr.data;
  const hdr: Header = {
    width: u32be(d, 0),
    height: u32be(d, 4),
    bitDepth: d[8],
    colorType: d[9],
    interlace: d[12],
  };
  if (!CHANNELS[hdr.colorType]) throw new Error(`Unsupported PNG colour type ${hdr.colorType}`);
  if (![1, 2, 4, 8, 16].includes(hdr.bitDepth)) throw new Error(`Unsupported PNG bit depth ${hdr.bitDepth}`);
  if (hdr.width === 0 || hdr.height === 0) throw new Error('PNG has zero size');

  const meta: MetaChunk[] = [];
  const idat: Uint8Array[] = [];
  let actl: { frames: number; plays: number } | null = null;
  const frames: { fc: FrameControl; parts: Uint8Array[] }[] = [];
  let idatIsFrame = false;
  let seenIdat = false;
  let current: { fc: FrameControl; parts: Uint8Array[] } | null = null;

  for (const c of chunks.slice(1)) {
    switch (c.type) {
      case 'PLTE':
        hdr.palette = c.data;
        break;
      case 'tRNS':
        hdr.trns = c.data;
        break;
      case 'IDAT':
        if (!seenIdat && current) idatIsFrame = true;
        seenIdat = true;
        idat.push(c.data);
        if (idatIsFrame && current) current.parts.push(c.data);
        break;
      case 'acTL':
        if (!seenIdat && c.data.length >= 8) actl = { frames: u32be(c.data, 0), plays: u32be(c.data, 4) };
        break;
      case 'fcTL': {
        if (c.data.length < 26) break;
        const f = c.data;
        current = {
          fc: {
            width: u32be(f, 4),
            height: u32be(f, 8),
            x: u32be(f, 12),
            y: u32be(f, 16),
            delayNum: u16be(f, 20),
            delayDen: u16be(f, 22),
            dispose: f[24],
            blend: f[25],
          },
          parts: [],
        };
        frames.push(current);
        break;
      }
      case 'fdAT':
        if (current && c.data.length > 4) current.parts.push(c.data.subarray(4));
        break;
      default:
        if (METADATA_CHUNKS.has(c.type)) meta.push({ type: c.type, data: c.data.slice() });
        else if (!STRUCTURAL.has(c.type) && c.type.charCodeAt(3) & 0x20) meta.push({ type: c.type, data: c.data.slice() });
    }
  }
  if (!idat.length) throw new Error('PNG has no image data');

  const depth: 8 | 16 = hdr.bitDepth === 16 ? 16 : 8;
  const { width, height } = hdr;

  if (!actl || frames.length === 0) {
    const pixels = decodeImage(concat(idat), width, height, hdr, warnings);
    return { width, height, depth, frames: [{ data: pixels, delayNum: 0, delayDen: 100 }], loops: 0, chunks: meta, format: 'png', warnings };
  }

  if (actl.frames !== frames.length) warnings.push(`APNG declares ${actl.frames} frames but contains ${frames.length}`);

  const Arr = depth === 16 ? Uint16Array : Uint8Array;
  const max = depth === 16 ? 0xffff : 0xff;
  let canvas = new Arr(width * height * 4);
  const out: Frame[] = [];

  frames.forEach(({ fc, parts }, i) => {
    if (fc.x + fc.width > width || fc.y + fc.height > height || fc.width === 0 || fc.height === 0) {
      warnings.push(`APNG frame ${i} lies outside the canvas and was skipped`);
      return;
    }
    if (!parts.length) {
      warnings.push(`APNG frame ${i} has no data and was skipped`);
      return;
    }
    const saved = fc.dispose === 2 && i > 0 ? canvas.slice() : null;
    const sub = decodeImage(concat(parts), fc.width, fc.height, hdr, warnings);
    blit(canvas, width, sub, fc, fc.blend === 1, max);
    out.push({ data: canvas.slice(), delayNum: fc.delayNum, delayDen: fc.delayDen || 100 });
    if (fc.dispose === 1 || (fc.dispose === 2 && i === 0)) clearRect(canvas, width, fc);
    else if (saved) canvas = saved;
  });
  if (!out.length) throw new Error('APNG has no decodable frames');

  return { width, height, depth, frames: out, loops: actl.plays, chunks: meta, format: out.length > 1 ? 'apng' : 'png', warnings };
}

function clearRect(canvas: Uint8Array | Uint16Array, width: number, fc: FrameControl) {
  for (let y = fc.y; y < fc.y + fc.height; y++) canvas.fill(0, (y * width + fc.x) * 4, (y * width + fc.x + fc.width) * 4);
}

/** Composite a sub-image onto the canvas (APNG/WebP blend rules, non-premultiplied alpha). */
export function blit(
  canvas: Uint8Array | Uint16Array,
  width: number,
  sub: Uint8Array | Uint16Array,
  r: { x: number; y: number; width: number; height: number },
  over: boolean,
  max: number,
) {
  for (let y = 0; y < r.height; y++) {
    let s = y * r.width * 4;
    let t = ((r.y + y) * width + r.x) * 4;
    if (!over) {
      canvas.set(sub.subarray(s, s + r.width * 4), t);
      continue;
    }
    for (let x = 0; x < r.width; x++, s += 4, t += 4) {
      const sa = sub[s + 3];
      if (sa === max) {
        canvas[t] = sub[s];
        canvas[t + 1] = sub[s + 1];
        canvas[t + 2] = sub[s + 2];
        canvas[t + 3] = sa;
      } else if (sa !== 0) {
        const da = canvas[t + 3];
        const dw = (da * (max - sa)) / max;
        const oa = sa + dw;
        for (let k = 0; k < 3; k++) canvas[t + k] = Math.round((sub[s + k] * sa + canvas[t + k] * dw) / oa);
        canvas[t + 3] = Math.round(oa);
      }
    }
  }
}

function decodeImage(zdata: Uint8Array, width: number, height: number, hdr: Header, warnings: string[]): Uint8Array | Uint16Array {
  let raw: Uint8Array;
  try {
    raw = unzlibSync(zdata);
  } catch {
    warnings.push('PNG image data is corrupt or truncated; missing pixels were left transparent');
    raw = new Uint8Array(0);
  }
  const ch = CHANNELS[hdr.colorType];
  const bits = ch * hdr.bitDepth;
  const bpp = Math.max(1, bits >> 3);
  const out = hdr.bitDepth === 16 ? new Uint16Array(width * height * 4) : new Uint8Array(width * height * 4);
  const conv = makeConverter(hdr);

  const passes = hdr.interlace ? ADAM7 : [[0, 0, 1, 1]];
  let pos = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((width - x0) / dx);
    const ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const rowBytes = Math.ceil((pw * bits) / 8);
    let prev = new Uint8Array(rowBytes);
    let cur = new Uint8Array(rowBytes);
    for (let py = 0; py < ph; py++) {
      if (pos + 1 + rowBytes > raw.length) {
        if (raw.length) warnings.push('PNG image data is truncated');
        return out;
      }
      const ft = raw[pos];
      cur.set(raw.subarray(pos + 1, pos + 1 + rowBytes));
      pos += 1 + rowBytes;
      unfilterRow(ft, cur, prev, bpp);
      conv(cur, pw, out, (y0 + py * dy) * width + x0, dx);
      [prev, cur] = [cur, prev];
    }
  }
  return out;
}

export function unfilterRow(ft: number, cur: Uint8Array, prev: Uint8Array, bpp: number) {
  const n = cur.length;
  switch (ft) {
    case 0:
      break;
    case 1:
      for (let i = bpp; i < n; i++) cur[i] = (cur[i] + cur[i - bpp]) & 0xff;
      break;
    case 2:
      for (let i = 0; i < n; i++) cur[i] = (cur[i] + prev[i]) & 0xff;
      break;
    case 3:
      for (let i = 0; i < bpp; i++) cur[i] = (cur[i] + (prev[i] >> 1)) & 0xff;
      for (let i = bpp; i < n; i++) cur[i] = (cur[i] + ((cur[i - bpp] + prev[i]) >> 1)) & 0xff;
      break;
    case 4:
      for (let i = 0; i < bpp; i++) cur[i] = (cur[i] + prev[i]) & 0xff;
      for (let i = bpp; i < n; i++) cur[i] = (cur[i] + paeth(cur[i - bpp], prev[i], prev[i - bpp])) & 0xff;
      break;
    default:
      throw new Error(`Invalid PNG filter type ${ft}`);
  }
}

export function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

type RowConverter = (row: Uint8Array, count: number, out: Uint8Array | Uint16Array, pixel: number, step: number) => void;

function makeConverter(hdr: Header): RowConverter {
  const { colorType: ct, bitDepth: bd } = hdr;
  const trns = hdr.trns;
  if (ct === 3) {
    const pal = hdr.palette ?? new Uint8Array(0);
    const entries = Math.floor(pal.length / 3);
    const lut = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      if (i < entries) {
        lut[i * 4] = pal[i * 3];
        lut[i * 4 + 1] = pal[i * 3 + 1];
        lut[i * 4 + 2] = pal[i * 3 + 2];
      }
      lut[i * 4 + 3] = trns && i < trns.length ? trns[i] : 255;
    }
    return (row, count, out, pixel, step) => {
      for (let x = 0; x < count; x++) {
        const idx = sampleAt(row, x, bd);
        const o = (pixel + x * step) * 4;
        out[o] = lut[idx * 4];
        out[o + 1] = lut[idx * 4 + 1];
        out[o + 2] = lut[idx * 4 + 2];
        out[o + 3] = lut[idx * 4 + 3];
      }
    };
  }
  const max = bd === 16 ? 0xffff : 0xff;
  const scale = bd < 8 ? 255 / ((1 << bd) - 1) : 1;
  const ch = CHANNELS[ct];
  const read = bd === 16 ? (row: Uint8Array, i: number) => (row[i * 2] << 8) | row[i * 2 + 1] : (row: Uint8Array, i: number) => row[i];
  const grayKey = ct === 0 && trns && trns.length >= 2 ? u16be(trns, 0) : -1;
  const rgbKey = ct === 2 && trns && trns.length >= 6 ? [u16be(trns, 0), u16be(trns, 2), u16be(trns, 4)] : null;

  return (row, count, out, pixel, step) => {
    for (let x = 0; x < count; x++) {
      const o = (pixel + x * step) * 4;
      if (ct === 0) {
        const v = bd < 8 ? sampleAt(row, x, bd) : read(row, x);
        const g = bd < 8 ? Math.round(v * scale) : v;
        out[o] = out[o + 1] = out[o + 2] = g;
        out[o + 3] = v === grayKey ? 0 : max;
      } else if (ct === 2) {
        const r = read(row, x * 3);
        const g = read(row, x * 3 + 1);
        const b = read(row, x * 3 + 2);
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = rgbKey && r === rgbKey[0] && g === rgbKey[1] && b === rgbKey[2] ? 0 : max;
      } else if (ct === 4) {
        const g = read(row, x * 2);
        out[o] = out[o + 1] = out[o + 2] = g;
        out[o + 3] = read(row, x * 2 + 1);
      } else {
        out[o] = read(row, x * ch);
        out[o + 1] = read(row, x * ch + 1);
        out[o + 2] = read(row, x * ch + 2);
        out[o + 3] = read(row, x * ch + 3);
      }
    }
  };
}

function sampleAt(row: Uint8Array, x: number, bd: number): number {
  if (bd === 8) return row[x];
  const perByte = 8 / bd;
  const byte = row[Math.floor(x / perByte)];
  const shift = 8 - bd * ((x % perByte) + 1);
  return (byte >> shift) & ((1 << bd) - 1);
}
