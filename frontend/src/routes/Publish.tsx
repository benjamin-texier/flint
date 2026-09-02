import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import {
  allOpenapiPath,
  byAddress,
  endpointPath,
  hiddenNote,
  hitRate,
  listedRevisions,
  unreachedCalls,
  usageBySlug,
  usageKey,
  type Address,
  type Published,
  type SlugUsage,
} from '../lib/publish'
import { EmptyNote, ErrorNote, Loading } from '../components/Note'
import { PublishForm } from '../components/PublishForm'
import { ExposeTables } from '../components/ExposeTables'
import { Keys } from '../components/Keys'
import { NeedsWorkspace } from '../components/NeedsWorkspace'
import { readHandoff, type Handoff } from '../lib/handoff'
import { count } from '../lib/format'
import { keeps } from '../lib/spaces'

/** How far back the figures on this page look. A day, because "Calls 24h" is
 *  the column somebody scans, and a week's total tells you nothing about
 *  whether an endpoint is busy *now*. */
const WINDOW_HOURS = 24

/** What is exposed, and to whom.
 *
 *  One row per revision that a caller can still reach, plus every draft —
 *  because a draft is precisely the thing somebody needs to see in order to do
 *  something about it. Retired revisions are folded away and counted.
 *
 *  The page's job is to make three things impossible to miss: which addresses
 *  answer without a key, which revisions are on their way out and still being
 *  called, and which drafts are sitting unreviewed. Everything else is a
 *  figure, and a figure Flint cannot read is dropped rather than shown as a
 *  zero. */
export function PublishPage() {
  const config = useQuery({ queryKey: ['config'], queryFn: () => api.config() })
  const stateful = keeps(config.data)
  const list = useQuery({
    queryKey: ['published'],
    queryFn: () => api.published(),
    enabled: stateful,
    retry: false,
  })
  const usage = useQuery({
    queryKey: ['published-usage', WINDOW_HOURS],
    queryFn: () => api.publishedUsage(WINDOW_HOURS),
    enabled: stateful,
    staleTime: 30_000,
    retry: false,
  })
  const used = usageBySlug(usage.data)
  /* Absent is not zero. With the call log unreadable there is nothing to say,
     and "never called" would be a guess dressed as a fact. */
  const usageKnown = usage.data?.available ?? false

  const [params, setParams] = useSearchParams()
  const [adding, setAdding] = useState(false)
  /* Addressable for the same reason the key list is: "how do I expose these
     tables" is a question somebody sends a link for, and a panel folded shut on
     arrival makes the link useless. */
  const [exposing, setExposing] = useState(() => params.has('expose'))
  const [handoff, setHandoff] = useState<Handoff | null>(() => readHandoff(params))
  useEffect(() => {
    if (readHandoff(params)) {
      setAdding(true)
      setParams(new URLSearchParams(), { replace: true })
    }
  }, [params, setParams])

  const stateless = config.data?.workspace === null
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  const addresses = byAddress(list.data ?? [])

  return (
    <div className="page page--publish">
      <header className="page__head">
        <p className="eyebrow">DATA · ENDPOINTS</p>
        <div className="page__titlerow">
          <h1 className="page__title page__title--hero">What is exposed, and to whom</h1>
          {!stateless ? (
            <div className="page__actions">
              {/* Two doors, because they are two different jobs. A statement is
                  for a join or an aggregate somebody wrote; tables are for
                  handing a partner read access to fifteen of them, which used
                  to be fifteen visits to the other form. */}
              <button
                className="btn"
                onClick={() => {
                  setExposing((e) => !e)
                  setAdding(false)
                }}
                aria-expanded={exposing}
              >
                Expose tables
              </button>
              <button
                className="btn btn--spark"
                onClick={() => {
                  setAdding(true)
                  setExposing(false)
                }}
              >
                Publish a statement
              </button>
            </div>
          ) : null}
        </div>
        <p className="page__lead">
          Base URL <code>{origin}/api/data</code> · every call is logged with its key and its
          cost. A caller supplies values, never SQL, and a published statement always runs
          read-only.{' '}
          <a className="pub__doclink" href={allOpenapiPath()}>
            OpenAPI for all of them
          </a>
        </p>
      </header>

      {stateless ? (
        <NeedsWorkspace title="Publishing needs a workspace" holds="an endpoint" />
      ) : null}

      {list.isPending && !stateless ? <Loading label="Reading endpoints" /> : null}
      {list.error ? <ErrorNote error={list.error} retry={() => list.refetch()} /> : null}

      {exposing ? (
        <ExposeTables
          defaultDatabase={config.data?.default_database ?? ''}
          onDone={() => setExposing(false)}
        />
      ) : null}

      {adding ? (
        <PublishForm
          existing={null}
          handoff={handoff}
          defaultDatabase={config.data?.default_database ?? ''}
          delegatableRoles={config.data?.delegatable_roles ?? []}
          timezone={undefined}
          onDone={() => {
            setAdding(false)
            setHandoff(null)
          }}
        />
      ) : null}

      {addresses.length ? (
        <EndpointTable
          addresses={addresses}
          used={used}
          usageKnown={usageKnown}
          unreached={unreachedCalls(usage.data)}
        />
      ) : list.data && !adding ? (
        <EmptyNote title="Nothing is published">
          Turn a statement you keep re-running by hand into something another tool can ask for.
        </EmptyNote>
      ) : null}

      {addresses.length ? <Attention addresses={addresses} used={used} /> : null}

      {/* Keys are global — one program calls four addresses — so they live on
          the page that lists all of them rather than on any one endpoint. */}
      {!stateless ? <Keys addresses={addresses} defaultOpen={params.has('keys')} /> : null}
    </div>
  )
}

