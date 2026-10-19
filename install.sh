#!/bin/sh
# install.sh — one-command installer for OpenAgentd on macOS / Linux.
#
# Usage:
#     curl -LsSf https://raw.githubusercontent.com/lthoangg/openagentd/main/install.sh | sh
#     curl -LsSf https://raw.githubusercontent.com/lthoangg/openagentd/main/install.sh | sh -s -- --cli
#     ./install.sh --version 3.0.0
#
# Default: installs the macOS Apple Silicon app into /Applications or the
# Linux x86_64 .deb package through apt.
# --cli: installs the `agentd` command-line binary (macOS arm64/x86_64,
# Linux x86_64/arm64) into ~/.local/bin, verified against its .sha256, and
# removes an OpenAgentd v2 (Python) install made with uv or pipx. Releases
# also ship `openagentd`, the binary's former name, as an alias.
#
# Release artefacts are downloaded from GitHub. OPENAGENTD_RELEASES_URL
# overrides the releases base URL (used by tests against a local server).

set -eu

REPO="lthoangg/openagentd"
RELEASES_URL="${OPENAGENTD_RELEASES_URL:-https://github.com/${REPO}/releases}"
VERSION=""
MODE="desktop"
INSTALL_DIR="${OPENAGENTD_INSTALL_DIR:-$HOME/.local/bin}"

usage() {
    cat <<'EOF'
OpenAgentd installer for macOS and Linux.

Usage:
    install.sh [--cli [--dir DIR]] [--version VERSION]

Options:
    --cli              Install the `agentd` command-line tool instead of
                       the desktop app.
    --dir DIR          Where --cli puts the binary (default: ~/.local/bin,
                       or $OPENAGENTD_INSTALL_DIR).
    --version VERSION  Install a specific release (for example, 3.0.0).
    -h, --help         Show this help.

Supported platforms:
    Desktop app: macOS 11+ on Apple Silicon, Debian/Ubuntu Linux on x86_64
    CLI:         macOS on Apple Silicon or Intel, Linux (glibc) on x86_64 or arm64
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --cli)
            MODE="cli"
            shift
            ;;
        --dir)
            shift
            if [ $# -eq 0 ]; then
                echo "error: --dir requires an argument" >&2
                exit 2
            fi
            INSTALL_DIR="$1"
            shift
            ;;
        --version)
            shift
            if [ $# -eq 0 ]; then
                echo "error: --version requires an argument" >&2
                exit 2
            fi
            VERSION="${1#v}"
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "error: unknown argument: $1" >&2
            echo "run with --help for usage" >&2
            exit 2
            ;;
    esac
done

if [ -t 1 ]; then
    BOLD="$(printf '\033[1m')"
    DIM="$(printf '\033[2m')"
    GREEN="$(printf '\033[32m')"
    RESET="$(printf '\033[0m')"
else
    BOLD=""; DIM=""; GREEN=""; RESET=""
fi

say()  { printf '%s\n' "$*"; }
step() { printf '%s==>%s %s\n' "$GREEN" "$RESET" "$*"; }
note() { printf '%s%s%s\n' "$DIM" "$*" "$RESET"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || fail "curl is required"

resolve_version() {
    if [ -z "$VERSION" ]; then
        step "Finding the latest OpenAgentd release"
        release_url="$(curl -LsSf -o /dev/null -w '%{url_effective}' \
            "${RELEASES_URL}/latest")" \
            || fail "could not resolve the latest GitHub release"
        VERSION="${release_url##*/}"
        VERSION="${VERSION#v}"
    fi

    case "$VERSION" in
        ""|*[!A-Za-z0-9._-]*)
            fail "invalid version: $VERSION"
            ;;
    esac
}

install_macos() {
    arch="$(uname -m)"
    [ "$arch" = "arm64" ] || fail "macOS desktop releases require Apple Silicon (found $arch)"
    command -v tar >/dev/null 2>&1 || fail "tar is required"

    asset="OpenAgentd.app.tar.gz"
    url="${RELEASES_URL}/download/v${VERSION}/${asset}"
    archive="$tmpdir/$asset"

    step "Downloading ${BOLD}OpenAgentd ${VERSION}${RESET} for macOS"
    note "    Source: $url"
    curl -LsSf --retry 3 -o "$archive" "$url" \
        || fail "failed to download $asset"

    step "Extracting the desktop app"
    tar -xzf "$archive" -C "$tmpdir"
    bundle="$tmpdir/OpenAgentd.app"
    [ -d "$bundle" ] || fail "the release archive does not contain OpenAgentd.app"

    helper="$bundle/Contents/Resources/install.sh"
    [ -f "$helper" ] || fail "the release archive does not contain the desktop installer"

    step "Installing ${BOLD}OpenAgentd.app${RESET} into /Applications"
    # The bundled installer removes quarantine, applies the required local
    # ad-hoc signature, verifies it, and copies the app into /Applications.
    bash "$helper" --install "$bundle"
}

install_linux() {
    arch="$(uname -m)"
    case "$arch" in
        x86_64|amd64) ;;
        *) fail "Linux desktop releases require x86_64 (found $arch)" ;;
    esac
    command -v apt-get >/dev/null 2>&1 \
        || fail "Linux desktop installation currently requires Debian/Ubuntu (apt-get)"

    asset="OpenAgentd_${VERSION}_amd64.deb"
    url="${RELEASES_URL}/download/v${VERSION}/${asset}"
    package="$tmpdir/$asset"

    step "Downloading ${BOLD}OpenAgentd ${VERSION}${RESET} for Linux"
    note "    Source: $url"
    curl -LsSf --retry 3 -o "$package" "$url" \
        || fail "failed to download $asset"

    step "Installing the ${BOLD}OpenAgentd desktop app${RESET}"
    if [ "$(id -u)" -eq 0 ]; then
        apt-get install -y "$package"
    elif command -v sudo >/dev/null 2>&1; then
        sudo apt-get install -y "$package"
    else
        fail "sudo is required to install the Linux desktop package"
    fi
}

