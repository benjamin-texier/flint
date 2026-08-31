/**
 * Regenerate `contrib/play-schema.sql` from ClickHouse's public playground.
 *
 *   node contrib/pull-play.mjs [> contrib/play-schema.sql]
 *
 * The dev fixture used to be a schema somebody here invented. This replaces it
 * with ClickHouse's own examples — the 90-odd objects on play.clickhouse.com,
 * the ones their documentation and their blog posts are written against. Flint
 * exists to be pointed at somebody else's warehouse, and a fixture written by
 * the same hand as the product only ever shows Flint the shapes it already
 * expects. Their schemas do not know Flint exists, which is the whole value:
 * `hits` is 105 columns wide, `minicrawl` is twenty kilobytes a row, `countries`
 * holds a `MultiPolygon`, and none of that was chosen to make a diagram look
 * good.
 *
 * ## What this emits, and what it deliberately does not
 *
 * DDL, and one `INSERT ... SELECT ... LIMIT n` per table. Not the data: the
 * extracts come to about 154 MiB, which has no business in a git history, and
 * the playground is a stable public endpoint that the local server can pull from
 * itself. So the generated file is a few thousand lines of SQL that *fetches*,
 * and it needs the network on first boot. That is the trade, stated plainly.
 *
 * The pull uses `remoteSecure` over the playground's native TLS port rather than
 * its HTTP one, because the HTTP path is unusable here for a reason worth
 * recording: play runs `readonly=1`, which refuses *every* setting Flint's own
 * client attaches — `max_execution_time`, `max_result_rows`, `log_comment`,
 * `session_timezone`, all of them code 164. Flint cannot talk to the playground
 * at all. `remoteSecure` sidesteps it because the settings then belong to the
 * local server, which is not read-only.
 *
 * ## Why the row counts are measured rather than chosen
 *
 * `LIMIT 100000` on every table would be a number pulled from the air, and it
 * lands very differently on `tranco` (4 bytes a row) than on `minicrawl` (20
 * kilobytes a row) — the same limit is 2 MiB in one and 196 MiB in the other.
 * So the limit is derived from `total_bytes / total_rows` read off the
 * playground: roughly TARGET_BYTES of compressed data per table, floored at
 * MIN_ROWS so nothing arrives empty and capped at MAX_ROWS so nothing arrives
 * enormous. Where the budget and the floor disagree, the budget wins — hence
 * `minicrawl` at 200 rows, which is genuinely all that fits.
 *
 * The `LIMIT` costs nothing at the far end: it is pushed to the remote, measured
 * at 0.6 s to take 100 000 rows out of the 100 M in `default.hits`.
 *
 * And it is an *arbitrary* n rows, not the first n. `LIMIT` with no `ORDER BY`
 * returns whatever blocks the server reached first, so the extract is a sample
 * with no promise about which one — describing it as a prefix anywhere would be
 * a wording bug.
 *
 * ## The rewrites
 *
 * - `Replicated*MergeTree('/path/{shard}', '{replica}', ...)` loses the two
 *   coordination arguments and becomes the plain engine. The dev container has
 *   no Keeper, and standing one up to hold a fixture would be a second daemon
 *   for no gain. Any *further* argument — `ReplicatedReplacingMergeTree`'s
 *   version column — is kept, because dropping it would silently change what
 *   the table means.
 * - The two `Proxy` tables are dropped. They are `AS remoteSecure(...)` onto a
 *   ClickHouse staging host that is not ours to reach, so they would reproduce
 *   as a table that errors on every read.
 * - Views and materialized views are emitted last, after the inserts. A
 *   materialized view sitting between two tables we are both filling would fire
 *   while we filled the source and write its own rows into a target that
 *   already has an extract — the fixture would load differently every time.
 *
 * Everything else is kept verbatim, and the kept parts are the point: the skip
 * indices (9 of them), the projections (3), the codecs, the column comments, the
 * `SETTINGS index_granularity`. Those are what Flint draws.
 */

const PLAY = 'https://play.clickhouse.com';
const USER = 'explorer';

/** Roughly this much compressed data per table. */
const TARGET_BYTES = 2 * 1024 * 1024;
/** Never fetch fewer than this, unless the table holds fewer. */
const MIN_ROWS = 200;
/** Never fetch more than this, however narrow the rows are. */
const MAX_ROWS = 500_000;

/** The playground's own databases, in the order the fixture should create them. */
const DATABASES = ['blogs', 'git_clickhouse', 'mgbench'];
const SYSTEM = "('system', 'INFORMATION_SCHEMA', 'information_schema')";

