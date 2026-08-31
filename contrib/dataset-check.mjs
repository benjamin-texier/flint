/**
 * The dataset API surface, against a running Flint.
 *
 *   node contrib/dataset-check.mjs [base-url] [user] [password] [endpoint]
 *
 * The endpoint is needed only where the deployment has none of its own —
 * `FLINT_CLICKHOUSE_URL` unset, so the *caller* names the ClickHouse. Passed
 * anywhere else it is refused, which is why this asks `/api/config` rather than
 * sending it always. The dataset API works unpinned: it reads as whoever is
 * asking, and it needs no workspace.
 *
 * `api-check.mjs` does this for the published face. This does it for the other
 * half — and the case for it is stronger, because more of what this API answers
 * is arithmetic. A published endpoint that filters wrongly returns the wrong
 * rows, and someone eventually notices. An aggregation that groups wrongly
 * returns a *number*, and a number is believed.
 *
 * So almost nothing here asserts a fixed value: the data underneath is whatever
 * this server happens to hold. Every check is a self-consistency one instead —
 * the parts must add up to the whole, two windows must be disjoint, a
 * comparison's halves must equal the same two periods asked for separately, a
 * cursor walk must equal one big page. Those hold on any server with any data,
 * and every one of them fails loudly if the SQL underneath is subtly wrong.
 *
 * It reads two system tables, and which one each check uses is itself a
 * decision. `system.query_log` is the only table always present that has
 * timestamps, so the time checks are its — but it *grows while this runs*,
 * because these requests land in it. Any check that reads a number twice and
 * compares them therefore uses `system.columns`, which does not move.
 */
const BASE = process.argv[2] ?? 'http://localhost:8096'
const USER = process.argv[3] ?? process.env.FLINT_USER
const PASSWORD = process.argv[4] ?? process.env.FLINT_PASSWORD ?? ''
const ENDPOINT = process.argv[5] ?? process.env.FLINT_ENDPOINT
const DATASET = 'system.query_log'
/** A second dataset for the checks that need the ground to hold still.
 *
 *  `system.query_log` grows while this runs — its own requests land in it — and
 *  its `query_id` is not unique, because one query logs a start *and* a finish.
 *  Both facts broke the first draft of the cursor check here, and neither was a
 *  bug in Flint. `system.columns` does not move during a run and its
 *  database/table/name is genuinely one row. */
const STABLE = 'system.columns'

let bearer = null
let failures = 0
let checks = 0

function ok(what, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`  ok   ${what}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${what}${detail ? `\n       ${detail}` : ''}`)
}

async function post(path, body, expect = 200) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = { raw: text }
  }
  if (expect !== null && response.status !== expect) {
    throw new Error(`${path} answered ${response.status}, wanted ${expect}: ${text.slice(0, 300)}`)
  }
  return { status: response.status, body: parsed }
}

