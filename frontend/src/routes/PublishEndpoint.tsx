import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../lib/api'
import {
  answers,
  byAddress,
  callerName,
  contractIsEmpty,
  declaredParamsTyped,
  endpointPath,
  nextRevision,
  openapiPath,
  parseContract,
  parseDefaults,
  quotaFilled,
  quotaNote,
  requiredParams,
  quoted,
  toolPath,
  unkeepablePromises,
  STATE_NOTE,
  type CacheUsage,
  type CallerUsage,
  type Contract,
  type EndpointUsage,
  type KeyUsage,
  type Published,
  type RefusalUsage,
} from '../lib/publish'
import { EmptyNote, ErrorNote, Loading } from '../components/Note'
import { PublishForm } from '../components/PublishForm'
import { CallBuilder } from '../components/CallBuilder'
import { count, relativeTime } from '../lib/format'

const WINDOW_HOURS = 24

/** One address, in full.
 *
 *  The left column is the contract — what a caller may change, what runs, and
 *  what the endpoint says about itself. The right column is what has actually
 *  been happening to it. They are side by side on purpose: almost every
 *  question anybody brings to this page is really a question about the pair
 *  ("who is still on v3", "why is the bot getting 429s", "is that cache doing
 *  anything"), and answering it out of two screens is answering it badly. */
