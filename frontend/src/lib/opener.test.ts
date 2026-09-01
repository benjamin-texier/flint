import { describe, expect, it } from 'vitest'

import { openers, serverOpeners } from './opener'

const COLS = [
  { name: 'login', type: 'String' },
  { name: 'kind', type: 'LowCardinality(String)' },
  { name: 'followers', type: 'Int64' },
  { name: 'created_at', type: 'DateTime' },
]

describe('openers', () => {
  it('offers nothing for a table it knows no columns of', () => {
    expect(openers('default', 'actors', [])).toEqual([])
    expect(openers('default', '', COLS)).toEqual([])
  })

  it('always offers the count and a look at the rows', () => {
    const ids = openers('default', 'actors', COLS).map((o) => o.id)
    expect(ids.slice(0, 2)).toEqual(['rows', 'peek'])
  })

  it('qualifies the table with its database, so the statement travels', () => {
    const [count] = openers('analytics', 'events', COLS)
    expect(count!.sql).toBe('SELECT count() AS rows FROM analytics.events')
  })

  it('quotes a name that needs it', () => {
    const [count] = openers('my db', 'weird-table', COLS)
    expect(count!.sql).toBe('SELECT count() AS rows FROM `my db`.`weird-table`')
  })

  it('leaves the database off when there is none to name', () => {
    const [count] = openers(undefined, 'events', COLS)
    expect(count!.sql).toBe('SELECT count() AS rows FROM events')
  })

  /* The wording rule, asserted rather than trusted: LIMIT with no ORDER BY is
     not a prefix, and this is the one offer that could imply it is. */
  it('never calls an unordered limit "the first" rows', () => {
    const peek = openers('default', 'actors', COLS)[1]!
    expect(peek.sql).not.toMatch(/ORDER BY/)
    expect(`${peek.title} ${peek.note}`.toLowerCase()).not.toContain('first ')
    expect(peek.note).toContain('whichever the server reaches first')
  })

  it('buckets by the temporal column the table is sorted by', () => {
    const cols = [
      { name: 'seen_at', type: 'DateTime' },
      { name: 'event_time', type: 'DateTime64(3)' },
      { name: 'host', type: 'LowCardinality(String)' },
    ]
    const over = openers('logs', 'access', cols, ['event_time'])!.find((o) => o.id === 'over-time')!
    expect(over.title).toContain('event_time')
    expect(over.sql).toContain('toStartOfHour(event_time)')
    expect(over.note).toContain('reads a slice')
  })

  it('says so when the only timestamp is not in the sorting key', () => {
    const over = openers('default', 'actors', COLS)!.find((o) => o.id === 'over-time')!
    expect(over.note).toContain('not in the sorting key')
  })

  it('offers no hour bucket on a table with no time in it', () => {
    const cols = [
      { name: 'a', type: 'Float64' },
      { name: 'b', type: 'Int32' },
    ]
    expect(openers('default', 'm', cols).map((o) => o.id)).toEqual(['rows', 'peek'])
  })

  it('prefers a LowCardinality column to group by', () => {
    const by = openers('default', 'actors', COLS)!.find((o) => o.id === 'commonest')!
    expect(by.title).toBe('The commonest kind')
    expect(by.sql).toContain('GROUP BY kind')
  })

  it('falls back to a plain String when nothing repeats by type', () => {
    const cols = [
      { name: 'followers', type: 'Int64' },
      { name: 'login', type: 'Nullable(String)' },
    ]
    const by = openers('default', 'actors', cols)!.find((o) => o.id === 'commonest')!
    expect(by.title).toBe('The commonest login')
  })

  it('offers no grouping on a table of numbers', () => {
    const cols = [{ name: 'v', type: 'Float64' }]
    expect(openers('default', 'm', cols).map((o) => o.id)).toEqual(['rows', 'peek'])
  })

  it('never offers a hour bucket and a grouping it cannot address', () => {
    // Both offers name a column, so both have to be quoted the same way the
    // count is.
    const weird = [
      { name: 'seen at', type: 'DateTime' },
      { name: 'host name', type: 'LowCardinality(String)' },
    ]
    const all = openers('db', 't', weird, ['seen at'])
    expect(all.find((o) => o.id === 'over-time')!.sql).toContain('toStartOfHour(`seen at`)')
    expect(all.find((o) => o.id === 'commonest')!.sql).toContain('GROUP BY `host name`')
  })

  it('gives every offer a distinct id, so a list of them can be keyed', () => {
    const ids = openers('default', 'actors', COLS).map((o) => o.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('serverOpeners', () => {
  it('offers two statements that need no table', () => {
    expect(serverOpeners('default').map((o) => o.id)).toEqual(['objects', 'running'])
  })

  it('scopes the object list to the database, as a bound-safe literal', () => {
    const [objects] = serverOpeners("o'brien")
    expect(objects!.title).toBe("What is in o'brien")
    expect(objects!.sql).toContain("WHERE database = 'o\\'brien'")
  })

  it('leaves ClickHouse’s own databases out when no database is named', () => {
    const [objects] = serverOpeners(undefined)
    expect(objects!.title).toBe('What is')
    expect(objects!.sql).toContain("database NOT IN ('system'")
  })

  /* Every offer runs on click, so every offer has to be a statement — not a
     fragment, and not something that needs a subject filled in. */
  it('offers only complete SELECTs', () => {
    for (const o of serverOpeners('default')) {
      expect(o.sql).toMatch(/^SELECT /)
      expect(o.sql).not.toContain('undefined')
    }
  })
})
