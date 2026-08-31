import { describe, expect, it } from 'vitest'

import {
  announce,
  applySettings,
  blame,
  asText,
  asTsv,
  clampHeight,
  HISTORY_CAP,
  describeSettings,
  parseMeta,
  parseSet,
  print,
  recall,
  remember,
  splitError,
  splitStatements,
  summarise,
  databaseInPath,
  type Entry,
} from './console'
import type { QueryResult } from './api'

const cols = (...pairs: [string, string][]) => pairs.map(([name, type]) => ({ name, type }))

describe('parseMeta', () => {
  it('answers the console words itself', () => {
    expect(parseMeta('help')).toEqual({ kind: 'help' })
    expect(parseMeta('  CLEAR ; ')).toEqual({ kind: 'clear' })
    expect(parseMeta('\\q')).toEqual({ kind: 'hide' })
  })

  it('takes USE in the three spellings ClickHouse takes', () => {
    expect(parseMeta('use analytics')).toEqual({ kind: 'use', database: 'analytics' })
    expect(parseMeta('USE `my db`;')).toEqual({ kind: 'use', database: 'my db' })
    expect(parseMeta('use "odd-name"')).toEqual({ kind: 'use', database: 'odd-name' })
  })

  it('leaves SQL alone, including SQL that merely mentions the words', () => {
    expect(parseMeta('SELECT 1')).toBeNull()
    expect(parseMeta("SELECT 'help'")).toBeNull()
    // The trap: a column called `use`, or a USE buried in a longer statement.
    expect(parseMeta('SELECT use FROM t')).toBeNull()
    expect(parseMeta('use analytics; SELECT 1')).toBeNull()
  })
})

describe('print', () => {
  it('sets each column to the widest thing in it', () => {
    const p = print(cols(['name', 'String'], ['n', 'UInt64']), [
      ['hits', 12],
      ['a much longer one', 3],
    ])
    expect(p.widths).toEqual(['a much longer one'.length, 2])
  })

  it('right-aligns numbers and puts their header dashes in front', () => {
    const p = print(cols(['n', 'UInt64']), [[7], [1234]])
    expect(p.body[0]![0]!.text).toBe('   7')
    expect(p.body[1]![0]!.text).toBe('1234')
    // `───n─` — the name ends over the last digit.
    expect(p.head[0]!.before).toBe('────')
    expect(p.head[0]!.after).toBe('─')
  })

  it('left-aligns everything else', () => {
    const p = print(cols(['s', 'String']), [['ab'], ['abcd']])
    expect(p.body[0]![0]!.text).toBe('ab  ')
    expect(p.head[0]!.before).toBe('─')
  })

  it('keeps NULL and the empty string distinguishable', () => {
    const p = print(cols(['s', 'Nullable(String)']), [[null], ['']])
    expect(p.body[0]![0]!.kind).toBe('null')
    expect(p.body[0]![0]!.text.trim()).toBe('NULL')
    expect(p.body[1]![0]!.kind).toBe('empty')
    expect(p.body[1]![0]!.text.trim()).toBe("''")
  })

  it('caps one enormous cell rather than letting it set the table width', () => {
    const p = print(cols(['blob', 'String']), [['x'.repeat(4000)]])
    expect(p.widths[0]).toBe(60)
    expect(p.body[0]![0]!.text.endsWith('…')).toBe(true)
  })

  it('flattens newlines, so one multi-line value cannot break the box', () => {
    const p = print(cols(['s', 'String']), [['a\nb']])
    expect(p.body[0]![0]!.text).toBe('a⏎b')
  })

  it('rules the bottom to the same widths', () => {
    const p = print(cols(['a', 'String'], ['b', 'String']), [['xx', 'y']])
    expect(p.bottom).toBe('└────┴───┘')
  })

  it('prints a header-only table for an empty result', () => {
    const p = print(cols(['a', 'String']), [])
    expect(p.body).toEqual([])
    expect(p.widths).toEqual([1])
  })
})

