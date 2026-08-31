/** Which edges of the schema diagram are actually carrying anything.
 *
 *  The diagram used to animate every edge identically: the same dots at the
 *  same pace along a live materialized view, along a plain view that has never
 *  moved a row in its life, and along a pipeline whose target table was dropped
 *  a month ago. That is decoration wearing the clothes of a measurement — the
 *  worst kind, because a reader is entitled to assume that something moving on
 *  a diagram of data movement means data moved.
 *
 *  So motion is earned here, from `system.query_views_log` by way of the
 *  pipelines report, and it means one thing: rows passed through this pipe
 *  inside the window. Everything else holds still.
 *
 *  Two decisions worth keeping:
 *
 *  **Cadence, not speed.** Every dot on the canvas travels at the same rate, and
 *  volume is the *spacing* between them — a busy pipe is a stream, a quiet one
 *  is a dot every few seconds. Speed cannot be compared across two curves of
 *  different lengths anyway, and a fast dot reads as urgency rather than as
 *  quantity.
 *
 *  **The scale is the 90th percentile**, the same as every bar in the product
 *  (`barScale`) and for the same reason: one view feeding a rollup with 400
 *  million rows beside three doing tens of thousands would otherwise leave the
 *  three at the sparsest spacing, indistinguishable from idle. What runs past
 *  the scale is drawn at the densest spacing and *counted*, so the legend can
 *  say so.
 *
 *  The vocabulary is deliberately not the Pipelines page's. That page asks "is
 *  this view healthy"; the diagram asks "did rows move". A view can be
 *  perfectly healthy and still — nothing was inserted into its source this week
 *  — and calling that `idle` on one screen and `Flowing` on the other would read
 *  as a contradiction rather than as two questions. */

import { count } from './format'
import type { GraphEdge, GraphNode } from './graph'
import { edgeKey, nodeId } from './graph'
import { verdictOf, type PipelineReport, type View } from './pipeline'
import { barScale } from './scale'

export type FlowState =
  /** Rows moved through it inside the window. The only state that animates. */
  | 'carrying'
  /** A real pipeline that moved nothing: an idle source, or runs that wrote no
   *  rows. Working, and with nothing to show for it. */
  | 'still'
  /** It cannot run: the target is gone, its runs are failing, its refresh is in
   *  error. Drawn severed. */
  | 'broken'
  /** A pipeline whose log Flint cannot read. Not the same as nothing having
   *  happened, and it must not be drawn as if it were. */
  | 'unseen'
  /** Not a pipeline at all — a plain view's SELECT, a dictionary's source. No
   *  insert ever pushes a row along it, so it never moves. */
  | 'inert'

/** The dot itself, in px. Small enough to read as a particle rather than a
 *  dash; the gap around it is what carries the quantity. */
const DOT = 2
/** The spacing at and past the scale: dots nearly touching, a stream. */
const GAP_DENSE = 9
/** The spacing of the quietest pipe that still moved a row. A dot every
 *  hundred pixels is lonely, which is the point — but it is still a dot, and
 *  "a little" must never render as "nothing". */
const GAP_SPARSE = 96
/** Where a pipe whose volume Flint cannot measure is drawn — a refreshable
 *  view, which writes its target wholesale and reports no row count. Mid-scale
 *  and marked in the legend, rather than parked at one end where it would read
 *  as a measurement. */
const GAP_UNMEASURED = 40

export interface EdgeFlow {
  state: FlowState
  /** The materialized view this edge belongs to, `database.name`. Empty on an
   *  inert edge, which belongs to no pipeline. */
  view: string
  /** Rows written through the view over the window. */
  rows: number
  /** False when the state is `carrying` but the row count is not a measurement
   *  of this pipe — see `GAP_UNMEASURED`. */
  measured: boolean
  /** `stroke-dasharray`'s gap, in px. Only meaningful while carrying. */
  gap: number
  /** Carries more than the scale, and so is drawn at the densest spacing it can
   *  be drawn at rather than at its true share. */
  past: boolean
  /** What is true of this edge, for its tooltip. One sentence, in the view's
   *  own terms. */
  says: string
}

export interface FlowReading {
  /** Keyed by `edgeKey`, which is what a laid-out edge carries as its id. */
  edges: Map<string, EdgeFlow>
  /** The row count the spacing is scaled against — the 90th percentile of the
   *  pipes that moved anything. */
  scale: number
  /** The busiest pipe drawn, which is the figure a legend should quote: a
   *  percentile is the right scale and the wrong sentence. */
  busiest: number
  windowDays: number
  /** What each materialized view is doing, keyed by `database.name`. Kept
   *  rather than reduced to counts here because the reading is taken over the
   *  whole diagram — so that filtering it does not rescale the cadence and make
   *  a quiet pipe look busy — while the legend has to count only what is drawn.
   *  Two different sets, from one measurement. */
  pipes: Map<string, Pipe>
}

