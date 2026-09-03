import { describe, expect, it } from 'vitest'
import {
  answers,
  byAddress,
  contractIsEmpty,
  contractIsFrozen,
  hiddenNote,
  listedRevisions,
  nextRevision,
  parseContract,
  quoted,
  unkeepablePromises,
  callerName,
  hitRate,
  quotaFilled,
  quotaNote,
  unreachedCalls,
  usageBySlug,
  usageKey,
  type Contract,
  type KeyUsage,
  callQuery,
  callUrl,
  curlExample,
  curlFor,
  declaredParams,
  declaredParamsTyped,
  emptyCall,
  nextLink,
  openapiPath,
  sheetsCaveat,
  snippet,
  opsFor,
  endpointPath,
  callerParams,
  callerParamsTyped,
  isQuestion,
  parseDefaults,
  problemWithPublished,
  requiredParams,
  serialiseDefaults,
  slugify,
  validSlug,
  type Call,
  type EndpointSchema,
  type Published,
} from './publish'

const endpoint = (over: Partial<Published> = {}): Published => ({
  revision: 1,
  state: 'live',
  description: '',
  cache_ttl: 0,
  contract: '',
  published_by: '',
  document: '',
  id: 'i',
  name: 'By city',
  slug: 'by-city',
  sql: 'SELECT city FROM events WHERE city = {city:String}',
  database: 'analytics',
  timezone: '',
  defaults: '{}',
  token_hashed: true,
  expires_at: '',
  run_as: '',
  public: false,
  enabled: true,
  max_rows: 1000,
  created_at: '',
  updated_at: '',
  ...over,
})

describe('validSlug', () => {
  it('matches the server rule', () => {
    for (const good of ['events', 'daily-totals', 'v2_by_city', 'a']) {
      expect(validSlug(good)).toBe(true)
    }
    for (const bad of ['', 'Events', 'with space', 'trailing-', '-leading', 'a/b', 'a.b', 'é']) {
      expect(validSlug(bad)).toBe(false)
    }
    expect(validSlug('x'.repeat(65))).toBe(false)
  })
})

describe('slugify', () => {
  it('turns a name into a usable address so nobody learns the rule', () => {
    expect(slugify('Events by city')).toBe('events-by-city')
    expect(slugify('Événements — par ville!')).toBe('evenements-par-ville')
    expect(slugify('  spaced  out  ')).toBe('spaced-out')
  })

  it('always produces something valid, or nothing', () => {
    for (const name of ['Events by city', '???', 'A', 'x'.repeat(120)]) {
      const slug = slugify(name)
      if (slug) expect(validSlug(slug)).toBe(true)
    }
  })
})

describe('declaredParams', () => {
  it('reads ClickHouse placeholders, sorted and deduplicated', () => {
    expect(declaredParams('WHERE a = {b:String} AND c = {a:UInt8}')).toEqual(['a', 'b'])
    expect(declaredParams('SELECT {x:UInt8} + {x:UInt8}')).toEqual(['x'])
  })

  it('agrees with the server about what is not a parameter', () => {
    // The same cases the Rust side is tested against: a brace that is not a
    // placeholder must not demand a parameter nobody can supply.
    expect(declaredParams("SELECT map('a', 1)['a']")).toEqual([])
    expect(declaredParams('SELECT {no_type}')).toEqual([])
    expect(declaredParams('SELECT {:String}')).toEqual([])
    expect(declaredParams('SELECT {not a name:String}')).toEqual([])
    expect(declaredParams('SELECT 1')).toEqual([])
  })
})

describe('defaults', () => {
  it('round trips', () => {
    expect(parseDefaults(serialiseDefaults({ days: '7' }))).toEqual({ days: '7' })
  })

  it('drops a blank, which is not a default', () => {
    // Storing an empty default would satisfy a required parameter with nothing.
    expect(serialiseDefaults({ days: '  ', city: 'Oslo' })).toBe('{"city":"Oslo"}')
  })

  it('survives a stored value it cannot read', () => {
    expect(parseDefaults('nonsense')).toEqual({})
    expect(parseDefaults('[1,2]')).toEqual({})
    expect(parseDefaults('null')).toEqual({})
  })
})