export function PublishEndpointPage() {
  const { slug = '' } = useParams()
  const client = useQueryClient()
  const list = useQuery({ queryKey: ['published'], queryFn: () => api.published(), retry: false })
  const usage = useQuery({
    queryKey: ['endpoint-usage', slug, WINDOW_HOURS],
    queryFn: () => api.endpointUsage(slug, WINDOW_HOURS),
    staleTime: 15_000,
    retry: false,
  })
  const config = useQuery({ queryKey: ['config'], queryFn: () => api.config() })

  const address = byAddress(list.data ?? []).find((a) => a.slug === slug)
  /* Which revision the page is showing. The live one by default, because that
     is the one a bare address reaches and therefore the one somebody arriving
     from a link means. */
  const [showing, setShowing] = useState<string | null>(null)
  const revision = address?.revisions.find((r) => r.id === showing) ?? address?.current
  const [editing, setEditing] = useState(false)
  /* Readable once. A revision going live is when a token-guarded endpoint gets
     its first, and this is the only moment anything can read it. */
  const [minted, setMinted] = useState<string | null>(null)

  /* What this revision's statement returns. Only ever used to check the
     contract against reality — a promise about a column that is not there is
     one the endpoint cannot keep, and this page is where somebody would go
     looking for the reason a caller is getting an error about an unknown
     identifier. */
  const shown = address?.revisions.find((r) => r.id === showing) ?? address?.current
  const returned = useQuery({
    queryKey: ['endpoint-columns', slug, shown?.revision],
    queryFn: () => api.endpointColumns(slug, shown?.revision),
    enabled: Boolean(shown),
    staleTime: 60_000,
    retry: false,
  })

  const move = useMutation({
    mutationFn: (to: 'live' | 'retiring' | 'retired') =>
      api.setRevisionState(revision?.id ?? '', to),
    onSuccess: (saved) => {
      setMinted(saved.minted ?? null)
      client.invalidateQueries({ queryKey: ['published'] })
    },
  })
  const branch = useMutation({
    mutationFn: () => api.newRevision(slug),
    onSuccess: () => client.invalidateQueries({ queryKey: ['published'] }),
  })

  if (list.isPending) return <Loading label="Reading the endpoint" />
  if (list.error) return <ErrorNote error={list.error} retry={() => list.refetch()} />
  if (!address || !revision) {
    return (
      <EmptyNote title={`No endpoint at ${slug}`}>
        Nothing is published at this address.{' '}
        <Link className="pub__doclink" to="/apis">
          Back to the endpoints
        </Link>
      </EmptyNote>
    )
  }

  const contract = parseContract(revision.contract)
  const declared = declaredParamsTyped(revision.sql)
  const defaults = parseDefaults(revision.defaults)
  const required = requiredParams(revision.sql, defaults)
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  const hasDraft = address.revisions.some((r) => r.state === 'draft')

  return (
    <div className="page page--endpoint">
      <header className="page__head">
        <p className="eyebrow">
          ENDPOINT
          <span className={`flag flag--${revision.state === 'live' ? 'ok' : 'idle'}`}>
            {revision.state} · v{revision.revision}
          </span>
          {revision.published_by ? (
            <span className="mono-dim">published by {revision.published_by}</span>
          ) : null}
          {address.revisions
            .filter((r) => r.state === 'retiring' && r.id !== revision.id)
            .map((r) => (
              <span className="mono-dim" key={r.id}>
                v{r.revision} retiring
              </span>
            ))}
        </p>
        <div className="page__titlerow">
          <h1 className="page__title page__title--hero ep__title">
            <span className="ep__method">GET</span> {endpointPath(address.slug)}
          </h1>
          <div className="ep__actions">
            <a className="btn" href={openapiPath(address.slug)}>
              OpenAPI
            </a>
            {answers(revision.state) ? (
              <button
                className="btn btn--spark"
                onClick={() => branch.mutate()}
                disabled={branch.isPending || hasDraft}
                title={
                  hasDraft
                    ? 'There is already a draft of this address. Finish or discard it first.'
                    : undefined
                }
              >
                {branch.isPending ? 'Starting…' : `New version (v${nextRevision(address)})`}
              </button>
            ) : null}
            {revision.state === 'draft' ? (
              <button
                className="btn btn--spark"
                onClick={() => move.mutate('live')}
                disabled={move.isPending}
              >
                {move.isPending ? 'Going live…' : 'Issue a key and go live'}
              </button>
            ) : null}
            {revision.state === 'retiring' ? (
              <>
                <button
                  className="btn"
                  onClick={() => move.mutate('live')}
                  disabled={move.isPending}
                >
                  Call it off
                </button>
                <button
                  className="btn"
                  onClick={() => move.mutate('retired')}
                  disabled={move.isPending}
                >
                  Retire it now
                </button>
              </>
            ) : null}
          </div>
        </div>
        {branch.error ? <ErrorNote error={branch.error} /> : null}
        {move.error ? <ErrorNote error={move.error} /> : null}
        {minted ? (
          <p className="pub__token">
            <code>{minted}</code>
            <span className="mono-dim">
              Copy this now — it is stored hashed, so this is the only time anyone can read it.
            </span>
          </p>
        ) : null}
        <p className="page__lead">{STATE_NOTE[revision.state]}</p>
      </header>

      {address.revisions.length > 1 ? (
        <Revisions
          revisions={address.revisions}
          showing={revision.id}
          onShow={(id) => {
            setShowing(id)
            setEditing(false)
          }}
        />
      ) : null}

      {editing ? (
        <PublishForm
          existing={revision}
          handoff={null}
          defaultDatabase={config.data?.default_database ?? ''}
          delegatableRoles={config.data?.delegatable_roles ?? []}
          timezone={undefined}
          onDone={() => setEditing(false)}
        />
      ) : null}

      <div className="ep__cols">
        <div className="ep__left">
          <ContractPanel
            revision={revision}
            contract={contract}
            declared={declared}
            defaults={defaults}
            required={required}
            nextNumber={nextRevision(address)}
            onEdit={() => setEditing((e) => !e)}
            editing={editing}
            returns={returned.data?.known ? returned.data.columns.map((c) => c.name) : []}
          />
          <StatementPanel revision={revision} />
          <DescriptionPanel revision={revision} origin={origin} />
        </div>
        <div className="ep__right">
          {usage.isPending ? <Loading label="Reading the call log" /> : null}
          {usage.data && !usage.data.available ? (
            <section className="ep__panel">
              <h2 className="ep__paneltitle">Traffic unknown</h2>
              <p className="says says--watch says--wide">
                Flint could not read its own call log
                {usage.data.reason ? `: ${usage.data.reason}` : ''}. Nothing below is zero — it is
                absent.
              </p>
            </section>
          ) : null}
          {usage.data?.available ? <Panels usage={usage.data} ttl={revision.cache_ttl} /> : null}
        </div>
      </div>
    </div>
  )
}

