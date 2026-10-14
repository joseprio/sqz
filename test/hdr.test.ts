import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { convert, decode, type ConvertOptions } from '../src/index.js';
import { registerNodeCodecs } from '../src/node/codecs.js';
import { cicpOf } from '../src/process/hdr.js';
import { isJpeg, readMeta } from '../src/util/jpeg.js';
import type { RasterImage } from '../src/types.js';

const dir = join(import.meta.dirname, 'fixtures');
const load = (f: string) => new Uint8Array(readFileSync(join(dir, f)));
const fast: ConvertOptions = { effort: 'fast' };

beforeAll(() => registerNodeCodecs());

async function one(input: Uint8Array, opts: ConvertOptions) {
  const r = await convert(input, opts);
  const v = r.variants[0];
  if (v.error) throw new Error(v.error);
  return { ...v, data: v.data!, result: r };
}

/** Largest colour sample of a frame (PQ code value for HDR output). */
const peak = (img: RasterImage) => {
  let m = 0;
  const d = img.frames[0].data;
  for (let i = 0; i < d.length; i += 4) m = Math.max(m, d[i], d[i + 1], d[i + 2]);
  return m;
};

// PQ code value of SDR white (203 nits), as a fraction of full scale.
const PQ_SDR_WHITE = 0.58;

describe('JPEG', () => {
  it('stores pixels upright and resets the EXIF orientation', async () => {
    const src = await decode(load('rotated.jpg'));
    expect([src.width, src.height]).toEqual([32, 48]);
    // The red marker stored top-left ends up top-right after a 90° clockwise turn.
    const d = src.frames[0].data;
    const at = (x: number, y: number) => (y * src.width + x) * 4;
    expect(d[at(29, 2)]).toBeGreaterThan(180);
    expect(d[at(2, 2)]).toBeLessThan(80);
    // Re-reading the output must not rotate it a second time.
    const v = await one(load('rotated.jpg'), { ...fast, format: 'jpeg', target: 90 });
    expect(v.keptOriginal).toBe(false);
    const out = await decode(v.data);
    expect([out.width, out.height]).toEqual([32, 48]);
  });

  it('keeps the original JPEG when re-encoding would not make it smaller', async () => {
    const input = load('photo.jpg');
    const v = await one(input, { ...fast, format: 'jpeg', target: 100 });
    expect(v.keptOriginal).toBe(true);
    expect(v.size).toBe(input.length);
    expect(v.extension).toBe('jpg');
  });

  it('fills transparency with white, and refuses animations', async () => {
    const v = await one(load('photo-alpha.png'), { ...fast, format: 'jpeg', target: 60 });
    expect(v.warnings.join()).toMatch(/no transparency/);
    const r = await convert(load('anim.gif'), { ...fast, format: 'jpeg' });
    expect(r.variants[0].error).toMatch(/animations/);
  });
});

describe('Ultra HDR JPEG input', () => {
  it('decodes the gain map and its hdrgm metadata', async () => {
    const img = await decode(load('ultrahdr.jpg'));
    expect(img.format).toBe('jpeg');
    const gm = img.gainMap!;
    expect(gm.channels).toBe(1);
    expect([gm.width, gm.height]).toEqual([96, 64]);
    expect(gm.max[0]).toBeCloseTo(Math.log2(1000 / 203), 4);
    expect(gm.alternateHdrHeadroom).toBeCloseTo(Math.log2(1000 / 203), 4);
    // The container description goes; the rest of the XMP stays.
    const xmp = new TextDecoder().decode(img.chunks.find((c) => c.type === 'iTXt')!.data);
    expect(xmp).toContain('sqz fixtures');
    expect(xmp).not.toContain('Container:Directory');
  });

  it('becomes a real HDR PNG (16-bit BT.2020 PQ) in lossless PNG', async () => {
    const v = await one(load('ultrahdr.jpg'), { ...fast, format: 'png', variants: ['lossless'] });
    const out = await decode(v.data);
    expect(out.depth).toBe(16);
    expect(cicpOf(out.chunks)).toEqual({ primaries: 9, transfer: 16 });
    expect(out.chunks.some((c) => c.type === 'cLLI')).toBe(true);
    expect(peak(out) / 65535).toBeGreaterThan(PQ_SDR_WHITE + 0.1);
    expect(v.result.hdr).toBe('gain map');
  });

  for (const variant of ['lossless', 'lossy'] as const) {
    it(`keeps the gain map in ${variant} AVIF`, async () => {
      const v = await one(load('ultrahdr.jpg'), { ...fast, format: 'avif', variants: [variant], target: 70 });
      expect(v.description).toMatch(/gain map/);
      const out = await decode(v.data);
      expect(out.gainMap).toBeDefined();
      expect(out.gainMap!.max[0]).toBeCloseTo(Math.log2(1000 / 203), 3);
    });
  }

  it('keeps the gain map in JPEG, with MPF, ISO 21496-1 and hdrgm XMP', async () => {
    // A low target, so the re-encode beats the original and the writer is what gets tested.
    const v = await one(load('ultrahdr.jpg'), { ...fast, format: 'jpeg', target: 30 });
    expect(v.keptOriginal).toBe(false);
    expect(v.description).toMatch(/Ultra HDR/);
    const meta = readMeta(v.data);
    expect(meta.mpfImages).toHaveLength(1);
    expect(isJpeg(v.data, meta.mpfImages[0])).toBe(true);
    const gmMeta = readMeta(v.data, meta.mpfImages[0]);
    expect(gmMeta.iso!.length).toBeGreaterThan(4);
    expect(new TextDecoder().decode(gmMeta.xmp)).toContain('hdrgm:GainMapMax');
    const out = await decode(v.data);
    expect(out.gainMap!.alternateHdrHeadroom).toBeCloseTo(Math.log2(1000 / 203), 3);
  });

  it('warns that formats without gain maps keep only the SDR image', async () => {
    const v = await one(load('ultrahdr.jpg'), { ...fast, format: 'webp', variants: ['lossless'] });
    expect(v.warnings.join()).toMatch(/gain map dropped/);
  });

  it('drops HDR on request', async () => {
    const v = await one(load('ultrahdr.jpg'), { ...fast, format: 'png', variants: ['lossless'], stripHdr: true });
    const out = await decode(v.data);
    expect(out.depth).toBe(8);
    expect(cicpOf(out.chunks)).toBeNull();
    expect(v.warnings).toEqual([]);
    const jpeg = await one(load('ultrahdr.jpg'), { ...fast, format: 'jpeg', target: 95, stripHdr: true });
    expect((await decode(jpeg.data)).gainMap).toBeUndefined();
  });
});