describe('what a caller may supply', () => {
  const question = `{"dataset":"default.t","select":["a"],"filter":{"column":"n","op":"eq","value":"1"}}`

  it('is nothing at all where the endpoint answers a question', () => {
    // The statement of a question is generated and its placeholders are the
    // renderer's: they carry the values the question was published with, and
    // the server refuses to let a caller set one. Offering a box for
    // `flint_f0` would invite somebody to fill in the question's own filter.
    const asks = endpoint({
      sql: 'SELECT a FROM t WHERE n = {flint_f0:Int32}',
      document: question,
    })
    expect(isQuestion(asks)).toBe(true)
    expect(callerParams(asks)).toEqual([])
    expect(callerParamsTyped(asks)).toEqual([])
  })

  it('and is what the statement declares where somebody typed it', () => {
    const typed = endpoint({ sql: 'SELECT a FROM t WHERE n = {n:Int32}' })
    expect(isQuestion(typed)).toBe(false)
    expect(callerParams(typed)).toEqual(['n'])
  })
})

describe('requiredParams', () => {
  it('is what the caller must always send', () => {
    const sql = 'WHERE city = {city:String} AND days > {days:UInt8}'
    expect(requiredParams(sql, {})).toEqual(['city', 'days'])
    expect(requiredParams(sql, { days: '7' })).toEqual(['city'])
  })
})

describe('curlExample', () => {
  it('sends the token as a header, never in the URL', () => {
    // A token in a URL ends up in logs and in shell history.
    const example = curlExample(endpoint(), 'http://flint.local', 'tok')
    expect(example).toContain('X-Flint-Token: tok')
    expect(example).not.toContain('token=tok')
  })

  it('stands a placeholder in where the token is no longer knowable', () => {
    // Which is almost always: a token is hashed at rest and readable once, so
    // a page opened later has nothing to paste. Printing the placeholder is
    // the honest version — the alternative is keeping the secret readable so
    // the snippet stays copy-pasteable, which is what the hashing was for.
    expect(curlExample(endpoint(), 'http://x')).toContain('X-Flint-Token: YOUR_TOKEN')
  })

  it('shows the parameters the statement needs', () => {
    expect(curlExample(endpoint(), 'http://x')).toContain('city=%3Ccity%3E')
    expect(curlExample(endpoint({ defaults: '{"city":"Oslo"}' }), 'http://x')).toContain(
      'city=Oslo',
    )
  })

  it('omits the header for a public endpoint', () => {
    expect(curlExample(endpoint({ public: true }), 'http://x')).not.toContain('Token')
  })
})

describe('endpointPath', () => {
  it('is namespaced so it cannot collide with the app', () => {
    expect(endpointPath('by-city')).toBe('/api/data/by-city')
  })

  it('hangs the endpoint\'s own documents off it', () => {
    expect(openapiPath('by-city')).toBe('/api/data/by-city/openapi.json')
  })
})

describe('problemWithPublished', () => {
  it('explains the address rule rather than just rejecting', () => {
    expect(problemWithPublished({ name: '', slug: 'a', sql: 'x' })).toContain('name')
    expect(problemWithPublished({ name: 'A', slug: '', sql: 'x' })).toContain('address')
    expect(problemWithPublished({ name: 'A', slug: 'Bad Slug', sql: 'x' })).toContain('lower-case')
    expect(problemWithPublished({ name: 'A', slug: 'a', sql: ' ' })).toContain('statement')
    expect(problemWithPublished({ name: 'A', slug: 'a', sql: 'SELECT 1' })).toBeNull()
  })
})


const call = (over: Partial<Call> = {}): Call => ({ ...emptyCall, ...over })

