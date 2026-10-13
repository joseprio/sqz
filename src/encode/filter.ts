import { deflateSync } from 'fflate';
import { paeth } from '../decode/png.js';

export type FilterStrategy =
  | { kind: 'fixed'; filter: 0 | 1 | 2 | 3 | 4 }
  | { kind: 'minsum' }
  | { kind: 'entropy' }
  | { kind: 'bigrams' }
  | { kind: 'bigent' }
  | { kind: 'brute'; context?: number; level?: 6 | 9 }
  | { kind: 'hint'; rows: Uint8Array };

export const describeStrategy = (s: FilterStrategy) => (s.kind === 'fixed' ? `filter ${s.filter}` : s.kind);

export interface AlphaFill {
  bpp: number;
  alpha: number;
  size: number;
}

function filterRow(ft: number, cur: Uint8Array, prev: Uint8Array, bpp: number, out: Uint8Array, o: number) {
  const n = cur.length;
  out[o] = ft;
  o++;
  switch (ft) {
    case 0:
      out.set(cur, o);
      break;
    case 1:
      for (let i = 0; i < bpp; i++) out[o + i] = cur[i];
      for (let i = bpp; i < n; i++) out[o + i] = cur[i] - cur[i - bpp];
      break;
    case 2:
      for (let i = 0; i < n; i++) out[o + i] = cur[i] - prev[i];
      break;
    case 3:
      for (let i = 0; i < bpp; i++) out[o + i] = cur[i] - (prev[i] >> 1);
      for (let i = bpp; i < n; i++) out[o + i] = cur[i] - ((cur[i - bpp] + prev[i]) >> 1);
      break;
    case 4:
      for (let i = 0; i < bpp; i++) out[o + i] = cur[i] - prev[i];
      for (let i = bpp; i < n; i++) out[o + i] = cur[i] - paeth(cur[i - bpp], prev[i], prev[i - bpp]);
      break;
  }
}

/**
 * Overwrite the colour bytes of fully transparent pixels with whatever the filter
 * predicts, so they filter to zeros. Their colour is invisible, so this is lossless.
 */
function fillTransparent(ft: number, cur: Uint8Array, prev: Uint8Array, a: AlphaFill) {
  const { bpp, alpha, size } = a;
  for (let p = 0; p < cur.length; p += bpp) {
    let transparent = true;
    for (let k = 0; k < size; k++) if (cur[p + alpha + k] !== 0) transparent = false;
    if (!transparent) continue;
    for (let i = p; i < p + bpp; i++) {
      if (i >= p + alpha && i < p + alpha + size) continue;
      const left = i >= bpp ? cur[i - bpp] : 0;
      const up = prev[i];
      const ul = i >= bpp ? prev[i - bpp] : 0;
      cur[i] = ft === 0 ? 0 : ft === 1 ? left : ft === 2 ? up : ft === 3 ? (left + up) >> 1 : paeth(left, up, ul);
    }
  }
}

// Bigram statistics over a row: distinct byte pairs (oxipng "Bigrams") and their entropy ("BigEnt").
const seen = new Uint32Array(65536);
let seenGen = 0;
const pairCount = new Uint32Array(65536);
const touched = new Uint32Array(65536);
function bigrams(buf: Uint8Array, o: number, n: number, entropyMode: boolean): number {
  if (++seenGen === 0xffffffff) {
    seen.fill(0);
    seenGen = 1;
  }
  let distinct = 0;
  for (let i = o + 2; i < o + 1 + n; i++) {
    const k = (buf[i - 1] << 8) | buf[i];
    if (seen[k] !== seenGen) {
      seen[k] = seenGen;
      pairCount[k] = 0;
      touched[distinct++] = k;
    }
    pairCount[k]++;
  }
  if (!entropyMode) return distinct;
  const total = n - 1;
  let e = 0;
  for (let j = 0; j < distinct; j++) {
    const c = pairCount[touched[j]];
    e -= c * Math.log2(c / total);
  }
  return e;
}

