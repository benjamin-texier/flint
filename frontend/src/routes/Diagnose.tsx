import { useState } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import { bytes, count, duration, exact, relativeTime } from '../lib/format'
import {
  actualWindow,
  costShare,
  databaseOf,
  editorLink,
  everRead,
  percent,
  projectionsLink,
  scanShare,
  scanVerdict,
  tableLink,
  worthAskingAboutProjections,
  timeSpent,
  type Pattern,
  type QueryReport,
  type StorageReport,
  type TrafficReport,
} from '../lib/diagnose'
import { concerns, summarise, type Item } from '../lib/attention'
import { nameOf, notable, saysCaveat, trustworthy, type SpendReport } from '../lib/spend'
import { keeps } from '../lib/spaces'
import { readPlan, verdicts } from '../lib/plan'
import { Flag, Says, Section, SectionIndex, type Q } from '../components/Diag'
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
  const config = useQuery({ queryKey: ['config'], queryFn: () => api.config() })
  /* Only where Flint keeps any. Watching nothing is the correct answer on a
     stateless Flint — asking anyway returns a refusal, and a refusal counted as
     "no alerts" is a distinction this panel cannot draw. */
  const stateful = keeps(config.data)
  const alerts = useQuery({
    queryKey: ['alerts'],
    queryFn: () => api.alerts(),
    enabled: stateful,
    retry: false,
  })
  const reportList = useQuery({
    queryKey: ['reports'],
    queryFn: () => api.reports(),
    enabled: stateful,
    retry: false,
  })
  const usage = useQuery({
    queryKey: ['api-usage', 7],
    queryFn: () => api.apiUsage(7),
    retry: false,
    staleTime: 60_000,
  })

  /* Who the statements above belonged to. Its own request and its own window,
     following the filter like the other two: the question "who spends this
     server" is only answerable over a span, and a section quoting a different
     one from the page it sits on is a section nobody can reconcile. */
  const spend = useQuery({
    queryKey: ['diag', 'spend', days],
    queryFn: () => api.spend(days),
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
        {/* One filter row, above everything it scopes — and now everything it
            scopes really is on the page, which was not true when the server's
            point-in-time figures shared it. Dropped entirely where the role can
            read none of it: a window over nothing is a control that cannot
            change anything, which is worse than no control at all. */}
        {shutOut ? null : (
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
        )}
      </header>

      <SectionIndex />

      {/* Outside the shut-out branch, deliberately. What Flint is watching comes
          from its own workspace, not from `system.*`, so a role denied the query
          log has not lost it — and it used to vanish along with everything else,
          which told somebody their alerts were unreadable when they were fine. */}
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

      {shutOut ? (
        <ShutOut obstacles={obstacles} />
      ) : (
        <>
          <Load report={queries} days={days} />
          <Spend report={spend} />
          <Patterns report={queries} />
          <Failures report={queries} />
          <Traffic report={traffic} storage={storage.data} />
          <Unused report={traffic} />
        </>
      )}
    </div>
  )
}

/** Who the server has been working for.
 *
 *  The other half of everything else on this page. `Load`, `Patterns` and
 *  `Failures` all answer *what* the statements were; none of them can answer
 *  whose they were, and on a shared server that is usually the question with
 *  somewhere to go — a statement shape costing forty minutes a week is a query
 *  to optimise, and the same forty minutes belonging to one service account is a
 *  conversation with whoever owns it.
 *
 *  Every row, not only the notable ones. `lib/spend`'s threshold decides what is
 *  worth a *finding* on a board; this is the page that owns the reading, and a
 *  page that hid the accounts below a quarter would be a ranking somebody cannot
 *  add up. The threshold still shows, as the mark on the rows that cross it. */
