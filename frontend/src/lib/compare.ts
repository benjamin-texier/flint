/** What is different between two tables, and which of it matters.
 *
 *  `src/clickhouse/compare.rs` measures: both column lists, both sets of storage
 *  settings, no opinion. This decides what the differences *mean* — and the one
 *  meaning worth most is the question people are actually asking when they put
 *  two tables side by side: **can this one stand in for that one?**
 *
 *  Three rules shape everything below.
 *
 *  - **A rename is a drop and an add, and says so.** Columns match by name
 *    because there is nothing else to match them by. Guessing that `client`
 *    became `customer` — from position, or from type — would invent a
 *    correspondence the server cannot confirm, and would be silently wrong on
 *    the day two columns swap places.
 *  - **Direction is the whole question.** `UInt32` becoming `UInt64` is safe and
 *    `UInt64` becoming `UInt32` is not, and the same pair of types is both
 *    depending on which way round you read it. So every verdict here is about
 *    the right-hand table *as a replacement for* the left-hand one.
 *  - **Where the answer is not certain, it is `changed`.** `Int64` to `Float64`
 *    holds every value up to 2^53 and loses precision above it; `String` to
 *    `DateTime` parses or throws depending on the rows. Neither is a widening
 *    and calling either one would be a promise this cannot keep, so both land in
 *    the bucket that says only that they differ.
 */

export interface Column {
  name: string
  type: string
  position: number
  default_kind: string
  default_expression: string
}

export interface Storage {
  engine: string
  sorting_key: string
  primary_key: string
  partition_key: string
  sampling_key: string
  total_rows: number | null
  total_bytes: number | null
}

export interface Side {
  database: string
  table: string
  found: boolean
  storage: Storage | null
  columns: Column[]
}

export interface Comparison {
  left: Side
  right: Side
}

export type Kind = 'same' | 'moved' | 'retyped' | 'added' | 'removed'

/** How a type changed, read left to right. */
export type How = 'widened' | 'narrowed' | 'nullable' | 'required' | 'storage' | 'changed'

export interface ColumnChange {
  name: string
  kind: Kind
  how?: How
  /** Whether it also sits somewhere else. Kept apart from `kind` because a
   *  column can change type *and* move, and the first version reported only the
   *  type — so a pair that swapped places while both were retyped never raised
   *  the positional warning at all. */
  moved: boolean
  left?: Column
  right?: Column
}

/** A difference in how the table is laid out rather than in what it holds. */
export interface StorageChange {
  what: 'engine' | 'sorting key' | 'primary key' | 'partition key' | 'sampling key'
  left: string
  right: string
  /** True where the same columns are listed in a different order — which is a
   *  different table for every query, and reads as identical in a diff. */
  reordered?: boolean
}

/** Every column, in a stable order: the left table's own order, then whatever
 *  the right table adds. A diff sorted by severity reads as a ranking; a diff in
 *  the table's own order reads as the table. */
export function columns(c: Comparison): ColumnChange[] {
  const right = new Map(c.right.columns.map((col) => [col.name, col]))
  const out: ColumnChange[] = []

  for (const left of c.left.columns) {
    const match = right.get(left.name)
    if (!match) {
      out.push({ name: left.name, kind: 'removed', moved: false, left })
      continue
    }
    right.delete(left.name)
    const moved = match.position !== left.position
    if (match.type !== left.type) {
      out.push({
        name: left.name,
        kind: 'retyped',
        how: how(left.type, match.type),
        moved,
        left,
        right: match,
      })
    } else {
      out.push({ name: left.name, kind: moved ? 'moved' : 'same', moved, left, right: match })
    }
  }
  for (const added of c.right.columns) {
    if (right.has(added.name)) {
      out.push({ name: added.name, kind: 'added', moved: false, right: added })
    }
  }
  return out
}

export function storage(c: Comparison): StorageChange[] {
  const a = c.left.storage
  const b = c.right.storage
  if (!a || !b) return []
  const out: StorageChange[] = []
  const pairs: [StorageChange['what'], string, string][] = [
    ['engine', a.engine, b.engine],
    ['sorting key', a.sorting_key, b.sorting_key],
    ['primary key', a.primary_key, b.primary_key],
    ['partition key', a.partition_key, b.partition_key],
    ['sampling key', a.sampling_key, b.sampling_key],
  ]
  for (const [what, left, right] of pairs) {
    if (left === right) continue
    out.push({ what, left, right, reordered: sameSet(left, right) })
  }
  return out
}

/** Whether two key expressions list the same columns in a different order.
 *
 *  Worth its own word: `(id, at)` and `(at, id)` are different tables to every
 *  query that filters on one of them, and a diff that only says "the sorting key
 *  changed" leaves the reader to spot that nothing was added or removed. */
function sameSet(left: string, right: string): boolean {
  const parts = (s: string) =>
    s
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .sort()
  const a = parts(left)
  const b = parts(right)
  return a.length > 1 && a.length === b.length && a.every((p, i) => p === b[i])
}

/** What a type change means, read as "left becoming right". */
export function how(left: string, right: string): How {
  const a = peel(left)
  const b = peel(right)

  // Same values, different encoding. Checked first, because a LowCardinality
  // wrapper is not a change to what the column can hold.
  if (a.base === b.base && a.nullable === b.nullable && a.low !== b.low) return 'storage'

  if (a.base === b.base) {
    if (!a.nullable && b.nullable) return 'nullable'
    if (a.nullable && !b.nullable) return 'required'
    return 'storage'
  }

  const widening = holds(a.base, b.base)
  if (widening !== null) {
    // A widening that also drops the null is not a widening: the rows that were
    // null have nowhere to go, and that is the half somebody needs told.
    if (a.nullable && !b.nullable) return 'required'
    return widening ? 'widened' : 'narrowed'
  }
  return 'changed'
}

