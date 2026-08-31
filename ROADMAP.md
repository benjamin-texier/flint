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

**Built.** The bar names the space before it names the page, `lib/spaces` holds
the membership rule — a page is Infrastructure because it lives under `/infra`,
and nothing else — and the old single `Diagnose` page is now two: Data keeps what
the statements cost, Infrastructure took the server's own condition. The object
rail is Data's navigator and does not follow you across. Of Infrastructure's
eight sections, seven exist: Health, Pipelines, Clusters, Schema, Backups,
Access, Config — and Audit. Versions is the one still absent from the nav, and
absent means absent until it is real.

Each space's name now opens that space's own board. `/infra` answers "is
anything wrong"; `Data` answers "what does this workspace answer" — the saved
statements, where each is running, what the endpoints served, and anything
unhappy — at `/home`. Neither is the busiest page in its half: Health is the
right page for working on a server and the wrong one for finding out whether you
need to, and a database is the right page for reading rows and the wrong one for
finding out what has already been built on them. The tree above has no `Home` in
it because the brief did not ask for one; the asymmetry is what asked for it,
Infrastructure having had a board since `/infra` stopped redirecting to Health.
It is one of the five Data sections that need a workspace, so a stateless Flint
has neither the section nor the promise of it: `Data` opens the schema there, the
way it always did.

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

Two variables, answering two different questions. Both **shipped**.

`FLINT_INFRASTRUCTURE` decides whether the space *exists*:

- Off removes it entirely — no navigation entry, no route, and its code is
  never fetched. Absent means absent, not a disabled control with a tooltip
  explaining what you may not do. An analytics team turns it off and never
  learns the other half is there.
- On by default, because everything the space shows today is a read of
  `system.*` — which is why this is a decision about *audience*, and not the
  same decision as the one below. An earlier draft of this roadmap derived the
  space's visibility from the write tier, which would have taken today's
  storage, pipelines, replication and access views away from every read-only
  deployment that already has them.

`FLINT_TIER` decides what may be *done*:

| tier | what it permits |
| --- | --- |
| `read` | reads only — `readonly=2` on every statement |
| `data` | rows may be written: insert, import, truncate, mutate |
| `ddl` | structure may be written where nothing is destroyed: create, alter, rename, detach, freeze, optimize |
| `admin` | the server may be operated, **and data may be destroyed**: `SYSTEM`, access, backups, truncate, drop |

The line between the last two is **data loss**, and it is not the line this table
first drew. That one said "structure is `ddl`, the server is `admin`" and put
`DROP TABLE` beside `CREATE`. It did not survive contact with the work: a
deployment that wants people reshaping schemas without being able to delete data
is a real deployment, and the first line could not express it. So creating,
renaming and altering sit at `ddl`; truncating, dropping a partition, deleting a
detached part and dropping a table sit at `admin`.

Unset it follows `FLINT_READONLY`, so every deployment that predates the tier
behaves exactly as it did. Today it gates nothing beyond what is already built:
it is the contract the phases below are written against, in place early so that
each action can be added behind a notch that already exists rather than
inventing one when the first `DROP` arrives.

Two rules attach to it:

- The tier is set in the manifest, by whoever deploys, never in the UI by
  whoever is signed in: a permission a user can grant themselves is not a
  permission. A manifest that asks for both `FLINT_READONLY=true` and a writing
  tier is refused at boot rather than resolved quietly in one direction.
- An action that writes will **require `FLINT_WORKSPACE_DATABASE`** when it
  lands — a write Flint cannot record is a write nobody can reconstruct
  afterwards. Not enforced yet, because no such action exists yet, and
  enforcing it now would only lock people out of read-only pages.

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

### A0. The four readings of a database — **built**

One database, four pictures, because each answers something the other three
structurally cannot. `Flow` is the declared graph: who feeds whom, permanent,
with no time in it. `Time` is the partition grid: the same tables against the
partitions they hold, which is where a TTL's cut-off, a backfill and a failed
ingest live. `Mass` is the treemap: where the disk is, down to the column, which
the diagram cannot say because it draws a three-terabyte table and a four-row
lookup as the same rectangle. `Together` is the co-access matrix: which tables
turn up in one statement, read out of `system.query_log` — the only one of the
four that comes from what people did rather than from what the database is.

Modes of one section rather than four screens, and each one a link
(`?view=time|mass|together`), because a particular way of looking at a database
is something people send to each other.

What is deliberately left for later:

- **The scale is built** — day, week, month, quarter or year per column, folded
  by the server, on the range the parts carry rather than on the partition's
  name; and the window's width follows the grain, so a page of columns is a
  period somebody can name — and the axis is continuous, so a stretch with
  nothing written in it is a run of empty columns rather than nothing at all.
  Each row also carries a sparkline of its own shape, which is the glance a row
  of squares makes you read across for. And the grid is drawn at server scope on
  the server page — a database where a table was — so "which of my forty
  databases is growing" is answerable. `Mass` and `Together` are not: a treemap
  of every column on the server would be a hundred thousand rectangles, and
  co-access across databases is already in the matrix wherever a statement
  crossed a boundary. Neither is obviously worth its own view, which is why
  neither is built.
- **`Together` sees pairs, not shapes.** A statement joining four tables becomes
  six pairs, and the fact that they arrived as one four-way join is lost. The
  matrix is right for "which two", and finding the *groups* — the four tables
  that always appear as a set — is a clustering problem worth its own page
  rather than a second reading of this one.
- **Nothing here is per-user.** `system.query_log` carries the user, and "which
  tables does this team read" is a question the same data answers. It belongs
  with access rather than with the schema, so it is B6's, not this section's.

### A0b. Query and Build become one page — **built**

They were two nav entries, two routes and two components, and they were never
two products: the same database, the same connection, the same Run, the same
results grid, the same charts. Only the surface you composed on differed. The
cost of that split was not the duplicated shell — it was that every affordance
had to be built twice, so half of them only ever got built once. The form had no
chart, no download, no history, no handoff to an alert; the editor had no way to
ask a question without knowing the language.

So it is one page with a switch on it, and the switch belongs to the **tab**
rather than to the page. A global mode would have one form and one statement for
eight tabs; a tab carries its own, so four tabs can be four forms, four
statements, or any mix.

Everything below the composing band is now literally the same code in both
faces: one stats strip, one result view, one download, one set of panels, one
`⌘↵`. Two things had to be built to make that true rather than approximately
true —

- **The dataset API takes a `query_id`.** It is what `KILL QUERY` matches on, so
  Stop works on a question asked through the form. Without it "the same
  features" would have quietly meant "the same features except cancelling".
- **The grid writes back into the form.** A header click, a cell filter and a
  dropped column rewrite the *spec* in form mode and the *text* in SQL mode, and
  the grid does not know which. The form knows one thing the text does not: a
  filter on a total belongs after the grouping, so it lands in HAVING by itself.
  Where the form cannot express a gesture it says why — `ts_day` cannot be
  filtered, because it is `ts` folded by day and a filter runs before the fold.

**The asymmetry is stated on the control.** A form always becomes SQL; SQL
becomes a form again only while it is still the statement the form wrote.
Nothing parses SQL back into a spec, and a switch that pretended otherwise would
be the mode switch that eats your work. The disabled side carries the reason, and
the form is kept on the tab, so undoing the edit opens the way back.

`/build` still resolves, to `/query?mode=build`. It is in bookmarks and in links
people sent each other, and a merge is not a reason to break them.

Two defects fell out of doing this and were fixed rather than noted: `asResult`
had been cast to a `QueryResult` it was not (no `kind`, no `summary`), which the
shared stats strip would have thrown on; and a line chart drew its points in row
order, so an unordered `GROUP BY` over a time column came back as a scribble
instead of a shape.

### A0d. A console, on every page — **built**

The query page is where you go to write a statement. It is not where you go to
*check* one — and checking one is what people were doing when they left a table
page, opened a tab, typed `SELECT count() FROM …`, read one number and came
back. The page was never the problem; leaving was.

So there is a prompt on the connection Flint already holds, on every page, at
the bottom left. It slides up, and you hide it rather than close it: the
component is mounted outside the router and never torn down, so the transcript,
the half-written statement and a query still in flight survive walking from a
table to a dashboard to the cluster page. A statement left running reaches you
as a pulse on the launcher, wherever you have got to. `Ctrl+\`` opens and hides
it; the shell reserves exactly its height, so nothing on a page ends up
underneath it.

It borrows `clickhouse-client`'s shape — the box rules, `12 rows in set · 3 ms`,
`use`, `SET` — because that is what anybody reaching for a prompt already reads.
It is not a terminal and is not called one: no shell, no PTY, no filesystem.
Being a web view rather than an emulator is what makes the rest work — the
completion is the editor's own, and selection, copy and paste are the browser's.

**It does not cross the line.** The Roadmap's one rule is about *pages*, and
this is not a page; it is the connection, exposed. What it may do is what the
account you signed in as may do, which is the answer the product already gives
everywhere else — and a more honest one than hiding the prompt in half the app
while every statement Flint runs on your behalf goes through anyway.

Three things came out of building it that were not about the console:

- `QUERY_WAS_CANCELLED` answered **408**, and Chrome retries a POST that gets
  one — so Stop killed the query and the browser silently ran it again for the
  whole `max_execution_time`. The editor's Cancel had this too, and nothing had
  noticed. Four tests in `src/error.rs` now say no status may be 408.
- `SET` over ClickHouse's HTTP interface reports `Ok.` and changes nothing,
  because there is no session to hold it. The console carries the settings
  itself, refuses the names Flint attaches (from a list the server publishes),
  and names them when a statement fails while carrying any.
- The browser check had no way to reach any of it, so it grew one: `--only
  console` opens the drawer, prints every kind of cell, folds and unfolds an
  error, and checks that hiding it returns the focus and leaves nothing in the
  tab order.

### A0e. A board answers before it is asked — **built**

Every page in Flint answered a question the reader arrived with. Opening it,
nobody has one yet — the first question is *is anything different today*, and
until now the four measurements that answer it each lived on the page you had to
already suspect. `/home` inventoried what Flint keeps; `/infra` answered whether
anything is wrong; neither said what *changed*.

So each board opens with a band of headlines. Nothing in it is a new capability:
`diagnostics.rs` was already reading what statements cost and what failed,
`meta.rs` what was reshaped, and `part_log` what was written. What was missing
was the synthesis, and the synthesis is the product.

`src/clickhouse/news.rs` measures and `frontend/src/lib/news.ts` judges — the
split `drift.ts` and `review.ts` already follow, and the reason the thresholds
are arguable in a test file rather than buried in a SQL string.

Four decisions came out of building it, each measured before it was written:

- **The baseline is the week, not yesterday.** The span is cut into seven equal
  periods and the newest judged against the median of the six behind it. A
  before-and-after pair reads every Monday as a collapse of Sunday, and it
  cannot tell a daily ingest that stopped from a seed load that was never going
  to repeat. That second case is not hypothetical: on a development server the
  first draft called nine freshly-seeded tables dead pipelines.
- **A median above zero is itself the regularity test.** For one, more than half
  the periods must have had something in them — so "written most days and took
  nothing today" needs no second check, and a table loaded once six days ago
  never qualifies. This is the rule that makes the silently-stopped ingest
  reportable at all, and it is the headline nothing else in Flint would give:
  the table keeps serving reads, so the first symptom is normally somebody
  asking why last week's number has not moved.
- **A period the log does not wholly cover is unknown, not empty.** Averaging
  those in as zeros manufactures a decline out of a retention limit. So the
  prior periods travel as a fixed-length array indexed by period rather than a
  packed one — a `groupArray` would have been shorter to write and would have
  lost the only thing that makes the array usable, which period each figure came
  from. Below three covered periods the band states why it cannot judge.
- **A multiplier its baseline cannot carry is not printed.** An error code seen
  366, 109, 1, 2 and 0 times over five days has a median of 2, and 1,141 of them
  today came out as **571×** — every step correct, the sentence nonsense. Past
  twenty it says *far more* and the figures beside it hold the truth. Same rule
  as dropping an absent figure rather than dashing it.

**It crosses no line.** The band is filed by destination, exactly as
`attention.ts` files a concern: a statement's cost and a table that stopped
taking rows are Data's, a reshaped object is Infrastructure's. That leaves the
split lopsided — structure is the only kind that lands under `/infra` — and the
lopsidedness is right, because a dead ingest is a fact about the data whatever
it took an operator to cause. It is also why the band leads on Data's board and
speaks even when it has nothing to report, while on Infrastructure's it is a row
gained when the schema moved and silence otherwise: `/infra` already opens with
a verdict, and a second empty panel under it would be the same answer twice.

**It needs no workspace**, which is why it sits above `/home`'s workspace gate.
Everything else on that page is what Flint *keeps*; this is a read of
`system.*`, and it answers the same on a stateless Flint as on a pinned one.
Flint's own traffic is excluded by the `log_comment` tag, and so is the
workspace database — measured first: on a development server the ten most recent
structure changes were all Flint's own migrations.

What is deliberately left for later: nothing here is per-user, the window is
fixed at 24 hours rather than chosen, and a headline cannot be dismissed. All
three are the same kind of feature — state about a reader — and Flint has
nowhere to put reader state that is not the workspace, which this section
pointedly does not require.

### A0c. An object's path is drawn, not listed — **built**

The Path tab was a chain of rows, one hop each, on the argument that a chain is
honest about depth in a way a picture is not. Half of that was right, and the
other half showed: on the overwhelmingly common shape — one hop down to one view
— the tab was four words and a pill in a screenful of nothing.

So the path is drawn by the schema canvas, given the objects `lineageSubgraph`
picks out. It is the same function the database page's own "whole path through…"
uses, so the two cannot disagree about what a path is, and it is the same canvas,
so there is no second diagram in the product with a second set of manners. The
depth survives where it was always the strongest — in the caption, beside the
count of what was kept — and the canvas gained a `here` marker, because on eleven
boxes the caption naming one is not enough to find it in.

### A1. The Explorer finishes its write half

Insert by form, built from the column types `chType.ts` and the profile already
read: defaults, `Nullable`, enums as a list rather than free text.

Import a file — CSV, JSONEachRow, Parquet — with the schema inferred by
`DESCRIBE file()`, the mapping and a sample of parsed rows shown *before*
anything is written, and rows accepted and rows rejected counted separately.
This is the feature that gets a browser tab used instead of `clickhouse-client`.

~~Export a table or a result as CSV, JSONL or Parquet in one click.~~ **Built**
for a result — the editor's result bar carries the three formats, ClickHouse
writes the bytes, and the download is uncapped and streamed rather than
buffered anywhere. Two things it settled that are worth keeping:

- **A file cannot say what it left out.** So the cap comes off and the honesty
  moves to before the click. The control does *not* name a total, because a
  truncated page has none to give — `rows_before_limit_at_least` is null and
  `rows_read` counts only what the server read before it stopped. Naming either
  would be a figure nobody could reconcile.
- **A form, not `fetch`.** A form submission is a navigation, so the browser
  streams to disk with its own progress and cancel; `fetch` would hold the file
  in the tab. Measured at 1.1 GB: the file grows on disk while the query is
  still running. The session rides in the `SameSite=Lax` cookie, which closes
  the CSRF shape a form route would otherwise open.

**And on a table** — built, where the count often *is* known, so the control
names it: "Downloads all 3,780 rows, not only the 200 shown." It keeps the
columns and filters the reader chose and drops the preview's `LIMIT`, because
"give me this table" that hands back two hundred rows is the truncation the
whole feature exists to avoid — and it says so in every wording.

The figure is withdrawn the moment it stops being known: a `WHERE` makes the
count something ClickHouse would have to count, and Flint will not run a second
pass over a table to decorate a button. That case, and the case of an object
that keeps no count at all, both fall back to naming no figure.

**Every place Flint shows rows now offers the file, except two — and both
exceptions are reasoned rather than pending.** The editor, a table's preview and
a dashboard tile all carry the three formats.

- **The Builder does not**, because the dataset API is paged by construction:
  every statement it renders carries a row cap, and asking for none still
  yields `LIMIT 10001`. A download built from it handed over 501 rows of a
  3,780-row table under the words "the whole result" — measured, and removed.
  The route out is already on the page: *Take to the editor*, where the
  statement is the caller's own and the download is uncapped. Making it work
  in place means teaching the dataset API to render for a **download** rather
  than for a page — a change to `into_asked` and to the row-cap floor, which is
  load-bearing, not a flag to add in passing.
