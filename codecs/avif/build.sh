#!/usr/bin/env bash
# Builds src/wasm/sqz_avif.{js,wasm}: libavif + libaom with image-sequence support.
# Needs the toolchain from codecs/toolchain.sh (Linux or WSL). Output is committed.
#
#   bash codecs/toolchain.sh && bash codecs/avif/build.sh
set -euo pipefail

LIBAVIF_VERSION=v1.4.1
AOM_VERSION=v3.15.1

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../../src/wasm"
BUILD="${SQZ_CODEC_BUILD:-$HOME/.cache/sqz-codec-build/avif}"
JOBS="$(nproc)"

# shellcheck disable=SC1090
source "$(bash "$HERE/../toolchain.sh" --env)"
mkdir -p "$BUILD" "$OUT"
cd "$BUILD"

fetch() { # name url tag
  if [[ ! -d "$1" ]]; then git clone --quiet --depth 1 --branch "$3" "$2" "$1"; fi
  (cd "$1" && [[ "$(git describe --tags --exact-match 2>/dev/null)" == "$3" ]]) || { echo "$1 is not at $3; delete $BUILD/$1"; exit 1; }
}
fetch aom https://aomedia.googlesource.com/aom "$AOM_VERSION"
fetch libavif https://github.com/AOMediaCodec/libavif.git "$LIBAVIF_VERSION"

echo "==> libaom $AOM_VERSION"
emcmake cmake -S aom -B aom-build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DAOM_TARGET_CPU=generic \
  -DCONFIG_RUNTIME_CPU_DETECT=0 \
  -DCONFIG_MULTITHREAD=0 \
  -DCONFIG_AV1_HIGHBITDEPTH=1 \
  -DCONFIG_WEBM_IO=0 \
  -DENABLE_CCACHE=0 \
  -DENABLE_DOCS=0 \
  -DENABLE_EXAMPLES=0 \
  -DENABLE_TESTDATA=0 \
  -DENABLE_TESTS=0 \
  -DENABLE_TOOLS=0 \
  -DENABLE_NASM=0 >/dev/null
cmake --build aom-build -j "$JOBS"

echo "==> libavif $LIBAVIF_VERSION"
emcmake cmake -S libavif -B libavif-build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DAVIF_CODEC_AOM=SYSTEM \
  -DAOM_INCLUDE_DIR="$BUILD/aom" \
  -DAOM_LIBRARY="$BUILD/aom-build/libaom.a" \
  -DAVIF_LIBYUV=OFF \
  -DAVIF_LIBSHARPYUV=OFF \
  -DAVIF_LIBXML2=OFF \
  -DAVIF_BUILD_APPS=OFF \
  -DAVIF_BUILD_TESTS=OFF \
  -DAVIF_ENABLE_WERROR=OFF >/dev/null
cmake --build libavif-build -j "$JOBS"

echo "==> sqz_avif"
em++ -O3 -std=c++17 \
  -I libavif/include \
  "$HERE/sqz_avif.cpp" \
  libavif-build/libavif.a aom-build/libaom.a \
  -lembind \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sEXPORT_NAME=createAvifModule \
  -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 \
  -sMAXIMUM_MEMORY=4GB \
  -sSTACK_SIZE=1MB \
  -sFILESYSTEM=0 \
  -sDYNAMIC_EXECUTION=0 \
  -o "$OUT/sqz_avif.js"

ls -la "$OUT"/sqz_avif.*
echo "Built with libavif $LIBAVIF_VERSION, libaom $AOM_VERSION, emscripten $(emcc --version | head -1 | grep -o '[0-9.]*' | head -1)"
