# Flint

**The workspace ClickHouse doesn't ship with.**

A self-hosted, single-container web interface for exploring and querying
ClickHouse. Point it at a server, open a browser, and start reading your data.

This is `v0.1`: the database explorer and the SQL editor. It is deliberately
**read-only by design** — connecting Flint does not create a table, write a
row, or change a setting on the server you point it at.

---

## Run it

```bash
cp .env.example .env      # set FLINT_CLICKHOUSE_PASSWORD, and the URL if needed
docker compose up --build
```

Then open <http://localhost:8080>. The default connection reaches a ClickHouse
running on the host machine, and `FLINT_READONLY` defaults to `true` here:
pointing a fresh deployment at a real database should not be able to write to
it.

If your ClickHouse is bound to the host's **loopback only** — which is what
`kubectl port-forward` and Tilt give you — a bridged container cannot see it,
whatever address you use. Add the host-network overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.host.yml up --build
```

Without compose:

```bash
docker run --rm -p 8080:8080 \
  -e FLINT_CLICKHOUSE_URL=http://clickhouse:8123 \
  -e FLINT_CLICKHOUSE_USER=explorer \
  -e FLINT_CLICKHOUSE_PASSWORD=... \
  -e FLINT_READONLY=true \
  flint:local
```

`docker build -t flint .` builds it: one stage compiles the frontend, one
compiles the binary with the frontend embedded in it, and the runtime image is
`distroless/cc` carrying nothing but Flint — 34 MB.

Because that image has no shell and no curl, the container healthcheck is the
binary itself (`flint --health-check`). It is a liveness check: if ClickHouse is
down, Flint is still healthy and says so on the page, and restarting it would
fix nothing while making the outage harder to see.

## What it does today

**One place to type a name.** `⌘K` — or `/` — searches everything at once:
databases, tables, views, every column, and the saved queries, dashboards,
reports, alerts and endpoints Flint keeps. A rail filter finds a table in the
database you are already looking at; on a server with forty databases that is
the wrong question, because you know the name and not where it lives.

The ranking is plain and deterministic, because fuzzy matching feels clever and
puts the wrong row first: a name you typed exactly wins, then one that starts
with it, then one that starts a word inside it (`events` finds `raw_events` and
`analytics.events`), then one that merely contains it.

Two rules came out of looking at real results rather than from taste. *One row
per destination* — a column's route is its table's route, so a table and its own
matching column are the same suggestion twice. And *every object above every
column*: searching `events` on a real schema found seven columns named `events`
in seven rollup tables and pushed the view `events_by_region` off the list. You
typed a name, and names are what objects have; a column match is a way to reach
a table you did not name, which is useful and is never the first answer.

ClickHouse's own databases are left out. `system` alone holds thousands of
columns, and a palette where `name` returns forty rows of `system.columns` has
buried the answer. Everything is fetched when the palette opens rather than on
every page load, since the corpus is every column on the server.

**It opens on your schema, drawn.** Not an inventory screen — Flint resolves a
database (the one you were last in, else the fullest one that is yours rather
than ClickHouse's; `default` counts as yours, because that is where a great many
people keep everything) and draws it as the pipeline it is: sources on the left, the
materialized views that consume them next, the tables those write into after
that. Hover any object to trace its lineage; everything unrelated fades. Click
to open it.

**And which of it anyone actually uses.** `Traffic` puts each object's reads over
the last week on it: a filled track against the busiest object in the diagram, or
an empty track and "no reads" for everything nothing has asked for. The diagram
draws dependencies, which are permanent — a materialized view will feed its
target table forever whether or not a single person has ever selected from it.
Only the log can tell you which half of the picture is load-bearing, and the
answer is usually a smaller half than you would guess.

Reads, not traffic in general, and the distinction is the point: a target table
is written on every insert, so counting writes here would light up the whole
pipeline and say nothing. The scale is fixed to the whole diagram rather than the
slice on screen, because a scale that moves when you filter makes a quiet table
look busy the moment its noisy neighbour leaves the view. Objects borrowed from
another database are looked up under their own name, so a dictionary's source
table is measured like anything else. The caption says the window and the
exclusions, since a magnitude drawn without them is a number you cannot argue
with — and the toggle is disabled, with the reason, where `system.query_log`
cannot be read.

Past 40 objects it draws a **neighbourhood** instead of the whole thing, centred
on your biggest table that is actually part of a pipeline — never on the largest
object in the database when that object is connected to nothing, because a
diagram of one box captioned "not referenced by anything else" is the one view
that cannot show how data moves. The name of the centre is itself the control
that changes it, and every object in the database is in that list. The legend
under the diagram is the kind filter — it was already naming the kinds and
counting them there while a second row of buttons said the same words above, and
the one attached to the picture is the one that reads. Drawing all 170 objects of a real database is 7000px tall and
fits on screen at 35% zoom, where no label is readable — a texture, not a
diagram. One node's fan-out is capped too, and the view says how many objects
it is leaving out rather than trimming quietly.

Three things are borrowed from [Kiali](https://kiali.io)'s mesh topology, which
solves the same problem of a graph too dense to read. **Boxes** group the
diagram by database, because when a schema reaches across a boundary the
boundary is itself information. **One click inspects** an object in a side
panel — the first row of real data, engine, keys, partitioning, TTL, and both
directions of its lineage — instead of navigating away and costing you the view
you had built up; **double click** re-roots the neighbourhood on it, the same
split Kiali draws between selecting and changing point of view. **Right click**
is the shortcut for when you already know which object you mean: open it, centre
on it, copy its name. The panel's row is turned on its side — field names down
the left, values beside them — because a grid of six columns in a 320px panel
shows two of them, both ellipsised, and what makes an object recognisable is
seeing every field with a real value next to it. And the travelling dots on the edges,
which Kiali calls traffic animation, now have a **toggle**.

Three other Kiali ideas are deliberately left out. Edge labels and health
colouring need a rate and an error rate; a schema has neither, and the honest
version of them — which tables are queried, how often, how much they scan —
belongs to the diagnostics phase where `system.query_log` makes them real rather
than decorative. Its force-directed layouts would be a step backwards here: a
ClickHouse schema is a directed acyclic flow, and a layered layout says which
way the data moves where a force layout throws that away. And its replay over a
time window needs history Flint does not keep yet.

The diagram has its own **filter** — by name and by kind — which narrows what is
laid out rather than dimming it, so what is left gets the whole frame. It can
**flow either way**: across the page or down it. Neither direction is better in
the abstract — it depends on whether the schema is deep with few objects per
stage or shallow with many — so `Auto` lays it out both ways and keeps whichever
fits the frame, with `Across` and `Down` to overrule it. And **full screen**,
because a schema is the one thing here worth the whole display.

**Explorer.** Every database, table, view, materialized view and dictionary,
with the metadata that decides how each one behaves: engine, sorting key,
primary key, partition key, TTL, active parts, projections, and the lineage
edges between materialized views and their sources.

**Written for both audiences.** The engine name stays primary — an expert reads
`ReplicatedSummingMergeTree` and stops. Underneath it, one quiet sentence says
what that actually does, and every clause of a table's shape carries the same
treatment. Nobody has to already know what a sorting key is to use this — and
nobody has to read the same six sentences on their hundredth table either, so
one click puts them away and Flint remembers.

**Only the figures that exist.** A view stores nothing, so it is not given a row
of dashes where a table's rows, bytes, compression and parts would be: an absent
figure is dropped, and a materialized view is told how many objects it reads
from instead. `ORDER BY` and `PRIMARY KEY` are printed once when they hold the
same columns, which is ClickHouse's default — so seeing them apart means they
genuinely are. A part count is captioned with how many that is per partition,
because 55 is healthy and 5,000 is an incident and the number alone cannot say
which.

**Looking at the actual rows.** An object page opens on its data, because that
is what somebody came for — a list of column names is what they read *after*
seeing that the shape is not what they expected. An object that stores nothing
keeps its columns, having nothing to open on.

`SELECT * LIMIT 200` answers one question and stops, so the preview is a small
explorer over the one table: newest or oldest by any date column, stored order,
a random sample; a row count; filters built with the same operators and the same
literal-quoting as the no-code builder, because one place has to decide how a
typed value becomes SQL; and a column chooser.

**Every control says what it costs**, which is the part a first-time ClickHouse
reader cannot guess and an expert checks by habit. "Newest first" is nearly free
on a table whose sorting key leads with that column and a full scan on the next
one along — so the page says which, by name: *the table is sorted by device_id,
ts, not by ts — so ordering by it reads the whole table and then sorts*. A random
sample says it reads everything. And the default is the cheap answer: a table
that would need a full scan to show its newest rows opens in stored order
instead, because spending that on somebody's behalf before they asked is not a
courtesy.

Choosing columns is the other half. Reading four of thirty-six is the largest
saving a column store offers and it is invisible unless something says so, so the
figures under the grid are what the statement actually read: the same query over
`events` went from 17 MiB to 4.8 MiB by naming two columns instead of eight.

A wide row is unreadable across, so one can be opened downwards — thirty-six
fields as a list, with the empties marked, which is the only way to actually read
a row that wide.

**Storage, made visible.** Each column shows its size on disk against its
uncompressed extent, so you can see at a glance which column *is* your table
and which one compresses to nothing. Same treatment for partitions.

**Query builder, no SQL required.** Dataset → columns → filters → sort → limit,
and the generated ClickHouse SQL is on screen the whole time, one click from the
editor. Choosing a column with no aggregate makes it a grouping, so `GROUP BY`
writes itself. Everything you type is encoded rather than interpolated: a value
of `' OR 1=1 --` becomes a string containing that text. Relative times like
`now() - INTERVAL 7 DAY` pass through unquoted, but only by matching a closed
grammar — `now() + INTERVAL 1 DAY` does not, and becomes a literal.

