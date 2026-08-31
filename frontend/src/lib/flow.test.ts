import { describe, expect, it } from 'vitest'

import { flowCounts, flowLegend, gapFor, readFlow, type FlowReading } from './flow'
import type { GraphEdge, GraphNode } from './graph'
import type { PipelineReport, View } from './pipeline'

function node(name: string, kind: GraphNode['kind']): GraphNode {
  return {
    database: 'analytics',
    name,
    kind,
    engine: kind === 'table' ? 'MergeTree' : 'MaterializedView',
    comment: '',
    rows: 0,
    bytes: 0,
    columns: 3,
    external: false,
  }
}

function view(name: string, over: Partial<View> = {}): View {
  return {
    database: 'analytics',
    name,
    target: 'analytics.rollup',
    target_exists: true,
    refreshable: false,
    definition: 'SELECT 1',
    target_rows: 10,
    target_bytes: 100,
    last_write: '2026-08-01 00:00:00',
    runs: 4,
    failures: 0,
    written_rows: 1000,
    avg_ms: 3,
    last_run: '2026-08-01 00:00:00',
    last_error: '',
    refresh_status: '',
    last_refresh: '',
    last_success: '',
    next_refresh: '',
    refresh_exception: '',
    retry: 0,
    progress: 0,
    ...over,
  }
}

function report(views: View[], over: Partial<PipelineReport> = {}): PipelineReport {
  return { views, window_days: 7, log_available: true, refreshes_available: true, ...over }
}

/** One source, one materialized view, one target: the two edges every pipeline
 *  puts on the diagram. */
const PIPELINE = {
  nodes: [node('events', 'table'), node('hourly_mv', 'materialized_view'), node('rollup', 'table')],
  edges: [
    { from: 'analytics.events', to: 'analytics.hourly_mv', kind: 'reads' },
    { from: 'analytics.hourly_mv', to: 'analytics.rollup', kind: 'writes' },
  ] as GraphEdge[],
}

const READS = 'analytics.events->analytics.hourly_mv:reads'
const WRITES = 'analytics.hourly_mv->analytics.rollup:writes'

/** The counts as the legend takes them: over everything drawn. */
const counted = (flow: FlowReading, nodes: GraphNode[] = PIPELINE.nodes) => flowCounts(flow, nodes)

