import { GifReader } from 'omggif';
import type { Frame, MetaChunk, RasterImage } from '../types.js';
import { textChunk } from '../util/meta.js';

export function decodeGif(buf: Uint8Array): RasterImage {
  const warnings: string[] = [];
  const reader = new GifReader(buf);
  const { width, height } = reader;
  const n = reader.numFrames();
  if (!n) throw new Error('GIF has no frames');

  let canvas = new Uint8Array(width * height * 4);
  const frames: Frame[] = [];
  let shortDelays = false;
  for (let i = 0; i < n; i++) {
    const info = reader.frameInfo(i);
    const saved = info.disposal === 3 ? canvas.slice() : null;
    try {
      reader.decodeAndBlitFrameRGBA(i, canvas);
    } catch (e) {
      warnings.push(`GIF frame ${i} is corrupt (${(e as Error).message}); remaining frames were dropped`);
      break;
    }
    // Browsers play delays of 0 or 1 hundredths at 10 hundredths; keep what people actually see.
    let delay = info.delay;
    if (delay <= 1 && n > 1) {
      delay = 10;
      shortDelays = true;
    }
    frames.push({ data: canvas.slice(), delayNum: delay, delayDen: 100 });
    if (info.disposal === 2) {
      const x1 = Math.min(width, info.x + info.width);
      const y1 = Math.min(height, info.y + info.height);
      for (let y = info.y; y < y1; y++) canvas.fill(0, (y * width + info.x) * 4, (y * width + x1) * 4);
    } else if (saved) {
      canvas = saved;
    }
  }
  if (!frames.length) throw new Error('GIF has no decodable frames');
  if (shortDelays) warnings.push('GIF frame delays under 20 ms were set to 100 ms, matching how browsers play them');

  // GIF without a NETSCAPE block plays once; a loop count of 0 means forever, like APNG.
  const lc = reader.loopCount() as number | null;
  const loops = lc === null || lc === undefined ? 1 : lc;
  const chunks: MetaChunk[] = readComments(buf).map((c) => textChunk('Comment', c));
  return { width, height, depth: 8, frames, loops, chunks, format: 'gif', warnings };
}

/** Pull Comment Extension text blocks; omggif skips them. */
function readComments(buf: Uint8Array): string[] {
  const out: string[] = [];
  let p = 13;
  if (buf[10] & 0x80) p += 3 * (1 << ((buf[10] & 7) + 1));
  const skipBlocks = () => {
    let s = '';
    while (p < buf.length) {
      const len = buf[p++];
      if (!len) break;
      for (let i = 0; i < len && p + i < buf.length; i++) s += String.fromCharCode(buf[p + i]);
      p += len;
    }
    return s;
  };
  while (p < buf.length) {
    const b = buf[p++];
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = buf[p++];
      const s = skipBlocks();
      if (label === 0xfe && s.trim()) out.push(s);
    } else if (b === 0x2c) {
      p += 8;
      const flags = buf[p++];
      if (flags & 0x80) p += 3 * (1 << ((flags & 7) + 1));
      p++; // LZW minimum code size
      skipBlocks();
    } else {
      break;
    }
  }
  return out;
}
