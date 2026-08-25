import { describe, expect, it } from 'vitest'

import { splitStatements, statementAt, tableInStatement } from './sql'

describe('splitStatements', () => {
  it('splits on top-level semicolons', () => {
    const parts = splitStatements('SELECT 1; SELECT 2')
    expect(parts.map((s) => s.sql.trim())).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('drops empty statements from stray semicolons', () => {
    expect(splitStatements(';;SELECT 1;;').map((s) => s.sql.trim())).toEqual(['SELECT 1'])
  })

  it('ignores a semicolon inside a string literal', () => {
    const parts = splitStatements("SELECT 'a;b' AS x; SELECT 2")
    expect(parts).toHaveLength(2)
    expect(parts[0]!.sql.trim()).toBe("SELECT 'a;b' AS x")
  })

  it('ignores a semicolon inside a backtick-quoted identifier', () => {
    const parts = splitStatements('SELECT `weird;name` FROM t; SELECT 2')
    expect(parts).toHaveLength(2)
  })

  it('ignores a semicolon inside a line comment', () => {
    const parts = splitStatements('SELECT 1 -- trailing ; comment\n; SELECT 2')
    expect(parts).toHaveLength(2)
    expect(parts[0]!.sql).toContain('-- trailing ; comment')
  })

  it('ignores a semicolon inside a block comment', () => {
    expect(splitStatements('SELECT /* a ; b */ 1')).toHaveLength(1)
  })

  it('handles a doubled quote as an escape', () => {
    const parts = splitStatements("SELECT 'it''s; fine' AS x")
    expect(parts).toHaveLength(1)
  })

  it('handles a backslash escape before a quote', () => {
    expect(splitStatements("SELECT 'a\\'; b' AS x")).toHaveLength(1)
  })

  it('does not run off the end of an unterminated string', () => {
    expect(splitStatements("SELECT 'unclosed")).toHaveLength(1)
  })

  it('reports offsets that map back onto the source', () => {
    const text = 'SELECT 1;\nSELECT 2'
    const parts = splitStatements(text)
    expect(text.slice(parts[1]!.start, parts[1]!.end).trim()).toBe('SELECT 2')
  })
})

describe('statementAt', () => {
  const text = 'SELECT 1;\nSELECT 2;\nSELECT 3'

  it('finds the statement containing the caret', () => {
    expect(statementAt(text, 3)?.sql.trim()).toBe('SELECT 1')
    expect(statementAt(text, 14)?.sql.trim()).toBe('SELECT 2')
    expect(statementAt(text, text.length)?.sql.trim()).toBe('SELECT 3')
  })

  it('picks the statement the caret trails, not the next one', () => {
    // Caret sitting just after `SELECT 1;` belongs to the second statement.
    expect(statementAt(text, 10)?.sql.trim()).toBe('SELECT 2')
  })

  it('returns null for an empty buffer', () => {
    expect(statementAt('   ', 0)).toBeNull()
  })
})

describe('tableInStatement', () => {
  it('finds an unqualified table', () => {
    expect(tableInStatement('SELECT * FROM events WHERE x = 1')).toEqual({ table: 'events' })
  })

  it('splits a qualified table', () => {
    expect(tableInStatement('SELECT * FROM analytics.events')).toEqual({
      database: 'analytics',
      table: 'events',
    })
  })

  it('handles backticks and whitespace around the dot', () => {
    expect(tableInStatement('SELECT * FROM `my db`.`odd`')).toEqual({
      database: 'my db',
      table: 'odd',
    })
    expect(tableInStatement('SELECT * FROM a . b')).toEqual({ database: 'a', table: 'b' })
  })

  it('falls back to a JOIN when there is no FROM', () => {
    expect(tableInStatement('SELECT 1 JOIN sessions ON x')).toEqual({ table: 'sessions' })
  })

  it('ignores a FROM inside a comment or string', () => {
    expect(tableInStatement("SELECT 'FROM fake' AS x FROM real")).toEqual({ table: 'real' })
    expect(tableInStatement('-- FROM fake\nSELECT * FROM real')).toEqual({ table: 'real' })
    expect(tableInStatement('/* FROM fake */ SELECT * FROM real')).toEqual({ table: 'real' })
  })

  it('returns null when nothing is selected from', () => {
    expect(tableInStatement('SELECT 1')).toBeNull()
  })
})
