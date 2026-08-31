import { describe, expect, it } from 'vitest'

import {
  buildGrid,
  columnLabel,
  comparePartitions,
  windowOf,
  WINDOW,
  bucketOf,
  bucketSequence,
  columnLabels,
  leftOut,
  parseStamp,
  notPartitioned,
  pinnedName,
  spanLine,
  type PartitionCell,
  type PartitionTimeline,
  type TimelineTable,
} from './timeline'

const cell = (over: Partial<PartitionCell> = {}): PartitionCell => ({
  table: 'events',
  partition: '202605',
  partition_id: '202605',
  parts: 4,
  partitions: 1,
  rows: 1_000,
  bytes: 10_000,
  uncompressed_bytes: 40_000,
  covers_from: '2026-05-01 00:00:00',
  covers_to: '2026-05-31 23:59:59',
  ...over,
})

const table = (over: Partial<TimelineTable> = {}): TimelineTable => ({
  table: 'events',
  partitions: 1,
  parts: 4,
  rows: 1_000,
  bytes: 10_000,
  partition_key: 'toYYYYMM(ts)',
  ...over,
})

const report = (over: Partial<PartitionTimeline> = {}): PartitionTimeline => ({
  available: true,
  tables: [table()],
  cells: [cell()],
  total_tables: 1,
  total_bytes: 10_000,
  cells_truncated: false,
  grain: 'partition',
  datable: true,
  scope: 'database',
  ...over,
})

describe('comparePartitions', () => {
  it('puts months in the order a date key makes them', () => {
    const got = ['202512', '202601', '202511'].sort(comparePartitions)
    expect(got).toEqual(['202511', '202512', '202601'])
  })

  it('compares digit runs as numbers, so 9 comes before 10', () => {
    // Lexicographic order would put '10' first, which on a yearly or numeric
    // key draws history backwards.
    expect(['10', '9', '2'].sort(comparePartitions)).toEqual(['2', '9', '10'])
  })

  it('sorts the unpartitioned column last, in either of the two names it has', () => {
    // `system.parts.partition` prints the key expression's value, which for an
    // empty tuple is `tuple()`; the id is `all`. A real server hands over the
    // first and every ALTER takes the second, so both have to land in the same
    // place — at the end, because neither is a point in time.
    expect(['all', '202601', '202512'].sort(comparePartitions)).toEqual([
      '202512',
      '202601',
      'all',
    ])
    expect(['tuple()', '202601', '202512'].sort(comparePartitions)).toEqual([
      '202512',
      '202601',
      'tuple()',
    ])
  })

  it('falls back to plain order for keys that are not dates at all', () => {
    expect(['eu', 'ap', 'us'].sort(comparePartitions)).toEqual(['ap', 'eu', 'us'])
  })
})

