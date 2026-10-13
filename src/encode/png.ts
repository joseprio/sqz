import { unzlibSync } from 'fflate';
import { ByteWriter, crc32, latin1 } from '../util/bytes.js';
import { PNG_SIGNATURE } from '../decode/png.js';
import type { Effort, Frame, MetaChunk } from '../types.js';
import { alphaLayout, candidateModes, describeMode, filterBpp, pack, PNG_COLOR_TYPE, rowBytes, type ColorMode } from './analyze.js';
import { applyFilter, strategiesFor, type FilterStrategy } from './filter.js';
import { deflateFast, deflateZopfli } from './deflate.js';
import { planFrames, type SubFrame } from './frames.js';

export interface EncodeInput {
  width: number;
  height: number;
  depth: 8 | 16;
  /** Full canvases, already canonicalised and de-duplicated. */
  frames: Frame[];
  loops: number;
  chunks: MetaChunk[];
  effort: Effort;
  /** Per-row filter types suggested by the lossy stage (still images only). */
  hint?: Uint8Array;
  onProgress?: (stage: string, fraction: number) => void;
}

export interface EncodeOutput {
  data: Uint8Array;
  colorType: string;
}

interface Candidate {
  strategy: FilterStrategy;
  filtered: Uint8Array;
  quick: Uint8Array;
}

interface FrameTrial {
  sub: SubFrame;
  candidates: Candidate[]; // best first
}

interface Trial {
  mode: ColorMode;
  frames: FrameTrial[];
  size: number;
}

/** Colour space signature of an embedded ICC profile ('RGB ', 'GRAY', …). */
function iccColorSpace(chunks: MetaChunk[]): string | null {
  const c = chunks.find((x) => x.type === 'iCCP');
  if (!c) return null;
  try {
    const nul = c.data.indexOf(0);
    const profile = unzlibSync(c.data.subarray(nul + 2));
    return String.fromCharCode(...profile.subarray(16, 20));
  } catch {
    return null;
  }
}

function paletteOverhead(m: ColorMode): number {
  if (m.kind !== 'palette') return 0;
  let trns = 0;
  m.palette.forEach((c, i) => {
    if ((c & 0xff) !== 0xff) trns = i + 1;
  });
  return 12 + m.palette.length * 3 + (trns ? 12 + trns : 0);
}

export async function encodePng(input: EncodeInput): Promise<EncodeOutput> {
  const { width, height, depth, frames, effort } = input;
  const progress = input.onProgress ?? (() => {});
  const animated = frames.length > 1;
  const max = depth === 16 ? 0xffff : 0xff;
  // Fast screening doesn't always rank candidates the way zopfli will, so small images send more than one.
  const rawTotal = width * height * 4 * (depth / 8) * frames.length;
  const keep = effort === 'max' ? 3 : rawTotal <= 1 << 20 ? 2 : 1;

  const plans: SubFrame[][] = [];
  if (animated) {
    plans.push(planFrames(frames, width, height, max, false));
    const over = planFrames(frames, width, height, max, true);
    if (over.some((f) => f.blend === 1)) plans.push(over);
  } else {
    plans.push([{ x: 0, y: 0, width, height, data: frames[0].data, blend: 0, delayNum: 0, delayDen: 100 }]);
  }

  const rgbProfile = iccColorSpace(input.chunks) === 'RGB ';
  const level = rawTotal < 4 << 20 ? 9 : 6;

  // Work out how much screening there is, for progress reporting.
  const trialsPlanned: { plan: SubFrame[]; modes: ColorMode[] }[] = plans.map((plan) => {
    let modes = candidateModes(plan, depth, effort !== 'fast');
    if (rgbProfile) modes = modes.filter((m) => m.kind !== 'gray' && m.kind !== 'graya');
    if (!modes.length) modes = [{ kind: 'rgba', bitDepth: depth }];
    return { plan, modes };
  });
  const units = trialsPlanned.reduce((n, t) => n + t.modes.length * t.plan.length, 0);
  let done = 0;

  let best: Trial | null = null;
  for (const { plan, modes } of trialsPlanned) {
    for (const mode of modes) {
      const trial: Trial = { mode, frames: [], size: paletteOverhead(mode) };
      for (const sub of plan) {
        const raw = pack(sub, mode);
        const rb = rowBytes(mode, sub.width);
        const bpp = filterBpp(mode);
        const fill = alphaLayout(mode);
        const hint = !animated && mode.kind !== 'palette' && mode.bitDepth === 8 ? input.hint : undefined;
        const strategies = strategiesFor(mode.bitDepth < 8, raw.length, effort, hint);
        const cands: Candidate[] = [];
        for (const strategy of strategies) {
          const filtered = applyFilter(raw, sub.height, rb, bpp, strategy, fill);
          const quick = deflateFast(filtered, level);
          cands.push({ strategy, filtered, quick });
          cands.sort((a, b) => a.quick.length - b.quick.length);
          if (cands.length > keep) cands.length = keep;
        }
        trial.frames.push({ sub, candidates: cands });
        trial.size += cands[0].quick.length + 38; // + fcTL/fdAT framing
        progress('analyse', ++done / units);
        if (best && trial.size > best.size * 1.5) break; // hopeless, skip the rest of this trial
      }
      if (trial.frames.length === plan.length && (!best || trial.size < best.size)) best = trial;
    }
  }
  if (!best) throw new Error('internal: no encoding candidate');

  // Final compression pass.
  const streams: Uint8Array[] = [];
  const zopfliEffort = effort === 'fast' ? null : effort;
  const work = best.frames.reduce((n, f) => n + f.candidates.reduce((m, c) => m + c.filtered.length, 0), 0);
  let worked = 0;
  for (const f of best.frames) {
    let smallest = f.candidates[0].quick;
    if (zopfliEffort) {
      for (const c of f.candidates) {
        progress('compress', worked / work);
        const z = await deflateZopfli(c.filtered, zopfliEffort);
        if (z.length < smallest.length) smallest = z;
        worked += c.filtered.length;
      }
    }
    streams.push(smallest);
  }
  progress('compress', 1);

  return { data: writePng(input, best.mode, best.frames.map((f) => f.sub), streams), colorType: describeMode(best.mode) };
}