describe('declaredParamsTyped', () => {
  it('keeps the type, which is what says whether a date or an epoch is wanted', () => {
    expect(declaredParamsTyped('SELECT {since:DateTime}, {n:UInt32}')).toEqual([
      { name: 'n', type: 'UInt32' },
      { name: 'since', type: 'DateTime' },
    ])
  })
})

describe('callQuery', () => {
  it('asks the question first and shapes the answer after', () => {
    expect(
      callQuery(
        call({
          values: { city: 'Oslo' },
          filters: [{ column: 'n', op: 'gte', value: '10' }],
          order: [{ column: 'n', desc: true }],
          select: ['city', 'n'],
          limit: 50,
          offset: 100,
          count: true,
          format: 'csv',
        }),
      ),
    ).toEqual([
      ['city', 'Oslo'],
      ['n', 'gte.10'],
      ['select', 'city,n'],
      ['order', 'n.desc'],
      ['limit', '50'],
      ['offset', '100'],
      ['count', 'exact'],
      ['format', 'csv'],
    ])
  })

  it('leaves out everything that is already the default', () => {
    // A URL carrying `offset=0&format=json` says nothing and reads as though
    // it does. What the endpoint would do anyway does not belong in it.
    expect(callQuery(call({ values: { city: '' } }))).toEqual([])
  })

  it('writes an operator that takes no value as the whole term', () => {
    expect(callQuery(call({ filters: [{ column: 'note', op: 'isnull', value: '' }] }))).toEqual([
      ['note', 'isnull'],
    ])
    // And drops a comparison nobody filled in, rather than sending `eq.`,
    // which asks for the rows whose value is the empty string.
    expect(callQuery(call({ filters: [{ column: 'note', op: 'eq', value: '' }] }))).toEqual([])
  })
})

describe('callUrl', () => {
  it('escapes what a caller typed', () => {
    expect(callUrl('by-city', call({ values: { city: 'Oslo Sør' } }))).toBe(
      '/api/data/by-city?city=Oslo%20S%C3%B8r',
    )
    expect(callUrl('by-city', call())).toBe('/api/data/by-city')
  })
})

describe('curlFor', () => {
  it('sends the token as a header, never in the URL', () => {
    const example = curlFor(endpoint(), 'http://x', call({ limit: 10 }), 'tok')
    expect(example).toContain('X-Flint-Token: tok')
    expect(example).not.toContain('token=')
    expect(example).toContain('/api/data/by-city?limit=10')
  })
})

describe('opsFor', () => {
  it('offers what the column takes, and everything when the schema is unread', () => {
    const schema = {
      columns: [{ name: 'n', type: 'UInt32', filter: ['eq', 'gt'] }],
    } as EndpointSchema
    expect(opsFor(schema, 'n')).toEqual(['eq', 'gt'])
    // An unread schema offers everything rather than nothing: a builder that
    // offers no operator is more broken than one the server may correct.
    expect(opsFor(undefined, 'n').length).toBeGreaterThan(2)
  })
})


describe('nextLink', () => {
  it('reads the next page out of the header every format carries', () => {
    // CSV and NDJSON have no envelope, so the header is the only place the
    // next page is written down.
    expect(
      nextLink([
        ['x-flint-has-more', 'true'],
        ['link', '</api/data/x?limit=10&cursor=abc>; rel="next"'],
      ]),
    ).toBe('/api/data/x?limit=10&cursor=abc')
    expect(nextLink([['x-flint-has-more', 'false']])).toBeNull()
    // A `Link` that is not the next page is not the next page.
    expect(nextLink([['link', '</api/data/x>; rel="describedby"']])).toBeNull()
  })
})


