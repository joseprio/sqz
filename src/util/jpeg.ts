import { ByteWriter, concat, latin1, u16be, u32be } from './bytes.js';
import type { GainMap } from '../types.js';

/**
 * JPEG container plumbing: marker segments, ICC / EXIF / XMP, the MPF index that
 * Ultra HDR uses to find its second (gain map) image, and gain map metadata in both
 * the ISO 21496-1 binary form and Adobe's older hdrgm XMP form.
 */

export interface Segment {
  marker: number;
  /** Payload, without the length field. */
  data: Uint8Array;
  /** Offset of the 0xFF of the marker. */
  offset: number;
}

const ICC_ID = 'ICC_PROFILE\0';
const EXIF_ID = 'Exif\0\0';
const XMP_ID = 'http://ns.adobe.com/xap/1.0/\0';
const MPF_ID = 'MPF\0';
const ISO_ID = 'urn:iso:std:iso:ts:21496:-1\0';
const HDRGM_NS = 'http://ns.adobe.com/hdr-gain-map/1.0/';

const startsWith = (d: Uint8Array, id: string) => d.length >= id.length && [...id].every((c, i) => d[i] === c.charCodeAt(0));

export const isJpeg = (b: Uint8Array, at = 0) => b.length >= at + 3 && b[at] === 0xff && b[at + 1] === 0xd8 && b[at + 2] === 0xff;

/** Header segments from SOI up to (not including) the first SOS. */
export function headerSegments(b: Uint8Array, start = 0): Segment[] {
  if (!isJpeg(b, start)) throw new Error('Not a JPEG file');
  const out: Segment[] = [];
  let o = start + 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) throw new Error('Corrupt JPEG header');
    const marker = b[o + 1];
    if (marker === 0xff) {
      o++;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break;
    const len = u16be(b, o + 2);
    out.push({ marker, data: b.subarray(o + 4, Math.min(b.length, o + 2 + len)), offset: o });
    o += 2 + len;
  }
  return out;
}

/** Offset just past the EOI of the JPEG starting at `start`, walking every scan. */
export function jpegEnd(b: Uint8Array, start = 0): number {
  let o = start + 2;
  while (o + 1 < b.length) {
    if (b[o] !== 0xff) {
      o++;
      continue;
    }
    const m = b[o + 1];
    if (m === 0xd9) return o + 2;
    if (m === 0xff || m === 0x00 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      o += m === 0xff ? 1 : 2;
      continue;
    }
    const len = u16be(b, o + 2);
    o += 2 + len;
    if (m === 0xda) {
      // Entropy-coded data runs until the next marker that is not a stuffed byte or restart.
      while (o + 1 < b.length && !(b[o] === 0xff && b[o + 1] !== 0 && (b[o + 1] < 0xd0 || b[o + 1] > 0xd7))) o++;
    }
  }
  return b.length;
}

export interface JpegMeta {
  icc?: Uint8Array;
  exif?: Uint8Array;
  xmp?: Uint8Array;
  /** Number of colour components in the frame header. */
  components: number;
  /** Offsets of further images listed in an MPF index, relative to the file. */
  mpfImages: number[];
  /** ISO 21496-1 payload (after the identifier). */
  iso?: Uint8Array;
}