function sumAbs(buf: Uint8Array, o: number, n: number): number {
  let s = 0;
  for (let i = o + 1; i < o + 1 + n; i++) {
    const v = buf[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

const hist = new Uint32Array(256);
function entropy(buf: Uint8Array, o: number, n: number): number {
  hist.fill(0);
  for (let i = o + 1; i < o + 1 + n; i++) hist[buf[i]]++;
  let e = 0;
  for (let i = 0; i < 256; i++) {
    const c = hist[i];
    if (c) e -= c * Math.log2(c / n);
  }
  return e;
}

/**
 * Filter raw scanlines with the given strategy. Returns the bytes to deflate
 * (h rows of filter-type byte + data). `raw` is not modified.
 */
export function applyFilter(raw: Uint8Array, height: number, rb: number, bpp: number, s: FilterStrategy, fill: AlphaFill | null): Uint8Array {
  const out = new Uint8Array(height * (rb + 1));
  let prev = new Uint8Array(rb);
  const tries = [0, 1, 2, 3, 4].map(() => ({ row: new Uint8Array(rb), out: new Uint8Array(rb + 1) }));
  // Rows of history the brute-force strategy compresses alongside each candidate.
  const context = s.kind === 'brute' ? (s.context ?? 2) : 0;
  const bruteLevel = s.kind === 'brute' ? (s.level ?? 6) : 6;

  for (let y = 0; y < height; y++) {
    const src = raw.subarray(y * rb, (y + 1) * rb);
    let candidates: number[];
    if (s.kind === 'fixed') candidates = [s.filter];
    else if (s.kind === 'hint') candidates = [s.rows[y] ?? 0];
    else candidates = [0, 1, 2, 3, 4];

    let best = -1;
    let bestCost = Infinity;
    for (const ft of candidates) {
      const t = tries[ft];
      t.row.set(src);
      if (fill) fillTransparent(ft, t.row, prev, fill);
      filterRow(ft, t.row, prev, bpp, t.out, 0);
      if (candidates.length === 1) {
        best = ft;
        break;
      }
      let cost: number;
      if (s.kind === 'minsum') cost = sumAbs(t.out, 0, rb);
      else if (s.kind === 'entropy') cost = entropy(t.out, 0, rb);
      else if (s.kind === 'bigrams') cost = bigrams(t.out, 0, rb, false);
      else if (s.kind === 'bigent') cost = bigrams(t.out, 0, rb, true);
      else {
        const start = Math.max(0, y - context) * (rb + 1);
        const hist = out.subarray(start, y * (rb + 1));
        const buf = new Uint8Array(hist.length + rb + 1);
        buf.set(hist);
        buf.set(t.out, hist.length);
        cost = deflateSync(buf, { level: bruteLevel, mem: 4 }).length;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = ft;
      }
    }
    const t = tries[best];
    out.set(t.out, y * (rb + 1));
    prev = t.row.slice();
  }
  return out;
}

export function strategiesFor(bitDepthBelow8: boolean, rawSize: number, effort: 'fast' | 'default' | 'max', hint?: Uint8Array): FilterStrategy[] {
  const list: FilterStrategy[] = [];
  if (hint) list.push({ kind: 'hint', rows: hint });
  if (effort === 'fast') {
    list.push({ kind: 'fixed', filter: 0 });
    if (!bitDepthBelow8) list.push({ kind: 'minsum' });
    return list;
  }
  for (const f of [0, 1, 2, 3, 4] as const) list.push({ kind: 'fixed', filter: f });
  // Bigrams/BigEnt (from oxipng) often win on smooth images; each brute-force depth wins on different content.
  list.push({ kind: 'minsum' }, { kind: 'entropy' }, { kind: 'bigrams' }, { kind: 'bigent' });
  if (effort === 'max' || rawSize <= 1 << 20) list.push({ kind: 'brute', context: 2, level: 6 }, { kind: 'brute', context: 4, level: 9 });
  if (effort === 'max') list.push({ kind: 'brute', context: 8, level: 9 });
  return list;
}