- **A report snapshot does not**, because it is a record of what was true at
  nine on Monday. A download re-runs a statement, so a button there would hand
  over what is true now under Monday's heading. Writing the CSV in the browser
  instead would give Flint a second CSV dialect to keep in step with
  ClickHouse's, which `src/export.rs` exists to prevent. Serving the kept rows
  back through the server is the shape that would work; it is not built.

It cost one real bug to get right, and it is the bug this file's rules are
written against. A view sends `total_rows: null` **and `parts_rows: 0`**, and
`0` means "no parts", not "no rows" — so `??` walked past the null, landed on
the zero, and put *"Downloads all 0 rows"* under a view holding 3,780. A
promise of an empty file is worse than no promise. The gate is now `stores`,
the same question the tab list asks, so the two cannot drift.

**Not** inline cell editing. ClickHouse has no cell edit: an
`ALTER TABLE ... UPDATE` is an asynchronous rewrite and a lightweight `DELETE` is
a mask that still costs a merge. A pencil icon would lie about what the click
does. "Update these rows" and "delete these rows" are jobs instead — the `WHERE`
previewed with the count it matches, progress against `system.mutations`, and a
plain refusal where the predicate does not narrow to a partition. Same rule as
dropping an absent figure rather than dashing it.

### A2. Dashboards grow the controls a dashboard needs — **built**

**A time range every tile can honour.** `DashboardSpec` carries `rangeHours`, and
a tile follows it by declaring `{from:DateTime}` and `{to:DateTime}` — the
binding ClickHouse already gives it, and the one the rest of Flint uses
everywhere.

A convention rather than a rewrite, and that was the decision. The alternative is
Flint finding each tile's time column and injecting a `WHERE`, which means
parsing SQL — something this codebase deliberately does not do, and which would
be wrong on the first statement with a subquery in it. So a tile says whether it
wants the window, and the dashboard **says how far the window reaches**: "Last 30
days — followed by 1 of 3 tiles. The other 2 do not declare {from:DateTime}, so
they read whatever their own statement says." A control that moves a third of a
dashboard and stays silent about the rest is a control nobody can trust.

Three smaller things it settled:

- **The window is computed at the moment of asking**, not when the range is
  chosen. A dashboard is a thing left open on a wall: "the last seven days" is
  still true tomorrow, and a `from` frozen at 14:29 quietly becomes an absolute
  range. The query key carries the *choice* so changing it refetches; the values
  come from the clock.
- **Only relative windows, for now.** An absolute pair needs its own controls,
  and leaving it out is a smaller lie than a date picker that means "seven days
  from whenever you set it".
- **`POST /query` learned to carry bound values.** Unvetted on purpose and safe
  for the reason the whole product binds this way: ClickHouse quotes a parameter
  as a literal of the type the *statement* declared, so a value cannot become
  syntax. It grants a caller on that route nothing new — they are sending the
  statement too. That is not true of the published endpoints, which is why those
  declare their parameters and check them.

**Variables**, which are the same mechanism with the names read off the
statements instead of fixed. Every `{name:Type}` the tiles declare, apart from
the two the range owns, gets a control; a tile is sent only what it asked for.
Collected from the SQL rather than declared beside it, for the reason the page
index is read from the page: a list maintained by hand drifts, and here the drift
is silent until a tile fails.

Two things it has to say, and both were produced against a real server before
they were written.

- **An unset parameter is not an empty tile.** ClickHouse answers `Substitution
  'city' is not set (UNKNOWN_QUERY_PARAMETER)`, so the reader gets a red box
  where they expected data and no way to guess that a text field three inches up
  would fix it. The page says which variables have no value and how many tiles
  each one takes down.
- **One value, two types, and half the dashboard breaks.** `{n:String}` accepts
  `eu-west` while `{n:UInt8}` in the tile beside it answers *Value eu-west cannot
  be parsed as UInt8*. A name declared as two types by two tiles is named as a
  conflict rather than left to be discovered one tile at a time.

Building it surfaced a race in the save path that had been there all along and
could not show until now: `onSuccess` dropped the draft *before* the refetch
landed, so `spec` fell back to the cached dashboard — the version without the
change just saved — and every tile re-keyed to the old bindings and asked again
with them. Invisible while the only controls were refresh and width, because
neither changes what a tile asks for. The invalidation is awaited now.

**Full screen**, which is a browser API and two decisions. Everything that
*changes* the dashboard goes — nobody edits a wall, and a stray click on a screen
behind a desk is a dashboard somebody else has to put back — while the range and
the variables stay, readable and not editable, because a chart of "the last 7
days" that does not say so is a chart of nothing in particular.

Both decisions were measured first.

- **The screen lock is missing on the deployment that needs it.**
  `navigator.wakeLock` wants a secure context. Over `http://127.0.0.1` it is
  present and granted; over `http://10.0.8.10` — a Flint on a LAN address, which
  is exactly how a wall display is served — it is `undefined` and reaching for it
  throws a `TypeError`. So it is asked for where it exists, never promised, and
  where it will not hold the wall says *why*: an insecure context, not an old
  browser, because the second sends somebody to install the wrong thing.
- **The browser owns the exit.** Escape leaves full screen without going near a
  click handler, so the state follows `fullscreenchange` rather than whatever the
  button last did. A page that thinks it is still on the wall is a page with its
  chrome missing and no way to get it back — which is what the check now
  exercises, by leaving full screen from outside the button.

One CSS trap on the way, the same one a `:first-child` had already sprung
earlier: `:first-of-type` counts *per element type*, so a rule meant to keep the
exit button also kept the first `<a class="btn">` beside it and the link to the
reports page stayed on the wall. Named, not positional.

**Drag-to-arrange is there now**, and it is an addition to the two arrow
buttons rather than a replacement for them. The framing this section used to
carry — "instead of the width control and the reorder buttons" — was wrong as
stated: those buttons are the keyboard path and dragging is not, so taking them
out for a grip would have landed the feature as an accessibility regression.
They are still there, still three per tile.

Three things it settled:

- **The grip starts the drag, not the card.** `draggable` is set on the tile at
  the moment the grip is pressed and cleared on drop, rather than held in
  state — the browser reads that attribute when it decides whether a
  `pointerdown` begins a drag, and a React state change is not guaranteed to
  have rendered by then. Doing it from the grip is also what keeps a tile's own
  table selectable and scrollable while the dashboard is being arranged; a card
  that is draggable everywhere turns a scroll gesture inside a tile into a
  reorder.
- **Both paths now speak, and neither did before.** A tile moved in silence is
  legible only to somebody who can see it move, and that was as true of the
  arrows — shipped months ago — as of the drag. Both go through one `rearrange`
  that writes into a `role="status"` region: *"Moved Hourly volume to 1 of 3."*
  The drag is what made the omission visible; the fix is older than the drag.
- **One mover, not two.** The pointer path and the keyboard path both end in
  `moveTile`, whose doc comment had been promising a drag handler since the
  buttons were written. Two implementations of "move this tile there" is how
  the two paths come to disagree about what dropping on the last tile means.

Verified in a browser rather than in a test run, which is where the state
classes had to be looked at: mid-flight the carried tile reads `is-dragging`
and the tile it would displace reads `is-over`, and the drop reorders and
announces. The arrows were exercised in the same pass.

### A3. Analysis — **built**

The brief asks Flint to help users *understand* data, not only display it:
distributions, correlations, trends, outliers, missing data, cardinality, time
series, comparisons, quality checks. Select a table, get a useful analytical
overview without knowing which query you wanted.

The profile was the foundation and answers *what is in this table*. The two
layers above it are now there, and each is a tab that reads the rows rather than
the DDL — both on consent, because both read every row once.

**Relations — what one column says about another.** Constants, determinations,
mirrors, columns that move together, far values, a dominant value. The test is
`uniqExact(tuple(a)) = uniqExact(tuple(a, b))`, and the rule that turns it from
noise into findings was measured before it was written: a **near-key determines
everything and means nothing**. `process_time`, with 3,771 distinct values in
3,780 rows, "determines" every other column — trivially, because almost every row
is its own group.

**Over time — whether the table has started behaving differently.** The same
readings cut into periods on the table's own time column, the early part of the
window compared against the late part, and the answer given as sentences rather
than as charts: "`region` was 5.0% null and is now 100.0%, from 15 August" is
something somebody can look up in a deploy log; "drift detected on 1 column" is
not. Four things were measured first and each decided part of it.

- **The first and last periods are partial, nearly always.** `lab.traffic` opens
  51,741 / 86,400 / 126,941 rows and then sits at 172,800 for a month: the table
  began part-way through a day and today is still filling. A detector that reads
  those as a collapse and a recovery fires on every table there is. Both ends are
  held out of every comparison, and named, because "not counted" is a fact the
  reader is owed.
- **Flat is the common answer and it is a good one.** A fixture of 483,188 rows
  gave 5,664 rows a day, 5.88% nulls and 400 devices for eighty days. Twelve flat
  sparklines would imply an insight that is not there. The tab says nothing
  changed and stops.
- **A counter always drifts.** Found the way everything else here was — a fixture
  whose day counter reported "3 → 15" beside three real findings and read exactly
  like them. A column that rises at *every* period is a sequence, not a
  measurement; its level is not compared, and it is named rather than dropped,
  because "we did not look at `id`" and "`id` did not change" are different
  statements and only one of them is true. Strictly rising, because the shape of
  every real level change — flat, then a step — is non-decreasing too.
- **The server finds the gaps.** `ORDER BY … WITH FILL STEP toIntervalDay(1)`
  emits the periods with no rows, which `GROUP BY` alone silently omits and a
  chart drawn from it quietly closes over.

Cost, measured rather than assumed: 5,000,000 rows and 122 MB in **56 ms** for
six aggregates over 31 periods. So the bound is on the *window* — how many
periods — and never a row prefix, which would bias which periods were read.

Both halves follow the house split that `review` and `projection` set:
`drift.rs` **measures** and sends periods, rows, null shares, distinct counts and
averages with no opinion attached; `lib/drift.ts` **decides** which of those
movements is news and how to word it. It was written the wrong way round first —
the thresholds in Rust, on the model of `relations.rs` — and moving them cost
nothing and bought a great deal: the same four sentences came out of the same
fixture afterwards, and the rules went from five Rust assertions to thirty-five,
including the ones that are hard to stage against a live server. That a single
spike cannot manufacture a finding, that two points of a percentage are not news,
that a table which stopped a year ago reports one gap rather than three hundred,
that a period holding no rows is never averaged into a comparison.

Building the second one surfaced a bug in the first: **both tabs were reachable
only by typing the URL.** `TABS` had them, the router had them, the browser check
reached them by address — and the visible tab strip is a second list, which
nobody had added them to. No unit test and no route test can see that, which is
why the check now asserts the tab is in the strip and not merely that the address
resolves.

**Distribution — the shape of one column.** The profile gives five numbers per
column, and five numbers cannot tell an evenly spread column from two clusters,
or from one value and a rounding error. Opened from the profile row, one column
at a time, because each needs its own range before it can be binned. It also
gives A4 its histogram.

The measuring half chooses what to count, and every branch of that choice came
from a table rather than from a preference.

- **ClickHouse's own `histogram(n)` is the wrong tool.** It answers in 9 ms and
  returns *adaptive* bins: unequal widths and fractional heights —
  `(12, 208.08, 105473.75)` on a real column. Equal-width bars drawn from
  unequal-width bins misstate density, which is the one thing a histogram is
  for, and 105,473.75 is not a number of rows. Equal-width bins cost 15 ms over
  the same 482,212 rows and are exact.
- **A column with few distinct values is a tally, not a histogram.**
  `analytics.device_daily.events` holds six distinct values across a range twelve
  wide; binned into twelve, seven bins were empty *by construction* and the chart
  reported the binning rather than the data.
- **Empty buckets vanish from a `GROUP BY`.** That same column came back as five
  rows — bins 0, 1, 6, 7 and 11 — which drawn in order read as a smooth ramp. The
  truth is 42,000 rows at the top of the range and 800 scattered below it.

And two rules in the judging half that only real columns could have taught:

- **An identifier has no distribution.** `analytics.events.payload` holds 482,212
  distinct values in 482,212 rows, and its twelve most common are one row each.
  Twelve bars of height one is a chart that says nothing, and every shape rule
  would have had an opinion about it.
- **A `top` reading cannot see whether the tail is heavy.**
  `analytics.events.device_id` spreads evenly over 400 values, whose twelve most
  common are 3.0% of the rows — which is exactly 12/400. A power law over the
  same 400 draws the same twelve bars. Only the ratio between what the listed
  values hold and what they would hold if the column were flat tells the two
  apart, and the first version of the rule called the even one a long tail.

**Comparison — two tables, side by side.** A staging copy against production, a
`_v2` against the table it replaces. The answer is not a diff but a direction:
*can the right-hand table stand in for the left-hand one*, and if not, what is in
the way — each line naming one thing to fix, because "not a drop-in replacement"
is a verdict nobody can act on.

Three rules shape it, and the third was a bug before it was a rule.

- **A rename is a drop and an add, and says so.** Columns match by name because
  there is nothing else to match them by. Guessing that `client` became
  `customer`, from position or from type, would invent a correspondence the
  server cannot confirm.
- **Direction is the whole question.** `UInt32` to `UInt64` is safe and the
  reverse is not, and it is the same pair of types read the other way round. A
  widening that also drops the null is not a widening: the rows that were null
  have nowhere to go. And where the answer is not certain — `Int64` to `Float64`
  is exact to 2^53 and lossy above it — it says only that they differ, because
  calling it a widening would be a promise this cannot keep.
- **A column can change type *and* move.** The first version reported only the
  type, so a pair that swapped places while both were retyped never raised the
  positional warning at all — and a moved column breaks exactly one thing, which
  people write constantly: `INSERT INTO t VALUES (…)` without a column list.

`(id, at)` and `(at, id)` also get their own word. A sorting key that lists the
same columns in a different order is a different table to every query that
filters on one of them, and "the sorting key changed" leaves the reader to notice
that nothing was added or removed.

### A4. The visualisation set the brief describes — **the three are built**

`ChartKind` is `stat | line | area | bar | donut | heatmap | scatter`. The
**histogram** stays where it is, as part of A3's distribution rather than as
something to configure — a histogram is not a way of drawing a result set, it
is a question about a column, and the binning is the answer rather than an
option. Later: maps — which needs the geographic column role the exploration
heuristics do not yet detect — funnels, cohorts, anomaly charts.

Each of the three had one decision in it worth more than the drawing.

**Area is a stack, or it is nothing.** A single filled series is what `line`
already draws, so offering `area` for one measure would be the same picture
under a second name; it appears from two measures up. What a stack asserts is
then the whole point: **the top edge is the sum**, and the offer says so in the
picker rather than leaving it to be inferred. Flint cannot know whether the
measures are parts of anything — `avg(d), max(d)` stacks as readily as
`hits, misses` and the total means nothing — so it names the claim and lets the
reader see in a glance whether it holds.

The refusal that *can* be computed is computed. A negative has no place in a
stack: the top edge stops being the sum the moment a band descends. The picker
works from the shape of a result and never sees a value, so the check happens
where the values are, and the answer is a sentence rather than a drawing —
*"These measures go negative, and a stack cannot draw that."* ClickHouse
produces them readily, out of a `sum(delta)` or a difference between two counts.
A missing value is a third case and gets a third answer: its band pinches shut
and the edge above drops by exactly what is absent, because interpolating would
put a figure in the total the query never returned.

**A donut is withheld rather than annotated.** This is the form that fits Flint's
rules worst, and the resolution is the same one the rest of the product uses for
a fold it cannot honestly draw. A ring asserts that its slices are *everything*,
which is a claim almost no ClickHouse result can make: `ORDER BY c DESC LIMIT 10`
is complete as asked and is still the top ten of something larger. So the form is
offered on three conditions — six slices at most, a result Flint did not cut, a
label and one measure — and where any of them fails the same numbers are a bar,
which asserts nothing about a whole. The six is a refusal to offer the form and
not a cap on the slices, which is what keeps "say what was left out" satisfied:
nothing is left out, because nothing was drawn.

A donut and not a pie for one reason that is not taste: **the hole is where the
total goes**. A share with no total beside it cannot be checked against anything,
and a pie has nowhere to put that number.

And the label came off the band. Printing the share inside its own slice puts
type on a categorical hue, which this codebase forbids everywhere else because a
hue is illegible as text — and here it was measured failing outright: the surface
white it needs reaches 4.32:1 on the first slot and 4.10:1 on the fourth, against
the 4.5 that 10.5px demands. Outside the ring the label wears a text token and
the contrast is the page's, whatever colour the slice is.

