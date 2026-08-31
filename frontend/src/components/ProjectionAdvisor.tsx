import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import {
  api,
  type Advice,
  type Existing,
  type Measurement,
  type Pattern,
  type Weight,
} from '../lib/api'
import {
  benefit,
  candidates,
  cost,
  ddlFor,
  limits,
  measureRequest,
  rowsPerRun,
  standing,
  tally,
  unreadable,
  weighRequest,
  weight,
  type Candidate,
  type Standing,
} from '../lib/projection'
import { bytes, count, exact, relativeTime } from '../lib/format'
import { allows } from '../lib/spaces'
import { EmptyNote, ErrorNote, Loading } from './Note'

/** Which projections this table's workload argues for.
 *
 *  The shape of the panel is the shape of the argument, and it goes in one
 *  direction: from what actually ran, through what the sorting key could not
 *  serve, to a statement somebody might run. Nothing is proposed without the
 *  queries behind it visible in the same card, because the recommendation is
 *  only ever as good as the workload it was read from — and a projection
 *  proposed from three runs of one report on a Tuesday is a bad idea that looks
 *  exactly like a good one until you can see the three runs.
 *
 *  Two gates, in that order. A proposal carries no numbers until somebody
 *  presses **Measure**, because the benefit is arithmetic over a count that
 *  costs a scan to obtain, and a page that spent it on opening would be a page
 *  nobody could afford to open. And nothing is ever applied from here without a
 *  press: `Declare` submits a job, which is inert by design, and building it is
 *  a second press again — the same two steps ClickHouse itself has, surfaced
 *  rather than hidden, because `ADD PROJECTION` reporting success while
 *  building nothing is the trap this whole area sets. */
export function ProjectionAdvisor({ database, table }: { database: string; table: string }) {
  const config = useQuery({
    queryKey: ['config'],
    queryFn: () => api.config(),
  })
  const may = allows(config.data?.tier, 'ddl')
  const [days, setDays] = useState(7)

  const advice = useQuery({
    queryKey: ['projections', database, table, days],
    queryFn: () => api.projectionAdvice(database, table, days),
    staleTime: 30_000,
  })

  if (advice.isPending) return <Loading label="Reading the workload" />
  if (advice.error) return <ErrorNote error={advice.error} retry={() => advice.refetch()} />
  if (!advice.data) return null

  return <Body advice={advice.data} may={may} days={days} onDays={setDays} />
}

const WINDOWS = [1, 7, 30]

