import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../lib/api'
import { bytes, count, duration, exact, relativeTime } from '../lib/format'
import {
  compressionVerdict,
  diskVerdict,
  notable,
  partitionVerdict,
  percent,
  progressOf,
  usableFree,
  type ActivityReport,
  type Disk as DiskInfo,
  type PartitionLoad,
  type Running as RunningQuery,
  type StorageReport,
} from '../lib/diagnose'
import { Flag, Says, Section, SectionIndex, type Q } from '../components/Diag'
import { allows } from '../lib/spaces'
import { MetricLine } from '../components/MetricLine'
import { Operations } from '../components/Operations'
import { OverTime } from '../components/OverTime'
import { Dictionaries } from '../components/Dictionaries'
import { Pressure } from '../components/Pressure'
import { Trace } from '../components/Trace'
import { WatchedHere } from '../components/WatchedHere'
import { Errors } from '../components/Errors'
import { Merges } from '../components/Merges'
import { DetachedParts } from '../components/DetachedParts'
import { ServerLog } from '../components/ServerLog'
import { EmptyNote } from '../components/Note'
import { ShareBar, StratumBar } from '../components/StratumBar'

/** Infrastructure — Health: what the server is doing, and what it is sitting on.
 *
 *  The other half of what used to be one Diagnose page. The line between them is
 *  the line between the two spaces: a slow statement is something somebody
 *  wrote and can rewrite, so it belongs to Data; a merge backlog, a disk filling
 *  up and a partition count are the server's own condition, and reading them is
 *  the beginning of operating it.
 *
 *  No window control here, unlike the Data page. Every section on it is either
 *  "right now" — running queries, merges, mutations — or a present-tense fact
 *  about bytes on disk. Offering "last 30 days" above figures that have no
 *  window would be a control that changes nothing, which is worse than no
 *  control. */
export function HealthPage() {
  const storage = useQuery({
    queryKey: ['diag', 'storage'],
    queryFn: () => api.diagnoseStorage(),
    staleTime: 30_000,
  })
  const activity = useQuery({
    queryKey: ['diag', 'activity'],
    queryFn: () => api.diagnoseActivity(),
    // This one is "right now", so it keeps asking.
    refetchInterval: 5_000,
    placeholderData: (prev) => prev,
  })

  /* When a role is granted neither, two copies of the same sentence is noise.
     One banner naming each distinct obstacle says more and reads once; mixed
     grants keep the per-section notes, which is where they belong. */
  const reports = [storage.data, activity.data]
  const loaded = reports.filter((r) => r !== undefined)
  const shutOut = loaded.length === reports.length && loaded.every((r) => r && !r.available)
  const obstacles = [...new Set(loaded.map((r) => r?.reason).filter(Boolean))] as string[]

  /* What this deployment permits. Read here and passed down, so a control that
     the tier forbids is never drawn — rather than drawn and then refused, which
     teaches people to distrust the buttons. The backend checks the same tier
     again: hiding it is a courtesy, not the enforcement. */
  const config = useQuery({ queryKey: ['config'], queryFn: () => api.config() })
  const mayOptimize = allows(config.data?.tier, 'ddl')
  /* Dropping a partition deletes rows with nothing to undo it, so it needs the
     tier that operates the server rather than the one that reshapes a schema. */
  const mayDrop = allows(config.data?.tier, 'admin')

  return (
    <div className="page page--diagnose">
      <header className="page__head">
        <p className="eyebrow">Infrastructure · Health</p>
        <div className="page__titlerow">
          <h1 className="page__title page__title--hero">What the server is doing</h1>
        </div>
      </header>

      <Standing activity={activity.data} />

      {/* After the figures, before the sections: the headline numbers are the
          answer somebody came for, and the index is the way to the rest. */}
      <SectionIndex />

      <Operations space="infra" />

      {/* Outside the shut-out branch, for the reason Diagnose's own watching
          panel is: alerts come from Flint's workspace rather than from
          `system.*`, so a role denied the system tables has not lost them.
          Vanishing with everything else would tell somebody their alerts were
          unreadable when they were fine. */}
      <WatchedHere />

      {shutOut ? (
        <ShutOut obstacles={obstacles} />
      ) : (
        <>
          <RightNow activity={activity} />
          {/* What is running, then how much room is left to run it in, then over
              time, then what the server said about it: the questions in the
              order somebody asks them. */}
          <Pressure />
          <Dictionaries />
          <OverTime />
          {/* After the history, because it answers the question the history
              raises: the graph says the processor was busy, this says on what. */}
          <Trace />
          <Merges />
          <Errors />
          <ServerLog />
          <Storage report={storage} />
          <DetachedParts />
          <Partitions report={storage} mayOptimize={mayOptimize} mayDrop={mayDrop} />
        </>
      )}
    </div>
  )
}

