import { Ssimulacra2 } from '../metric/ssimulacra2.js';
import type { Frame } from '../types.js';
import { lossyFilter } from './lossy.js';
import { quantizeFrames } from './quantize.js';

/**
 * Lossy variants are tuned to a SSIMULACRA2 target instead of an encoder "quality":
 * each search finds the cheapest setting whose output still scores at least `target`.
 * Animations are scored on up to four sample frames; the worst frame counts.
 */

export interface Tuned<T> {
  value: T;
  score: number;
  /** false when even the most expensive setting misses the target. */
  reached: boolean;
}

const SAMPLE_FRAMES = 4;

/**
 * SSIMULACRA2 works on 8-bit sRGB. 16-bit samples are scored on their top 8 bits: for
 * PQ / HLG that treats the code values as if they were sRGB, a rough but monotonic proxy.
 */
function to8(d: Uint8Array | Uint16Array): Uint8Array {
  if (d instanceof Uint8Array) return d;
  const out = new Uint8Array(d.length);
  for (let i = 0; i < d.length; i++) out[i] = (d[i] * 255 + 32767) / 65535;
  return out;
}

export function sampleIndices(n: number): number[] {
  if (n <= SAMPLE_FRAMES) return [...Array(n).keys()];
  return [...new Set([...Array(SAMPLE_FRAMES).keys()].map((i) => Math.round((i * (n - 1)) / (SAMPLE_FRAMES - 1))))];
}

export class FrameScorer {
  private scorers: Ssimulacra2[];
  readonly indices: number[];

  constructor(frames: Frame[], width: number, height: number) {
    this.indices = sampleIndices(frames.length);
    this.scorers = this.indices.map((i) => new Ssimulacra2(to8(frames[i].data), width, height));
  }

  /** `candidates[k]` corresponds to `indices[k]`. */
  score(candidates: (Uint8Array | Uint16Array)[]): number {
    return Math.min(...this.scorers.map((s, k) => s.score(to8(candidates[k]))));
  }
}

/**
 * Integer search between an expensive end (best quality) and a cheap end, assuming
 * quality falls monotonically towards the cheap end. Returns the cheapest passing value.
 */
async function cheapestPassing(expensive: number, cheap: number, target: number, scoreAt: (v: number) => Promise<number> | number, onStep?: () => void): Promise<Tuned<number>> {
  const cache = new Map<number, number>();
  const at = async (v: number) => {
    if (!cache.has(v)) {
      cache.set(v, await scoreAt(v));
      onStep?.();
    }
    return cache.get(v)!;
  };
  if ((await at(cheap)) >= target) return { value: cheap, score: cache.get(cheap)!, reached: true };
  if ((await at(expensive)) < target) return { value: expensive, score: cache.get(expensive)!, reached: false };
  let good = expensive;
  let bad = cheap;
  while (Math.abs(good - bad) > 1) {
    const mid = Math.round((good + bad) / 2);
    if ((await at(mid)) >= target) good = mid;
    else bad = mid;
  }
  return { value: good, score: cache.get(good)!, reached: true };
}

/** Largest PNG lossy-filter step that meets the target. */
export async function tunePngStep(frames: Frame[], width: number, height: number, target: number, onStep?: () => void): Promise<Tuned<number>> {
  const scorer = new FrameScorer(frames, width, height);
  const sample = scorer.indices.map((i) => frames[i].data as Uint8Array);
  return cheapestPassing(1, 48, target, (step) => scorer.score(sample.map((d) => lossyFilter(d, width, height, step).data)), onStep);
}

/** Fewest palette colours that meet the target. */
export async function tuneColors(frames: Frame[], width: number, height: number, target: number, dither: boolean, maxColors: number, onStep?: () => void): Promise<Tuned<number>> {
  const scorer = new FrameScorer(frames, width, height);
  const sample = scorer.indices.map((i) => frames[i]);
  // Search in log space: the difference between 4 and 8 colours matters far more than 200 vs 204.
  const steps = 32;
  const colorsAt = (k: number) => Math.max(2, Math.round(2 * (maxColors / 2) ** (k / steps)));
  const r = await cheapestPassing(
    steps,
    0,
    target,
    (k) => {
      // Sample frames are quantized independently of each other, so frame diffing does not apply.
      const q = sample.map((f) => quantizeFrames([f], width, height, colorsAt(k), dither)[0].data as Uint8Array);
      return scorer.score(q);
    },
    onStep,
  );
  return { ...r, value: colorsAt(r.value) };
}

/**
 * Lowest encoder quality (0–100) whose decoded output meets the target. `roundTrip`
 * receives frames as they are: Uint8Array, or Uint16Array for 16-bit frames.
 */
export async function tuneQuality<T extends Uint8Array | Uint16Array>(
  frames: Frame[],
  width: number,
  height: number,
  target: number,
  roundTrip: (rgba: T, quality: number) => Promise<Uint8Array | Uint16Array>,
  onStep?: () => void,
): Promise<Tuned<number>> {
  const scorer = new FrameScorer(frames, width, height);
  const sample = scorer.indices.map((i) => frames[i].data as T);
  return cheapestPassing(100, 0, target, async (q) => scorer.score(await Promise.all(sample.map((d) => roundTrip(d, q)))), onStep);
}

export { TARGET_BANDS, describeTarget, type TargetBand } from './bands.js';