**A heatmap scrolls rather than truncating a label.** Every other axis in the
chart file has a fixed band to fit its labels into and drops them all when they
do not all fit — the rule that stops thirty bars reading `segm…`. A grid has a
scroll container, so the room is there for the asking and the honest answer is to
give each label the length it needs.

Which made the sizing arithmetic load-bearing, and the first version of it was
wrong in the direction that clips. `textWidth` measures on a canvas, which cannot
be told about `font-variant-numeric: tabular-nums` — and these labels are dates
and identifiers, which is to say almost all figures, where tabular is the wider
of the two — and it answers with the fallback face where the webfont has not
loaded. Both errors run the same way. Measured in the browser before it was
fixed: all 25 column labels over the top edge by 8px and the last one 23px past
the right. The room is now the larger of what the canvas says and what the
character count implies at the pessimistic width the bar labels already use.

Its colour is sequential and not categorical, which is the one thing a grid
cannot get wrong: six hues across the cells would say they are six different
kinds of thing rather than one thing at six magnitudes. It is the same physics
as the partition grid and the co-access matrix — `barScale`'s 90th percentile
and the shared `CELL_FLOOR` — so a single outlying crossing does not wash the
grid out, and the cells past the scale are drawn full and *counted*. A crossing
the query never returned is an outline rather than the palest step of the ramp,
because the palest step is what a real zero wears and the two are different
answers.

**One shape it does not catch, said out loud.** `GROUP BY toHour(ts), host` is
the canonical heatmap and Flint does not offer a grid for it: `toHour` returns a
`UInt8`, and a bare integer is a measure here, not an axis. That follows from the
rule that classification reads the declared type and never the values, which is
what keeps a 64-bit integer arriving as a JSON string from being guessed at.
`toStartOfHour` and `toDate` are time and do get the grid. Relaxing it would mean
guessing which of two numbers is the aggregate, and this codebase does not guess.

**A stored tile survives all three.** `parseSpec`'s reader had the kinds written
out a second time, so a form it did not recognise fell through to `null` and the
tile came back as a table with no error anywhere saying a chart had been dropped
— the one failure nobody sees. It is keyed off `ChartKind` now, and the test
asserts every member of the union rather than the two that happened to be on
somebody's dashboard.

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

**A7 is where it gets named**, and it names it more usefully than a fifth stored
object would: a dataset is a table or a view, derived from what the caller may
read rather than declared anywhere. Do A7.1 and most of this is already done.

**A daily or weekly report now carries its own timezone** — built. It is the
axis a cron entry has and a `SET session_timezone` cannot supply: a schedule
belongs to the artefact, not to whoever last looked at it, so an answer that
changed with its reader was never an option. 
**Bucketing carries a zone too** — built, and it settled a question the
scheduling case did not have to answer: *whose* zone. It turns out to depend on
who wrote the question, and the two API surfaces come out opposite:

- **A published endpoint owns its zone.** It is a fixed address somebody else
  published, so its days belong to it. Two callers asking the same URL on the
  same afternoon have to be shown the same days, or "revenue on the 3rd" is a
  different figure depending on who is asking and neither of them can tell.
  The OpenAPI document states it — but only where the answer actually has a
  date in it, read off the described columns rather than carried as a second
  field that could drift from them.
- **A dataset request names its own.** That document is written fresh on every
  call, so "last 7 days, in my days" is a legitimate thing to ask. The answer
  says which zone it used whether or not one was asked for, because a result
  filed away for a month with no zone on it cannot be reconciled against
  anything. A zone on a query that draws no boundary is refused rather than
  ignored: a setting that silently does nothing is worse than one turned down.

The page and its `count=exact` total read in the same zone, and so does the
`DESCRIBE` behind the schema. Three statements in two zones is not a slower
answer, it is a different one.

**Alerts** stay out, and not by omission: they carry `interval_seconds` and
nothing else, so there is no wall clock to place and no column to add. If an
alert ever grows a time of day, it grows this field with it.

**Dashboards and saved queries get no field, and that is the answer** rather
than the work not being done. Their SQL is written by hand, so the zone is
already expressible *in the language*, visibly, in the place a reader looks:
`toStartOfDay(ts, 'Europe/Oslo')` gives exactly what the session setting gives,
and `toMonday` and `toStartOfMonth` take the argument too. A hidden per-artefact
setting on top of that would be strictly worse — the statement on screen would
say `toStartOfDay(ts)` while the answer meant something else, which is the very
defect the Builder's SQL panel had until it started printing its own
`SETTINGS session_timezone` line.

And the loop closes on its own. A question built with a zone is saved with that
line in its SQL, so it survives being stored, reopened in the editor, or dropped
into a tile — verified end to end: the saved query answers about Auckland's days
where the server would have cut 24/23/22.

What those surfaces did need was a **sentence, not a setting**. A dashboard
reader never sees a tile's SQL — only its chart and the database it came from —
so a bar per day was a bar per *somebody's* day with nothing on the page saying
whose. A dated tile now names its zone beside the database, on three rules:
the statement declares one, and that is it; the statement names a place
anywhere, and Flint says **nothing** rather than confidently printing the
server's; otherwise nothing overrode the session, and the server's zone is a
fact. The middle rule is the one worth having — and where it stays silent,
ClickHouse has already written the zone into the column's own type.

### A7. The Data API — one way in

The read side of the no-code APIs is built and documented, and two things about
it are wrong in the same way.

Publishing is per statement, so exposing fifteen tables is fifteen acts of
publication. And a published endpoint runs as the account in the manifest —
`GET /api/data/<slug>` is one of the deliberate exemptions from `Caller` — which
meant that for as long as Flint had an API, **no row policy had ever applied to a
call on it**, and `readonly=2` was doing all of the work alone.

`POST /api/data` (A7.3, below) is the first route where that is no longer true.
Both problems had the same answer, and it is one sentence:

> A **dataset** is a table or a view. The caller names one, describes the answer
> it wants, and ClickHouse decides whether it may have it.

Everything below follows from refusing to loosen that sentence.

**The first half now has a second answer, for the callers the dataset API
cannot serve.** `POST /api/data` needs an account, and A7.5 keeps the published
endpoint for exactly the case where there is none — a partner, a spreadsheet.
For those, `POST /api/published/tables` takes a database and a list and writes
one endpoint per table, each serving `SELECT * FROM t` with the shape layer over
it, sortable by the table's own sorting key and nothing else. Fifteen tables is
one act. It is not a loosening of the sentence above: a dataset is still a table
or a view, and this only decides *who may name one without an account*. The
per-statement form stays for the join and the aggregate, which this deliberately
cannot express.

#### A7.1 Datasets are derived, never declared — **built**

Every table and view the signed-in user may read is a dataset. There is no
registry, and there must never be one.

The alternative is what every semantic layer ends up maintaining: a hand-written
list of dataset names, and beside it a column inventory saying which column is a
time, which groups, which measures, and which aggregations each one accepts. It
is a real cost — a table added is a table nobody can query until someone edits
two files and ships.

Flint must not pay it, because it already holds every input. `meta.rs` reads
`system.columns`, `chType.ts` knows the type families, `profile.rs` has the
cardinality and the values, `graph.rs` infers the relations. The inventory is
**proposed** from those and confirmed by an author, not written from nothing.

The property to protect: a view the ops team adds shows up on its own, filtered
by grants like everything else. Nothing to declare, nowhere to register it. That
is the whole advantage, and every shortcut that adds a registry spends it.

`src/dataset/inventory.rs` is that computation, and `POST /api/data/schema`
publishes it — asked as the caller, because a `DESCRIBE` of a table somebody may
not read is still a read of its shape. Six kinds: `id`, `time`, `bool`, `text`,
`numeric`, `unsupported`, each carrying the operators it can be filtered with and
the aggregations it accepts.

**`id` is the kind that earns the module.** `meter_id` and `reading` are both
`UInt64` and only one has a meaningful average, so the name is consulted — the
one place any of this guesses, and it is kept narrow deliberately: a whole-word
`id` or a `_id`/`_uid`/`_uuid` ending, so `valid`, `pyramid` and `overbid` stay
quantities. Where the guess is wrong the column can still be filtered, grouped,
ordered and selected; only the arithmetic is withheld, because that is the one
operation whose wrong answer looks like a right one.

Two decisions worth keeping visible. A `Kind` says **what may be asked**, not
what a column means — so a `device_id` that is a `String` stays `text`, since
there is no arithmetic on a string to withhold and `like` on it is a real
question. And nothing is **hidden**: the noise columns a semantic layer usually
excludes (`created_at`, `owner_id`, `version`) are consumer policy, not a fact
about the data, and a Flint that dropped them would be answering for a consumer
it does not have. What cannot be measured is *counted* instead — "1 of 8 columns
holds many values at once" — which is the house rule about saying what was left
out, applied to a column list.

Still to come, and it is what the roadmap meant by *proposal*: an author
confirming or correcting a derived kind, which needs somewhere to keep the
correction. Until then the derivation stands on its own, which for a schema
whose names are ordinary is the right answer anyway.

#### A7.2 Joins are not in the DSL, and will not be

A query language that lets callers join is a query language that has to answer
for join order, for cardinality blowups, and for every table anyone can name
being reachable from every other. The arrangement that holds instead is to move
the join upstream: it lives in a view, versioned, owned by whoever owns the
schema. That is an Ops decision, and in Flint's tree it is B4 → Schema.

Closed for the same reason and named so nobody has to ask: `arrayJoin`, `FINAL`,
`PREWHERE`, `SAMPLE`, subqueries, CTEs, window functions. The DSL may narrow and
summarise what a dataset already returns, and nothing else. That is exactly the
argument `published/shape.rs` already makes for the query string, and it is what
makes the surface safe to open at all.

**Flint does not create views.** Where one is genuinely needed that is an
operational change, made by the people who own the schema; the most Flint should
do is write the `CREATE VIEW` out for someone to review. A tool that lets every
analyst mint a view produces a database nobody can account for six months later.

#### A7.3 The DSL travels in the body — **built**

`shape.rs` already had the vocabulary — a projection, twelve operators, orders,
limit and offset, a cursor, a count. What bounds it is the query string, not the
design: a nested boolean group, a long `IN` and a multi-column order do not fit
in a URL.

So `POST /api/data`, with the document in the body — `src/dataset.rs` for the
question, `src/routes/dataset.rs` for the handler. **The GET surface is
untouched**: `=IMPORTDATA(…)` cannot POST, and neither can a CDN cache, an
`<img>`, or a webhook's URL field.

Built: a dataset named as `database.table`, `select`, a filter **tree**,
`order`, `limit`/`offset`, cursor paging, `count`, and the three formats — all of
it rendered by `published::shape`, so the operators, the `DESCRIBE`-checked
identifiers and the bound values are one implementation serving both paths. It
takes `Caller`, so it runs as whoever asked.

The tree is the only new expressive power, and that was the point: everything
else the body carries, a query string could already say. What it adds is the
`OR` a URL has nowhere to put, and an `in` list far longer than a URL holds.
Nesting stops at eight groups and says so.

**Aggregation is built too.** `dimensions` and `metrics`, eight aggregations,
and the permission decided per column by A7.1's kinds rather than by what
ClickHouse would compile: `sum` over an identifier is refused by name, with the
list of what that column does take. Rendered by the same `wrap`, so there is
still one place where a statement is built and one set of guards on it.

Three things it settles rather than leaves open. `order` names what the *answer*
returns once aggregated, because `avg_temperature` is a column of nothing.
`count` counts **groups**, since that is what the page holds — and refuses on a
single-row answer instead of returning `1` as though it were a finding. And an
aggregated answer carries **no cursor**: its rows are computed rather than
stored, so there is nothing to resume from. That one was found by looking at a
real response — the first version happily emitted a cursor the next request would
have rejected, which is worse than offering none.

**The time object is built** — `src/dataset/time.rs`. Three windows (`last`,
`period`, `from`/`to`), six granularities, and the time column resolved from the
inventory where the dataset has exactly one. Two rules carry it: ***`last` rolls,
`period` aligns***, and **every window is half-open**, which is what stops a
caller who pages a month at a time from counting each boundary row twice.

The clock is ClickHouse's. `now()` is rendered into the statement rather than
resolved in Flint — the decision `workspace.rs` already made — so a sidecar with
a drifted clock cannot return a window that disagrees with `system.query_log`.

**Comparison is built too.** `compare` takes `previous_period` or
`previous_year`, and the second window is derived from the first rather than
described again — a calendar window moves by whole units of its own kind, a
rolling one by its own span. Two windows a caller wrote separately could drift
apart, and windows of different lengths make a difference that is not one.

One pass, not a `UNION`: both windows are read together and told apart by a
computed column, so the order, the page and the total are one answer. The
predicate is `(this) OR (that)`, which the primary index resolves as well as
either alone — comparing a month with the same month last year does not read the
eleven months between them.

Three refusals, each earning its place. A `from`/`to` window cannot be compared,
because its length is date arithmetic and that has been left to ClickHouse on
purpose. A comparison needs a metric, because two windows of raw rows is not a
comparison. And a rolling window bucketed by day genuinely puts one calendar day
in both windows — documented rather than papered over, because the alternative is
quietly changing what `last` means.

Two things this cost, both found by running it rather than reading it, and both
written up in the code where they were fixed. Ordering an aggregated answer now
names the **expression** behind a name, never the alias: an alias shadows a
source column of the same name, and `ORDER BY ts` was resolving to the raw
column, which is not in the `GROUP BY`. And the bucket is called `ts_day`, not
`ts`, because that shadowing reaches *inside the expression that defines it* —
`SELECT toStartOfDay(ts) AS ts … GROUP BY toStartOfDay(ts)` groups by something
other than what it selected. The replacement is better anyway: `ts_day` says
which granularity it is, and it matches how a metric is named.

HTTP `QUERY` is an alias on the same handler the day it exists. It is a draft
with no `fetch()` support: nothing in this design may depend on it, and nothing
here does.

#### A7.4 Every call carries an identity

This closes the hole rather than adding a feature. `Caller` (`routes/mod.rs:121`)
already hands every handler a client bound to the session's ClickHouse user, and
`explorer`, `query` and `diagnostics` all take it. The API face is the one place
that does not.

Three mechanisms, and they are not interchangeable — the use case picks, not the
caller:

| carried as | who it is for | model |
| --- | --- | --- |
| the session cookie | the browser | rights of the invoker |
| a bearer from `/api/login` — **built** | a script whose owner has an account | rights of the invoker |
| `X-Flint-Token` | a caller with no account at all | rights of the definer |

**The bearer is built.** `/api/login` already probed with `currentUser()` and
opened a session, so it gained `bearer: true` in its request and returns the id,
the user and an `expires_in` in the body; `auth::session_id` (`auth.rs:183`) now
reads `Authorization: Bearer` and falls back to the cookie. `client_for` resolves
it from there unchanged, so every handler taking `Caller` accepts a script
without knowing one called it.

Two things were decided in the writing rather than here, both narrowing what this
document proposed. The bearer is **opt-in**, because the cookie is `HttpOnly` so
that no script can read the session id and returning it in every sign-in body
would undo that for the browser in order to serve something that is not one. And
it is **exclusive** — asking for a bearer suppresses the `Set-Cookie` — because a
caller that asked for one has just said it is not a browser, and issuing both puts
a second copy of the same secret somewhere nobody is watching. Where a bearer and
a cookie both arrive on a request, the bearer wins: a cookie is sent whether or
not the caller meant it, so letting it outrank a header would have an open tab
override what a script deliberately asked for.

One ambiguity is now on record in `auth.rs` rather than waiting to be found:
`/api/data/*` reads the same `Authorization: Bearer` as a published endpoint's
token. Nothing is ambiguous today, because that route is exempt from the gate and
never asks for a session — but the day one route accepts both, it has to tell
them apart explicitly instead of trying one and then the other.

Its cost, said plainly, because `auth.rs` already says the same thing about
sessions: a bearer is a session id, so Flint holds the password for as long as it
lives, and a restart invalidates every one of them. That is right for a person
and wrong for a long-lived integration. So **bearers stay short and the client
re-authenticates on a 401** — which is the honest arrangement anyway, since the
durable secret then lives in the caller's vault rather than in Flint's memory.
The password is posted to `/api/login` once; it never travels as a header on
every call, where proxies log it and shell history keeps it.

