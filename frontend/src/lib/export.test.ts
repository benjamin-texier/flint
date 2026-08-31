import { describe, expect, it } from 'vitest'

import { builtDownloadNote, downloadNote, stemFor, tableDownloadNote, FORMATS } from './export'

describe('downloadNote', () => {
  it('refuses to name a total it does not know', () => {
    // The page was cut by the row cap, so nothing in the answer says how many
    // rows there really are — `rows_before_limit_at_least` is null and
    // `rows_read` counts only what the server read before it stopped. Printing
    // either as a total would be a figure nobody could reconcile.
    const said = downloadNote(10000, true)
    expect(said).toContain('the whole result')
    expect(said).toContain('10,000 rows shown')
    // And it must not claim the shown figure is the size of the file.
    expect(said).not.toMatch(/Downloads 10,000 rows/)
  })

  it('names the count where the count is the whole truth', () => {
    // Nothing was cut, so the number on screen is the number in the file.
    expect(downloadNote(1234, false)).toBe('Downloads 1,234 rows — everything this statement returned.')
    expect(downloadNote(1, false)).toBe('Downloads 1 row — everything this statement returned.')
    expect(downloadNote(0, false)).toBe('Downloads 0 rows — everything this statement returned.')
  })
})

describe('tableDownloadNote', () => {
  it('names the count when the table knows it and nothing narrows it', () => {
    // The case the editor's note cannot have: a MergeTree keeps this figure,
    // so the button can say its own size instead of gesturing at it.
    expect(tableDownloadNote(494440, false, 200)).toBe(
      'Downloads all 494,440 rows, not only the 200 shown.',
    )
    expect(tableDownloadNote(1, false, 1)).toBe('Downloads all 1 row, not only the 1 shown.')
  })

  it('stops claiming a figure the moment a filter narrows it', () => {
    // A `WHERE` makes the count unknown, and Flint will not run a second pass
    // over the table to decorate a button.
    const said = tableDownloadNote(494440, true, 200)
    expect(said).toContain('matching the filters above')
    expect(said).not.toContain('494,440')
  })

  it('and drops the figure rather than dashing it where there is none', () => {
    // A view has no row count, and neither does every engine.
    for (const absent of [null, undefined]) {
      const said = tableDownloadNote(absent, false, 200)
      expect(said).toBe('Downloads every row, not only the 200 shown.')
      expect(said).not.toMatch(/—|--|null|undefined/)
    }
  })

  it('always says the preview limit does not apply', () => {
    // A download that quietly honoured the preview's LIMIT would hand back two
    // hundred rows under a button labelled with the whole table.
    for (const said of [
      tableDownloadNote(494440, false, 200),
      tableDownloadNote(494440, true, 200),
      tableDownloadNote(null, false, 200),
    ]) {
      expect(said).toContain('not only the 200 shown')
    }
  })
})

describe('stemFor', () => {
  it('names the file after what the reader is looking at', () => {
    expect(stemFor('analytics', 'events')).toBe('analytics.events')
  })

  it('and falls back rather than making half a name', () => {
    expect(stemFor(undefined, 'events')).toBe('events')
    expect(stemFor('analytics', undefined)).toBe('analytics')
    expect(stemFor(undefined, undefined)).toBe('export')
    expect(stemFor('  ', '')).toBe('export')
  })
})

describe('FORMATS', () => {
  it('offers three, and each says what it is for', () => {
    // A format nobody can open is a download nobody wanted, so each one names
    // the tool it is for rather than only itself.
    expect(FORMATS.map((f) => f.format)).toEqual(['csv', 'jsonl', 'parquet'])
    for (const f of FORMATS) expect(f.why.length).toBeGreaterThan(10)
  })
})

describe('what a download from the form says it will give', () => {
  it('names the limit the reader set, not the rows that came back', () => {
    // The file is a re-run: the rows on screen are from before, and the table
    // may have moved since. The limit is the only figure that is still true.
    expect(builtDownloadNote(500)).toBe('Downloads what the form asks for: at most 500 rows.')
    expect(builtDownloadNote(10_000)).toContain('10,000')
  })

  it('says what no limit means rather than printing a zero', () => {
    expect(builtDownloadNote(0)).toContain('every row that matches')
    expect(builtDownloadNote(0)).not.toContain('0')
  })
})
