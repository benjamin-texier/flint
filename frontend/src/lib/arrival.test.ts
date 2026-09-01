import { describe, expect, it } from 'vitest'

import { inOrder, plain, saysRead, strata, verdict, type Reading } from './arrival'
import type { Area, Finding, Urgency } from './checkup'

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