function writePng(input: EncodeInput, mode: ColorMode, subs: SubFrame[], streams: Uint8Array[]): Uint8Array {
  const w = new ByteWriter();
  w.bytes(PNG_SIGNATURE);
  const chunk = (type: string, data: Uint8Array) => {
    const t = latin1(type);
    w.u32(data.length).bytes(t).bytes(data).u32(crc32([t, data]));
  };
  const body = () => new ByteWriter();

  chunk(
    'IHDR',
    body().u32(input.width).u32(input.height).u8(mode.bitDepth).u8(PNG_COLOR_TYPE[mode.kind]).u8(0).u8(0).u8(0).done(),
  );
  const animated = subs.length > 1;
  if (animated) chunk('acTL', body().u32(subs.length).u32(input.loops).done());

  // Colour-space chunks must precede PLTE; everything else is allowed there too.
  const order = ['iCCP', 'sRGB', 'cICP', 'gAMA', 'cHRM', 'mDCV', 'cLLI'];
  const meta = [...input.chunks].sort((a, b) => {
    const ia = order.indexOf(a.type);
    const ib = order.indexOf(b.type);
    return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib);
  });
  for (const c of meta) chunk(c.type, c.data);

  if (mode.kind === 'palette') {
    const plte = new Uint8Array(mode.palette.length * 3);
    let trnsLen = 0;
    mode.palette.forEach((c, i) => {
      plte[i * 3] = c >>> 24;
      plte[i * 3 + 1] = (c >>> 16) & 0xff;
      plte[i * 3 + 2] = (c >>> 8) & 0xff;
      if ((c & 0xff) !== 0xff) trnsLen = i + 1;
    });
    chunk('PLTE', plte);
    if (trnsLen) chunk('tRNS', Uint8Array.from(mode.palette.subarray(0, trnsLen), (c) => c & 0xff));
  } else if (mode.kind === 'gray' && mode.key !== undefined) {
    chunk('tRNS', body().u16(mode.key).done());
  } else if (mode.kind === 'rgb' && mode.key) {
    chunk('tRNS', body().u16(mode.key[0]).u16(mode.key[1]).u16(mode.key[2]).done());
  }

  let seq = 0;
  subs.forEach((s, i) => {
    if (animated) {
      chunk(
        'fcTL',
        body().u32(seq++).u32(s.width).u32(s.height).u32(s.x).u32(s.y).u16(s.delayNum).u16(s.delayDen).u8(0).u8(s.blend).done(),
      );
    }
    if (i === 0) chunk('IDAT', streams[i]);
    else {
      const d = new Uint8Array(streams[i].length + 4);
      new DataView(d.buffer).setUint32(0, seq++);
      d.set(streams[i], 4);
      chunk('fdAT', d);
    }
  });
  chunk('IEND', new Uint8Array(0));
  return w.done();
}
