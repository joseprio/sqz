import { zlibSync } from 'fflate';
import { ectModule, fhanauModule } from '../codecs.js';
import type { ZopfliModule } from '../wasm/sqz_zopfli_ect.js';

/** Quick zlib stream, used to rank candidates and as the `fast` effort output. */
export function deflateFast(data: Uint8Array, level: 6 | 9 = 9): Uint8Array {
  return zlibSync(data, { level, mem: 12 });
}

// sqz's deflate engine is ECT's zopfli (codecs/zopfli): same output size as stock zopfli,
// 2–4× faster. At max effort fhanau/zopfli also runs, since it occasionally wins.

/** ECT mode 9 is its strongest preset (`ect -9`); more iterations made no difference in testing. */
const ECT_LEVEL = 9;
const FHANAU_ITERATIONS = 15;

function run(m: ZopfliModule, data: Uint8Array, level: number): Uint8Array {
  const ptr = m._malloc(data.length);
  try {
    m.HEAPU8.set(data, ptr);
    if (!m._sqz_zlib(ptr, data.length, level)) throw new Error('zopfli failed');
    const out = m._sqz_out();
    return m.HEAPU8.slice(out, out + m._sqz_out_size());
  } finally {
    m._free(ptr);
  }
}

/** Zopfli zlib stream. Synchronous under the hood; run it in a worker to keep a UI responsive. */
export async function deflateZopfli(data: Uint8Array, effort: 'default' | 'max'): Promise<Uint8Array> {
  const best = run(await ectModule(), data, ECT_LEVEL);
  if (effort !== 'max') return best;
  const alt = run(await fhanauModule(), data, FHANAU_ITERATIONS);
  return alt.length < best.length ? alt : best;
}