function EndpointTable({
  addresses,
  used,
  usageKnown,
  unreached,
}: {
  addresses: Address[]
  used: Map<string, SlugUsage>
  usageKnown: boolean
  /** Calls refused before Flint knew which revision they wanted, so they
   *  belong to no row above. */
  unreached: number
}) {
  const folded = addresses
    .map((a) => hiddenNote(a))
    .filter((n): n is string => n !== null).length

  return (
    <>
      <table className="tbl eps">
        <thead>
          <tr>
            <th scope="col">Path</th>
            <th scope="col">From</th>
            <th scope="col" className="eps__n">
              Ver.
            </th>
            <th scope="col" className="eps__n">
              Calls {WINDOW_HOURS}h
            </th>
            <th scope="col" className="eps__n">
              p95
            </th>
            <th scope="col" className="eps__n">
              Cached
            </th>
            <th scope="col" className="eps__n">
              Keys
            </th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {addresses.map((address) =>
            listedRevisions(address).map((revision) => (
              <Row
                key={revision.id}
                address={address}
                revision={revision}
                /* Per revision, because that is the question the row is
                   asking. "v3 is retiring and still took two thousand calls
                   today" is the sentence somebody acts on, and an
                   address-level total hides it inside the revision that
                   replaced it. */
                usage={used.get(usageKey(address.slug, revision.revision))}
                usageKnown={usageKnown}
              />
            )),
          )}
        </tbody>
      </table>
      {/* Every fold states its own count. */}
      {folded > 0 || !usageKnown || unreached > 0 ? (
        <p className="eps__foot">
          {folded > 0 ? (
            <span className="mono-dim">
              {addresses
                .map((a) => hiddenNote(a))
                .filter(Boolean)
                .join(' · ')}
            </span>
          ) : null}
          {unreached > 0 ? (
            <span className="mono-dim">
              {count(unreached)} call{unreached === 1 ? '' : 's'} reached no revision — a wrong
              address, a pin for one that does not exist, or no key
            </span>
          ) : null}
          {!usageKnown ? (
            <span className="says says--watch">
              Traffic unknown — Flint could not read its own call log, so the four figures on the
              right are absent rather than zero.
            </span>
          ) : null}
        </p>
      ) : null}
    </>
  )
}

