import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import {
  AGG_LABEL,
  OP_LABEL,
  aggsFor,
  aliasOf,
  opTakesNoValue,
  opsFor,
  startingSpec,
  WINDOWS,
  type Agg,
  type Bucket,
  type Condition,
  type Having,
  type Op,
  type Projection,
  type QuerySpec,
} from '../lib/query'
import { isTemporal } from '../lib/chType'
import type { ColumnProfile } from '../lib/profile'
import { TypeIcon } from '../components/TypeIcon'
import { ErrorNote, Loading } from '../components/Note'

const BUCKETS: Bucket[] = ['minute', 'hour', 'day', 'week', 'month']

const uid = () => crypto.randomUUID()

/** The question as a form — the other face of the query page.
 *
 *  It sits where the editor sits, in the same resizable band above the same
 *  clause strip and the same results, because that is what makes the switch
 *  above it read as a switch rather than as a second page.
 *
 *  ## Two panes, not five columns
 *
 *  It used to be five columns across — dataset, columns, filters, filters on the
 *  totals, sort — one per section, in the order a SELECT is written. The order
 *  was right and the shape was wrong: a section gets a column whether or not it
 *  has anything in it, so on a first visit three of the five were empty and the
 *  band was two thirds air on the page where space is the scarcest thing there
 *  is. A form's sections do not have equal weight. Filters is usually empty;
 *  the column list is never empty and is the thing every interaction starts
 *  with.
 *
 *  So it is two panes now. On the left the question, as a stack of clauses that
 *  are one line tall when they hold nothing and grow when they hold something —
 *  `from`, `show`, `where`, `having`, `order`, `limit`, and the zone when there
 *  is a day boundary to place. On the right the table's columns, searchable,
 *  which is where the clicking actually happens: a table with ninety of them was
 *  unusable in a 300px column and is now a palette you can type into.
 *
 *  The left pane's keywords are deliberately the same words the SQL side's
 *  clause strip uses — `from`, `where`, `by`, `order`, `limit`. Same question,
 *  same vocabulary, whichever face the tab is wearing; a form that names its
 *  sections differently from the strip underneath it is a form you cannot learn
 *  SQL from.
 *
 *  It owns no state but the profile it may be asked for and what is typed in the
 *  column search. The spec lives on the tab, so switching tabs switches
 *  questions and nothing here has to remember anything. */