# Rust target triple of the CLI archive for this machine.
cli_target() {
    os="$(uname -s)"
    arch="$(uname -m)"
    case "$os" in
        Darwin)
            # A shell running under Rosetta reports x86_64 on Apple Silicon;
            # prefer the native build there.
            if [ "$arch" = "x86_64" ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = "1" ]; then
                arch="arm64"
            fi
            case "$arch" in
                arm64|aarch64) TARGET="aarch64-apple-darwin" ;;
                *) fail "Intel Macs are not supported; prebuilt CLI releases are Apple Silicon only" ;;
            esac
            ;;
        Linux)
            if ldd --version 2>&1 | grep -qi musl; then
                fail "musl-based Linux (e.g. Alpine) is not supported yet; the CLI needs glibc"
            fi
            case "$arch" in
                x86_64|amd64) TARGET="x86_64-unknown-linux-gnu" ;;
                *) fail "unsupported Linux architecture: $arch (prebuilt CLI releases are x86_64 only)" ;;
            esac
            ;;
        *) fail "unsupported platform: $os" ;;
    esac
}

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | cut -d' ' -f1
    else
        fail "sha256sum or shasum is required to verify the download"
    fi
}

# OpenAgentd v2 was a Python package. Its uv/pipx shim usually sits in
# ~/.local/bin too, so remove it *before* placing v3 (uninstalling later
# could delete the new binary). A pip install cannot be removed safely from
# here; the PATH check at the end points it out instead.
remove_v2() {
    if command -v uv >/dev/null 2>&1 && uv tool list 2>/dev/null | grep -q '^openagentd '; then
        step "Removing OpenAgentd v2 (installed with uv)"
        uv tool uninstall openagentd || fail "could not remove the v2 uv tool; run: uv tool uninstall openagentd"
    fi
    if command -v pipx >/dev/null 2>&1 && pipx list --short 2>/dev/null | grep -q '^openagentd '; then
        step "Removing OpenAgentd v2 (installed with pipx)"
        pipx uninstall openagentd || fail "could not remove the v2 pipx package; run: pipx uninstall openagentd"
    fi
}

