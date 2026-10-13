import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { convert, decode, stripPng, variantsFor, ssimulacra2, type ConvertOptions, type OutputFormat } from '../src/index.js';
import { registerNodeCodecs } from '../src/node/codecs.js';
import { readChunks } from '../src/decode/png.js';
import type { RasterImage } from '../src/types.js';

const dir = join(import.meta.dirname, 'fixtures');
const fixtures = readdirSync(dir).filter((f) => /\.(png|gif|webp|avif)$/.test(f));
const load = (f: string) => new Uint8Array(readFileSync(join(dir, f)));
const fast: ConvertOptions = { effort: 'fast' };

beforeAll(() => registerNodeCodecs());

async function one(input: Uint8Array, opts: ConvertOptions) {
  const r = await convert(input, opts);
  const v = r.variants[0];
  if (v.error) throw new Error(v.error);
  return { ...v, data: v.data! };
}

/** Largest per-channel difference between two decodes, ignoring the colour of invisible pixels. */
function maxDiff(a: RasterImage, b: RasterImage): number {
  expect(b.width).toBe(a.width);
  expect(b.height).toBe(a.height);
  expect(b.frames.length).toBe(a.frames.length);
  let worst = 0;
  a.frames.forEach((fa, i) => {
    const da = fa.data;
    const db = b.frames[i].data;
    for (let p = 0; p < da.length; p += 4) {
      worst = Math.max(worst, Math.abs(da[p + 3] - db[p + 3]));
      if (da[p + 3] === 0 && db[p + 3] === 0) continue;
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(da[p + c] - db[p + c]));
    }
  });
  return worst;
}

/** Collapse frames identical to their predecessor (as sqz does), keeping total time per distinct frame. */
function collapse(img: RasterImage): { frames: RasterImage['frames']; times: number[] } {
  const frames: RasterImage['frames'] = [];
  const times: number[] = [];
  for (const f of img.frames) {
    const prev = frames[frames.length - 1];
    const d = f.delayNum / (f.delayDen || 100);
    if (prev && prev.data.length === f.data.length && prev.data.every((v, i) => v === f.data[i])) times[times.length - 1] += d;
    else {
      frames.push(f);
      times.push(d);
    }
  }
  return { frames, times: times.map((t) => Math.round(t * 1000)) };
}

function expectSameAnimation(src: RasterImage, out: RasterImage, tolerance = 0) {
  const a = collapse(src);
  const b = collapse(out);
  expect(maxDiff({ ...src, frames: a.frames }, { ...out, frames: b.frames })).toBeLessThanOrEqual(tolerance);
  if (a.frames.length > 1) {
    expect(b.times).toEqual(a.times);
    expect(out.loops).toBe(src.loops);
  }
}

describe('variants', () => {
  it('lists what each format offers', () => {
    expect(variantsFor('png')).toEqual(['lossless', 'quantized', 'lossy']);
    expect(variantsFor('webp', 'lossy')).toEqual(['quantized', 'lossy']);
    expect(variantsFor('gif', 'lossy')).toEqual(['quantized']);
    expect(variantsFor('avif', 'lossy')).toEqual(['lossy']);
  });

  it('produces every variant in one call, decoding once', async () => {
    const r = await convert(load('photo.png'), { ...fast, format: 'webp', target: 70 });
    expect(r.variants.map((v) => v.variant)).toEqual(['lossless', 'quantized', 'lossy']);
    for (const v of r.variants) expect(v.error).toBeUndefined();
  });
});

describe('lossless round trips', () => {
  const targets: OutputFormat[] = ['png', 'webp', 'avif', 'gif'];
  for (const f of fixtures) {
    for (const format of targets) {
      it(`${f} → ${format}`, async () => {
        const input = load(f);
        const src = await decode(input);
        const r = await convert(input, { ...fast, format, variants: ['lossless'] });
        const v = r.variants[0];
        if (format === 'gif' && v.error) return void expect(v.error).toMatch(/256 colours|partial transparency/);
        expect(v.error).toBeUndefined();
        const out = await decode(v.data!);
        // 16-bit precision survives only in PNG.
        expectSameAnimation(src.depth === 16 && format !== 'png' ? { ...src, frames: [] } : src, src.depth === 16 && format !== 'png' ? { ...out, frames: [] } : out);
      });
    }
  }
});

