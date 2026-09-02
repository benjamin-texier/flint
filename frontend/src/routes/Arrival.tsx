import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import { api } from '../lib/api'
import {
  growth,
  inOrder,
  saysGrowth,
  saysRead,
  strata,
  verdict,
  type Growth,
  type Reading,
  type Said,
} from '../lib/arrival'
import {
  clearBackups,
  clearCold,
  clearDetached,
  clearQueries,
  clearSpend,
  clearStorage,
  clearTraffic,
  clearTwins,
  fromBackups,
  fromDetached,
  fromHeavy,
  fromCold,
  fromQueries,
  fromSpend,
  fromStorage,
  fromTraffic,
  fromTwins,
  type Cleared,
  type Finding,
} from '../lib/checkup'
import { bytes, count, exact, uptime } from '../lib/format'
import { onDisk, weigh } from '../lib/weight'
import { Headlines } from '../components/Headlines'
import { BarRow } from '../components/BarRow'
import { ClearedList } from '../components/ClearedList'
import { Dash } from '../components/Dash'
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
  /* And who the server has been working for. Its own request beside the cost of
     the statements, because the two answer different halves of one question and
     one of them being denied must not take the other with it. */
  const spend = useQuery({ queryKey: ['diag', 'spend', DAYS], queryFn: () => api.spend(DAYS) })
  /* And the same data held twice. The one reading on this page that needs no
     query log, which is why it is here rather than behind anything: on a server
     whose log Flint may not read it is the only substantial finding left. */
  const twins = useQuery({ queryKey: ['diag', 'twins'], queryFn: () => api.twins() })
  /* And the one dimension this page had none of: time. `system.parts` bucketed by
     month, which is metadata rather than a log — so it answers on the servers
     whose query log is switched off, which is most of the ones Flint gets
     pointed at first. The same cache key the server page uses, so whichever is
     opened second pays nothing. */
  const overTime = useQuery({
    queryKey: ['server', 'timeline', 'month'],
    queryFn: () => api.serverTimeline('month'),
  })

  const findings: Finding[] = useMemo(
    () => [
      ...(storage.data ? fromStorage(storage.data) : []),
      ...(detached.data ? fromDetached(detached.data) : []),
      ...(backups.data ? fromBackups(backups.data) : []),
      ...(heavy.data ? fromHeavy(heavy.data) : []),
      ...(queries.data ? fromQueries(queries.data) : []),
      ...(traffic.data ? fromTraffic(traffic.data) : []),
      ...(cold.data ? fromCold(cold.data) : []),
      ...(spend.data ? fromSpend(spend.data) : []),
      ...(twins.data ? fromTwins(twins.data) : []),
    ],
    [
      storage.data,
      detached.data,
      backups.data,
      heavy.data,
      queries.data,
      traffic.data,
      cold.data,
      spend.data,
      twins.data,
    ],
  )

  /* What each reading is doing, in the words the caption uses. `available:
     false` is ClickHouse's own answer — the grant is missing, or the log is
     switched off — and it is a *third* state, neither waiting nor answered:
     a page that folds it into "answered" quietly claims a verdict it never
     earned. */
  const readings: Reading[] = [
    stateOf('the disks', storage),
    stateOf('the detached parts', detached),
    stateOf('the backup log', backups),
    stateOf('the column types', heavy),
    stateOf('the query log', queries),
    stateOf('what each table is read for', traffic),
    stateOf('what nothing has read', cold),
    stateOf('who the server works for', spend),
    stateOf('the same data held twice', twins),
  ]

  /* What came back clear, from the same readings the findings come from — the
     `clear*` twins `/checkup` uses, so the two pages cannot disagree about what
     passed. Shown here for the reason it is shown there: three of the four areas
     have nothing to report on a healthy server, and a page whose answer to that
     is one negative sentence has hidden all of its work. */
  const cleared: Cleared[] = useMemo(
    () => [
      ...(storage.data ? clearStorage(storage.data) : []),
      ...(detached.data ? clearDetached(detached.data) : []),
      ...(backups.data ? clearBackups(backups.data) : []),
      ...(twins.data ? clearTwins(twins.data) : []),
      ...(queries.data ? clearQueries(queries.data) : []),
      ...(traffic.data ? clearTraffic(traffic.data) : []),
      ...(cold.data ? clearCold(cold.data) : []),
      ...(spend.data ? clearSpend(spend.data) : []),
    ],
    [
      storage.data,
      detached.data,
      backups.data,
      twins.data,
      queries.data,
      traffic.data,
      cold.data,
      spend.data,
    ],
  )

  const ordered = inOrder(findings, SHOWN)
  /* The scale the gutter marks are drawn against: the largest gain *in each
     unit*, because a gigabyte and a second are not two points on one scale — the
     rule `lib/checkup` exists to enforce. A mark is therefore "the heaviest
     saving of its kind on this page", which is a claim a reader can check
     against the figure printed beside it. */
  const heaviest = ordered.reduce<Record<string, number>>((max, f) => {
    if (f.gain.kind === 'none') return max
    return { ...max, [f.gain.kind]: Math.max(max[f.gain.kind] ?? 0, f.gain.n) }
  }, {})
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
  const curve = growth(overTime.data)
  const { bands } = strata(mine.map((d) => ({ name: d.name, bytes: d.bytes })))
  const biggest = [...mine].sort(
    (a, b) => (onDisk({ total_bytes: b.bytes || null }) ?? 0) - (onDisk({ total_bytes: a.bytes || null }) ?? 0),
  )[0]

  return (
    <article className="page page--arrival">
      <header className="arrival__head">
        <p className="arrival__where">
          {server.data ? (
            <>
              {/* Not the address: the chrome above already carries it, and a
                  page that repeats its own chrome is a page with nothing of its
                  own to say in that line. */}
              ClickHouse {server.data.version}
              <span className="arrival__sep" aria-hidden="true" />
              up {uptime(server.data.uptime_seconds)}
              <span className="arrival__sep" aria-hidden="true" />
              as {server.data.current_user}
              {/* The scale of the schema belongs here, with the other readings
                  about this server, and not on the line under the strip: that
                  line measures *disk*, and an object count riding on it is a
                  second quantity borrowing a first one's scale. */}
              {objects > 0 ? (
                <>
                  <span className="arrival__sep" aria-hidden="true" />
                  {exact(objects)} objects
                  <span className="arrival__sep" aria-hidden="true" />
                  {count(rows)} rows
                </>
              ) : null}
            </>
          ) : (
            'Connecting'
          )}
        </p>
        {/* A sentence, set as one. It is the most confident thing in the product
            and it used to be typeset exactly like the name of a table — same
            face, same weight, one page title among eighteen. The figure inside
            it is set in the data face, which is the rule the token file states
            and this is the first place it is kept inside prose. */}
        <h1 className="arrival__verdict">
          {verdict(findings, readings).map((said, i) => (
            <Run key={i} said={said} />
          ))}
        </h1>
        {covered ? <p className="arrival__covered">{covered}</p> : null}
      </header>

      {/* The server's disk as one measured line, where a row of four large
          figures used to be. The figures were true and they were the template
          answer: four counts at one weight, none of them saying which part of
          the server is the mass of it. One strip says that without a word, and
          it is the only shape ClickHouse has ever drawn — a column, laid out by
          weight.

          Dropped entirely where nothing could be weighed, rather than drawn
          empty: a strip of nothing reads as a server holding nothing. */}
      {bands.length > 0 ? (
        <figure className="strip">
          <div
            className="strip__bar"
            role="img"
            aria-label={`${bytes(disk.bytes)} on disk, ${bands
              .map((b) => `${b.name} ${Math.round(b.share * 100)}%`)
              .join(', ')}`}
          >
            {bands.map((band, i) => (
              <span
                key={band.name}
                className={`strip__band${band.folded ? ' strip__band--folded' : ''}`}
                style={
                  {
                    flexGrow: band.share,
                    '--i': i,
                  } as React.CSSProperties
                }
                title={`${band.name} — ${bytes(band.bytes)}`}
              />
            ))}
          </div>
          <figcaption className="strip__legend">
            <span className="strip__total">{bytes(disk.bytes)}</span>
            <span className="strip__on">on disk across</span>
            {bands.map((band) => (
              <span className="strip__key" key={band.name}>
                <span
                  className={`strip__dot${band.folded ? ' strip__dot--folded' : ''}`}
                  aria-hidden="true"
                />
                {band.folded ? (
                  band.name
                ) : (
                  <Link className="strip__name" to={`/db/${encodeURIComponent(band.name)}`}>
                    {band.name}
                  </Link>
                )}
                <span className="strip__share">{Math.round(band.share * 100)}%</span>
              </span>
            ))}
          </figcaption>
        </figure>
      ) : null}

      {/* The same disk along the other axis — see `growth`. Two figures rather
          than one because they answer different halves of "what is on here": the
          strip says *which database* holds it, this says *when its rows are
          from*. Dropped entirely where the parts carry no date, rather than
          drawn flat: a row of equal bars is a picture of a server with no
          history, and that is not what a missing partition key means. */}
      {curve ? <DataByPeriod growth={curve} /> : null}

      {/* What is different today, which is a question nobody types and everybody
          has. Its own request, its own refusals, and it speaks even when the
          answer is "nothing moved". */}
      <Headlines space="data" lead />

      <section className="section arrival__found">
        <div className="arrival__bar">
          <h2 className="arrival__title">What Flint found</h2>
          <span className="arrival__count">
            {ordered.length > 0
              ? `${ordered.length}${hidden > 0 ? ` of ${findings.length}` : ''}`
              : null}
          </span>
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
             ask.
             
             Kept short, because the clearances underneath now carry the work:
             the sentence says what state the list is in, and they say what was
             measured. */
          <p className="says">
            {readings.some((r) => r.state === 'reading')
              ? 'Still reading.'
              : readings.some((r) => r.state === 'refused')
                ? 'Nothing in what could be read.'
                : 'Nothing on this server is asking to be changed.'}
          </p>
        ) : (
          <>
            <ul className="strata">
              {ordered.map((f, i) => (
                <Stratum key={f.id} finding={f} heaviest={heaviest} index={i} />
              ))}
            </ul>
            {/* The count follows the list, and names where the rest are. A
                header that counted them would be a header nobody can
                reconcile against what is under it. */}
            {hidden > 0 ? (
              <p className="says says--wide">
                {exact(hidden)} more on <Link className="link" to="/checkup">the checkup</Link>.
              </p>
            ) : null}
          </>
        )}

        {/* And what was measured and had nothing to say. */}
        <ClearedList cleared={cleared} also={ordered.length > 0} />
      </section>

      {/* And what has been built on top of this server. Below the verdict on
          purpose: everything above is a read of `system.*` and answers on every
          Flint there is, and this section is the only one that needs somewhere
          to write. A stateless deployment says so here rather than losing a
          page it never had. */}
      <section className="section arrival__kept">
        <div className="arrival__bar">
          <h2 className="arrival__title">What this Flint keeps</h2>
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

