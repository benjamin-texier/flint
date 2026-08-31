/** The cluster, as the interface reads it.
 *
 *  One rule runs through all of it: a single-node ClickHouse is a legitimate
 *  deployment, not a broken cluster. Every verdict here has to be sayable about a
 *  server that is alone and perfectly healthy, which is why "not in a cluster" is
 *  a *state* rather than an absence — and why nothing counts a shard of one as a
 *  problem. */

export interface Node {
  cluster: string
  shard_num: number
  replica_num: number
  host_name: string
  port: number
  is_local: boolean
  errors_count: number
  /** Seconds before the local server will try this endpoint again. */
  recovery_secs: number
  /** Null where the build does not report it: "we do not know", which is neither
   *  active nor inactive. */
  is_active: boolean | null
}

export interface Topology {
  available: boolean
  reason?: string
  nodes: Node[]
  single_node: boolean
}

export interface QueueEntry {
  database: string
  table: string
  kind: string
  created_time: string
  num_tries: number
  last_exception: string
  is_currently_executing: boolean
  postpone_reason: string
}

export interface QueueReport {
  available: boolean
  reason?: string
  entries: QueueEntry[]
  total: number
}

export interface DdlEntry {
  entry: string
  host: string
  query: string
  status: string
  exception_code: number
  exception_text: string
  query_create_time: string
}

export interface DdlReport {
  available: boolean
  reason?: string
  entries: DdlEntry[]
}

/** The shards of one cluster, each with its replicas, in configuration order. */
export interface Shard {
  shard: number
  replicas: Node[]
}

export interface Ring {
  cluster: string
  shards: Shard[]
  /** How many endpoints in the whole ring — the figure a reader checks against
   *  what they think they deployed. */
  nodes: number
}

/** Group the flat `system.clusters` rows into the rings they describe.
 *
 *  The table is one row per endpoint per cluster, and a server can be configured
 *  with several clusters that overlap — the same host appearing in three of them
 *  is normal. So the grouping is by cluster first and shard second, and nothing
 *  is deduplicated across clusters: two rings sharing a host are two rings. */
export function rings(nodes: Node[]): Ring[] {
  const byCluster = new Map<string, Map<number, Node[]>>()
  for (const node of nodes) {
    const shards = byCluster.get(node.cluster) ?? new Map<number, Node[]>()
    const replicas = shards.get(node.shard_num) ?? []
    replicas.push(node)
    shards.set(node.shard_num, replicas)
    byCluster.set(node.cluster, shards)
  }
  return [...byCluster.entries()].map(([cluster, shards]) => ({
    cluster,
    shards: [...shards.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([shard, replicas]) => ({
        shard,
        replicas: [...replicas].sort((a, b) => a.replica_num - b.replica_num),
      })),
    nodes: [...shards.values()].reduce((n, r) => n + r.length, 0),
  }))
}

/** A ring that is one endpoint, and that endpoint is this server.
 *
 *  Every ClickHouse ships a `default` cluster shaped exactly like this, and
 *  nobody deployed it. Drawn beside a real ring it reads as a second cluster,
 *  which is worse than not drawing it — so it is folded away and *counted*, the
 *  way the explorer folds internal tables. Not dropped silently: a list quietly
 *  shortened reads as the whole truth. */
export function selfOnly(ring: Ring): boolean {
  return ring.nodes === 1 && ring.shards.every((s) => s.replicas.every((r) => r.is_local))
}

/** What to say about one endpoint.
 *
 *  This used to read `errors_count`, on the reasoning that it was the only live
 *  signal `system.clusters` carries. Watched against a real failure — one replica
 *  of a two-replica shard stopped, and both a read and a write pushed at it — it
 *  stayed **zero** throughout, so the page was showing a column that never
 *  speaks. `estimated_recovery_time` is the one that moved: to 60, and then down
 *  by one a second.
 *
 *  Its name oversells it and the sentence here does not repeat the overselling.
 *  It is the local server's own back-off timer: measured counting down from 60
 *  to 9 *while the stopped replica was already running again*, because nothing
 *  checks — it simply will not try until the timer runs out. So the verdict says
 *  what is true, which is that this server is not sending anything there yet.
 */