export function readMeta(b: Uint8Array, start = 0): JpegMeta {
  const segs = headerSegments(b, start);
  const icc: { seq: number; data: Uint8Array }[] = [];
  const meta: JpegMeta = { components: 3, mpfImages: [] };
  for (const s of segs) {
    if (s.marker === 0xe1 && startsWith(s.data, EXIF_ID) && !meta.exif) meta.exif = s.data.subarray(EXIF_ID.length);
    else if (s.marker === 0xe1 && startsWith(s.data, XMP_ID) && !meta.xmp) meta.xmp = s.data.subarray(XMP_ID.length);
    else if (s.marker === 0xe2 && startsWith(s.data, ICC_ID)) icc.push({ seq: s.data[12], data: s.data.subarray(14) });
    else if (s.marker === 0xe2 && startsWith(s.data, ISO_ID)) meta.iso = s.data.subarray(ISO_ID.length);
    else if (s.marker === 0xe2 && startsWith(s.data, MPF_ID)) {
      const tiff = s.offset + 4 + MPF_ID.length;
      meta.mpfImages = readMpf(s.data.subarray(MPF_ID.length))
        .filter((off) => off > 0)
        .map((off) => tiff + off);
    } else if ((s.marker >= 0xc0 && s.marker <= 0xcf && s.marker !== 0xc4 && s.marker !== 0xc8 && s.marker !== 0xcc) && s.data.length >= 6) {
      meta.components = s.data[5];
    }
  }
  if (icc.length) meta.icc = concat(icc.sort((a, z) => a.seq - z.seq).map((c) => c.data));
  return meta;
}

// --- TIFF (MPF and EXIF) ----------------------------------------------------------

function tiffReader(t: Uint8Array) {
  const le = t[0] === 0x49;
  const v = new DataView(t.buffer, t.byteOffset, t.byteLength);
  return {
    u16: (o: number) => v.getUint16(o, le),
    u32: (o: number) => v.getUint32(o, le),
    set16: (o: number, x: number) => v.setUint16(o, x, le),
    ok: t.length >= 8 && (t[0] === 0x49 || t[0] === 0x4d),
  };
}

/** Image offsets (relative to the MPF TIFF header) from an MP Index IFD. */
function readMpf(t: Uint8Array): number[] {
  const r = tiffReader(t);
  if (!r.ok) return [];
  try {
    const ifd = r.u32(4);
    const n = r.u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (r.u16(e) !== 0xb002) continue;
      const count = r.u32(e + 4);
      const at = r.u32(e + 8);
      const out: number[] = [];
      for (let k = 0; k + 16 <= count; k += 16) out.push(r.u32(at + k + 8));
      return out;
    }
  } catch {
    // Truncated index: no extra images.
  }
  return [];
}

/** MPF APP2 payload listing a primary image and one secondary image. */
export function mpfSegment(primarySize: number, secondarySize: number, secondaryOffset: number): Uint8Array {
  const w = new ByteWriter();
  w.bytes(latin1(MPF_ID));
  w.bytes(latin1('MM\0*')).u32(8);
  w.u16(3);
  w.u16(0xb000).u16(7).u32(4).bytes(latin1('0100'));
  w.u16(0xb001).u16(4).u32(1).u32(2);
  w.u16(0xb002).u16(7).u32(32).u32(50);
  w.u32(0);
  // Baseline MP primary image, then a plain JPEG.
  w.u32(0x030000).u32(primarySize).u32(0).u16(0).u16(0);
  w.u32(0).u32(secondarySize).u32(secondaryOffset).u16(0).u16(0);
  return w.done();
}

export const MPF_SEGMENT_SIZE = 4 + MPF_ID.length + 82;

/** EXIF orientation (1–8; 1 when absent) and a copy of the EXIF with it reset to 1. */
export function exifOrientation(exif: Uint8Array): { orientation: number; exif: Uint8Array } {
  const copy = exif.slice();
  const r = tiffReader(copy);
  if (!r.ok) return { orientation: 1, exif: copy };
  try {
    const ifd = r.u32(4);
    const n = r.u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (r.u16(e) !== 0x0112) continue;
      const o = r.u16(e + 8);
      r.set16(e + 8, 1);
      return { orientation: o >= 1 && o <= 8 ? o : 1, exif: copy };
    }
  } catch {
    // Malformed EXIF: leave it alone.
  }
  return { orientation: 1, exif: copy };
}

