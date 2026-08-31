/** The trail, as the wire sends it, and the two facts a page has to derive.
 *
 *  Both are here rather than in the component for the usual reason: they are
 *  decisions about what a reader is told, and a decision buried in JSX is one
 *  nobody can test and nobody finds again. */

export type AuditKind = 'operation' | 'endpoint' | 'dataset'

/** How something ended, in the three answers there are.
 *
 *  Not a boolean, and the reason is worth keeping: a job has four states and
 *  only one is `done`, so under a boolean everything else read as a failure and
 *  the page painted a job that was still running as a refusal. */
export type AuditOutcome = 'ok' | 'failed' | 'unfinished'

export interface AuditEntry {
  at: string
  who: string
  kind: AuditKind
  what: string
  outcome: AuditOutcome
  detail?: string
  tier?: string
  duration_ms?: number
  read_rows?: number
}

export interface AuditReport {
  days: number
  entries: AuditEntry[]
  /** Why the calls and reads are missing, where they are. */
  calls_unavailable?: string
  /** Why the operations are. Separate, because the two halves fail for
   *  different reasons and one message would hide whichever still worked. */
  operations_unavailable?: string
  note?: string
}

/** What each kind is called on the page.
 *
 *  Not the wire's word: `operation` is what the record is, and "ran" is what a
 *  person did. An audit is read by somebody reconstructing actions, so the
 *  column reads as actions. */
export const KIND_LABEL: Record<AuditKind, string> = {
  operation: 'ran',
  endpoint: 'called',
  dataset: 'read',
}

/** What to say about how something ended, where anything needs saying at all.
 *
 *  Nothing for the ones that worked: a trail where every line carries a badge
 *  is a trail where the badges stop being read, and the two worth seeing are
 *  the ones that did not. */
export function outcomeNote(outcome: AuditOutcome): { label: string; tone: string } | null {
  switch (outcome) {
    case 'ok':
      return null
    case 'failed':
      return { label: 'refused', tone: 'flag flag--error' }
    case 'unfinished':
      // Deliberately not "failed". A running job may yet succeed, and an
      // interrupted one very often already did — on a server that carried on
      // after Flint stopped watching it.
      return { label: 'unfinished', tone: 'flag flag--idle' }
  }
}

/** Who did it, and what it ran as — which are not always the same account.
 *
 *  A dataset read and an operation are done *by* somebody: they signed in, and
 *  ClickHouse knows their name. A published endpoint is not. Whoever called it
 *  held a token, and Flint ran the statement under its own account — so the
 *  name in the log is what it ran *as*, and printing it in a column headed
 *  "Who" says a named person made a call they may never have heard of.
 *
 *  That is the one misstatement an audit cannot afford, so the two facts are
 *  kept apart here rather than collapsed into the one the log happens to
 *  carry. */
export function actorOf(entry: AuditEntry): { who: string; ranAs?: string } {
  if (entry.kind !== 'endpoint') return { who: entry.who }
  return { who: 'token holder', ranAs: entry.who }
}

/** The line under the title: what this trail holds, and what it does not.
 *
 *  Said on the page rather than in the documentation, because the question it
 *  answers — "is my colleague's query missing because they did not run one, or
 *  because this does not show them?" — is asked while looking at the page. A
 *  trail that leaves that to be inferred is a trail nobody should trust.
 */
export function scopeSentence(report: AuditReport | undefined): string {
  const holds =
    'Operations Flint ran, calls on a published endpoint, and reads of a dataset — each with who asked and what the server said.'
  const misses =
    'Statements typed into the editor are not here: they carry no mark of Flint’s, so this cannot tell one from the same person’s clickhouse-client. The History page shows those. And a call on a published endpoint is made by whoever holds its token — the account beside it is what the statement ran as, not who asked for it.'
  if (!report) return holds
  return `${holds} ${misses}`
}

/** Why a half of the trail is missing, as one sentence per half.
 *
 *  Returned as a list rather than joined, so a page can show two and a reader
 *  can tell they are two problems — a grant on `system.query_log` and a missing
 *  workspace are fixed in different places. */
export function obstacles(report: AuditReport | undefined): string[] {
  if (!report) return []
  return [
    report.calls_unavailable && `Calls and reads: ${report.calls_unavailable}`,
    report.operations_unavailable && `Operations: ${report.operations_unavailable}`,
  ].filter((s): s is string => Boolean(s))
}

/** Whether the trail is empty *because nothing happened*, rather than because
 *  neither half could be read — which look identical and mean the opposite. */
export function quiet(report: AuditReport | undefined): boolean {
  return Boolean(report && report.entries.length === 0 && obstacles(report).length === 0)
}
