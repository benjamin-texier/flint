# Roadmap

Flint is two products in one binary, and the whole of this document follows from
refusing to let them blur.

**Data** is the workspace the brief describes: explore, query, visualise,
analyse, expose. It is what Flint is today, and its remaining work is the
brief's own backlog.

**Infrastructure** is the thing people ask for once Flint is installed and they
realise it already knows where everything is: operate the server. Clusters,
health, backups, access, configuration.

They share a binary, a connection, a design system and most of their machinery.
They must never share a screen.

---

## The one rule

```text
Flint
├── Data
│   ├── Explorer
│   ├── SQL
│   ├── Charts
│   ├── Dashboards
│   ├── APIs
│   └── Alerts
│
└── Infrastructure
    ├── Clusters
    ├── Health
    ├── Users & RBAC
    ├── Backups
    ├── Versions
    ├── Configuration
    ├── Schema
    └── Audit
```

Two named spaces, chosen explicitly, with no page belonging to both. An analyst
who opens Flint to answer a question should not pass a `DROP PARTITION` button on
the way, and an operator draining a replica should not have to walk through
somebody's dashboards to reach the replication queue.

The navigation already has the seed of this: `Chrome.tsx` groups its links in
three unlabelled clusters, with `Diagnose` sitting alone in the third. That third
group is Infrastructure asking to be named.

---

## Where the line falls

The tempting line is "read versus write", and it is the wrong one. Data writes
too — an insert, an import, an ingestion endpoint. The line that actually holds:

> **Data works on rows. Infrastructure works on structure and on the server.**

- Data **reads** structure, because you cannot query what you cannot see, and
  **writes** rows: insert, import, truncate, ingest.
- Infrastructure **writes** structure — `CREATE`, `ALTER`, `DROP`, indexes,
  projections, partitions, TTL — and operates everything that is not data.

This cuts one thing in half that an earlier draft of this roadmap kept together:
the mongo-express-parity work. Insert, import and export are Data; creating and
dropping tables is Infrastructure → Schema. That is a better split than it first
looks — the analyst who needs to load a CSV is not the person who should be
reshaping a sorting key.

**The corollary that keeps it honest**: no Data control may change structure as a
side effect. An import into a table that does not exist offers the DDL and sends
you to Infrastructure — or is refused, when the tier says so. It does not
helpfully create the table.

---

## The split is the deployment story

The brief states a property worth protecting exactly:

> Connecting Flint must not modify the ClickHouse instance.

Infrastructure is, by definition, the violation of that sentence. Which is
precisely why it must be a whole space rather than a scattering of buttons: a
space can be switched off entirely.

`FLINT_READONLY` becomes a notch:

| tier | Data | Infrastructure |
| --- | --- | --- |
| `read` | read-only — today's Flint, the brief's stateless mode | **absent** |
| `data` | inserts, imports, exports, truncate, ingest endpoints | **absent** |
| `ddl` | as above | Schema only |
| `admin` | as above | all eight sections |

Absent means absent: no navigation entry, no route, no disabled control with a
tooltip explaining what you are not allowed to do. An analytics team runs Flint
at `read` or `data` and never learns the other half exists.

Two rules attach to the notch:

- Anything above `read` **requires `FLINT_WORKSPACE_DATABASE`**. A write Flint
  cannot record is a write nobody can reconstruct afterwards.
- The tier is set in the manifest, by whoever deploys, never in the UI by
  whoever is signed in.

---

## What the two spaces share

The real risk of drawing a hard line through the product is building everything
twice. These are one implementation with two façades, and reviews should say so:

- **One job runner.** An `OPTIMIZE`, a backup, a mutation, an ingestion batch:
  same table, same progress, same resumption.
- **One alert engine, two kinds of question.** A SQL result over your data, and a
  system metric — replication delay, disk, mutation queue. Same scheduler, same
  event log; the Data space lists the first, Infrastructure the second.
- **One chart library.** A latency percentile over time is the same line chart as
  revenue over time. Health should not grow its own plotting.
- **One audit trail.** `system.query_log`, filtered. Infrastructure gets a page
  of it; Data writes land in the same place.
