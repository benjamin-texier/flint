/** What somebody said about a finding, and what that means the next time.
 *
 *  `/checkup` and the arrival board both compute their findings from scratch
 *  on every visit — that is what keeps them honest, and it is also why an
 *  answer cannot live in the finding. It lives in the workspace, keyed by the
 *  finding's own id, which `lib/checkup` has always built from what a finding
 *  is *about* rather than from its wording: `schema:cold:analytics.events`
 *  survives Flint rewriting the sentence, the numbers moving, and the report
 *  being asked for over a different window.
 *
 *  ## Putting something away is not deleting it
 *
 *  Three answers, and they are deliberately not a severity:
 *
 *  - **put away** — *not a problem here*. The finding stops being listed and
 *    is counted instead, because a page that hides things without saying how
 *    many is a page whose silence means nothing.
 *  - **accepted** — *yes, and I will do it*. It stays listed and is marked:
 *    hiding work somebody has taken on is how it stops happening.
 *  - **reopened** — the undo, and a row of its own rather than a deletion,
 *    because changing one's mind is the part of the history worth keeping.
 *
 *  ## A dismissal can outlive its reason
 *
 *  This is the half that makes the feature more than a hide button. A finding
 *  put away when a table held 400 MiB is a judgement about 400 MiB. When the
 *  same finding comes back at four gigabytes, the dismissal is still *there*
 *  and is no longer about the same thing — so it is surfaced again, marked,
 *  with both figures, and the reader decides again. That is the re-evaluation
 *  the roadmap asks for, and it needs no extra measurement: the worth is
 *  stored with the answer, and the worth is what changed.
 *
 *  Being wrong in either direction costs something, which is why the rule has
 *  two parts rather than one. Too sensitive and every dismissal comes back on
 *  the first merge, which trains people to ignore the page. Too blunt and a
 *  table that has quadrupled stays quiet. So: a **factor**, because a
 *  proportional change is what "the same problem, bigger" means — and a
 *  **floor** per unit, because doubling six megabytes is not news.
 */

import { bytes, count } from './format'
import type { Finding, Gain } from './checkup'

export interface Answer {
  finding: string
  /** When it was answered, as ClickHouse wrote it. Read as UTC, which is the
   *  convention the audit page settled on after finding that a naive
   *  timestamp parsed as local made every entry look two hours old. */
  at: string
  state: string
  note: string
  who: string
  area: string
  object: string
  /** What the finding claimed when it was answered. */
  title: string
  gain_kind: string
  gain_n: number
  /** How many times this finding has been answered. Above one, somebody has
   *  changed their mind about it before. */
  times: number
}

/** What a finding's answer means for this run of it. */
export type Standing =
  | { kind: 'open' }
  /** Answered, and the answer was to put it back. Listed exactly like an
   *  unanswered finding — that is what reopening means — but *marked*, because
   *  the history is the one thing a reopened finding still has to say and a row
   *  with no mark has nowhere to hang it. Found by looking: a finding put away
   *  and taken back showed no trace at all, so the record of somebody changing
   *  their mind was reachable only through the API. */
  | { kind: 'reopened'; answer: Answer }
  | { kind: 'away'; answer: Answer }
  | { kind: 'accepted'; answer: Answer }
  /** Put away, and the thing it was put away about has moved. */
  | { kind: 'stale'; answer: Answer; says: string }

/** How far a figure has to move before a dismissal stops applying. */
const FACTOR = 2

/** And by how much in absolute terms, per unit, so that doubling nothing is
 *  not news. Each of these is a sentence somebody can argue with: sixty-four
 *  megabytes is about the smallest disk saving worth a second look, ten
 *  seconds of query time a week is the smallest worth re-reading, and a
 *  hundred thousand rows is where a row count starts to mean something. */
const FLOOR: Record<string, number> = {
  bytes: 64 * 1024 * 1024,
  seconds: 10,
  rows: 100_000,
}

function said(kind: string, n: number): string {
  if (kind === 'bytes') return bytes(n)
  if (kind === 'seconds') return `${n < 1 ? n.toFixed(2) : Math.round(n)} s`
  if (kind === 'rows') return count(n)
  return String(n)
}

