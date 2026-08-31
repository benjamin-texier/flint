/** How far the path an object sits on reaches, in each direction.
 *
 *  The path itself is *drawn* — `lineageSubgraph` picks the objects out and the
 *  schema canvas draws them, the same canvas the database page uses, so the two
 *  cannot disagree about what a path is. This measures it.
 *
 *  It was the drawing too, once: a chain of rows, one hop each, on the argument
 *  that a chain is honest about depth in a way a picture is not. Half of that
 *  was right. Depth is exactly what a diagram of six boxes does not tell you at
 *  a glance — so it survives here, in the caption above the picture — and the
 *  rest of the chain was a worse diagram than the diagram.
 *
 *  Built from the graph the page already has, which is scoped to one database
 *  plus the neighbours it references. So a path can *stop* at an object from
 *  elsewhere whose own sources were never fetched, and that is said rather than
 *  presented as the end of the line — see `incomplete`, which is the other
 *  thing here the drawing cannot say. */

import { nodeId, lineageSubgraph, type GraphNode, type SchemaGraph } from './graph'

export interface Step {
  id: string
  database: string
  name: string
  kind: string
  /** True for an object outside the database this graph was built for: its own
   *  lineage is not in hand, so the path may continue beyond it. */
  external: boolean
}

export interface Level {
  /** 1 is the immediate neighbour; 2 is its neighbour, and so on. */
  depth: number
  steps: Step[]
}

export interface Path {
  upstream: Level[]
  downstream: Level[]
  /** Objects on the path whose own lineage was not loaded, so the chain may go
   *  further than it shows. */
  incomplete: Step[]
}

const stepOf = (node: GraphNode): Step => ({
  id: nodeId(node),
  database: node.database,
  name: node.name,
  kind: node.kind,
  external: node.external,
})

/** Levels away from the root, following the arrows one way only.
 *
 *  An object reachable by two routes of different length sits at its *shortest*
 *  distance: it is one hop from the root if any single hop reaches it, and
 *  saying otherwise would put the same object on two rows. */
function levelsFrom(
  rootId: string,
  adjacency: Map<string, string[]>,
  nodes: Map<string, GraphNode>,
): Level[] {
  const seen = new Set<string>([rootId])
  const levels: Level[] = []
  let frontier = [rootId]
  let depth = 1
  while (frontier.length > 0) {
    const next: string[] = []
    for (const id of frontier) {
      for (const neighbour of adjacency.get(id) ?? []) {
        if (seen.has(neighbour)) continue
        seen.add(neighbour)
        next.push(neighbour)
      }
    }
    if (next.length === 0) break
    const steps = next
      .map((id) => nodes.get(id))
      .filter((n): n is GraphNode => Boolean(n))
      .map(stepOf)
      .sort((a, b) => a.database.localeCompare(b.database) || a.name.localeCompare(b.name))
    if (steps.length > 0) levels.push({ depth, steps })
    frontier = next
    depth += 1
  }
  return levels
}

export function lineagePath(graph: SchemaGraph, rootId: string): Path {
  const { graph: onPath } = lineageSubgraph(graph, rootId)
  const nodes = new Map(onPath.nodes.map((n) => [nodeId(n), n]))
  if (!nodes.has(rootId)) return { upstream: [], downstream: [], incomplete: [] }

  const upstream = new Map<string, string[]>()
  const downstream = new Map<string, string[]>()
  for (const edge of onPath.edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue
    if (!downstream.has(edge.from)) downstream.set(edge.from, [])
    if (!upstream.has(edge.to)) upstream.set(edge.to, [])
    downstream.get(edge.from)!.push(edge.to)
    upstream.get(edge.to)!.push(edge.from)
  }

  const up = levelsFrom(rootId, upstream, nodes)
  const down = levelsFrom(rootId, downstream, nodes)
  // An external object's own sources were never fetched, so a path that ends on
  // one has not necessarily ended.
  const incomplete = [...up, ...down]
    .flatMap((level) => level.steps)
    .filter((step) => step.external)
  return { upstream: up, downstream: down, incomplete }
}

/** How far the path reaches, for a one-line summary. */
export function depthOf(path: Path): { up: number; down: number } {
  return {
    up: path.upstream.length,
    down: path.downstream.length,
  }
}