`X-Flint-Token` stays opaque and gains three things it lacks: a **role** to
assume rather than an account to be, a **scope**, and an **expiry**. What it must
never become is a stored ClickHouse credential Flint replays — that makes Flint a
secret store, keeps ClickHouse's credentials inside ClickHouse, and puts every
call back under one powerful account, which is the hole this section exists to
close. Two rules attach: an identity *and* a token on the same request is a
`400`, never a silent precedence, because that is how somebody eventually runs as
the wrong user without knowing; and the manifest account is never a delegation
target, or minting a token means handing out the administrator.

One correction to what is built: `data.rs:490` compares against `endpoint.token`,
held in clear in the workspace. Show it once at mint and store the hash, with the
consequence accepted — the page can no longer redisplay it, so `publish.ts`'s
snippets have to be produced at that moment. Cheap now; impossible once other
people's workspaces hold tokens in clear.

#### A7.5 What publishing becomes

Smaller and clearer, not useless. A published object is one of two things:

- **A name for a DSL document** — a bookmark with a stable slug. The Builder
  produces the document and the document rehydrates the Builder, and that
  reversibility is the point: "this URL returns exactly what you are looking at"
  is only believable if pasting it back proves it in two seconds.
- **A delegation** — a slug, a token, a role, for a partner or a spreadsheet with
  no ClickHouse account. This is the one thing the current mode does that nothing
  else can, and it is worth keeping for precisely that.

The statement-backed endpoint stays as the escape hatch for the analyst with no
DDL rights on a shared cluster who needs a join today. A fallback, no longer the
main road.

#### A7.6 What a per-request DSL gives up, and where each piece lands

- **The per-endpoint row cap** → the caller's own quota, `max_result_rows` and
  `max_execution_time`. Better than what it replaces: per person, not per URL.
- **Attribution in `/diagnostics/api-usage`** → `log_comment` carries the dataset
  and the caller instead of a slug, and the page groups by those. It keeps
  working; it stops being keyed on an object that no longer has to exist.
- **One OpenAPI per endpoint** → one document for the whole DSL, generated from
  the request type, with `dataset` as an enum **computed per user from their
  grants** — so the document lists exactly what that caller may read. The
  consequence to accept out loud: the surface differs per caller, so a generated
  client is per user. **Built** — `GET /api/data/openapi.json`, generated from
  the same constants the parser uses, so an operator added to `shape::Op` reaches
  it without anybody remembering. Past two hundred datasets the enum stops being
  documentation and the field falls back to a string that points at the listing.
- **A stable slug** → that, and only that, is what A7.5's naming is for.

#### A7.7 The façade has to survive an error — **built for `POST /api/data`**

Callers should not have to learn they are talking to ClickHouse, and the reason
is not cosmetic: once the vocabulary is Flint's, the substrate is replaceable.
The probe is `currentUser()` today and can be LDAP or OIDC tomorrow without a
single caller changing a line.

The leak was real and was measured rather than predicted. The first refusal the
new route produced read:

```text
flint_probe: Not enough privileges. To execute this query, it's necessary to
have the grant SELECT ON system.users. (ACCESS_DENIED) (version 26.7.5.10)
```

— the account name, the grant syntax and the build number, to a caller offered
none of them. `in_flints_words` in `routes/dataset.rs` now translates that family
and only that family: `ACCESS_DENIED` becomes "`system.users` is not yours to
read" (403) and an unknown table or database becomes "not a dataset on this
server" (404).

Two decisions inside it worth keeping visible. **Only the access family is
translated** — a timeout, a memory limit, a `Too many parts` are operational
answers that help whoever reads them, and burying those under a house voice would
trade a real diagnosis for a tidy one; what is hidden is vocabulary, not trouble.
And **"does not exist" and "you may not" are kept apart** rather than merged into
one cautious sentence: an authenticated caller can already list what they may
read, ClickHouse filters that listing by grants itself, and conflating the two
would cost every honest typo a confusing answer to buy secrecy the server does
not keep.

Still open: `routes/session.rs` speaks ClickHouse to a *browser*, on purpose —
codes 516/194/193/192 and 164, with 164 naming `GRANT SELECT ON db.*` and
`readonly=2`. That one is a person at a sign-in form who is better served by the
server's own words, and it stays. The façade is a property of the API.

Deliberately **not** hidden: the Access page names ClickHouse's model on purpose
— "your own standing" is the whole point of it, and B6 manages it. The façade is
a property of the API, not of the product.

#### The order I would take it

`A7.4`'s bearer and `A7.3`'s body are **done**, and together they did the thing
this section was written for: a call to `POST /api/data` runs as the caller, so
their grants and their row policies decide what comes back. Verified rather than
assumed — the same request, sent twice under two identities, returns two
different sets of rows. `A7.7` shipped with it, as this document said it had to.

**The query language is finished**: datasets derived rather than declared,
filters as a tree, aggregation gated by the inventory, time with windows,
granularity and comparison. Every one of them runs as the caller, so grants and
row policies decide what comes back.

Two pieces of A7 remain, and neither blocks the other.

**`A7.6` is done**, and the listing it was missing with it: `POST /api/data/list`
answers "which datasets can I read", narrowed by ClickHouse rather than by a list
Flint keeps, and `GET /api/data/openapi.json` builds the document on top of it.

`contrib/dataset-check.mjs` came with them, and it is the piece worth arguing for
rather than assuming. A published endpoint that filters wrongly returns wrong
rows and somebody notices; **an aggregation that groups wrongly returns a
number, and a number is believed**. So it asserts almost no fixed values — the
parts must sum to the whole, a comparison's previous half must equal the same
period asked for alone, buckets must partition their window, a cursor walk must
visit exactly what one page does. Thirty-one checks, and the first draft's two
failures were both its own: `system.query_log` grows while the check runs and its
`query_id` is not unique. Anything reading a number twice now reads
`system.columns`.

**`A7.4`'s hash at rest and expiry are built.** A published token is hashed on
its way in and handed back once; the workspace is no longer a list of live
credentials, and the page offers *rotate* because *show* is no longer something
anything can do. An endpoint made before this keeps working — the stored value
carries a `sha256:` marker, and without one it is compared in clear, because a
minted token and a digest are both 64 hex characters and an upgrade that guessed
wrong would have locked every caller out at once.

Two things this needed first, and both are worth more than the feature that
forced them:

- **The workspace can gain a column.** `CREATE TABLE IF NOT EXISTS` was the whole
  of its schema management, so a column added to a statement reached fresh
  installs and nobody else. There is now an `ALTER ... ADD COLUMN IF NOT EXISTS`
  pass at the end of `ensure`, and a rule attached to it: the list only grows.
- **The writers name their columns.** `ALTER` appends, so a positional insert
  would have written `run_as` into `version` on every migrated install and
  nowhere on a fresh one — silently, and only for people who already had data.

**`run_as` is built, and building it found the thing worth knowing.** The
mechanism was never the problem: ClickHouse's HTTP interface takes a `role`
parameter, so a role applies to one statement without Flint keeping a session.
The problem was that it does not do what this document said it did.

**ClickHouse's effective privileges are the union of the active roles *and*
everything granted to the user directly**, and a direct grant cannot be switched
off by activating a role. Every account on both servers here holds its rights
directly — `system.grants` shows `role_name` null on every row — so `run_as`
would have narrowed *nothing* in the ordinary case, while the page said
"delegated". A feature that quietly does nothing is worse than an absent one,
because somebody relies on it.

So the check is the feature. `Workspace::delegation_check` reads `system.grants`
for Flint's own account, and saving an endpoint with a role is refused when a
direct `SELECT` still reaches past the workspace — naming the grants, and the
fix. `FLINT_DELEGATABLE_ROLES` is the other half: which roles a deployment will
hand out, in the manifest and never in the UI, empty by default.

Two decisions inside it. Only `SELECT` is examined, because a published
statement runs `readonly=2` and refusing on an `INSERT` grant would refuse every
deployment that can write at all, for a risk that is not there. And grants on
the workspace database are exempt, because Flint keeps its bookkeeping there by
construction and it reaches nothing a caller asked for.

**The positive path is verified now**, and verifying it needed a fixture that did
not exist: `contrib/dev-roles.sql`, plus `ACCESS MANAGEMENT` on the development
`default` account, because roles cannot be created without it and nobody had it.
It builds two roles and `flint_delegate` — an account holding **no direct grants
at all**, every privilege arriving through a role, which is the shape the check
demands and which nothing here could previously produce.

The experiment, same account and same credentials throughout: with its default
roles it reads `analytics.devices`; with `role=flint_narrow` the same read is
`ACCESS_DENIED`; with the same role `analytics.events` returns half a million
rows; and `currentRoles()` answers `['flint_narrow']`. Through Flint: an endpoint
delegated to the narrow role is refused on a table outside it, the *same
statement* published without a role returns 400 rows, and the narrow role reads
what it does grant. `run_as` narrows.

One leak came with it, and only because the feature works. A privilege refusal
stopped being a misconfiguration and became a *normal* outcome — an endpoint
whose statement reaches past its role produces one on every call, at a caller
who holds a token and has never been shown the schema. `without_statement` now
translates `ACCESS_DENIED` into words that name neither the account Flint
connects as nor the grant it wanted, and logs the real one for whoever published
the endpoint.

#### A7.8 One query language, not two — **built**

Flint had grown a second one without anybody deciding to. `frontend/src/lib/query.ts`
turned the Builder's spec into SQL *in the browser* and posted the SQL;
`src/dataset/` took a document and wrote the SQL on the server. Two languages
for one product is two sets of rules, and they had already drifted on the word
where it matters most: `uniq` meant an honestly-labelled *estimate* on one side
and `distinct_count` an exact answer on the other. Same concept, two numbers.

Converging was only allowed to be lossless, so the server went first. It gained
**percentiles** (`p95`, `p99`), an **approximate distinct count** under a name
that says so (`distinct_count_approx`, beside the exact one — two words rather
than one with a flag), and **`HAVING`**: a filter on what was computed, the same
tree a `filter` is, rendered over what the answer returns rather than over the
dataset's columns. Those were the three things the Builder could say and the
document could not.

Three additions made the swap possible rather than merely correct. `explain`
builds the statement and hands it back **unrun**, so the Builder can still show
its work while somebody is assembling a question — a page that renders SQL only
after the answer arrives cannot, and a page that renders it locally is the
second implementation all over again. The answer carries the **statement** it
became, which the published face deliberately does not: there the statement is
somebody else's, here it is the caller's own question rendered. And it carries
the **column types**, because a metric's type is computed and a grid has nowhere
else to learn what to right-align.

`lib/dsl.ts` is the translation, with tests; `toSql` and the two helpers only it
used are gone. The Builder is unchanged as a *builder* — same spec, same
controls — and what it sends is now a document.

**And then it had to be finished properly.** The first version of the translator
refused three things the Builder had always been able to ask: two buckets, two
windows, and a window and a bucket on different columns. All three for the same
reason — the document held one `time` and one only — and all three shipped as a
polite message explaining what Flint would no longer do.

That is not a trade converging two languages is allowed to make, so `time` takes
a list now: every window narrows, every granularity adds a column, and one time
is still written as a plain object because that is what almost every request
sends. Only the first window may carry a `compare` — a comparison moves one
window, and two would be two answers.

Worth keeping as the rule for next time: **the language that survives has to be
able to say everything the one that goes could.** Anything less is a regression
wearing the clothes of a simplification.

**And a list needs its members to know which is which.** Making `time` a list
left a bug behind that no test saw: a `compare` was applied to `windows[0]`
rather than to the window it was written on. Put it on the second of two
entries and the `OR` paired the *first* window with the second's previous — two
unrelated columns, with the second's own window `AND`ed on top so the previous
branch could never match. It returned the current half alone, labelled by the
wrong column, and it looked like an answer.

`Comparison` owns its `current` window now, so the pair cannot be separated;
every other window is a plain condition. Found by reading the generated SQL of a
request nobody had sent yet, which is the only way this class of bug is ever
found — the numbers it returns are the right shape.

The same pass found a smaller one beside it. A `having` could not name the
comparison's `window` column, and the refusal listed the answer's *other*
columns — telling somebody an answer did not return something they could see in
their own rows. `order` could already name it, which made the inconsistency the
tell. The label is threaded into the `HAVING` renderer now, so "only the previous
half" is a filter like any other and the message lists what is really there.

A7 is finished. `A7.5`'s question is now the live one, and this section answers
half of it already: publishing is for **delegation** — a question handed to
somebody who has no account — and the delegation is only as real as the account
Flint runs as. If a deployment cannot meet that precondition, the honest advice
is the dataset API with a real identity, not a published endpoint with a role
that does nothing.

Then `A7.5`'s question becomes the live one, and it is worth stating plainly
rather than discovering: **what is publishing for**, now that anybody with an
account can ask anything without it? The answer this document has been assuming
is *delegation* — a slug and a token for a caller who has no account at all — and
that is the half of A7.4 still unbuilt. If that turns out to be the only
remaining use, the published endpoint should be rewritten around it rather than
kept as a second query surface with its own query string.

One thing found repeatedly while building this, worth carrying forward: every
bug that survived `cargo test` was about **names**. An alias shadowing its own
source column, a cursor offered where the next request would refuse it, a bucket
colliding with a dimension. The type system had nothing to say about any of them,
and a real request said it immediately.

---

## Track B — Infrastructure

Each of the eight sections of the tree, and the order they become useful in.

### B0. Identity: ClickHouse is the provider — **built**

A sign-in screen that takes **ClickHouse** credentials, a session that carries
them, every statement executed as that user rather than as the service account.
`FLINT_AUTH=true`; off by default, so no existing deployment changes. See
`src/auth.rs` and the README's *Signing in*.

It was worth doing first because of what it let us *not* build:

- **Authorisation is already written** — `system.grants`, which `access.rs`
  already reads. A user who may not drop a table is refused by the server, not by
  a check of ours that might be wrong.
- **The audit trail is already written** — `system.query_log` carries `user`.
  Infrastructure → Audit is a query, not a subsystem.
- **The access page changes meaning** — "who can do what" stops being an
  administrator's dashboard and becomes your own standing.

`FLINT_CLICKHOUSE_USER` stays, and it is what Flint's *own* work runs as: the
workspace, the alert scheduler, the report runner, the health probe. That line is
load-bearing in two directions. It keeps saving a dashboard from requiring every
reader to hold `INSERT` on a database they never asked about — and it means a
scheduled report reads whatever that account can read, so anyone who can sign in
can see the edition. Said out loud in the README rather than found out later.

What is still open, now that the rest exists:

- **Per-user audit as a page.** The trail is already in `system.query_log`; B8 is
  the view over it.
- **Tiers that mean something.** `FLINT_TIER` gates nothing yet beyond what is
  built. When the first `DROP` arrives, the notch is already there — and so is
  the identity that makes it attributable.
- **A second front end holding a session.** The cookie is same-origin. A separate
  SPA on another host would need credentialed CORS, which the CORS layer does not
  offer today. Nobody has asked.
- **A session a script can hold.** `auth::session_id` reads the cookie and
  nothing else, so an identity cannot reach the API face at all — which is why
  `/api/data/*` still runs as the account in the manifest, and why no row policy
  has ever applied to a call. A7.4 is the missing branch.

### B1. A job runner that survives a restart — **built**

One row per operation in `flint.jobs`: the statement, who submitted it, the tier
that allowed it, its state and its outcome. The row is the truth and the task is
only what happens to be pushing it along, which is what makes a restart
survivable. Carried by a first real job rather than built on its own: `OPTIMIZE`,
at the `ddl` tier, offered on Health beside the part counts that justify it.

Two kinds of work run on it, which is what proves it generalises rather than
being one feature in disguise: an `OPTIMIZE`, which is a single statement sent as
the caller, and an edition of a report, which is a dozen of them run by the
scheduler as Flint. `POST /reports/{id}/run` used to hold the request open while
every section ran — a report with slow sections timed out in the browser while
continuing on the server, and nothing on the page could say so. It now returns in
tens of milliseconds with a job id, and the Reports page shows the edition being
made.

What it deliberately does not do yet is **reattach**. On boot, a job still marked
running is marked `interrupted`, which is honest for the jobs that exist — the
statement Flint was waiting on died with the process, even though the server's
merge usually finishes. A job Flint could genuinely re-observe (a mutation, by
`mutation_id`; a backup, by `system.backups`) will want the real thing, and the
row already carries the `query_id` it would need.

One consequence worth knowing: only a job that is a single tagged statement can
be stopped. `KILL QUERY` finds one by the id in its row; an edition is a sequence
with an id each, so the control is not offered and the route says why rather than
pretending.

