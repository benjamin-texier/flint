/** Alerts, as the UI sees them.
 *
 *  The condition mirrors the backend's closed grammar exactly — two things to
 *  measure, six ways to compare — because an alert you cannot read back is an
 *  alert nobody trusts. Everything here is about turning that triple into a
 *  sentence a person can check at a glance. */

export type Metric = 'rows' | 'value'
export type Op = '>' | '>=' | '<' | '<=' | '==' | '!='

export interface Condition {
  metric: Metric
  op: Op
  threshold: number
}

export interface Alert {
  id: string
  name: string
  sql: string
  database: string
  condition: string
  interval_seconds: number
  webhook: string
  enabled: boolean
  created_at: string
  updated_at: string
  /** Empty until the alert has been evaluated at least once with something to
   *  report. A brand-new alert that is fine has no state, which is the truth. */
  state: string
  last_event: string
  last_message: string
  last_delivered: boolean
  last_delivery_error: string
  /** Which space lists this alert: `data`, `infra`, or `unplaceable`. Decided
   *  by what the SQL reads, asked of the server each time the list is built. */
  space: string
  /** Why it is placed where it is, or why it could not be. */
  space_note: string
}

export interface AlertEvent {
  alert_id: string
  alert: string
  at: string
  state: string
  value: number | null
  message: string
  delivered: boolean
  delivery_error: string
}

export const OPS: Op[] = ['>', '>=', '<', '<=', '==', '!=']

/** The intervals worth offering. Below a minute an alert is a load test, and
 *  the scheduler's own tick is ten seconds anyway. */
export const INTERVALS = [60, 300, 900, 3600, 21_600, 86_400] as const