/** Whether every value of `a` fits in `b` — `true` for a widening, `false` for a
 *  narrowing, `null` where the two are not comparable and no promise should be
 *  made either way. */
function holds(a: string, b: string): boolean | null {
  const ia = integer(a)
  const ib = integer(b)
  if (ia && ib) {
    // A signed type has to reach one bit lower than an unsigned one of the same
    // width to hold it: UInt32 fits in Int64, and does not fit in Int32.
    const reach = (t: { signed: boolean; bits: number }) => (t.signed ? t.bits - 1 : t.bits)
    if (ia.signed && !ib.signed) return false
    return reach(ia) <= reach(ib)
  }
  const fa = float(a)
  const fb = float(b)
  if (fa && fb) return fa <= fb
  const da = decimal(a)
  const db = decimal(b)
  if (da && db) return db.p - db.s >= da.p - da.s && db.s >= da.s
  return null
}

function integer(t: string): { signed: boolean; bits: number } | null {
  const m = /^(U?)Int(8|16|32|64|128|256)$/.exec(t)
  return m ? { signed: m[1] === '', bits: Number(m[2]) } : null
}

function float(t: string): number | null {
  const m = /^Float(32|64)$/.exec(t)
  return m ? Number(m[1]) : null
}

function decimal(t: string): { p: number; s: number } | null {
  const m = /^Decimal\(\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(t)
  return m ? { p: Number(m[1]), s: Number(m[2]) } : null
}

/** A declared type split into what it holds and how it is stored. Both wrappers,
 *  in either nesting order — ClickHouse writes `LowCardinality(Nullable(String))`
 *  and a reader may well type it the other way round. */
export function peel(type: string): { base: string; nullable: boolean; low: boolean } {
  let base = type.trim()
  let nullable = false
  let low = false
  for (let i = 0; i < 2; i++) {
    const n = /^Nullable\((.*)\)$/s.exec(base)
    if (n) {
      nullable = true
      base = n[1]!.trim()
      continue
    }
    const l = /^LowCardinality\((.*)\)$/s.exec(base)
    if (l) {
      low = true
      base = l[1]!.trim()
    }
  }
  return { base, nullable, low }
}

/** What stands in the way of using the right table where the left one is used.
 *
 *  Empty means nothing does. The list is the point: "not a drop-in replacement"
 *  is a verdict nobody can act on, and each line here names one thing to fix. */
export function blockers(c: Comparison): string[] {
  const out: string[] = []
  if (!c.left.found) return [`\`${qualified(c.left)}\` does not exist.`]
  if (!c.right.found) return [`\`${qualified(c.right)}\` does not exist.`]

  for (const change of columns(c)) {
    if (change.kind === 'removed') {
      out.push(`\`${change.name}\` is not in ${c.right.table} — anything selecting it breaks.`)
    } else if (change.kind === 'retyped' && change.how === 'narrowed') {
      out.push(
        `\`${change.name}\` narrows from ${change.left!.type} to ${change.right!.type} — values that fit before may not now.`,
      )
    } else if (change.kind === 'retyped' && change.how === 'required') {
      out.push(`\`${change.name}\` is no longer nullable — rows that were null have nowhere to go.`)
    } else if (change.kind === 'retyped' && change.how === 'changed') {
      out.push(`\`${change.name}\` changes from ${change.left!.type} to ${change.right!.type}.`)
    }
  }

  /* A moved column breaks exactly one thing, and it is a thing people write:
     `INSERT INTO t VALUES (…)` without a column list is positional. Named after
     what breaks rather than after what changed. */
  const moved = columns(c).filter((x) => x.moved)
  if (moved.length) {
    out.push(
      `${moved.length} ${moved.length === 1 ? 'column sits' : 'columns sit'} in a different position — an INSERT without a column list writes them into the wrong fields.`,
    )
  }
  return out
}

/** The one-line answer, above the detail. */
export function headline(c: Comparison): string {
  if (!c.left.found || !c.right.found) {
    const missing = !c.left.found ? c.left : c.right
    return `\`${qualified(missing)}\` does not exist, so there is nothing to compare.`
  }
  const changes = columns(c)
  const differing = changes.filter((x) => x.kind !== 'same')
  const store = storage(c)
  if (differing.length === 0 && store.length === 0) {
    return `These two tables are identical, column for column and setting for setting.`
  }
  const blocked = blockers(c)
  const parts: string[] = []
  if (differing.length) {
    // `changes.length` is the union of both column lists, which is neither
    // table's own count — so it says so rather than leaving a number the reader
    // cannot find on either side.
    parts.push(`${differing.length} of the ${changes.length} columns across the two differ`)
  }
  if (store.length) {
    parts.push(`${store.length} storage ${store.length === 1 ? 'setting differs' : 'settings differ'}`)
  }
  const lead = parts.join(' and ')
  return blocked.length
    ? `${cap(lead)}. ${c.right.table} cannot stand in for ${c.left.table} yet — ${blocked.length} ${blocked.length === 1 ? 'thing is' : 'things are'} in the way.`
    : `${cap(lead)}, and none of it would break a query written against ${c.left.table}.`
}

/** How each kind reads in a list. */
export const KIND_LABEL: Record<Kind, string> = {
  same: 'unchanged',
  moved: 'moved',
  retyped: 'retyped',
  added: 'added',
  removed: 'removed',
}

export const HOW_LABEL: Record<How, string> = {
  widened: 'holds more',
  narrowed: 'holds less',
  nullable: 'may be null now',
  required: 'no longer nullable',
  storage: 'stored differently',
  changed: 'different type',
}

export function qualified(side: Side): string {
  return `${side.database}.${side.table}`
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
