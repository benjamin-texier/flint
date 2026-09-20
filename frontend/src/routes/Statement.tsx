import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import { bytes, count, exact, relativeTime, times } from '../lib/format'
import { tableLink } from '../lib/diagnose'
import { readPlan, verdicts as planVerdicts, type Verdict } from '../lib/plan'
import {
  counter,
  explainable,
  hitRate,
  notable,
  openInEditor,
  phases,
  pruning,
  verdicts,
  type Statement,
  type StatementReport,
} from '../lib/statement'
import { EmptyNote, ErrorNote, Loading } from '../components/Note'
import { MetricLine } from '../components/MetricLine'
import { ShareBar } from '../components/StratumBar'

/** One statement, and everything the log kept about it.
 *
 *  Every other reading of the query log in Flint groups — by shape, by account,
 *  by table, by error — which is right for "what is expensive here" and useless
 *  once somebody has an answer and wants *this* call. A shape has no
 *  `query_id`, so until now there was nothing to click through to.
 *
 *  The page is ordered the way the question is asked. What it was and what it
 *  cost; then the verdicts, because somebody who came from a slow-query list
 *  wants the sentence before the table; then the evidence each sentence rests
 *  on, in the order it is usually needed — what was skipped, where the time
 *  went, what it ran with, how this run compares with its own shape.
 *
 *  Nothing on it is measured by Flint. Every figure is a column or a counter
 *  the server wrote while the statement ran, which is what lets the page be
 *  this confident: a reader can check any of it against `system.query_log`. */
export function StatementPage() {
  const { id = '' } = useParams()
  const report = useQuery({
    queryKey: ['statement', id],
    queryFn: () => api.statement(id),
    retry: false,
    // A row in the log does not change. Refetching it costs a read and can
    // only ever return the same answer.
    staleTime: Infinity,
  })

  const data = report.data
  const s = data?.statement ?? null

  return (
    <div className="page page--diagnose">
      <header className="page__head">
        <p className="eyebrow">
          STATEMENT<span className="eyebrow__sep">·</span>
          <Link className="link" to="/diagnose">
            back to what your queries cost
          </Link>
        </p>
        <div className="page__titlerow">
          <h1 className="page__title page__title--hero">{s ? title(s) : 'One statement'}</h1>
        </div>
        <p className="page__sub">
          <code className="mono-dim">{id}</code>
        </p>
      </header>

      {report.isPending ? <Loading label="Reading the log" /> : null}
      {report.error ? <ErrorNote error={report.error} retry={() => report.refetch()} /> : null}

      {data && !data.available ? (
        <EmptyNote title="Not available here">
          {data.reason}. Everything else about this server is unaffected.
        </EmptyNote>
      ) : null}

      {data?.available && !s ? (
        <EmptyNote title="No statement with that id">
          {/* The window is part of the answer. "No such statement" and "no such
              statement in the last 30 days" send somebody to different places,
              and only one of them is true. */}
          The log holds nothing under this id in the last {data.window_days} days. A query id
          belongs to whoever sent it, so this one may have been rolled off by the log's own TTL, or
          it may never have reached this server.
        </EmptyNote>
      ) : null}

      {data?.running ? (
        <p className="says says--wide says--watch">
          This statement is still running: the log has its start and no ending yet. What it has
          cost so far, and the way to stop it, are on{' '}
          <Link className="link" to="/infra/health">
            Health
          </Link>{' '}
          — stopping a statement is operating the server, which is the other space.
        </p>
      ) : null}

      {s ? <Figures statement={s} /> : null}
      {data && s ? <Verdicts report={data} /> : null}
      {s ? <Sql statement={s} /> : null}
      {s ? <Skipped statement={s} /> : null}
      {s ? <Time statement={s} /> : null}
      {data && s ? <Stages report={data} /> : null}
      {data && s ? <TheShape report={data} /> : null}
      {s ? <Ran statement={s} /> : null}
      {s ? <Counters statement={s} /> : null}
    </div>
  )
}

/** What this statement was, in the order somebody would say it out loud. */
function title(s: Statement): string {
  const kind = s.kind && s.kind !== 'Other' ? s.kind : 'Statement'
  return `${kind}, ${relativeTime(s.at)}`
}