/** Every revision of this address, as a tablist.
 *
 *  A tablist because that is what it is, and the role brings obligations: one
 *  tab stop for the whole set, arrows to move between them. */
function Revisions({
  revisions,
  showing,
  onShow,
}: {
  revisions: Published[]
  showing: string
  onShow: (id: string) => void
}) {
  const at = revisions.findIndex((r) => r.id === showing)
  return (
    <div className="ep__revs" role="tablist" aria-label="Revisions of this endpoint">
      {revisions.map((revision) => (
        <button
          key={revision.id}
          role="tab"
          id={`rev-${revision.id}`}
          aria-selected={revision.id === showing}
          tabIndex={revision.id === showing ? 0 : -1}
          className={`ep__rev${revision.id === showing ? ' is-on' : ''}`}
          onClick={() => onShow(revision.id)}
          onKeyDown={(e) => {
            const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
            if (!step) return
            e.preventDefault()
            const next = revisions[(at + step + revisions.length) % revisions.length]
            if (!next) return
            onShow(next.id)
            document.getElementById(`rev-${next.id}`)?.focus()
          }}
        >
          v{revision.revision}
          <span className={`flag flag--${revision.state === 'live' ? 'ok' : 'idle'}`}>
            {revision.state}
          </span>
        </button>
      ))}
    </div>
  )
}

