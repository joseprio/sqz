import { unzlibSync, zlibSync } from 'fflate';
import { latin1, concat } from './bytes.js';
import type { MetaChunk } from '../types.js';

export function iccpChunk(profile: Uint8Array, name = 'ICC profile'): MetaChunk {
  const kw = latin1(name.slice(0, 79));
  return { type: 'iCCP', data: concat([kw, new Uint8Array([0, 0]), zlibSync(profile, { level: 9 })]) };
}

/** eXIf wants a bare TIFF stream; containers sometimes prefix it with "Exif\0\0". */
export function exifChunk(exif: Uint8Array): MetaChunk | null {
  let d = exif;
  if (d.length > 6 && d[0] === 0x45 && d[1] === 0x78 && d[2] === 0x69 && d[3] === 0x66 && d[4] === 0 && d[5] === 0) d = d.subarray(6);
  const tiff = d.length >= 4 && ((d[0] === 0x49 && d[1] === 0x49) || (d[0] === 0x4d && d[1] === 0x4d));
  return tiff ? { type: 'eXIf', data: d.slice() } : null;
}

export function xmpChunk(xmp: Uint8Array): MetaChunk {
  const kw = latin1('XML:com.adobe.xmp');
  return { type: 'iTXt', data: concat([kw, new Uint8Array([0, 0, 0, 0, 0]), xmp]) };
}

export function textChunk(keyword: string, text: string): MetaChunk {
  return { type: 'tEXt', data: concat([latin1(keyword.slice(0, 79)), new Uint8Array([0]), latin1(text)]) };
}

export function cicpChunk(primaries: number, transfer: number, fullRange: boolean): MetaChunk {
  // PNG only allows RGB (matrix 0) in cICP; the decoder already converted to RGB.
  return { type: 'cICP', data: new Uint8Array([primaries, transfer, 0, fullRange ? 1 : 0]) };
}

/** Sum two APNG-style delays, keeping the result representable in u16 num/den. */
export function addDelays(aNum: number, aDen: number, bNum: number, bDen: number): [number, number] {
  aDen ||= 100;
  bDen ||= 100;
  if (aDen === bDen && aNum + bNum <= 0xffff) return [aNum + bNum, aDen];
  return toDelay(aNum / aDen + bNum / bDen);
}

export function toDelay(seconds: number): [number, number] {
  for (const den of [1000, 100, 10, 1]) {
    const num = Math.round(seconds * den);
    if (num <= 0xffff) return [num, den];
  }
  return [0xffff, 1];
}

/** Pull ICC / EXIF / XMP out of PNG metadata chunks for containers that store them natively. */
export function portableMeta(chunks: MetaChunk[]): { icc?: Uint8Array; exif?: Uint8Array; xmp?: Uint8Array; dropped: string[] } {
  const out: { icc?: Uint8Array; exif?: Uint8Array; xmp?: Uint8Array; dropped: string[] } = { dropped: [] };
  for (const c of chunks) {
    try {
      if (c.type === 'iCCP') {
        const nul = c.data.indexOf(0);
        out.icc = unzlibSync(c.data.subarray(nul + 2));
      } else if (c.type === 'eXIf') out.exif = c.data;
      else if (c.type === 'iTXt' && latin1Decode(c.data.subarray(0, c.data.indexOf(0))) === 'XML:com.adobe.xmp') {
        // keyword\0 flag method lang\0 translated\0 text
        let p = c.data.indexOf(0) + 1;
        const compressed = c.data[p];
        p += 2;
        p = c.data.indexOf(0, p) + 1;
        p = c.data.indexOf(0, p) + 1;
        const text = c.data.subarray(p);
        out.xmp = compressed ? unzlibSync(text) : text;
      } else out.dropped.push(c.type);
    } catch {
      out.dropped.push(c.type);
    }
  }
  return out;
}

const latin1Decode = (b: Uint8Array) => String.fromCharCode(...b);