**A profile of an empty table says so.** Distinct counts, ranges and
most-common values all need rows; without them the table was thirty-six lines of
dashes, which said only that Flint asked anyway. The column *roles* survive —
they come from the types — so those stay and the rest is one sentence.

**Automatic profiling.** Open a table you have never seen and the Profile tab
says what is in it: nulls as a proportion, approximate distinct counts, ranges,
the most common values — and what each column is *for*. Time, metric, category,
dimension, identifier, geographic, structure. The guess comes from the data
rather than the name: a `UInt8` with three values is a category, not something to
average, and `device_id` with four hundred values across half a million rows is a
dimension you group by, not an identifier. One pass over the data, and past five
million rows it reads a prefix and says so.

**SQL editor.** ClickHouse syntax highlighting and schema-aware autocomplete:
`analytics.` completes tables, `events.` completes that table's columns with
their types, and a bare prefix completes against whatever the statement's
`FROM` clause names. Multiple tabs, statement-at-caret execution (`⌘↵` /
`Ctrl+↵`) so one tab can hold a scratchpad of queries, cancellation of a
running query, and execution statistics — rows and bytes scanned, elapsed
time — for every run.

**A results grid you can work in.** Both axes are windowed, so eighty columns
and ten thousand rows cost what ten of each do. Columns size themselves from the
values actually present and cap before one long JSON blob can push everything
else off the screen; drag a column wider and it stays wider the next time that
query runs. Click a header to sort the rows on screen — it says so, and says
these are the rows that came back rather than the table. Pin a column and it
holds the left edge while the rest scrolls under it. Select cells with the mouse
or the arrow keys and `⌘C` copies the block as TSV; `⏎` opens the value in full,
JSON indented, for anything a single line cannot hold. A `NULL` and an empty
string do not look alike.