/** A plain read, for the reports that take their window in the query string. */
async function get(path, expect = 200) {
  const response = await fetch(`${BASE}${path}`, {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = { raw: text }
  }
  if (expect !== null && response.status !== expect) {
    throw new Error(`${path} answered ${response.status}: ${text.slice(0, 200)}`)
  }
  return { status: response.status, body: parsed }
}

/** One number out of a one-row answer. */
async function scalar(query, field = 'count') {
  const { body } = await post('/api/data', query)
  if (!body.rows?.length) return 0
  return Number(body.rows[0][field])
}

async function signIn() {
  const session = await (await fetch(`${BASE}/api/session`)).json()
  if (!session.required) {
    console.log('sign-in is off on this Flint; calling as the manifest account\n')
    return
  }
  if (!USER) {
    throw new Error(
      'this Flint requires a sign-in — pass a user and password:\n' +
        `  node contrib/dataset-check.mjs ${BASE} <user> <password>`,
    )
  }
  /* Whether the deployment names its own server. Asked rather than inferred from
     the sign-in being required: those are two different facts, and an unpinned
     Flint is only one of the two deployments that ask for a session. */
  const config = await (await fetch(`${BASE}/api/config`)).json()
  if (config.pinned === false && !ENDPOINT) {
    throw new Error(
      'this Flint has no ClickHouse of its own — the caller names one at sign-in:\n' +
        `  node contrib/dataset-check.mjs ${BASE} ${USER} <password> http://localhost:8123`,
    )
  }
  const response = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    /* Only where there is no server in the manifest. A pinned Flint refuses the
       field rather than ignoring it, so sending it always would break every
       ordinary run. */
    body: JSON.stringify({
      user: USER,
      password: PASSWORD,
      bearer: true,
      ...(config.pinned === false ? { endpoint: ENDPOINT } : {}),
    }),
  })
  if (!response.ok) throw new Error(`sign-in refused: ${await response.text()}`)
  const body = await response.json()
  bearer = body.bearer
  const where = config.pinned === false ? ` on ${ENDPOINT}` : ''
  console.log(`signed in as ${body.user}${where}, bearer expires in ${body.expires_in}s\n`)
}

/** Whether this caller can read what the checks below read.
 *
 *  Worth its own step, because the alternative is a run that fails eight times
 *  and never says why. A user granted one database is a *correct* thing to be —
 *  it is most of what the sign-in feature is for — and being told "you cannot
 *  read `system.query_log`" is the answer, not a failure of Flint. */
async function preflight() {
  const missing = []
  for (const dataset of [DATASET, STABLE]) {
    const { status } = await post('/api/data/schema', { dataset }, null)
    if (status !== 200) missing.push(dataset)
  }
  if (missing.length === 0) return
  throw new Error(
    `this check reads ${missing.join(' and ')}, and your grants do not reach ` +
      `${missing.length > 1 ? 'them' : 'it'}.\n` +
      'That is a correct answer from Flint, not a failure — run this as a user with ' +
      '`SELECT ON system.*`, or grant it:\n' +
      `  GRANT SELECT ON system.* TO ${USER ?? '<user>'}`,
  )
}

/* ── The listing and the inventory ─────────────────────────────────────── */

async function checkListing() {
  console.log('listing')
  const { body } = await post('/api/data/list', { database: 'system' })
  const names = body.datasets.map((d) => d.name)
  ok('names the dataset this check uses', names.includes(DATASET))
  ok('counts what it returned', body.count === body.datasets.length)
  ok(
    'drops the size of a view rather than printing a zero',
    body.datasets.every((d) => d.kind !== 'view' || d.rows === undefined),
  )
}

async function checkInventory() {
  console.log('inventory')
  const { body } = await post('/api/data/schema', { dataset: DATASET })
  const by = Object.fromEntries(body.columns.map((c) => [c.name, c]))

  ok('reads a timestamp as a time', by.event_time?.kind === 'time')
  ok('reads a duration as a quantity', by.query_duration_ms?.kind === 'numeric')
  // Deliberately `text` and not `id`: a kind says what may be *asked* of a
  // column, and a string query id takes `like` — there is no arithmetic on it
  // to withhold. The identifier rule exists for numbers, where `sum` would
  // otherwise return a plausible number that means nothing.
  ok('reads a string identifier as text, which is what can be asked of it', by.query_id?.kind === 'text')
  ok(
    'offers arithmetic on the quantity and on nothing else',
    by.query_duration_ms?.aggregate.includes('sum') && !by.query_id?.aggregate.includes('sum'),
  )
  ok(
    'counts what it cannot measure rather than hiding it',
    body.columns.every((c) => c.kind !== 'unsupported') || Boolean(body.note),
  )
}

/* ── The parts have to add up to the whole ─────────────────────────────── */

