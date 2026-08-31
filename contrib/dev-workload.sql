-- A workload, so the Projections tab has something to read on a fresh stack.
--
-- This exists for the reason `dev-dictionaries.sql` does. The projection advisor
-- reads `system.query_log` and nothing else: on a server nobody has queried, its
-- correct answer — "nothing has touched this table" — is the same empty panel a
-- broken advisor would show. The state it exists for cannot be reasoned about
-- without producing it.
--
-- `analytics.events` is `ORDER BY (device_id, ts)`, and the shapes below sit
-- deliberately on both sides of that line:
--
--   * `status` is in no key, so those queries read the whole table and the
--     advisor has an aggregate case to lead with;
--   * `city` is in no key either, so a filter on it is a sort-order case —
--     except when the table's own `by_city` projection can answer it, which one
--     of the two city shapes is written to do and the other is written not to;
--   * `device_id` *is* the first key column, so the advisor should propose
--     nothing for it. A page that only ever proposes is a page nobody should
--     trust, and the count of shapes that need nothing is on it;
--   * and one statement joins, which the parser refuses and lists as unread
--     with the reason.
--
-- Each shape runs more than twice, because a proposal argued from one or two
-- runs is folded away as thin — correctly — and a fixture that only produced
-- thin proposals would demonstrate the fold rather than the feature.
--
-- **No comments below this line.** ClickHouse's init runner splits the file on
-- `;` and keeps everything since the last one, so a comment written above a
-- statement is logged *as part of it* — and would then appear on the page as
-- the query somebody ran, which is exactly the confusion a demo fixture must
-- not add. Everything worth saying is said here, and this block attaches to the
-- no-op below rather than to a shape the advisor will show.
SELECT 1 FORMAT Null;

SELECT status, count() FROM analytics.events GROUP BY status FORMAT Null;
SELECT status, count() FROM analytics.events GROUP BY status FORMAT Null;
SELECT status, count() FROM analytics.events GROUP BY status FORMAT Null;
SELECT status, count(), avg(latency_ms) FROM analytics.events GROUP BY status FORMAT Null;
SELECT status, count(), avg(latency_ms) FROM analytics.events GROUP BY status FORMAT Null;
SELECT status, count(), avg(latency_ms) FROM analytics.events GROUP BY status FORMAT Null;

SELECT count(), max(latency_ms) FROM analytics.events WHERE city = 'Lyon' FORMAT Null;
SELECT count(), max(latency_ms) FROM analytics.events WHERE city = 'Paris' FORMAT Null;
SELECT count(), max(latency_ms) FROM analytics.events WHERE city = 'Berlin' FORMAT Null;
SELECT count(), max(latency_ms) FROM analytics.events WHERE city = 'Oslo' FORMAT Null;
SELECT count(), max(latency_ms) FROM analytics.events WHERE city = 'Kyoto' FORMAT Null;

SELECT city, count(), avg(temperature) FROM analytics.events GROUP BY city FORMAT Null;
SELECT city, count(), avg(temperature) FROM analytics.events GROUP BY city FORMAT Null;
SELECT count(), avg(temperature) FROM analytics.events WHERE city = 'Lyon' FORMAT Null;

SELECT count() FROM analytics.events WHERE device_id = 'dev-0007' FORMAT Null;
SELECT count() FROM analytics.events WHERE device_id = 'dev-0042' FORMAT Null;
SELECT count() FROM analytics.events WHERE device_id = 'dev-0100' FORMAT Null;

SELECT d.model, count() FROM analytics.events AS e INNER JOIN analytics.devices AS d ON d.device_id = e.device_id GROUP BY d.model FORMAT Null;
SELECT d.model, count() FROM analytics.events AS e INNER JOIN analytics.devices AS d ON d.device_id = e.device_id GROUP BY d.model FORMAT Null;

SYSTEM FLUSH LOGS;