install_cli() {
    command -v tar >/dev/null 2>&1 || fail "tar is required"
    cli_target
    if command -v brew >/dev/null 2>&1 && brew list --formula openagentd >/dev/null 2>&1; then
        fail "openagentd is installed with Homebrew; update it with: brew upgrade openagentd"
    fi

    asset="openagentd-${VERSION}-${TARGET}.tar.gz"
    url="${RELEASES_URL}/download/v${VERSION}/${asset}"
    archive="$tmpdir/$asset"

    step "Downloading ${BOLD}agentd ${VERSION}${RESET} (${TARGET})"
    note "    Source: $url"
    curl -LsSf --retry 3 -o "$archive" "$url" || fail "failed to download $asset"
    curl -LsSf --retry 3 -o "$archive.sha256" "$url.sha256" || fail "failed to download $asset.sha256"

    expected="$(cut -d' ' -f1 < "$archive.sha256")"
    actual="$(sha256_of "$archive")"
    [ -n "$expected" ] && [ "$expected" = "$actual" ] \
        || fail "checksum mismatch for $asset (expected $expected, got $actual)"

    stage="$tmpdir/stage"
    mkdir -p "$stage"
    tar -xzf "$archive" -C "$stage"
    # Releases before the rename (pinned with --version) only have `openagentd`.
    BIN_NAME="agentd"
    [ -x "$stage/$BIN_NAME" ] || BIN_NAME="openagentd"
    [ -x "$stage/$BIN_NAME" ] || fail "the archive does not contain the agentd binary"
    "$stage/$BIN_NAME" --version >/dev/null 2>&1 \
        || fail "the downloaded binary does not run on this machine"

    remove_v2

    step "Installing into ${BOLD}${INSTALL_DIR}${RESET}"
    mkdir -p "$INSTALL_DIR"
    # Every executable at the archive root, replaced by rename so a running
    # copy (or a leftover symlink) is swapped rather than written through.
    for f in "$stage"/*; do
        [ -f "$f" ] && [ -x "$f" ] || continue
        name="${f##*/}"
        cp "$f" "$INSTALL_DIR/.$name.tmp.$$"
        chmod 755 "$INSTALL_DIR/.$name.tmp.$$"
        mv -f "$INSTALL_DIR/.$name.tmp.$$" "$INSTALL_DIR/$name"
    done
    note "    $("$INSTALL_DIR/$BIN_NAME" --version)"
}

cli_path_hints() {
    case ":$PATH:" in
        *":$INSTALL_DIR:"*) ;;
        *)
            say "Add ${BOLD}${INSTALL_DIR}${RESET} to your PATH, for example:"
            say "    echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.profile"
            return
            ;;
    esac
    for name in "$BIN_NAME" openagentd; do
        found="$(command -v "$name" 2>/dev/null || true)"
        if [ -n "$found" ] && [ "$found" != "$INSTALL_DIR/$name" ]; then
            say "Warning: ${BOLD}${found}${RESET} comes first on your PATH."
            if [ "$name" = openagentd ]; then
                say "    If it is OpenAgentd v2 installed with pip, remove it with: python3 -m pip uninstall openagentd"
            fi
            break
        fi
    done
}

resolve_version

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT HUP INT TERM

if [ "$MODE" = "cli" ]; then
    install_cli
    say ""
    step "${BOLD}Installed ${BIN_NAME} ${VERSION}!${RESET}"
    cli_path_hints
    say "Next: run ${BOLD}${BIN_NAME} --help${RESET}, or ${BOLD}${BIN_NAME} server start --wait${RESET}."
    note "      It uses the same config and data as OpenAgentd v2 and the desktop app."
    say ""
    exit 0
fi

case "$(uname -s)" in
    Darwin) install_macos ;;
    Linux) install_linux ;;
    *) fail "unsupported platform: $(uname -s)" ;;
esac

say ""
step "${BOLD}Installed OpenAgentd ${VERSION}!${RESET}"
case "$(uname -s)" in
    Darwin) say "Next: open ${BOLD}OpenAgentd${RESET} from Applications." ;;
    Linux)  say "Next: open ${BOLD}OpenAgentd${RESET} from your application menu." ;;
esac
note "      The desktop app includes and manages its own local server."
say ""
