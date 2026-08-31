import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import { api } from '../lib/api'
import { read, reach } from '../lib/news'
import { spaceOf } from '../lib/spaces'
import { ErrorNote, Loading } from './Note'

import type { SpaceId } from '../lib/spaces'

/** What changed since you last looked.
 *
 *  The band a space's board opens with, and the answer to the one complaint no
 *  page in Flint had ever addressed: opening it told you what *exists*, never
 *  what is *different*. Every figure behind this was already being measured —
 *  what statements cost, what failed, what was reshaped, what was written — and
 *  each one lived on the page you had to already suspect. `lib/news` does the
 *  judging, with its thresholds in a test file; this draws the result.
 *
 *  **Filed by destination, exactly as `attention.ts` files a concern.** A
 *  headline is Infrastructure because it sends you under `/infra` and for no
 *  other reason, so one measurement serves two boards without either of them
 *  showing the other's work. That leaves the split lopsided — a reshaped object
 *  is the only kind that lands in Infrastructure — and the lopsidedness is
 *  right: a statement's cost and a table that stopped taking rows are facts
 *  about the data whatever it took an operator to cause them.
 *
 *  Which is why `lead` exists rather than a second component. On Data's board
 *  this *is* the opening verdict, so it speaks even when it has nothing to
 *  report: "nothing moved" is the answer somebody came for, and a section that
 *  vanishes when the answer is good makes the reader wonder whether it ran.
 *  Infrastructure's board already opens with a verdict of its own, so here the
 *  band is a row it gains when the schema moved and silence otherwise — a
 *  second empty panel under `/infra`'s own "nothing wrong" would be the same
 *  answer twice. */
export function Headlines({ space, lead = false }: { space: SpaceId; lead?: boolean }) {
  /* One cache entry for both boards, and a stale time long enough that walking
     between them does not re-read six days of the query log. The window is the
     default 24 hours: a shorter one would be a question about right now, which
     is what Health and the console are for. */
  const news = useQuery({
    queryKey: ['news', 24],
    queryFn: () => api.news(24),
    staleTime: 120_000,
    retry: false,
  })

  const report = news.data
  const { headlines, blocked } = read(report)
  const mine = headlines.filter((h) => spaceOf(h.to) === space)

  /* Nothing to add to a board that already answered the question. */
  if (!lead && !mine.length) return null

  return (
    <section className="section news" aria-labelledby="news-title">
      <div className="section__bar">
        <h2 className="section__title section__title--bare" id="news-title">
          What changed
        </h2>
        {/* The caption states the reach of the comparison rather than the window
            asked for — see `reach`. Absent until the report is, because a span
            named before it is known is a span that may turn out to be wrong. */}
        {report ? <span className="label">{reach(report)}</span> : null}
      </div>

      {news.error ? <ErrorNote error={news.error} retry={() => news.refetch()} /> : null}
      {news.isPending ? <Loading label="Reading what changed" /> : null}

      {/* Said plainly and once. The reason the log cannot answer is itself the
          answer — a board that showed an empty list over an unreadable log would
          be reporting "nothing changed" about a server it never read. */}
      {blocked ? <p className="news__quiet">{blocked}</p> : null}

      {report && !blocked && !mine.length && lead ? (
        <p className="news__quiet">
          Nothing moved. No statement cost what it usually does not, no table that was being
          written stopped, and nothing was reshaped.
        </p>
      ) : null}

      {mine.length ? (
        <ul className="news__list">
          {mine.map((headline) => (
            /* The rank is an edge, and the edge is reinforcement rather than the
               only carrier: every sentence here says what happened in words —
               "took nothing", "started failing" — so a reader who cannot see the
               colour has lost an emphasis and not the fact. */
            <li className={`news__row news__row--${headline.rank}`} key={headline.id}>
              <Link className="news__subject" to={headline.to}>
                {headline.subject}
              </Link>
              <span className="news__says">{headline.says}</span>
              {/* Dropped, not dashed: a headline with no figure worth giving is
                  a headline whose sentence already carried it. */}
              {headline.figure ? <span className="news__figure">{headline.figure}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
