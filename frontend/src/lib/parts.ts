/** Parts on the disk that are not in the table.
 *
 *  One rule carries this whole screen: an empty `reason` means a person detached
 *  the part, and anything else means the server did. They look identical in a
 *  listing and they are opposite decisions — reattaching your own detached
 *  partition is the obvious next step, and reattaching a part ClickHouse
 *  quarantined for failing its checksums puts a broken part back in a table.
 *
 *  So nothing here treats "detached" as one state. */

export interface DetachedPart {
  database: string
  table: string
  qualified: string
  partition_id: string
  name: string
  bytes: number
  detached_at: string
  disk: string
  /** Empty when a person detached it; otherwise the server's own word. */
  reason: string
}

export interface DetachedReport {
  available: boolean
  reason?: string
  parts: DetachedPart[]
  total: number
  total_bytes: number
  quarantined: number
}

export type Origin = 'detached-by-hand' | 'quarantined'

/** Who put this part aside. */
export function origin(part: DetachedPart): Origin {
  return part.reason.trim() === '' ? 'detached-by-hand' : 'quarantined'
}

/** What to say about it, and how loudly.
 *
 *  A part somebody detached is not a problem — it is a step in a procedure, and
 *  flagging it would cry wolf on every backup. A part the server moved aside is
 *  worth reading before anything is done to it, and the server's own word for why
 *  is better than any word Flint could invent. */
export function says(part: DetachedPart): { text: string; level: 'idle' | 'watch' } {
  return origin(part) === 'detached-by-hand'
    ? { text: 'detached by hand', level: 'idle' }
    : { text: part.reason, level: 'watch' }
}

/** Whether reattaching this part is the ordinary thing to do.
 *
 *  Never a hard refusal — a broken part is sometimes exactly what you want back,
 *  after looking at it — but the control should not be the same shape as the safe
 *  one. Flint's job is to make sure nobody attaches a quarantined part without
 *  having read why it was quarantined. */
export function attachIsRoutine(part: DetachedPart): boolean {
  return origin(part) === 'detached-by-hand'
}

/** How much disk the detached parts are holding, and whether it is worth saying.
 *
 *  Zero parts is silence, not "0 B in 0 parts": a screen that reports nothing
 *  found as a figure is a screen that trains people to skip it. */
export function summary(report: DetachedReport | undefined): string | null {
  if (!report?.available || report.total === 0) return null
  const parts = `${report.total} detached part${report.total === 1 ? '' : 's'}`
  // `all` and `every one` need something to be all of, so one part gets neither.
  // Fixing this on one branch and not the other is how a sentence ends up
  // reading like a mistake in exactly one state nobody tested.
  const one = report.total === 1
  if (report.quarantined === 0) {
    return one ? `${parts}, detached by hand` : `${parts}, all detached by hand`
  }
  if (report.quarantined === report.total) {
    return one ? `${parts}, put aside by the server` : `${parts}, every one put aside by the server`
  }
  return `${parts}, ${report.quarantined} put aside by the server`
}
