# Makefile for openagentd

.PHONY: all run dev kill-dev-ports test coverage health health-json migrate revision build-web build dist clean help

# Default target
all: test

run: ## Start the API server only (no reload, no frontend; :8000)
	APP_ENV=development uv run uvicorn app.server:app

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
	@command -v bun >/dev/null 2>&1 || { echo "error: 'bun' not found — install from https://bun.sh"; exit 1; }
	@trap 'kill 0' INT TERM EXIT; \
	(APP_ENV=development uv run uvicorn app.server:app --reload --reload-dir app 2>&1 | sed 's/^/[api] /') & \
	(cd web && bun dev 2>&1 | sed 's/^/[web] /') & \
	wait

test: ## Run tests
	uv run pytest -q

coverage: ## Run tests with coverage report
	uv run pytest --cov=app --cov-report=term-missing tests/

health: ## Rank god files + detect circular imports (text report)
	uv run python -m scripts.codehealth

health-json: ## Same as 'health' but emit JSON (for baselines / CI)
	uv run python -m scripts.codehealth --json

migrate: ## Run Alembic migrations (dev only — production auto-migrates on startup)
	APP_ENV=development uv run alembic -c app/alembic.ini upgrade head

revision: ## Create a new Alembic revision (usage: make revision MSG="message")
	APP_ENV=development uv run alembic -c app/alembic.ini revision --autogenerate -m "$(MSG)"

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
