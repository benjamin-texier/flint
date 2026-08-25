import { describe, expect, it } from 'vitest'
import {
  asResult,
  clockOf,
  describeSchedule,
  minuteOf,
  parseSchedule,
  parseSections,
  problemWithReport,
  sectionsFromDashboard,
  serialiseSchedule,
  statusOf,
  type Schedule,
  type SectionResult,
} from './report'

describe('parseSchedule', () => {
  it('round trips every kind', () => {
    const all: Schedule[] = [
      { kind: 'every', hours: 6 },
      { kind: 'daily', minute: 540 },
      { kind: 'weekly', dow: 3, minute: 0 },
    ]
    for (const s of all) expect(parseSchedule(serialiseSchedule(s))).toEqual(s)
  })

  it('refuses a schedule that could never come round', () => {
    // Each of these would be a report that looks scheduled and never runs.
    expect(parseSchedule('{"kind":"daily","minute":2000}')).toBeNull()
    expect(parseSchedule('{"kind":"weekly","dow":0,"minute":10}')).toBeNull()
    expect(parseSchedule('{"kind":"weekly","dow":8,"minute":10}')).toBeNull()
    expect(parseSchedule('{"kind":"every","hours":0}')).toBeNull()
    expect(parseSchedule('{"kind":"every","hours":9999}')).toBeNull()
    expect(parseSchedule('{"kind":"never"}')).toBeNull()
    expect(parseSchedule('nonsense')).toBeNull()
    expect(parseSchedule('{"kind":"daily"}')).toBeNull()
  })

  it('accepts midnight, which is a real time of day', () => {
    expect(parseSchedule('{"kind":"daily","minute":0}')).toEqual({ kind: 'daily', minute: 0 })
  })
})

describe('clockOf and minuteOf', () => {
  it('round trip', () => {
    for (const m of [0, 9, 540, 1439]) expect(minuteOf(clockOf(m))).toBe(m)
  })

  it('pads so the field reads as a clock', () => {
    expect(clockOf(0)).toBe('00:00')
    expect(clockOf(545)).toBe('09:05')
  })

  it('refuses what is not a time', () => {
    expect(minuteOf('nine')).toBeNull()
    expect(minuteOf('24:00')).toBeNull()
    expect(minuteOf('09:70')).toBeNull()
    expect(minuteOf('9')).toBeNull()
  })
})

describe('describeSchedule', () => {
  it('names the timezone, because nine is nine somewhere', () => {
    expect(describeSchedule({ kind: 'daily', minute: 540 }, 'Europe/Paris')).toBe(
      'Every day at 09:00 (Europe/Paris)',
    )
    expect(describeSchedule({ kind: 'weekly', dow: 1, minute: 480 }, 'UTC')).toBe(
      'Every Monday at 08:00 (UTC)',
    )
  })

  it('says nothing about a timezone for an interval, which has no time of day', () => {
    expect(describeSchedule({ kind: 'every', hours: 6 }, 'UTC')).toBe('Every 6 hours')
    expect(describeSchedule({ kind: 'every', hours: 1 }, 'UTC')).toBe('Every hour')
  })
})

describe('statusOf', () => {
  it('keeps partial as its own thing', () => {
    expect(statusOf('partial')).toBe('partial')
    expect(statusOf('ok')).toBe('ok')
    expect(statusOf('')).toBe('none')
    expect(statusOf('weird')).toBe('none')
  })
})

describe('parseSections', () => {
  it('survives a snapshot it cannot read', () => {
    expect(parseSections('not json')).toEqual([])
    expect(parseSections('{"not":"an array"}')).toEqual([])
    expect(parseSections('[]')).toEqual([])
  })
})

describe('asResult', () => {
  it('shapes a stored section into what the live components read', () => {
    const section: SectionResult = {
      title: 'a',
      sql: 'SELECT 1',
      columns: [{ name: 'n', type: 'UInt64' }],
      rows: [[1]],
      truncated: true,
      error: '',
    }
    const result = asResult(section)
    expect(result.columns[0]!.type).toBe('UInt64')
    expect(result.truncated).toBe(true)
  })
})

describe('problemWithReport', () => {
  it('needs a name and one real statement', () => {
    const section = { title: 'a', sql: '', database: '' }
    expect(problemWithReport({ name: '', sections: [section] })).toContain('name')
    expect(problemWithReport({ name: 'A', sections: [section] })).toContain('statement')
    expect(
      problemWithReport({ name: 'A', sections: [{ ...section, sql: 'SELECT 1' }] }),
    ).toBeNull()
  })
})

describe('parseSections, defensively', () => {
  it('reads a snapshot written by an older Flint', () => {
    // The shape that crashed the page: columns as bare strings, because that is
    // what the first version stored. Six months of snapshots outlive the code
    // that wrote them.
    const old = JSON.stringify([
      { title: 'By city', sql: 'SELECT 1', columns: ['city', 'n'], rows: [['Oslo', 1]] },
    ])
    const [section] = parseSections(old)
    expect(section!.columns).toEqual([
      { name: 'city', type: '' },
      { name: 'n', type: '' },
    ])
    expect(section!.rows).toEqual([['Oslo', 1]])
  })

  it('repairs a section rather than dropping the snapshot', () => {
    const messy = JSON.stringify([
      { title: 'ok', sql: 'SELECT 1', columns: [{ name: 'n', type: 'UInt8' }], rows: [[1]] },
      { title: 42, columns: 'not a list', rows: 'not a list' },
      null,
      'not an object',
    ])
    const sections = parseSections(messy)
    // The good one survives intact; the broken ones become empty sections
    // rather than taking the page down.
    expect(sections).toHaveLength(2)
    expect(sections[0]!.columns[0]!.type).toBe('UInt8')
    expect(sections[1]!.columns).toEqual([])
    expect(sections[1]!.rows).toEqual([])
    expect(sections[1]!.title).toBe('')
  })

  it('drops rows that are not rows', () => {
    const raw = JSON.stringify([{ title: 'a', sql: 'x', columns: [], rows: [[1], 'nope', null] }])
    expect(parseSections(raw)[0]!.rows).toEqual([[1]])
  })

  it('keeps truncated only when it is really true', () => {
    const raw = JSON.stringify([{ title: 'a', sql: 'x', columns: [], rows: [], truncated: 'yes' }])
    expect(parseSections(raw)[0]!.truncated).toBe(false)
  })
})

describe('sectionsFromDashboard', () => {
  const tile = (over: Record<string, unknown> = {}) => ({
    title: 'By city',
    sql: 'SELECT city FROM events',
    database: 'analytics',
    chart: { kind: 'bar', x: 0, series: [1], why: 'a label and a measure' } as never,
    ...over,
  })

  it('carries the statement, the database and the chart across', () => {
    const [section] = sectionsFromDashboard([tile()])
    expect(section).toEqual({
      title: 'By city',
      sql: 'SELECT city FROM events',
      database: 'analytics',
      chart: { kind: 'bar', x: 0, series: [1], why: 'a label and a measure' },
    })
  })

  it('drops a tile with no statement rather than making a failing section', () => {
    const sections = sectionsFromDashboard([tile(), tile({ sql: '  ' }), tile({ title: 'Two' })])
    expect(sections).toHaveLength(2)
    expect(sections.map((s) => s.title)).toEqual(['By city', 'Two'])
  })

  it('keeps a table tile as a table section', () => {
    expect(sectionsFromDashboard([tile({ chart: null })])[0]!.chart).toBeNull()
  })

  it('is empty for an empty dashboard', () => {
    expect(sectionsFromDashboard([])).toEqual([])
  })
})