describe('buildGrid', () => {
  it('leaves a cell undefined where the table holds nothing', () => {
    // The distinction the view exists for: a hole in a row is a partition that
    // does not exist, which is a retention policy or a failed ingest. Drawing
    // it as a zero would say the partition is there and empty.
    const grid = buildGrid(
      report({
        cells: [cell({ partition: '202604' }), cell({ partition: '202606' })],
        tables: [table({ partitions: 2 })],
      }),
      'bytes',
    )
    expect(grid.columns).toEqual(['202604', '202606'])
    expect(grid.rows[0]!.cells.map((c) => c !== undefined)).toEqual([true, true])

    const withHole = buildGrid(
      report({
        cells: [
          cell({ partition: '202604' }),
          cell({ partition: '202605', table: 'other' }),
          cell({ partition: '202606' }),
        ],
        tables: [table(), table({ table: 'other' })],
      }),
      'bytes',
    )
    expect(withHole.columns).toEqual(['202604', '202605', '202606'])
    expect(withHole.rows[0]!.cells.map((c) => c !== undefined)).toEqual([true, false, true])
  })

  it('gives anything present a visible floor', () => {
    const grid = buildGrid(
      report({
        cells: [
          cell({ partition: '202601', bytes: 1 }),
          cell({ partition: '202602', bytes: 1_000_000 }),
          cell({ partition: '202603', bytes: 1_000_000 }),
        ],
        tables: [table({ partitions: 3 })],
      }),
      'bytes',
    )
    const tiny = grid.rows[0]!.cells[0]!
    expect(tiny.value).toBe(1)
    expect(tiny.fill).toBeGreaterThan(0)
  })

  it('marks a cell past the scale instead of pretending it fits', () => {
    // Eleven ordinary months and one backfilled with three years of history.
    // Twelve rather than ten because the scale is `barScale`, whose 90th
    // percentile *is* the maximum below eleven values — which is deliberate
    // there and inherited here: a short row behaves as it always did and
    // nothing is ever marked on it.
    const cells = Array.from({ length: 12 }, (_, i) =>
      cell({ partition: `2026${String(i + 1).padStart(2, '0')}`, bytes: i === 11 ? 1_000_000 : 10 }),
    )
    const grid = buildGrid(report({ cells, tables: [table({ partitions: 12 })] }), 'bytes')
    const drawn = grid.rows[0]!.cells
    expect(grid.scale).toBe(10)
    expect(drawn[11]!.past).toBe(true)
    expect(drawn[11]!.fill).toBe(1)
    expect(drawn[0]!.past).toBe(false)
  })

  it('opens on the newest partitions when there are more than fit', () => {
    const cells = Array.from({ length: 8 }, (_, i) => cell({ partition: `20260${i + 1}` }))
    const grid = buildGrid(report({ cells, tables: [table({ partitions: 8 })] }), 'bytes', {
      limit: 3,
    })
    expect(grid.columns).toEqual(['202606', '202607', '202608'])
    expect(grid.window.older).toBe(5)
    expect(grid.window.newer).toBe(0)
  })

  it('pins the unpartitioned column outside the window', () => {
    // Otherwise it travels with whichever window holds the newest partitions,
    // and paging back into history turns every unpartitioned table into an
    // empty row — which reads as "holds nothing" about a table that holds
    // everything it has, one column to the right.
    const cells = [
      ...Array.from({ length: 6 }, (_, i) => cell({ partition: `20260${i + 1}` })),
      cell({ table: 'devices', partition: 'tuple()' }),
    ]
    const tables = [table({ partitions: 6 }), table({ table: 'devices', partition_key: '' })]
    const grid = buildGrid(report({ cells, tables }), 'bytes', { limit: 2, offset: 2 })
    expect(grid.columns).toEqual(['202601', '202602', 'tuple()'])
    expect(grid.pinned).toBe(1)
    // The pinned column is not one of the partitions the window counts.
    expect(grid.window.total).toBe(6)
    expect(grid.window.older).toBe(0)
    expect(grid.window.newer).toBe(4)
    // And the unpartitioned table still has its one cell, three windows back.
    expect(grid.rows[1]!.cells[2]).toBeDefined()
  })

  it('reaches history a window at a time', () => {
    // The whole reason the window moves: a retention policy shows up at the old
    // end, and a cap that could not be moved would put it permanently out of
    // reach.
    const cells = Array.from({ length: 8 }, (_, i) => cell({ partition: `20260${i + 1}` }))
    const back = buildGrid(report({ cells, tables: [table({ partitions: 8 })] }), 'bytes', {
      limit: 3,
      offset: 1,
    })
    expect(back.columns).toEqual(['202603', '202604', '202605'])
    expect(back.window.older).toBe(2)
    expect(back.window.newer).toBe(3)
  })

  it('reports the share of the disk the drawn rows account for', () => {
    // A cap that hides ninety tables holding 2% of the disk and one that hides
    // two holding 90% are not the same cap.
    const grid = buildGrid(
      report({
        tables: [table({ bytes: 900 })],
        cells: [cell({ bytes: 900 })],
        total_tables: 40,
        total_bytes: 1_000,
      }),
      'bytes',
    )
    expect(grid.shareOfDisk).toBeCloseTo(0.9)
    expect(grid.omittedTables).toBe(39)
  })

  it('switches what a cell weighs without relaying it out', () => {
    const grid = buildGrid(report({ cells: [cell({ parts: 300 })] }), 'parts')
    expect(grid.rows[0]!.cells[0]!.value).toBe(300)
  })
})

