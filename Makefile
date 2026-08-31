# Flint's task surface, in the same vocabulary as Dashfile's: `make lint` and
# `make test` are the gate a change has to pass, and every target is one line of
# help away.
CARGO ?= cargo
PNPM ?= pnpm
FRONTEND := frontend
BASE ?= http://localhost:8080

.PHONY: help install hooks build build-frontend test test-backend test-frontend \
        lint lint-backend lint-frontend fmt fmt-backend dev run check-live clean

help: ## Show this help
	@awk 'BEGIN {FS = ":.*## "} \
		/^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: hooks ## Install the frontend toolchain and the git hooks
	cd $(FRONTEND) && $(PNPM) install

# Versioned rather than copied into .git/hooks, so a hook is reviewed like any
# other file and a fix reaches everybody on the next pull. One setting, and git
# looks here instead.
hooks: ## Point git at the versioned hooks in .githooks
	@git config core.hooksPath .githooks
	@echo "hooks: git will run .githooks (commit-msg, pre-commit, pre-push)"

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
	cd $(FRONTEND) && FLINT_LIVE=$(BASE) $(PNPM) vitest run src/lib/timeline.live

# Vite serves the frontend and proxies /api to the binary, so both run.
dev: ## Run the API and the Vite dev server together
	@echo "run in two shells:  make run   |   cd $(FRONTEND) && $(PNPM) dev"

run: ## Run the API on its own (serves frontend/dist)
	$(CARGO) run

# `env -u` rather than an empty assignment, and both variables rather than one.
# The dev shell exports FLINT_CLICKHOUSE_URL and FLINT_WORKSPACE_DATABASE through
# direnv, so `cargo run` here is always pinned — and a workspace without a server
# is a manifest `Config::check` refuses, which would look like a broken target
# rather than the one setting that had to go with the other.
run-unpinned: ## Run the API with no server in its manifest (the browser names one)
	env -u FLINT_CLICKHOUSE_URL -u FLINT_WORKSPACE_DATABASE $(CARGO) run

clean: ## Remove build output
	$(CARGO) clean
	rm -rf $(FRONTEND)/dist $(FRONTEND)/node_modules/.vite
