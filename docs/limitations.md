# Known limitations

*[← back to the README](../README.md)*

Every feature in the brief is built at least once. This is what is missing
*inside* them, written down rather than discovered.


Every feature in the brief is now built at least once. What is missing inside
them: alerts and reports deliver to webhooks only — no email, which would mean
SMTP configuration and a queue, and no per-recipient routing. A published endpoint
accepts a statement that writes, and ClickHouse
refuses it at call time rather than Flint refusing it at save time — judging that
here would mean a SQL parser that would also reject legitimate statements.
Traffic on the diagram
is per object, not per edge: an edge here is a dependency rather than a call, and
Kiali's edge thickness measures requests between services, which is not a thing
this graph has. Dashboard tiles are reordered with buttons and a width control
rather than by dragging.

A `PostgreSQL` or `MySQL` *database* does not list the tables on the far end:
ClickHouse resolves those on demand, and a database that cannot be reached reads
as an empty one. The consuming tab covers `Kafka` and `S3Queue` and no other
background reader. `RabbitMQ` and `NATS` have no `system` table at all to read;
`AzureQueue` publishes its settings and a metadata cache but no log of what it
took, which is the half that would have made a page. For those three Flint has
the address and nothing else. And it reports; it does not act. There is no button to
skip a poison message or to reset a consumer group, both of which lose data on
purpose and are the wrong shape for a click. The connection check is one
question — does the far end answer — and not a diagnosis: it cannot tell a wrong
password from a firewall, because ClickHouse cannot either, and it quotes the
server rather than guessing between them.

Replication is read-only, and two of its verdicts have been exercised against a
live server while three have not. A healthy replica and one with its Keeper
connection cut were both tested — the second is where the fifty-six-year delay
came from. *Behind*, *a replica is missing* and *lost parts* rest on unit tests
and on what `system.replicas` documents, because reproducing them needs a
multi-node cluster with one node held down. Nothing here can repair a replica
either: `SYSTEM RESTORE REPLICA` and `SYSTEM RESTART REPLICA` are recoveries with
consequences, and a button is the wrong shape for them.

The projection advisor reads one table at a time. Diagnose points at the tables
whose reads walk most of themselves, which is enough to know where to look, but
nothing ranks tables by whether a projection would actually *help* — that needs
the shapes parsed, which happens only once a table's tab is open. It proposes a
key and a column list
and never a `SETTINGS` clause on the projection, and it cannot weigh two
overlapping proposals against each other — where a wider key would serve a
narrower proposal too it says so and leaves the choice, because which is better
depends on what each one measures out at. Its parser reads a single-table
`SELECT`; a workload that reaches this table mostly through views or joins will
find most of its shapes in the "did not read" list, which the page states rather
than papers over.

Weighing a pre-aggregated proposal needs a workspace database to write its
scratch table in, so on a deployment without one those proposals keep their row
count and lose their bytes — stated on the page rather than left to be
discovered. And the weigher will not build an aggregate over an *expression*:
`sum(value * 2)` and `countIf(status = ?)` are perfectly good SQL and are not
things Flint will hand to a statement builder, so a proposal folding one of them
in cannot be weighed at all. Both are the same rule the rest of the page keeps —
a figure that cannot be had is dropped, not guessed.

The schema review says nothing about the two biggest levers a MergeTree has — the
sorting key and the partition key — because changing either means rebuilding the
table rather than altering a column, and a panel of one-click `ALTER`s is the
wrong shape for that conversation. It does not propose an `Enum`: the values
would have to be a closed set that never grows, which nothing in the data can
establish. And weighing a change needs a workspace database to write its scratch
table in, so on a deployment without one the findings stay hypotheses with no way
to weigh them — stated on the page rather than left to be discovered.

See the project brief for where this is going.
