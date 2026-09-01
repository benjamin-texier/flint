import { describe, expect, it } from 'vitest'

import { nameOf, notable, saysCaveat, saysSpender, trustworthy, type SpendReport, type Spender } from './spend'

const report = (over: Partial<SpendReport> = {}): SpendReport => ({
  available: true,
  window_days: 7,
  covered_days: 6.4,
  spenders: [],
  total_seconds: 4000,
  total_statements: 100_000,
  accounts: 3,
  excludes_flint: true,
  ...over,
})

const spender = (over: Partial<Spender> = {}): Spender => ({
  user: 'grafana_ro',
  background: false,
  statements: 96_559,
  seconds: 1600,
  share: 0.41,
  read_bytes: 0,
  read_rows: 0,
  failed: 0,
  busiest_table: 'analytics.events',
  busiest_share: 0.82,
  last_seen: '2026-09-01 12:28:29',
  ...over,
})

describe('whether a spend ranking may be believed', () => {
  it('believes a week of a real workload', () => {
    expect(trustworthy(report()).ok).toBe(true)
  })

  it('refuses a log that does not go back a day', () => {
    const said = trustworthy(report({ covered_days: 0.23 }))
    expect(said.ok).toBe(false)
    expect(said.why).toContain('who was awake this morning')
  })

  it('refuses a window with no workload in it to divide', () => {
    const said = trustworthy(report({ total_seconds: 3 }))
    expect(said.ok).toBe(false)
    expect(said.why).toContain('3 seconds')
  })
})

describe('naming a row', () => {
  it('never calls the empty account a user', () => {
    /* The empty user is a materialized view's push, a subquery from another
       node, a background flush. On the first real server it was the second
       largest spender on the machine — named as an account it sends somebody
       hunting for one that does not exist. */
    expect(nameOf(spender({ user: '', background: true }))).toBe(
      'The server’s own background work',
    )
  })

  it('uses the account’s own name otherwise', () => {
    expect(nameOf(spender())).toBe('grafana_ro')
  })
})

describe('which accounts are worth a sentence', () => {
  it('keeps only the ones taking a real share', () => {
    /* Not "the top three": on a server where one account does everything, two
       of those three are noise; on one shared evenly, none is a finding. */
    const said = notable(
      report({
        spenders: [spender({ share: 0.41 }), spender({ user: 'etl', share: 0.3 }), spender({ user: 'ops', share: 0.05 })],
      }),
    )
    expect(said.map((s) => s.user)).toEqual(['grafana_ro', 'etl'])
  })

  it('finds none on a server nobody dominates', () => {
    const said = notable(
      report({ spenders: [spender({ share: 0.2 }), spender({ user: 'b', share: 0.2 })] }),
    )
    expect(said).toEqual([])
  })

  it('finds none at all where the reading may not be believed', () => {
    const said = notable(report({ covered_days: 0.2, spenders: [spender({ share: 0.9 })] }))
    expect(said).toEqual([])
  })
})

describe('the sentence for one account', () => {
  it('names the table when that is most of what the account does', () => {
    const said = saysSpender(spender(), report())
    expect(said).toContain('grafana_ro took 41%')
    expect(said).toContain('82% of that was on one table — analytics.events')
  })

  it('leaves the table out when it is not concentrated', () => {
    /* "41% of the server, and 12% of that on events" is two figures that
       together say nothing. */
    const said = saysSpender(spender({ busiest_share: 0.12 }), report())
    expect(said).not.toContain('analytics.events')
    expect(said).toContain('97,000 statements')
  })

  it('leaves it out when the log named no table', () => {
    const said = saysSpender(spender({ busiest_table: '', busiest_share: 0 }), report())
    expect(said).toContain('statements')
  })

  it('speaks of background work as work, not as somebody', () => {
    const said = saysSpender(spender({ user: '', background: true }), report())
    expect(said.startsWith('The server’s own background work took 41%')).toBe(true)
  })
})

describe('the caveat', () => {
  it('discloses that Flint is inside the figures where it could not tag itself', () => {
    expect(saysCaveat(report({ excludes_flint: false }))).toContain('inside these figures')
  })

  it('says nothing where Flint could leave itself out', () => {
    expect(saysCaveat(report())).toBeNull()
  })
})