export function describeInterval(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`
  if (seconds < 3600) {
    const m = Math.round(seconds / 60)
    return m === 1 ? 'minute' : `${m} minutes`
  }
  if (seconds < 86_400) {
    const h = Math.round(seconds / 3600)
    return h === 1 ? 'hour' : `${h} hours`
  }
  const d = Math.round(seconds / 86_400)
  return d === 1 ? 'day' : `${d} days`
}

const SUBJECT: Record<Metric, string> = {
  rows: 'the number of rows',
  value: 'the first value',
}

export function describeCondition(c: Condition): string {
  return `${SUBJECT[c.metric]} ${c.op} ${trim(c.threshold)}`
}

/** The whole alert as one sentence, which is the only reliable way to catch a
 *  condition that says the opposite of what was meant. */
export function describeAlert(c: Condition, intervalSeconds: number): string {
  return `Every ${describeInterval(intervalSeconds)}, run this and notify when ${describeCondition(c)}.`
}

function trim(v: number): string {
  return Number.isInteger(v) ? String(v) : String(v)
}

export function serialiseCondition(c: Condition): string {
  return JSON.stringify({ metric: c.metric, op: c.op, threshold: c.threshold })
}

/** Null rather than a default when the stored condition cannot be read: an
 *  alert whose condition silently became "never fires" is one that lies about
 *  being armed, so the UI has to be able to say it is broken. */
export function parseCondition(raw: string): Condition | null {
  try {
    const d = JSON.parse(raw) as Partial<Condition>
    if (d.metric !== 'rows' && d.metric !== 'value') return null
    if (!d.op || !OPS.includes(d.op)) return null
    if (typeof d.threshold !== 'number' || !Number.isFinite(d.threshold)) return null
    return { metric: d.metric, op: d.op, threshold: d.threshold }
  } catch {
    return null
  }
}

export type Tone = 'firing' | 'error' | 'ok' | 'idle'

/** `idle` is not a state the backend sends — it is the absence of one, which
 *  the list has to render as "nothing to report yet" rather than as healthy. */
export function toneOf(state: string): Tone {
  if (state === 'firing') return 'firing'
  if (state === 'error') return 'error'
  if (state === 'ok') return 'ok'
  return 'idle'
}

export const TONE_LABEL: Record<Tone, string> = {
  firing: 'Firing',
  error: 'Cannot run',
  ok: 'Recovered',
  idle: 'Nothing yet',
}

/** The states the rail counts, in the order it lists them.
 *
 *  `paused` is not a tone: an alert with `enabled: false` has whatever state it
 *  last had, and "firing but not being evaluated" is a thing somebody needs to
 *  see as *paused* rather than as firing. So it is checked first and wins. */
export type Standing = 'firing' | 'error' | 'paused' | 'ok' | 'idle'

export const STANDINGS: Standing[] = ['firing', 'error', 'paused', 'ok', 'idle']

export const STANDING_LABEL: Record<Standing, string> = {
  firing: 'Firing',
  error: 'Cannot run',
  paused: 'Paused',
  ok: 'Recovered',
  idle: 'Nothing yet',
}

/** The same five, as the predicate of a sentence rather than as a chip. A page
 *  stating what its filter held back reads "the 2 of 5 that cannot run", which
 *  the noun form cannot supply. */
export const STANDING_SAYS: Record<Standing, string> = {
  firing: 'are firing',
  error: 'cannot run',
  paused: 'are paused',
  ok: 'have recovered',
  idle: 'have not run yet',
}

export function standingOf(alert: Alert): Standing {
  if (!alert.enabled) return 'paused'
  return toneOf(alert.state)
}

export function counts(alerts: readonly Alert[]): Record<Standing, number> {
  const out: Record<Standing, number> = { firing: 0, error: 0, paused: 0, ok: 0, idle: 0 }
  for (const a of alerts) out[standingOf(a)] += 1
  return out
}

/** Where the notifications go, and whether the last one arrived.
 *
 *  Grouped by host rather than by full URL: a token in a query string is not
 *  something to print in a rail, and three alerts pointing at one Slack channel
 *  are one destination to a reader.
 *
 *  An alert with no webhook is a destination too — its own history — because
 *  "this one tells nobody" is the fact somebody most needs to see in a list of
 *  where things go. */
export interface Destination {
  label: string
  alerts: number
  /** The last delivery that failed, where one did. Nothing here means either
   *  every delivery arrived or none has been attempted, and those are told
   *  apart by `tried`. */
  failing: string | null
  tried: boolean
}

export function destinations(alerts: readonly Alert[]): Destination[] {
  const by = new Map<string, Destination>()
  for (const alert of alerts) {
    const url = alert.webhook.trim()
    let label = 'history only'
    if (url) {
      try {
        label = new URL(url).host
      } catch {
        // Not a URL Flint can parse is still a destination somebody typed, and
        // showing it verbatim is better than dropping the row.
        label = url.slice(0, 40)
      }
    }
    const at = by.get(label) ?? { label, alerts: 0, failing: null, tried: false }
    at.alerts += 1
    if (url && alert.last_event) {
      at.tried = true
      if (!alert.last_delivered) {
        at.failing = alert.last_delivery_error || 'no reason recorded'
      }
    }
    by.set(label, at)
  }
  // Failing destinations first: the point of the list is the one that is not
  // getting through.
  return [...by.values()].sort(
    (l, r) => Number(Boolean(r.failing)) - Number(Boolean(l.failing)) || r.alerts - l.alerts,
  )
}

/** What the UI must say about where this alert's notifications went.
 *
 *  The failed case comes first because it is the one that matters: an alerting
 *  tool that rounds "we tried and could not reach anyone" to silence is worse
 *  than one with no delivery at all. */
export function deliveryNote(alert: Alert, webhooksAllowed: boolean): string | null {
  if (alert.webhook.trim() && alert.last_event && !alert.last_delivered) {
    return `The last notification did not get through: ${
      alert.last_delivery_error || 'no reason recorded'
    }`
  }
  if (!alert.webhook.trim()) {
    return 'No webhook: this alert only writes to its own history.'
  }
  if (!webhooksAllowed) {
    return 'Webhook delivery is switched off on this Flint, so this will be recorded but not sent.'
  }
  return null
}

/** The intervals to offer, including one the alert already has that is not on
 *  the list. An edit form that silently rounds a field it was not asked to
 *  change is a form that edits things behind your back. */
export function intervalChoices(current: number): number[] {
  const all = new Set<number>(INTERVALS)
  all.add(current)
  return [...all].sort((a, b) => a - b)
}

/** Whether the form describes something the backend will accept. Checked here
 *  so the reason appears beside the field rather than as a 400. */
export function problemWith(input: {
  name: string
  sql: string
  threshold: string
}): string | null {
  if (!input.name.trim()) return 'Give the alert a name.'
  if (!input.sql.trim()) return 'An alert needs a statement to run.'
  const n = Number(input.threshold)
  if (input.threshold.trim() === '' || !Number.isFinite(n)) {
    return 'The threshold has to be a number.'
  }
  return null
}

/** The alerts one space lists, and the count it is leaving to the other.
 *
 *  The rule is the one the two spaces are built on: an alert is listed where
 *  its *subject* lives, not where its author sits. An operator watching
 *  `system.replicas` and an analyst watching `orders` should each find their own
 *  without walking through the other's page.
 *
 *  An alert nobody can place appears in both, marked. Dropping it from both
 *  would make an alert that is switched on invisible everywhere, which is worse
 *  than showing it twice — and showing it twice is the honest shape of not
 *  knowing. */
export function inSpace(alerts: Alert[], space: 'data' | 'infra'): Alert[] {
  return alerts.filter((a) => a.space === space || a.space === 'unplaceable')
}

/** What this list is not showing, in the words of the space that has them.
 *
 *  A list silently holding back half its rows reads as the whole truth, and an
 *  alert nobody can find is an alert nobody trusts. */
export function saysElsewhere(alerts: Alert[], space: 'data' | 'infra'): string | null {
  const other = space === 'data' ? 'infra' : 'data'
  const n = alerts.filter((a) => a.space === other).length
  if (!n) return null
  const where = other === 'infra' ? 'Infrastructure, beside what they watch' : 'Data, beside the tables they watch'
  return `${n} more ${n === 1 ? 'alert is' : 'alerts are'} listed under ${where}.`
}

/** The list a page should draw, given what its rail has selected.
 *
 *  Beside `counts` deliberately: one of them saying "2 firing" while the other
 *  shows three is the failure this pairing exists to prevent, and they can only
 *  be held to each other if they are written against the same rule in the same
 *  place. An unknown state selects nothing rather than everything — a link to a
 *  standing that no longer exists should come up empty and say so, not quietly
 *  hand back the whole list as though it had been honoured. */
export function selected<T extends { enabled: boolean; state: string }>(
  list: readonly T[],
  state: string | null,
): readonly T[] {
  if (!state) return list
  return list.filter((a) => standingOf(a as never) === state)
}
