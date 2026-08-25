import { describe, expect, it } from 'vitest'
import { depthOf, lineagePath } from './path'
import type { SchemaGraph } from './graph'

/** raw.events → analytics.hourly_mv → analytics.hourly_rollup → analytics.report
 *  with analytics.other_mv also reading raw.events (a sibling, not on the path). */
const graph = (): SchemaGraph => ({
  database: 'analytics',
  nodes: [
    node('raw', 'events', 'table', true),
    node('analytics', 'hourly_mv', 'materialized_view'),
    node('analytics', 'hourly_rollup', 'table'),
    node('analytics', 'report', 'view'),
    node('analytics', 'other_mv', 'materialized_view'),
  ],
  edges: [
    { from: 'raw.events', to: 'analytics.hourly_mv', kind: 'reads' },
    { from: 'analytics.hourly_mv', to: 'analytics.hourly_rollup', kind: 'writes' },
    { from: 'analytics.hourly_rollup', to: 'analytics.report', kind: 'reads' },
    { from: 'raw.events', to: 'analytics.other_mv', kind: 'reads' },
  ],
})

function node(
  database: string,
  name: string,
  kind: 'table' | 'view' | 'materialized_view' | 'dictionary',
  external = false,
) {
  return {
    database,
    name,
    kind,
    engine: '',
    comment: '',
    rows: 0,
    bytes: 0,
    columns: 0,
    external,
  }
}

describe('lineagePath', () => {
  it('walks all the way up and all the way down', () => {
    const path = lineagePath(graph(), 'analytics.hourly_rollup')
    expect(path.upstream.map((l) => l.steps.map((s) => s.name))).toEqual([
      ['hourly_mv'],
      ['events'],
    ])
    expect(path.downstream.map((l) => l.steps.map((s) => s.name))).toEqual([['report']])
  })

  it('does not wander sideways onto a sibling', () => {
    // `other_mv` also reads raw.events, but it is not on this object's path.
    const path = lineagePath(graph(), 'analytics.hourly_rollup')
    const names = [...path.upstream, ...path.downstream].flatMap((l) => l.steps.map((s) => s.name))
    expect(names).not.toContain('other_mv')
  })

  it('numbers the hops from the object outwards', () => {
    const path = lineagePath(graph(), 'analytics.report')
    expect(path.upstream.map((l) => l.depth)).toEqual([1, 2, 3])
    expect(path.upstream[2]!.steps[0]!.name).toBe('events')
  })

  it('says where the chain may continue beyond what was loaded', () => {
    // raw.events comes from another database: its own sources are not in hand.
    const path = lineagePath(graph(), 'analytics.hourly_rollup')
    expect(path.incomplete.map((s) => s.id)).toEqual(['raw.events'])
  })

  it('puts an object at its shortest distance, not on two rows', () => {
    const g = graph()
    // A shortcut: report also reads raw.events directly.
    g.edges.push({ from: 'raw.events', to: 'analytics.report', kind: 'reads' })
    const path = lineagePath(g, 'analytics.report')
    const rows = path.upstream.map((l) => l.steps.map((s) => s.name))
    expect(rows[0]).toContain('events')
    expect(rows.slice(1).flat()).not.toContain('events')
  })

  it('is empty for an object the graph does not hold', () => {
    const path = lineagePath(graph(), 'nowhere.at_all')
    expect(path).toEqual({ upstream: [], downstream: [], incomplete: [] })
  })

  it('is empty both ways for an object on nobody’s path', () => {
    const g = graph()
    g.nodes.push(node('analytics', 'alone', 'table'))
    const path = lineagePath(g, 'analytics.alone')
    expect(path.upstream).toEqual([])
    expect(path.downstream).toEqual([])
  })
})

describe('depthOf', () => {
  it('counts the hops each way', () => {
    expect(depthOf(lineagePath(graph(), 'analytics.hourly_rollup'))).toEqual({ up: 2, down: 1 })
  })
})
