import { useState } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import { bytes, count, duration, exact, relativeTime } from '../lib/format'
import {
  actualWindow,
  costShare,
  editorLink,
  everRead,
  percent,
  scanShare,
  scanVerdict,
  timeSpent,
  type QueryReport,
  type TrafficReport,
} from '../lib/diagnose'
import { concerns, summarise, type Item } from '../lib/attention'
import { Flag, Says, Section, type Q } from '../components/Diag'
import { MetricLine } from '../components/MetricLine'
import { EmptyNote } from '../components/Note'
import { ShareBar } from '../components/StratumBar'
import { ShutOut } from './Health'

const WINDOWS = [1, 7, 30] as const
/** What the route returns by default. Stated in the UI, because a list cut off
 *  silently reads as the whole truth. */
const CAP = 40

/** Where a link into the old single Diagnose page now goes.
 *
 *  These three tabs became Infrastructure pages. The links are in people's
 *  bookmarks, in alert webhooks that have already been delivered, and in the
 *  README — so the query string keeps working rather than landing on a page that
 *  no longer holds what it promised. */
const MOVED: Record<string, string> = {
  pipelines: '/infra/pipelines',
  access: '/infra/access',
  replication: '/infra/replication',
}

/** Data — Diagnostics: what the statements cost, and what nobody reads.
 *
 *  Half of what used to be one page. This half is about queries somebody wrote:
 *  which are slow, which fail, which tables they touch, and which objects no
 *  statement has read at all. Every one of those is answerable by rewriting a
 *  query or dropping something nobody uses, which is why it sits in Data.
 *
 *  The server's own condition — running work, merges, disks, partitions — is
 *  Infrastructure's Health page. */
export function DiagnosePage() {
  const [days, setDays] = useState<number>(7)
  const [params] = useSearchParams()

  const moved = MOVED[params.get('view') ?? '']

  const queries = useQuery({
    queryKey: ['diag', 'queries', days],
    queryFn: () => api.diagnoseQueries(days),
    staleTime: 30_000,
  })
  const traffic = useQuery({
    queryKey: ['diag', 'traffic', days],
    queryFn: () => api.diagnoseTraffic(days),
    staleTime: 30_000,
  })
  /* Not shown as a section here — Health owns storage — but Traffic prints each
     object's size beside its reads, and it is the same cache entry either page
     fills. */
  const storage = useQuery({
    queryKey: ['diag', 'storage'],
    queryFn: () => api.diagnoseStorage(),
    staleTime: 30_000,
  })
  /* What Flint is watching on your behalf. The reader is already here asking
     what is wrong, so this is where it belongs — and every one of these is a
     query the pages themselves cache anyway. */
  const alerts = useQuery({ queryKey: ['alerts'], queryFn: () => api.alerts(), retry: false })
  const reportList = useQuery({ queryKey: ['reports'], queryFn: () => api.reports(), retry: false })
  const usage = useQuery({
    queryKey: ['api-usage', 7],
    queryFn: () => api.apiUsage(7),
    retry: false,
    staleTime: 60_000,
  })

  const reports = [queries.data, traffic.data]
  const loaded = reports.filter((r) => r !== undefined)
  const shutOut = loaded.length === reports.length && loaded.every((r) => r && !r.available)
  const obstacles = [...new Set(loaded.map((r) => r?.reason).filter(Boolean))] as string[]

  /* After the hooks, never before: bailing out earlier would change how many
     hooks this component calls between renders. */
  if (moved) return <Navigate to={moved} replace />

  return (
    <div className="page page--diagnose">
      <header className="page__head">
        <p className="eyebrow">DIAGNOSTICS</p>
        <div className="page__titlerow">
          <h1 className="page__title page__title--hero">What your queries cost</h1>
        </div>
        {/* One filter row, above everything it scopes — and now everything on
            the page really is scoped by it, which was not true when the server's
            point-in-time figures shared the page. */}
        <div className="diag__filter">
          <span className="label">WINDOW</span>
          <div className="segmented">
            {WINDOWS.map((w) => (
              <button
                key={w}
                className={`segmented__item${days === w ? ' is-on' : ''}`}
                onClick={() => setDays(w)}
              >
                {w === 1 ? '24 hours' : `${w} days`}
              </button>
            ))}
          </div>
          {queries.data?.available ? (
            <span className="diag__filternote">
              covering {actualWindow(queries.data.summary, days)}
            </span>
          ) : null}
        </div>
      </header>

      {shutOut ? (
        <ShutOut obstacles={obstacles} />
      ) : (
        <>
          <Watching
            items={concerns({
              alerts: alerts.data,
              reports: reportList.data,
              usage: usage.data,
            })}
            anything={Boolean(
              alerts.data?.length || reportList.data?.length || usage.data?.usage.length,
            )}
          />
          <Load report={queries} days={days} />
          <Patterns report={queries} />
          <Failures report={queries} />
          <Traffic report={traffic} storage={storage.data} />
          <Unused report={traffic} />
        </>
      )}
    </div>
  )
}