/** What one materialized view is doing, before it is spread over its edges. */
export interface Pipe {
  state: Exclude<FlowState, 'inert'>
  rows: number
  measured: boolean
  says: string
}

/** The pipelines among a set of drawn nodes, tallied by what they are doing. */
export interface FlowCounts {
  carrying: number
  still: number
  broken: number
  unseen: number
  /** Of the carrying ones, how many are drawn without a measurement. */
  unmeasured: number
  /** Of the carrying ones, how many run past the scale. */
  past: number
  /** Every pipeline drawn, which is what the others are `of`. */
  total: number
}

function pipeOf(view: View, logAvailable: boolean): Pipe {
  const verdict = verdictOf(view, logAvailable)
  if (verdict.health === 'broken') {
    return { state: 'broken', rows: 0, measured: true, says: verdict.says }
  }
  if (verdict.health === 'unknown') {
    return { state: 'unseen', rows: 0, measured: true, says: verdict.says }
  }
  if (verdict.health === 'idle') {
    return { state: 'still', rows: 0, measured: true, says: verdict.says }
  }
  // A refreshable view is flowing on its own schedule and reports no row count
  // for it: the run is a wholesale rewrite of the target, not a stream of rows
  // through a trigger. Drawn, but not measured.
  if (view.refreshable) {
    return {
      state: 'carrying',
      rows: 0,
      measured: false,
      says: `refreshing on its own schedule (${view.refresh_status}) — a refresh rewrites its target, so there is no row count to scale its cadence against`,
    }
  }
  if (view.written_rows === 0) {
    return {
      state: 'still',
      rows: 0,
      measured: true,
      says: `it ran ${view.runs} time${view.runs === 1 ? '' : 's'} and wrote no rows`,
    }
  }
  return {
    state: 'carrying',
    rows: view.written_rows,
    measured: true,
    says: `${count(view.written_rows)} rows written over ${view.runs} run${
      view.runs === 1 ? '' : 's'
    }`,
  }
}

/** The gap between two dots, for a pipe carrying `rows` against `scale`.
 *
 *  Linear in the share, with the sparse end as the floor — the same shape as
 *  `CELL_FLOOR` in the grids: present and small has to stay visibly different
 *  from absent. */
export function gapFor(rows: number, scale: number): number {
  if (scale <= 0) return GAP_UNMEASURED
  const share = Math.min(1, rows / scale)
  return Math.round(GAP_SPARSE - share * (GAP_SPARSE - GAP_DENSE))
}

/** The period of the dash pattern — dot plus gap. Exported for the tests and
 *  for anything that needs to reason about the travel in px rather than in
 *  CSS. */
export function periodFor(gap: number): number {
  return DOT + gap
}

export function readFlow(
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  report: PipelineReport,
): FlowReading {
  const reported = new Map(report.views.map((v) => [`${v.database}.${v.name}`, v]))

  // Only the views actually drawn. The report is server-wide, and counting a
  // broken pipeline in another database against a diagram that does not show it
  // is a figure nobody can reconcile with what is on screen.
  const pipes = new Map<string, Pipe>()
  for (const node of graph.nodes) {
    if (node.kind !== 'materialized_view') continue
    const id = nodeId(node)
    const view = reported.get(id)
    pipes.set(
      id,
      view
        ? pipeOf(view, report.log_available)
        : {
            state: 'unseen',
            rows: 0,
            measured: true,
            says: 'this server did not report it among its materialized views, so there is nothing to say about what it moved',
          },
    )
  }

  const measured = [...pipes.values()].filter((p) => p.state === 'carrying' && p.measured)
  const scale = barScale(measured.map((p) => p.rows))
  const busiest = measured.reduce((max, p) => Math.max(max, p.rows), 0)

  const edges = new Map<string, EdgeFlow>()
  for (const edge of graph.edges) {
    // A `writes` edge is the view emptying into its target; a `reads` edge is
    // the source feeding it. The same rows travel both, so both carry the
    // view's cadence — and both die when the view does, which is the whole
    // point of the structural check: a dropped target kills the *insert*, one
    // hop upstream of the view.
    const owner =
      edge.kind === 'writes' ? edge.from : edge.kind === 'reads' ? edge.to : undefined
    const pipe = owner ? pipes.get(owner) : undefined
    if (!pipe || !owner) {
      edges.set(edgeKey(edge), {
        state: 'inert',
        view: '',
        rows: 0,
        measured: true,
        gap: 0,
        past: false,
        says:
          edge.kind === 'loads'
            ? 'a dictionary loads on its own schedule; nothing travels this edge on insert'
            : 'a plain view is rewritten into the query that reads it — no rows ever move along this edge',
      })
      continue
    }
    const past = pipe.state === 'carrying' && pipe.measured && scale > 0 && pipe.rows > scale
    edges.set(edgeKey(edge), {
      state: pipe.state,
      view: owner,
      rows: pipe.rows,
      measured: pipe.measured,
      gap:
        pipe.state !== 'carrying'
          ? 0
          : pipe.measured
            ? gapFor(pipe.rows, scale)
            : GAP_UNMEASURED,
      past,
      says: `${owner.slice(owner.indexOf('.') + 1)}: ${pipe.says}`,
    })
  }

  return { edges, scale, busiest, windowDays: report.window_days, pipes }
}

