/** Which tables are read together, and which of those the schema knows about.
 *
 *  The diagram draws declared dependencies. This draws observed ones: every
 *  finished `SELECT` names the tables it touched, so two names in the same row
 *  of `system.query_log` were read together, and a week of those is the coupling
 *  the DDL never recorded.
 *
 *  The two are drawn *on the same cell* rather than in two pictures, because the
 *  question is not "which pairs exist" — it is which pairs exist that nothing
 *  declares. A heavy cell with a ring is somebody's view being read, which is
 *  fine and expected. A heavy cell with no ring is a join performed constantly
 *  that no object in the database knows about, and that is the one worth
 *  finding.
 *
 *  A matrix rather than a graph, deliberately. Co-access is undirected and full
 *  of cycles, so the layered layout the schema diagram uses does not apply, and
 *  a force layout would be the thing the README already refuses — it throws away
 *  the ordering that makes a picture readable. A matrix has no layout to get
 *  wrong: rows and columns in one order, and the eye reads along either.
 *
 *  Everything here is pure so the matrix can be tested without a browser. */

import { barScale, CELL_FLOOR } from './scale'

export interface AffinityNode {
  qualified: string
  queries: number
  readers: number
}

export interface AffinityPair {
  a: string
  b: string
  queries: number
}

export interface AffinityReport {
  available: boolean
  reason?: string
  nodes: AffinityNode[]
  pairs: AffinityPair[]
  days: number
  /** Statements that touched this database at all, in the window. */
  considered: number
  /** Of those, the ones naming a single table: they make no pair, and an empty
   *  matrix beside a large `considered` would be a puzzle rather than an
   *  answer. */
  single: number
  /** And the ones left out for naming too many tables to be one join. */
  wide: number
  max_tables: number
}

/** The windows the matrix offers, in days.
 *
 *  Three, not a slider. Each answers a different question and the difference is
 *  the point: a day is what is happening now, a week is the shape of ordinary
 *  work including whatever runs on Mondays, and a month reaches far enough to
 *  catch the report nobody remembers scheduling. A slider would let somebody ask
 *  for eleven days, which answers nothing in particular.
 *
 *  Longer than a month is deliberately not offered here. `system.query_log` is
 *  usually kept for weeks, so a ninety-day window would quietly answer with
 *  whatever survived the TTL and call it ninety days. */
export const WINDOWS = [1, 7, 30] as const

export type Window = (typeof WINDOWS)[number]

export const WINDOW_LABEL: Record<Window, string> = {
  1: 'Today',
  7: 'A week',
  30: 'A month',
}

export const WINDOW_MEANING: Record<Window, string> = {
  1: 'The last day — what is happening now',
  7: 'The last seven days — ordinary work, including whatever runs weekly',
  30: 'The last thirty days — far enough to catch a monthly report',
}

/** Whether a number is one of the offered windows, for reading one out of a URL
 *  somebody may have edited. */
export function isWindow(n: number): n is Window {
  return (WINDOWS as readonly number[]).includes(n)
}

/** The key for an unordered pair. Sorted, so `(a,b)` and `(b,a)` are the same
 *  fact — which they are. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a} ${b}` : `${b} ${a}`
}

/** The declared pairs, from the schema graph's edges.
 *
 *  Direction is dropped on purpose: the schema knows a view reads a table, and
 *  what this matrix asks is only whether the pair is declared at all. Keeping
 *  the arrow here would mean a cell above the diagonal and one below it
 *  disagreeing about the same relationship. */
export function declaredPairs(edges: readonly { from: string; to: string }[]): Set<string> {
  return new Set(edges.map((e) => pairKey(e.from, e.to)))
}

/** A table's name as this database's reader thinks of it. A table from another
 *  database keeps its prefix: when a query reaches across a boundary, the
 *  boundary is information — the same rule the diagram's boxes follow. */
export function shortName(qualified: string, database: string): string {
  const prefix = `${database}.`
  return qualified.startsWith(prefix) ? qualified.slice(prefix.length) : qualified
}

