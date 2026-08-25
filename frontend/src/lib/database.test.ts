import { describe, expect, it } from 'vitest'

import { objectCount, orderDatabases, resolveDatabase } from './database'

/** A database with a size, as the API hands them over. */
function db(name: string, tables = 0, views = 0) {
  return { name, tables, views }
}

describe('objectCount', () => {
  it('adds up everything Flint can open', () => {
    expect(
      objectCount({ tables: 3, views: 2, materialized_views: 1, dictionaries: 1 }),
    ).toBe(7)
  })

  it('reads a missing count as none', () => {
    expect(objectCount({})).toBe(0)
    expect(objectCount({ tables: 4 })).toBe(4)
  })
})

describe('resolveDatabase', () => {
  const server = [
    db('INFORMATION_SCHEMA', 0, 10),
    db('analytics', 40),
    db('default', 170),
    db('information_schema', 0, 10),
    db('reference', 3),
    db('system', 129),
  ]

  it('prefers the database you were last looking at', () => {
    expect(resolveDatabase(server, 'reference')).toBe('reference')
  })

  it('will happily remember an internal database if that is where you were', () => {
    expect(resolveDatabase(server, 'system')).toBe('system')
  })

  it('ignores a remembered database that no longer exists', () => {
    expect(resolveDatabase(server, 'deleted')).toBe('default')
  })

  it('opens on the fullest database that is yours', () => {
    expect(resolveDatabase(server, null)).toBe('default')
  })

  it('never opens on an empty database when a full one exists', () => {
    // The bug this replaces: `nemo` sorted first among "yours" and won, so a
    // server whose 170 objects all live in `default` opened on a blank rail.
    const list = [db('nemo'), db('smart_control'), db('default', 67, 103)]
    expect(resolveDatabase(list, null)).toBe('default')
  })

  it('falls back to ClickHouse own databases when nothing else has anything', () => {
    expect(resolveDatabase([db('nemo'), db('system', 129)], null)).toBe('system')
  })

  it('opens on an empty database only when every database is empty', () => {
    expect(resolveDatabase([db('nemo'), db('zeta')], null)).toBe('nemo')
  })

  it('returns nothing for a server with no databases', () => {
    expect(resolveDatabase([], null)).toBeUndefined()
  })
})

describe('orderDatabases', () => {
  it('puts your databases first, the fullest of them leading', () => {
    const list = [db('system', 129), db('reference', 3), db('default', 67), db('analytics', 40)]
    expect(orderDatabases(list).map((d) => d.name)).toEqual([
      'default',
      'analytics',
      'reference',
      'system',
    ])
  })

  it('sorts by name when two databases hold the same amount', () => {
    const list = [db('reference', 3), db('analytics', 3)]
    expect(orderDatabases(list).map((d) => d.name)).toEqual(['analytics', 'reference'])
  })

  it('treats default as yours, not as ClickHouse plumbing', () => {
    const list = [db('system', 500), db('default', 1)]
    expect(orderDatabases(list).map((d) => d.name)).toEqual(['default', 'system'])
  })

  it('never demotes the database being viewed', () => {
    const list = [db('zeta', 5), db('system', 1), db('information_schema', 0, 10)]
    expect(orderDatabases(list).map((d) => d.name)).toEqual([
      'zeta',
      'information_schema',
      'system',
    ])
    // Viewing `system` lifts it out of the plumbing group, above the larger
    // `information_schema` it would otherwise sit below.
    expect(orderDatabases(list, 'system').map((d) => d.name)).toEqual([
      'zeta',
      'system',
      'information_schema',
    ])
  })

  it('leaves the input untouched', () => {
    const input = [db('system'), db('analytics')]
    orderDatabases(input)
    expect(input.map((d) => d.name)).toEqual(['system', 'analytics'])
  })
})
