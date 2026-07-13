# Makefile for openagentd

.PHONY: all run dev kill-dev-ports test coverage health health-json prompt-budget prompt-budget-json migrate revision build-web build dist clean help

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
	(API_HOST=0.0.0.0 API_PORT=8000 API_RELOAD=true uv run python -m app.server 2>&1 | sed 's/^/[api] /') & \
	(cd web && bun dev --host 0.0.0.0 2>&1 | sed 's/^/[web] /') & \
	wait

test: ## Run tests
	uv run pytest -n auto -q

coverage: ## Run tests with coverage report (terminal + htmlcov/)
	uv run pytest --cov=app --cov-report=term-missing:skip-covered --cov-report=html tests/

health: ## Rank god files + detect circular imports (text report)
	uv run python -m scripts.codehealth

health-json: ## Same as 'health' but emit JSON (for baselines / CI)
	uv run python -m scripts.codehealth --json

prompt-budget: ## Count system prompt, tool schema, and bundled skill tokens
	@uv run python -m manual.inspect_prompt --dir seed/agents --date 2026-01-01 --skills-scope builtin --stats-only

prompt-budget-json: ## Same as prompt-budget but emit stable JSON for tracking/CI
	@uv run python -m manual.inspect_prompt --dir seed/agents --date 2026-01-01 --skills-scope builtin --stats-only --json

migrate: ## Run Alembic migrations (dev only — production auto-migrates on startup)
	uv run alembic -c app/alembic.ini upgrade head

revision: ## Create a new Alembic revision (usage: make revision MSG="message")
	uv run alembic -c app/alembic.ini revision --autogenerate -m "$(MSG)"

build-web: ## Build web UI into web/dist/ for desktop packaging
	cd web && bun install && bun run build

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