**Statements you can read.** ClickHouse returns `create_table_query` on a single
line; for a thirty-column view that is two thousand characters of soft-wrapped
text in which nothing can be found. Flint breaks it into lines — one column per
line, one selected expression per line, every clause its own — and colours it
with the same palette the editor uses. The formatter works over tokens, not over
the raw string, so a column called `order by` and a literal containing `FROM`
come through intact; its invariant is that the sequence of non-space tokens is
unchanged, which means it can lay a statement out badly but never corrupt one. A
view's own definition leads, and the full CREATE — the definition plus the column
list ClickHouse derives from it plus the settings of the session that made it —
is one click away instead of printed twice.

**Where every column of a view came from.** ClickHouse fills
`dependencies_table` for a materialized view and leaves it empty for a plain
one, so Flint reads the definition instead: which tables it selects from, and for
each output column, which source columns it is built out of and by what
expression. A view's Columns tab spends the room that would have shown four
dashes of storage on a `From` column, each source a link, and selecting a view in
the diagram says the same thing in its side panel without leaving the picture. It is a best-effort
read of the shapes a view actually has — a select list, a from, some joins, maybe
a union — and a reference it cannot place is marked unplaced rather than
attributed to whichever table looked likely: a lineage you cannot trust is worse
than none.

**And the schemas it is built out of.** A view gets a Sources tab: one panel per
table it selects from, saying how much of that table it actually touches — "13 of
24 columns read" — then each read column with its type and the output columns it
feeds. Columns read without being returned are listed too, because a join key is
a dependency even though it never appears in the result, and the ones the
definition ignores are counted rather than listed. It resolves an alias to what
the alias came from: `INFORMATION_SCHEMA.columns` selects half its columns as
upper-case aliases of the other half, and following that chain is the difference
between attributing them to a column that does not exist and tracing them to the
one that does. And where a column's type changes on the way through — read
`Bool`, returned `Nullable(Bool)` because a join made it nullable, or
`LowCardinality(String)` flattened to `String` — it says so, and stays silent
where nothing changed, which is what makes the mark worth reading.

**The whole path it sits on.** `Sources` and `Read by` answer about the
immediate neighbours; the question that needs its own tab is the one spanning
them — where do these rows ultimately come from, and where do they end up. It
follows the arrows and only the arrows, so a sibling view that happens to read
the same source does not appear: that is a neighbourhood, not a path.

It reads top to bottom in the direction the rows travel, with the object you are
on marked in the middle. Where the chain leaves this database, it says so: Flint
loaded this database's schema and not the other one's, so the path may continue
past that object rather than ending there.

**And the same question backwards.** Every object gets a Read by tab: which views,
materialized views and dictionaries select from it, and column by column, which
of them consume it and under what name. This is the question you have when you
are about to change something — if this column goes, what breaks — and ClickHouse
cannot answer it, so the readers come from the schema graph, which recovers plain
views by reading their definitions. A column read only by a join or a filter is
listed as such, because it is a dependency even though it never appears in a
result. The columns nothing reads are named too: those are the ones you can
change freely.

**Saved queries, kept in ClickHouse.** The first feature that needs Flint to
remember something, and it remembers it where the brief says to: a table in a
database of its own, not in a second datastore dragged in for the purpose. Set
`FLINT_WORKSPACE_DATABASE` and Flint creates `saved_queries` there on first use;
leave it unset and Flint writes nothing at all, which is what makes the
stateless mode a real guarantee rather than a habit.

ClickHouse has no UPDATE, so the table is a log of versions over a
`ReplacingMergeTree` and a delete is a tombstone. Reads collapse it with
`argMax` rather than `FINAL`, which costs no more and lets `created_at` survive
as the minimum across versions where `FINAL` would overwrite it with whatever
the last edit said.

Workspace writes go through even under `FLINT_READONLY`. That flag is a promise
about *your* tables — that Flint will not change the data it is exploring. It
was never a promise that Flint would refuse to remember a query you asked it to
save, and a read-only deployment with a workspace would otherwise be inert.

**Charts the result suggests itself.** Flint reads the shape of what came back
and offers only the forms that fit it: a time column and a measure gets a line,
a label and a measure a bar, two measures a scatter, and a single row a figure
rather than a one-bar bar chart. Nothing is drawn until you pick one, and the
table stays a click away, because every value a chart shows has to be readable
somewhere that is not a tooltip.

Two measures on different scales become small multiples, never two y-axes: the
alignment of a second axis is arbitrary, so a dual-axis chart invents a
correlation that is not in the data. Bars and filled areas start at zero, since
both encode the value as a size — an area rising from 50 says the quantity is
far larger than it is — while a bare multi-series line keeps its zoomed axis,
where forcing zero would flatten the shape it exists to show.

Labels follow the same all-or-nothing rule as the layout: each bar is named
under it and carries its value on the cap only when every label fits in full,
measured rather than estimated. Thirty bars all reading `segm…` name nothing, so
past that point the two ends label the axis and the tooltip and the table carry
the rest. Colours come from a palette checked for colourblind separation and
contrast in both themes, and the numbers and labels wear text colours, never the
series colour.

**Dashboards.** Any chart you have built in the editor can be sent to a
dashboard, which is a twelve-column grid of tiles that each re-run their own
query. Widths come from a fixed set rather than free resizing, so a dashboard
cannot be dragged into a layout that breaks on the next screen; tiles refresh on
a shared interval, and a refetch holds the previous render instead of flashing a
skeleton.

