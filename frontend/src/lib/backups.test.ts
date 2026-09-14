import { describe, expect, it } from 'vitest'

import {
  logReach,
  restorable,
  says,
  saysElsewhere,
  suggestName,
  throughFlint,
  tooShortToBeQuiet,
  tookACopy,
  whyNotRestorable,
  type BackupRun,
  type Elsewhere,
} from './backups'

const run = (over: Partial<BackupRun> = {}): BackupRun => ({
  id: '533a3ddd-3dc0-41b0-98d2-b96a45d84320',
  name: "Disk('backups', 'events.zip')",
  status: 'BACKUP_CREATED',
  error: '',
  started_at: '2026-08-25 17:28:22',
  finished_at: '2026-08-25 17:28:22',
  files: 11,
  total_size: 4898,
  compressed_size: 6041,
  query_id: 'flint-job-abc',
  target: 'analytics.events',
  target_exists: false,
  ...over,
})

describe('says', () => {
  it("keeps the server's own words", () => {
    // `BACKUP_CREATED` and `RESTORED` mean precise things; paraphrasing them
    // would be Flint disagreeing with the log it is quoting.
    expect(says('BACKUP_CREATED')).toEqual({ label: 'backup_created', level: 'ok' })
    expect(says('RESTORED').level).toBe('ok')
    expect(says('BACKUP_FAILED').level).toBe('bad')
    expect(says('RESTORE_FAILED').level).toBe('bad')
  })

  it('treats anything still moving as busy rather than good', () => {
    expect(says('CREATING_BACKUP').level).toBe('busy')
    expect(says('RESTORING').level).toBe('busy')
    // A status this build has never heard of is not reported as success.
    expect(says('SOMETHING_NEW').level).toBe('busy')
  })
})

describe('throughFlint', () => {
  it('recognises what Flint asked for, and nothing else', () => {
    expect(throughFlint(run())).toBe(true)
    expect(throughFlint(run({ query_id: '8cfee2c2-6110-4049-9847-a7b88267a4f9' }))).toBe(false)
    expect(throughFlint(run({ query_id: '' }))).toBe(false)
  })
})

describe('suggestName', () => {
  it('says what it is and when', () => {
    // `backup_3.zip` is how a backup nobody can find again happens.
    expect(suggestName('analytics', 'events', new Date('2026-08-25T17:28:22Z'))).toBe(
      'analytics-events-2026-08-25.zip',
    )
  })

  it('makes an awkward name into a file name', () => {
    expect(suggestName('my db', 'a.b', new Date('2026-01-02T00:00:00Z'))).toBe(
      'my_db-a_b-2026-01-02.zip',
    )
  })
})

describe('restorable', () => {
  it('offers a restore only into an absence', () => {
    expect(restorable(run())).toBe(true)
    // Restoring over something is a different decision from putting back what
    // was lost, and the backend refuses it too.
    expect(restorable(run({ target_exists: true }))).toBe(false)
    expect(restorable(run({ status: 'BACKUP_FAILED' }))).toBe(false)
    expect(restorable(run({ status: 'RESTORED' }))).toBe(false)
    // A backup somebody took in a terminal: a file, and no way to aim it.
    expect(restorable(run({ target: '' }))).toBe(false)
  })
})

describe('whyNotRestorable', () => {
  it('says nothing when it can be restored', () => {
    expect(whyNotRestorable(run())).toBeNull()
  })

  it('gives each reason its own sentence', () => {
    expect(whyNotRestorable(run({ target: '' }))).toMatch(/did not take this one/)
    expect(whyNotRestorable(run({ target_exists: true }))).toBe('analytics.events is still there')
  })

  it('stays quiet where the question does not arise', () => {
    // A restore was never a thing to restore from, and a failure already has the
    // server's own exception in the column beside this one.
    expect(whyNotRestorable(run({ status: 'RESTORED' }))).toBeNull()
    expect(whyNotRestorable(run({ status: 'BACKUP_FAILED' }))).toBeNull()
  })
})