describe('PNG specifics', () => {
  it('never returns a PNG larger than the input', async () => {
    const input = load('gray4.png');
    const v = await one(input, { ...fast, variants: ['lossless'] });
    expect(v.size).toBeLessThanOrEqual(input.length);
  });

  it('keeps real 16-bit precision', async () => {
    const v = await one(load('gray16.png'), { ...fast, variants: ['lossless'] });
    expect((await decode(v.data)).depth).toBe(16);
  });

  it('beats the source PNG with zopfli', async () => {
    const input = load('photo.png');
    const v = await one(input, { variants: ['lossless'] });
    expect(v.size).toBeLessThan(input.length);
  });
});

describe('target search', () => {
  for (const format of ['png', 'webp'] as const) {
    it(`${format} quantized meets the SSIMULACRA2 target with a small palette`, async () => {
      const input = load('natural.png');
      const v = await one(input, { ...fast, format, variants: ['quantized'], target: 45 });
      expect(Number(v.setting!.split(' ')[0])).toBeLessThan(256);
      expect(v.warnings).toEqual([]);
      const src = await decode(input);
      const out = await decode(v.data);
      const score = ssimulacra2(src.frames[0].data as Uint8Array, out.frames[0].data as Uint8Array, src.width, src.height);
      expect(score).toBeGreaterThanOrEqual(45 - 0.5);
      expect(Math.abs(score - v.score!)).toBeLessThan(1);
    });
  }

  for (const format of ['png', 'webp', 'avif'] as const) {
    it(`${format} lossy meets the target and shrinks with a lower one`, async () => {
      const input = load('natural.png');
      const hi = await one(input, { ...fast, format, variants: ['lossy'], target: 85 });
      const lo = await one(input, { ...fast, format, variants: ['lossy'], target: 55 });
      const src = await decode(input);
      for (const v of [hi, lo]) {
        const out = await decode(v.data);
        const s = ssimulacra2(src.frames[0].data as Uint8Array, out.frames[0].data as Uint8Array, src.width, src.height);
        expect(s).toBeGreaterThanOrEqual((v === hi ? 85 : 55) - 0.5);
      }
      expect(lo.size).toBeLessThan(hi.size);
    });
  }

  it('warns when a target cannot be reached', async () => {
    // Pure noise: no 256-colour palette gets anywhere near 95.
    const v = await one(load('photo.png'), { ...fast, variants: ['quantized'], target: 95 });
    expect(v.warnings.join()).toMatch(/Could not reach SSIMULACRA2 95/);
    expect(v.setting).toBe('256 colours');
  });

  it('keeps fully transparent pixels transparent when quantizing', async () => {
    const input = load('photo-alpha.png');
    const v = await one(input, { ...fast, variants: ['quantized'], target: 50 });
    const src = (await decode(input)).frames[0].data;
    const d = (await decode(v.data)).frames[0].data;
    for (let i = 3; i < src.length; i += 4) if (src[i] === 0) expect(d[i]).toBe(0);
  });

  it('quantizes animations with one shared palette', async () => {
    const v = await one(load('anim-lossy.webp'), { ...fast, variants: ['quantized'], target: 60 });
    expect((await decode(v.data)).frames.length).toBeGreaterThan(1);
    expect(v.description).toMatch(/palette/);
  });

  it('handles animated lossy PNG and WebP', async () => {
    const input = load('anim-lossy.webp');
    const src = await decode(input);
    for (const format of ['png', 'webp'] as const) {
      const v = await one(input, { ...fast, format, variants: ['lossy'], target: 60 });
      expect((await decode(v.data)).frames.length).toBe(src.frames.length);
    }
  });

  it('turns any image into a GIF when quantized', async () => {
    const v = await one(load('photo-alpha.webp'), { ...fast, format: 'gif', variants: ['quantized'], target: 50 });
    const out = await decode(v.data);
    expect(out.format).toBe('gif');
  });
});