export interface MatrixCell {
  a: string
  b: string
  queries: number
  /** Whether the schema declares a dependency between the two. */
  declared: boolean
  /** 0..1 against the scale, floored so anything seen at all is visible. */
  fill: number
  past: boolean
}

export interface Matrix {
  /** Tables in order, busiest first. */
  labels: string[]
  /** One row per table: `undefined` where the two were never named together,
   *  which is different from being named together rarely. */
  cells: (MatrixCell | undefined)[][]
  /** The value a full cell represents. */
  scale: number
  /** Tables the cap left out. */
  omittedNodes: number
  /** Pairs the cap put out of view — at least one end is not a drawn row. */
  offMatrixPairs: number
  /** Pairs seen in the log that the schema does not declare, among those drawn.
   *  The count the view exists for. */
  undeclared: number
}


/** How many tables the matrix draws. Beyond this the cells are smaller than the
 *  labels and the picture stops being readable in either direction. */
export const NODE_LIMIT = 24

export function buildMatrix(
  report: AffinityReport,
  declared: ReadonlySet<string>,
  limit: number = NODE_LIMIT,
): Matrix {
  const labels = report.nodes.slice(0, Math.max(2, limit)).map((n) => n.qualified)
  const drawn = new Set(labels)
  const seen = new Map(report.pairs.map((p) => [pairKey(p.a, p.b), p.queries]))

  const onMatrix = report.pairs.filter((p) => drawn.has(p.a) && drawn.has(p.b))
  const scale = barScale(onMatrix.map((p) => p.queries))

  const cells = labels.map((a) =>
    labels.map((b) => {
      // The diagonal is a table with itself, which is not a fact about
      // anything. Its own query count is on its row header, where it belongs.
      if (a === b) return undefined
      const queries = seen.get(pairKey(a, b))
      if (queries === undefined) return undefined
      return {
        a,
        b,
        queries,
        declared: declared.has(pairKey(a, b)),
        fill: scale > 0 ? Math.max(CELL_FLOOR, Math.min(1, queries / scale)) : CELL_FLOOR,
        past: scale > 0 && queries > scale,
      }
    }),
  )

  return {
    labels,
    cells,
    scale,
    omittedNodes: Math.max(0, report.nodes.length - labels.length),
    offMatrixPairs: report.pairs.length - onMatrix.length,
    undeclared: onMatrix.filter((p) => !declared.has(pairKey(p.a, p.b))).length,
  }
}

/** What the matrix is not showing, and what the log could not answer. Each
 *  count states itself, as everywhere else here. */
export function leftOut(matrix: Matrix, report: AffinityReport): string[] {
  const out: string[] = []
  if (matrix.omittedNodes > 0) {
    out.push(`${matrix.omittedNodes} less-read tables not drawn`)
  }
  if (matrix.offMatrixPairs > 0) {
    out.push(`${matrix.offMatrixPairs} pairs with a table that is not a row here`)
  }
  if (report.wide > 0) {
    out.push(
      `${report.wide} statements named more than 8 tables and were left out — the widest named ${report.max_tables}`,
    )
  }
  return out
}

/** The sentence over the matrix: what was read, over what window, and how much
 *  of it could make a pair at all.
 *
 *  Saying how many statements named one table is not padding: on most servers it
 *  is the majority, and a matrix that looked sparse beside "4,102 statements"
 *  would read as a picture that failed rather than as the truth. */
export function span(report: AffinityReport): string {
  const window = `over ${report.days} ${report.days === 1 ? 'day' : 'days'}`
  if (report.considered === 0) return `No statement read this database ${window}`
  const paired = report.considered - report.single - report.wide
  const stmt = `${report.considered.toLocaleString('en-US')} ${
    report.considered === 1 ? 'statement' : 'statements'
  }`
  if (paired <= 0) {
    return `${stmt} ${window}, every one of them naming a single table — nothing was read together`
  }
  return `${stmt} ${window} · ${paired.toLocaleString('en-US')} named more than one table`
}