async function checkAggregation() {
  console.log('aggregation')
  // On the dataset that holds still: this compares two readings, and a table
  // that grew between them would fail for a reason that is not a bug.
  const whole = await scalar({ dataset: STABLE, metrics: [{ aggregation: 'count' }] })
  const { body } = await post('/api/data', {
    dataset: STABLE,
    dimensions: ['database'],
    metrics: [{ aggregation: 'count' }],
    limit: 500,
  })
  const parts = body.rows.reduce((sum, r) => sum + Number(r.count), 0)
  ok('grouped counts sum to the ungrouped count', parts === whole, `${parts} vs ${whole}`)
  ok(
    'every group is named once',
    new Set(body.rows.map((r) => r.database)).size === body.rows.length,
  )

  const { body: counted } = await post('/api/data', {
    dataset: STABLE,
    dimensions: ['database'],
    metrics: [{ aggregation: 'count' }],
    count: true,
    limit: 1,
  })
  ok(
    'the total counts groups, not rows',
    counted.total === body.rows.length,
    `${counted.total} vs ${body.rows.length} groups`,
  )
}

async function checkFilterTree() {
  console.log('filter tree')
  const { body } = await post('/api/data', {
    dataset: STABLE,
    dimensions: ['database'],
    metrics: [{ aggregation: 'count' }],
    limit: 500,
  })
  if (body.rows.length < 2) {
    console.log('  skip this server has only one database to tell apart')
    return
  }
  const [a, b] = body.rows.slice(0, 2)
  const either = await scalar({
    dataset: STABLE,
    filter: {
      any: [
        { column: 'database', op: 'eq', value: a.database },
        { column: 'database', op: 'eq', value: b.database },
      ],
    },
    metrics: [{ aggregation: 'count' }],
  })
  ok(
    'an OR of two values is exactly those two groups',
    either === Number(a.count) + Number(b.count),
    `${either} vs ${Number(a.count) + Number(b.count)}`,
  )

  const neither = await scalar({
    dataset: STABLE,
    filter: { not: { column: 'database', op: 'in', values: [a.database, b.database] } },
    metrics: [{ aggregation: 'count' }],
  })
  const whole = await scalar({ dataset: STABLE, metrics: [{ aggregation: 'count' }] })
  ok('and its negation is the rest', either + neither === whole, `${either}+${neither} vs ${whole}`)
}

async function checkHaving() {
  console.log('having')
  const groups = await post('/api/data', {
    dataset: STABLE,
    dimensions: ['database'],
    metrics: [{ aggregation: 'count' }],
    limit: 500,
  })
  const counts = groups.body.rows.map((r) => Number(r.count)).sort((a, b) => a - b)
  if (counts.length < 3) {
    console.log('  skip not enough databases to partition')
    return
  }
  // A threshold that actually splits the set, rather than one that excludes
  // everything — an empty answer passes a badly chosen assertion.
  const cut = counts[Math.floor(counts.length / 2)]

  const above = await post('/api/data', {
    dataset: STABLE,
    dimensions: ['database'],
    metrics: [{ aggregation: 'count' }],
    having: { column: 'count', op: 'gte', value: cut },
    count: true,
    limit: 500,
  })
  const below = await post('/api/data', {
    dataset: STABLE,
    dimensions: ['database'],
    metrics: [{ aggregation: 'count' }],
    having: { not: { column: 'count', op: 'gte', value: cut } },
    count: true,
    limit: 500,
  })

  ok('a filter on a computed value keeps some of the groups', above.body.rows.length > 0)
  ok(
    'and its negation keeps exactly the rest',
    above.body.rows.length + below.body.rows.length === counts.length,
    `${above.body.rows.length} + ${below.body.rows.length} vs ${counts.length}`,
  )
  ok(
    'the total counts the groups that survived it',
    above.body.total === above.body.rows.length,
    `${above.body.total} vs ${above.body.rows.length}`,
  )
  ok(
    'and every kept group really is on that side of the line',
    above.body.rows.every((r) => Number(r.count) >= cut),
  )

  // The comparison's label is one of the answer's columns, so it filters like
  // the rest. It did not for a while, and the refusal listed the *other*
  // columns — telling a caller an answer does not return something they could
  // see in their own rows.
  const compared = await post('/api/data', {
    dataset: DATASET,
    time: { column: 'event_time', period: 'this_hour', compare: 'previous_period' },
    dimensions: ['type'],
    metrics: [{ aggregation: 'count' }],
    having: { column: 'window', op: 'eq', value: 'previous' },
    count: true,
    limit: 100,
  })
  // Every row it kept must be the half asked for. Not "and there is at least
  // one" — whether the previous hour holds anything is the server's business,
  // and asserting on it makes a quiet hour look like a defect.
  ok(
    'the window a comparison labels can be filtered like any other column',
    compared.body.rows.every((r) => r.window === 'previous'),
    `${compared.body.rows.length} rows, windows: ${[
      ...new Set(compared.body.rows.map((r) => r.window)),
    ].join(', ') || 'none'}`,
  )
  ok(
    'and the total counts what survived it, not what existed before it',
    compared.body.total === compared.body.rows.length,
    `${compared.body.total} vs ${compared.body.rows.length}`,
  )

  const { status, body } = await post(
    '/api/data',
    { dataset: STABLE, having: { column: 'count', op: 'gt', value: 1 } },
    null,
  )
  ok(
    'filtering what nothing computed is refused rather than ignored',
    status === 400 && (body.error?.message ?? '').includes('computes nothing'),
    `${status} ${(body.error?.message ?? '').slice(0, 100)}`,
  )
}

