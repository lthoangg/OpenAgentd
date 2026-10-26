# Makefile for openagentd

.PHONY: all run dev kill-dev-ports verify verify-scripts verify-web verify-docs verify-version verify-native verify-shell-core verify-desktop verify-mobile health health-json build-web icons clean help
.PHONY: run-v3 dev-v3 run3 dev3 build-v3 verify-v3

# Default target
all: help

# Dev ports. Set them on the command line (`make dev PORT=8001 WEB_PORT=5174`)
# to run several checkouts side by side; each keeps its own `.openagentd/dev/`.
# Plain `=` so an inherited PORT (a common variable) cannot move them.
PORT = 8000
WEB_PORT = 5173

# A debug build already runs in development; pinning the mode as well keeps an
# inherited OPENAGENTD_ENV=production from moving source checkouts onto the
# installed app's database.
run: ## Start the API server only (v3 Rust backend, no frontend; :8000, PORT=…)
	OPENAGENTD_ENV=development cargo run --manifest-path appv3/Cargo.toml -p appv3-cli -- server serve --port $(PORT)

run-v3: run ## Alias for run

run3: run

dev: kill-dev-ports ## Start the v3 backend (:8000) and Vite (:5173) together; PORT=… WEB_PORT=… to run more
	@trap 'kill 0' INT TERM EXIT; \
	(OPENAGENTD_ENV=development cargo run --manifest-path appv3/Cargo.toml -p appv3-cli -- server serve --port $(PORT) 2>&1 | sed 's/^/[api] /') & \
	(while ! nc -z 127.0.0.1 $(PORT) 2>/dev/null; do sleep 0.1; done; cd web && VITE_API_PROXY_TARGET=http://localhost:$(PORT) bun run dev --port $(WEB_PORT) --strictPort 2>&1 | sed 's/^/[web] /') & \
	wait

dev-v3: dev ## Alias for dev

dev3: dev

build-v3: ## Build optimized OpenAgentd v3 release binary
	cargo build --release --manifest-path appv3/Cargo.toml -p appv3-cli

verify-v3: ## Check and test all appv3 Rust crates
	cargo fmt --all --check --manifest-path appv3/Cargo.toml
	cargo clippy --manifest-path appv3/Cargo.toml --all-targets -- -D warnings
	cargo test --manifest-path appv3/Cargo.toml --all-targets

kill-dev-ports: ## Stop processes listening on this checkout's dev ports (PORT, WEB_PORT)
	@command -v lsof >/dev/null 2>&1 || { echo "error: 'lsof' not found"; exit 1; }
	@for port in $(PORT) $(WEB_PORT); do \
		pids=$$(lsof -tiTCP:$$port -sTCP:LISTEN); \
		if [ -n "$$pids" ]; then \
			echo "stopping processes on port $$port: $$pids"; \
			kill $$pids; \
			for i in 1 2 3 4 5; do \
				sleep 0.2; \
				pids=$$(lsof -tiTCP:$$port -sTCP:LISTEN); \
				[ -z "$$pids" ] && break; \
			done; \
			pids=$$(lsof -tiTCP:$$port -sTCP:LISTEN); \
			if [ -n "$$pids" ]; then \
				echo "force stopping processes on port $$port: $$pids"; \
				kill -9 $$pids; \
			fi; \
		fi; \
	done

verify: verify-v3 verify-scripts verify-web verify-docs verify-version ## Run the portable pre-merge contract

# The repository has no Python project; the tooling tests install their few
# deps into the local, git-ignored .venv.
SCRIPTS_VENV := .venv

$(SCRIPTS_VENV)/bin/python:
	python3 -m venv $(SCRIPTS_VENV)

verify-scripts: $(SCRIPTS_VENV)/bin/python ## Test maintainer scripts, installers, and release/workflow contracts
	$(SCRIPTS_VENV)/bin/python -m pip install -q --disable-pip-version-check pytest pyyaml pillow
	$(SCRIPTS_VENV)/bin/python -m pytest scripts/tests -q

verify-web: ## Lint, type-check, and test the web frontend
	cd web && bun run lint
	cd web && bun run typecheck
	cd web && bun test --parallel

verify-docs: ## Validate documentation links, metadata, and repository references
	python3 scripts/validate_docs.py

verify-version: ## Verify release-facing versions and release docs stay synchronized
	scripts/check_version_consistency.sh
	@VERSION=$$(scripts/release_version.sh); \
		grep -F "**Latest release:** v$${VERSION} ·" documents/docs/features.md; \
		grep -E '^updated: [0-9]{4}-[0-9]{2}-[0-9]{2}$$' documents/docs/features.md

verify-native: verify-shell-core verify-desktop verify-mobile ## Run shared-crate, desktop, and mobile Rust checks (requires native build dependencies)

verify-shell-core: ## Format-check, lint, and test the Rust crate shared by both native shells (no Tauri deps)
	cd native/shell-core && cargo fmt --check
	cd native/shell-core && cargo clippy --all-targets -- -D warnings
	cd native/shell-core && cargo test

verify-desktop: ## Check, test, and lint the desktop Rust crate
	cd desktop/src-tauri && TAURI_CONFIG="$$(cat tauri.dev.conf.json)" cargo check --locked
	cd desktop/src-tauri && TAURI_CONFIG="$$(cat tauri.dev.conf.json)" cargo test --locked
	cd desktop/src-tauri && TAURI_CONFIG="$$(cat tauri.dev.conf.json)" cargo clippy --locked --all-targets

verify-mobile: ## Check the mobile Rust crate
	cd mobile/src-tauri && TAURI_CONFIG='{"bundle":{"icon":["icons/icon.png"]}}' cargo check --locked

health: ## Rank web frontend god files + detect circular imports (text report)
	python3 -m scripts.codehealth --lang ts

health-json: ## Same as 'health' but emit JSON (for baselines / CI)
	python3 -m scripts.codehealth --lang ts --json

build-web: ## Build web UI into web/dist/ for desktop packaging
	# --frozen-lockfile: install exactly what bun.lock pins instead of
	# re-resolving. Matches tauri.conf.json's beforeBuildCommand, web.yml CI,
	# and mobile/Makefile so a local packaging build cannot ship different
	# dependency versions than the ones that were tested.
	cd web && bun install --frozen-lockfile && bun run build

icons: ## Generate all app & platform icons from the brand masters (python3 scripts/generate_icons.py --force to rebuild)
	python3 scripts/generate_icons.py

clean: ## Remove build and cache artifacts
	rm -rf .pytest_cache
	rm -rf web/dist
	find . -type d -name "__pycache__" -exec rm -rf {} +

help: ## Show this help message
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-15s\033[0m %s\n", $$1, $$2}'
