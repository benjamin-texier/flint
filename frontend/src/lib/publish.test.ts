import { describe, expect, it } from 'vitest'
import {
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
  id: 'i',
  name: 'By city',
  slug: 'by-city',
  sql: 'SELECT city FROM events WHERE city = {city:String}',
  database: 'analytics',
  defaults: '{}',
  token: 'tok',
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
    const example = curlExample(endpoint(), 'http://flint.local')
    expect(example).toContain('X-Flint-Token: tok')
    expect(example).not.toContain('token=tok')
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
    const example = curlFor(endpoint(), 'http://x', call({ limit: 10 }))
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
    const cell = snippet('sheets', endpoint(), 'http://x', call())
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