/* ── Windows are half-open, and a comparison is two of them ────────────── */

async function checkTime() {
  console.log('time')
  const count = (time) => scalar({ dataset: DATASET, time, metrics: [{ aggregation: 'count' }] })

  // Anchored on the hour that has already finished, never the one in progress.
  // The query log grows while this check runs — these very requests land in it
  // — so an assertion about the current hour is an assertion about a number
  // that changed between the two calls that read it.
  const closed = await count({ column: 'event_time', period: 'previous_hour' })
  const opening = await count({ column: 'event_time', period: 'this_hour' })

  const { body } = await post('/api/data', {
    dataset: DATASET,
    time: { column: 'event_time', period: 'this_hour', compare: 'previous_period' },
    metrics: [{ aggregation: 'count' }],
  })
  const halves = Object.fromEntries(body.rows.map((r) => [r.window, Number(r.count)]))

  // The whole point of deriving the second window rather than being told it:
  // `previous_period` of `this_hour` has to *be* `previous_hour`, exactly.
  ok(
    'a comparison derives its previous window as the period before',
    (halves.previous ?? 0) === closed,
    `${halves.previous} vs ${closed}`,
  )
  // The open half can only be asserted as monotone, for the reason above.
  ok('and its current half is the window still filling', (halves.current ?? 0) >= opening)

  // A comparison moves the window it was put on, not whichever came first.
  // Sent with a *second* window that is not the compared one, because that is
  // the arrangement where getting it wrong returns a plausible number: the pair
  // silently became two unrelated columns and only the current half came back.
  const paired = await post('/api/data', {
    dataset: DATASET,
    time: [
      { column: 'query_start_time', period: 'today' },
      { column: 'event_time', period: 'this_hour', compare: 'previous_period' },
    ],
    metrics: [{ aggregation: 'count' }],
  })
  const halved = Object.fromEntries(paired.body.rows.map((r) => [r.window, Number(r.count)]))
  // Only where the previous hour has anything in it. A server nobody queried an
  // hour ago is a fine server, and a check that fails because nothing happened
  // is a check that gets ignored — the same flakiness this file already moved
  // the counting assertions off `system.query_log` to avoid.
  if (closed > 0) {
    ok(
      'a comparison beside another window still returns both of its halves',
      'current' in halved && 'previous' in halved,
      `got ${Object.keys(halved).join(', ') || 'nothing'}`,
    )
  } else {
    console.log('  skip nothing ran in the previous hour, so there is no half to compare')
  }
  // This one holds either way: if the previous window is empty, both are zero.
  ok(
    'and its previous half is the period before, on its own column',
    (halved.previous ?? 0) === closed,
    `${halved.previous} vs ${closed}`,
  )

  const buckets = await post('/api/data', {
    dataset: DATASET,
    time: { column: 'event_time', period: 'previous_hour', granularity: 'minute' },
    metrics: [{ aggregation: 'count' }],
    order: [{ column: 'event_time_minute' }],
    limit: 200,
  })
  const bucketed = buckets.body.rows.reduce((sum, r) => sum + Number(r.count), 0)
  ok('buckets partition the window they are in', bucketed === closed, `${bucketed} vs ${closed}`)
  ok(
    'and the bucket is named for its column and its unit',
    buckets.body.rows.length === 0 || 'event_time_minute' in buckets.body.rows[0],
  )
  ok('an aggregated answer offers no cursor', buckets.body.page.cursor === undefined)
}

