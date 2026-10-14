import { unzlibSync } from 'fflate';
import { avifModule } from '../codecs.js';
import { u32be } from '../util/bytes.js';
import { cicpChunk } from '../util/meta.js';
import type { Frame, GainMap, MetaChunk, RasterImage } from '../types.js';

/**
 * HDR handling. Three kinds of image reach the encoders:
 *  - SDR: 8 or 16 bits, colour described by ICC / cICP / nothing (sRGB);
 *  - gain map: SDR frames plus a gain map (Ultra HDR JPEG, AVIF with tmap);
 *  - PQ / HLG: 16-bit frames whose cICP chunk names an HDR transfer.
 * Linear light uses libavif's convention: 1.0 is SDR white (203 nits).
 */

// ITU-T H.273 code points.
export const PRIMARIES = { BT709: 1, BT2020: 9, P3: 12 } as const;
export const TRANSFER = { SRGB: 13, PQ: 16, HLG: 18 } as const;

export interface Colour {
  primaries: number;
  transfer: number;
}

const SRGB: Colour = { primaries: PRIMARIES.BT709, transfer: TRANSFER.SRGB };
const SDR_WHITE = 203;

/** Chunks that describe the colour space of the pixels. */
export const COLOUR_CHUNKS = new Set(['iCCP', 'sRGB', 'gAMA', 'cHRM', 'cICP', 'mDCV', 'cLLI']);

export function cicpOf(chunks: MetaChunk[]): Colour | null {
  const c = chunks.find((x) => x.type === 'cICP');
  return c && c.data.length >= 2 ? { primaries: c.data[0], transfer: c.data[1] } : null;
}

export function hdrTransfer(img: RasterImage): boolean {
  const c = cicpOf(img.chunks);
  return !!c && (c.transfer === TRANSFER.PQ || c.transfer === TRANSFER.HLG);
}

/**
 * Primaries and transfer of the pixels, as far as gain map maths needs them: cICP wins,
 * then a recognised ICC profile (assumed to use the sRGB curve, as sRGB and Display P3
 * do), then plain sRGB. Null for an ICC profile with unrecognised primaries.
 */
export function colourOf(chunks: MetaChunk[]): Colour | null {
  const cicp = cicpOf(chunks);
  if (cicp) return cicp;
  const icc = iccOf(chunks);
  if (!icc) return SRGB;
  const p = iccPrimaries(icc);
  return p === null ? null : { primaries: p, transfer: TRANSFER.SRGB };
}

export function iccOf(chunks: MetaChunk[]): Uint8Array | null {
  const c = chunks.find((x) => x.type === 'iCCP');
  if (!c) return null;
  try {
    return unzlibSync(c.data.subarray(c.data.indexOf(0) + 2));
  } catch {
    return null;
  }
}

// --- Colorimetry -------------------------------------------------------------------

type Mat = number[][];
const XY: Record<number, number[][]> = {
  [PRIMARIES.BT709]: [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]],
  [PRIMARIES.P3]: [[0.68, 0.32], [0.265, 0.69], [0.15, 0.06]],
  [PRIMARIES.BT2020]: [[0.708, 0.292], [0.17, 0.797], [0.131, 0.046]],
};
const D65 = [0.3127, 0.329];
const BRADFORD: Mat = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];

const mul = (a: Mat, b: Mat): Mat => a.map((r) => b[0].map((_, j) => r.reduce((s, v, k) => s + v * b[k][j], 0)));
const apply = (m: Mat, v: number[]) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const xyz = ([x, y]: number[]) => [x / y, 1, (1 - x - y) / y];

