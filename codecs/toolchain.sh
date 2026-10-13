#!/usr/bin/env bash
# Installs the wasm build toolchain (emsdk, CMake, Ninja) into a user-local directory.
# No root needed. Only required to rebuild the codecs in codecs/*; the built .js/.wasm
# files are committed, so normal development and npm users never need this.
#
#   bash codecs/toolchain.sh          # install (idempotent)
#   source "$(bash codecs/toolchain.sh --env)"   # put the tools on PATH
set -euo pipefail

EMSDK_VERSION=6.0.10
CMAKE_VERSION=4.4.3
NINJA_VERSION=1.13.1
ROOT="${SQZ_TOOLCHAIN:-$HOME/.cache/sqz-toolchain}"
ENV_FILE="$ROOT/env.sh"

if [[ "${1:-}" == "--env" ]]; then
  echo "$ENV_FILE"
  exit 0
fi

mkdir -p "$ROOT"
cd "$ROOT"
arch="$(uname -m)"

if [[ ! -x "cmake-$CMAKE_VERSION/bin/cmake" ]]; then
  echo "==> CMake $CMAKE_VERSION"
  curl -fsSL "https://github.com/Kitware/CMake/releases/download/v$CMAKE_VERSION/cmake-$CMAKE_VERSION-linux-$arch.tar.gz" -o cmake.tgz
  rm -rf "cmake-$CMAKE_VERSION"
  mkdir "cmake-$CMAKE_VERSION"
  tar -xzf cmake.tgz -C "cmake-$CMAKE_VERSION" --strip-components=1
  rm cmake.tgz
fi

if [[ ! -x "ninja-$NINJA_VERSION/ninja" ]]; then
  echo "==> Ninja $NINJA_VERSION"
  suffix=$([[ "$arch" == "aarch64" ]] && echo "linux-aarch64" || echo "linux")
  curl -fsSL "https://github.com/ninja-build/ninja/releases/download/v$NINJA_VERSION/ninja-$suffix.zip" -o ninja.zip
  mkdir -p "ninja-$NINJA_VERSION"
  python3 -m zipfile -e ninja.zip "ninja-$NINJA_VERSION"
  chmod +x "ninja-$NINJA_VERSION/ninja"
  rm ninja.zip
fi

if [[ ! -d emsdk ]]; then
  echo "==> emsdk"
  git clone --quiet https://github.com/emscripten-core/emsdk.git
fi
if [[ ! -f "emsdk/.installed-$EMSDK_VERSION" ]]; then
  echo "==> Emscripten $EMSDK_VERSION"
  (cd emsdk && git fetch --quiet --tags && git checkout --quiet "$EMSDK_VERSION" && ./emsdk install "$EMSDK_VERSION" && ./emsdk activate "$EMSDK_VERSION" >/dev/null)
  touch "emsdk/.installed-$EMSDK_VERSION"
fi

cat > "$ENV_FILE" <<EOF
export PATH="$ROOT/cmake-$CMAKE_VERSION/bin:$ROOT/ninja-$NINJA_VERSION:\$PATH"
export EMSDK_QUIET=1
source "$ROOT/emsdk/emsdk_env.sh"
EOF
echo "Toolchain ready. Use it with: source $ENV_FILE"