/* ── A cursor must lose nothing and repeat nothing ─────────────────────── */

async function checkCursor() {
  console.log('cursor')
  // On the dataset that holds still, and ordered by something genuinely
  // unique — a keyset walk over a table that is growing, or over a key that
  // repeats, fails for reasons that have nothing to do with the cursor.
  const shape = {
    dataset: STABLE,
    select: ['database', 'table', 'name'],
    order: [{ column: 'database' }, { column: 'table' }, { column: 'name' }],
  }
  const key = (r) => `${r.database}\u0000${r.table}\u0000${r.name}`

  const { body: whole } = await post('/api/data', { ...shape, limit: 40 })
  if (whole.rows.length < 10) {
    console.log('  skip not enough columns on this server to walk')
    return
  }

  const walked = []
  let cursor
  for (let page = 0; page < 20; page += 1) {
    const { body } = await post('/api/data', { ...shape, limit: 7, cursor })
    walked.push(...body.rows.map(key))
    if (!body.page.has_more || walked.length >= whole.rows.length) break
    cursor = body.page.cursor
    if (!cursor) break
  }

  const expected = whole.rows.map(key)
  const got = walked.slice(0, expected.length)
  ok('a cursor walk repeats nothing', new Set(walked).size === walked.length)
  ok(
    'and it visits the same rows one page would',
    JSON.stringify(got) === JSON.stringify(expected),
    `${got.length} walked vs ${expected.length} in one page`,
  )
  ok(
    'across a three-column order, which is where a keyset walk goes wrong',
    walked.length > 7,
  )
}

/* ── Where the days begin ──────────────────────────────────────────────── */

