import { describe, expect, it } from 'vitest'

import {
  defaultFocus,
  focusSubgraph,
  lineageSubgraph,
  layoutSchema,
  neighbourhood,
  nodeId,
  type GraphEdge,
  type GraphNode,
  type SchemaGraph,
} from './graph'

function node(name: string, over: Partial<GraphNode> = {}): GraphNode {
  return {
    database: 'analytics',
    name,
    kind: 'table',
    engine: 'MergeTree',
    comment: '',
    rows: 0,
    bytes: 0,
    columns: 0,
    external: false,
    ...over,
  }
}

const edge = (from: string, to: string, kind: GraphEdge['kind'] = 'reads'): GraphEdge => ({
  from: `analytics.${from}`,
  to: `analytics.${to}`,
  kind,
})

function graph(names: string[], edges: GraphEdge[]): SchemaGraph {
  return { database: 'analytics', nodes: names.map((n) => node(n)), edges }
}

const layerOf = (l: ReturnType<typeof layoutSchema>, name: string) =>
  l.nodes.find((n) => n.name === name)!.layer

describe('layoutSchema', () => {
  it('places a pipeline in left-to-right layers', () => {
    const l = layoutSchema(graph(['events', 'mv', 'rollup'], [edge('events', 'mv'), edge('mv', 'rollup', 'writes')]))
    expect(layerOf(l, 'events')).toBe(0)
    expect(layerOf(l, 'mv')).toBe(1)
    expect(layerOf(l, 'rollup')).toBe(2)
    expect(l.layers).toBe(3)
  })

  it('uses the longest path, so a node sits after everything feeding it', () => {
    // events -> mv -> rollup, and events -> rollup directly. rollup must land
    // in layer 2, past the mv, not in layer 1 beside it.
    const l = layoutSchema(
      graph(['events', 'mv', 'rollup'], [edge('events', 'mv'), edge('mv', 'rollup'), edge('events', 'rollup')]),
    )
    expect(layerOf(l, 'rollup')).toBe(2)
  })

  it('separates connected objects from standalone ones', () => {
    const l = layoutSchema(graph(['events', 'mv', 'lonely'], [edge('events', 'mv')]))
    expect(l.nodes.find((n) => n.name === 'lonely')!.band).toBe('standalone')
    expect(l.nodes.find((n) => n.name === 'events')!.band).toBe('flow')
    expect(l.standaloneY).toBeGreaterThan(0)
  })

  it('reports no standalone band when everything is connected', () => {
    const l = layoutSchema(graph(['a', 'b'], [edge('a', 'b')]))
    expect(l.standaloneY).toBeNull()
  })

  it('lays standalone objects out as a grid, not one long column', () => {
    const names = Array.from({ length: 9 }, (_, i) => `t${i}`)
    const l = layoutSchema(graph(names, []))
    const rows = new Set(l.nodes.map((n) => n.y))
    const cols = new Set(l.nodes.map((n) => n.x))
    expect(cols.size).toBeGreaterThan(1)
    expect(rows.size).toBeLessThan(names.length)
  })

  it('breaks a cycle into two columns rather than spreading it out', () => {
    const l = layoutSchema(graph(['a', 'b'], [edge('a', 'b'), edge('b', 'a')]))
    expect(l.nodes).toHaveLength(2)
    expect(l.edges).toHaveLength(2)
    // Both edges are kept, but the cycle occupies two layers, not five.
    expect(l.layers).toBe(2)
  })

  it('drops edges pointing at objects it was not given', () => {
    const l = layoutSchema(graph(['a'], [edge('a', 'ghost')]))
    expect(l.edges).toHaveLength(0)
    expect(l.nodes[0]!.band).toBe('standalone')
  })

  it('gives every edge a path and a midpoint', () => {
    const l = layoutSchema(graph(['a', 'b'], [edge('a', 'b')]))
    expect(l.edges[0]!.path).toMatch(/^M [\d.]+ [\d.]+ C /)
    expect(l.edges[0]!.mid.x).toBeGreaterThan(0)
  })

  it('bows a backwards edge outward rather than through the nodes', () => {
    const l = layoutSchema(graph(['a', 'b'], [edge('a', 'b'), edge('b', 'a')]))
    const byId = new Map(l.nodes.map((n) => [n.id, n]))
    // Identify the backwards edge geometrically: the one whose target sits at
    // or before its source.
    const backwards = l.edges.filter((e) => byId.get(e.to)!.x <= byId.get(e.from)!.x)
    const forwards = l.edges.filter((e) => byId.get(e.to)!.x > byId.get(e.from)!.x)
    expect(backwards).toHaveLength(1)
    expect(forwards).toHaveLength(1)
    expect(backwards[0]!.mid.y).toBeLessThan(forwards[0]!.mid.y)
  })

  it('centres a short column against a tall one', () => {
    // One source fanning into four views: the source should sit at the
    // vertical middle of the four, not at the top.
    const l = layoutSchema(
      graph(['src', 'v1', 'v2', 'v3', 'v4'], ['v1', 'v2', 'v3', 'v4'].map((v) => edge('src', v))),
    )
    const src = l.nodes.find((n) => n.name === 'src')!
    const views = l.nodes.filter((n) => n.name.startsWith('v'))
    const top = Math.min(...views.map((v) => v.y))
    const bottom = Math.max(...views.map((v) => v.y + v.h))
    const srcCentre = src.y + src.h / 2
    expect(srcCentre).toBeGreaterThan(top)
    expect(srcCentre).toBeLessThan(bottom)
    expect(Math.abs(srcCentre - (top + bottom) / 2)).toBeLessThan(1)
  })

  it('sizes the canvas to contain every node', () => {
    const l = layoutSchema(graph(['events', 'mv', 'rollup'], [edge('events', 'mv'), edge('mv', 'rollup')]))
    for (const n of l.nodes) {
      expect(n.x + n.w).toBeLessThanOrEqual(l.width)
      expect(n.y + n.h).toBeLessThanOrEqual(l.height)
    }
  })

  it('widens a node to fit a long name', () => {
    const l = layoutSchema(graph(['a', 'a_very_long_table_name_indeed'], []))
    const short = l.nodes.find((n) => n.name === 'a')!
    const long = l.nodes.find((n) => n.name !== 'a')!
    // Standalone cells share a width, so compare against the minimum instead.
    expect(long.w).toBeGreaterThanOrEqual(short.w)
    expect(long.w).toBeGreaterThan(168)
  })

  it('handles an empty database', () => {
    const l = layoutSchema({ database: 'empty', nodes: [], edges: [] })
    expect(l.nodes).toHaveLength(0)
    expect(l.width).toBeGreaterThan(0)
    expect(l.height).toBeGreaterThan(0)
  })
})

