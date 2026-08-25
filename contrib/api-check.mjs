/**
 * The published API surface, against a running Flint.
 *
 *   node contrib/api-check.mjs [base-url]
 *
 * `smoke.sh` asks every route whether it answers. This asks the published face
 * whether it answers *correctly* — which is a different question, and the only
 * one that matters for the half of Flint that other people's scripts depend on.
 * A filter that silently returns the unfiltered table is a 200. So is a cursor
 * that skips every third row. Neither is visible from a status code, and none
 * of it is visible to a unit test: the wrapper, the bindings and the ordering
 * all have to reach a real ClickHouse to mean anything.
 *
 * It publishes a throwaway endpoint over `system.numbers`, exercises it, and
 * deletes it again — including when an assertion fails, because an endpoint
 * left armed after a failed check is worse than no check.
 */
const BASE = process.argv[2] ?? 'http://localhost:8096'
const SLUG = 'flint-api-check'

/** 500 rows with one of everything a filter can meet: a wide integer, a string,
 *  a timestamp, a column that can be null, and one that is not a scalar. */
const STATEMENT = [
  'SELECT number AS n,',
  '       toString(number % 5) AS bucket,',
  '       toDateTime(1700000000 + number) AS ts,',
  "       if(number % 7 = 0, NULL, concat('row-', toString(number))) AS note,",
  '       [1, 2] AS tags',
  'FROM system.numbers',
  'WHERE number >= {from:UInt64}',
  'LIMIT 500',
].join('\n')

let failures = 0
let checked = 0

function ok(what) {
  checked += 1
  console.log(`  ok   ${what}`)
}

function fail(what, why) {
  failures += 1
  console.log(`  FAIL ${what}\n       ${why}`)
}

/** Every assertion is a sentence about the endpoint, not about the code. */
async function check(what, run) {
  try {
    await run()
    ok(what)
  } catch (e) {
    fail(what, String(e.message ?? e).slice(0, 300))
  }
}

function assert(claim, why) {
  if (!claim) throw new Error(why)
}

function assertEqual(got, want, why) {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  if (a !== b) throw new Error(`${why}: got ${a}, wanted ${b}`)
}

let token = ''

