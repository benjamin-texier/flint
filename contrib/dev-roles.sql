-- Roles for the development ClickHouse, so delegation can be exercised.
--
--   docker compose -f docker-compose.dev.yml exec -T clickhouse \
--     clickhouse-client --password flint --multiquery < contrib/dev-roles.sql
--
-- Why this is not in `demo-schema.sql`: that file is applied by the image on
-- first boot, before `users.d` has given anybody `ACCESS MANAGEMENT`, so a
-- `CREATE ROLE` in it fails. This is run by hand, once, and is idempotent.
--
-- What it is for
-- --------------
-- A published endpoint can be made to run as a role — but a role only narrows
-- anything where Flint's own account gets its read access *through roles*.
-- ClickHouse's effective privileges are the union of the active roles and
-- everything granted to the user directly, and a direct grant cannot be
-- switched off by activating a role. An account holding `SELECT ON *.*` in its
-- own right therefore reads everything whatever `run_as` says.
--
-- Flint checks that when an endpoint is saved and refuses rather than
-- pretending. Without these roles a developer only ever sees the refusal, which
-- is half the feature and the less interesting half.
--
-- Point Flint at `flint_delegate` to see the other half:
--
--   FLINT_CLICKHOUSE_USER=flint_delegate
--   FLINT_CLICKHOUSE_PASSWORD=delegate
--   FLINT_DELEGATABLE_ROLES=flint_narrow

CREATE ROLE IF NOT EXISTS flint_wide;
CREATE ROLE IF NOT EXISTS flint_narrow;

-- Wide enough to run Flint: the whole demo database, and the workspace it
-- keeps its own bookkeeping in.
GRANT SELECT ON analytics.* TO flint_wide;
GRANT SELECT, INSERT, CREATE, ALTER ON flint.* TO flint_wide;
GRANT CREATE DATABASE ON *.* TO flint_wide;
-- The system tables the explorer and the diagnostics read. Not `*.*`: an
-- account that could read everything directly would make the narrow role
-- pointless, which is the very thing this fixture exists to demonstrate.
GRANT SELECT ON system.* TO flint_wide;

-- One table, and nothing else. This is what an endpoint gets delegated to.
GRANT SELECT ON analytics.events TO flint_narrow;

-- The account Flint runs as. It holds **no direct grants at all** — every
-- privilege it has arrives through a role, which is the precondition the whole
-- feature rests on and the one Flint refuses to proceed without.
CREATE USER IF NOT EXISTS flint_delegate IDENTIFIED WITH plaintext_password BY 'delegate';
GRANT flint_wide, flint_narrow TO flint_delegate;
-- Only the wide one by default; the narrow one is assumed per statement, which
-- is exactly what `run_as` does.
SET DEFAULT ROLE flint_wide TO flint_delegate;