describe('snippet', () => {
  const call = (over: Partial<Call> = {}): Call => ({ ...emptyCall, ...over })

  it('pages by following the link rather than by counting', () => {
    // The point of the whole cursor apparatus is that nobody writes
    // `offset += 100` by hand, so the snippet must not teach them to.
    for (const kind of ['python', 'javascript'] as const) {
      const code = snippet(kind, endpoint(), 'http://x', call({ limit: 100 }))
      expect(code).toContain('next')
      expect(code).not.toContain('offset +')
      expect(code).toContain('X-Flint-Token')
    }
  })

  it('sends the token as a header everywhere a header can be sent', () => {
    expect(snippet('curl', endpoint(), 'http://x', call())).toContain('X-Flint-Token')
    expect(snippet('python', endpoint(), 'http://x', call())).toContain('X-Flint-Token')
    // And nowhere at all when the endpoint is open.
    expect(snippet('python', endpoint({ public: true }), 'http://x', call())).not.toContain(
      'tok',
    )
  })

  it('puts the token in the URL only where a header is impossible, and says so', () => {
    // A spreadsheet cannot send a header. That is the one exception, and it is
    // not one to make quietly.
    const cell = snippet('sheets', endpoint(), 'http://x', call(), 'tok')
    expect(cell).toContain('=IMPORTDATA(')
    expect(cell).toContain('format=csv')
    expect(cell).toContain('token=tok')
    expect(sheetsCaveat(endpoint())).toContain('the one place the token goes in the URL')

    const open = snippet('sheets', endpoint({ public: true }), 'http://x', call())
    expect(open).not.toContain('token=')
    expect(sheetsCaveat(endpoint({ public: true }))).not.toContain('token')
  })

  it('asks for csv in a spreadsheet whatever the builder was set to', () => {
    const cell = snippet('sheets', endpoint(), 'http://x', call({ format: 'ndjson' }))
    expect(cell).toContain('format=csv')
    expect(cell).not.toContain('ndjson')
  })
})

// ── Revisions ─────────────────────────────────────────────────────────────

const rev = (slug: string, revision: number, state: Published['state']): Published =>
  endpoint({ id: `${slug}-v${revision}`, slug, revision, state })

/** The one address these fixtures build, asserted rather than indexed — a
 *  grouping that returned nothing should fail as a missing address, not as a
 *  property read on undefined three lines later. */
const oneAddress = (rows: Published[]) => {
  const grouped = byAddress(rows)
  expect(grouped).toHaveLength(1)
  const [address] = grouped
  if (!address) throw new Error('byAddress returned nothing')
  return address
}

describe('grouping revisions into addresses', () => {
  it('opens an address on its live revision, whatever order the rows arrived in', () => {
    const address = oneAddress([
      rev('device_daily', 3, 'retiring'),
      rev('device_daily', 4, 'live'),
      rev('device_daily', 5, 'draft'),
    ])
    expect(address.live?.revision).toBe(4)
    expect(address.current.revision).toBe(4)
    // Newest first within the group, so the list reads downwards in age.
    expect(address.revisions.map((r) => r.revision)).toEqual([5, 4, 3])
  })

  it('opens on the newest revision where nothing is live yet', () => {
    // An address whose only revision is a draft has never answered anything.
    // That is a state to draw, not a case to filter out.
    const address = oneAddress([rev('city_summary', 1, 'draft')])
    expect(address.live).toBeUndefined()
    expect(address.current.revision).toBe(1)
  })

  it('sorts the addresses that answer nothing to the bottom', () => {
    const grouped = byAddress([
      rev('draft_only', 1, 'draft'),
      rev('dead', 1, 'retired'),
      rev('working', 1, 'live'),
    ])
    expect(grouped.map((a) => a.slug)).toEqual(['working', 'draft_only', 'dead'])
  })

  it('keeps two addresses apart even when their revisions collide', () => {
    const grouped = byAddress([rev('a', 1, 'live'), rev('b', 1, 'live')])
    expect(grouped).toHaveLength(2)
    expect(grouped.every((g) => g.revisions.length === 1)).toBe(true)
  })
})

