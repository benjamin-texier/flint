# Design

*[← back to the README](../README.md)*

## The two spaces

Flint is two products in one binary, and the UI keeps them apart rather than
mixing them into one menu. **Data** works on rows — explore, query, visualise,
expose. **Infrastructure** works on structure and on the server — health,
pipelines, replication, access. An analyst opening Flint to answer a question
should not pass an operator's controls on the way, and an operator should not
walk through somebody's dashboards to reach the replication queue.

Each space's name in the bar opens that space's board — `Infrastructure` its
"is anything wrong", `Data` its "what does this workspace answer". Neither is
the busiest page in its half, deliberately: Health is the right page for working
on a server and the wrong one for finding out whether you need to, and a
database is the right page for reading rows and the wrong one for finding out
what has already been built on them.

**Infrastructure → Audit** is the trail: who ran which operation under which
tier, who called which published endpoint, who read which dataset, and what the
server said to each. It is a *read* over the two records that already exist —
`system.query_log`, which carries the user, and the job table, which carries the
submitter and the tier — rather than a third one free to disagree with both.
Statements typed into the editor are deliberately not in it, and the page says
so: they carry no mark of Flint's, so it cannot tell one from the same person's
`clickhouse-client`. The History page shows those.

`FLINT_INFRASTRUCTURE=false` removes that half **entirely**: no navigation
entry, no route, and its code is never fetched. Off means absent, not a disabled
button explaining what you may not do. A team that only ever queries turns it
off and never learns the other half is there.

**An alert is listed where its subject lives**, not where its author sits. One
on `system.replicas` appears under Infrastructure beside the replicas even when
an analyst wrote it, and one on `orders` appears under Data even when an
operator did. Writing them stays in one place — one form to learn, one page that
owns their shape.

Which space that is comes from the server rather than from reading the SQL:
`EXPLAIN QUERY TREE` analyses a statement without running it and names every
table it resolved, through joins, through CTEs, and through an unqualified name
that only means something once you know which database the alert runs in. A
statement touching a user table is Data even where it also reads `system.*` —
the user table is the subject and the system table is context.

Some alerts cannot be placed. `merge('system', …)` names no table at all, and
what it reads depends on its arguments; such an alert is listed in **both**
spaces, saying so, because an alert that is switched on and invisible is worse
than one shown twice. The same line is where an alert whose tables no longer
exist admits it — asked fresh each time the list is built, so dropping a table
under a stored alert shows up as what it is.

Each list says what it is not showing and where those went, and the attention
badge on each space follows the same rule: an operator's firing alert raises the
operator's number, and points at the page that lists it.

`FLINT_TIER` is a different question — not which space is *shown* but what may
be *done*, because everything Flint displays today is a read of `system.*` that
changes nothing:

| tier | what it permits |
| --- | --- |
| `read` | reads only — `readonly=2` on every statement |
| `data` | rows may be written: insert, truncate, mutate |
| `ddl` | structure may be written: create, alter, drop, partitions |
| `admin` | the server may be operated: `SYSTEM`, access, backups |

Unset, it follows `FLINT_READONLY`: read-only means `read`, otherwise `data`.
Every deployment that predates the tier therefore behaves exactly as it did.
The tiers above `data` are opt-in because they are the ones that reshape a
schema or operate a server, and nobody should acquire those by upgrading —
today they gate nothing beyond what is already built, and the actions they
describe are on the roadmap. Setting `FLINT_READONLY=true` together with a tier
that needs to write is refused at boot rather than resolved quietly in one
direction.

The tier is set in the manifest by whoever deploys Flint, never in the UI by
whoever is looking at it: a permission a user can grant themselves is not a
permission.

## Visual language

Flint shares [Dashfile](../../dashfile)'s design language, and its token *names*
are the contract between them — the values are Flint's own: a warm neutral
ground, white surfaces, one green for everything interactive, and a categorical
palette tuned to stay separable for colour-blind readers. The green is a hue
rather than a value: #3ddc9a on the dark ground, re-stepped to #0d794c on white,
because a brand colour that changes family with the theme is not a brand colour
and the bright green is 1.5:1 on paper. Every colour that carries a word clears
AA on the ground it actually sits on, which the browser check measures on the
rendered page rather than trusting to the palette. Plus Jakarta Sans speaks for the interface; JetBrains Mono
speaks for the data — identifiers, types, values, SQL, everywhere the characters
themselves are the content.

