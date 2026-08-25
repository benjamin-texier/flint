# CLAUDE.md

Guidance for working in this repository. (Dashfile, the sibling project, keeps one
of these too — the practice is borrowed; the conventions below are Flint's own,
and where they differ from Dashfile's the difference is deliberate and marked.)

## What this is

**Flint** — a ClickHouse explorer that opens on your schema, drawn. One Rust
binary (`axum`) serves a JSON API and embeds the built React frontend
(`rust-embed`), so a deployment is one process and no second database. There is
no ORM and no query builder in the backend: every read is SQL against
`system.*`, parameterised with ClickHouse's `{name:Type}` bindings so an
identifier is quoted by the server rather than by us.

## Architecture

- **`src/main.rs`** — config, tracing, the ClickHouse handshake, the router.
- **`src/clickhouse/`** — everything that speaks to the server. `mod.rs` is the
  HTTP client (formats, settings, the `system_columns` probe that lets an older
  server degrade one field instead of failing a page); `meta.rs` the object
  metadata; `graph.rs` the schema graph (mostly *inferred* — see the README);
  `profile.rs` the per-column profile; `diagnostics.rs` the query-log reads.
- **`src/routes/`** — thin handlers over the above, plus `spa.rs`, which serves
  the embedded frontend.
- **`frontend/src/lib/`** — the logic, as pure functions, tested with Vitest:
  layout, lineage parsing, formatting, type families, the diagnose maths. If a
  piece of logic can be tested without a DOM, it belongs here rather than in a
  component.
- **`frontend/src/components/` + `routes/`** — React 19, no component library,
  no CSS-in-JS. One stylesheet (`styles/app.css`) over the tokens.

## Commands

```bash
make lint          # clippy -D warnings + rustfmt --check + tsc + oxlint
make test          # cargo test + vitest
make build         # frontend, then the release binary that embeds it
make run           # the API on its own (serves frontend/dist)
make help          # every target
```

Before considering a task done, `make lint` and `make test` must pass. CI runs
the same commands and nothing else.

## Conventions

- **Comments explain *why*, and they are allowed to be long.** This is the
  opposite of Dashfile's "comment sparingly": in Flint the reasoning behind a
  design decision — why a figure is dropped rather than dashed, why a scale is a
  percentile, why an edge is redrawn — lives next to the code it governs, because
  those decisions are the product. Restating what the next line does is still
  noise. Em-dashes are part of the house voice here.
- **An absent figure is dropped, not dashed.** A view has no size; printing four
  em-dashes says Flint asked the wrong question. A dash is for something that
  should have a value and does not.
- **Say what was left out.** Every cap, fold or filter states its own count: "155
  of 164 objects", "9 internal tables hidden", "6 past the scale", "Showing the
  40 that cost the most". A list silently truncated reads as the whole truth.
- **Counts follow the list.** A header that counts objects the list below it does
  not show is a header nobody can reconcile. Rows and bytes are the documented
  exception: that disk is real wherever it lives.
- **Design tokens are a contract with Dashfile** (`frontend/src/styles/tokens.css`).
  Its token names are the source of truth; Flint's own vocabulary is aliased onto
  them at the bottom of that file. A colour or a duration written as a literal in
  a rule is a bug — including motion: one physics for the product, `--motion-fast`
  through `--motion-slow`, with the ambient loops on `--loop-*`.
- **Every interaction keeps the contract its ARIA role announces.** A tablist is
  driven by arrows and holds one tab stop; a menu closes on Escape and walks with
  arrows; a sortable column publishes `aria-sort`.
- **Verify in the browser, not only in the test run.** The bugs this codebase has
  actually shipped — a diagram clipped by a stale fit, a canvas collapsed to zero
  height, a bar rounded to a hairline — were all invisible to `tsc` and Vitest and
  obvious in a screenshot.

## Sample data

Any ClickHouse will do; `system` is always there and `system.query_log` is the
best table on the machine for exercising the storage bars, the profile and the
diagnose page.
