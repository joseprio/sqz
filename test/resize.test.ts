import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { convert, decode, ssimulacra2, type ConvertOptions } from '../src/index.js';
import { registerNodeCodecs } from '../src/node/codecs.js';
import { resample, transformImage } from '../src/process/resize.js';

const dir = join(import.meta.dirname, 'fixtures');
const load = (f: string) => new Uint8Array(readFileSync(join(dir, f)));
const fast: ConvertOptions = { effort: 'fast' };

beforeAll(() => registerNodeCodecs());

async function lossless(file: string, opts: ConvertOptions) {
  const r = await convert(load(file), { ...fast, variants: ['lossless'], ...opts });
  const v = r.variants[0];
  if (v.error) throw new Error(v.error);
  return { result: r, out: await decode(v.data!), v };
}

describe('resampling', () => {
  it('keeps a flat colour flat both ways', () => {
    const src = new Uint8Array(17 * 11 * 4).map((_, i) => [200, 40, 90, 255][i % 4]);
    for (const [W, H] of [[5, 3], [60, 41], [17, 30]]) {
      const out = resample(src, 17, 11, W, H);
      expect(out.length).toBe(W * H * 4);
      for (let i = 0; i < out.length; i += 4) expect([...out.subarray(i, i + 4)]).toEqual([200, 40, 90, 255]);
    }
  });

  it('does not bleed the colour of transparent pixels into edges', () => {
    // Left half opaque white, right half transparent *black*.
    const w = 16;
    const src = new Uint8Array(w * 4 * 4);
    for (let y = 0; y < 4; y++) for (let x = 0; x < w / 2; x++) src.set([255, 255, 255, 255], (y * w + x) * 4);
    const out = resample(src, w, 4, 7, 4);
    for (let i = 0; i < out.length; i += 4) if (out[i + 3] > 0) expect(out[i]).toBeGreaterThanOrEqual(250);
  });

  it('works on 16-bit pixels', () => {
    const src = new Uint16Array(8 * 8 * 4).map((_, i) => (i % 4 === 3 ? 65535 : 40000));
    const out = resample(src, 8, 8, 3, 3);
    expect(out).toBeInstanceOf(Uint16Array);
    expect(out[0]).toBe(40000);
  });

  it('shrinks close to what the eye expects, and enlarges back', async () => {
    const src = await decode(load('natural.png'));
    const down = resample(src.frames[0].data as Uint8Array, 128, 96, 64, 48);
    const back = resample(down, 64, 48, 128, 96);
    expect(ssimulacra2(src.frames[0].data as Uint8Array, back, 128, 96)).toBeGreaterThan(60);
  });
});

describe('resize and crop in convert', () => {
  it('resizes, then crops in resized pixels', async () => {
    const { out, result } = await lossless('natural.png', { resize: { width: 64, height: 48 }, crop: { x: 10, y: 5, width: 30, height: 20 } });
    expect([out.width, out.height]).toEqual([30, 20]);
    expect([result.width, result.height]).toEqual([30, 20]);
    const resized = resample((await decode(load('natural.png'))).frames[0].data as Uint8Array, 128, 96, 64, 48);
    const d = out.frames[0].data;
    for (let y = 0; y < 20; y++) for (let x = 0; x < 30; x++) {
      for (let c = 0; c < 4; c++) expect(d[(y * 30 + x) * 4 + c]).toBe(resized[((y + 5) * 64 + x + 10) * 4 + c]);
    }
  });

  it('upscales with bicubic', async () => {
    const { out } = await lossless('photo.png', { resize: { width: 200, height: 150 } });
    expect([out.width, out.height]).toEqual([200, 150]);
  });

  it('applies to every frame of an animation, keeping the timing', async () => {
    const src = await decode(load('anim.gif'));
    const { out } = await lossless('anim.gif', { resize: { width: 32, height: 24 } });
    expect([out.width, out.height]).toEqual([32, 24]);
    expect(out.frames.length).toBe(src.frames.length);
  });

  it('scales and crops the HDR gain map along', async () => {
    const src = await decode(load('ultrahdr.jpg'));
    const img = transformImage(src, { width: 48, height: 32 }, { x: 12, y: 8, width: 24, height: 16 });
    expect([img.gainMap!.width, img.gainMap!.height]).toEqual([24, 16]);
    const r = await convert(load('ultrahdr.jpg'), { ...fast, format: 'avif', variants: ['lossless'], resize: { width: 48, height: 32 }, crop: { x: 12, y: 8, width: 24, height: 16 } });
    const out = await decode(r.variants[0].data!);
    expect([out.width, out.height]).toEqual([24, 16]);
    expect(out.gainMap).toBeDefined();
  });

  it('turns a no-op edit into no edit, so the original is still reusable', async () => {
    const input = load('photo.jpg');
    const r = await convert(input, { ...fast, format: 'jpeg', target: 100, resize: { width: 128, height: 96 }, crop: { x: 0, y: 0, width: 128, height: 96 } });
    expect(r.variants[0].keptOriginal).toBe(true);
  });

  it('never hands back the original once edited', async () => {
    const r = await convert(load('photo.jpg'), { ...fast, format: 'jpeg', target: 100, crop: { x: 0, y: 0, width: 100, height: 96 } });
    expect(r.variants[0].keptOriginal).toBe(false);
  });

  it('rejects crops outside the image', async () => {
    await expect(convert(load('photo.png'), { ...fast, crop: { x: 90, y: 0, width: 10, height: 10 } })).rejects.toThrow(/inside the 96×64 image/);
    await expect(convert(load('photo.png'), { ...fast, resize: { width: 0, height: 10 } })).rejects.toThrow(/whole numbers/);
  });
});
