#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# OpenAgentd installer for macOS + Linux.
#
# Windows users: run the bundled ``OpenAgentd-x.y.z-x64.msi`` installer
# instead. It already handles registration, Start Menu shortcut, and
# uninstall. (SmartScreen may warn on first launch — click "More info"
# → "Run anyway"; the binary is unsigned but not malicious.)
#
# ──────────────────────────────────────────────────────────────────────────────
# macOS branch
# ──────────────────────────────────────────────────────────────────────────────
# We don't ship a paid Apple Developer ID, so CI signs the app ad hoc
# (with a designated requirement that stays the same across releases,
# so macOS keeps folder-access grants on update). Gatekeeper rejects such
# an app when it was downloaded, i.e. carries the quarantine flag:
#
#     "OpenAgentd.app" is damaged and can't be opened. You should
#      move it to the Trash.
#
# The bundle is fine; removing the flag is enough. The app is not
# re-signed here: it is installed exactly as CI signed it.
#
# Steps:
#   1. Strip ``com.apple.quarantine`` xattr (set by the browser).
#   2. Verify the signature (a modified bundle fails here).
#   3. (Optional, with ``--install``) copy to /Applications.
#
# ──────────────────────────────────────────────────────────────────────────────
# Linux branch
# ──────────────────────────────────────────────────────────────────────────────
# Linux has no Gatekeeper-equivalent; signing is unnecessary. We
# instead:
#   1. ``chmod +x`` the AppImage / extracted binary.
#   2. Move it to ``~/.local/bin/openagentd`` (user-local, no sudo).
#   3. Drop a ``.desktop`` file under
#      ``~/.local/share/applications/`` so it appears in launchers.
#   4. Drop an icon under ``~/.local/share/icons/hicolor/.../apps/``.
#   5. Refresh the desktop database if ``update-desktop-database`` is
#      available.
#
# Both branches share the bundle-detection logic and the CLI surface.
#
# ──────────────────────────────────────────────────────────────────────────────
# Usage
# ──────────────────────────────────────────────────────────────────────────────
#     # Run with no args from the directory containing the bundle:
#     ./install.sh
#
#     # Point at a specific bundle / binary:
#     ./install.sh /path/to/OpenAgentd.app           # macOS
#     ./install.sh /path/to/OpenAgentd.AppImage      # Linux
#
#     # Also install into a system location (macOS → /Applications,
#     # Linux → ~/.local/bin + .desktop entry):
#     ./install.sh --install
#
# Exit codes:
#   0  success
#   1  cannot locate bundle / unsupported platform
#   2  chmod failed (Linux)
#   3  verification failed (macOS)
#   4  install copy failed
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── ANSI colors (TTY only) ────────────────────────────────────────────────────
if [ -t 1 ]; then
  RED=$'\033[0;31m'
  YELLOW=$'\033[0;33m'
  GREEN=$'\033[0;32m'
  BLUE=$'\033[0;34m'
  BOLD=$'\033[1m'
  RESET=$'\033[0m'
else
  RED= YELLOW= GREEN= BLUE= BOLD= RESET=
fi

info() { printf '%s[oad]%s %s\n' "$BLUE"   "$RESET" "$*" >&2; }
warn() { printf '%s[oad]%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
ok()   { printf '%s[oad]%s %s\n' "$GREEN"  "$RESET" "$*" >&2; }
fail() { printf '%s[oad]%s %s\n' "$RED"    "$RESET" "$*" >&2; }

# ── Argument parsing ──────────────────────────────────────────────────────────
DO_INSTALL=0
TARGET=""
for arg in "$@"; do
  case "$arg" in
    --install)
      DO_INSTALL=1
      ;;
    --force)
      # Re-signed the app before v3.22.0; nothing re-signs it now.
      warn "--force is no longer needed; ignoring it."
      ;;
    -h|--help)
      # The comment block at the top of this file.
      awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
      exit 0
      ;;
    --*)
      fail "Unknown option: $arg"
      exit 1
      ;;
    *)
      TARGET="$arg"
      ;;
  esac
done

# ── Detect platform ───────────────────────────────────────────────────────────
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
uname_s="$(uname -s)"

case "$uname_s" in
  Darwin) PLATFORM=macos ;;
  Linux)  PLATFORM=linux ;;
  *)
    fail "Unsupported platform: $uname_s"
    fail "Windows users: run OpenAgentd-*.msi instead."
    exit 1
    ;;