describe('leftOut', () => {
  it('says nothing when nothing was left out', () => {
    expect(leftOut(buildGrid(report(), 'bytes'))).toEqual([])
  })

  it('states every cap it applied, with its count', () => {
    const cells = Array.from({ length: 5 }, (_, i) => cell({ partition: `20260${i + 1}` }))
    const grid = buildGrid(
      report({ cells, tables: [table()], total_tables: 3, cells_truncated: true }),
      'bytes',
      { limit: 2 },
    )
    const said = leftOut(grid).join(' · ')
    expect(said).toContain('2 smaller tables not drawn')
    expect(said).toContain('3 older partitions before these')
    expect(said).toContain('cell cap')
  })

  it('says which way the rest lies once the window has moved', () => {
    const cells = Array.from({ length: 5 }, (_, i) => cell({ partition: `20260${i + 1}` }))
    const grid = buildGrid(report({ cells, tables: [table()] }), 'bytes', { limit: 2, offset: 1 })
    const said = leftOut(grid).join(' · ')
    expect(said).toContain('1 older partition before these')
    expect(said).toContain('2 newer partitions after these')
  })
})

describe('a scale of time', () => {
  it('pins the undated column, like the unpartitioned one', () => {
    // At a coarse grain the server cannot place a part whose range it never
    // recorded. That part still holds real disk, so it keeps a column beside
    // the timeline rather than dropping out of a picture of the whole database.
    const grid = buildGrid(
      report({
        grain: 'month',
        cells: [
          cell({ partition: '2026-05' }),
          cell({ partition: '2026-06' }),
          cell({ table: 'devices', partition: 'undated' }),
        ],
        tables: [table({ partitions: 2 }), table({ table: 'devices', partition_key: '' })],
      }),
      'bytes',
    )
    expect(grid.columns).toEqual(['2026-05', '2026-06', 'undated'])
    expect(grid.pinned).toBe(1)
    expect(grid.window.total).toBe(2)
  })

  it('orders month buckets chronologically, which is what their names give', () => {
    // `2026-05` sorts before `2026-06` lexicographically as well as in time, so
    // the bucket labels need no date parsing either.
    expect(['2026-06', '2026-05', '2025-12'].sort(comparePartitions)).toEqual([
      '2025-12',
      '2026-05',
      '2026-06',
    ])
  })

  it('carries how many partitions a bucket folded together', () => {
    const grid = buildGrid(
      report({
        grain: 'month',
        cells: [cell({ partition: '2026-05', partitions: 31, parts: 62 })],
      }),
      'bytes',
    )
    expect(grid.rows[0]!.cells[0]!.cell.partitions).toBe(31)
  })
})

describe('spanLine', () => {
  const months = (n: number) =>
    Array.from({ length: n }, (_, i) => cell({ partition: `2026${String(i + 1).padStart(2, '0')}` }))

  it('counts only the partitions the window moves through', () => {
    // The pinned column is drawn and is not one of them. Counting it in the
    // first figure and not the second gives a pair nobody can reconcile.
    const cells = [...months(6), cell({ table: 'devices', partition: 'tuple()' })]
    const tables = [table({ partitions: 6 }), table({ table: 'devices', partition_key: '' })]
    const grid = buildGrid(report({ cells, tables }), 'bytes', { limit: 2 })
    expect(spanLine(grid)).toBe('2 tables across 2 of 6 partitions, plus the unpartitioned column')
  })

  it('spells the window out on the grains whose heads gave up the year', () => {
    const cells = ['2026-05-27', '2026-05-28', '2026-05-29'].map((p) => cell({ partition: p }))
    const grid = buildGrid(report({ grain: 'day', cells, tables: [table()] }), 'bytes')
    expect(spanLine(grid, 'day')).toBe('1 table across 3 days · 2026-05-27 to 2026-05-29')
    // And not on the ones that fit: a month's own head says `2026-05` already.
    const months = buildGrid(
      report({ grain: 'month', cells: [cell({ partition: '2026-05' })], tables: [table()] }),
      'bytes',
    )
    expect(spanLine(months, 'month')).toBe('1 table across 1 month')
  })

  it('does not count columns where the axis is empty', () => {
    // A database partitioned by nothing has one column and it is the pinned one.
    // "3 tables across 0 partitions, plus the unpartitioned column" contradicts
    // itself in eight words; it is what this said until the branch was rendered.
    const grid = buildGrid(
      report({
        cells: [cell({ partition: 'tuple()' }), cell({ table: 'cities', partition: 'tuple()' })],
        tables: [table({ partition_key: '' }), table({ table: 'cities', partition_key: '' })],
      }),
      'bytes',
    )
    expect(spanLine(grid)).toBe('2 tables, none of them partitioned')
    // At a scale of time the same shape means undated rather than unpartitioned.
    const dated = buildGrid(
      report({
        grain: 'month',
        cells: [cell({ partition: 'undated' })],
        tables: [table()],
      }),
      'bytes',
    )
    expect(spanLine(dated, 'month')).toBe('1 table, none of them dated')
  })

  it('drops the "of" where the whole timeline is drawn', () => {
    const grid = buildGrid(report({ cells: months(3), tables: [table({ partitions: 3 })] }), 'bytes')
    expect(spanLine(grid)).toBe('1 table across 3 partitions')
  })
})

