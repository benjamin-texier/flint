-- Two years of monthly-partitioned rows, so the figures about *time* have
-- something to be about.
--
-- This exists for the reason `contrib/dev-workload.sql` does: a reading whose
-- correct answer on a fresh stack is an empty figure cannot be told from a
-- broken one, and the state it needs cannot be reasoned about without producing
-- it.
--
-- The 85 objects in `contrib/play-schema.sql` are ClickHouse's own examples and
-- they are the right fixture for almost everything — they were not built to suit
-- Flint, which is the whole value. What they do not contain is one table
-- partitioned by month with contiguous data in every month. `hits` is one
-- partition, `trips` spreads twelve partitions over eight years, and the rest
-- carry no date at all. So every reading Flint has about time — the arrival's
-- figure, the partition grid, the timeline's grain ladder — was only ever
-- exercised against data that made it look wrong:
--
--   * The arrival drew 308 monthly columns for `2001-01` to `2026-08`, with two
--     years of real data as a sixty-pixel smear at the right-hand end. That is
--     the bug the grain ladder now fixes, and it was invisible until a fixture
--     had enough contiguous months to show the fixed version working.
--   * Tables with no partition key fold into the epoch, so most of the disk
--     appeared as a mountain labelled January 1970.
--
-- 210,000 rows at five-minute intervals from 2024-09-01, which is 24 months and
-- 24 partitions — deliberately under `max_partitions_per_insert_block`, whose
-- default of 100 refuses a single INSERT spanning more than that. About 3 MiB.
--
-- Nothing here is real data and it does not pretend to be: the point is the
-- *shape* — one row every five minutes, unbroken, for two years — which is what
-- an event table looks like to a partition key and is exactly what none of the
-- playground's tables provide.
--
-- ## And one pipeline, for the diagram
--
-- The schema diagram is the thing Flint is best known for and there was nothing
-- in any fixture that produced a single arrow: every database on the dev stack
-- came back with `edges: 0`, including all four from the playground. So the
-- flow reading could only ever be looked at as one box in an empty canvas —
-- which is exactly the state it was drawing badly, and the state that could not
-- be told from the fixed version without an edge to compare against.
--
-- A materialized view over the table above gives two: `events` is read by the
-- view, and the view writes into `events_by_hour`. That is the smallest thing
-- that is genuinely a pipeline rather than a picture of one.

CREATE TABLE IF NOT EXISTS default.events
(
    `ts` DateTime,
    `kind` LowCardinality(String),
    `user_id` UInt32,
    `ms` UInt16
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (kind, ts);

INSERT INTO default.events
SELECT
    toDateTime('2024-09-01 00:00:00') + INTERVAL number * 5 MINUTE AS ts,
    ['click', 'view', 'signup', 'purchase'][1 + (number % 4)] AS kind,
    1 + ((number * 7919) % 5000) AS user_id,
    1 + ((number * 31) % 900) AS ms
FROM numbers(210000);

-- The rollup the view writes into. `SummingMergeTree`, so the arrow out of the
-- view points at something whose engine explains why it exists.
CREATE TABLE IF NOT EXISTS default.events_by_hour
(
    `hour` DateTime,
    `kind` LowCardinality(String),
    `n` UInt64,
    `ms_total` UInt64
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(hour)
ORDER BY (kind, hour);

-- Created after the INSERT above on purpose: a materialized view only sees rows
-- written after it exists, so the target starts empty. That is the honest state
-- for a pipeline somebody just added, and it is the one Flint has to draw
-- without claiming the view has moved anything.
CREATE MATERIALIZED VIEW IF NOT EXISTS default.events_by_hour_mv TO default.events_by_hour AS
SELECT
    toStartOfHour(ts) AS hour,
    kind,
    count()  AS n,
    sum(ms)  AS ms_total
FROM default.events
GROUP BY hour, kind;