describe('neighbourhood', () => {
  it('collects both directions, one hop out', () => {
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('x', 'y')]
    const near = neighbourhood(edges, 'analytics.b')
    expect([...near].sort()).toEqual(['analytics.a', 'analytics.b', 'analytics.c'])
  })

  it('returns just the node when nothing touches it', () => {
    expect([...neighbourhood([], 'analytics.a')]).toEqual(['analytics.a'])
  })
})

describe('nodeId', () => {
  it('qualifies with the database', () => {
    expect(nodeId({ database: 'analytics', name: 'events' })).toBe('analytics.events')
  })
})

describe('long-edge routing', () => {
  it('routes an edge spanning several layers around the nodes between', () => {
    // src -> mid -> sink, plus src -> sink directly. The direct edge crosses
    // layer 1, where `mid` sits, so it must be routed rather than drawn
    // straight through.
    const l = layoutSchema(
      graph(['src', 'mid', 'sink'], [edge('src', 'mid'), edge('mid', 'sink'), edge('src', 'sink')]),
    )
    const long = l.edges.find((e) => e.from.endsWith('.src') && e.to.endsWith('.sink'))!
    const short = l.edges.find((e) => e.from.endsWith('.src') && e.to.endsWith('.mid'))!
    // A routed edge is a chain of cubics; a direct one is a single cubic.
    expect((long.path.match(/C/g) ?? []).length).toBeGreaterThan(1)
    expect((short.path.match(/C/g) ?? []).length).toBe(1)
  })

  it('reserves a lane, so the routed edge does not overlap the node it passes', () => {
    const l = layoutSchema(
      graph(['src', 'mid', 'sink'], [edge('src', 'mid'), edge('mid', 'sink'), edge('src', 'sink')]),
    )
    const mid = l.nodes.find((n) => n.name === 'mid')!
    const long = l.edges.find((e) => e.from.endsWith('.src') && e.to.endsWith('.sink'))!
    // The routed midpoint sits outside `mid`'s vertical extent.
    const clearsAbove = long.mid.y < mid.y
    const clearsBelow = long.mid.y > mid.y + mid.h
    expect(clearsAbove || clearsBelow).toBe(true)
  })

  it('still draws a single curve when the edge spans one layer', () => {
    const l = layoutSchema(graph(['a', 'b'], [edge('a', 'b')]))
    expect((l.edges[0]!.path.match(/C/g) ?? []).length).toBe(1)
  })

  it('keeps the diagram wide enough for the lanes it added', () => {
    const l = layoutSchema(
      graph(['src', 'mid', 'sink'], [edge('src', 'mid'), edge('mid', 'sink'), edge('src', 'sink')]),
    )
    for (const n of l.nodes) {
      expect(n.y).toBeGreaterThanOrEqual(0)
      expect(n.y + n.h).toBeLessThanOrEqual(l.height)
    }
  })
})