Four shapes carry the object kinds, in the rail, the diagram and the tables
alike: a square is a table, a diamond a materialized view, a ring a view, a disc
a dictionary. The accent is deliberately absent from that set — it belongs to
interaction, and a diagram where every table is the hover colour says nothing.

The accent is spent **once per view**, on the thing you are being asked to do.
That is a ceiling rather than a floor: a page whose job is reading — a database,
a health board — carries none at all, and is quieter for it. Everything that
merely says *where you are* says so in ink: the current section is an inverted
pill, the current space an underline in the text colour, the open editor tab a
rule in the same. Figures never wear it; a number nobody can click, painted in
the one colour that means "you can touch this", is a promise the page cannot
keep. A metric with something to say says it in the verdict tones instead.

Health is twelve sections and a little over seven screens; Diagnostics is six
and four and a half. Both are pages somebody works *in*, so each opens with an
index of what it holds — read from the rendered page rather than declared beside
it, because sections load independently and several do not render at all on a
narrow grant. A list that named rows the page does not have would be the same
broken promise as a header counting what the list below it does not show.

State reads in two registers, and which one a fact gets is the whole design: a
**hairline** for something continuously true — a pipeline that flows keeps a
green edge — and a **chip** for something that changed. So `ok` means two
different things and wears two different chips: a verdict that is simply fine
goes quiet, because a green badge on every row of a healthy page is not an
indicator; an alert that *recovered*, or a call that just answered 200, is news
and takes the green.

Five colours carry states, and the fifth is the one most products leave out:
*cold*, a blue for something dormant. An alert switched off, a job paused, a
replica taken out of the set — none of these is fine and none is broken, and
colouring them with either says something untrue in both directions.

One thing moves on its own: data travelling along the schema's edges. A
materialized view really is a live pipeline, and the dots are its measured
throughput rather than an impression of one — so an edge that moves is an edge
rows went through this week, and the pace they travel at is a token
(`--flow-speed`) like every other constant of the product's physics. Everything
else animates only in answer to a pointer, and all of it stops under
`prefers-reduced-motion`, where the spacing survives as static texture.

Controls keep the contract their role announces. A tablist is driven by the
arrow keys with `Home` and `End` at the ends, and holds one tab stop rather than
eight — the panel is one key away, not nine. The diagram's context menu is a
menu: arrows walk it, `Escape` closes it, and anything else dismisses it. A
column that sorts says which way in `aria-sort`, not only with an arrow. None of
that is a separate accessibility pass; it is what the roles already promised.

## Design notes

**No second database.** What Flint remembers — saved queries and dashboards —
lives in a ClickHouse database of its own, never in a Postgres dragged in for the
purpose. Leave `FLINT_WORKSPACE_DATABASE` unset and it remembers nothing.

**ClickHouse's HTTP interface, directly.** Flint speaks to `/?query=…` rather
than through a typed driver, because a SQL editor needs to run statements whose
shape is unknown at compile time, and because `query_id`, `X-ClickHouse-Summary`
and `result_overflow_mode` are all right there.

**Version tolerance.** ClickHouse keeps adding columns to its system tables.
Flint probes `system.columns` once and substitutes a default for any column
this server does not have, so pointing it at an older build degrades one field
rather than failing a page.

**The schema graph is mostly inferred.** ClickHouse tracks only one of these
edges for you — `system.tables.dependencies_*`, for materialized views. A plain
view's sources, a materialized view's target and a dictionary's source table are
recorded nowhere but the object's own DDL, so Flint reads those definitions and
then checks every candidate against the objects that actually exist. That last
step is what keeps aliases, CTE names and `numbers(10)` out of the diagram.

**A materialized view's storage is folded into the view.** A view created
without a TO clause gets a table ClickHouse names after the view's uuid.
`.inner_id.<uuid>` is not an object anybody wrote: drawn as a node it doubles
every such view and labels half the diagram with uuids, so Flint redraws the
edges that touched the storage to touch the view, and counts the storage's rows
and bytes as the view's — which is why a materialized view here has a size at
all, where ClickHouse reports none for it. Its own page does the same and says
so in a sentence: the rows, the size, the parts, the partitions and the keys all
come from the storage table, named in full, because a figure whose origin is
unexplained is a figure you cannot check. The same tables are folded out of the
rail and the object list, behind a line that says how many there are and shows
them on a click — and every count follows the list, so the rail's header, the
kind chips, the headline figures and the diagram all report the same number.
Rows and bytes are the exception, on purpose: that disk is real and it belongs
to the database, whoever named the table. It needs `system.tables.uuid`; on a server too old to have it
they stay where they were.