function ContractPanel({
  revision,
  contract,
  declared,
  defaults,
  required,
  nextNumber,
  onEdit,
  editing,
  returns,
}: {
  revision: Published
  contract: Contract
  declared: { name: string; type: string }[]
  defaults: Record<string, string>
  required: string[]
  nextNumber: number
  onEdit: () => void
  editing: boolean
  /** What the statement actually returns, or empty where Flint could not find
   *  out. Empty means nothing is claimed, not that nothing is returned. */
  returns: string[]
}) {
  const exposure = contract.columns
  /* The contract says what may leave; this says what there is. They disagree
     when somebody promised a column from memory, or when a later revision of
     the statement stopped selecting one. */
  const exposed = returns.length
    ? returns.filter((name) => !exposure.never?.includes(name)).filter(
        (name) => !exposure.only?.length || exposure.only.includes(name),
      )
    : (exposure.only ?? [])
  const stale = unkeepablePromises(contract, returns)
  /* The sort list, narrowed the same way the exposed list is: showing `p95` as
     sortable when the statement does not return it is the same lie in a
     different row. */
  const sortable = returns.length
    ? contract.order_by.filter((name) => returns.includes(name))
    : contract.order_by
  return (
    <section className="ep__panel">
      <h2 className="ep__paneltitle">
        What a caller may change
        <span className="mono-dim">values, exposed columns, sort — nothing else</span>
      </h2>

      {declared.length === 0 && contractIsEmpty(contract) ? (
        <p className="ep__none">
          This statement declares no parameters and this revision promises nothing beyond them, so
          a caller may change only the page and the format.
        </p>
      ) : (
        <table className="tbl ep__contract">
          <tbody>
            {declared.map(({ name, type }) => {
              const rule = contract.params.find((r) => r.name === name)
              const says: string[] = []
              if (required.includes(name)) says.push('required')
              else says.push(`defaults to ${defaults[name]}`)
              if (rule?.min) says.push(`no earlier than ${rule.min}`)
              if (rule?.max) says.push(`no later than ${rule.max}`)
              if (rule?.one_of?.length) says.push(`one of ${rule.one_of.join(', ')}`)
              if (rule?.window_days && rule.window_to) {
                says.push(`window capped at ${rule.window_days} days`)
              }
              if (rule?.note) says.push(rule.note)
              return (
                <tr key={name}>
                  <th scope="row">{name}</th>
                  <td className="ep__ctype">{type}</td>
                  <td className="ep__csays">{says.join(' · ')}</td>
                  <td className="ep__cval">
                    {/* The value a caller gets if they send nothing. Dropped
                        rather than dashed where there is none: a required
                        parameter has no default, and an em-dash would say
                        Flint failed to read one. */}
                    {defaults[name] ?? null}
                  </td>
                </tr>
              )
            })}
            {sortable.length ? (
              <tr>
                <th scope="row">order</th>
                <td className="ep__ctype">Column</td>
                <td className="ep__csays">{sortable.join(', ')} — nothing else accepted</td>
                <td className="ep__cval" />
              </tr>
            ) : null}
            {exposure.only?.length || exposure.never?.length ? (
              <tr>
                <th scope="row">select</th>
                <td className="ep__ctype">Columns</td>
                <td className="ep__csays">
                  {/* The count follows the list, and the list is what the
                      statement can actually produce — a header counting
                      columns the endpoint cannot return is a header nobody can
                      reconcile. Where Flint could not describe the statement,
                      the contract's own list is shown and no count is claimed
                      against it. */}
                  {exposure.only?.length
                    ? returns.length
                      ? `${exposed.length} of ${returns.length} exposed: ${exposed.join(', ')}`
                      : `exposed: ${exposure.only.join(', ')}`
                    : 'every column it returns'}
                  {exposure.never?.length
                    ? ` · ${exposure.never.join(', ')} ${
                        exposure.never.length === 1 ? 'is' : 'are'
                      } never returned`
                    : ''}
                </td>
                <td className="ep__cval" />
              </tr>
            ) : null}
            {contract.max_limit !== undefined ? (
              <tr>
                <th scope="row">limit</th>
                <td className="ep__ctype">UInt32</td>
                <td className="ep__csays">
                  defaults to {Math.min(contract.max_limit, revision.max_rows)} · max{' '}
                  {contract.max_limit}
                </td>
                <td className="ep__cval" />
              </tr>
            ) : null}
          </tbody>
        </table>
      )}

      {stale.offered.length ? (
        <p className="says says--watch says--wide">
          This revision offers {quoted(stale.offered)} and its statement does not return{' '}
          {stale.offered.length === 1 ? 'it' : 'them'}. The document and the tool definition leave{' '}
          {stale.offered.length === 1 ? 'it' : 'them'} out, so a caller never learns
          {stale.offered.length === 1 ? ' it was' : ' they were'} offered — and one who asks by
          name gets an error about an unknown identifier. Fix it on a new revision.
        </p>
      ) : null}
      {stale.guarding.length ? (
        <p className="says says--watch says--wide">
          The deny-list keeps in {quoted(stale.guarding)}, which this statement does not return, so
          it guards nothing. Worth checking against what it does return: a rule written for a name
          that does not exist leaves the column it was meant to keep inside leaving on every call.
        </p>
      ) : null}

      <p className="ep__panelfoot">
        <button className="btn btn--quiet" onClick={onEdit} aria-expanded={editing}>
          {editing ? 'Close the editor' : 'Edit the contract'}
        </button>
        {answers(revision.state) ? (
          <span className="mono-dim">
            a change here starts v{nextNumber}, it does not alter v{revision.revision}
          </span>
        ) : (
          <span className="mono-dim">this revision is a draft, so it can still be changed</span>
        )}
      </p>
    </section>
  )
}

function StatementPanel({ revision }: { revision: Published }) {
  return (
    <section className="ep__panel">
      <h2 className="ep__paneltitle">
        The statement that runs
        {revision.source ? <span className="mono-dim">{revision.source}</span> : null}
      </h2>
      <pre className="ep__sql">{revision.sql}</pre>
      <p className="ep__panelfoot">
        Sent as a ClickHouse parameterised query, so a value can never become SQL. The sort is
        resolved against the allow-list before the statement is built.
        {revision.run_as ? (
          <>
            {' '}
            It runs as <code>{revision.run_as}</code>.
          </>
        ) : null}
      </p>
    </section>
  )
}

