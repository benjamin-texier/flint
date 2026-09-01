import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import { api } from '../lib/api'
import { concerns } from '../lib/attention'
import { count, exact, figure, relativeTime } from '../lib/format'
import { endpointPath } from '../lib/publish'
import { keeps, spaceOf } from '../lib/spaces'
import {
  busiest,
  callsServed,
  countUnreached,
  describeReach,
  reachOf,
  recentlyTouched,
  trafficOf,
} from '../lib/workspace'
import { MetricLine, type Metric } from '../components/MetricLine'
import { EmptyNote, ErrorNote, Loading } from '../components/Note'

import type { SavedQuery } from '../lib/api'
import type { UsageReport } from '../lib/diagnose'
import type { Reach, Served } from '../lib/workspace'

/** What a block needs to know about its own request — enough to say it is
 *  waiting, and enough to offer the retry. Deliberately not react-query's
 *  shape: these blocks are about what they can show, not about who fetched it. */
interface Fetching {
  isPending: boolean
  error: unknown
  refetch: () => void
}

/** What Flint keeps here, and what it is being asked for.
 *
 *  This was `/home`, a board of its own behind Data's name, and it was the right
 *  content on the wrong footing: it answered "what has this workspace been made
 *  to answer", which is a fine second question and never anybody's first. Worse,
 *  it was the one Data page a stateless Flint could not fill, so the space's own
 *  name opened a page explaining why the page was not there.
 *
 *  So it is a section of the arrival board now rather than a page — under the
 *  verdict about the server, where what has been built on top of that server
 *  belongs. `/home` still resolves, to `/`, because it is in bookmarks. The
 *  paragraphs below are what it was, and still are:
 *
 *  Data — the first page: what this workspace has been made to answer.
 *
 *  The mirror of `/infra`, and the answer to the same complaint: clicking the
 *  space's own name used to land on a database, which tells you what is on the
 *  *server*. Nobody's first question on opening Flint is "what tables exist" —
 *  they know; they built them. It is "what have we already got answers for, and
 *  is any of it unhappy".
 *
 *  What it is emphatically not is an inventory screen. Flint opens on a
 *  database and still does — `/` is unchanged, Explore still owns it, and this
 *  page is somewhere you go rather than somewhere you land. What is inventoried
 *  here is Flint's own workspace: the statements people saved, where each one is
 *  running, and what the endpoints are serving.
 *
 *  Every block is its own request, like the Infrastructure board: the query log
 *  being off must not take the saved statements down with it. And no figure on
 *  this page comes from anywhere but an endpoint that already existed — where
 *  the wire does not carry a number, the number is not here. */

/** The window the traffic block asks for. The same seven days the APIs page
 *  uses, deliberately: two pages quoting "calls" over different spans is a
 *  discrepancy somebody would eventually spend an afternoon on. */
const USAGE_DAYS = 7

/** How much of each list fits before the reader stops reading it. Both blocks
 *  state their own count underneath, so a cap is a cap and never a total. */
const TOUCHED = 5
const SERVING = 4