describe('animated AVIF', () => {
  it('round-trips an animation losslessly with timing and loop count', async () => {
    const input = load('anim-transparent.gif');
    const v = await one(input, { ...fast, format: 'avif', variants: ['lossless'] });
    const src = await decode(input);
    const out = await decode(v.data);
    expect(out.format).toBe('avif');
    expectSameAnimation(src, out);
  });

  it('meets the target on real (inter-frame coded) output, not just the sampled stills', async () => {
    const input = load('anim-lossy.webp');
    const src = await decode(input);
    const v = await one(input, { ...fast, format: 'avif', variants: ['lossy'], target: 70 });
    const out = await decode(v.data);
    expect(out.frames.length).toBe(src.frames.length);
    let worst = 100;
    src.frames.forEach((f, i) => {
      worst = Math.min(worst, ssimulacra2(f.data as Uint8Array, out.frames[i].data as Uint8Array, src.width, src.height));
    });
    // Inter-frame coding can land slightly away from the stills the search scored.
    expect(worst).toBeGreaterThanOrEqual(70 - 3);
  });

  it('decodes AVIF sequences into frames', async () => {
    const anim = await one(load('anim.gif'), { ...fast, format: 'avif', variants: ['lossless'] });
    const back = await convert(anim.data, { ...fast, format: 'png', variants: ['lossless'] });
    const png = await decode(back.variants[0].data!);
    expect(png.frames.length).toBe(6);
  });

  it('keeps more than 8 bits from 10-bit AVIF in lossless PNG', async () => {
    const v = await one(load('photo-10bit.avif'), { ...fast, format: 'png', variants: ['lossless'] });
    expect((await decode(v.data)).depth).toBe(16);
  });
});

describe('ssimulacra2', () => {
  it('is 100 for identical images and drops with damage', () => {
    const w = 64;
    const h = 64;
    const a = new Uint8Array(w * h * 4);
    for (let i = 0; i < a.length; i += 4) {
      a[i] = (i / 4) % 256;
      a[i + 1] = ((i / 4) * 7) % 256;
      a[i + 2] = 128;
      a[i + 3] = 255;
    }
    expect(ssimulacra2(a, a, w, h)).toBeCloseTo(100, 5);
    const b = a.map((v, i) => (i % 4 === 3 ? v : Math.min(255, v + ((i * 13) % 9) - 4)));
    const c = a.map((v, i) => (i % 4 === 3 ? v : Math.min(255, v + ((i * 13) % 41) - 20)));
    const sb = ssimulacra2(a, b, w, h);
    const sc = ssimulacra2(a, c, w, h);
    expect(sb).toBeLessThan(100);
    expect(sc).toBeLessThan(sb);
  });
});

describe('metadata', () => {
  it('keeps metadata by default and strips it on request', async () => {
    const withText = withChunk(load('photo.png'), 'tEXt', new TextEncoder().encode('Comment\0hello'));
    const kept = await one(withText, { ...fast, variants: ['lossless'] });
    expect(readChunks(kept.data).some((c) => c.type === 'tEXt')).toBe(true);
    const stripped = await one(withText, { ...fast, variants: ['lossless'], strip: true });
    expect(readChunks(stripped.data).some((c) => c.type === 'tEXt')).toBe(false);
    expect(readChunks(stripPng(withText)).map((c) => c.type)).not.toContain('tEXt');
  });
});

describe('library hygiene', () => {
  it('decodes Node Buffers that are views into a shared pool', async () => {
    const pooled = readFileSync(join(dir, 'photo.avif'));
    const r = await convert(new Uint8Array(pooled.buffer, pooled.byteOffset, pooled.length), { ...fast, variants: ['lossless'] });
    expect(r.width).toBe(96);
  });

  it('does not leave process-wide error handlers behind after zopfli loads', async () => {
    const before = process.listenerCount('unhandledRejection') + process.listenerCount('uncaughtException');
    await convert(load('gray4.png'), { variants: ['lossless'] });
    expect(process.listenerCount('unhandledRejection') + process.listenerCount('uncaughtException')).toBe(before);
  });
});

function withChunk(png: Uint8Array, type: string, data: Uint8Array): Uint8Array {
  const ihdr = readChunks(png)[0];
  const at = ihdr.offset + ihdr.size;
  const c = new Uint8Array(12 + data.length);
  new DataView(c.buffer).setUint32(0, data.length);
  c.set(new TextEncoder().encode(type), 4);
  c.set(data, 8);
  // CRC is not checked by our decoder; leave it zero.
  const out = new Uint8Array(png.length + c.length);
  out.set(png.subarray(0, at));
  out.set(c, at);
  out.set(png.subarray(at), at + c.length);
  return out;
}
