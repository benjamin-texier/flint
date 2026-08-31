import { describe, expect, it } from 'vitest'

import {
  capabilities,
  carries,
  CHECKS,
  consequences,
  detected,
  heldOn,
  reached,
  said,
  type Grant,
  type Preflight,
  type ReachWord,
} from './preflight'

function grant(what: string, on: string, revoked = false): Grant {
  return { what, on, revoked, grantable: false, statement: '', direct: true, via: [] }
}

/** A reading with everything working, for a test to spoil one field of. */
function pre(over: Partial<Preflight> = {}, reading: Partial<Preflight['reading']> = {}): Preflight {
  return {
    backups: true,
    workspace: 'flint',
    scheduled: true,
    ...over,
    reading: {
      reached_ms: 4,
      version: '26.7.1.1315',
      databases: 8,
      objects: 326,
      nodes: 1,
      reach: {
        tables: 'readable',
        query_log: 'readable',
        parts: 'readable',
        merges: 'readable',
        users: 'readable',
        session_log: 'readable',
        clusters: 'readable',
      },
      grants: {
        user: 'jeeves',
        roles: [],
        grants: [grant('SELECT, INSERT', 'analytics.*'), grant('BACKUP', '*.*')],
        revokes: [],
      },
      ...reading,
    },
  }
}

const verdicts = (p: Preflight) =>
  Object.fromEntries(capabilities(p).map((c) => [c.id, c.verdict]))
const words = (p: Preflight) => Object.fromEntries(capabilities(p).map((c) => [c.id, c.word]))
const rests = (p: Preflight) => Object.fromEntries(capabilities(p).map((c) => [c.id, c.rests]))

describe('carries', () => {
  it('matches a privilege in a list', () => {
    expect(carries('SELECT, INSERT, ALTER', 'SELECT')).toBe(true)
    expect(carries('SELECT, INSERT', 'BACKUP')).toBe(false)
  })

  /* The bug this exists for: a forty-privilege superuser line, measured on a
     real server, contains `displaySecretsInShowAndSelect`, and a substring
     search for SELECT matches it. */
  it('does not match a privilege that merely contains the name', () => {
    expect(carries('displaySecretsInShowAndSelect, SOURCES', 'SELECT')).toBe(false)
  })

  /* And the other direction: CREATE is a prefix of five other privileges, so a
     startsWith test would credit CREATE TABLE to a user who only holds
     CREATE VIEW. */
  it('does not match a longer privilege that starts with the name', () => {
    expect(carries('CREATE VIEW, CREATE DICTIONARY', 'CREATE')).toBe(false)
    expect(carries('CREATE, DROP', 'CREATE')).toBe(true)
  })

  it('counts a column-scoped grant as the privilege', () => {
    expect(carries('SELECT(on_time, carrier)', 'SELECT')).toBe(true)
  })
})

describe('heldOn', () => {
  it('names each target once, shortest first', () => {
    const held = heldOn([grant('SELECT', 'reference.*'), grant('SELECT', 'a.*'), grant('SELECT', 'a.*')], 'SELECT')
    expect(held).toEqual(['a.*', 'reference.*'])
  })

  it('ignores a revoke', () => {
    expect(heldOn([grant('SELECT', 'analytics.orders', true)], 'SELECT')).toEqual([])
  })

  /* A wildcard over everything makes every narrower grant beside it redundant,
     and a line whose job is "what may you touch" is not improved by listing
     three databases that `*.*` already covers. */
  it('lets a grant on everything swallow the rest', () => {
    const held = heldOn([grant('SELECT', 'analytics.*'), grant('SELECT', '*.*')], 'SELECT')
    expect(held).toEqual(['*.*'])
  })

  it('caps the list and counts what it left out', () => {
    const many = ['a.*', 'bb.*', 'ccc.*', 'dddd.*', 'eeeee.*'].map((on) => grant('SELECT', on))
    expect(heldOn(many, 'SELECT')).toEqual(['a.*', 'bb.*', 'ccc.*', 'and 2 more'])
  })
})