/** Apply an EXIF orientation to RGBA pixels. */
export function orient(data: Uint8Array, w: number, h: number, o: number): { data: Uint8Array; width: number; height: number } {
  if (o === 1) return { data, width: w, height: h };
  const swap = o >= 5;
  const W = swap ? h : w;
  const H = swap ? w : h;
  const out = new Uint8Array(data.length);
  const src = new Uint32Array(data.buffer, data.byteOffset, w * h);
  const dst = new Uint32Array(out.buffer);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sx: number;
      let sy: number;
      switch (o) {
        case 2: sx = w - 1 - x; sy = y; break;
        case 3: sx = w - 1 - x; sy = h - 1 - y; break;
        case 4: sx = x; sy = h - 1 - y; break;
        case 5: sx = y; sy = x; break;
        case 6: sx = y; sy = h - 1 - x; break;
        case 7: sx = w - 1 - y; sy = h - 1 - x; break;
        default: sx = w - 1 - y; sy = x; break;
      }
      dst[y * W + x] = src[sy * w + sx];
    }
  }
  return { data: out, width: W, height: H };
}

// --- Gain map metadata --------------------------------------------------------------

export type GainMapMetadata = Pick<
  GainMap,
  'min' | 'max' | 'gamma' | 'baseOffset' | 'alternateOffset' | 'baseHdrHeadroom' | 'alternateHdrHeadroom' | 'useBaseColorSpace'
>;

/** ISO 21496-1 GainMapMetadata; null for a version-only payload or an unsupported version. */
export function parseIso(p: Uint8Array): GainMapMetadata | null {
  if (p.length < 5 || u16be(p, 0) !== 0) return null;
  const multi = !!(p[4] & 0x80);
  const channels = multi ? 3 : 1;
  if (p.length < 5 + 16 + channels * 40) return null;
  const s32 = (o: number) => u32be(p, o) | 0;
  const frac = (n: number, d: number) => (d ? n / d : 0);
  const m: GainMapMetadata = {
    useBaseColorSpace: !!(p[4] & 0x40),
    baseHdrHeadroom: frac(u32be(p, 5), u32be(p, 9)),
    alternateHdrHeadroom: frac(u32be(p, 13), u32be(p, 17)),
    min: [],
    max: [],
    gamma: [],
    baseOffset: [],
    alternateOffset: [],
  };
  for (let c = 0; c < 3; c++) {
    const o = 21 + Math.min(c, channels - 1) * 40;
    m.min.push(frac(s32(o), u32be(p, o + 4)));
    m.max.push(frac(s32(o + 8), u32be(p, o + 12)));
    m.gamma.push(frac(u32be(p, o + 16), u32be(p, o + 20)));
    m.baseOffset.push(frac(s32(o + 24), u32be(p, o + 28)));
    m.alternateOffset.push(frac(s32(o + 32), u32be(p, o + 36)));
  }
  return m;
}

/** Best rational approximation with a denominator that fits in 32 bits. */
function fraction(v: number, signed: boolean): [number, number] {
  const limit = signed ? 0x7fffffff : 0xffffffff;
  if (!Number.isFinite(v) || Math.abs(v) > limit) return [0, 1];
  let [h0, h1, k0, k1] = [0, 1, 1, 0];
  let x = Math.abs(v);
  for (let i = 0; i < 32; i++) {
    const a = Math.floor(x);
    const h2 = a * h1 + h0;
    const k2 = a * k1 + k0;
    if (h2 > limit || k2 > 0xffffffff) break;
    [h0, h1, k0, k1] = [h1, h2, k1, k2];
    if (x - a < 1e-12 || Math.abs(h1 / k1 - Math.abs(v)) < 1e-12) break;
    x = 1 / (x - a);
  }
  return [v < 0 ? -h1 : h1, k1 || 1];
}

