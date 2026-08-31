import { describe, expect, it } from 'vitest'

import {
  anyRunning,
  elapsedMs,
  killable,
  says,
  spaceOfKind,
  stoppable,
  tookFor,
  type Job,
} from './job'

const job = (over: Partial<Job> = {}): Job => ({
  id: 'aaaaaaaa-1111-4222-8333-444455556666',
  kind: 'optimize',
  label: 'Optimize analytics.events',
  target: 'analytics.events',
  submitted_by: 'analyst',
  tier: 'ddl',
  state: 'running',
  detail: '',
  started_at: '2026-08-25 12:00:00.000',
  started_ms: Date.parse('2026-08-25T12:00:00.000Z'),
  finished_at: '',
  ...over,
})

describe('says', () => {
  it('does not call an interrupted job a failure', () => {
    // Nothing went wrong with the work; Flint stopped watching it. Calling it
    // failed would send somebody to run an expensive operation twice.
    expect(says('interrupted').level).toBe('watch')
    expect(says('failed').level).toBe('bad')
    expect(says('done').level).toBe('ok')
    expect(says('running').level).toBe('busy')
  })

  it('shows an unknown state rather than hiding it', () => {
    // A state this build does not know about is still something the operator
    // should see — a newer Flint wrote it.
    expect(says('quantum').label).toBe('quantum')
  })
})

describe('stoppable', () => {
  it('offers to stop only what is running', () => {
    expect(stoppable(job({ state: 'running' }))).toBe(true)
    for (const state of ['done', 'failed', 'cancelled', 'interrupted'] as const) {
      expect(stoppable(job({ state }))).toBe(false)
    }
  })

  it('does not offer to stop what the server cannot find by id', () => {
    // An edition is a dozen statements with a dozen ids. The backend refuses
    // the same set — this only keeps the browser from drawing a dead button.
    expect(stoppable(job({ state: 'running', kind: 'report' }))).toBe(false)
    expect(killable('optimize')).toBe(true)
    expect(killable('report')).toBe(false)
    expect(killable('backup')).toBe(false)
  })
})

describe('spaceOfKind', () => {
  it('files a job by what it does, not by who asked', () => {
    expect(spaceOfKind('optimize')).toBe('infra')
    expect(spaceOfKind('report')).toBe('data')
  })

  it('puts an unrecognised kind with the operations', () => {
    // A newer Flint is likelier to have added an operation than a report, and
    // an operator seeing one job too many beats an operator missing one.
    expect(spaceOfKind('backup')).toBe('infra')
  })
})

describe('elapsedMs', () => {
  const started = Date.parse('2026-08-25T12:00:00.000Z')

  it('measures a running job against now', () => {
    expect(elapsedMs(job(), started + 5_000)).toBe(5_000)
  })

  it('measures a finished job against its own end', () => {
    const finished = job({
      state: 'done',
      finished_at: '2026-08-25 12:00:07.000',
    })
    // `nowMs` is hours later and must not matter: the job stopped when it
    // stopped.
    expect(elapsedMs(finished, started + 9_000_000)).toBe(7_000)
  })

  it('never reports a job that started in the future', () => {
    // A browser clock behind the server's would otherwise print a negative
    // duration, which makes a reader distrust every other figure on the page.
    expect(elapsedMs(job(), started - 30_000)).toBe(0)
  })

  it('reports nothing rather than NaN when the timestamp is unreadable', () => {
    expect(elapsedMs(job({ state: 'done', finished_at: 'not a date' }), started)).toBeNull()
  })

  it('gives no duration for a job whose end is unknown', () => {
    // An interrupted job measured against now read "9 min", then "10 min", for
    // an operation that had finished in a second. Dropped instead.
    expect(elapsedMs(job({ state: 'interrupted', finished_at: '' }), started + 600_000)).toBeNull()
    expect(elapsedMs(job({ state: 'cancelled', finished_at: '' }), started + 600_000)).toBeNull()
  })
})

describe('tookFor', () => {
  it('does not pretend to sub-second precision', () => {
    // The point of a job is that it might take an hour. "0.4 s" is noise.
    expect(tookFor(400)).toBe('under a second')
  })

  it('reads at a glance at every scale', () => {
    expect(tookFor(7_000)).toBe('7s')
    expect(tookFor(89_000)).toBe('89s')
    expect(tookFor(200_000)).toBe('3 min')
    expect(tookFor(3 * 3_600_000)).toBe('3h')
    expect(tookFor(3 * 3_600_000 + 25 * 60_000)).toBe('3h 25 min')
  })
})

describe('anyRunning', () => {
  it('decides whether the list is worth re-asking', () => {
    expect(anyRunning([job({ state: 'done' }), job({ state: 'running' })])).toBe(true)
    expect(anyRunning([job({ state: 'done' }), job({ state: 'interrupted' })])).toBe(false)
    expect(anyRunning([])).toBe(false)
  })
})