function inverse(m: Mat): Mat {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [C / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}

/** RGB → XYZ (D65) for a set of primaries. */
function rgbToXyz(primaries: number): Mat {
  const cols = XY[primaries].map(xyz);
  const m: Mat = [0, 1, 2].map((r) => cols.map((c) => c[r]));
  const s = apply(inverse(m), xyz(D65));
  return m.map((r) => r.map((v, j) => v * s[j]));
}

/** Linear RGB in `from` primaries → linear RGB in `to` primaries. */
export function convertMatrix(from: number, to: number): Mat {
  return mul(inverse(rgbToXyz(to)), rgbToXyz(from));
}

/** The D50-adapted colorants an ICC profile stores for each primaries set. */
const ICC_COLORANTS = Object.fromEntries(
  Object.keys(XY).map((p) => {
    const d50 = [0.3457, 0.3585];
    const lmsSrc = apply(BRADFORD, xyz(D65));
    const lmsDst = apply(BRADFORD, xyz(d50));
    const scale: Mat = [0, 1, 2].map((i) => [0, 1, 2].map((j) => (i === j ? lmsDst[i] / lmsSrc[i] : 0)));
    const adapt = mul(inverse(BRADFORD), mul(scale, BRADFORD));
    const m = mul(adapt, rgbToXyz(Number(p)));
    return [p, [0, 1, 2].map((c) => [m[0][c], m[1][c], m[2][c]])];
  }),
) as Record<string, number[][]>;

/** H.273 primaries of an RGB ICC profile, recognised from its colorants; null if unknown. */
export function iccPrimaries(icc: Uint8Array): number | null {
  if (icc.length < 132) return null;
  const space = String.fromCharCode(...icc.subarray(16, 20));
  if (space === 'GRAY') return PRIMARIES.BT709;
  if (space !== 'RGB ') return null;
  const tags = new Map<string, number>();
  const n = u32be(icc, 128);
  for (let i = 0; i < n && 132 + i * 12 + 12 <= icc.length; i++) {
    const o = 132 + i * 12;
    tags.set(String.fromCharCode(...icc.subarray(o, o + 4)), u32be(icc, o + 4));
  }
  const read = (tag: string) => {
    const o = tags.get(tag);
    if (o === undefined || o + 20 > icc.length) return null;
    return [0, 1, 2].map((k) => (u32be(icc, o + 8 + k * 4) | 0) / 65536);
  };
  const got = ['rXYZ', 'gXYZ', 'bXYZ'].map(read);
  if (got.some((g) => !g)) return null;
  for (const [p, want] of Object.entries(ICC_COLORANTS)) {
    if (want.every((w, c) => w.every((v, k) => Math.abs(v - got[c]![k]) < 0.004))) return Number(p);
  }
  return null;
}

// --- Transfer functions -------------------------------------------------------------

const pqToLinear = (v: number) => {
  const p = Math.pow(v, 1 / 78.84375);
  return Math.pow(Math.max(p - 0.8359375, 0) / (18.8515625 - 18.6875 * p), 1 / 0.1593017578125) * (10000 / SDR_WHITE);
};

const hlgToLinear = (v: number) => {
  const a = 0.17883277;
  const b = 1 - 4 * a;
  const c = 0.5 - a * Math.log(4 * a);
  const scene = v <= 0.5 ? (v * v) / 3 : (Math.exp((v - c) / a) + b) / 12;
  // Same per-channel OOTF approximation as libavif, for a 1000-nit display.
  return Math.pow(scene, 1.2) * (1000 / SDR_WHITE);
};

const srgbEncode = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

const luts = new Map<number, Float32Array>();
function linearLut(transfer: number): Float32Array {
  let lut = luts.get(transfer);
  if (!lut) {
    const f = transfer === TRANSFER.PQ ? pqToLinear : hlgToLinear;
    lut = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) lut[i] = f(i / 65535);
    luts.set(transfer, lut);
  }
  return lut;
}

/**
 * Tone map PQ / HLG frames to 8-bit sRGB: a hue-preserving curve on max(R,G,B) that is
 * the identity up to a knee and rolls the brightest content off to SDR white.
 */
