import { fourcc } from '../util/bytes.js';
import { decodePng, PNG_SIGNATURE } from './png.js';
import { decodeGif } from './gif.js';
import { decodeWebp } from './webp.js';
import { decodeAvif, isAvif } from './avif.js';
import type { InputFormat, RasterImage } from '../types.js';

export function detectFormat(b: Uint8Array): Exclude<InputFormat, 'apng'> | null {
  if (b.length >= 8 && PNG_SIGNATURE.every((v, i) => b[i] === v)) return 'png';
  if (b.length >= 6 && fourcc(b, 0) === 'GIF8') return 'gif';
  if (b.length >= 12 && fourcc(b, 0) === 'RIFF' && fourcc(b, 8) === 'WEBP') return 'webp';
  if (isAvif(b)) return 'avif';
  return null;
}

export async function decode(input: Uint8Array): Promise<RasterImage> {
  const fmt = detectFormat(input);
  let img: RasterImage;
  switch (fmt) {
    case 'png':
      img = decodePng(input);
      break;
    case 'gif':
      img = decodeGif(input);
      break;
    case 'webp':
      img = await decodeWebp(input);
      break;
    case 'avif':
      img = await decodeAvif(input);
      break;
    default:
      throw new Error('Unrecognised image format (expected PNG, APNG, GIF, WebP or AVIF)');
  }
  return reduce16(img);
}

/** 16-bit images whose samples are all v*257 carry no extra precision. */
function reduce16(img: RasterImage): RasterImage {
  if (img.depth !== 16) return img;
  for (const f of img.frames) {
    const d = f.data;
    for (let i = 0; i < d.length; i++) if (d[i] >> 8 !== (d[i] & 0xff)) return img;
  }
  for (const f of img.frames) {
    const d = f.data;
    const out = new Uint8Array(d.length);
    for (let i = 0; i < d.length; i++) out[i] = d[i] & 0xff;
    f.data = out;
  }
  img.depth = 8;
  return img;
}
