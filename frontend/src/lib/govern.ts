/** Writing quotas, settings profiles and row policies.
 *
 *  The statements are built in the backend, and for reasons this file does not
 *  restate: a quota's intervals need a comma the grammar does not insist on, and
 *  a row policy with no `TO` is accepted and does nothing. What is here is what
 *  the form needs to know before it sends anything.
 */

/** The things a quota can cap, as both the `MAX` clause and
 *  `system.quota_limits` spell them. One vocabulary for the read and the write.
 */
export const DIMENSIONS = [
  'queries',
  'query_selects',
  'query_inserts',
  'errors',
  'result_rows',
  'result_bytes',
  'read_rows',
  'read_bytes',
  'written_bytes',
  'failed_sequential_authentications',
  'queries_per_normalized_hash',
] as const

/** What a quota may be keyed by. Empty means one set of counters shared by
 *  everyone it applies to — "sixty queries between you" rather than each. */
export const KEYS = [
  'user_name',
  'ip_address',
  'client_key',
  'client_key_or_user_name',
  'client_key_or_ip_address',
  'forwarded_ip_address',
] as const

/** A window somebody typed, in seconds — or null when it is not a window.
 *
 *  Accepts the units a person writes, because "1h" is what somebody means and
 *  `3600` is what the statement needs. Zero and a bare unit are refused rather
 *  than becoming a window of nothing.
 */
export function seconds(text: string): number | null {
  const m = text.trim().toLowerCase().match(/^(\d+)\s*(s|sec|secs|m|min|mins|h|hour|hours|d|day|days)?$/)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  const unit = m[2] ?? 's'
  const per = unit.startsWith('d') ? 86400 : unit.startsWith('h') ? 3600 : unit.startsWith('m') ? 60 : 1
  return n * per
}

/** The accounts a comma-separated field names, with the blanks dropped. */
export function accounts(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Why a policy form is not ready to send, or null when it is.
 *
 *  The `TO` is required here as well as in the backend, so the button can be
 *  disabled with the reason rather than the request refused after the fact —
 *  and the reason is the measured one: a policy naming nobody does nothing.
 */
export function policyProblem(values: {
  name: string
  database: string
  table: string
  filter: string
  to: string
}): string | null {
  if (!values.name.trim()) return 'a name is required'
  if (!values.database.trim() || !values.table.trim()) return 'a database and a table are required'
  if (!values.filter.trim()) {
    return 'a USING expression is required — one with none lets every row through'
  }
  if (!accounts(values.to).length) {
    return 'name the accounts it applies to: one that names nobody is accepted by ClickHouse and does nothing'
  }
  return null
}

/** Turn a window in seconds back into the shortest thing a person would type.
 *
 *  The form's own input accepts `1h`, and pre-filling it with `3600` would have
 *  somebody edit a number they did not write. Exact divisors only — 90 minutes
 *  stays `5400s` rather than becoming a lie about hours.
 */
export function asWindow(seconds: number): string {
  if (seconds > 0 && seconds % 86400 === 0) return `${seconds / 86400}d`
  if (seconds > 0 && seconds % 3600 === 0) return `${seconds / 3600}h`
  if (seconds > 0 && seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}