export function toneMapToSdr(frames: Frame[], colour: Colour): Frame[] {
  const lut = linearLut(colour.transfer);
  const m = convertMatrix(colour.primaries in XY ? colour.primaries : PRIMARIES.BT2020, PRIMARIES.BT709);
  let peak = 1;
  for (const f of frames) {
    const d = f.data;
    for (let i = 0; i < d.length; i += 4) peak = Math.max(peak, lut[d[i]], lut[d[i + 1]], lut[d[i + 2]]);
  }
  const knee = 0.7;
  const xp = (peak - knee) / (1 - knee);
  const enc = new Uint8Array(4097);
  for (let i = 0; i <= 4096; i++) enc[i] = Math.round(srgbEncode(i / 4096) * 255);
  return frames.map((f) => {
    const d = f.data;
    const out = new Uint8Array(d.length);
    for (let i = 0; i < d.length; i += 4) {
      const r0 = lut[d[i]];
      const g0 = lut[d[i + 1]];
      const b0 = lut[d[i + 2]];
      let r = m[0][0] * r0 + m[0][1] * g0 + m[0][2] * b0;
      let g = m[1][0] * r0 + m[1][1] * g0 + m[1][2] * b0;
      let b = m[2][0] * r0 + m[2][1] * g0 + m[2][2] * b0;
      const max = Math.max(r, g, b);
      if (max > knee && peak > 1) {
        const x = (max - knee) / (1 - knee);
        const s = (knee + (1 - knee) * ((x * (1 + x / (xp * xp))) / (1 + x))) / max;
        r *= s;
        g *= s;
        b *= s;
      }
      out[i] = enc[Math.round(Math.min(1, Math.max(0, r)) * 4096)];
      out[i + 1] = enc[Math.round(Math.min(1, Math.max(0, g)) * 4096)];
      out[i + 2] = enc[Math.round(Math.min(1, Math.max(0, b)) * 4096)];
      out[i + 3] = d[i + 3] >> 8;
    }
    return { ...f, data: out };
  });
}

/** Colour chunks for 8-bit sRGB output, keeping everything else. */
export function sdrChunks(chunks: MetaChunk[]): MetaChunk[] {
  return chunks.filter((c) => !COLOUR_CHUNKS.has(c.type));
}

/** PNG cLLI payload: max content and frame-average light levels in 0.0001 cd/m². */
export function clliChunk(maxCll: number, maxFall: number): MetaChunk {
  const d = new Uint8Array(8);
  new DataView(d.buffer).setUint32(0, Math.round(maxCll * 10000));
  new DataView(d.buffer).setUint32(4, Math.round(maxFall * 10000));
  return { type: 'cLLI', data: d };
}

/** [maxCLL, maxFALL] in cd/m² from a PNG cLLI chunk. */
export function clliOf(chunks: MetaChunk[]): [number, number] | null {
  const c = chunks.find((x) => x.type === 'cLLI');
  if (!c || c.data.length < 8) return null;
  return [Math.round(u32be(c.data, 0) / 10000), Math.round(u32be(c.data, 4) / 10000)];
}

// --- Gain maps ----------------------------------------------------------------------

/**
 * The HDR rendition of a gain map image as 16-bit BT.2020 PQ, with chunks to match.
 * Null when the base image's colour space is not one gain map maths can work in.
 */
export async function renderGainMap(img: RasterImage): Promise<{ frame: Frame; chunks: MetaChunk[] } | null> {
  const gm = img.gainMap!;
  const base = colourOf(img.chunks);
  if (!base || base.transfer !== TRANSFER.SRGB) return null;
  const m = await avifModule();
  const f = img.frames[0];
  const r = m.applyGainMap(f.data as Uint8Array, img.width, img.height, base.primaries, base.transfer, gm, PRIMARIES.BT2020, TRANSFER.PQ);
  if ('error' in r) throw new Error(`Could not apply the gain map (${r.error})`);
  const chunks = [cicpChunk(PRIMARIES.BT2020, TRANSFER.PQ, true), ...sdrChunks(img.chunks)];
  if (r.clli[0]) chunks.splice(1, 0, clliChunk(r.clli[0], r.clli[1]));
  return { frame: { ...f, data: r.data }, chunks };
}

/**
 * Split a PQ / HLG still into an 8-bit sRGB base and the gain map that restores the
 * HDR version, the way Ultra HDR cameras store photos. The map is a quarter of the size.
 */
export async function splitHdr(img: RasterImage): Promise<{ frame: Frame; gainMap: GainMap }> {
  const colour = cicpOf(img.chunks)!;
  const [sdr] = toneMapToSdr([img.frames[0]], colour);
  const m = await avifModule();
  const w = Math.max(1, Math.round(img.width / 4));
  const h = Math.max(1, Math.round(img.height / 4));
  const gm = m.computeGainMap(
    sdr.data as Uint8Array,
    PRIMARIES.BT709,
    TRANSFER.SRGB,
    img.frames[0].data as Uint16Array,
    colour.primaries,
    colour.transfer,
    img.width,
    img.height,
    w,
    h,
    3,
  );
  if ('error' in gm) throw new Error(`Could not compute a gain map (${gm.error})`);
  return { frame: sdr, gainMap: gm };
}
