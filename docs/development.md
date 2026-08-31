# Development

*[← back to the README](../README.md)*


Everything in containers, hot reload on both sides, against a throwaway
ClickHouse seeded with `contrib/play-schema.sql`:

```bash
docker compose -f docker-compose.dev.yml up --build
```

Open <http://localhost:5173>. The seed is ClickHouse's own: 85 tables and 5
views lifted from [play.clickhouse.com](https://play.clickhouse.com) across four
databases — `hits` at 105 columns wide, `noaa` with a `Point` and 22 weather
enums, `countries` holding a `MultiPolygon`, a materialized view, three
projections, 42 skip indices and 204 column comments. None of it was designed to
flatter a schema diagram, which is why it is here. The extract is about 150 MiB,
fetched by the server itself on first boot, sized from the bytes-per-row measured
on the playground rather than a round number guessed here; `contrib/pull-play.mjs`
regenerates the file. Dictionaries, row policies, quotas and a delegation role
come from the other fixtures in `contrib/`, applied on the same boot.

ClickHouse is on `:8125` (user `default`, password `flint`) and the API on
`:8080` if you want to hit either directly.

The first `up` is slow: it installs `cargo-watch` and builds the dependency
tree. After that the cargo registry and target directory live in volumes, so
restarts are quick.

Or on the host, against your own ClickHouse. There is an `.envrc`, so with
[direnv](https://direnv.net) the environment sets itself:

```bash
cp .env.example .env      # put FLINT_CLICKHOUSE_PASSWORD in it
direnv allow

cargo run                 # terminal 1 — API on :8080
cd frontend && pnpm dev   # terminal 2 — Vite on :5173, proxying /api to :8080
```

`.envrc` is committed and holds no secrets: it points at `localhost:8123`,
allows the dev server's origin as CORS (forgetting that produces a failure that
looks like a bug in the app), leaves writes enabled, and puts `flint`, `vite`
and `tsc` on your `PATH`. Anything in `.env` wins over all of it.

Without direnv, export the same variables yourself — `flint --help` lists them.

```bash
cargo test                    # exception parsing, schedules, conditions, guards
cargo clippy --all-targets
cd frontend && pnpm test      # splitting, charts, schedules, search, snapshots
cd frontend && pnpm typecheck
```

The statement splitter has the most tests, because "run the statement under the
caret" silently running the *wrong* statement is the worst failure this editor
could have.

Neither suite can see the classes of bug that have actually shipped here, so
there are three checks that run against something live — see [Checking a
deployment](#checking-a-deployment):

```bash
contrib/smoke.sh http://localhost:8080                 # every endpoint, real ClickHouse
node contrib/browser-check.mjs http://localhost:8080   # every page, real browser
node contrib/api-check.mjs http://localhost:8080       # the published face, end to end
node contrib/dataset-check.mjs http://localhost:8080  # the dataset API, end to end
```

All three take a user and a password after the URL where the deployment signs
people in. For `smoke.sh` that is most of what it asks for — nearly every route
runs as whoever is asking, so without a session thirty of them answer 401 and the
run says nothing about whether they work. For the other two it is publishing an
endpoint and reading a dataset, which only a person can do; calling a published
endpoint is not, which is the distinction the whole published face rests on, and
the check exercises both sides of it.

Against an **unpinned** Flint the caller names the ClickHouse, so `smoke.sh` and
`dataset-check.mjs` — the two that exercise reads, which is all an unpinned Flint
does — take the endpoint as a last argument, or `FLINT_ENDPOINT`:

```bash
contrib/smoke.sh http://localhost:8080 default analyst secret http://localhost:8123
node contrib/dataset-check.mjs http://localhost:8080 analyst secret http://localhost:8123
```

Both pass there in full: every route answers, the workspace ones say `stateless:
no workspace configured` rather than failing, and all 62 dataset checks hold —
including the audit ones, which is the evidence that identity and endpoint travel
together on a server the browser named.

`api-check.mjs` says up front that it does not apply, rather than failing halfway
with advice that would make things worse: it is about published endpoints, which
need a workspace, and `FLINT_WORKSPACE_DATABASE` on its own stops an unpinned
Flint booting. Give the workspace a server of its own with `FLINT_WORKSPACE_URL`
and the endpoints do exist unpinned — that combination is not what this target
runs, so the check still declines rather than guessing which one you meant.

`browser-check.mjs` holds no session, so on any Flint that signs people in —
unpinned or `FLINT_AUTH=true` — every address serves the same sign-in screen, and
walking twenty of them would report a clean run having covered one page. It
audits that one page instead, in both themes, and says which it could not reach.
Which closed a hole rather than papering over one: with `FLINT_AUTH` off there is
no sign-in screen to look at, so until now its contrast and its console had never
been measured by anything.

To run one with no server in its manifest — the mode above, whose form asks
where to connect:

```bash
make run-unpinned    # env -u FLINT_CLICKHOUSE_URL -u FLINT_WORKSPACE_DATABASE
```

Its own target because the dev shell exports both of those through direnv, so a
plain `make run` is always pinned; and both rather than one, because a workspace
with no server of its own and no pinned server is a manifest Flint refuses to
boot. To keep the workspace unpinned instead, point it somewhere:

```bash
env -u FLINT_CLICKHOUSE_URL FLINT_WORKSPACE_URL=http://127.0.0.1:9000 \
    FLINT_WORKSPACE_DATABASE=flint cargo run
```

A local ClickHouse started for the purpose — `clickhousectl local server start`
is one line of it — is enough, and nothing Flint explores is written to.

To build the way the container does — frontend embedded in the binary:

```bash
cd frontend && pnpm build && cd ..
cargo build --release   # ./target/release/flint serves everything
```