describe('PQ HDR input', () => {
  it('stays HDR in AVIF, at 12 bits with its CICP', async () => {
    const input = load('hdr-pq.png');
    const src = await decode(input);
    const v = await one(input, { ...fast, format: 'avif', variants: ['lossless'] });
    expect(v.description).toMatch(/12-bit, HDR PQ/);
    const out = await decode(v.data);
    expect(out.depth).toBe(16);
    expect(cicpOf(out.chunks)).toEqual({ primaries: 9, transfer: 16 });
    expect(out.chunks.some((c) => c.type === 'cLLI')).toBe(true);
    let worst = 0;
    src.frames[0].data.forEach((s, i) => (worst = Math.max(worst, Math.abs(s - out.frames[0].data[i]))));
    expect(worst).toBeLessThanOrEqual(16);
  });

  it('stays HDR in lossy AVIF', async () => {
    const v = await one(load('hdr-pq.png'), { ...fast, format: 'avif', variants: ['lossy'], target: 70 });
    const out = await decode(v.data);
    expect(cicpOf(out.chunks)).toEqual({ primaries: 9, transfer: 16 });
    expect(peak(out) / 65535).toBeGreaterThan(PQ_SDR_WHITE + 0.1);
  });

  it('becomes Ultra HDR in JPEG and comes back as HDR', async () => {
    const input = load('hdr-pq.png');
    const v = await one(input, { ...fast, format: 'jpeg', target: 90 });
    expect(v.description).toMatch(/Ultra HDR/);
    const back = await one(v.data, { ...fast, format: 'png', variants: ['lossless'] });
    const out = await decode(back.data);
    expect(cicpOf(out.chunks)).toEqual({ primaries: 9, transfer: 16 });
    // The highlight comes back close to the 1000-nit original.
    expect(Math.abs(peak(out) - peak(await decode(input))) / 65535).toBeLessThan(0.05);
  });

  it('is tone mapped for SDR-only formats', async () => {
    const v = await one(load('hdr-pq.png'), { ...fast, format: 'webp', variants: ['lossless'] });
    expect(v.warnings.join()).toMatch(/tone mapped to SDR/);
    const out = await decode(v.data);
    // The sun is near white, not the dull grey that PQ codes read as sRGB would give.
    expect(peak(out)).toBeGreaterThan(240);
  });

  it('is tone mapped on request, even in lossless PNG', async () => {
    const v = await one(load('hdr-pq.png'), { ...fast, format: 'png', variants: ['lossless'], stripHdr: true });
    const out = await decode(v.data);
    expect(out.depth).toBe(8);
    expect(cicpOf(out.chunks)).toBeNull();
    expect(v.result.hdr).toBe('PQ');
  });

  it('keeps its HDR signalling when metadata is stripped', async () => {
    const v = await one(load('hdr-pq.png'), { ...fast, format: 'png', variants: ['lossless'], strip: true });
    expect(cicpOf((await decode(v.data)).chunks)).toEqual({ primaries: 9, transfer: 16 });
  });
});
