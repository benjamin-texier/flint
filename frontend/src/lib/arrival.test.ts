import { describe, expect, it } from 'vitest'

import { growth, inOrder, plain, saysGrowth, saysRead, strata, verdict, type Reading } from './arrival'
import type { Area, Finding, Urgency } from './checkup'
import type { Grain } from './timeline'

function finding(id: string, area: Area, urgency: Urgency, gain = 0): Finding {
  return {
    id,
    area,
    urgency,
    title: id,
    why: '',
    evidence: '',
    gain: gain ? { kind: 'bytes', n: gain } : { kind: 'none' },
  }
}

describe('the order a first reader meets findings in', () => {
  it('opens with what is already going wrong', () => {
    const said = inOrder([
      finding('big', 'schema', 'worth', 900_000_000_000),
      finding('failing', 'queries', 'now'),
      finding('medium', 'schema', 'worth', 400_000_000),
    ])
    expect(said[0]?.id).toBe('failing')
  })

  it('deals the rest across areas rather than emptying one', () => {
    /* The defect this exists to prevent: ranked by gain alone, a server with
       eight heavy tables opens with eight storage rows — all true, all the same
       insight — and the reader never reaches the workload. */
    const said = inOrder(
      [
        finding('disk-1', 'schema', 'worth', 900),
        finding('disk-2', 'schema', 'worth', 800),
        finding('disk-3', 'schema', 'worth', 700),
        finding('slow', 'queries', 'worth', 10),
        finding('full', 'server', 'worth', 5),
      ],
      4,
    )
    const areas = said.map((f) => f.area)
    expect(new Set(areas).size).toBeGreaterThan(1)
    // And within one area the strongest still comes first.
    expect(said.filter((f) => f.area === 'schema')[0]?.id).toBe('disk-1')
  })

  it('respects the cap and does not loop on empty queues', () => {
    const many = Array.from({ length: 20 }, (_, i) => finding(`f${i}`, 'schema', 'worth', 20 - i))
    expect(inOrder(many, 5)).toHaveLength(5)
    // Fewer findings than the cap must terminate rather than spin.
    expect(inOrder([finding('one', 'server', 'worth', 1)], 8)).toHaveLength(1)
  })

  it('never drops a failure to stay under the cap', () => {
    const said = inOrder(
      [
        finding('a', 'queries', 'now'),
        finding('b', 'queries', 'now'),
        finding('c', 'schema', 'worth', 5),
      ],
      2,
    )
    expect(said.map((f) => f.id)).toEqual(['a', 'b'])
  })
})

describe('the verdict', () => {
  const done: Reading[] = [{ label: 'the disks', state: 'read' }]

  it('leads with failure over opportunity', () => {
    const said = plain(verdict([finding('a', 'queries', 'now'), finding('b', 'schema', 'worth', 9)], done))
    expect(said).toBe('One thing on this server is going wrong now.')
  })

  it('counts what is worth changing when nothing is wrong', () => {
    expect(plain(verdict([finding('a', 'schema', 'worth', 9)], done))).toBe(
      'One thing here is worth changing.',
    )
    expect(
      plain(verdict([finding('a', 'schema', 'worth', 9), finding('b', 'server', 'worth', 2)], done)),
    ).toBe('2 things here are worth changing.')
  })

  it('says it is still reading rather than clearing the server too early', () => {
    /* A verdict that reads "nothing is wrong" and becomes "three things are
       failing" four seconds later is worse than one that waited. */
    expect(plain(verdict([], [{ label: 'the query log', state: 'reading' }]))).toBe(
      'Reading this server.',
    )
  })

  it('speaks when the answer is good', () => {
    // A heading that vanishes leaves the reader wondering whether anything ran.
    expect(plain(verdict([], done))).toBe('Nothing on this server is asking to be changed.')
  })

  it('refuses to clear a server it was not allowed to read', () => {
    /* ClickHouse's own demo server: five of six readings refused, and the
       headline cheerfully cleared a seven-terabyte machine it had barely looked
       at. The caption names which ones; the headline must stop claiming. */
    const mostlyRefused: Reading[] = [
      { label: 'the disks', state: 'refused' },
      { label: 'the query log', state: 'refused' },
      { label: 'the backup log', state: 'read' },
    ]
    expect(plain(verdict([], mostlyRefused))).toBe(
      'Flint could not read enough of this server to say.',
    )
  })

  it('still clears a server where only one reading was refused', () => {
    // Below the line a refusal is a gap in an answer, not the absence of one.
    const mostlyRead: Reading[] = [
      { label: 'the disks', state: 'read' },
      { label: 'the query log', state: 'read' },
      { label: 'the backup log', state: 'refused' },
    ]
    expect(plain(verdict([], mostlyRead))).toBe('Nothing on this server is asking to be changed.')
  })
})

