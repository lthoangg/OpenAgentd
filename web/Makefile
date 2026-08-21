.PHONY: dev build typecheck lint test preview clean

dev: ## Start the Vite web dev server (:5173)
	bun dev

build: ## Build the web UI into dist/
	bun run build

typecheck: ## Run TypeScript type checking
	bun run typecheck

lint: ## Run Oxlint
	bun run lint

test: ## Run Bun tests
	bun run test

preview: ## Preview the production build locally
	bun run preview

clean: ## Remove web build artifacts
	rm -rf dist