async function call(query, { as = 'json', headers = {} } = {}) {
  const response = await fetch(`${BASE}/api/data/${SLUG}${query ? `?${query}` : ''}`, {
    headers: { 'X-Flint-Token': token, ...headers },
  })
  const text = await response.text()
  return {
    status: response.status,
    headers: response.headers,
    body: as === 'json' ? safeJson(text) : text,
    text,
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function main() {
  // ── Publish the endpoint this whole file is about ─────────────────────
  const created = await fetch(`${BASE}/api/published`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Flint API check',
      slug: SLUG,
      sql: STATEMENT,
      database: '',
      defaults: JSON.stringify({ from: '0' }),
      public: false,
      enabled: true,
      max_rows: 10,
    }),
  })
  if (!created.ok) {
    const why = await created.text()
    console.error(
      `could not publish the endpoint this check needs (HTTP ${created.status}).\n` +
        `${why.slice(0, 300)}\n` +
        'A workspace is required: set FLINT_WORKSPACE_DATABASE and try again.',
    )
    process.exit(2)
  }
  const mine = (await created.json()).find((e) => e.slug === SLUG)
  token = mine.token

  console.log(`Flint at ${BASE}, calling /api/data/${SLUG}`)

  // ── The answer, and where it says it is ───────────────────────────────

  await check('an unshaped call answers with the endpoint page size', async () => {
    const { status, body } = await call('')
    assertEqual(status, 200, 'status')
    assertEqual(body.rows.length, 10, 'rows')
    assertEqual(body.page.limit, 10, 'page.limit')
    assertEqual(body.page.offset, 0, 'page.offset')
    assert(body.page.has_more, 'there are 500 rows behind a page of 10')
    assert(body.page.next?.includes('offset=10'), 'the next page is named')
  })

  await check('the headers say what the envelope says', async () => {
    const { headers } = await call('limit=3')
    assertEqual(headers.get('x-flint-limit'), '3', 'X-Flint-Limit')
    assertEqual(headers.get('x-flint-returned'), '3', 'X-Flint-Returned')
    assertEqual(headers.get('x-flint-has-more'), 'true', 'X-Flint-Has-More')
    assert(headers.get('link')?.includes('rel="next"'), 'a Link to the next page')
  })

  await check('a page bigger than the endpoint serves is capped, and says so', async () => {
    const { body } = await call('limit=5000')
    assertEqual(body.page.limit, 10, 'page.limit')
    assertEqual(body.page.limit_asked, 5000, 'page.limit_asked')
  })

  await check('a total is counted only when it is asked for', async () => {
    const without = await call('limit=2')
    assert(without.body.total === undefined, 'no total unless asked for')
    const { body } = await call('limit=2&count=exact')
    assertEqual(body.total, 500, 'total')
  })

  // ── Filters ───────────────────────────────────────────────────────────

  await check('a filter narrows, and the count counts what it narrowed', async () => {
    const { body } = await call('bucket=eq.3&count=exact&limit=4')
    assertEqual(body.total, 100, 'one bucket in five')
    assert(
      body.rows.every((r) => r.bucket === '3'),
      'every row is in the bucket asked for',
    )
  })

  await check('a list, a null test and a text match each mean what they say', async () => {
    const list = await call('bucket=in.1,4&count=exact&limit=1')
    assertEqual(list.body.total, 200, 'two buckets in five')
    const nulls = await call('note=isnull&count=exact&limit=1')
    assertEqual(nulls.body.total, 72, 'every seventh row of 500')
    const like = await call('note=ilike.%25row-4_&limit=3&select=note')
    assert(
      like.body.rows.every((r) => /^row-4\d$/.test(r.note)),
      'the pattern matched what it describes',
    )
  })

  await check('a date filter takes a date a human would write', async () => {
    const day = await call('ts=lt.2023-11-15&count=exact&limit=1')
    assertEqual(day.body.total, 500, 'all of them are before the next day')
    const exact = await call('ts=gte.2023-11-14%2022:15:00&limit=1&select=n')
    assertEqual(exact.body.rows[0].n, '100', 'the row at that second')
  })

  await check('a date that is not one fails loudly rather than matching nothing', async () => {
    // The failure mode this guards: `parseDateTimeBestEffortOrNull` would make
    // this a 200 with no rows, which looks exactly like a true answer.
    const { status, body } = await call('ts=lt.yesterday')
    assertEqual(status, 400, 'status')
    assert(/Cannot read DateTime|Cannot parse/i.test(body.error.message), 'says what it could not read')
  })

  await check('an error does not hand back the statement it failed on', async () => {
    const { body } = await call('ts=lt.yesterday')
    assert(!/system\.numbers|SELECT/i.test(body.error.message), 'the SQL is not quoted back')
  })

  // ── The things that are refused, and by name ──────────────────────────

  await check('an unknown column is refused by name, with the ones that exist', async () => {
    const { status, body } = await call('buckt=eq.1')
    assertEqual(status, 400, 'status')
    assert(body.error.message.includes('buckt'), 'names what was asked for')
    assert(body.error.message.includes('bucket'), 'names what exists')
  })

  await check('a filter with no operator is refused with the one it meant', async () => {
    const { status, body } = await call('bucket=3')
    assertEqual(status, 400, 'status')
    assert(body.error.message.includes('bucket=eq.3'), 'suggests the equality test')
  })

  await check('a column that is not one value is returned but not filtered', async () => {
    const { status, body } = await call('tags=eq.1')
    assertEqual(status, 400, 'status')
    assert(body.error.message.includes('not collections'), 'says why')
    const rows = await call('limit=1')
    assert(Array.isArray(rows.body.rows[0].tags), 'and is still returned')
  })

  await check('a null test is refused where nothing can be null', async () => {
    const { status, body } = await call('bucket=isnull')
    assertEqual(status, 400, 'status')
    assert(body.error.message.includes('never be null'), 'says why it would match nothing')
  })

  // ── Order, projection, formats ────────────────────────────────────────

  await check('an order sorts, and .desc reverses it', async () => {
    const up = await call('order=n&limit=3&select=n')
    assertEqual(up.body.rows.map((r) => r.n), ['0', '1', '2'], 'ascending')
    const down = await call('order=n.desc&limit=3&select=n')
    assertEqual(down.body.rows.map((r) => r.n), ['499', '498', '497'], 'descending')
  })

  await check('a projection returns those columns and no others', async () => {
    const { body } = await call('select=n,bucket&limit=1')
    assertEqual(body.columns, ['n', 'bucket'], 'columns')
    assertEqual(Object.keys(body.rows[0]), ['n', 'bucket'], 'the row itself')
  })

  await check('csv and ndjson carry the paging the envelope cannot', async () => {
    const csv = await call('limit=2&select=n,note&format=csv', { as: 'text' })
    assert(csv.headers.get('content-type').startsWith('text/csv'), 'content type')
    assertEqual(csv.text.split('\n')[0], 'n,note', 'a header row')
    assertEqual(csv.headers.get('x-flint-returned'), '2', 'the count, in a header')

    const nd = await call('limit=2&select=n&format=ndjson', { as: 'text' })
    const lines = nd.text.trim().split('\n')
    assertEqual(lines.length, 2, 'one object per line')
    assertEqual(JSON.parse(lines[0]).n, '0', 'and each line is an object')
    assert(nd.headers.get('link')?.includes('rel="next"'), 'the next page, in a header')
  })

  // ── Cursors: the whole point of the exercise ──────────────────────────

  await check('a cursor walks the whole result exactly once', async () => {
    // The failure this catches is invisible any other way: offset paging over
    // moving rows serves one twice and never serves another, and every page of
    // it is a 200.
    const seen = []
    let path = `order=bucket.desc,n&limit=5&select=n,bucket`
    let pages = 0
    while (path && pages < 200) {
      const { body } = await call(path)
      seen.push(...body.rows.map((r) => r.n))
      pages += 1
      path = body.page.next ? body.page.next.split('?')[1] : null
    }
    assertEqual(pages, 100, 'pages of five over five hundred rows')
    assertEqual(seen.length, 500, 'rows seen')
    assertEqual(new Set(seen).size, 500, 'and every one of them distinct')
  })

  await check('an ordering column comes back for the cursor and not for the caller', async () => {
    const { body } = await call('select=bucket&order=n.desc&limit=3')
    assertEqual(body.columns, ['bucket'], 'the caller asked for one column')
    assert(body.page.cursor, 'and there is still a cursor')
  })

  await check('a cursor is refused where it would point somewhere else', async () => {
    const first = await call('order=n.desc&limit=1')
    const cursor = first.body.page.cursor
    const wrong = await call(`order=bucket&cursor=${encodeURIComponent(cursor)}`)
    assertEqual(wrong.status, 400, 'a cursor from another order')
    assert(wrong.body.error.message.includes('n.desc'), 'names the order it was made for')

    const both = await call(`order=n.desc&offset=5&cursor=${encodeURIComponent(cursor)}`)
    assertEqual(both.status, 400, 'two ways of saying where to start')

    const alone = await call(`cursor=${encodeURIComponent(cursor)}`)
    assertEqual(alone.status, 400, 'a cursor with no order')

    const nonsense = await call('order=n&cursor=not-a-cursor')
    assertEqual(nonsense.status, 400, 'something that is not a cursor')
  })

  await check('an order that can be null pages by offset, and says why', async () => {
    const { body } = await call('order=note&limit=2&select=n,note')
    assert(body.page.cursor === undefined, 'no cursor over a nullable column')
    assert(body.page.cursor_note?.includes('note'), 'and it names the column')
    assert(body.page.next.includes('offset='), 'so it pages by offset instead')
  })

  // ── What the endpoint says about itself ───────────────────────────────

  await check('the schema documents the columns and what each one takes', async () => {
    const response = await fetch(`${BASE}/api/data/${SLUG}/schema`, {
      headers: { 'X-Flint-Token': token },
    })
    const doc = await response.json()
    assertEqual(response.status, 200, 'status')
    assertEqual(doc.parameters.map((p) => p.name), ['from'], 'the statement parameter')
    const byName = Object.fromEntries(doc.columns.map((c) => [c.name, c.filter]))
    assert(byName.bucket.includes('like'), 'a string takes a text match')
    assert(!byName.bucket.includes('isnull'), 'and not a null test')
    assert(byName.note.includes('isnull'), 'a nullable column does')
    assertEqual(byName.tags, [], 'and an array takes nothing')
  })

  await check('the OpenAPI document resolves every reference it makes', async () => {
    const response = await fetch(`${BASE}/api/data/${SLUG}/openapi.json`, {
      headers: { 'X-Flint-Token': token },
    })
    const doc = await response.json()
    assertEqual(response.status, 200, 'status')
    for (const reference of references(doc)) {
      let at = doc
      for (const step of reference.replace('#/', '').split('/')) {
        at = at?.[step]
        assert(at !== undefined, `${reference} points at nothing`)
      }
    }
    const params = doc.paths[`/api/data/${SLUG}`].get.parameters.map((p) => p.name)
    for (const wanted of ['from', 'limit', 'offset', 'cursor', 'order', 'select', 'bucket']) {
      assert(params.includes(wanted), `${wanted} is documented`)
    }
    assert(!params.includes('tags'), 'and a column nothing can filter on is not')
    // The mapping that would bite hardest if it were the obvious one.
    assertEqual(doc.components.schemas.Row.properties.n.type, 'string', 'a 64-bit integer')
  })

  await check('every endpoint is in one document too', async () => {
    const doc = await (await fetch(`${BASE}/api/published/openapi.json`)).json()
    assert(doc.paths[`/api/data/${SLUG}`], 'this endpoint is in it')
    for (const reference of references(doc)) {
      let at = doc
      for (const step of reference.replace('#/', '').split('/')) {
        at = at?.[step]
        assert(at !== undefined, `${reference} points at nothing`)
      }
    }
  })

  // ── The door ──────────────────────────────────────────────────────────

  await check('the token is the door, and a wrong address is a closed one', async () => {
    const none = await fetch(`${BASE}/api/data/${SLUG}?limit=1`)
    assertEqual(none.status, 401, 'no token')
    const bearer = await fetch(`${BASE}/api/data/${SLUG}?limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assertEqual(bearer.status, 200, 'a bearer authorization is accepted too')
    const nowhere = await fetch(`${BASE}/api/data/no-such-endpoint`)
    assertEqual(nowhere.status, 404, 'an address nothing answers at')
    const format = await call('format=xlsx')
    assertEqual(format.status, 400, 'a format nothing serves')
  })
}

function references(value, out = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => references(item, out))
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref' && typeof child === 'string') out.push(child)
      else references(child, out)
    }
  }
  return out
}

/** Whatever happened, the throwaway endpoint does not outlive the check. */
async function cleanUp() {
  try {
    const all = await (await fetch(`${BASE}/api/published`)).json()
    const mine = all.find((e) => e.slug === SLUG)
    if (mine) {
      await fetch(`${BASE}/api/published/${mine.id}`, { method: 'DELETE' })
    }
  } catch {
    console.log(`  --   could not remove the endpoint at /api/data/${SLUG}; remove it by hand`)
  }
}

try {
  await main()
} catch (e) {
  fail('the check itself', String(e.stack ?? e).slice(0, 400))
} finally {
  await cleanUp()
}

console.log()
if (failures) {
  console.log(`${failures} of ${checked + failures} checks failed`)
  process.exit(1)
}
console.log(`${checked} checks, and the published face answered correctly to all of them`)
