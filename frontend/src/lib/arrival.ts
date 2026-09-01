/** The order somebody meets a server they have just connected to.
 *
 *  Flint has always had a great deal to say and no opinion about what to say
 *  first. Connecting landed you on a database, which answers *what exists* —
 *  and nobody's first question on opening a tool pointed at their own server is
 *  what exists. They built it; they know. The question is whether anything in
 *  there is worth their afternoon, and until now the only way to find out was to
 *  already know which page to open.
 *
 *  ## This measures nothing and judges almost nothing
 *
 *  Every finding here is one `lib/checkup` already produces from a report the
 *  backend already serves, and every one of them is also on a page that owns it.
 *  That is the constraint the arrival is built under rather than an accident of
 *  reuse: a home that is the only place a fact appears is a home you cannot act
 *  from, because the control that acts on it lives somewhere you were never sent.
 *
 *  So what is here is **arrangement** — which of thirty true sentences goes
 *  first, how many of them fit before somebody stops reading, and what to say
 *  while the rest are still landing.
 *
 *  ## Why the order is not `rank`'s
 *
 *  `lib/checkup` ranks within an area, for a reader working through that area.
 *  This reader is meeting the server. Ranked by gain alone the list opens with
 *  eight storage rows — all true, all one insight repeated — and the failing
 *  materialized view is ninth. So failures lead, and then the opportunities are
 *  dealt round-robin across the four areas: the first five things somebody reads
 *  should be five different kinds of thing.
 */

import type { Area, Finding } from './checkup'
import { AREAS, rank } from './checkup'

/** One of the things the page is waiting on, and how it went.
 *
 *  `refused` carries its reason because that is the half that keeps the page
 *  honest on a server Flint is only half granted. A section that vanishes when
 *  a grant is missing teaches the reader that Flint has nothing to say about
 *  it; one that says *which* grant teaches them what to ask their DBA for. */
export interface Reading {
  /** What it was reading, as a person would say it: "the disks", "the query log". */
  label: string
  state: 'reading' | 'read' | 'refused'
  reason?: string
}

/** The findings, in the order a first reader should meet them.
 *
 *  Failures first — those are things that are already going wrong, and no
 *  amount of disk saved outranks a write that is not landing. Then one from
 *  each area in turn, so the top of the list is a tour of the server rather
 *  than the same insight eight times.
 *
 *  Capped, and the caller says how much was left out. A list silently truncated
 *  reads as the whole truth.
 */
export function inOrder(findings: Finding[], cap = 8): Finding[] {
  const ranked = rank(findings)
  const now = ranked.filter((f) => f.urgency === 'now')

  /* One queue per area, each already in the order its own page would use, so
     dealing from them cannot produce an order that page would disagree with. */
  const queues = new Map<Area, Finding[]>(
    AREAS.map((a) => [a.id, ranked.filter((f) => f.urgency !== 'now' && f.area === a.id)]),
  )

  const dealt: Finding[] = []
  while (dealt.length + now.length < cap) {
    /* One full pass that hands out nothing means every queue is empty. Checked
       by watching the round rather than by counting what is left, because the
       queues are being mutated as we go. */
    let handed = false
    for (const area of AREAS) {
      if (dealt.length + now.length >= cap) break
      const next = queues.get(area.id)?.shift()
      if (next) {
        dealt.push(next)
        handed = true
      }
    }
    if (!handed) break
  }

  return [...now, ...dealt]
}

/** The one sentence at the top: what this server's own state amounts to.
 *
 *  It is a *verdict*, not a count, and it speaks even when the answer is good —
 *  "nothing here is asking to be changed" is what somebody came for, and a
 *  heading that disappears when there is nothing wrong leaves them wondering
 *  whether anything ran.
 *
 *  While readings are still landing it says so instead of guessing, because a
 *  verdict that changes from "nothing wrong" to "three things are failing" four
 *  seconds after it is read is worse than one that waited.
 */
export function verdict(findings: Finding[], readings: Reading[]): string {
  const pending = readings.filter((r) => r.state === 'reading').length
  const now = findings.filter((f) => f.urgency === 'now').length
  const worth = findings.length - now

  if (now > 0) {
    return `${now === 1 ? 'One thing on this server is' : `${now} things on this server are`} going wrong now.`
  }
  if (worth > 0) {
    return `${worth === 1 ? 'One thing is' : `${worth} things are`} worth changing here.`
  }
  if (pending > 0) return 'Reading this server.'

  /* Nothing found — but "nothing is wrong" is only as wide as the readings
     behind it, and on a locked-down account most of them never happened. Found
     on ClickHouse's own demo server, where five of six readings are refused and
     the page cheerfully cleared a seven-terabyte machine it had barely looked
     at. The caption underneath already names which ones; the headline has to
     stop *claiming*, because the headline is the sentence people repeat.

     Half is the line, and it is a judgement rather than a measurement: below it
     the refusals are gaps in an answer, above it there is no answer to have
     gaps in. */
  const refused = readings.filter((r) => r.state === 'refused').length
  if (refused > readings.length / 2) {
    return 'Flint could not read enough of this server to say.'
  }
  return 'Nothing on this server is asking to be changed.'
}

/** What was read to reach that verdict, and what would not be read.
 *
 *  Both halves in one sentence, because they are one claim: a verdict is only
 *  as wide as the readings behind it, and "nothing is wrong" over four refused
 *  grants is a sentence that should be qualified where it is made and nowhere
 *  else.
 *
 *  Returns `null` when there is nothing to qualify — everything answered, and
 *  nothing is still in flight. A caption saying "read all six of six" is a line
 *  the reader has to parse in order to learn nothing.
 */
export function saysRead(readings: Reading[]): string | null {
  const reading = readings.filter((r) => r.state === 'reading')
  const refused = readings.filter((r) => r.state === 'refused')
  const parts: string[] = []

  if (reading.length > 0) {
    parts.push(
      reading.length === readings.length
        ? `Reading ${list(reading.map((r) => r.label))}.`
        : `Still reading ${list(reading.map((r) => r.label))}.`,
    )
  }
  if (refused.length > 0) {
    parts.push(
      `${cap(list(refused.map((r) => r.label)))} ${refused.length === 1 ? 'is' : 'are'} not readable as this account, so nothing here speaks for ${refused.length === 1 ? 'it' : 'them'}.`,
    )
  }
  return parts.length ? parts.join(' ') : null
}

/** `a`, `a and b`, `a, b and c`. The Oxford comma is deliberately absent: these
 *  are short noun phrases, and the list appears mid-sentence. */
function list(items: string[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