The spec is JSON in the same workspace database as saved queries, and it is
parsed before it is stored — a dashboard saved with a malformed spec is a
dashboard that cannot be opened again. Reading is defensive in the same spirit:
a tile with no SQL, an out-of-range width or a chart kind this build does not
know is dropped, so one bad tile costs you that tile and not the dashboard.

**What needs looking at.** Flint now watches things on your behalf, and none of
that is worth much if you have to visit three pages to learn that one of them is
unhappy. So the count of things needing attention rides beside `Alerts` and
`Reports` in the nav, and the diagnostics page opens with what is wrong.

Only what is *wrong or stuck* counts. A count of things that are fine is a
vanity number, and a badge that is always lit stops being read — so there is no
badge at zero, and nothing is listed for an alert that is quiet or a report that
completed. An alert somebody paused is left alone: pausing it was a decision, and
nagging about it second-guesses that.

An alert that *cannot run* is listed beside one that is firing rather than below
it. "This condition is true" and "we have no idea whether this condition is
true" are both things you need to know, and the second is much easier to miss.
Where `system.query_log` cannot be read, failing endpoints are not listed at all
rather than reported as zero — inventing reassurance is worse than staying quiet.

**Are the materialized views flowing?** ClickHouse answers that in three places
and no one of them is enough, which is why there was nowhere to look before.

`system.query_views_log` records every view execution an insert triggered — rows
written, duration, exception. That is the everyday health of a classic view, and
it is silent about the most common way one breaks: drop a view's target table and
the *insert* fails before the view runs, so nothing is logged. The view looks
idle, the pipeline is dead, and the only evidence is a failing insert somewhere
else. So the target is checked structurally too, and a missing one outranks a
clean log — the log is clean *because* nothing ran.

A refreshable view has none of that shape. It runs on its own schedule, and
`system.view_refreshes` holds its real state: last success, next run, exception,
retry count. Judged by the insert log it would look permanently idle, so it is
judged by its own.

"Nothing has happened" and "we cannot see what happened" are kept apart. Without
`system.query_views_log` a view with no runs reads as **Unknown**, not as idle.

**Forcing one by hand means two different things**, and conflating them is how
people double-count data. A refreshable view can simply be told to run —
`SYSTEM REFRESH VIEW`, one button, refused under `FLINT_READONLY` because it
rewrites a table. A classic view has nothing to refresh: it is a trigger, and the
only way to fill a gap is to insert the missing rows yourself. Flint writes that
statement out and stops there, with the warning that running it as-is recomputes
everything and double-counts what the target already holds.

**Who can do what.** Users, roles and grants, read-only. A dump of
`system.grants` is unreadable — ClickHouse stores one row per privilege, so a
full-access user is seventy rows — so it is grouped by scope: `analytics.*`,
`system.query_log`, `everything`, each with what may be done there and whether
the holder may pass it on.

Then the handful of facts worth pointing out: who can connect with no password,
who has rights on everything, who can grant to others, which role nobody holds,
and which user can log in and see nothing. `valid_until` is an array — one expiry
per authentication method, since a user may hold several — and ClickHouse writes
the epoch to mean "never", so neither is reported as an expiry.

Flint will not change any of it. Granting and revoking are decisions that outlive
a click, and they belong in a statement somebody wrote on purpose.

**Are the replicas keeping up?** Only on a server that has replicas — a
single-node deployment is never offered a tab that could only ever say "nothing
is replicated", and a link straight to it on such a server says exactly that
rather than a blank page.

The ordering of verdicts is the whole content of this view, because the loudest
number is the least useful one. Lost parts come first: `lost_part_count` above
zero is data gone, not data late, and no delay figure outranks it. Read-only is
second, and it is the state that hides — a replica whose Keeper session expired
keeps answering `SELECT` perfectly and refuses every write, so it surfaces as a
failing insert in some other system rather than as anything wrong here. Falling
behind is third, judged on the queue as well as the clock: the queue grows before
`absolute_delay` moves, so it is the earlier signal. Fewer active replicas than
total is last — less redundancy than the table asked for, which is worth knowing
and is not an outage.

**Some of those numbers come from Keeper, so they are unavailable exactly when
you need them.** Testing this against a replica with its Keeper connection cut
was worth more than the code it produced: `absolute_delay` came back as
**1787650776** seconds — fifty-six years, because the comparison had nothing on
the other side — and the replica counts collapsed to 0 of 0. Both are reported as
unknown rather than printed. The verdict order already kept the nonsense out of
the headline; without the live test it would still have been sitting in the fact
row underneath, looking like a measurement. `readonly_duration` is also null right
after a restart, so "read-only" is said without a duration rather than "read-only
for 0s".

A stuck replica is listed in *What Flint is watching* on the server view as well,
because this is the failure whose first symptom appears in a different system
entirely.

**What is running, right now.** The first thing anybody reaches for when a
server is misbehaving, and the only view that can answer "what is doing this":
every query in flight with its user, how long it has been going, what it has
read, what it is holding, and how far along it is — absent rather than a bar at
zero where ClickHouse has no estimate to divide by, because "we do not know yet"
is not "no progress".

Each one can be stopped. That is allowed even where Flint is read-only, and the
distinction is the point: `FLINT_READONLY` promises Flint will not change *your
data*, and a KILL destroys nothing — it stops work in progress. `SYSTEM REFRESH
VIEW` rewrites a table and stays refused. An operator staring at a runaway SELECT
on a read-only deployment is exactly who needs the first and not the second.

A query id is whatever the client called it — Flint mints UUIDs for its own, but
another tool may send `nightly-rollup-3`, and requiring a UUID rejected exactly
the queries somebody most wants to stop. Stopping one that has already finished
says so rather than reporting success.