describe('what the list shows and what it says it is not showing', () => {
  it('lists everything reachable, plus the draft', () => {
    const address = oneAddress([
      rev('d', 4, 'live'),
      rev('d', 3, 'retiring'),
      rev('d', 5, 'draft'),
      rev('d', 2, 'retired'),
      rev('d', 1, 'retired'),
    ])
    expect(listedRevisions(address).map((r) => r.revision)).toEqual([5, 4, 3])
  })

  it('counts what it folded away rather than truncating in silence', () => {
    const address = oneAddress([
      rev('d', 3, 'live'),
      rev('d', 2, 'retired'),
      rev('d', 1, 'retired'),
    ])
    expect(hiddenNote(address)).toBe('2 retired revisions not shown')
  })

  it('says nothing where nothing was hidden', () => {
    const address = oneAddress([rev('d', 1, 'live')])
    expect(hiddenNote(address)).toBeNull()
  })

  it('counts one in the singular', () => {
    const address = oneAddress([rev('d', 2, 'live'), rev('d', 1, 'retired')])
    expect(hiddenNote(address)).toBe('1 retired revision not shown')
  })

  it('hands out the next number above every revision, retired ones included', () => {
    // Including the retired: a number is never handed out twice, or a caller
    // pinned to v2 would silently start reaching a different contract.
    const address = oneAddress([rev('d', 4, 'live'), rev('d', 9, 'retired')])
    expect(nextRevision(address)).toBe(10)
  })
})

describe('which revisions answer', () => {
  it('is live and retiring, and nothing else', () => {
    expect(answers('live')).toBe(true)
    expect(answers('retiring')).toBe(true)
    expect(answers('draft')).toBe(false)
    expect(answers('retired')).toBe(false)
  })

  it('freezes the contract of exactly the revisions somebody is calling', () => {
    expect(contractIsFrozen(rev('d', 1, 'live'))).toBe(true)
    expect(contractIsFrozen(rev('d', 1, 'retiring'))).toBe(true)
    // A draft is where a change goes, so it is editable.
    expect(contractIsFrozen(rev('d', 1, 'draft'))).toBe(false)
  })
})

describe('reading a contract', () => {
  it('reads the promises out of the column they are stored in', () => {
    const contract = parseContract(
      '{"params":[{"name":"region","one_of":["eu-west"]}],"columns":{"never":["device_id"]},"order_by":["day"],"max_limit":1000}',
    )
    expect(contract.params[0]?.one_of).toEqual(['eu-west'])
    expect(contract.columns.never).toEqual(['device_id'])
    expect(contract.max_limit).toBe(1000)
    expect(contractIsEmpty(contract)).toBe(false)
  })

  it('treats an empty or broken contract as one that promises nothing', () => {
    // The same rule the server follows: a page that refused to render over bad
    // JSON would hide the very endpoint somebody needs to go and fix.
    for (const raw of ['', '   ', '{ not json', '[]', 'null', '42']) {
      expect(contractIsEmpty(parseContract(raw))).toBe(true)
    }
  })

  it('ignores fields of the wrong shape rather than trusting them', () => {
    const contract = parseContract('{"params":"all of them","order_by":7,"max_limit":"lots"}')
    expect(contract.params).toEqual([])
    expect(contract.order_by).toEqual([])
    expect(contract.max_limit).toBeUndefined()
  })
})

// ── Traffic ───────────────────────────────────────────────────────────────

const keyUsage = (over: Partial<KeyUsage> = {}): KeyUsage => ({
  key_id: 'k',
  key_name: 'app-frontend',
  owner: '',
  calls_today: 0,
  quota_per_day: 0,
  throttled_today: 0,
  last_call: '',
  ...over,
})

describe('a hit rate needs both a cache and a denominator', () => {
  it('is the share of answers that came from memory', () => {
    expect(hitRate(60, 100, 78)).toBeCloseTo(0.78)
  })

  it('is nothing at all where the endpoint has no cache', () => {
    // 0% would read as a cache that is failing rather than one that is off.
    expect(hitRate(0, 100, 0)).toBeNull()
  })

  it('is nothing at all where nobody has called', () => {
    // 0% would be a claim about traffic that does not exist.
    expect(hitRate(60, 0, 0)).toBeNull()
  })
})

