import { describe, expect, it } from 'vitest'
import { buildEntries, search, type Entry } from './palette'

/** Distinct routes, as real tables have: two tables are never the same
 *  destination, and the fixture must not pretend otherwise. */
const table = (label: string, context = 'analytics'): Entry => ({
  kind: 'table',
  label,
  context,
  to: `/db/${context}/${label}`,
})

describe('search', () => {
  it('shows nothing before you type', () => {
    // A palette that lists everything on open is a list, not a search.
    expect(search([table('events')], '')).toEqual([])
    expect(search([table('events')], '   ')).toEqual([])
  })

  it('puts an exact name first', () => {
    const hits = search([table('events_by_region'), table('events')], 'events')
    expect(hits[0]!.label).toBe('events')
  })

  it('prefers a prefix over a word boundary over a substring', () => {
    const hits = search(
      [table('my_events_raw'), table('raw.events'), table('events_raw')],
      'events',
    )
    expect(hits.map((h) => h.label)).toEqual(['events_raw', 'raw.events', 'my_events_raw'])
  })

  it('finds a name after a separator, which is how qualified names read', () => {
    expect(search([table('analytics.events')], 'events')).toHaveLength(1)
    expect(search([table('raw_events')], 'events')).toHaveLength(1)
  })

  it('ranks a table above one of its own columns', () => {
    // Someone typing `events` almost always wants the table.
    const hits = search(
      [{ kind: 'column', label: 'events', context: 'a.b', to: '/y' }, table('events')],
      'events',
    )
    expect(hits[0]!.kind).toBe('table')
  })

  it('puts every object above every column, whatever the match quality', () => {
    // The real case: seven columns named `events` used to bury the view
    // `events_by_region`, because an exact match outscored a prefix one.
    const hits = search(
      [
        { kind: 'column', label: 'events', context: 'a.rollup', to: '/rollup' },
        { kind: 'column', label: 'events', context: 'a.daily', to: '/daily' },
        { kind: 'view', label: 'events_by_region', context: 'a', to: '/view' },
      ],
      'events',
    )
    expect(hits[0]!.kind).toBe('view')
    expect(hits.slice(1).every((h) => h.kind === 'column')).toBe(true)
  })

  it('collapses a table and its own matching column into one row', () => {
    // Same destination, same suggestion: showing it twice is noise.
    const hits = search(
      [
        table('events'),
        {
          kind: 'column',
          label: 'events',
          context: 'analytics.events',
          to: '/db/analytics/events',
        },
      ],
      'events',
    )
    expect(hits).toHaveLength(1)
    expect(hits[0]!.kind).toBe('table')
  })

  it('keeps one row per table when several of its columns match', () => {
    const hits = search(
      [
        { kind: 'column', label: 'event_id', context: 'a.t', to: '/t' },
        { kind: 'column', label: 'event_time', context: 'a.t', to: '/t' },
      ],
      'event',
    )
    expect(hits).toHaveLength(1)
  })

  it('breaks ties towards the shorter name', () => {
    const hits = search([table('device_daily_rollup'), table('device')], 'device')
    expect(hits[0]!.label).toBe('device')
  })

  it('does not match the context, only the label', () => {
    // Otherwise every column of `events` is a hit for "events".
    expect(
      search([{ kind: 'column', label: 'id', context: 'analytics.events', to: '/t' }], 'events'),
    ).toEqual([])
  })

  it('is case insensitive both ways', () => {
    expect(search([table('Events')], 'events')).toHaveLength(1)
    expect(search([table('events')], 'EVENTS')).toHaveLength(1)
  })

  it('caps what it returns', () => {
    const many = Array.from({ length: 200 }, (_, i) => table(`events_${i}`))
    expect(search(many, 'events', 10)).toHaveLength(10)
  })

  it('is deterministic for equal scores', () => {
    const a = search([table('beta'), table('alpha')], 'a')
    const b = search([table('alpha'), table('beta')], 'a')
    expect(a.map((h) => h.label)).toEqual(b.map((h) => h.label))
  })
})