function Row({
  address,
  revision,
  usage,
  usageKnown,
}: {
  address: Address
  revision: Published
  usage: SlugUsage | undefined
  usageKnown: boolean
}) {
  const cached = usage ? hitRate(revision.cache_ttl, usage.calls, usage.cached) : null
  const muted = revision.state !== 'live'

  return (
    <tr className={muted ? 'is-muted' : undefined}>
      <th scope="row">
        <Link className="eps__path" to={`/apis/${encodeURIComponent(address.slug)}`}>
          {endpointPath(address.slug)}
        </Link>
        {!revision.enabled ? <span className="flag flag--idle">Paused</span> : null}
        {revision.public ? <span className="flag flag--error">Public</span> : null}
      </th>
      <td className="eps__from">
        {/* An absent source is dropped, not dashed: a join has no single table
            to name, and four em-dashes would say Flint asked the wrong
            question. */}
        {revision.source ? <code>{revision.source}</code> : null}
      </td>
      <td className="eps__n">v{revision.revision}</td>
      {/* Zero is a fact where the log is readable: an address absent from the
          rollup was called zero times, and printing nothing there is
          indistinguishable from Flint having failed to read it. The three
          figures beside it stay absent, because a p95 of no calls is not zero
          — it does not exist. */}
      <td className="eps__n">{usageKnown ? count(usage?.calls ?? 0) : null}</td>
      <td className="eps__n">
        {usageKnown && usage?.p95_ms !== undefined ? `${Math.round(usage.p95_ms)} ms` : null}
      </td>
      <td className="eps__n">
        {/* Nothing where the endpoint has no cache. 0% would read as a cache
            that is failing rather than one that is switched off. */}
        {cached !== null ? `${Math.round(cached * 100)}%` : null}
      </td>
      <td className="eps__n">
        {usageKnown && usage?.calls ? (
          usage.keys > 0 ? (
            `${usage.keys} key${usage.keys === 1 ? '' : 's'}`
          ) : (
            <span className="mono-dim">no key</span>
          )
        ) : null}
      </td>
      <td>
        <span className={`flag flag--${flagFor(revision.state)}`}>{revision.state}</span>
      </td>
    </tr>
  )
}

/** Which of the shared flag colours a state wears.
 *
 *  Retiring is a warning and not an error: nothing is broken, somebody simply
 *  has a conversation to have before a date. A draft is neither — it is inert,
 *  and colouring it like a problem would send people to fix something that is
 *  working as intended. */
function flagFor(state: Published['state']): string {
  switch (state) {
    case 'live':
      return 'ok'
    case 'retiring':
      return 'watch'
    case 'draft':
      return 'idle'
    case 'retired':
      return 'idle'
  }
}

/** The two things on this page that are somebody's move.
 *
 *  Not a list of every state — the table above is that. These are the rows
 *  where the state is a *question left open*: a revision on notice that people
 *  are still calling, and a draft nobody has taken live. Both have a next step
 *  and a person attached to it, and both are invisible in a table of figures. */
function Attention({
  addresses,
  used,
}: {
  addresses: Address[]
  used: Map<string, SlugUsage>
}) {
  const retiring = addresses.flatMap((address) =>
    address.revisions
      .filter((r) => r.state === 'retiring')
      .map((revision) => ({ address, revision })),
  )
  const drafts = addresses.flatMap((address) =>
    address.revisions.filter((r) => r.state === 'draft').map((revision) => ({ address, revision })),
  )
  if (retiring.length === 0 && drafts.length === 0) return null

  return (
    <div className="eps__cards">
      {retiring.length ? (
        <section className="eps__card">
          <h2 className="eps__cardtitle">Retiring a version</h2>
          {retiring.slice(0, 3).map(({ address, revision }) => {
            const usage = used.get(usageKey(address.slug, revision.revision))
            return (
              <p className="eps__cardbody" key={revision.id}>
                <code>{endpointPath(address.slug)}</code> v{revision.revision} is marked retiring
                {usage?.calls ? <> and still took {count(usage.calls)} calls today</> : null}.
                Flint will not delete it while it is being called — it tells you who to talk to.{' '}
                <Link className="pub__doclink" to={`/apis/${encodeURIComponent(address.slug)}`}>
                  Who is still on it
                </Link>
              </p>
            )
          })}
          {retiring.length > 3 ? (
            <p className="mono-dim">
              {retiring.length - 3} more revision{retiring.length - 3 === 1 ? '' : 's'} retiring
            </p>
          ) : null}
        </section>
      ) : null}

      {drafts.length ? (
        <section className="eps__card">
          <h2 className="eps__cardtitle">Drafts are not reachable</h2>
          {drafts.slice(0, 3).map(({ address, revision }) => (
            <p className="eps__cardbody" key={revision.id}>
              <code>{endpointPath(address.slug)}</code> v{revision.revision} answers nothing at any
              address. It exists so you can review the parameters and the exposed columns before
              anything outside can reach it.{' '}
              <Link className="pub__doclink" to={`/apis/${encodeURIComponent(address.slug)}`}>
                Review it
              </Link>
            </p>
          ))}
          {drafts.length > 3 ? (
            <p className="mono-dim">
              {drafts.length - 3} more draft{drafts.length - 3 === 1 ? '' : 's'}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