function DescriptionPanel({ revision, origin }: { revision: Published; origin: string }) {
  const [showCaller, setShowCaller] = useState(false)
  return (
    <section className="ep__panel">
      <h2 className="ep__paneltitle">
        How it is described to callers
        <span className="mono-dim">the text an agent or a notebook reads</span>
      </h2>
      {revision.description ? (
        <p className="ep__prose">{revision.description}</p>
      ) : (
        <p className="ep__none">
          Nothing has been written. The OpenAPI document will describe this endpoint&rsquo;s
          mechanics and say nothing about what it is <em>for</em> — which is the one part a person
          has to write.
        </p>
      )}
      <p className="ep__panelfoot">
        <a className="btn btn--quiet" href={openapiPath(revision.slug)}>
          openapi.json
        </a>
        {/* The same facts, for whoever is wiring this into an agent. Worth its
            own chip rather than a line in the document: the contract's enums
            and caps become argument constraints there, which is the difference
            between a model that guesses `region` and one that cannot. */}
        <a className="btn btn--quiet" href={toolPath(revision.slug)}>
          tool.json
        </a>
        <button
          className="btn btn--quiet"
          aria-expanded={showCaller}
          aria-controls={`caller-${revision.id}`}
          onClick={() => setShowCaller((s) => !s)}
        >
          {showCaller ? 'Hide the call' : 'curl, Python, a spreadsheet'}
        </button>
      </p>
      {showCaller ? (
        <div id={`caller-${revision.id}`}>
          <CallBuilder endpoint={revision} origin={origin} />
        </div>
      ) : null}
    </section>
  )
}

function Panels({ usage, ttl }: { usage: EndpointUsage; ttl: number }) {
  return (
    <>
      <CachePanel cache={usage.cache} ttl={ttl} />
      <KeysPanel keys={usage.keys} />
      <CallersPanel callers={usage.callers} hours={usage.window_hours} calls={usage.calls} />
      <RefusalsPanel refusals={usage.refusals} failures={usage.failures} calls={usage.calls} />
    </>
  )
}

function CachePanel({ cache, ttl }: { cache: CacheUsage; ttl: number }) {
  if (ttl <= 0) {
    return (
      <section className="ep__panel">
        <h2 className="ep__paneltitle">Cache</h2>
        <p className="ep__none">
          Off. Every call runs the statement, so nothing a caller receives is older than the moment
          they asked.
        </p>
      </section>
    )
  }
  return (
    <section className="ep__panel">
      <h2 className="ep__paneltitle">
        Cache
        <span className="mono-dim">{ttl} s · keyed on the parameters</span>
      </h2>
      <div className="ep__figures">
        {/* A rate needs a denominator: absent rather than 0% where nobody has
            called, because 0% would be a claim about traffic that does not
            exist. */}
        {cache.hit_rate !== undefined ? (
          <Figure value={`${Math.round(cache.hit_rate * 100)}`} unit="%" label="HIT RATE" />
        ) : null}
        {cache.avg_hit_ms !== undefined ? (
          <Figure value={`${Math.round(cache.avg_hit_ms)}`} unit="ms" label="FROM CACHE" />
        ) : null}
        {cache.avg_miss_ms !== undefined ? (
          <Figure value={`${Math.round(cache.avg_miss_ms)}`} unit="ms" label="FROM CLICKHOUSE" />
        ) : null}
      </div>
      <p className="ep__panelfoot">
        {cache.oldest_held !== undefined ? (
          <>
            Oldest row a caller can receive right now: {cache.oldest_held} second
            {cache.oldest_held === 1 ? '' : 's'}, across {cache.held} held answer
            {cache.held === 1 ? '' : 's'}.
          </>
        ) : (
          <>Nothing is held right now, so the next call of every shape runs the statement.</>
        )}
      </p>
    </section>
  )
}

function Figure({ value, unit, label }: { value: string; unit: string; label: string }) {
  return (
    <div className="ep__figure">
      <span className="ep__fignum">
        {value}
        <span className="ep__figunit">{unit}</span>
      </span>
      <span className="label">{label}</span>
    </div>
  )
}