function Spend({ report }: { report: Q<SpendReport> }) {
  const data = report.data
  const trust = data ? trustworthy(data) : null
  const loud = new Set(data ? notable(data).map((s) => s.user) : [])
  return (
    <Section
      title="Who this server works for"
      sub="Every account that ran anything, by the time the server spent on it. Background work — a materialized view's push, a subquery from another node — has no account name and is listed as what it is."
      q={report}
    >
      {data && !trust?.ok ? (
        <p className="says says--wide">Ranked anyway, but not to be leaned on: {trust?.why}.</p>
      ) : null}
      {saysCaveat(data ?? ({} as SpendReport)) ? (
        <p className="says says--wide">{saysCaveat(data!)}</p>
      ) : null}
      {data?.spenders.length ? (
        <div className="panel__scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th>Account</th>
                <th className="tbl--n">Statements</th>
                <th className="tbl--n">Query time</th>
                <th className="tbl--n">Share</th>
                <th className="tbl--n">Read</th>
                <th className="tbl--n">Failed</th>
                <th>Most of its time on</th>
              </tr>
            </thead>
            <tbody>
              {data.spenders.map((s) => (
                <tr key={s.user || '__background'}>
                  <td className="tbl__key">
                    {nameOf(s)}
                    {loud.has(s.user) ? (
                      <span className="tbl__note">most of this server’s query time</span>
                    ) : null}
                  </td>
                  <td className="tbl--n">{count(s.statements)}</td>
                  <td className="tbl--n">{duration(s.seconds)}</td>
                  <td className="tbl--n">{Math.round(s.share * 100)}%</td>
                  <td className="tbl--n">{bytes(s.read_bytes)}</td>
                  {/* Zero failures is a fact and prints as one; a dash here
                      would say Flint could not count them. */}
                  <td className="tbl--n">{exact(s.failed)}</td>
                  <td className="tbl__expr">
                    {s.busiest_table ? (
                      <>
                        {s.busiest_table}
                        <span className="tbl__note">
                          {Math.round(s.busiest_share * 100)}% of this account’s time
                        </span>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : data ? (
        <EmptyNote title="Nothing ran in this window">
          The log covers the span above and holds no finished statement from it.
        </EmptyNote>
      ) : null}
    </Section>
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
              level: s.failures > 0 ? 'throw' : 'ok',
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
                    <>
                      <Link
                        className="diag__open"
                        to={editorLink(p)}
                        onClick={(event) => event.stopPropagation()}
                      >
                        Open in editor →
                      </Link>
                      <WhyPattern pattern={p} />
                    </>
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

/** Why the shape above cost what it cost.
 *
 *  This table says *which* statements are expensive, which is the question the
 *  query log can answer. It cannot say why — but the plan can, and Flint can
 *  read a plan. So the two are joined here: `EXPLAIN PLAN indexes = 1` over the
 *  statement as it was logged, read back as sentences.
 *
 *  Explaining costs nothing to run — a plan reads metadata, not data — and it is
 *  still behind a click, because it is a question about one row of a table of
 *  forty and forty plans nobody asked for is forty queries.
 *
 *  One caveat is printed rather than left to be discovered: this is *today's*
 *  plan for a statement that ran earlier. Parts have merged since, the data has
 *  grown, and a filter that pruned nothing last week may prune today. */
function WhyPattern({ pattern }: { pattern: Pattern }) {
  const [asked, setAsked] = useState(false)
  const database = databaseOf(pattern)
  const plan = useQuery({
    queryKey: ['pattern-plan', pattern.hash],
    queryFn: () =>
      api.run({
        sql: `EXPLAIN PLAN indexes = 1 ${pattern.sample.trim()}`,
        database,
      }),
    enabled: asked,
    retry: false,
    staleTime: 60_000,
  })

  if (!asked) {
    return (
      <button
        className="diag__open"
        onClick={(event) => {
          event.stopPropagation()
          setAsked(true)
        }}
        type="button"
      >
        Why it reads that much →
      </button>
    )
  }
  if (plan.isPending) return <p className="bhint">Reading the plan…</p>
  if (plan.error) {
    return (
      <p className="bhint">
        The server would not explain this statement as it was logged — a table it named may be gone,
        or it may not be a SELECT.
      </p>
    )
  }
  const said = verdicts(readPlan((plan.data?.rows ?? []).map((row) => String(row[0] ?? '')).join('\n')))
  if (said.length === 0) {
    return (
      <p className="bhint">
        The plan has nothing to add: this read had no parts or granules to skip.
      </p>
    )
  }
  return (
    <div className="diag__why" onClick={(event) => event.stopPropagation()}>
      <ul className="planread">
        {said.map((verdict) => (
          <li className={`planread__v planread__v--${verdict.tone}`} key={verdict.text}>
            <span className="planread__text">{verdict.text}</span>
            {verdict.evidence ? <span className="planread__ev num">{verdict.evidence}</span> : null}
          </li>
        ))}
      </ul>
      <p className="bhint">
        Today's plan for a statement that ran earlier: parts have merged since, and the data has
        grown.
      </p>
    </div>
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
              const rowsOf = sizeOf.get(t.qualified) ?? 0
              const share = scanShare(t, rowsOf)
              const verdict = share === null ? null : scanVerdict(share)
              const at = tableLink(t.qualified)
              /* The scan share is already the sentence a projection answers, and
                 until now it led nowhere: a reader was told the sorting key was
                 not narrowing these queries and left to find the table by hand.
                 The link is offered from the point where the verdict fires, and
                 it is worded as the question it is — whether a projection is
                 worth its disk depends on the shapes behind those reads, which
                 that tab reads and this page does not. */
              const argues = worthAskingAboutProjections(share, rowsOf) ? projectionsLink(t.qualified) : null
              return (
                <tr key={t.qualified}>
                  <td className="tbl__key">
                    {at ? (
                      <Link className="link" to={at}>
                        {t.qualified}
                      </Link>
                    ) : (
                      t.qualified
                    )}
                  </td>
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
                        {argues ? (
                          <Link className="says says--ask" to={argues}>
                            would a projection help?
                          </Link>
                        ) : null}
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