export function BuildPane({
  spec,
  onChange,
  database,
  onNaturalHeight,
}: {
  spec: QuerySpec
  onChange: (next: QuerySpec) => void
  /** The tab's database. Picked in the bar above, which is the page's one
   *  database picker in both modes — a second one down here would be two
   *  controls for one fact, and they would disagree the moment either moved. */
  database: string | undefined
  /** How tall the question wants to be, measured after every change.
   *
   *  Reported rather than estimated. The band's height is set from outside, and
   *  the first version of this counted rows and multiplied — which is a model of
   *  the layout, kept in a different file from the layout, and it was wrong the
   *  moment `having` arrived with a sentence under it. What the clauses actually
   *  occupy is a number the browser already knows. */
  onNaturalHeight?: (px: number) => void
}) {
  const tables = useQuery({
    queryKey: ['tables', database],
    queryFn: () => api.tables(database!),
    enabled: Boolean(database),
  })
  // Only objects you can select from; a dictionary needs dictGet, not FROM.
  const selectable = useMemo(
    () => (tables.data ?? []).filter((t) => t.kind !== 'dictionary'),
    [tables.data],
  )

  /* A form with no table is not a question yet, so one is chosen — the first
     the database offers — rather than left for the reader to notice. Also the
     repair when the database changes under a form: the old table is not in the
     new database, and a spec pointing at it would generate a statement that
     fails on a name nobody typed. */
  useEffect(() => {
    if (spec.table && selectable.some((t) => t.name === spec.table)) return
    const first = selectable[0]?.name
    if (!first) return
    onChange(startingSpec(database ?? spec.database, first))
  }, [selectable, spec.table, spec.database, database, onChange])

  const detail = useQuery({
    queryKey: ['table', database, spec.table],
    queryFn: () => api.table(database!, spec.table),
    enabled: Boolean(database && spec.table),
  })
  /* The key flags come with the columns. A palette that does not say which
     columns the table is sorted by is a palette that lets somebody group a
     hundred million rows by the one column ClickHouse cannot help them with,
     and never mention it. */
  const columns = useMemo(
    () =>
      (detail.data?.columns ?? []).map((c) => ({
        name: c.name,
        type: c.type,
        key: c.in_primary_key || c.in_sorting_key,
      })),
    [detail.data],
  )

  /* The clauses' own height, handed up so the band can be as tall as the
     question and no taller. Observed rather than computed on render: a clause
     wraps when the window narrows, and nothing in a render pass knows that. */
  const question = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = question.current
    if (!el || !onNaturalHeight) return
    const report = () => onNaturalHeight(el.scrollHeight)
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    return () => observer.disconnect()
  }, [onNaturalHeight])

  /** What is typed into the column search. Component state and not the spec's:
   *  it is a way of looking at the table, not part of the question, and a search
   *  that survived a tab switch would be somebody else's search. */
  const [find, setFind] = useState('')

  /** Value suggestions are asked for, never assumed: the profile reads a sample
   *  of the table, which is a real query, so it runs when somebody wants help
   *  filling a filter and not because a filter exists. */
  const [suggesting, setSuggesting] = useState(false)
  const profile = useQuery({
    queryKey: ['profile', database, spec.table],
    queryFn: () => api.profile(database!, spec.table),
    enabled: suggesting && Boolean(database && spec.table),
    retry: false,
    staleTime: 5 * 60_000,
  })

  // Only an aggregate can be filtered after the grouping, so the section only
  // exists once there is one.
  const aggregateAliases = useMemo(
    () => spec.projections.filter((p) => p.agg !== null).map(aliasOf),
    [spec.projections],
  )

  const server = useQuery({ queryKey: ['server'], queryFn: () => api.server() })
  /* Whether this question draws a day boundary at all — which is what decides
     whether a zone is worth offering. A question with no window and no bucket
     has nowhere to put one, and the server says so rather than accepting a
     setting that would do nothing. */
  const placesDays =
    spec.projections.some((p) => p.bucket !== null) ||
    spec.conditions.some((c) => c.op === 'since' && c.value.trim() !== '')
  const zones = useQuery({
    queryKey: ['timezones'],
    queryFn: () => api.timezones(),
    enabled: placesDays,
  })

  const patch = (changes: Partial<QuerySpec>) => onChange({ ...spec, ...changes })
  const typeOf = (name: string) => columns.find((c) => c.name === name)?.type ?? 'String'

  if (tables.error) return <ErrorNote error={tables.error} />

  /* Columns already in the question, so the palette does not offer them twice.
     A name, not an index: two projections of the same column are legal SQL and
     an accident in a form. */
  const chosen = new Set(spec.projections.map((p) => p.column))
  const offered = columns.filter((c) => !chosen.has(c.name))
  const needle = find.trim().toLowerCase()
  const shown = needle
    ? offered.filter(
        (c) => c.name.toLowerCase().includes(needle) || c.type.toLowerCase().includes(needle),
      )
    : offered

  return (
    <div className="buildband">
      {/* ── The question ──────────────────────────────────────────────────
          A stack of clauses in the order SQL writes them, each one line tall
          until it holds something. The keywords are the ones the clause strip
          under the results uses, on purpose: same question, same words, either
          face. */}
      <div className="qform">
        <div className="qform__inner" ref={question}>
        <Clause word="from">
          <select
            className="picker__select qform__field"
            value={spec.table}
            onChange={(e) => onChange(startingSpec(database ?? spec.database, e.target.value))}
            aria-label="Table"
          >
            {selectable.some((t) => t.name === spec.table) ? null : (
              <option value={spec.table}>{spec.table || '—'}</option>
            )}
            {selectable.map((t) => (
              <option key={t.name}>{t.name}</option>
            ))}
          </select>
          {tables.isPending && database ? <Loading label="Reading the objects" /> : null}
          {/* The count follows the list: a picker that offers 40 of 49 objects
              without saying so is a picker somebody will search in vain. */}
          {tables.data && tables.data.length > selectable.length ? (
            <p className="bhint bhint--inline">
              {tables.data.length - selectable.length} dictionaries left out — they are read with
              dictGet, not FROM.
            </p>
          ) : null}
        </Clause>

        <Clause
          word="show"
          hint={
            spec.projections.length === 0
              ? 'Pick columns on the right. One with no aggregate becomes a grouping; pick one aggregate and the rest group themselves.'
              : undefined
          }
        >
          {spec.projections.map((p) => (
            <ProjectionRow
              key={p.id}
              projection={p}
              type={p.column === '*' ? 'UInt64' : typeOf(p.column)}
              onChange={(next) =>
                patch({ projections: spec.projections.map((x) => (x.id === p.id ? next : x)) })
              }
              onRemove={() =>
                patch({ projections: spec.projections.filter((x) => x.id !== p.id) })
              }
            />
          ))}
          <button
            className="bpill"
            onClick={() =>
              patch({
                projections: [
                  ...spec.projections,
                  { id: uid(), column: '*', agg: 'count', bucket: null },
                ],
              })
            }
          >
            + count of rows
          </button>
        </Clause>

        <Clause word="where">
          {spec.conditions.map((c) => (
            <ConditionRow
              key={c.id}
              condition={c}
              type={typeOf(c.column)}
              columns={columns}
              onChange={(next) =>
                patch({ conditions: spec.conditions.map((x) => (x.id === c.id ? next : x)) })
              }
              onRemove={() => patch({ conditions: spec.conditions.filter((x) => x.id !== c.id) })}
              column={profile.data?.columns.find((col) => col.name === c.column)}
              asking={suggesting}
              loading={profile.isFetching}
              onAsk={() => setSuggesting(true)}
            />
          ))}
          {columns.length > 0 ? (
            <button
              className="bpill"
              onClick={() =>
                patch({
                  conditions: [
                    ...spec.conditions,
                    { id: uid(), column: columns[0]!.name, op: '=', value: '', value2: '' },
                  ],
                })
              }
            >
              + filter
            </button>
          ) : null}
        </Clause>

        {/* Only once there is an aggregate to compare. Its own clause rather
            than a heading inside `where`: it is the same idea on the other side
            of the grouping, and SQL gives it its own word. */}
        {aggregateAliases.length > 0 ? (
          <Clause
            word="having"
            hint="These compare a total — count > 100. The filters above run before the grouping, on the rows."
          >
            {spec.having.map((h) => (
              <div className="brow" key={h.id}>
                <select
                  className="picker__select bfield"
                  value={h.ref}
                  onChange={(e) =>
                    patch({
                      having: spec.having.map((x) =>
                        x.id === h.id ? { ...x, ref: e.target.value } : x,
                      ),
                    })
                  }
                  aria-label="Aggregate"
                >
                  {aggregateAliases.map((alias) => (
                    <option key={alias}>{alias}</option>
                  ))}
                </select>
                <select
                  className="picker__select bfield bfield--sm"
                  value={h.op}
                  onChange={(e) =>
                    patch({
                      having: spec.having.map((x) =>
                        x.id === h.id ? { ...x, op: e.target.value as Having['op'] } : x,
                      ),
                    })
                  }
                  aria-label="Operator"
                >
                  {(['>', '>=', '=', '!=', '<', '<='] as const).map((op) => (
                    <option key={op} value={op}>
                      {OP_LABEL[op]}
                    </option>
                  ))}
                </select>
                <input
                  className="picker__select bfield bfield--sm"
                  value={h.value}
                  placeholder="100"
                  inputMode="numeric"
                  onChange={(e) =>
                    patch({
                      having: spec.having.map((x) =>
                        x.id === h.id ? { ...x, value: e.target.value } : x,
                      ),
                    })
                  }
                  aria-label="Threshold"
                />
                <button
                  className="brow__x"
                  onClick={() => patch({ having: spec.having.filter((x) => x.id !== h.id) })}
                  aria-label="Remove this filter"
                >
                  ×
                </button>
              </div>
            ))}
            <button
              className="bpill"
              onClick={() =>
                patch({
                  having: [
                    ...spec.having,
                    { id: uid(), ref: aggregateAliases[0]!, op: '>', value: '' },
                  ],
                })
              }
            >
              + filter
            </button>
          </Clause>
        ) : null}

        <Clause word="order">
          {spec.orderings.map((o) => (
            <div className="brow" key={o.id}>
              <select
                className="picker__select bfield"
                value={o.ref}
                onChange={(e) =>
                  patch({
                    orderings: spec.orderings.map((x) =>
                      x.id === o.id ? { ...x, ref: e.target.value } : x,
                    ),
                  })
                }
                aria-label="Sort by"
              >
                {spec.projections.map((p) => (
                  <option key={p.id} value={aliasOf(p)}>
                    {aliasOf(p)}
                  </option>
                ))}
              </select>
              <button
                className="bpill bpill--quiet"
                onClick={() =>
                  patch({
                    orderings: spec.orderings.map((x) =>
                      x.id === o.id ? { ...x, desc: !x.desc } : x,
                    ),
                  })
                }
                aria-label={`Sorting ${o.desc ? 'descending' : 'ascending'} — click to reverse`}
              >
                {o.desc ? 'desc ↓' : 'asc ↑'}
              </button>
              <button
                className="brow__x"
                onClick={() => patch({ orderings: spec.orderings.filter((x) => x.id !== o.id) })}
                aria-label="Remove sort"
              >
                ×
              </button>
            </div>
          ))}
          {spec.projections.length > 0 ? (
            <button
              className="bpill"
              onClick={() =>
                patch({
                  orderings: [
                    ...spec.orderings,
                    { id: uid(), ref: aliasOf(spec.projections[0]!), desc: true },
                  ],
                })
              }
            >
              + sort
            </button>
          ) : (
            <p className="bhint bhint--inline">Pick a column first.</p>
          )}
        </Clause>

        <Clause word="limit">
          <input
            className="picker__select qform__limit"
            type="number"
            min={0}
            step={100}
            value={spec.limit}
            onChange={(e) => patch({ limit: Math.max(0, Number(e.target.value) || 0) })}
            aria-label="Row limit"
          />
        </Clause>

        {/* Only once there is a window or a bucket to place. Offered rather
            than assumed, because "the last 7 days" and "by day" are both
            answers to a question about somebody's days — and on a server in
            another country they are quietly answers about somebody else's. */}
        {placesDays ? (
          <Clause word="days begin in">
            <select
              className="picker__select qform__field"
              value={spec.timezone}
              onChange={(e) => patch({ timezone: e.target.value })}
              aria-label="Timezone the days are cut in"
            >
              <option value="">
                the server&rsquo;s{server.data?.timezone ? ` (${server.data.timezone})` : ''}
              </option>
              {(zones.data ?? []).map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </Clause>
        ) : null}
        </div>
      </div>

      {/* ── The columns ───────────────────────────────────────────────────
          The pane that gets the room, because it is the one every question
          starts in. Searchable: `hits` has 105 columns, and a wall of 105 chips
          is a wall whichever column of the band it is in. */}
      <div className="palette">
        <div className="palette__head">
          <input
            className="palette__find"
            value={find}
            onChange={(e) => setFind(e.target.value)}
            placeholder={`Filter ${spec.table || 'the table'}’s columns`}
            aria-label="Filter the column list"
            type="search"
          />
        </div>

        {detail.isPending ? <Loading label="Reading columns" /> : null}

        <div className="palette__list">
          {shown.map((c) => (
            <button
              key={c.name}
              className={`bcol${c.key ? ' bcol--key' : ''}`}
              onClick={() =>
                patch({
                  projections: [
                    ...spec.projections,
                    { id: uid(), column: c.name, agg: null, bucket: null },
                  ],
                })
              }
              title={`${c.type}${c.key ? ' · in the table’s sorting key' : ''} — click to show it`}
            >
              <TypeIcon type={c.type} />
              <span className="bcol__name">{c.name}</span>
            </button>
          ))}
          {/* A search that matched nothing says so where the results would have
              been, rather than leaving an empty box that reads as a table with
              no columns. */}
          {needle && shown.length === 0 && offered.length > 0 ? (
            <p className="bhint">
              Nothing here matches “{find.trim()}”.
            </p>
          ) : null}
        </div>

        {/* The count follows the list. Every part of it is a thing that was left
            out, named — a palette that shows 12 of 105 and says nothing is a
            palette somebody will search in vain. */}
        {columns.length > 0 ? (
          <p className="palette__count">
            {shown.length} of {columns.length} columns
            {chosen.size > 0 ? ` · ${chosen.size} already in the question` : ''}
            {needle && offered.length > shown.length
              ? ` · ${offered.length - shown.length} filtered out`
              : ''}
          </p>
        ) : null}
      </div>
    </div>
  )
}