describe('focusSubgraph', () => {
  // src -> mid -> sink, and an unrelated pair.
  const g = graph(
    ['src', 'mid', 'sink', 'other', 'lonely'],
    [edge('src', 'mid'), edge('mid', 'sink'), edge('other', 'lonely')],
  )

  it('keeps one hop in both directions', () => {
    const { graph: f, hidden } = focusSubgraph(g, 'analytics.mid', 1)
    expect(f.nodes.map((n) => n.name).sort()).toEqual(['mid', 'sink', 'src'])
    expect(hidden).toBe(2)
  })

  it('reaches further with more hops', () => {
    const { graph: f } = focusSubgraph(g, 'analytics.src', 2)
    expect(f.nodes.map((n) => n.name).sort()).toEqual(['mid', 'sink', 'src'])
  })

  it('keeps only edges with both ends in view', () => {
    const { graph: f } = focusSubgraph(g, 'analytics.src', 1)
    expect(f.edges).toHaveLength(1)
    expect(f.nodes.map((n) => n.name).sort()).toEqual(['mid', 'src'])
  })

  it('returns nothing for a root that is not in the graph', () => {
    const { graph: f, hidden } = focusSubgraph(g, 'analytics.ghost', 2)
    expect(f.nodes).toHaveLength(0)
    expect(hidden).toBe(5)
  })

  it('caps a wide fan-out and reports what it dropped', () => {
    const names = ['hub', ...Array.from({ length: 20 }, (_, i) => `v${i}`)]
    const wide = graph(names, names.slice(1).map((v) => edge('hub', v)))
    const { graph: f, capped } = focusSubgraph(wide, 'analytics.hub', 1)
    // 8 neighbours plus the hub itself.
    expect(f.nodes).toHaveLength(9)
    expect(capped).toEqual([{ id: 'analytics.hub', hidden: 12 }])
  })

  it('keeps the biggest neighbours when it has to choose', () => {
    const nodes = [
      node('hub'),
      node('small', { rows: 10 }),
      node('big', { rows: 1_000_000 }),
    ]
    const wide: SchemaGraph = {
      database: 'analytics',
      nodes,
      edges: [edge('hub', 'small'), edge('hub', 'big')],
    }
    // With room for both, order does not matter; with room for one it must
    // keep `big`. Re-run at a cap of one by giving the hub many tiny peers.
    const many: SchemaGraph = {
      database: 'analytics',
      nodes: [
        node('hub'),
        node('big', { rows: 1_000_000 }),
        ...Array.from({ length: 12 }, (_, i) => node(`t${i}`, { rows: 1 })),
      ],
      edges: [
        edge('hub', 'big'),
        ...Array.from({ length: 12 }, (_, i) => edge('hub', `t${i}`)),
      ],
    }
    expect(focusSubgraph(wide, 'analytics.hub', 1).graph.nodes).toHaveLength(3)
    expect(
      focusSubgraph(many, 'analytics.hub', 1).graph.nodes.map((n) => n.name),
    ).toContain('big')
  })
})