### B2. Clusters — **read, not yet operated**

The reads are built. `Replication` became `Clusters`: the ring from
`system.clusters` drawn as shards and replicas, per-table replica health from
`system.replicas`, this replica's `system.replication_queue` ordered by failures,
and `system.distributed_ddl_queue` one row per host. The old
`/infra/replication` path redirects.

It also forced a third answer out of `Reach`. A server with no Keeper answers
`system.distributed_ddl_queue` with code 139 — "There is no Zookeeper
configuration in server config" — which Flint used to raise as an error, and
which is neither a missing grant nor a missing table. `Reach::Unconfigured` says
it as what it is: this server is not in a cluster, and nothing is wrong.

**The actions are built too**, at the `admin` tier, each a job — which is why B1
came first. `SYSTEM SYNC REPLICA`, `STOP`/`START FETCHES` and `RESTART REPLICA`,
offered on the replica row that diagnoses them, with `Restart replica` set apart
from the routine three: re-initialising a replica from Keeper is what you do when
something is already wrong.

To verify them, the repository gained a real cluster:
`docker-compose.cluster.yml` — one Keeper and two replicas of one shard, separate
from the single-node development environment because a single node is what most
people run and what Flint must stay honest about. Four things do not exist
without it: a populated `system.replicas`, a replication queue with entries in it,
a `SYNC REPLICA` that has anything to wait for, and a stopped fetch. Every one of
them was exercised — a replica taken to zero rows and brought back.

**Keeper**, on the Clusters page and above the places it breaks: a replica gone
read-only and an `ON CLUSTER` that never finished are both symptoms of this one
line. Three sections — the session this server holds, the ensemble as it sees it
from `system.zookeeper_info`, and every connect and disconnect from
`system.zookeeper_connection_log`. Three things the work settled:

- **Absence is an answer, not a failure to get one.** A ClickHouse with no
  Keeper in its configuration does not *have* `system.zookeeper`,
  `system.zookeeper_connection`, `system.zookeeper_info` or
  `system.zookeeper_watches` — the tables are created conditionally, so asking
  answers the same `UNKNOWN_TABLE` an old version would.
  `system.zookeeper_connection_log` exists on both and is the tell, so Flint says
  "this server has no Keeper configured" rather than sending somebody to upgrade
  a server that did not need upgrading. That took reading two real servers side
  by side.
- **One reading cannot show a flapping ensemble.** The session table only ever
  holds the current session, so a session that keeps being young is a session
  that keeps being lost — and the verdict for a young session points at the
  history rather than at itself. The history earned its place by accident: the
  Keeper wipe attempted below is in it, `Session expired` and a reconnect one
  second apart.
- **A lone standalone Keeper is stated, not judged.** It is a legitimate
  development setup and a hazard in production, and Flint cannot know which this
  is. So: "There is no quorum to lose, which also means there is no redundancy."

**`RESTORE REPLICA` is still not shipped, and now for a reason with evidence
behind it.** Three attempts to produce the state it repairs — Keeper metadata
gone, local data intact — all failed to reach it on a real two-replica cluster:
dropping the replica from its peer does nothing while it is active and did not
stick while it was stopped, and emptying Keeper entirely (recreating its
container, so the servers kept their data and the ensemble kept nothing) ended
with both replicas re-registering themselves, five hundred rows each,
`absolute_delay` zero and `is_readonly` never once true. The refusal is verified
— `Code: 36. Replica must be readonly.` — and the success is not, so where a
replica *is* read-only the page names the statement and declines to run it.

Also verified while there: **a stopped fetch has no light**, exactly as a stopped
merge does not. No column of `system.replicas` reports it and `ReplicatedFetch`
reads zero whether fetching is stopped or merely idle, so the job row is the only
record — the same sentence the merge controls carry, for the same reason.

What is left:
- **Per-edge traffic on the ring — answered, and the answer inverted the page.**
  `system.clusters` carries `errors_count` and `estimated_recovery_time`, and the
  page showed the first. Watched against a real failure — one replica of a
  two-replica shard stopped, then a distributed read *and* a write pushed at it —
  `errors_count` stayed at **zero** throughout. It never moved once. The page was
  showing a column that cannot speak.

  `estimated_recovery_time` is the one that moves: to 60 at the first failed
  attempt, then down by one a second. So it is now what the row reports, and
  `errors_count` is kept and shown only where it is *not* zero, because another
  build may populate it and a column that says nothing on this server should not
  be a column that says nothing everywhere.

  Its name oversells it and the sentence beside it does not repeat the
  overselling. It is the local server's own back-off timer, not a prediction
  about the node: measured counting down from 60 to 9 **while the stopped replica
  was already running again**. Nothing checks until the timer runs out. So the
  row says "not being tried for 45s after a failure", which is what is true.

  The fixture gap found on the way is **closed**: the ring could not do
  distributed *writes*, because a cluster definition carries its own credentials
  and this one had none — the node forwarding an insert authenticates against its
  peer as `default` with no password and is told `Authentication failed`. Reads
  never show it. `<user>`/`<password>` per replica in `contrib/cluster/
  server-common.xml`, and an insert of a thousand rows through the Distributed
  table now lands on both replicas.
- **`system.distributed_ddl_queue` — the half-succeeded statement, produced and
  read.** A conflicting table on one replica, then a `CREATE TABLE ON CLUSTER`,
  and the ledger gives three shapes, none of which was safe to assume:

  - `Finished`, code `0` — it ran.
  - `Finished`, code `57` — it **failed**. The status is about the queue entry
    being done with, not about the statement working. A page that reads the
    status alone puts "Finished" against the node where the table was never
    created, which is the exact failure the table exists to expose.
  - `Inactive`, **null** in both exception columns — the node has not picked it
    up. Nothing has gone wrong; it runs the statement when it comes back.

  That null was a shipped bug, and it broke the section on the one server state
  the section is for: `toInt32(exception_code)` decoded into `i32` answered
  `invalid type: null, expected i32` and took the whole Distributed DDL panel
  down the moment a node was stopped. Coalesced in SQL now.

  The other correction is quieter and would have produced a confident lie: the
  limit counted **rows**, and there is one row per host, so a cut fell inside a
  statement — half a statement folds into "ran on all 1 host" about a statement
  that ran on one of four. The limit counts statements now.

  The page folds the ledger back to one row per statement, because "ran on 3 of
  4" is a fact about a statement and a table of host rows makes the reader
  assemble it by scanning. A host that failed and a host that is absent are said
  differently, since the remedies are: read the exception, or get the node back.
- **A degraded ensemble.** `system.zookeeper_connection` and the connection log
  are read and the sections are built, but every reading so far has been of an
  ensemble that was either healthy or entirely absent. What Flint says about one
  that is *losing* a node is still unwatched — and a lone standalone Keeper, the
  fixture in hand, has no node to lose.
- **`RESTORE REPLICA`** — the only action still unshipped, and the reasoning is
  above: the refusal is verified and the success is not, because three attempts
  to produce Keeper-metadata-gone-local-data-intact on a real two-replica cluster
  all failed to reach that state. The other four actions are built and were
  watched working.

### B3. Health — **history, logs, now, and dictionaries**

Four of the six landed.

**Dictionaries**, and whether they are actually working. A dictionary is the one
piece of ClickHouse that fails and keeps answering: one that loaded successfully
and has since been failing to refresh returns the values it had, and no query
result says so. Three things the work settled, and the first is why it was worth
doing at all:

- **The status column does not report the dangerous state.** This was built
  expecting `FAILED_AND_RELOADING`, which `system.dictionaries` documents.
  Producing the state for real — a dictionary sourced from ClickHouse whose
  account was then dropped — gives `LOADED`, with `dictGet` still returning the
  old values. A page reading the status alone calls that dictionary healthy,
  which is exactly the failure it exists to catch.
- **The error count flickers.** `error_count` does go up on a failed refresh,
  and it is reset and re-raised as the background loader retries: two readings
  of the same broken dictionary a moment apart gave 1 and then 0. So it is a
  second way in, not the detector. What does not flicker is the clock — a last
  *successful* load a whole lifetime past due, measured against the lifetime the
  deployment chose rather than a threshold invented here.
- **Two figures that look like faults and are not.** `NOT_LOADED` is innocent
  where `dictionaries_lazy_load` is on, which is the default, so the setting is
  read alongside and the row says which of the two it is. And a `lifetime_max` of
  `0` means "never refreshes on its own" only on a dictionary that has loaded —
  on one that has not, the server simply has not read the definition yet, and the
  fixture had exactly that: a dictionary declared `LIFETIME(MIN 300 MAX 600)`
  reporting `0/0`. Flint prints no lifetime there rather than asserting a
  configuration it has not seen.

A low `found_rate` is shown and not judged: a dictionary used for optional
enrichment misses most lookups by design, and inventing a threshold would put
Flint's guess above the deployment's intent. Zero found over real lookups is
remarked on, because that one is unambiguous.

`SYSTEM RELOAD DICTIONARY` is the action, at `ddl` — it destroys nothing and it
is the ordinary repair for a source that has moved on. It is also the only action
on these pages whose effect *is* observable: the status, the key count and the
last-success time all move.

Verified against `contrib/dev-dictionaries.sql`, which builds all three states,
and by watching the broken one keep answering `first` while Flint said why it
should not be trusted.

**Right now**, from `system.metrics` and `system.asynchronous_metrics`, and the
organising idea is that a figure is paired with the ceiling the server would
refuse at. Eighty numbers with no scale is a wall; the same eighty against what
the server will allow is a page somebody can act on. Four things the work
settled:

- **`system.events` is not used, deliberately.** It counts from boot, so on a
  server up for eleven days "forty-two million selects" is true and says nothing
  about this minute — the mistake the errors panel made once and had to be
  rebuilt out of. The rates come from the newest bucket of `system.metric_log`,
  whose `ProfileEvent_*` columns are per-second deltas already, which costs one
  cheap read and no waiting for a second sample. That bucket buffers before it is
  written, so the page says how old the reading is, and says something different
  past a bucket's worth: eight seconds is a buffer, two minutes is a collector
  that has stopped.
- **The two settings tables collide.** `max_concurrent_queries` is 1000 in
  `system.server_settings` and 0 — unlimited — in
  `system.merge_tree_settings`, and they are different limits. Six names do
  this. A flat lookup by name let the second overwrite the first, which turned a
  real ceiling into no ceiling and demoted the most-read row on the page to a
  figure with no scale. Ceilings are keyed by `table.name` now.
- **A ceiling of zero is not a ceiling.** ClickHouse spells "no limit" as `0` in
  every one of these settings, so a literal reading draws a bar permanently at
  its end and reports a healthy server as one at 100% of everything. Such a row
  becomes a plain figure under its own heading rather than a saturation with
  nothing to saturate — and that heading drops the ceiling column entirely,
  because a column empty down every row is a heading nobody can reconcile.
- **An alarm that is not firing is not an alarm.** Four zeroes under a heading
  that says something is wrong is a heading nobody trusts the fifth time. The
  quiet ones become one line that *names* them, because the value of that line is
  seeing that the thing you were worried about is one of the ones being watched.

The firing banner was verified rather than assumed: the two-replica compose
overlay from B2, its Keeper stopped, `ReadonlyReplica` at 1, and the panel saying
"A replica that has lost Keeper accepts no writes. It does not fix itself."
Keeper back, and it cleared.

It also closes a loop with B7: the `SYSTEM STOP MERGES` panel warns that a table
over `parts_to_throw_insert` refuses inserts, and this page carries the figure
that says how far away that is — named down to the partition, because a parts
count with no table is a number nobody can act on.

Watching is opt-in and says its interval. A page that quietly asks a production
server for two hundred metrics every two seconds costs something nobody agreed
to; a snapshot with the reading's own age on it is honest, and watching is one
click.

The two the phase was originally named for:

**Over time**, from `system.metric_log`: memory, queries running, merge pool
against its own size, delayed inserts, mark cache hit rate. Gauges at each
bucket's peak rather than its average, because an average hides the spike that
mattered; `ProfileEvent_*` columns summed, because in that table they are already
deltas and not running totals. A bucket with nothing to measure is a *break* in
the line rather than a zero, and the count of breaks is stated.

**What has gone wrong**, from `system.error_log`, which samples the error
counters over time. The panel used to live inside "Right now" and count since the
server started — the one thing it could not be, because on a server up for eleven
days "42 access denied" says nothing about today. Where `error_log` is switched
off it falls back to the lifetime snapshot from `system.errors` and *says so*,
rather than quietly changing what its numbers mean.

**The server's log**, from `system.text_log`: newest first, at a level and
everything worse than it. Two attempts at the level filter were silently wrong
before the third worked — `level <= CAST('Warning' AS Enum8(…))` compares as
String, where `'Debug' <= 'Warning'` is true and the filter returns the whole log;
`toUInt8(level)` goes through `toString` and fails parsing `'Trace'`. It is an
`IN` over names now, which cannot go wrong the same way and says what it means.

**Merging, over time**, from `system.part_log`: merges finished and bytes
written as lines, then the tables the work went to with their average and their
worst. `MergeParts` only — `MergePartsStart` is the same merge counted at its
beginning, and summing both doubles every figure on the page. Merge failures
(`error`, `exception`) are surfaced per table and at the top; zero on the server
this was built against, so that is the one branch nobody has watched render.

The three history panels refresh once a minute, not every five seconds: at the
six-hour window a bucket is 108 seconds wide, so asking faster redraws the same
line. `Right now` is the panel that needs to be live, and it says so.

`Where the processor went` reads `system.trace_log`, and four things about it
had to be measured rather than assumed:

- **The innermost frame, not every frame.** Under real load, counting every
  frame ranked thread-pool plumbing at the top — `__thread_proxy`, `worker()`,
  `executeStep`, 6/6/6/5/5 — while `trace[1]` alone ranked `sipHash64Keyed`,
  which is the function the query was actually in. Counting whole stacks
  produces a chart that is the same on every server.
- **Symbolising needs a setting that is off.** Without
  `allow_introspection_functions`, `addressToSymbol` answers `Code: 446
  FUNCTION_NOT_ALLOWED`. It goes in the statement's own `SETTINGS` clause, so it
  is deliberately absent from `ATTACHED_SETTINGS`: it never reaches another
  query's `system.settings`, and the Configuration page would be lying to show
  it.
- **Most addresses have no name, and the proportion is the finding.** Measured
  through Flint: CPU/15m gave 28 samples with 0 unnamed; Real/15m gave 6204 with
  6172 — 99.5%. Without that line the Real view would draw a confident top-three
  built from 32 samples out of 6204. The share is clamped to 1–99% because
  rounding 15174 of 15201 to "100% is missing" directly above twenty rows is a
  claim the reader can see is false.
- **Below thirty samples the count replaces the ranking.** A five-minute window
  on a quiet server holds ten, which draws eight rows tied at 13% — the picture
  of nothing. A warning printed *above* that table reads as a caveat on an
  answer; printed *instead of* it, it is the answer.

What is left of the phase:

- `system.metrics`, `system.events`, `system.asynchronous_metrics` as a
  right-now panel. The history covers the questions people actually ask, so this
  is a smaller gap than it looked.
- `system.crash_log`. It does not exist until a server has crashed, which is the
  right reason not to have verified it — the table is empty on a healthy machine
  and there is nothing to see until there is.
- Ingestion: `system.kafka_consumers`, S3Queue, `system.rocksdb`. All three
  tables exist on the dev server and all three are empty, because no such engine
  is configured. Verifying them means building fixtures for each engine first,
  which is the honest cost and why they are still here.

The original note, kept because it is still the point:

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

