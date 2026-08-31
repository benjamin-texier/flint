/** Whether Flint can be reached at all, held once for the whole window.
 *
 *  When the backend stops answering, every panel on the page fails within a
 *  second of every other — the rail, the diagram, the badge counts in the nav —
 *  and each one used to draw its own red card with its own copy of "502 Bad
 *  Gateway" and its own Try again. Three of those on one screen is not three
 *  times the information: it is the same fact, said three times, in the shape of
 *  something the reader did wrong.
 *
 *  So the fact is lifted out of the panels. One strip at the top of the window
 *  says what is unreachable and keeps checking; the panels underneath go quiet
 *  and wait. Nothing here is React — the store is fed from the query cache,
 *  which is not a component — and everything that decides *what* is wrong is a
 *  pure function, tested.
 */

import { FlintError } from './api'

/** Whose absence this is. The two failures look almost identical from a panel
 *  and are entirely different to act on: one is a process that is not running,
 *  the other is a process that is running and cannot see its database. */
export type Outage = 'flint' | 'clickhouse'

/** What a failed request says about the deployment as a whole, or null when it
 *  says nothing — which is the usual case, and the reason this is not simply
 *  "the last error".
 *
 *  The distinctions are all in the envelope. A fetch that never got an answer
 *  is `network`, and means nothing is listening. Flint's own errors always
 *  carry a JSON body with a `kind`, so a 502 *with* `transport` is Flint
 *  telling us it cannot reach ClickHouse, while a 502 with no envelope at all
 *  is somebody else's proxy answering for a Flint that has gone — Vite's
 *  "502 Bad Gateway" in development, nginx in production. `decode` is left out
 *  on purpose: it is also a 502, but it is one bad answer to one question, not
 *  an outage. */
export function outageOf(error: unknown): Outage | null {
  if (!(error instanceof FlintError)) return null
  if (error.kind === 'network') return 'flint'
  if (error.kind === 'transport') return 'clickhouse'
  const gateway = error.status === 502 || error.status === 503 || error.status === 504
  return gateway && error.kind === 'http' ? 'flint' : null
}

/** The headline. Names the thing that is absent, in the deployment's own
 *  vocabulary — not "something went wrong". */
export function outageTitle(outage: Outage): string {
  return outage === 'flint' ? 'Flint is not answering' : 'Flint cannot reach ClickHouse'
}

/** The sentence under it: what this means, and the one thing worth checking.
 *  Never an apology, and never a stack trace. */
export function outageHint(outage: Outage): string {
  return outage === 'flint'
    ? 'Nothing is answering on this address. The server has stopped, or is restarting — this page keeps checking and fills itself back in the moment it answers.'
    : 'Flint itself is up; the ClickHouse it connects to is not answering. Check FLINT_CLICKHOUSE_URL, and that the server is accepting HTTP connections.'
}

/** How long to wait before the nth check, in milliseconds.
 *
 *  A restart is usually over in a couple of seconds, so the first check is
 *  quick; a server that has been down for five minutes is not coming back
 *  within one, and asking every two seconds for an afternoon is a request log
 *  full of the same failure. It settles at half a minute — long enough to be
 *  quiet, short enough that nobody who fixes the server sits looking at a stale
 *  page wondering whether Flint noticed. */
const STEPS = [2_000, 4_000, 8_000, 15_000, 30_000]

export function probeDelay(attempt: number): number {
  return STEPS[Math.min(Math.max(attempt, 0), STEPS.length - 1)]!
}

/** What the window currently believes about reaching the backend. */
export interface Reach {
  outage: Outage | null
  /** When the *first* failure of this outage was seen. A restart that takes
   *  three minutes should say three minutes, not reset its clock on every
   *  failing request underneath. */
  since: number
}

const CLEAR: Reach = { outage: null, since: 0 }

let current: Reach = CLEAR
const listeners = new Set<() => void>()

function publish(next: Reach) {
  current = next
  for (const listener of listeners) listener()
}

/** A request failed. Only the failures that mean "nothing works" land here;
 *  everything else stays the business of the panel that asked. */
export function reachFailed(error: unknown, at: number = Date.now()) {
  const outage = outageOf(error)
  if (!outage) return
  // A second failure of an outage already known changes nothing — and must not
  // move `since`, or the strip would keep saying "for 2 s" forever.
  if (current.outage === outage) return
  publish({ outage, since: at })
}

/** Something answered. Any answer at all is enough: a refusal is a running
 *  server refusing, which is not an outage. */
export function reachAnswered() {
  if (current.outage === null) return
  publish(CLEAR)
}

export function reachSnapshot(): Reach {
  return current
}

export function subscribeReach(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Test seam: the store is module state, and a test that leaves it down would
 *  hand the next test an outage it never caused. */
export function resetReach() {
  publish(CLEAR)
}
