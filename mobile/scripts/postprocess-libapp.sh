#!/usr/bin/env bash
#
# Post-process libapp.a for Xcode 27 / Swift 6 compatibility.
#
# On Xcode 27, SwiftPM internalizes @_cdecl functions in static library
# products (symbols become local 't'). While swift-rs attempts to promote
# symbols from the package's own module with llvm-objcopy, dependency modules
# like SwiftRs.o are excluded. As a result, _release_object, _retain_object,
# and _string_from_bytes remain local and the Xcode linker fails with
# undefined symbols.
#
# This script locates llvm-objcopy and marks those symbols as global (weak)
# in libapp.a before the final Xcode link step.

set -euo pipefail

export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SRCROOT="${SRCROOT:-"$MOBILE_DIR/src-tauri/gen/apple"}"
CONFIGURATION="${CONFIGURATION:-Release}"
ARCHS="${ARCHS:-arm64}"

# Locate llvm-objcopy
OBJCOPY=""
if command -v llvm-objcopy >/dev/null 2>&1; then
  OBJCOPY="$(command -v llvm-objcopy)"
else
  RUSTC_SYSROOT="$(rustc --print sysroot 2>/dev/null || true)"
  if [ -n "$RUSTC_SYSROOT" ]; then
    HOST_ARCH="$(uname -m)"
    if [ "$HOST_ARCH" = "arm64" ]; then
      RUST_HOST="aarch64-apple-darwin"
    elif [ "$HOST_ARCH" = "x86_64" ]; then
      RUST_HOST="x86_64-apple-darwin"
    else
      RUST_HOST="${HOST_ARCH}-apple-darwin"
    fi
    CANDIDATE="$RUSTC_SYSROOT/lib/rustlib/${RUST_HOST}/bin/llvm-objcopy"
    if [ -x "$CANDIDATE" ]; then
      OBJCOPY="$CANDIDATE"
    else
      rustup component add llvm-tools-preview llvm-tools >/dev/null 2>&1 || true
      if [ -x "$CANDIDATE" ]; then
        OBJCOPY="$CANDIDATE"
      else
        for candidate in "$RUSTC_SYSROOT"/lib/rustlib/*/bin/llvm-objcopy; do
          if [ -x "$candidate" ]; then
            OBJCOPY="$candidate"
            break
          fi
        done
      fi
    fi
  fi
fi

if [ -z "$OBJCOPY" ] || [ ! -x "$OBJCOPY" ]; then
  for candidate in "$HOME"/.rustup/toolchains/*/lib/rustlib/*/bin/llvm-objcopy; do
    if [ -x "$candidate" ]; then
      OBJCOPY="$candidate"
      break
    fi
  done
fi

if [ -z "$OBJCOPY" ] || [ ! -x "$OBJCOPY" ]; then
  echo "postprocess-libapp: error: llvm-objcopy not found in PATH or rust toolchains. Run 'rustup component add llvm-tools-preview'" >&2
  exit 1
fi

echo "postprocess-libapp: using $OBJCOPY"

PROCESSED=""
for arch in $ARCHS; do
  for config in "$CONFIGURATION" Release release Debug debug; do
    LIB="$SRCROOT/Externals/$arch/$config/libapp.a"
    if [ -f "$LIB" ]; then
      CANONICAL="$(cd "$(dirname "$LIB")" && pwd)/$(basename "$LIB")"
      case " $PROCESSED " in
        *" $CANONICAL "*) continue ;;
      esac
      PROCESSED="$PROCESSED $CANONICAL"
      echo "postprocess-libapp: globalizing @_cdecl symbols in $LIB"
      "$OBJCOPY" \
        --globalize-symbol=_release_object --weaken-symbol=_release_object \
        --globalize-symbol=_retain_object --weaken-symbol=_retain_object \
        --globalize-symbol=_string_from_bytes --weaken-symbol=_string_from_bytes \
        "$LIB"
    fi
  done
done
