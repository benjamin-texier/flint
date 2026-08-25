import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../lib/api'
import {
  curlExample,
  declaredParams,
  endpointPath,
  parseDefaults,
  problemWithPublished,
  requiredParams,
  serialiseDefaults,
  slugify,
  allOpenapiPath,
  type Published,
} from '../lib/publish'
import { EmptyNote, ErrorNote, Loading } from '../components/Note'
import { CallBuilder } from '../components/CallBuilder'
import { CheckPanel } from '../components/CheckPanel'
import { readHandoff, suggestName, type Handoff } from '../lib/handoff'
import { usageIndex, type ApiUsage } from '../lib/diagnose'
import { count } from '../lib/format'
import { relativeTime } from '../lib/format'

/** How far back the usage figures look. */
const USAGE_DAYS = 7

/** No-code APIs: a statement, published at a stable URL.
 *
 *  The page's job is to make the two things that go wrong impossible to miss —
 *  which parameters a caller must supply, and whether the endpoint is open to
 *  anyone who has the address. */
export function PublishPage() {
  const config = useQuery({ queryKey: ['config'], queryFn: () => api.config() })
  const list = useQuery({ queryKey: ['published'], queryFn: () => api.published(), retry: false })
  /* Which of these anyone actually calls. Read from the query log, so it is
     absent rather than zeroed where the log is off. */
  const usage = useQuery({
    queryKey: ['api-usage', USAGE_DAYS],
    queryFn: () => api.apiUsage(USAGE_DAYS),
    staleTime: 30_000,
    retry: false,
  })
  const used = usageIndex(usage.data)
  const [editing, setEditing] = useState<Published | null>(null)
  const [adding, setAdding] = useState(false)
  const [params, setParams] = useSearchParams()
  const [handoff, setHandoff] = useState<Handoff | null>(() => readHandoff(params))
  useEffect(() => {
    if (readHandoff(params)) {
      setAdding(true)
      setParams(new URLSearchParams(), { replace: true })
    }
  }, [params, setParams])

  const stateless = config.data?.workspace === null
  const origin = typeof window === 'undefined' ? '' : window.location.origin

  return (
    <div className="page page--publish">
      <header className="page__head">
        <p className="eyebrow">APIS</p>
        <div className="page__titlerow">
          <h1 className="page__title page__title--hero">Queries, served</h1>
          {!stateless ? (
            <button
              className="btn btn--spark"
              onClick={() => {
                setEditing(null)
                setAdding(true)
              }}
            >
              New endpoint
            </button>
          ) : null}
        </div>
        <p className="page__lead">
          Write the statement once, with ClickHouse's own <code>{'{name:Type}'}</code>{' '}
          placeholders in it, and Flint serves it at a stable URL that a spreadsheet or a
          five-line script can fetch. Callers supply values, never SQL — and a published
          statement always runs read-only.
        </p>
        {/* Needs no token, so it is a link rather than a curl line. */}
        <p className="page__lead">
          Every endpoint below, in one document:{' '}
          <a className="pub__doclink" href={allOpenapiPath()}>
            OpenAPI
          </a>
        </p>
      </header>

      {stateless ? (
        <EmptyNote title="Publishing needs a workspace">
          Flint is running without one, so it has nowhere to keep an endpoint. Set
          `FLINT_WORKSPACE_DATABASE` to a database it may write to.
        </EmptyNote>
      ) : null}

      {list.isPending && !stateless ? <Loading label="Reading endpoints" /> : null}
      {list.error ? <ErrorNote error={list.error} retry={() => list.refetch()} /> : null}

      {adding || editing ? (
        <PublishForm
          existing={editing}
          handoff={editing ? null : handoff}
          defaultDatabase={config.data?.default_database ?? ''}
          onDone={() => {
            setAdding(false)
            setEditing(null)
            setHandoff(null)
          }}
        />
      ) : null}

      {list.data?.length ? (
        <ul className="alist">
          {list.data.map((endpoint) => (
            <EndpointRow
              key={endpoint.id}
              endpoint={endpoint}
              origin={origin}
              usage={used.get(endpoint.slug)}
              usageKnown={usage.data?.available ?? false}
              onEdit={() => {
                setAdding(false)
                setEditing(endpoint)
              }}
            />
          ))}
        </ul>
      ) : list.data && !adding ? (
        <EmptyNote title="Nothing is published">
          Turn a statement you keep re-running by hand into something another tool can ask for.
        </EmptyNote>
      ) : null}
    </div>
  )
}