- **One lineage graph, read two ways.** In Data it answers "where did this column
  come from". In Infrastructure it is the blast radius of a `DROP` — *this takes
  40 GB and breaks these twelve views*, drawn. Same graph, and it is Flint's one
  genuine advantage over every other ClickHouse console.
- **One attention count, split.** The badge in the bar has to become two, one per
  space. A Data user inheriting an alarm about a replica they cannot touch is
  noise; an operator missing it because it was filed under someone's dashboard is
  worse.

---

## Track A — Data

The brief's own progression, continued. Nearly all of it is built; what follows
is what is genuinely missing, in the order I would take it.

### A1. The Explorer finishes its write half

Insert by form, built from the column types `chType.ts` and the profile already
read: defaults, `Nullable`, enums as a list rather than free text.

Import a file — CSV, JSONEachRow, Parquet — with the schema inferred by
`DESCRIBE file()`, the mapping and a sample of parsed rows shown *before*
anything is written, and rows accepted and rows rejected counted separately.
This is the feature that gets a browser tab used instead of `clickhouse-client`.

Export a table or a result as CSV, JSONL or Parquet in one click. The published
endpoints cover the API case; they do not cover "give me this file now".

**Not** inline cell editing. ClickHouse has no cell edit: an
`ALTER TABLE ... UPDATE` is an asynchronous rewrite and a lightweight `DELETE` is
a mask that still costs a merge. A pencil icon would lie about what the click
does. "Update these rows" and "delete these rows" are jobs instead — the `WHERE`
previewed with the count it matches, progress against `system.mutations`, and a
plain refusal where the predicate does not narrow to a partition. Same rule as
dropping an absent figure rather than dashing it.

### A2. Dashboards grow the controls a dashboard needs

`DashboardSpec` today is tiles plus `refreshSeconds`. Missing, and all of it in
the brief: dashboard-level filters, a time range that every tile honours,
variables, fullscreen, and drag-to-arrange instead of the width control and the
reorder buttons the README already admits to.

### A3. Analysis — the largest unbuilt Data feature

The brief asks Flint to help users *understand* data, not only display it:
distributions, correlations, trends, outliers, missing data, cardinality, time
series, comparisons, quality checks. Select a table, get a useful analytical
overview without knowing which query you wanted.

The profile is the foundation and is already good. What is missing is the layer
above it: relationships between columns rather than facts about one.

### A4. The visualisation set the brief describes

`ChartKind` is `stat | line | bar | scatter`. Also listed in the brief and not
built: area, histogram, pie/donut, heatmap. Later: maps — which needs the
geographic column role the exploration heuristics do not yet detect — funnels,
cohorts, anomaly charts.

### A5. Ingestion APIs

`POST /api/ingest/<name>`: target table, input schema, field mapping,
validation, authentication, batching. The read side of no-code APIs is built and
documented; the write side is not started, and it is the feature that makes
ClickHouse usable as a backend without writing one.

It is also the one Data feature that needs a background component — a buffer that
survives a restart — which is why it waits for the job runner rather than growing
its own.

### A6. Reports and saved datasets

Reports deliver to webhooks only: no email, no per-recipient routing, no PDF, and
a report cannot yet be built from a saved query. And the brief lists **saved
datasets** as a first-class object, distinct from a saved query — the thing a
chart, an alert, a report and an endpoint all point at. Flint has the concept
implicitly, in four places; naming it once would simplify all four.

---

## Track B — Infrastructure

Each of the eight sections of the tree, and the order they become useful in.

### B0. Identity: ClickHouse is the provider

A login form that takes **ClickHouse** credentials, a session that carries them,
every statement executed as that user rather than as the service account.

Worth doing first because of what it lets us *not* build:

- **Authorisation is already written** — `system.grants`, which `access.rs`
  already reads. A user who may not drop a table is refused by the server, not by
  a check of ours that might be wrong.
- **The audit trail is already written** — `system.query_log` carries `user`.
  Infrastructure → Audit is a query, not a subsystem.
