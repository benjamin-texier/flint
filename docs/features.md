# What Flint does

*[← back to the README](../README.md)*

Every feature, in the order somebody meets it. This is the long form; the
README carries the summary.

The first part is a walkthrough of the Data space, in the order somebody
meets it — schema, query, results, what Flint keeps. The sections below have
their own headings:

- [Which of the disk is doing any work](#which-of-the-disk-is-doing-any-work)
- [Who this server has been working for](#who-this-server-has-been-working-for)
- [The same data, held twice](#the-same-data-held-twice)
- [Long operations](#long-operations)
- [What the server has been doing](#what-the-server-has-been-doing)
- [Changing a table's shape](#changing-a-tables-shape)
- [Making a table](#making-a-table)
- [Where data is allowed to live](#where-data-is-allowed-to-live)
- [Which ClickHouse this is](#which-clickhouse-this-is)
- [What this server is running with](#what-this-server-is-running-with)
- [Backups](#backups)
- [Where a table's rows actually are](#where-a-tables-rows-actually-are)
- [Whether a streaming table is actually moving anything](#whether-a-streaming-table-is-actually-moving-anything)
- [Whether the address answers](#whether-the-address-answers)
- [Everywhere this server reads from](#everywhere-this-server-reads-from)
- [How a table got here](#how-a-table-got-here)
- [Reviewing a table's schema](#reviewing-a-tables-schema)
- [Which projections the workload argues for](#which-projections-the-workload-argues-for)
- [Parts that are on the disk and not in the table](#parts-that-are-on-the-disk-and-not-in-the-table)
- [The cluster, from one node](#the-cluster-from-one-node)

**What changed, before you ask.** Each space's board opens with a band that
answers the question nobody types, because it is the one you have before you
have a question: *is anything different today*. Not an inventory — a verdict, a
handful of rows, each a subject, a sentence and the measurement behind it:

```text
UNKNOWN_QUERY_PARAMETER  started failing statements that were not failing before   25 failed
UNKNOWN_IDENTIFIER       failed far more statements than it usually does   1,143 against 2 usually
analytics.raw_hits_v2    took its first rows in this window                300 K rows, 2.3 MiB
```

Four things are read: what statements cost, what failed, what was reshaped, and
what was written. None of that is new — Flint was measuring all four already,
and each of them lived on the page you had to already suspect. What was missing
was anybody saying it out loud.

**Nothing is stored to make it work.** `system.query_log` and `system.part_log`
carry their own history, so "different from usual" is a read rather than a diff
against a snapshot Flint kept. A Flint installed ten minutes ago answers this as
well as one installed a year ago, and it needs no workspace database: it is a
read of the server, not of anything Flint owns.

**The baseline is the week, not yesterday.** The span is cut into seven equal
periods and the newest is judged against the median of the six behind it. A
single before-and-after pair reads every Monday as a collapse of Sunday, and it
cannot tell a daily ingest that stopped from a seed load that was never going to
repeat — which is the one headline here that nothing else in Flint would ever
have given you. A table that stops taking rows keeps serving reads and every
dashboard on it keeps drawing, so the first symptom of a dead pipeline is
normally somebody asking why last week's number has not moved.

That comparison is also what makes the silence trustworthy. For a median to be
above zero, more than half the periods have to have had something in them — so
*was written most days and took nothing today* needs no second test, and a table
loaded once six days ago never qualifies. A period the log does not wholly cover
is unknown rather than empty, and counting those as zeros would manufacture a
decline out of a retention limit; so they are dropped, the caption states what
the comparison actually stood on — *the last 24 hours, against the 5 days
before* — and below three covered periods the band says why it cannot judge
instead of guessing from one sample.

Two things it will not do. It does not quote a multiplier its baseline cannot
carry: an error seen 366, 109, 1, 2 and 0 times over five days has a median of
2, and 1,141 of them today is arithmetically **571×** and editorially nonsense,
so past twenty it says *far more* and lets the figures beside it hold the truth.
And it does not report the statement that dominates this server every day — true,
and not news. A share gate and a movement gate, and neither is enough alone.

Flint's own traffic is excluded, by the tag every internal statement carries,
and so is the workspace database: a board that opens by announcing that Flint
migrated its own tables is a board nobody reads twice.

Each headline is filed by **where it sends you**, exactly as an unhappy alert
is. A statement's cost and a table that stopped taking rows are facts about the
data, so they are Data's; a reshaped object is Infrastructure's. That leaves the
split lopsided and the lopsidedness is right — and it means Data's board says
*nothing moved* when nothing did, while Infrastructure, which already opens with
a verdict of its own, gains a row only when the schema actually moved.

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

**A prompt on the database, on every page.** Bottom left, a small caret that
says `Console` when you approach it; `Ctrl+\`` opens it without the click. It
slides up from the bottom, and it is a *drawer*, not a page: the shell gives up
exactly the height it takes, so the bottom of a wide table is never underneath
it.

You do not close it, you hide it. The component is mounted outside the router
and is never torn down, so the transcript, the half-written statement, the
scroll position and a query still in flight all survive walking from a table to
a dashboard to the cluster page. A statement started in the console and left to
run reaches you as a pulse on the launcher, wherever you have got to.

It prints results the way `clickhouse-client` does — the same box rules, the
same `12 rows in set · 3 ms`, the same `use` — because that is the interface
anybody reaching for a prompt already reads, and a console that invents its own
shape has to be learnt twice. A wide result scrolls sideways rather than
dropping columns: this is the one surface in Flint where the answer is the whole
row. What it does *not* borrow is ClickHouse's habit of answering a typo with
eight hundred words of grammar — the sentence that says where the statement went
wrong is shown, and `Expected one of:` waits behind a control that says how much
of it there is.

`SET` works, and that took a decision. ClickHouse's HTTP interface has no
session, so a `SET` sent down it applies to the request that carried it and
nothing else — a console that forwarded one would answer `Ok.` and change
nothing about the next statement, which is the worst kind of bug. So the
console keeps the settings and puts them on every request it makes, says so in
the note it prints, and shows the count on its bar, because state you cannot
see is state that will surprise you. They are the *console's* settings and
nothing else's: not a dashboard tile, not an endpoint, not the same statement
opened in the editor, and reloading the tab drops them. The names Flint
attaches itself — `readonly` and `max_result_rows` among them — are refused at
the prompt, from a list the server publishes, because a deployment's own limits
must not be arguable with from a text box; and if a statement fails while the
console is carrying anything, the failure says what it was carrying, since the
second failure of a poisoned console looks nothing like its cause.

The console asks for two hundred rows, whatever the deployment's own cap is.
The transcript prints every row it is given as real DOM — a box drawn with
rules cannot be windowed without the rules lying about where the table ends —
so this is a limit on the drawer rather than on the question. It is stated
where it bites: *Showing 200 of at least 12,043 — add a LIMIT, or open it in
the editor*, and the editor is one click away on every entry, with the grid
that does window.

Semicolons split. A pasted script runs statement by statement and stops at the
first that fails — a script is a sequence, and the statement after the one that
failed almost always assumed it had worked — then says how many did not run.

`Ctrl+C` and `Stop` really stop it, which they did not until the console went
looking. `QUERY_WAS_CANCELLED` used to leave Flint as **408 Request Timeout** —
a status that reads correctly and is a trap, because 408 means *you* took too
long to send the request, and Chrome is entitled to retry a POST that gets one.
So Stop killed the query and the browser immediately started it again, for the
whole `max_execution_time`, with nothing on screen offering to cancel the
second one; what a reader saw was a statement that would not stop. It answers
400 now, with the ClickHouse code in the body where the UI already reads it, and
`src/error.rs` keeps four tests that say so. This was never the console's bug —
the editor's Cancel had it too, and nothing had noticed.

It is called a console rather than a terminal on purpose. There is no shell
behind it, no PTY and no filesystem; it is the connection Flint already holds,
exposed. Being a web view rather than a terminal emulator is what makes the rest
work: the completion is the editor's own — every table and column on the server,
narrowed to what belongs at the caret — and selection, copy and paste are the
browser's, so they behave the way they do everywhere else. `Ctrl+C` splits the
difference the way a terminal does: with something selected it copies, with
nothing selected it kills the running statement.

Unqualified names resolve in the database of the page you are reading, and
follow you as you move. `use` — or the picker in its bar — pins it somewhere
else, and says that it has, until the `⟲` gives it back to the page. What the
prompt may do is whatever the account you signed in as may do, which is the
answer the rest of the product already gives: it is not a second, wider door.

**Data has a home, and it is not an inventory.** Clicking `Data` in the bar
opens **Home**: what this workspace has been made to answer. The statements
people saved and where each one is now running — the endpoints publishing it,
the dashboard tiles drawing it — what those endpoints served over the last week,
and anything unhappy gathered at the foot. It is the mirror of Infrastructure's
board, and it lists Flint's own workspace rather than the server: nobody's first
question on opening Flint is which tables exist, because they built them.

The link between a saved statement and the endpoint serving it is *inferred*
from the statement text — nothing on the wire records that one was copied from
the other — so the page claims only what it knows, "where the same statement
also runs", and says `nowhere else` rather than anything stronger. A statement
published and then edited stops matching, which is the honest reading: those are
now two statements.

Home needs nothing. It used to need a workspace — it *was* the workspace board,
and that made Data's own name, on a stateless Flint, open the page explaining why
the page was not there. What the workspace keeps is a section of the arrival now,
which says its own absence there; `/home` still resolves, to `/`.

**And `/` opens on what Flint found.** Not an inventory screen and no longer the
schema either: connecting used to land on a database, which answers what *exists*,
and nobody's first question about their own server is what exists — they built it.
So `/` is a verdict, the findings behind it, and the schema one click on. It owns
nothing: every finding is one `/checkup` produces, drawn by `/checkup`'s own
component, and every figure comes from an endpoint that already existed. What is
its own is the *order* — failures first, then one finding from each of the four
areas in turn, because ranked by weight alone the list opens with eight storage
rows saying one thing.

It will not clear a server it was not allowed to read. Past half the readings
refused the headline stops claiming and the caption names which ones never voted:
on ClickHouse's demo account, where six of seven are refused, "nothing is wrong"
would have been a verdict on questions nobody was allowed to ask.

**The schema, drawn.** `/explore` — where `/` used to go — resolves a database (the one you were last in, else the fullest one that
is yours rather than ClickHouse's; `default` counts as yours, because that is
where a great many people keep everything) and draws it as the pipeline it is:
sources on the left, the materialized views that consume them next, the tables
those write into after that. Hover any object to trace its lineage; everything
unrelated fades. Click to open it.

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
seeing every field with a real value next to it. And the travelling dots on the
edges, which Kiali calls traffic animation, are a **reading** with a toggle: a
dot is rows that actually went through that pipe.

Two other Kiali ideas are deliberately left out, and one arrived late. Edge
labels still need a rate a schema does not have. Edge **health colouring** does
have one now, for the only edges that can: a materialized view is a pipeline
with a real throughput, and `system.query_views_log` says what went through it.
So the dots on an edge are the rows that moved along it in the window — spacing
carries the volume, against the same 90th-percentile scale as every bar in the
product, and the speed is constant, because two curves of different lengths
cannot be compared by how fast something crosses them. An edge nothing went
through holds still; a view whose target was dropped is drawn severed, in the
alarm ink, on both of its edges — the insert fails one hop before the view is
even reached. A plain view's edge never moves at all, because nothing travels it:
a view is rewritten into the query that reads it. Until that measurement existed
the animation was on every edge equally, which is to say it was decoration.
Its force-directed layouts would be a step backwards here: a
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

**And the same database on its other axis: time.** The diagram draws
dependencies, which are permanent and have no date in them — so `Time` swaps it
for the picture that does: one row per table, one column per partition, in
order, with the weight of each cell drawn. A TTL's cut-off, a backfill that
wrote six months in an afternoon, a hole where an ingest failed and a partition
carrying a hundred times the parts of its neighbours are all shapes here, and
none of them is legible in a total. A cell weighs bytes, rows or parts — three
different questions of the same grid, and the last one is where merge pressure
shows before it becomes a failed insert.

Two modes of one section rather than a second screen, because the value is in
changing point of view on the database you are already looking at. An empty
square is a partition the table does not have, drawn as an outline of nothing
rather than as a pale fill: "small" and "not there" are the two answers this
view exists to keep apart. The scale is the same 90th percentile the storage
bars use, so one backfilled partition cannot flatten a year of ordinary months.
And the order is the server's own: a partition id is an opaque string, name
order is chronological exactly where the key is a date expression, and the
caption says so rather than pretending to have parsed a date out of an
identifier ClickHouse never promised was one.

A daily-partitioned table three years old has a thousand partitions, which is
forty thousand cells and a texture rather than a grid. Two answers to that, and
they are different questions. The grid opens on the newest partitions and **moves
back through history a window at a time** — it has to move rather than simply
report what it dropped, because the old end is where a retention policy shows up
and a cap that put it permanently out of reach would cut off this view's best
answer. And the columns have a **scale**: partitions, days, weeks, months, quarters or
years, with the folding done by the server, because a thousand columns paged
through twelve at a time still never shows the shape of a year. The window's
width follows the scale rather than staying at one number — ninety days is a
quarter, fifty-two weeks is a year, sixty months is five — so paging moves by a
period somebody can name instead of by "120 columns", which is not a period at
all.

The client generates the columns between the observed ones, so the two sides have
to spell a bucket identically — one character of difference draws two columns for
one month, one with data and one permanently empty. Neither side could check that
alone: the Rust tests assert which date functions the SQL calls and the Vitest
ones assert what the TypeScript formats, and the comparison that matters needs a
real server, whose timezone and week start both get a say. So it is a live check,
in `make check-live`, cell by cell across all five scales — and it was verified to
*fail* by breaking one format on purpose, because a check that cannot fail proves
nothing.

The scale is built on the range the parts actually carry, never on the partition's
name — a partition id is an opaque string, and the rule that nothing here parses a
date out of one holds for the axis as much as for the ordering. That range lives
in one of two places and the difference matters: `min_date`/`max_date` are the
MergeTree's old Date-key columns and sit at the epoch on a table partitioned by a
`DateTime`, while `min_time`/`max_time` are the modern pair and sit at the epoch
on one partitioned by a `Date`. Reading only the first, which is the obvious
thing to do, reports half the tables in existence as undated — and did, until a
real server said otherwise. Where the server filled neither there genuinely is no
date, and those parts hold real disk, so they get an `undated` column of their own
rather than dropping out of a picture of the whole database. A database with no
dated part at all is not offered a scale it cannot draw: the control says so
instead.

**The axis is continuous.** At a scale of time the columns are every bucket
between the ends of the range, not only the buckets with something in them —
because without that, a month in which nothing at all was written has no column
rather than an empty one, the gap closes up, and the view loses the very thing it
claims to show. The server says where the two ends are and the client fills in
between, which is where date arithmetic belongs; the caption counts the stretches
that are empty everywhere, so a run of blank squares reads as data rather than as
a drawing that gave up. A range that would generate more columns than any page
can use — one part with a corrupt date, 1997 or 2242 — falls back to the buckets
that exist rather than hanging the page on ninety thousand columns.

On a daily axis a column head cannot hold `2026-05-27`: ten characters in a
cell's width arrive clipped to `2026-0…`, which is ninety identical headers and
no axis at all. So the head is the day — `05-27` — and the year goes in the line
above the grid, which has room for it: *90 of 107 days · 2026-05-27 to
2026-08-24*. Keeping the year on the first column was tried first, and bought a
clipped header instead of a legible one.

**And each row carries its own shape.** Ninety squares say where a table's data
is; they make you read across to answer the question people actually have about
a table over time — growing, flat, or stopped. So a sparkline sits beside each
name, over the same columns and in the same order, and both are drawn: the line
for the shape, the squares for the buckets.

It is scaled to that row's own peak, not to the grid's, and the legend says so —
a row flattened against its largest neighbour would only repeat what the squares
already say. A hole breaks the line rather than dipping through it, because a
bucket a table has nothing in is the absence of a measurement and not a
measurement of nothing; joining across it would draw a dive to the floor and a
climb back out, an event that did not happen. A single bucket between two holes
becomes a dot, since a segment of one point draws nothing at all. And the pinned
`undated` column is left out of the line entirely: an unpartitioned table's one
bucket is not the latest period, so a table with nothing in time has no line
rather than a dot floating outside the axis.

A table with no `PARTITION BY` keeps everything it has in the one partition
ClickHouse calls `all`, and that column is **pinned** beside the timeline rather
than placed in it. It is not a point in time; and without pinning it travels with
whichever window holds the newest partitions, so paging into history turns every
unpartitioned table into an empty row — which reads as *this table holds
nothing* about a table that holds all of it, one column to the right.

**And where its disk actually is.** `Mass` is the third reading: a treemap where
area is bytes, divided to the **column** — because a column store is the one
place where that is the honest unit, and a table that is 90% one `String` of
JSON is a completely different object from one whose bytes are spread evenly.
Neither of the other two views can say this: the diagram draws a three-terabyte
table and a four-row lookup as the same rectangle, and the object list carries
the figures but as a column of numbers to add up rather than a shape to see.

A block is the table's real size on disk — the same figure the headline above it
prints, because a picture that disagrees with the number over it is a picture
people stop believing. Colour is the **type family**, in the same vocabulary the
type badges use, so *all of this disk is one Nested* arrives before a single
label is read. What the columns do not account for — the marks and the primary
key index, which belong to none of them — is drawn as its own cell rather than
spread quietly over the ones that do, so a block's parts add up to the block.
The columns too small to see fold into one cell that says how many, because
thirty rectangles nobody can hover is not more information than one that counts
them: on `system.metric_log` that cell reads *1907 smaller columns*, which is
the honest description of that table.

**A projection gets its own cell.** A part's `bytes_on_disk` counts the projection
parts stored underneath it, so a projection's disk arrives inside the table's
figure and, before this, inside the marks-and-index cell — which on a table whose
projection is nearly a second copy meant a label naming the smaller of the two
things it held. Measured rather than assumed, and the small case is a trap: a toy
projection of 827 bytes sits under the noise between two identical tables built
from random data, and pointed at the opposite conclusion. A projection that is
nearly a full copy settled it — 4.41 MB on disk for 2.19 MB of columns and a
2.22 MB projection. It is drawn apart from the marks because it is a different
kind of fact: marks are the cost of storing the columns, a projection is a second
copy of some of them that somebody asked for.

A small table has no per-column sizes at all, and that is the server rather than
Flint: MergeTree keeps a *compact* part's columns in a single file, so ClickHouse
reports zero for each of them — truthfully. Those tables are drawn whole with the
reason on them and counted in the caption, because filtering them out would
quietly remove real tables holding real disk from a picture whose entire claim is
that it shows where the disk is.

**And which of them are actually used together.** The first three readings all
come from what the database *is*. `Together` is the one that comes from what
people did with it: every finished `SELECT` in `system.query_log` names the
tables it touched, so two names in one row were read together, and a week of
those is the coupling nobody declared. Tables down the side, the same tables
across the top, and a cell shaded by how often a statement named both.

The finding is the *difference* between this and the diagram, so the two are
drawn on the same cell rather than in two pictures: a ring means the schema
already declares a dependency between the pair. A heavy ringed cell is somebody's
view being read — the log records a view and its sources in the same row, so
those are expected and are most of them. A heavy cell **without** a ring is a
join performed constantly that no object in the database records, and that is
the cell worth finding. On the development database it is one cell wide:
`analytics.events` and `reference.cities`, joined across a database boundary that
nothing in either schema mentions.

The window is a control: **today, a week, a month** — three, not a slider,
because each answers a different question and a slider would let somebody ask for
eleven days, which answers nothing in particular. A day is what is happening now,
a week is ordinary work including whatever runs on Mondays, a month reaches far
enough to catch the report nobody remembers scheduling. Longer is deliberately
not offered: `system.query_log` is usually kept for weeks, so a ninety-day window
would quietly answer with whatever survived the TTL and call it ninety days. The
window travels in the URL (`&days=1`), and the sentence above the matrix names
the window it actually answered.

A matrix rather than a graph, deliberately. Co-access is undirected and full of
cycles, so the layered layout the diagram uses does not apply — and the force
layout that would is the thing Flint already declines, because it throws
away the ordering that makes a picture readable. A matrix has no layout to get
wrong. Statements naming more than eight tables are left out and counted, since
a dashboard refresh touching thirty would contribute 435 pairs on its own; and
the count of statements that named a single table is printed beside the total,
because on most servers that is the majority and a sparse matrix beside a large
number would otherwise read as a picture that failed.

**And what their column types are costing, as one decision each.** The four
readings above describe the database; `Review` is the one that proposes changing
it. A schema with a naming convention in it — `raw_x`, `raw_x_estimated`,
`raw_x_last_state` — does not have three problems with `occupancy_percentage`, it
has one, and reviewing the three tables in turn produces the same finding three
times and leaves somebody to notice that by hand. They notice by copying thirty
`ALTER` statements out one at a time, which is the work this reading exists to
delete.

The tables are chosen by a `LIKE` pattern (`raw_%`, `%_estimated`), because a
pattern is a rule and a column of ticked checkboxes is a snapshot: `raw_%` has
twelve tables in it today and thirteen next week, which is what a naming
convention is *for*. What it caught is listed under it and not merely counted —
in `LIKE`, `_` is a wildcard, so a pattern written to mean "the `raw_` prefix"
also catches names with no underscore at all.

Then three axes over one set of findings. You **read** by column: a group is one
column name and one proposed type, over every table that has it. You **choose**
by table, never by group, because the evidence is per table — three tables can
agree on the type and disagree on whether it was measured over every row, and one
of them can have the column in its sorting key, where ClickHouse refuses the
change outright. And it **emits** by table: one `ALTER` carrying every ticked
column, which is measured rather than assumed. Against 26.7.5, one `ALTER` with
three `MODIFY COLUMN` registers three rows in `system.mutations`, exactly as three
separate statements would — but `system.part_log` shows **one** `MutatePart`
against **three**. The mutation entries are per action; the rewrite is per
statement. Twenty-eight changes across five tables come out as five statements
and five passes over the parts, not twenty-eight.

Two kinds of member are shown with the column's problem intact and left out of
the SQL anyway, because neither is a change anybody can make to one table. A
column in the sorting or partition key, which ClickHouse refuses outright. And a
table a **materialized view writes into**: the view's `SELECT` is not part of the
target's DDL, so narrowing the target leaves the view casting into the new type
on every insert from then on — and a narrowing cast truncates rather than
refusing. The `ALTER` succeeds, the table looks right, and wrong numbers arrive
quietly until somebody looks. That pair changes together or not at all, and the
row names the view so it can be opened. It is read from the lineage the diagram
already draws, which the section above is explicit is largely *inferred* — the
right amount of caution for a refusal, since it is a reason to make somebody look
and never a claim that the pair is safe.

Nothing here runs DDL — this is the Data half of the product, and Data does not
write structure. A whole selection leaves as SQL you copy, with what you are
carrying stated in a comment at the top of it, because that block is the only
part of the page that reaches the terminal where it matters. A single change
leaves through the same link the projection advisor uses, into Infrastructure →
Schema with the operation filled in and not submitted.

The honesty rules of the per-table review survive the grouping or they were never
rules. A group is a verdict only when *every* member was measured over every row,
and it says how many were not. Bytes are summed only over the members whose bytes
exist — a table whose parts are Compact has no per-column size, and is counted
apart rather than folded in as zero. Nothing predicts a saving; the figure is what
those columns occupy today.

And a tick is an intention, not a frozen proposal. Verifying is offered over the
tables you actually ticked — priced before it is asked for, never over the whole
pattern — and it is *expected* to move some of them: a sample says a duration
column fits in a `UInt16`, reading every row finds the day somebody measured a
full 86,400 seconds, and the `ALTER` built from the stale tick would have
truncated the column. So the SQL is never built from what was ticked. It is built
from what those ticks resolve to against the findings as they stand, and what
moved is said above the block rather than applied quietly.

One thing falls out of what has already been read, and it is the only finding
here no per-table review could ever reach: a column name these tables do not
agree about. It is read from *every* column of every table reviewed and not only
the ones a rule flagged, which is the half that matters — `ts` being a `DateTime`
in five tables and a `DateTime64(3)` in the sixth fires no rule at all, because
each table is individually fine, and every join between them still casts.

Whether it is worth an alarm depends on whether the tables are variants of one
another, so they are grouped by how much of their shape they share — four fifths
of the union of their columns, single-linkage, so `raw_x`, `raw_x_estimated` and
`raw_x_last_state` stay one family across the columns that distinguish them. A
disagreement inside a family is **drift**, and one of those tables is simply
wrong; across families it is two unrelated tables sharing a common noun, which
every warehouse has and nobody needs told about. Both are listed, only the first
is marked, and the marked ones come first. No DDL follows from either, so none is
offered — it is somewhere to look.

Each reading is a **link**: `?view=time`, `?view=mass`, `?view=together`,
`?view=review&like=raw_%` on the database's own address — and the partition grid's scale travels with it, so
`?view=time&grain=month` is a picture you can send. The diagram and the server's
own grain are both left unwritten, so the plain URL means what it always meant. A particular way of looking at a database is a thing
people send to each other, and one that lives only in a component's state
cannot be sent.

**And the same grid one level up.** Every one of those readings is scoped to a
database, which leaves one question none of them can be asked: *which of my forty
databases is growing*. The server page answers it with the same grid, a
database where a table was — because "which of these is growing" does not change
shape when the things being asked about get bigger. The list above it already
says which is biggest, sorted, with a share bar; time is the axis that list has
never had.

`system` is in it. It is where a great deal of a server's disk actually goes, and
a picture of which databases are growing that quietly dropped the one growing
fastest would be worse than no picture at all. A row links to its database, its
figure is the partitions it holds, and it gets no "not partitioned" label — a
database has no partition key, its tables each have their own, so that sentence
under a database name would be a claim about nothing.

Each of the three readings that need a `system` table can be refused one, and
each says which: *this user is not granted SELECT on system.parts*, and so on.
Exercised rather than asserted — the development cluster keeps a narrowly-granted
account, denied `parts`, `parts_columns` and `query_log` at once, and every path
was rendered under it. The diagram carries on drawing all thirteen objects, which
is the claim those notes make about it.

**And what one column says about another.** The profile answers questions about
a column alone. `Relations` asks the next one, which nobody types because you
have to suspect the answer to ask it: *which of these columns are saying the same
thing twice*. Two passes over the rows, five kinds of finding — a **constant**
(one value in every row, costing disk in every part), a **mirror** (two columns
that are the same information, paired one to one), a **determination**
(`status_code` fixes `success`: ten values, and each always has the same
boolean), a **straight line** (r ≥ 0.99, so one number carries nothing the other
does not) and a plain **correlation**, signed, because moving opposite each other
is as strong a statement as moving together.

The test for a determination is `uniqExact(tuple(a)) = uniqExact(tuple(a, b))`:
if pairing `b` with `a` adds no combination, `a` fixes `b`. The `tuple()` is not
decoration — an aggregate skips NULL, so without it the two counts would be over
two different populations on any nullable column.

Two rules came out of measuring rather than reasoning. **A near-key determines
everything and means nothing**: on a real API log, `process_time` with 3,771
distinct values in 3,780 rows "determined" every other column, trivially, because
almost every row was its own group — so a column is only a candidate while it
groups the table into meaningfully fewer parts than it has rows. And **the
ranking is what makes a rule actionable**: sorted by what is *determined*, a
296-value column fixing a 4-value one came before `status_code` fixing `success`.
Sorted by how coarse the determinant is, the rule somebody could write down comes
first.

A seventh comes from the same pair of passes and is the cheapest of them all: a
**dominant value**. `method` is `GET` in 90% of the rows of a real API log,
`asgi_app` is one app in 95%, and `system.parts.refcount` is 1 in 99%. Below four
fifths a column merely leans; at four fifths it is a constant with exceptions,
which changes what an index on it is worth, what partitioning by it would do, and
whether a filter on it narrows anything at all.

The most common value is measured in the first pass and its share counted in the
second — the same shape as the fences, and for the same reason: an aggregate
inside an aggregate is refused. That value is the one piece of *data* that
reaches the second statement, and it travels as a bound parameter with the column
stringified to meet it. A table holding `'); DROP` in a `LowCardinality(String)`
is a table Flint reads like any other.

A sixth finding comes from the same two passes: a column whose values **reach far
past the rest of itself**. The quarters are measured in the first pass, the
fences they imply are worked out between the two — an aggregate inside an
aggregate is refused, which is the server saying the same thing — and the rows
beyond them are counted in the second. Tukey's far fence, three interquartile
ranges out rather than the more familiar one and a half, because on the skewed
distributions a database is full of — durations, sizes, counts — the smaller
figure flags a tenth of the table and says nothing.

And a share rules it: measured before it was chosen, those fences put 19% of
`system.parts.rows` and 10% of a duration column past the line. "Forty-two of
your two hundred rows are outliers" describes a skew, so past five percent the
finding is dropped — the tail is the distribution rather than an exception.

Each family gets a share of the list, which is not the single ranked list every
other view here uses. It had to change: sixteen numeric columns of `system.parts`
produce twenty-odd correlations, and ranked together they filled every slot — the
far-value findings, rarer and more interesting, never appeared at all.

It is asked for, never automatic — it reads every row twice, and spending that
before anybody asked is not a courtesy. Mirrors are transitive, so four columns
arriving as six pairs are folded into one finding. And where the table is small
the view says so: on a few hundred rows, one column fixing another is easily
coincidence, and that is the reader's to weigh rather than Flint's to hide.

**Infrastructure opens on a board, not on a workbench.** `/infra` used to
redirect to Health, which is the busiest page in the product — running queries,
merges, disks, errors, logs. That is the right page for working on a server and
the wrong one for finding out whether you need to. The board is one row per
section, each carrying the figure that makes it checkable: *1 disk · 159 GiB free
on default, 17% of it*, *no replicated table on this server*, *2 accounts, all
with a password*, *no destination configured here, so Flint takes no backups*.

One rule shapes every row: **a thing that could not be read is not a thing that
is fine.** A board showing green for a section whose grant was denied, or whose
request failed, is worse than no board — it lies in exactly the situation
somebody built it for. So "could not be read" is a standing of its own, it
carries the server's own words, and nothing in the page can turn an absence into
`ok`. A section still being fetched is a third state, because a row that is
merely slow must not look like one that is blind.

It proved itself on the first render: `/diagnostics/pipelines` answered 502 on
the development server, and the board said so on one line while the other seven
sections carried on. The cause was a refreshable view that had never succeeded —
`system.view_refreshes.last_success_time` is nullable, and `toString` of a null
is a null where a string was expected.

Quiet is the good answer. A settled row states its fact and stops; it takes no
colour and does not congratulate anybody. An indicator that is always lit is not
an indicator.

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

**One query page, two ways to write one.** The Query page carries a switch, per
tab: **Form** or **SQL**. Not two pages — the same database picker, the same Run
and `⌘↵`, the same Stop, the same statistics, the same grid, the same charts,
the same Save, Send to…, Explain, History and download sit under both, because
they are the same code. What changes is the surface above them.

The form is two panes. On the left the question, as a stack of clauses in the
order SQL writes them — `from`, `show`, `where`, `having`, `order`, `limit`, and
the timezone when there is a day boundary to place. Each one is a single line
until it holds something, so a fresh question is five short lines rather than a
band of empty sections. The keywords are the same words the clause strip under
the results uses, deliberately: same question, same vocabulary, whichever face
the tab is wearing.

On the right the table's columns, searchable, with the ones in the sorting key
underlined and a count of what is not being shown — `15 of 17 columns · 2 already
in the question`. That pane gets the room because that is where the clicking
happens: `hits` is 105 columns wide, and a wall of 105 chips is a wall whichever
column of the band it sits in.

The generated ClickHouse SQL is on screen the whole time with the question
written out in English above it. Choosing a column with no aggregate makes it a
grouping, so `GROUP BY` writes itself. Everything you type is encoded rather than
interpolated: a value of `' OR 1=1 --` becomes a string containing that text.
Relative times like `now() - INTERVAL 7 DAY` pass through unquoted, but only by
matching a closed grammar — `now() + INTERVAL 1 DAY` does not, and becomes a
literal.

**A fresh tab offers questions rather than explaining the keyboard.** What used
to be a grey card in a very large empty rectangle is now the table's own first
questions — how many rows, a hundred rows of it, rows by the hour on its
timestamp, the commonest value of its lowest-cardinality column — each with the
statement it will run printed on it before it is pressed. Only questions the
columns can actually answer are offered: no hour bucket on a table with no
timestamp. Under them, the last few statements this server was asked, out of
`system.query_log`. A blank SQL tab has no table to be about, so it offers the
two statements a fresh console is always for instead: what is in this database,
and what is running right now.

**The page is two blocks, not six bands.** The composing band, the tabs and the
clause strip are the question; the figures — rows read, bytes, elapsed, returned
— are the head of the answer, which is a card on the ground underneath. The
figures used to be a band of their own *between* the statement and its own
clauses, so the page read question, how-it-went, question again, answer.

**The switch is honest about the one direction it cannot go.** A form always
becomes SQL. SQL becomes a form again only while it is still the statement the
form wrote — nothing here parses SQL back into a spec, and a switch that
pretended otherwise would be the mode switch that eats your work. Type one
character over a generated statement and the Form side greys out with the reason
on it. The form is not discarded, though: undo the edit and the way back opens.

**And the grid edits whichever one you are in.** A click on a column header
sorts, a cell filters, a column can be dropped — in SQL that rewrites the text,
and in the form it edits the form. The form knows something the text does not:
a filter on a total belongs *after* the grouping, so it lands in `having` by
itself. Where it cannot express a gesture it says so rather than
doing nothing — filtering `ts_day` is refused with "it is `ts` folded by day,
and a filter runs on the rows before the folding".

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

**SQL editor.** Multiple tabs, statement-at-caret execution (`⌘↵` / `Ctrl+↵`) so
one tab can hold a scratchpad of queries, cancellation of a running query, and
execution statistics — rows and bytes scanned, elapsed time — for every run.

**Completion that only offers what would work here.** The old completion was a
dictionary: every table on the server and every column of every table, offered
everywhere, which will happily complete a column of `system.parts` into a query
that reads `events` and has nothing at all to say about the word `GROUP`. So the
question it answers is narrower — where in the statement is the caret, what does
the statement read from, and what would be *legal and useful* in that position.

In a `WHERE`, this table's columns with their types, before ClickHouse's
functions. After `FROM events`, the clauses this statement has not got yet, in
the order you would write them: `PREWHERE`, `WHERE`, `GROUP BY`, `ORDER BY`,
`LIMIT`. `GROUP` completes to `GROUP BY`; `HAVING` is offered only once there is
a `GROUP BY` for it to filter. After a column in a `WHERE`, the operators — and
on a timestamp, `>= now() - INTERVAL 1 HOUR`, which is the filter a ClickHouse
table is nearly always read through. After a complete predicate, `AND` rather
than another `=`. `Tab` takes the highlighted entry, and the menu opens after a
space or a comma as well as after a letter, because the moment the choice is
widest — right after `GROUP BY ` — was the one moment it used to stay silent.

Inside a string literal or a comment it says nothing at all. The words there are
data or prose, and a menu of operators over somebody's half-typed sentence is
the kind of help that makes people switch autocomplete off.

**And the rail writes into the statement.** On the Query page a click on a table
in the rail no longer navigates away: it inserts at the caret, and never
overwrites — the only exception is a statement that is empty, where a bare table
name would be no use and a whole `SELECT` is what was meant. The chevron unfolds
the table's columns, each of them one click from the caret, comma-aware so
clicking four of them produces a select list rather than a syntax error.

**A results grid you can work in.** Both axes are windowed, so eighty columns
and ten thousand rows cost what ten of each do. Columns size themselves from the
values actually present and cap before one long JSON blob can push everything
else off the screen; drag a column wider and it stays wider the next time that
query runs. Click a header to sort the rows on screen — it says so, and says
these are the rows that came back rather than the table. Where there *is* a
statement behind the grid, that same click means something stronger; see below. Pin a column and it
holds the left edge while the rest scrolls under it. Select cells with the mouse
or the arrow keys and `⌘C` copies the block as TSV; `⏎` opens the value in full,
JSON indented, for anything a single line cannot hold. A `NULL` and an empty
string do not look alike.

**On the Query page, the grid edits the query.** A click on a header does not
sort the rows on screen there — it rewrites the statement's `ORDER BY` and runs
it again, so the order comes from the server over the whole table rather than
from the page of rows that happened to arrive. The bar above the grid says which
of the two you are looking at, because they are different claims. A cell offers
`filter to this` and lands in the `WHERE`; a column's own menu offers a typed
filter and, separately, the difference between taking the column out of the
`SELECT` — where the server stops reading it — and merely hiding it on screen.

Under the statement, the clauses read back as a row of removable chips: what it
reads from, which of the table's columns it asks for, each `PREWHERE` and `WHERE`
conjunct, the grouping, the `HAVING`, each `ORDER BY` term, the `LIMIT`. Every
one has an `×`. A `DISTINCT` or a `WITH TOTALS` is stated but has no `×`: those
change what a row *is*, and an `×` beside them would offer a change nobody
browsing filters intended. Clauses the strip will not touch — a `WITH`, a
`SETTINGS` — are named rather than skipped, because a sentence that reads the
query back has to admit the words it left out.

None of this keeps a second model of the query. The statement in the editor is
the only truth: every gesture rewrites the text, and the rewriting refuses what
it cannot read — a `UNION`, a subquery in the `FROM`, a `LIMIT n BY` — rather
than guessing, in which case the affordances disappear and the strip says why.

Whether the rewrite runs immediately depends on what the last run cost. Under two
seconds and a quarter of a gigabyte read, it just runs: waiting for a second
gesture to confirm a sort is the kind of caution that makes a tool feel slow.
Above it, the text changes, the rows stay, and the strip says the statement
changed and what the last run cost.

**The plan, read back as sentences.** `Explain…` has always shown ClickHouse's
own plan; the figures that answer "why was that slow" were in it all along, forty
lines down a wall of box drawing. Flint now does the arithmetic above the text:
*the primary key on `event_time` narrowed the read: 5 of 11 granules*; *nothing
was pruned — every one of the 13 granules was read, and nothing in the query
constrained the key*; *the server moved a filter into PREWHERE by itself*; *this
join builds from the right side first, so that is the side whose rows have to fit
in memory*; *the join condition casts on every row: the two sides are not the same
type*. Each one carries the figures it rests on, and the plan stays underneath —
a verdict nobody can check against the thing it came from is a verdict taken on
faith.

Every sentence there is arithmetic over what the server reported, and that is
deliberate rather than modest. The obvious hand-written rule — never wrap a key
column in a function — is false on ClickHouse 26.7, where monotonicity detection
keeps the pruning identical; measured here, `toStartOfHour(event_time)` pruned
exactly as well as the bare column. A rule like that ages into folklore. `5 of 11
granules` cannot.

**What the result adds up to.** Beside the values, an `analyses` panel reads the
result back: where the numbers sit, how long a stretch of time the rows cover,
which handful of values account for them, which column is null in most rows and
which never varies at all — that last one usually meaning a column that should
not have been selected, or a filter already applied. One pass over data that is
already in the browser, so it costs no query. Every figure is about *the rows
that came back*, which the panel says once at the top and then never repeats; a
result is a `LIMIT` away from being a sample of unknown bias. Clicking a top
value narrows the query to it.

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

It is **drawn**, by the same canvas the database page draws its schema with —
same nodes, same engines, same panel when you click one, same full screen — with
only the objects on this path in it. The object you are on carries a ring; the
caption says what was kept and how far the path reaches in each direction ("4 of
14 objects · 1 hop back to a source · 2 hops on to a leaf"), because the count
and the depth are the two things a picture of four boxes does not tell you at a
glance. Where the path leaves this database, it says so: Flint loaded this
database's schema and not the other one's, so it may continue past that object
rather than ending there.

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

Which server it goes on is a second decision, and `FLINT_WORKSPACE_URL` is where
it is made. Unset — the default, and what every deployment did before the
variable existed — Flint's tables land on the server it is exploring. Set, Flint
holds a second connection and keeps its own bookkeeping there. That is worth
doing for two reasons: a read-only Flint could always write its own workspace
(`allow_write` is exempt from `FLINT_READONLY` on purpose, or the mode would be
inert) but the tables still landed in somebody's production, and pointing them
elsewhere makes "connecting Flint creates nothing" literally true. And it gives
an unpinned Flint a memory, which it could not have when the only candidate
server was one the browser named at sign-in. A local ClickHouse is enough —
`clickhousectl local server start` — and `FLINT_WORKSPACE_USER` is deliberately
not inherited from the explored server's account, because carrying one server's
credentials to another is a guess that surfaces as an authentication error
nobody can trace back to a default they never set.

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

At `admin` tier it also changes it: create and drop a user or a role, grant and
revoke a role, grant and revoke a privilege on a scope, rotate a password. Every
statement runs as whoever is signed in, so the server refuses what that account
may not do and Flint is never more permissive than the credentials it was given.
Below `admin` the controls are not drawn at all — a button that fails at click
time is worse than one that was never there.

Three things worth knowing before pressing any of them:

- **An account defined in `users.xml` cannot be changed by SQL**, and Flint says
  so in the form rather than letting ClickHouse say it in the job list a few
  seconds later. Its definition lives in a file, and whatever deploys that file
  owns it.
- **A password travels in the statement**, because ClickHouse's protocol has no
  parameter for one. It is sent as `sha256_password` so the server hashes it on
  arrival, and Flint records the statement *without* it — the recorded text is
  built without the secret rather than scrubbed of it.
- **What each button ran is recorded** beside a sentence saying what it was, in
  the same job list as every other write. "What did that actually run" is the
  first question anybody asks of a tool that grants privileges for them.

Privileges come from `system.privileges` rather than from a list written here, so
what Flint accepts is what this ClickHouse understands.

An account's expiry, the hosts it may connect from and which of its roles are
active by default can all be changed there. Each carries what it costs, because
each fails quietly:

- **An expiry in the past stops the account immediately**, and ClickHouse reports
  that as a wrong password rather than an expiry.
- **A host restriction locks it out of everywhere else**, reported the same way.
- **`DEFAULT ROLE NONE` revokes nothing and disables everything**: the roles stay
  granted, visible in the list, and unusable until the account sets one per
  session.

Aimed at the account you are signed in as, the first two are **refused** — that
would lock Flint out of the server, and the login screen would blame your
password. Widening is still allowed: `HOST ANY` on your own account is fine, and
an empty host form says it means "anywhere" rather than "no change".

Quotas, settings profiles and row policies can be made and dropped from the same
page. Their statements are **built** rather than typed, and each of the three has
a reason for that:

- **A row policy with no accounts named does nothing.** ClickHouse accepts
  `CREATE ROW POLICY p ON t USING tenant = 'c'` and every account still sees
  every row — the statement succeeds and nothing reports it. Flint will not
  create one, and the form says why.
- **A quota's intervals need a comma the grammar does not insist on.** Without
  it ClickHouse keeps only the last interval, silently. Two ceilings over the
  same window become one interval, for the same reason.
- **`READONLY` in a profile is reported back as `writability = CONST`.** The
  checkbox says what it does instead of picking one of the two words.

All three can also be **changed in place**, which is not the same as dropping and
recreating: an altered quota keeps what has already been consumed, where a
recreated one starts its counters at zero — so raising a ceiling the second way
silently forgives everything spent. A row policy dropped and recreated leaves the
table unprotected in between.

One asymmetry to know about, since Flint works around it rather than exposing it:
`ALTER SETTINGS PROFILE` **replaces** the profile's whole settings list, while
`ALTER QUOTA` **amends**. The forms are pre-filled with everything that is
actually there and send all of it, so editing one field cannot drop the rest.

**How much, and which rows.** Below that, the three tables multi-tenant
ClickHouse is actually configured in and which nobody stumbles across: quotas,
settings profiles and row policies. Each is read separately and each reports its
own obstacle, because a role granted `SHOW QUOTAS` is not thereby granted `SHOW
ROW POLICIES` — a list empty because nobody may read it must not look like a
list empty because there is nothing in it.

Four things it says that the tables do not:

- **A row policy does not protect a table — it protects it for the accounts it
  names.** An account no policy names sees every row, and a restrictive policy
  standing alone narrows from everything rather than from nothing. The page
  spells out what a table's policies do together, in the order the server
  applies them, and ends with the line people get wrong: everybody else sees
  every row.
- **A profile is fastened on from either end**, and only one of the two is on the
  profile. Every account on a stock server holds `default` through a row written
  against *itself*, so a page reading only the profile's own list reports the
  profile every query runs under as applying to nobody.
- **`ALTER USER … SETTINGS` belongs to no profile.** Those settings get their own
  section rather than being folded in beside a profile's.
- **A quota's ceiling is per account or shared**, depending on a `keys` column
  three fields away — the difference between sixty queries each and sixty
  between you. A dimension with no ceiling is not listed at all, and a quota with
  no ceiling on any dimension says so, because the stock one is exactly that.

Being refused the quota definitions does not cost you the figures: an account
that cannot read `system.quotas` can still read its own `system.quota_usage`,
and the page then says whose consumption it is showing.

Developing against any of this needs fixtures, because a stock server has one
empty quota, one profile and no policies: `contrib/dev-access.xml` turns on
SQL-driven access control and `contrib/dev-access.sql` creates one of each.

**Keeper.** Above the replica list, because everything replicated goes through
it and its failures surface somewhere else: a replica that has gone read-only, an
`ON CLUSTER` that never finished. Three things: the session this server holds,
the ensemble as it sees it — state, latency average beside worst, followers
synced against followers — and every connect and disconnect it has recorded,
because one reading of the session cannot show a connection that keeps being
lost and remade.

A ClickHouse with no Keeper configured says so, and says it as a configuration
fact rather than as a missing table. It genuinely has no
`system.zookeeper_connection`: those tables are created only where there is an
ensemble to describe, so asking answers exactly what an old version would.
`system.zookeeper_connection_log` exists either way, which is how the two are
told apart.

On the ring itself, an endpoint the local server has stopped trying says so:
*"not being tried for 45s after a failure"*. That figure is ClickHouse's own
back-off timer rather than a prediction about the node — it counts down whether or
not the node has come back, because nothing checks until it runs out, so the row
says what is true instead of what the column is named. `errors_count`, which
sounds like the obvious signal, never moved once through a stopped replica, a
distributed read and a write; it is shown only where a build actually populates
it.

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

**And why the expensive ones are expensive.** The log answers *which* statements
cost the most — that is what a log can do. It cannot say why, but the plan can,
so the two are joined: expand a pattern and `Why it reads that much →` runs
`EXPLAIN PLAN indexes = 1` over the statement as it was logged, and reads it back
as sentences. *The key on `event_date` was used but excluded nothing: all 17
granules matched.* *Nothing in the query constrained the key, which is
`event_date, event_time`.* *This join builds from the right side first.* *The join
condition casts on every row.*

Those two are worth telling apart, and the plan's own condition is what tells
them apart: a key nothing mentioned is a filter on the wrong column, while a key
that was used and excluded nothing is a filter that is already right and simply
had nothing to skip. Reported as a cost and a note respectively — sending
somebody to fix a filter that is correct is worse than saying nothing at all.

Explaining reads metadata rather than data, so it is nearly free, and it is still
a click per row: forty plans nobody asked for are forty queries. One caveat is
printed rather than left to be discovered — this is today's plan for a statement
that ran earlier, and parts have merged since.

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

**Or out of the queries you already named.** A report is mostly a handful of
questions somebody has asked before, so saved queries can be added as sections
one at a time — appended rather than replacing what is there, because the point
is to build a report from several. The editor's *send to* already covers the
single-statement case and lands as a replacement, which is the right shape for
one query and the wrong one for a Monday-morning summary.

A saved query may hold *several* statements — the editor runs the one under the
cursor, so nothing ever stopped anybody saving a buffer with three in it. A
section is one statement, so it arrives as one section per statement, numbered
after the first, rather than as one section that would fail when it ran. A
comment-only query comes across as it was saved instead of being blanked: the
section's own check panel will say it is not a statement, which is more use than
a section that arrived mysteriously empty.

**A report can be run by hand.** Until it has run once, nobody has seen it do
the thing it describes, and finding out at nine tomorrow that a section names a
column that does not exist is not a review cycle. The button goes through the
scheduler's own runner rather than a second implementation of "run a report", so
a manual edition is made exactly the way a scheduled one is: recorded, listed,
and delivered to the webhook like any other. A paused report still runs by hand —
pausing stops the schedule, and somebody pressing the button is not the schedule.

It is allowed under `FLINT_READONLY`, on the same reasoning as stopping a query:
every section runs as a read, and the edition it writes is Flint's own
bookkeeping in its own database. Refusing it there would leave the one deployment
shape where a report can never be checked before its first slot — which is
exactly a look-but-do-not-touch deployment. The run id is minted by Flint rather
than by `generateUUIDv4()` inside the insert, so the answer says *which* edition
it just made; "it ran, go and find it in the list" is not an answer when two runs
can land in the same second.

Time is ClickHouse's. The server that stores the timestamps does the date
arithmetic too — it hands over midnight, the day of the week and the minute of
the day, and Flint compares integers. One clock, and no second one to disagree
with it. The schedule reads back as a sentence naming its zone, because a report
due at nine is due at nine *somewhere*.

**Which somewhere is the report's own.** A daily or weekly report carries a
timezone the way a cron entry carries one, and Flint asks ClickHouse for the
clock in that zone — `session_timezone` moves midnight and the day of the week,
so "nine in Auckland" and "nine in São Paulo" are the same integer comparison
against two different midnights. Empty means the server's, which is what every
report made before this field is. The list you pick from is the server's own
`system.time_zones`, because the server is what will read the choice back: a
name the browser knows and ClickHouse does not would be a refusal at save time
for something that looked offered.

The pairing is checked, not just recorded. An interval schedule — every six
hours — is the same six hours everywhere, so attaching a zone to it is refused
rather than stored: a setting that changes nothing is worse than one that is
turned down, because the person who set it believes it did something. Only a
time of day gets a place. And the zone governs the *schedule*, not the answers:
what the report's statements read comes back in the server's timezone as
before, and the form says so where the two differ.

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

**A published token is hashed, and readable once.** It is minted, handed back
in the save that created it, and stored as a SHA-256 digest — so a workspace
somebody can read (a backup, a replica, a colleague with `SELECT` on
`<workspace>.published`) is no longer a list of live credentials.

The consequence is the feature, not a side effect: **the page cannot show you
the token again**, because nothing can. A card offers *Rotate token* rather than
*Show token*, and rotating hands you a new one and takes the old one out of
service in the same act. Snippets fall back to `YOUR_TOKEN` where the real one
is no longer knowable, which is the honest version of a snippet you cannot paste
unaltered.

An endpoint published before this keeps working — its token is compared in
clear, exactly as it was, because an upgrade that silently stopped every caller
of every endpoint would be a worse outcome than a token at rest until somebody
rotates it. The page says which endpoints those are, since nobody would
otherwise know to.

**Several tables, one act.** Publishing being per statement is right for the
analyst who needs a join today and wrong for the only other thing anyone uses it
for: handing a partner, or a spreadsheet, read access to a handful of tables.
That was fifteen visits to a form to type fifteen variations of `SELECT * FROM
t`, and the fifteenth is where somebody makes the mistake. *Expose tables* on
the endpoints page takes a database and a list of them and writes one endpoint
each — `SELECT * FROM t`, with the same shape layer over it that every published
endpoint has, so a caller gets filters, a sort, a projection, paging and a count
without any of it being written out.

Three decisions inside it. The tables are read as **you**, not as Flint,
because the endpoints run as the manifest account afterwards and publishing a
table you cannot see would be a way to read it. The sort a caller may ask for is
the table's **own sorting key** and nothing else — that is the one sort that
costs nothing, and offering every column would invite a full sort of a billion
rows over HTTP; a table with no sorting key offers no sort, which is the honest
answer rather than a slow one. And they arrive as **drafts** by default,
reachable at no address, because fifteen endpoints that started answering the
moment somebody clicked once is a lot of surface to appear unread.

Nothing is skipped in silence. A name that is not a table you can read, an
address already in use, one two tables in the batch both want: each comes back
named, with the reason. A caller who asked for fifteen and got twelve needs to
know which three and why, and a count alone sends them comparing lists by hand.

And the panel says, before anything is ticked, that most people should not be
using it: anyone with a ClickHouse account gets more from `POST /api/data`,
which publishes nothing and answers under their own grants and row policies.
This is for the caller who has none, which is the one thing publishing does that
nothing else can.

**A revision is a promise, and the number is how a caller holds you to it.**
An address holds a stack of revisions rather than one statement. `GET
/api/data/<address>` reaches whichever is *live*; `?v=3`, or an
`X-Flint-Version` header, reaches that one and nothing else. A pin is refused
rather than approximated — `?v=latest` is a 400, not a quiet fall-through to
live — because the whole value of the number is that a caller who believes they
are pinned *is*, and the failure it exists to prevent is the one they would
otherwise discover on the morning the contract changed.

The rule that makes the number mean anything is that **a live revision's
statement and contract cannot be edited**. Everything that is not a promise —
the name, the prose, the cache, the row cap, the pause switch, the expiry —
stays editable in place, because none of it changes what comes back. Change what
does, and Flint refuses and names the revision the change would land on
instead. Editing a shape under a pinned caller without changing the number is
worse than having no versioning at all: with none they would at least have known
the endpoint could move.

A revision walks `draft → live → retiring → retired`, one way, with one
called-off exception (`retiring → live`, because a revision put on notice by
mistake should not have to be republished as a new number). A **draft** is
reachable at no address — the window between "somebody edited the statement" and
"the endpoint returns something different" is where every review that ever
caught anything happened, and a draft makes that window as long as the person
wants. Going live is one act that also puts the revision it replaces on notice,
because a moment in which an address has two live revisions, or none, is a
moment a caller can land in. A **retiring** revision goes on answering: Flint
will not take it away while it is being called, it tells you who is still
calling, and taking it out is a decision somebody makes rather than a deadline
that passes. Draft and retired both answer exactly the 404 a wrong address
gives, for the same reason a paused endpoint does: whether an address is not yet
open, or finished, is not a caller's business.

**A contract is made of refusals, not of transformations.** The placeholders
already say what an endpoint *needs*; they say nothing about what it will
*accept*, and that gap is where the unhappy mornings come from — somebody asks
for four years of a table partitioned by day and the cluster notices, or asks
for `device_id` and gets it because the statement selected it for a join and
nobody meant it to leave the building. So a revision can carry rules: a floor
and a ceiling on a value, a fixed set it must be one of, a maximum window
measured across a *pair* of parameters, an allow-list of columns that may leave
and a deny-list that never may, the columns a caller may sort by, and a cap on
the page below the row cap.

Every one of them refuses. A window wider than the cap is refused with the cap
in the sentence — it is not quietly narrowed to fit. A column that is not
exposed is refused *by name* — it is not dropped from the answer, because a
caller who asked for `device_id` and received a page without it would conclude
the column is empty and act on that for weeks. A filter counts as asking: a
`?device_id=eq.abc` reads a hidden column one row count at a time, so it is
checked against the same list. And a caller who names no column at all gets
every *exposed* column rather than every column the statement happens to select,
which is the line that actually keeps a join key inside — without it the
contract would only ever have stopped the people polite enough to ask by name.

A contract can also name a column the statement does not return — typed from
memory, or left behind when a later revision stopped selecting it — and Flint
says so in the editor as it is written and on the endpoint page for the ones
already out there. Two different failures, so two different sentences. A column
*offered* and not there is one the endpoint cannot produce: the document and the
tool definition drop it, so a caller never learns it was offered, and one who
asks for it by name gets ClickHouse's message about an unknown identifier, which
tells them nothing. A column *denied* and not there is harmless on its own — it
refuses something nobody can ask for — but it is almost never what somebody
meant: a `never` written for `device_ids` beside a returned `device_id` reads as
protection and is none, and the column it was written to keep inside is leaving
on every call.

An empty contract promises exactly what the placeholders do, which is how every
endpoint published before contracts existed goes on behaving. A contract that
cannot be parsed is read as empty rather than as an error: an endpoint taken off
the air because something wrote bad JSON into a column is a worse failure than
one that promises less, and the page it is edited on refuses the same JSON at
the moment somebody tries to save it.

**A key is a caller, not a door.** The per-endpoint token answers one question —
may this call happen — and can answer no others: every caller of an endpoint
shares one secret, so "who is making thirty thousand of these a day" has no
answer, rotating locks out everybody at once, and a quota can only ever be a
quota on the endpoint. A key is global and scoped to the addresses it may call,
because that is the shape of the thing being named: `app-frontend` is one
program and it calls four endpoints. It carries a quota in calls per day *per
address*, so one noisy tile cannot spend the budget the same program's other
calls depend on, and the quota counts answered calls only — a refusal does not
eat the allowance it was refused by, or hitting the limit once would lock a
caller out for the rest of the day.

Both travel the same three ways — an `X-Flint-Key` header, a `Bearer`
authorization, a `token` query parameter — and a presented secret is tried as a
key first and as the endpoint's own token second. That is what lets a deployment
move one caller at a time: `app-frontend` swaps its secret for a key and becomes
visible in the call log, while the four scripts nobody can find go on working. A
key is hashed at rest and readable once, exactly like a token, so the page
offers *Rotate* and never *Show*.

**An answer can be kept for a few seconds, and the page says how stale that
makes it.** A published endpoint is usually a dashboard tile, which means the
same question arrives from forty browsers inside the same minute and ClickHouse
answers it forty times. A per-revision TTL turns that into one query — but the
interesting part is not the saving, it is that a caller can now be told exactly
how old the figure in front of them is allowed to be. It is off by default,
because a figure nobody asked to be stale should not become stale because a
default said so. The key is everything that changes the bytes and deliberately
*not* the caller: a published endpoint runs as the endpoint, so two callers with
the same question get the same answer. The cache lives in the process, so two
Flints behind a load balancer each keep their own and one caller can see an
answer up to one TTL older than another — a real consequence of not having a
second database to put a shared cache in, and the reason the TTL is stated on
the page rather than hidden.

**And Flint keeps its own call log, which is a departure worth explaining.**
Flint's rule is to read `system.*` and keep no second copy of anything ClickHouse
already knows, and the endpoints page breaks it — because three of its panels
cannot be built from the query log even in principle. A cache hit never reaches
ClickHouse, so a hit rate read from the query log is zero for ever. A refusal
runs no statement, so a 429 and a 403 leave no row there at all. And a query log
row records the account the statement ran *as*, which is Flint's for every
published endpoint, so it cannot tell one key from another however carefully the
statement is tagged. `{workspace}.api_calls` holds one row per call, refusals
included, for thirty days. The query log is still the better source for what a
call *cost* on the server, and the diagnostics page goes on reading it; this is
the caller's side of the same traffic.

Calls are buffered and written a few seconds apart, in one insert. That is not
an optimisation, it is the difference between a feature and an outage:
ClickHouse makes a *part* per insert, so a row per call means thirty thousand
parts a day on the workspace — the same database the alerts, the dashboards and
the saved queries live in — and the `TOO_MANY_PARTS` that eventually arrives
takes all of them down for the sake of a usage panel. The batch crosses as one
bound parameter holding JSON, which ClickHouse parses itself: two of these
fields are free text off the wire, and a `VALUES` list built by string
concatenation is the one thing this codebase will not do.

Three consequences worth stating. Each row carries how long *before* the insert
its call happened rather than a timestamp, so ClickHouse's clock stays the only
clock in the workspace — `calls_today` compares these against
`toStartOfDay(now64(3))`, and a sidecar's drift meeting a quota boundary is a
bug nobody would think to look for. A quota therefore counts what has been
written *plus* what is still waiting, or a caller could spend a whole flush
window's worth over the limit. And a crash loses the buffer, which is the right
thing to lose: the alternative is making a caller wait on Flint's own
bookkeeping. The buffer is capped, and says in the log what it dropped rather
than letting a panel go quietly short.

The figures are per *revision*, not per address, because "v3 is retiring and
still took two thousand calls today" is the sentence somebody acts on and an
address-level total hides it inside the revision that replaced it. Calls refused
before Flint knew which revision they wanted — a wrong address, a pin for one
that does not exist, a missing key — belong to no revision, and the list counts
them in a line of their own rather than dropping them.

**An endpoint describes itself twice, from the same facts.** `openapi.json` is
for a client generator; `tool.json` is the same endpoint as a tool definition an
agent framework can be handed — one name, one sentence, one argument schema.
Both are generated, so neither can go stale against the other or against the
endpoint. The contract is what makes the second one worth having, for a reason
specific to agents: a person handed a parameter called `region` asks what the
regions are, and a model guesses, calls, gets a 400, and guesses again. So every
constraint the contract holds is pushed into the argument schema, where the
framework enforces it before a call is made — and what JSON Schema cannot hold,
a date floor and a window across a pair, is said in the sentence instead of
encoded as something a validator would apply wrongly. Neither document carries
the statement: a published address is not an invitation to read the SQL behind
it.

**An endpoint can be made to run as a role — where that means something.**
`FLINT_DELEGATABLE_ROLES` names the roles a deployment is willing to hand out,
in the manifest and never in the UI, for the reason the tier is there: a
permission a user can grant themselves is not a permission. Empty is the
default, so publishing cannot hand out anything until somebody deploys the
decision to allow it. An endpoint with `run_as` set carries that role on every
statement it runs — the page, the count, and the `DESCRIBE` behind its schema,
because a column list is half of a leak nobody counts.

**And Flint checks that it narrows anything, because usually it does not.**
ClickHouse's effective privileges are the union of the active roles *and*
everything granted to the user directly, and a direct grant cannot be switched
off by activating a role. So an account holding `SELECT ON *.*` in its own right
reads everything whatever `run_as` says, and an endpoint that looked delegated
would be one running as the administrator. Saving such an endpoint is refused,
with the grants that defeat it named:

> this endpoint cannot be delegated to `reporting`. Flint's own account holds
> SELECT on `*.*` directly rather than through a role, and a direct grant stays
> in force whatever role is active — so the endpoint would read everything that
> account can, not what `reporting` can. Give this account its read access
> through roles instead.

A caller never sees that machinery from the outside. An endpoint that reaches
past its role is refused with *"this endpoint cannot read what it asks for"* —
not with ClickHouse's own sentence, which names the account Flint connects as
and the grant it wanted, to somebody holding a token who has never been shown
the schema. The real refusal goes to the log, for whoever published it.

Which is the whole feature, really. Delegation that quietly does nothing is
worse than no delegation, because somebody would rely on it. The precondition —
**give Flint's account its read access through roles, not directly** — is a real
thing to configure, and this is the one place that will tell you whether you
did. `contrib/dev-roles.sql` builds an account shaped that way against the
development ClickHouse, if you want to see it work rather than see it refuse. Grants on the workspace database are exempt: Flint keeps its own
bookkeeping there and it reaches nothing a caller asked for.

**And a token can be given an end**, which the endpoint then says out loud.
`expires_at` appears in its schema and in a sentence of its OpenAPI description —
*"this endpoint stops answering at …, after which it responds exactly as an
address that never existed"* — because a client generated from that document is
the one thing that will still be calling on the day it does, and the 404 it gets
then is indistinguishable from a wrong address. An endpoint with no end says
nothing, and carries no field for one.

`expires_at` retires an endpoint at a moment you choose; empty means never,
which is what every endpoint made before this field is. A call that arrives
afterwards gets the same 404 a paused endpoint gives — not a 401, which would
send somebody hunting for a credential mistake they did not make, and not a 410,
which tells anyone who asks that the address once existed and who to pester
about it.

**The moment is read in the server's timezone**, and the form names it beside
the field. ClickHouse is what compares the expiry against now — deliberately,
because a sidecar with a fast clock would otherwise retire an endpoint early —
which means the clock on the machine you type it into is not the one that
counts. An endpoint that retires two hours off is not something anybody debugs:
they find it gone.

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
by name: "`citty` is not one of the columns here; they are city, n". Under
the old rule an unrecognised key was ignored, which meant a misspelt filter
returned the unfiltered table and looked exactly like an answer.

Both halves of the API are on the same page: the APIs page lists what has been
published, and says in a line that the other half exists — because a feature
nothing in the product mentions is a feature nobody finds.

**Or just give me the file.** The two APIs cover a machine that calls an address
on a schedule. They do not cover the other thing people want from a table, which
is a file on their disk, once, right now — so the result bar carries **CSV**,
**JSONL** and **Parquet**, and each one hands over the whole answer.

*The whole answer*, not the page. Every other read in Flint is capped and says
what it left out; a file cannot say that — nothing in a Parquet footer mentions
the four million rows that did not fit, and a CSV that stops at ten thousand
looks exactly like a CSV of a ten-thousand-row table. So the cap comes off for a
download, and the honesty moves to before the click: the control reads
"Downloads the whole result, not only the 10,000 rows shown." It does not name a
total, because it does not have one — a truncated page reports no count it could
use, and a figure invented there is a figure nobody can reconcile.

ClickHouse writes the bytes. `CSVWithNames`, `JSONEachRow` and `Parquet` are its
own formats, correct down to the quoting and the type mapping for `Decimal` and
`Nullable(Date32)`; Flint names one and moves what comes back. There is no
serialiser in Flint and there must never be one.

It is a real `<form>` with real submit buttons and no JavaScript in the path,
which is not a stylistic choice: a form submission is a *navigation*, so the
browser streams to disk with its own progress and its own cancel, while `fetch`
would hold the file in the tab first. A 1.1 GB export is not something to keep
in a tab — and, measured, it never sits in Flint's memory either: the file grows
on disk while the query is still running. The session rides in the cookie, which
a form sends and a header could not; the cookie is `SameSite=Lax`, so a form on
somebody else's page reaches Flint with no session and is refused.

What is downloaded is the statement that *ran*, not what is in the editor now. A
reader who typed three more characters after running would otherwise get a file
answering a question they never asked, with nothing saying so.

**A table's preview carries the same three buttons**, and there the count is
often known, so the sentence names it: "Downloads all 3,780 rows, not only the
200 shown." It keeps the columns and filters chosen above and drops the
preview's `LIMIT` — "give me this table" that returns two hundred rows is the
truncation this feature exists to prevent. The figure is withdrawn as soon as it
stops being known: a filter makes the count something ClickHouse would have to
go and count, and an object that keeps no count of its own never had one. Both
fall back to "Downloads every row, not only the 200 shown" — a dropped figure
rather than a dashed or an invented one.

**Reading a dataset, as yourself.** A published endpoint answers one question,
chosen by whoever published it, and is opened by a token. The other half of the
API is the opposite of that: `POST /api/data` takes a **dataset** — any table or
view — and reads it as *you*.

```bash
curl -s localhost:8080/api/data -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{
    "dataset": "analytics.sales",
    "select": ["id", "amount", "region"],
    "filter": {"any": [
      {"column": "region", "op": "eq", "value": "EMEA"},
      {"all": [{"column": "amount", "op": "gte", "value": 1000},
               {"column": "tier",   "op": "in",  "values": ["gold", "platinum"]}]}
    ]},
    "order": [{"column": "amount", "desc": true}],
    "limit": 100,
    "count": true
  }'
```

Nothing is registered to make a dataset. There is no list of exposed tables and
there must never be one: **which datasets exist is a question ClickHouse already
answers**, through grants and row policies, and a second list kept by Flint could
only ever start disagreeing with the first. Sign in as a user who holds
`SELECT` on one database and that database is what the route will read — a name
outside it comes back as "`system.users` is not yours to read", because the
server refused it, not because Flint checked.

That is the whole reason this route exists, and it is worth stating in one line:
**it is the first part of Flint's API where a row policy applies.** A published
endpoint runs as the account in the manifest, so it never could.

What the body buys over the query string is exactly one thing, and it is the
thing above: **a filter that is a tree.** `region=eq.EMEA&amount=gte.1000` is a
conjunction and a URL has nowhere to put an `OR`, so until now every question
that needed one had to be published as a statement by somebody with the rights
to publish. A body also carries an `in` list of four thousand identifiers, which
a URL cannot.

Everything else is the published endpoints' machinery, unchanged and shared:
`select`, the same twelve operators, `order`, `limit`/`offset`, the same cursor
paging, `count`, and `format` for JSON, CSV or NDJSON. Identifiers are matched
against what the dataset really returns, asked with `DESCRIBE`; values travel as
bound parameters; the statement runs read-only whatever the deployment otherwise
permits. A dataset name is quoted rather than pattern-matched, so a backtick in
one is a name that does not exist rather than a way out of the quoting.

**And the dataset says what it can be asked.** `POST /api/data/schema` returns
the column inventory — what each column *is*, not only what type it holds:

```json
{ "dataset": "analytics.events", "groupable": 7, "measurable": 7,
  "note": "1 of 8 columns holds many values at once — it is returned, and cannot be filtered, grouped or measured",
  "columns": [
    {"name": "ts",         "type": "DateTime64(3)", "kind": "time",
     "group": true,  "filter": ["eq","ne","gt","gte","lt","lte","in","nin"],
     "aggregate": ["count","min","max","distinct_count","any"]},
    {"name": "latency_ms", "type": "UInt32",        "kind": "numeric",
     "group": true,  "filter": ["eq","ne","gt","gte","lt","lte","in","nin"],
     "aggregate": ["count","sum","avg","min","max","median","distinct_count","any"]},
    {"name": "tags",       "type": "Array(String)", "kind": "unsupported",
     "group": false, "filter": [], "aggregate": []}
  ] }
```

The six kinds are `id`, `time`, `bool`, `text`, `numeric` and `unsupported`, and
none of them is configured anywhere. They are derived, from the same
`system.columns` the explorer already reads and the same type families the rest
of the product already uses — so a view your ops team adds on a Tuesday can be
grouped and measured on the Tuesday, with nothing to register.

`id` is the kind that earns the module. `meter_id` and `reading` are both
`UInt64`, and only one of them has a meaningful average: a type cannot tell them
apart, so the *name* is consulted — and only where consulting it prevents
something. The rule is narrow on purpose — a whole-word `id`, or a `_id`, `_uid`
or `_uuid` ending — so `valid`, `pyramid` and `overbid` stay quantities. Where
the guess is wrong you can still filter, group, order and select the column; the
only thing withheld is the arithmetic, which is the single operation that would
otherwise return a plausible number that means nothing.

It is asked as you, like the read, because a `DESCRIBE` of a table you may not
read is still a read of its shape.

**Grouping and measuring.** `dimensions` and `metrics` turn the same request
into an aggregate:

```json
{ "dataset": "analytics.events",
  "dimensions": ["city", "status"],
  "metrics": [{"aggregation": "count"},
              {"aggregation": "avg", "column": "temperature"},
              {"aggregation": "max", "column": "latency_ms", "as": "worst_latency"}],
  "order": [{"column": "count", "desc": true}], "limit": 6, "count": true }
```

Eight aggregations — `count sum avg min max median distinct_count any` — and
**which of them a column accepts is the inventory's answer, not the type
system's**. `sum` over an identifier compiles, runs, and returns a number that
means nothing, so it is refused by name with the list of what that column does
take: *"`device_id` does not take `sum`; it takes count, min, max,
distinct_count, any"*. Averaging a timestamp and grouping by an `Array` are
refused the same way.

Either half alone is a question. Dimensions with no metrics is "which cities are
there"; metrics with no dimensions is "how many altogether", and comes back as
one row.

Four details worth the words. Metric names are predictable — `avg` of
`temperature` is `avg_temperature`, a bare `count` is `count` — so a chart can be
written against the answer before the request is sent, and `as` overrides it; two
things that would land under one name are refused rather than one of them
winning. `order` then names what the answer *returns*, not what the dataset has,
because `avg_temperature` is a column of nothing. `count: true` counts **groups**
rather than rows, since that is what the page holds — and on a single-row answer
it says there is no total rather than returning `1`. And `distinct_count` is
`uniqExact`, not the cheaper approximate `uniq`: a field read as "how many
distinct customers" must not be an estimate nobody mentioned.

**An aggregated answer has no cursor**, and says so in `page.cursor_note`. Its
rows are computed rather than stored, so there is no row to carry on from; page
it with `offset`. Sending a cursor to an aggregate is refused on the way in for
the same reason.

**When, as part of the question.** All of this could be written as two filters
on a timestamp, and that is where the mistakes are — so `time` names the three
windows people actually ask for:

```json
"time": {"last": 7, "unit": "days", "granularity": "day"}
"time": {"period": "previous_month"}
"time": {"from": "2024-01-01", "to": "2024-02-01"}
```

***`last` rolls, `period` aligns.*** Seven days is 7 × 24 hours ending now;
`previous_month` is a month, whatever length that month happens to be. The two
answer different questions, and reaching for the wrong one gives a plausible
number — which is why they have different names rather than one flag.

**Every window is half-open**, `[from, to)`. Page a month at a time over closed
intervals and every boundary row lands in two answers; the row exactly at
midnight belongs to the day that is starting, once. Periods are
`this_hour previous_hour today yesterday this_week previous_week this_month
previous_month this_year previous_year`, and a week starts on Monday.

**`granularity`** buckets the column and turns the answer into a series —
`minute hour day week month year`. The bucket arrives as `<column>_<unit>`, so a
day bucket over `ts` is `ts_day`: the same naming rule as a metric, and it says
which granularity it is. A granularity on its own is still a group by, because
"which days are there" is a question.

**More than one time.** `time` takes a list as readily as an object, for the
questions that have two of them — "created last week and updated today", or a
day column beside an hour column:

```json
"time": [{"column": "created_at", "last": 7, "unit": "days"},
         {"column": "updated_at", "period": "today"}]
```

Every window narrows; every granularity adds a column. Only the first may carry
a `compare`, because a comparison moves one window and two would be two answers.
One time stays a plain object — the shape every example here shows.

`time.column` may be left out where the dataset has exactly one date or
timestamp. Where it has several, Flint hands the ambiguity back with the
candidates in it rather than picking — a window on the wrong timestamp returns
rows that look right.

**The clock is ClickHouse's, not Flint's.** `now()` is written into the
statement rather than resolved here, so a sidecar whose clock has drifted cannot
return a window that disagrees with `system.query_log`. The cost is that the
answer does not print its exact boundaries back; ask for them with
`{"aggregation": "min", "column": "ts"}`.

**And you say where its days begin.** `"timezone": "Europe/Paris"` moves every
boundary in `time` at once: `last: 7 days` counts back from your midnight, a
`day` bucket cuts at yours, `period: "yesterday"` means your yesterday, and an
explicit `from`/`to` is read as a wall clock in it — the same two strings select
different rows in two zones, which is the point rather than a surprise. It
reaches ClickHouse as `session_timezone`, so one setting moves `toStartOfDay`,
`toMonday`, `today()` and the meaning of a bare datetime consistently — rather
than Flint rewriting six functions and getting five of them right.

```json
{ "dataset": "analytics.events",
  "metrics": [{"aggregation": "count", "as": "n"}],
  "time": {"column": "ts", "period": "yesterday"},
  "timezone": "Pacific/Auckland" }
```

The answer names the zone it used whether or not you chose one — a row stamped
`2026-08-27` is a different day in Auckland and in São Paulo, and a result filed
away for a month with no zone on it cannot be reconciled against anything. The
`sql` it hands back carries a `SETTINGS session_timezone` line for the same
reason: that string is what the Builder shows and what "take to the editor"
pastes, and a statement handed over without its zone runs in the server's and
quietly answers about different days.

A zone on a query with no window and no bucket is **refused**, not ignored.
There is no boundary for it to move, and a setting that silently changes
nothing is worse than one that is turned down — the person who set it believes
it did something. The name is checked against `system.time_zones` on this
server, because that is what will read it.

**A dashboard tile is neither, and needs no field at all.** Its SQL is written
by hand, so the zone is already expressible in the language and visible where a
reader looks — `toStartOfDay(ts, 'Europe/Oslo')` gives what the session setting
gives. What a dashboard did need is a sentence: a reader never sees a tile's
SQL, only its chart, so a bar per day was a bar per *somebody's* day. A dated
tile now names its zone beside the database — the one the statement declares,
or the server's where nothing overrode it, or **nothing at all** where the
statement names a place itself, because a confidently wrong zone is worse for a
reader than an absent one.

**A published endpoint is the other way round: it owns its zone**, and callers
do not choose. An endpoint is a fixed address somebody else published, so two
people asking it on the same afternoon must be shown the same days or neither
can reconcile a figure with the other. Its OpenAPI document says which zone —
but only where the answer has a date in it, read off the columns rather than
kept as a second field that could drift from them. The page, its `count=exact`
total and the `DESCRIBE` behind its schema all read in that one zone; three
statements in two zones is not a slower answer, it is a different one.

**A date a caller sends is read in that zone too**, and the document says so
because it has to: `?ts=lt.2024-03-01` is choosing a midnight whether the caller
knows it or not. This was found the hard way — a test endpoint given a zone
turned a filter that had matched 500 rows into one that matched none, and both
numbers were right.

Every answer carries its zone in `X-Flint-Timezone` as well as in the envelope,
on both faces. A CSV of daily figures is the most likely thing anyone pipes into
a spreadsheet, and paging can be inferred from the rows that arrived where a day
boundary cannot be inferred from anything.

**Comparison.** `compare` asks the same question of a second window and returns
both, told apart by a `window` column whose values are `current` and `previous`:

```json
"time": {"period": "this_week", "compare": "previous_period"}
"time": {"period": "this_month", "compare": "previous_year"}
"time": {"last": 7, "unit": "days", "compare": "previous_period"}
```

```
ok     current   2324        ok     previous  23796
warn   current    774        warn   previous   7932
```

The second window is **worked out from the first**, never described again: a
calendar window moves by whole units of its own kind, so `this_month` against
`previous_period` is the month before — a month, not thirty days — and a rolling
window moves by its own span. Asking a caller to write both would let them drift
apart, and two windows of different lengths make a difference that is not one.

It is **one pass, not two**. Both windows are read together and told apart by a
computed column, so the order, the page and the total are one answer rather than
two stitched together; `count` then counts groups across both windows. The
predicate is `(this window) OR (that one)`, which ClickHouse resolves against the
primary index the same way it resolves either alone — comparing a month with the
same month last year does not read the eleven months in between.

**Grouping, then filtering what the grouping produced.** `having` is a filter on
computed values — the same tree `filter` is, but over what the answer *returns*
rather than the dataset's columns:

```json
{ "dataset": "analytics.events", "dimensions": ["city"],
  "metrics": [{"aggregation": "count"}],
  "having": {"any": [{"column": "count", "op": "gt", "value": 94932},
                     {"column": "count", "op": "lt", "value": 90000}]} }
```

`filter` narrows the rows that go into the grouping; `having` narrows the groups
that come out. It names anything the answer returns, the comparison's `window`
column included — so "only the previous half" is a `having`, and the total then
counts what survived it rather than what existed before. Sending a `having` with nothing aggregated is refused rather than
ignored, because a request carrying one meant to aggregate. And `count: true`
counts the groups that survived it, not the ones that existed before it.

**Two distinct counts, and they are two words.** `distinct_count` is `uniqExact`
and `distinct_count_approx` is `uniq`. On a large table you usually want the
second, and on a report you usually want the first — so the difference is in the
name, at the call site, rather than in a flag somebody sets once and forgets.

**`explain`.** Send `"explain": true` and the statement comes back unrun. It
still checks the dataset, so a column that is not there is still named before
anybody presses run — it is what lets Flint's own Builder show the SQL it is
about to ask for without writing that SQL a second time in the browser.

**Finding a dataset, and documenting one.** `POST /api/data/list` answers which
datasets you can read — `system.tables`, narrowed by ClickHouse to your grants
rather than by a list Flint keeps. Two people calling it get two different
answers, correctly. Each entry says whether it is a `table`, a `view`, a
`materialized_view` or a `dictionary`, and carries its size where it has one — a
view has none, so the figure is dropped rather than printed as a zero.

`GET /api/data/openapi.json` is the whole query language as an OpenAPI 3.1
document: one document, because there is nothing published here to write one
*about*. It is generated from the same constants the parser uses, so an operator
added to the code appears in it without anybody remembering to. The `dataset`
field is an **enum of what you can read** — which means a client generated from
it is generated for one user. Generate it as the account a team shares, or, past
a couple of hundred datasets, the field falls back to a plain string and points
at `/api/data/list`.

Three things a comparison will not do, each for a reason. A `from`/`to` window
written out by hand **cannot be compared**: its length is date arithmetic, and that is
ClickHouse's job here rather than Flint's, so it says so instead of guessing a
span. A comparison **needs a metric**, because two windows of raw rows is two
pages with a label on them and not a comparison. And a rolling window bucketed by
day will show **one calendar day in both windows** — `last: 3, unit: days` cuts
mid-day, so that day's rows split across the boundary. That is what a rolling
window is; bucket a `period` instead if you want whole days.

The one other limit, said rather than found: the filter nests eight groups deep
and then says so.

Callers who are not people, and have no ClickHouse account, keep using a
published endpoint and its token. The two are not competing: one delegates a
chosen question to somebody who could not otherwise ask it, the other lets
somebody who *can* ask anything ask it without publishing first.

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
endpoint without anyone writing the document by hand.

**Every type in it was checked against the wire, not against the type's name.**
`contrib/api-check.mjs` publishes one column of each family and compares what
the document claims with what actually arrives, and it found three mappings
wrong — each one the obvious reading:

| ClickHouse | arrives as | why |
| --- | --- | --- |
| `UInt64`, `Int128`, … | `string` | Flint has ClickHouse quote wide integers, so a JSON reader cannot silently round an id past 2^53 |
| `Decimal(38, 4)` | `number` | that setting covers *integers only*, so a decimal is not quoted — and is not exact once a client has parsed it |
| `Tuple(UInt8, String)` | `array` | unnamed; a named `Tuple(x UInt8, …)` arrives as an object, and the document says so per column |
| `Point`, `Polygon`, … | `array` | the geo types are aliases for nested arrays of points |
| `DateTime` | `string`, no `format` | ClickHouse writes `2023-11-14 22:13:20`, which is not RFC 3339; a validator told otherwise rejects every row |

The first was already right. The next three were not, and no amount of reading
the type name would have shown it — only asking the server.

One consequence worth knowing rather than discovering: a `Decimal` crosses as a
JSON number, so a value wider than a double holds is no longer exact once a
client parses it. The document says so on the column. Quoting them the way wide
integers are quoted is one ClickHouse setting away, but it would change the wire
format for every consumer Flint already has, including its own grid — so it is a
decision rather than a fix.

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


## Which of the disk is doing any work

Every other storage reading here answers *where the disk is* — the treemap draws
it, the review says what the column types cost, the advisor says what the
workload would prefer. None of them answers the question somebody actually has
when a disk fills.

Two system tables between them can, and neither can alone. `system.parts_columns`
weighs every column of every active part. `system.query_log.columns` names every
column each statement touched, fully qualified. A column in the first and not in
the second is one this server stored, merged, backed up and paid for, and did not
serve — and nothing in ClickHouse will ever mention it. On a real schema that is
routinely most of the disk: a `raw_payload` kept "just in case" beside twelve
columns anybody queries.

**It never says a column is unused.** It says nothing has read it *in the
window*, which is a different sentence and the only one the evidence supports. A
quarterly report, an incident investigation, a regulator's export and a year-end
reconciliation all read columns that look cold for months. The finding is where
to look; the decision needs somebody who knows what the column is for.

**And the window it quotes is the log's, not the one that was asked for.**
`system.query_log` has a TTL. Asked about seven days, a real server answered for
five hours — and "nothing has read this in 7 days" over five hours of evidence is
a false statement built entirely from true numbers. So the covered span comes
back with the reading, and below a day of it nothing is claimed at all: a log
covering twenty minutes cannot tell a cold column from a column nobody happened
to need during lunch. The page says which reading it is holding, and why.

Two distinctions the numbers do not make on their own. A table nothing read has
every column cold, and reporting that as "1,906 unread columns" dresses one fact
as nineteen hundred — it is a fact about the table and is said that way. And a
column occupying no bytes is not a saving: an ALIAS, or a MATERIALIZED column
never backfilled, and counting those would make every table look half cold.

A table's own Columns tab carries the sentence and marks the columns — but only
when *every* cold column can be marked, because a mark that is right about six
rows and silently absent on thirty-four is worse than none.

## Who this server has been working for

Diagnostics ranks statement *shapes* by cost, which answers what is expensive. The
other half is whose it was, and on a shared server that is usually the half with
somewhere to go: a shape costing forty minutes a week is a query to optimise, and
the same forty minutes belonging to one service account is a conversation with
whoever owns that service.

**An empty account is not a person.** ClickHouse logs work nobody asked for
interactively — a materialized view's push, a subquery arriving from another node,
a background flush — under an empty user. On the first server this was pointed at,
that empty name was the second largest spender on the machine: 34% of the window,
with 82% of its own time on one table. Named as a user it sends somebody hunting
for an account that does not exist. Named as what it is, it is the most useful row
on the page — a view quietly costing a third of a server is not something anybody
goes looking for.

The busiest table is named only when it is most of what the account does. "41% of
the server, and 12% of that on `events`" is two figures that together say nothing;
"41% of the server, and 82% of that on one table" is a finding. And the window is
the log's own, like the reading above: below a day of coverage the ranking is
shown and marked as not to be leaned on, because ranking who spent the week from
five hours of log ranks who was awake this morning.

## The same data, held twice

The copy nobody deleted. A migration that made `events_v2`, filled it, switched
the reads over and left `events` on the disk; a table cloned to try a different
sorting key; a restore into a second name never dropped. They merge and back up
like anything else, ClickHouse mentions none of them, and the only reason anybody
notices is a disk filling.

**Shape alone is not evidence, and measuring proved it.** Grouping tables by their
column list produced eight-table groups of nothing on a real schema: `raw_x`,
`raw_x_estimated`, `raw_x_last_state` and `raw_x_last_state_mv` share a shape *by
design*, and two databases on one server share every shape in them because they
are two environments.

So two more conditions, and the second is the sharp one. The same database —
`default.events` and `staging.events` are a deployment, not a duplicate. And the
same row count to within 2%. On ClickHouse's own demo server that separates the
real ones cleanly: `hits`, `hits_full_projection` and `hits_index_projection` hold
99,997,497 rows each, spread exactly zero; `query_log_sharded` and
`query_log_plain` differ by 0.06%. Meanwhile `forex`, `forex_2020s` and
`forex_usd` share a shape and spread 99.8%, and `hackernews_changes_items` and
`hackernews_history` spread 42% — both correctly excluded, and no amount of shape
comparison would have told them apart.

**It never says drop one.** Both sets it finds on that server are deliberate
second *layouts* of one dataset — a projection kept as its own table, a shard
beside its plain twin — and from the outside that is indistinguishable from the
copy a migration left. Which it is, is a fact about somebody's intentions: the
reader has it and Flint does not. The figure quoted is the conservative one,
everything beyond the *heaviest* member, which is the least you get back whichever
copy survives.

And it needs no query log — `system.columns` and `system.tables` are enough. That
is what makes it worth having beyond its own merit: on a locked-down account where
six of Flint's seven readings are refused outright, this is the one substantial
finding the home can still produce.

## Long operations

Some ClickHouse operations do not fit in a request. An `OPTIMIZE` over four
terabytes, and later a mutation or a backup, outlive the tab that started them —
and Flint is a sidecar, which is rescheduled without being asked. So an operation
is a **row**, not a spinner: Flint records it, starts it, and hands back an id at
once.

The first one is `OPTIMIZE`, offered on Infrastructure → Health beside the part
counts that justify it, because an action a screen away from the number that
justifies it gets used without the number. Two clicks, and the expensive version
named as such: `FINAL` merges a partition into one part, and the bytes it would
rewrite are printed in front of the choice.

Three things it needs, and one it tells you:

- **`FLINT_TIER=ddl`** or above. An `OPTIMIZE` writes no rows and changes no
  structure, but it rewrites storage and can cost hours of I/O, which puts it
  with the operations that reshape things rather than the ones that read them.
  Below that tier the control is not drawn *and* the route refuses it.
- **A workspace.** An operation Flint cannot record is one nobody can reconstruct
  afterwards. Without `FLINT_WORKSPACE_DATABASE` there is nowhere to write it, so
  there are no operations, and the page says so instead of looking broken.
- **Grants of whoever asked.** The statement runs as the signed-in user, so
  ClickHouse decides whether they may optimize that table, and `system.query_log`
  records who did.
- **What a restart lost.** An operation still marked running when Flint boots is
  marked `interrupted` — not left spinning for ever, and not called failed. The
  server very often finishes the merge without us, and the row says exactly that
  rather than guessing either way. Its duration is dropped, because Flint does
  not know when it ended.

An **edition of a report asked for by hand** is a job too. It used to hold the
request open while every section ran, which meant a report with slow sections
timed out in the browser and kept going on the server with nothing on the page to
say so; now the button returns at once and the Reports page shows the edition
being made. The schedule's own editions are unchanged — they were never waiting
on anybody.

Stopping one asks the server to stop, and only works for a job that is a single
statement: `KILL QUERY` finds that by the id in its row, where an edition is a
sequence of statements with an id each. So the control is not offered for one,
and the route says why rather than doing nothing quietly. For a merge, "stopped"
means the server was asked — work already begun finishes in its own time, and the
answer says so.

## What the server has been doing

Every figure Flint showed about the machine used to be a single instant: memory
*now*, merges *now*, delayed inserts *now*. That answers "is it bad right now"
and nothing else, and the question an operator has is "was it always like this".

Infrastructure → Health reads `system.metric_log`, which keeps a row a second,
and draws five lines from it: memory tracked, queries running, merge pool in use
against the pool's own size, inserts being slowed, and the mark cache hit rate.
Five, from a table with nineteen hundred columns — a page that draws every metric
ClickHouse exposes is a page nobody reads, and each of these carries a sentence
saying which question it answers.

Three decisions in there worth knowing, because they change what you are reading:

- **Gauges are shown at each bucket's peak, not its average.** A minute in which
  memory touched its limit for two seconds is a minute worth seeing, and an
  average of the other fifty-eight hides it.
- **A gap is a gap.** The cache hit rate has no value in a bucket where nothing
  read any marks — an idle minute has no hit rate — so the line *breaks* rather
  than dropping to zero, and the section says how many buckets were empty. A line
  diving to the floor says "it went bad"; a break says "nobody knows".
- **The scale starts at zero**, and where a metric has a real ceiling — a merge
  pool of 32 slots — that ceiling is the top of the frame, so half full looks
  half full.

**Merging, over time** answers what "Right now" cannot: whether the machine has
been merging all night. From `system.part_log` — merges finished, bytes written,
and the tables the work went to with their average duration beside their worst,
because a table averaging a second with a worst of four minutes has a story the
average hides. Merges that failed are called out; on most servers that column is
empty, which is the answer you want.

**What has gone wrong** is on the same page, from `system.error_log`. It used to
count since the server started, which is the one thing an error panel cannot
usefully do: on a server up for eleven days, "42 access denied" says nothing about
whether anybody should care today. Now it takes a window and draws the trend —
and where `system.error_log` is switched off it falls back to the lifetime
snapshot and says which it is, because the same table of numbers meaning "these
six hours" or "these eleven days" without saying so is a table nobody can act on.

**The server's own log** is on the same page, from `system.text_log`: newest
first, at the level you choose and everything worse than it, defaulting to
warnings. Not live, because a log that scrolls while you read it is a log you
cannot read. Messages are clamped to three lines with the rest on hover — a
ClickHouse message carries paragraphs, and left to wrap, two hundred of them made
a section thirteen hundred lines tall.

Both sections say so plainly when the table they need is switched off, which it
is on plenty of servers: `system.text_log` in particular is off by default in
many builds.

**Dictionaries.** The one piece of ClickHouse that fails and keeps answering: a
dictionary that loaded once and is now failing to refresh returns the values it
had, and nothing a query returns says so. Neither does its status, which reads
`LOADED` — that was found by producing the state rather than by reading the
documentation, which names a `FAILED_AND_RELOADING` this server never used. Nor
does `error_count`, which is reset and re-raised as the loader retries. What does
not flicker is the clock: a last successful load a whole lifetime past due.

Two things on that page are deliberately *not* faults. `NOT_LOADED` is innocent
where `dictionaries_lazy_load` is on — the default — and the page says so rather
than flagging every dictionary nobody has queried yet. A lifetime of zero means
"never refreshes on its own" only where the dictionary has loaded; where it has
not, the server has not read the definition yet, so Flint prints nothing rather
than asserting a configuration it has not seen.

**What it is running against.** Between "what is running" and "what happened"
there is a third question: how much room is left. Every figure on that panel is
paired with the ceiling the server would refuse at — memory against
`max_server_memory_usage`, the merge pool against its own size, the fullest
partition against `parts_to_throw_insert`, each disk against its total. A ceiling
of zero means no limit in ClickHouse, so it is left off rather than drawn as a
full bar, and the row moves to a group that has no ceiling column at all.

`system.events` is not among the sources, on purpose: it counts from boot, and on
a server up for eleven days it says nothing about this minute. The per-second
figures come from the newest bucket of `system.metric_log`, whose
`ProfileEvent_*` columns are deltas — and the panel says how old that bucket is,
because it is written on a buffer and "now" and "the newest row" are not the same
thing.

Alarms that are not firing are collapsed into one line that names them, so
"nothing is delayed, no replica is read-only, nothing is behind" reads once
instead of as three zeroes under a warning. Watching is opt-in and says its
interval.

**Where the processor went** is the sampling profiler, read back from
`system.trace_log`. Two questions, not one: processor time answers "what was it
computing" and wall clock answers "where were the threads", including every one
that was waiting — an idle server has a few thousand of the first and millions of
the second, and reading one as the other is the easy mistake, so both are offered
and each says what it answers.

Flint counts the innermost frame rather than the whole stack. A stack is thirty
frames deep and twenty-eight of them are thread-pool plumbing identical in every
sample, so counting all of them puts `ThreadPoolImpl::worker()` on top of every
server ever profiled. Measured under load, `trace[1]` alone put `sipHash64Keyed`
on top — the function the query was actually in.

Most addresses have no name: the official build ships no line tables, and
`addressToSymbol` returns nothing for an inlined frame. That proportion is the
finding, not a footnote — 28 CPU samples with none unnamed against 6204
wall-clock samples with 6172 unnamed, on the same server in the same fifteen
minutes. So the panel counts what it could not name and says so above the list,
because a top-three built from 32 samples out of 6204 looks exactly as
authoritative as one built from all of them.

Under thirty samples in the window there is no list at all, only the count. The
profiler fires once a second per busy thread, so five minutes on a quiet server
is ten samples, and ten samples draw eight rows tied at 13% — a picture of
nothing. A caution printed above that table would be read as a caveat on an
answer; printed instead of it, it is the answer.

## Changing a table's shape

On the Schema page, beside dropping: add a column, rename one, change its type,
drop it, set a TTL, remove one. Each says what it costs **this** table before the
button — "rewrites 4,000,000 rows across 4 parts" is a sentence about a table, so
it comes from the server rather than from a template.

Two things there were measured rather than assumed. `ADD COLUMN` rewrites
nothing, with or without a `DEFAULT`: the default is computed on read until a
merge writes it down, which makes it cheap to add and not free to query.
`RENAME COLUMN` *does* rewrite, which is the one most people would call
metadata-only. And "done" means done — `alter_sync` defaults to waiting for the
mutation on this replica, so a job that reports done has really applied; on a
replicated table the label says it waited for this replica and not the others.

The same panel handles skip indexes and projections, and carries the fact that
makes them worth a screen: **declaring one does nothing to the data already
there, and the statement says it worked.** Measured — `ADD INDEX` leaves the index
at zero bytes with no mutation; `MATERIALIZE INDEX` fills it in. So a table can
carry an index every query ignores, and a projection that answers nothing,
indefinitely, with no error anywhere. There is no status column for that, so the
size is read as one: "nothing — never built".

Types go to the server as you write them. Flint does not parse ClickHouse's type
grammar: it is large, it changes between versions, and refusing a type this
server understands would be worse than passing it on. A semicolon or a comment in
a type is refused, because that is the one way one statement becomes two.

## Making a table

Beside altering, on the same row: **Copy**. It opens the definition the server
itself holds for that object — `create_table_query`, formatted into lines and
with the name already changed — and creating from it makes a new object.

That is the DDL rather than a form because the DDL round-trips: the server's own
text, renamed, produces the same shape, and it covers parts of ClickHouse's
grammar no form would. Nothing validates the SQL, and nothing needs to:
ClickHouse's HTTP interface refuses a body holding more than one statement and
runs neither of them. Flint adds only its own policy — this runs a `CREATE`, and
not an `OR REPLACE` that would drop what is there.

Put the original name back and the button greys with a sentence saying why,
rather than letting the server answer "already exists".

## Where data is allowed to live

Storage policies, on the Schema page. A policy holds volumes in priority order, a
volume holds disks, and a part goes to the first volume that will take it — and
three things worth knowing are in neither `system.storage_policies` nor
`system.disks` on its own:

- **Which volumes the server is draining right now.** `move_factor` is not how
  much to move; it is the free-space ratio below which the server moves parts
  downward on its own, continuously. A development machine 80% full satisfies a
  factor of 0.2 already, so anything moved onto its hot volume leaves again within
  seconds — measured twice, at three seconds and under ten. The page says which
  volumes that is true of, because otherwise `MOVE PARTITION TO VOLUME` is a
  button whose effect does not outlast the click.
- **Which disks belong to no policy.** Nothing can ever be written to those. The
  backup disk is one of them on a stock server: it looks like capacity and is not.
- **Whether a "tier" is really two filesystems.** Two disks reporting identical
  free and total space are almost certainly one, and a tier that does not change
  which disk can fill up is not a tier. Said as an inference, because there is no
  filesystem id to read.

`ALTER TABLE … MOVE PARTITION TO VOLUME|DISK` sits at `ddl` — it destroys nothing
and changes where the bytes are — on the same partition row as detach, freeze and
drop.

## Which ClickHouse this is

Above the settings, because it is the coarser answer to the same question. A
version alone is not an identity — two servers both reporting `26.7.5.10` can be
an official release and somebody's branch — so the panel carries the commit, the
branch and the build type beside it, and says plainly when the build is *not* an
official one.

Three things there are not trivia. A `Debug` build is several times slower for
reasons no query plan explains. `TZDATA_VERSION` decides what every `DateTime`
conversion returns, and a stale one is wrong with no error at all. And the
optional features that were compiled *out* are the answer to "why can this server
not do that" — a build without `USE_AWS_S3` cannot back up to S3 and says so
nowhere else. Where all of them are in, the panel says that too, because an empty
list reads as a failure to look.

## What this server is running with

Infrastructure → Config, and the point of it is that two tables answer two
different questions.

`system.server_settings` is the server's own configuration — the same for every
connection, and authoritative. Flint shows the ones somebody **wrote down**,
which is not the same as the ones that differ: on a stock server about half the
written settings hold exactly the value the server would have used anyway, so
those are separated and counted. The obsolete-and-set ones come first, because
configuration the server no longer acts on is invisible in the file. And the
restart note is on the settings you *can* change on a reload, not the ones you
cannot — 39 of 46 need a restart, so the note would otherwise repeat down every
row and say nothing.

`system.settings` answers a different question: what a statement on *this
connection* would run with. That includes everything Flint attached to it — a
timeout, a row cap, a block size — so those are listed apart and labelled as
Flint's own. Without that, the page reports Flint's timeout as your server's
configuration, which it did do, once, for `log_comment`.

If the connection is running in `compatibility` mode, that is said first —
before the settings, because one such line moves hundreds of them at once and
none of those is a choice anybody made here. Flint measures which ones rather
than guessing: it asks the same question again with that line undone, and what
stops differing was its doing. Those are counted and not listed, so the settings
somebody did choose stay visible.

At `admin` tier there are eight `SYSTEM` statements, each with the sentence
saying what it costs before it is pressed. Two of them — stopping and starting
merges — change a state ClickHouse reports nowhere: the `Merge` metric reads zero
whether merges are stopped or idle. Flint says so rather than implying a switch
it can read back, and the job row is the only record that it happened.

## Backups

`FLINT_BACKUP_DISK` names the disk Flint may write to. It has to be told:
ClickHouse refuses `BACKUP … TO Disk(…)` unless the server's own
`backups.allowed_disk` sanctions the destination, and that setting cannot be read
from SQL. Unset, Flint takes no backups and the page says why.

Infrastructure → Backups reads `system.backups` — and says what that is. It is a
log of what this server has been asked to do **since it started**, not a catalogue
of what exists: it does not survive a restart, so a backup older than the server's
uptime is on the disk and not in the list.

Taking one needs `ddl` — it reads data and writes a file, and destroys nothing.
Restoring needs `admin`, and is refused unless the table is **absent**. ClickHouse
will restore over an existing table given the right setting; that is a different
decision from putting back what was lost, and Flint asks you to drop it first so
the decision is one somebody made rather than one a button made for them.

Where `system.backup_log` is switched on — it usually is — that list survives a
restart, and the heading says so. Where it is not, `system.backups` is all there
is and the page falls back to it, saying that a backup older than this server's
uptime will be on the disk and not in the list.

Neither is a catalogue, and cannot be: a backup disk cannot be listed from SQL at
all. `filesystem()` is confined to `user_files` and refuses anything outside it,
and there is no statement for removing a backup — so Flint offers no retention,
because it could neither find the old files nor delete them.

**S3 works by configuration rather than by a second code path.** Point
`FLINT_BACKUP_DISK` at an S3 disk defined in the server's own storage
configuration and everything else is unchanged — which is the reason to do it
that way: `BACKUP … TO S3(url, key, secret)` would put the credentials in a
statement that both `query_log` and Flint's job table record, and a named disk
keeps them in the file that owns them.

One thing does change. **A zip cannot be written to object storage** — the server
refuses it, because zip needs seeking and S3 does not do that efficiently — so the
suggested file name follows the disk's type, `.tar.gz` where it is object storage
and `.zip` where it is local, and a zip aimed at a bucket is refused in the form
rather than in the job list. A name with no extension writes a directory of
objects rather than one archive, which is allowed and not corrected.

The trade-off, since it is easier to read here than to discover: with a named
disk the object keys are generated, so a backup called `nightly.tar.gz` is not
findable in the bucket by that name. Flint's list is where the names live.

A whole database can be backed up and restored, not only a table. That is one
statement rather than a loop, and it matters: `RESTORE DATABASE` puts the table
definitions back too, so a database dropped entirely comes back whole.

A row in that list also says **what it was of**, which `system.backups` does not
record — it has the destination file and not the source. Flint joins it to its own
job rows on the `query_id` every statement it sends carries, so a backup Flint
took names its table and, if that table is gone, offers a Restore. A backup taken
in a terminal keeps its file and gets no button: Flint would be guessing which
table it held, and says so in the row rather than greying out in silence.

To develop against any of this you need a destination, which a default ClickHouse
does not have: `contrib/dev-backups.xml` gives the compose fixture one.

## Where a table's rows actually are

A dozen of ClickHouse's engines store nothing of their own. `S3` reads objects out
of a bucket, `PostgreSQL` queries somebody else's database on every `SELECT`,
`Kafka` drains a topic. Flint used to draw those as a MergeTree with an odd name
and no size, which is the one thing they are not: the question in front of an `S3`
table is *which bucket*, and the answer was already on the page — folded into
`engine_full`, and shown nowhere but the DDL tab.

So the object page reads it, under the sentence that says what the engine does. A
bucket is split into the parts somebody would read out loud — `flint/events/*.parquet`
**on** `s3:9000`, its region where the host names one, its format, its compression.
A `PostgreSQL` table says `shop.public.orders` on `pg.internal:5432` and the user it
connects as. A `Kafka` table says its topics, its brokers, its consumer group. The
same line appears on the diagram's side panel, where the address is what tells two
otherwise identical nodes apart. A database engine gets the same treatment: a
`PostgreSQL` database makes every table under it a table on another server, and said
so nowhere before.

**Nothing in it is guessed.** These signatures are positional and several are
variadic — `S3` takes a path, or a path and a format, or a path with two credentials
wedged between them — so an argument Flint cannot name is *counted* rather than
labelled, and the panel says how many. A host presented as a database name is worse
than an argument the page admits it did not read. The credentials never appear
because ClickHouse itself replaces them with `[HIDDEN]` unless
`format_display_secrets_in_show_and_select` is on, which Flint never asks for — and
the panel says so, once, so nobody goes looking for the setting in Flint.

Reading these tables also settled what their *figures* mean. `system.columns` does
not report zero for an `S3`, a `URL` or a `File` table: it reports ClickHouse's own
planning estimate, a flat 100 MB compressed and 1 GB raw per column, identical down
the table — which Flint drew as "95 MiB on disk, 954 MiB raw, 10×" on a table holding
nothing at all. Those columns are now dropped. So are the zeroes the diagram drew for
the same tables, which read as an empty table rather than as a table this server has
never held; a node whose rows are elsewhere counts its columns instead.

## Whether a streaming table is actually moving anything

An `S3` or a `PostgreSQL` table is read when somebody queries it, so one pointing
at the wrong place fails in front of the person who asked. A `Kafka` or an
`S3Queue` table is not like that. It runs on its own, in the background, and when
it stops the only symptom is a target table that quietly stops growing — which is
the same reason the dictionary page exists, and the reason those two engines get a
tab of their own.

For a `Kafka` table it reads `system.kafka_consumers`: who is assigned which
partitions, where each one is, when it last polled and last committed, and the
server's ring of the last ten exceptions. For an `S3Queue` it reads
`system.s3queue_log` — every object taken, whether it parsed, how many rows it
produced — and the settings the queue was created with, `mode` first, because
that decides whether an object can be taken twice.

The sentences above the table are the point. Three states came out of running one
against a real broker, and none of them can be told apart from the address alone:

- **Declared and never started.** A `Kafka` table with no materialized view
  reading it does not consume. The server still creates its consumers, so the
  table looks configured and the topic never moves. Nothing else in ClickHouse
  says this; here it is the first line on the tab.
- **Running.** A consumer id, partitions assigned, offsets moving.
- **Polling and delivering nothing.** ClickHouse inserts a *block* of messages at
  a time, so one unparseable message does not cost you that message — it fails
  the whole block, commits nothing, and the block is read again. On the
  development fixture the consumer had read 2,911 messages, committed none, and
  delivered zero rows, from 41 messages of which one is bad. It polls, its
  counters climb, and every other view of it looks healthy.

Two figures the server reports are not measurements, and both are dropped before
they reach the browser. A partition assigned and not yet read from reports offset
`-1001` — librdkafka's "no offset", which rendered as a number is a table saying
it is a thousand messages behind. And `1970-01-01` in a timestamp means the thing
never happened, so the column says *never* rather than a date.

Repeats are folded and counted, in both halves. A consumer stuck on one message
fills its ring with ten copies of one error under two spellings; a queue retrying
one object writes the same six-line exception once per attempt. Both collapse to
one line with a count and a span — the attempts are real and stay counted, it is
the text that stops repeating.

## Whether the address answers

A definition is metadata. ClickHouse stores `S3('http://s3:9000/flint/…')`
without checking that the bucket is there, so the panel above can describe, in
perfect detail, a connection that has been broken for a year — and the first
person to find out is whoever runs a query. So the panel has a button that asks.

It runs `SELECT * FROM <table> LIMIT 1`, read-only, with a fifteen-second budget
of its own, and throws the row away. One row rather than a count: `count()` on an
`S3` table with a glob over ten thousand objects reads all ten thousand, and the
question is whether the far end answers, not how much is in it.

It is a button and not a reading taken on page load, and that is the whole design.
Every other figure on that page comes out of `system.*` on a server Flint is
already talking to; this one opens a connection to somebody else's
infrastructure, and a page that contacts a production Postgres because a tab was
opened is a page nobody can leave open.

Four outcomes, kept apart because three of them are usually rendered as one red
box and they send you to three different places. **Answered, with a row.**
**Answered, with nothing there** — which is the diagnosis for half the tickets
this shortens, and a green tick alone does not give it. **No answer**, with the
server's own words: `could not translate host name "pg.internal" to address`,
`Access Denied`, `HTTP status code: 404`. Every rewording of those Flint could
attempt would be a worse version of what somebody is about to paste into a search
box. And **refused**, in grey rather than red, because Flint did not try.

It refuses two kinds of table. One whose rows are on this server, where there is
nothing to reach. And a queue: reading a `Kafka` or an `S3Queue` table *takes*
from it, and what a check consumed would never reach a target table. That last
one is also why the three surfaces that sample rows — the preview tab, the
diagram's side panel, the peek under it — do not ask for a sample from a queue at
all. ClickHouse refuses a direct select there by default and answers with a
message naming the setting that would allow it, which is a poor thing to put in
front of somebody as the explanation of an empty tab; and on a server where that
setting is on, clicking a node would silently eat a message.

## Everywhere this server reads from

The three readings above answer one table at a time, which is the right shape for
"what is this table" and the wrong one for the question somebody actually arrives
with. Credentials rotate on a bucket and thirty tables stop working at once; a
host is decommissioned and nobody knows which tables pointed at it. Neither is
answerable from a page you have to open thirty times.

So the server page has an inventory: every table whose rows are not on this
server, **grouped by the far end rather than by the engine**. Two `PostgreSQL`
tables on two different servers have nothing to do with each other, and an `S3`
table and an `IcebergS3` table on the same bucket have everything to do with each
other — the grouping key is the address, because the address is what breaks
together. It reads the same `engine_full` the object page does, through the same
parser, so a bucket cannot be split in two by two spellings of one rule. Two
protocols that happen to share a hostname stay apart.

The header gives both figures — how many tables, and how many places — because
either alone misleads: six tables on one bucket and one table each on six buckets
are the same "six tables" and completely different exposures.

And one button checks every address, one at a time and in order. Not all at once:
each is a connection to somebody else's infrastructure, and firing forty in
parallel is something a monitoring system does deliberately and a page should not
do because a button was pressed. The verdicts are **per table, never per group**,
however much a green tick on a bucket would please — two tables on one bucket can
carry different credentials, so "this bucket is fine" would be a claim about a
table nobody asked.

## How a table got here

The DDL tab shows a table's definition. Underneath it, Flint now shows the record:
every `CREATE`, `ALTER`, `RENAME` and `DROP` that touched the object, who ran it,
and whether it went through Flint or somebody's terminal. `system.query_log` has
been recording this all along; nothing else displays it.

Two limits are on the panel rather than left to be discovered. The log has a TTL,
so the panel states how far back what it can see actually reaches — a history that
quietly stops is worse than none. And a `CREATE DATABASE` names no table, so it
will never appear there.

Repeats are folded and counted. Flint's own workspace bootstrap runs
`CREATE TABLE IF NOT EXISTS` on every start, so without folding, the history of
its own tables would be fifty identical rows burying the one `ALTER` somebody came
to find.

## Reviewing a table's schema

Every column of a ClickHouse table was declared once, usually before anybody knew
what would go in it, and never revisited. The costs of getting it wrong are quiet
and large: a `String` holding six distinct values, a `Nullable` that has never
been null, an `Int64` counting to forty, a date stored as text so no index can
prune on it. None of it shows up as an error. A table's Schema review tab looks
for it.

**A hypothesis is not a verdict, and the page never confuses the two.** The first
pass reads a bounded prefix of the table — cheap, immediate, and labelled as
guesses. "The first 200,000 rows fit in a `UInt16`" is not "the column fits in a
`UInt16`", and a tool that conflates those will eventually propose an `ALTER` that
truncates somebody's data. A button reads every row and turns the survivors into
verdicts, with the cost of doing so stated on it.

**A saving is measured, never predicted.** The review says what a column costs
*today* — a figure ClickHouse measured — and never a percentage it would save.
`Measure it` writes the same rows both ways into a scratch table in Flint's own
database, weighs them, and drops it: same rows, same part, same settings, one
difference. On this project's own data an `Int32` narrowed to a `UInt16` halved
the *raw* bytes exactly as arithmetic says, and moved the compressed bytes by
14% — because the compression had already found the redundancy. An estimator
would have promised half.

The same button reports what one grouping of the column cost the engine, in bytes
read. Bytes rather than milliseconds, deliberately: a timing over a table written
a second ago measures the page cache, while the bytes are the same warm or cold.
One column measured 1.1× smaller on disk and 16.7× fewer bytes scanned — the same
change, two verdicts, neither of them guessable.

**A refusal is the most useful answer it can give.** The scratch table is filled
with `accurateCast`, not `CAST`: `CAST(toInt32(300) AS UInt8)` is `44` on
ClickHouse 26.7 — it wraps, silently — while `accurateCast` refuses. So weighing
doubles as a safety check over real rows, and it has already contradicted the
review's own hypothesis: a `Nullable` column with no nulls in the sample turned
out to have 3,272 of them, and the refusal said so in ClickHouse's own words
before any `ALTER` was written.

**Codecs are weighed rather than recommended.** A codec is lossless, so nothing is
at stake but bytes — and which one wins cannot be reasoned about. Measured here:
`DoubleDelta, ZSTD` made a `DateTime` 3.3× smaller; `T64, ZSTD` made one `UInt64`
3.4× smaller while plain `ZSTD` beat it on the `UInt64` in the next column along;
and `Gorilla` — the codec every guide recommends for floats — made a `Float32`
column 29% *bigger* than the default. Candidates are chosen by the server from the
column's type family, all weighed in one pass, ordered by what they cost, and the
one that comes out worse than today stays in the list and is marked. A column
whose codec somebody already chose is left alone.

**What a column costs is only half the question.** The other half is whether
anything reads it, which `system.query_log` can answer exactly: each finding says
`read by 85 queries in 7 days`, or that nothing has read it. Flint's own questions
are excluded, or the report is a self-portrait — the page measuring a table is,
that week, one of the biggest readers of it.

The window is the log's, not the question's. `system.query_log` commonly has a
one-day TTL — on the machine this was built against it held twelve hours — so a
seven-day question gets a twelve-hour answer, and the panel says *in the 12 hours
the log keeps* rather than *in 7 days*. That sentence is the one somebody drops a
column on; wrong by a factor of fourteen it is worse than absent. The hours are
the server's own subtraction, because `event_time` is on ClickHouse's clock and a
browser's is its own, and doing it in the browser was two hours out.

The log records *which* columns a query touched, not what it did with them, so the
question everybody asks next — is it filtered on, is it in an `ORDER BY` — has two
possible answers: guess from the SQL text with regular expressions, or show the
SQL. Flint shows the SQL, grouped by ClickHouse's own normalised hash so a hundred
runs differing in a literal are one entry, biggest reader first, each one a click
from the editor.

And "nothing reads it" is not "nothing needs it". For an `INSERT` ClickHouse logs
no columns at all, so a table taking rows every minute looks abandoned from the
read counts alone. The review counts the writes separately: where they exist, a
column nothing reads is reported as a conversation to have with whatever writes
it, because an `INSERT` that names the column fails the moment it is dropped.

**A wide table's review is several arguments at once, and nobody wants all of
them.** `system.query_log` produces sixty findings across four subjects at a time:
dictionaries, number widths, text holding a date or a UUID, and columns that say
nothing. Somebody tuning storage has no use for the last of those, and somebody
auditing what a table actually holds does not want to argue about codecs today. So
a finding carries a *kind* as well as a severity — what it is about and how much
it matters are different questions, and ranking by what a column costs can only
answer the second — and the `kinds` filter takes a whole subject away at once. The
choice is remembered across tables — and across every surface that lists
findings, because "codecs are not my problem" is a position about the advice
rather than about the page it was read on — and the count that survives says
what it hid: *20 changes worth considering · 3 hidden by kind*. A kind this table
has nothing in is not offered, because a checkbox that hides nothing is not an
offer.

The same filter sits on the database-wide reading, where it matters more: that
page argues about forty tables at once, and one switched-off kind is the
difference between reading a hundred and fifteen decisions and reading ninety.
What it will not do there is quietly change the SQL. A tick is an explicit act
and a filter is a way of looking, so hiding a kind leaves the statements
somebody already chose exactly as they were — and says so above the block,
*2 ticked in a kind you have since hidden, still in the SQL*, rather than
letting them travel to a terminal unseen.

**Which table to open at all.** A review is per table, and nobody with a hundred
and sixty of them starts at the right one, so the panel offers the question that
comes before it: where the rest of this database keeps its disk. The heaviest
columns across every table, from part metadata alone — no sampling, nothing read —
each one a click from that table's own review.

The coverage is stated beside the ranking, and on a database of small tables it is
often partial: per-column bytes exist only in `Wide` parts, so the list says it
accounts for, say, 11 MiB of the 14 MiB the parts hold and where the rest is. On a
database whose every part is Compact there is nothing to rank at all, and it says
that instead of showing an empty list that would read as "no columns worth
mentioning".

**Nothing here runs DDL.** Each finding hands over the statement and the reason to
think twice — that `MODIFY COLUMN` is a mutation which rewrites every part of the
column, that a column in the sorting key mostly cannot be retyped at all, that
dropping one has no undo. The `ALTER` is copied, read, and run by a person.

Two figures are absent rather than guessed. Per-column bytes only exist in `Wide`
parts — a `Compact` part keeps every column in one file — so on a small table the
size is reported as not measurable rather than as a confident zero, and no codec
findings are offered at all, since without a size there is no way to say the
change is worth the rewrite. And where the query log cannot be read, the usage
line is absent, which is a different answer from "nothing read it".

## Which projections the workload argues for

A ClickHouse table has exactly one physical order, chosen once, and a query that
does not filter on a prefix of it reads the whole thing. A projection is the
escape — a second copy of some columns in another order, or a pre-aggregated one,
kept in the same parts and chosen by the server without the query changing at
all. Whether one is worth its disk is a question about a *workload*, not about a
schema, so a table's Projections tab starts from `system.query_log` and not from
the DDL.

**The evidence comes first, and it is the log's.** Each proposal names the query
shapes behind it, how many times they ran, how many rows each run read and what
share of the table that is, and the time the window actually spent on them —
which is also how the proposals are ranked. The workload itself is capped at the
sixty costliest shapes, and the cap says so: *"the 60 costliest of 104 query
shapes, 118 of 162 runs"*, because a list silently truncated reads as the whole
workload and invites the conclusion that nothing else asks anything of this
table. Nothing is ranked by a predicted
saving. The sample statement is there to open in the editor, because a
recommendation is only ever as good as the workload it was read from.

**The benefit is counted, not modelled.** `Measure it` runs one pass over the
proposed key and comes back with the figure the whole argument rests on: how many
distinct values are behind it. For a pre-aggregated projection that *is* the
answer — the projection holds one row per group per part, so 31 distinct days
over five parts is at most 155 rows against five million, and it falls towards 31
as the parts merge. For a re-sorted one the floor is arithmetic ClickHouse's own
behaviour fixes: it reads whole granules and every part contributes at least one,
so `parts × index_granularity` is the best case however selective the filter is.
Measured on a five-million-row table in five parts, a filter matching 250 rows
read 40,960 — five times 8,192, and not 250. A tool that promised 250 would be
wrong by a factor of 164.

The figures are rows, never seconds. How much faster a query gets from reading
less depends on the query, the disk and the cache, and the page says so rather
than putting a number on it.

**The cost is stated as loudly as the benefit.** A projection is written on every
insert and merged on every merge, for as long as the table exists. A re-sorted
one is a second copy of the columns it holds, and the page gives their size
*and their share of the table*, because that is the figure a byte count hides: on
the table this was built against, a projection keyed on a small string column
still came to as much as the whole table — entirely because one of the patterns
behind it also selected the timestamp.

A pre-aggregated one has no such shortcut. Its size depends on the width of the
aggregate *states*, and a `uniqCombined` digest is not a number anybody can read
off a schema. So `Weigh it` builds it: the same grouping and the same states go
into a scratch table in Flint's own database, its parts are read, and it is
dropped. The states and not the finalized values, because a `quantile` state is a
digest many times wider than the `Float64` it finalizes to, and weighing the
finalized form would under-report by an order of magnitude and call it a
measurement.

It is a **range, and the range is honest.** One part's worth is the floor and
`× parts` is the ceiling, and which end a key lands on was measured both ways: a
key of three values came out at exactly five times one part, because every part
holds all three; a key of thirty-one days came out 15% under the ceiling, because
the parts were written in time order and each holds only some of the days.
Nothing in Flint can tell which case a key is, so both ends are given and neither
is called the answer. Checked afterwards against the real thing: a seven-aggregate
proposal was weighed at 1.3 MiB to 6.3 MiB, and the projection built from it
measured 2.57 MiB.

That figure is the whole reason the button exists. Thirty-one rows sounds free;
those thirty-one rows carry four `uniqCombined` digests and come to a sixth of
the table, and nothing short of building it would have said so.

**It proposes the narrow projection, and says what the narrow one cannot answer.**
The column list is the difference between a proposal costing 8% of the table and
one costing 100%: measured, `SELECT *` came to 22.5 MB against 1.7 MB for the
same key holding only the two columns those queries read. The price of the narrow
one is that a query reading any other column cannot use it — the same query with
`max(time)` added went straight back to reading all five million rows, silently,
with no error and nothing in the result to say so. That sentence ships with every
proposal.

**Aggregates are matched by expression, not by algebra.** A projection storing
`count(), sum(value)` does not answer `avg(value)` — measured, five million rows
read rather than fifteen — so the proposal carries the aggregate expressions the
workload actually wrote, and says which ones it will and will not answer. Where
several shapes group the same way they fold into one proposal holding all of
them, and the page says so when that has folded in more than it should.

**It says what to drop, not only what to add.** A page that only ever proposes
adding is a page that grows somebody's disk forever: a projection is written on
every insert and merged on every merge whether or not a single query has ever
chosen it, and ClickHouse raises nothing about one that does nothing. So the
existing projections are read back with what they hold and how many runs the log
says actually *used* them, and two of those readings are findings.

*Declared and never built* is a fact about the table and needs no log at all —
zero parts, so every query ignores it, and the statement that created it reported
success. The size is the only tell there is, and the row says `never built`
rather than a size. It is offered both ways out, because either may be what was
meant: build it, or drop it.

*Built and nothing used it* is a claim about the workload, and it is only ever
made where the log could actually answer. The count is taken over **every** run
in the window and not over the shapes the page happens to list — those are the
sixty costliest, and a projection answering a cheap frequent query would
otherwise be reported as unused, which is the one mistake here that costs
somebody a regression. Where this server does not record which projection served
a query the answer is absent, never zero. And the caution ships with the finding:
the window is what the log kept, not what was asked for, so a monthly report is
invisible in seven days.

**Nothing is proposed from a query Flint did not read.** The parser here reads a
single-table `SELECT` and refuses everything else — a join, a `UNION`, a filter it
cannot attribute to one column, a grouping expression it cannot resolve. Refused
shapes are *listed*, with the reason and what they cost, rather than dropped: two
proposals over a workload of forty shapes would otherwise read as the whole
truth. Proposals argued from two runs or fewer, or from under a twentieth of the
window's time, are folded behind a count for the same reason — a permanent cost
is not argued from an afternoon.

**Nothing here runs anything, and the tab could not run it if it wanted to.** A
projection is structure, and structure is Infrastructure's to write — the table
page is Data, and the rule that keeps the two spaces honest is that no Data
control changes structure as a side effect. So a proposal does what an import
into a missing table does: it offers the DDL and hands it over. `Take it to
Schema` opens Infrastructure → Schema with the operation and its fields filled
in, still to be submitted, and still editable — a proposal is an argument and not
an instruction.

Two statements are copied, not one, and the page says why: `ADD PROJECTION` is
metadata. It reports success, builds nothing, and leaves every query reading the
table exactly as before — measured at zero parts and no mutation. Building it is
`MATERIALIZE PROJECTION`, which is the mutation the declaration was not.

**And the same question across a database.** A database page's *Keys* reading
ranks its tables by the time the workload actually spent on each, and says what
that table's costliest shapes do: whether the sorting key serves them, whether a
projection already answers one, whether they ask for the whole table in a way no
layout helps, or whether the table is small enough that a few granules is the
whole of it.

What it claims is narrower than it looks, deliberately. It reads five shapes per
table where the table's own tab reads sixty, so every sentence is about *those
shapes* — "one of the 4 costliest shapes read here filters on `city`, which is
not a prefix of `device_id, ts`" — and the page says in as many words that this
is enough to know which table to open and **not** enough to conclude a table has
nothing worth doing. Three reads answer it for the whole database rather than
one per table.

Reading only the *first* shape that parsed was the first version and it was
useless on a real log: on a machine somebody develops on, a table's costliest
statements are a cross join and a profiling scan, and the page said "nothing to
serve" about a table the per-table advisor finds two proposals on. All five are
read now and the strongest finding wins.

**Finding the table is Diagnose's job, and it already had the answer.** *Which
tables are read* has always carried the scan share — rows read per read against
the rows in the table — with the verdict that says it plainly: "each read walks
the whole table, the sorting key is not narrowing these queries". That sentence
is the projection argument, and until now it led nowhere. It now offers *would a
projection help?*, which opens that table's tab.

A question, not a recommendation: whether a projection is worth its disk depends
on the shapes behind those reads, and reading them is the tab's job. It is
offered only above eight granules' worth of rows, because a lookup table of five
rows reads 100% of itself and always will — asking there is not a question, it is
advice, and it is wrong. Three of the six rows that first qualified were
dictionary sources, which is how the floor got written.

Where the query log is off or ungranted the tab says so and proposes nothing,
because there is nothing to base a recommendation on — which is the honest answer
and not a schema-shaped guess. That correct answer is also indistinguishable from
a broken advisor, so the dev stack seeds a workload
(`contrib/dev-workload.sql`): on a fresh `docker compose -f
docker/dev.yml up`, `analytics.events` opens on seven shapes over
nineteen runs, two proposals, one shape that the sorting key already serves, one
that a projection already answers, one folded as thin and one listed as unread.

## Parts that are on the disk and not in the table

`detached/` is where a MergeTree puts a part it is not using, and ClickHouse never
cleans it up: a partition detached in March is still occupying disk in December,
and the way people find out is that a disk fills. Infrastructure → Health lists
them, largest first.

Two things end up there and they are opposite situations, so Flint marks them
apart. An empty `reason` means somebody ran `DETACH PARTITION` — a step in a
procedure, and reattaching is the obvious next one. Anything else is the server's
own word for why it moved the part aside: `broken`, `unexpected`,
`covered-by-broken`. Flint repeats that word rather than paraphrasing it, because
those mean different things to somebody who knows ClickHouse.

Attaching needs `FLINT_TIER=ddl`; it is undone by detaching again. **Deleting** a
detached part needs `admin`, because it removes data from a disk with nothing to
undo it — two clicks with the bytes named, and the job records the statement
including the flag ClickHouse demands before it will do it at all. Attaching a
part the server quarantined is allowed, and deliberately does not get the emphasis
of the safe case: sometimes a broken part is exactly what you want back, once you
have read why it was set aside.

## The cluster, from one node

Infrastructure → **Clusters** reads the ring around the server Flint sits beside.
It needs no fleet: `system.clusters` is that server's own configuration,
`system.replication_queue` is what its replica has left to apply, and
`system.distributed_ddl_queue` is a ledger every node in the ring shares.

- **Shards and replicas**, drawn — shards across, replicas down, the local node
  marked, and an endpoint the server has failed to reach carrying its error
  count. A node nothing has *tried* is left silent rather than called healthy:
  the section reads what the configuration says, not what answered lately.
- **Replicas**, per replicated table on this node: delay, read-only, lost parts.
- **The replication queue**, ordered by failures rather than by age — an entry
  retried two hundred times is the story whatever its neighbours' timestamps say.
- **Distributed DDL**, folded back to one row per statement. The server keeps a
  row per host, and "ran on 3 of 4" is a fact about the statement — a table of
  host rows makes the reader assemble it by scanning adjacent lines, which works
  for two nodes and does not for twelve.

  The trap it exists to spring is in the status column: a host where the
  statement **failed** is marked `Finished`, because the status is about the
  queue entry being done with and not about the statement working. Reading it
  alone reports a success on the node where the table was never created. So the
  page reads the exception beside it, names the host, and shows the exception
  once rather than once per host.

  A host that is merely *absent* is a third thing, kept apart from both: its row
  reads `Inactive`, and it runs the statement when the node comes back — watched
  doing exactly that, `Inactive` to `Finished` with the table present. Nothing
  has gone wrong, and flagging it red would light the page up over a server
  being restarted.

  The statement shown is the one that was written. `ON CLUSTER` is rewritten
  before it reaches the ledger — the initiator assigns the table's UUID so every
  replica creates the same one — and thirty-eight characters of machine
  bookkeeping in the middle of the column nobody scans for it. The stored form
  is one hover away.

Three ways a section can be unavailable, and Flint keeps them apart because each
sends you somewhere different: a **grant** is missing, the table is **not on this
build** (an older ClickHouse), or there is **no Keeper** — the table is there, the
server is not in a cluster, and nothing is wrong. A single node is a perfectly
ordinary way to run ClickHouse, and the page says so rather than telling its
operator to upgrade or to grant something.

The `default` cluster every ClickHouse ships — one endpoint, itself — is folded
away and counted, the way the explorer folds internal tables.

**Operating a replica** needs `FLINT_TIER=admin`: `Sync`, `Stop fetches`,
`Start fetches` and `Restart replica`, offered on the replica row that diagnoses
them. Each becomes a job — `SYSTEM SYNC REPLICA` waits for the whole backlog, and
a button that holds the page for that is a button people stop trusting — so the
answer appears in Operations on the Health page, recorded against whoever asked.
`Restart replica` sits apart from the other three on purpose: re-reading a
replica's state from Keeper is what you do when something is already wrong.

To develop or verify any of this you need more than one node.
`docker/cluster.yml` brings up one Keeper and two replicas of one shard,
separately from the ordinary development environment:

```bash
docker compose -f docker/cluster.yml up -d
FLINT_CLICKHOUSE_URL=http://localhost:8232 FLINT_CLICKHOUSE_PASSWORD=flint \
  FLINT_TIER=admin FLINT_WORKSPACE_DATABASE=flint cargo run
docker compose -f docker/cluster.yml down -v
```

A populated `system.replicas`, a replication queue with entries in it, a
`SYNC REPLICA` with something to wait for and a stopped fetch do not exist on one
server — and a page developed against empty tables has never rendered a row.

Two more states need producing rather than waiting for, and both are one command:
a statement that half succeeded, from a conflicting table on one replica followed
by a `CREATE TABLE … ON CLUSTER`; and a host that never got one, from stopping a
replica before issuing it.

One thing that fixture taught, worth knowing before writing your own: **a cluster
definition carries its own credentials.** Without `<user>` and `<password>` in
each `<replica>`, reads work perfectly and every distributed *write* comes back
`Authentication failed` from the node the insert was forwarded to — the node
authenticates against its peer as `default` with no password. It reads like an
application bug and it is a line missing from a configuration file.