export function nodeVerdict(node: Node): { says: string; level: 'ok' | 'watch' | 'bad' } | null {
  if (node.is_active === false) return { says: 'not active', level: 'bad' }
  if (node.recovery_secs > 0) {
    return {
      says: `not being tried for ${node.recovery_secs}s after a failure`,
      level: 'watch',
    }
  }
  // Kept for a build that populates it, and dropped where it says nothing.
  if (node.errors_count > 0) {
    return {
      says: `${node.errors_count} connection error${node.errors_count === 1 ? '' : 's'}`,
      level: 'watch',
    }
  }
  return null
}

/** An entry the replica has tried and failed at, more than once.
 *
 *  One failure is a retry, and retries are how replication works — flagging them
 *  would light the page up on a healthy cluster. Repeated failures with an
 *  exception are the thing worth a reader's attention. */
export function stuck(entry: QueueEntry): boolean {
  return entry.num_tries > 1 && entry.last_exception.trim().length > 0
}

/** Whether a distributed statement failed on any host it reached.
 *
 *  The failure mode this exists for: `Finished` on three nodes and an exception
 *  on the fourth. A status of `Finished` with a non-zero exception code is
 *  exactly that, and reading only the status would call it a success. */
export function ddlFailed(entry: DdlEntry): boolean {
  return entry.exception_code !== 0 || entry.exception_text.trim().length > 0
}

/** A host that has not picked the statement up yet.
 *
 *  Measured on a two-node ring with one node stopped: the row is `Inactive` with
 *  nulls in both exception columns. Nothing has gone wrong — the node is not
 *  there, and the statement is waiting for it. Reading that as a failure would
 *  put a red flag on a cluster whose only problem is a server being restarted;
 *  reading it as a success would be worse. */
export function ddlPending(entry: DdlEntry): boolean {
  return !ddlFailed(entry) && entry.status.trim().toLowerCase() !== 'finished'
}

/** One `ON CLUSTER` statement, with every host that ran it folded back in.
 *
 *  The ledger stores a row per host, and the reader's question is about the
 *  statement: "did this happen everywhere". Answering it from a table of host
 *  rows means scanning adjacent lines and counting, which works for two nodes
 *  and does not for twelve. */
export interface DdlStatement {
  entry: string
  query: string
  when: string
  hosts: DdlEntry[]
  failed: DdlEntry[]
  pending: DdlEntry[]
  /** Hosts where the statement actually ran. */
  ran: number
}

/** Fold the per-host ledger into one row per statement, newest first.
 *
 *  Order comes from the server — the rows arrive newest first — and is kept
 *  rather than recomputed, because `query_create_time` has one-second resolution
 *  and re-sorting on it would shuffle statements that share a second. */
export function foldDdl(entries: DdlEntry[]): DdlStatement[] {
  const by = new Map<string, DdlStatement>()
  for (const e of entries) {
    let s = by.get(e.entry)
    if (!s) {
      s = { entry: e.entry, query: e.query, when: e.query_create_time, hosts: [], failed: [], pending: [], ran: 0 }
      by.set(e.entry, s)
    }
    s.hosts.push(e)
    if (ddlFailed(e)) s.failed.push(e)
    else if (ddlPending(e)) s.pending.push(e)
    else s.ran += 1
  }
  return [...by.values()]
}

/** What happened to a statement, as a sentence about the whole ring.
 *
 *  "Ran on 3 of 4" is the finding; a row per host makes the reader assemble it.
 *  The two ways of not running are kept apart because the operator does
 *  different things about them: a failure needs the exception read, a node that
 *  has not picked the statement up needs the node back. */
export function saysDdl(s: DdlStatement): string {
  const n = s.hosts.length
  if (s.failed.length) {
    const who = s.failed.map((h) => h.host).join(', ')
    return `Ran on ${s.ran} of ${n} — failed on ${who}.`
  }
  if (s.pending.length) {
    const who = s.pending.map((h) => h.host).join(', ')
    return `Ran on ${s.ran} of ${n} — ${who} ${s.pending.length === 1 ? 'has' : 'have'} not picked it up yet.`
  }
  return n === 1 ? 'Ran on the one host in the ring.' : `Ran on all ${n} hosts.`
}

/** The statement as it was written, without the UUID the server put in it.
 *
 *  An `ON CLUSTER` statement is rewritten before it reaches the ledger: the
 *  initiator assigns the table's UUID so that every replica creates the same
 *  one, and stores the rewritten form. That is thirty-eight characters of
 *  machine bookkeeping in the middle of the column the reader is scanning, and
 *  it is the same shape on every row. The full text stays one hover away. */
export function withoutUuid(query: string): string {
  return query.replace(/\s+UUID\s+'[0-9a-fA-F-]{36}'/g, '')
}