describe('a quota bar', () => {
  it('is a fraction of the day-s allowance', () => {
    expect(quotaFilled(keyUsage({ calls_today: 30, quota_per_day: 60 }))).toBeCloseTo(0.5)
  })

  it('is absent where the key has no ceiling', () => {
    // A meter with no ceiling is a shape that implies one.
    expect(quotaFilled(keyUsage({ calls_today: 900 }))).toBeNull()
  })

  it('never draws past its own end', () => {
    // The quota is checked before a call is answered, so the count sits
    // exactly at the limit rather than above it — but a clamp is cheaper than
    // finding out that assumption was wrong from a screenshot.
    expect(quotaFilled(keyUsage({ calls_today: 99, quota_per_day: 60 }))).toBe(1)
  })
})

describe('what is said beneath a quota bar', () => {
  it('leads with the throttling, because that is happening now', () => {
    expect(quotaNote(keyUsage({ throttled_today: 41, quota_per_day: 10, calls_today: 10 }))).toBe(
      'throttled 41 times today',
    )
    expect(quotaNote(keyUsage({ throttled_today: 1, quota_per_day: 10, calls_today: 10 }))).toBe(
      'throttled 1 time today',
    )
  })

  it('warns before it becomes today-s news', () => {
    expect(quotaNote(keyUsage({ calls_today: 55, quota_per_day: 60 }))).toBe('5 calls left today')
    expect(quotaNote(keyUsage({ calls_today: 59, quota_per_day: 60 }))).toBe('1 call left today')
  })

  it('says nothing about a key with room to spare, or with no ceiling', () => {
    expect(quotaNote(keyUsage({ calls_today: 10, quota_per_day: 60 }))).toBeNull()
    expect(quotaNote(keyUsage({ calls_today: 90_000 }))).toBeNull()
  })
})

describe('naming a caller', () => {
  it('joins the key to what it said it was doing', () => {
    expect(callerName({ key_name: 'app-frontend', label: 'dashboard tile', calls: 1, last_call: '' })).toBe(
      'app-frontend · dashboard tile',
    )
  })

  it('says no key rather than leaving a blank', () => {
    // Anonymous is a real and permanent answer — a public endpoint has no
    // caller to name — and a blank reads as a figure Flint failed to fetch.
    expect(callerName({ key_name: '', label: '', calls: 1, last_call: '' })).toBe('no key')
    expect(callerName({ key_name: '', label: 'nightly export', calls: 1, last_call: '' })).toBe(
      'no key · nightly export',
    )
  })
})

describe('traffic keyed by address', () => {
  it('is empty where the call log could not be read at all', () => {
    // Not called and cannot tell are different sentences, and only one of them
    // is a fact. An unavailable report yields nothing to look up, so every row
    // falls through to the page-s "usage unknown" wording.
    expect(
      usageBySlug({ available: false, reason: 'no workspace', window_hours: 24, usage: [] }).size,
    ).toBe(0)
    expect(usageBySlug(undefined).size).toBe(0)
  })

  it('files each revision of an address separately', () => {
    // The whole point of the column: "v3 is retiring and still took 2.2 K
    // calls today" is the sentence somebody acts on, and an address-level
    // total hides it inside the revision that replaced it.
    const index = usageBySlug({
      available: true,
      window_hours: 24,
      usage: [
        {
          slug: 'device_daily',
          revision: 4,
          calls: 38_100,
          cached: 29_718,
          failures: 12,
          p95_ms: 41,
          avg_ms: 12,
          last_call: '2026-08-28 14:00:00',
          keys: 2,
        },
        {
          slug: 'device_daily',
          revision: 3,
          calls: 2_200,
          cached: 1_760,
          failures: 0,
          p95_ms: 44,
          avg_ms: 20,
          last_call: '2026-08-28 13:58:00',
          keys: 1,
        },
      ],
    })
    expect(index.get(usageKey('device_daily', 4))?.calls).toBe(38_100)
    expect(index.get(usageKey('device_daily', 3))?.calls).toBe(2_200)
    // A revision that answered nothing is absent, not zero.
    expect(index.get(usageKey('device_daily', 5))).toBeUndefined()
    expect(index.get(usageKey('missing', 1))).toBeUndefined()
  })

  it('cannot confuse two addresses whose names run together', () => {
    // `a` + `11` and `a1` + `1` must not be one key.
    expect(usageKey('a', 11)).not.toBe(usageKey('a1', 1))
  })
})

