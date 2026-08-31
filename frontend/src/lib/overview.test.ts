import { describe, expect, it } from 'vitest'

import { headline, row, standingOf, unread, worst, type Reading } from './overview'
import type { Section } from './spaces'

const section: Section = { id: 'cluster', to: '/infra/cluster', label: 'Clusters' }

const reads = () => ({ standing: 'ok' as const, says: 'two replicas, both in step' })

describe('a section that could not be read is never fine', () => {
  it('says so when the request failed', () => {
    // The failure this page exists to prevent: a board that shows green for a
    // section whose request errored is a board that lies in exactly the
    // situation somebody built it for.
    const r = row(section, 'replication', { failed: 'HTTP 500' }, reads)
    expect(r.standing).toBe('unknown')
    expect(r.says).toContain('HTTP 500')
  })

  it('says so when the server answered that it cannot tell', () => {
    const reading: Reading<{ available: boolean; reason: string }> = {
      data: { available: false, reason: 'this user is not granted SELECT on system.replicas' },
    }
    const r = row(section, 'replication', reading, reads)
    expect(r.standing).toBe('unknown')
    // The server's own words, not a paraphrase.
    expect(r.says).toBe('this user is not granted SELECT on system.replicas')
  })

  it('distinguishes still reading from could not read', () => {
    // A row that is merely slow must not look like one that is blind.
    expect(standingOf({ pending: true })).toBe('reading')
    expect(standingOf({ failed: 'boom' })).toBe('unknown')
    expect(unread({ pending: true }, 'replication')).toBe('reading replication…')
  })

  it('consults the section only once it has answered', () => {
    let asked = false
    row(section, 'replication', { failed: 'no' }, () => {
      asked = true
      return reads()
    })
    expect(asked).toBe(false)
  })

  it('lets a section that answered speak for itself', () => {
    const r = row(section, 'replication', { data: { available: true } }, reads)
    expect(r.standing).toBe('ok')
    expect(r.says).toBe('two replicas, both in step')
    expect(r.to).toBe('/infra/cluster')
  })
})

describe('worst', () => {
  it('ranks in the order the product already uses', () => {
    expect(worst(['ok', 'watch', 'ok'])).toBe('watch')
    expect(worst(['watch', 'throw', 'delay'])).toBe('throw')
    expect(worst([])).toBe('ok')
  })
})

describe('headline', () => {
  const at = (standing: Row['standing']): Row => ({
    id: 'x',
    label: 'X',
    to: '/infra/x',
    standing,
    says: '',
  })
  type Row = ReturnType<typeof row>

  it('says nothing when there is nothing to say', () => {
    // Quiet is the good answer, and an indicator that is always lit is not an
    // indicator.
    expect(headline([at('ok'), at('ok')])).toBeNull()
  })

  it('counts not knowing among the things to surface', () => {
    // Not knowing is precisely what this page is for.
    expect(headline([at('unknown'), at('ok')])).toBe('1 that could not be read')
    expect(headline([at('throw'), at('watch'), at('unknown')])).toBe(
      '1 needing attention, 1 worth a look, 1 that could not be read',
    )
  })

  it('does not count a section still being read as a problem', () => {
    expect(headline([at('reading'), at('ok')])).toBeNull()
  })
})
