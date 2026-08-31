import { useMemo, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import { api, type SchemaGraph, type SchemaReview, type TableSummary } from '../lib/api'
import { bytes, count } from '../lib/format'
import { internalName, storesParts } from '../lib/explain'
import { KIND_LABEL, tally } from '../lib/review'
import {
  disagreements,
  group,
  heldBack,
  writtenBy,
  handOver,
  matching,
  reach,
  reconcile,
  script,
  statements,
  type Group,
  type Member,
} from '../lib/sweep'
import { KindFilter, useHiddenKinds } from './KindFilter'
import { EmptyNote, Loading } from './Note'

/** One member's identity, as the tick map spells it. A NUL because it cannot
 *  occur in an identifier and a space can: `a b`.`c` and `a`.`b c` are two
 *  different columns, and a separator that conflates them would tick one and
 *  alter the other. */
const keyOf = (m: { table: string; column: string }) => `${m.table}\u0000${m.column}`

/** The whole database's suggestions at once: grouped, ticked, and handed over as
 *  the statements they come to.
 *
 *  The table's own review is the measurement; this is the decision. It reviews
 *  several tables and then reads their findings the way somebody with a naming
 *  convention actually reads them — one column, one proposed type, every table
 *  that has it — because `raw_x`, `raw_x_estimated` and `raw_x_last_state` do
 *  not have three problems with `occupancy_percentage`, they have one.
 *
 *  Three things this page will not do, all for the same reason: it hands over
 *  DDL rather than running it. It never verifies here — a full scan of twelve
 *  tables at once is not something a page should start on a click, and the one
 *  table that needs a verdict is a link away. It never predicts a saving. And
 *  the caveats travel *inside* the copied SQL, because that block is the only
 *  part of this page that reaches the terminal where it matters.
 */
export function DatabaseReview({
  database,
  tables,
  graph,
  pattern,
  onPattern,
}: {
  database: string
  tables: TableSummary[]
  /** The lineage, when the page has it. Optional and treated as optional: a
   *  role that cannot read enough of `system` to trace it loses the guard
   *  below and keeps the review, rather than the review refusing to render. */
  graph?: SchemaGraph
  pattern: string
  onPattern: (next: string) => void
}) {
  /** The pattern that was actually reviewed, which is not the one in the box:
   *  reviewing samples every candidate table, so it happens when somebody asks
   *  and not on a keystroke. */
  const [run, setRun] = useState<string | null>(null)
  /** One tick per (table, column), so two proposals for one column replace each
   *  other rather than both reaching the SQL — an `ALTER` naming a column twice
   *  is rejected outright, and a page that could build one is a page that lies
   *  about what it hands over. */
  const [ticks, setTicks] = useState<Map<string, Member>>(new Map())
  /** Tables the reader has asked to have measured over every row.
   *
   *  Bounded by the ticks and never by the pattern: verifying is a full scan,
   *  and "verify the twelve tables you searched for" is a bill nobody agreed
   *  to. "Verify the three you actually intend to change" is one somebody can
   *  weigh, and it is the only set where the answer changes anything. */
  const [verifying, setVerifying] = useState<Set<string>>(new Set())
  const [copied, setCopied] = useState(false)

  /** Which subjects the reader has put away — the same set the per-table review
   *  reads, because it is a position about the advice and not about the page.
   *
   *  It matters more here than it does there. A table's review argues about
   *  eight columns; this one argues about forty tables at once, and a reader
   *  who has decided that codecs are somebody else's problem is otherwise
   *  scrolling past the same refusal thirty times. */
  const { hidden, put, showAll } = useHiddenKinds()

  /* Only what a review can say anything about. A view stores no rows of its
     own, so it has no column types to be wrong; the tables ClickHouse keeps for
     its materialized views are not objects anybody declared. Both are counted
     out loud below rather than quietly dropped. */
  const reviewable = useMemo(
    () => tables.filter((t) => storesParts(t.engine) && !internalName(t.name)),
    [tables],
  )
  const names = useMemo(() => reviewable.map((t) => t.name), [reviewable])
  const matched = useMemo(() => matching(names, pattern), [names, pattern])

  /* Biggest first, so that a pattern which catches more than the cap keeps the
     tables the reader came for. */
  const candidates = useMemo(() => {
    const size = new Map(reviewable.map((t) => [t.name, t.parts_bytes]))
    return [...matched].sort((a, b) => (size.get(b) ?? 0) - (size.get(a) ?? 0))
  }, [matched, reviewable])
  const taken = candidates.slice(0, MAX_TABLES)

  /* The pattern at the moment the button was pressed, so editing the box does
     not silently re-aim a review that is already running. */
  const running = useMemo(
    () => (run === null ? [] : matching(names, run).filter((n) => taken.includes(n))),
    [run, names, taken],
  )

  /* One query per table, sharing the per-table review's own cache key: opening
     a table's review afterwards costs nothing, and a table already reviewed
     costs nothing here. The browser's own limit on connections to one origin is
     what keeps this from arriving at the server as forty simultaneous scans. */
  const results = useQueries({
    queries: running.map((table) => {
      const full = verifying.has(table)
      return {
        queryKey: ['review', database, table, full],
        queryFn: () => api.review(database, table, full),
        staleTime: 5 * 60_000,
        retry: false,
        /* Asking for the fuller measurement is a new query, and a new query
           with no placeholder unmounts everything the reader was looking at —
           their ticks included — to put a spinner where the answer was. The
           sample stays on screen, marked as a sample, until the verdict
           replaces it. The same rule the partition grid follows for a change
           of grain. */
        placeholderData: (previous: SchemaReview | undefined) => previous,
      }
    }),
  })

  const done = results.filter((r) => r.data !== undefined)
  const failed = results.filter((r) => r.error)
  /* Grouped on every render rather than memoised on the results array, whose
     identity changes each time anyway. It is a pass over at most forty reviews
     of pure data, and a stale grouping — findings from a review that has since
     been refetched — would be a page quietly describing a table as it was. */
  const reviews = done.map((r) => r.data as SchemaReview)
  /* What writes into each of these tables, so a materialized view's target is
     not offered as a change somebody can make on its own. */
  const fed = writtenBy(graph, database)
  const groups = group(reviews, fed)
  /* How many of the reviews on screen are verdicts. The line under the pattern
     said "a sample of each" whatever had happened since, which stops being true
     the moment anybody presses verify — and it is the one sentence on this page
     stating what the whole reading rests on. */
  const verdicts = reviews.filter((r) => r.verified).length

  /* What is on offer, counted over every group rather than the shown ones: the
     number beside a ticked-off box is what ticking it back on would bring. */
  const kinds = tally(groups)
  const shown = groups.filter((g) => !hidden.has(g.kind))
  const away = groups.length - shown.length

  /* Falls out of what has already been read rather than being asked for, and is
     the one thing here no per-table review could say. Over the shown groups,
     because a divergence about a column whose kind is hidden is an observation
     about a row that is not on the page — but over every *declared* type of
     every reviewed table, because two tables typing `user_id` differently
     disagree whether or not either is worth changing on its own, and no rule
     will ever have flagged it. */
  const splits = disagreements(reviews, shown)

  /* The ticks are what the reader asked for; this is what those asks resolve to
     against the findings as they stand. Verifying is expected to move some of
     them, which is the point of verifying — so the SQL is built from here and
     never from the map. */
  const settled = reconcile([...ticks.values()], groups)
  const chosen = settled.chosen
  const carried = reach(chosen)
  const sql = script(database, chosen)
  const conflicts = statements(database, chosen).conflicts
  /* Ticked changes that nothing on the page still shows.
     A tick is an explicit act and a filter is a way of looking, so hiding a
     kind must not quietly drop statements somebody chose — the SQL is built
     over every group, not the shown ones. Which leaves the opposite hazard: a
     block of SQL carrying a change the reader can no longer see. So it is
     counted and said, above the block rather than after it. */
  /* Keyed the way the tick map is keyed, and for its reason: a NUL cannot occur
     in an identifier, while a space can — `a b`.`c` and `a`.`b c` are two
     different columns that any friendlier separator turns into one. */
  const visibleKeys = new Set(shown.flatMap((g) => g.members.map(keyOf)))
  const hiddenChosen = chosen.filter((m) => !visibleKeys.has(keyOf(m))).length
  /* Which of the ticked tables are still hypotheses, and what verifying them
     would read. Only the ticked ones: the cost has to be the cost of the
     question actually being asked. */
  const unsure = [...new Set(chosen.filter((m) => !m.verified).map((m) => m.table))]
  const unsureBytes = chosen
    .filter((m) => !m.verified)
    .reduce((n, m) => n + (m.bytes ?? 0), 0)
  /* Tables whose full scan is in flight. Named rather than counted, because a
     full scan of a large table is a wait somebody should be able to attribute
     to a table rather than to the page. */
  const scanning = running.filter((table, i) => verifying.has(table) && results[i]?.isFetching)

  const tick = (member: Member, on: boolean) =>
    setTicks((current) => {
      const next = new Map(current)
      const key = `${member.table} ${member.column}`
      if (on) next.set(key, member)
      else next.delete(key)
      return next
    })

  /** Tick a whole group, minus the members whose ALTER the server would refuse.
   *  A shortcut that quietly included them would produce a block of SQL that
   *  fails halfway through, which is worse than not offering the shortcut. */
  const tickGroup = (g: Group, on: boolean) =>
    setTicks((current) => {
      const next = new Map(current)
      for (const member of g.members) {
        if (on && heldBack(member)) continue
        const key = `${member.table} ${member.column}`
        if (on) next.set(key, member)
        else next.delete(key)
      }
      return next
    })

  const started = run !== null && running.length > 0
  const pending = started && done.length < running.length

  return (
    <section className="sweep">
      <div className="sweep__pick">
        <label className="sweep__label" htmlFor="sweep-pattern">
          Tables like
        </label>
        <input
          className="sweep__pattern"
          id="sweep-pattern"
          value={pattern}
          onChange={(e) => onPattern(e.target.value)}
          placeholder="raw_%"
          spellCheck={false}
          autoComplete="off"
        />
        <p className="sweep__matched">
          {/* A pattern catches names without being watched, and `_` is a
              wildcard in LIKE — so the count is never the whole answer and the
              names are one fold away. */}
          {matched.length === names.length
            ? `every one of the ${count(names.length)} tables here`
            : `${count(matched.length)} of ${count(names.length)} tables`}
          {tables.length > reviewable.length
            ? ` · ${count(tables.length - reviewable.length)} ${
                tables.length - reviewable.length === 1 ? 'object has' : 'objects have'
              } no column types to review — a view stores no rows of its own`
            : ''}
          {candidates.length > taken.length
            ? ` · reviewing the ${MAX_TABLES} largest of them`
            : ''}
        </p>
        <button
          className="btn btn--spark sweep__go"
          disabled={taken.length === 0}
          onClick={() => {
            setRun(pattern)
            setTicks(new Map())
            /* A new selection is a new question, and carrying "read every row
               of this" across into it would spend a full scan nobody asked for
               a second time. */
            setVerifying(new Set())
          }}
          type="button"
        >
          {run === null ? 'Review these' : 'Review again'}
          <span className="btn__aside">
            {taken.length} {taken.length === 1 ? 'table' : 'tables'}
          </span>
        </button>
      </div>

      {matched.length > 0 ? (
        <details className="sweep__names">
          <summary>What this pattern caught</summary>
          <ul>
            {candidates.map((name, i) => (
              <li key={name} className={i >= MAX_TABLES ? 'is-past' : undefined}>
                <Link to={`/db/${encodeURIComponent(database)}/${encodeURIComponent(name)}?tab=review`}>
                  {name}
                </Link>
                {i >= MAX_TABLES ? <span className="sweep__past"> past the cap</span> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {!started ? (
        <EmptyNote title="Nothing reviewed yet">
          Reviewing reads a sample of every table the pattern caught — 200,000 rows each, not the
          whole table. Nothing here runs DDL: it produces the statements and the reasons to think
          twice.
        </EmptyNote>
      ) : (
        <>
          <p className="sweep__progress">
            {pending
              ? `Reviewed ${done.length} of ${running.length} tables…`
              : verdicts === 0
                ? `${count(running.length)} ${running.length === 1 ? 'table' : 'tables'} reviewed, a sample of each.`
                : verdicts === reviews.length
                  ? `${count(running.length)} ${running.length === 1 ? 'table' : 'tables'} reviewed over every row.`
                  : `${count(running.length)} tables reviewed — ${verdicts} over every row, the rest a sample of each.`}
            {failed.length > 0 ? (
              <>
                {' '}
                <strong>{failed.length}</strong> could not be read
                {/* Which ones, and why: a page that reviewed nine of twelve
                    tables and did not say so has ranked the wrong column at the
                    top and looks certain about it. */}
                {' — '}
                {failed
                  .map((r) => String((r.error as Error)?.message ?? r.error))
                  .slice(0, 2)
                  .join('; ')}
              </>
            ) : null}
          </p>

          {pending ? <Loading label="Sampling" /> : null}

          {!pending && groups.length === 0 ? (
            <EmptyNote title="Nothing to change across these tables">
              Every column type in them suits what is in it, as far as a sample of each can say.
            </EmptyNote>
          ) : null}

          {groups.length > 0 ? (
            <>
              <div className="sweep__bar">
                {shown.length > 0 ? (
                  <p className="sweep__stake">
                    <strong>{count(shown.length)}</strong>{' '}
                    {shown.length === 1 ? 'decision' : 'decisions'} over{' '}
                    {count(shown.reduce((n, g) => n + g.members.length, 0))} columns
                    {' — '}
                    holding <strong>{bytes(shown.reduce((n, g) => n + g.bytes, 0))}</strong> today
                    {/* Forty tables' worth of advice with a filter on it, read a
                        week after the box was ticked, is exactly the list that
                        reads as the whole truth. */}
                    {away > 0 ? ` · ${away} hidden by kind` : null}
                    <span className="sweep__caveat">
                      what those columns cost now, not what changing them would save — that needs
                      weighing, not guessing
                    </span>
                  </p>
                ) : null}
                {/* Only where there is a choice to make. */}
                {kinds.length > 1 ? (
                  <KindFilter kinds={kinds} hidden={hidden} onPut={put} onAll={showAll} />
                ) : null}
              </div>
              {splits.length > 0 ? (
                <section className="sweep__split">
                  <h4 className="sweep__splittitle">
                    {splits.length} {splits.length === 1 ? 'column name' : 'column names'} these
                    tables do not agree about
                  </h4>
                  <p className="sweep__splitwhy">
                    Read from every column of every table reviewed, not only the ones with a
                    finding: two tables typing one name differently disagree whether or not either
                    is worth changing on its own, and every join between them casts. Nothing
                    follows from it automatically — it is somewhere to look.
                    {splits.some((d) => d.withinFamily) ? (
                      <>
                        {' '}
                        The ones marked <strong>drift</strong> are between tables that are variants
                        of each other, where one of them is simply wrong; the rest are unrelated
                        tables sharing a common noun, which is ordinary.
                      </>
                    ) : null}
                  </p>
                  <ul className="sweep__splits">
                    {splits.map((d) => (
                      <li className="sweep__splitrow" key={d.column}>
                        <code className="sweep__column">{d.column}</code>
                        {d.withinFamily ? <span className="sweep__drift">drift</span> : null}
                        {d.declared.length > 1 ? (
                          <span className="sweep__splitside">
                            {d.declared
                              .map((t) => `${t.type} in ${t.tables.join(', ')}`)
                              .join(' · ')}
                          </span>
                        ) : null}
                        {d.proposals.length > 1 ? (
                          <span className="sweep__splitside">
                            heading for{' '}
                            {d.proposals
                              .map((t) => `${t.type} in ${t.tables.join(', ')}`)
                              .join(' · ')}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {/* Said once above the list, and in the terms this page makes
                  true: the statements are gathered per table, so a table is
                  read once however many of its columns are ticked. */}
              {shown.length === 0 ? (
                /* Not the same sentence as "nothing to change across these
                   tables": there is plenty, and the reader hid it. */
                <EmptyNote title={`${count(groups.length)} decisions, all of them hidden`}>
                  Every kind of finding across these tables is switched off in the filter.{' '}
                  <button className="review__showall" onClick={showAll} type="button">
                    show all
                  </button>
                </EmptyNote>
              ) : null}

              {shown.length > 0 ? (
                <p className="bhint">
                  Every MODIFY COLUMN below is a mutation: ClickHouse rewrites those columns in
                  every part of the table, which on a large one is hours of disk. Gathering a
                  table&rsquo;s changes into one statement is what makes that one pass rather than
                  one per column.
                </p>
              ) : null}

              {shown.length > 0 ? (
                <ul className="sweep__groups">
                  {shown.map((g) => (
                    <GroupRow
                      key={`${g.column} ${g.proposal}`}
                      database={database}
                      group={g}
                      ticks={ticks}
                      onTick={tick}
                      onTickGroup={tickGroup}
                    />
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}

          {chosen.length > 0 ? (
            <section className="sweep__out">
              <header className="sweep__outhead">
                <h4 className="sweep__outtitle">
                  {count(carried.columns)} {carried.columns === 1 ? 'change' : 'changes'} over{' '}
                  {count(carried.tables)} {carried.tables === 1 ? 'table' : 'tables'},{' '}
                  {count(carried.tables)} {carried.tables === 1 ? 'statement' : 'statements'}
                </h4>
                <p className="sweep__outfacts">
                  {carried.bytes > 0 ? `${bytes(carried.bytes)} of columns` : null}
                  {carried.unknown > 0
                    ? `${carried.bytes > 0 ? ' · ' : ''}${carried.unknown} whose size is not measurable`
                    : null}
                  {carried.unverified > 0
                    ? `${carried.bytes > 0 || carried.unknown > 0 ? ' · ' : ''}${carried.unverified} resting on a sample rather than every row`
                    : null}
                  {hiddenChosen > 0
                    ? `${carried.bytes > 0 || carried.unknown > 0 || carried.unverified > 0 ? ' · ' : ''}${hiddenChosen} ticked in a kind you have since hidden, still in the SQL`
                    : null}
                </p>
                <span className="panel__spacer" />
                {/* Bounded by the ticks, priced before it is asked for, and
                    gone once there is nothing left to promote from hypothesis
                    to verdict. */}
                {unsure.length > 0 ? (
                  <button
                    className="btn btn--spark"
                    disabled={scanning.length > 0}
                    onClick={() => setVerifying(new Set([...verifying, ...unsure]))}
                    title={`Reads every row of the ticked columns in ${unsure.length === 1 ? 'this table' : `these ${unsure.length} tables`}${
                      unsureBytes > 0 ? ` — about ${bytes(unsureBytes)} compressed` : ''
                    }`}
                    type="button"
                  >
                    {scanning.length > 0
                      ? `Reading ${scanning.length === 1 ? scanning[0] : `${scanning.length} tables`}…`
                      : `Verify ${unsure.length === 1 ? 'this table' : `these ${unsure.length} tables`}`}
                    {unsureBytes > 0 && scanning.length === 0 ? (
                      <span className="btn__aside">~{bytes(unsureBytes)}</span>
                    ) : null}
                  </button>
                ) : null}
                <button
                  className="btn"
                  onClick={() => {
                    void navigator.clipboard.writeText(sql).then(
                      () => setCopied(true),
                      () => setCopied(false),
                    )
                  }}
                  type="button"
                >
                  {copied ? 'Copied' : 'Copy the SQL'}
                </button>
              </header>

              {/* What verifying moved. Loud, and above the SQL rather than
                  beside it: a reader who ticked a UInt16 and is about to copy a
                  UInt32 has to be told, and told before they read the block
                  rather than after they have run it. */}
              {settled.changed.length > 0 ? (
                <p className="sweep__moved">
                  <strong>
                    {settled.changed.length}{' '}
                    {settled.changed.length === 1 ? 'change has' : 'changes have'} moved
                  </strong>{' '}
                  since you ticked{' '}
                  {settled.changed.length === 1 ? 'it' : 'them'} — the fuller measurement found
                  values the sample had not:{' '}
                  {settled.changed
                    .map((c) => `${c.table}.${c.column} ${c.was} → ${c.now}`)
                    .join(', ')}
                  . The SQL below follows the newer figure.
                </p>
              ) : null}
              {settled.dropped.length > 0 ? (
                <p className="sweep__moved">
                  <strong>
                    {settled.dropped.length}{' '}
                    {settled.dropped.length === 1 ? 'tick is' : 'ticks are'} no longer advised
                  </strong>{' '}
                  and {settled.dropped.length === 1 ? 'is' : 'are'} not in the SQL below:{' '}
                  {settled.dropped.map((d) => `${d.table}.${d.column}`).join(', ')}.
                </p>
              ) : null}

              {conflicts.length > 0 ? (
                <p className="bhint">
                  {conflicts.length} {conflicts.length === 1 ? 'tick was' : 'ticks were'} a second
                  proposal for a column already spoken for, and{' '}
                  {conflicts.length === 1 ? 'it is' : 'they are'} not in the SQL below:{' '}
                  {conflicts.map((c) => `${c.table}.${c.column} (${c.dropped})`).join(', ')}.
                </p>
              ) : null}

              <pre className="sweep__sql">{sql}</pre>
            </section>
          ) : null}
        </>
      )}
    </section>
  )
}

/** How many tables one press will sample. Not a technical limit — the browser
 *  would queue more happily enough — but the point past which "review these"
 *  stops being a thing somebody can hold in their head, and starts being a load
 *  on somebody's production server that they did not quite ask for. */
const MAX_TABLES = 40

/** One column, one proposed type, and every table it applies to.
 *
 *  The group is what you read and the members are what you tick, which is why
 *  the members are always shown rather than folded away: the evidence differs
 *  between them, and a reader agreeing to five changes at once should be able
 *  to see the five ranges the five proposals rest on. */
function GroupRow({
  database,
  group: g,
  ticks,
  onTick,
  onTickGroup,
}: {
  database: string
  group: Group
  ticks: Map<string, Member>
  onTick: (member: Member, on: boolean) => void
  onTickGroup: (group: Group, on: boolean) => void
}) {
  const tickable = g.members.filter((m) => !heldBack(m))
  const on = (m: Member) => ticks.get(`${m.table} ${m.column}`)?.proposal === m.proposal
  const chosen = tickable.filter(on).length
  const all = tickable.length > 0 && chosen === tickable.length

  return (
    <li className={`sweep__group sweep__group--${g.severity}`}>
      <div className="sweep__ghead">
        <label className="sweep__gtick">
          <input
            type="checkbox"
            checked={all}
            ref={(el) => {
              // Some ticked and some not is a third state, and a box that shows
              // it as "off" invites a click that turns everything on.
              if (el) el.indeterminate = chosen > 0 && !all
            }}
            disabled={tickable.length === 0}
            onChange={(e) => onTickGroup(g, e.target.checked)}
          />
          <code className="sweep__column">{g.column}</code>
        </label>
        <span className="sweep__headline">{g.headline}</span>
        <span className="sweep__spread">
          {g.members.length} {g.members.length === 1 ? 'table' : 'tables'}
        </span>
        <span className="sweep__bytes num">{g.bytes > 0 ? bytes(g.bytes) : null}</span>
        <span className="sweep__kind">{KIND_LABEL[g.kind].label}</span>
      </div>

      <p className="sweep__why">
        {/* Whose reasoning this is, said only when the members do not all start
            from the same type — otherwise it is the only type in play and
            naming it is noise. */}
        {g.declared.length > 1 ? <b className="sweep__mfrom">{g.whyFor}: </b> : null}
        {g.why}
      </p>

      <p className="sweep__claim">
        {g.verified === g.members.length
          ? `Verified over every row of ${g.members.length === 1 ? 'the table' : 'all ' + g.members.length + ' tables'}.`
          : g.verified === 0
            ? `A hypothesis: every table here was measured over a sample, not all of it.`
            : `Verified on ${g.verified} of ${g.members.length}; the rest were measured over a sample.`}
        {g.unknown > 0
          ? ` · ${g.unknown} of them keep their parts Compact, so that column has no measurable size and is not in the figure above.`
          : ''}
        {g.inKey > 0
          ? ` · ${g.inKey} ${g.inKey === 1 ? 'has' : 'have'} this column in a key, where ClickHouse refuses the change.`
          : ''}
        {g.fed > 0
          ? ` · ${g.fed} ${g.fed === 1 ? 'is' : 'are'} written by a materialized view whose SELECT would have to change too, so ${g.fed === 1 ? 'it is' : 'they are'} not offered here.`
          : ''}
      </p>

      {/* Said once when every table says the same thing, and only on the rows
          when they differ. Five tables repeating one sentence about verifying
          is the same caveat five times, which is how a caveat stops being
          read. */}
      {g.sharedUsage ? <p className="sweep__gusage">{g.sharedUsage}</p> : null}
      {g.sharedCaution ? <p className="sweep__gcaution">{g.sharedCaution}</p> : null}

      <ul className="sweep__members">
        {g.members.map((m) => (
          <li className={`sweep__member${heldBack(m) ? ' is-refused' : ''}`} key={m.table}>
            <label className="sweep__mtick">
              <input
                type="checkbox"
                checked={on(m)}
                disabled={heldBack(m)}
                onChange={(e) => onTick(m, e.target.checked)}
              />
              <Link
                to={`/db/${encodeURIComponent(database)}/${encodeURIComponent(m.table)}?tab=review`}
              >
                {m.table}
              </Link>
            </label>
            <span className="sweep__mevidence">
              {/* Which of these rows is the Int32 — a question only worth
                  answering when the group's members disagree about it. */}
              {g.declared.length > 1 ? <b className="sweep__mfrom">{m.from} · </b> : null}
              {m.evidence}
            </span>
            <span className="sweep__mbytes num">{m.bytes === null ? null : bytes(m.bytes)}</span>
            <span className={`sweep__mclaim${m.verified ? ' is-verified' : ''}`}>
              {m.verified ? 'every row' : 'sample'}
            </span>
            {/* Named, not just counted: "a materialized view writes here" is a
                sentence somebody has to act on by opening that view, and they
                cannot open one they have not been told the name of. */}
            {m.fedBy.length > 0 ? (
              <span className="sweep__mcaution">
                {m.fedBy.length === 1 ? 'Written by ' : 'Written by '}
                {m.fedBy.map((v, i) => (
                  <span key={v}>
                    {i > 0 ? ', ' : ''}
                    <Link to={`/db/${encodeURIComponent(database)}/${encodeURIComponent(v)}`}>
                      {v}
                    </Link>
                  </span>
                ))}
                . Its SELECT still produces the old type and would cast into the new one on every
                insert — and a narrowing cast truncates rather than refusing. Change the pair
                together, or not at all.
              </span>
            ) : null}
            {/* One change, carried to where structure may be written. The whole
                group leaves through the SQL block instead: the panel at the
                other end takes one action on one table, and that is the one
                form that loses the grouping. */}
            {heldBack(m) ? null : (
              <Link className="sweep__malter" to={handOver(database, m)}>
                Alter&nbsp;&rarr;
              </Link>
            )}
            {m.usage && !g.sharedUsage ? (
              <span className="sweep__musage">{m.usage}</span>
            ) : null}
            {m.caution && !g.sharedCaution ? (
              <span className="sweep__mcaution">{m.caution}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </li>
  )
}
