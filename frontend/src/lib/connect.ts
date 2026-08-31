/** Whether the address a table points at actually answers.
 *
 *  A definition is metadata. ClickHouse stores `S3('http://s3:9000/flint/…')`
 *  without checking that the bucket is there, so the object page can describe,
 *  in perfect detail, a connection that has been broken for a year. The first
 *  person to find out is whoever runs a query.
 *
 *  The reading itself is one line from the backend. What is here is the
 *  sentence, and the four outcomes it has to keep apart — because three of them
 *  are usually rendered as one red box, and they send you to three different
 *  places. */

export interface Attempt {
  /** Whether the far end answered. Not whether it had anything. */
  ok: boolean
  elapsed_ms: number
  found: boolean
  /** The server's own words, trimmed of its stack trace and build stamp. */
  error: string
  /** Set when Flint declined to try, and says why. A refusal is not a failure
   *  and must not be coloured like one. */
  refused: string
}

/** `reached` and `empty` are both successes. Keeping them apart is the point:
 *  "the bucket is there and has nothing in it" is the answer to half the
 *  tickets this check exists to shorten, and a green tick alone does not give
 *  it. */
export type Verdict = 'reached' | 'empty' | 'failed' | 'refused'

export function verdictOf(attempt: Attempt): Verdict {
  if (attempt.refused) return 'refused'
  if (!attempt.ok) return 'failed'
  return attempt.found ? 'reached' : 'empty'
}

/** How long it took, in the unit that reads.
 *
 *  Milliseconds up to a second, because that is the range a working connection
 *  lives in and `0.084 s` is unreadable; seconds above it, because past a
 *  second the interesting figure is the order of magnitude and `4231 ms` makes
 *  the reader count digits. */
export function saysElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

/** The outcome as a sentence.
 *
 *  The error is quoted rather than summarised. ClickHouse's own message names
 *  the bucket, the host or the status code, and every rewording of it Flint
 *  could attempt would be a worse version of what somebody is about to paste
 *  into a search box. */
/** The same outcome where there is one line for it rather than a paragraph.
 *
 *  A failing `URL` table hands back the remote server's *response body*: five
 *  hundred characters of somebody's 404 page, inside the exception, which in a
 *  list of twenty addresses buries the nineteen either side of it. The full
 *  message is still worth having and is kept on the element's title, and the
 *  object page — which has the room — shows it whole. */
export function saysShort(attempt: Attempt, max = 130): string {
  const said = saysAttempt(attempt)
  if (said.length <= max) return said
  // Cut at a word rather than mid-token: a truncated hostname reads as a
  // different hostname.
  const cut = said.lastIndexOf(' ', max)
  return `${said.slice(0, cut > max / 2 ? cut : max).trimEnd()}…`
}

export function saysAttempt(attempt: Attempt): string {
  switch (verdictOf(attempt)) {
    case 'refused':
      return attempt.refused
    case 'failed':
      return `No answer after ${saysElapsed(attempt.elapsed_ms)}. ${attempt.error}`
    case 'empty':
      return `Answered in ${saysElapsed(attempt.elapsed_ms)}, with no row to give — the far end is reachable and there is nothing in it.`
    case 'reached':
      return `Answered in ${saysElapsed(attempt.elapsed_ms)}, with a row to give.`
  }
}