describe('readFlow', () => {
  it('carries both of a view’s edges when rows moved through it', () => {
    const flow = readFlow(PIPELINE, report([view('hourly_mv')]))
    const reads = flow.edges.get(READS)!
    const writes = flow.edges.get(WRITES)!
    expect(reads.state).toBe('carrying')
    expect(writes.state).toBe('carrying')
    // The same rows travel both, so they are drawn at the same cadence.
    expect(reads.gap).toBe(writes.gap)
    expect(counted(flow).carrying).toBe(1)
  })

  it('holds a view still when its source has had nothing inserted', () => {
    const flow = readFlow(PIPELINE, report([view('hourly_mv', { runs: 0, written_rows: 0 })]))
    expect(flow.edges.get(READS)!.state).toBe('still')
    expect(counted(flow).still).toBe(1)
  })

  it('holds a view still when it ran and wrote nothing — motion means rows', () => {
    const flow = readFlow(PIPELINE, report([view('hourly_mv', { written_rows: 0 })]))
    const edge = flow.edges.get(WRITES)!
    expect(edge.state).toBe('still')
    expect(edge.says).toContain('wrote no rows')
  })

  it('breaks both edges when the target is gone, including the one upstream', () => {
    const flow = readFlow(PIPELINE, report([view('hourly_mv', { target_exists: false })]))
    // The insert fails before the view runs, so the source's edge is dead too.
    expect(flow.edges.get(READS)!.state).toBe('broken')
    expect(flow.edges.get(WRITES)!.state).toBe('broken')
    expect(counted(flow).broken).toBe(1)
  })

  it('says unseen rather than still when the log cannot be read', () => {
    const flow = readFlow(
      PIPELINE,
      report([view('hourly_mv', { runs: 0, written_rows: 0 })], { log_available: false }),
    )
    expect(flow.edges.get(READS)!.state).toBe('unseen')
    expect(counted(flow).unseen).toBe(1)
  })

  it('draws a refreshable view without claiming to have measured it', () => {
    const flow = readFlow(
      PIPELINE,
      report([
        view('hourly_mv', {
          refreshable: true,
          refresh_status: 'Scheduled',
          last_success: '2026-08-27 12:00:00',
          runs: 0,
          written_rows: 0,
        }),
      ]),
    )
    const edge = flow.edges.get(WRITES)!
    expect(edge.state).toBe('carrying')
    expect(edge.measured).toBe(false)
    expect(counted(flow).unmeasured).toBe(1)
  })

  it('never moves a plain view’s edge, or a dictionary’s', () => {
    const nodes = [node('events', 'table'), node('errors', 'view'), node('cities', 'dictionary')]
    const edges: GraphEdge[] = [
      { from: 'analytics.events', to: 'analytics.errors', kind: 'reads' },
      { from: 'analytics.events', to: 'analytics.cities', kind: 'loads' },
    ]
    const flow = readFlow({ nodes, edges }, report([]))
    expect(flow.edges.get('analytics.events->analytics.errors:reads')!.state).toBe('inert')
    expect(flow.edges.get('analytics.events->analytics.cities:loads')!.state).toBe('inert')
    expect(counted(flow, nodes).total).toBe(0)
  })

  it('counts a view the report never mentioned as unseen rather than idle', () => {
    const flow = readFlow(PIPELINE, report([]))
    expect(flow.edges.get(WRITES)!.state).toBe('unseen')
    expect(counted(flow).unseen).toBe(1)
  })

  it('scales against the diagram, not the server', () => {
    const nodes = [
      node('events', 'table'),
      node('a_mv', 'materialized_view'),
      node('b_mv', 'materialized_view'),
    ]
    const edges: GraphEdge[] = [
      { from: 'analytics.events', to: 'analytics.a_mv', kind: 'reads' },
      { from: 'analytics.events', to: 'analytics.b_mv', kind: 'reads' },
    ]
    const flow = readFlow(
      { nodes, edges },
      // The third view is somewhere else on the server and is not drawn: it must
      // not set the scale for two pipes nobody can see it beside.
      report([
        view('a_mv', { written_rows: 100 }),
        view('b_mv', { written_rows: 1000 }),
        view('elsewhere', { written_rows: 10_000_000 }),
      ]),
    )
    expect(flow.busiest).toBe(1000)
    const quiet = flow.edges.get('analytics.events->analytics.a_mv:reads')!
    const busy = flow.edges.get('analytics.events->analytics.b_mv:reads')!
    expect(quiet.gap).toBeGreaterThan(busy.gap)
  })

  it('counts only what is drawn, while scaling against everything measured', () => {
    const nodes = [
      node('events', 'table'),
      node('a_mv', 'materialized_view'),
      node('b_mv', 'materialized_view'),
    ]
    const edges: GraphEdge[] = [
      { from: 'analytics.events', to: 'analytics.a_mv', kind: 'reads' },
      { from: 'analytics.events', to: 'analytics.b_mv', kind: 'reads' },
    ]
    const flow = readFlow(
      { nodes, edges },
      report([view('a_mv', { written_rows: 100 }), view('b_mv', { written_rows: 1000 })]),
    )
    // Filtering the diagram down to the quiet one leaves it drawn at its own
    // share of the busy one, not promoted to the top of a scale of one.
    const filtered = counted(flow, [nodes[0]!, nodes[1]!])
    expect(filtered.total).toBe(1)
    expect(flow.edges.get('analytics.events->analytics.a_mv:reads')!.gap).toBeGreaterThan(
      flow.edges.get('analytics.events->analytics.b_mv:reads')!.gap,
    )
  })
})

describe('gapFor', () => {
  it('puts the pipe at the scale at the densest spacing', () => {
    expect(gapFor(100, 100)).toBe(9)
    expect(gapFor(400, 100)).toBe(9)
  })

  it('keeps a trickle visible rather than rounding it to nothing', () => {
    expect(gapFor(1, 1_000_000)).toBeLessThanOrEqual(96)
    expect(gapFor(1, 1_000_000)).toBeGreaterThan(9)
  })

  it('falls back to a neutral spacing when there is no scale to compare against', () => {
    expect(gapFor(0, 0)).toBe(40)
  })
})

describe('flowLegend', () => {
  it('offers nothing on a schema with no pipeline in it', () => {
    const nodes = [node('events', 'table')]
    const flow = readFlow({ nodes, edges: [] }, report([]))
    expect(flowLegend(flow, flowCounts(flow, nodes))).toBeNull()
  })

  it('counts the pipes that moved rows, and names the scale', () => {
    const flow = readFlow(PIPELINE, report([view('hourly_mv')]))
    const legend = flowLegend(flow, counted(flow))!
    expect(legend.label).toBe('1 view carrying rows')
    expect(legend.title).toContain('1 K rows')
    expect(legend.title).toContain('last 7 days')
  })

  it('says what is not moving, and why', () => {
    const nodes = [
      node('events', 'table'),
      node('a_mv', 'materialized_view'),
      node('b_mv', 'materialized_view'),
    ]
    const edges: GraphEdge[] = [
      { from: 'analytics.events', to: 'analytics.a_mv', kind: 'reads' },
      { from: 'analytics.events', to: 'analytics.b_mv', kind: 'reads' },
    ]
    const flow = readFlow(
      { nodes, edges },
      report([view('a_mv'), view('b_mv', { target_exists: false })]),
    )
    const legend = flowLegend(flow, flowCounts(flow, nodes))!
    expect(legend.label).toBe('1 of 2 views carrying rows')
    expect(legend.title).toContain('1 cannot run at all')
  })
})
