import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../lib/api'
import { bytes, count, relativeTime } from '../lib/format'
import { withoutTrace } from '../lib/attention'
import {
  logReach,
  restorable,
  says,
  saysElsewhere,
  throughFlint,
  tookACopy,
  tooShortToBeQuiet,
  whyNotRestorable,
  type BackupRun,
} from '../lib/backups'
import { allows } from '../lib/spaces'
import { EmptyNote, ErrorNote, Loading } from '../components/Note'

/** Infrastructure — Backups.
 *
 *  What this server has been asked to back up or restore. Two tables can answer
 *  that and they answer differently: `system.backups` is in memory and lost on
 *  restart, `system.backup_log` is written to disk and is not. Flint reads the
 *  log where there is one — measured at 24 rows going back two days, across a
 *  container restart that emptied the in-memory table completely — and the page's
 *  own heading changes with it, because "since this server started" is true of
 *  one and a needless disclaimer on the other.
 *
 *  Neither is a catalogue. A backup disk cannot be listed from SQL at all —
 *  `filesystem()` is confined to `user_files` and answers code 291 for anything
 *  else — so a file deleted by hand is still in this list, and the page says so
 *  rather than offering a restore as a promise.
 *
 *  Taking one is on the Schema page, beside the object it would copy — an action
 *  a screen away from the thing it acts on gets used without looking at it. */