function Figures({ statement: s }: { statement: Statement }) {
  const failed = s.exception_code !== 0

  return (
    <section className="diag">
      <MetricLine
        lead
        metrics={[
          { value: exact(s.duration_ms), unit: 'ms', label: 'TOOK' },
          { value: count(s.read_rows), label: 'ROWS READ' },
          { value: bytes(s.read_bytes), label: 'BYTES READ' },
          { value: count(s.result_rows), label: 'RETURNED' },
          { value: bytes(s.memory_usage), label: 'MEMORY' },
          /* Zero means "this version does not record it", which is not one
             thread — so the figure is dropped rather than printed as 0. An
             absent figure is dropped, not dashed. */
          ...(s.peak_threads > 0
            ? [{ value: exact(s.peak_threads), label: 'THREADS' }]
            : []),
          /* `failed`, not the exception code. Under a label reading FAILED a
             number is read as a count, and `394` is not 394 failures — it is
             the code, which belongs in the sentence that quotes the server's
             own words rather than in a figure. */
          {
            value: failed ? 'failed' : 'ok',
            label: 'OUTCOME',
            level: failed ? ('throw' as const) : ('ok' as const),
          },
        ]}
      />
      <p className="bhint">
        Run by <strong>{s.user || 'the server itself, with no account behind it'}</strong>
        {s.database ? (
          <>
            {' '}
            against <code>{s.database}</code>
          </>
        ) : null}
        , {s.started} → {s.at}
        {/* Whether it came through Flint, read off the `log_comment` Flint
            stamps. The audit page makes the same statement for the same
            reason: a statement somebody ran in a terminal is honestly marked
            as not having come from here. */}
        {s.via_flint ? ' · sent by Flint' : ' · not sent by Flint'}
        {s.query_cache && s.query_cache !== 'None' && s.query_cache !== 'Unknown'
          ? ` · query cache: ${s.query_cache.toLowerCase()}`
          : null}
      </p>
      {/* The exception is *not* repeated here. It leads the verdicts directly
          below, and the same sentence twice within a screen reads as two
          different facts until somebody checks. */}
    </section>
  )
}

function Said({ said }: { said: Verdict[] }) {
  return (
    <ul className="planread">
      {said.map((v) => (
        <li className={`planread__v planread__v--${v.tone}`} key={v.text}>
          <span className="planread__text">{v.text}</span>
          {v.evidence ? <span className="planread__ev num">{v.evidence}</span> : null}
        </li>
      ))}
    </ul>
  )
}

function Verdicts({ report }: { report: StatementReport }) {
  const said = verdicts(report)
  if (said.length === 0) return null
  return (
    <section className="diag" id="what-it-says">
      <header className="diag__head">
        <h2 className="diag__title">What it says</h2>
        <p className="diag__sub">
          Arithmetic over the counters the server wrote while this ran. Nothing here re-plans the
          statement or predicts anything about it.
        </p>
      </header>
      <Said said={said} />
    </section>
  )
}

function Sql({ statement: s }: { statement: Statement }) {
  return (
    <section className="diag" id="the-statement">
      <header className="diag__head">
        <h2 className="diag__title">The statement</h2>
        <p className="diag__sub">As the server recorded it, before any formatting.</p>
      </header>
      <pre className="code code--sql code--wrap">{s.query}</pre>
      <p className="diag__open">
        <Link className="link" to={openInEditor(s)}>
          Open in editor →
        </Link>
      </p>
      {s.tables.length > 0 ? (
        <p className="bhint">
          Touched{' '}
          {s.tables.map((t, i) => {
            const to = tableLink(t)
            return (
              <span key={t}>
                {i > 0 ? ', ' : ''}
                {to ? (
                  <Link className="link" to={to}>
                    {t}
                  </Link>
                ) : (
                  <code>{t}</code>
                )}
              </span>
            )
          })}
          {s.columns.length > 0
            ? ` · ${count(s.columns.length)} ${s.columns.length === 1 ? 'column' : 'columns'}`
            : null}
          {s.views.length > 0 ? ` · through ${s.views.join(', ')}` : null}
        </p>
      ) : null}
    </section>
  )
}

