/** Number, byte and duration formatting, and the one piece of name shortening.
 *  Everything here is deliberately terse: these values sit inside dense tables
 *  where width is expensive. */

const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
const FULL = new Intl.NumberFormat('en')

/** `1.24 B` for 1_240_000_000. Used wherever a count shares a row with others. */
export function count(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  if (n < 1000) return String(n)
  return COMPACT.format(n).replace(/([A-Z])$/, ' $1')
}

/** A computed figure — a mean, a total, a percentile — at the size it reads
 *  best: compact past a thousand, where the digits stop carrying information
 *  and start costing width, and two decimals below it, where an average of 3.22
 *  is the answer and 3 is not. */
export function figure(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 1000) return count(value)
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100)
}

export function exact(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return FULL.format(n)
}

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  if (n === 0) return '0 B'
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), UNITS.length - 1)
  const value = n / 1024 ** i
  const digits = value < 10 && i > 0 ? 1 : 0
  return `${value.toFixed(digits)} ${UNITS[i]}`
}

/** Seconds, rendered at the precision a human cares about at that magnitude. */
export function duration(seconds: number): string {
  if (seconds < 0.001) return '<1 ms'
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`
  if (seconds < 60) return `${seconds.toFixed(2)} s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}m ${s}s`
}

/** How long a stretch of *data* covers, which is a different question from how
 *  long a query took and wants a different coarseness. `duration` renders 12,000
 *  seconds as "200m 0s" — right for a slow query, useless for the three hours a
 *  result happens to span. */
export function stretch(seconds: number): string {
  if (seconds < 1) return '<1 s'
  if (seconds < 60) return `${Math.round(seconds)} s`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  if (seconds < 86_400) {
    const h = Math.floor(seconds / 3600)
    const m = Math.round((seconds % 3600) / 60)
    return m > 0 ? `${h} h ${m} min` : `${h} h`
  }
  const d = Math.floor(seconds / 86_400)
  const h = Math.round((seconds % 86_400) / 3600)
  return h > 0 ? `${d} d ${h} h` : `${d} d`
}

export function uptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  if (d >= 1) return `${d}d`
  const h = Math.floor(seconds / 3600)
  if (h >= 1) return `${h}h`
  return `${Math.max(1, Math.floor(seconds / 60))}m`
}

/** `4.1×`, or null when there is nothing to compare. */
export function ratio(uncompressed: number, compressed: number): string | null {
  if (!compressed || !uncompressed) return null
  return times(uncompressed / compressed)
}

/** A multiple, written the way every ratio in Flint is written.
 *
 *  Split out of `ratio` so that a caller which has already *judged* the multiple
 *  — `lib/weight`, which knows which of a table's three byte figures may be
 *  divided by which — renders it identically rather than growing a second
 *  `toFixed` beside it. One decimal below ten, none above: `3.8×` is a fact
 *  about a column type, `142×` is a fact about a table, and `142.0×` is neither.
 */
export function times(multiple: number | null): string | null {
  if (multiple === null || !Number.isFinite(multiple) || multiple <= 0) return null
  return `${multiple.toFixed(multiple < 10 ? 1 : 0)}×`
}

/** ClickHouse hands us `2024-06-01 12:03:44`. Trim to what fits. */
export function shortTime(value: string): string {
  if (!value || value.startsWith('1970-01-01') || value.startsWith('0000')) return '—'
  return value.replace('T', ' ').slice(0, 16)
}

export function relativeTime(value: string): string {
  const then = Date.parse(value.replace(' ', 'T') + 'Z')
  if (Number.isNaN(then)) return '—'
  const secondsAgo = (Date.now() - then) / 1000
  if (secondsAgo < 60) return 'just now'
  if (secondsAgo < 3600) return `${Math.floor(secondsAgo / 60)}m ago`
  if (secondsAgo < 86400) return `${Math.floor(secondsAgo / 3600)}h ago`
  return `${Math.floor(secondsAgo / 86400)}d ago`
}

/** Split a name so a narrow column can drop characters out of the middle rather
 *  than off the end.
 *
 *  Truncating the tail is the wrong choice for the names a ClickHouse schema
 *  actually holds: `sensor_readings_raw`, `sensor_readings_latest` and
 *  `sensor_readings_estimated` share every character that fits and differ
 *  only in the part that gets cut. So the last segment is kept whole and the
 *  head is what gives way — and where there is no segment to keep, the last few
 *  characters are, which is enough to tell two UUID-suffixed names apart.
 *
 *  Returns `[head, tail]`; an empty tail means the name is short enough to
 *  stand as it is. */
export function splitTail(name: string, floor = 16): [string, string] {
  if (name.length <= floor) return [name, '']
  const cut = name.lastIndexOf('_')
  if (cut > 0 && name.length - cut <= 13) return [name.slice(0, cut), name.slice(cut)]
  return [name.slice(0, -6), name.slice(-6)]
}

/** The caption under a part count.
 *
 *  A part count on its own is unjudgeable: 55 is healthy, 5,000 is an incident,
 *  and the number alone cannot say which. Against the partition count it can —
 *  a handful per partition means the merges are keeping up, and a hundred means
 *  they are not. With one partition there is nothing to divide by and the bare
 *  label is the honest one. */
export function partsLabel(parts: number, partitions: number): string {
  // One part is one part. A table with a single part is the common case for a
  // small table, and "1 active parts" is the kind of thing that makes a page
  // look generated rather than written.
  if (parts === 1) return 'active part'
  if (partitions < 2) return 'active parts'
  const per = parts / partitions
  const rounded = per < 1.5 ? '~1' : per < 10 ? per.toFixed(1) : Math.round(per).toString()
  return `active parts · ${rounded} per partition`
}
