import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import {
  atStake,
  codecDdl,
  findings,
  MUTATION_COST,
  reading,
  tally,
  times,
  type Finding,
} from '../lib/review'
import { KindFilter, useHiddenKinds } from './KindFilter'
import { bytes, count, exact } from '../lib/format'
import { Link } from 'react-router-dom'
import { EmptyNote, ErrorNote, Loading } from './Note'

/** Whether this table's column types suit the data in it.
 *
 *  The shape of the page is the shape of the argument. A first pass reads a
 *  sample of the table and produces *hypotheses* — cheap, immediate, and clearly
 *  labelled as guesses. A second, asked for explicitly, reads every row and
 *  turns the survivors into *verdicts*. Nothing here runs DDL: each finding
 *  hands over the statement and the reason to think twice, and the reader
 *  decides.
 *
 *  Ordered by what the column costs on disk today, because that is the only
 *  honest way to rank advice about storage — and never by a predicted saving,
 *  which would be a number this page cannot know. */
export function SchemaReview({ database, table }: { database: string; table: string }) {
  /** Verification is a full scan. It happens when somebody asks for it, and the
   *  question is asked with the cost attached. */
  const [verify, setVerify] = useState(false)

  /** Which subjects the reader has put away. Remembered across tables and
   *  across surfaces, because "codecs are not my problem" is a standing
   *  position and not a per-table one — nobody wants to tick the same box on a
   *  hundred and sixty tables. */
  const { hidden, put, showAll } = useHiddenKinds()

  const review = useQuery({
    queryKey: ['review', database, table, verify],
    queryFn: () => api.review(database, table, verify),
    staleTime: 60_000,
    retry: false,
  })

  const list = useMemo(() => (review.data ? findings(review.data) : []), [review.data])
  const kinds = useMemo(() => tally(list), [list])
  const shown = useMemo(() => list.filter((finding) => !hidden.has(finding.kind)), [list, hidden])

  /* Two figures, and they are not the same one. What the *scan* would read is
     the whole review's — a filter is a thing this page does after the server
     answered, and hiding a card does not make the verification cheaper. What is
     *at stake* is the shown list's, because a total over rows nobody can see is
     a header nobody can reconcile. */
  const stake = useMemo(() => atStake(shown), [shown])
  const scan = useMemo(() => atStake(list), [list])

  if (review.isPending) {
    return <Loading label={verify ? 'Reading every row' : 'Reading a sample'} />
  }
  if (review.error) return <ErrorNote error={review.error} retry={() => review.refetch()} />
  if (!review.data) return null

  const data = review.data
  const proposals = shown.filter((f) => f.proposal !== null)
  const away = list.length - shown.length

  return (
    <section className="review">
      <header className="review__head">
        <div className="review__scope">
          <p className="review__claim">
            {data.verified ? (
              <>
                <strong>Verified</strong> over every row — {count(data.scanned)} of them.
              </>
            ) : (
              <>
                <strong>Hypotheses</strong> from {count(data.scanned)}
                {data.total_rows > data.scanned ? ` of ${count(data.total_rows)}` : ''} rows.
              </>
            )}
          </p>
          <p className="review__facts">
            {/* Everything a finding rests on, so the reader can weigh it: which
                engine, what the table is ordered by, and whether per-column
                sizes exist here at all. */}
            {data.engine}
            {data.sorting_key ? ` · ordered by ${data.sorting_key}` : ''}
            {data.part_type ? ` · ${data.part_type} parts` : ''}
            {data.sizes_known
              ? ''
              : ' · per-column sizes are not measurable here, so findings are ordered by how much they matter rather than by disk'}
          </p>
        </div>

        {/* Only where there is a choice to make: one kind of finding and the
            dropdown offers to hide everything, which is not an offer. */}
        {kinds.length > 1 ? (
          <KindFilter kinds={kinds} hidden={hidden} onPut={put} onAll={showAll} />
        ) : null}

        {data.verified ? null : (
          <button
            className="btn btn--spark"
            onClick={() => setVerify(true)}
            title={
              scan.columns > 0
                ? `Reads every row of the columns involved — about ${bytes(scan.bytes)} compressed`
                : 'Reads every row of the columns involved'
            }
            type="button"
          >
            Verify over every row
            {scan.columns > 0 ? <span className="btn__aside">~{bytes(scan.bytes)}</span> : null}
          </button>
        )}
      </header>

      {data.usage_known ? null : (
        <p className="bhint">
          This server’s query log could not be read, so nothing here knows which columns anything
          actually uses — only what they cost.
        </p>
      )}
      {data.degraded ? (
        <p className="bhint">
          Some of the measurements were refused by the server, so this review is the reduced one:
          counts only.
        </p>
      ) : null}

      <Elsewhere database={database} table={table} />

      {list.length === 0 ? (
        <EmptyNote title="Nothing to change here">
          Every column’s type suits what is in it, as far as {count(data.scanned)} rows can say.
          That is the answer this page most often gives on a schema somebody thought about.
        </EmptyNote>
      ) : shown.length === 0 ? (
        /* Not the same sentence as "nothing to change": there is something to
           change and the reader hid it. Saying so, with the way back, is the
           difference between a filter and a page that has lost its findings. */
        <EmptyNote title={`${count(list.length)} findings, all of them hidden`}>
          Every kind of finding on this table is switched off in the filter.{' '}
          <button className="review__showall" onClick={showAll} type="button">
            show all
          </button>
        </EmptyNote>
      ) : (
        <>
          <p className="review__stake">
            {proposals.length} {proposals.length === 1 ? 'change' : 'changes'} worth considering
            {stake.columns > 0 ? (
              <>
                {' '}
                over columns holding <strong>{bytes(stake.bytes)}</strong> today
                <span className="review__caveat">
                  what they cost now, not what a change would save — that needs weighing, not
                  guessing
                </span>
              </>
            ) : null}
            {stake.unknown > 0 ? ` · ${stake.unknown} whose size is not measurable here` : null}
            {/* A list silently truncated reads as the whole truth, and a filter
                the reader set five tables ago is exactly the sort of thing they
                have stopped seeing. */}
            {away > 0 ? ` · ${away} hidden by kind` : null}
          </p>

          <p className="review__cost">{MUTATION_COST}</p>

          <ul className="review__list">
            {shown.map((finding) => (
              <FindingCard
                key={finding.column + finding.headline}
                finding={finding}
                database={database}
                table={table}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

const TONE: Record<Finding['severity'], { label: string; pill: string }> = {
  // Not the danger colour for any of them: none of this is broken, and a page
  // of red pills over a schema somebody is proud of reads as an accusation.
  save: { label: 'costs disk', pill: 'pill pill--key' },
  fix: { label: 'wrong type', pill: 'pill pill--caution' },
  note: { label: 'worth knowing', pill: 'pill' },
}

function FindingCard({
  finding,
  database,
  table,
}: {
  finding: Finding
  database: string
  table: string
}) {
  const [copied, setCopied] = useState(false)
  const [readers, setReaders] = useState(false)

  /** Weighing is a write, so it happens when somebody presses the button and
   *  never as a side effect of opening the page. */
  const weigh = useMutation({
    mutationFn: () =>
      api.probe(database, table, { column: finding.column, to_type: finding.proposal! }),
  })
  const measured = weigh.data ? reading(weigh.data) : null

  return (
    <li className={`rfind rfind--${finding.severity}`}>
      <header className="rfind__head">
        <span className="rfind__col">{finding.column}</span>
        <span className="rfind__headline">{finding.headline}</span>
        <span className={TONE[finding.severity].pill}>{TONE[finding.severity].label}</span>
        {finding.bytes === null ? null : (
          <span className="rfind__bytes num" title="What this column occupies on disk today">
            {bytes(finding.bytes)}
          </span>
        )}
      </header>

      <p className="rfind__evidence num">
        {finding.evidence}
        {/* What reads it, beside what it costs: the two together are what make
            a change worth an afternoon, or not. */}
        {finding.usage ? (
          <button
            className="rfind__usage"
            onClick={() => setReaders((open) => !open)}
            aria-expanded={readers}
            title="The queries that read this column"
            type="button"
          >
            {finding.usage}
            <span className="rfind__twist" aria-hidden="true">
              {readers ? '▾' : '▸'}
            </span>
          </button>
        ) : null}
      </p>
      <p className="rfind__why">{finding.why}</p>

      {readers ? (
        <Readers database={database} table={table} column={finding.column} />
      ) : null}

      {finding.ddl ? (
        <div className="rfind__ddl">
          <pre className="code code--wrap">{finding.ddl}</pre>
          <button
            className="btn"
            onClick={() => {
              void navigator.clipboard.writeText(finding.ddl!).then(
                () => setCopied(true),
                () => setCopied(false),
              )
            }}
            type="button"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      ) : null}

      {finding.weigh === 'codecs' ? (
        <CodecWeigh database={database} table={table} column={finding.column} />
      ) : null}

      {finding.proposal ? (
        <div className="rmeasure">
          {weigh.data?.refused ? (
            // The most useful answer this button can give: not a saving but a
            // refusal, in the server's own words, over real rows.
            <p className="rmeasure__refused">
              <strong>The conversion refused</strong> on {count(weigh.data.total_rows)} rows —{' '}
              {weigh.data.refused}
            </p>
          ) : measured ? (
            <p className="rmeasure__read">
              <span className="rmeasure__figs num">
                {bytes(measured.before)} → {bytes(measured.after)}
              </span>
              {/* No ratio means one of the two weighed to nothing, and there is
                  no factor to name. The house rule holds here too: a figure
                  that does not exist is dropped, not dashed — the sizes above
                  are the measurement, and they stand on their own. */}
              {measured.ratio !== null ? (
                <>
                  <strong>{times(measured.ratio)}</strong> smaller, compressed, over{' '}
                  {count(measured.rows)} rows
                </>
              ) : (
                <>compressed, over {count(measured.rows)} rows</>
              )}
              {measured.rawRatio !== null && times(measured.rawRatio) !== times(measured.ratio) ? (
                <span className="rmeasure__aside">
                  the values themselves are {times(measured.rawRatio)} smaller — compression had
                  already found most of it
                </span>
              ) : null}
              {measured.scanRatio !== null ? (
                <span className="rmeasure__aside">
                  the same grouping moved {bytes(measured.beforeScanned)} instead of{' '}
                  {bytes(measured.afterScanned)} — {times(measured.scanRatio)} less to scan. Bytes,
                  not seconds: how much faster a query gets depends on the query, the disk and the
                  cache.
                </span>
              ) : null}
              {measured.projected !== null ? (
                <span className="rmeasure__aside">
                  the whole column is {bytes(finding.bytes ?? 0)} today; at that ratio, about{' '}
                  {bytes(measured.projected)}
                </span>
              ) : (
                <span className="rmeasure__aside">
                  this table's parts are Compact, so what the column costs today is not measurable —
                  the ratio is, and it is measured
                </span>
              )}
              {measured.worse ? (
                <span className="rmeasure__aside rmeasure__aside--warn">
                  it is bigger this way, not smaller
                </span>
              ) : null}
            </p>
          ) : (
            <button
              className="btn"
              onClick={() => weigh.mutate()}
              disabled={weigh.isPending}
              title="Writes the same rows both ways into a scratch table in Flint's own database, weighs them, and drops it"
              type="button"
            >
              {weigh.isPending ? 'Weighing…' : 'Measure it'}
            </button>
          )}
          {weigh.error ? <ErrorNote error={weigh.error} /> : null}
        </div>
      ) : null}

      {/* Under the statement, not above it: the caution is what to read last,
          just before deciding. */}
      {finding.caution ? <p className="rfind__caution">{finding.caution}</p> : null}
      {finding.verified ? null : (
        <p className="rfind__caution rfind__caution--soft">
          {/* Not "a prefix": the sample is a LIMIT with no ORDER BY, so it is
              some rows of the table and not its first ones. The conclusion is
              unchanged — a partial read is a hypothesis — but the sentence must
              not claim a determinism the query never asked for. */}
          Measured over a sample of the table — a hypothesis, not a verdict.
        </p>
      )}
    </li>
  )
}

/** The queries that read a column, as they were written.
 *
 *  This exists because of a question `system.query_log` cannot answer. It
 *  records the columns a query touched, not what it did with them — so "is this
 *  column filtered on, is it in an ORDER BY" has two possible answers: guess
 *  from the SQL text with regular expressions, or show the SQL. Guessing is
 *  folklore and gets the first subquery wrong. This shows the SQL, biggest
 *  reader first, and lets the reader see their own `ORDER BY`.
 *
 *  Grouped by ClickHouse's own normalised hash, so the list is shapes rather
 *  than repetitions. */
/** The window this list actually covers.
 *
 *  The same problem the review's own wording has: a seven-day question against a
 *  log with a one-day TTL is a twelve-hour answer, and the hours come from the
 *  server because the two clocks are not the same one. */
function reach(data: { days: number; hours: number | null }): string {
  const hours = data.hours
  if (hours === null || hours >= data.days * 24 - 2) return `${data.days} days`
  if (hours >= 48) return `the ${Math.round(hours / 24)} days the log keeps`
  if (hours >= 2) return `the ${hours} hours the log keeps`
  return 'the last hour, which is all the log keeps'
}

function Readers({
  database,
  table,
  column,
}: {
  database: string
  table: string
  column: string
}) {
  const readers = useQuery({
    queryKey: ['readers', database, table, column],
    queryFn: () => api.readers(database, table, column),
    staleTime: 60_000,
    retry: false,
  })

  if (readers.isPending) return <Loading label="Reading the query log" />
  if (readers.error) return <ErrorNote error={readers.error} />
  if (!readers.data) return null
  if (!readers.data.available) {
    return (
      <p className="bhint">
        This server’s query log cannot be read, so there is nothing to show about what uses this
        column.
      </p>
    )
  }
  if (readers.data.entries.length === 0) {
    return (
      <p className="bhint">
        No query read this column in {reach(readers.data)} — Flint’s own questions excluded.
      </p>
    )
  }

  return (
    <div className="rread">
      <p className="rread__head">
        {/* What the list leaves out, stated: a capped list that does not say so
            reads as the whole truth. */}
        {readers.data.shapes > readers.data.entries.length
          ? `The ${readers.data.entries.length} that read the most, of ${readers.data.shapes} query shapes, over ${reach(readers.data)}. `
          : `What read it, biggest first, over ${reach(readers.data)}. `}
        The log records which columns a query touched, not what it did with them — the SQL below is
        where a WHERE or an ORDER BY shows.
      </p>
      <ul className="rread__list">
        {readers.data.entries.map((entry) => (
          <li className="rread__item" key={entry.sample + entry.last_seen}>
            <div className="rread__facts num">
              <span title={`${exact(entry.runs)} runs`}>{count(entry.runs)}×</span>
              <span title={`${exact(entry.read_bytes)} bytes read in total`}>
                {bytes(entry.read_bytes)} read
              </span>
              <span>{count(entry.max_ms)} ms at worst</span>
              {entry.users > 1 ? <span>{entry.users} users</span> : null}
              <span className="rread__when">last {entry.last_seen}</span>
            </div>
            {/* On one line, whitespace collapsed. Kept as written, four of
                these statements differ only in a LIMIT or an ORDER BY — the
                part a four-line clip hides — and the list reads as five copies
                of the same query. The full text is a hover away. */}
            <pre className="code code--wrap rread__sql" title={entry.sample}>
              {entry.sample.replace(/\s+/g, ' ').trim()}
            </pre>
            <Link
              className="rread__open"
              to={`/query?sql=${encodeURIComponent(entry.sample)}&database=${encodeURIComponent(database)}`}
            >
              Open in the editor →
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Every codec worth trying on one column, weighed together.
 *
 *  No recommendation is offered before the measurement and none is needed
 *  after: the rows are ordered by what they cost, so the smallest is first and
 *  the reader can see how much the next one gives up. A codec that turns out
 *  *worse* than the column's current writing stays in the list and is marked —
 *  that is the finding, and hiding it would leave the reader believing the
 *  recommendation everybody repeats. */
function CodecWeigh({
  database,
  table,
  column,
}: {
  database: string
  table: string
  column: string
}) {
  const weigh = useMutation({ mutationFn: () => api.codecs(database, table, column) })
  const data = weigh.data

  if (!data) {
    return (
      <div className="rmeasure">
        <button
          className="btn"
          onClick={() => weigh.mutate()}
          disabled={weigh.isPending}
          title="Writes the same rows once per codec into a scratch table in Flint's own database, weighs them, and drops it"
          type="button"
        >
          {weigh.isPending ? 'Weighing…' : 'Weigh the codecs'}
        </button>
        {weigh.error ? <ErrorNote error={weigh.error} /> : null}
      </div>
    )
  }

  const ranked = [...data.candidates].sort((a, b) => a.compressed - b.compressed)

  return (
    <div className="rcodec">
      <p className="rcodec__head">
        Over {count(data.rows)} rows, written once per codec. As it stands today:{' '}
        <strong>{bytes(data.baseline)}</strong>.
      </p>
      <ul className="rcodec__list">
        {ranked.map((candidate) => {
          const ratio = candidate.compressed > 0 ? data.baseline / candidate.compressed : null
          const worse = ratio !== null && ratio < 1
          const ddl = codecDdl(database, table, column, data.type, candidate.codec)
          return (
            <li className={`rcodec__row${worse ? ' is-worse' : ''}`} key={candidate.codec}>
              <span className="rcodec__name">CODEC({candidate.codec})</span>
              <span className="rcodec__bytes num">{bytes(candidate.compressed)}</span>
              <span className="rcodec__ratio num">
                {ratio === null ? '—' : worse ? `${times(ratio)} — bigger` : `${times(ratio)}`}
              </span>
              <button
                className="rcodec__copy"
                onClick={() => void navigator.clipboard.writeText(ddl)}
                title={ddl}
                type="button"
              >
                copy the ALTER
              </button>
            </li>
          )
        })}
      </ul>
      <p className="rcodec__note">
        A codec is lossless, so nothing here risks the data — only the time to rewrite the column.
        {ranked.some((c) => c.compressed > data.baseline)
          ? ' One of these is bigger than what the column has now, which is why they are weighed rather than recommended.'
          : ''}
      </p>
    </div>
  )
}

/** Where the rest of this database's disk is.
 *
 *  A review is per table, and nobody with a hundred and sixty tables starts at
 *  the right one. This is the question before it — which table is worth opening —
 *  answered from metadata alone: no sampling, no data read, one query over
 *  `system.parts_columns`.
 *
 *  The coverage is stated beside the ranking, because it is often not total. Per
 *  column bytes exist only in `Wide` parts, so a database of small tables can
 *  have most of its disk where this cannot see. A list that covered 78% of a
 *  database while looking like all of it would be the worst kind of half-truth:
 *  the sort of thing somebody plans a week around. */
function Elsewhere({ database, table }: { database: string; table: string }) {
  const [open, setOpen] = useState(false)
  const heavy = useQuery({
    queryKey: ['heavy', database],
    queryFn: () => api.heavy(database, 12),
    enabled: open,
    staleTime: 5 * 60_000,
    retry: false,
  })

  if (!open) {
    return (
      <button className="review__elsewhere" onClick={() => setOpen(true)} type="button">
        Where the rest of {database} keeps its disk →
      </button>
    )
  }
  if (heavy.isPending) return <Loading label="Reading the part metadata" />
  if (heavy.error) return <ErrorNote error={heavy.error} />
  if (!heavy.data) return null

  const data = heavy.data
  const hidden = Math.max(0, data.on_disk - data.visible)
  const others = data.columns.filter((c) => c.table !== table)

  return (
    <section className="heavy">
      <header className="heavy__head">
        <h4 className="heavy__title">Where {database} keeps its disk</h4>
        <p className="heavy__scope">
          {data.columns_total > data.columns.length
            ? `The ${data.columns.length} heaviest of ${count(data.columns_total)} columns, from part metadata — nothing sampled. `
            : 'The heaviest columns, from part metadata — nothing sampled. '}
          {data.visible > 0 ? (
            <>
              This accounts for {bytes(data.visible)} of the {bytes(data.on_disk)} its parts hold
              {hidden > 0 ? (
                <>
                  ; the other {bytes(hidden)} is in {count(data.compact_parts)} of{' '}
                  {count(data.parts)} parts that keep every column in one file, where per-column
                  bytes do not exist
                </>
              ) : null}
              .
            </>
          ) : (
            <>
              Every part in this database is Compact — every column in one file — so there are no
              per-column bytes to rank. The only figure available is what each table holds
              altogether.
            </>
          )}
        </p>
      </header>
      {others.length > 0 ? (
        <ul className="heavy__list">
          {others.map((entry) => (
            <li className="heavy__row" key={`${entry.table}.${entry.column}`}>
              <Link className="heavy__where" to={`/db/${encodeURIComponent(database)}/${encodeURIComponent(entry.table)}?tab=review`}>
                {entry.table}
              </Link>
              <span className="heavy__col">{entry.column}</span>
              <span className="heavy__type" title={entry.type}>
                {entry.type}
              </span>
              <span className="heavy__bytes num">{bytes(entry.compressed)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
