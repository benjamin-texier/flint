import { describe, expect, it } from 'vitest'
import { forcingFor, summarise, verdictOf, type View } from './pipeline'

const view = (over: Partial<View> = {}): View => ({
  database: 'analytics',
  name: 'hourly_mv',
  target: 'analytics.hourly_rollup',
  target_exists: true,
  refreshable: false,
  definition: 'SELECT toStartOfHour(ts) AS hour, count() AS n FROM events GROUP BY hour',
  target_rows: 100,
  target_bytes: 1000,
  last_write: '2026-08-25 08:00:00',
  runs: 4,
  failures: 0,
  written_rows: 40,
  avg_ms: 2,
  last_run: '2026-08-25 08:00:00',
  last_error: '',
  refresh_status: '',
  last_refresh: '',
  last_success: '',
  next_refresh: '',
  refresh_exception: '',
  retry: 0,
  progress: 0,
  ...over,
})

describe('verdictOf', () => {
  it('calls a healthy classic view flowing', () => {
    expect(verdictOf(view(), true)).toEqual({ health: 'flowing', says: '4 runs, no failures' })
  })

  it('puts a missing target above a clean log', () => {
    // The whole reason this function combines sources: the log is clean
    // *because* the view never runs.
    const v = verdictOf(view({ target_exists: false, runs: 4, failures: 0 }), true)
    expect(v.health).toBe('broken')
    expect(v.says).toContain('does not exist')
    expect(v.says).toContain('never runs')
  })

  it('reports failed runs', () => {
    expect(verdictOf(view({ runs: 5, failures: 2 }), true).says).toBe('2 of its 5 runs failed')
  })

  it('separates "nothing happened" from "we cannot see"', () => {
    // These send a reader to different places, so they are different answers.
    expect(verdictOf(view({ runs: 0 }), true).health).toBe('idle')
    expect(verdictOf(view({ runs: 0 }), false).health).toBe('unknown')
  })

  it('does not blame a view for an idle source', () => {
    expect(verdictOf(view({ runs: 0 }), true).says).toContain('nothing to do')
  })

  describe('refreshable', () => {
    const refreshable = (over: Partial<View> = {}) =>
      view({
        refreshable: true,
        refresh_status: 'Scheduled',
        last_success: '2026-08-25 08:00:00',
        runs: 0,
        ...over,
      })

    it('reads its own state, not the insert log', () => {
      // A refreshable view has no runs in query_views_log at all; judging it by
      // that would call every one of them idle.
      expect(verdictOf(refreshable(), true).health).toBe('flowing')
      expect(verdictOf(refreshable(), false).health).toBe('flowing')
    })

    it('is broken when its refresh threw', () => {
      expect(verdictOf(refreshable({ refresh_exception: 'no such column' }), true).says).toContain(
        'no such column',
      )
    })

    it('is broken while it is retrying', () => {
      expect(verdictOf(refreshable({ retry: 2 }), true).says).toBe(
        'it is retrying — 2 attempts so far',
      )
    })

    it('is idle before its first success', () => {
      expect(verdictOf(refreshable({ last_success: '1970-01-01 00:00:00' }), true).health).toBe(
        'idle',
      )
      expect(verdictOf(refreshable({ last_success: '' }), true).health).toBe('idle')
    })

    it('is still broken when its target is gone', () => {
      expect(verdictOf(refreshable({ target: 'a.b', target_exists: false }), true).health).toBe(
        'broken',
      )
    })
  })
})

describe('forcingFor', () => {
  it('offers a refresh only to a refreshable view', () => {
    expect(forcingFor(view({ refreshable: true }))).toEqual({ kind: 'refresh' })
  })

  it('writes a backfill for a classic view without running it', () => {
    // Running it is safe exactly once, and only the reader knows whether it
    // already ran.
    const forcing = forcingFor(view())
    expect(forcing.kind).toBe('backfill')
    if (forcing.kind === 'backfill') {
      expect(forcing.statement).toBe(
        'INSERT INTO analytics.hourly_rollup\nSELECT toStartOfHour(ts) AS hour, count() AS n FROM events GROUP BY hour',
      )
    }
  })

  it('says why it cannot help rather than guessing', () => {
    expect(forcingFor(view({ target: '' })).kind).toBe('none')
    expect(forcingFor(view({ definition: '   ' })).kind).toBe('none')
  })
})

describe('summarise', () => {
  it('counts only what is not flowing', () => {
    const report = {
      views: [view(), view({ target_exists: false }), view({ failures: 1, runs: 1 })],
      window_days: 7,
      log_available: true,
      refreshes_available: true,
    }
    expect(summarise(report)).toBe('2 of 3 not flowing')
  })

  it('says nothing when everything flows, and nothing with no views', () => {
    const ok = { views: [view()], window_days: 7, log_available: true, refreshes_available: true }
    expect(summarise(ok)).toBeNull()
    expect(summarise({ ...ok, views: [] })).toBeNull()
    expect(summarise(undefined)).toBeNull()
  })
})
