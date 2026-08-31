-- One table per kind of "somewhere else", so the engines that store nothing can
-- be looked at.
--
-- A stock server has none of these, and they are the tables Flint had the least
-- to say about: an `S3` table drew as a MergeTree with an odd name, no size and
-- no hint of which bucket — while the answer sat in `engine_full` the whole
-- time, shown nowhere but the DDL tab. Producing them is what found the other
-- half of it: `system.columns` does **not** report zero for an `S3`, a `URL` or
-- a `File` table. It reports ClickHouse's planning estimate — a flat 100 MB
-- compressed and 1 GB raw per column, identical down the table — which Flint
-- drew as "95 MiB on disk, 954 MiB raw, 10×" on a table holding nothing at all.
--
--     docker exec -i flint-dev-clickhouse-1 clickhouse-client --user default \
--       --password flint --multiquery < contrib/dev-external.sql
--
-- Nothing here has to resolve. Every one of these engines creates against a
-- host that does not exist, which is the point: the address is metadata, and
-- reading it back is what this fixture is for. The exception is the bucket,
-- which is aimed at the MinIO in `docker-compose.s3.yml` so that with that
-- overlay up the table also reads.

CREATE DATABASE IF NOT EXISTS elsewhere;

-- Object storage. Four arguments — path, key, secret, format — of which the
-- server hands back the third as `[HIDDEN]`.
CREATE TABLE IF NOT EXISTS elsewhere.bucket_events (a UInt64, b String)
  ENGINE = S3('http://s3:9000/flint/events/*.parquet', 'flintkey', 'flintsecret', 'Parquet');

-- The same family with no credentials at all, and a glob in the path: the two
-- shapes that a parser reading positions rather than shapes gets wrong.
CREATE TABLE IF NOT EXISTS elsewhere.public_bucket (ts DateTime, value Float64)
  ENGINE = S3('https://datasets.s3.eu-west-2.amazonaws.com/y={2020..2024}/*.csv.gz', NOSIGN, 'CSVWithNames', 'gzip');

-- A second table on the *same* bucket, which is the point of the server page's
-- inventory: a bucket read by two tables breaks for both at once, and one
-- table per far end would make that grouping invisible in the fixture.
CREATE TABLE IF NOT EXISTS elsewhere.bucket_clicks (ts DateTime, path String)
  ENGINE = S3('http://s3:9000/flint/clicks/*.parquet', 'flintkey', 'flintsecret', 'Parquet');

-- An HTTP endpoint, which names its own host and so has no endpoint of its own
-- to print beside it.
CREATE TABLE IF NOT EXISTS elsewhere.feed (id UInt64, payload String)
  ENGINE = URL('https://example.org/data.jsonl', 'JSONEachRow');

-- A file on the server's own disk. Its definition carries only the format; the
-- path is a measurement, and it arrives from `data_paths` instead.
CREATE TABLE IF NOT EXISTS elsewhere.dropbox (line String)
  ENGINE = File(CSV);

-- Another database, queried live. PostgreSQL's sixth argument is the schema,
-- which is the one that moves if a parse closes the gap where the password was.
CREATE TABLE IF NOT EXISTS elsewhere.pg_orders (id Int32, total Decimal(12, 2))
  ENGINE = PostgreSQL('pg.internal:5432', 'shop', 'orders', 'pguser', 'pgpass', 'public');

-- And a second table on the same PostgreSQL, for the same reason: what a
-- rotated password takes down is a host, not a table.
CREATE TABLE IF NOT EXISTS elsewhere.pg_customers (id Int32, email String)
  ENGINE = PostgreSQL('pg.internal:5432', 'shop', 'customers', 'pguser', 'pgpass', 'public');

CREATE TABLE IF NOT EXISTS elsewhere.my_customers (id Int32, name String)
  ENGINE = MySQL('mysql.internal:3306', 'shop', 'customers', 'root', 'rootpass');

CREATE TABLE IF NOT EXISTS elsewhere.mongo_sessions (id String, started DateTime)
  ENGINE = MongoDB('mongo.internal:27017', 'shop', 'sessions', 'muser', 'mpass');

-- Redis puts its password third and its pool size fourth, so a reader that
-- drops the hidden argument prints the password's slot as the pool.
CREATE TABLE IF NOT EXISTS elsewhere.redis_flags (k String, v String)
  ENGINE = Redis('redis.internal:6379', 0, 'rpass', 16) PRIMARY KEY k;

-- A message queue, whose whole address is in settings rather than arguments.
-- No materialized view reads it, so it never starts a consumer and the log
-- stays quiet: this table exists to be read, not to run.
CREATE TABLE IF NOT EXISTS elsewhere.stream_events (raw String)
  ENGINE = Kafka SETTINGS kafka_broker_list = 'kafka1:9092,kafka2:9092',
                          kafka_topic_list = 'events,clicks',
                          kafka_group_name = 'flint-dev',
                          kafka_format = 'JSONEachRow',
                          kafka_num_consumers = 2;
