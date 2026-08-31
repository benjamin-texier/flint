/** Long operations, as the interface reads them.
 *
 *  A job is a row, not a spinner: it starts, it ends, and between those two the
 *  only honest thing to say is how long it has been going. Everything here is
 *  about saying that without inventing anything — no progress percentage, because
 *  ClickHouse does not report one for a merge, and a bar that fills at a made-up
 *  rate is worse than no bar. */

export interface Job {
  id: string
  /** `optimize` today; the kinds grow with the roadmap. */
  kind: string
  label: string
  target: string
  submitted_by: string
  tier: string
  state: JobState
  /** The outcome in a sentence, or the error. Empty while it runs. */
  detail: string
  started_at: string
  started_ms: number
  /** Empty while it has not finished — the backend drops the epoch rather than
   *  sending a date from before ClickHouse existed. */
  finished_at: string
}

export interface JobReport {
  available: boolean
  reason?: string
  jobs: Job[]
}

export type JobState = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'

/** Which space a kind of job belongs to.
 *
 *  A job is a mechanism, not a place — but the *list* of them has to live
 *  somewhere, and the rule is the one the roadmap set for alerts: it follows what
 *  the job does, not who submitted it. An `OPTIMIZE` rewrites storage, so it is
 *  Infrastructure; an edition of a report is somebody's data question answered on
 *  a schedule, so it is Data. An unknown kind is Infrastructure, because a Flint
 *  newer than this browser is more likely to have added an operation than a
 *  report. */
export function spaceOfKind(kind: string): 'data' | 'infra' {
  return kind === 'report' ? 'data' : 'infra'
}

/** Whether the server can be asked to stop this kind at all.
 *
 *  Mirrors `jobs::cancellable` in the backend, which refuses the same set: a
 *  single tagged statement can be killed by id, a sequence of them cannot. Drawn
 *  from the kind rather than from the state, then combined with it — a stop
 *  button that does nothing is worse than no button. */
export function killable(kind: string): boolean {
  return kind === 'optimize'
}

/** How each state reads, and how loudly.
 *
 *  `interrupted` is deliberately not an error: nothing went wrong with the work,
 *  Flint simply stopped watching it. Telling somebody their optimize *failed*
 *  when the server most likely finished it would send them to run it again. */
const SAYS: Record<JobState, { label: string; level: 'busy' | 'ok' | 'watch' | 'bad' }> = {
  running: { label: 'running', level: 'busy' },
  done: { label: 'done', level: 'ok' },
  cancelled: { label: 'stopped', level: 'watch' },
  interrupted: { label: 'interrupted', level: 'watch' },
  failed: { label: 'failed', level: 'bad' },
}

export function says(state: string): { label: string; level: 'busy' | 'ok' | 'watch' | 'bad' } {
  return SAYS[state as JobState] ?? { label: state, level: 'watch' }
}

/** Only a running job of a kind the server can find by id can be stopped. */
export function stoppable(job: Job): boolean {
  return job.state === 'running' && killable(job.kind)
}

/** How long a job has been going, or how long it took — or nothing.
 *
 *  Null is a real answer here, and the case that produced it is `interrupted`: a
 *  job Flint stopped watching has no known end, so measuring it against *now*
 *  gives a figure that grows for ever. It read "9 min" and then "10 min" for an
 *  operation that had almost certainly finished in a second, which is the kind of
 *  number that quietly discredits every other number on the page. An absent
 *  figure is dropped, not counted.
 *
 *  Milliseconds from the server's clock for the start, and the browser's for
 *  "now" — the one place the two meet. A skewed browser could make a job look as
 *  though it started in the future; that is clamped to zero rather than printed
 *  as negative. */
export function elapsedMs(job: Job, nowMs: number): number | null {
  if (job.finished_at) {
    const end = Date.parse(job.finished_at.replace(' ', 'T') + 'Z')
    return Number.isFinite(end) ? Math.max(0, end - job.started_ms) : null
  }
  // Still going: measure it. Over, with no end recorded: there is nothing to
  // say, and saying it anyway would be inventing a duration.
  return job.state === 'running' ? Math.max(0, nowMs - job.started_ms) : null
}

/** A duration a person reads at a glance, not a stopwatch.
 *
 *  Under a second is "just now" rather than "0.4 s": for an operation whose
 *  whole point is that it might take an hour, sub-second precision is noise. */
export function tookFor(ms: number): string {
  if (ms < 1000) return 'under a second'
  const seconds = Math.round(ms / 1000)
  if (seconds < 90) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h ${rest} min` : `${hours}h`
}

/** Whether anything is still going, which is what decides the refresh cadence:
 *  a list of finished jobs does not need to be re-asked every two seconds. */
export function anyRunning(jobs: Job[]): boolean {
  return jobs.some((j) => j.state === 'running')
}