Flint's own introspection is left out of the list. The query fetching it is
itself running, and a page that mostly shows you Flint looking at Flint answers
nothing.

**Free space, and the errors nothing else counts.** A full disk is the incident
nobody sees coming, so the disks sit in the same section, measured against the
margin ClickHouse keeps for itself rather than the raw free space — a disk with
ten per cent free of which nine is reserved has one per cent, and it says so.

And `system.errors`: counters since the server started, not only from queries, so
some of them appear nowhere else in Flint. Killing a query shows up here as
`QUERY_WAS_CANCELLED` a second later, which is the point — this is the table that
sees what the query log frames as success.

Each of these lists can be individually refused: a role granted `system.merges`
but not `system.processes` keeps the rest of the section, and the one it lost is
named rather than shown as empty.

**Diagnostics that explain rather than measure.** A console over `system.*`
answering what the server is doing, what it costs, and what it is quietly
wasting: the load in a window, the query patterns ranked by *total* time, the
failures grouped by error, which tables are read, which are only ever written,
what compresses and what does not, and how close any partition is to the limit
where ClickHouse starts slowing inserts down.

Every number that carries a judgement carries the threshold it was judged
against, read from the server rather than remembered — `parts_to_delay_insert`
ships as 150 on some builds and 1,000 on others, and a threshold guessed wrong
invents alarms. Where the reading is unusual the row says why in a sentence: a
table whose every read walks all of it is a table whose sorting key does not
match its queries, and that is worth more than the ratio it is derived from.

Reads and writes are counted separately, because ClickHouse's log names every
table a statement touched: count them together and a materialized view's target
table is credited with traffic it never had — it was written by the insert, and
nothing has selected from it in weeks. That difference is the whole point of the
section, so the two numbers stay apart.

**Flint leaves its own traffic out of it.** Every metadata query Flint sends is
stamped with a `log_comment`, and the diagnostics and the history panel exclude
that stamp. Without it the page is a self-portrait: it opens, runs a dozen
queries against `system.*`, and reports its own queries as the costliest thing
on the server. Statements you run in the editor are your workload and stay.

The four sections load independently and each can be individually unavailable,
because on a locked-down role most of them are. A role granted `system.parts`
but not `system.query_log` still gets the storage half of the page. When a role
is granted none of it, one banner names each missing grant instead of eight
copies of the same sentence — and Flint distinguishes a missing grant from a
disabled log, since `system.columns` is itself grant-filtered and reporting "the
log is switched off" would send the reader to change the wrong thing.

**Alerts: a question asked on a schedule.** A statement, a condition, and how
often to ask. Flint runs it in the background, keeps a history of every change,
and POSTs to a webhook if you give it one. The condition is a closed grammar —
the number of rows, or the first value, against one of six comparisons — because
an expression language here would mean running user-authored code on a timer
inside the server, and everything richer belongs in the SQL where ClickHouse
evaluates it.

Three commitments hold this together.

*An alert is a question, never a change.* Its statement always runs with
`readonly=2`, whatever `FLINT_READONLY` says, because an alert runs unattended
and nobody is watching to notice that the thing scheduled every minute is a
DELETE. Verified the way it should be: on a Flint with read-only *off*, where an
ordinary editor INSERT succeeds, a scheduled INSERT is refused and the table is
unchanged.

*Notifying is done on transition, not on truth.* A condition that stays true for
a week is one event, not ten thousand. An alert that cries every minute is an
alert people turn off, and an alert people turn off is worse than none. A new
alert that finds nothing wrong records nothing at all — nobody wants "your new
alert is fine" in their history.

*A failure to evaluate is its own state.* "The server was unreachable", "the
statement returned no rows so there was no value to compare", "the first column
is text" — none of these is "the condition is false", and quietly reporting the
second is how a monitoring tool tells you everything is fine while it is blind.
Those alerts show as **Cannot run** rather than as healthy.

The history records what became of each notification in three states, not two:
sent, failed with the reason, or skipped because there was nowhere to send it.
"There was no webhook" is not "delivered", and a log that rounds the first to the
second is a log that cannot be trusted about the one thing it exists for. Where
the last notification did not get through, the alert says so on its own row —
"we tried and could not reach anyone" is the one thing an alerting tool must
never round to silence.

Each alert reads back as a sentence — *Every 5 minutes, run this and notify when
the number of rows > 0* — because a condition that says the opposite of what was
meant is invisible in three dropdowns and obvious in a line of English.

**Reports: what the numbers were.** A dashboard shows you now — last Monday's
version of it is gone. A report is the other half: a set of statements, a
schedule, and a *kept* answer, so "what did this look like three weeks ago" has
one. Opening an edition shows the numbers as they were, drawn through the same
chart and grid the live editor uses; nothing is re-queried, because re-running it
would answer today's question.

A dashboard someone has already arranged is the best possible starting point, so
**a report can be built from one** — its tiles become the sections, statements,
databases and chart forms intact. The two are nearly the same thing said about
different moments: a tile is a statement and a chart shown now, a section is the
same statement and chart kept.

Time is ClickHouse's. The server that stores the timestamps does the date
arithmetic too — it hands over midnight, the day of the week and the minute of
the day in its own timezone, and Flint compares integers. One clock, the one
already shown on the server page, and no second one to disagree with it. The
schedule reads back as a sentence naming that zone, because a report due at nine
is due at nine *somewhere*.

Due-ness comes from the recorded runs, never from what the process remembers. A
restart at 09:05 does not run the nine o'clock report again; a Flint that was
down at nine still runs it when it comes back. A slot missed by more than a day
is recorded as skipped rather than delivered late — nobody wants Monday's summary
on Thursday, and the numbers it would carry are today's anyway.