/** ISO 21496-1 payload: the full metadata, or only the version (for the primary image). */
export function isoSegment(m: GainMapMetadata | null): Uint8Array {
  const w = new ByteWriter();
  w.bytes(latin1(ISO_ID)).u16(0).u16(0);
  if (!m) return w.done();
  const same = (a: number[]) => a[1] === a[0] && a[2] === a[0];
  const multi = ![m.min, m.max, m.gamma, m.baseOffset, m.alternateOffset].every(same);
  w.u8((multi ? 0x80 : 0) | (m.useBaseColorSpace ? 0x40 : 0));
  const put = (v: number, signed: boolean) => {
    const [n, d] = fraction(v, signed);
    w.u32(n >>> 0).u32(d);
  };
  put(m.baseHdrHeadroom, false);
  put(m.alternateHdrHeadroom, false);
  for (let c = 0; c < (multi ? 3 : 1); c++) {
    put(m.min[c], true);
    put(m.max[c], true);
    put(m.gamma[c], false);
    put(m.baseOffset[c], true);
    put(m.alternateOffset[c], true);
  }
  return w.done();
}

const xmpText = (x: Uint8Array) => new TextDecoder().decode(x);

/** Gain map metadata from Adobe's hdrgm XMP; null when absent or the base is the HDR one. */
export function parseHdrgm(xmp: Uint8Array): GainMapMetadata | null {
  const s = xmpText(xmp);
  if (!s.includes(HDRGM_NS)) return null;
  const values = (name: string, fallback: number): number[] | null => {
    const attr = new RegExp(`hdrgm:${name}\\s*=\\s*["']([^"']*)["']`).exec(s);
    if (attr) return [0, 1, 2].map(() => Number(attr[1]));
    const el = new RegExp(`<hdrgm:${name}>([\\s\\S]*?)</hdrgm:${name}>`).exec(s);
    if (el) {
      const li = [...el[1].matchAll(/<rdf:li[^>]*>([^<]*)<\/rdf:li>/g)].map((x) => Number(x[1]));
      if (li.length === 3) return li;
      if (li.length === 1) return [li[0], li[0], li[0]];
      const plain = Number(el[1].trim());
      return [plain, plain, plain];
    }
    return Number.isNaN(fallback) ? null : [fallback, fallback, fallback];
  };
  if (/hdrgm:BaseRenditionIsHDR\s*=\s*["']True["']/i.test(s)) return null;
  const max = values('GainMapMax', NaN);
  const capMax = values('HDRCapacityMax', NaN);
  if (!max || !capMax) return null;
  const m: GainMapMetadata = {
    min: values('GainMapMin', 0)!,
    max,
    gamma: values('Gamma', 1)!,
    baseOffset: values('OffsetSDR', 1 / 64)!,
    alternateOffset: values('OffsetHDR', 1 / 64)!,
    baseHdrHeadroom: values('HDRCapacityMin', 0)![0],
    alternateHdrHeadroom: capMax[0],
    useBaseColorSpace: true,
  };
  return [...m.min, ...m.max, ...m.gamma, ...m.baseOffset, ...m.alternateOffset, m.baseHdrHeadroom, m.alternateHdrHeadroom].some(Number.isNaN) ? null : m;
}

const XMP_HEAD = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">';
const XMP_TAIL = '</rdf:RDF></x:xmpmeta>';

/** hdrgm XMP for the gain map image, for readers that predate ISO 21496-1. */
export function hdrgmXmp(m: GainMapMetadata): Uint8Array {
  const num = (v: number) => String(Number(v.toPrecision(9)));
  const attrs: string[] = [];
  const elems: string[] = [];
  const put = (name: string, v: number[]) => {
    if (v[1] === v[0] && v[2] === v[0]) attrs.push(`hdrgm:${name}="${num(v[0])}"`);
    else elems.push(`<hdrgm:${name}><rdf:Seq>${v.map((x) => `<rdf:li>${num(x)}</rdf:li>`).join('')}</rdf:Seq></hdrgm:${name}>`);
  };
  put('GainMapMin', m.min);
  put('GainMapMax', m.max);
  put('Gamma', m.gamma);
  put('OffsetSDR', m.baseOffset);
  put('OffsetHDR', m.alternateOffset);
  const head = `<rdf:Description rdf:about="" xmlns:hdrgm="${HDRGM_NS}" hdrgm:Version="1.0" ${attrs.join(' ')} hdrgm:HDRCapacityMin="${num(m.baseHdrHeadroom)}" hdrgm:HDRCapacityMax="${num(m.alternateHdrHeadroom)}" hdrgm:BaseRenditionIsHDR="False"`;
  return new TextEncoder().encode(XMP_HEAD + (elems.length ? `${head}>${elems.join('')}</rdf:Description>` : `${head}/>`) + XMP_TAIL);
}

/** The Ultra HDR container description for the primary image, merged into existing XMP. */
export function containerXmp(existing: Uint8Array | undefined, gainMapLength: number): Uint8Array {
  const desc =
    `<rdf:Description rdf:about="" xmlns:hdrgm="${HDRGM_NS}" xmlns:Container="http://ns.google.com/photos/1.0/container/" ` +
    `xmlns:Item="http://ns.google.com/photos/1.0/container/item/" hdrgm:Version="1.0"><Container:Directory><rdf:Seq>` +
    `<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/></rdf:li>` +
    `<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="${gainMapLength}"/></rdf:li>` +
    `</rdf:Seq></Container:Directory></rdf:Description>`;
  const s = existing ? xmpText(existing) : '';
  const at = s.lastIndexOf('</rdf:RDF>');
  return new TextEncoder().encode(at >= 0 ? s.slice(0, at) + desc + s.slice(at) : XMP_HEAD + desc + XMP_TAIL);
}

/**
 * XMP without the gain map container description, which only makes sense next to the
 * gain map it points at. Null when nothing else is left.
 */
export function withoutGainMapXmp(xmp: Uint8Array): Uint8Array | null {
  let s = xmpText(xmp);
  if (!s.includes(HDRGM_NS) && !s.includes('Container:Directory')) return xmp;
  s = s.replace(/<rdf:Description\b(?:[^>"']|"[^"]*"|'[^']*')*?(?:\/>|>[\s\S]*?<\/rdf:Description>)/g, (d) =>
    /hdrgm:|Container:Directory/.test(d) ? '' : d,
  );
  return /<rdf:Description\b/.test(s) ? new TextEncoder().encode(s) : null;
}

// --- Writing ------------------------------------------------------------------------

export function segment(marker: number, payload: Uint8Array): Uint8Array {
  if (payload.length + 2 > 0xffff) throw new Error('JPEG segment too large');
  const out = new Uint8Array(payload.length + 4);
  out[0] = 0xff;
  out[1] = marker;
  out[2] = (payload.length + 2) >> 8;
  out[3] = (payload.length + 2) & 0xff;
  out.set(payload, 4);
  return out;
}

export const exifSegment = (exif: Uint8Array) => segment(0xe1, concat([latin1(EXIF_ID), exif]));
export const xmpSegment = (xmp: Uint8Array) => segment(0xe1, concat([latin1(XMP_ID), xmp]));
export const MAX_XMP = 0xffff - 2 - XMP_ID.length;
export const MAX_EXIF = 0xffff - 2 - EXIF_ID.length;

export function iccSegments(icc: Uint8Array): Uint8Array[] {
  const max = 0xffff - 2 - ICC_ID.length - 2;
  const n = Math.ceil(icc.length / max);
  if (n > 255) throw new Error('ICC profile too large for JPEG');
  return [...Array(n).keys()].map((i) => segment(0xe2, concat([latin1(ICC_ID), new Uint8Array([i + 1, n]), icc.subarray(i * max, (i + 1) * max)])));
}

/** Insert segments into an encoder's output, after SOI and a leading JFIF APP0. */
export function withSegments(jpeg: Uint8Array, segs: Uint8Array[]): Uint8Array {
  let at = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + u16be(jpeg, 4);
  return concat([jpeg.subarray(0, at), ...segs, jpeg.subarray(at)]);
}
