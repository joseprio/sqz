#!/usr/bin/env bash
# Builds src/wasm/sqz_zopfli_ect.{js,wasm} (ECT's zopfli, sqz's deflate engine) and
# src/wasm/sqz_zopfli_fhanau.{js,wasm} (fhanau/zopfli, also tried at max effort).
# Needs the toolchain from codecs/toolchain.sh (Linux or WSL). Output is committed.
#
#   bash codecs/toolchain.sh && bash codecs/zopfli/build.sh
set -euo pipefail

ECT_COMMIT=e711c5ea9d725d02db546ce926a66b91b68ecb3a
FHANAU_COMMIT=3315c43be52e189d947a645a5ecc790e320c35e3

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../../src/wasm"
BUILD="${SQZ_CODEC_BUILD:-$HOME/.cache/sqz-codec-build}/zopfli"

# shellcheck disable=SC1090
source "$(bash "$HERE/../toolchain.sh" --env)"
mkdir -p "$BUILD" "$OUT"
cd "$BUILD"

fetch() { # dir url commit
  if [[ ! -d "$1" ]]; then
    git init --quiet "$1"
    git -C "$1" remote add origin "$2"
  fi
  if [[ "$(git -C "$1" rev-parse HEAD 2>/dev/null)" != "$3" ]]; then
    git -C "$1" fetch --quiet --depth 1 origin "$3"
    git -C "$1" checkout --quiet FETCH_HEAD
  fi
}
fetch ect https://github.com/fhanau/Efficient-Compression-Tool.git "$ECT_COMMIT"
fetch fhanau https://github.com/fhanau/zopfli.git "$FHANAU_COMMIT"

LINK=(-O3 -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node -sALLOW_MEMORY_GROWTH=1
  -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=4MB -sFILESYSTEM=0 -sDYNAMIC_EXECUTION=0
  -sEXPORTED_FUNCTIONS=_sqz_zlib,_sqz_out,_sqz_out_size,_malloc,_free -sEXPORTED_RUNTIME_METHODS=HEAPU8)

echo "==> ECT zopfli ${ECT_COMMIT:0:7}"
rm -rf ect-obj && mkdir ect-obj
S=ect/src
CFLAGS=(-O3 -DNOMULTI=1 -DSQZ_ECT=1 -I"$S" -I"$S/zopfli" -I"$S/zlib" -Wno-everything)
for c in "$S"/zopfli/{blocksplitter,lz77,squeeze,util,zlib_container}.c "$S/LzFind.c" "$S"/zlib/{adler32,zutil}.c "$HERE/sqz_zopfli.c"; do
  emcc "${CFLAGS[@]}" -c "$c" -o "ect-obj/$(basename "$c" .c).o"
done
for c in "$S"/zopfli/{deflate,katajainen}.cpp; do
  em++ "${CFLAGS[@]}" -std=c++17 -c "$c" -o "ect-obj/$(basename "$c" .cpp).o"
done
em++ ect-obj/*.o "${LINK[@]}" -sEXPORT_NAME=createZopfliEct -o "$OUT/sqz_zopfli_ect.js"

echo "==> fhanau/zopfli ${FHANAU_COMMIT:0:7}"
mapfile -t SRCS < <(ls fhanau/src/zopfli/*.c | grep -v zopfli_bin.c)
emcc -O3 -Wno-everything -I fhanau/src/zopfli "$HERE/sqz_zopfli.c" "${SRCS[@]}" "${LINK[@]}" -sEXPORT_NAME=createZopfliFhanau -o "$OUT/sqz_zopfli_fhanau.js"

ls -la "$OUT"/sqz_zopfli_*