- create, rename, drop, `TRUNCATE`. **Drop and truncate are built**, in a new
  Infrastructure → Schema section — which had to exist first, because the rule set
  with the two spaces holds: no Data control may change structure, and the table
  page is Data. Dropping had nowhere it was allowed to live.

  The drop confirmation *is* the impact preview: pressing it asks what depends on
  the object and shows the answer before offering the button again, with the two
  certainties apart and the button reading "Drop it anyway" when something would
  break. Verified by dropping a table with a view over it and watching the view
  break exactly as predicted.

  **Altering is there now**, for columns and TTL: add, rename, retype, drop a
  column, set a TTL and remove one. Each carries the sentence saying what it
  costs *this* table before it is pressed, published by the backend rather than
  written a second time in the browser — the drift the `SYSTEM` console already
  had to have removed from it once.

  Which of these rewrite data was **measured, not reasoned**, on a table of
  400,000 rows in two parts. `ADD COLUMN` makes no mutation, with or without a
  `DEFAULT` — the default is computed on read until a merge writes it down, so it
  is cheap to add and not free to query. `RENAME COLUMN` does make one, which is
  the surprise in that table and the operation most likely to be assumed
  metadata-only. Retyping, dropping and changing a TTL rewrite as expected.

  And **"done" already means done**, which was worth checking rather than
  assuming: `alter_sync` defaults to `1`, so the statement waits for the mutation
  on this replica. Measured at 15 ms with `alter_sync = 0` and the mutation still
  running, against 161 ms at the default with nothing unfinished. Flint keeps the
  default instead of raising it to `2`: waiting for every replica would make
  "done" mean more and would hang against a replica that is down, which the
  Keeper work has already shown is a state a cluster reaches. So the job label on
  a replicated table records what it waited for — "on this replica" — rather than
  letting the list be read as "applied everywhere".

  The tier is per operation, on the documented line. Dropping a column throws its
  values away and a TTL deletes rows already past it, so those two are `admin`;
  adding, renaming and retyping are `ddl`. Removing a TTL stops deletions and is
  `ddl` for the same reason.

  A type or a TTL expression reaches the server **as written**. Flint does not
  parse ClickHouse's type grammar — it is large, it moves between versions, and a
  validator here would refuse types this server understands. What it refuses is a
  fragment carrying a semicolon or a comment opener, which is the only way one of
  these becomes two statements: `UInt8; DROP TABLE analytics.alter_probe` is
  turned away and the table is still there.

  **Indexes and projections are there too**, six more operations: declare, build
  and drop each. And the fact that was waiting there is true, measured on tables
  of 500,000 and 300,000 rows:

  | statement | mutation | size after |
  |---|---|---|
  | `ADD INDEX by_label label TYPE set(100) GRANULARITY 4` | none | 0 bytes |
  | `MATERIALIZE INDEX by_label` | one | 36 bytes |
  | `ADD PROJECTION by_v (SELECT v, count() GROUP BY v)` | none | 0 parts |
  | `MATERIALIZE PROJECTION by_v` | one | 1 part, 761 bytes |

  So **declaring one does nothing to the data already there, and the statement
  reports success**. A table can carry an index every query ignores, and a
  projection that answers nothing, indefinitely, with no error anywhere. There is
  no status column for it either — the observable is size, and zero bytes on an
  index or no parts on a projection is what `ADD` leaves behind. The panel reads
  that out of `system.data_skipping_indices` and `system.projection_parts`, says
  "nothing — never built" where it is true, and puts the sentence above the
  controls.

  Dropping either is `ddl`, not `admin`: both are computed from the rows, so
  nothing is lost that cannot be declared and built again.

  One small thing the form found: `granularity` is a number and a form sends
  `"4"`. Refusing a body for the JSON type of a number somebody typed correctly is
  a refusal nobody can act on, so it is read leniently — and `"lots"` is still
  refused rather than becoming a zero.

  **Creating is there, and it is the DDL editor rather than a form.** Two facts
  made that the honest shape, and both were asked of the server:

  - **`create_table_query` round-trips.** What the server reports as a table's
    definition, with the name changed, creates the same shape — verified by
    copying a `ReplacingMergeTree` and reading back an empty table with the same
    four columns. It carries no `UUID` clause unless
    `show_table_uuid_in_table_create_query_if_not_nil` is on, which is off by
    default. So "start from this table's own definition" is a real offer, and a
    form with fifteen fields would cover less of ClickHouse's DDL than the
    statement already in front of you.
  - **ClickHouse's HTTP interface refuses multi-statements.** A body with two
    statements comes back as `Code: 62 … (Multi-statements are not allowed)` and
    *neither* runs — checked with a `CREATE` followed by a `DROP` against a table
    that was still there afterwards. So Flint does not have to find semicolons
    outside string literals, which no amount of string matching does correctly.
    That is the opposite of `alter.rs`, where a *fragment* is spliced into a
    statement Flint builds and the semicolon check is the whole defence.

  What is left is Flint's own policy, not the server's safety: the endpoint runs a
  `CREATE` and nothing else — dropping, inserting and altering have their own
  controls, where the tier and the confirmation belong to what they do — and it
  refuses `OR REPLACE`, which drops an existing table's rows, for the same reason
  the restore control refuses to write over something that is there.

  The definition is run through `formatDdl` before being offered, which is what
  that function already existed for: `create_table_query` comes back as one line,
  and for a thirty-column table that is two thousand characters of soft-wrapped
  text nobody can edit. And the name arrives already changed, with the button
  disabled and a sentence if it is put back — otherwise the server answers
  "already exists" and the form looks broken rather than unfinished.

  **B4 is complete.**
- columns, TTL, sorting key, codecs; indexes and projections, added, dropped and
  `MATERIALIZE`d
- partitions as objects — **built** for `DETACH`, `FREEZE` and `DROP`, each a
  job, on the row of "Parts per partition" that already carries the figures they
  act on. `MOVE PARTITION TO DISK|VOLUME` is left out: this server has one disk,
  and a control for moving data between volumes that has never moved any is not
  a control worth shipping.

  Three things learned from the server rather than assumed. `PARTITION ID`
  always, never the partition expression: the id is the opaque string ClickHouse
  reports itself, identical for a date key, a tuple key or no key at all — where
  it is `all`, which is worth knowing before pressing Drop. A freeze is *named*,
  because an unnamed one gets a sequential integer in `shadow/` that nobody can
  match to what they froze. And `SYSTEM UNFREEZE` is gated behind a **server**
  setting that is off by default, so a frozen copy usually cannot be removed by
  any statement — only by deleting the directory on the machine. Flint says so in
  the control's own tooltip rather than leaving it to be discovered.

  The three, plus the detached-parts screen, close a loop that was verified end to
  end: freeze, detach, watch the part appear as detached, attach it back, drop the
  partition. It reads as a story in the job list, each label carrying the rows and
  parts involved — because a job list is read after the fact, and "Drop 202605"
  without them leaves nobody able to tell what was lost.
- `system.detached_parts` — **built**: largest first, with reattach and delete as
  jobs. The column that carries the screen is `reason` — empty means a person ran
  `DETACH PARTITION` and reattaching is the next step in a procedure; anything
  else is the server's own word for why it quarantined the part, and reattaching
  that puts a broken part back in a table. The two are marked apart, the server's
  word is repeated rather than paraphrased, and attaching a quarantined part is
  *allowed* without the emphasis of the safe case: sometimes a broken part is
  exactly what you want back, once you have read why it was set aside.

  Deleting sits at `admin` rather than `ddl` — it removes data from a disk with
  nothing to undo it, which is operating a server rather than reshaping a schema.
  Two clicks with the bytes named, and the job records the statement *including*
  the `allow_drop_detached` flag ClickHouse demands, because a permanent deletion
  should read in the log exactly as it was sent.

  Verified against a real server: the attach on a genuinely detached partition,
  the delete on a table created for the purpose and dropped after, a part name
  carrying a quote refused before it reaches SQL, and a part that is not detached
  refused with the honest "it may have been attached or deleted already". The one
  branch nobody has watched render is a *quarantined* part — provoking one means
  corrupting a part on disk, which is not a thing to do to a fixture.
- storage: `system.storage_policies`, move rules, which volume a part is on,
  `system.filesystem_cache` and `system.blob_storage_log` where the disk is S3
- part-count pressure against the merge tree's own limits, so "too many parts"
  arrives as a warning rather than as a failed insert
- schema as code: diff two servers, generate the migration, export and import a
  versioned schema. **"Who changed this table, when" is built**: the table page's
  DDL tab now carries the record underneath the definition — the definition is
  *what* it is, the record is *how*. From `system.query_log`, which has been
  recording `query_kind` and the tables each statement touched all along.

  Each row says whether it came through Flint, read off the `query_id` the job
  runner already sets — so nothing extra is written to make it true, and a
  statement somebody ran in a terminal is honestly marked as not having come from
  here.

  Two limits are carried into the interface rather than left to be found: the log
  has a TTL, so the panel says how far back what it can see actually goes; and a
  `CREATE DATABASE` names no table, so it can never appear.

  Building it surfaced something about Flint itself. The workspace bootstrap runs
  `CREATE TABLE IF NOT EXISTS` on every start, so on a server Flint has been
  restarted against fifty times, the structural history of its own tables is fifty
  identical rows burying anything real. Consecutive identical statements are now
  folded and *counted* — "×55, back to 4h ago" — the same treatment the explorer
  gives internal tables. Consecutive only: two identical `ALTER`s with somebody
  else's `DROP` between them are three events, and merging them because the text
  matches would rewrite what happened.
