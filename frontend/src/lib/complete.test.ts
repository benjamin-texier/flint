import { describe, expect, it } from 'vitest'

import type { SchemaEntry } from './api'
import { best, candidates, contextAt, type Source } from './complete'

const SCHEMA: SchemaEntry[] = [
  {
    database: 'default',
    table: 'logs',
    columns: ['ts', 'host', 'ms', 'body'],
    types: ['DateTime', 'LowCardinality(String)', 'UInt32', 'String'],
    kind: 'table',
  },
  {
    database: 'default',
    table: 'users',
    columns: ['id', 'name'],
    types: ['UInt64', 'String'],
    kind: 'table',
  },
  {
    database: 'system',
    table: 'parts',
    columns: ['table', 'rows'],
    types: ['String', 'UInt64'],
    kind: 'table',
  },
]

const source: Source = { schema: SCHEMA, database: 'default' }

/** Everything offered at the end of `doc`, best first. */
function offered(doc: string): string[] {
  return candidates(contextAt(doc, doc.length), source).map((c) => c.label)
}

function taken(doc: string): string | null {
  return best(doc, doc.length, source)?.label ?? null
}

describe('where the caret is', () => {
  it('reads the slot from the clause it sits in', () => {
    expect(contextAt('', 0).slot).toBe('statement')
    expect(contextAt('SELECT ', 7).slot).toBe('select')
    expect(contextAt('SELECT * FROM ', 14).slot).toBe('from')
    expect(contextAt('SELECT * FROM logs WHERE ', 25).slot).toBe('where')
    expect(contextAt('SELECT * FROM logs GROUP BY ', 28).slot).toBe('groupBy')
    expect(contextAt('SELECT * FROM logs ORDER BY ', 28).slot).toBe('orderBy')
    expect(contextAt('SELECT * FROM logs LIMIT ', 25).slot).toBe('limit')
  })

  it('starts fresh after a semicolon', () => {
    const doc = 'SELECT 1;\n'
    expect(contextAt(doc, doc.length).slot).toBe('statement')
  })

  it('reads the word under the caret and any qualifier', () => {
    const ctx = contextAt('SELECT logs.ho', 14)
    expect(ctx.word.text).toBe('ho')
    expect(ctx.qualifier).toBe('logs')
  })

  it('knows the table and the clauses already written', () => {
    const ctx = contextAt('SELECT * FROM system.parts WHERE rows > 0 LIMIT 10', 50)
    expect(ctx.from).toEqual({ database: 'system', table: 'parts' })
    expect(ctx.present).toEqual(['select', 'from', 'where', 'limit'])
  })
})

describe('this table, not every table', () => {
  it('offers the columns of the FROM target and nobody else’s', () => {
    const list = offered('SELECT * FROM logs WHERE ')
    expect(list.slice(0, 4)).toEqual(['body', 'host', 'ms', 'ts'])
    expect(list).not.toContain('id')
    expect(list).not.toContain('rows')
  })

  it('follows a qualified name into the right table', () => {
    expect(offered('SELECT logs.')).toEqual(expect.arrayContaining(['ts', 'host', 'ms', 'body']))
    expect(offered('SELECT * FROM system.')).toContain('parts')
    expect(offered('SELECT logs.')).not.toContain('id')
  })

  it('carries the type along, which is how a schema gets learnt', () => {
    const list = candidates(contextAt('SELECT * FROM logs WHERE ', 25), source)
    const ts = list.find((c) => c.label === 'ts')
    expect(ts?.detail).toBe('DateTime')
  })

  it('offers tables where a table belongs', () => {
    const list = offered('SELECT * FROM ')
    expect(list.slice(0, 2)).toEqual(['logs', 'users'])
    expect(list).toContain('system')
  })

  it('says nothing about columns when there is no table yet', () => {
    const list = offered('SELECT ')
    expect(list).not.toContain('ts')
    expect(list).toContain('count()')
  })
})

