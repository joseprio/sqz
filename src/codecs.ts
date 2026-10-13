/**
 * Lazy access to the wasm codecs.
 *
 * WebP comes from jSquash. Browsers let it fetch its own .wasm next to the module;
 * Node registers loaders (see node/codecs.ts) because emscripten cannot fetch file URLs
 * there. AVIF is sqz's own libavif build (codecs/avif), which adds image sequences; its
 * glue finds the .wasm next to itself in both environments.
 */
import type { AvifModule } from './wasm/sqz_avif.js';

export interface DecodedImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

type Codec = 'webpDec' | 'webpEnc';
type WasmLoader = () => Promise<WebAssembly.Module>;
export const wasmLoaders: Partial<Record<Codec, WasmLoader>> = {};

type Decoder = (b: ArrayBuffer) => Promise<DecodedImage>;
type Encoder = (img: { data: Uint8ClampedArray; width: number; height: number }, opts: Record<string, unknown>) => Promise<ArrayBuffer>;

const cache: Partial<Record<Codec, Promise<unknown>>> = {};

function load<T>(codec: Codec, importer: () => Promise<{ init: (m?: WebAssembly.Module) => unknown; default: unknown }>): Promise<T> {
  cache[codec] ??= (async () => {
    const mod = await importer();
    const loader = wasmLoaders[codec];
    if (loader) await mod.init(await loader());
    return mod.default;
  })();
  return cache[codec] as Promise<T>;
}

export const webpDecoder = () => load<Decoder>('webpDec', () => import('@jsquash/webp/decode.js'));
export const webpEncoder = () => load<Encoder>('webpEnc', () => import('@jsquash/webp/encode.js') as never);

let avif: Promise<AvifModule> | undefined;
export function avifModule(): Promise<AvifModule> {
  avif ??= import('./wasm/sqz_avif.js').then((m) => m.default());
  return avif;
}

/** Exactly the view's bytes; Node Buffers are views into a larger shared pool. */
export function toArrayBuffer(b: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(b.length);
  copy.set(b);
  return copy.buffer;
}