esac

info "Platform: ${BOLD}${PLATFORM}${RESET}"

# ════════════════════════════════════════════════════════════════════════════════
# macOS branch
# ════════════════════════════════════════════════════════════════════════════════
if [ "$PLATFORM" = "macos" ]; then

  # ── Locate the .app bundle ──────────────────────────────────────────────────
  BUNDLE="$TARGET"
  if [ -z "$BUNDLE" ]; then
    for candidate in \
      "$script_dir/OpenAgentd.app" \
      "$script_dir/../OpenAgentd.app" \
      "$PWD/OpenAgentd.app"; do
      if [ -d "$candidate" ]; then
        BUNDLE="$candidate"
        break
      fi
    done
  fi

  if [ -z "$BUNDLE" ] || [ ! -d "$BUNDLE" ] || [ "${BUNDLE##*.}" != "app" ]; then
    fail "Cannot find OpenAgentd.app. Pass the path explicitly:"
    fail "    $0 /path/to/OpenAgentd.app"
    exit 1
  fi

  BUNDLE="$(cd -- "$BUNDLE" && pwd)"
  info "Bundle: ${BOLD}${BUNDLE}${RESET}"

  # ── 1. Strip quarantine xattr ───────────────────────────────────────────────
  # Without this, even a freshly-signed bundle will trigger
  # Gatekeeper's first-launch translocation, which copies the app to
  # a read-only location and silently breaks the sidecar discovery.
  info "Stripping quarantine xattr…"
  if xattr -p com.apple.quarantine "$BUNDLE" &>/dev/null; then
    xattr -dr com.apple.quarantine "$BUNDLE" || warn "xattr -dr returned non-zero"
    ok "Quarantine xattr removed"
  else
    ok "No quarantine xattr present"
  fi
  xattr -cr "$BUNDLE" 2>/dev/null || true

  # ── 2. Verify ───────────────────────────────────────────────────────────────
  # CI signed the bundle; a failure means it was modified or is incomplete.
  info "Verifying signature…"
  if ! codesign --verify --deep --strict --verbose=1 "$BUNDLE" 2>&1 | sed 's/^/  /'; then
    fail "Verification failed. Download OpenAgentd again."
    exit 3
  fi
  ok "Signature verified"

  # ── 3. Optional: install to /Applications ───────────────────────────────────
  if [ "$DO_INSTALL" = "1" ]; then
    bundle_name="$(basename "$BUNDLE")"
    dest="/Applications/$bundle_name"
    if [ -d "$dest" ]; then
      warn "Overwriting existing $dest"
      rm -rf "$dest"
    fi
    info "Copying to $dest …"
    if ! ditto "$BUNDLE" "$dest"; then
      fail "Copy failed."
      exit 4
    fi
    ok "Installed to $dest"
  fi

  ok "${BOLD}Done.${RESET} You can launch OpenAgentd now."
  exit 0
fi