describe('defaultFocus', () => {
  it('never opens on the hidden table behind a materialized view', () => {
    // These are usually the biggest objects in the schema and their names are
    // uuids; the view they belong to is on the canvas already.
    const g: SchemaGraph = {
      database: 'analytics',
      nodes: [
        node('.inner_id.0f8c9e21-4b3a-4d5e-9a71-2c6d84f0b1e3', { bytes: 10_000_000_000 }),
        node('.inner.old_style_view', { bytes: 9_000_000_000 }),
        node('events', { bytes: 10 }),
      ],
      edges: [],
    }
    expect(defaultFocus(g)).toBe('analytics.events')
  })

  it('prefers a smaller object that is part of a pipeline to a large loner', () => {
    // The page is about how data moves. A diagram of one box captioned "not
    // referenced by anything else" is the one view that cannot show that.
    const g: SchemaGraph = {
      database: 'analytics',
      nodes: [
        node('lookup', { bytes: 10_000_000 }),
        node('events', { bytes: 100 }),
        node('events_rollup', { bytes: 50 }),
      ],
      edges: [{ from: 'analytics.events', to: 'analytics.events_rollup', kind: 'reads' }],
    }
    expect(defaultFocus(g)).toBe('analytics.events')
  })

  it('falls back to a loner when nothing in the database is connected', () => {
    const g: SchemaGraph = {
      database: 'analytics',
      nodes: [node('lookup', { bytes: 10_000_000 }), node('other', { bytes: 1 })],
      edges: [],
    }
    expect(defaultFocus(g)).toBe('analytics.lookup')
  })

  it('opens on a hidden table only when there is nothing else at all', () => {
    const g: SchemaGraph = {
      database: 'analytics',
      nodes: [node('.inner_id.abc', { bytes: 10 })],
      edges: [],
    }
    expect(defaultFocus(g)).toBe('analytics..inner_id.abc')
  })

  it('opens on the biggest table', () => {
    const g: SchemaGraph = {
      database: 'analytics',
      nodes: [
        node('small', { bytes: 10 }),
        node('huge', { bytes: 10_000_000 }),
        node('a_view', { kind: 'view', bytes: 0 }),
      ],
      edges: [],
    }
    expect(defaultFocus(g)).toBe('analytics.huge')
  })

  it('falls back to any object when there are no tables', () => {
    const g: SchemaGraph = {
      database: 'analytics',
      nodes: [node('only_view', { kind: 'view' })],
      edges: [],
    }
    expect(defaultFocus(g)).toBe('analytics.only_view')
  })

  it('returns nothing for an empty database', () => {
    expect(defaultFocus({ database: 'x', nodes: [], edges: [] })).toBeUndefined()
  })
})

describe('layout direction', () => {
  const pipeline = graph(
    ['src', 'mid', 'sink'],
    [edge('src', 'mid'), edge('mid', 'sink', 'writes')],
  )

  it('advances along x when flowing left to right', () => {
    const l = layoutSchema(pipeline, 'lr')
    const [src, mid, sink] = ['src', 'mid', 'sink'].map(
      (n) => l.nodes.find((x) => x.name === n)!,
    )
    expect(src!.x).toBeLessThan(mid!.x)
    expect(mid!.x).toBeLessThan(sink!.x)
    // A single object per stage: they share a row.
    expect(src!.y).toBe(mid!.y)
    expect(l.direction).toBe('lr')
  })

  it('advances along y when flowing top to bottom', () => {
    const l = layoutSchema(pipeline, 'tb')
    const [src, mid, sink] = ['src', 'mid', 'sink'].map(
      (n) => l.nodes.find((x) => x.name === n)!,
    )
    expect(src!.y).toBeLessThan(mid!.y)
    expect(mid!.y).toBeLessThan(sink!.y)
    expect(src!.x).toBe(mid!.x)
    expect(l.direction).toBe('tb')
  })

  it('transposes the overall shape', () => {
    // Four objects fanning out of one. The absolute aspect of either layout
    // depends on how a node's width compares to its height, so the invariant
    // worth asserting is the relationship between the two: turning the flow
    // spends the objects of a stage on the other axis.
    const fan = graph(
      ['src', 'a', 'b', 'c', 'd'],
      ['a', 'b', 'c', 'd'].map((v) => edge('src', v)),
    )
    const lr = layoutSchema(fan, 'lr')
    const tb = layoutSchema(fan, 'tb')
    expect(tb.width).toBeGreaterThan(lr.width)
    expect(tb.height).toBeLessThan(lr.height)
  })

  it('leaves and arrives along the flow axis', () => {
    const lr = layoutSchema(pipeline, 'lr')
    const tb = layoutSchema(pipeline, 'tb')
    const first = (l: ReturnType<typeof layoutSchema>) => {
      const e = l.edges.find((x) => x.from.endsWith('.src'))!
      const from = l.nodes.find((n) => n.id === e.from)!
      const nums = e.path.match(/-?[\d.]+/g)!.map(Number)
      return { from, startX: nums[0]!, startY: nums[1]! }
    }
    // Left to right: the edge starts on the node's right edge, mid-height.
    const a = first(lr)
    expect(a.startX).toBeCloseTo(a.from.x + a.from.w, 0)
    expect(a.startY).toBeCloseTo(a.from.y + a.from.h / 2, 0)
    // Top to bottom: on the bottom edge, mid-width.
    const b = first(tb)
    expect(b.startX).toBeCloseTo(b.from.x + b.from.w / 2, 0)
    expect(b.startY).toBeCloseTo(b.from.y + b.from.h, 0)
  })

  it('routes long edges in both directions', () => {
    const g = graph(
      ['src', 'mid', 'sink'],
      [edge('src', 'mid'), edge('mid', 'sink'), edge('src', 'sink')],
    )
    for (const dir of ['lr', 'tb'] as const) {
      const l = layoutSchema(g, dir)
      const long = l.edges.find((e) => e.from.endsWith('.src') && e.to.endsWith('.sink'))!
      expect((long.path.match(/C/g) ?? []).length).toBeGreaterThan(1)
    }
  })

  it('contains every node in both directions', () => {
    for (const dir of ['lr', 'tb'] as const) {
      const l = layoutSchema(graph(['a', 'b', 'lonely'], [edge('a', 'b')]), dir)
      for (const n of l.nodes) {
        expect(n.x + n.w).toBeLessThanOrEqual(l.width)
        expect(n.y + n.h).toBeLessThanOrEqual(l.height)
      }
    }
  })

  it('defaults to left to right', () => {
    expect(layoutSchema(pipeline).direction).toBe('lr')
  })
})

