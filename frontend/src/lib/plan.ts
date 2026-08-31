/** Reading ClickHouse's plan back as sentences.
 *
 *  `EXPLAIN PLAN indexes = 1` already contains the answer to nearly every
 *  question people ask about why a query was slow: how many parts and granules
 *  it actually read against how many it could have, which index did the
 *  pruning, whether the server moved a predicate into PREWHERE by itself, which
 *  side of a join it builds its hash from, and whether a join condition is
 *  quietly casting on every row. Flint has been printing all of it as a wall of
 *  text.
 *
 *  So this turns the numbers into statements. It is deliberately *not* a rules
 *  engine: every sentence it produces is an arithmetic fact about figures the
 *  server reported, which is what makes them safe to print. Earlier in this
 *  codebase's life the obvious rule — "never wrap a key column in a function" —
 *  turned out to be false on ClickHouse 26.7, where monotonicity detection kept
 *  the pruning identical. A hand-written rule ages; `5 of 11 granules` cannot.
 *
 *  Anything the parser does not recognise is ignored rather than guessed, and a
 *  plan it cannot read at all produces no verdicts — the raw text is still on
 *  screen, which is the state of the art it is improving on. */

/** How many of a thing were used, out of how many there were. */
export interface Used {
  used: number
  total: number
}

export interface PlanIndex {
  /** `MinMax`, `Partition`, `PrimaryKey`, `Skip`. */
  kind: string
  /** A skip index has a name of its own; the others are the kind. */
  name: string | null
  /** `minmax GRANULARITY 1`, for a skip index. */
  description: string | null
  condition: string | null
  /** The key columns the condition could use. Not the whole sorting key: the
   *  plan reports what the condition reached, which is the question. */
  keys: string[]
  parts: Used | null
  granules: Used | null
}

export interface PlanRead {
  /** `system.query_log`, as the plan names it. */
  table: string
  /** `Default`, `InOrder`, `InReverseOrder`. */
  readType: string | null
  /** What it ended up reading. */
  parts: number | null
  granules: number | null
  /** The predicate the server moved into PREWHERE by itself. */
  prewhere: string | null
  indexes: PlanIndex[]
}

export interface PlanJoin {
  /** `FillRightFirst` and friends — which side is built first. */
  order: string | null
  algorithm: string | null
  kind: string | null
  condition: string | null
}

export interface Plan {
  reads: PlanRead[]
  joins: PlanJoin[]
}

/** ClickHouse escapes quotes inside the plan text, so a condition arrives as
 *  `event_time >= \'2026-08-26\'`. Printed as-is that reads like a bug in
 *  Flint. */