describe('columnLabels', () => {
  it('shows the day, because the year and month are what repeat', () => {
    // Ten characters do not fit a cell's width: ninety daily columns arrive
    // clipped to `2026-0…`, which is ninety identical headers and no axis.
    expect(columnLabels(['2026-05-27', '2026-05-28', '2026-06-01'], 'day')).toEqual([
      '05-27',
      '05-28',
      '06-01',
    ])
  })

  it('drops the year from the first column too, since it does not fit there either', () => {
    // Keeping it on the first column was the first attempt, and it bought a
    // header clipped to `2026-0…`. The year is in the line above the grid and on
    // every column's title instead.
    expect(columnLabels(['2025-12-31', '2026-01-01'], 'day')).toEqual(['12-31', '01-01'])
  })

  it('leaves the other grains as they are', () => {
    // A month, a quarter and a year already fit; a partition's name is the
    // server's and is not Flint's to trim.
    expect(columnLabels(['2026-05', '2026-06'], 'month')).toEqual(['2026-05', '2026-06'])
    expect(columnLabels(['202605', 'tuple()'], 'partition')).toEqual(['202605', 'all'])
  })

  it('leaves the pinned column alone at any grain', () => {
    // It is not a date and has nothing to shorten.
    expect(columnLabels(['2026-05-27', 'undated'], 'day')).toEqual(['05-27', 'undated'])
    expect(columnLabels(['2026-05-27', 'tuple()'], 'day')).toEqual(['05-27', 'all'])
  })
})

describe('the axis is continuous', () => {
  it('fills the buckets nothing was written in', () => {
    // The whole reason: without this, a month in which no table wrote has no
    // column, the gap closes up, and the view cannot show the hole it
    // advertises. July is missing from the cells and must still be a column.
    const grid = buildGrid(
      report({
        grain: 'month',
        span_from: '2026-05-04 00:00:00',
        span_to: '2026-08-24 16:23:56',
        cells: [
          cell({ partition: '2026-05' }),
          cell({ partition: '2026-06' }),
          cell({ partition: '2026-08' }),
        ],
        tables: [table({ partitions: 3 })],
      }),
      'bytes',
    )
    expect(grid.columns).toEqual(['2026-05', '2026-06', '2026-07', '2026-08'])
    expect(grid.axisFilled).toBe(true)
    expect(grid.emptyColumns).toBe(1)
    expect(grid.rows[0]!.cells[2]).toBeUndefined()
    expect(leftOut(grid, 'month').join(' · ')).toContain('1 month with nothing in any table drawn')
  })

  it('leaves the partition grain alone, which has no sequence to walk', () => {
    // A partition's name is whatever the key made it. There is nothing between
    // `('eu',2026)` and `('us',2026)` to generate.
    const grid = buildGrid(
      report({
        span_from: '2026-05-04 00:00:00',
        span_to: '2026-08-24 16:23:56',
        cells: [cell({ partition: '202605' }), cell({ partition: '202608' })],
      }),
      'bytes',
    )
    expect(grid.columns).toEqual(['202605', '202608'])
    expect(grid.axisFilled).toBe(false)
  })

  it('keeps what the server answered when it cannot fill the axis', () => {
    const grid = buildGrid(
      report({ grain: 'month', cells: [cell({ partition: '2026-05' })] }),
      'bytes',
    )
    expect(grid.columns).toEqual(['2026-05'])
    expect(grid.axisFilled).toBe(false)
    expect(grid.emptyColumns).toBe(0)
  })
})

