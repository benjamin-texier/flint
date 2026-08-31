import { useEffect, useMemo, useState } from 'react'
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
 *  This is the old Builder's left rail, turned on its side. It sits where the
 *  editor sits, in the same resizable band above the same statement strip and
 *  the same results, because that is what makes the switch above it read as a
 *  switch rather than as a second page: everything below the grip is identical
 *  in both modes, and only the surface you compose on changes.
 *
 *  Laid out across rather than down, in the order a SELECT is written —
 *  dataset, columns, filters, filters on the totals, sort, limit, zone. A form
 *  that reads left to right in the order of the language it generates is a form
 *  somebody can learn SQL from, which the brief asks for explicitly.
 *
 *  It owns no state but the profile it may be asked for. The spec lives on the
 *  tab, so switching tabs switches questions and nothing here has to remember
 *  anything. */
export function BuildPane({
  spec,
  onChange,
  database,
}: {
  spec: QuerySpec
  onChange: (next: QuerySpec) => void
  /** The tab's database. Picked in the bar above, which is the page's one
   *  database picker in both modes — a second one down here would be two
   *  controls for one fact, and they would disagree the moment either moved. */
  database: string | undefined
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
  const columns = useMemo(
    () => (detail.data?.columns ?? []).map((c) => ({ name: c.name, type: c.type })),
    [detail.data],
  )

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

  return (
    <div className="buildband">
      <Group label="Dataset" narrow>
        <select
          className="picker__select bfield"
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
          <p className="bhint">
            {tables.data.length - selectable.length} dictionaries left out — they are read with
            dictGet, not FROM.
          </p>
        ) : null}
      </Group>

      <Group
        label="Columns"
        wide
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
              patch({ projections: spec.projections.map((x) => (x.id === p.id ? next : x)) })
            }
            onRemove={() => patch({ projections: spec.projections.filter((x) => x.id !== p.id) })}
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

      <Group label="Filters" wide>
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

        {aggregateAliases.length > 0 ? (
          <>
            {/* Its own heading rather than its own column: it is the same idea
                on the other side of the grouping, and an empty column for it
                pushed Sort off the end of the band. */}
            <h3 className="bgroup__label bgroup__label--again">Filters on the totals</h3>
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
                having: [...spec.having, { id: uid(), ref: aggregateAliases[0]!, op: '>', value: '' }],
              })
            }
          >
            + filter
          </button>
            {/* Said once, where the difference bites: a filter here runs after
                the grouping, so it can talk about a total. */}
            <p className="bhint">
              These compare a total — <code>count &gt; 100</code>. The ones above run before the
              grouping, on the rows.
            </p>
          </>
        ) : null}
      </Group>

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

        <h3 className="bgroup__label bgroup__label--again">Limit</h3>
        <input
          className="picker__select bfield"
          type="number"
          min={0}
          step={100}
          value={spec.limit}
          onChange={(e) => patch({ limit: Math.max(0, Number(e.target.value) || 0) })}
          aria-label="Row limit"
        />

        {/* Only once there is a window or a bucket to place. Offered rather
            than assumed, because "the last 7 days" and "by day" are both
            answers to a question about somebody's days — and on a server in
            another country they are quietly answers about somebody else's. */}
        {placesDays ? (
          <>
            <h3 className="bgroup__label bgroup__label--again">Days begin in</h3>
            <select
              className="picker__select bfield"
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
          </>
        ) : null}
      </Group>
    </div>
  )
}

function Group({
  label,
  hint,
  wide,
  narrow,
  children,
}: {
  label: string
  hint?: string
  /** The groups that hold a list rather than a field. A table's column list is
   *  the longest thing in the band, and in a 268px column it becomes a
   *  staircase of one chip per line. */
  wide?: boolean
  /** One field's worth of question. It gets one field's worth of band. */
  narrow?: boolean
  children: React.ReactNode
}) {
  return (
    <section className={`bgroup${wide ? ' bgroup--wide' : ''}${narrow ? ' bgroup--narrow' : ''}`}>
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
