import { describe, expect, it } from 'vitest'

import { compression, onDisk, weigh } from './weight'

describe('what a table weighs', () => {
  it('reads the figure system.tables gives', () => {
    expect(onDisk({ total_bytes: 14438210664, parts_bytes: 14438210664 })).toBe(14438210664)
  })

  it('falls back to the parts where system.tables has no answer', () => {
    // A Log or Memory engine reports no total_bytes on some builds; the parts
    // are still countable.
    expect(onDisk({ total_bytes: null, parts_bytes: 4096 })).toBe(4096)
  })

  it('answers nothing rather than zero where nothing was granted', () => {
    /* The case that mattered: on ClickHouse's own demo server system.parts is
       refused, and Flint used to print `0 B` for a seven-terabyte database and
       an em-dash beside every table on it. Zero is a claim; this is not one. */
    expect(onDisk({ total_bytes: null, parts_bytes: 0 })).toBeNull()
    expect(onDisk({})).toBeNull()
  })

  it('keeps an empty table apart from an unanswerable one', () => {
    // Both print differently, and only one of them is a fact about the table.
    expect(onDisk({ total_bytes: 0 })).toBe(0)
    expect(onDisk({ total_bytes: null })).toBeNull()
  })
})

describe('the compression ratio', () => {
  it('is the uncompressed size over the stored one', () => {
    // hits, on play.clickhouse.com.
    const ratio = compression({ total_bytes: 14438210664, uncompressed_bytes: 54351455779 })
    expect(ratio).toBeCloseTo(3.76, 2)
  })

  it('is absent where the build has no uncompressed figure', () => {
    /* And this is why it exists. Built from total_bytes over parts_bytes — the
       two compressed figures, which are the same number — it read 1.0× for
       every MergeTree table on every server. */
    expect(compression({ total_bytes: 14438210664, parts_bytes: 14438210664 })).toBeNull()
  })

  it('is absent for a table with nothing in it', () => {
    expect(compression({ total_bytes: 0, uncompressed_bytes: 0 })).toBeNull()
  })
})

describe('weighing a list', () => {
  it('totals what is known and counts what is not', () => {
    const said = weigh([
      { total_bytes: 100 },
      { total_bytes: 250 },
      { total_bytes: null, parts_bytes: 0 },
    ])
    expect(said).toEqual({ bytes: 350, known: 2, silent: 1 })
  })

  it('reports nothing known where nothing was granted', () => {
    // The caller drops the figure on this rather than printing `0 B`.
    const said = weigh([{ total_bytes: null }, { total_bytes: null }])
    expect(said.known).toBe(0)
    expect(said.silent).toBe(2)
  })

  it('counts an empty table as an answer', () => {
    const said = weigh([{ total_bytes: 0 }, { total_bytes: 40 }])
    expect(said).toEqual({ bytes: 40, known: 2, silent: 0 })
  })
})