/** One finding, as a band.
 *
 *  It does not borrow `/checkup`'s row any more, and that is a real loss worth
 *  naming: the two pages can now drift on what a finding looks like. It is worth
 *  it because they are not the same reading. `/checkup` is a worklist, grouped by
 *  area, read top to bottom by somebody who came to work through it; this is a
 *  *ranking*, mixed across areas by weight, read by somebody who arrived ten
 *  seconds ago. The gutter mark is the difference — there is no scale on a
 *  worklist, because every row in an area is the same kind of thing.
 *
 *  What is shared is the part that would actually hurt to duplicate: `Finding`
 *  itself, and every judge that produces one. A field added there appears here
 *  and on the checkup or in neither.
 */
function Stratum({
  finding,
  heaviest,
  index,
}: {
  finding: Finding
  heaviest: Record<string, number>
  index: number
}) {
  const gain = finding.gain
  /* A share of the heaviest of its own kind, floored so the smallest finding on
     the page still has a mark: a gutter that renders as nothing says the row
     below is worth nothing, which is not what "smallest here" means. */
  const weight =
    gain.kind === 'none' ? 0 : Math.max(0.08, gain.n / Math.max(1, heaviest[gain.kind] ?? gain.n))
  return (
    <li
      className={`strata__row strata__row--${finding.urgency}`}
      style={{ '--i': index, '--weight': `${Math.round(weight * 100)}%` } as React.CSSProperties}
    >
      <span className="strata__weight" aria-hidden="true" />
      <div className="strata__what">
        <p className="strata__claim">{finding.title}</p>
        <p className="strata__why">{finding.why}</p>
        <p className="strata__evidence">{finding.evidence}</p>
        {finding.act ? (
          <Link className="link strata__act" to={finding.act.to}>
            {finding.act.label} →
          </Link>
        ) : null}
      </div>
      {/* The unit is part of the figure and never dropped — see the stylesheet.
          A finding with no quantity prints nothing rather than a zero: printing
          `0` beside a backup that was never taken would say acting on it is
          worth nothing. */}
      {gain.kind === 'none' ? null : (
        <p className="strata__worth">
          <span className="strata__figure">
            {gain.kind === 'bytes'
              ? bytes(gain.n)
              : gain.kind === 'seconds'
                ? `${gain.n < 1 ? gain.n.toFixed(2) : Math.round(gain.n)} s`
                : count(gain.n)}
          </span>
          <span className="strata__unit">
            {gain.kind === 'bytes' ? 'on disk' : gain.kind === 'seconds' ? 'of query time' : 'rows'}
          </span>
        </p>
      )}
    </li>
  )
}

