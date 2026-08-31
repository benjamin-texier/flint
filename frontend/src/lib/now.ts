/** What the server is doing this second.
 *
 *  Three kinds of figure, and the kind is a property of the figure rather than a
 *  choice the page makes: one has a ceiling and the distance to it is the point,
 *  one has no ceiling and should be zero, and one is context. Mixing them puts a
 *  bar next to a number that has nothing to be a fraction of.
 */

export type Unit = 'count' | 'bytes' | 'seconds'
export type Kind = 'saturation' | 'should-be-zero' | 'figure'

export interface Gauge {
  name: string
  /** The metric behind it, so a figure can be traced to a table. */
  source: string
  value: number
  unit: Unit
  kind: Kind
  /** Absent where the server sets no limit — zero means unlimited in ClickHouse
   *  and is dropped rather than drawn as a bar at its end. */
  ceiling?: number
  /** `table.setting`, qualified because the settings tables collide. */
  ceiling_from: string
  note: string
  /** Which object the figure is about, where it is about one. */
  detail: string
}

export interface Rate {
  name: string
  source: string
  per_second: number
  unit: Unit
}

export interface Section<T> {
  items: T[]
  blocked?: string
}

export interface NowReport {
  gauges: Section<Gauge>
  rates: Section<Rate>
  rates_at: string
  rates_age_secs: number
  uptime_secs?: number
}

/** The three groups, in the order they are worth reading.
 *
 *  Alarms first, and only the ones actually firing: a list of four zeroes under
 *  a heading that says something is wrong is a heading nobody will trust the
 *  fifth time. The quiet ones are counted instead, because "nothing is delayed,
 *  nothing is read-only, no replica is behind" is itself worth one line.
 */
export function split(gauges: Gauge[]): {
  firing: Gauge[]
  quiet: Gauge[]
  saturation: Gauge[]
  figures: Gauge[]
} {
  const alarms = gauges.filter((g) => g.kind === 'should-be-zero')
  return {
    firing: alarms.filter((g) => g.value > 0),
    quiet: alarms.filter((g) => g.value === 0),
    saturation: gauges.filter((g) => g.kind === 'saturation'),
    figures: gauges.filter((g) => g.kind === 'figure'),
  }
}

/** The quiet alarms as one line, naming them.
 *
 *  Naming them matters: "3 checks are clear" says nothing about *which*, and the
 *  value of this line is that somebody can see the thing they were worried about
 *  is one of the ones being checked.
 */
export function saysQuiet(quiet: Gauge[]): string | null {
  if (!quiet.length) return null
  const names = quiet.map((g) => g.name.toLowerCase()).join(', ')
  return `All clear: ${names}.`
}

/** How stale the rates are, in words — or null when the answer is boring.
 *
 *  `metric_log` buffers before it writes, so the newest bucket can be several
 *  seconds behind. A rate labelled "now" that is nine seconds old is the same
 *  lie as a lifetime counter, in miniature, so the delay is said out loud once
 *  it is worth saying.
 */
export function staleness(ageSecs: number): string | null {
  if (ageSecs <= 2) return null
  if (ageSecs <= 30) {
    return `measured ${ageSecs} seconds ago — system.metric_log buffers before it writes`
  }
  return `measured ${ageSecs} seconds ago, which is longer than a bucket: system.metric_log may have stopped collecting`
}

/** Uptime as the context sentence it is.
 *
 *  A figure that looks alarming on a server up for a minute is often just a
 *  server that has been up for a minute.
 */
export function saysUptime(seconds: number | undefined): string | null {
  if (seconds === undefined) return null
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  if (days) return `up ${days} day${days === 1 ? '' : 's'}, ${hours}h`
  if (hours) return `up ${hours}h ${mins}m`
  return `up ${mins} minute${mins === 1 ? '' : 's'}`
}