/** Whether the worth of a finding has moved enough that an answer about the
 *  old figure is no longer an answer about this one — and how to say it.
 *
 *  Null where it has not, which is the common case and the whole point: a
 *  dismissal that came back every time a merge moved a number by 3% would be
 *  a dismissal nobody would bother giving.
 */
export function moved(now: Gain, was: { kind: string; n: number }): string | null {
  // A finding with nothing to measure cannot have moved, however long ago it
  // was answered. "Nothing is backed up" is the same claim today as it was in
  // March, and re-raising it on a timer would be a reminder rather than a
  // finding.
  if (now.kind === 'none' || was.kind === 'none' || !was.kind) return null
  if (now.kind !== was.kind) {
    // The finding is measuring something else than it was. Rare enough that
    // it means a rule changed underneath the answer, which is exactly when a
    // reader should look again.
    return `it was ${said(was.kind, was.n)} when it was answered, and is measured in ${now.kind} now`
  }
  const floor = FLOOR[now.kind] ?? 0
  if (Math.abs(now.n - was.n) < floor) return null
  // A worth that was zero or unrecorded cannot be divided by; anything above
  // the floor is a move in its own right.
  if (was.n <= 0) return `it was not measured when it was answered, and is ${said(now.kind, now.n)} now`
  const ratio = now.n / was.n
  if (ratio < FACTOR && ratio > 1 / FACTOR) return null
  return `it was ${said(was.kind, was.n)} then, and is ${said(now.kind, now.n)} now`
}

/** The answers, by the finding they are about. */
export function index(answers: Answer[] | undefined): Map<string, Answer> {
  return new Map((answers ?? []).map((a) => [a.finding, a]))
}

/** Where this finding stands. */
export function standingOf(finding: Finding, answer: Answer | undefined): Standing {
  if (!answer) return { kind: 'open' }
  if (answer.state === 'accepted') return { kind: 'accepted', answer }
  if (answer.state === 'reopened') return { kind: 'reopened', answer }
  // A state this version does not know is not a reason to hide something.
  if (answer.state !== 'dismissed') return { kind: 'open' }
  const says = moved(finding.gain, { kind: answer.gain_kind, n: answer.gain_n })
  return says ? { kind: 'stale', answer, says } : { kind: 'away', answer }
}

/** The findings to list, and the ones somebody has put away.
 *
 *  A stale dismissal is listed, which is the whole of the re-evaluation: it
 *  comes back where the reader will see it, marked with what it was put away
 *  about, rather than being quietly counted with the ones that still hold.
 */
export function split(
  findings: Finding[],
  answers: Map<string, Answer>,
): { open: Finding[]; away: Finding[] } {
  const open: Finding[] = []
  const away: Finding[] = []
  for (const finding of findings) {
    // Only a live dismissal is put aside. Accepted, reopened and stale are all
    // listed, for three different reasons written where each is decided.
    if (standingOf(finding, answers.get(finding.id)).kind === 'away') away.push(finding)
    else open.push(finding)
  }
  return { open, away }
}

/** What to say about the ones not listed. Never nothing: a page that drops
 *  rows without a count reads as the whole truth, which is the rule every
 *  other cap in this product follows. */
export function saysAway(away: Finding[]): string | null {
  if (away.length === 0) return null
  return away.length === 1
    ? '1 finding put away'
    : `${away.length} findings put away`
}

/** The one-line note a marked row carries. */
export function saysStanding(standing: Standing): string | null {
  switch (standing.kind) {
    case 'open':
      return null
    case 'reopened':
      return `Reopened by ${standing.answer.who}`
    case 'accepted':
      return `Accepted by ${standing.answer.who}${standing.answer.note ? ` — ${standing.answer.note}` : ''}`
    case 'away':
      return `Put away by ${standing.answer.who}${standing.answer.note ? ` — ${standing.answer.note}` : ''}`
    /* The note is kept here of all places. It is the context somebody needs to
       decide *again*, which is the only thing this row is asking them to do —
       "small enough to leave" is exactly what a reader wants in front of them
       when the thing is no longer small. */
    case 'stale':
      return `Put away by ${standing.answer.who}${
        standing.answer.note ? ` — ${standing.answer.note}` : ''
      }. Back because ${standing.says}`
  }
}
