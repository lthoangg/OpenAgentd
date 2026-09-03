# Makefile for openagentd

.PHONY: all run dev dev-lan kill-dev-ports test coverage verify verify-backend verify-web verify-docs verify-version verify-native verify-shell-core verify-desktop verify-mobile scenarios scenarios-chat scenarios-mentions scenarios-questions scenarios-lsp scenarios-performance health health-json prompt-budget prompt-budget-json migrate revision build-web icons build dist clean help

# Default target
all: test

run: ## Start the API server only (no reload, no frontend; :8000)
	uv run uvicorn app.server:app

kill-dev-ports: ## Stop processes listening on dev ports (:8000, :5173)
	@command -v lsof >/dev/null 2>&1 || { echo "error: 'lsof' not found"; exit 1; }
	@for port in 8000 5173; do \
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

dev: kill-dev-ports ## Start backend (:8000 + reload) and frontend (Vite :5173) together
	@trap 'kill 0' INT TERM EXIT; \
	(uv run uvicorn app.server:app --reload --reload-dir app 2>&1 | sed 's/^/[api] /') & \
	(cd web && bun dev 2>&1 | sed 's/^/[web] /') & \
	wait

dev-lan: kill-dev-ports ## Start backend (:8000 + reload) and frontend (Vite :5173) together, accessible on LAN
	@trap 'kill 0' INT TERM EXIT; \
	(API_ALLOW_INSECURE_LAN=true API_HOST=0.0.0.0 API_PORT=8000 API_RELOAD=true uv run python -m app.server 2>&1 | sed 's/^/[api] /') & \
	(cd web && bun dev --host 0.0.0.0 2>&1 | sed 's/^/[web] /') & \
	wait

test: ## Run tests
	uv run pytest -n 4 -q

coverage: ## Run tests with coverage report (terminal + htmlcov/)
	uv run pytest --cov=app --cov-report=term-missing:skip-covered --cov-report=html tests/

verify: verify-backend verify-web verify-docs verify-version ## Run the portable pre-merge contract

verify-backend: ## Lint, format-check, type-check, and test the Python backend
	uv run ruff check app/ tests/
	uv run ruff format --check app/ tests/
	uv run ty check app/
	uv run pytest -n 4 -q

verify-web: ## Lint, type-check, and test the web frontend
	cd web && bun run lint
	cd web && bun run typecheck
	cd web && bun test --parallel

verify-docs: ## Validate documentation links, metadata, and repository references
	uv run python scripts/validate_docs.py

verify-version: ## Verify release-facing versions and release docs stay synchronized
	scripts/check_version_consistency.sh
	@VERSION=$$(tr -d '[:space:]' < app/version.txt); \
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

scenarios: scenarios-chat scenarios-mentions scenarios-questions scenarios-lsp scenarios-performance ## Run all service-layer manual scenarios

scenarios-chat: ## Run chat service compaction, undo/redo, queue, and edge-case scenarios
	uv run python tests/manual/manual_scenarios.py
	uv run python tests/manual/extended_scenarios.py

scenarios-mentions: ## Run workspace mention and path-safety scenarios
	uv run python tests/manual/mention_scenarios.py

scenarios-questions: ## Run ask_user durable suspension scenarios
	uv run python tests/manual/question_scenarios.py

scenarios-lsp: ## Run mocked and real-server LSP scenarios
	uv run python tests/manual/lsp_scenarios.py

scenarios-performance: ## Run deterministic persistence query-count scenarios
	uv run python tests/manual/performance_scenarios.py

health: ## Rank god files + detect circular imports (text report)
	uv run python -m scripts.codehealth

health-json: ## Same as 'health' but emit JSON (for baselines / CI)
	uv run python -m scripts.codehealth --json

prompt-budget: ## Count system prompt, tool schema, and bundled skill tokens
	@tmp=$$(mktemp -d); TMP_AGENTS=$$tmp uv run python -c 'import os; from pathlib import Path; from app.agent.loader import ensure_builtin_code_agent; p=Path(os.environ["TMP_AGENTS"]); ensure_builtin_code_agent(p)'; uv run python -m manual.inspect_prompt --dir $$tmp --date 2026-01-01 --skills-scope builtin --stats-only; status=$$?; rm -rf $$tmp; exit $$status

prompt-budget-json: ## Same as prompt-budget but emit stable JSON for tracking/CI
	@tmp=$$(mktemp -d); TMP_AGENTS=$$tmp uv run python -c 'import os; from pathlib import Path; from app.agent.loader import ensure_builtin_code_agent; p=Path(os.environ["TMP_AGENTS"]); ensure_builtin_code_agent(p)'; uv run python -m manual.inspect_prompt --dir $$tmp --date 2026-01-01 --skills-scope builtin --stats-only --json; status=$$?; rm -rf $$tmp; exit $$status

migrate: ## Run Alembic migrations (dev only — production auto-migrates on startup)
	uv run alembic -c app/alembic.ini upgrade head

revision: ## Create a new Alembic revision (usage: make revision MSG="message")
	uv run alembic -c app/alembic.ini revision --autogenerate -m "$(MSG)"

build-web: ## Build web UI into web/dist/ for desktop packaging
	# --frozen-lockfile: install exactly what bun.lock pins instead of
	# re-resolving. Matches tauri.conf.json's beforeBuildCommand, web.yml CI,
	# and mobile/Makefile so a local packaging build cannot ship different
	# dependency versions than the ones that were tested.
	cd web && bun install --frozen-lockfile && bun run build

icons: ## Centralize and generate all app & platform icons from the master brand icon
	python3 scripts/generate_icons.py

build: ## Build Python wheel (API server only)
	uv build

dist: build ## Alias for build

clean: ## Remove build and cache artifacts
	rm -rf .pytest_cache .ruff_cache .coverage .ty_cache htmlcov
	rm -rf web/dist dist
	find . -type d -name "__pycache__" -exec rm -rf {} +

help: ## Show this help message
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-15s\033[0m %s\n", $$1, $$2}'
