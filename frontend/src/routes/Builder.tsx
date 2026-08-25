import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { api, type QueryResult } from '../lib/api'
import { rememberedDatabase, resolveDatabase } from '../lib/database'
import {
  AGG_LABEL,
  OP_LABEL,
  aggsFor,
  aliasOf,
  describe,
  literal as _literal,
  opTakesNoValue,
  opsFor,
  startingSpec,
  WINDOWS,
  toSql,
  type Agg,
  type Bucket,
  type Condition,
  type Op,
  type Having,
  type Projection,
  type QuerySpec,
} from '../lib/query'
import { isTemporal } from '../lib/chType'
import type { ColumnProfile } from '../lib/profile'
import { bytes, count, duration } from '../lib/format'
import { ResultView } from '../components/ResultView'
import { TypeIcon } from '../components/TypeIcon'
import { EmptyNote, ErrorNote, Loading } from '../components/Note'

const BUCKETS: Bucket[] = ['minute', 'hour', 'day', 'week', 'month']

const uid = () => crypto.randomUUID()

/** Querying without writing SQL — and showing the SQL anyway.
 *
 *  The brief is explicit that the abstraction should stay close to SQL rather
 *  than hiding how ClickHouse works, so the generated statement is always on
 *  screen, always editable by taking it to the editor, and the shape of the
 *  form follows the shape of a SELECT. */
