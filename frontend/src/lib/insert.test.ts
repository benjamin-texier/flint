import { describe, expect, it } from 'vitest'

import { columnInsertion, tableInsertion, tableName } from './insert'

const ref = { database: 'default', table: 'logs' }

/** The document as it would be after the insertion, with `|` for the caret. */
function applied(doc: string, insertion: { text: string; from: number; to: number }): string {
  return doc.slice(0, insertion.from) + insertion.text + '|' + doc.slice(insertion.to)
}

describe('tableName', () => {
  it('drops the database the tab is already in', () => {
    expect(tableName(ref, 'default')).toBe('logs')
    expect(tableName(ref, 'other')).toBe('default.logs')
  })

  it('backticks what needs it', () => {
    expect(tableName({ database: 'my db', table: 'odd name' }, 'my db')).toBe('`odd name`')
    expect(tableName({ database: 'my db', table: 'odd name' }, 'x')).toBe('`my db`.`odd name`')
  })
})

describe('tableInsertion', () => {
  it('writes a whole statement into an empty tab', () => {
    const insertion = tableInsertion('', 0, ref, 'default')
    expect(insertion.text).toBe('SELECT *\nFROM logs\nLIMIT 100')
  })

  it('replaces the blank rather than inserting into it', () => {
    expect(applied('\n\n', tableInsertion('\n\n', 1, ref, 'default'))).toBe(
      'SELECT *\nFROM logs\nLIMIT 100|',
    )
  })

  it('never overwrites a statement that has something in it', () => {
    const doc = 'SELECT * FROM '
    expect(applied(doc, tableInsertion(doc, doc.length, ref, 'default'))).toBe(
      'SELECT * FROM logs|',
    )
  })

  it('adds the space that was missing', () => {
    const doc = 'SELECT * FROM'
    expect(applied(doc, tableInsertion(doc, doc.length, ref, 'default'))).toBe(
      'SELECT * FROM logs|',
    )
  })

  it('leaves the statement after the caret alone', () => {
    const doc = 'SELECT * FROM  LIMIT 10'
    expect(applied(doc, tableInsertion(doc, 14, ref, 'default'))).toBe(
      'SELECT * FROM logs| LIMIT 10',
    )
  })

  it('seeds only the statement the caret is in', () => {
    const doc = 'SELECT 1;\n'
    expect(applied(doc, tableInsertion(doc, 10, ref, 'default'))).toBe(
      'SELECT 1;\nSELECT *\nFROM logs\nLIMIT 100|',
    )
  })
})

describe('columnInsertion', () => {
  it('continues a list with a comma', () => {
    const doc = 'SELECT ts'
    expect(applied(doc, columnInsertion(doc, doc.length, 'host'))).toBe(
      'SELECT ts, host|',
    )
  })

  it('does not add a comma after a keyword', () => {
    const doc = 'SELECT '
    expect(applied(doc, columnInsertion(doc, doc.length, 'host'))).toBe('SELECT host|')
  })

  it('does not add a comma where a list is not what is being written', () => {
    const doc = 'SELECT * FROM logs WHERE ts > 1 AND'
    expect(applied(doc, columnInsertion(doc, doc.length, 'host'))).toBe(
      'SELECT * FROM logs WHERE ts > 1 AND host|',
    )
  })

  it('backticks a name that needs it', () => {
    expect(columnInsertion('SELECT ', 7, 'odd name').text).toBe('`odd name`')
  })
})