/** One clause of the question: its keyword in the gutter, its controls beside
 *  it.
 *
 *  The keyword rather than a title-case heading, because the keyword is the
 *  thing being taught. `where` here writes `WHERE` there, and the strip under
 *  the results calls it `where` too — three surfaces, one word.
 *
 *  A clause with nothing in it is one line tall. That is the whole point of the
 *  shape: a form whose empty sections cost as much room as its full ones is a
 *  form that is mostly empty, which is what this replaced. */
function Clause({
  word,
  hint,
  children,
}: {
  word: string
  /** Said under the controls, and only while it is worth saying — most of these
   *  are for the state where the clause is empty and the reader has to be told
   *  what belongs in it. */
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section className="clause">
      <span className="clause__key label">{word}</span>
      <div className="clause__body">
        {children}
        {hint ? <p className="bhint clause__hint">{hint}</p> : null}
      </div>
    </section>
  )
}

function ProjectionRow({
  projection: p,
  type,
  onChange,
  onRemove,
}: {
  projection: Projection
  type: string
  onChange: (next: Projection) => void
  onRemove: () => void
}) {
  const isStar = p.column === '*'
  /* One line: the column, what is being done to it, and the way to take it out.
     It used to be two — the name on its own row above the dropdowns — because in
     a 264px column a name beside two selects was squeezed to nothing. The pane
     is 780px now and the stacked version was a 90px block per column, so four
     columns filled the band with three fields in it. */
  return (
    <div className="brow brow--proj">
      <span className="brow__name">{isStar ? 'rows' : p.column}</span>
      <div className="brow__controls">
        {!isStar ? (
          <select
            className="picker__select bfield bfield--sm"
            value={p.agg ?? ''}
            onChange={(e) => onChange({ ...p, agg: (e.target.value || null) as Agg | null })}
            aria-label={`Aggregate for ${p.column}`}
          >
            <option value="">group by</option>
            {aggsFor(type).map((a) => (
              <option key={a} value={a}>
                {AGG_LABEL[a]}
              </option>
            ))}
          </select>
        ) : null}
        {!isStar && p.agg === null && isTemporal(type) ? (
          <select
            className="picker__select bfield bfield--sm"
            value={p.bucket ?? ''}
            onChange={(e) => onChange({ ...p, bucket: (e.target.value || null) as Bucket | null })}
            aria-label={`Bucket for ${p.column}`}
          >
            <option value="">exact</option>
            {BUCKETS.map((b) => (
              <option key={b} value={b}>
                by {b}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <button
        className="brow__x"
        onClick={onRemove}
        aria-label={isStar ? 'Stop counting rows' : `Remove ${p.column}`}
      >
        ×
      </button>
    </div>
  )
}

function ConditionRow({
  condition: c,
  type,
  columns,
  onChange,
  onRemove,
  column,
  asking,
  loading,
  onAsk,
}: {
  condition: Condition
  type: string
  columns: { name: string; type: string }[]
  onChange: (next: Condition) => void
  onRemove: () => void
  /** The profile of the filtered column, once it has been asked for. */
  column: ColumnProfile | undefined
  asking: boolean
  loading: boolean
  onAsk: () => void
}) {
  const ops = opsFor(type)
  // Open on the field only when the window in the spec is not one of the
  // shortcuts — a query that came back from a saved spec has to show its own
  // value, not the nearest chip.
  const [custom, setCustom] = useState(
    () =>
      c.op === 'since' && c.value !== '' && !WINDOWS.includes(c.value as (typeof WINDOWS)[number]),
  )
  return (
    <div className="brow brow--cond">
      <select
        className="picker__select bfield"
        value={c.column}
        onChange={(e) => {
          const next = e.target.value
          const nextOps = opsFor(columns.find((x) => x.name === next)?.type ?? 'String')
          // Keep the operator only if it still applies to the new column.
          onChange({ ...c, column: next, op: nextOps.includes(c.op) ? c.op : nextOps[0]! })
        }}
        aria-label="Filter column"
      >
        {columns.some((col) => col.name === c.column) ? null : <option>{c.column}</option>}
        {columns.map((col) => (
          <option key={col.name}>{col.name}</option>
        ))}
      </select>
      <select
        className="picker__select bfield bfield--sm"
        value={c.op}
        onChange={(e) => onChange({ ...c, op: e.target.value as Op })}
        aria-label="Operator"
      >
        {ops.map((op) => (
          <option key={op} value={op}>
            {OP_LABEL[op]}
          </option>
        ))}
      </select>
      {opTakesNoValue(c.op) ? null : c.op === 'since' ? (
        /* A window is picked, not typed: these six cover nearly every reading of
           a ClickHouse table. The field appears only for the seventh, so the
           common case is one click and the row stays one line. */
        <span className="bwin">
          {WINDOWS.map((w) => (
            <button
              key={w}
              className={`bpill bpill--sm${c.value === w ? ' is-on' : ''}`}
              onClick={() => {
                setCustom(false)
                onChange({ ...c, value: w })
              }}
              type="button"
            >
              {w}
            </button>
          ))}
          {custom ? (
            <input
              className="picker__select bfield bfield--sm"
              value={c.value}
              placeholder="90d"
              autoFocus
              onChange={(e) => onChange({ ...c, value: e.target.value })}
              aria-label="Window"
            />
          ) : (
            <button
              className="bpill bpill--sm"
              onClick={() => setCustom(true)}
              title="A window of your own"
              type="button"
            >
              …
            </button>
          )}
        </span>
      ) : (
        <input
          className="picker__select bfield"
          value={c.value}
          placeholder={isTemporal(type) ? '2026-01-01 00:00:00' : 'value'}
          onChange={(e) => onChange({ ...c, value: e.target.value })}
          aria-label="Value"
        />
      )}
      {/* What is actually in the column, which is the difference between a form
          you can use on a table you know and one you can use on any table. A
          value goes into the field for a comparison, and joins the list for
          "is one of". */}
      {opTakesNoValue(c.op) || c.op === 'since' ? null : !asking ? (
        <button className="bpill bpill--sm bvals__ask" onClick={onAsk} type="button">
          values…
        </button>
      ) : loading && !column ? (
        <span className="bhint">reading a sample…</span>
      ) : column && column.top.length > 0 ? (
        <span className="bvals">
          {column.top.slice(0, 8).map((value) => {
            const list = c.op === 'in' || c.op === 'notIn'
            const parts = c.value
              .split(',')
              .map((v) => v.trim())
              .filter(Boolean)
            const on = list ? parts.includes(value) : c.value === value
            return (
              <button
                key={value}
                className={`bpill bpill--sm${on ? ' is-on' : ''}`}
                onClick={() =>
                  onChange({
                    ...c,
                    value: list
                      ? (on ? parts.filter((v) => v !== value) : [...parts, value]).join(', ')
                      : value,
                  })
                }
                title={value}
                type="button"
              >
                {value === '' ? "''" : value.length > 18 ? `${value.slice(0, 17)}…` : value}
              </button>
            )
          })}
          {column.distinct > column.top.length ? (
            <span className="bhint bhint--inline">{column.distinct} distinct in the sample</span>
          ) : null}
        </span>
      ) : column ? (
        <span className="bhint">no repeated value to offer here</span>
      ) : null}
      {c.op === 'between' ? (
        <input
          className="picker__select bfield"
          value={c.value2}
          placeholder="and"
          onChange={(e) => onChange({ ...c, value2: e.target.value })}
          aria-label="Second value"
        />
      ) : null}
      <button className="brow__x" onClick={onRemove} aria-label="Remove filter">
        ×
      </button>
    </div>
  )
}
