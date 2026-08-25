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