- **The access page changes meaning** — "who can do what" stops being an
  administrator's dashboard and becomes your own standing.

`FLINT_CLICKHOUSE_USER` stays, for background metadata and the first page load.
Where one shared password is enough — a laptop, a CI fixture — basic auth from
the environment is the degraded mode, which is the answer mongo-express gives
too.

Small piece of work; nearly everything below depends on it.

### B1. A job runner that survives a restart

Nothing else in this track fits inside an HTTP request, and a sidecar is
rescheduled without warning. One row per operation in the workspace: the
statement, who submitted it, the tier that allowed it, progress, outcome. Truth
comes from the server — `system.mutations`, `system.merges`, `system.backups`,
`system.processes` — never from our own memory, and on boot Flint reattaches to
what is still running instead of orphaning it.

### B2. Clusters

The largest technical gap in Flint today: `system.clusters` appears nowhere in
the codebase. An operations tool without replication is not one. Read from the
node Flint sits beside, which is enough:

- topology from `system.clusters`, drawn — the canvas already knows how to lay
  out a graph and state what it dropped
- `system.replicas`: `absolute_delay`, `is_readonly`, `is_session_expired`,
  `future_parts`, `parts_to_check`
- `system.replication_queue`, with stuck entries and their exceptions, which is
  where a replication problem is actually legible
- `system.distributed_ddl_queue` — an `ON CLUSTER` that succeeded on three nodes
  out of four is the failure this table exists to expose
- `system.zookeeper_connection`, and what a degraded ensemble looks like
- actions, as jobs: `SYSTEM SYNC REPLICA`, `RESTART REPLICA`, `RESTORE REPLICA`,
  `STOP`/`START FETCHES`

### B3. Health

Everything Flint measures today comes from `system.query_log` and
`system.parts`: what queries did, and what is on disk. Nothing about the machine.

- now — `system.metrics`, `system.events`, `system.asynchronous_metrics`
- over time — `system.metric_log`, `system.asynchronous_metric_log`: memory,
  background pool saturation, `DelayedInserts`, cache hit rates as a line rather
  than a number
- merges over time — `system.part_log`, not only `system.merges` in flight
- logs — a tail over `system.text_log`, by level and query id. The thing people
  open a shell for
- failures — `system.crash_log`, `system.errors` as a series, `system.trace_log`
  where a profile earns its weight
- ingestion, because its failures are operational even though its purpose is
  not: `system.kafka_consumers` (lag, exceptions, rebalances), S3Queue,
  `system.rocksdb`, dictionary status and `SYSTEM RELOAD DICTIONARY`
- a refresh cadence on all of it. Today every panel is a single GET

### B4. Schema

Structure, written. This is where `ddl` tier lives, and the only Infrastructure
section that has a Data-side twin — Explorer shows the same objects and never
touches them.

- create, rename, drop, `TRUNCATE`; a form for the common shape and a raw DDL
  editor for the rest, starting from `create_table_query` rather than from a
  guess
- columns, TTL, sorting key, codecs; indexes and projections, added, dropped and
  `MATERIALIZE`d
- partitions as objects: `ATTACH`, `DETACH`, `DROP PARTITION`, `FREEZE`,
  `MOVE PARTITION TO DISK|VOLUME`, each a job
- `system.detached_parts` — an operations screen with two buttons, reattach and
  drop, that no tool shows
- storage: `system.storage_policies`, move rules, which volume a part is on,
  `system.filesystem_cache` and `system.blob_storage_log` where the disk is S3
- part-count pressure against the merge tree's own limits, so "too many parts"
  arrives as a warning rather than as a failed insert
- schema as code: diff two servers, generate the migration, export and import a
  versioned schema, and reconstruct "who changed this table, when" from the audit
- every destructive action gated by the lineage graph as its confirmation dialog

### B5. Backups

`BACKUP` and `RESTORE` to disk or S3, progress from `system.backups`, retention,
and restoring one table rather than everything. Probably the most expected
feature of anything calling itself an administration console, and entirely
absent.

### B6. Users & RBAC

