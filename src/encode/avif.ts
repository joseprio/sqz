import { avifModule } from '../codecs.js';
import { repetitionsFromLoops } from '../decode/avif.js';
import { portableMeta } from '../util/meta.js';
import type { Effort, Frame, MetaChunk } from '../types.js';

export interface AvifInput {
  width: number;
  height: number;
  /** 8-bit full canvases, canonicalised and de-duplicated. More than one makes an image sequence. */
  frames: Frame[];
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
  for (const f of frames) for (let i = 3; i < f.data.length; i += 4) if (f.data[i] !== 255) return true;
  return false;
}

async function encode(
  frames: Frame[],
  width: number,
  height: number,
  opts: { lossless: boolean; quality: number; subsample: boolean; speed: number; loops: number; chunks: MetaChunk[] },
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
  });
  try {
    // Every frame of a sequence must agree on having an alpha plane.
    const alpha = hasAlpha(frames);
    frames.forEach((f, i) => {
      const ms = frames.length > 1 ? (f.delayNum / (f.delayDen || 100)) * 1000 : 0;
      const err = enc.add(f.data as Uint8Array, ms, alpha);
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
  const dropped = meta.dropped.filter((t) => t !== 'sRGB');
  if (dropped.length) warnings.push(`AVIF cannot store ${[...new Set(dropped)].join(', ')} metadata; it was dropped`);
  const n = input.frames.length;
  input.onProgress?.('compress', 0);
  const data = await encode(
    input.frames,
    input.width,
    input.height,
    { lossless: input.lossless, quality: input.quality, subsample: input.subsample, speed: speedFor(input.effort), loops: input.loops, chunks: input.chunks },
    (i) => input.onProgress?.('compress', (i + 1) / n),
  );
  const kind = input.lossless ? 'AVIF lossless' : `AVIF lossy q${input.quality}${input.subsample ? '' : ' 4:4:4'}`;
  return { data, description: n > 1 ? `${kind}, animated` : kind, warnings };
}

/** Encode one still at `quality` with the final settings and decode it again, for the target search. */
export async function avifRoundTrip(rgba: Uint8Array, width: number, height: number, quality: number, effort: Effort, subsample = true): Promise<Uint8Array> {
  const file = await encode([{ data: rgba, delayNum: 0, delayDen: 100 }], width, height, { lossless: false, quality, subsample, speed: speedFor(effort), loops: 0, chunks: [] });
  const m = await avifModule();
  const r = m.decode(file, false);
  if ('error' in r && r.error) throw new Error(`AVIF round trip failed (${r.error})`);
  return (r as Exclude<typeof r, { error: string }>).frames[0].data as Uint8Array;
}