describe('bucketOf and bucketSequence', () => {
  const at = (s: string) => parseStamp(s)!

  it('spells a bucket the way the server spells it', () => {
    // A contract with the Rust side: one character of difference produces two
    // columns for one month, one with data and one generated and always empty.
    expect(bucketOf('day', at('2026-05-28 04:15:37'))).toBe('2026-05-28')
    expect(bucketOf('month', at('2026-05-28 04:15:37'))).toBe('2026-05')
    expect(bucketOf('quarter', at('2026-05-28 04:15:37'))).toBe('2026-Q2')
    expect(bucketOf('year', at('2026-05-28 04:15:37'))).toBe('2026')
  })

  it('puts a week on the Monday, as toStartOfWeek(x, 1) does', () => {
    // 2026-05-28 is a Thursday; ClickHouse's week-mode 1 starts on Monday, and a
    // column labelled with the Sunday would disagree with the server.
    expect(bucketOf('week', at('2026-05-28 04:15:37'))).toBe('2026-05-25')
    // A Sunday belongs to the week that began six days earlier, not to the next.
    expect(bucketOf('week', at('2026-05-31 23:59:59'))).toBe('2026-05-25')
    expect(bucketOf('week', at('2026-06-01 00:00:00'))).toBe('2026-06-01')
  })

  it('walks months across a year boundary', () => {
    expect(bucketSequence('month', '2025-11-14 00:00:00', '2026-02-01 00:00:00')).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ])
  })

  it('walks quarters and years', () => {
    expect(bucketSequence('quarter', '2025-11-14 00:00:00', '2026-04-30 00:00:00')).toEqual([
      '2025-Q4',
      '2026-Q1',
      '2026-Q2',
    ])
    expect(bucketSequence('year', '2024-06-01 00:00:00', '2026-01-01 00:00:00')).toEqual([
      '2024',
      '2025',
      '2026',
    ])
  })

  it('refuses to generate a page nobody can use', () => {
    // One part with a corrupt date — 1997, or 2242 — would otherwise generate
    // ninety thousand daily columns and hang the page. The axis falls back to
    // the buckets that exist.
    expect(bucketSequence('day', '1997-01-01 00:00:00', '2026-01-01 00:00:00')).toEqual([])
  })

  it('reads a timestamp without moving it', () => {
    // Naive on purpose: the server formatted its labels in its own timezone, so
    // the sequence between them has to be built in the same frame.
    const d = parseStamp('2026-05-28 04:15:37')!
    expect(d.getUTCHours()).toBe(4)
    expect(parseStamp('not a time')).toBeNull()
  })
})

describe('the window follows the grain', () => {
  it('holds a period a reader can name, not a fixed number of columns', () => {
    // The cap is there so a browser is not asked to lay out forty thousand
    // cells; any figure under a few hundred does that, which leaves the figure
    // free to be chosen for the reader. Ninety days is a quarter, fifty-two
    // weeks a year — so paging moves by something nameable.
    expect(WINDOW.day).toBe(90)
    expect(WINDOW.week).toBe(52)
    expect(WINDOW.month).toBe(60)
    // A partition is whatever the table's key made it, so there is no period to
    // round to and it keeps the plain cap.
    expect(WINDOW.partition).toBe(120)
  })

  it('consults the grain rather than a flat constant', () => {
    const cells = Array.from({ length: 70 }, (_, i) =>
      cell({ partition: `2026-${String((i % 12) + 1).padStart(2, '0')}-01` }),
    )
    const grid = buildGrid(report({ grain: 'day', cells, tables: [table()] }), 'bytes')
    // Twelve distinct days here, so nothing is windowed — the point is only
    // that the grain's window was consulted rather than the flat constant.
    expect(grid.window.limit).toBe(WINDOW.day)
  })

  it('orders quarter buckets by year and then by quarter', () => {
    expect(['2026-Q2', '2025-Q4', '2026-Q1'].sort(comparePartitions)).toEqual([
      '2025-Q4',
      '2026-Q1',
      '2026-Q2',
    ])
  })
})

