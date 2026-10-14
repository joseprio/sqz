import { jpegDecoder, toArrayBuffer } from '../codecs.js';
import { exifChunk, iccpChunk, xmpChunk } from '../util/meta.js';
import { exifOrientation, isJpeg, jpegEnd, orient, parseHdrgm, parseIso, readMeta, withoutGainMapXmp, type GainMapMetadata } from '../util/jpeg.js';
import { iccPrimaries } from '../process/hdr.js';
import type { GainMap, MetaChunk, RasterImage } from '../types.js';

export { isJpeg };

async function pixels(jpeg: Uint8Array, components: number): Promise<{ data: Uint8Array; width: number; height: number }> {
  if (components === 4) throw new Error('CMYK JPEGs are not supported');
  const decode = await jpegDecoder();
  const img = await decode(toArrayBuffer(jpeg));
  return { data: new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.length), width: img.width, height: img.height };
}

/** The gain map image of an Ultra HDR / ISO 21496-1 JPEG, if it has one. */
function findGainMap(buf: Uint8Array, primaryEnd: number, mpfImages: number[]): { start: number; meta: GainMapMetadata; icc?: Uint8Array; components: number } | null {
  // MPF says where the extra images are; files without it append the gain map directly.
  const candidates = [...new Set([...mpfImages, primaryEnd])].filter((o) => o < buf.length);
  for (const start of candidates) {
    if (!isJpeg(buf, start)) continue;
    try {
      const m = readMeta(buf, start);
      const meta = (m.iso && parseIso(m.iso)) || (m.xmp && parseHdrgm(m.xmp)) || null;
      if (meta) return { start, meta, icc: m.icc, components: m.components };
    } catch {
      // Not a readable JPEG: try the next candidate.
    }
  }
  return null;
}

export async function decodeJpeg(buf: Uint8Array): Promise<RasterImage> {
  const warnings: string[] = [];
  const meta = readMeta(buf);
  const primaryEnd = jpegEnd(buf);
  const base = await pixels(buf.subarray(0, primaryEnd), meta.components);

  let orientation = 1;
  const chunks: MetaChunk[] = [];
  if (meta.icc) chunks.push(iccpChunk(meta.icc));
  if (meta.exif) {
    // Pixels are stored upright, so the tag must say so too.
    const e = exifOrientation(meta.exif);
    orientation = e.orientation;
    const c = exifChunk(e.exif);
    if (c) chunks.push(c);
  }
  const xmp = meta.xmp && withoutGainMapXmp(meta.xmp);
  if (xmp) chunks.push(xmpChunk(xmp));

  const upright = orient(base.data, base.width, base.height, orientation);
  let gainMap: GainMap | undefined;
  const found = findGainMap(buf, primaryEnd, meta.mpfImages);
  if (found) {
    try {
      const end = jpegEnd(buf, found.start);
      const gm = await pixels(buf.subarray(found.start, end), found.components);
      const o = orient(gm.data, gm.width, gm.height, orientation);
      gainMap = {
        ...found.meta,
        width: o.width,
        height: o.height,
        channels: found.components === 1 ? 1 : 3,
        data: o.data,
        altIcc: found.icc,
        // With no profile of its own, the HDR rendition shares the base colour space.
        altPrimaries: (found.icc && iccPrimaries(found.icc)) || 2,
        altTransfer: 2,
        altDepth: 10,
        altPlaneCount: 3,
      };
    } catch (e) {
      warnings.push(`The HDR gain map could not be read (${(e as Error).message}); only the SDR image was kept`);
    }
  }

  return {
    width: upright.width,
    height: upright.height,
    depth: 8,
    frames: [{ data: upright.data, delayNum: 0, delayDen: 100 }],
    loops: 0,
    chunks,
    format: 'jpeg',
    warnings,
    gainMap,
  };
}