function EndpointRow({
  endpoint,
  origin,
  usage,
  usageKnown,
  onEdit,
}: {
  endpoint: Published
  origin: string
  usage: ApiUsage | undefined
  /** False when the query log cannot be read, where "no calls" would be a
   *  guess dressed as a fact. */
  usageKnown: boolean
  onEdit: () => void
}) {
  const client = useQueryClient()
  const [showToken, setShowToken] = useState(false)
  /* Closed by default: the card's job is to say what the endpoint is, and the
     builder asks the endpoint to describe itself, which is a query. */
  const [showCaller, setShowCaller] = useState(false)
  const defaults = useMemo(() => parseDefaults(endpoint.defaults), [endpoint.defaults])
  const params = declaredParams(endpoint.sql)
  const required = requiredParams(endpoint.sql, defaults)

  const remove = useMutation({
    mutationFn: () => api.deletePublished(endpoint.id),
    onSuccess: () => client.invalidateQueries({ queryKey: ['published'] }),
  })
  const toggle = useMutation({
    mutationFn: () =>
      api.savePublished({
        id: endpoint.id,
        name: endpoint.name,
        slug: endpoint.slug,
        sql: endpoint.sql,
        database: endpoint.database,
        defaults: endpoint.defaults,
        public: endpoint.public,
        enabled: !endpoint.enabled,
        max_rows: endpoint.max_rows,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['published'] }),
  })

  return (
    <li className={`arow${endpoint.enabled ? '' : ' arow--off'}`}>
      <div className="arow__head">
        <h3 className="arow__name">{endpoint.name}</h3>
        {/* Openness is the fact most worth seeing without looking for it. */}
        {endpoint.public ? (
          <span className="flag flag--error">Public</span>
        ) : (
          <span className="flag flag--ok">Token required</span>
        )}
        {!endpoint.enabled ? <span className="flag flag--idle">Paused</span> : null}
        <span className="panel__spacer" />
        <button className="btn" onClick={() => toggle.mutate()} disabled={toggle.isPending}>
          {endpoint.enabled ? 'Pause' : 'Resume'}
        </button>
        <button className="btn" onClick={onEdit}>
          Edit
        </button>
        <button className="btn" onClick={() => remove.mutate()} disabled={remove.isPending}>
          Delete
        </button>
      </div>

      <p className="pub__url">
        <span className="pub__method">GET</span>
        <code>{endpointPath(endpoint.slug)}</code>
      </p>

      <pre className="arow__sql">{endpoint.sql}</pre>

      {params.length ? (
        <p className="arow__foot">
          <span className="mono-dim">
            parameters: {params.map((p) => (required.includes(p) ? p : `${p} (${defaults[p]})`)).join(', ')}
          </span>
          {required.length ? (
            <span className="says says--watch">
              a caller must supply {required.map((p) => `\`${p}\``).join(', ')}
            </span>
          ) : null}
        </p>
      ) : null}

      <div className="pub__try">
        <pre className="pub__curl">{curlExample(endpoint, origin)}</pre>
        <button
          className="btn"
          aria-expanded={showCaller}
          aria-controls={`caller-${endpoint.id}`}
          onClick={() => setShowCaller((s) => !s)}
        >
          {showCaller ? 'Hide the call' : 'Filter, page, try it'}
        </button>
        {!endpoint.public ? (
          <button className="btn" onClick={() => setShowToken((s) => !s)}>
            {showToken ? 'Hide token' : 'Show token'}
          </button>
        ) : null}
      </div>

      {showCaller ? (
        <div id={`caller-${endpoint.id}`}>
          <CallBuilder endpoint={endpoint} origin={origin} />
        </div>
      ) : null}
      {showToken && !endpoint.public ? (
        <p className="pub__token">
          <code>{endpoint.token}</code>
        </p>
      ) : null}

      <p className="arow__foot">
        {endpoint.database ? <span className="mono-dim">{endpoint.database}</span> : null}
        {/* A page, not a ceiling: `limit` and `offset` walk past it, and the
            statement's own LIMIT is the only thing that does not move. */}
        <span className="mono-dim">up to {endpoint.max_rows} rows per page</span>
        <span className="mono-dim">json · csv · ndjson</span>
        {/* Absent is not zero: with the query log off there is nothing to say,
            and saying "never called" would be a guess dressed as a fact. */}
        {!usageKnown ? (
          <span className="mono-dim">usage unknown — system.query_log is not readable</span>
        ) : usage ? (
          <span className="mono-dim">
            {count(usage.calls)} call{usage.calls === 1 ? '' : 's'} in {USAGE_DAYS}d ·{' '}
            {Math.round(usage.avg_ms)} ms · last {relativeTime(usage.last_call)}
          </span>
        ) : (
          <span className="says says--watch">not called in the last {USAGE_DAYS} days</span>
        )}
        {usage?.failures ? (
          <span className="says says--throw">
            {usage.failures} call{usage.failures === 1 ? '' : 's'} failed
          </span>
        ) : null}
      </p>
    </li>
  )
}

