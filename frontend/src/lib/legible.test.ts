import { describe, expect, it } from 'vitest'

import { legible, type SchemaGraph, type GraphNode } from './graph'

const node = (name: string): GraphNode => ({
  database: 'default',
  name,
  kind: 'table',
  engine: 'MergeTree',
  comment: '',
  rows: 1000,
  bytes: 1000,
  columns: 4,
  external: false,
})

const graph = (nodes: GraphNode[], edges: SchemaGraph['edges'] = []): SchemaGraph => ({
  database: 'default',
  nodes,
  edges,

})

/** A chain: `t0 → t1 → … → tn`. Deep and narrow, so it lays out as a long line
 *  of stages one node tall. */
function chain(n: number): SchemaGraph {
  const nodes = Array.from({ length: n }, (_, i) => node(`t${i}`))
  const edges = Array.from({ length: n - 1 }, (_, i) => ({
    from: `default.t${i}`,
    to: `default.t${i + 1}`,
    kind: 'reads' as const,
  }))
  return graph(nodes, edges)
}

/** A fan: one source read by `n` others. Two stages, and the second is `n` nodes
 *  across. */
function fan(n: number): SchemaGraph {
  const nodes = [node('src'), ...Array.from({ length: n }, (_, i) => node(`leaf${i}`))]
  const edges = Array.from({ length: n }, (_, i) => ({
    from: 'default.src',
    to: `default.leaf${i}`,
    kind: 'reads' as const,
  }))
  return graph(nodes, edges)
}

describe('whether a schema can be drawn whole and still read', () => {
  it('says yes to a small schema', () => {
    expect(legible(chain(4))).toBe(true)
    expect(legible(graph([node('a'), node('b'), node('c')]))).toBe(true)
  })

  it('says no to a graph nobody could read', () => {
    /* The case that made this a measurement rather than a count. 155 objects in
       three stages lays out around sixty nodes across one axis; at the frame the
       section gives it that is a fifth of full size — a ribbon of grey texture
       where the labels should be. */
    expect(legible(fan(120))).toBe(false)
    expect(legible(chain(60))).toBe(false)
  })

  it('draws a wide grid of unrelated tables whole', () => {
    /* The case the change was asked for. A schema of seventy tables that barely
       reference each other lays out as a *grid*, about 2000px tall, and there is
       room for that — it was only ever refused because a node count cannot tell a
       grid from a fan. */
    expect(legible(graph(Array.from({ length: 60 }, (_, i) => node(`t${i}`))))).toBe(true)
  })

  it('judges by shape, not by how many objects there are', () => {
    /* The whole argument for the function, and the numbers are measured rather
       than chosen: twenty objects in one chain lay out 5,164px wide and twenty in
       a fan 1,954px tall, so one fits the frame and the other does not. A
       threshold on `nodes.length` gets one of the two wrong whatever number you
       pick. */
    expect(legible(fan(20))).toBe(true)
    expect(legible(chain(20))).toBe(false)
  })

  it('does not fall over on an empty graph', () => {
    expect(legible(graph([]))).toBe(true)
  })
})