describe('database boxes', () => {
  const crossDb = (): SchemaGraph => ({
    database: 'analytics',
    nodes: [
      node('events'),
      node('rollup'),
      { ...node('cities'), database: 'reference', external: true },
      { ...node('city_dict'), database: 'reference', kind: 'dictionary', external: true },
    ],
    edges: [
      { from: 'analytics.events', to: 'analytics.rollup', kind: 'reads' },
      { from: 'reference.cities', to: 'reference.city_dict', kind: 'loads' },
      { from: 'reference.city_dict', to: 'analytics.rollup', kind: 'reads' },
    ],
  })

  it('draws no box when only one database is on screen', () => {
    expect(layoutSchema(graph(['a', 'b'], [edge('a', 'b')])).boxes).toHaveLength(0)
  })

  it('draws one box per database once the diagram crosses a boundary', () => {
    const l = layoutSchema(crossDb())
    expect(l.boxes.map((b) => b.database).sort()).toEqual(['analytics', 'reference'])
  })

  it('contains every node of its own database', () => {
    const l = layoutSchema(crossDb())
    for (const box of l.boxes) {
      for (const n of l.nodes.filter((x) => x.database === box.database)) {
        expect(n.x).toBeGreaterThanOrEqual(box.x)
        expect(n.y).toBeGreaterThanOrEqual(box.y)
        expect(n.x + n.w).toBeLessThanOrEqual(box.x + box.w)
        expect(n.y + n.h).toBeLessThanOrEqual(box.y + box.h)
      }
    }
  })

  it('keeps the boxes from overlapping', () => {
    for (const dir of ['lr', 'tb'] as const) {
      const [a, b] = layoutSchema(crossDb(), dir).boxes
      const disjoint =
        a!.x + a!.w <= b!.x || b!.x + b!.w <= a!.x || a!.y + a!.h <= b!.y || b!.y + b!.h <= a!.y
      expect(disjoint).toBe(true)
    }
  })

  it('keeps the boxes inside the canvas', () => {
    const l = layoutSchema(crossDb())
    for (const box of l.boxes) {
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.x + box.w).toBeLessThanOrEqual(l.width)
      expect(box.y + box.h).toBeLessThanOrEqual(l.height)
    }
  })
})