- every destructive action gated by the lineage graph as its confirmation dialog.
  **The reading half is built**: `GET …/impact` answers what a drop would break
  and what it would lose, transitively, and the table page's `Read by` tab now
  opens on it. Two certainties kept apart, which is the whole substance:
  `declared` is ClickHouse's own `dependencies_table` — the server itself breaks —
  and `inferred` is Flint having read a definition with something that is
  deliberately not a SQL parser. A single number over both would be a promise
  Flint cannot make about half of it.

  Two bugs found in building it, and the second only because the first was fixed.
  `dependencies_table` on X lists the things that depend on X, and I had the edge
  reversed — which still produced the right *set*, because the inferred pass found
  the same objects, and only mislabelled how Flint knew. Then the label depended
  on the order the server returned rows in: of three declared materialized views,
  one came out `declared` and two `inferred`, on the same data. `declared` wins
  unconditionally now.

  Wiring it as an actual confirmation waits for `DROP TABLE`, and that waits for
  an Infrastructure → Schema section — because the rule set in the first task
  holds: no Data control may change structure, and the table page is Data.

  **Projections have an advisor now**, and it lives on the Data side while the
  control that runs it stays here — the corollary in "Where the line falls"
  holds: no Data control changes structure as a side effect, so the table's
  Projections tab offers the DDL and hands it to Infrastructure → Schema with
  the form filled in. That link is the first use of a prefilled alteration, and
  it is the shape the roadmap already prescribed for an import into a table that
  does not exist.

  The advisor starts from `system.query_log` and not from the DDL, because
  whether a projection earns its disk is a question about a *workload*. Each
  proposal names the shapes behind it, their runs, their rows read per run and
  the share of the table that is, and they are ranked by the time the window
  actually spent — never by a predicted saving.

  Four things were measured before any of the wording was written, on a
  5,000,000-row table in five parts with `ORDER BY (project_id, time)`:

  - **A sort-order projection bottoms out at `parts × index_granularity`.** A
    filter matching 250 rows read 40,960 — five times 8,192 — because ClickHouse
    reads whole granules and every part contributes at least one. A tool that
    promised the matching rows would be wrong by 164×, so the floor is arithmetic
    and it is stated as a floor.
  - **An aggregate projection's benefit is countable in advance.**
    `uniqCombined` over the proposed key *is* the projection's row count: three
    distinct values came out at 15 rows over five parts, 150 at 750. So `Measure
    it` counts rather than models, and the same pass can refute a proposal — a
    key with a million distinct values makes a projection nearly as large as the
    table, and the number says so.
  - **The column list is the recommendation.** `SELECT *` measured 22.5 MB
    against 1.7 MB for the same key holding only the two columns those queries
    read. The advisor proposes the narrow one and ships the price of it in every
    card: the same query with `max(time)` added read all 5,000,000 rows again,
    silently.
  - **Aggregates match by expression, not by algebra.** A projection storing
    `count(), sum(value)` did not answer `avg(value)` — 5,000,000 rows against
    15 — so a proposal carries the expressions the workload actually wrote.

  Verified end to end afterwards rather than left as arithmetic: the advisor
  predicted 40,960 rows and 21 MiB for one proposal, and after declaring it
  through the hand-over and building it, the query read 40,960 rows and the
  projection weighed 21.8 MB. The tab then showed it under *Already here*, used
  seven times, and marked its own proposal **already covered**.

  Finding the table needed no new ranking: Diagnose's *Which tables are read*
  already carries the scan share and the verdict "the sorting key is not
  narrowing these queries", and that sentence now offers a link into the tab.
  Above a floor of eight granules' worth of rows only — the first version asked
  whether a projection would help a five-row dictionary source, which is not a
  question.

  **The size of an aggregate projection is weighed, not reasoned about.** It
  depends on the width of the aggregate *states* — a `uniqCombined` digest is
  not a number anybody can read off a schema — so `Weigh it` does what the type
  probe does: the same grouping and the same states go into a scratch table in
  the workspace, its parts are read, and it is dropped. The states and not the
  finalized values, because a `quantile` state is a digest many times wider than
  the `Float64` it finalizes to.

  Reported as a range, because it is one. One part's worth is the floor and
  `× parts` the ceiling, and which end a key lands on was measured both ways: a
  key of three values came out at exactly five times one part, a key of 31 days
  15% under the ceiling — the parts were written in time order, so each holds
  only some of the days. Verified against the real thing afterwards: a
  seven-aggregate proposal weighed 1.3–6.3 MiB and the projection built from it
  measured 2.57 MiB. That figure is why the button exists — 31 rows sounds free,
  and those 31 rows carry four `uniqCombined` digests and come to a sixth of the
  table.

  Two bugs found in building it, both only visible by running it. The scratch
  table's key column is *named* `toStartOfDay(time)`, so `ORDER BY
  (toStartOfDay(time))` resolves against the new table and fails with `Missing
  columns: 'time'`; the keys are aliased now. And the reading was a `<p>` with a
  `<details>` and a `<pre>` inside it, which no `tsc` or Vitest run can see and
  the browser silently reparents.

  The workload is capped at the sixty costliest shapes and the cap states its
  own count — "the 60 costliest of 104 query shapes, 118 of 162 runs" — which
  the first version did not. Two extra aggregates over the same rows rather than
  a bigger list: raising the cap would carry hundreds of full statements over
  the wire to answer a question that is two numbers.

  **And it says what to drop.** An advisor that only adds grows a disk forever.
  A projection declared and never built is named from the table alone — zero
  parts, no log needed, and the statement that created it reported success. One
  that is built and that nothing in the window chose is named from the log, with
  the count taken over *every* run rather than over the sixty shapes the page
  lists: those are the costliest, and a projection answering a cheap frequent
  query would otherwise read as unused, which is the one mistake here that costs
  somebody a regression. That was the shape this had first and it was wrong.
  Both findings hand their `MATERIALIZE` or `DROP` to Infrastructure the same way
  the proposals do.

  **And the same question across a database.** A database page's *Keys* reading
  ranks its tables by the time the workload spent on each and says what that
  table's costliest shapes do — three reads for the whole database rather than
  one per table. It reads five shapes each where the table's own tab reads
  sixty, so it speaks about those five and says so: enough to know which table
  to open, not enough to conclude one has nothing worth doing.

  Two things it got wrong first, both visible only by rendering it. Reporting on
  the *first* shape that parsed made it useless on a real log — a cross join and
  a profiling scan ahead of the real workload, and "nothing to serve" about a
  table with two proposals on it. And a shape with no filter and no grouping was
  classified as a sort candidate, which printed "filters on , which is not a
  prefix of device_id, ts". Both now have their own reading, as does a table
  below the granule floor — which is one constant now, shared with the diagnose
  page, after two copies of it had been written a day apart.

  What it does not do is in "Not built yet": no `SETTINGS` on a
  projection, no bytes without a workspace to weigh them in, and no weighing of
  an aggregate over an expression rather than over a column — `sum(value * 2)`
  is not something Flint will hand to a statement builder.

### B5. Backups — **started**

`BACKUP TABLE … TO Disk(…)` and its inverse run as jobs, and Infrastructure →
Backups reads `system.backups`.

Three things the work settled:

- **A destination cannot be discovered.** ClickHouse refuses the statement unless
  the server's own `backups.allowed_disk` sanctions the disk, and that setting is
  not readable from SQL — so Flint is *told*, in `FLINT_BACKUP_DISK`, and takes no
  backups where nobody named one. The page says that rather than hiding a button.
- **`system.backups` is a log, not a catalogue.** It is per-process and does not
  survive a restart, so a backup taken last week by a server restarted since is on
  the disk and not in the table. A screen presenting it as "your backups" would
  have somebody conclude theirs had vanished; this one says what it is.
- **Restore only into an absence.** ClickHouse will restore over an existing table
  given the right setting, and that is a different decision from putting back what
  was lost. Flint refuses it and says to drop first, so the decision is one
  somebody made rather than one a button made for them.

**Restore from the list.** `system.backups` records the destination and not the
source: a row says a file was written and not what was in it, which is exactly the
fact a restore needs. Flint's own job rows have both, so the two are joined on the
`query_id` — every statement Flint sends carries `flint-job-<id>`, which makes the
job row and the server's record of it the same event seen from two sides. From
that join the page gains a **Was of** column and, on the runs where it can, a
Restore button.

It can on four conditions, and the row says which one is missing rather than
greying out in silence: the backup succeeded, it was a backup rather than a
restore, Flint knows what it held, and that object is gone now. Existence is
checked *as the caller* — a table this user cannot see is not one to offer a
restore into. A backup somebody took in a terminal keeps its file and gets no
button: Flint would be guessing which table it held.

Verified end to end, with a fixture added for it: a default ClickHouse cannot back
up at all, so `contrib/dev-backups.xml` gives the development one a destination.
Backed a table up, dropped it, restored it, 1,234 rows back — and then again from
the list, in the browser: 555 rows back, and both rows offering that backup
withdrew the offer and said the table was there again.

**Restoring a whole database is there**, and it is one statement rather than a
loop over the tables — which matters for what it can do: `RESTORE DATABASE` puts
the table *definitions* back too, so a database that was dropped entirely comes
back whole. Verified by dropping one with two tables and reading both back with
all their rows, through Flint. Restoring table by table would need the tables to
exist first, which after a drop they do not.

The scope is the absence of a table name rather than a new field, and the
existence check had to learn about it: a database target has no dot in it, so the
check that only looked at `system.tables` found nothing and offered a restore into
a database that was there. The route refused it — so the cost was a button that
failed rather than a database overwritten — and the check now asks
`system.databases` as well.

**Two findings that changed a page already shipped.**

`system.backup_log` **survives a restart** where `system.backups` does not:
measured at 24 rows going back two days, across a container restart that emptied
the in-memory table completely. Flint reads the log where there is one, and the
page's heading follows — "since this server started" is true of one table and a
needless disclaimer on the other. It is an event log with a row per state change,
so the outcome is the last row per id, and the first version of that read ordered
by `event_time`: both rows of a fast backup land in the **same second**, so
`argMax` over a `DateTime` chose between them arbitrarily and the page reported
every finished backup as still creating. Measured at 2 ms apart.
`event_time_microseconds` exists for exactly this.

**Retention is not implementable, and that is a measurement rather than a
decision.** A backup disk cannot be listed from SQL at all: `filesystem()` is
confined to `user_files_path` and answers `Code: 291 … DATABASE_ACCESS_DENIED` for
anything outside it, `file()` the same, and there is no `SYSTEM DROP BACKUP`. So
Flint can neither enumerate the files on a backup disk nor remove one, and a
retention control would have to be a lie about both. The page already says the
half of this that matters — a file deleted by hand is still in the list, and the
restore offered against it fails with the server's own words.

**S3 is there, and most of it needed no code.** A MinIO fixture
(`docker-compose.s3.yml`) and an S3 *disk* in the server's configuration
(`contrib/dev-s3-backups.xml`) are enough: Flint keeps naming a disk, the existing
`Disk(disk, file)` statement is unchanged, and nothing secret passes through
Flint. That is the point of doing it that way — `BACKUP … TO S3(url, key,
secret)` puts the credentials in a statement, which ClickHouse records in
`query_log` and Flint would record in its own job table.

What S3 *does* change is the archive format, and that needed code:

- **A zip cannot go to object storage.** `Code: 36 … Zip archive format is not
  supported for backups on disk 's3backup' because it is backed by object
  storage, which does not support seeking efficiently (zip requires seeking).`
  `.tar`, `.tar.gz` and `.tzst` all work. So the suggested file name follows the
  disk's own `type` — `ObjectStorage` against `Local`, read rather than guessed
  from the disk's name — and a `.zip` aimed at object storage is refused in the
  form with the server's reason rather than in the job list after the button.
- **A name with no extension is a directory, not an archive.** It writes many
  objects instead of one file, which is a legitimate thing to want, so it is
  allowed and not corrected.

And a trade-off worth writing down rather than discovering. A named S3 disk keeps
the credentials in the server's config, and the price is that the object keys are
generated: a backup called `nightly.tar.gz` lands in the bucket as
`fwq/baadtfoyapizrpbfccuhcshnwrnzh`. The file name is ClickHouse's handle and not
the object key, so the bucket cannot be browsed by name — which makes the
persistence of `system.backup_log` matter more, not less, since Flint's list is
then the only place those names exist.

Verified end to end against the fixture: a zip refused, a `.tar.gz` written, the
table dropped, and 400 rows restored from the bucket.

**B5 is complete.**

### B6. Users & RBAC — **read, and now written**

`access.rs` lists users, roles and grants and refuses to change any of them,
deliberately. Once B0 is in place that refusal can be lifted safely, because the
server decides whether the signed-in user may grant anything.

**How much, and which rows.** The three families with no coverage at all are now
read, in `limits.rs`, and shown under the access list: a quota caps what an
account may consume, a settings profile fixes the settings it runs with, and a
row policy decides which rows it sees. Four things the work settled:

- **A row policy does not protect a table.** It protects it *for the accounts it
  names*. An account no policy names sees every row — and a restrictive policy
  standing alone narrows from everything rather than from nothing. Both were
  verified against a running server with three policies and two users, not
  reasoned from the shape of the tables, and both are on the screen because both
  are easy to state backwards.
- **A profile is fastened on from either end.** `CREATE SETTINGS PROFILE p TO
  bob` fills the profile's list; `CREATE USER bob SETTINGS PROFILE p` writes a
  row against *bob* and leaves that list empty. Every account on a stock server
  holds `default` the second way, so a page reading only the first reports the
  profile every query on the machine runs under as applying to nobody.
- **`ALTER USER … SETTINGS` belongs to no profile.** Those rows sit in
  `settings_profile_elements` beside the profile ones and are easy to read as
  part of a profile. They have their own section, because otherwise the page
  says an account runs with the profile's settings while the server runs it with
  these.
- **Being refused the definitions does not cost the figures.** An account that
  may not read `system.quotas` can still read its own `system.quota_usage`, and
  that row carries the ceilings it is counted against — so the answer to "how
  close am I" survives losing the list of quotas, and the page says whose
  figures it is showing.

Verified end to end against fixtures added for it (`contrib/dev-access.xml` and
`contrib/dev-access.sql`), because a stock server has one empty quota, one
profile and no policies at all — three sections that render the same whether
they work or not. Drove a quota to 52 of 60 queries a minute and then past it:
the bands moved, and ClickHouse refused with `QUOTA_EXCEEDED`.

**The writing half.** Nine changes, in `rbac.rs`: create and drop a user or a
role, grant and revoke a role, grant and revoke a privilege on a scope, and
rotate a password. `admin` tier, which the tier enum's own doc already named
access as belonging to — the reasoning is not that a grant destroys data, it does
not, but that a grant is the only write here that hands somebody *else* every
other one. Four things the work settled:

- **A secret must not survive the statement.** A password travels in SQL text
  because ClickHouse's protocol has no parameter for one. The server strips it
  from `query_log`; Flint's job table is a MergeTree that keeps rows for thirty
  days and had to strip it too. So a statement is built as two strings — the one
  sent and the one recorded — and the recorded one is *built without* the secret
  rather than scrubbed of it, because a redaction that works by finding the
  secret in a finished string is one regular expression away from keeping it.
  Verified after the fact: zero rows in `flint.jobs` carry it, and the server's
  own record reads `ALTER USER flint_bob IDENTIFIED WITH sha256_password`.
- **Privileges are the server's list, not ours.** Validation goes against
  `system.privileges` — 241 of them on a current server — so a hardcoded set
  cannot rot into refusing a privilege the server gained. The form offers them
  through a native `datalist`, which filters as you type and costs no combobox.
- **An account in a file is refused in the form, not by the server.** ClickHouse
  answers code 495 `ACCESS_STORAGE_READONLY`, correctly, several seconds after
  the button — where the person who pressed it is no longer looking. Flint says
  the same thing where they are, and names the file. The test is the *writable*
  storages, not the read-only ones, so a server with a storage nobody here has
  seen refuses rather than offering a button that fails.
- **A drop says what it costs.** "Drop user flint_bob? This takes away 1 grant, 1
  role it holds." Same reasoning as the object drop on the Data side, where the
  confirmation carries the row count: the number is the decision.

Verified by clicking, not only by testing: granted a privilege on one table and
watched it appear, revoked it from the chip that names it, watched the cost
sentence fall to "It holds nothing and nobody holds it", and dropped the account.
At `ddl` tier the endpoint answers 403 and the page draws no controls at all.

**Quotas, profiles and row policies are written now**, in `govern.rs`: create
and drop each of the three, at `admin` like the rest of access control. None of
them deletes a row, but a row policy decides which rows somebody sees and a quota
decides how many queries they get, and those are the same kind of decision as a
grant. Every statement is *built* rather than typed, and each of the three had a
reason:

- **A row policy with no `TO` applies to nobody.** `CREATE ROW POLICY p ON t
  USING tenant = 'c'` reads like "restrict this table to tenant c" and does
  nothing at all: the server stores it with an empty apply-to list, the statement
  succeeds, every account still sees every row, and nothing anywhere reports it.
  Measured. So Flint refuses to create one, and the form carries that sentence
  rather than letting the server say nothing — the same rule as refusing to make
  a user with no password.
- **A quota's intervals need a comma the grammar does not insist on.**
  `FOR INTERVAL 1 minute MAX queries = 60 FOR INTERVAL 1 hour MAX queries = 1000`
  is accepted and **keeps only the last interval**, silently. The development
  fixture was written that way once and read back with one interval where two
  were meant. Building the statement is what makes that impossible: a quota made
  through Flint came back with `durations: [60, 3600]` and each ceiling on the
  right interval. The form goes further and folds two ceilings over the same
  window into one interval, because sending them as two intervals of equal length
  loses one the same way.
- **`READONLY` going out is `writability = CONST` coming back.** Two vocabularies
  for one fact, so the checkbox says what it does — "cannot be changed" — rather
  than picking a side. Verified by writing one and reading it back.

The form validates what the backend refuses, so the button carries the reason
instead of the request being turned away after the fact: a window that is not a
window, an interval that caps nothing, a dimension the server does not have (all
eleven are the same words `system.quota_limits` uses for its columns, which keeps
one vocabulary across the read and the write). And only what SQL wrote can be
dropped by SQL — the same `storage` rule the user and role controls follow.

Verified through the browser: a policy created from the form took `probe_none`
from three rows to one, and dropping it gave them back.

**`ALTER USER` beyond the password is there**: the expiry, the hosts, and which
roles are active by default. Each was worth building because each has a way of
going wrong that nothing reports, and all three were measured:

- **A `VALID UNTIL` in the past locks the account out now**, and the server
  reports it as `AUTHENTICATION_FAILED` — "password is incorrect, or there is no
  user with such name". So somebody whose account expired is told their password
  is wrong. `infinity` is the server's own word for never and is stored as the
  epoch, which is what the read side already documents.
- **A host restriction that excludes where the account connects from locks it out
  the same way**, reported the same misleading way.
- **`DEFAULT ROLE NONE` leaves every granted role in place and inert.** A user
  holding a role that grants `SELECT` on `system.parts` lost the read entirely —
  `Not enough privileges` — with the grant still in the list. The panel says so
  rather than leaving it to be found.

And the guard those two lockouts earn: **aimed at the account this request is
signed in as, both are refused rather than confirmed.** That is Flint locking
itself out of the server, and the next thing anybody would see is a login screen
blaming their password. A confirmation is for a decision, and this is not a
decision anybody makes on purpose from here — so the refusal names the account,
says what would happen, and says to do it from another one. The date is judged by
the *server's* clock rather than Flint's, because it is the clock that will
enforce it.

Widening is not narrowing: `HOST ANY` on your own account is allowed, and an
empty host form says it means that rather than meaning nothing.

**Altering the three in place is there**, and the reason is measured rather than
argued: `ALTER QUOTA … MAX queries = 2000` keeps what has been consumed — five
queries against the new ceiling — where `DROP` then `CREATE` resets it to **zero**.
So raising a ceiling the second way silently forgives everything spent so far, and
for a row policy the drop leaves the table unprotected between the two statements.

Two things the work found, both by reading the server rather than the grammar:

- **`ALTER` means two opposite things under two nearly identical shapes.**
  `ALTER SETTINGS PROFILE p SETTINGS max_threads = 8` **replaces the whole list**
  — a profile with three settings came back holding one — while
  `ALTER QUOTA q FOR INTERVAL 1 minute MAX queries = 20` **amends**, leaving the
  hour interval exactly as it was. So Flint sends the whole picture every time,
  the form is pre-filled from what is actually there, and the asymmetry stops
  being something anybody has to know. Verified by changing one setting of three
  through the browser and reading all three back, the other two with their `MIN
  1 MAX 120` and `CONST` intact.
- **A direction can only be claimed where it is known.** The first version of the
  job label said "this takes access away" about every alter, including raising a
  ceiling from 1000 to 2000 — which widens. Flint does not hold the previous state
  to compare against, so an alter now says it *changes* what those accounts may
  do and does not claim which way. A create still says it takes access away,
  because that much is knowable from the request alone.

**B6 is complete.**

### B7. Configuration and Versions — **built**

Infrastructure → Config: the effective configuration, what a statement here
would run with, and eight `SYSTEM` statements at `admin` tier. Flint reads
configuration and asks for a reload; it does not edit the files, which belong to
whatever deploys them.

Four things the work settled, three of which were measurements rather than
decisions:

- **`system.settings` is not the server's configuration.** It answers for *this
  connection*, and Flint attaches settings to every statement it sends — so a
  naive read reports Flint's own timeout as the machine's config. Not
  hypothetical: with `max_execution_time=17` on the request the table answers
  `17, changed`. The names Flint sends are published as one constant and
  subtracted, and the page lists them apart. The first version of that list held
  only "settings somebody might plausibly configure" and left out `log_comment`
  — which promptly appeared on the configuration page reading
  `flint:introspection`, presented as this server's own. The test is now *did
  Flint send it*, and nothing else.
- **`changed` means written down, not different.** 24 of the 46 written server
  settings on a stock dev server hold exactly the value the server would have
  used anyway. That makes the list "what your config files say", which is the
  more useful fact — and the inert half is itself a finding about a file somebody
  is about to edit, so it is separated and counted rather than mixed in.
- **The restart note belongs on the minority, and the minority is the other
  one.** 39 of 46 written settings need a restart, and 336 of all 439 — so a
  "needs a restart" column repeats down almost every row and says nothing. The
  seven that take effect on a reload are what somebody can act on today, and
  those are the ones flagged.
- **`SYSTEM STOP MERGES` has no light.** The server exposes no flag: the `Merge`
  metric reads zero whether merges are stopped or merely idle, and no system
  table records it — verified by stopping them and looking. Hiding the switch was
  not the answer, since stopping merges is a real thing to do during a heavy
  import. Saying so was: the panel states that nothing on the page will look
  different afterwards, and that the job row — who pressed it, and when — is the
  only record there is. Flint's own bookkeeping is the state the server does not
  keep.

The eight commands are published by the backend with the sentence each one warns
under. The first version kept a second copy of those eight paragraphs in the
frontend, which made the Rust compiler call the originals dead code — a useful
way to be told that a warning had been duplicated and would eventually differ
from what the button does.

**The `compatibility` line, and what verifying it found.** That line was written
and never seen with a value on it, which is a claim in the product with no
evidence behind it. Pointing Flint at an account whose profile set
`compatibility = '24.8'` found two things, one of them much larger than this
page:

- **Flint could not read an error from such a server at all.** `compatibility`
  below 24.9 turns on `http_write_exception_in_output_format`, so ClickHouse
  writes the exception *inside* the JSON body instead of as the body. Flint's
  parser looked for `Code: ` at the front of the body, found nothing, reported
  code 0, and dragged the JSON tail along with the message. That is not
  cosmetic: `Reach` classifies by code — 497 a missing grant, 60 a missing table,
  139 an unconfigured Keeper — so at code 0 every "this user needs SHOW QUOTAS"
  and every "this server has no system.text_log" on every page collapsed into
  one opaque 500. On exactly the servers this page exists to warn about. The
  parser now reads the exception wherever the server put it, and reads it by
  finding `Code: ` rather than by requiring it first, since a streaming format
  appends the error after whatever it had already written.
- **The page could not say what the line was responsible for.** 392 settings
  differ on such an account, which is unreadable and, presented as "set for this
  account", false — nobody chose them. The attribution is now exact rather than
  inferred: the same read again with `SETTINGS compatibility = ''` for that one
  query, and whatever stops differing was the line's doing. 384 of the 392, on
  this fixture. They are counted and not listed, so the one setting somebody did
  choose is visible.

Both were found by building the fixture rather than by reasoning: it is in
`contrib/dev-access.sql` as an account to point Flint at, not a setting on the
server, which would change how it answers everybody.

**Which ClickHouse this actually is**, from `system.build_options` — seventy-six
rows of build variables, of which four things answer questions nothing else on
the server answers:

- **Whether it is an official build.** `VERSION_OFFICIAL` holds
  `" (official build)"` on one and is *empty* on anything else, which is the only
  reason to read that column rather than the version string beside it. A version
  alone is not an identity: two servers both reporting `26.7.5.10` can be a
  release and somebody's branch, and the commit is what tells them apart.
- **What kind of build.** A `Debug` one is several times slower for reasons no
  query plan explains, and `WITH_COVERAGE` on is the same class of surprise.
- **Which timezone database it was built against.** `TZDATA_VERSION` decides what
  every `DateTime` conversion returns, and a stale one is wrong *quietly* — no
  error, just the wrong hour for a zone whose rules changed. It is on the line
  beside the compiler rather than in a footnote for that reason.
- **Which optional features were compiled out.** Forty-four `USE_*` flags, and
  the ones that are off are the answer to "why can this server not do that" — a
  build without `USE_AWS_S3` cannot back up to S3 and says so nowhere else. On
  the official build all forty-four are on, and the panel *says* so: an empty
  list reads as a failure to look rather than as an answer.

The flags are spelled three ways — `1`, `ON`, and absent — so their opposites are
`0`, `OFF` and empty, and all of them mean the same thing. Both spellings are in
use on one server, which is why the check takes all three.

**Honest limit:** the panel is quiet on an ordinary server, which is the design,
and the four verdicts that make it speak up are covered by unit tests only. Every
one of them needs a ClickHouse that is not an official release build, and unlike
the `compatibility` account or the emptied Keeper there is no fixture for that
short of compiling one. The *blocked* path is verified against the
narrowly-granted user, and the flag parsing against the real values.

The deprecated-settings sweep is already there and did not need its own work: the
Config page puts the obsolete-and-set server settings first, and the session
settings carry ClickHouse's own `tier` — `Production`, `Beta`, `Experimental`,
`Obsolete` — as a badge on anything that is not Production.

**B7 is complete.**

### B8. Audit — **built**

Every action Flint took, who took it, under which tier, and what the server said
— and it stayed a *read*, which was the point. Signing in with ClickHouse
credentials meant every statement already arrives attributed, and every long
operation already writes a row saying who submitted it and under which tier. A
third record beside those two would have been free to disagree with both.

`src/clickhouse/audit.rs` reads them together: the job table for operations, and
`system.query_log` filtered to Flint's own `log_comment` tags for calls on a
published endpoint and reads of a dataset. One trail, newest first, because what
somebody wants from an audit is the order things happened in.

**What it does not hold is said on the page**, not in the documentation.
Statements typed into the editor carry no mark of Flint's, so this cannot tell
one from the same person's `clickhouse-client` — and the question that answers
("is my colleague's query missing because they ran none, or because this does
not show them?") is asked while looking at the screen. The two halves also
report their obstacles separately: a grant on `system.query_log` and a missing
workspace are fixed in different places, and one merged "unavailable" would hide
whichever half still worked.

`contrib/dataset-check.mjs` verifies it end to end — a read is made, the log is
waited on, and the trail has to hold that read under the right name. It found the
misdiagnosis worth recording: asked as a user who may not read
`system.query_log`, the report said *"this ClickHouse version has no
log_comment"*, because an unreadable table returns an empty column list and the
column was tested before the grant. That is the exact failure `diagnostics.rs`
warns about in its own opening — telling somebody their server is too old when a
grant is missing — and it took a narrowly-granted account to see it, which is
what that account is in the fixture for.

**Two clocks, and a page that did not say which one it was showing.** Writing a
check that no entry is dated in the future turned up the frame problem behind
it: an audit timestamp is naive and in ClickHouse's timezone, and JavaScript
parses a naive string as *local*. Here ClickHouse is UTC and the machine is
CEST, so every entry looked two hours old and the check passed by the luck of
the sign — pointed at a ClickHouse an hour ahead, it would have called a healthy
server broken. It compares against the newest thing the server has recorded now,
which is a bound in the server's own frame.

The publish form had it a third time, at the end where the value is *entered*:
somebody types an expiry meaning their own clock, and ClickHouse compares it
against its own. An endpoint retiring two hours early is not something anybody
debugs — they find it gone. The field is labelled `EXPIRES UTC` now, and the
hint says which clock reads it.

The page had the same gap and it matters more there: on the one screen about
*when* things happened, an unlabelled timestamp two hours off the reader's watch
lines an incident up against the wrong rows. The column says `When UTC`, from
`/api/server` — the Reports page already names the server's timezone for the
same reason, so this is a convention the product had and this page had not
joined.

**A zero that would have taken the cap off.** `limit: 0` was clamped up to one,
served a row nobody asked for, and said so in `limit_asked`. Honest, and still
the wrong answer — and the clamp turned out to be doing more than tidying:
`QueryOptions::max_rows` reads `0` as *no cap at all*, so a zero threaded past
it would take the row limit off the statement. The floor is load-bearing, which
is now written where it is. It is refused instead, pointing at `count` — the
field somebody sending `limit: 0` is usually reaching for. The published face
already refused it, in its own words; the two surfaces now agree.

**An endpoint that ends had not been told to say so.** The README promises every
endpoint documents itself, and expiry arrived without joining that promise: the
schema did not carry it and the OpenAPI description did not mention it. A client
generated from that document is exactly the thing that will still be calling on
the day the endpoint stops, and the 404 it gets is the same one a wrong address
gives. Both say it now, and an endpoint with no end carries no field for one.

**And "who" had to be made true.** The log carries one name per statement, and
for a published endpoint that name is the account Flint connects as — not the
caller, who held a token and is not identified anywhere. Printed under a column
headed *Who* on a page headed *Who did what*, it said a named person made calls
they may never have heard of. That is the one misstatement an audit cannot
afford. The two facts are separated now: the Who column says `token holder`,
and the account moves beside the verb, where the tier already sits — both answer
*how*, and Who has to stay the answer to *who*. It needed no change to the wire:
`kind` already said which rows were which.

**And it found a leak in the published face, which is not its half of the
product at all.** The audit trims a ClickHouse exception before showing it, for
the same reason `routes/data.rs` does: the tail of one is the statement it
failed on, and a published endpoint's statement belongs to whoever published it.
Writing that trim revealed that the original had a list of markers — `In scope`,
`While executing` — and that ClickHouse does not agree with itself about their
case. It writes `in scope` lowercase for an unknown table, which the list did
not know, so **an anonymous caller received the author's own SQL**:

```text
Unknown table expression identifier 'vault_of_secrets'
  in scope SELECT secret_value FROM vault_of_secrets. (UNKNOWN_TABLE)