export function BackupsPage() {
  const config = useQuery({ queryKey: ['config'], queryFn: () => api.config() })
  /* Restoring writes data. Taking a backup does not, and lives a tier below —
     the tier line is data loss, and a restore into an absence is the one write
     here that could overwrite if it were ever aimed wrong. */
  const may = allows(config.data?.tier, 'admin')
  const report = useQuery({
    queryKey: ['backups'],
    queryFn: () => api.backups(),
    // A backup in progress is a moving thing.
    refetchInterval: 5_000,
    placeholderData: (prev) => prev,
  })
  /* Asked separately, and not on the five-second refresh: it scans a week of
     `system.query_log`, and what it is looking for happens once a night. */
  const elsewhere = useQuery({
    queryKey: ['backups', 'elsewhere', 7],
    queryFn: () => api.backupsElsewhere(7),
  })
  const data = report.data
  const runs = data?.runs ?? []

  return (
    <div className="page page--diagnose">
      <header className="page__head">
        <p className="eyebrow">INFRASTRUCTURE</p>
        <div className="page__titlerow">
          <h1 className="page__title page__title--hero">Backups taken and read back</h1>
        </div>
      </header>

      <section className="diag">
        <header className="diag__head">
          <h2 className="diag__title">
            {report.data?.persistent ? 'What this server has been asked' : 'Since this server started'}
          </h2>
          <p className="diag__sub">
            {report.data?.persistent ? (
              <>
                From <code>system.backup_log</code>, which is written to disk and survives a
                restart — one row per state change, so what you see is the last one for each
                backup.
              </>
            ) : (
              <>
                From <code>system.backups</code>, which the server keeps in memory and loses on
                restart, so a backup older than this server&apos;s uptime is on the disk and not
                here. <code>system.backup_log</code> would survive a restart; it is switched off
                on this server.
              </>
            )}{' '}
            Either way it is a record of what was asked for and not a list of what exists: a
            backup whose file has since been deleted is here and not on the disk. A backup disk
            cannot be listed from SQL, so a restore offered below is Flint trusting this record;
            if the file is gone, the job fails with the server saying so.
          </p>
        </header>

        {report.isPending ? <Loading label="Reading the backup log" /> : null}
        {report.error ? <ErrorNote error={report.error} retry={() => report.refetch()} /> : null}
        {data && !data.available ? (
          <EmptyNote title="Not available here">{data.reason}.</EmptyNote>
        ) : null}

        {data?.available && !data.disk ? (
          <EmptyNote title="No destination configured">
            ClickHouse refuses <code>BACKUP … TO Disk(…)</code> unless the server sanctions the
            disk, and Flint cannot read that setting. Name the disk in{' '}
            <code>FLINT_BACKUP_DISK</code> and the Schema page will offer to back things up.
          </EmptyNote>
        ) : null}

        {data?.available && data.disk ? (
          <p className="diag__sub">
            Flint writes to <code>{data.disk}</code>. A backup on the same machine as the data is
            not a backup — whether that disk is somewhere else is not something Flint can check.
          </p>
        ) : null}

        {data?.available && runs.length === 0 ? (
          <p className="diag__quiet">
            Nothing has been backed up or restored since this server started.
          </p>
        ) : null}

        {runs.length ? (
          <table className="tbl">
            <thead>
              <tr>
                <th>Destination</th>
                <th>State</th>
                <th>Asked</th>
                <th className="tbl--n">Files</th>
                <th className="tbl--n">Size</th>
                <th>Was of</th>
                <th>Notes</th>
                {may ? <th className="bk__cell">Restore</th> : null}
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const verdict = says(r.status)
                return (
                  <tr key={r.id}>
                    <td className="tbl__key">{r.name}</td>
                    <td>
                      <span className={`flag flag--job-${verdict.level}`}>{verdict.label}</span>
                    </td>
                    <td className="mono-dim">
                      {relativeTime(r.started_at)}
                      {throughFlint(r) ? (
                        <span className="chg__via">through Flint</span>
                      ) : null}
                    </td>
                    <td className="tbl--n">{count(r.files)}</td>
                    <td className="tbl--n mono-dim">{bytes(r.total_size)}</td>
                    {/* Dropped rather than dashed where Flint cannot know: a
                        backup somebody took in a terminal has a file and no
                        recoverable source. */}
                    <td className="mono-dim">{r.target}</td>
                    <td className="mono-dim">
                      {r.error ? (
                        <span className="says says--throw" title={r.error}>
                          {withoutTrace(r.error)}
                        </span>
                      ) : null}
                    </td>
                    {may ? (
                      <td className="bk__cell">
                        <Restore run={r} />
                      </td>
                    ) : null}
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : null}
      </section>

      <Elsewhere query={elsewhere} />
    </div>
  )
}

/** What backed this server up that was not this server.
 *
 *  The section exists because the one above it is narrower than it looks. Both
 *  `system.backups` and `system.backup_log` record a single thing — this
 *  server's own `BACKUP` statement — and a great deal of ClickHouse is backed up
 *  by something that never issues it: Altinity's `clickhouse-backup`, which
 *  freezes the tables and copies the hardlinks out to object storage; a volume
 *  snapshot taken underneath the disk; a replica in another rack. On those
 *  servers the table above is empty and every archive is fine, and a page that
 *  left it at that would be telling somebody with working backups that they have
 *  none.
 *
 *  What it shows is evidence and not a catalogue, and the wording never crosses
 *  that line. Flint cannot list a backup disk, cannot reach a bucket, and has
 *  never seen one of these archives. It can see the freeze, because freezing is
 *  a statement and statements are logged — so it can say a copy was taken, when,
 *  and of what, and it says nothing about whether that copy reads back. */
function Elsewhere({ query }: { query: ReturnType<typeof useQuery<import('../lib/backups').Elsewhere>> }) {
  const e = query.data
  const said = saysElsewhere(e)
  return (
    <section className="diag">
      <header className="diag__head">
        <h2 className="diag__title">Taken by something that is not this server</h2>
        <p className="diag__sub">
          The list above is <code>BACKUP</code>, the statement. A tool such as{' '}
          <code>clickhouse-backup</code> never issues it — it freezes each table and copies the
          hardlinks out — and a volume snapshot happens below ClickHouse entirely. None of them
          writes a row above, and all of them are backups. Flint cannot see their archives: a
          backup disk cannot be listed from SQL and a bucket is not its to read. It can see the
          freeze, because freezing is a statement and statements are logged.
        </p>
      </header>

      {query.isPending ? <Loading label="Reading the query log" /> : null}
      {query.error ? <ErrorNote error={query.error} retry={() => query.refetch()} /> : null}

      {e && !e.available ? <EmptyNote title="Not available here">{e.reason}.</EmptyNote> : null}

      {e?.available && tookACopy(e) ? (
        <>
          <p className="diag__sub">{said}.</p>
          {e.objects.length ? (
            <p className="mono-dim">
              {e.objects.join(', ')}
              {/* Counts follow the list: a sample of eight standing silently for
                  two hundred would be the page under-reporting its own good
                  news. */}
              {e.total_objects > e.objects.length
                ? ` — showing ${e.objects.length} of ${e.total_objects}`
                : ''}
            </p>
          ) : null}
          {e.frozen_now > 0 && e.freezes > 0 ? (
            <p className="diag__quiet">
              {e.frozen_now} parts are frozen at this moment — a copy being taken now, or a
              shadow left behind and holding disk.
            </p>
          ) : null}
        </>
      ) : null}

      {e?.available && !tookACopy(e) ? (
        <p className="diag__quiet">
          Nothing froze a table in the {logReach(e.covered_hours)} the query log covers.
          {tooShortToBeQuiet(e)
            ? ' That is less than a day, so a copy taken nightly would not appear here either — this reading is as short as the log is.'
            : ' On a server backed up by a tool that freezes, one would have shown here.'}
        </p>
      ) : null}
    </section>
  )
}

/** Put back what a backup holds — into an absence, and nowhere else.
 *
 *  Offered only where four things hold: the backup succeeded, it was a backup
 *  rather than a restore, Flint knows what it was of, and that object is gone.
 *  Where one of them does not, the row says *which* — four reasons and four
 *  sentences, because "restore is unavailable" would be true of all of them and
 *  useful for none.
 */
function Restore({ run }: { run: BackupRun }) {
  const queryClient = useQueryClient()
  const act = useMutation({
    mutationFn: () => {
      const dot = run.target.indexOf('.')
      const database = run.target.slice(0, dot)
      const table = run.target.slice(dot + 1)
      // The file as ClickHouse spelled the destination back to us:
      // `Disk('backups', 'name.zip')`.
      const file = run.name.match(/,\s*'([^']+)'\s*\)/)?.[1] ?? ''
      return api.backupAction(database, table, file, 'restore')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backups'] })
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      queryClient.invalidateQueries({ queryKey: ['schema', 'objects'] })
    },
  })

  if (!restorable(run)) {
    const why = whyNotRestorable(run)
    return why ? <span className="says">{why}</span> : null
  }

  return (
    <span className="bk__act">
      <button className="btn" onClick={() => act.mutate()} disabled={act.isPending}>
        {act.isPending ? 'Restoring…' : 'Restore'}
      </button>
      {act.error ? (
        <span className="says says--throw">
          {act.error instanceof Error ? act.error.message : 'it was refused'}
        </span>
      ) : null}
    </span>
  )
}