/** The whole page, denied.
 *
 *  A read-only role is the common case and this is not its fault: naming the
 *  grant that would fix it turns a dead end into an instruction. */
export function ShutOut({ obstacles }: { obstacles: string[] }) {
  return (
    <div className="note note--empty diag__shutout">
      <p className="note__title">This role cannot see the server's own tables</p>
      <p className="note__hint">
        Diagnostics read `system.*` and nothing else. Every section here needs a grant this user
        does not have:
      </p>
      <ul className="diag__obstacles">
        {obstacles.map((o) => (
          <li key={o}>{o}</li>
        ))}
      </ul>
      <p className="note__hint">
        A read-only role is welcome to all of it — `GRANT SELECT ON system.* TO your_user` reads
        nothing of your data.
      </p>
    </div>
  )
}

// ── Right now ──────────────────────────────────────────────────────────────

function RightNow({ activity }: { activity: Q<ActivityReport> }) {
  const data = activity.data
  const denied = new Set(data?.denied ?? [])
  const quiet =
    data?.available &&
    !data.merges.length &&
    !data.mutations.length &&
    !data.running.length &&
    !denied.has('processes')

  return (
    <Section
      title="Right now"
      sub="Live, refreshed every five seconds."
      q={activity}
    >
      {quiet ? (
        /* The healthy answer, said out loud. An empty box leaves the reader
           wondering whether the question was even asked. */
        <p className="diag__quiet">Nothing running, nothing merging, no mutations pending.</p>
      ) : null}

      {/* Named rather than shown as empty: "nothing is running" and "you may
          not see what is running" are different answers. */}
      {[...denied].map((what) => (
        <p className="says says--watch" key={what}>
          This user is not granted SELECT on system.{what}, so that list is missing rather than
          empty.
        </p>
      ))}

      {data?.running.length ? <Running running={data.running} /> : null}

      {data?.merges.length ? (
        <table className="tbl">
          <thead>
            <tr>
              <th>Merging</th>
              <th className="tbl--n">Parts</th>
              <th className="tbl--n">Size</th>
              <th className="tbl--n">Elapsed</th>
              <th className="tbl__bar">Progress</th>
            </tr>
          </thead>
          <tbody>
            {data.merges.map((m) => (
              <tr key={m.result}>
                <td className="tbl__key">
                  {m.qualified}
                  {m.is_mutation ? <Flag level="watch">mutation</Flag> : null}
                </td>
                <td className="tbl--n">{m.num_parts}</td>
                <td className="tbl--n mono-dim">{bytes(m.bytes)}</td>
                <td className="tbl--n mono-dim">{m.elapsed.toFixed(1)} s</td>
                <td className="tbl__bar">
                  <ShareBar value={m.progress} max={1} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {data?.disks.length ? <Disks disks={data.disks} /> : null}

      {data?.mutations.length ? (
        <table className="tbl">
          <thead>
            <tr>
              <th>Unfinished mutation</th>
              <th>Command</th>
              <th className="tbl--n">Parts left</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {data.mutations.map((m) => (
              <tr key={m.qualified + m.mutation_id}>
                <td className="tbl__key">{m.qualified}</td>
                <td>
                  <code className="mono-dim">{m.command}</code>
                  {/* The reason a mutation is stuck appears nowhere else in the
                      UI, and it is the only thing worth knowing about it. */}
                  {m.fail_reason ? (
                    <span className="says says--throw">{m.fail_reason}</span>
                  ) : null}
                </td>
                <td className="tbl--n">{exact(m.parts_to_do)}</td>
                <td className="mono-dim">{relativeTime(m.created)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Section>
  )
}

/** What is executing this instant. The first thing anybody reaches for when a
 *  server is misbehaving, and the only view that can answer "what is doing
 *  this". Flint's own introspection is excluded server-side — a list that is
 *  mostly Flint looking at Flint answers nothing. */
function Running({ running }: { running: RunningQuery[] }) {
  const client = useQueryClient()
  const [killing, setKilling] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  const kill = async (id: string) => {
    setKilling(id)
    setFailed(null)
    try {
      const out = await api.killQuery(id)
      if (!out.matched) setFailed('That query had already finished.')
      await client.invalidateQueries({ queryKey: ['diag', 'activity'] })
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e))
    } finally {
      setKilling(null)
    }
  }

  return (
    <>
      <h3 className="diag__sub2">
        {running.length} running {running.length === 1 ? 'query' : 'queries'}
      </h3>
      {failed ? <p className="says says--watch">{failed}</p> : null}
      <table className="tbl">
        <thead>
          <tr>
            <th>Query</th>
            <th className="tbl--n">For</th>
            <th className="tbl--n">Read</th>
            <th className="tbl--n">Memory</th>
            <th className="tbl__bar">Progress</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {running.map((q) => {
            const share = progressOf(q)
            return (
              <tr key={q.query_id} className={notable(q) ? 'is-open' : undefined}>
                <td className="tbl__key">
                  <code className="diag__sql">{q.query.replace(/\s+/g, ' ').trim()}</code>
                  <span className="says">
                    {q.user}
                    {q.database ? ` · ${q.database}` : ''}
                    {q.cancelled ? ' · cancelling' : ''}
                  </span>
                </td>
                <td className="tbl--n mono-dim">{duration(q.elapsed)}</td>
                <td className="tbl--n mono-dim">{bytes(q.read_bytes)}</td>
                <td className="tbl--n mono-dim">{bytes(q.memory)}</td>
                <td className="tbl__bar">
                  {/* Absent rather than a bar at zero: ClickHouse does not
                      always know the total, and a bar would claim it does. */}
                  {share === null ? (
                    <span className="dash">unknown</span>
                  ) : (
                    <>
                      <span className="diag__share">{percent(share)}</span>
                      <ShareBar value={share} max={1} />
                    </>
                  )}
                </td>
                <td>
                  <button
                    className="btn"
                    onClick={() => kill(q.query_id)}
                    disabled={killing === q.query_id || q.cancelled}
                    title="Stop this query. It destroys no data."
                  >
                    {killing === q.query_id ? 'Stopping…' : 'Stop'}
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </>
  )
}

/** Free space: the incident nobody sees coming. */
/** The figures a reader wants before reading anything: what is running, and how
 *  close the disks are to full.
 *
 *  Only what this page already fetched — a headline that needed its own request
 *  would be a headline that can be wrong while the page below it is right. The
 *  fullest disk is the one figure that takes a colour, because it is the only
 *  one here that can become an incident. */
function Standing({ activity }: { activity?: ActivityReport }) {
  if (!activity?.available) return null
  const disks = activity.disks ?? []
  const fullest = disks.reduce<DiskInfo | null>(
    (worst, d) =>
      !worst || usableFree(d) / Math.max(1, d.total) < usableFree(worst) / Math.max(1, worst.total)
        ? d
        : worst,
    null,
  )
  const used = fullest
    ? Math.round(((fullest.total - usableFree(fullest)) / Math.max(1, fullest.total)) * 100)
    : null
  const level = fullest ? diskVerdict(fullest).level : 'ok'

  return (
    <MetricLine
      metrics={[
        { value: exact(activity.running?.length ?? 0), label: 'queries running' },
        { value: exact(activity.merges?.length ?? 0), label: 'merges' },
        { value: exact(activity.mutations?.length ?? 0), label: 'mutations' },
        ...(used !== null
          ? [
              {
                value: String(used),
                unit: '%',
                label: 'fullest disk',
                level,
              },
            ]
          : []),
        { value: exact(disks.length), label: disks.length === 1 ? 'disk' : 'disks' },
      ]}
    />
  )
}

function Disks({ disks }: { disks: DiskInfo[] }) {
  return (
    <>
      <h3 className="diag__sub2">Disks</h3>
      <table className="tbl tbl--disks">
        <thead>
          <tr>
            <th>Disk</th>
            <th className="tbl__bar">Used</th>
            <th className="tbl--n">Share</th>
            <th className="tbl--n">Free</th>
            <th className="tbl--n">Of</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {disks.map((disk) => {
            const verdict = diskVerdict(disk)
            const free = usableFree(disk)
            const share = Math.round(((disk.total - free) / Math.max(1, disk.total)) * 100)
            return (
              <tr key={disk.name}>
                <td className="tbl__key">
                  {disk.name}
                  <span className="says">{disk.path}</span>
                </td>
                <td className="tbl__bar">
                  <ShareBar
                    value={Math.max(0, disk.total - free)}
                    max={Math.max(1, disk.total)}
                    level={verdict.level}
                  />
                </td>
                {/* The bar shows the proportion and the figure lets somebody
                    quote it. A bar alone is a shape nobody can put in a
                    message. */}
                <td className={`tbl--n mono${verdict.level === 'ok' ? '-dim' : ''}`}>{share}%</td>
                <td className="tbl--n mono-dim">{bytes(free)}</td>
                <td className="tbl--n mono-dim">{bytes(disk.total)}</td>
                <td>
                  <Says verdict={verdict} />
                  {verdict.level === 'ok' ? <span className="mono-dim">{verdict.says}</span> : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </>
  )
}

/** Server-lifetime error counters. Some of these never reach `query_log`
 *  because nothing failed a query — they are the noise a server makes, and a
 *  rising one is a lead. */

// ── Storage ────────────────────────────────────────────────────────────────

function Storage({ report }: { report: Q<StorageReport> }) {
  const rows = report.data?.tables ?? []

  return (
    <Section
      title="What it costs on disk"
      sub="Point in time, from active parts. The outline is the data uncompressed, the fill is what it actually occupies."
      q={report}
    >
      {rows.length ? (
        <table className="tbl">
          <thead>
            <tr>
              <th>Table</th>
              <th className="tbl--n">Rows</th>
              <th className="tbl--n">On disk</th>
              <th className="tbl--n">Ratio</th>
              <th className="tbl--n">Parts</th>
              <th className="tbl--n">Partitions</th>
              <th className="tbl__bar">Compression</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const verdict = compressionVerdict(t.ratio)
              return (
                <tr key={t.qualified}>
                  <td className="tbl__key">{t.qualified}</td>
                  <td className="tbl--n">{count(t.row_count)}</td>
                  <td className="tbl--n mono-dim">{bytes(t.compressed)}</td>
                  <td className="tbl--n">
                    {t.ratio.toFixed(t.ratio < 10 ? 1 : 0)}×
                    <Says verdict={verdict} />
                  </td>
                  <td className="tbl--n mono-dim">{t.parts}</td>
                  <td className="tbl--n mono-dim">{t.partitions}</td>
                  <td className="tbl__bar">
                    {/* Scaled to this row's own raw size, so the fill reads as
                        "what is left after compression" and two tables of very
                        different sizes stay comparable. Against the largest
                        table instead, every small row is one invisible pixel. */}
                    <StratumBar
                      compressed={t.compressed}
                      uncompressed={t.uncompressed}
                      max={Math.max(1, t.uncompressed)}
                      title={`${bytes(t.compressed)} on disk, ${bytes(t.uncompressed)} raw`}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : (
        <EmptyNote title="Nothing stored">No active parts in any user database.</EmptyNote>
      )}
    </Section>
  )
}

// ── Partitions ─────────────────────────────────────────────────────────────

/** Everything that can be done to one partition, one strip at a time.
 *
 *  `Merge` answers the part count the row is already showing. The rest —
 *  freeze, detach, drop — are lifecycle operations somebody arrives intending to
 *  perform. Both belong on this row, because this is the only place partitions
 *  are listed and an action a screen away from the figures that justify it gets
 *  used without them.
 *
 *  One mode at a time, and not for tidiness: two independent control groups in a
 *  254px table cell wrapped it to three lines and knocked the whole row out of
 *  alignment — measured at 33px folded and 113px with a confirmation open. They
 *  are alternatives at any given moment, so the strip shows one of them.
 *
 *  `Drop` is two steps behind a fold, so that deleting a partition is never one
 *  careless click from a page people open to read.
 */
function RowActions({ row, mayDrop }: { row: PartitionLoad; mayDrop: boolean }) {
  const [mode, setMode] = useState<'idle' | 'merge' | 'partition' | 'drop'>('idle')
  const queryClient = useQueryClient()

  const settle = () => {
    setMode('idle')
    queryClient.invalidateQueries({ queryKey: ['jobs'] })
    queryClient.invalidateQueries({ queryKey: ['diag', 'storage'] })
    queryClient.invalidateQueries({ queryKey: ['parts', 'detached'] })
  }

  const merge = useMutation({
    mutationFn: (finalPass: boolean) => api.optimize(row.database, row.table, finalPass),
    onSuccess: settle,
  })
  const act = useMutation({
    mutationFn: (action: string) =>
      api.partitionAction(row.database, row.table, row.partition_id, action),
    onSuccess: settle,
  })
  const busy = merge.isPending || act.isPending
  const failure = merge.error ?? act.error

  if (mode === 'idle') {
    return (
      <div className="pacts">
        <button className="btn" onClick={() => setMode('merge')} disabled={busy}>
          {busy ? 'Working…' : 'Merge'}
        </button>
        <button className="btn" onClick={() => setMode('partition')} disabled={busy}>
          Partition…
        </button>
        {failure ? <Refused error={failure} /> : null}
      </div>
    )
  }

  if (mode === 'merge') {
    return (
      <div className="pacts">
        <span className="pacts__cost pacts__cost--plain">rewrites {bytes(row.bytes)}</span>
        <button className="btn" onClick={() => merge.mutate(false)} disabled={busy}>
          Merge parts
        </button>
        <button
          className="btn btn--spark"
          onClick={() => merge.mutate(true)}
          disabled={busy}
          title="FINAL merges every part in the partition into one. The thorough version, and the expensive one."
        >
          …to one part
        </button>
        <button className="btn" onClick={() => setMode('idle')}>
          Cancel
        </button>
      </div>
    )
  }

  if (mode === 'drop') {
    return (
      <div className="pacts">
        {/* Short enough to sit on one line beside the buttons — the strip
            wrapped at the longer wording, and a confirmation that reflows the
            table row it lives in reads as a glitch rather than a question. */}
        <span className="pacts__cost">
          {count(row.row_count)} rows, {bytes(row.bytes)} — for good
        </span>
        <button className="btn" onClick={() => act.mutate('drop')} disabled={busy}>
          Drop it
        </button>
        <button className="btn" onClick={() => setMode('partition')}>
          Keep it
        </button>
      </div>
    )
  }

  return (
    <div className="pacts">
      <button
        className="btn"
        onClick={() => act.mutate('freeze')}
        disabled={busy}
        title="Hard-link a copy into shadow/. Costs no space until these parts are merged away — but SYSTEM UNFREEZE is disabled on most servers, so removing the copy means deleting the directory on the machine."
      >
        Freeze
      </button>
      <button
        className="btn"
        onClick={() => act.mutate('detach')}
        disabled={busy}
        title="Take it out of the table. The data stays in detached/, and the Detached parts section can put it back."
      >
        Detach
      </button>
      {mayDrop ? (
        <button className="btn" onClick={() => setMode('drop')} disabled={busy}>
          Drop
        </button>
      ) : null}
      <button className="btn" onClick={() => setMode('idle')}>
        Cancel
      </button>
    </div>
  )
}

/** Why it did not happen, next to the button that tried. */
function Refused({ error }: { error: unknown }) {
  return (
    <span className="pacts__error">
      {error instanceof Error ? error.message : 'it was refused'}
    </span>
  )
}

function Partitions({
  report,
  mayOptimize,
  mayDrop,
}: {
  report: Q<StorageReport>
  mayOptimize: boolean
  mayDrop: boolean
}) {
  const rows = report.data?.partitions ?? []
  const t = report.data?.thresholds
  const worst = rows[0]?.parts ?? 0

  return (
    <Section
      title="Parts per partition"
      sub={
        t
          ? `ClickHouse slows inserts at ${exact(t.delay_insert)} parts in one partition and refuses them at ${exact(t.throw_insert)}${t.from_server ? '' : ' (defaults — this server would not say)'}.`
          : undefined
      }
      q={report}
    >
      {rows.length && t && partitionVerdict(worst, t).level === 'ok' ? (
        <p className="diag__quiet">
          Nothing is close to the limit — the busiest partition holds {worst} of{' '}
          {exact(t.delay_insert)} parts.
        </p>
      ) : null}
      {rows.length && t ? (
        <table className="tbl">
          <thead>
            <tr>
              <th>Table</th>
              <th>Partition</th>
              <th className="tbl--n">Parts</th>
              <th className="tbl--n">Rows</th>
              <th className="tbl--n">Avg part</th>
              <th className="tbl__bar">Against the limit</th>
              {mayOptimize ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const verdict = partitionVerdict(p.parts, t)
              return (
                <tr key={p.qualified + p.partition}>
                  <td className="tbl__key">{p.qualified}</td>
                  <td className="mono-dim">
                    {p.partition === 'tuple()' ? (
                      <span className="dash">not partitioned</span>
                    ) : (
                      p.partition
                    )}
                  </td>
                  <td className="tbl--n">
                    {p.parts}
                    <Says verdict={verdict} />
                  </td>
                  <td className="tbl--n">{count(p.row_count)}</td>
                  <td className="tbl--n mono-dim">{bytes(p.avg_part)}</td>
                  <td className="tbl__bar">
                    <ShareBar value={p.parts} max={Math.max(worst, t.delay_insert)} />
                  </td>
                  {mayOptimize ? (
                    <td className="tbl--n">
                      <RowActions row={p} mayDrop={mayDrop} />
                    </td>
                  ) : null}
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : null}
    </Section>
  )
}