function Body({
  advice,
  may,
  days,
  onDays,
}: {
  advice: Advice
  may: boolean
  days: number
  onDays: (days: number) => void
}) {
  const proposals = useMemo(() => candidates(advice), [advice])
  /* Two lists, one rule. A proposal argued from one run of one query is not
     wrong — it is thin, and a permanent cost is not argued from an afternoon.
     Folded rather than dropped, with the count on the fold, because a page that
     silently kept back half its findings is the one thing this product must
     never be. */
  const strong = useMemo(() => proposals.filter((c) => !c.thin), [proposals])
  const thin = useMemo(() => proposals.filter((c) => c.thin), [proposals])
  const refused = useMemo(() => unreadable(advice), [advice])
  const counts = useMemo(() => tally(advice), [advice])
  const notEarning = useMemo(() => standing(advice), [advice])
  const taken = advice.existing.map((e) => e.name)

  return (
    <section className="padv">
      <header className="padv__head">
        <div className="padv__scope">
          <p className="padv__claim">
            {advice.sorting_key.length > 0 ? (
              <>
                Ordered by <strong>{advice.sorting_key.join(', ')}</strong>. ClickHouse skips
                granules on a <em>prefix</em> of that and nothing else, so a query that does not
                filter on <code>{advice.sorting_key[0]}</code> reads the table.
              </>
            ) : (
              <>
                This table has no sorting key, so every query reads all of it. A projection is one
                answer; a sorting key is usually the better one.
              </>
            )}
          </p>
          <p className="padv__facts">
            {advice.engine} · {count(advice.total_rows)} rows · {bytes(advice.table_bytes)} ·{' '}
            {advice.parts} {advice.parts === 1 ? 'part' : 'parts'} · granularity{' '}
            {exact(advice.index_granularity)}
          </p>
        </div>
        {/* The window is a control because the answer changes with it: a
            fortnightly report is invisible at one day, and a log with a
            one-day TTL cannot answer thirty however it is asked. */}
        <div className="padv__window" role="group" aria-label="Workload window">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              className={`padv__win${w === days ? ' is-on' : ''}`}
              aria-pressed={w === days}
              onClick={() => onDays(w)}
            >
              {w}d
            </button>
          ))}
        </div>
      </header>

      {!advice.supported ? (
        <EmptyNote title="This engine cannot carry a projection">
          Projections live in the parts of a MergeTree table, and a {advice.engine} has none.
          Nothing below would apply.
        </EmptyNote>
      ) : null}

      <ExistingList existing={advice.existing} days={advice.window_days} />
      <NotEarning items={notEarning} advice={advice} may={may} />

      {advice.workload.blocked ? (
        <EmptyNote title="No workload to read">
          {advice.workload.blocked}. Without it there is nothing to base a recommendation on — which
          is the honest answer here, not a schema-shaped guess.
        </EmptyNote>
      ) : (
        <>
          <p className="padv__tally">
            {counts.patterns === 0 ? (
              <>
                No SELECT has touched this table in the last {advice.window_days} days that the log
                still holds.
              </>
            ) : (
              <>
                {/* The cap says its own count. The list is the costliest few,
                    and a page that reported those as the whole workload would
                    be inviting somebody to conclude that nothing else asks
                    anything of this table. */}
                {counts.capped ? (
                  <>
                    The {counts.patterns} costliest of {count(counts.patternsTotal)} query shapes,{' '}
                    {count(counts.runs)} of {count(counts.runsTotal)} runs
                  </>
                ) : (
                  <>
                    {counts.patterns} query {counts.patterns === 1 ? 'shape' : 'shapes'} over{' '}
                    {count(counts.runs)} runs
                  </>
                )}
                {advice.since ? <> since {relativeTime(advice.since)}</> : null}.{' '}
                {counts.servedByKey > 0 ? (
                  <>
                    {counts.servedByKey} already {counts.servedByKey === 1 ? 'filters' : 'filter'}{' '}
                    on <code>{advice.sorting_key[0]}</code> and{' '}
                    {counts.servedByKey === 1 ? 'needs' : 'need'} nothing.{' '}
                  </>
                ) : null}
                {counts.servedByProjection > 0 ? (
                  <>
                    {count(counts.servedByProjection)} runs were already answered by a
                    projection.{' '}
                  </>
                ) : null}
                {counts.refused > 0 ? (
                  <>
                    {counts.refused} {counts.refused === 1 ? 'shape is' : 'shapes are'} listed at
                    the bottom as unread rather than dropped.
                  </>
                ) : null}
              </>
            )}
          </p>

          {strong.length === 0 && thin.length === 0 ? (
            counts.patterns > 0 ? (
              <EmptyNote title="Nothing here argues for a projection">
                Every shape Flint could read is either served by the sorting key already or is not
                one a second physical order would help. That is the answer this panel most often
                gives on a table somebody thought about.
              </EmptyNote>
            ) : null
          ) : (
            <>
              {strong.length > 0 ? (
                <ul className="padv__list">
                  {strong.map((candidate) => (
                    <ProposalCard
                      key={candidate.id}
                      candidate={candidate}
                      advice={advice}
                      taken={taken}
                      may={may}
                    />
                  ))}
                </ul>
              ) : null}

              {thin.length > 0 ? (
                <details className="fold">
                  <summary className="fold__head">
                    {thin.length} thinner {thin.length === 1 ? 'proposal' : 'proposals'}
                    <span className="fold__hint">
                      argued from two runs or fewer, or from under a twentieth of the time this
                      table spent answering queries — real, and not what to change first
                    </span>
                  </summary>
                  <ul className="padv__list padv__list--thin">
                    {thin.map((candidate) => (
                      <ProposalCard
                        key={candidate.id}
                        candidate={candidate}
                        advice={advice}
                        taken={taken}
                        may={may}
                      />
                    ))}
                  </ul>
                </details>
              ) : null}
            </>
          )}

          {refused.length > 0 ? <Refused items={refused} /> : null}
        </>
      )}
    </section>
  )
}

