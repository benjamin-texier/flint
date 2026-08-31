/** What needs looking at.
 *
 *  Flint now watches things on your behalf — alerts, reports, endpoints — and
 *  none of that is worth much if you have to visit three pages to find out that
 *  one of them is unhappy. This is the summary, and it is deliberately narrow:
 *  only what is *wrong or stuck* counts. A count of things that are fine is a
 *  vanity number, and a badge that is always lit stops being read. */

import type { Alert } from './alert'
import type { Report } from './report'
import type { ApiUsage, UsageReport } from './diagnose'
import { verdictOf, type ReplicationReport } from './replication'

export type Concern = 'firing' | 'broken' | 'failed' | 'partial' | 'erroring'

export interface Item {
  concern: Concern
  /** What it is called. */
  name: string
  /** One line: what is wrong with it. */
  says: string
  /** Where to go about it. */
  to: string
}

/** Alerts that are firing, or that cannot run at all.
 *
 *  An alert that cannot run is listed beside one that is firing, not below it:
 *  "this condition is true" and "we have no idea whether this condition is
 *  true" are both things you need to know, and the second is easier to miss. */
/** Drop a leading copy of the name.
 *
 *  The scheduler writes messages as "<name> is firing: …" because they go to a
 *  webhook where nothing else says which alert it is. Here the name is already
 *  the link beside it, and repeating it reads like a stutter. */
export function withoutName(message: string, name: string): string {
  const trimmed = message.trim()
  return trimmed.toLowerCase().startsWith(`${name.toLowerCase()} `)
    ? trimmed.slice(name.length + 1)
    : trimmed
}

/** One clause, not a stack trace.
 *
 *  A ClickHouse exception carries the statement, the scope and the build
 *  version; pasted whole into a one-line summary it pushes everything else off
 *  the row. The detail belongs on the page the row links to. */
export function concise(message: string, cap = 96): string {
  const first = message.split(/(?<=\.)\s|\n/)[0] ?? message
  const line = first.trim()
  return line.length <= cap ? line : `${line.slice(0, cap - 1).trimEnd()}…`
}

/** The message without the invitation to paste a stack trace.
 *
 *  `concise` cuts at a sentence, which is right for an alert's own wording and
 *  wrong for a ClickHouse exception: the first sentence of one is "Code: 318."
 *  and the useful clause is the second. What actually needs removing is the
 *  preamble the server appends to every exception — ", Stack trace (when copying
 *  this message, always include the lines below):" — which arrives on the *same*
 *  line as the message and so survives a split on newlines.
 *
 *  Whole otherwise. A reader who wants the frames can hover; a reader who wants
 *  to know what went wrong should not have to read past a request to include
 *  lines they cannot see. */
export function withoutTrace(message: string): string {
  const line = message.split('\n')[0] ?? ''
  const at = line.indexOf(', Stack trace')
  return (at > 0 ? line.slice(0, at) : line).trim()
}

/** Where an unhappy alert sends the reader.
 *
 *  The same rule the lists use: an alert is found where its subject lives. It
 *  matters twice over here, because the badge on each space counts the items
 *  whose destination is in it — so an operator's firing alert sent to `/alerts`
 *  would raise a number on Data and then not be in the list it points at.
 *
 *  What cannot be placed goes to `/alerts`, which is where it can be edited and
 *  where it is listed alongside its own explanation. */
function alertGoesTo(alert: Alert): string {
  return alert.space === 'infra' ? '/infra/health' : '/alerts'
}

export function alertConcerns(alerts: Alert[] | undefined): Item[] {
  return (alerts ?? [])
    .filter((a) => a.enabled)
    .flatMap((a): Item[] => {
      if (a.state === 'firing') {
        return [
          {
            concern: 'firing',
            name: a.name,
            says: concise(withoutName(a.last_message, a.name)) || 'is firing',
            to: alertGoesTo(a),
          },
        ]
      }
      if (a.state === 'error') {
        return [
          {
            concern: 'broken',
            name: a.name,
            says: a.last_message
              ? concise(withoutName(a.last_message, a.name))
              : 'cannot run, so it is telling you nothing',
            to: alertGoesTo(a),
          },
        ]
      }
      return []
    })
}

export function reportConcerns(reports: Report[] | undefined): Item[] {
  return (reports ?? [])
    .filter((r) => r.enabled)
    .flatMap((r): Item[] => {
      if (r.last_status === 'failed') {
        return [{ concern: 'failed', name: r.name, says: 'its last edition failed', to: '/reports' }]
      }
      if (r.last_status === 'partial') {
        return [
          { concern: 'partial', name: r.name, says: 'its last edition ran with gaps', to: '/reports' },
        ]
      }
      return []
    })
}

/** Endpoints whose callers are getting errors.
 *
 *  Only where the log could be read: with `system.query_log` off there is
 *  nothing to say, and saying nothing is the honest version. */
export function endpointConcerns(usage: UsageReport | undefined): Item[] {
  if (!usage?.available) return []
  return usage.usage
    .filter((u: ApiUsage) => u.failures > 0)
    .map((u) => ({
      concern: 'erroring' as const,
      name: u.slug,
      says: `${u.failures} of ${u.calls} call${u.calls === 1 ? '' : 's'} failed`,
      to: '/apis',
    }))
}

/** Replicas that are not keeping up.
 *
 *  Listed here and not only on its own tab, because this is the failure somebody
 *  finds out about from a *different* system: the replica keeps serving reads, so
 *  the first symptom is an insert failing somewhere nobody is looking. */
export function replicaConcerns(report: ReplicationReport | undefined): Item[] {
  if (!report?.available) return []
  return report.replicas.flatMap((replica): Item[] => {
    const verdict = verdictOf(replica)
    if (verdict.health === 'keeping-up') return []
    return [
      {
        // Data lost and a read-only replica are somebody-act-now; falling behind
        // and a thin cluster are worth reading, not worth an alarm.
        concern: verdict.health === 'lost' || verdict.health === 'stuck' ? 'broken' : 'partial',
        name: `${replica.database}.${replica.table}`,
        says: concise(verdict.says),
        to: '/infra/cluster',
      },
    ]
  })
}

export function concerns(sources: {
  alerts?: Alert[]
  reports?: Report[]
  usage?: UsageReport
  replication?: ReplicationReport
}): Item[] {
  return [
    ...alertConcerns(sources.alerts),
    ...reportConcerns(sources.reports),
    ...endpointConcerns(sources.usage),
    ...replicaConcerns(sources.replication),
  ]
}

/** How many concerns point at a given page, for a badge beside its name.
 *  Zero means no badge: an indicator that is always lit is not an indicator. */
export function countFor(items: Item[], to: string): number {
  return items.filter((i) => i.to === to).length
}

/** One line for the whole picture. Null when there is nothing to say, which is
 *  the common case and should not be dressed up as good news everywhere. */
export function summarise(items: Item[]): string | null {
  if (!items.length) return null
  const firing = items.filter((i) => i.concern === 'firing').length
  const broken = items.filter((i) => i.concern === 'broken').length
  const rest = items.length - firing - broken
  const parts: string[] = []
  if (firing) parts.push(`${firing} alert${firing === 1 ? '' : 's'} firing`)
  if (broken) parts.push(`${broken} that cannot run`)
  if (rest) parts.push(`${rest} other thing${rest === 1 ? '' : 's'} to look at`)
  return parts.join(', ')
}
