// Types for the emscripten module built by codecs/zopfli/build.sh.
export interface ZopfliModule {
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  /** Returns 1 on success; read the zlib stream via _sqz_out/_sqz_out_size. */
  _sqz_zlib(ptr: number, size: number, level: number): number;
  _sqz_out(): number;
  _sqz_out_size(): number;
}

export default function create(overrides?: Record<string, unknown>): Promise<ZopfliModule>;