describe('calls that never reached a revision', () => {
  const row = (revision: number, calls: number, failures: number) => ({
    slug: 'device_daily',
    revision,
    calls,
    cached: 0,
    failures,
    last_call: '',
    keys: 0,
  })

  it('counts the ones refused before Flint knew which revision they wanted', () => {
    // A wrong address, a pin for a revision that does not exist, a missing
    // key: recorded against revision 0, matching no row in the table.
    expect(
      unreachedCalls({
        available: true,
        window_hours: 24,
        usage: [row(2, 150, 96), row(0, 0, 17)],
      }),
    ).toBe(17)
  })

  it('is nothing where every call landed somewhere', () => {
    expect(
      unreachedCalls({ available: true, window_hours: 24, usage: [row(2, 150, 96)] }),
    ).toBe(0)
  })

  it('claims nothing at all where the log could not be read', () => {
    expect(unreachedCalls({ available: false, window_hours: 24, usage: [] })).toBe(0)
    expect(unreachedCalls(undefined)).toBe(0)
  })
})

describe('promises the statement cannot keep', () => {
  const contract = (over: Partial<Contract> = {}): Contract => ({
    params: [],
    columns: {},
    order_by: [],
    ...over,
  })

  it('names a column the endpoint offers and cannot produce', () => {
    const found = unkeepablePromises(contract({ columns: { only: ['day', 'p95'] } }), [
      'day',
      'events',
    ])
    expect(found.offered).toEqual(['p95'])
    expect(found.guarding).toEqual([])
  })

  it('keeps the sort list in the same bucket as the allow-list', () => {
    // Both are ways of *offering* a column, and both fail the same way.
    const found = unkeepablePromises(contract({ order_by: ['cost'] }), ['day'])
    expect(found.offered).toEqual(['cost'])
  })

  it('reports a deny-list entry separately, because it fails differently', () => {
    // Guarding a column that is not there is harmless on its own. What it
    // usually is, is a typo — and the column it was meant to keep inside is
    // then leaving on every call.
    const found = unkeepablePromises(
      contract({ columns: { never: ['device_ids'] } }),
      ['day', 'device_id'],
    )
    expect(found.offered).toEqual([])
    expect(found.guarding).toEqual(['device_ids'])
  })

  it('counts a name promised twice as one mistake', () => {
    const found = unkeepablePromises(
      contract({ columns: { only: ['p95'] }, order_by: ['p95'] }),
      ['day'],
    )
    expect(found.offered).toEqual(['p95'])
  })

  it('says nothing at all until somebody has asked what the statement returns', () => {
    // Empty is "nobody has asked yet", not "it returns nothing". Flagging
    // every column of an untested statement would train people to ignore this.
    const found = unkeepablePromises(contract({ columns: { only: ['day'], never: ['x'] } }), [])
    expect(found).toEqual({ offered: [], guarding: [] })
  })

  it('says nothing where every promise is keepable', () => {
    const found = unkeepablePromises(
      contract({ columns: { only: ['day'], never: ['device_id'] }, order_by: ['day'] }),
      ['day', 'device_id', 'events'],
    )
    expect(found).toEqual({ offered: [], guarding: [] })
  })
})

describe('quoting a list of column names', () => {
  it('backticks each one, because they are identifiers in a sentence', () => {
    expect(quoted(['day', 'p95'])).toBe('`day`, `p95`')
    expect(quoted(['day'])).toBe('`day`')
    expect(quoted([])).toBe('')
  })
})