describe('buildEntries', () => {
  const schema = [
    { database: 'analytics', table: 'events', columns: ['id', 'city'] },
    { database: 'analytics', table: 'devices', columns: ['id'] },
    { database: 'system', table: 'columns', columns: ['name', 'type'] },
  ]

  it('leaves ClickHouse its own databases out', () => {
    // `system` alone holds thousands of columns; a search for `name` that
    // returns forty of them has buried the answer.
    const labels = buildEntries({ schema }).map((e) => e.label)
    expect(labels).not.toContain('columns')
    expect(labels).toContain('events')
  })

  it('lists each database once', () => {
    const dbs = buildEntries({ schema }).filter((e) => e.kind === 'database')
    expect(dbs.map((d) => d.label)).toEqual(['analytics'])
  })

  it('gives a table a route to itself and a column the route to its table', () => {
    const entries = buildEntries({ schema })
    const t = entries.find((e) => e.kind === 'table' && e.label === 'events')!
    const c = entries.find((e) => e.kind === 'column' && e.label === 'city')!
    expect(t.to).toBe('/db/analytics/events')
    expect(c.to).toBe(t.to)
    expect(c.context).toBe('analytics.events')
  })

  it('calls a view a view, and a materialized view one too', () => {
    const entries = buildEntries({
      schema: [
        { database: 'a', table: 'plain', columns: [], kind: 'table' },
        { database: 'a', table: 'looks', columns: [], kind: 'view' },
        { database: 'a', table: 'rolls', columns: [], kind: 'materialized_view' },
        { database: 'a', table: 'unknown', columns: [] },
      ],
    })
    const kindOf = (label: string) => entries.find((e) => e.label === label)!.kind
    expect(kindOf('plain')).toBe('table')
    expect(kindOf('looks')).toBe('view')
    expect(kindOf('rolls')).toBe('view')
    // Nothing said: a table is the safe assumption and the common case.
    expect(kindOf('unknown')).toBe('table')
  })

  it('carries a saved query straight into the editor', () => {
    const entries = buildEntries({
      saved: [{ id: 'i', name: 'Daily', sql: 'SELECT 1', database: 'analytics' }],
    })
    const hit = entries.find((e) => e.kind === 'saved')!
    expect(hit.to).toBe('/query?sql=SELECT%201&database=analytics')
  })

  it('names an endpoint by its address', () => {
    const entries = buildEntries({ apis: [{ id: 'i', name: 'By city', slug: 'by-city' }] })
    expect(entries.find((e) => e.kind === 'api')!.context).toBe('/api/data/by-city')
  })

  it('escapes a name that would break a URL', () => {
    const entries = buildEntries({
      schema: [{ database: 'my db', table: 'odd/name', columns: [] }],
    })
    expect(entries.find((e) => e.kind === 'table')!.to).toBe('/db/my%20db/odd%2Fname')
  })

  it('always offers the pages, even with nothing loaded', () => {
    expect(buildEntries({}).every((e) => e.kind === 'page')).toBe(true)
    expect(search(buildEntries({}), 'diagnose')[0]!.to).toBe('/diagnose')
  })
})

describe('search deduplication', () => {
  it('keeps every report apart, though they share one route', () => {
    // The trap in deduping by destination: /reports is every report's route.
    const hits = search(
      [
        { kind: 'report', label: 'Monday numbers', to: '/reports' },
        { kind: 'report', label: 'Monday errors', to: '/reports' },
      ],
      'monday',
    )
    expect(hits).toHaveLength(2)
  })

  it('keeps two tables apart, and two databases', () => {
    const hits = search(
      [
        { kind: 'table', label: 'events', context: 'a', to: '/db/a/events' },
        { kind: 'table', label: 'events', context: 'b', to: '/db/b/events' },
        { kind: 'database', label: 'events_db', to: '/db/events_db' },
      ],
      'events',
    )
    expect(hits).toHaveLength(3)
  })
})