/** What the server skipped, and — separately — what it would skip today.
 *
 *  The two are kept apart on purpose and the page says which is which. The
 *  counters are what happened on this run; an `EXPLAIN` asked now re-plans
 *  against parts that have merged and rows that have arrived since, so it
 *  answers a question about a table that no longer exists in that shape. Both
 *  are worth having — only the plan can name the index — and merging them into
 *  one figure would be a claim Flint cannot make about half of it. */
function Skipped({ statement: s }: { statement: Statement }) {
  const { parts, marks, ranges } = pruning(s)
  if (!parts && !marks) return null
  return (
    <section className="diag" id="what-it-skipped">
      <header className="diag__head">
        <h2 className="diag__title">What it skipped</h2>
        <p className="diag__sub">
          Counted by the server while this statement ran, not re-planned afterwards. It says how
          much was skipped and never by what — no counter records which index did it.
        </p>
      </header>
      <table className="tbl">
        <thead>
          <tr>
            <th>Of the table</th>
            <th className="tbl--n">Read</th>
            <th className="tbl--n">There are</th>
            <th className="tbl__bar">Share read</th>
          </tr>
        </thead>
        <tbody>
          {parts ? (
            <tr>
              <td className="tbl__key">Parts</td>
              <td className="tbl--n">{exact(parts.used)}</td>
              <td className="tbl--n mono-dim">{exact(parts.total)}</td>
              <td className="tbl__bar">
                <ShareBar value={parts.used} max={parts.total} />
              </td>
            </tr>
          ) : null}
          {marks ? (
            <tr>
              <td className="tbl__key">
                Granules
                <span className="tbl__note">8,192 rows each, read whole</span>
              </td>
              <td className="tbl--n">{exact(marks.used)}</td>
              <td className="tbl--n mono-dim">{exact(marks.total)}</td>
              <td className="tbl__bar">
                <ShareBar value={marks.used} max={marks.total} />
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {ranges > 0 ? (
        <p className="bhint">
          In {exact(ranges)} {ranges === 1 ? 'range' : 'ranges'} of the sorting key.
        </p>
      ) : null}
      <PlanToday statement={s} />
    </section>
  )
}

/** The plan, asked now, for a statement that ran earlier.
 *
 *  Behind a click and labelled with its own caveat, the same arrangement the
 *  Diagnose page's shapes already use: explaining costs nothing to run, and it
 *  is still a question about one row that nobody asked. */
function PlanToday({ statement: s }: { statement: Statement }) {
  const [asked, setAsked] = useState(false)
  const plan = useQuery({
    queryKey: ['statement-plan', s.query_id],
    queryFn: () =>
      api.run({
        sql: `EXPLAIN PLAN indexes = 1 ${explainable(s.query)}`,
        database: s.database,
      }),
    enabled: asked,
    retry: false,
    staleTime: 60_000,
  })

  if (!asked) {
    return (
      <button className="diag__open" onClick={() => setAsked(true)} type="button">
        What would it skip today? →
      </button>
    )
  }
  if (plan.isPending) return <p className="bhint">Reading the plan…</p>
  if (plan.error) {
    return (
      <p className="bhint">
        The server would not explain this statement as it was logged — a table it named may be
        gone, it may not be a SELECT, or it may have carried parameters the log did not keep.
      </p>
    )
  }
  const said = planVerdicts(
    readPlan((plan.data?.rows ?? []).map((row) => String(row[0] ?? '')).join('\n')),
  )
  if (said.length === 0) {
    return <p className="bhint">The plan has nothing to add: no parts or granules to skip.</p>
  }
  return (
    <div className="diag__why">
      <Said said={said} />
      <p className="bhint">
        Today's plan, for a statement that ran {relativeTime(s.at)}: parts have merged since and
        the data has grown, so this is what the server <em>would</em> do — the figures above are
        what it <em>did</em>.
      </p>
    </div>
  )
}

/** Where the time went, to the extent anything counted it.
 *
 *  The five named phases come from `ProfileEvents` and stop where execution
 *  begins; execution is the remainder and is labelled as what it is. The bar
 *  is drawn per row rather than stacked, because a stacked bar of five slivers
 *  and one enormous one is a picture of nothing. */
function Time({ statement: s }: { statement: Statement }) {
  const rows = phases(s)
  if (rows.length === 0) return null
  const whole = rows.reduce((n, p) => n + p.micros, 0)
  const cpu = counter(s, 'OSCPUVirtualTimeMicroseconds')
  return (
    <section className="diag" id="where-the-time-went">
      <header className="diag__head">
        <h2 className="diag__title">Where the time went</h2>
        <p className="diag__sub">
          ClickHouse counts the phases before execution and nothing after it, so execution is the
          remainder rather than a figure of its own.
        </p>
      </header>
      <table className="tbl">
        <tbody>
          {rows.map((p) => (
            <tr key={p.name}>
              <td className="tbl__key">{p.name}</td>
              <td className="tbl--n">
                {p.micros >= 1000 ? `${exact(Math.round(p.micros / 1000))} ms` : `${exact(p.micros)} µs`}
              </td>
              <td className="tbl__bar">
                <ShareBar value={p.micros} max={whole} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {cpu > 0 ? (
        <p className="bhint">
          {exact(Math.round(cpu / 1000))} ms of processor time across every thread, against{' '}
          {exact(s.duration_ms)} ms on the clock
          {s.peak_threads > 1 ? ` and ${exact(s.peak_threads)} threads at its widest` : ''}.
        </p>
      ) : null}
    </section>
  )
}

function Stages({ report }: { report: StatementReport }) {
  const { items, blocked } = report.stages
  if (!blocked && items.length === 0) return null
  const worst = items[0]?.micros ?? 0
  return (
    <section className="diag" id="the-pipeline">
      <header className="diag__head">
        <h2 className="diag__title">The pipeline, operator by operator</h2>
        <p className="diag__sub">
          Folded by name, because thirty-two rows of one transform is the thread count wearing the
          clothes of a plan.
        </p>
      </header>
      {blocked ? <EmptyNote title="Not recorded here">{blocked}.</EmptyNote> : null}
      {items.length > 0 ? (
        <table className="tbl">
          <thead>
            <tr>
              <th>Operator</th>
              <th className="tbl--n">Threads</th>
              <th className="tbl--n">In</th>
              <th className="tbl--n">Out</th>
              <th className="tbl--n">Took</th>
              <th className="tbl__bar">Share</th>
            </tr>
          </thead>
          <tbody>
            {items.map((st) => (
              <tr key={st.name}>
                <td className="tbl__key">{st.name}</td>
                <td className="tbl--n mono-dim">{exact(st.processors)}</td>
                <td className="tbl--n">{count(st.input_rows)}</td>
                <td className="tbl--n">{count(st.output_rows)}</td>
                <td className="tbl--n">{exact(Math.round(st.micros / 1000))} ms</td>
                <td className="tbl__bar">
                  <ShareBar value={st.micros} max={worst} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  )
}

function TheShape({ report }: { report: StatementReport }) {
  const shape = report.shape
  const s = report.statement
  if (!shape || !s) return null
  /* Below five runs the figures are the same figure three times — median, p95
     and worst of one run are all that run — and printing them side by side
     under headings that promise a distribution is the page inventing a normal
     it does not have. `againstShape` withholds its verdict at the same floor,
     for the same reason, so the two cannot disagree. */
  if (shape.runs < 5) {
    return (
      <section className="diag" id="its-shape">
        <header className="diag__head">
          <h2 className="diag__title">This shape, lately</h2>
        </header>
        <p className="diag__quiet">
          {shape.runs === 1
            ? `This statement's shape has run once in ${shape.window_days} days — this run — so there is nothing to read it against.`
            : `This statement's shape has run ${count(shape.runs)} times in ${shape.window_days} days, which is too few to say what it normally costs.`}
        </p>
        <p className="diag__open">
          <Link className="link" to={`/diagnose?hash=${encodeURIComponent(shape.hash)}`}>
            {shape.runs === 1 ? 'Look for it over a longer window' : 'Every run of this shape'} →
          </Link>
        </p>
      </section>
    )
  }
  return (
    <section className="diag" id="its-shape">
      <header className="diag__head">
        <h2 className="diag__title">This shape, lately</h2>
        <p className="diag__sub">
          Every run of the same normalised statement in the last {shape.window_days} days — what
          this one should be read against.
        </p>
      </header>
      <MetricLine
        metrics={[
          { value: count(shape.runs), label: 'RUNS' },
          { value: exact(Math.round(shape.median_ms)), unit: 'ms', label: 'MEDIAN' },
          { value: exact(Math.round(shape.p95_ms)), unit: 'ms', label: 'P95' },
          { value: exact(shape.max_ms), unit: 'ms', label: 'WORST' },
          {
            value: shape.failures ? count(shape.failures) : '0',
            label: 'FAILED',
            level: shape.failures > 0 ? ('throw' as const) : ('ok' as const),
          },
          ...(shape.median_ms > 0
            ? [{ value: times(s.duration_ms / shape.median_ms) ?? '', label: 'THIS RUN' }]
            : []),
        ]}
      />
      <p className="diag__open">
        <Link className="link" to={`/diagnose?hash=${encodeURIComponent(shape.hash)}`}>
          Every run of this shape →
        </Link>
      </p>
    </section>
  )
}

function Ran({ statement: s }: { statement: Statement }) {
  const marks = hitRate(s, 'MarkCacheHits', 'MarkCacheMisses')
  const condition = hitRate(s, 'QueryConditionCacheHits', 'QueryConditionCacheMisses')
  if (s.settings.length === 0 && !marks && !condition && s.row_policies.length === 0) return null
  return (
    <section className="diag" id="what-it-ran-with">
      <header className="diag__head">
        <h2 className="diag__title">What it ran with</h2>
        <p className="diag__sub">
          The settings this statement carried that differed from the profile behind it.
        </p>
      </header>
      {s.settings.length > 0 ? (
        <table className="settbl">
          <tbody>
            {s.settings.map((set) => (
              <tr key={set.name}>
                <td className="settbl__k">{set.name}</td>
                <td className="settbl__v">{set.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="diag__quiet">Nothing was set on this statement that the profile had not.</p>
      )}
      {/* Counted rather than hidden: a settings list that silently drops a
          third of itself is one nobody can reconcile against SHOW SETTINGS. */}
      {s.flint_settings > 0 ? (
        <p className="bhint">
          {exact(s.flint_settings)} more were Flint's own, attached to every statement it sends and
          left out here so this list is what the statement asked for. They are on the Config page.
        </p>
      ) : null}
      {marks || condition ? (
        <p className="bhint">
          {marks ? `Mark cache: ${exact(marks.used)} hits of ${exact(marks.total)} lookups.` : null}
          {marks && condition ? ' ' : null}
          {condition
            ? `Query condition cache: ${exact(condition.used)} of ${exact(condition.total)}.`
            : null}
        </p>
      ) : null}
      {s.row_policies.length > 0 ? (
        <p className="says says--watch">
          Row policies applied: {s.row_policies.join(', ')}. The rows this statement returned are
          not the rows another account would have got.
        </p>
      ) : null}
    </section>
  )
}

/** Every counter, with the ones worth reading first.
 *
 *  Folded rather than dropped. A statement carries a hundred and fifty of
 *  these and almost nobody wants them — but the person who does is usually
 *  half an hour into something and would otherwise be writing the query
 *  against `system.query_log` by hand, which is exactly the thing this page
 *  exists to stop. */
function Counters({ statement: s }: { statement: Statement }) {
  const [all, setAll] = useState(false)
  if (s.events.length === 0) return null
  const first = notable(s)
  const shown = all ? s.events : first
  const rest = s.events.length - first.length
  return (
    <section className="diag" id="counters">
      <header className="diag__head">
        <h2 className="diag__title">Counters</h2>
        <p className="diag__sub">
          {all
            ? `Every one of the ${count(s.events.length)} the server wrote for this statement.`
            : `The ${count(first.length)} of ${count(s.events.length)} that usually say something.`}
        </p>
      </header>
      <table className="settbl">
        <tbody>
          {shown.map((c) => (
            <tr key={c.name}>
              <td className="settbl__k">{c.name}</td>
              <td className="settbl__v">{exact(c.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rest > 0 ? (
        <button className="diag__open" onClick={() => setAll(!all)} type="button">
          {all ? 'Show the ones that say something' : `Show the other ${count(rest)} →`}
        </button>
      ) : null}
    </section>
  )
}
