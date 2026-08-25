-- A small schema that exercises everything Flint draws, applied automatically
-- by the ClickHouse container in `docker-compose.dev.yml`.
--
-- The shape is the point: one raw table feeding three materialized views, each
-- writing into its own rollup table, plus plain views over both ends and a
-- dictionary loading from another database. That gives the schema diagram every
-- edge kind it knows how to render.

CREATE DATABASE IF NOT EXISTS analytics COMMENT 'Product telemetry';
CREATE DATABASE IF NOT EXISTS reference COMMENT 'Slowly-changing lookups';

-- ── Reference data, and a dictionary over it ────────────────────────────────
CREATE TABLE IF NOT EXISTS reference.cities
(
    city    String,
    region  String,
    country LowCardinality(String)
)
ENGINE = MergeTree
ORDER BY city;

INSERT INTO reference.cities VALUES
    ('Lyon', 'FR-ARA', 'FR'), ('Paris', 'FR-IDF', 'FR'), ('Berlin', 'DE-BE', 'DE'),
    ('Oslo', 'NO-03', 'NO'), ('Kyoto', 'JP-26', 'JP');

CREATE DICTIONARY IF NOT EXISTS reference.city_region
(
    city    String,
    region  String,
    country String
)
PRIMARY KEY city
SOURCE(CLICKHOUSE(TABLE 'cities' DB 'reference'))
LAYOUT(COMPLEX_KEY_HASHED())
LIFETIME(600);

-- ── The devices sending events ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS analytics.devices
(
    device_id    String,
    model        LowCardinality(String),
    city         String,
    installed_at DateTime
)
ENGINE = ReplacingMergeTree
ORDER BY device_id;

INSERT INTO analytics.devices
SELECT
    concat('dev-', leftPad(toString(number), 4, '0')),
    ['sensor-a', 'sensor-b', 'gateway'][(number % 3) + 1],
    ['Lyon', 'Paris', 'Berlin', 'Oslo', 'Kyoto'][(number % 5) + 1],
    now() - toIntervalDay(number % 400)
FROM numbers(400);

-- ── The raw event stream ────────────────────────────────────────────────────
-- Codecs chosen to make the per-column compression story visible in Flint:
-- `payload` compresses enormously, `temperature` under Gorilla barely at all.
CREATE TABLE IF NOT EXISTS analytics.events
(
    ts          DateTime64(3) CODEC(DoubleDelta, ZSTD(1)),
    device_id   LowCardinality(String),
    city        LowCardinality(Nullable(String)) COMMENT 'Resolved from IP, null when unknown',
    status      Enum8('ok' = 1, 'warn' = 2, 'error' = 3),
    temperature Float32 CODEC(Gorilla),
    latency_ms  UInt32,
    payload     String COMMENT 'Raw event body' CODEC(ZSTD(3)),
    tags        Array(String),
    PROJECTION by_city ( SELECT city, count(), avg(temperature) GROUP BY city )
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (device_id, ts)
TTL toDateTime(ts) + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

-- ── Rollup targets ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS analytics.hourly_rollup
(
    hour     DateTime,
    city     LowCardinality(Nullable(String)),
    events   UInt64,
    avg_temp Float64
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(hour)
ORDER BY (hour, city)
SETTINGS allow_nullable_key = 1;

CREATE TABLE IF NOT EXISTS analytics.device_daily
(
    day         Date,
    device_id   LowCardinality(String),
    events      UInt64,
    errors      UInt64,
    p95_latency Float64
)
ENGINE = SummingMergeTree
ORDER BY (day, device_id);

CREATE TABLE IF NOT EXISTS analytics.error_stream
(
    ts         DateTime64(3),
    device_id  LowCardinality(String),
    latency_ms UInt32
)
ENGINE = MergeTree
ORDER BY ts
TTL toDateTime(ts) + INTERVAL 14 DAY;

-- ── The pipelines that fill them ────────────────────────────────────────────
-- Created before the bulk insert so they actually see it: a materialized view
-- only fires on inserts that happen after it exists.
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.hourly_mv TO analytics.hourly_rollup AS
SELECT toStartOfHour(toDateTime(ts)) AS hour, city, count() AS events, avg(temperature) AS avg_temp
FROM analytics.events
GROUP BY hour, city;

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.device_daily_mv TO analytics.device_daily AS
SELECT
    toDate(ts) AS day,
    device_id,
    count() AS events,
    countIf(status = 'error') AS errors,
    quantile(0.95)(latency_ms) AS p95_latency
FROM analytics.events
GROUP BY day, device_id;

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.error_mv TO analytics.error_stream AS
SELECT ts, device_id, latency_ms
FROM analytics.events
WHERE status = 'error';

-- ── Plain views, which ClickHouse tracks no dependencies for ────────────────
CREATE VIEW IF NOT EXISTS analytics.errors AS
SELECT ts, device_id, city, latency_ms FROM analytics.events WHERE status = 'error';

CREATE VIEW IF NOT EXISTS analytics.device_health AS
SELECT d.device_id, d.model, d.city, dd.events, dd.errors, dd.p95_latency
FROM analytics.devices AS d
LEFT JOIN analytics.device_daily AS dd ON dd.device_id = d.device_id;

-- Reaches into the other database, which is what makes Flint draw a labelled
-- box per database rather than one anonymous cloud of nodes.
CREATE VIEW IF NOT EXISTS analytics.events_by_region AS
SELECT c.region, c.country, count() AS events
FROM analytics.events AS e
INNER JOIN reference.cities AS c ON c.city = e.city
GROUP BY c.region, c.country;

CREATE VIEW IF NOT EXISTS analytics.city_summary AS
SELECT hr.city, sum(hr.events) AS events, avg(hr.avg_temp) AS avg_temp
FROM analytics.hourly_rollup AS hr
GROUP BY hr.city;

-- ── Data last, so every pipeline above is fed by it ─────────────────────────
-- Rows older than the 90-day TTL are dropped on the way in, which is why the
-- final count is well under 600k. That is the TTL working, not a mistake.
INSERT INTO analytics.events
SELECT
    now() - toIntervalSecond(intDiv(number, 4) * 61)                       AS ts,
    concat('dev-', leftPad(toString(number % 400), 4, '0'))                AS device_id,
    if(number % 17 = 0, NULL,
       ['Lyon', 'Paris', 'Berlin', 'Oslo', 'Kyoto'][(number % 5) + 1])     AS city,
    (['ok', 'ok', 'ok', 'warn', 'error'][(number % 5) + 1])
        ::Enum8('ok' = 1, 'warn' = 2, 'error' = 3)                         AS status,
    18 + (number % 250) / 10                                              AS temperature,
    12 + number % 900                                                     AS latency_ms,
    repeat(concat('{"n":', toString(number), ',"k":"payload"}'), 5)        AS payload,
    arraySlice(['alpha', 'beta', 'gamma', 'delta'], 1, (number % 4) + 1)   AS tags
FROM numbers(600000);
