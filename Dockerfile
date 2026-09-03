# ── Frontend ────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS frontend
WORKDIR /app/frontend
RUN corepack enable
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend/ ./
RUN pnpm build

# ── Rust toolchain, shared by the release build and the dev container ────────
FROM rust:1-bookworm AS rust-base
# aws-lc-sys (rustls' crypto provider) is built from source and needs a C
# toolchain with cmake and clang.
RUN apt-get update \
 && apt-get install -y --no-install-recommends cmake clang libclang-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ── Dev: rebuild and restart on save. Used by docker/dev.yml ────────────────
FROM rust-base AS dev
RUN cargo install cargo-watch --locked
# The source, the target directory and the registry all arrive as mounts.
CMD ["cargo", "watch", "-w", "src", "-w", "Cargo.toml", "-x", "run"]

# ── Backend ─────────────────────────────────────────────────────────────────
FROM rust-base AS backend

# Warm the dependency layer first so editing source does not rebuild the world.
COPY Cargo.toml Cargo.lock build.rs ./
RUN mkdir -p src frontend/dist \
 && echo 'fn main() {}' > src/main.rs \
 && cargo build --release --locked \
 && rm -rf src

COPY src/ ./src/
COPY --from=frontend /app/frontend/dist ./frontend/dist
# Touch the entrypoint so cargo does not reuse the placeholder's fingerprint.
RUN touch src/main.rs && cargo build --release --locked

# ── Runtime ─────────────────────────────────────────────────────────────────
# distroless/cc carries libc and libgcc and nothing else. Flint bundles its own
# CA roots, so no certificate store is needed in the image.
FROM gcr.io/distroless/cc-debian12
COPY --from=backend /app/target/release/flint /usr/local/bin/flint

# No endpoint on purpose. The image used to carry `http://localhost:8123`, which
# inside a container is the container itself and therefore an address that could
# never work — a default that only ever produced a Flint pointed at nothing.
# Unset, `docker run -p 8080:8080 flint` starts unpinned and opens on a form
# asking where to connect, which is the same amount of typing and a working
# Flint at the end of it. Pass FLINT_CLICKHOUSE_URL to pin it.
ENV FLINT_HOST=0.0.0.0 \
    FLINT_PORT=8080
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/usr/local/bin/flint"]