A run where some sections failed is `partial`, which is neither `ok` nor
`failed`: a report where two of five statements broke is not fine and not
useless, and both roundings mislead. Each section keeps up to 500 rows and says
when it was cut short. A webhook is told that a report ran and how it went — the
snapshot stays here, where it can be read, because a snapshot can be megabytes
and the thing on the other end is somebody's five-line script.

Snapshots outlive the code that wrote them, by design — six months of them. So
reading one is defensive in a way a live result never has to be: every field is
checked and repaired, and a snapshot Flint no longer fully understands renders as
much of itself as it can. An early version stored column names as bare strings,
and handing one of those to the grid took the whole page down over a record from
March.

**Send it, rather than retype it.** A statement written and tested in the editor
goes to an alert, a report or an API from the editor itself — the target page
opens with its form already filled in. A query retyped on another page is a
query that will differ from the one that was tested, and the difference is
usually the interesting part. The handoff travels in the URL, the same
convention the editor already uses for `/query?sql=…`, so it is linkable and
survives a reload; it is cleared once consumed, so a reload does not reopen a
form somebody dismissed.

**Try it before you arm it.** An alert, a report section and a published
endpoint are all statements that will run later, unattended, under a guarantee
the editor does not apply. So each form runs it *that way* before you commit:
read-only whatever this Flint is otherwise allowed to do, capped, and shown
beside the thing that produced it. A test under different rules than the real
thing is worse than no test — on a writable Flint, testing an INSERT through the
ordinary query path would insert.

For an alert the answer is not the rows but the verdict: *right now this would be
firing: the value > 1000 (measured 509,904)*, or *right now this would be quiet*.
That is the only question its author actually has, and a condition that says the
opposite of what was meant is invisible until something asks it. For a published
endpoint the check runs with the parameter defaults filled in, so it answers what
a caller would get; where a placeholder has no default it says which one needs
one rather than passing ClickHouse's "Substitution `city` is not set" along.

**No-code APIs: a statement, published.** Write the SQL once with ClickHouse's
own `{name:Type}` placeholders in it, and Flint serves it at `GET
/api/data/<address>`, as JSON objects, as CSV, or as NDJSON. A spreadsheet, a
dashboard somewhere else, or a five-line script can fetch it; nobody has to
write an endpoint.

The parameters are discovered *from the statement* rather than configured beside
it, because the statement is the only thing that can be right about what it
needs and a list kept next to it drifts. They are bound parameters, so a caller
supplies values and can never supply SQL — and only the parameters the statement
declares are forwarded. That last one matters more than it looks: ClickHouse's
HTTP interface takes its *settings* as query parameters too, so passing along an
unrecognised one would let a caller turn off the row cap, or the read-only mode,
by adding it to the URL. Everything else in the query string is ignored.

A published statement always runs read-only, with the endpoint's own row cap, and
says when it hit it — in the JSON envelope and in an `X-Flint-Truncated` header,
so a CSV consumer that cannot read the envelope still has a way to notice.

**Callers may shape the answer, never the question.** A caller can page through
a result, filter it, order it and ask for a subset of its columns, all over the
query string:

```
GET /api/data/sales?region=eq.EMEA&amount=gte.1000&order=amount.desc&select=id,amount&limit=100&offset=200
```

Operators are a closed set — `eq ne gt gte lt lte like ilike in nin isnull
notnull` — and every value a caller writes travels as a bound parameter, under a
prefix no declared parameter is using. Column names are matched against the
columns the statement *actually returns*, asked of ClickHouse with `DESCRIBE`
rather than parsed out of the SQL, so a name that is not one of them is refused
by name: "`citty` is not a column this endpoint returns; it has city, n". Under
the old rule an unrecognised key was ignored, which meant a misspelt filter
returned the unfiltered table and looked exactly like an answer.

Three details worth the words. Dates are bound as text and parsed by ClickHouse,
so `?ts=gte.2024-01-01` and a full timestamp both work — and an unparseable one
fails loudly rather than matching nothing, because an empty answer looks exactly
like a true one. A column that is `Array`, `Map` or `Tuple` is returned but not
filterable, and the endpoint's schema says so rather than leaving it to be found
in a 400. And `isnull` is only offered on a `Nullable` column, where it can
match something.

The endpoint's row cap is a **page size**: the most rows one response may carry,
not the most that exist. `limit` is clamped to it, `offset` walks past it, and
the answer says which page it is — `page` in the JSON envelope, and
`X-Flint-Limit`, `X-Flint-Offset`, `X-Flint-Returned`, `X-Flint-Has-More` and a
`Link: rel="next"` header for the formats that have no envelope. Those headers
are named in `Access-Control-Expose-Headers` too, because a browser on another
origin can only read the headers a server exposes, and for CSV and NDJSON they
*are* the paging. `?count=exact` adds a real total, and only when asked for: it
is a second pass over the same rows, and a caller walking a list should not pay
for one on every page. An author who wants a bounded extract writes the `LIMIT`
in the statement — the wrapper sits outside it, so no caller can page past it.

One thing offset paging cannot do for you: **a page is only stable if the rows
have an order.** Without one, ClickHouse is free to return them differently
between two queries, so page two can repeat a row from page one and never show
another. Pass `order`, or put an ORDER BY in the statement. Flint says this
where you page rather than leaving it to be discovered in a row count that never
adds up.

**And an order is still not enough, so there are cursors.** Offset paging counts,
and counting is the flaw: between page one and page two, rows are inserted and
merged, and page two is `LIMIT n OFFSET n` over a *different* result — a row
shifts across the boundary and is served twice, or shifts back and is never
served at all. On a table anyone is writing to that is the normal case, and it is
silent.