function unescape(text: string): string {
  return text.replace(/\\'/g, "'").trim()
}

/** `3/4` → used 3 of 4. Also accepts a bare number, which is what the read
 *  node's own `Parts: 3 | Granules: 5` line carries. */
function used(text: string): Used | null {
  const pair = /^(\d+)\s*\/\s*(\d+)$/.exec(text.trim())
  if (pair) return { used: Number(pair[1]), total: Number(pair[2]) }
  return null
}

/** Strip the tree drawing and report how deeply the line was indented.
 *
 *  Depth is what separates a field of the read node from a field of the index
 *  block underneath it, and the box-drawing characters are the only thing
 *  standing between this and a straightforward indentation parse. */
function level(line: string): { depth: number; text: string } {
  const bare = line.replace(/[│├└─]/g, ' ')
  const text = bare.trimEnd()
  return { depth: text.length - text.trimStart().length, text: text.trim() }
}

/** Parse the plan. Never throws: a shape it does not know produces less, not an
 *  error. */
export function readPlan(text: string): Plan {
  const plan: Plan = { reads: [], joins: [] }
  let read: PlanRead | null = null
  let index: PlanIndex | null = null
  /** Indentation of the `Indexes:` block, so a field can be attributed to the
   *  index it belongs to rather than to the read above it. */
  let indexesAt = -1
  /** True while the lines being read are the `Keys:` list of a PrimaryKey. */
  let inKeys = false

  for (const raw of text.split('\n')) {
    const { depth, text: line } = level(raw)
    if (!line) continue

    const readNode = /^ReadFrom(\w+)\s*\(([^)]+)\)/.exec(line)
    if (readNode) {
      read = {
        table: readNode[2]!.trim(),
        readType: null,
        parts: null,
        granules: null,
        prewhere: null,
        indexes: [],
      }
      plan.reads.push(read)
      index = null
      indexesAt = -1
      inKeys = false
      continue
    }

    const join = /^Join\s*\(([^)]*)\)/.exec(line)
    if (join) {
      plan.joins.push({
        order: join[1]!.replace(/^JOIN\s+/i, '').trim() || null,
        algorithm: null,
        kind: null,
        condition: null,
      })
      continue
    }

    const current = plan.joins[plan.joins.length - 1]
    if (current) {
      const algorithm = /Algorithm:\s*(.+)$/.exec(line)
      if (algorithm && !current.algorithm) current.algorithm = algorithm[1]!.trim()
      const kind = /Type:\s*(\w+)/.exec(line)
      if (kind && !current.kind) current.kind = kind[1]!
      const condition = /^Join conditions:\s*(.+)$/.exec(line)
      if (condition && !current.condition) current.condition = unescape(condition[1]!)
    }

    if (!read) continue

    if (line === 'Indexes:') {
      indexesAt = depth
      index = null
      inKeys = false
      continue
    }

    // Inside the index block: a line at the block's own depth + 2 opens a new
    // index, anything deeper is a field of it.
    if (indexesAt >= 0 && depth > indexesAt) {
      if (/^(Min-?Max|Partition|PrimaryKey|Skip)$/i.test(line)) {
        index = {
          kind: line.replace('-', ''),
          name: null,
          description: null,
          condition: null,
          keys: [],
          parts: null,
          granules: null,
        }
        read.indexes.push(index)
        inKeys = false
        continue
      }
      if (index) {
        if (line === 'Keys:') {
          inKeys = true
          continue
        }
        const field = /^([A-Za-z ]+):\s*(.*)$/.exec(line)
        if (field) {
          inKeys = false
          const key = field[1]!.trim()
          const value = field[2]!.trim()
          if (key === 'Name') index.name = value
          else if (key === 'Description') index.description = value
          else if (key === 'Condition') index.condition = unescape(value)
          else if (key === 'Parts') index.parts = used(value)
          else if (key === 'Granules') index.granules = used(value)
          continue
        }
        // A bare word under `Keys:` is one of them.
        if (inKeys) index.keys.push(line.replace(/,$/, ''))
        continue
      }
      continue
    }

    // Fields of the read node itself.
    const readType = /^Read type:\s*(.+)$/.exec(line)
    if (readType) {
      read.readType = readType[1]!.trim()
      continue
    }
    const counts = /^Parts:\s*(\d+)\s*\|\s*Granules:\s*(\d+)/.exec(line)
    if (counts) {
      read.parts = Number(counts[1])
      read.granules = Number(counts[2])
      continue
    }
    const prewhere = /^Prewhere filter column:\s*(.+)$/.exec(line)
    if (prewhere) {
      read.prewhere = unescape(prewhere[1]!)
      continue
    }
  }

  return plan
}

/* -- What the numbers say ---------------------------------------------- */

export type Tone =
  /** The query is being helped: pruning happened, an order was free. */
  | 'good'
  /** Something is costing more than it needs to. */
  | 'cost'
  /** Worth knowing, neither good nor bad. */
  | 'note'

export interface Verdict {
  tone: Tone
  text: string
  /** The figures it rests on, so the reader can disagree with the sentence. */
  evidence: string | null
}

function share(u: Used): string {
  return `${u.used} of ${u.total}`
}

/** The plan, read back as statements.
 *
 *  Every one of these is arithmetic over what the server reported. Nothing here
 *  predicts, recommends a codec, or knows anything about SQL: the moment it
 *  starts guessing, it starts aging. */