**`INFORMATION_SCHEMA` is listed once.** ClickHouse publishes every view in it
twice — lower case for PostgreSQL compatibility, upper case for MySQL's — and
the database itself under both names. They are the same views in the same
database, so Flint keeps the lower-case name at both levels, and the headline
counts on the server page are taken off the list rather than from
`system.databases`, so the two cannot disagree. Either spelling still opens: it
is the listing that is collapsed, not the lookup.

**Bundled trust store.** The web PKI is compiled into the binary, so HTTPS to
ClickHouse Cloud works from an image with no certificate store. Point
`FLINT_CLICKHOUSE_CA_CERT` at a PEM bundle to add a private CA.

**Storage, drawn as columns.** The bar beside each column is the one view you
cannot get from `DESCRIBE TABLE`: a ghost outline for the uncompressed extent
and a solid fill for the bytes on disk. A long ghost with a sliver of fill is a
column that compresses beautifully; a solid bar is what your disk actually is.

The scale is the 90th percentile of the columns, not the largest of them.
`system.query_log` holds a `query` column of 8.5 MiB beside eighty columns of a
few hundred kilobytes; against the maximum, eighty-eight of its eighty-nine bars
round to the same hairline and the picture says nothing. The handful above the
scale are drawn full width with an accent edge — they run off the end rather
than pretending to fit — and the legend counts them. On a table narrow enough
for the two to agree, nothing is marked and nothing changes.

### Checking a deployment

Three checks, for three classes of defect that the unit tests are structurally
unable to see.

`contrib/smoke.sh http://localhost:8096` walks every endpoint and fails on the
first one that does not answer what its caller expects — including a 200 that
carries an error, which is how most of this codebase's bugs have presented. It
understands the stateless mode rather than reading it as a broken deployment.

The bug class it exists for is SQL semantics: an alias that shadows the column it
aggregates, a `!=` that yields `UInt8` where the wire wants a boolean. No unit
test can see any of it — the statement has to reach a real ClickHouse. Nine
alias-shadowing bugs in this codebase were all found that way and none by a unit
test, which is why the check is a script you can run rather than a rule to
remember.

`node contrib/browser-check.mjs http://localhost:8096` opens every page in a real
browser, in both themes, and fails on a console error, a failed request, or any
text/background pair that misses WCAG AA — measured on what the page actually
rendered rather than on the tokens it was supposed to use. It needs a Chrome or
Chromium (`FLINT_BROWSER=…`, or one of the usual paths) and the `playwright-core`
dev dependency in `frontend/`.

Its bug class is what only a rendered page shows: a component that throws when a
stored record is in an older shape, a button whose label drops below AA *while
the pointer is on it*, a windowed grid that renders six thousand pixels tall
because its parent is unbounded. All three shipped in this codebase and all three
were found this way.

`node contrib/api-check.mjs http://localhost:8096` publishes a throwaway endpoint
over `system.numbers`, asks it two dozen questions, and deletes it again —
including when an assertion fails, because an endpoint left armed after a failed
check is worse than no check. It needs a workspace, and a sign-in where the
deployment has one: it predated `FLINT_AUTH` for a while, which meant the half
of Flint that other people's scripts depend on was uncheckable on exactly the
deployments that have users.

Its bug class is the one a status code cannot show. `smoke.sh` asks whether a
route answers; this asks whether the answer is *right*, which for the half of
Flint that other people's scripts depend on is the only question. A filter that
silently returns the unfiltered table is a 200. So is a cursor that skips every
third row, a date that matched nothing because it failed to parse, and an error
that quotes the published statement back to whoever triggered it. The wrapper,
the bindings and the ordering all have to reach a real ClickHouse to mean
anything, so the check walks all 500 rows of a paged result and counts them.