/** The pipelines actually on screen, tallied.
 *
 *  `drawn` is what the layout put down, which after a filter is a subset of what
 *  was measured. A header that counts pipelines the diagram below it does not
 *  show is a header nobody can reconcile. */
export function flowCounts(reading: FlowReading, drawn: readonly GraphNode[]): FlowCounts {
  const here: Pipe[] = []
  for (const node of drawn) {
    const pipe = reading.pipes.get(nodeId(node))
    if (pipe) here.push(pipe)
  }
  const carrying = here.filter((p) => p.state === 'carrying')
  return {
    carrying: carrying.length,
    still: here.filter((p) => p.state === 'still').length,
    broken: here.filter((p) => p.state === 'broken').length,
    unseen: here.filter((p) => p.state === 'unseen').length,
    unmeasured: carrying.filter((p) => !p.measured).length,
    past: carrying.filter((p) => p.measured && reading.scale > 0 && p.rows > reading.scale).length,
    total: here.length,
  }
}

/** The chip at the foot of the diagram, and what it means in full.
 *
 *  An encoding nobody explains is decoration — the same rule the broken rail
 *  and the traffic bars already answer to. Every count that is not zero gets a
 *  sentence, because each of them sends a reader somewhere different: `still`
 *  to whatever should have been inserting, `broken` to the Pipelines page,
 *  `unseen` to the server's own configuration. */
export function flowLegend(
  reading: FlowReading,
  counts: FlowCounts,
): { label: string; title: string } | null {
  const { carrying, still, broken, unseen, unmeasured, past, total } = counts
  if (total === 0) return null

  const label =
    carrying === total
      ? `${total} view${total === 1 ? '' : 's'} carrying rows`
      : `${carrying} of ${total} views carrying rows`

  const lines: string[] = [
    carrying > 0 && reading.busiest > 0
      ? `Dot spacing is the rows each materialized view wrote in the last ${reading.windowDays} days, scaled against the busiest one measured here (${count(reading.busiest)} rows) and not rescaled by filtering. Every dot travels at the same speed, so a dense pipe is a busy one.`
      : `Dots would be the rows each materialized view wrote in the last ${reading.windowDays} days. Nothing here wrote any.`,
  ]
  if (past > 0) {
    lines.push(
      `${past} of them ${past === 1 ? 'carries' : 'carry'} more than the scale and ${past === 1 ? 'is' : 'are'} drawn at the densest spacing.`,
    )
  }
  if (unmeasured > 0) {
    lines.push(
      `${unmeasured} refreshable view${unmeasured === 1 ? '' : 's'} drawn at a neutral spacing: a refresh rewrites its target wholesale and reports no row count.`,
    )
  }
  if (still > 0) {
    lines.push(
      `${still} view${still === 1 ? '' : 's'} moved nothing in the window — working, with nothing inserted into ${still === 1 ? 'its' : 'their'} source.`,
    )
  }
  if (broken > 0) {
    lines.push(
      `${broken} cannot run at all. Hover the severed edge for what is wrong with it.`,
    )
  }
  if (unseen > 0) {
    lines.push(
      `${unseen} cannot be seen: without system.query_views_log there is no way to tell what passed through ${unseen === 1 ? 'it' : 'them'}.`,
    )
  }
  lines.push(
    'Plain views and dictionary loads move nothing when a row is inserted, so their edges never travel.',
  )

  return { label, title: lines.join('\n\n') }
}
