/** The Keeper this server talks to, as the wire describes it.
 *
 *  In `lib/` rather than beside the component, which is where every other type
 *  on this side lives — and where it has to be: `api.ts` names this report, and
 *  a type declared in a component that imports `api` puts the two in a cycle.
 *  That cycle rendered the whole Clusters page blank, with nothing in the
 *  console to say why.
 */

export interface Session {
  name: string
  host: string
  port: number
  uptime_secs: number
  expired: boolean
  session_timeout_ms: number
}

export interface KeeperNode {
  host: string
  port: number
  connected: boolean
  readonly: boolean
  version: string
  state: string
  avg_latency: number
  max_latency: number
  followers: number
  synced_followers: number
  pending_syncs: number
  znodes: number
  watches: number
  ephemerals: number
}

export interface KeeperEvent {
  at: string
  kind: string
  host: string
  reason: string
}

export interface KeeperReport {
  session?: Session
  nodes: { items: KeeperNode[]; blocked?: string }
  history: { items: KeeperEvent[]; blocked?: string }
  absent?: string
  verdicts: string[]
}