describe('asText / asTsv', () => {
  it('renders the same box that is on screen', () => {
    const p = print(cols(['a', 'String'], ['n', 'UInt8']), [['x', 1]])
    expect(asText(p)).toBe(['┌─a─┬─n─┐', '│ x │ 1 │', '└───┴───┘'].join('\n'))
  })

  it('gives a spreadsheet a blank for NULL, not the word', () => {
    expect(asTsv(cols(['a', 'String'], ['b', 'String']), [['x', null]])).toBe('a\tb\nx\t')
  })
})

function result(over: Partial<QueryResult> = {}): QueryResult {
  return {
    query_id: 'q',
    columns: [{ name: 'a', type: 'UInt8' }],
    rows: [[1]],
    truncated: false,
    rows_before_limit_at_least: null,
    statistics: { elapsed: 0.012, rows_read: 100, bytes_read: 2048 },
    summary: {
      read_rows: 100,
      read_bytes: 2048,
      written_rows: 0,
      result_rows: 1,
      result_bytes: 1,
      elapsed_ns: 12_000_000,
    },
    kind: 'read',
    ...over,
  }
}

describe('summarise', () => {
  it('counts the rows and what they cost', () => {
    expect(summarise(result()).line).toBe('1 row in set · 12 ms · read 100 rows, 2.0 KiB')
  })

  it('says Ok for a statement that returns nothing', () => {
    const s = summarise(result({ kind: 'command', rows: [], columns: [] }))
    expect(s.line.startsWith('Ok.')).toBe(true)
    expect(s.capped).toBeNull()
  })

  it('states the cap against the floor the server gave', () => {
    const s = summarise(
      result({ rows: [[1], [2]], truncated: true, rows_before_limit_at_least: 900 }),
    )
    expect(s.capped).toContain('2 of at least 900')
  })

  it('still states the cap when the server gave no floor', () => {
    const s = summarise(result({ truncated: true }))
    expect(s.capped).toContain('the first 1')
  })

  it('drops the read figures rather than printing zeroes', () => {
    const s = summarise(result({ statistics: { elapsed: 0.5, rows_read: 0, bytes_read: 0 } }))
    expect(s.line).toBe('1 row in set · 500 ms')
  })
})

describe('history', () => {
  it('appends, newest last', () => {
    expect(remember(['a'], 'b')).toEqual(['a', 'b'])
  })

  it('does not repeat the statement just run', () => {
    expect(remember(['a', 'b'], ' b ')).toEqual(['a', 'b'])
  })

  it('ignores blank lines', () => {
    expect(remember(['a'], '   ')).toEqual(['a'])
  })

  it('forgets the oldest past the cap', () => {
    const long = Array.from({ length: HISTORY_CAP }, (_, i) => `q${i}`)
    const next = remember(long, 'new')
    expect(next.length).toBe(HISTORY_CAP)
    expect(next[0]).toBe('q1')
    expect(next[HISTORY_CAP - 1]).toBe('new')
  })

  it('walks back from the newest', () => {
    const h = ['a', 'b', 'c']
    expect(recall(h, null, -1)).toEqual({ index: 0, sql: 'c' })
    expect(recall(h, 0, -1)).toEqual({ index: 1, sql: 'b' })
    expect(recall(h, 1, -1)).toEqual({ index: 2, sql: 'a' })
  })

  it('stops at the oldest instead of wrapping', () => {
    expect(recall(['a', 'b', 'c'], 2, -1)).toEqual({ index: 2, sql: 'a' })
  })

  it('walks back down to the live line', () => {
    expect(recall(['a', 'b'], 0, 1)).toEqual({ index: null, sql: '' })
  })

  it('never wipes a draft with a stray Down', () => {
    expect(recall(['a'], null, 1)).toEqual({ index: null, sql: null })
  })

  it('does nothing at all with no history', () => {
    expect(recall([], null, -1)).toEqual({ index: null, sql: null })
  })
})

describe('clampHeight', () => {
  it('keeps a drag inside something readable', () => {
    expect(clampHeight(20, 1000)).toBe(180)
    expect(clampHeight(5000, 1000)).toBe(850)
    expect(clampHeight(400, 1000)).toBe(400)
  })

  it('leaves room even on a very short window', () => {
    expect(clampHeight(5000, 200)).toBe(220)
  })
})