function PublishForm({
  existing,
  handoff,
  defaultDatabase,
  onDone,
}: {
  existing: Published | null
  /** A statement the editor sent over. Its name seeds the address too. */
  handoff: Handoff | null
  defaultDatabase: string
  onDone: () => void
}) {
  const client = useQueryClient()
  const handedName = handoff ? suggestName(handoff, '') : ''
  const [name, setName] = useState(existing?.name ?? handedName)
  const [slug, setSlug] = useState(existing?.slug ?? slugify(handedName))
  const [slugTouched, setSlugTouched] = useState(Boolean(existing))
  const [sql, setSql] = useState(existing?.sql ?? handoff?.sql ?? '')
  const [database, setDatabase] = useState(
    existing?.database ?? handoff?.database ?? defaultDatabase,
  )
  const [defaults, setDefaults] = useState<Record<string, string>>(() =>
    parseDefaults(existing?.defaults ?? '{}'),
  )
  const [isPublic, setPublic] = useState(existing?.public ?? false)
  const [maxRows, setMaxRows] = useState(existing?.max_rows ?? 1000)

  const params = declaredParams(sql)
  /* Testable here only when every placeholder has a value to stand in for the
     caller's. A made-up value would answer a question nobody asked. */
  const missingDefaults = requiredParams(sql, defaults)
  const problem = problemWithPublished({ name, slug, sql })

  const save = useMutation({
    mutationFn: () =>
      api.savePublished({
        id: existing?.id,
        name,
        slug: slug.trim(),
        sql,
        database,
        defaults: serialiseDefaults(defaults),
        public: isPublic,
        enabled: existing?.enabled ?? true,
        max_rows: maxRows,
      }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['published'] })
      onDone()
    },
  })

  return (
    <section className="aform">
      <header className="aform__head">
        <h2 className="diag__title">{existing ? 'Edit this endpoint' : 'A new endpoint'}</h2>
      </header>

      <div className="aform__row">
        <label className="aform__field aform__field--narrow">
          <span className="label">NAME</span>
          <input
            className="input"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              // The address follows the name until someone edits it, so
              // nobody has to learn the rule to get a working URL.
              if (!slugTouched) setSlug(slugify(e.target.value))
            }}
            placeholder="Events by city"
          />
        </label>
        <label className="aform__field aform__field--narrow">
          <span className="label">ADDRESS</span>
          <input
            className="input"
            value={slug}
            onChange={(e) => {
              setSlugTouched(true)
              setSlug(e.target.value)
            }}
            placeholder="events-by-city"
          />
        </label>
      </div>

      <p className="aform__hint">
        Will answer at <code>{endpointPath(slug || 'your-address')}</code>
      </p>

      <label className="aform__field">
        <span className="label">STATEMENT</span>
        <textarea
          className="input input--area"
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          rows={4}
          spellCheck={false}
          placeholder="SELECT city, count() AS n FROM events WHERE city = {city:String} GROUP BY city"
        />
      </label>

      {params.length ? (
        <div className="pub__params">
          <span className="label">PARAMETERS THIS STATEMENT DECLARES</span>
          {params.map((p) => (
            <label className="pub__param" key={p}>
              <code>{p}</code>
              <input
                className="input"
                value={defaults[p] ?? ''}
                onChange={(e) => setDefaults((d) => ({ ...d, [p]: e.target.value }))}
                placeholder="no default — a caller must supply it"
              />
            </label>
          ))}
        </div>
      ) : null}

      <div className="aform__row">
        <label className="aform__field aform__field--narrow">
          <span className="label">DATABASE</span>
          <input
            className="input"
            value={database}
            onChange={(e) => setDatabase(e.target.value)}
            placeholder="default"
          />
        </label>
        <label className="aform__field aform__field--tiny">
          <span className="label">MAX ROWS</span>
          <input
            className="input"
            value={maxRows}
            onChange={(e) => setMaxRows(Math.max(1, Number(e.target.value) || 1))}
            inputMode="numeric"
          />
        </label>
        <label className="aform__field aform__field--narrow">
          <span className="label">ACCESS</span>
          <select
            className="input"
            value={isPublic ? 'public' : 'token'}
            onChange={(e) => setPublic(e.target.value === 'public')}
          >
            <option value="token">needs its token</option>
            <option value="public">anyone with the address</option>
          </select>
        </label>
      </div>

      {/* With the defaults filled in, this is what a caller will get. A
          statement with a parameter that has no default cannot be run here,
          and the check says so rather than pretending. */}
      <CheckPanel
        sql={sql}
        database={database}
        params={params.map((p) => [p, defaults[p] ?? ''] as [string, string])}
        blocked={
          missingDefaults.length
            ? `Give ${missingDefaults.map((p) => `\`${p}\``).join(', ')} a default above to test it here — a caller would supply ${missingDefaults.length === 1 ? 'it' : 'them'}.`
            : undefined
        }
        label="What will a caller get?"
      />

      {isPublic ? (
        <p className="says says--watch">
          Anyone who can reach this Flint and knows the address will get this data. Flint has no
          login of its own, so "public" means public to the whole network it is on.
        </p>
      ) : (
        <p className="aform__hint">
          A token is minted for you and stays the same when you edit the endpoint, so callers do
          not break.
        </p>
      )}

      {problem ? <p className="says says--watch">{problem}</p> : null}
      {save.error ? <ErrorNote error={save.error} /> : null}

      <div className="aform__actions">
        <button
          className="btn btn--spark"
          disabled={!!problem || save.isPending}
          onClick={() => save.mutate()}
        >
          {existing ? 'Save changes' : 'Publish it'}
        </button>
        <button className="btn" onClick={onDone}>
          Cancel
        </button>
      </div>
    </section>
  )
}