So every answer with an order carries a **cursor** — `page.cursor`, the
`X-Flint-Cursor` header, and the `Link` to the next page, which uses it. A cursor
carries the ordering values of the last row it served, and the next page asks for
the rows strictly after them. Nothing before that point comes back and nothing
after it is skipped, whatever happened in between. Follow the `Link` and you are
paging by cursor without having thought about it.

It is opaque on purpose — not to hide anything, it is base64 of a small JSON
object — but because a caller who takes it apart will depend on its shape. The
one thing it checks is that the order it was made for is the order it is being
used with: a cursor from `?order=n.desc` replayed against `?order=city` points at
a row that order has never reached, and is refused rather than answered.

Three places where the obvious version would be wrong, and is not:

- The predicate is written out — `(n < x) OR (n = x AND city > y)` — rather than
  as the tuple comparison `(n, city) < (x, y)`, because a tuple only says the
  right thing when every column runs the same way, and an order with a `.desc` in
  it does not.
- A cursor over a **nullable** column is refused by name. A comparison against
  null is neither true nor false, so a keyset over one silently drops every row
  it should have found. Where the order has one, Flint issues no cursor, says why
  in `page.cursor_note`, and pages by offset instead.
- An ordering column comes back even when `?select=` did not ask for it — a
  cursor is made of those values — and is then dropped from the answer, because
  `?select=city` that also returned `n` would be answering a question nobody
  asked. `DateTime64` is parsed at the precision it is stored at, too: the
  second-resolution parser would truncate the cursor and skip every other row
  inside that second.

Flint reads `token`, `format`, `limit`, `offset`, `order`, `select` and `count`
for itself, and a statement that declares a parameter of one of those names
takes it back: publishing `LIMIT {limit:UInt32}` is a reasonable thing to have
done, and stealing `limit` from such an endpoint would break the callers it
already has. The endpoint's schema lists which names it took.

**Every endpoint documents itself.** `GET /api/data/<address>/schema`, behind
the same token as the data, answers with the parameters it needs and their
types, the columns it returns and the operators each one takes, the page it
serves, and the formats it speaks. It deliberately leaves out the statement: a
public endpoint's address is not an invitation to read the SQL behind it. For
the same reason a ClickHouse error is trimmed to the sentence that says what
went wrong — ClickHouse quotes the failing query back in most of them, and a
caller who can make an endpoint fail on demand could otherwise read it.

And `GET /api/data/<address>/openapi.json` answers the same facts as an OpenAPI
3.1 document — with `GET /api/published/openapi.json` for all of them at once,
guarded the way the endpoint list already is, because no single token can speak
for every endpoint — generated from the statement on every request rather than kept
anywhere — enough for Swagger UI, Postman or a client generator to read the
endpoint without anyone writing the document by hand. It is honest about two
things an obvious mapping would get wrong: a 64-bit integer is documented as a
*string*, because Flint asks ClickHouse to quote them so a JSON reader cannot
silently round an id above 2^53; and a `DateTime` is a string with an example
rather than `format: date-time`, because ClickHouse writes `2023-11-14 22:13:20`
and a validator told otherwise would reject every row.

The APIs page shows all of it, read from that schema rather than from anything
the page knows, beside a builder that writes the URL and then actually fetches
it — the same request, the same token, the same headers an outside caller gets.
And it hands the call over in whatever form you are going to use it: curl,
Python, JavaScript, or a spreadsheet cell. The Python and JavaScript ones page by
*following the link* rather than by counting, because a caller who writes
`offset += 100` by hand is the caller the whole cursor apparatus exists to spare.

The spreadsheet one is the exception, and it is not one made quietly. A
spreadsheet cannot send a header, so `=IMPORTDATA(...)` is the single place where
Flint puts a token in a URL — and the page says, next to the cell it just wrote,
that the token lands in the spreadsheet's own logs and in anyone's screen share
of it. Make the endpoint public, or accept that.

Each endpoint carries a 256-bit token unless someone deliberately makes it
public; the token is accepted as an `X-Flint-Token` header, a Bearer
authorization, or a query parameter, and the example Flint shows you uses the
header, because a token in a URL ends up in logs and shell history. It survives
an edit, so renaming an endpoint does not break every caller. A paused endpoint
answers exactly as one that never existed: whether a given address is switched
off is not a caller's business.

**And which endpoints anyone actually calls.** Every published call is stamped
with its own `log_comment`, so the list can say "8 calls in 7 days, last one an
hour ago" or "not called in the last 7 days" — read out of `system.query_log`
rather than out of a log of Flint's own, because a second write on every API
request would be a real cost for an answer the log already holds. Published
calls stay in the diagnostics, where they belong: they are real workload, unlike
Flint's own introspection.

Three states, kept apart: called, not called, and *cannot tell*. Where
`system.query_log` is unreadable the row says so instead of showing zero calls,
because "nobody uses this" is a conclusion somebody might delete an endpoint
over.

**Flint has no login of its own.** Anyone who can reach the port can already run
any statement through `/api/query`, so publishing does not widen that — but a
published URL has a much longer life than a session, and "public" here means
public to the whole network Flint is on. The page says so where you choose it.

**Query history.** Recent statements from `system.query_log` with what each one
cost, one click from being loaded back into the editor. Where the log is
disabled or ungranted, the panel says which.

**EXPLAIN, five ways.** The plan, the pipeline, the estimate, the query as
ClickHouse rewrote it, the analyzer tree. The plan asks for `indexes = 1`, which
is the answer generic tools cannot give you — how many parts and granules the
primary key, partition and min-max indexes actually pruned.

**Formatting by the server.** `Format` calls ClickHouse's own `formatQuery`,
which knows the whole grammar, and falls back to a local clause-splitter only
where that function does not exist yet.