# ════════════════════════════════════════════════════════════════════════════════
# Linux branch
# ════════════════════════════════════════════════════════════════════════════════
if [ "$PLATFORM" = "linux" ]; then

  # ── Locate the binary / AppImage ────────────────────────────────────────────
  # Tauri produces several Linux artifacts; we accept any of them.
  # Preference order: AppImage (self-contained) → standalone binary
  # → .deb (defer to dpkg).
  BINARY="$TARGET"
  if [ -z "$BINARY" ]; then
    for candidate in \
      "$script_dir"/OpenAgentd*.AppImage \
      "$script_dir"/../OpenAgentd*.AppImage \
      "$PWD"/OpenAgentd*.AppImage \
      "$script_dir/openagentd" \
      "$script_dir/../openagentd"; do
      # Glob expansion can leave the literal pattern if there's no
      # match — guard with [ -f ].
      if [ -f "$candidate" ]; then
        BINARY="$candidate"
        break
      fi
    done
  fi

  if [ -z "$BINARY" ] || [ ! -f "$BINARY" ]; then
    fail "Cannot find OpenAgentd binary / AppImage. Pass the path explicitly:"
    fail "    $0 /path/to/OpenAgentd.AppImage"
    exit 1
  fi

  # If user handed us a .deb, defer to the package manager.
  case "$BINARY" in
    *.deb)
      info "Detected .deb package; deferring to dpkg."
      if ! sudo dpkg -i "$BINARY"; then
        fail "dpkg install failed. Try: sudo apt-get install -f"
        exit 4
      fi
      ok "${BOLD}Done.${RESET}"
      exit 0
      ;;
    *.rpm)
      info "Detected .rpm package; deferring to rpm."
      if ! sudo rpm -Uvh "$BINARY"; then
        fail "rpm install failed."
        exit 4
      fi
      ok "${BOLD}Done.${RESET}"
      exit 0
      ;;
  esac

  BINARY="$(cd -- "$(dirname -- "$BINARY")" && pwd)/$(basename -- "$BINARY")"
  info "Binary: ${BOLD}${BINARY}${RESET}"

  # ── 1. Make it executable ───────────────────────────────────────────────────
  if [ ! -x "$BINARY" ]; then
    info "Setting executable bit…"
    if ! chmod +x "$BINARY"; then
      fail "chmod failed."
      exit 2
    fi
  fi
  ok "Executable"

  if [ "$DO_INSTALL" = "0" ]; then
    ok "${BOLD}Done.${RESET} Launch with: ${BINARY}"
    ok "Pass ${BOLD}--install${RESET} to register a desktop launcher entry."
    exit 0
  fi

  # ── 2. Install to ~/.local/bin ──────────────────────────────────────────────
  # Per the XDG Base Directory spec, user-local executables go in
  # ``$XDG_BIN_HOME`` (with ``~/.local/bin`` as the conventional
  # fallback). This is on $PATH by default on Ubuntu 22.04+ /
  # Fedora 36+; older distros need the user to add it manually.
  bin_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
  mkdir -p "$bin_dir"
  dest_bin="$bin_dir/openagentd"
  info "Copying binary to $dest_bin …"
  if ! install -m 0755 "$BINARY" "$dest_bin"; then
    fail "install(1) failed."
    exit 4
  fi
  ok "Binary installed"

  # ── 3. Drop a .desktop entry ────────────────────────────────────────────────
  apps_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$apps_dir"
  desktop_file="$apps_dir/openagentd.desktop"

  # ``Exec=`` must be an absolute path or a basename on $PATH. We
  # use the absolute path to avoid surprises when ~/.local/bin
  # isn't on $PATH yet.
  cat > "$desktop_file" <<DESKTOP
[Desktop Entry]
Type=Application
Name=OpenAgentd
GenericName=Coding Agent
Comment=The coding agent that shows its work
Exec=${dest_bin} %U
Icon=openagentd
Terminal=false
Categories=Development;Utility;Office;
StartupWMClass=OpenAgentd
StartupNotify=true
Keywords=AI;assistant;llm;chat;
DESKTOP
  chmod 0644 "$desktop_file"
  ok "Desktop entry: $desktop_file"

  # ── 4. Copy icon if present ─────────────────────────────────────────────────
  # Tauri ships icons under ``icons/`` next to the bundle; the
  # 512×512 PNG is the canonical one for the hicolor theme.
  icons_root="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"
  for size in 32 64 128 256 512; do
    for src in \
      "$script_dir/icons/${size}x${size}.png" \
      "$script_dir/../icons/${size}x${size}.png" \
      "$script_dir/icons/${size}x${size}@2x.png"; do
      if [ -f "$src" ]; then
        target_dir="$icons_root/${size}x${size}/apps"
        mkdir -p "$target_dir"
        cp -f "$src" "$target_dir/openagentd.png"
      fi
    done
  done

  # ── 5. Refresh desktop / icon caches ────────────────────────────────────────
  # These commands are optional — distros without them still pick
  # up the .desktop file on next login. We swallow errors so a
  # missing tool doesn't fail the install.
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$apps_dir" >/dev/null 2>&1 || true
  fi
  if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -f -t "$icons_root" >/dev/null 2>&1 || true
  fi

  # ── 6. PATH sanity check ────────────────────────────────────────────────────
  case ":$PATH:" in
    *":$bin_dir:"*)
      ok "${BOLD}Done.${RESET} Launch with: ${BOLD}openagentd${RESET}"
      ;;
    *)
      warn "${bin_dir} is not on \$PATH. Add this to your shell rc:"
      warn "    export PATH=\"${bin_dir}:\$PATH\""
      warn "Or launch via the desktop menu / file manager."
      ;;
  esac

  exit 0
fi
