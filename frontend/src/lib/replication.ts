/** Whether the replicas are keeping up.
 *
 *  The figures that matter here are not the obvious ones. A replica that has
 *  lost its Keeper session goes **read-only**: it keeps serving reads, so
 *  nothing looks wrong until an insert fails — which is why that state outranks
 *  every delay. `lost_part_count` above zero means data is gone, not late. And
 *  the queue moves before the delay does, so a growing queue is the early
 *  warning that a rising `absolute_delay` only confirms. */

export interface Replica {
  database: string
  table: string
  engine: string
  is_leader: boolean
  is_readonly: boolean
  session_expired: boolean
  absolute_delay: number
  readonly_for: number
  queue_size: number
  inserts_in_queue: number
  merges_in_queue: number
  behind_log: number
  total_replicas: number
  active_replicas: number
  lost_parts: number
  oldest_queued: string
  queue_exception: string
  zookeeper_exception: string
}

export interface ReplicationReport {
  available: boolean
  reason?: string
  replicas: Replica[]
}

export type Health = 'lost' | 'stuck' | 'behind' | 'thin' | 'keeping-up'

export interface Verdict {
  health: Health
  says: string
}

export const HEALTH_LABEL: Record<Health, string> = {
  lost: 'Data lost',
  stuck: 'Read-only',
  behind: 'Behind',
  thin: 'A replica is missing',
  'keeping-up': 'Keeping up',
}

/** Seconds behind before it is worth saying so. Replication lag of a few
 *  seconds is normal operation, not news. */
export const LAG_SECONDS = 30

function forDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86_400)}d`
}

/** How far behind, or null if the figure cannot be trusted.
 *
 *  `absolute_delay` is measured against Keeper. A replica that cannot reach
 *  Keeper still reports one — and it comes back as the seconds since the epoch,
 *  because the comparison has nothing on the other side. Observed live: a replica
 *  five minutes into a broken Keeper connection announced 1787650776 seconds,
 *  which is fifty-six years. That is not a delay, it is an absence of an answer. */
export function delayOf(replica: Replica): number | null {
  return replica.session_expired ? null : replica.absolute_delay
}

/** How many replicas are up, or null if this node cannot see the others.
 *
 *  Same reason: the counts come from Keeper. With no session they read 0 of 0,
 *  which would render as "0/0 up" — a sentence that looks like a fact. */
export function clusterOf(replica: Replica): { active: number; total: number } | null {
  if (replica.session_expired || replica.total_replicas === 0) return null
  return { active: replica.active_replicas, total: replica.total_replicas }
}

/** Ordered by what a reader must act on first, not by how bad it sounds. */
export function verdictOf(replica: Replica): Verdict {
  if (replica.lost_parts > 0) {
    return {
      health: 'lost',
      says: `${replica.lost_parts} part${replica.lost_parts === 1 ? '' : 's'} could not be recovered — that is data gone, not data late`,
    }
  }
  if (replica.is_readonly || replica.session_expired) {
    const how = replica.zookeeper_exception
      ? `: ${replica.zookeeper_exception}`
      : replica.session_expired
        ? ' — its Keeper session expired'
        : ''
    const since = replica.readonly_for > 0 ? ` for ${forDuration(replica.readonly_for)}` : ''
    return {
      health: 'stuck',
      // The state that hides: reads keep working, so nothing looks wrong until
      // somebody tries to write.
      says: `read-only${since}${how}. It still answers reads, so this shows up as a failing insert rather than a failing query`,
    }
  }
  const delay = delayOf(replica)
  if ((delay !== null && delay >= LAG_SECONDS) || replica.behind_log > 0) {
    const parts: string[] = []
    if (delay !== null && delay >= LAG_SECONDS) {
      parts.push(`${forDuration(delay)} behind`)
    }
    if (replica.behind_log > 0) {
      parts.push(`${replica.behind_log} log ${replica.behind_log === 1 ? 'entry' : 'entries'} to apply`)
    }
    if (replica.queue_size > 0) parts.push(`${replica.queue_size} in its queue`)
    return { health: 'behind', says: parts.join(', ') }
  }
  const cluster = clusterOf(replica)
  if (cluster && cluster.active < cluster.total) {
    const missing = cluster.total - cluster.active
    return {
      health: 'thin',
      says: `${cluster.active} of ${cluster.total} replicas are up — ${missing} ${missing === 1 ? 'is' : 'are'} not answering, so there is less redundancy than the table asks for`,
    }
  }
  return {
    health: 'keeping-up',
    says:
      cluster && cluster.total > 1
        ? `caught up, ${cluster.active} of ${cluster.total} replicas up`
        : 'caught up',
  }
}

/** Worst first. On a cluster with a hundred replicas, the one that is read-only
 *  must not be on page three. */
const RANK: Record<Health, number> = {
  lost: 0,
  stuck: 1,
  behind: 2,
  thin: 3,
  'keeping-up': 4,
}

export function worstFirst(replicas: Replica[]): Replica[] {
  return [...replicas].sort((a, b) => {
    const byHealth = RANK[verdictOf(a).health] - RANK[verdictOf(b).health]
    if (byHealth !== 0) return byHealth
    return `${a.database}.${a.table}`.localeCompare(`${b.database}.${b.table}`)
  })
}

/** The header line: only what is wrong. */
export function summarise(report: ReplicationReport | undefined): string | null {
  if (!report?.available || report.replicas.length === 0) return null
  const bad = report.replicas.filter((r) => verdictOf(r).health !== 'keeping-up')
  if (bad.length === 0) return null
  return `${bad.length} of ${report.replicas.length} not keeping up`
}

/** Whether this server has replication at all. A single-node deployment should
 *  not be offered a tab that can only ever be empty. */
export function hasReplication(report: ReplicationReport | undefined): boolean {
  return Boolean(report?.available && report.replicas.length > 0)
}
