import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import { api } from '../lib/api'
import { inOrder, saysRead, verdict, type Reading } from '../lib/arrival'
import {
  fromBackups,
  fromDetached,
  fromHeavy,
  fromCold,
  fromQueries,
  fromStorage,
  fromTraffic,
  type Finding,
} from '../lib/checkup'
import { bytes, count, exact, uptime } from '../lib/format'
import { onDisk, weigh } from '../lib/weight'
import { Headlines } from '../components/Headlines'
import { MetricLine } from '../components/MetricLine'
import { Dash } from '../components/Dash'
import { FindingRow } from './Checkup'
import { WhatIsKept } from './Home'

/** The first screen: what Flint found on the server you just connected to.
 *
 *  Connecting used to land on a database — the schema, drawn, which is what
 *  Flint is *for* and the wrong thing to open with. It answers what exists, and
 *  nobody's first question about their own server is what exists; they built it.
 *  The question is whether anything in there is worth the afternoon, and the
 *  only way to find out was to already know which of eighteen pages to open.
 *
 *  ## It owns nothing
 *
 *  Every figure here comes from an endpoint that already existed, every finding
 *  from a judge in `lib/checkup` that `/checkup` uses, and every row is drawn by
 *  `/checkup`'s own component. That is the constraint rather than a happy
 *  accident: a home that is the only place a fact appears is a home you cannot
 *  act from, because the control that acts on the fact lives on a page you were
 *  never sent to. So this page reports and links, and never acts.
 *
 *  What is genuinely its own is `lib/arrival` — the *order*. Which of thirty
 *  true sentences goes first, how many fit before somebody stops reading, and
 *  what to say while the rest are still landing.
 *
 *  ## Every reading is its own request
 *
 *  Eight of them, and they report as they land. A page that waited for the
 *  slowest of eight is a page nobody leaves open; and one section being denied
 *  must not take the other seven down — the rule `/infra` and `/checkup` already
 *  keep. What it adds is that a *denial* is stated rather than shown as an empty
 *  panel: on a server where `system.parts` is refused, "nothing is wrong" is a
 *  sentence four readings never got to vote on, and it says so.
 *
 *  ## The one thing it does that `/checkup` does not
 *
 *  It reads the query log without being asked. `/checkup` puts that behind a
 *  button, and the reason is good — scanning `system.query_log` on a busy server
 *  is the most expensive thing Flint can do, and spending it before anybody
 *  asked is not a courtesy. It is spent here anyway, for one reason: the whole
 *  claim of this page is that connecting is enough. A home that opens with a
 *  button saying "and now find out what your statements cost" has handed the
 *  question straight back. It is one aggregate over a window `/api/diagnostics/news`
 *  is already reading on this very page, and the caption says what it covered.
 */

/** The window the workload readings ask for. A week, like every other reading
 *  in Flint that looks at the query log — two pages quoting "the last N days"
 *  over different spans is a discrepancy somebody spends an afternoon on. */
const DAYS = 7

/** How many findings fit before somebody stops reading. The rest are counted
 *  underneath and are a click away: a list silently truncated reads as the
 *  whole truth. */
const SHOWN = 8

/** ClickHouse's own databases, which nobody connected to look at. Excluded from
 *  the scale figures and from the heavy reading for the same reason the palette
 *  excludes them: `system` alone would be most of the answer, and none of it is
 *  about the schema anybody built. */
const CLICKHOUSE_OWN = new Set(['system', 'INFORMATION_SCHEMA', 'information_schema'])

