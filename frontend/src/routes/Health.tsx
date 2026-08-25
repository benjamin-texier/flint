import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

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
  type ErrorCount as ErrorCounter,
  type Running as RunningQuery,
  type StorageReport,
} from '../lib/diagnose'
import { Flag, Says, Section, type Q } from '../components/Diag'
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

  return (
    <div className="page page--diagnose">
      <header className="page__head">
        <p className="eyebrow">INFRASTRUCTURE</p>
        <div className="page__titlerow">
          <h1 className="page__title page__title--hero">What the server is doing</h1>
        </div>
      </header>

      {shutOut ? (
        <ShutOut obstacles={obstacles} />
      ) : (
        <>
          <RightNow activity={activity} />
          <Storage report={storage} />
          <Partitions report={storage} />
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
      sub="Live, refreshed every five seconds — not the window above."
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
      {data?.errors.length ? <Errors errors={data.errors} /> : null}
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
function Disks({ disks }: { disks: DiskInfo[] }) {
  return (
    <>
      <h3 className="diag__sub2">Disks</h3>
      <table className="tbl">
        <thead>
          <tr>
            <th>Disk</th>
            <th className="tbl--n">Free</th>
            <th className="tbl--n">Of</th>
            <th className="tbl__bar">Used</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {disks.map((disk) => {
            const verdict = diskVerdict(disk)
            const free = usableFree(disk)
            return (
              <tr key={disk.name}>
                <td className="tbl__key">
                  {disk.name}
                  <span className="says">{disk.path}</span>
                </td>
                <td className="tbl--n mono-dim">{bytes(free)}</td>
                <td className="tbl--n mono-dim">{bytes(disk.total)}</td>
                <td className="tbl__bar">
                  <ShareBar value={Math.max(0, disk.total - free)} max={Math.max(1, disk.total)} />
                </td>
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
function Errors({ errors }: { errors: ErrorCounter[] }) {
  return (
    <>
      <h3 className="diag__sub2">Errors the server has counted</h3>
      <p className="diag__sub">
        Since it started, not in the window above — and not only from queries, so some of these
        appear nowhere else.
      </p>
      <table className="tbl">
        <thead>
          <tr>
            <th>Error</th>
            <th className="tbl--n">Times</th>
            <th>Last</th>
            <th>Message</th>
          </tr>
        </thead>
        <tbody>
          {errors.map((e) => (
            <tr key={`${e.code}-${e.name}`}>
              <td className="tbl__key">{e.name}</td>
              <td className="tbl--n">{count(e.count)}</td>
              <td className="mono-dim">{relativeTime(e.last_seen)}</td>
              <td>
                <span className="diag__msg">{e.message.split('\n')[0]}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}


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

function Partitions({ report }: { report: Q<StorageReport> }) {
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
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : null}
    </Section>
  )
}