/* -- What the table already has ----------------------------------------- */

function ExistingList({ existing, days }: { existing: Existing[]; days: number }) {
  if (existing.length === 0) return null
  return (
    <section className="padv__have">
      <h3 className="padv__subtitle">
        Already here
        <span className="padv__note">{existing.length}</span>
      </h3>
      <table className="tbl">
        <thead>
          <tr>
            <th>Projection</th>
            <th>What</th>
            <th className="tbl--n">Holds</th>
            <th className="tbl--n">Used, {days}d</th>
          </tr>
        </thead>
        <tbody>
          {existing.map((p) => (
            <tr key={p.name}>
              <td className="tbl__key">
                {p.name}
                <span className="says mono-dim">{p.query}</span>
              </td>
              <td className="mono-dim">
                {p.kind === 'Aggregate' ? 'pre-aggregated' : 'another sort order'}
                {p.sorting_key.length > 0 ? <> · by {p.sorting_key.join(', ')}</> : null}
              </td>
              {/* The size is the status. Zero parts is not "small", it is
                  "never built" — and there is no other column that says so. */}
              <td className="tbl--n mono-dim">
                {p.inert ? (
                  <span className="padv__inert">nothing — never built</span>
                ) : (
                  <>
                    {bytes(p.bytes)} <span className="says">{count(p.rows)} rows</span>
                  </>
                )}
              </td>
              <td className="tbl--n mono-dim">
                {/* Null is "the log could not say", which is a different answer
                    from none and must not be drawn as one. */}
                {p.used_by === null ? (
                  <span className="says">not recorded here</span>
                ) : p.used_by === 0 ? (
                  <span className="padv__unused">no query used it</span>
                ) : (
                  count(p.used_by)
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

/** The other half of the advice: what is already here and not earning it.
 *
 *  Under the list rather than beside it, because it is a reading of that list
 *  and not a separate subject — and because a page whose first screen is
 *  "here is something to delete" reads as an accusation about a schema
 *  somebody thought about. */
function NotEarning({
  items,
  advice,
  may,
}: {
  items: Standing[]
  advice: Advice
  may: boolean
}) {
  if (items.length === 0) return null
  return (
    <ul className="padv__list">
      {items.map((item) => (
        <li className={`padv__card padv__card--${item.issue}`} key={item.name}>
          <header className="padv__cardhead">
            <span className="padv__key">{item.name}</span>
            <span className="pill pill--caution">
              {item.issue === 'inert' ? 'never built' : 'nothing used it'}
            </span>
            {item.bytes === null ? null : (
              <span className="padv__spent num" title="What it occupies on disk today">
                {bytes(item.bytes)}
              </span>
            )}
          </header>
          <p className="padv__why">{item.says}</p>
          {item.caution ? <p className="padv__caveat">{item.caution}</p> : null}
          {may ? (
            <div className="padv__act">
              {item.fixes.map((fix) => (
                <Link
                  className="btn"
                  key={fix.op}
                  to={handOver(advice, fix.op, { name: item.name })}
                >
                  {fix.label}
                </Link>
              ))}
              <span className="padv__actnote">
                {item.fixes.map((fix) => `${fix.label}: ${fix.explain}`).join(' ')}
              </span>
            </div>
          ) : (
            <p className="padv__actnote">
              {item.fixes.map((fix) => `${fix.label}: ${fix.explain}`).join(' ')}
            </p>
          )}
        </li>
      ))}
    </ul>
  )
}

/* -- One proposal -------------------------------------------------------- */

const KIND: Record<Candidate['kind'], { label: string; blurb: string }> = {
  aggregate: {
    label: 'pre-aggregated',
    blurb:
      'Stores one row per group instead of one per row. The query does not change; ClickHouse ' +
      'reads the fold when it can answer from it.',
  },
  sort: {
    label: 'another sort order',
    blurb:
      'Stores these columns again, sorted differently, so the same filter can skip granules ' +
      'instead of scanning. The query does not change.',
  },
}

function ProposalCard({
  candidate,
  advice,
  taken,
  may,
}: {
  candidate: Candidate
  advice: Advice
  taken: string[]
  may: boolean
}) {
  const [copied, setCopied] = useState(false)
  const [shown, setShown] = useState(false)

  const ddl = useMemo(
    () => ddlFor(candidate, advice.database, advice.table, taken),
    [candidate, advice.database, advice.table, taken],
  )

  /** A scan of every row of the key columns. It happens because somebody asked,
   *  and the button says what it costs before it is pressed. */
  const measure = useMutation({
    mutationFn: () =>
      api.measureProjection(advice.database, advice.table, measureRequest(candidate)),
  })
  const measurement: Measurement | null = measure.data ?? null

  /** The second price, and the only call in this panel that writes. It builds
   *  the grouping and the aggregate states into a scratch table in Flint's own
   *  workspace, reads its parts and drops it — because the *size* of an
   *  aggregate projection is the one figure nothing can read off a schema.
   *
   *  Its own button, after the measurement rather than beside it: counting the
   *  groups answers whether the projection helps, and building them answers
   *  what it costs. Two questions, two prices, agreed to one at a time. */
  const ask = weighRequest(candidate, advice.columns)
  const weighing = useMutation({
    mutationFn: () => api.weighProjection(advice.database, advice.table, ask!),
  })
  const weighed: Weight | null = weighing.data ?? null
  const reading = benefit(candidate, measurement)
  const price = cost(candidate, measurement, advice.table_bytes, weighed)

  const readsNow = rowsPerRun(candidate.patterns)
  const share = advice.total_rows > 0 ? readsNow / advice.total_rows : null
  const runs = candidate.patterns.reduce((n, p) => n + p.runs, 0)

  return (
    <li className={`padv__card padv__card--${candidate.kind}`}>
      <header className="padv__cardhead">
        <span className="padv__key">{candidate.key.map((k) => k.expr).join(', ')}</span>
        <span className="pill">{KIND[candidate.kind].label}</span>
        {candidate.coveredBy ? <span className="pill pill--key">already covered</span> : null}
        <span className="padv__spent num" title="Time this workload spent on the shapes below">
          {exact(weight(candidate))} ms in {advice.window_days}d
        </span>
      </header>

      {/* The evidence first, and it is the log's, not this panel's. */}
      <p className="padv__evidence num">
        {runs} {runs === 1 ? 'run' : 'runs'} · {count(readsNow)} rows read per run
        {/* Over 100% is a true figure and a bad sentence. `read_rows` is what
            the engine moved and `total_rows` is what the parts hold, and they
            are not the same measure — a scan that reads a column twice, or a
            table whose TTL has dropped rows since, lands at 101% and reads as
            arithmetic Flint got wrong. At and above the whole table it is said
            in words, which is both true and legible. */}
        {share !== null && share >= 0.99 ? (
          <> — the whole table, every time</>
        ) : share !== null && share >= 0.5 ? (
          <> — {Math.round(share * 100)}% of the table, every time</>
        ) : share !== null ? (
          <> of {count(advice.total_rows)}</>
        ) : null}
      </p>
      <p className="padv__why">{KIND[candidate.kind].blurb}</p>

      {candidate.coveredBy ? (
        <p className="padv__covered">
          <strong>{candidate.coveredBy}</strong> already holds this. Nothing to add — the panel
          shows it so the shape below is not read as unserved.
        </p>
      ) : null}

      {candidate.alsoServedBy.length > 0 ? (
        <p className="padv__also">
          One projection keyed{' '}
          {candidate.alsoServedBy.map((k, i) => (
            <span key={k}>
              {i > 0 ? ' or ' : ''}
              <code>{k}</code>
            </span>
          ))}{' '}
          would serve this grouping too — a wider key holds more rows, so which is the better trade
          is what measuring both is for.
        </p>
      ) : null}

      {candidate.caveats.map((caveat) => (
        <p className="padv__caveat" key={caveat}>
          {caveat}
        </p>
      ))}

      {/* The measurement, and the arithmetic that rests on it. Absent until
          asked for, because it costs a scan — and never replaced by an
          estimate in the meantime.

          A covered proposal is offered neither: there is nothing left to
          decide, so spending a full scan on it and printing a statement
          nobody should run would both be noise on a card whose whole message
          is "this is already here". */}
      {candidate.coveredBy ? null : (
        <div className="padv__measure">
          {reading ? (
            <p className="padv__reading">
              {/* One line, not three: the figures, the factor and the hedge are
                  one sentence, and a column layout had been breaking it after
                  the factor and starting the next line with a comma. */}
              <span className="padv__headline">
                <span className="padv__figs num">
                  {count(reading.readsNow)} → {count(reading.readsThen)} rows
                </span>
                {reading.factor !== null && reading.factor > 1.1 ? (
                  <span>
                    <strong>{formatFactor(reading.factor)} less to read</strong>, at best
                  </span>
                ) : (
                  <strong>no less to read</strong>
                )}
              </span>
              <span className="padv__aside">{reading.basis}</span>
              {price ? <span className="padv__aside">{price}</span> : null}
              <span className="padv__aside">
                Rows, not seconds. How much faster a query gets from reading less depends on the
                query, the disk and the cache — this panel will not put a number on that.
              </span>
            </p>
          ) : measure.error ? (
            <ErrorNote error={measure.error} retry={() => measure.mutate()} />
          ) : (
            /* A plain button, not the accent one. The palette spends the accent
               once per page and this list has a button per card — the same
               reason the schema review keeps its one spark in the header and
               gives every finding a plain control. */
            <button
              className="btn"
              type="button"
              disabled={measure.isPending}
              onClick={() => measure.mutate()}
              title={`Reads every row of ${candidate.key.map((k) => k.column).join(', ')} — ${count(
                advice.total_rows,
              )} rows — and writes nothing`}
            >
              {measure.isPending ? 'Counting…' : 'Measure it'}
              <span className="btn__aside">scans {count(advice.total_rows)} rows</span>
            </button>
          )}

          {/* The second price, offered only once the first has been paid, and a
              sibling of the reading rather than a child of it: a `details` and
              a `pre` are block elements, and a `p` may contain neither — the
              browser closes the paragraph early and silently reparents
              everything after it. */}
          {reading && ask && !weighed ? (
            <p className="padv__weigh">
              <button
                className="btn btn--quiet"
                type="button"
                disabled={weighing.isPending}
                onClick={() => weighing.mutate()}
                title="Builds the same grouping and the same aggregate states into a scratch table in Flint's own database, reads its parts and drops it"
              >
                {weighing.isPending ? 'Building…' : 'Weigh it'}
              </button>
              <span className="padv__aside">
                the bytes are the one figure nothing can read off a schema — this writes{' '}
                {count(measurement?.groups ?? 0)} rows to Flint’s workspace and drops them again
              </span>
            </p>
          ) : null}
          {weighing.error ? (
            <p className="padv__aside padv__aside--warn">
              {weighing.error instanceof Error ? weighing.error.message : 'it was refused'}
            </p>
          ) : null}
          {weighed ? (
            <details className="padv__built">
              <summary>what was weighed</summary>
              <pre className="code code--wrap">{weighed.built}</pre>
            </details>
          ) : null}
        </div>
      )}

      {candidate.coveredBy ? null : (
        <>
          <p className="padv__limits">{limits(candidate)}</p>

          <div className="padv__ddl">
            <pre className="code code--wrap">{ddl.declare}</pre>
            <button
              className="btn"
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(`${ddl.declare};\n${ddl.materialize};`).then(
                  () => setCopied(true),
                  () => setCopied(false),
                )
              }}
            >
              {copied ? 'Copied' : 'Copy both'}
            </button>
          </div>
          <p className="padv__second">
            Declaring it costs nothing and answers nothing: the projection goes into the table's
            definition and is <em>not</em> built over the rows already there. Building it is the
            mutation, and a separate statement —{' '}
            <code className="padv__inline">MATERIALIZE PROJECTION {ddl.name}</code> — which is why
            both are copied together.
          </p>

          {/* No button here runs this. A projection is structure, and structure is
          Infrastructure's to write — the table page is Data, and the rule that
          keeps the two spaces honest is that no Data control changes structure
          as a side effect. So the proposal does what an import into a missing
          table does: it offers the DDL and sends you where the control lives,
          with the fields already filled in. */}
          {may ? (
            <div className="padv__act">
              <Link className="btn" to={handOver(advice, 'add-projection', { name: ddl.name, query: ddl.query })}>
                Take it to Schema
              </Link>
              <span className="padv__actnote">
                Adding a projection is an <code>ALTER</code>, and altering is Infrastructure’s. The
                form there opens filled in with this statement, and still has to be submitted.
              </span>
            </div>
          ) : null}
        </>
      )}

      <button
        className="padv__toggle"
        type="button"
        aria-expanded={shown}
        onClick={() => setShown((open) => !open)}
      >
        {candidate.patterns.length} {candidate.patterns.length === 1 ? 'shape' : 'shapes'} behind
        this
        <span className="padv__twist" aria-hidden="true">
          {shown ? '▾' : '▸'}
        </span>
      </button>
      {shown ? <PatternList patterns={candidate.patterns} database={advice.database} /> : null}
    </li>
  )
}

/** A ratio at the precision it is actually known to.
 *
 *  Two significant figures past a thousand, because `32,258×` claims a
 *  precision the floor it is built on does not have — the projected read is a
 *  bound, and printing five digits of it invites the reader to hold Flint to
 *  the fifth. */
/** Where an alteration is carried to be run: Infrastructure → Schema, with the
 *  operation and its fields in the address.
 *
 *  Every structural change this panel suggests goes through here — adding a
 *  projection, building one that was never built, dropping one nothing uses.
 *  The panel is Data and Data does not change structure, so what it produces is
 *  a filled-in form somewhere else and never a statement it runs itself. */
function handOver(advice: Advice, op: string, fields: Record<string, string>): string {
  const params = new URLSearchParams({
    alter: `${advice.database}.${advice.table}`,
    op,
    ...fields,
  })
  return `/infra/schema?${params.toString()}`
}

function formatFactor(factor: number): string {
  if (factor >= 1000) {
    const rounded = Number(factor.toPrecision(2))
    return `${rounded.toLocaleString('en')}×`
  }
  if (factor >= 100) return `${Math.round(factor / 10) * 10}×`
  if (factor >= 10) return `${Math.round(factor)}×`
  return `${factor.toFixed(1)}×`
}

function PatternList({ patterns, database }: { patterns: Pattern[]; database: string }) {
  return (
    <ul className="padv__shapes">
      {patterns.map((p) => (
        <li className="padv__shape" key={p.hash}>
          <p className="padv__shapefacts num">
            {p.runs} {p.runs === 1 ? 'run' : 'runs'} · {count(p.read_rows / Math.max(p.runs, 1))}{' '}
            rows each · {Math.round(p.avg_ms)} ms avg · p95 {Math.round(p.p95_ms)} ms ·{' '}
            {p.users === 1 ? '1 user' : `${p.users} users`} · last {relativeTime(p.last_seen)}
          </p>
          <pre className="code code--wrap">{p.statement.trim()}</pre>
          <Link
            className="link padv__open"
            to={`/query?sql=${encodeURIComponent(p.statement.trim())}&database=${encodeURIComponent(database)}`}
          >
            Open in the editor
          </Link>
        </li>
      ))}
    </ul>
  )
}

/** The shapes Flint refused, with the reason.
 *
 *  Listed rather than dropped. A panel showing two proposals over a workload of
 *  forty shapes has to say what happened to the other thirty-eight, or the two
 *  read as the whole truth. */
function Refused({ items }: { items: { pattern: Pattern; why: string }[] }) {
  return (
    <details className="fold">
      <summary className="fold__head">
        {items.length} {items.length === 1 ? 'shape' : 'shapes'} Flint did not read
        <span className="fold__hint">
          no advice is offered from a statement this could not parse all the way through — the
          alternative is a projection proposed from a guess
        </span>
      </summary>
      <ul className="padv__shapes">
        {items.map(({ pattern, why }) => (
          <li className="padv__shape" key={pattern.hash}>
            <p className="padv__shapefacts num">
              {pattern.runs} {pattern.runs === 1 ? 'run' : 'runs'} · {exact(pattern.total_ms)} ms ·{' '}
              <span className="padv__whynot">{why}</span>
            </p>
            <pre className="code code--wrap">{pattern.statement.trim()}</pre>
          </li>
        ))}
      </ul>
    </details>
  )
}