describe('databaseInPath', () => {
  it('reads the database off a Data page', () => {
    expect(databaseInPath('/db/analytics')).toBe('analytics')
    expect(databaseInPath('/db/analytics/hits')).toBe('analytics')
  })

  it('decodes a name that had to be escaped', () => {
    expect(databaseInPath('/db/my%20db')).toBe('my db')
  })

  it('says nothing for a page that is not about one', () => {
    expect(databaseInPath('/infra/health')).toBeNull()
    expect(databaseInPath('/query')).toBeNull()
    expect(databaseInPath('/')).toBeNull()
  })
})

describe('splitError', () => {
  it('keeps the sentence that says where, and offers the grammar', () => {
    const { head, rest } = splitError(
      "Code: 62. DB::Exception: Syntax error: failed at position 1 ('SELEKT'): SELEKT 1. Expected one of: Query, SHOW, ALTER, … . (SYNTAX_ERROR) (version 26.7.5.10)",
    )
    expect(head).toBe(
      "Code: 62. DB::Exception: Syntax error: failed at position 1 ('SELEKT'): SELEKT 1.",
    )
    expect(rest?.startsWith('Expected one of:')).toBe(true)
  })

  it('leaves an error that is already short alone', () => {
    const { head, rest } = splitError('Code: 60. DB::Exception: Table analytics.nope does not exist.')
    expect(head).toBe('Code: 60. DB::Exception: Table analytics.nope does not exist.')
    expect(rest).toBeNull()
  })

  it('cuts a stack trace too', () => {
    expect(splitError('Boom. Stack trace:\n  0x1').rest).toBe('Stack trace:\n  0x1')
  })

  it('would rather show the wall than nothing', () => {
    const { head, rest } = splitError('Expected one of: a, b, c')
    expect(head).toBe('Expected one of: a, b, c')
    expect(rest).toBeNull()
  })
})

describe('SET', () => {
  it('takes one assignment', () => {
    expect(parseSet('SET max_threads = 4')).toEqual([{ name: 'max_threads', value: '4' }])
  })

  it('takes several, and a quoted value with a comma in it', () => {
    expect(parseSet("set a = 1, b = 'x,y' ;")).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: 'x,y' },
    ])
  })

  it('reads DEFAULT as "stop carrying it"', () => {
    expect(parseSet('SET max_threads = DEFAULT')).toEqual([{ name: 'max_threads', value: null }])
  })

  it('leaves SET ROLE and anything else malformed to the server', () => {
    expect(parseSet('SET ROLE admin')).toBeNull()
    expect(parseSet('SET a = 1, ROLE admin')).toBeNull()
    expect(parseSet('SELECT 1')).toBeNull()
    expect(parseSet('ALTER TABLE t UPDATE x = 1 WHERE 1')).toBeNull()
  })

  it('reaches parseMeta as its own kind', () => {
    expect(parseMeta('SET max_threads = 4')).toEqual({
      kind: 'set',
      changes: [{ name: 'max_threads', value: '4' }],
    })
    expect(parseMeta('set')).toEqual({ kind: 'settings' })
    expect(parseMeta('reset')).toEqual({ kind: 'reset' })
  })
})

describe('applySettings', () => {
  it('adds and replaces', () => {
    expect(applySettings({ a: '1' }, [{ name: 'b', value: '2' }])).toEqual({ a: '1', b: '2' })
    expect(applySettings({ a: '1' }, [{ name: 'a', value: '9' }])).toEqual({ a: '9' })
  })

  it('removes on DEFAULT rather than storing the word', () => {
    expect(applySettings({ a: '1', b: '2' }, [{ name: 'a', value: null }])).toEqual({ b: '2' })
  })

  it('does not mutate what it was given', () => {
    const before = { a: '1' }
    applySettings(before, [{ name: 'a', value: null }])
    expect(before).toEqual({ a: '1' })
  })
})

describe('describeSettings', () => {
  it('says there are none rather than printing an empty list', () => {
    expect(describeSettings({})[0]).toContain('no settings of its own')
  })

  it('says how far they reach, because that is the surprising part', () => {
    const lines = describeSettings({ max_threads: '4' })
    expect(lines[0]).toContain('nowhere else in Flint')
    expect(lines).toContain('  max_threads = 4')
  })
})

