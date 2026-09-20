import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import { bytes, count, duration } from '../lib/format'
import {
  claim,
  measurable,
  proposals,
  saysKind,
  saysNothing,
  saysUnmeasurable,
  type Proposal,
} from '../lib/indexAdvice'
import { handOver, verdicts, type Outcome } from '../lib/whatif'
import { ErrorNote, Loading } from './Note'

/** What a skip index would do to this table, before anybody adds one.
 *
 *  Every other panel in Flint that proposes a structural change measures the
 *  *thing itself* first — `probe.rs` writes the column both ways and weighs
 *  the bytes, the projection advisor builds the aggregate and reads its parts.
 *  This is the same move for an index, and it is the only one of the three
 *  where the answer is a **plan** rather than a size: the index is built on a
 *  copy of one partition and `EXPLAIN PLAN indexes = 1` is run either side of
 *  it.
 *
 *  It is a form rather than a list of proposals because nothing here proposes
 *  anything yet — that is the advisor's job, and it does not exist. What this
 *  answers is the question somebody already has: *would an index on this
 *  column help this filter*. The answer is worth as much when it is no.
 */
export function IndexWhatIf({ database, table }: { database: string; table: string }) {
  const columns = useQuery({
    queryKey: ['table', database, table],
    queryFn: () => api.table(database, table),
  })
  const declared = useQuery({
    queryKey: ['derived', database, table],
    queryFn: () => api.derived(database, table),
    retry: false,
  })
  /* The workload, on the same query key the projections tab uses — opening
     both tabs is one read of `system.query_log`, not two. The two advisors
     read the same measurement and answer different questions from it; that is
     the whole reason this is a separate module rather than more rules in the
     other one. */
  const advice = useQuery({
    queryKey: ['projections', database, table, 7],
    queryFn: () => api.projectionAdvice(database, table, 7),
    staleTime: 30_000,
    retry: false,
  })

  const names = (columns.data?.columns ?? []).map((c) => c.name)
  const [column, setColumn] = useState('')
  const [kind, setKind] = useState<'minmax' | 'set' | 'bloom_filter' | 'tokenbf_v1'>('minmax')
  const [op, setOp] = useState('eq')
  const [value, setValue] = useState('')

  const measure = useMutation({
    mutationFn: (body: Parameters<typeof api.whatIf>[2]) => api.whatIf(database, table, body),
  })
  const outcome = measure.data

  /* The filter defaults to the column being indexed, because that is the only
     filter an index on it can possibly serve — and getting that pair wrong is
     the commonest way to measure nothing and conclude the index is useless. */
  const on = column || names[0] || ''

  const argued = advice.data
    ? proposals(advice.data, declared.data?.indexes.items ?? [])
    : null

  /* One press from a proposal to its measurement: the form is filled in and
     the measurement run, because a proposal nobody can check in a click is a
     recommendation, and this page does not make those. */
  const measureProposal = (proposal: Proposal, kind: Proposal['kind']) => {
    setColumn(proposal.column)
    setKind(kind)
    // The comparison the workload wrote, not one inferred from its kind: `<`
    // and `>` on the same column are opposite questions, and an index
    // measured against the wrong one answers the wrong one.
    setOp(proposal.op)
    if (proposal.sample !== null) setValue(proposal.sample)
    measure.mutate({
      column: proposal.column,
      kind,
      granularity: 4,
      filter_column: proposal.column,
      filter_op: proposal.op,
      filter_values: [proposal.sample ?? value],
    })
  }

  return (
    <div className="stack">
      {advice.data && argued ? (
        <Argued
          advice={advice.data}
          argued={argued}
          onMeasure={measureProposal}
          measuring={measure.isPending ? (measure.variables?.column ?? null) : null}
        />
      ) : null}
      {advice.isPending ? <Loading label="Reading the workload" /> : null}

      <section className="wif">
        <header className="wif__head">
          <h3 className="wif__title">Would an index help?</h3>
          {/* `says--wide`, because the default column is set for a caption
              beside a figure and this is a paragraph across the page. */}
          <p className="says says--wide">
            Flint builds it on a copy of one partition, asks the server for the plan either side
            of it, and throws the copy away. Nothing here changes this table — the statement that
            would is handed to Infrastructure.
          </p>
        </header>

        <form
          className="wif__form"
          onSubmit={(e) => {
            e.preventDefault()
            if (!on) return
            measure.mutate({
              column: on,
              kind,
              granularity: 4,
              filter_column: on,
              filter_op: op,
              filter_values: op === 'isnull' || op === 'notnull' ? [] : [value],
            })
          }}
        >
          <label className="wif__field">
            <span className="label">COLUMN</span>
            <select
              className="picker__select"
              value={on}
              onChange={(e) => setColumn(e.target.value)}
            >
              {names.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="wif__field">
            <span className="label">INDEX</span>
            <select
              className="picker__select"
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof kind)}
            >
              <option value="minmax">minmax — a range per granule</option>
              <option value="set">set — every value, up to 100</option>
              <option value="bloom_filter">bloom filter — is it in here</option>
              <option value="tokenbf_v1">token bloom — words in text</option>
            </select>
          </label>
          <label className="wif__field">
            <span className="label">FILTERED</span>
            <select className="picker__select" value={op} onChange={(e) => setOp(e.target.value)}>
              <option value="eq">equals</option>
              <option value="ne">is not</option>
              <option value="gt">greater than</option>
              <option value="lt">less than</option>
              <option value="gte">at least</option>
              <option value="lte">at most</option>
              <option value="like">like</option>
              <option value="isnull">is null</option>
              <option value="notnull">is not null</option>
            </select>
          </label>
          {op !== 'isnull' && op !== 'notnull' ? (
            <label className="wif__field">
              <span className="label">VALUE</span>
              <input
                className="input bfield bfield--sm"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="the value the query compares to"
                aria-label="The value the filter compares to"
              />
            </label>
          ) : null}
          <button className="btn" type="submit" disabled={measure.isPending || !on}>
            {measure.isPending ? 'Building it on a copy…' : 'Measure it'}
          </button>
        </form>

        {/* The cost is said where the decision is, which is the rule the
            checkup's workload button already follows. */}
        <p className="bhint bhint--inline">
          This copies a partition's rows — seconds on a few million, longer on a big one — and
          drops the copy whatever happens.
        </p>

        {measure.isPending ? <Loading label="Copying, building, planning" /> : null}
        {measure.error ? <ErrorNote error={measure.error} /> : null}
        {outcome ? <Reading database={database} table={table} outcome={outcome} /> : null}
      </section>

      {/* What the table already carries, so the question is asked against what
          is there rather than in the dark. The inert marking is B4's: declaring
          an index does nothing to the rows already written, and the statement
          reports success either way. */}
      {declared.data && declared.data.indexes.items.length > 0 ? (
        <section className="wif">
          <header className="wif__head">
            <h3 className="wif__title">Already declared</h3>
          </header>
          <table className="tbl">
            <thead>
              <tr>
                <th>Index</th>
                <th>On</th>
                <th>Kind</th>
                <th className="tbl--n">Granularity</th>
                <th className="tbl--n">Size</th>
              </tr>
            </thead>
            <tbody>
              {declared.data.indexes.items.map((i) => (
                <tr key={i.name}>
                  <td className="tbl__key">
                    {i.name}
                    {i.inert ? <span className="tbl__note">declared, never built</span> : null}
                  </td>
                  <td className="tbl__expr">{i.expression}</td>
                  <td className="mono-dim">{i.kind}</td>
                  <td className="tbl--n mono-dim">{i.granularity}</td>
                  <td className="tbl--n">{i.inert ? 'nothing' : bytes(i.compressed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  )
}

/** What the workload argues for, ranked by the time it actually spends.
 *
 *  Every proposal here is a *question* rather than a recommendation, and the
 *  difference is one press: the measurement beside it builds the thing on a
 *  copy and says what it would have done. That is the loop this advisor was
 *  waiting for — A9 before A10, in the roadmap's own order, because five more
 *  advisors whose claims rest on a model is what B4 measured its way out of. */
function Argued({
  advice,
  argued,
  onMeasure,
  measuring,
}: {
  advice: Parameters<typeof proposals>[0]
  argued: ReturnType<typeof proposals>
  onMeasure: (proposal: Proposal, kind: Proposal['kind']) => void
  measuring: string | null
}) {
  const says = saysNothing(argued.nothing, advice)
  if (argued.proposals.length === 0 && !says) return null
  return (
    <section className="wif">
      <header className="wif__head">
        <h3 className="wif__title">What the workload argues for</h3>
        <p className="says says--wide">
          Read from every SELECT against this table in the last {advice.window_days} days, ranked
          by the time the window actually spent on them — never by a saving anything predicted.
        </p>
      </header>
      {argued.proposals.length > 0 ? (
        <ul className="wif__list">
          {argued.proposals.map((p) => (
            <li className="wif__card" key={p.id}>
              <div className="wif__cardhead">
                <span className="wif__claim">{claim(p)}</span>
                <span className="wif__spent">
                  {duration(p.spentMs / 1000)}
                  <span className="wif__spentlabel">spent on {p.patterns.length === 1 ? 'this shape' : `${p.patterns.length} shapes`}</span>
                </span>
              </div>
              <p className="says">{saysKind(p)}</p>
              <p className="bhint">
                {count(p.runs)} {p.runs === 1 ? 'run' : 'runs'} in the window
                {/* Where the value comes from, because a plan is only worth
                    reading if a value took part in it — and where it cannot
                    come from, which is said rather than left to a button that
                    does not work. */}
                {measurable(p)
                  ? ` · measured against ${p.sample}, which one of them compared to`
                  : ` · ${saysUnmeasurable(p)}`}
              </p>
              <div className="wif__cardacts">
                <button
                  className="btn"
                  disabled={measuring !== null || !measurable(p)}
                  onClick={() => onMeasure(p, p.kind)}
                  type="button"
                >
                  {measuring === p.column ? 'Measuring…' : `Measure ${p.kind}`}
                </button>
                {p.alternative ? (
                  <button
                    className="btn btn--soft"
                    disabled={measuring !== null || !measurable(p)}
                    onClick={() => onMeasure(p, p.alternative!)}
                    type="button"
                  >
                    and {p.alternative}
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {/* Why the list is short, or empty. A page that proposes nothing and
          says nothing has told the reader there is nothing to find. */}
      {says ? <p className="says says--wide">{says}</p> : null}
    </section>
  )
}

function Reading({
  database,
  table,
  outcome,
}: {
  database: string
  table: string
  outcome: Outcome
}) {
  const said = verdicts(outcome)
  return (
    <div className="wif__reading">
      <ul className="planread">
        {said.map((v) => (
          <li className={`planread__v planread__v--${v.tone}`} key={v.text}>
            <span className="planread__text">{v.text}</span>
            {v.evidence ? <span className="planread__ev num">{v.evidence}</span> : null}
          </li>
        ))}
      </ul>
      {outcome.refused ? null : (
        <>
          <pre className="code code--sql code--wrap">{outcome.statement}</pre>
          <p className="wif__acts">
            <Link className="btn" to={handOver(database, table, outcome)}>
              Add it, in Infrastructure →
            </Link>
            <span className="says">
              Adding it writes nothing to the rows already here; building it over
              {' '}
              {count(outcome.table_rows)} rows is a mutation, and that is the statement after this
              one.
            </span>
          </p>
        </>
      )}
    </div>
  )
}
