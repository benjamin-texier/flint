/** Where the processor actually went.
 *
 *  The framing comes from the backend, because every sentence on this panel is a
 *  claim about what sampling can and cannot say — and those were measured
 *  against a real server rather than reasoned from the table.
 */

export interface Frame {
  name: string
  samples: number
}

export interface TraceReport {
  frames: Frame[]
  /** Every sample in the window, named or not — the denominator each figure
   *  needs. Two out of five is noise; two out of five thousand is a finding. */
  samples: number
  unnamed: number
  kind: string
  minutes: number
  /** What this kind of sample answers, in the backend's words — sent rather
   *  than written twice. */
  kind_says: string
  /** Why the ranking should not be trusted, when it should not. Empty when the
   *  window holds enough. */
  note: string
  blocked?: string
}

/** A frame's share of the samples that could be named.
 *
 *  Of the *named* ones, not of every sample: dividing by a total that includes
 *  frames nobody could name would make every share quietly too small, and the
 *  unnamed count is reported on its own line instead.
 */
export function share(frame: Frame, frames: Frame[]): number {
  const named = frames.reduce((n, f) => n + f.samples, 0)
  return named > 0 ? frame.samples / named : 0
}

/** What the build could not name, as a sentence — or null when it named
 *  everything.
 *
 *  Roughly half of the frames on an idle server come back empty: inlined, or in
 *  a region the official build ships no symbol for. Dropping them silently would
 *  make the ranking above look complete when it is not.
 */
export function saysUnnamed(report: TraceReport): string | null {
  if (!report.unnamed || !report.samples) return null
  // When nothing could be named there is no list below to be missing from, and
  // a sentence that points at an absent table is worse than no sentence: the
  // reader looks for what it refers to. This is the only case where the line is
  // the whole answer rather than a caveat on one.
  if (report.unnamed >= report.samples) {
    return `All ${report.samples} samples landed at an address this build has no name for, so there is no ranking to show.`
  }
  // Clamped away from both ends, because the rounding contradicts the page
  // otherwise: 15174 of 15201 is 99.8%, and printing "100% is missing" directly
  // above twenty rows is a claim the reader can see is false. The same at the
  // other end — "0% is missing" next to a count that is not zero. The exact
  // figures are the two numerals in front of the share; this is the gloss.
  const pct = Math.min(99, Math.max(1, Math.round((report.unnamed / report.samples) * 100)))
  return `${report.unnamed} of ${report.samples} samples landed at an address this build has no name for — ${pct}% of the window is missing from the list below.`
}

/** The longest shared prefix of a C++ namespace, for trimming a label.
 *
 *  `DB::ColumnUnique<DB::ColumnVector<unsigned short>>::compareAt` is ninety
 *  characters of which the last twenty carry the meaning. The full name stays in
 *  the title attribute; this is what the row shows.
 */
export function short(name: string): string {
  // Cut the template arguments first: they are the bulk and almost never the
  // point. A single pass that keeps depth, so `A<B<C>>::d` becomes `A<…>::d`.
  let out = ''
  let depth = 0
  for (const c of name) {
    if (c === '<') {
      if (depth === 0) out += '<…'
      depth += 1
    } else if (c === '>') {
      depth -= 1
      if (depth === 0) out += '>'
    } else if (depth === 0) {
      out += c
    }
  }
  return out.length > 72 ? `${out.slice(0, 71)}…` : out
}