/** One run of the verdict sentence, in the face it belongs to.
 *
 *  The whole component, and it is worth being one: the alternative is a ternary
 *  inside the heading, and this is the rule the token file states — the data face
 *  for characters that *are* the content, the interface face for everything that
 *  labels it. */
function Run({ said }: { said: Said }) {
  return said.figure ? <b className="arrival__figure">{said.text}</b> : <>{said.text}</>
}

/** One react-query result, in the three words `lib/arrival` reasons about.
 *
 *  The `available: false` case is the one that matters and the one a
 *  `useQuery` cannot express: the request *succeeded*, and its answer is that
 *  ClickHouse would not say. Folding that into "read" would let the verdict
 *  speak for a reading that never happened. */
function stateOf(
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

/** The server's data along time, as a row of columns.
 *
 *  Bars rather than a line, and CSS rather than the `Chart` component. Both are
 *  deliberate. A line asserts that the value moved continuously between its
 *  points, and these are buckets — a month holds what it holds, and there is no
 *  value between January and February to draw through. And `Chart` takes a
 *  `QueryResult`: fabricating one so a landing page can draw twelve numbers
 *  would be inventing a result that no statement returned, on the page whose
 *  whole claim is that every figure came from a reading.
 *
 *  No y axis, which is the same restraint `components/OverTime` states for the
 *  health sparklines. The figure answers "is this steady, or was it one
 *  afternoon"; a reader who wants the number per month has the grid on
 *  `/server`, and the caption links to it.
 */
function DataByPeriod({ growth: g }: { growth: Growth }) {
  const total = g.bars.reduce((n, b) => n + b.bytes, 0)
  const first = g.bars[0]!
  const last = g.bars[g.bars.length - 1]!
  return (
    <figure className="byperiod">
      <BarRow
        label={`${bytes(total)} on disk across ${g.bars.length} ${GRAIN_WORD[g.grain]}, from ${first.bucket} to ${last.bucket}`}
        bars={g.bars.map((b) => ({
          key: b.bucket,
          value: b.bytes,
          title: `${b.bucket} — ${bytes(b.bytes)}, ${count(b.rows)} rows`,
        }))}
      />
      <figcaption className="byperiod__legend">
        <span className="byperiod__ends">
          <span>{first.bucket}</span>
          <span>{last.bucket}</span>
        </span>
        <span className="byperiod__says">
          {saysGrowth(g)}{' '}
          <Link className="link" to="/server">
            The grid, per table →
          </Link>
        </span>
      </figcaption>
    </figure>
  )
}

/** The plural of a grain, for the one sentence that counts buckets. */
const GRAIN_WORD: Record<Growth['grain'], string> = {
  partition: 'partitions',
  day: 'days',
  week: 'weeks',
  month: 'months',
  quarter: 'quarters',
  year: 'years',
}
