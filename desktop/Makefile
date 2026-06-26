# Build the desktop app and its Python sidecar.
#
# Targets:
#   make sidecar        Build a slim Python sidecar bundle for the current OS/arch.
#   make sidecar-full   Same, but with [audio,azure-doc-intel] extras.
#   make icons          Regenerate .icns / .ico from icons/icon.png.
#   make dev            Tauri shell + Vite dev server, using the bundled
#                       sidecar connection model. Run Vite in another terminal
#                       if you need frontend HMR.
#   make dev-bundled    Tauri shell with the *bundled* sidecar (requires
#                       ``make sidecar`` first). Use this to test the
#                       sidecar handshake / auth wiring end-to-end.
#   make build          Build a release desktop app.
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

.PHONY: sidecar sidecar-full icons dev dev-bundled build-dev-app build clean open open-prod

ROOT       := $(abspath ..)
BUNDLE     := sidecar-bundle
PYVER      := 3.14
EXTRAS     ?=                       # set to e.g. "audio,azure-doc-intel,full"
sidecar:
	@python3 ../scripts/build_sidecar.py \
		--root "$(ROOT)" \
		--out  "$(BUNDLE)" \
		--python-version "$(PYVER)" \
		$(if $(EXTRAS),--extras "$(EXTRAS)",)

open:
	@open "src-tauri/target/release/bundle/macos/OpenAgentd (dev).app"

open-prod:
	@open "src-tauri/target/release/bundle/macos/OpenAgentd.app"

sidecar-full:
	@$(MAKE) sidecar EXTRAS="audio,azure-doc-intel"

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

# Dev with the bundled CPython sidecar — the closest thing to ``make build``
# without producing a .dmg. Useful for testing handshake, token injection,
# Job-Object cleanup, and the ``app.cli serve`` entry path.
#
# The XDG roots are pinned to ``<repo>/.openagentd/dev/...`` so the bundled
# sidecar shares state (DB, config, workspace) with ``make dev`` at
# the repo root. Without these overrides ``APP_ENV=development`` would
# resolve them relative to the sidecar's cwd (``desktop/src-tauri/``).
dev-bundled:
	@$(MAKE) sidecar
	cd src-tauri && \
		OPENAGENTD_APP_ENV=development \
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