describe('capabilities', () => {
  it('grants everything on a server where everything answered', () => {
    expect(verdicts(pre())).toEqual({
      explore: 'granted',
      diagnostics: 'granted',
      pipelines: 'granted',
      schedule: 'granted',
      backups: 'granted',
      access: 'granted',
    })
  })

  it('names what a granted row rests on', () => {
    expect(rests(pre()).explore).toBe('SELECT on analytics.*')
    expect(rests(pre()).backups).toBe('BACKUP on *.*')
  })

  /* The row is about the user's own data, so a SELECT on a system table must
     not be credited to it — that grant is what the Diagnostics row rests on,
     and one privilege counted twice makes a panel that does not add up. */
  it('does not credit a system-table grant to Explore', () => {
    const p = pre({}, {
      grants: {
        user: 'ro',
        roles: [],
        grants: [grant('SELECT', 'system.query_log')],
        revokes: [],
      },
    })
    expect(rests(p).explore).toBe('SELECT on a database')
  })

  it('refuses what the grants refuse', () => {
    const p = pre({}, { reach: { ...pre().reading.reach, query_log: 'denied' as ReachWord } })
    expect(verdicts(p).diagnostics).toBe('refused')
    expect(words(p).diagnostics).toBe('refused')
  })

  /* The distinction the four-state verdict exists for, and the one measured on
     a real server: the log is off, the grants are fine, and "refused" would
     send somebody to write a GRANT that changes nothing. */
  it('says switched off, not refused, when the log is absent', () => {
    const p = pre({}, { reach: { ...pre().reading.reach, query_log: 'absent' as ReachWord } })
    expect(verdicts(p).diagnostics).toBe('off')
    expect(words(p).diagnostics).toBe('switched off')
  })

  it('names which half of Pipelines is missing', () => {
    const p = pre({}, { reach: { ...pre().reading.reach, merges: 'denied' as ReachWord } })
    expect(verdicts(p).pipelines).toBe('partial')
    expect(words(p).pipelines).toBe('no system.merges')
  })

  it('says it could not tell when the probe itself never answered', () => {
    const { clusters, ...rest } = pre().reading.reach
    void clusters
    const p = pre({}, { reach: { ...rest, query_log: undefined } })
    expect(words(p).diagnostics).toBe('could not tell')
  })

  /* A readable but empty server is not a refusal. `databases` counts what this
     user can see, so 1 is `system` alone — and a GRANT is what changes it,
     which is why the consequence says so and the verdict does not say
     "refused". */
  it('says nothing granted when only ClickHouse own databases are visible', () => {
    const p = pre({}, { databases: 1 })
    expect(verdicts(p).explore).toBe('off')
    expect(words(p).explore).toBe('nothing granted')
  })

  it('puts the disk before the privilege on Backups', () => {
    const p = pre({ backups: false })
    expect(verdicts(p).backups).toBe('off')
    expect(words(p).backups).toBe('no disk')
    /* Even though BACKUP on *.* is held — a granted privilege with nowhere to
       write is true and useless. */
    expect(rests(p).backups).toBe('FLINT_BACKUP_DISK, sanctioned by the server')
  })

  it('refuses Backups when there is a disk and no privilege', () => {
    const p = pre({}, {
      grants: { user: 'ro', roles: [], grants: [grant('SELECT', 'analytics.*')], revokes: [] },
    })
    expect(verdicts(p).backups).toBe('refused')
  })

  /* Alerts are gated by the deployment, not by grants: Flint writes its own
     bookkeeping with its own account. The row must name the real gate. */
  it('separates nothing kept from no schedule', () => {
    const stateless = pre({ workspace: null, scheduled: false })
    expect(words(stateless).schedule).toBe('nothing kept')
    expect(rests(stateless).schedule).toBe('FLINT_WORKSPACE_DATABASE')

    const unpinned = pre({ workspace: 'flint', scheduled: false })
    expect(words(unpinned).schedule).toBe('no schedule')
    expect(rests(unpinned).schedule).toContain('flint')
  })

  it('shows users without history when the session log is off', () => {
    const p = pre({}, { reach: { ...pre().reading.reach, session_log: 'absent' as ReachWord } })
    expect(verdicts(p).access).toBe('partial')
    expect(words(p).access).toBe('no history')
  })

  it('survives a reading with no grants at all', () => {
    const p = pre({}, { grants: undefined })
    expect(verdicts(p).explore).toBe('granted')
    expect(rests(p).explore).toBe('SELECT on a database')
    expect(words(p).backups).toBe('could not tell')
  })
})

describe('CHECKS', () => {
  /* The panel lists these before it has asked the server anything, so the empty
     state and the verdicts are two renders of one list. This is the test that
     stops them drifting: reorder or rename a row and it fails here rather than
     in a screenshot nobody takes. */
  it('is the same ids in the same order as the verdicts', () => {
    expect(capabilities(pre()).map((c) => ({ id: c.id, label: c.label }))).toEqual(CHECKS)
  })
})

