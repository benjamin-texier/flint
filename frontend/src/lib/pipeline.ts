/** Are the materialized views flowing?
 *
 *  ClickHouse answers in three places and the verdict has to combine them,
 *  because the most common breakage is invisible in the one that looks
 *  authoritative: drop a view's target table and the *insert* fails before the
 *  view runs, so its execution log stays clean while the pipeline is dead. */

export interface View {
  database: string
  name: string
  target: string
  target_exists: boolean
  refreshable: boolean
  definition: string
  target_rows: number
  target_bytes: number
  last_write: string
  runs: number
  failures: number
  written_rows: number
  avg_ms: number
  last_run: string
  last_error: string
  refresh_status: string
  last_refresh: string
  last_success: string
  next_refresh: string
  refresh_exception: string
  retry: number
  progress: number
}

export interface PipelineReport {
  views: View[]
  window_days: number
  log_available: boolean
  log_reason?: string
  refreshes_available: boolean
}

export type Health = 'broken' | 'flowing' | 'idle' | 'unknown'

export interface Verdict {
  health: Health
  /** One sentence: what is true, and what it means. */
  says: string
}

export const HEALTH_LABEL: Record<Health, string> = {
  broken: 'Broken',
  flowing: 'Flowing',
  idle: 'Idle',
  unknown: 'Unknown',
}

/** The verdict for one view.
 *
 *  Order matters: a structural break outranks a clean log, because the log is
 *  clean *because* nothing ran. `unknown` is its own answer rather than being
 *  folded into `idle` — "nothing has happened" and "we cannot see what happened"
 *  send a reader to different places. */
export function verdictOf(view: View, logAvailable: boolean): Verdict {
  if (view.target && !view.target_exists) {
    return {
      health: 'broken',
      says: `its target ${view.target} does not exist, so every insert into its source fails — and nothing appears in the view log, because the view never runs`,
    }
  }
  if (view.refreshable) {
    if (view.refresh_exception) {
      return { health: 'broken', says: `its last refresh failed: ${view.refresh_exception}` }
    }
    if (view.retry > 0) {
      return {
        health: 'broken',
        says: `it is retrying — ${view.retry} attempt${view.retry === 1 ? '' : 's'} so far`,
      }
    }
    if (!view.last_success || view.last_success.startsWith('1970')) {
      return { health: 'idle', says: 'it has not completed a refresh yet' }
    }
    return { health: 'flowing', says: `refreshing on its own schedule (${view.refresh_status})` }
  }
  if (view.failures > 0) {
    return {
      health: 'broken',
      says: `${view.failures} of its ${view.runs} run${view.runs === 1 ? '' : 's'} failed`,
    }
  }
  /* Why the log is unreadable belongs to the *page*, not to every card on it.
     Both surfaces that draw these already say it once — Pipelines prints the
     server's own `log_reason` above the list, and the diagram's legend counts
     "N cannot be seen: without system.query_views_log …" — and this sentence
     used to name the table a third time, on each affected view. On a server
     with the log off that is every classic view: thirty identical rows of 118
     characters, about 2,600px of a 9,251px page spent restating one fact, and
     the one card that had something *different* to say (a view whose target
     Flint could not read out of its definition) was buried among them.

     So the card keeps the half that is about this view — its target exists,
     which is what separates it from `broken` — and points at the reason rather
     than reprinting it. The pill above it already reads "Unknown". */
  if (!logAvailable) {
    return { health: 'unknown', says: 'its target is there; nothing beyond that can be seen' }
  }
  if (view.runs === 0) {
    return {
      health: 'idle',
      says: 'nothing has been inserted into its source in this window, so it has had nothing to do',
    }
  }
  return {
    health: 'flowing',
    says: `${view.runs} run${view.runs === 1 ? '' : 's'}, no failures`,
  }
}

/** How to make it run now, in the reader's terms.
 *
 *  Two entirely different answers, and conflating them is how people
 *  double-count data. A refreshable view can simply be told to run. A classic
 *  one is a trigger: there is nothing to trigger, and the only way to fill a
 *  gap is to insert the missing rows yourself — which is safe exactly once. */
export type Forcing =
  | { kind: 'refresh' }
  | { kind: 'backfill'; statement: string }
  | { kind: 'none'; why: string }

export function forcingFor(view: View): Forcing {
  if (view.refreshable) return { kind: 'refresh' }
  if (!view.target) {
    return {
      kind: 'none',
      why: 'Flint could not read this view’s target out of its definition, so it cannot write the backfill for you.',
    }
  }
  if (!view.definition.trim()) {
    return {
      kind: 'none',
      why: 'this server did not report the view’s SELECT, so there is nothing to build a backfill from.',
    }
  }
  return { kind: 'backfill', statement: `INSERT INTO ${view.target}\n${view.definition.trim()}` }
}

/** Counts for the header, and only of what is wrong. */
export function summarise(report: PipelineReport | undefined): string | null {
  if (!report?.views.length) return null
  const broken = report.views.filter((v) => verdictOf(v, report.log_available).health === 'broken')
  if (!broken.length) return null
  return `${broken.length} of ${report.views.length} not flowing`
}