```

Two readers wanted one rule and each had grown its own copy of the list. There
is one now — `clickhouse::statement_starts_at`, matched case-insensitively —
with a test on each side and a check in `api-check.mjs` that publishes a broken
statement and reads the refusal back.

**A boolean that was wrong by one.** An entry ended `ok: bool`, and a job has
four states — `running`, `done`, `failed`, `interrupted`. Everything that was
not `done` came back false, so a job *still going* was reported as a failure and
the page painted it a refusal. The job runner deliberately refuses to call an
interrupted job either done or failed, for a good reason — the server very often
finished the statement after Flint stopped watching — and a boolean cannot hold
that.

There are three answers, so there are three: `ok`, `failed`, `unfinished`. A
call is only ever the first two; an operation can be any of them. Nothing is
badged on the page for `ok`, because a trail where every line carries a badge is
one where the badges stop being read.

**A count it could not know, removed.** The truncation note read "showing the 200
most recent of 400 entries" — where the 400 was simply twice the page, because
each half is asked for a page and no more. The sum of two capped halves counts
nothing. On a server with a thousand tagged calls in the window it read as a
quiet week that had been tidily summarised, which is the failure the house rule
about counts is meant to prevent and a worse version of it: a fabricated total
is harder to distrust than an absent one. Each half is now asked for one row
more than the page, so "there is more" is a fact, and no total is claimed.

Two things it changed elsewhere. A shaped dataset read describes the dataset
before running it, and that describe was tagged as introspection — so a caller
refused for lack of a grant produced *nothing attributable*, which left the audit
blind to the one event it is most read for. The describe now carries the dataset
tag, and the audit drops the successful ones by `query_kind` so a call is still
one line. And the server's own words are kept here deliberately: an API refusal
is translated before it leaves Flint, because a caller was never shown the
schema; an audit is read by whoever runs the server, about their own server, and
`Not enough privileges … SELECT on system.users` is the answer rather than a
leak.

---

## Placements still to settle

Honest gaps in the tree above, rather than decisions quietly made in code later.

- ~~**Reports**~~ **Decided: Data, beside Dashboards, at `/reports`** — where it
  already sits, now with a reason rather than by default. Folding it into
  Dashboards was the alternative and it is wrong for one concrete reason: a
  dashboard is a thing you open and a report is a thing that arrives. They share
  a section format and nothing else — a dashboard has no schedule, no delivery
  and no history of past runs, and a report has no layout. One page for both
  would have to hide half its controls on every row.
- ~~**Diagnose has to be cut in two.**~~ **Done.** The server's own condition —
  running work, merges, disks, partitions — is Infrastructure's Health page;
  what statements cost is `/diagnose`, under Data by the URL rule, and the three
  views that moved redirect. One `diagnostics.rs` serves both, which was always
  the plan.
- ~~**"What may I see"**~~ **Built**, under Data on the server page, read-only,
  with arranging access left in Infrastructure. Five things had to be measured
  first, and each decided part of it:

  - **`SHOW GRANTS` answers where `system.grants` refuses.** A user without
    `SELECT ON system.grants` — the ordinary case, and precisely the person
    asking — gets `Code: 497`. `SHOW GRANTS` answers the same user, because it is
    about them. So the panel reads the statement, never the table.
  - **A revoke is a row.** `SHOW GRANTS` returns *statements*, and some take
    something away: `REVOKE SELECT ON analytics.orders FROM probe_cols` sits in
    the same list as the grants. Printed under "what you may see" it says the
    opposite of what it means, so revokes are a separate table with its own
    heading.
  - **A role hides its grants**, and `SHOW GRANTS` shows only that you hold it.
    `SHOW GRANTS FOR <role>` answers for a role you actually have and says
    `Code: 511 … There is no role` for one you do not — so the roles come from
    `system.enabled_roles` (which says *switched on*, not merely granted) and are
    expanded one at a time.
  - **The column is named after the statement**: `GRANTS` for your own and
    `GRANTS FOR analyst` for a role's. A fixed field name read the first and
    silently failed the second — which it did, and the roles lost their grants
    while the panel looked complete.
  - **One privilege arrives by two paths.** `probe_a` holds `SELECT ON
    analytics.*` directly *and* through `analyst`. Two rows have the reader count
    twice, so they fold into one that names both — which is also the answer for
    somebody who loses a role and keeps the access.

  And the fact that makes the panel worth having: **ClickHouse filters the system
  tables rather than refusing them.** A user holding nothing gets 200 from every
  endpoint on the server page and a perfectly empty inventory. There is no error
  to explain the absence, which is why the absence needs explaining.

  `WITH IMPLICIT` was tried and dropped: it turned two rows into seventy-one,
  sixty-nine of them `GRANT TABLE ENGINE ON <engine>` — identical on every server
  and never the answer to anything.
- ~~**Alerts on system metrics**~~ **Built to the rule that was stated: where an
  alert is listed follows what it queries, not who wrote it.** The placement is
  decided by asking ClickHouse — `EXPLAIN QUERY TREE` analyses without running
  and names every table it resolved, which is what makes this a measurement
  rather than a regex over SQL. Four edges measured before relying on it:

  - **A join names both**, and a **CTE is not skipped** — its table sits several
    levels down the tree, so the whole tree is read. Stopping at the first level
    would call an alert built on a CTE "reads nothing".
  - **An unqualified name is resolved** against the alert's own database:
    `FROM events` with `database=analytics` comes back `analytics.events`. That
    resolution is exactly what a text scan cannot do, and it is the ordinary way
    people write an alert.
  - **A table function names no table.** `merge('system', …)` really does read
    tables and the tree does not say which — so it is *unplaceable* rather than
    empty, appears in **both** lists marked, and says why. Dropping it from both
    would make an alert that is switched on invisible everywhere.
  - **`EXPLAIN QUERY TREE` does not check grants.** It answered for a user with
    no privilege on the table. Safe to run on somebody's behalf here, useless as
    an access check anywhere else.

  A statement reading a user table is **Data** even where it also reads
  `system.*` — the user table is the subject, the system table is context. The
  reverse is not symmetrical: `system.*` alone has no subject in Data at all.

  It also caught a real mixing of the two spaces that was already shipped. The
  nav badge counts the items whose destination is in each space, and every
  unhappy alert was sent to `/alerts` — so an operator's firing alert on
  `system.replicas` raised a number on **Data** and pointed at a list that (now)
  does not contain it. Watched before and after with a firing alert in each
  space: Data 2 / Infrastructure 0, then Data 2 / Infrastructure 1.

  Asked per alert rather than stored with it, because the answer changes under a
  stored alert: drop the table and the same alert becomes unplaceable — which is
  also how the list now shows an alert that is *on* and cannot run.

---

## Sequencing two tracks

The failure mode of two tracks is alternating between them and finishing
neither. Two suggestions:

**B0 and B1 are done.** Identity landed first, because it is what makes any write
attributable; the job runner second, because everything long depends on it. Both
are in place, so the next release can be a whole track rather than a foundation:
A1's mutations, A5's batching and B2's `SYNC REPLICA` all now have somewhere to
run.

**Then commit to one track per release.** Data is closer to done and it is what
the brief promised; Infrastructure is where the ambition is. Finishing A1–A3 makes
Flint the best ClickHouse explorer that exists. Starting B2–B3 makes it something
nobody has built. Either is a good next release. Doing halves of both is not.

---

## Starting without a server — **built**

`FLINT_CLICKHOUSE_URL` unset and Flint boots connected to nothing: it opens on a
form asking where to go, and the browser names the server at sign-in.
`docker run -p 8080:8080 flint`, with no environment at all, is a working Flint.

Why it fits rather than fights the shape above: the connection was already
per-request. B0 made every statement run as the signed-in user by cloning one
`Client` with their credentials, so carrying the *endpoint* down the same path is
the same mechanism with one more field — `Client::as_user` stayed the single
funnel through which a request acquires both who it is and where it goes.

What it costs is the half worth writing down, because none of it is a policy
anyone chose:

- **Signing in is required**, whatever `FLINT_AUTH` says. The endpoint arrives
  with a session, so there is nothing to connect *as* until somebody signs in.
- **Nothing runs on a schedule.** Alerts, reports and jobs run with nobody's
  browser open, and a schedule has no session to borrow a server from. So
  `FLINT_WORKSPACE_DATABASE` is refused alongside an unset URL rather than
  quietly ignored, and an unpinned Flint is stateless by construction.
- **The endpoint is an address from a browser that this process then dials**,
  which is the shape of an SSRF. `src/target.rs` vets it and `FLINT_TARGETS`
  narrows it; empty means any, said as a warning at boot rather than left to be
  assumed. The fence checks the host as written, not as resolved, and says so.

## Many servers, if it is ever asked for

Not the section above. Unpinned mode holds *one* server per session, in memory,
for as long as the session lives — it moves the question "which ClickHouse" from
the manifest to the sign-in form and stops there. And the session lives in a
cookie, so it is one server per *browser profile*: a second tab opens on the
server the first one chose, and signing out and in elsewhere moves both. That is
the line. Everything below is what it would take to cross it, and none of it
exists because unpinned mode does:

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
  stay named as ClickHouse names them — *in the product*. A7.7 draws the one line
  where that stops: someone calling the API is not a user of the product, has not
  been shown the schema, and should not learn the substrate from an error
  message. Naming things as ClickHouse names them is a promise to the person
  looking at the screen, not to every client of the wire.
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
