import { avifModule } from '../codecs.js';
import { repetitionsFromLoops } from '../decode/avif.js';
import { portableMeta } from '../util/meta.js';
import { PRIMARIES, TRANSFER, type Colour } from '../process/hdr.js';
import type { Effort, Frame, GainMap, MetaChunk } from '../types.js';

export interface AvifInput {
  width: number;
  height: number;
  /** Full canvases, canonicalised and de-duplicated. More than one makes an image sequence. */
  frames: Frame[];
  /** 8 with Uint8Array frames; 10 or 12 with Uint16Array (0–65535) frames. */
  depth?: 8 | 10 | 12;
  /** Written as the CICP colour description; sRGB by default. */
  colour?: Colour;
  /** [maxCLL, maxPALL] in cd/m². */
  clli?: [number, number] | null;
  gainMap?: GainMap;
  loops: number;
  chunks: MetaChunk[];
  lossless: boolean;
  quality: number;
  /** Lossy only: chroma subsampling to 4:2:0 (smaller) instead of 4:4:4 (sharper colour edges). */
  subsample: boolean;
  effort: Effort;
  onProgress?: (stage: string, fraction: number) => void;
}

const speedFor = (effort: Effort) => (effort === 'fast' ? 8 : effort === 'max' ? 3 : 6);

function hasAlpha(frames: Frame[]): boolean {
  for (const f of frames) {
    const opaque = f.data instanceof Uint16Array ? 65535 : 255;
    for (let i = 3; i < f.data.length; i += 4) if (f.data[i] !== opaque) return true;
  }
  return false;
}

async function encode(
  frames: Frame[],
  width: number,
  height: number,
  opts: {
    lossless: boolean;
    quality: number;
    subsample: boolean;
    speed: number;
    loops: number;
    chunks: MetaChunk[];
    depth?: 8 | 10 | 12;
    colour?: Colour;
    clli?: [number, number] | null;
    gainMap?: GainMap;
  },
  onFrame?: (i: number) => void,
): Promise<Uint8Array> {
  const m = await avifModule();
  const meta = portableMeta(opts.chunks);
  const enc = new m.Encoder(width, height, {
    quality: opts.quality,
    speed: opts.speed,
    lossless: opts.lossless,
    subsample: !opts.lossless && opts.subsample,
    frames: frames.length,
    repetitionCount: repetitionsFromLoops(opts.loops),
    icc: meta.icc ?? false,
    exif: meta.exif ?? false,
    xmp: meta.xmp ?? false,
    depth: opts.depth ?? 8,
    primaries: opts.colour?.primaries ?? PRIMARIES.BT709,
    transfer: opts.colour?.transfer ?? TRANSFER.SRGB,
    clli: opts.clli ?? false,
    gainMap: opts.gainMap ?? false,
    qualityGainMap: Math.max(opts.quality, 80),
  });
  try {
    // Every frame of a sequence must agree on having an alpha plane.
    const alpha = hasAlpha(frames);
    frames.forEach((f, i) => {
      const ms = frames.length > 1 ? (f.delayNum / (f.delayDen || 100)) * 1000 : 0;
      const err = enc.add(f.data, ms, alpha);
      if (err) throw new Error(`AVIF ${err}`);
      onFrame?.(i);
    });
    const out = enc.finish();
    if ('error' in out) throw new Error(`AVIF ${out.error}`);
    return out;
  } finally {
    enc.delete();
  }
}

export async function encodeAvif(input: AvifInput): Promise<{ data: Uint8Array; description: string; warnings: string[] }> {
  const warnings: string[] = [];
  const meta = portableMeta(input.chunks);
  const dropped = meta.dropped.filter((t) => t !== 'sRGB' && t !== 'cICP' && t !== 'cLLI');
  if (dropped.length) warnings.push(`AVIF cannot store ${[...new Set(dropped)].join(', ')} metadata; it was dropped`);
  const n = input.frames.length;
  input.onProgress?.('compress', 0);
  const data = await encode(
    input.frames,
    input.width,
    input.height,
    {
      lossless: input.lossless,
      quality: input.quality,
      subsample: input.subsample,
      speed: speedFor(input.effort),
      loops: input.loops,
      chunks: input.chunks,
      depth: input.depth,
      colour: input.colour,
      clli: input.clli,
      gainMap: input.gainMap,
    },
    (i) => input.onProgress?.('compress', (i + 1) / n),
  );
  let kind = input.lossless ? 'AVIF lossless' : `AVIF lossy q${input.quality}${input.subsample ? '' : ' 4:4:4'}`;
  if (input.depth && input.depth > 8) kind += `, ${input.depth}-bit`;
  const t = input.colour?.transfer;
  if (t === TRANSFER.PQ || t === TRANSFER.HLG) kind += `, HDR ${t === TRANSFER.PQ ? 'PQ' : 'HLG'}`;
  if (input.gainMap) kind += ', gain map';
  return { data, description: n > 1 ? `${kind}, animated` : kind, warnings };
}

/**
 * Encode one still at `quality` with the final settings and decode it again, for the
 * target search. Uint16Array input is encoded at `depth` and comes back as 16 bits.
 */
export async function avifRoundTrip<T extends Uint8Array | Uint16Array>(
  rgba: T,
  width: number,
  height: number,
  quality: number,
  effort: Effort,
  subsample = true,
  depth: 8 | 10 | 12 = 8,
  colour?: Colour,
): Promise<T> {
  const opts = { lossless: false, quality, subsample, speed: speedFor(effort), loops: 0, chunks: [], depth, colour };
  const file = await encode([{ data: rgba, delayNum: 0, delayDen: 100 }], width, height, opts);
  const m = await avifModule();
  const r = m.decode(file, depth > 8);
  if ('error' in r && r.error) throw new Error(`AVIF round trip failed (${r.error})`);
  return (r as Exclude<typeof r, { error: string }>).frames[0].data as T;
}

/**
 * The AVIF bit depth for 16-bit frames: the smallest of 10 and 12 that holds every
 * sample exactly (as a 10- or 12-bit source decoded to 16 bits does), otherwise 12.
 */
export function avifDepth(frames: Frame[]): 10 | 12 {
  for (const bits of [10, 12] as const) {
    const max = (1 << bits) - 1;
    const exact = frames.every((f) => {
      const d = f.data;
      for (let i = 0; i < d.length; i++) {
        if (Math.round((Math.round((d[i] * max) / 65535) * 65535) / max) !== d[i]) return false;
      }
      return true;
    });
    if (exact) return bits;
  }
  return 12;
}