export function ArrivalPage() {
  const server = useQuery({ queryKey: ['server'], queryFn: api.server })
  const databases = useQuery({ queryKey: ['databases'], queryFn: api.databases })

  /* The four that cost nothing but metadata. Straight in on load — this is the
     landing page, and a landing page with a button on it has handed the
     question back to the reader. */
  const storage = useQuery({ queryKey: ['diag', 'storage'], queryFn: api.diagnoseStorage })
  const detached = useQuery({ queryKey: ['parts', 'detached'], queryFn: api.detachedParts })
  const backups = useQuery({ queryKey: ['backups'], queryFn: api.backups })

  const names = (databases.data ?? []).filter((d) => !CLICKHOUSE_OWN.has(d.name)).map((d) => d.name)
  /* The same cache key `/checkup` uses, so walking between the two pages costs
     one of them nothing. */
  const heavy = useQuery({
    queryKey: ['checkup', 'heavy', names],
    queryFn: () => Promise.all(names.map((n) => api.heavy(n, 40))),
    enabled: names.length > 0,
  })

  /* And the workload — see the header. Not behind a button here, and its cost
     is stated under the section it produces. */
  const queries = useQuery({
    queryKey: ['diag', 'queries', DAYS],
    queryFn: () => api.diagnoseQueries(DAYS),
  })
  const traffic = useQuery({
    queryKey: ['diag', 'traffic', DAYS],
    queryFn: () => api.diagnoseTraffic(DAYS),
  })
  /* The one reading on this page nothing else in Flint could produce: which of
     the disk is doing any work. Same cache key as the checkup's, so whichever
     page is opened second pays nothing. */
  const cold = useQuery({ queryKey: ['diag', 'cold', DAYS], queryFn: () => api.cold({ days: DAYS }) })

  const findings: Finding[] = useMemo(
    () => [
      ...(storage.data ? fromStorage(storage.data) : []),
      ...(detached.data ? fromDetached(detached.data) : []),
      ...(backups.data ? fromBackups(backups.data) : []),
      ...(heavy.data ? fromHeavy(heavy.data) : []),
      ...(queries.data ? fromQueries(queries.data) : []),
      ...(traffic.data ? fromTraffic(traffic.data) : []),
      ...(cold.data ? fromCold(cold.data) : []),
    ],
    [storage.data, detached.data, backups.data, heavy.data, queries.data, traffic.data, cold.data],
  )

  /* What each reading is doing, in the words the caption uses. `available:
     false` is ClickHouse's own answer — the grant is missing, or the log is
     switched off — and it is a *third* state, neither waiting nor answered:
     a page that folds it into "answered" quietly claims a verdict it never
     earned. */
  const readings: Reading[] = [
    said('the disks', storage),
    said('the detached parts', detached),
    said('the backup log', backups),
    said('the column types', heavy),
    said('the query log', queries),
    said('what each table is read for', traffic),
    said('what nothing has read', cold),
  ]

  const ordered = inOrder(findings, SHOWN)
  const hidden = findings.length - ordered.length
  const covered = saysRead(readings)

  /* The scale of the thing, from the two cheapest reads on the page. Both are
     already in cache by the time anybody looks — the rail and the chrome ask
     for them — so the headline costs nothing of its own. */
  const mine = (databases.data ?? []).filter((d) => !CLICKHOUSE_OWN.has(d.name))
  const disk = weigh(mine.map((d) => ({ total_bytes: d.bytes || null })))
  const rows = mine.reduce((sum, d) => sum + d.rows, 0)
  const objects = mine.reduce((sum, d) => sum + d.tables + d.views + d.materialized_views, 0)
  /* Where to send somebody who wants the schema rather than the verdict: the
     database with the most in it, which is the one they almost certainly came
     for. Falls back to the first, and to nothing at all on a server whose
     databases are all ClickHouse's own. */
  const biggest = [...mine].sort(
    (a, b) => (onDisk({ total_bytes: b.bytes || null }) ?? 0) - (onDisk({ total_bytes: a.bytes || null }) ?? 0),
  )[0]

  return (
    <article className="page page--arrival">
      <header className="page__head">
        <p className="eyebrow">
          {server.data ? (
            <>
              ClickHouse {server.data.version} · up {uptime(server.data.uptime_seconds)} · as{' '}
              {server.data.current_user}
            </>
          ) : (
            'Connected'
          )}
        </p>
        <h1 className="page__title page__title--hero arrival__verdict">
          {verdict(findings, readings)}
        </h1>
        {covered ? <p className="page__sub">{covered}</p> : null}
      </header>

      <MetricLine
        metrics={[
          { value: exact(mine.length), label: mine.length === 1 ? 'database' : 'databases' },
          { value: exact(objects), label: 'objects' },
          { value: count(rows), label: 'rows' },
          /* Dropped rather than dashed where no reading could weigh anything —
             the rule the object lists keep, and it matters most in a headline,
             where a zero reads as a measurement. */
          ...(disk.known ? [{ value: bytes(disk.bytes), label: 'on disk' }] : []),
        ]}
        lead
      />

      {/* What is different today, which is a question nobody types and everybody
          has. Its own request, its own refusals, and it speaks even when the
          answer is "nothing moved". */}
      <Headlines space="data" lead />

      <section className="section">
        <div className="section__bar">
          <h2 className="section__title section__title--bare">What Flint found</h2>
          <span className="panel__spacer" />
          <Link className="link" to="/checkup">
            The full checkup →
          </Link>
        </div>
        {ordered.length === 0 ? (
          /* Not the headline's sentence again. This one is about the *list*,
             and it must not claim more than the readings behind it either — on
             an account granted almost nothing, "nothing is asking to be
             changed" is a verdict on four questions nobody was allowed to
             ask. */
          <p className="says">
            {readings.some((r) => r.state === 'reading')
              ? 'Still reading.'
              : readings.some((r) => r.state === 'refused')
                ? 'Nothing in what could be read.'
                : 'Nothing on this server is asking to be changed.'}
          </p>
        ) : (
          <>
            <ul className="checkup__list">
              {ordered.map((f) => (
                <FindingRow key={f.id} finding={f} />
              ))}
            </ul>
            {/* The count follows the list, and names where the rest are. A
                header that counted them would be a header nobody can
                reconcile against what is under it. */}
            {hidden > 0 ? (
              <p className="says">
                {exact(hidden)} more on <Link className="link" to="/checkup">the checkup</Link>.
              </p>
            ) : null}
          </>
        )}
      </section>

      {/* And what has been built on top of this server. Below the verdict on
          purpose: everything above is a read of `system.*` and answers on every
          Flint there is, and this section is the only one that needs somewhere
          to write. A stateless deployment says so here rather than losing a
          page it never had. */}
      <section className="section">
        <div className="section__bar">
          <h2 className="section__title section__title--bare">What this Flint keeps</h2>
        </div>
        <WhatIsKept />
      </section>

      {/* The way on. Last, because somebody who read the verdict and wants the
          schema has already had eight chances to disagree with it — and first
          would make this a menu with a report attached. */}
      <section className="section arrival__ways">
        {biggest ? (
          <Link className="btn btn--spark" to={`/db/${encodeURIComponent(biggest.name)}`}>
            Open {biggest.name}, drawn
          </Link>
        ) : null}
        <Link className="btn" to="/query">
          Write a statement
        </Link>
        <span className="says">
          {biggest ? (
            <>
              {exact(biggest.tables + biggest.views + biggest.materialized_views)} objects,{' '}
              {onDisk({ total_bytes: biggest.bytes || null }) === null ? (
                <Dash />
              ) : (
                bytes(biggest.bytes)
              )}{' '}
              — the biggest database here.
            </>
          ) : (
            'Nothing on this server but ClickHouse’s own databases.'
          )}
        </span>
      </section>
    </article>
  )
}

/** One react-query result, in the three words `lib/arrival` reasons about.
 *
 *  The `available: false` case is the one that matters and the one a
 *  `useQuery` cannot express: the request *succeeded*, and its answer is that
 *  ClickHouse would not say. Folding that into "read" would let the verdict
 *  speak for a reading that never happened. */
function said(
  label: string,
  q: { data?: unknown; error?: unknown; isPending: boolean },
): Reading {
  const refusal =
    q.data && typeof q.data === 'object' && 'available' in q.data && q.data.available === false
      ? String((q.data as { reason?: string }).reason ?? '')
      : null
  if (refusal !== null) return { label, state: 'refused', reason: refusal || undefined }
  if (q.error) return { label, state: 'refused', reason: String((q.error as Error).message ?? q.error) }
  if (q.isPending) return { label, state: 'reading' }
  return { label, state: 'read' }
}
