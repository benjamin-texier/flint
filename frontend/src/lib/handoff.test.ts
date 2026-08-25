import { describe, expect, it } from 'vitest'
import { DESTINATIONS, handoffPath, readHandoff, suggestName } from './handoff'

describe('handoffPath', () => {
  it('carries the statement to each destination', () => {
    const handoff = { sql: 'SELECT 1', database: 'analytics', name: 'Ones' }
    expect(handoffPath('alert', handoff)).toBe(
      '/alerts?sql=SELECT+1&database=analytics&name=Ones',
    )
    expect(handoffPath('report', handoff)).toContain('/reports?')
    expect(handoffPath('api', handoff)).toContain('/apis?')
  })

  it('encodes a statement that would otherwise break the URL', () => {
    const path = handoffPath('alert', {
      sql: "SELECT * FROM t WHERE s = 'a&b' AND x = {p:String}",
      database: '',
      name: '',
    })
    // Round trips through the parser the page will use.
    const params = new URLSearchParams(path.split('?')[1])
    expect(params.get('sql')).toBe("SELECT * FROM t WHERE s = 'a&b' AND x = {p:String}")
  })

  it('omits what it does not have', () => {
    const path = handoffPath('api', { sql: 'SELECT 1', database: '', name: '' })
    expect(path).toBe('/apis?sql=SELECT+1')
  })

  it('has a path for every destination it offers', () => {
    for (const d of DESTINATIONS) {
      expect(handoffPath(d.id, { sql: 'x', database: '', name: '' })).toContain(d.path)
    }
  })
})

describe('readHandoff', () => {
  it('reads back what the editor sent', () => {
    const path = handoffPath('alert', {
      sql: 'SELECT count() FROM events',
      database: 'analytics',
      name: 'Events',
    })
    const handoff = readHandoff(new URLSearchParams(path.split('?')[1]))
    expect(handoff).toEqual({
      sql: 'SELECT count() FROM events',
      database: 'analytics',
      name: 'Events',
    })
  })

  it('is null for an ordinary visit', () => {
    expect(readHandoff(new URLSearchParams(''))).toBeNull()
    expect(readHandoff(new URLSearchParams('sql='))).toBeNull()
    expect(readHandoff(new URLSearchParams('sql=%20%20'))).toBeNull()
    expect(readHandoff(new URLSearchParams('database=analytics'))).toBeNull()
  })

  it('accepts a statement with nothing else', () => {
    expect(readHandoff(new URLSearchParams('sql=SELECT+1'))).toEqual({
      sql: 'SELECT 1',
      database: '',
      name: '',
    })
  })
})

describe('suggestName', () => {
  it('uses the tab title when it is a real one', () => {
    expect(suggestName({ sql: 'x', database: '', name: 'Daily errors' }, 'New alert')).toBe(
      'Daily errors',
    )
  })

  it('falls back rather than naming something "Untitled"', () => {
    expect(suggestName({ sql: 'x', database: '', name: 'Untitled' }, 'New alert')).toBe('New alert')
    expect(suggestName({ sql: 'x', database: '', name: '  ' }, 'New alert')).toBe('New alert')
  })
})
