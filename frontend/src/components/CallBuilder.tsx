import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { api, callPublished, type RawCall } from '../lib/api'
import {
  callUrl,
  declaredParams,
  emptyCall,
  filterable,
  operatorLabel,
  nextLink,
  openapiPath,
  operatorTakesValue,
  opsFor,
  parseDefaults,
  sheetsCaveat,
  snippet,
  SNIPPETS,
  type Call,
  type CallFormat,
  type ColumnDoc,
  type EndpointSchema,
  type Published,
  type SnippetKind,
} from '../lib/publish'
import { ErrorNote } from './Note'
import { TypeBadge } from './TypeBadge'
import { count } from '../lib/format'

/** How much of a response the page shows before it says how much it left out.
 *  A CSV of ten thousand rows is not something anyone reads in a panel. */
const BODY_CHARS = 4000

/** What an endpoint takes, and a way to try it.
 *
 *  The reference on the left is read from the endpoint's own `/schema` rather
 *  than from anything this page knows: if the two ever disagreed, the one that
 *  answers callers is the one that is right. The builder on the right writes a
 *  URL and then actually fetches it — the same request, the same token, the
 *  same headers an outside caller would get back. */
export function CallBuilder({
  endpoint,
  origin,
  token,
}: {
  endpoint: Published
  origin: string
  /** The endpoint's token, where it is still knowable — which is only just
   *  after it was minted. A token is hashed on its way into the workspace, so a
   *  page opened tomorrow does not have one to send, and this builder says so
   *  rather than firing a call that would come back 401 looking like a bug. */
  token?: string
}) {
  const callable = endpoint.public || Boolean(token)
  const schema = useQuery({
    queryKey: ['published-schema', endpoint.slug, token ?? ''],
    queryFn: () => api.publishedSchema(endpoint.slug, token ?? ''),
    enabled: callable,
    retry: false,
    staleTime: 60_000,
  })

  const [call, setCall] = useState<Call>(() => {
    const defaults = parseDefaults(endpoint.defaults)
    return {
      ...emptyCall,
      values: Object.fromEntries(
        declaredParams(endpoint.sql).map((p) => [p, defaults[p] ?? '']),
      ),
    }
  })
  const [take, setTake] = useState<SnippetKind>('curl')
  const [result, setResult] = useState<RawCall | null>(null)
  const [running, setRunning] = useState(false)
  const [unreachable, setUnreachable] = useState<string | null>(null)

  const columns = useMemo(() => filterable(schema.data), [schema.data])
  const url = callUrl(endpoint.slug, call)
  const patch = (change: Partial<Call>) => setCall((c) => ({ ...c, ...change }))

  /* Both buttons are the same fetch, made the way an outside caller would
     make it — the document is behind the endpoint's token like its data. */
  async function fetchPath(path: string) {
    if (!callable) {
      setResult(null)
      setUnreachable(
        'This endpoint needs its token, and a token is readable only once — at the moment it is minted. Rotate it to get a new one, which will also stop every caller using the old one.',
      )
      return
    }
    setRunning(true)
    setUnreachable(null)
    try {
      setResult(await callPublished(path, endpoint.public ? '' : (token ?? '')))
    } catch {
      setResult(null)
      setUnreachable('Flint did not answer. Is the server still running?')
    } finally {
      setRunning(false)
    }
  }

  return (
    <section className="call">
      <div className="call__cols">
        <div className="call__side">
          <Reference endpoint={endpoint} schema={schema.data} />
          {schema.error ? <ErrorNote error={schema.error} retry={() => schema.refetch()} /> : null}
        </div>

        <div className="call__build">
          <h4 className="call__head">Build a call</h4>

          {Object.keys(call.values).length ? (
            <div className="call__group">
              <span className="label">PARAMETERS</span>
              {Object.keys(call.values).map((name) => (
                <label className="call__row" key={name}>
                  <code className="call__key">{name}</code>
                  <input
                    className="input"
                    value={call.values[name] ?? ''}
                    onChange={(e) =>
                      patch({ values: { ...call.values, [name]: e.target.value } })
                    }
                    placeholder="a value the caller supplies"
                  />
                </label>
              ))}
            </div>
          ) : null}

          <Filters call={call} columns={columns} schema={schema.data} patch={patch} />
          <Sorts call={call} columns={schema.data?.columns ?? []} patch={patch} />
          <Projection call={call} columns={schema.data?.columns ?? []} patch={patch} />

          <div className="call__group">
            <span className="label">PAGE</span>
            <div className="call__row call__row--wrap">
              <label className="call__num">
                <span className="call__key">limit</span>
                <input
                  className="input"
                  value={call.limit === null ? '' : call.limit}
                  inputMode="numeric"
                  placeholder={String(endpoint.max_rows)}
                  onChange={(e) => {
                    const raw = e.target.value.trim()
                    patch({ limit: raw === '' ? null : Math.max(1, Number(raw) || 1) })
                  }}
                />
              </label>
              <label className="call__num">
                <span className="call__key">offset</span>
                <input
                  className="input"
                  value={call.offset === 0 ? '' : call.offset}
                  inputMode="numeric"
                  placeholder="0"
                  onChange={(e) =>
                    patch({ offset: Math.max(0, Number(e.target.value.trim()) || 0) })
                  }
                />
              </label>
              <label className="call__check">
                <input
                  type="checkbox"
                  checked={call.count}
                  onChange={(e) => patch({ count: e.target.checked })}
                />
                {/* Said plainly: a total is a second pass over the same rows. */}
                <span>count the total too</span>
              </label>
              <label className="call__num">
                <span className="call__key">format</span>
                <select
                  className="input"
                  value={call.format}
                  onChange={(e) => patch({ format: e.target.value as CallFormat })}
                >
                  <option value="json">json</option>
                  <option value="csv">csv</option>
                  <option value="ndjson">ndjson</option>
                </select>
              </label>
            </div>
          </div>
        </div>
      </div>

      <div className="call__take">
        <label className="call__num">
          <span className="label">TAKE IT AWAY</span>
          <select
            className="input"
            value={take}
            onChange={(e) => setTake(e.target.value as SnippetKind)}
          >
            {SNIPPETS.map((s) => (
              <option key={s.kind} value={s.kind}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <pre className="pub__curl call__curl">{snippet(take, endpoint, origin, call)}</pre>
      {take === 'sheets' ? (
        <p className={endpoint.public ? 'call__note' : 'says says--watch'}>
          {sheetsCaveat(endpoint)}
        </p>
      ) : null}

      <div className="call__actions">
        <button
          className="btn btn--spark"
          onClick={() => void fetchPath(url)}
          disabled={running}
        >
          {running ? 'Calling…' : 'Call it'}
        </button>
        {/* Following the link rather than building the URL is the point: the
            cursor in it cannot lose a row the way counting rows can. */}
        {result && nextLink(result.headers) ? (
          <button
            className="btn"
            onClick={() => void fetchPath(nextLink(result.headers) as string)}
            disabled={running}
          >
            Next page →
          </button>
        ) : null}
        <button
          className="btn"
          onClick={() => void fetchPath(openapiPath(endpoint.slug))}
          disabled={running}
        >
          OpenAPI
        </button>
        {result ? <Verdict result={result} /> : null}
      </div>

      {unreachable ? <p className="says says--wide says--throw">{unreachable}</p> : null}
      {result ? <Body result={result} /> : null}
    </section>
  )
}

/** The endpoint as a caller reads it. */
function Reference({
  endpoint,
  schema,
}: {
  endpoint: Published
  schema: EndpointSchema | undefined
}) {
  return (
    <>
      <h4 className="call__head">What this endpoint takes</h4>

      {schema?.parameters.length ? (
        <div className="call__group">
          <span className="label">PARAMETERS</span>
          <ul className="call__list">
            {schema.parameters.map((p) => (
              <li key={p.name}>
                <code>{p.name}</code>
                <TypeBadge type={p.type} />
                {p.required ? (
                  <span className="says says--watch">required</span>
                ) : (
                  <span className="mono-dim">defaults to {p.default}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="call__group">
        <span className="label">COLUMNS, AND WHAT EACH ONE TAKES</span>
        {schema?.columns?.length ? (
          <ul className="call__list">
            {schema.columns.map((c) => (
              <li key={c.name}>
                <code>{c.name}</code>
                <TypeBadge type={c.type} />
                {/* An absent figure is dropped, not dashed — but a column that
                    cannot be filtered is a fact worth saying out loud, because
                    the alternative is a caller discovering it in a 400. */}
                {c.filter.length ? (
                  <span className="mono-dim">{c.filter.join(' · ')}</span>
                ) : (
                  <span className="mono-dim">returned, not filterable</span>
                )}
              </li>
            ))}
          </ul>
        ) : schema?.columns_note ? (
          <p className="call__note">
            Flint could not describe this statement without running it, so the columns are not
            listed here. <span className="mono-dim">{schema.columns_note}</span>
          </p>
        ) : (
          <p className="call__note mono-dim">Reading the endpoint…</p>
        )}
      </div>

      <div className="call__group">
        <span className="label">PAGE</span>
        <p className="call__note">
          Up to {count(endpoint.max_rows)} rows per response. <code>limit</code> and{' '}
          <code>offset</code> page through the rest; <code>count=exact</code> adds the total.
          Every answer carries <code>X-Flint-Limit</code>, <code>X-Flint-Offset</code>,{' '}
          <code>X-Flint-Has-More</code> and a <code>Link</code> to the next page, so a CSV
          reader that has no envelope to look at still knows where it is.
        </p>
        {/* The trap in every offset-paged API, and it is worth the sentence:
            without an order the rows have no order, and two pages of an
            unordered result can repeat one row and never show another. */}
        <p className="says says--wide says--watch">
          A page is only stable if the rows have an order. Give one below, or put an ORDER BY
          in the statement — otherwise page two can repeat a row from page one and skip
          another entirely.
        </p>
      </div>

      <div className="call__group">
        <span className="label">ELSEWHERE</span>
        <p className="call__note">
          This endpoint also describes itself as an OpenAPI document at{' '}
          <code>{openapiPath(endpoint.slug)}</code> — enough for Swagger UI, Postman or a
          client generator to read it without anyone writing the document by hand.
        </p>
        <p className="call__note">
          Paging by <code>cursor</code> rather than <code>offset</code> is what the{' '}
          <code>Link</code> header gives you: it carries the last row's ordering values, so
          nothing is lost or repeated when rows arrive between two pages.
        </p>
      </div>

      {schema?.shadowed.length ? (
        <p className="says says--wide says--watch">
          This statement declares {schema.shadowed.map((s) => `\`${s}\``).join(', ')} itself, so
          Flint leaves {schema.shadowed.length === 1 ? 'that name' : 'those names'} to it — a
          caller sending {schema.shadowed.length === 1 ? 'it' : 'them'} is answering the
          statement, not shaping the page.
        </p>
      ) : null}
    </>
  )
}

function Filters({
  call,
  columns,
  schema,
  patch,
}: {
  call: Call
  columns: ColumnDoc[]
  schema: EndpointSchema | undefined
  patch: (change: Partial<Call>) => void
}) {
  const add = () => {
    const first = columns[0]
    if (!first) return
    patch({
      filters: [...call.filters, { column: first.name, op: first.filter[0] ?? 'eq', value: '' }],
    })
  }
  const set = (i: number, change: Partial<Call['filters'][number]>) =>
    patch({ filters: call.filters.map((f, j) => (j === i ? { ...f, ...change } : f)) })

  return (
    <div className="call__group">
      <span className="label">FILTERS</span>
      {call.filters.map((f, i) => {
        const ops = opsFor(schema, f.column)
        return (
          <div className="call__row" key={i}>
            <select
              className="input"
              value={f.column}
              aria-label="column"
              onChange={(e) => {
                const next = opsFor(schema, e.target.value)
                set(i, {
                  column: e.target.value,
                  op: next.includes(f.op) ? f.op : (next[0] ?? 'eq'),
                })
              }}
            >
              {columns.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            <select
              className="input call__op"
              value={f.op}
              aria-label="operator"
              onChange={(e) => set(i, { op: e.target.value })}
            >
              {ops.map((op) => (
                <option key={op} value={op}>
                  {operatorLabel(op)}
                </option>
              ))}
            </select>
            {operatorTakesValue(f.op) ? (
              <input
                className="input"
                value={f.value}
                aria-label="value"
                placeholder={f.op === 'in' || f.op === 'nin' ? 'one, or, another' : 'a value'}
                onChange={(e) => set(i, { value: e.target.value })}
              />
            ) : null}
            <button
              className="iconbtn"
              aria-label={`remove the filter on ${f.column}`}
              onClick={() => patch({ filters: call.filters.filter((_, j) => j !== i) })}
            >
              ×
            </button>
          </div>
        )
      })}
      {columns.length ? (
        <button className="btn" onClick={add}>
          Add a filter
        </button>
      ) : (
        <p className="call__note mono-dim">
          No column of this endpoint can be filtered, so there is nothing to add.
        </p>
      )}
    </div>
  )
}

function Sorts({
  call,
  columns,
  patch,
}: {
  call: Call
  columns: ColumnDoc[]
  patch: (change: Partial<Call>) => void
}) {
  if (!columns.length) return null
  return (
    <div className="call__group">
      <span className="label">ORDER</span>
      {call.order.map((s, i) => (
        <div className="call__row" key={i}>
          <select
            className="input"
            value={s.column}
            aria-label="column to order by"
            onChange={(e) =>
              patch({
                order: call.order.map((o, j) =>
                  j === i ? { ...o, column: e.target.value } : o,
                ),
              })
            }
          >
            {columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            className="input call__op"
            value={s.desc ? 'desc' : 'asc'}
            aria-label="direction"
            onChange={(e) =>
              patch({
                order: call.order.map((o, j) =>
                  j === i ? { ...o, desc: e.target.value === 'desc' } : o,
                ),
              })
            }
          >
            <option value="asc">ascending</option>
            <option value="desc">descending</option>
          </select>
          <button
            className="iconbtn"
            aria-label={`stop ordering by ${s.column}`}
            onClick={() => patch({ order: call.order.filter((_, j) => j !== i) })}
          >
            ×
          </button>
        </div>
      ))}
      <button
        className="btn"
        onClick={() =>
          patch({
            order: [...call.order, { column: columns[0]?.name ?? '', desc: false }],
          })
        }
      >
        Add an order
      </button>
    </div>
  )
}

function Projection({
  call,
  columns,
  patch,
}: {
  call: Call
  columns: ColumnDoc[]
  patch: (change: Partial<Call>) => void
}) {
  if (!columns.length) return null
  const toggle = (name: string) =>
    patch({
      select: call.select.includes(name)
        ? call.select.filter((n) => n !== name)
        : [...call.select, name],
    })

  return (
    <div className="call__group">
      <span className="label">COLUMNS</span>
      <div className="call__chips">
        {columns.map((c) => {
          const on = call.select.includes(c.name)
          return (
            <button
              key={c.name}
              className={`bpill bpill--sm${on ? ' is-on' : ''}`}
              aria-pressed={on}
              onClick={() => toggle(c.name)}
            >
              {c.name}
            </button>
          )
        })}
      </div>
      {/* Counts follow the list: an empty selection is every column, and
          saying so beats leaving the reader to infer it from nothing. */}
      <p className="call__note mono-dim">
        {call.select.length
          ? `${call.select.length} of ${columns.length} columns`
          : `all ${columns.length} columns`}
      </p>
    </div>
  )
}

/** The status line: what came back, how big it was, how long it took. */
function Verdict({ result }: { result: RawCall }) {
  const page = pageOf(result)
  return (
    <p className="call__verdict">
      <span className={`flag ${result.ok ? 'flag--good' : 'flag--throw'}`}>{result.status}</span>
      {page ? (
        <span className="mono-dim">
          {count(page.returned)} row{page.returned === 1 ? '' : 's'}
          {page.total !== undefined ? ` of ${count(page.total)}` : ''}
          {page.has_more ? ' · more behind this' : ''}
        </span>
      ) : null}
      <span className="mono-dim">{result.ms} ms</span>
      {result.headers.map(([name, value]) => (
        <span className="mono-dim" key={name}>
          {name}: {value}
        </span>
      ))}
    </p>
  )
}

function Body({ result }: { result: RawCall }) {
  const shown = result.body.slice(0, BODY_CHARS)
  const left = result.body.length - shown.length
  return (
    <>
      <pre className="call__body">{shown}</pre>
      {left > 0 ? (
        <p className="call__note mono-dim">
          Showing the first {count(BODY_CHARS)} of {count(result.body.length)} characters.
        </p>
      ) : null}
    </>
  )
}

/** The paging facts, read from the JSON envelope when there is one. */
function pageOf(
  result: RawCall,
): { returned: number; has_more: boolean; total?: number } | null {
  if (!result.contentType.includes('json') || result.contentType.includes('ndjson')) {
    // No envelope to read. The headers say the same thing, and `Verdict`
    // prints those beside this.
    return null
  }
  try {
    const body = JSON.parse(result.body)
    if (!body?.page) return null
    return {
      returned: Number(body.page.returned ?? 0),
      has_more: Boolean(body.page.has_more),
      total: typeof body.total === 'number' ? body.total : undefined,
    }
  } catch {
    return null
  }
}
