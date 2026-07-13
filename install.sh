#!/bin/sh
# install.sh — one-command desktop app installer for OpenAgentd on macOS / Linux.
#
# Usage:
#     curl -LsSf https://raw.githubusercontent.com/lthoangg/openagentd/main/install.sh | sh
#     ./install.sh
#     ./install.sh --version 1.102.0
#
# Installs the macOS Apple Silicon app into /Applications or the Linux x86_64
# .deb package through apt. Release artefacts are downloaded from GitHub.

set -eu

REPO="lthoangg/openagentd"
VERSION=""

usage() {
    cat <<'EOF'
OpenAgentd desktop app installer for macOS and Linux.

Usage:
    install.sh [--version VERSION]

Options:
    --version VERSION  Install a specific release (for example, 1.102.0).
    -h, --help         Show this help.

Supported platforms:
    macOS 11+ on Apple Silicon
    Debian/Ubuntu Linux on x86_64
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
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
        step "Finding the latest OpenAgentd desktop release"
        release_url="$(curl -LsSf -o /dev/null -w '%{url_effective}' \
            "https://github.com/${REPO}/releases/latest")" \
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
    url="https://github.com/${REPO}/releases/download/v${VERSION}/${asset}"
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
    url="https://github.com/${REPO}/releases/download/v${VERSION}/${asset}"
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

resolve_version

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT HUP INT TERM

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