async function checkTimezone() {
  console.log('timezone')

  // Two zones twelve hours apart, so "yesterday" cannot accidentally name the
  // same span in both. The query log is the dataset, so both windows have rows
  // in them whatever hour this check runs at.
  const yesterday = (timezone) =>
    scalar({
      dataset: DATASET,
      time: { column: 'event_time', period: 'yesterday' },
      metrics: [{ aggregation: 'count' }],
      ...(timezone ? { timezone } : {}),
    })

  const east = await yesterday('Pacific/Auckland')
  const west = await yesterday('America/Los_Angeles')
  ok(
    'a window is cut where the caller says, not where the server sits',
    east !== west,
    `Auckland ${east} vs Los Angeles ${west}`,
  )

  // The zone reaches ClickHouse as a session setting, which is invisible in
  // the statement — so the statement Flint hands back carries it, or the
  // Builder shows and the editor pastes a query that answers about other days.
  const { body } = await post('/api/data', {
    dataset: DATASET,
    time: { column: 'event_time', granularity: 'day' },
    metrics: [{ aggregation: 'count' }],
    timezone: 'Pacific/Auckland',
    limit: 3,
  })
  ok(
    'the statement it hands back carries its own zone',
    /SETTINGS session_timezone = 'Pacific\/Auckland'/.test(body.sql),
    body.sql.split('\n').pop(),
  )
  ok('and the answer names the zone it used', body.timezone === 'Pacific/Auckland', body.timezone)

  // Said even when nobody chose one: a stored answer with no zone on it cannot
  // be reconciled against the same query run from anywhere else.
  const plain = await post('/api/data', {
    dataset: DATASET,
    time: { column: 'event_time', granularity: 'day' },
    metrics: [{ aggregation: 'count' }],
    limit: 3,
  })
  ok(
    'an answer names its zone even where none was asked for',
    typeof plain.body.timezone === 'string' && plain.body.timezone.length > 0,
    String(plain.body.timezone),
  )

  // A total counted against different day boundaries than the page is not a
  // slower answer, it is a different one.
  const paged = await post('/api/data', {
    dataset: DATASET,
    time: { column: 'event_time', granularity: 'day' },
    metrics: [{ aggregation: 'count' }],
    timezone: 'Pacific/Auckland',
    count: true,
    limit: 100,
  })
  ok(
    'the page and its total are counted in the same zone',
    paged.body.total === paged.body.rows.length,
    `total ${paged.body.total} vs ${paged.body.rows.length} buckets`,
  )

  // The case the envelope cannot serve. A CSV of daily figures is the most
  // likely thing anyone pipes into a spreadsheet, and paging can be inferred
  // from the rows that arrived where a day boundary cannot be inferred from
  // anything.
  const csv = await fetch(`${BASE}/api/data`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({
      dataset: DATASET,
      time: { column: 'event_time', granularity: 'day' },
      metrics: [{ aggregation: 'count' }],
      timezone: 'Pacific/Auckland',
      format: 'csv',
      limit: 3,
    }),
  })
  ok(
    'a CSV answer, which has no envelope, says its zone in a header',
    csv.headers.get('x-flint-timezone') === 'Pacific/Auckland',
    csv.headers.get('x-flint-timezone') ?? 'absent',
  )
  ok(
    'and names that header as one a cross-origin caller may read',
    (csv.headers.get('access-control-expose-headers') ?? '').includes('x-flint-timezone'),
  )

  const nowhere = await post(
    '/api/data',
    { dataset: DATASET, select: ['query_id'], timezone: 'Pacific/Auckland', limit: 1 },
    400,
  )
  ok(
    'a zone with no boundary to move is refused rather than ignored',
    /nothing to place/.test(nowhere.body.error?.message ?? ''),
    nowhere.body.error?.message,
  )

  const unknown = await post(
    '/api/data',
    {
      dataset: DATASET,
      time: { column: 'event_time', granularity: 'day' },
      metrics: [{ aggregation: 'count' }],
      timezone: 'Europe/Atlantis',
    },
    400,
  )
  ok(
    'and a zone this server has never heard of is too',
    /not a timezone this ClickHouse knows/.test(unknown.body.error?.message ?? ''),
    unknown.body.error?.message,
  )
}

/* ── What it refuses, and why ──────────────────────────────────────────── */