describe('keywords, when they are the useful answer', () => {
  it('completes GROUP to GROUP BY', () => {
    expect(taken('SELECT * FROM logs GROUP')).toBe('GROUP BY')
    expect(taken('SELECT * FROM logs ORD')).toBe('ORDER BY')
  })

  it('offers the clauses this statement has not got, next one first', () => {
    const list = offered('SELECT * FROM logs ')
    expect(list[0]).toBe('PREWHERE')
    expect(list).toEqual(expect.arrayContaining(['WHERE', 'GROUP BY', 'ORDER BY', 'LIMIT']))
  })

  it('never offers a clause twice', () => {
    expect(offered('SELECT * FROM logs WHERE ms > 1 ')).not.toContain('WHERE')
    expect(offered('SELECT * FROM logs WHERE ms > 1 ')).toContain('ORDER BY')
  })

  it('offers HAVING only once there is a GROUP BY to have it', () => {
    expect(offered('SELECT * FROM logs WHERE ms > 1 ')).not.toContain('HAVING')
    expect(offered('SELECT host, count() FROM logs GROUP BY host ')).toContain('HAVING')
  })

  it('offers FROM from inside an unfinished select list', () => {
    expect(offered('SELECT ts, host ')).toContain('FROM')
  })

  it('offers a direction after an ORDER BY term', () => {
    expect(taken('SELECT * FROM logs ORDER BY ts ')).toBe('DESC')
  })

  it('offers an operator after a column in a WHERE', () => {
    expect(offered('SELECT * FROM logs WHERE host ')).toEqual(
      expect.arrayContaining(['=', '!=', 'IN (…)', 'LIKE', 'IS NULL']),
    )
  })

  it('offers a window back from now on a timestamp, and only on a timestamp', () => {
    expect(taken('SELECT * FROM logs WHERE ts ')).toBe('>= now() - INTERVAL 1 HOUR')
    expect(taken('SELECT * FROM logs WHERE host ')).toBe('=')
  })

  it('offers a connector once the predicate is complete, not another operator', () => {
    expect(taken("SELECT * FROM logs WHERE host = 'a' ")).toBe('AND')
    expect(offered("SELECT * FROM logs WHERE host = 'a' ")).not.toContain('=')
    expect(taken('SELECT * FROM logs WHERE ms > 10 ')).toBe('AND')
    expect(taken('SELECT * FROM logs WHERE body IS NULL ')).toBe('AND')
    expect(taken('SELECT * FROM logs WHERE ts >= now() - INTERVAL 3 HOUR ')).toBe('AND')
  })

  it('reads a comma as another item, not as the end of one', () => {
    const list = offered('SELECT * FROM logs GROUP BY host, ')
    expect(list.slice(0, 4)).toEqual(['body', 'host', 'ms', 'ts'])
  })
})

describe('where there is nothing to complete', () => {
  it('says nothing inside a string literal', () => {
    const doc = "SELECT * FROM logs WHERE host = 'my host "
    expect(contextAt(doc, doc.length).slot).toBe('quiet')
    expect(offered(doc)).toEqual([])
  })

  it('speaks again once the string is closed', () => {
    const doc = "SELECT * FROM logs WHERE host = 'a' "
    expect(contextAt(doc, doc.length).slot).toBe('where')
  })

  it('says nothing inside a comment', () => {
    expect(offered('SELECT * FROM logs -- why not ')).toEqual([])
    expect(offered('SELECT * FROM logs /* a note ')).toEqual([])
  })

  it('speaks again on the line after a line comment', () => {
    expect(contextAt('SELECT * FROM logs -- why\n', 26).slot).not.toBe('quiet')
  })
})

describe('the empty tab', () => {
  it('offers whole shapes of query first', () => {
    const list = offered('')
    expect(list.slice(0, 3)).toEqual([
      'SELECT * FROM …',
      'SELECT count() FROM …',
      'top values by count',
    ])
  })

  it('marks them as snippets so the caret lands where the table goes', () => {
    const opener = candidates(contextAt('', 0), source)[0]!
    expect(opener.snippet).toBe(true)
    expect(opener.insert).toContain('#{table}')
  })
})

describe('the select list’s own names', () => {
  it('offers an alias to the ORDER BY that has to name it', () => {
    const list = offered('SELECT host, count() AS n FROM logs GROUP BY host ORDER BY ')
    expect(list[0]).toBe('n')
  })

  it('offers it to a HAVING too', () => {
    expect(offered('SELECT host, count() AS n FROM logs GROUP BY host HAVING ')[0]).toBe('n')
  })
})

describe('what gets inserted', () => {
  it('backticks a column that needs it', () => {
    const odd: Source = {
      database: 'default',
      schema: [{ database: 'default', table: 't', columns: ['odd name'], types: ['String'], kind: 'table' }],
    }
    const list = candidates(contextAt('SELECT * FROM t WHERE ', 22), odd)
    expect(list.find((c) => c.label === 'odd name')?.insert).toBe('`odd name`')
  })

  it('leaves a clause keyword with the space that follows it', () => {
    const where = candidates(contextAt('SELECT * FROM logs ', 19), source).find(
      (c) => c.label === 'WHERE',
    )
    expect(where?.insert).toBe('WHERE ')
  })
})