function KeysPanel({ keys }: { keys: KeyUsage[] }) {
  return (
    <section className="ep__panel">
      <h2 className="ep__paneltitle">
        Keys and quotas
        <span className="mono-dim">per key, per day</span>
      </h2>
      {keys.length === 0 ? (
        <p className="ep__none">
          No key is scoped to this address. It answers to its own token, or to anyone at all if it
          is public — either way the call log cannot say who is calling.
        </p>
      ) : (
        <ul className="ep__keys">
          {keys.map((key) => {
            const filled = quotaFilled(key)
            const note = quotaNote(key)
            return (
              <li className="ep__key" key={key.key_id}>
                <span className="ep__keyname">{key.key_name}</span>
                <span className="ep__keycount">
                  {count(key.calls_today)}
                  {key.quota_per_day > 0 ? (
                    <> of {count(key.quota_per_day)} / day</>
                  ) : (
                    <span className="mono-dim"> today · no limit</span>
                  )}
                </span>
                {filled !== null ? (
                  <span
                    className={`ep__meter${key.throttled_today > 0 ? ' is-over' : ''}`}
                    role="meter"
                    aria-valuenow={key.calls_today}
                    aria-valuemin={0}
                    aria-valuemax={key.quota_per_day}
                    aria-label={`${key.key_name} against its daily quota`}
                  >
                    <span className="ep__meterfill" style={{ inlineSize: `${filled * 100}%` }} />
                  </span>
                ) : null}
                {note ? <span className="ep__keynote">{note}</span> : null}
                {key.owner ? <span className="mono-dim">{key.owner}</span> : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function CallersPanel({
  callers,
  hours,
  calls,
}: {
  callers: CallerUsage[]
  hours: number
  calls: number
}) {
  const top = callers[0]?.calls ?? 0
  const shown = callers.reduce((sum, caller) => sum + caller.calls, 0)
  return (
    <section className="ep__panel">
      <h2 className="ep__paneltitle">
        Who calls it
        <span className="mono-dim">last {hours} hours</span>
      </h2>
      {callers.length === 0 ? (
        <p className="ep__none">Nobody has called this in the last {hours} hours.</p>
      ) : (
        <ul className="ep__callers">
          {callers.map((caller) => (
            <li className="ep__caller" key={`${caller.key_name} ${caller.label}`}>
              <span className="ep__callername">{callerName(caller)}</span>
              <span className="ep__callerbar" aria-hidden="true">
                <span
                  className="ep__callerfill"
                  style={{ inlineSize: `${top > 0 ? (caller.calls / top) * 100 : 0}%` }}
                />
              </span>
              <span className="ep__callern">{count(caller.calls)}</span>
            </li>
          ))}
        </ul>
      )}
      {/* Counts follow the list: a header that counted calls these rows do not
          show would be a header nobody can reconcile. This says what was left
          out instead, and only when something was. */}
      {shown < calls ? (
        <p className="ep__panelfoot">
          Showing the {callers.length} that called most, of {count(calls)} calls in all.
        </p>
      ) : null}
    </section>
  )
}

function RefusalsPanel({
  refusals,
  failures,
  calls,
}: {
  refusals: RefusalUsage[]
  failures: number
  calls: number
}) {
  if (refusals.length === 0) {
    return (
      <section className="ep__panel">
        <h2 className="ep__paneltitle">Refused and failed</h2>
        <p className="ep__none">Nothing has been turned away.</p>
      </section>
    )
  }
  const total = calls + failures
  const share = total > 0 ? (failures / total) * 100 : 0
  return (
    <section className="ep__panel">
      <h2 className="ep__paneltitle">
        Refused and failed
        <span className="mono-dim">
          {count(failures)} call{failures === 1 ? '' : 's'} · {share.toFixed(2)}% of traffic
        </span>
      </h2>
      <ul className="ep__refusals">
        {refusals.map((refusal) => (
          <li className="ep__refusal" key={`${refusal.status} ${refusal.reason}`}>
            <span className={`ep__status ep__status--${Math.floor(refusal.status / 100)}`}>
              {refusal.status}
            </span>
            <span className="ep__reason">{refusal.reason}</span>
            <span className="ep__refusaln">{count(refusal.calls)}</span>
            <span className="mono-dim">last {relativeTime(refusal.last_call)}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