/** Flint's own side of the ledger: the things it watches for you, and whether
 *  any is unhappy. Only the unhappy ones are listed — a list of things that are
 *  fine is a vanity number. */

function Watching({ items, anything }: { items: Item[]; anything: boolean }) {
  if (!anything) return null
  const line = summarise(items)
  return (
    <section className="diag">
      <header className="diag__head">
        <h2 className="diag__title">What Flint is watching</h2>
        <p className="diag__sub">
          Alerts, reports and endpoints. Only what is wrong or stuck is listed. Replicas are
          Infrastructure's business, and are counted on its own tab.
        </p>
      </header>
      {line ? (
        <ul className="watch">
          {items.map((item, i) => (
            <li className={`watch__item watch__item--${item.concern}`} key={`${item.to}-${i}`}>
              <Link className="watch__name" to={item.to}>
                {item.name}
              </Link>
              <span className="watch__says">{item.says}</span>
            </li>
          ))}
        </ul>
      ) : (
        /* The healthy answer, said out loud — the same courtesy the merge
           section gets. */
        <p className="diag__quiet">
          Everything Flint watches here is quiet: no alert firing, no report failing, no endpoint
          erroring.
        </p>
      )}
    </section>
  )
}


// ── Load ───────────────────────────────────────────────────────────────────

function Load({ report, days }: { report: Q<QueryReport>; days: number }) {
  const s = report.data?.summary
  return (
    <Section title="Load" sub={`Everything the log kept for the last ${days === 1 ? '24 hours' : `${days} days`}.`} q={report}>
      {s ? (
        <MetricLine
          metrics={[
            { value: count(s.queries), label: 'STATEMENTS' },
            { value: count(s.selects), label: 'READS' },
            { value: count(s.inserts), label: 'WRITES' },
            {
              value: s.failures ? count(s.failures) : '0',
              label: 'FAILED',
              accent: s.failures > 0,
            },
            { value: `${exact(Math.round(s.p95_ms))}`, unit: 'ms', label: 'P95' },
            { value: bytes(s.read_bytes), label: 'READ' },
            { value: count(s.users), label: 'USERS' },
          ]}
        />
      ) : null}
      {s && !s.queries ? (
        <EmptyNote title="Nothing logged in this window">
          Widen the window, or check that `log_queries` is on.
        </EmptyNote>
      ) : null}
    </Section>
  )
}

// ── Patterns ───────────────────────────────────────────────────────────────