describe('the verdict’s setting', () => {
  it('hands the count over as a figure and the rest as prose', () => {
    /* They are set in different faces — see `Said`. The token file's own rule:
       the data face is for "everywhere the characters themselves are the content
       rather than a label for it", and a count in a verdict is content. */
    const said = verdict(
      [finding('a', 'queries', 'now'), finding('b', 'queries', 'now')],
      [{ label: 'the disks', state: 'read' }],
    )
    expect(said[0]).toEqual({ text: '2', figure: true })
    expect(said[1]?.figure).toBeUndefined()
  })

  it('leaves "one" as a word', () => {
    // Nobody reads `1 thing` as a figure they might act on, and setting it in
    // the data face would make the calmest verdict the loudest-looking one.
    const said = verdict([finding('a', 'queries', 'now')], [{ label: 'x', state: 'read' }])
    expect(said).toHaveLength(1)
    expect(said[0]?.figure).toBeUndefined()
  })

  it('has no figure in a verdict that counts nothing', () => {
    for (const readings of [
      [{ label: 'x', state: 'read' as const }],
      [{ label: 'x', state: 'reading' as const }],
      [{ label: 'x', state: 'refused' as const }],
    ]) {
      expect(verdict([], readings).some((s) => s.figure)).toBe(false)
    }
  })
})

describe('the server’s disk as one line', () => {
  it('orders the bands by weight and shares them out', () => {
    const { bands, total } = strata([
      { name: 'small', bytes: 100 },
      { name: 'big', bytes: 900 },
    ])
    expect(bands.map((b) => b.name)).toEqual(['big', 'small'])
    expect(bands[0]?.share).toBeCloseTo(0.9, 5)
    expect(total).toBe(1000)
  })

  it('folds the tail into a band that counts itself', () => {
    /* A strip of forty two-pixel slivers is a texture, not a measurement. The
       fold is always the right-hand end, because order is by weight. */
    const items = Array.from({ length: 9 }, (_, i) => ({ name: `d${i}`, bytes: 100 - i }))
    const { bands } = strata(items, 3)
    expect(bands).toHaveLength(4)
    expect(bands[3]).toMatchObject({ name: '6 more', folded: true })
  })

  it('leaves out what weighs nothing rather than drawing a zero band', () => {
    const { bands } = strata([{ name: 'a', bytes: 10 }, { name: 'empty', bytes: 0 }])
    expect(bands.map((b) => b.name)).toEqual(['a'])
  })

  it('has no bands at all where nothing could be weighed', () => {
    // A server whose sizes were all refused. The caller drops the strip.
    expect(strata([{ name: 'a', bytes: 0 }])).toEqual({ bands: [], total: 0 })
    expect(strata([])).toEqual({ bands: [], total: 0 })
  })
})

describe('what was read', () => {
  it('says nothing when everything answered', () => {
    expect(saysRead([{ label: 'the disks', state: 'read' }])).toBeNull()
  })

  it('names what is still in flight', () => {
    const said = saysRead([
      { label: 'the disks', state: 'read' },
      { label: 'the query log', state: 'reading' },
    ])
    expect(said).toBe('Still reading the query log.')
  })

  it('names what would not be read, and what that costs', () => {
    const said = saysRead([
      { label: 'the disks', state: 'read' },
      { label: 'the query log', state: 'refused', reason: 'no grant' },
      { label: 'the parts', state: 'refused' },
    ])
    expect(said).toBe(
      'The query log and the parts are not readable as this account, so nothing here speaks for them.',
    )
  })

  it('joins three or more with commas and a final and', () => {
    const said = saysRead([
      { label: 'a', state: 'reading' },
      { label: 'b', state: 'reading' },
      { label: 'c', state: 'reading' },
    ])
    expect(said).toBe('Reading a, b and c.')
  })
})

