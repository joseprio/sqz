/**
 * Colour analysis and pixel packing: picks the PNG colour types an image can be stored
 * in without losing anything, and serialises RGBA pixels into raw scanlines for them.
 */

export type PaletteOrder = 'frequency' | 'luma' | 'appearance';

export type ColorMode =
  | { kind: 'palette'; bitDepth: 1 | 2 | 4 | 8; palette: Uint32Array; order: PaletteOrder }
  | { kind: 'gray'; bitDepth: 1 | 2 | 4 | 8 | 16; key?: number }
  | { kind: 'graya'; bitDepth: 8 | 16 }
  | { kind: 'rgb'; bitDepth: 8 | 16; key?: [number, number, number] }
  | { kind: 'rgba'; bitDepth: 8 | 16 };

export interface Pixels {
  data: Uint8Array | Uint16Array;
  width: number;
  height: number;
}

export const PNG_COLOR_TYPE = { gray: 0, rgb: 2, palette: 3, graya: 4, rgba: 6 } as const;

export function describeMode(m: ColorMode): string {
  const name = { palette: 'palette', gray: 'grayscale', graya: 'grayscale+alpha', rgb: 'RGB', rgba: 'RGBA' }[m.kind];
  const extra = m.kind === 'palette' ? ` (${m.palette.length} colours)` : 'key' in m && m.key !== undefined ? ' + tRNS' : '';
  return `${name} ${m.bitDepth}-bit${extra}`;
}

/** Bytes per complete pixel, as used by PNG filters (minimum 1). */
export function filterBpp(m: ColorMode): number {
  const ch = { palette: 1, gray: 1, graya: 2, rgb: 3, rgba: 4 }[m.kind];
  return Math.max(1, (ch * m.bitDepth) >> 3);
}

export function rowBytes(m: ColorMode, width: number): number {
  const ch = { palette: 1, gray: 1, graya: 2, rgb: 3, rgba: 4 }[m.kind];
  return Math.ceil((width * ch * m.bitDepth) / 8);
}

/** Where the alpha bytes sit inside a pixel, for transparent-pixel filling during filtering. */
export function alphaLayout(m: ColorMode): { bpp: number; alpha: number; size: number } | null {
  if (m.kind === 'rgba') return m.bitDepth === 8 ? { bpp: 4, alpha: 3, size: 1 } : { bpp: 8, alpha: 6, size: 2 };
  if (m.kind === 'graya') return m.bitDepth === 8 ? { bpp: 2, alpha: 1, size: 1 } : { bpp: 4, alpha: 2, size: 2 };
  return null;
}

interface Stats {
  opaque: boolean;
  binaryAlpha: boolean;
  gray: boolean;
  /** Smallest gray bit depth that represents every visible gray level exactly. */
  grayDepth: 1 | 2 | 4 | 8 | 16;
  /** Packed RGBA → count, in first-appearance order; null when > 256 colours. */
  colors: Map<number, number> | null;
}

function analyze(images: Pixels[], depth: 8 | 16): Stats {
  const max = depth === 16 ? 0xffff : 0xff;
  let opaque = true;
  let binaryAlpha = true;
  let gray = true;
  let colors: Map<number, number> | null = depth === 8 ? new Map() : null;
  // Gray level divisibility: 255 → 1-bit, 85 → 2-bit, 17 → 4-bit.
  let div1 = true;
  let div2 = true;
  let div4 = true;
  for (const img of images) {
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      const a = d[i + 3];
      if (a !== max) {
        opaque = false;
        if (a !== 0) binaryAlpha = false;
      }
      if (a !== 0 && gray) {
        if (r !== g || g !== b) gray = false;
        else if (depth === 8) {
          if (r % 255) div1 = false;
          if (r % 85) div2 = false;
          if (r % 17) div4 = false;
        }
      }
      if (colors) {
        const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
        const n = colors.get(key);
        if (n === undefined) {
          if (colors.size >= 256) colors = null;
          else colors.set(key, 1);
        } else colors.set(key, n + 1);
      }
    }
  }
  const grayDepth = depth === 16 ? 16 : div1 ? 1 : div2 ? 2 : div4 ? 4 : 8;
  return { opaque, binaryAlpha, gray, grayDepth, colors };
}

/** A gray level (at `bitDepth`) that no opaque pixel uses, for a tRNS key. */
function findGrayKey(images: Pixels[], bitDepth: number, depth: 8 | 16): number | undefined {
  const levels = 1 << bitDepth;
  const used = new Uint8Array(levels);
  const div = depth === 8 && bitDepth < 8 ? 255 / (levels - 1) : 1;
  for (const img of images) {
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] !== 0) used[d[i] / div] = 1;
  }
  const k = used.indexOf(0);
  return k < 0 ? undefined : k;
}