async function checkRefusals() {
  console.log('refusals')
  const refused = async (what, body, expect, contains) => {
    const { status, body: answer } = await post('/api/data', body, null)
    const message = answer?.error?.message ?? ''
    ok(
      what,
      status === expect && message.includes(contains),
      `${status} ${message.slice(0, 120)}`,
    )
  }

  await refused(
    'summing an identifier',
    { dataset: DATASET, metrics: [{ aggregation: 'sum', column: 'query_id' }] },
    400,
    'does not take `sum`',
  )
  await refused(
    'averaging a timestamp',
    { dataset: DATASET, metrics: [{ aggregation: 'avg', column: 'event_time' }] },
    400,
    'does not take `avg`',
  )
  await refused(
    'a column that is not there',
    { dataset: DATASET, select: ['nope'] },
    400,
    'not one of the',
  )
  await refused(
    'a cursor on an aggregated answer',
    { dataset: DATASET, dimensions: ['type'], cursor: 'x' },
    400,
    'computed rather than stored',
  )
  await refused(
    'a comparison with nothing measured',
    { dataset: DATASET, time: { column: 'event_time', period: 'today', compare: 'previous_period' }, dimensions: ['type'] },
    400,
    'compares measurements',
  )
  await refused(
    'a dataset that is not there',
    { dataset: 'system.no_such_dataset', select: ['x'] },
    404,
    'not a dataset',
  )
  // It used to serve one row and report `limit_asked: 0` — honest, and still
  // not what anybody asked for. Refusing also keeps a zero away from the row
  // cap, where zero means *no cap*.
  await refused('a page of no rows', { dataset: STABLE, limit: 0 }, 400, '`count`')

  // The façade: a refusal must not hand back ClickHouse's vocabulary.
  const { body } = await post(
    '/api/data',
    { dataset: 'system.no_such_dataset', select: ['x'] },
    null,
  )
  const message = body?.error?.message ?? ''
  ok(
    'and a refusal does not name the server underneath',
    !/grant|clickhouse|ACCESS_DENIED|version \d/i.test(message),
    message.slice(0, 160),
  )
}

/* ── The trail ─────────────────────────────────────────────────────────── */

/** The audit has to hold what just happened, and say so about what it does not.
 *
 *  Its failure mode is the quiet one this file exists for: an audit that misses
 *  entries looks exactly like a quiet week, and one that reports the wrong user
 *  looks like a colleague did something they did not. Neither is visible from a
 *  status code. */