`node contrib/dataset-check.mjs http://localhost:8096 <user> <password>` does the
same for the other half, and the case for it is stronger: more of what the
dataset API answers is arithmetic. A published endpoint that filters wrongly
returns the wrong rows and somebody eventually notices; an aggregation that
groups wrongly returns a *number*, and a number is believed.

So almost nothing in it asserts a fixed value. Every check is a self-consistency
one — grouped counts must sum to the ungrouped count, an `OR` of two values must
equal those two groups and its negation the rest, a comparison's previous half
must equal the same period asked for on its own, buckets must partition the
window they are in, a cursor walk must visit exactly the rows one big page does.
Those hold on any server with any data, and each fails loudly if the SQL beneath
is subtly wrong.

It checks the **audit** too, and for the same reason: an audit that misses
entries looks exactly like a quiet week, and one that reports the wrong user
looks like a colleague did something they did not. So it makes a read, waits for
the log to flush, and asserts that read is in the trail under the right name —
plus that every entry is dated in the past, that the list is newest first, and
that a failure carries the reason it failed.

That check found a real one. Asked as a user who may not read
`system.query_log`, the page reported *"this ClickHouse version has no
log_comment"* — because an unreadable table returns an empty column list, and
the column was tested before the grant. It told an operator to upgrade a server
that did not need upgrading. The order is now grant first, columns second.

Which table each check reads is itself a decision, and the first draft got it
wrong three times — twice on *which* table, and once on what it may assume about
one. A comparison check asserted that the previous hour held rows; on a server
nobody queried an hour ago it failed, and a check that fails because nothing
happened is a check that gets ignored. It skips that half now and says why,
while still asserting the part that holds either way: the previous half equals
the same period asked for on its own, zero included. `system.query_log` is the only table always present that has
timestamps — but it **grows while the check runs**, because the check's own
requests land in it, and its `query_id` is not unique, because one query logs a
start *and* a finish. Both broke the cursor walk, and neither was a bug in Flint.
Anything that reads a number twice now reads `system.columns`, which holds still.

It also publishes a column of every type family and compares the OpenAPI
document's claim about each with the value that actually arrives — the check
that found three wrong mappings, none of which a unit test could have seen,
because the authority on how ClickHouse serialises a `Decimal` is ClickHouse.

### Alerts and outbound requests

An alert with a webhook makes Flint POST to an address a user typed in, carrying
the alert's name, its statement, and the measured value. That is what a webhook
is for, and it is how every alerting tool works — but it also means anyone who
can create an alert on a shared Flint can have query results sent to a host they
choose. Set `FLINT_ALERT_WEBHOOKS=false` where that is not acceptable: alerts
still evaluate and still keep their history, and each event records that delivery
was disabled rather than pretending it was sent. Redirects are not followed, so a
webhook cannot quietly forward Flint somewhere else.

### Grants for access control

The access view needs to read ClickHouse's own account tables, and a read-only
role usually cannot:

```sql
GRANT SELECT ON system.users TO flint_reader;
GRANT SELECT ON system.roles, system.grants, system.role_grants TO flint_reader;
```

Each is checked separately — a role granted `system.users` but not
`system.roles` gets the users and an empty role list, not an error. None of it
lets Flint change anything.

`system.query_views_log` is what makes the pipelines view work; without it, view
health falls back to the structural check and says so.

### Grants for diagnostics

Diagnostics read `system.*` and nothing else, so a read-only role can have all
of it without seeing a row of your data:

```sql
GRANT SELECT ON system.query_log TO flint_reader;   -- load, patterns, failures, traffic
GRANT SELECT ON system.parts TO flint_reader;       -- storage, partitions
GRANT SELECT ON system.merges, system.mutations TO flint_reader;  -- right now
GRANT SELECT ON system.merge_tree_settings TO flint_reader;       -- the thresholds
GRANT SELECT ON system.replicas TO flint_reader;   -- replication, if the server has any
```

Grant none of it and the page says which grant each section wants. `system.parts`
is worth granting even if you skip the rest: without it the explorer loses every
size, row count and partition figure — the object list, the columns, the DDL and
the profile all still work.

### Grants for the workspace

Stateless mode needs `SELECT` and nothing else. A workspace additionally needs
`CREATE DATABASE`, `CREATE TABLE`, `INSERT` and `SELECT` on that one database —
and Flint says exactly that if the grant is missing, rather than failing with
ClickHouse's own message about privileges.
