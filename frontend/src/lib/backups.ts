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
