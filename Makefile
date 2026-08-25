# Flint's task surface, in the same vocabulary as Dashfile's: `make lint` and
# `make test` are the gate a change has to pass, and every target is one line of
# help away.
CARGO ?= cargo
PNPM ?= pnpm
FRONTEND := frontend
BASE ?= http://localhost:8080

.PHONY: help install build build-frontend test test-backend test-frontend \
        lint lint-backend lint-frontend fmt fmt-backend dev run check-live clean

help: ## Show this help
	@awk 'BEGIN {FS = ":.*## "} \
		/^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install the frontend toolchain
	cd $(FRONTEND) && $(PNPM) install

build: build-frontend ## Build the frontend, then the binary that embeds it
	$(CARGO) build --release

# rust-embed reads frontend/dist at compile time in release builds, so the
# frontend has to exist before the binary is built.
build-frontend: ## Build the frontend into frontend/dist
	cd $(FRONTEND) && $(PNPM) build

test: test-backend test-frontend ## Run backend and frontend tests

test-backend: ## Run the Rust tests
	$(CARGO) test

test-frontend: ## Run the Vitest suite
	cd $(FRONTEND) && $(PNPM) test

lint: lint-backend lint-frontend ## Lint backend and frontend

# Warnings are errors: a warning nobody has to fix is a warning nobody fixes.
lint-backend: ## clippy (warnings = errors) + rustfmt check
	$(CARGO) clippy --all-targets -- -D warnings
	$(CARGO) fmt --check

lint-frontend: ## tsc + eslint
	cd $(FRONTEND) && $(PNPM) typecheck
	cd $(FRONTEND) && $(PNPM) lint

fmt: fmt-backend ## Apply rustfmt

fmt-backend: ## Apply rustfmt
	$(CARGO) fmt

# The three checks that need something running, in one target. Not part of
# `make test`: they want a Flint, a ClickHouse and a browser, and a gate that
# cannot run on a laptop with none of them is a gate people learn to skip.
check-live: ## Run the live checks against a running Flint (BASE=url)
	contrib/smoke.sh $(BASE)
	node contrib/api-check.mjs $(BASE)
	node contrib/browser-check.mjs $(BASE)

# Vite serves the frontend and proxies /api to the binary, so both run.
dev: ## Run the API and the Vite dev server together
	@echo "run in two shells:  make run   |   cd $(FRONTEND) && $(PNPM) dev"

run: ## Run the API on its own (serves frontend/dist)
	$(CARGO) run

clean: ## Remove build output
	$(CARGO) clean
	rm -rf $(FRONTEND)/dist $(FRONTEND)/node_modules/.vite