export function WhatIsKept() {
  const config = useQuery({ queryKey: ['config'], queryFn: api.config })
  /* Everything on this page lives in the workspace, so a Flint without one has
     nothing here rather than a page full of refusals — the rule the other four
     kept sections already follow. */
  const stateful = keeps(config.data)
  const shared = { enabled: stateful, retry: false } as const

  const saved = useQuery({ queryKey: ['saved-queries'], queryFn: api.savedQueries, ...shared })
  const published = useQuery({ queryKey: ['published'], queryFn: api.published, ...shared })
  const dashboards = useQuery({ queryKey: ['dashboards'], queryFn: api.dashboards, ...shared })
  /* The same cache entries the bar's badges use, so arriving here costs nothing
     the chrome has not already paid for. */
  const alerts = useQuery({
    queryKey: ['alerts'],
    queryFn: api.alerts,
    staleTime: 60_000,
    ...shared,
  })
  const reports = useQuery({
    queryKey: ['reports'],
    queryFn: api.reports,
    staleTime: 60_000,
    ...shared,
  })
  const usage = useQuery({
    queryKey: ['api-usage', USAGE_DAYS],
    queryFn: () => api.apiUsage(USAGE_DAYS),
    staleTime: 30_000,
    ...shared,
  })

  const statements = saved.data ?? []
  const endpoints = published.data ?? []
  const reach = reachOf(statements, endpoints, dashboards.data ?? [])
  const touched = recentlyTouched(statements, TOUCHED)
  /* Traffic to endpoints that still exist. The log outlives them; a figure that
     counts calls to an address that now 404s cannot be reconciled with the
     "endpoints live" beside it. */
  const traffic = trafficOf(usage.data, published.data)
  const serving = busiest(endpoints, traffic, SERVING)
  const live = endpoints.filter((e) => e.enabled)
  const calls = callsServed(traffic)
  /* Only what this space can act on. An operator's stuck replica belongs to
     Infrastructure's board; putting it here would raise a number on a page
     whose every link goes somewhere else. */
  const items = concerns({
    alerts: alerts.data,
    reports: reports.data,
    usage: traffic,
  }).filter((i) => spaceOf(i.to) === 'data')

  /* Built from what has actually arrived. A figure still being fetched is
     absent, never zero: "no endpoints" and "we have not asked yet" are
     different facts and only one of them is worth reading. */
  const metrics: Metric[] = []
  const figureFor = (n: number, one: string, many: string): Metric => ({
    value: count(n),
    label: n === 1 ? one : many,
  })
  if (saved.data) metrics.push(figureFor(statements.length, 'saved statement', 'saved statements'))
  if (published.data) metrics.push(figureFor(live.length, 'endpoint live', 'endpoints live'))
  if (calls !== null)
    metrics.push({ value: count(calls), label: `calls in ${USAGE_DAYS} days` })
  if (dashboards.data) metrics.push(figureFor(dashboards.data.length, 'dashboard', 'dashboards'))
  if (alerts.data)
    metrics.push(
      figureFor(alerts.data.filter((a) => a.enabled).length, 'alert watching', 'alerts watching'),
    )

  const nothingKept = Boolean(
    stateful &&
      saved.data &&
      published.data &&
      dashboards.data &&
      statements.length === 0 &&
      endpoints.length === 0 &&
      dashboards.data.length === 0,
  )

  return (
    <>
      {/* The gate, and what it costs, in the one place the reader meets it.
          Everything above this section on the arrival board is a read of
          `system.*` and answers the same on every Flint there is; this section
          alone needs somewhere to write. */}
      {!stateful && config.data ? (
        <EmptyNote title="Nothing is kept here">
          Flint is running without a workspace, so it holds no statements, endpoints, dashboards
          or alerts of its own — and this section is the list of them. Everything above needs
          none: it is a read of the server's own tables. Set{' '}
          <code>FLINT_WORKSPACE_DATABASE</code> to a database it may write to, and restart.
        </EmptyNote>
      ) : null}

      {/* Not on a workspace with nothing in it: four zeros above a note that
          already says "nothing kept here yet" is the same fact four times, and
          a row of zeros is the one shape a figure should never take. */}
      {metrics.length > 0 && !nothingKept ? <MetricLine metrics={metrics} /> : null}

      {nothingKept ? (
        <EmptyNote title="Nothing kept here yet">
          Run something on the Query page and save it, and Flint starts keeping track of where it
          ends up — the endpoints serving it, the dashboards drawing it.
        </EmptyNote>
      ) : null}

      {stateful && !nothingKept ? (
        <div className="home__cols">
          <Touched
            statements={touched}
            total={statements.length}
            unreached={countUnreached(statements, reach)}
            reach={reach}
            query={saved}
          />
          <Serving
            serving={serving}
            live={live.length}
            usage={traffic}
            query={published}
            logFailed={Boolean(usage.error)}
          />
        </div>
      ) : null}

      {items.length ? (
        <section className="section">
          <h2 className="section__title">Worth a look</h2>
          <ul className="board">
            {items.map((item) => (
              <li
                className={`board__row board__row--${
                  item.concern === 'firing' || item.concern === 'broken' ? 'throw' : 'watch'
                }`}
                key={`${item.concern}-${item.name}`}
              >
                <Link className="board__name" to={item.to}>
                  {item.name}
                </Link>
                <span className="board__says">{item.says}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  )
}

/** What is being worked on, and where else each statement runs.
 *
 *  The relation is inferred from the statement text — see `lib/workspace` — so
 *  the block says "the same statement", which is what it knows, and never
 *  "depends on", which it does not. */
function Touched({
  statements,
  total,
  unreached,
  reach,
  query,
}: {
  statements: SavedQuery[]
  total: number
  unreached: number
  reach: Map<string, Reach>
  query: Fetching
}) {
  return (
    <section className="section home__block">
      <div className="section__bar">
        <h2 className="section__title section__title--bare">Recently touched</h2>
        <span className="label">and where the same statement also runs</span>
      </div>

      {query.error ? <ErrorNote error={query.error} retry={() => query.refetch()} /> : null}
      {query.isPending ? <Loading label="Reading saved statements" /> : null}

      {statements.length ? (
        <ul className="home__list">
          {statements.map((statement) => (
            <li className="home__row" key={statement.id}>
              <div className="home__what">
                {/* Straight into a tab with the statement in it. The saved list
                    is a panel on the query page rather than a page of its own,
                    so there is nowhere else for a name to lead that would not
                    be a detour through it. */}
                <Link
                  className="home__name mono"
                  to={`/query?sql=${encodeURIComponent(statement.sql)}&database=${encodeURIComponent(
                    statement.database,
                  )}`}
                >
                  {statement.name}
                </Link>
                <span className="home__when">
                  {statement.database}
                  <span className="home__dot" aria-hidden="true">
                    ·
                  </span>
                  {relativeTime(statement.updated_at)}
                </span>
              </div>
              <span className="home__says">{describeReach(reach.get(statement.id))}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {total ? (
        <p className="home__more">
          <Link className="home__link" to="/query?panel=saved">
            All {exact(total)} {total === 1 ? 'statement' : 'statements'} ›
          </Link>
          {unreached ? (
            <span className="home__aside">
              · {exact(unreached)} of them run nowhere else
            </span>
          ) : null}
        </p>
      ) : null}
    </section>
  )
}

/** What the endpoints are actually serving.
 *
 *  Live ones only, busiest first. Where `system.query_log` is off there are no
 *  figures at all and the block says so once, rather than printing zeros that
 *  would read as "nobody is calling these" — the opposite conclusion from the
 *  true one. */
function Serving({
  serving,
  live,
  usage,
  query,
  logFailed,
}: {
  serving: Served[]
  live: number
  usage: UsageReport | undefined
  query: Fetching
  logFailed: boolean
}) {
  const logged = Boolean(usage?.available)
  const why = usage?.reason ?? (logFailed ? 'the query log could not be read' : null)

  return (
    <section className="section home__block">
      <div className="section__bar">
        <h2 className="section__title section__title--bare">Serving traffic</h2>
        <span className="label">{logged ? `last ${USAGE_DAYS} days` : 'no figures'}</span>
      </div>

      {query.error ? <ErrorNote error={query.error} retry={() => query.refetch()} /> : null}
      {query.isPending ? <Loading label="Reading endpoints" /> : null}

      {!logged && why && !query.isPending ? (
        <p className="home__note">
          {why} — these are the live endpoints, in name order, with nothing said about how
          often they are called.
        </p>
      ) : null}

      {serving.length ? (
        <ul className="home__list">
          {serving.map(({ endpoint, usage: called }) => (
            <li className="home__row" key={endpoint.id}>
              <div className="home__what">
                <Link className="home__name mono" to="/apis">
                  {endpointPath(endpoint.slug)}
                </Link>
                <span className="home__when">
                  {called ? (
                    <>
                      {count(called.calls)} {called.calls === 1 ? 'call' : 'calls'}
                      <span className="home__dot" aria-hidden="true">
                        ·
                      </span>
                      p95 {figure(called.p95_ms)} ms
                      <span className="home__dot" aria-hidden="true">
                        ·
                      </span>
                      {relativeTime(called.last_call)}
                      {/* In the line of figures rather than in the column on the
                          right, which says one thing for every row — who may
                          call this. A column that means "who may call it" on
                          three rows and "how badly it is going" on the fourth is
                          a column with no heading anyone could write. The board
                          at the foot of the page is where a failing endpoint is
                          actually raised. */}
                      {called.failures ? (
                        <>
                          <span className="home__dot" aria-hidden="true">
                            ·
                          </span>
                          <span className="home__failed">
                            {exact(called.failures)} failed
                          </span>
                        </>
                      ) : null}
                    </>
                  ) : logged ? (
                    `not called in the last ${USAGE_DAYS} days`
                  ) : (
                    endpoint.database
                  )}
                </span>
              </div>
              <span className="home__says">
                {endpoint.public ? 'open' : 'token'}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {live ? (
        <p className="home__more">
          <Link className="home__link" to="/apis">
            All {exact(live)} live {live === 1 ? 'endpoint' : 'endpoints'} ›
          </Link>
        </p>
      ) : !query.isPending && !query.error ? (
        <p className="home__note">
          Nothing published yet. <Link to="/apis">An endpoint</Link> turns a saved statement
          into a URL a script can fetch.
        </p>
      ) : null}
    </section>
  )
}