describe('consequences', () => {
  it('says nothing when nothing will be missing', () => {
    expect(consequences(pre())).toEqual([])
  })

  it('names the tab that will not be there', () => {
    const [said, ...rest] = consequences(pre({ backups: false }))
    expect(rest).toEqual([])
    expect(said?.title).toBe('Backups will be hidden')
    /* And does not repeat the variable its own row already names: three of these
       can fire at once, and a paragraph apiece buried the panel they annotate. */
    expect(said?.body).not.toContain('FLINT_BACKUP_DISK')
    expect(said?.body).toContain('nowhere')
  })

  /* A refused row has already explained itself beside the privilege it wanted.
     These exist for consequences that land somewhere else on the screen, so a
     plain refusal must not produce one. */
  it('does not repeat a refusal that already reads as one', () => {
    const p = pre({}, { reach: { ...pre().reading.reach, query_log: 'denied' as ReachWord } })
    expect(consequences(p)).toEqual([])
  })

  it('distinguishes a Flint that keeps nothing from one that cannot tick', () => {
    const [stateless] = consequences(pre({ workspace: null, scheduled: false }))
    expect(stateless?.body).toContain('writes nothing down')
    expect(stateless?.title).toBe('Alerts and Reports will be hidden')
    const [unpinned] = consequences(pre({ workspace: 'flint', scheduled: false }))
    expect(unpinned?.body).toContain('on a timer')
  })

  it('warns when the server can answer nothing about the data', () => {
    const said = consequences(pre({}, { databases: 1 }))
    expect(said.map((c) => c.id)).toContain('explore')
  })
})

describe('detected', () => {
  it('reads the shape of the server', () => {
    expect(detected(pre().reading)).toEqual([
      'v26.7.1.1315',
      '8 databases',
      '326 objects',
      'single node',
    ])
  })

  /* The house rule: an absent figure is dropped, not dashed. A count that was
     refused is not a count of zero. */
  it('drops a figure it does not have rather than printing a dash', () => {
    expect(detected({ ...pre().reading, objects: undefined, nodes: undefined })).toEqual([
      'v26.7.1.1315',
      '8 databases',
    ])
  })

  it('counts more than one node', () => {
    expect(detected({ ...pre().reading, nodes: 6 })).toContain('6 nodes')
  })

  it('does not print a version it was not told', () => {
    expect(detected({ ...pre().reading, version: '' })[0]).toBe('8 databases')
  })
})

describe('a note stays one sentence', () => {
  /* The cap that keeps the panel readable. Enforced as a test rather than as a
     render-time truncation, because a note trimmed with an ellipsis is worse
     than a note that was written short. */
  it('is short enough to sit on one line beside its title', () => {
    const all = [
      ...consequences(pre({ backups: false, workspace: null, scheduled: false }, { databases: 1 })),
      ...consequences(pre({}, { reach: { tables: 'readable', query_log: 'absent', users: 'readable', session_log: 'absent' } })),
      ...consequences(pre({ workspace: 'flint', scheduled: false })),
    ]
    expect(all.length).toBeGreaterThan(4)
    for (const note of all) {
      expect(note.body.length, note.id).toBeLessThanOrEqual(96)
      expect(note.title.length, note.id).toBeLessThanOrEqual(48)
    }
  })
})

describe('said', () => {
  it('has nothing to say about no error', () => {
    expect(said(null)).toBeNull()
  })

  /* The bug: a refused password used to put "no answer" beside an address that
     had answered in five milliseconds. The address was right; the field was
     wrong about it. */
  it('says the address was reached when it was the credentials that were refused', () => {
    expect(said({ status: 401 })).toEqual({ word: 'reached', tone: 'ok' })
  })

  it('is loud about an address that answered and is not a database', () => {
    expect(said({ status: 502, kind: 'not_clickhouse' })).toEqual({
      word: 'not ClickHouse',
      tone: 'no',
    })
  })

  it('says no answer only when nothing answered', () => {
    expect(said({ status: 502 })).toEqual({ word: 'no answer', tone: 'plain' })
    expect(said({})).toEqual({ word: 'no answer', tone: 'plain' })
  })
})

describe('reached', () => {
  it('reads a round trip', () => {
    expect(reached(12)).toBe('reached in 12 ms')
  })

  /* Faster than the clock is not a failed measurement, and `0 ms` reads as one. */
  it('does not report a sub-millisecond trip as zero', () => {
    expect(reached(0)).toBe('reached in <1 ms')
  })

  it('switches to seconds when milliseconds stop reading', () => {
    expect(reached(2400)).toBe('reached in 2.4 s')
  })
})