async function play(sql, format = 'TSVRaw') {
  const res = await fetch(`${PLAY}/?user=${USER}&default_format=${format}`, {
    method: 'POST',
    body: sql,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`play refused: ${text.split('\n')[0]}`);
  return text;
}

/**
 * One row per object, with the limit already computed server-side — the
 * arithmetic belongs next to the numbers it reads, and TSV with tabs inside a
 * `create_table_query` would need escaping we would then have to undo.
 */
async function objects() {
  const json = await play(
    `
    WITH
        ${TARGET_BYTES} AS target,
        greatest(total_bytes / nullIf(total_rows, 0), 1) AS bytes_per_row
    SELECT
        database,
        name,
        engine,
        create_table_query,
        toUInt64(least(
            total_rows,
            greatest(${MIN_ROWS}, least(${MAX_ROWS}, toUInt64(target / bytes_per_row)))
        )) AS take
    FROM system.tables
    WHERE database NOT IN ${SYSTEM}
    ORDER BY database, name
    `,
    'JSONEachRow',
  );
  return json
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/**
 * Strip the two coordination arguments from a `Replicated*` engine, keeping any
 * that follow. Written against the string rather than a parse of it because the
 * shape is fixed and machine-generated: ClickHouse prints the path first and the
 * replica second, both single-quoted, and neither can contain a comma.
 */
function unreplicate(ddl) {
  return (
    ddl
      // A version column follows, so the parentheses stay and keep it.
      .replace(/ENGINE = Replicated(\w*MergeTree)\('[^']*',\s*'[^']*',\s*/, 'ENGINE = $1(')
      // Nothing follows, so the parentheses go with the arguments they held.
      .replace(/ENGINE = Replicated(\w*MergeTree)\('[^']*',\s*'[^']*'\)/, 'ENGINE = $1')
  );
}

const isTable = (engine) => engine.endsWith('MergeTree');
const isView = (engine) => engine === 'View' || engine === 'MaterializedView';

function main(rows) {
  const tables = rows.filter((r) => isTable(r.engine));
  const views = rows.filter((r) => isView(r.engine));
  const dropped = rows.filter((r) => !isTable(r.engine) && !isView(r.engine));

  const out = [];
  const say = (line = '') => out.push(line);

  say('-- GENERATED by contrib/pull-play.mjs — edit that, not this.');
  say('--');
  say(`-- ClickHouse's own example schemas, taken from ${PLAY} as user`);
  say(`-- '${USER}', with an extract of the data behind each one. Applied by the`);
  say('-- ClickHouse container in docker-compose.dev.yml, which needs the network on');
  say('-- its first boot to fetch the rows — the DDL is here, the data is not.');
  say('--');
  say(`-- ${tables.length} tables, ${views.length} views.`);
  if (dropped.length > 0) {
    const names = dropped.map((r) => `${r.database}.${r.name}`).join(', ');
    say(`-- ${dropped.length} left out (${names}): the Proxy engine points at a`);
    say('-- ClickHouse staging host that is not ours to reach.');
  }
  say('');

  for (const db of DATABASES) say(`CREATE DATABASE IF NOT EXISTS ${db};`);
  say('');

  say('-- ── Schema ─────────────────────────────────────────────────────────────────');
  say('-- Verbatim from the playground but for the engine: the skip indices,');
  say('-- projections, codecs, column comments and granularity settings are exactly');
  say('-- what Flint draws, so none of them is normalised away.');
  say('');
  for (const row of tables) {
    say(`${unreplicate(row.create_table_query)};`);
    say('');
  }

  say('-- ── Data ───────────────────────────────────────────────────────────────────');
  say('-- An arbitrary sample, not a prefix: LIMIT with no ORDER BY takes whatever');
  say('-- blocks the server reached first. Each limit was derived from the bytes per');
  say('-- row measured on the playground, for roughly');
  say(`-- ${(TARGET_BYTES / 1024 / 1024).toFixed(0)} MiB of compressed data per table.`);
  say('');
  for (const row of tables) {
    const target = `${row.database}.${row.name}`;
    if (Number(row.take) === 0) {
      say(`-- ${target}: empty on the playground, so there is nothing to fetch. An`);
      say('-- empty table is a state Flint has to render, so it is kept.');
      say('');
      continue;
    }
    say(`INSERT INTO ${target} SELECT * FROM remoteSecure(`);
    say(`    'play.clickhouse.com:9440', '${row.database}', '${row.name}', '${USER}', ''`);
    say(`) LIMIT ${row.take};`);
    say('');
  }

  say('-- ── Views ──────────────────────────────────────────────────────────────────');
  say('-- Last on purpose. A materialized view created before the inserts would fire');
  say('-- as its source filled and write rows into a target that already holds its');
  say('-- own extract, so the fixture would load differently every time.');
  say('');
  for (const row of views) {
    say(`${row.create_table_query};`);
    say('');
  }

  return out.join('\n');
}

const rows = await objects();
process.stdout.write(main(rows));
