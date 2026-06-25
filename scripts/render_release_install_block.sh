#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

usage() {
    cat <<'EOF'
Usage: scripts/render_release_install_block.sh --version <version> [--assets-file <path>]

Render the GitHub release-notes Install block from the actual published asset
list. If --assets-file is omitted, the script fetches the asset list with
`gh release view`.

Examples:
  scripts/render_release_install_block.sh --version 1.65.0
  gh release view v1.65.0 --repo lthoangg/openagentd | grep '^asset:' > /tmp/assets.txt
  scripts/render_release_install_block.sh --version 1.65.0 --assets-file /tmp/assets.txt
EOF
}

VERSION=
ASSETS_FILE=

while [ $# -gt 0 ]; do
    case "$1" in
        --version)
            shift
            VERSION=${1:-}
            ;;
        --assets-file)
            shift
            ASSETS_FILE=${1:-}
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "error: unknown argument: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
    shift
done

if [ -z "$VERSION" ]; then
    echo "error: --version is required" >&2
    usage >&2
    exit 2
fi

ASSET_LINES=
if [ -n "$ASSETS_FILE" ]; then
    if [ ! -f "$ASSETS_FILE" ]; then
        echo "error: assets file not found: $ASSETS_FILE" >&2
        exit 1
    fi
    ASSET_LINES=$(cat "$ASSETS_FILE")
else
    ASSET_LINES=$(gh release view "v$VERSION" --repo lthoangg/openagentd | grep '^asset:' || true)
fi

has_asset() {
    needle=$1
    printf '%s\n' "$ASSET_LINES" | grep -F "$needle" >/dev/null 2>&1
}

HAS_MACOS=false
HAS_LINUX_APPIMAGE=false
HAS_LINUX_DEB=false

if has_asset "OpenAgentd_${VERSION}_aarch64.dmg"; then
    HAS_MACOS=true
fi
if has_asset "OpenAgentd_${VERSION}_amd64.AppImage"; then
    HAS_LINUX_APPIMAGE=true
fi
if has_asset "OpenAgentd_${VERSION}_amd64.deb"; then
    HAS_LINUX_DEB=true
fi

cat <<'EOF'
## Install

EOF

if [ "$HAS_MACOS" = true ] || [ "$HAS_LINUX_APPIMAGE" = true ] || [ "$HAS_LINUX_DEB" = true ]; then
    cat <<'EOF'
**Desktop app** — download from this release (CLI + desktop ship under one tag since 1.0.9):

EOF
    if [ "$HAS_MACOS" = true ]; then
        echo "- macOS Apple Silicon → \
\`brew install --cask lthoangg/tap/openagentd\` (recommended — ad-hoc signs automatically), or \
\`OpenAgentd_${VERSION}_aarch64.dmg\` (run bundled \`install.sh\`, right-click → Open the first time)."
    fi
    if [ "$HAS_LINUX_APPIMAGE" = true ] && [ "$HAS_LINUX_DEB" = true ]; then
        echo "- Linux → \`OpenAgentd_${VERSION}_amd64.AppImage\` (\`chmod +x\` and run) or \`OpenAgentd_${VERSION}_amd64.deb\`."
    elif [ "$HAS_LINUX_APPIMAGE" = true ]; then
        echo "- Linux → \`OpenAgentd_${VERSION}_amd64.AppImage\` (\`chmod +x\` and run)."
    elif [ "$HAS_LINUX_DEB" = true ]; then
        echo "- Linux → \`OpenAgentd_${VERSION}_amd64.deb\`."
    fi
    printf '\n'
fi

cat <<'EOF'
**CLI / API server**

```
uv tool install openagentd
# or
pip install openagentd
# or
brew install lthoangg/tap/openagentd
```

`brew install lthoangg/tap/openagentd` installs the base package only; optional extras (e.g. `openagentd[full]`) must be installed via `uv` or `pip`:

```
uv tool install "openagentd[full]"
# or
pip install "openagentd[full]"
```
EOF
