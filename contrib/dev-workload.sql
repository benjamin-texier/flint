-- A workload, so the Projections tab has something to read on a fresh stack.
--
-- This exists for the reason `contrib/dev-dictionaries.sql` does. The projection
-- advisor reads `system.query_log` and nothing else: on a server nobody has
-- queried, its correct answer — "nothing has touched this table" — is the same
-- empty panel a broken advisor would show. The state it exists for cannot be
-- reasoned about without producing it.
--
-- The table is `default.hits_index_projection`, one of ClickHouse's own — see
-- `contrib/play-schema.sql`. It is a better subject than the schema this fixture
-- used to be written against, because it was not built to suit the advisor: it
-- is 105 columns wide, its sorting key is five deep
-- (`CounterID, EventDate, UserID, EventTime, WatchID`), and it carries a real
-- `by_time` projection ordered by `EventTime` that somebody added for their own
-- reasons. The shapes below sit deliberately on both sides of those lines:
--
--   * `OS` is in no key and no projection, so those queries read the whole table
--     and the advisor has an aggregate case to lead with;
--   * `RegionID` is in no key either, so a filter on it is a sort-order case —
--     and nothing the table already has can answer it;
--   * `EventTime` is the projection's sorting key, so the filter on it is the
--     contrast: a shape the table can *already* serve, which the advisor must
--     not propose a second projection for;
--   * `CounterID` *is* the first key column, so the advisor should propose
--     nothing for it. A page that only ever proposes is a page nobody should
--     trust, and the count of shapes that need nothing is on it;
--   * and one statement joins, which the parser refuses and lists as unread
--     with the reason.
--
-- The literal filter values are drawn from the dataset rather than invented:
-- `CounterID = 38` and `RegionID = 229` are its two commonest, and the whole of
-- `hits` falls on 2013-07-14 and 2013-07-15, so the `EventTime` bound stays
-- inside the data even after `contrib/pull-play.mjs` fetches a different sample.
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

SELECT OS, count() FROM default.hits_index_projection GROUP BY OS FORMAT Null;
SELECT OS, count() FROM default.hits_index_projection GROUP BY OS FORMAT Null;
SELECT OS, count() FROM default.hits_index_projection GROUP BY OS FORMAT Null;
SELECT OS, count(), avg(ResolutionWidth) FROM default.hits_index_projection GROUP BY OS FORMAT Null;
SELECT OS, count(), avg(ResolutionWidth) FROM default.hits_index_projection GROUP BY OS FORMAT Null;
SELECT OS, count(), avg(ResolutionWidth) FROM default.hits_index_projection GROUP BY OS FORMAT Null;

SELECT count(), max(ResolutionWidth) FROM default.hits_index_projection WHERE RegionID = 229 FORMAT Null;
SELECT count(), max(ResolutionWidth) FROM default.hits_index_projection WHERE RegionID = 2 FORMAT Null;
SELECT count(), max(ResolutionWidth) FROM default.hits_index_projection WHERE RegionID = 1 FORMAT Null;
SELECT count(), max(ResolutionWidth) FROM default.hits_index_projection WHERE RegionID = 34 FORMAT Null;
SELECT count(), max(ResolutionWidth) FROM default.hits_index_projection WHERE RegionID = 42 FORMAT Null;

SELECT RegionID, count(), avg(ResolutionDepth) FROM default.hits_index_projection GROUP BY RegionID FORMAT Null;
SELECT RegionID, count(), avg(ResolutionDepth) FROM default.hits_index_projection GROUP BY RegionID FORMAT Null;
SELECT count(), avg(ResolutionDepth) FROM default.hits_index_projection WHERE RegionID = 229 FORMAT Null;

SELECT count() FROM default.hits_index_projection WHERE EventTime >= '2013-07-15 00:00:00' FORMAT Null;
SELECT count() FROM default.hits_index_projection WHERE EventTime >= '2013-07-15 06:00:00' FORMAT Null;
SELECT count() FROM default.hits_index_projection WHERE EventTime >= '2013-07-15 12:00:00' FORMAT Null;

SELECT count() FROM default.hits_index_projection WHERE CounterID = 38 FORMAT Null;
SELECT count() FROM default.hits_index_projection WHERE CounterID = 17 FORMAT Null;
SELECT count() FROM default.hits_index_projection WHERE CounterID = 20 FORMAT Null;

SELECT h.OS, count() FROM default.hits_index_projection AS p INNER JOIN default.hits AS h ON h.WatchID = p.WatchID GROUP BY h.OS FORMAT Null;
SELECT h.OS, count() FROM default.hits_index_projection AS p INNER JOIN default.hits AS h ON h.WatchID = p.WatchID GROUP BY h.OS FORMAT Null;

SYSTEM FLUSH LOGS;