async function checkAudit() {
  console.log('audit')

  // Something to find, and something that must *not* be found as a success.
  const marker = `${STABLE}`
  await post('/api/data', { dataset: marker, metrics: [{ aggregation: 'count' }] })
  await post('/api/data', { dataset: 'system.no_such_dataset', select: ['x'] }, null)

  // The query log is flushed on its own schedule; an entry that has not landed
  // yet is not a missing entry, so this waits rather than asserting into a gap.
  let seen = null
  for (let tries = 0; tries < 12; tries += 1) {
    const { body } = await get('/api/diagnostics/audit?days=1&limit=200')
    seen = body
    if (body.entries?.some((e) => e.kind === 'dataset' && e.what === marker)) break
    await new Promise((r) => setTimeout(r, 2000))
  }

  if (seen?.calls_unavailable) {
    console.log(`  skip ${seen.calls_unavailable}`)
    return
  }

  const mine = seen.entries.filter((e) => e.kind === 'dataset' && e.what === marker)
  ok('a read that just happened is in the trail', mine.length > 0)
  ok(
    'attributed to whoever made it, as the server knows them',
    mine.every((e) => e.who && (!USER || e.who === USER)),
    mine[0] ? `who=${mine[0].who}` : 'nothing to attribute',
  )
  ok(
    'and it is not marked as having failed',
    mine.every((e) => e.outcome === 'ok'),
  )
  ok(
    'every entry carries a time, a person and a thing',
    seen.entries.every((e) => e.at && e.who && e.what && e.kind),
  )
  ok(
    'and an outcome that is one of the three there are',
    seen.entries.every((e) => ['ok', 'failed', 'unfinished'].includes(e.outcome)),
    [...new Set(seen.entries.map((e) => e.outcome))].join(', '),
  )
  ok(
    'a call is never unfinished — only an operation can be',
    seen.entries.every((e) => e.kind === 'operation' || e.outcome !== 'unfinished'),
  )
  // Against the server's own clock, not this machine's.
  //
  // The first version compared `e.at` to `Date.now()`, which is two clocks in
  // two frames: an audit timestamp is naive and in ClickHouse's timezone, and
  // JavaScript parses a naive string as *local*. Here ClickHouse is UTC and the
  // checker is CEST, so every entry looked two hours old and the check passed
  // by luck of the sign. Point it at a ClickHouse an hour ahead of the machine
  // running this and it would have called a healthy server broken.
  //
  // The newest thing the server has recorded is a bound in the server's own
  // frame, and nothing it did can be dated after it.
  const { body: latest } = await post('/api/data', {
    dataset: DATASET,
    metrics: [{ aggregation: 'max', column: 'event_time', as: 'newest' }],
  })
  const newest = latest.rows[0]?.newest
  ok(
    'nothing is dated after the newest thing the server has recorded',
    Boolean(newest) && seen.entries.every((e) => e.at <= newest),
    seen.entries.filter((e) => e.at > newest).map((e) => `${e.at} > ${newest}`)[0] ?? '',
  )
  ok(
    'newest first, which is the order somebody reads it in',
    seen.entries.every((e, i) => i === 0 || seen.entries[i - 1].at >= e.at),
  )

  // The one an audit is most read for. A dataset that does not exist is a 404
  // rather than a refusal, so this only asserts that *some* failure is recorded
  // with its reason where one is — a server nobody has been refused on is a
  // fine server.
  // `failed` only. An operation can be neither — a job still running, or one
  // Flint stopped watching — and demanding a reason from those would be asking
  // why something that has not ended yet ended.
  const refused = seen.entries.filter((e) => e.outcome === 'failed')
  ok(
    'a failure carries the reason it failed',
    refused.every((e) => Boolean(e.detail)),
    `${refused.length} failures, ${refused.filter((e) => !e.detail).length} without a reason`,
  )

  const { status } = await get('/api/diagnostics/audit?days=999&limit=99999', null)
  ok('an absurd window is clamped rather than refused', status === 200)

  // A cut list has to say so, and must not invent a total while doing it. An
  // earlier version said "showing the 3 most recent of 6" — where the 6 was
  // twice the page, because each half is asked for a page and no more. On a
  // server with a thousand calls in the window that read as a quiet week,
  // tidily summarised.
  const { body: small } = await get('/api/diagnostics/audit?days=7&limit=3')
  if (small.entries.length < 3) {
    console.log('  skip not enough in the window to cut')
    return
  }
  ok('a cut list says it was cut', Boolean(small.note), small.note ?? 'no note')
  const claimed = /of (\d+)/.exec(small.note ?? '')
  ok(
    'and does not claim a total it has not counted',
    claimed === null,
    claimed ? `claims a total of ${claimed[1]}` : '',
  )
}

/* ── The document ──────────────────────────────────────────────────────── */

async function checkDocument() {
  console.log('openapi')
  const response = await fetch(`${BASE}/api/data/openapi.json`, {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  })
  ok('answers', response.ok)
  const doc = await response.json()

  const refs = []
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref') refs.push(value)
        walk(value)
      }
    }
  }
  walk(doc)
  const dangling = refs.filter((ref) => {
    let at = doc
    for (const step of ref.replace(/^#\//, '').split('/')) at = at?.[step]
    return at === undefined
  })
  ok('every reference in it points at something', dangling.length === 0, dangling.join(', '))

  const field = doc.components.schemas.Query.properties.dataset
  ok(
    'the dataset enum is this caller’s own',
    !field.enum || field.enum.includes(DATASET),
    `${field.enum?.length ?? 'no'} entries`,
  )
}

/* ── Run ───────────────────────────────────────────────────────────────── */

try {
  await signIn()
  await preflight()
  await checkListing()
  await checkInventory()
  await checkAggregation()
  await checkFilterTree()
  await checkHaving()
  await checkTime()
  await checkTimezone()
  await checkCursor()
  await checkRefusals()
  await checkAudit()
  await checkDocument()
} catch (error) {
  console.error(`\nstopped: ${error.message}`)
  process.exit(1)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
