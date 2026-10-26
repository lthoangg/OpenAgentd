# Build the desktop app and its backend sidecar: the native ``agentd``
# binary from ``appv3/``, copied to ``sidecar-bundle/bin/``.
#
# Targets:
#   make sidecar        Build the backend and stage it in ``sidecar-bundle/``.
#                       PROFILE=dist (default, fat LTO) or release (faster
#                       build); TARGET=<rust triple> to cross/pin a target.
#   make icons          Regenerate the app icons from the brand masters in
#                       documents/assets/brand/ (scripts/generate_icons.py).
#   make dev            Tauri shell + Vite dev server, using the bundled
#                       sidecar connection model. Run Vite in another terminal
#                       if you need frontend HMR.
#   make dev-bundled    Tauri shell with the *bundled* sidecar (requires
#                       ``make sidecar`` first). Use this to test the
#                       sidecar handshake / auth wiring end-to-end.
#   make build          Build a release desktop app from the existing bundle.
#   make build-dev-app  Build the sidecar, then a dev-identity .app bundle.
#   make open           Open the dev macOS app bundle.
#   make open-prod      Open the production macOS app bundle.
#   make clean          Remove build artefacts.
#
# Dev-mode two-terminal flow (``make dev``):
#
#     terminal 1:   cd web && bun dev          # Vite :5173 for HMR
#     terminal 2:   cd desktop && make dev     # Tauri shell → bundled sidecar
#
# The Tauri shell no longer points at an implicit dev backend. To use a
# standalone server, add it from the app's Server connection dialog.

.PHONY: sidecar icons dev dev-bundled build-dev-app build clean open open-prod

ROOT       := $(abspath ..)
BUNDLE     := sidecar-bundle
EXE        := $(if $(filter Windows_NT,$(OS)),.exe,)

# `dist` = fat LTO (smaller, a few % faster, ~3x slower build); use
# PROFILE=release for quicker local bundles. Profiles keep symbols
# (strip = false), so strip the bundled copy.
PROFILE    ?= dist
TARGET     ?=
BIN_DIR    := ../appv3/target/$(if $(TARGET),$(TARGET)/,)$(PROFILE)
sidecar:
	cargo build --locked --profile $(PROFILE) --manifest-path ../appv3/Cargo.toml -p appv3-cli $(if $(TARGET),--target $(TARGET),)
	@rm -rf "$(BUNDLE)"
	@mkdir -p "$(BUNDLE)/bin"
	@cp -f "$(BIN_DIR)/agentd$(EXE)" "$(BUNDLE)/bin/agentd$(EXE)"
	@# GNU strip (e.g. from Git Bash) can corrupt MSVC executables; skip it there.
	@if [ -z "$(EXE)" ] && command -v strip >/dev/null 2>&1; then strip "$(BUNDLE)/bin/agentd$(EXE)"; fi
	@"$(BUNDLE)/bin/agentd$(EXE)" --version
	@du -sh "$(BUNDLE)"

open:
	@open "src-tauri/target/release/bundle/macos/OpenAgentd (dev).app"

open-prod:
	@open "src-tauri/target/release/bundle/macos/OpenAgentd.app"

icons:
	python3 ../scripts/generate_icons.py

# Dev: load the debug WebView from Vite :5173 and use the same connection
# model as production: bundled sidecar by default, saved external servers
# only when selected from the app.
#
# ``-c tauri.dev.conf.json`` overrides the bundle identifier + product
# name so the dev build coexists with a Homebrew-cask-installed prod
# build (they get separate Dock icons, tray entries, and log dirs).
# Without this, macOS routes ``open -a OpenAgentd`` to whichever
# instance is already running, masking which app you're testing.
dev:
	@echo "→ Tauri dev shell. Make sure Vite (:5173) is running. Backend uses bundled sidecar when available."
	cd src-tauri && cargo tauri dev -c tauri.dev.conf.json

# Dev with the bundled backend sidecar — the closest thing to ``make build``
# without producing a .dmg. Useful for testing handshake, token injection,
# Job-Object cleanup, and the ``server serve`` entry path.
#
# The XDG roots are pinned to ``<repo>/.openagentd/dev/...`` so the bundled
# sidecar shares state (DB, config, workspace) with ``make dev`` at
# the repo root. Without these overrides ``OPENAGENTD_ENV=development`` would
# resolve them relative to the sidecar's cwd (``desktop/src-tauri/``).
dev-bundled:
	@$(MAKE) sidecar
	cd src-tauri && \
		OPENAGENTD_ENV=development \
		OPENAGENTD_DATA_DIR="$(ROOT)/.openagentd/dev/data" \
		OPENAGENTD_CONFIG_DIR="$(ROOT)/.openagentd/dev/config" \
		OPENAGENTD_STATE_DIR="$(ROOT)/.openagentd/dev/state" \
		OPENAGENTD_CACHE_DIR="$(ROOT)/.openagentd/dev/cache" \
		OPENAGENTD_WORKSPACE_DIR="$(ROOT)/.openagentd/dev/workspace" \
		cargo tauri dev -c tauri.dev-bundled.conf.json

build-dev-app:
	@$(MAKE) sidecar
	cd src-tauri && cargo tauri build -c tauri.dev-bundled.conf.json --bundles app

build:
	cd src-tauri && cargo tauri build

clean:
	rm -rf "$(BUNDLE)" src-tauri/target
