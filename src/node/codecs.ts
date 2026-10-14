import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { wasmLoaders } from '../codecs.js';

const require = createRequire(import.meta.url);
const compile = (spec: string) => async () => WebAssembly.compile(await readFile(require.resolve(spec)));

/** Emscripten can't fetch file:// URLs in Node, so hand jSquash precompiled modules (sqz's own AVIF build loads itself). */
export function registerNodeCodecs() {
  wasmLoaders.webpDec ??= compile('@jsquash/webp/codec/dec/webp_dec.wasm');
  // jSquash picks the SIMD WebP encoder when available, which every supported Node has.
  wasmLoaders.webpEnc ??= compile('@jsquash/webp/codec/enc/webp_enc_simd.wasm');
  wasmLoaders.jpegDec ??= compile('@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm');
  wasmLoaders.jpegEnc ??= compile('@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm');
}