describe('growth', () => {
  const cell = (partition: string, bytes: number, from?: string) => ({
    partition,
    bytes,
    rows: bytes,
    covers_from: from,
  })
  const timeline = (cells: ReturnType<typeof cell>[], over: Partial<{ available: boolean; datable: boolean; grain: Grain }> = {}) => ({
    available: true,
    datable: true,
    grain: 'month' as Grain,
    cells,
    ...over,
  })

  it('sums the cells of a bucket into one bar, oldest first', () => {
    const g = growth(
      timeline([
        cell('2026-02', 20, '2026-02-01 00:00:00'),
        cell('2026-01', 5, '2026-01-01 00:00:00'),
        cell('2026-01', 7, '2026-01-14 00:00:00'),
      ]),
    )!
    expect(g.bars.map((b) => b.bucket)).toEqual(['2026-01', '2026-02'])
    expect(g.bars[0]!.bytes).toBe(12)
    expect(g.bars[1]!.bytes).toBe(20)
  })

  /* The lie this exists to prevent: a table with no partition key is folded
     into the epoch, and drawn as a bar it is a mountain labelled January 1970 —
     on a schema of flat analytics tables, most of the disk. */
  it('counts undated data instead of drawing it in 1970', () => {
    const g = growth(
      timeline([
        cell('1970-01', 900, '1970-01-02 00:00:00'),
        cell('2026-01', 5, '2026-01-01 00:00:00'),
        cell('2026-02', 6, '2026-02-01 00:00:00'),
      ]),
    )!
    expect(g.bars.map((b) => b.bucket)).toEqual(['2026-01', '2026-02'])
    expect(g.undated.bytes).toBe(900)
    expect(g.bars.some((b) => b.bucket.startsWith('1970'))).toBe(false)
  })

  it('treats both epoch dates the server may fill as undated', () => {
    for (const at of ['1970-01-01 00:00:00', '1970-01-02 00:00:00', '1970-01-03 23:59:59']) {
      const g = growth(
        timeline([cell('1970-01', 9, at), cell('2026-01', 1, '2026-01-01 00:00:00'), cell('2026-02', 1, '2026-02-01 00:00:00')]),
      )!
      expect(g.undated.bytes).toBe(9)
    }
  })

  it('counts a cell with no date at all as undated rather than dropping it', () => {
    const g = growth(
      timeline([
        cell('all', 400),
        cell('2026-01', 1, '2026-01-01 00:00:00'),
        cell('2026-02', 1, '2026-02-01 00:00:00'),
      ]),
    )!
    expect(g.undated.bytes).toBe(400)
  })

  it('is null where there is no reading, no scale of time, or nothing to compare', () => {
    expect(growth(undefined)).toBeNull()
    expect(growth(timeline([], { available: false }))).toBeNull()
    expect(growth(timeline([], { datable: false }))).toBeNull()
    // One bucket is a total with a chart around it, not a growth.
    expect(growth(timeline([cell('2026-01', 5, '2026-01-01 00:00:00')]))).toBeNull()
    // And a server whose only cells are undated has nothing dated to draw.
    expect(growth(timeline([cell('1970-01', 900, '1970-01-02 00:00:00')]))).toBeNull()
  })
})

describe('saysGrowth', () => {
  const g = (undatedBytes: number, filled = true) => ({
    bars: [
      { bucket: '2026-01', bytes: 1, rows: 1 },
      { bucket: '2026-06', bytes: 2, rows: 2 },
    ],
    undated: { bytes: undatedBytes, rows: undatedBytes },
    grain: 'month' as Grain,
    filled,
  })

  it('names the span and the grain, and never says "written"', () => {
    const said = saysGrowth(g(0))
    expect(said).toContain('2026-01 to 2026-06')
    expect(said).toContain('month')
    expect(said).not.toMatch(/written|growth|grew/i)
  })

  it('names the undated bytes when there are any, and stays quiet when there are none', () => {
    expect(saysGrowth(g(2048))).toContain('no date to place it by')
    expect(saysGrowth(g(0))).not.toContain('no date')
  })

  /* An axis to scale is what a reader assumes, so it is the exception that gets
     stated. */
  it('says when the gaps are not to scale, and nothing when they are', () => {
    expect(saysGrowth(g(0, false))).toContain('only the periods that hold something')
    expect(saysGrowth(g(0, true))).not.toContain('only the periods')
  })
})

