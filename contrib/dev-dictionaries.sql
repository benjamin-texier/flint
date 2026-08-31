-- Three dictionaries, in the three states worth looking at.
--
-- A stock server has none, so a page that reads `system.dictionaries` shows an
-- empty table whether it works or not — and the state this page exists for
-- cannot be reasoned about at all without producing it. Producing it is what
-- found that **the status column does not report it**: a dictionary that loaded
-- once and is now failing to refresh reads `LOADED`, `dictGet` keeps answering
-- with what it had, and `error_count` flickers between 1 and 0 as the background
-- loader retries. What does not flicker is the clock, so Flint keys off a last
-- successful load older than the dictionary's own lifetime.
--
--     docker exec -i flint-dev-clickhouse-1 clickhouse-client --user default \
--       --password flint --multiquery < contrib/dev-dictionaries.sql
--
-- Then, to break the third one on purpose:
--
--     DROP USER dict_src;
--     SYSTEM RELOAD DICTIONARY reference.flaky;

CREATE DATABASE IF NOT EXISTS reference;

CREATE TABLE IF NOT EXISTS reference.tenants (id UInt64, label String)
  ENGINE = MergeTree ORDER BY id;
TRUNCATE TABLE reference.tenants;
INSERT INTO reference.tenants VALUES (1, 'alpha'), (2, 'beta'), (3, 'gamma');

CREATE TABLE IF NOT EXISTS reference.flaky_src (id UInt64, label String)
  ENGINE = MergeTree ORDER BY id;
TRUNCATE TABLE reference.flaky_src;
INSERT INTO reference.flaky_src VALUES (1, 'first'), (2, 'second');

-- A ClickHouse-sourced dictionary connects back to the server as a client, so it
-- needs an account. Its own, rather than `default`: that is what makes the third
-- state below reachable — dropping this user breaks the refresh and nothing
-- else, where changing `default`'s password would break the whole fixture.
DROP USER IF EXISTS dict_src;
CREATE USER dict_src IDENTIFIED WITH plaintext_password BY 'src';
GRANT SELECT ON reference.* TO dict_src;

-- 1. Healthy, and used. Query it once with a key it has and once with a key it
--    has not, and `found_rate` reads 0.5 — the figure that says a dictionary is
--    keyed wrong when it reads zero over real traffic.
DROP DICTIONARY IF EXISTS reference.tenant_label;
CREATE DICTIONARY reference.tenant_label (id UInt64, label String)
  PRIMARY KEY id
  SOURCE(CLICKHOUSE(TABLE 'tenants' DB 'reference' USER 'dict_src' PASSWORD 'src'))
  LAYOUT(HASHED())
  LIFETIME(MIN 300 MAX 600);

-- 2. Never loaded, and it never will: the source does not exist. `FAILED`, with
--    the server's own exception, and no lifetime reported — which is why Flint
--    prints no lifetime for it rather than reading the `0` as "never refreshes".
DROP DICTIONARY IF EXISTS reference.broken;
CREATE DICTIONARY reference.broken (id UInt64, label String)
  PRIMARY KEY id
  SOURCE(CLICKHOUSE(TABLE 'does_not_exist' DB 'reference' USER 'dict_src' PASSWORD 'src'))
  LAYOUT(HASHED())
  LIFETIME(MIN 300 MAX 600);

-- 3. The one the page is for. A short lifetime so it goes stale in seconds once
--    `dict_src` is dropped, and it keeps answering the whole time.
DROP DICTIONARY IF EXISTS reference.flaky;
CREATE DICTIONARY reference.flaky (id UInt64, label String)
  PRIMARY KEY id
  SOURCE(CLICKHOUSE(TABLE 'flaky_src' DB 'reference' USER 'dict_src' PASSWORD 'src'))
  LAYOUT(HASHED())
  LIFETIME(MIN 1 MAX 2);

-- Load the two that can load, and give the first one a hit and a miss so its
-- found rate is a real figure rather than zero over zero.
SELECT dictGet('reference.tenant_label', 'label', toUInt64(2));
SELECT dictGet('reference.tenant_label', 'label', toUInt64(99));
SELECT dictGet('reference.flaky', 'label', toUInt64(1));