**Settings, visible.** What Flint attaches to every statement, beside the
server's own non-default settings — so the numbers in the stats strip are
explainable rather than mysterious.

**Row cap that tells you.** Results stop at `FLINT_MAX_RESULT_ROWS`, so a
`SELECT *` on a billion-row table returns a usable preview instead of an
error, and the stats strip says the result was truncated.

**Linkable views.** The tab you are on is in the URL, so
`/db/analytics/events?tab=partitions` is a link you can send to someone.

**Light and dark.** Light by default, following the system preference, with a
toggle that sticks. Both themes clear WCAG AA contrast on every text/background
pair in the app.

## Configuration

Every option is a flag or an environment variable. `flint --help` lists them.

| Variable | Default | What it does |
| --- | --- | --- |
| `FLINT_HOST` | `0.0.0.0` | Bind address |
| `FLINT_PORT` | `8080` | Bind port |
| `FLINT_CLICKHOUSE_URL` | `http://localhost:8123` | ClickHouse HTTP endpoint |
| `FLINT_CLICKHOUSE_USER` | `default` | ClickHouse user |
| `FLINT_CLICKHOUSE_PASSWORD` | *empty* | ClickHouse password |
| `FLINT_CLICKHOUSE_DATABASE` | `default` | Database the editor starts in |
| `FLINT_READONLY` | `false` | Send `readonly=2`: writes are refused |
| `FLINT_MAX_RESULT_ROWS` | `10000` | Row cap per query |
| `FLINT_QUERY_TIMEOUT_SECS` | `120` | Server-side query timeout |
| `FLINT_WORKSPACE_DATABASE` | — | Where Flint may keep its own metadata. Unset = stateless |
| `FLINT_CLICKHOUSE_CA_CERT` | — | PEM bundle for a private CA |
| `FLINT_CORS_ORIGIN` | — | Extra allowed origin (dev only) |
| `FLINT_LOG` | `flint=info` | `tracing` filter |

### Grants

Flint reads `system.databases`, `system.tables`, `system.columns`,
`system.parts`, and — where they exist — `system.projections` and
`system.query_log`. A user with `SELECT` on those plus the data you want to
explore is enough. Nothing is required beyond `SELECT`.

Set `FLINT_READONLY=true` to have Flint send `readonly=2` on every statement,
so the server rejects writes even if the credentials could perform them.

## Develop

Everything in containers, hot reload on both sides, against a throwaway
ClickHouse seeded with `contrib/demo-schema.sql`:

```bash
docker compose -f docker-compose.dev.yml up --build
```

Open <http://localhost:5173>. The demo schema is one raw table feeding three
materialized views into three rollup tables, plus plain views and a
cross-database dictionary — enough to exercise every edge the schema diagram
knows how to draw. ClickHouse is on `:8123` (user `default`, password `flint`)
and the API on `:8080` if you want to hit either directly.

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
```

To build the way the container does — frontend embedded in the binary:

```bash
cd frontend && pnpm build && cd ..
cargo build --release   # ./target/release/flint serves everything
```

## Design

Flint shares [Dashfile](../dashfile)'s design language, and its token names are
the contract between them: a warm neutral ground, white surfaces, one teal for
everything interactive, and a categorical palette tuned to stay separable for
colour-blind readers. Plus Jakarta Sans speaks for the interface; JetBrains Mono
speaks for the data — identifiers, types, values, SQL, everywhere the characters
themselves are the content.

Four shapes carry the object kinds, in the rail, the diagram and the tables
alike: a square is a table, a diamond a materialized view, a ring a view, a disc
a dictionary. The teal is deliberately absent from that set — it belongs to
interaction, and a diagram where every table is the hover colour says nothing.

One thing moves on its own: data travelling along the schema's edges. A
materialized view really is a live pipeline, so the diagram shows it as one.
Everything else animates only in answer to a pointer, and all of it stops under
`prefers-reduced-motion`.

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
check is worse than no check. It needs a workspace; it needs nothing else.

Its bug class is the one a status code cannot show. `smoke.sh` asks whether a
route answers; this asks whether the answer is *right*, which for the half of
Flint that other people's scripts depend on is the only question. A filter that
silently returns the unfiltered table is a 200. So is a cursor that skips every
third row, a date that matched nothing because it failed to parse, and an error
that quotes the published statement back to whoever triggered it. The wrapper,
the bindings and the ordering all have to reach a real ClickHouse to mean
anything, so the check walks all 500 rows of a paged result and counts them.

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

## Not built yet

Every feature in the brief is now built at least once. What is missing inside
them: alerts and reports deliver to webhooks only — no email, which would mean
SMTP configuration and a queue, and no per-recipient routing. A report cannot yet be built from a
saved query, only from a dashboard or from the editor. A published endpoint
accepts a statement that writes, and ClickHouse
refuses it at call time rather than Flint refusing it at save time — judging that
here would mean a SQL parser that would also reject legitimate statements.
Traffic on the diagram
is per object, not per edge: an edge here is a dependency rather than a call, and
Kiali's edge thickness measures requests between services, which is not a thing
this graph has. Dashboard tiles are reordered with buttons and a width control
rather than by dragging.

Replication is read-only, and two of its verdicts have been exercised against a
live server while three have not. A healthy replica and one with its Keeper
connection cut were both tested — the second is where the fifty-six-year delay
came from. *Behind*, *a replica is missing* and *lost parts* rest on unit tests
and on what `system.replicas` documents, because reproducing them needs a
multi-node cluster with one node held down. Nothing here can repair a replica
either: `SYSTEM RESTORE REPLICA` and `SYSTEM RESTART REPLICA` are recoveries with
consequences, and a button is the wrong shape for them.

See the project brief for where this is going.
