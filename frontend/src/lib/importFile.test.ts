import { describe, expect, it } from 'vitest'

import { blocked, fileSize, guessFormat, looksLikeHeader, saysMapping } from './importFile'

describe('guessFormat', () => {
  it('reads the delimiter off the name and the header off the first line', () => {
    expect(guessFormat('sales.csv', 'id,city,total')).toBe('CSVWithNames')
    expect(guessFormat('sales.csv', '1,Oslo,500')).toBe('CSV')
    expect(guessFormat('sales.tsv', 'id\tcity\ttotal')).toBe('TSVWithNames')
    expect(guessFormat('sales.tsv', '1\tOslo\t500')).toBe('TSV')
  })

  it('recognises line-delimited JSON by either half', () => {
    expect(guessFormat('events.ndjson', '{"a":1}')).toBe('JSONEachRow')
    expect(guessFormat('events.jsonl', '{"a":1}')).toBe('JSONEachRow')
    // No useful extension, but the content settles it.
    expect(guessFormat('dump.txt', '  {"a":1}')).toBe('JSONEachRow')
  })

  it('falls back to the delimiter it can see when the name says nothing', () => {
    expect(guessFormat('dump', 'a\tb\tc')).toBe('TSVWithNames')
    expect(guessFormat('dump', 'a,b,c')).toBe('CSVWithNames')
  })
})

describe('looksLikeHeader', () => {
  it('takes a numeric field as evidence against', () => {
    expect(looksLikeHeader('id,city,total', ',')).toBe(true)
    expect(looksLikeHeader('1,Oslo,500', ',')).toBe(false)
    // One number among words is still a data row: an id column is the usual
    // shape of one, and a header is words all the way across.
    expect(looksLikeHeader('1,Oslo,Norway', ',')).toBe(false)
  })

  it('strips the quotes a CSV writer puts round a name', () => {
    expect(looksLikeHeader('"id","city"', ',')).toBe(true)
  })

  it('is not fooled by an empty line', () => {
    expect(looksLikeHeader('', ',')).toBe(false)
    expect(looksLikeHeader(',,', ',')).toBe(false)
  })
})

describe('saysMapping', () => {
  const m = (over: Partial<Parameters<typeof saysMapping>[0]> = {}) => ({
    matched: [],
    unmatched: [],
    defaulted: [],
    by_name: true,
    ...over,
  })

  it('says nothing is missing when everything lines up', () => {
    const said = saysMapping(m({ matched: ['a', 'b'] }), 2)
    expect(said[0]).toBe("All 2 of the file's columns match a column of the table.")
    expect(said).toHaveLength(1)
  })

  it('marks the names with backticks rather than putting them on screen', () => {
    const said = saysMapping(m({ matched: ['a'], unmatched: ['extra'] }), 2)
    expect(said.join(' ')).toContain('`extra`')
    // An unmatched column stops the import; saying it "will be dropped" would
    // describe a thing Flint does not do.
    expect(said.join(' ')).toContain('refused')
  })

  it('names the columns the table will fill in itself', () => {
    const said = saysMapping(m({ matched: ['a'], defaulted: ['note', 'created'] }), 1)
    expect(said.join(' ')).toContain('`note`, `created`')
    expect(said.join(' ')).toContain('take their default')
  })

  it('says a headerless file is matched by position, and stops there', () => {
    // A `*WithNames` file with an unknown column is an error; a headerless one
    // never consults a name at all. Reporting the second as the first would
    // send somebody renaming columns for no reason.
    const said = saysMapping(m({ by_name: false, unmatched: ['c1'] }), 3)
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('by position')
  })
})

describe('blocked', () => {
  it('stops a named file with a column the table has not got', () => {
    expect(blocked({ matched: [], unmatched: ['x'], defaulted: [], by_name: true })).toBe(true)
  })

  it('lets a headerless file through, since names are never consulted', () => {
    expect(blocked({ matched: [], unmatched: ['c1'], defaulted: [], by_name: false })).toBe(false)
  })
})

describe('fileSize', () => {
  it('says what a reader would say', () => {
    expect(fileSize(512)).toBe('512 B')
    expect(fileSize(2048)).toBe('2 KB')
    expect(fileSize(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(fileSize(3 * 1024 * 1024 * 1024)).toBe('3.00 GB')
  })
})
