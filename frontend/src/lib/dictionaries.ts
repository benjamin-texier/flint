/** Dictionaries, and whether they are actually working.
 *
 *  The judgements come from the backend, where they are tested — none of them is
 *  readable off a single column, and the worst case on this page reads `LOADED`.
 */

export interface Dictionary {
  database: string
  name: string
  status: string
  /** Empty until it has loaded once: the server does not know either. */
  source: string
  layout: string
  elements: number
  bytes: number
  queries: number
  found_rate: number
  hit_rate: number
  lifetime_min: number
  lifetime_max: number
  last_success: string
  /** Seconds past its own `lifetime_max`, computed on the server's clock. */
  overdue_secs: number
  loading_secs: number
  errors: number
  exception: string
  worrying: boolean
}

export interface DictionaryReport {
  items: { items: Dictionary[]; blocked?: string }
  /** Whether this server loads dictionaries on first use — the fact that makes
   *  `NOT_LOADED` innocent. */
  lazy: boolean
  verdicts: string[]
}

/** Whether a dictionary has ever loaded, which decides what its figures mean.
 *
 *  Before the first load the server reports no source, no size and no lifetime,
 *  so those cells are empty rather than zero — a zero would be a measurement.
 */
export function everLoaded(d: Dictionary): boolean {
  return !d.last_success.startsWith('1970')
}

/** The found rate as a sentence, or null where there is nothing to say.
 *
 *  Zero of zero lookups is not zero per cent, and a rate over no queries is a
 *  figure Flint would be inventing.
 */
export function saysFound(d: Dictionary): string | null {
  if (d.queries === 0) return null
  return `${Math.round(d.found_rate * 100)}% of ${d.queries} lookups found their key`
}

/** What a lifetime means, in words — or nothing, where it is not known.
 *
 *  Zero has two meanings and only one of them is a fact. On a dictionary that
 *  has loaded it means "never refreshes on its own"; on one that never loaded it
 *  means the server has not read the definition's lifetime yet, and saying
 *  "never refreshes" there would be Flint asserting a configuration it has not
 *  seen. The dev fixture had exactly that: a broken dictionary declared with
 *  `LIFETIME(MIN 300 MAX 600)` reporting `0/0`.
 */
export function saysLifetime(d: Dictionary): string {
  if (!everLoaded(d)) return ''
  if (d.lifetime_max === 0) return 'never refreshes on its own'
  if (d.lifetime_min === d.lifetime_max) return `every ${d.lifetime_max}s`
  return `every ${d.lifetime_min}–${d.lifetime_max}s`
}
