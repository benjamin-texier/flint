/** Backups, as the server records them.
 *
 *  `system.backups` is a log of what this server has been asked to do since it
 *  *started*. It is not a catalogue of what exists: it does not survive a restart,
 *  so a backup taken last week by a server restarted since is on the disk and not
 *  in this table. Saying "your backups" over it would have somebody conclude
 *  theirs had vanished, so nothing here calls it that. */

export interface BackupRun {
  id: string
  name: string
  status: string
  error: string
  started_at: string
  finished_at: string
  files: number
  total_size: number
  compressed_size: number
  query_id: string
  /** The object this backup was of. Only knowable for one Flint took —
   *  `system.backups` records the destination and not the source — so a backup
   *  somebody took in a terminal has a file and no target here. */
  target: string
  /** Whether that object is there now. */
  target_exists: boolean
}

export interface BackupReport {
  /** Whether this list survives a restart — `system.backup_log` does,
   *  `system.backups` does not, and the page's heading follows. */
  persistent: boolean
  /** Whether the destination is object storage, which decides the archive
   *  format: a zip is refused there and a tar-based one is not. */
  object_storage: boolean
  available: boolean
  reason?: string
  runs: BackupRun[]
  /** The disk Flint writes to, or empty where none is configured. */
  disk: string
}

/** How a run reads, and how loudly.
 *
 *  The server's own status words, kept: `BACKUP_CREATED` and `RESTORED` mean
 *  precise things and a paraphrase would be Flint disagreeing with the log it is
 *  quoting. Only the tone is Flint's. */
export function says(status: string): { label: string; level: 'busy' | 'ok' | 'bad' } {
  if (status.endsWith('_FAILED')) return { label: status.toLowerCase(), level: 'bad' }
  if (status === 'BACKUP_CREATED' || status === 'RESTORED') {
    return { label: status.toLowerCase(), level: 'ok' }
  }
  return { label: status.toLowerCase(), level: 'busy' }
}

/** Whether Flint asked for this one.
 *
 *  Read off the `query_id` the job runner sets, which ClickHouse carries into
 *  `system.backups` — so a backup somebody took in a terminal is honestly marked
 *  as not having come from here. */
export function throughFlint(run: BackupRun): boolean {
  return run.query_id.startsWith('flint-job-')
}

/** Whether a run is one somebody could restore from here.
 *
 *  Four things have to hold, and each is a separate way of being wrong: it has to
 *  have *succeeded* — a failed backup has no file — it has to be a backup rather
 *  than a restore, Flint has to know what it was of, and the object has to be
 *  gone. Mirrors `backups::restorable` in the backend, which refuses the same
 *  set; this only keeps the browser from drawing a button that would be refused.
 */
export function restorable(run: BackupRun): boolean {
  return run.status === 'BACKUP_CREATED' && run.target !== '' && !run.target_exists
}

/** Why a successful backup offers no restore — or null when it does, and null
 *  where the question does not arise.
 *
 *  Only two rows have something to explain, and each gets its own sentence rather
 *  than a shared "restore is unavailable", which would be true of both and useful
 *  for neither. A run that *failed* is not one of them: the Notes column already
 *  carries the server's own exception, and repeating "it failed" beside it would
 *  be Flint talking over ClickHouse. A restore is not one either — it was never a
 *  thing to restore from. */
export function whyNotRestorable(run: BackupRun): string | null {
  if (restorable(run) || run.status !== 'BACKUP_CREATED') return null
  if (run.target === '') return 'Flint did not take this one, so it cannot tell which table it holds'
  return `${run.target} is still there`
}

/** A name for a backup file that says what it is and when.
 *
 *  Suggested, not imposed: a backup nobody can find again is not one, and
 *  `backup_3.zip` is how that happens. */
export function suggestName(
  database: string,
  table: string,
  at: Date,
  objectStorage = false,
): string {
  const day = at.toISOString().slice(0, 10)
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_')
  // The extension follows the destination, because it is not a preference: a
  // zip on an object-storage disk is refused by the server outright — zip needs
  // seeking and S3 does not do that efficiently — and a tar-based archive is
  // not. Measured against a real MinIO.
  const ext = objectStorage ? 'tar.gz' : 'zip'
  // A whole database has no table in its name, and `db--2026-08-27.zip` reads
  // as a mistake.
  const of = table ? `${safe(database)}-${safe(table)}` : safe(database)
  return `${of}-${day}.${ext}`
}

/** Evidence that something *other than this server* took a copy.
 *
 *  `system.backups` answers one question — what this server's own `BACKUP`
 *  statement did — and a page that reads "no backup has been taken" over an
 *  empty one is answering a much larger question it never asked. Altinity's
 *  `clickhouse-backup` freezes the tables and copies the hardlinks out; a volume
 *  snapshot happens underneath the disk; a replica sits in another rack. None of
 *  them writes a row there, and all of them are backups.
 *
 *  What the backend can measure is the freeze on its way past, because freezing
 *  is a statement and statements are logged. So this is evidence and not a
 *  catalogue: it can say *something took a copy, at 02:14, of 41 tables* and it
 *  can never say that copy is readable. */
export interface Elsewhere {
  available: boolean
  reason?: string
  /** How far back the query log reaches, in hours. Every sentence below is
   *  bounded by it, and the short ones are the point: a log holding nine hours
   *  has nothing to say about a backup that runs at 02:00. */
  covered_hours: number
  freezes: number
  last_freeze: string
  users: string[]
  objects: string[]
  total_objects: number
  frozen_now: number
}

/** The window, in words, in whatever unit does not lie about its precision. */
export function logReach(hours: number): string {
  if (hours >= 48) return `${Math.round(hours / 24)} days`
  if (hours >= 2) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} hours`
  return `${Math.max(1, Math.round(hours * 60))} minutes`
}

/** Whether the log holds evidence that something took a copy.
 *
 *  Either mark counts. A freeze in the window is the ordinary one; parts frozen
 *  *now* is a backup in flight, which a page refreshing every few seconds will
 *  catch on a server whose log was trimmed a minute ago. */
export function tookACopy(e?: Elsewhere): boolean {
  return !!e && e.available && (e.freezes > 0 || e.frozen_now > 0)
}

/** Whether the window is too short to be quiet in.
 *
 *  A backup that runs nightly leaves nothing in a log that reaches back nine
 *  hours, and "nothing froze anything" over such a window is not a finding about
 *  the backups — it is a finding about the log. Below a day, every negative
 *  sentence on this subject has to say so. */
export function tooShortToBeQuiet(e?: Elsewhere): boolean {
  return !e || !e.available || e.covered_hours < 24
}

/** What the evidence supports saying, or null where it supports nothing.
 *
 *  Deliberately hedged in the same breath as it reassures: the copy is real, the
 *  archive is not something Flint has seen. Anything shorter would be this page
 *  promising a restore it cannot check. */
export function saysElsewhere(e?: Elsewhere): string | null {
  if (!tookACopy(e)) return null
  const it = e as Elsewhere
  if (it.freezes === 0) {
    return `${it.frozen_now} parts are frozen right now — something is taking a copy as you read this`
  }
  const of =
    it.total_objects > 0
      ? ` of ${it.total_objects} object${it.total_objects === 1 ? '' : 's'}`
      : ''
  const by = it.users.length ? `, as ${it.users.join(', ')}` : ''
  return `${it.freezes} freeze${it.freezes === 1 ? '' : 's'}${of}${by}, the last at ${it.last_freeze} — how a tool such as clickhouse-backup takes one, over the ${logReach(it.covered_hours)} the query log covers`
}
