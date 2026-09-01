import { describe, expect, it } from 'vitest'

import { inOrder, saysRead, verdict, type Reading } from './arrival'
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
    const said = verdict([finding('a', 'queries', 'now'), finding('b', 'schema', 'worth', 9)], done)
    expect(said).toBe('One thing on this server is going wrong now.')
  })

  it('counts what is worth changing when nothing is wrong', () => {
    expect(verdict([finding('a', 'schema', 'worth', 9)], done)).toBe(
      'One thing is worth changing here.',
    )
    expect(
      verdict([finding('a', 'schema', 'worth', 9), finding('b', 'server', 'worth', 2)], done),
    ).toBe('2 things are worth changing here.')
  })

  it('says it is still reading rather than clearing the server too early', () => {
    /* A verdict that reads "nothing is wrong" and becomes "three things are
       failing" four seconds later is worse than one that waited. */
    expect(verdict([], [{ label: 'the query log', state: 'reading' }])).toBe(
      'Reading this server.',
    )
  })

  it('speaks when the answer is good', () => {
    // A heading that vanishes leaves the reader wondering whether anything ran.
    expect(verdict([], done)).toBe('Nothing on this server is asking to be changed.')
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
    expect(verdict([], mostlyRefused)).toBe('Flint could not read enough of this server to say.')
  })

  it('still clears a server where only one reading was refused', () => {
    // Below the line a refusal is a gap in an answer, not the absence of one.
    const mostlyRead: Reading[] = [
      { label: 'the disks', state: 'read' },
      { label: 'the query log', state: 'read' },
      { label: 'the backup log', state: 'refused' },
    ]
    expect(verdict([], mostlyRead)).toBe('Nothing on this server is asking to be changed.')
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