export function verdicts(plan: Plan): Verdict[] {
  const out: Verdict[] = []

  for (const read of plan.reads) {
    const where = plan.reads.length > 1 ? ` on ${read.table}` : ''
    const primary = read.indexes.find((i) => i.kind.toLowerCase() === 'primarykey')

    if (primary?.granules) {
      const { used: kept, total } = primary.granules
      if (kept < total) {
        const keys = primary.keys.length > 0 ? ` on ${primary.keys.join(', ')}` : ''
        out.push({
          tone: 'good',
          text: `The primary key${keys} narrowed the read${where}: ${share(primary.granules)} granules.`,
          evidence: primary.parts ? `${share(primary.parts)} parts, ${share(primary.granules)} granules` : null,
        })
      } else {
        // Nothing was pruned, and there are two quite different reasons for
        // that. `Condition: true` means the query never constrained the key at
        // all — the filter is on the wrong column, and naming the key is the
        // useful half of the sentence. Any other condition means the key *was*
        // used and simply excluded nothing, which happens when everything asked
        // for is genuinely in range. Telling somebody to fix a filter that is
        // already right is worse than saying nothing.
        const unconstrained = primary.condition === null || primary.condition === 'true'
        const keys = primary.keys.join(', ')
        out.push({
          tone: unconstrained ? 'cost' : 'note',
          text: unconstrained
            ? `Nothing was pruned${where}: every one of the ${total} granules was read.${
                keys ? ` Nothing in the query constrained the key, which is ${keys}.` : ''
              }`
            : `The key${keys ? ` on ${keys}` : ''} was used but excluded nothing${where}: all ${total} granules matched, so there was nothing to skip.`,
          evidence: unconstrained ? null : `condition ${primary.condition}`,
        })
      }
    }

    // A skip index that pruned nothing is an index being paid for on every
    // write and returning nothing on this query. Worth saying; not worth
    // advising about, because one query is not the whole workload.
    for (const skip of read.indexes.filter((i) => i.kind.toLowerCase() === 'skip')) {
      if (!skip.granules) continue
      const name = skip.name ? `\`${skip.name}\`` : 'a skip index'
      if (skip.granules.used < skip.granules.total) {
        out.push({
          tone: 'good',
          text: `The skip index ${name} narrowed it further: ${share(skip.granules)} granules.`,
          evidence: skip.description,
        })
      } else {
        out.push({
          tone: 'note',
          text: `The skip index ${name} pruned nothing here — every granule it saw was read.`,
          evidence: skip.description,
        })
      }
    }

    if (read.prewhere) {
      out.push({
        tone: 'good',
        text: 'The server moved a filter into PREWHERE by itself, so it reads that column first and the rest only where it matched.',
        evidence: read.prewhere,
      })
    }

    if (read.readType && read.readType.toLowerCase().startsWith('inorder')) {
      out.push({
        tone: 'good',
        text: 'Read in sorting-key order, so the ORDER BY costs no sort at all.',
        evidence: `read type ${read.readType}`,
      })
    }
    if (read.readType && read.readType.toLowerCase().startsWith('inreverse')) {
      out.push({
        tone: 'note',
        text: 'Read backwards along the sorting key: no sort, but the reads are not sequential.',
        evidence: `read type ${read.readType}`,
      })
    }
  }

  for (const join of plan.joins) {
    if (join.order) {
      const side = /right/i.test(join.order) ? 'right' : /left/i.test(join.order) ? 'left' : null
      out.push({
        tone: 'note',
        text: side
          ? `This join builds from the ${side} side first, so that is the side whose rows have to fit in memory.`
          : 'This join builds one side into memory first.',
        evidence: [join.order, join.algorithm].filter(Boolean).join(' · ') || null,
      })
    }
    // An implicit cast in a join condition is per row, on both sides, and it is
    // invisible in the SQL that produced it.
    if (join.condition && /\bCAST\(|\b_CAST\(/i.test(join.condition)) {
      out.push({
        tone: 'cost',
        text: 'The join condition casts on every row: the two sides are not the same type.',
        evidence: join.condition,
      })
    }
  }

  return out
}