describe('growth fills the axis', () => {
  const cell = (partition: string, bytes: number, from?: string) => ({
    partition,
    bytes,
    rows: bytes,
    covers_from: from,
  })
  const monthly = (cells: ReturnType<typeof cell>[]) => ({
    available: true,
    datable: true,
    grain: 'month' as Grain,
    cells,
  })

  /* The lie this fixes: bars spaced by presence put 2001 next to 2002 with a
     year between them, under two end labels inviting the position to be read as
     time. */
  it('draws the empty periods between the ends', () => {
    const g = growth(
      monthly([
        cell('2026-01', 10, '2026-01-05 00:00:00'),
        cell('2026-04', 20, '2026-04-05 00:00:00'),
      ]),
    )!
    expect(g.filled).toBe(true)
    expect(g.bars.map((b) => b.bucket)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04'])
    expect(g.bars.map((b) => b.bytes)).toEqual([10, 0, 0, 20])
  })

  it('does not fill from the epoch when there is an undated lump', () => {
    const g = growth(
      monthly([
        cell('1970-01', 900, '1970-01-02 00:00:00'),
        cell('2026-01', 10, '2026-01-05 00:00:00'),
        cell('2026-03', 20, '2026-03-05 00:00:00'),
      ]),
    )!
    // Three months, not the six hundred and seventy since 1970.
    expect(g.bars).toHaveLength(3)
    expect(g.bars[0]!.bucket).toBe('2026-01')
  })

  /* The grain is chosen here rather than asked for, and this is why: one row
     from 2001 and one from 2026 drew three hundred and eight monthly columns, in
     which two years of real data was a sixty-pixel smear. Measured on a fixture
     that had exactly that shape. */
  it('coarsens the grain until the axis fits, rather than drawing hairlines', () => {
    const twoYears = growth(
      monthly([
        cell('a', 10, '2024-09-01 00:00:00'),
        cell('b', 20, '2026-08-01 00:00:00'),
      ]),
    )!
    expect(twoYears.grain).toBe('month')
    expect(twoYears.bars).toHaveLength(24)

    const quarterCentury = growth(
      monthly([
        cell('a', 10, '2001-01-01 00:00:00'),
        cell('b', 20, '2026-08-01 00:00:00'),
      ]),
    )!
    expect(quarterCentury.grain).toBe('year')
    expect(quarterCentury.bars.length).toBeLessThanOrEqual(64)
    expect(quarterCentury.bars.length).toBeGreaterThan(20)
  })

  it('reaches for quarters between the two, and never exceeds the cap', () => {
    const sixYears = growth(
      monthly([
        cell('a', 10, '2020-01-01 00:00:00'),
        cell('b', 20, '2026-01-01 00:00:00'),
      ]),
    )!
    expect(sixYears.grain).toBe('quarter')
    expect(sixYears.bars.length).toBeLessThanOrEqual(64)
  })

  /* The partition grain never reaches `bucketSequence` any more — the ladder is
     month, quarter, year — so a timeline that came back at it is re-bucketed by
     date like every other. Two partitions of one month are one bar, and one bar
     is not a growth. */
  it('re-buckets a partition-grained timeline by date rather than by name', () => {
    expect(
      growth({
        available: true,
        datable: true,
        grain: 'partition',
        cells: [cell('eu', 10, '2026-01-05 00:00:00'), cell('us', 20, '2026-01-06 00:00:00')],
      }),
    ).toBeNull()

    const spread = growth({
      available: true,
      datable: true,
      grain: 'partition',
      cells: [cell('eu', 10, '2026-01-05 00:00:00'), cell('us', 20, '2026-04-06 00:00:00')],
    })!
    expect(spread.grain).toBe('month')
    expect(spread.bars.map((b) => b.bucket)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04'])
  })
})