function Patterns({ report }: { report: Q<QueryReport> }) {
  const [open, setOpen] = useState<string | null>(null)
  const patterns = report.data?.patterns ?? []
  const worst = patterns[0]?.total_ms ?? 0
  const spent = timeSpent(patterns)

  return (
    <Section
      title="Where the time went"
      /* The ranking is the argument: one slow statement is an anecdote, and a
         cheap statement run ten thousand times is a bill. */
      /* The total is stated because it is what the shares are shares *of*, and
         a column of percentages with no denominator in sight cannot be
         checked. */
      sub={`Grouped by query shape and ranked by total time, not by the slowest single run.${
        patterns.length >= CAP ? ` Showing the ${CAP} that cost the most.` : ''
      }${spent > 0 ? ` ${duration(spent / 1000)} of query time between them.` : ''}`}
      q={report}
    >
      {patterns.length ? (
        <table className="tbl">
          <thead>
            <tr>
              <th>Query</th>
              <th className="tbl--n">Runs</th>
              <th className="tbl--n">Avg</th>
              <th className="tbl--n">P95</th>
              <th className="tbl--n">Total</th>
              <th className="tbl--n">Read</th>
              <th className="tbl__bar">Share of time</th>
            </tr>
          </thead>
          <tbody>
            {patterns.map((p) => (
              <tr
                key={p.hash}
                onClick={() => setOpen(open === p.hash ? null : p.hash)}
                className={open === p.hash ? 'is-open' : undefined}
              >
                <td className="tbl__key">
                  <code className={`diag__sql${open === p.hash ? ' diag__sql--full' : ''}`}>
                    {p.sample.replace(/\s+/g, ' ').trim()}
                  </code>
                  {p.failures ? <Flag level="throw">{p.failures} failed</Flag> : null}
                  {/* Reading which shape cost the most is the first question;
                      running it is the next one. The link appears with the open
                      statement rather than in every row, where forty of them
                      would compete with the numbers. */}
                  {open === p.hash ? (
                    <Link
                      className="diag__open"
                      to={editorLink(p)}
                      onClick={(event) => event.stopPropagation()}
                    >
                      Open in editor →
                    </Link>
                  ) : null}
                </td>
                <td className="tbl--n">{count(p.runs)}</td>
                <td className="tbl--n mono-dim">{Math.round(p.avg_ms)} ms</td>
                <td className="tbl--n mono-dim">{Math.round(p.p95_ms)} ms</td>
                {/* The column the table is sorted by, so it is the one set in
                    full strength: runs times average is the bill. */}
                <td className="tbl--n">{duration(p.total_ms / 1000)}</td>
                <td className="tbl--n mono-dim">{bytes(p.read_bytes)}</td>
                <td className="tbl__bar">
                  <span className="diag__share">{percent(costShare(p, patterns))}</span>
                  <ShareBar value={p.total_ms} max={worst} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyNote title="No reads in this window">
          Nothing has selected from anything yet.
        </EmptyNote>
      )}
    </Section>
  )
}

// ── Failures ───────────────────────────────────────────────────────────────

function Failures({ report }: { report: Q<QueryReport> }) {
  const failures = report.data?.failures ?? []
  return (
    <Section title="What failed" sub="Grouped by error, because twenty rows of the same exception say one thing." q={report}>
      {failures.length ? (
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
            {failures.map((f) => (
              <tr key={f.code}>
                <td className="tbl__key">
                  <Flag level="throw">{f.name || f.code}</Flag>
                </td>
                <td className="tbl--n">{count(f.occurrences)}</td>
                <td className="mono-dim">{relativeTime(f.last_seen)}</td>
                <td>
                  <span className="diag__msg">{f.message.split('\n')[0]}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="diag__quiet">Nothing failed in this window.</p>
      )}
    </Section>
  )
}

// ── Traffic ────────────────────────────────────────────────────────────────

function Traffic({
  report,
  storage,
}: {
  report: Q<TrafficReport>
  storage: StorageReport | undefined
}) {
  const rows = report.data?.traffic ?? []
  const sizeOf = new Map((storage?.tables ?? []).map((t) => [t.qualified, t.row_count]))
  const busiest = rows[0]?.reads ?? 0

  return (
    <Section
      title="Which tables are read"
      sub="Reads and writes counted separately: a materialized view's target table is written constantly and often read never."
      q={report}
    >
      {rows.length ? (
        <table className="tbl">
          <thead>
            <tr>
              <th>Table</th>
              <th className="tbl--n">Reads</th>
              <th className="tbl--n">Writes</th>
              <th className="tbl--n">Avg</th>
              <th>Scan</th>
              <th className="tbl__bar">Read share</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const share = scanShare(t, sizeOf.get(t.qualified) ?? 0)
              const verdict = share === null ? null : scanVerdict(share)
              return (
                <tr key={t.qualified}>
                  <td className="tbl__key">{t.qualified}</td>
                  <td className={`tbl--n${t.reads ? '' : ' zero'}`}>{count(t.reads)}</td>
                  <td className={`tbl--n${t.writes ? '' : ' zero'}`}>{count(t.writes)}</td>
                  <td className="tbl--n mono-dim">
                    {t.reads ? `${Math.round(t.avg_ms)} ms` : <span className="dash">—</span>}
                  </td>
                  <td>
                    {share === null ? (
                      <span className="dash">—</span>
                    ) : (
                      <>
                        <span className="mono-dim">{percent(Math.min(share, 1))}</span>
                        {verdict ? <Says verdict={verdict} /> : null}
                      </>
                    )}
                  </td>
                  <td className="tbl__bar">
                    <ShareBar value={t.reads} max={busiest} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : (
        <EmptyNote title="No table traffic logged">
          Nothing has been read or written in this window.
        </EmptyNote>
      )}
    </Section>
  )
}

// ── Unused ─────────────────────────────────────────────────────────────────

function Unused({ report }: { report: Q<TrafficReport> }) {
  const rows = report.data?.unused ?? []
  return (
    <Section
      title="Read by nothing"
      /* The caveat is the feature. A table read only through an INSERT … SELECT
         appears here too, and a reader who deletes on this evidence alone needs
         to know that before they do it. */
      sub="Not touched by any logged SELECT in this window. A short window, or an unlogged reader, will list a table that is genuinely in use."
      q={report}
    >
      {rows.length ? (
        <table className="tbl">
          <thead>
            <tr>
              <th>Table</th>
              <th>Engine</th>
              <th className="tbl--n">Rows</th>
              <th className="tbl--n">On disk</th>
              <th>Last written</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.qualified}>
                <td className="tbl__key">{t.qualified}</td>
                <td className="mono-dim">{t.engine}</td>
                <td className="tbl--n">{count(t.row_count)}</td>
                <td className="tbl--n mono-dim">{bytes(t.bytes)}</td>
                <td className="mono-dim">
                  {everRead(t.last_write) ? (
                    <>
                      {relativeTime(t.last_write)}
                      {/* Written but never read is the actionable shape: it is
                          costing you ingest and answering nobody. */}
                      <Says verdict={{ level: 'watch', says: 'still being written' }} />
                    </>
                  ) : (
                    <span className="dash">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="diag__quiet">Every table was read at least once in this window.</p>
      )}
    </Section>
  )
}

