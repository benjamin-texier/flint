/** Maps a ClickHouse type onto one of six colour families.
 *
 *  The point is that a 90-column schema should be readable at a glance —
 *  which columns are measures, which are timestamps, which are nested. Colour
 *  is doing structural work here, so the families are broad on purpose. */

export type TypeFamily = 'number' | 'string' | 'time' | 'bool' | 'nested' | 'other'

/** Strip the wrappers that do not change how a value reads. */
export function unwrap(type: string): string {
  let t = type.trim()
  for (;;) {
    const match = /^(Nullable|LowCardinality|SimpleAggregateFunction)\((.*)\)$/.exec(t)
    if (!match || !match[2]) break
    // SimpleAggregateFunction(sum, UInt64) — the type is the last argument.
    t = match[1] === 'SimpleAggregateFunction' ? match[2].split(',').pop()!.trim() : match[2]
  }
  return t
}

export function family(type: string): TypeFamily {
  const t = unwrap(type)
  if (/^(Date|Time)/.test(t)) return 'time'
  if (/^(U?Int|Float|Decimal|BFloat)/.test(t)) return 'number'
  if (/^(String|FixedString|UUID|IPv[46])/.test(t)) return 'string'
  if (/^(Bool|Enum)/.test(t)) return 'bool'
  if (/^(Array|Map|Tuple|Nested|Nullable|Variant|JSON|Object|Dynamic|AggregateFunction)/.test(t))
    return 'nested'
  return 'other'
}

export function familyColor(type: string): string {
  return `var(--t-${family(type)})`
}

/** True for types a chart can plot on a value axis. Used later by the chart
 *  suggester; already useful for right-aligning numeric grid columns. */
export function isNumeric(type: string): boolean {
  return family(type) === 'number'
}

export function isTemporal(type: string): boolean {
  return family(type) === 'time'
}

/** Abbreviate a long type for a narrow column, keeping the head intact:
 *  `LowCardinality(Nullable(String))` → `LowCard(Nullable(String))`. */
export function shortType(type: string): string {
  return type.replace(/LowCardinality/g, 'LowCard').replace(/SimpleAggregateFunction/g, 'SimpleAgg')
}