describe('lineageSubgraph', () => {
  /** raw -> staged -> rollup -> report, with a second consumer hanging off the
   *  shared source and a second producer feeding the shared sink. */
  const chain: SchemaGraph = {
    database: 'analytics',
    nodes: [
      node('raw_orders'),
      node('staged_orders', { kind: 'materialized_view' }),
      node('daily_orders'),
      node('report', { kind: 'view' }),
      node('unrelated_export', { kind: 'view' }),
      node('raw_returns'),
    ],
    edges: [
      { from: 'analytics.raw_orders', to: 'analytics.staged_orders', kind: 'reads' },
      { from: 'analytics.staged_orders', to: 'analytics.daily_orders', kind: 'writes' },
      { from: 'analytics.daily_orders', to: 'analytics.report', kind: 'reads' },
      // A sibling: another consumer of the same source, not on the path.
      { from: 'analytics.raw_orders', to: 'analytics.unrelated_export', kind: 'reads' },
      // A second producer of the sink, upstream of nothing we asked about.
      { from: 'analytics.raw_returns', to: 'analytics.daily_orders', kind: 'reads' },
    ],
  }
  const names = (g: SchemaGraph) => g.nodes.map((n) => n.name).sort()

  it('reaches the source and the leaf from the middle', () => {
    const { graph } = lineageSubgraph(chain, 'analytics.staged_orders')
    expect(names(graph)).toEqual(['daily_orders', 'raw_orders', 'report', 'staged_orders'])
  })

  it('leaves out a sibling consumer of the same source', () => {
    const { graph } = lineageSubgraph(chain, 'analytics.staged_orders')
    expect(names(graph)).not.toContain('unrelated_export')
  })

  it('picks up another producer when it is genuinely upstream of you', () => {
    // From `report`, `raw_returns` is an ancestor: its rows reach the report
    // through `daily_orders`.
    expect(names(lineageSubgraph(chain, 'analytics.report').graph)).toContain('raw_returns')
  })

  it('leaves out a co-producer that is neither before nor after you', () => {
    // From `staged_orders`, `raw_returns` is not an ancestor and not a
    // descendant — it merely feeds the same sink. This is the line between a
    // path and a neighbourhood, and it is where the two part company.
    expect(names(lineageSubgraph(chain, 'analytics.staged_orders').graph)).not.toContain(
      'raw_returns',
    )
  })

  it('counts what it leaves out', () => {
    const { hidden } = lineageSubgraph(chain, 'analytics.staged_orders')
    expect(hidden).toBe(2)
  })

  it('keeps only edges with both ends on the path', () => {
    const { graph } = lineageSubgraph(chain, 'analytics.staged_orders')
    expect(graph.edges.map((e) => `${e.from}->${e.to}`)).toEqual([
      'analytics.raw_orders->analytics.staged_orders',
      'analytics.staged_orders->analytics.daily_orders',
      'analytics.daily_orders->analytics.report',
    ])
  })

  it('from a source, walks the whole way down', () => {
    const { graph } = lineageSubgraph(chain, 'analytics.raw_orders')
    expect(names(graph)).toEqual([
      'daily_orders',
      'raw_orders',
      'report',
      'staged_orders',
      'unrelated_export',
    ])
  })

  it('keeps both sides of a diamond', () => {
    const diamond: SchemaGraph = {
      database: 'analytics',
      nodes: [node('src'), node('left'), node('right'), node('sink')],
      edges: [
        { from: 'analytics.src', to: 'analytics.left', kind: 'reads' },
        { from: 'analytics.src', to: 'analytics.right', kind: 'reads' },
        { from: 'analytics.left', to: 'analytics.sink', kind: 'reads' },
        { from: 'analytics.right', to: 'analytics.sink', kind: 'reads' },
      ],
    }
    expect(names(lineageSubgraph(diamond, 'analytics.sink').graph)).toEqual([
      'left',
      'right',
      'sink',
      'src',
    ])
  })

  it('does not hang on a cycle', () => {
    const loop: SchemaGraph = {
      database: 'analytics',
      nodes: [node('a'), node('b'), node('outside')],
      edges: [
        { from: 'analytics.a', to: 'analytics.b', kind: 'reads' },
        { from: 'analytics.b', to: 'analytics.a', kind: 'reads' },
      ],
    }
    expect(names(lineageSubgraph(loop, 'analytics.a').graph)).toEqual(['a', 'b'])
  })

  it('draws an object that is on nobody path but its own', () => {
    const { graph } = lineageSubgraph(chain, 'analytics.unrelated_export')
    expect(names(graph)).toEqual(['raw_orders', 'unrelated_export'])
  })

  it('returns nothing for an object that is not there', () => {
    const { graph, hidden } = lineageSubgraph(chain, 'analytics.ghost')
    expect(graph.nodes).toEqual([])
    expect(hidden).toBe(chain.nodes.length)
  })
})
