// Minimal wasm entry point for zopfli: zlib-wrapped deflate of one buffer.
// Built twice (see build.sh): against ECT's zopfli (SQZ_ECT, the default engine) and
// against fhanau/zopfli (tried in addition at max effort). Both export the same API.
#include <stdlib.h>

#include <emscripten/emscripten.h>

#include "zopfli.h"
#ifdef SQZ_ECT
#include "zlib_container.h"
#endif

static unsigned char* out_data = 0;
static size_t out_size = 0;

/**
 * Compresses `in` into a zlib stream, readable via sqz_out()/sqz_out_size() until the
 * next call. `level` is ECT's mode (2–9, or >9 = mode 9 with that many iterations) for
 * the ECT build, and the iteration count for the plain zopfli build.
 */
EMSCRIPTEN_KEEPALIVE int sqz_zlib(const unsigned char* in, size_t in_size, int level) {
  free(out_data);
  out_data = 0;
  out_size = 0;
  ZopfliOptions options;
#ifdef SQZ_ECT
  ZopfliInitOptions(&options, (unsigned)level, 0, 1);
  ZopfliZlibCompress(&options, in, in_size, &out_data, &out_size);
#else
  ZopfliInitOptions(&options);
  options.numiterations = level;
  options.blocksplitting = 1;
  options.blocksplittingmax = 15;
  ZopfliCompress(&options, ZOPFLI_FORMAT_ZLIB, in, in_size, &out_data, &out_size);
#endif
  return out_data != 0;
}

EMSCRIPTEN_KEEPALIVE unsigned char* sqz_out(void) { return out_data; }
EMSCRIPTEN_KEEPALIVE size_t sqz_out_size(void) { return out_size; }