describe('splitStatements', () => {
  it('leaves one statement alone, semicolon or not', () => {
    expect(splitStatements('SELECT 1')).toEqual(['SELECT 1'])
    expect(splitStatements('SELECT 1;')).toEqual(['SELECT 1'])
  })

  it('splits a pasted script', () => {
    expect(splitStatements('SELECT 1;\nSELECT 2;\n')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('ignores a semicolon inside a literal', () => {
    expect(splitStatements("SELECT 'a;b'")).toEqual(["SELECT 'a;b'"])
    expect(splitStatements('SELECT `we;ird`')).toEqual(['SELECT `we;ird`'])
  })

  it('ignores one inside a comment', () => {
    expect(splitStatements('SELECT 1 -- a; b\n;SELECT 2')).toEqual(['SELECT 1 -- a; b', 'SELECT 2'])
    expect(splitStatements('SELECT /* a; b */ 1')).toEqual(['SELECT /* a; b */ 1'])
  })

  it('survives an escaped quote', () => {
    expect(splitStatements("SELECT 'it\\'s;fine'")).toEqual(["SELECT 'it\\'s;fine'"])
  })

  it('drops the empty pieces a trailing or doubled semicolon leaves', () => {
    expect(splitStatements(';;SELECT 1;;')).toEqual(['SELECT 1'])
    expect(splitStatements('   ')).toEqual([])
  })
})

describe('announce', () => {
  const at = Date.now()
  const entry = (over: Partial<Entry>): Entry => ({
    id: 'e',
    sql: 'SELECT 1',
    database: 'd',
    at,
    state: 'done',
    ...over,
  })

  it('says nothing before anything has settled', () => {
    expect(announce([])).toBe('')
    expect(announce([entry({ state: 'running' })])).toBe('')
  })

  it('announces a result, and the cap with it', () => {
    const said = announce([entry({ result: result({ truncated: true }) })])
    expect(said).toContain('1 row in set')
    expect(said).toContain('the first 1')
  })

  it('announces a failure — the head of it, not the grammar', () => {
    const said = announce([
      entry({ state: 'error', error: 'Syntax error at position 1. Expected one of: a, b, c' }),
    ])
    expect(said).toBe('Syntax error at position 1.')
  })

  it('announces a cancellation', () => {
    expect(announce([entry({ state: 'cancelled' })])).toBe('Cancelled.')
  })

  it("announces the console's own reply, skipping its blank lines", () => {
    expect(announce([entry({ state: 'note', note: ['', 'Now using analytics.'] })])).toBe(
      'Now using analytics.',
    )
  })

  it('reads back to the last one that settled, past anything still running', () => {
    expect(
      announce([entry({ state: 'cancelled' }), entry({ id: 'f', state: 'running' })]),
    ).toBe('Cancelled.')
  })
})

describe('blame', () => {
  const carried = ['max_threads', 'not_a_real_setting']

  it('names the setting an error is actually about', () => {
    expect(
      blame(
        "Setting not_a_real_setting is neither a builtin setting nor started with the prefix 'SQL_'",
        carried,
      ),
    ).toEqual(['not_a_real_setting'])
  })

  it('stays quiet about a failure that has nothing to do with settings', () => {
    // The one that made this function exist: a read-only deployment refusing a
    // write, with the console innocently carrying max_threads.
    expect(blame('default: Cannot execute query in readonly mode. (READONLY)', carried)).toEqual([])
    expect(blame('Table analytics.nope does not exist.', carried)).toEqual([])
  })

  it('does not blame a setting merely because its name is in the statement', () => {
    expect(blame("Syntax error at 'max_threads': SELECT max_threads FROM t", carried)).toEqual([])
  })

  it('matches whole words, so a prefix is not a suspect', () => {
    expect(blame('Setting max_threads_extra is unknown', ['max_threads'])).toEqual([])
  })

  it('says nothing when the console is carrying nothing', () => {
    expect(blame('Setting x is unknown', [])).toEqual([])
  })
})
