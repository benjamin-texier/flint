-- A Kafka pipeline that actually runs, so the consuming tab has something to
-- report on.
--
-- `contrib/dev-external.sql` already declares a Kafka table, and it points at a
-- broker that does not exist on purpose: that is the *declared and never
-- started* state, which is worth seeing and is not the interesting one. This is
-- the other three, and none of them can be reasoned about without producing
-- them:
--
--   * **Running.** A consumer id, partitions assigned, offsets moving.
--   * **Polling and not delivering.** This one is worse than it sounds, and
--     running it is what showed how much worse. ClickHouse reads a *block* of
--     messages and inserts it in one go, so a single unparseable message does
--     not cost you that message — it fails the whole block, nothing is
--     committed, and the same block is read again. On this fixture the consumer
--     had read 1,845 messages, committed none, and delivered nothing at all
--     into `elsewhere.events`, from 41 messages of which exactly one is bad.
--     `kafka_skip_broken_messages` is the setting that changes it, and it is
--     deliberately not set here.
--   * **Rebalancing.** A consumer that never finishes rejoins the group, so the
--     counts of assignments and revocations run away from the count of commits.
--
-- Applied by the `kafka-init` service in `docker-compose.kafka.yml`, which also
-- creates the topic and puts the poison message in it:
--
--     docker compose -f docker-compose.dev.yml -f docker-compose.kafka.yml up -d
--
-- The materialized view is the point of the fixture rather than decoration. A
-- Kafka table with nothing selecting from it never polls, so without the view
-- below every figure on the tab would be zero and the tab would look broken
-- rather than idle.

CREATE DATABASE IF NOT EXISTS elsewhere;

CREATE TABLE IF NOT EXISTS elsewhere.live_events (id UInt64, kind String, at DateTime)
  ENGINE = Kafka SETTINGS kafka_broker_list = 'redpanda:9092',
                          kafka_topic_list = 'events',
                          kafka_group_name = 'flint-dev',
                          kafka_format = 'JSONEachRow',
                          kafka_num_consumers = 1;

CREATE TABLE IF NOT EXISTS elsewhere.events (id UInt64, kind String, at DateTime)
  ENGINE = MergeTree ORDER BY (kind, at);

CREATE MATERIALIZED VIEW IF NOT EXISTS elsewhere.events_mv TO elsewhere.events AS
  SELECT id, kind, at FROM elsewhere.live_events;
