-- One of each thing the Access page reads, for the development ClickHouse.
--
-- A stock server has a `default` quota with no limits, one `default` settings
-- profile, and no row policies at all — so the three sections render empty
-- whether they work or not, and every claim the page makes about them is
-- untested. These are the fixtures that make them say something.
--
-- Needs `contrib/dev-access.xml` first: without `access_management` on
-- `default`, every statement below comes back as code 497.
--
--     docker exec -i flint-dev-clickhouse-1 clickhouse-client --user default \
--       --password flint --multiquery < contrib/dev-access.sql

-- Its own database, created here. This file used to borrow one from the schema
-- fixture that ran before it, which made an access-control fixture silently
-- depend on which tables the demo schema happened to hold; the tables under
-- `contrib/play-schema.sql` are ClickHouse's and nothing here should be reaching
-- into them. `access_probe` holds only what this file puts there.
CREATE DATABASE IF NOT EXISTS access_probe;

-- A tenant table with rows belonging to three different people.
CREATE TABLE IF NOT EXISTS access_probe.policy_probe (tenant String, v UInt32)
  ENGINE = MergeTree ORDER BY tenant;
TRUNCATE TABLE access_probe.policy_probe;
INSERT INTO access_probe.policy_probe VALUES ('a', 1), ('b', 2), ('c', 3);

CREATE USER IF NOT EXISTS probe_a IDENTIFIED WITH plaintext_password BY 'p';
CREATE USER IF NOT EXISTS probe_none IDENTIFIED WITH plaintext_password BY 'p';
GRANT SELECT ON access_probe.* TO probe_a, probe_none;

CREATE ROLE IF NOT EXISTS analyst;
GRANT SELECT ON access_probe.* TO analyst;
GRANT analyst TO probe_a;

-- Row policies, in the three shapes whose composition is the whole subject:
-- two permissive ones that union, and a restrictive one that intersects what
-- they left. `probe_none` is named by none of them and therefore sees every
-- row — which is the fact about row policies most likely to be got wrong.
CREATE ROW POLICY OR REPLACE only_a ON access_probe.policy_probe
  USING tenant = 'a' TO probe_a;
CREATE ROW POLICY OR REPLACE also_b ON access_probe.policy_probe
  USING tenant = 'b' TO probe_a;
CREATE ROW POLICY OR REPLACE not_b ON access_probe.policy_probe
  AS RESTRICTIVE USING tenant != 'b' TO probe_a;

-- A quota with ceilings on two dimensions over two intervals, so the page has
-- both a used/max pair to draw and a second interval to keep apart from the
-- first. The other twelve dimensions have no ceiling and are dropped rather
-- than drawn as unlimited.
-- The comma before the second FOR INTERVAL is load-bearing: without it
-- ClickHouse keeps the last interval and drops the first, silently, and the
-- quota you read back is not the quota you wrote.
CREATE QUOTA OR REPLACE modest
  KEYED BY user_name
  FOR INTERVAL 1 minute MAX queries = 60, read_rows = 1000000,
  FOR INTERVAL 1 hour MAX queries = 1000
  TO probe_a, probe_none;

-- A settings profile with a value, a constrained setting, and a readonly one.
CREATE SETTINGS PROFILE OR REPLACE careful
  SETTINGS max_execution_time = 30 MIN 1 MAX 120,
           max_result_rows = 100000 READONLY,
           max_threads = 4
  TO probe_none;

-- And a setting pinned straight onto a user, which is *not* part of any
-- profile even though it lives in `system.settings_profile_elements`.
ALTER USER probe_a SETTINGS max_memory_usage = 2000000000;

-- An account behaving like an older ClickHouse.
--
-- `compatibility` is one line that moves hundreds of settings at once, and
-- until something on the machine actually had it set, two things Flint says
-- about it were written and never seen. Both turned out to be wrong:
--
--   * The page reported "392 settings differ" with no way to tell that 384 of
--     them were that one line's doing and nobody's choice.
--   * More seriously, `compatibility` below 24.9 turns on
--     `http_write_exception_in_output_format`, which makes ClickHouse write
--     errors *inside* the JSON body instead of as the body. Flint's error
--     parser looked for `Code: ` at the front, found nothing, and reported code
--     0 — which cost `Reach` the ability to tell a missing grant from a missing
--     table, on every page, on every server configured this way.
--
-- So: an account to point Flint at, rather than a setting on the server, which
-- would change how it answers everybody.
CREATE SETTINGS PROFILE OR REPLACE old_ways SETTINGS compatibility = '24.8';
CREATE USER IF NOT EXISTS probe_old IDENTIFIED WITH plaintext_password BY 'p'
  SETTINGS PROFILE old_ways;
GRANT SELECT ON access_probe.* TO probe_old;

-- Two accounts for "What you may see", the read-only grants panel in Data.
--
-- `probe_bare` holds nothing at all, and the point of it is what that looks
-- like: ClickHouse *filters* the system tables rather than refusing them, so
-- this user gets a successful, empty inventory and no error anywhere. Every
-- endpoint on the server page answers 200. Without a user like this the panel
-- looks like a nicety instead of the only thing on the page that explains the
-- emptiness.
CREATE USER IF NOT EXISTS probe_bare IDENTIFIED WITH plaintext_password BY 'p';

-- `probe_cols` produces the two shapes that are easy to get wrong: a column
-- level grant, whose commas are inside parentheses and are not separators; and
-- a REVOKE, which `SHOW GRANTS` returns as a row in the same list as the grants.
-- Printed among them, it tells the reader they may read the one table they may
-- not.
CREATE USER IF NOT EXISTS probe_cols IDENTIFIED WITH plaintext_password BY 'p';
GRANT SELECT ON access_probe.* TO probe_cols;
REVOKE SELECT ON access_probe.orders FROM probe_cols;
GRANT SELECT(event_time, query_duration_ms) ON system.query_log TO probe_cols;

-- `probe_a` already holds `SELECT ON access_probe.*` directly, and the `analyst`
-- role above carries the same grant — which is the third shape: one privilege
-- arriving by two paths, folded into one row that names both.