function findRgbKey(images: Pixels[], depth: 8 | 16): [number, number, number] | undefined {
  if (depth === 8) {
    const used = new Uint8Array(1 << 21); // one bit per 24-bit colour
    for (const img of images) {
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const c = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
        used[c >> 3] |= 1 << (c & 7);
      }
    }
    for (let i = 0; i < used.length; i++) {
      if (used[i] === 0xff) continue;
      for (let bit = 0; bit < 8; bit++) {
        if (!(used[i] & (1 << bit))) {
          const c = (i << 3) | bit;
          return [c >> 16, (c >> 8) & 0xff, c & 0xff];
        }
      }
    }
    return undefined;
  }
  const used = new Set<number>();
  for (const img of images) {
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] !== 0) used.add(d[i] * 2 ** 32 + d[i + 1] * 65536 + d[i + 2]);
  }
  for (let c = 0; ; c++) if (!used.has(c)) return [0, Math.floor(c / 65536), c % 65536];
}

function sortPalette(colors: Map<number, number>, order: PaletteOrder): Uint32Array {
  const entries = [...colors.entries()];
  const alpha = (c: number) => c & 0xff;
  if (order === 'frequency') entries.sort((a, b) => b[1] - a[1]);
  else if (order === 'luma') {
    const luma = (c: number) => 299 * (c >>> 24) + 587 * ((c >>> 16) & 0xff) + 114 * ((c >>> 8) & 0xff);
    entries.sort((a, b) => alpha(a[0]) - alpha(b[0]) || luma(a[0]) - luma(b[0]));
  }
  // tRNS only needs to cover entries up to the last translucent one, so put those first.
  const translucent = entries.filter(([c]) => alpha(c) !== 0xff);
  const solid = entries.filter(([c]) => alpha(c) === 0xff);
  return Uint32Array.from([...translucent, ...solid].map(([c]) => c));
}

/** Every lossless colour mode worth trying for these pixels, best guess first. */
export function candidateModes(images: Pixels[], depth: 8 | 16, thorough: boolean): ColorMode[] {
  const s = analyze(images, depth);
  const out: ColorMode[] = [];

  if (s.colors) {
    const n = s.colors.size;
    const bitDepth = n <= 2 ? 1 : n <= 4 ? 2 : n <= 16 ? 4 : 8;
    const orders: PaletteOrder[] = thorough ? ['frequency', 'luma', 'appearance'] : ['frequency'];
    for (const order of orders) out.push({ kind: 'palette', bitDepth, palette: sortPalette(s.colors, order), order });
  }

  if (s.gray) {
    if (s.opaque) out.push({ kind: 'gray', bitDepth: s.grayDepth });
    else {
      const key = s.binaryAlpha ? findGrayKey(images, s.grayDepth, depth) : undefined;
      if (key !== undefined) out.push({ kind: 'gray', bitDepth: s.grayDepth, key });
      else out.push({ kind: 'graya', bitDepth: depth });
    }
  }

  if (!s.gray && (!s.colors || thorough)) {
    if (s.opaque) out.push({ kind: 'rgb', bitDepth: depth });
    else {
      const key = s.binaryAlpha ? findRgbKey(images, depth) : undefined;
      if (key) out.push({ kind: 'rgb', bitDepth: depth, key });
      else out.push({ kind: 'rgba', bitDepth: depth });
    }
  }
  return out;
}

/** Serialise RGBA pixels into unfiltered PNG scanlines (no filter-type bytes). */
export function pack(img: Pixels, m: ColorMode): Uint8Array {
  const { width, height, data: d } = img;
  const rb = rowBytes(m, width);
  const out = new Uint8Array(rb * height);

  if (m.kind === 'palette' || (m.kind === 'gray' && m.bitDepth < 8)) {
    const index = new Map<number, number>();
    if (m.kind === 'palette') m.palette.forEach((c, i) => index.set(c, i));
    const bd = m.bitDepth;
    const div = m.kind === 'gray' ? 255 / ((1 << bd) - 1) : 1;
    const key = m.kind === 'gray' ? m.key : undefined;
    const perByte = 8 / bd;
    for (let y = 0; y < height; y++) {
      const row = y * rb;
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        let v: number;
        if (m.kind === 'palette') v = index.get(((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]) >>> 0)!;
        else v = d[i + 3] === 0 && key !== undefined ? key : d[i] / div;
        if (bd === 8) out[row + x] = v;
        else out[row + Math.floor(x / perByte)] |= v << (8 - bd * ((x % perByte) + 1));
      }
    }
    return out;
  }

  const wide = m.bitDepth === 16;
  let o = 0;
  const put = wide
    ? (v: number) => {
        out[o++] = v >> 8;
        out[o++] = v & 0xff;
      }
    : (v: number) => {
        out[o++] = v;
      };
  const n = width * height * 4;
  switch (m.kind) {
    case 'gray':
      for (let i = 0; i < n; i += 4) put(d[i + 3] === 0 && m.key !== undefined ? m.key : d[i]);
      break;
    case 'graya':
      for (let i = 0; i < n; i += 4) {
        put(d[i]);
        put(d[i + 3]);
      }
      break;
    case 'rgb':
      for (let i = 0; i < n; i += 4) {
        if (d[i + 3] === 0 && m.key) {
          put(m.key[0]);
          put(m.key[1]);
          put(m.key[2]);
        } else {
          put(d[i]);
          put(d[i + 1]);
          put(d[i + 2]);
        }
      }
      break;
    case 'rgba':
      for (let i = 0; i < n; i++) put(d[i]);
      break;
  }
  return out;
}