export function Builder() {
  const navigate = useNavigate()
  const [params] = useSearchParams()

  const databases = useQuery({ queryKey: ['databases'], queryFn: api.databases })
  const names = useMemo(() => (databases.data ?? []).map((d) => d.name), [databases.data])
  const startDb =
    params.get('database') ?? resolveDatabase(databases.data ?? [], rememberedDatabase())

  const [database, setDatabase] = useState<string | undefined>(startDb)
  const [table, setTable] = useState<string | undefined>(params.get('table') ?? undefined)
  useEffect(() => {
    if (!database && startDb) setDatabase(startDb)
  }, [database, startDb])

  const tables = useQuery({
    queryKey: ['tables', database],
    queryFn: () => api.tables(database!),
    enabled: Boolean(database),
  })
  // Only objects you can select from; a dictionary needs dictGet, not FROM.
  const selectable = (tables.data ?? []).filter((t) => t.kind !== 'dictionary')

  useEffect(() => {
    if (table && selectable.some((t) => t.name === table)) return
    if (selectable.length > 0) setTable(selectable[0]!.name)
  }, [selectable, table])

  const detail = useQuery({
    queryKey: ['table', database, table],
    queryFn: () => api.table(database!, table!),
    enabled: Boolean(database && table),
  })
  const columns = useMemo(
    () => (detail.data?.columns ?? []).map((c) => ({ name: c.name, type: c.type })),
    [detail.data],
  )

  const [spec, setSpec] = useState<QuerySpec>(() => startingSpec('', ''))
  /** Value suggestions are asked for, never assumed: the profile reads a sample
   *  of the table, which is a real query, so it runs when somebody wants help
   *  filling a filter and not because a filter exists. */
  const [suggesting, setSuggesting] = useState(false)
  const profile = useQuery({
    queryKey: ['profile', database, table],
    queryFn: () => api.profile(database!, table!),
    enabled: suggesting && Boolean(database && table),
    retry: false,
    staleTime: 5 * 60_000,
  })
  // Only an aggregate can be filtered after the grouping, so the section only
  // exists once there is one.
  const aggregateAliases = useMemo(
    () => spec.projections.filter((p) => p.agg !== null).map(aliasOf),
    [spec.projections],
  )
  // A new table means a new query: the old columns do not exist here.
  useEffect(() => {
    if (database && table) setSpec(startingSpec(database, table))
  }, [database, table])

  const sql = useMemo(() => toSql(spec, columns), [spec, columns])

  const [result, setResult] = useState<QueryResult | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [running, setRunning] = useState(false)

  const run = async () => {
    setRunning(true)
    setError(null)
    try {
      setResult(await api.run({ sql, database, query_id: uid() }))
    } catch (e) {
      setError(e)
      setResult(null)
    } finally {
      setRunning(false)
    }
  }

  const patch = (changes: Partial<QuerySpec>) => setSpec((s) => ({ ...s, ...changes }))

  const sentence = useMemo(() => describe(spec, columns), [spec, columns])

  /* Saving needs somewhere to save to, and Flint creates nothing uninvited:
     without a workspace database the control says so rather than failing. */
  const config = useQuery({ queryKey: ['config'], queryFn: api.config })
  const client = useQueryClient()
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [saved, setSaved] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: () =>
      api.saveQuery({ name: name.trim(), sql, database: database ?? '' }),
    onSuccess: (query) => {
      setNaming(false)
      setSaved(query.name)
      void client.invalidateQueries({ queryKey: ['saved-queries'] })
    },
  })
  const typeOf = (name: string) => columns.find((c) => c.name === name)?.type ?? 'String'

  if (databases.error) return <ErrorNote error={databases.error} />
  if (!database) return <Loading label="Finding your data" />

  return (
    <section className="builder">
      <aside className="builder__panel">
        <Group label="Dataset">
          <select
            className="picker__select bfield"
            value={database}
            onChange={(e) => setDatabase(e.target.value)}
            aria-label="Database"
          >
            {names.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
          <select
            className="picker__select bfield"
            value={table ?? ''}
            onChange={(e) => setTable(e.target.value)}
            aria-label="Table"
          >
            {selectable.map((t) => (
              <option key={t.name}>{t.name}</option>
            ))}
          </select>
        </Group>

        <Group
          label="Columns"
          hint="A column with no aggregate becomes a grouping. Pick one aggregate and the rest group themselves."
        >
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

          {spec.projections.map((p) => (
            <ProjectionRow
              key={p.id}
              projection={p}
              type={p.column === '*' ? 'UInt64' : typeOf(p.column)}
              onChange={(next) =>
                patch({
                  projections: spec.projections.map((x) => (x.id === p.id ? next : x)),
                })
              }
              onRemove={() =>
                patch({ projections: spec.projections.filter((x) => x.id !== p.id) })
              }
            />
          ))}

          {detail.isPending ? <Loading label="Reading columns" /> : null}
          <div className="bcols">
            {columns
              .filter((c) => !spec.projections.some((p) => p.column === c.name))
              .map((c) => (
                <button
                  key={c.name}
                  className="bcol"
                  onClick={() =>
                    patch({
                      projections: [
                        ...spec.projections,
                        { id: uid(), column: c.name, agg: null, bucket: null },
                      ],
                    })
                  }
                  title={c.type}
                >
                  <TypeIcon type={c.type} />
                  <span className="bcol__name">{c.name}</span>
                </button>
              ))}
          </div>
        </Group>

        <Group label="Filters">
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
        </Group>

        {aggregateAliases.length > 0 ? (
          <Group label="Filters on the totals">
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
            {/* Said once, where the difference bites: a filter here runs after
                the grouping, so it can talk about a total. */}
            <p className="bhint">
              These run after the grouping, so they can compare a total —
              <code> count &gt; 100</code>. A filter above runs before it, on the rows.
            </p>
          </Group>
        ) : null}

        <Group label="Sort">
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
              >
                {o.desc ? 'desc' : 'asc'}
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
            <p className="bhint">Pick a column first.</p>
          )}
        </Group>

        <Group label="Limit">
          <input
            className="picker__select bfield"
            type="number"
            min={0}
            step={100}
            value={spec.limit}
            onChange={(e) => patch({ limit: Math.max(0, Number(e.target.value) || 0) })}
            aria-label="Row limit"
          />
        </Group>
      </aside>

      <div className="builder__work">
        <div className="builder__sql">
          <div className="builder__sqlbar">
            <span className="builder__sqllabel">Generated SQL</span>
            <span className="panel__spacer" />
            {naming ? (
              <>
                <input
                  className="picker__select bfield"
                  value={name}
                  autoFocus
                  placeholder="a name for this query"
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && name.trim()) save.mutate()
                    if (e.key === 'Escape') setNaming(false)
                  }}
                  aria-label="Name for this query"
                />
                <button
                  className="btn btn--spark"
                  onClick={() => save.mutate()}
                  disabled={!name.trim() || save.isPending}
                >
                  {save.isPending ? 'Saving…' : 'Save'}
                </button>
              </>
            ) : (
              <button
                className="btn"
                onClick={() => {
                  // The sentence is the name nobody has to invent.
                  setName(sentence.split(', first ')[0]!.slice(0, 60))
                  setNaming(true)
                }}
                disabled={!config.data?.workspace}
                title={
                  config.data?.workspace
                    ? 'Keep this query in the workspace'
                    : 'Flint has nowhere to keep it: set FLINT_WORKSPACE_DATABASE and restart'
                }
              >
                Save
              </button>
            )}
            <button
              className="btn"
              onClick={() =>
                navigate(
                  `/query?sql=${encodeURIComponent(sql)}&database=${encodeURIComponent(database)}`,
                )
              }
            >
              Take to the editor
            </button>
            <button className="btn btn--spark" onClick={() => void run()} disabled={running}>
              {running ? 'Running…' : 'Run'}
            </button>
          </div>
          {/* The sentence above the SQL, because the mistake it catches — "by
              city" where you meant "by day" — is invisible in a SELECT and
              obvious in English. */}
          <p className="builder__sentence">
            {sentence}
            {saved ? <span className="builder__saved">saved as “{saved}”</span> : null}
            {save.error ? (
              <span className="builder__saved builder__saved--bad">
                {save.error instanceof Error ? save.error.message : 'could not save'}
              </span>
            ) : null}
          </p>
          <pre className="code code--wrap builder__code">{sql}</pre>
        </div>

        <div className={`stats${running ? ' stats--running' : ''}`}>
          <span className="stats__state">
            {running ? 'running' : error ? 'failed' : result ? 'done' : 'idle'}
          </span>
          {result ? (
            <>
              <span className="stats__fact">{count(result.statistics.rows_read)} rows read</span>
              <span className="stats__fact">{bytes(result.statistics.bytes_read)}</span>
              <span className="stats__fact">{duration(result.statistics.elapsed)}</span>
              <span className="stats__fact">{count(result.rows.length)} returned</span>
            </>
          ) : null}
        </div>

        <div className="builder__results">
          {error ? (
            <ErrorNote error={error} />
          ) : result && result.rows.length > 0 ? (
            <ResultView result={result} />
          ) : result ? (
            <EmptyNote title="No rows matched">Loosen a filter and run it again.</EmptyNote>
          ) : (
            <EmptyNote title="Nothing has run yet">
              Pick a column or two on the left and press Run. The SQL above is what will be sent —
              take it to the editor whenever you want to go further than the form allows.
            </EmptyNote>
          )}
        </div>
      </div>
    </section>
  )
}

function Group({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section className="bgroup">
      <h3 className="bgroup__label">{label}</h3>
      {hint ? <p className="bhint">{hint}</p> : null}
      {children}
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
  return (
    <div className="brow brow--proj">
      <div className="brow__head">
        <span className="brow__name">{isStar ? 'rows' : p.column}</span>
        <button className="brow__x" onClick={onRemove} aria-label={`Remove ${p.column}`}>
          ×
        </button>
      </div>
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
    () => c.op === 'since' && c.value !== '' && !WINDOWS.includes(c.value as (typeof WINDOWS)[number]),
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
            <span className="bhint bhint--inline">
              {column.distinct} distinct in the sample
            </span>
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