describe('suggestName', () => {
  const at = new Date('2026-08-27T09:00:00Z')

  it('names the day and the thing it is of', () => {
    expect(suggestName('analytics', 'events', at)).toBe('analytics-events-2026-08-27.zip')
  })

  it('follows the destination for the extension, because it is not a preference', () => {
    // A zip on object storage is refused by the server outright: zip needs
    // seeking and S3 does not do that efficiently. Measured against a MinIO.
    expect(suggestName('analytics', 'events', at, true)).toBe(
      'analytics-events-2026-08-27.tar.gz',
    )
  })

  it('leaves the table out of a whole-database name', () => {
    // `analytics--2026-08-27.zip` reads as a mistake.
    expect(suggestName('analytics', '', at)).toBe('analytics-2026-08-27.zip')
  })

  it('replaces what a file name cannot carry', () => {
    expect(suggestName('a b', 'c/d', at)).toBe('a_b-c_d-2026-08-27.zip')
  })
})

const elsewhere = (over: Partial<Elsewhere> = {}): Elsewhere => ({
  available: true,
  covered_hours: 168,
  freezes: 0,
  last_freeze: '',
  users: [],
  objects: [],
  total_objects: 0,
  frozen_parts: 0,
  ...over,
})

describe('logReach', () => {
  it('names the window in a unit that does not overstate it', () => {
    // Nine hours is the figure that matters most here — it is what a query log
    // trimmed daily holds by mid-morning — and rounding it to "0 days" or
    // dressing it as "9.72 hours" are both the reading lying about itself.
    expect(logReach(9.72)).toBe('9.7 hours')
    expect(logReach(168)).toBe('7 days')
    expect(logReach(0.5)).toBe('30 minutes')
    // Never zero of anything: a log holding two minutes holds two minutes.
    expect(logReach(0.004)).toBe('1 minutes')
  })
})

describe('tookACopy', () => {
  it('counts a freeze in the window and a part frozen right now', () => {
    /* Two marks, and the second one matters on a server whose query log was
       trimmed a minute ago: a backup in flight is visible in `system.parts`
       when the statement that started it is already gone from the log. */
    expect(tookACopy(elsewhere({ freezes: 12 }))).toBe(true)
    expect(tookACopy(elsewhere({ frozen_parts: 3 }))).toBe(true)
    expect(tookACopy(elsewhere())).toBe(false)
  })

  it('is not fooled by a log it could not read', () => {
    // "Flint may not look" is not "something took a copy", and it is not
    // "nothing did" either.
    expect(tookACopy(elsewhere({ available: false, freezes: 12 }))).toBe(false)
    expect(tookACopy(undefined)).toBe(false)
  })
})

describe('tooShortToBeQuiet', () => {
  it('treats a window under a day as unable to be silent', () => {
    /* A backup that runs at 02:00 leaves nothing in a log reaching back nine
       hours. Reporting that as "nothing froze anything" is a finding about the
       log dressed as a finding about the backups. */
    expect(tooShortToBeQuiet(elsewhere({ covered_hours: 9.7 }))).toBe(true)
    expect(tooShortToBeQuiet(elsewhere({ covered_hours: 168 }))).toBe(false)
    expect(tooShortToBeQuiet(undefined)).toBe(true)
  })
})

describe('saysElsewhere', () => {
  it('says a copy was taken, and never that an archive exists', () => {
    const said = saysElsewhere(
      elsewhere({
        freezes: 12,
        last_freeze: '2026-09-14 02:14:07',
        users: ['backup'],
        objects: ['analytics.events'],
        total_objects: 41,
        covered_hours: 168,
      }),
    )!
    expect(said).toContain('12 freeze statements')
    expect(said).toContain('41 objects')
    expect(said).toContain('backup')
    expect(said).toContain('2026-09-14 02:14:07')
    // The window it rests on travels with the sentence.
    expect(said).toContain('7 days')
    // And the tool that leaves this mark is named, because "something froze
    // your tables" is not a sentence anybody can go and check.
    expect(said).toContain('clickhouse-backup')
  })

  it('reads a freeze mark as undated, because that is what it is', () => {
    /* `is_frozen` survives its own `UNFREEZE` — measured on 26.7.1, where
       `SYSTEM UNFREEZE` is refused outright unless the server enables it — and
       clears only when a merge rewrites the part. It outlives the query log,
       which is why it is worth reading, and it carries no time at all, which is
       why it must never be printed as one. */
    const said = saysElsewhere(elsewhere({ frozen_parts: 3 }))!
    expect(said).toContain('3 parts')
    expect(said).toContain('no longer reaches back to say when')
    expect(said).not.toContain('right now')
  })

  it('supports nothing where there is nothing', () => {
    expect(saysElsewhere(elsewhere())).toBeNull()
    expect(saysElsewhere(undefined)).toBeNull()
  })
})