`access.rs` lists users, roles and grants and refuses to change any of them,
deliberately. Once B0 is in place that refusal can be lifted safely, because the
server decides whether the signed-in user may grant anything.

`CREATE`/`ALTER`/`DROP USER` and `ROLE`, `GRANT`, `REVOKE`, password rotation,
the expiry `valid_until` already surfaces — plus three families with no coverage
at all today: `system.quotas` with `system.quota_usage`,
`system.settings_profiles` with `system.settings_profile_elements`, and
`system.row_policies`. Multi-tenant ClickHouse is configured entirely there.

### B7. Configuration and Versions

`system.server_settings` and `system.settings` with their `changed` flags — the
effective configuration, rather than whichever file someone believes is
deployed. The running version with its deprecated settings and its
`compatibility` value, which explains more surprising behaviour than anything
else on the server. A `SYSTEM` console at `admin` tier: `FLUSH LOGS`,
`RELOAD CONFIG`, the cache drops, `STOP`/`START MERGES`.

Flint reads configuration and asks for a reload. It does not edit the files;
those belong to whatever deploys them.

### B8. Audit

Every action Flint took, who took it, under which tier, and what the server said.
Mostly a view over `system.query_log` once B0 exists, plus the job table for the
things that ran asynchronously.

---

## Placements still to settle

Honest gaps in the tree above, rather than decisions quietly made in code later.

- **Reports** is not in it. Under Data beside Dashboards is the obvious answer;
  folding it into Dashboards is the other one. It needs deciding before A6.
- **Diagnose has to be cut in two.** Query performance, expensive tables, unused
  tables, scan volume, latency percentiles explain statements people wrote — Data.
  Merges, mutations, parts, disk, replication describe the server —
  Infrastructure → Health. One `diagnostics.rs` can serve both; one page cannot.
- **"What may I see"** is useful to an analyst, and is a fragment of Users &
  RBAC. A small read-only panel in Data showing your own grants, with management
  staying in Infrastructure, is the split I would take.
- **Alerts on system metrics** are authored by an operator and belong to
  Infrastructure, while the engine and the event log are shared with Data. Which
  space *lists* an alert should follow what it queries, not who wrote it.

---

## Sequencing two tracks

The failure mode of two tracks is alternating between them and finishing
neither. Two suggestions:

**Do B0 and B1 now, out of turn.** Identity and the job runner are small,
structural, and unblock both tracks — the job runner is what A1's mutations and
A5's batching need as much as B2's `SYNC REPLICA` does.

**Then commit to one track per release.** Data is closer to done and it is what
the brief promised; Infrastructure is where the ambition is. Finishing A1–A3 makes
Flint the best ClickHouse explorer that exists. Starting B2–B3 makes it something
nobody has built. Either is a good next release. Doing halves of both is not.

---

## Many servers, if it is ever asked for

A connection registry, secrets encrypted at rest, a context switcher, views
across servers. Deliberately last, and possibly never: it contradicts the
single-container shape, moves the workspace out of the observed database, and
turns a container in a pod into a service with its own operational weight. If the
answer to "I have twelve ClickHouses" is "run twelve Flints", this never happens,
and that is a fine outcome.

The two-space split does make it cheaper if it comes: a fleet view is an
Infrastructure concern only. Data stays one server, always — the database you are
querying.

---

## Deliberately not on this roadmap

Said out loud, because a roadmap listing only its intentions reads as a promise
about everything else.

- **A generic database frontend.** ClickHouse-specific, per the brief. Concepts
  stay named as ClickHouse names them.
- **Provisioning.** Flint will not create a ClickHouse. Where the server runs in
  Kubernetes that belongs to the operator's CRDs, and reading them is the most
  Flint should ever do.
- **Editing server configuration files.** See B7.
- **Inline cell editing.** See A1. The engine does not support the gesture, and
  imitating it would be a lie.
- **A user store of its own.** ClickHouse has one. Two would disagree.
- **A second datastore.** No PostgreSQL, no Redis, no queue. The workspace
  database is the persistence layer, including for jobs.
- **A Data control that writes structure as a side effect.** The line in "Where
  the line falls" is load-bearing.