describe('the prose follows the scope', () => {
  it('counts databases when a row is a database', () => {
    // The same grid answers "which of these is growing" about tables and about
    // whole databases; only the word for a row changes.
    const grid = buildGrid(
      report({
        scope: 'server',
        tables: [table({ table: 'analytics' }), table({ table: 'reference' })],
        cells: [cell({ table: 'analytics' }), cell({ table: 'reference' })],
        total_tables: 5,
      }),
      'bytes',
    )
    expect(spanLine(grid, 'partition', 'server')).toBe('2 databases across 1 partition')
    expect(leftOut(grid, 'partition', 'server').join(' · ')).toContain(
      '3 smaller databases not drawn',
    )
  })
})

describe('the prose follows the scale', () => {
  it('counts months when the columns are months', () => {
    // A line that counts "partitions" over a row of months describes a
    // different picture than the one on screen.
    const grid = buildGrid(
      report({
        grain: 'month',
        cells: [cell({ partition: '2026-05' }), cell({ partition: '2026-06' })],
        tables: [table({ partitions: 2 })],
      }),
      'bytes',
    )
    expect(spanLine(grid, 'month')).toBe('1 table across 2 months')
  })

  it('names the pinned column for the reason it is pinned', () => {
    // At the server's own grain it is a table with no partition key; at a scale
    // of time it is a part whose range was never recorded. Telling a reader the
    // wrong one sends them looking for a partition key that is not the problem.
    expect(pinnedName('partition')).toBe('the unpartitioned column')
    expect(pinnedName('month')).toBe('the undated column')
  })

  it('says older and newer in the unit on screen', () => {
    const cells = Array.from({ length: 5 }, (_, i) => cell({ partition: `2026-0${i + 1}` }))
    const grid = buildGrid(report({ grain: 'month', cells, tables: [table()] }), 'bytes', {
      limit: 2,
      offset: 1,
    })
    const said = leftOut(grid, 'month').join(' · ')
    expect(said).toContain('1 older month before these')
    expect(said).toContain('2 newer months after these')
  })
})

describe('windowOf', () => {
  const months = ['202601', '202602', '202603', '202604', '202605']

  it('clamps an offset past the oldest instead of emptying the grid', () => {
    // A control one click from the end must not be able to produce a grid with
    // no columns in it.
    const { columns, window } = windowOf(months, 2, 99)
    expect(columns).toEqual(['202601'])
    expect(window.offset).toBe(2)
    expect(window.older).toBe(0)
  })

  it('draws everything, and says so, when it all fits', () => {
    const { columns, window } = windowOf(months, 10, 0)
    expect(columns).toEqual(months)
    expect(window.older).toBe(0)
    expect(window.newer).toBe(0)
  })

  it('holds no window when there is nothing to draw', () => {
    const { columns, window } = windowOf([], 10, 0)
    expect(columns).toEqual([])
    expect(window.total).toBe(0)
  })
})

describe('columnLabel', () => {
  it('gives the unpartitioned column the name every ALTER would take', () => {
    // `tuple()` in a column header is the server being literal about an empty
    // key; `all` is the string a DROP PARTITION ID takes and the one worth
    // reading in a row of months.
    expect(columnLabel('tuple()')).toBe('all')
    expect(columnLabel('202605')).toBe('202605')
  })
})

describe('notPartitioned', () => {
  it('is true only when the table has no partition key at all', () => {
    expect(notPartitioned(table({ partition_key: '' }))).toBe(true)
    expect(notPartitioned(table({ partition_key: 'toYYYYMM(ts)' }))).toBe(false)
  })
})
