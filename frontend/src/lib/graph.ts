/** Turning a schema into a diagram.
 *
 *  A ClickHouse schema is a flow, not a web: raw tables on the left, the
 *  materialized views that consume them next, the tables those write into
 *  after that. So this lays the graph out in layers left-to-right, which
 *  makes the direction of data movement the primary thing you read — a
 *  force-directed blob would throw that information away.
 *
 *  Everything here is pure so the layout can be tested without a browser. */

export type ObjectKind = 'table' | 'view' | 'materialized_view' | 'dictionary'
export type EdgeKind = 'reads' | 'writes' | 'loads'

export interface GraphNode {
  database: string
  name: string
  kind: ObjectKind
  engine: string
  comment: string
  rows: number
  bytes: number
  columns: number
  external: boolean
}

export interface GraphEdge {
  from: string
  to: string
  kind: EdgeKind
}

export interface SchemaGraph {
  database: string
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface PlacedNode extends GraphNode {
  id: string
  x: number
  y: number
  w: number
  h: number
  layer: number
  /** How this node relates to the rest: part of a pipeline, or on its own. */
  band: 'flow' | 'standalone'
}

export interface PlacedEdge extends GraphEdge {
  id: string
  path: string
  /** Midpoint, for placing a label or a flow marker. */
  mid: { x: number; y: number }
}

/** A labelled container around everything belonging to one database.
 *
 *  Borrowed from Kiali, which boxes a mesh graph by namespace: when a diagram
 *  reaches across boundaries, the boundary is itself information. Only produced
 *  when more than one database is on screen — a box around the only database
 *  present is a frame around the frame. */
export interface GroupBox {
  database: string
  x: number
  y: number
  w: number
  h: number
}

export interface Layout {
  nodes: PlacedNode[]
  edges: PlacedEdge[]
  boxes: GroupBox[]
  width: number
  height: number
  /** Where the standalone band starts, so a divider can be drawn. */
  standaloneY: number | null
  layers: number
  direction: Direction
}

export const NODE_H = 74
const NODE_MIN_W = 168
const NODE_MAX_W = 268
const PAD = 28
const BAND_GAP = 64

/** Which way the data flows across the page.
 *
 *  `lr` puts each stage in a column and stacks the objects of a stage
 *  vertically; `tb` does the opposite. Neither is better in the abstract — it
 *  depends entirely on whether the schema is deep with few objects per stage or
 *  shallow with many, and on the shape of the viewport. So Flint lays the graph
 *  out both ways and keeps whichever fits. */
export type Direction = 'lr' | 'tb'

/** Gap between stages, and between objects within a stage. Larger along the
 *  flow axis, because that is where the edges need room to be read. */
const GAPS: Record<Direction, { main: number; cross: number }> = {
  lr: { main: 92, cross: 22 },
  tb: { main: 76, cross: 30 },
}

/** How much room a placeholder takes across the stage it passes through. */
const VIRTUAL_CROSS: Record<Direction, number> = { lr: 14, tb: 26 }

/** Padding around a database box, and the clear space between two of them.
 *  The separation has to exceed twice the padding or adjacent boxes touch. */
const BOX_PAD = 16
const BOX_LABEL = 14
const BAND_SEP = BOX_PAD * 2 + 24

export function nodeId(node: { database: string; name: string }): string {
  return `${node.database}.${node.name}`
}

/** Wide enough for the name at the size the canvas draws it. */
function nodeWidth(node: GraphNode): number {
  const chars = Math.max(node.name.length, node.engine.length + 2)
  return Math.min(NODE_MAX_W, Math.max(NODE_MIN_W, 34 + chars * 7.6))
}

export function edgeKey(edge: GraphEdge): string {
  return `${edge.from}->${edge.to}:${edge.kind}`
}

/** Find the edges that close a cycle, so layering can ignore them.
 *
 *  Without this a pair of views selecting from each other pushes each other
 *  rightwards on every pass and two objects end up spread over five columns.
 *  A back edge is one pointing at a node still on the DFS stack; it is
 *  excluded from layering but still drawn, bowed, so the cycle stays visible.
 *  The traversal is iterative because a schema can be deeper than the JS
 *  call stack is willing to go. */
function findBackEdges(ids: string[], edges: GraphEdge[]): Set<string> {
  const outgoing = new Map<string, GraphEdge[]>()
  for (const edge of edges) {
    const list = outgoing.get(edge.from)
    if (list) list.push(edge)
    else outgoing.set(edge.from, [edge])
  }

  const UNVISITED = 0, ON_STACK = 1, DONE = 2
  const state = new Map<string, number>()
  const back = new Set<string>()

  for (const root of ids) {
    if ((state.get(root) ?? UNVISITED) !== UNVISITED) continue
    // Each frame tracks how far through its own edge list we have walked.
    const stack: { id: string; next: number }[] = [{ id: root, next: 0 }]
    state.set(root, ON_STACK)
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const list = outgoing.get(frame.id) ?? []
      if (frame.next >= list.length) {
        state.set(frame.id, DONE)
        stack.pop()
        continue
      }
      const edge = list[frame.next]!
      frame.next += 1
      const target = state.get(edge.to) ?? UNVISITED
      if (target === ON_STACK) back.add(edgeKey(edge))
      else if (target === UNVISITED) {
        state.set(edge.to, ON_STACK)
        stack.push({ id: edge.to, next: 0 })
      }
    }
  }
  return back
}

/** Longest-path layering over the acyclic edges: a node sits one column past
 *  everything that feeds it. */
function assignLayers(ids: string[], edges: GraphEdge[]): Map<string, number> {
  const layer = new Map(ids.map((id) => [id, 0]))
  for (let pass = 0; pass <= ids.length; pass += 1) {
    let moved = false
    for (const edge of edges) {
      const from = layer.get(edge.from)
      const to = layer.get(edge.to)
      if (from === undefined || to === undefined) continue
      if (to < from + 1) {
        layer.set(edge.to, from + 1)
        moved = true
      }
    }
    if (!moved) break
  }
  return layer
}

/** Order nodes within each layer by the average position of their neighbours,
 *  which is the cheap classic way to pull connected nodes into line and cut
 *  edge crossings. A few alternating sweeps is enough at schema scale. */
function orderLayers(
  columns: { id: string }[][],
  edges: GraphEdge[],
  /** Band index per node, so same-database nodes stay together in every stage.
   *  Without it a database's nodes interleave with another's and no rectangle
   *  can contain one without swallowing part of the other. */
  band: (id: string) => number = () => 0,
): void {
  const predecessors = new Map<string, string[]>()
  const successors = new Map<string, string[]>()
  for (const edge of edges) {
    if (!predecessors.has(edge.to)) predecessors.set(edge.to, [])
    if (!successors.has(edge.from)) successors.set(edge.from, [])
    predecessors.get(edge.to)!.push(edge.from)
    successors.get(edge.from)!.push(edge.to)
  }

  const positions = new Map<string, number>()
  const reindex = () => {
    for (const column of columns) {
      column.forEach((slot, i) => positions.set(slot.id, i))
    }
  }
  reindex()

  const barycenter = (id: string, neighbours: Map<string, string[]>): number => {
    const list = neighbours.get(id)
    if (!list || list.length === 0) return positions.get(id) ?? 0
    const sum = list.reduce((acc, n) => acc + (positions.get(n) ?? 0), 0)
    return sum / list.length
  }

  for (let sweep = 0; sweep < 4; sweep += 1) {
    const forward = sweep % 2 === 0
    const order = forward ? columns : [...columns].reverse()
    for (const column of order) {
      const keyed = column.map((slot) => ({
        slot,
        band: band(slot.id),
        key: barycenter(slot.id, forward ? predecessors : successors),
      }))
      keyed.sort(
        (a, b) => a.band - b.band || a.key - b.key || a.slot.id.localeCompare(b.slot.id),
      )
      column.splice(0, column.length, ...keyed.map((k) => k.slot))
      reindex()
    }
  }
}

/** A smooth polyline through a run of points, every segment leaving and
 *  arriving along the flow axis. Chaining cubics this way is what makes a
 *  routed edge read as one continuous pipe rather than joined arcs. */
function smoothPath(points: { x: number; y: number }[], direction: Direction): string {
  if (points.length < 2) return ''
  let d = `M ${round(points[0]!.x)} ${round(points[0]!.y)}`
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!
    const b = points[i]!
    if (direction === 'lr') {
      const c = Math.min(Math.max(Math.abs(b.x - a.x) * 0.5, 12), 120)
      d += ` C ${round(a.x + c)} ${round(a.y)}, ${round(b.x - c)} ${round(b.y)}, ${round(b.x)} ${round(b.y)}`
    } else {
      const c = Math.min(Math.max(Math.abs(b.y - a.y) * 0.5, 12), 120)
      d += ` C ${round(a.x)} ${round(a.y + c)}, ${round(b.x)} ${round(b.y - c)}, ${round(b.x)} ${round(b.y)}`
    }
  }
  return d
}

const round = (n: number) => Math.round(n * 10) / 10

/** An edge pointing backwards — a cycle, or a link inside one stage — bows
 *  aside instead of cutting straight through whatever sits between. */
function bowPath(
  from: PlacedNode,
  to: PlacedNode,
  direction: Direction,
): { path: string; mid: { x: number; y: number } } {
  const a = exitPoint(from, direction)
  const b = entryPoint(to, direction)
  const c = 90
  if (direction === 'lr') {
    const lift = 46 + Math.abs(b.y - a.y) * 0.15
    return {
      path: `M ${round(a.x)} ${round(a.y)} C ${round(a.x + c)} ${round(a.y - lift)}, ${round(b.x - c)} ${round(b.y - lift)}, ${round(b.x)} ${round(b.y)}`,
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - lift * 0.75 },
    }
  }
  const lift = 46 + Math.abs(b.x - a.x) * 0.15
  return {
    path: `M ${round(a.x)} ${round(a.y)} C ${round(a.x - lift)} ${round(a.y + c)}, ${round(b.x - lift)} ${round(b.y - c)}, ${round(b.x)} ${round(b.y)}`,
    mid: { x: (a.x + b.x) / 2 - lift * 0.75, y: (a.y + b.y) / 2 },
  }
}

/** Where an edge leaves a node, and where it arrives — the trailing and
 *  leading face along the flow axis. */
function exitPoint(n: PlacedNode, direction: Direction) {
  return direction === 'lr'
    ? { x: n.x + n.w, y: n.y + n.h / 2 }
    : { x: n.x + n.w / 2, y: n.y + n.h }
}

function entryPoint(n: PlacedNode, direction: Direction) {
  return direction === 'lr'
    ? { x: n.x, y: n.y + n.h / 2 }
    : { x: n.x + n.w / 2, y: n.y }
}

/** A slot in a stage: either a real object, or a placeholder reserving room
 *  for an edge to pass through. */
interface Slot {
  id: string
  cross: number
  virtual: boolean
}

export function layoutSchema(graph: SchemaGraph, direction: Direction = 'lr'): Layout {
  const gap = GAPS[direction]
  // Along the flow axis a node is as wide as its name in `lr`, and always one
  // row high in `tb`. Across it, the reverse.
  const mainOf = (n: GraphNode) => (direction === 'lr' ? nodeWidth(n) : NODE_H)
  const crossOf = (n: GraphNode) => (direction === 'lr' ? NODE_H : nodeWidth(n))

  const byId = new Map(graph.nodes.map((n) => [nodeId(n), n]))
  // An edge to a node we were not given cannot be drawn.
  const edges = graph.edges.filter((e) => byId.has(e.from) && byId.has(e.to))

  const connected = new Set<string>()
  for (const edge of edges) {
    connected.add(edge.from)
    connected.add(edge.to)
  }

  const flowIds = graph.nodes.map(nodeId).filter((id) => connected.has(id))
  const standaloneIds = graph.nodes.map(nodeId).filter((id) => !connected.has(id))

  // Layering only follows the acyclic edges; a back edge would otherwise keep
  // pushing its own source further down the flow.
  const backEdges = findBackEdges(flowIds, edges)
  const layer = assignLayers(
    flowIds,
    edges.filter((e) => !backEdges.has(edgeKey(e))),
  )
  const layerCount = flowIds.length
    ? Math.max(...flowIds.map((id) => layer.get(id) ?? 0)) + 1
    : 0

  // Expand every edge that spans more than one stage into a chain through
  // placeholder slots. Those placeholders take up a slot in the stages they
  // cross, which is what carves out a lane for the edge — without them a long
  // edge runs underneath the nodes between its ends and reads as if it
  // connected to them.
  const stages: Slot[][] = Array.from({ length: layerCount }, () => [])
  for (const id of flowIds) {
    stages[layer.get(id) ?? 0]!.push({ id, cross: crossOf(byId.get(id)!), virtual: false })
  }
  for (const stage of stages) stage.sort((a, b) => a.id.localeCompare(b.id))

  const waypoints = new Map<string, string[]>()
  const segments: GraphEdge[] = []
  for (const edge of edges) {
    const from = layer.get(edge.from) ?? 0
    const to = layer.get(edge.to) ?? 0
    if (to - from <= 1) {
      segments.push(edge)
      continue
    }
    const chain: string[] = []
    for (let l = from + 1; l < to; l += 1) {
      const id = `~${edgeKey(edge)}#${l}`
      chain.push(id)
      stages[l]!.push({ id, cross: VIRTUAL_CROSS[direction], virtual: true })
    }
    waypoints.set(edgeKey(edge), chain)
    const stops = [edge.from, ...chain, edge.to]
    for (let i = 0; i < stops.length - 1; i += 1) {
      segments.push({ from: stops[i]!, to: stops[i + 1]!, kind: edge.kind })
    }
  }

  // Bands: the database being viewed first, then the others alphabetically, so
  // the diagram reads outward from where you are.
  const databasesPresent = [...new Set(graph.nodes.map((n) => n.database))]
  const boxed = databasesPresent.length > 1
  const others = databasesPresent.filter((d) => d !== graph.database).sort()
  const bandIndex = new Map([graph.database, ...others].map((d, i) => [d, i]))
  const databaseOf = (id: string) =>
    // A placeholder is named after the edge it stands in for; it belongs to the
    // band of that edge's source, so lanes stay inside their own box.
    (id.startsWith('~') ? id.slice(1, id.indexOf('->')) : id).split('.')[0] ?? ''
  orderLayers(stages, segments, (id) => bandIndex.get(databaseOf(id)) ?? 99)

  // A stage is as thick as its widest real object; a placeholder contributes
  // nothing to that.
  const thickness = stages.map((stage) =>
    stage.reduce(
      (max, slot) => (slot.virtual ? max : Math.max(max, mainOf(byId.get(slot.id)!))),
      direction === 'lr' ? NODE_MIN_W : NODE_H,
    ),
  )
  const mainPos: number[] = []
  let cursor = PAD + (boxed ? BOX_PAD : 0)
  for (const t of thickness) {
    mainPos.push(cursor)
    cursor += t + gap.main
  }

  // Bands are laid out as strips at fixed offsets rather than each stage being
  // centred on its own. Centring per stage lets a database drift sideways from
  // one stage to the next, and then no rectangle can contain it without
  // swallowing part of its neighbour.
  const bandOf = (id: string) => bandIndex.get(databaseOf(id)) ?? 99
  const bands = [...new Set(stages.flat().map((slot) => bandOf(slot.id)))].sort((a, b) => a - b)
  const extentOf = (stage: Slot[], b: number) => {
    const own = stage.filter((slot) => bandOf(slot.id) === b)
    return own.reduce((sum, slot) => sum + slot.cross, 0) + Math.max(0, own.length - 1) * gap.cross
  }
  const bandExtent = new Map(
    bands.map((b) => [b, Math.max(0, ...stages.map((stage) => extentOf(stage, b)))]),
  )
  const bandOffset = new Map<number, number>()
  let bandCursor = 0
  for (const b of bands) {
    bandOffset.set(b, bandCursor)
    bandCursor += bandExtent.get(b)! + BAND_SEP
  }

  // Room for a box's padding and label, so a container never runs off the edge.
  const crossBase = PAD + (boxed ? BOX_PAD + BOX_LABEL : 0)

  const placed: PlacedNode[] = []
  // Placeholder centres, keyed by id, for routing the edges afterwards.
  const via = new Map<string, { x: number; y: number }>()

  stages.forEach((stage, stageIndex) => {
    const main = mainPos[stageIndex]!
    const thick = thickness[stageIndex]!

    for (const b of bands) {
      // Centre this stage's slice within the band's own strip: a two-object
      // stage beside a six-object one should sit against the middle of it.
      let cross =
        crossBase + bandOffset.get(b)! + (bandExtent.get(b)! - extentOf(stage, b)) / 2

      for (const slot of stage.filter((slot) => bandOf(slot.id) === b)) {
        if (slot.virtual) {
          via.set(
            slot.id,
            direction === 'lr'
              ? { x: main + thick / 2, y: cross + slot.cross / 2 }
              : { x: cross + slot.cross / 2, y: main + thick / 2 },
          )
        } else {
          const node = byId.get(slot.id)!
          placed.push({
            ...node,
            id: slot.id,
            // In `lr` every object in a stage shares the stage's width so the
            // column aligns; in `tb` they share a height instead and keep their
            // own widths.
            x: direction === 'lr' ? main : cross,
            y: direction === 'lr' ? cross : main,
            w: direction === 'lr' ? thick : slot.cross,
            h: NODE_H,
            layer: stageIndex,
            band: 'flow',
          })
        }
        cross += slot.cross + gap.cross
      }
    }
  })

  // Standalone objects are a grid, not a line: a database with forty unrelated
  // tables should not become one endless strip. Always below the flow, whichever
  // way the flow runs.
  const flowW = placed.reduce((max, n) => Math.max(max, n.x + n.w), PAD)
  const flowH = placed.reduce((max, n) => Math.max(max, n.y + n.h), PAD)
  let standaloneY: number | null = null
  if (standaloneIds.length > 0) {
    standaloneY = flowIds.length > 0 ? flowH + BAND_GAP : PAD
    const cellW = Math.min(
      NODE_MAX_W,
      Math.max(NODE_MIN_W, ...standaloneIds.map((id) => nodeWidth(byId.get(id)!))),
    )
    const available = Math.max(flowW - PAD, cellW * 3 + gap.main * 2)
    const perRow = Math.max(1, Math.floor((available + gap.main) / (cellW + gap.main)))
    standaloneIds.forEach((id, i) => {
      placed.push({
        ...byId.get(id)!,
        id,
        x: PAD + (i % perRow) * (cellW + gap.main),
        y: standaloneY! + 34 + Math.floor(i / perRow) * (NODE_H + gap.cross),
        w: cellW,
        h: NODE_H,
        layer: -1,
        band: 'standalone',
      })
    })
  }

  const placedById = new Map(placed.map((n) => [n.id, n]))
  const placedEdges: PlacedEdge[] = edges.map((edge) => {
    const from = placedById.get(edge.from)!
    const to = placedById.get(edge.to)!
    const key = edgeKey(edge)
    const backwards = direction === 'lr' ? to.x <= from.x : to.y <= from.y

    if (backwards) {
      const { path, mid } = bowPath(from, to, direction)
      return { ...edge, id: key, path, mid }
    }

    const stops = [
      exitPoint(from, direction),
      ...(waypoints.get(key) ?? []).map((id) => via.get(id)!).filter(Boolean),
      entryPoint(to, direction),
    ]
    const middle = stops[Math.floor(stops.length / 2)]!
    return { ...edge, id: key, path: smoothPath(stops, direction), mid: middle }
  })

  // One box per database, but only when the diagram actually crosses a
  // boundary. Padded outward so the box reads as a container rather than a
  // tight outline.
  const boxes: GroupBox[] = !boxed
    ? []
    : [...new Set(placed.map((n) => n.database))].map((database) => {
        const own = placed.filter((n) => n.database === database)
        const x = Math.min(...own.map((n) => n.x))
        const y = Math.min(...own.map((n) => n.y))
        return {
          database,
          x: x - BOX_PAD,
          y: y - BOX_PAD - BOX_LABEL,
          w: Math.max(...own.map((n) => n.x + n.w)) - x + BOX_PAD * 2,
          h: Math.max(...own.map((n) => n.y + n.h)) - y + BOX_PAD * 2 + BOX_LABEL,
        }
      })

  const width =
    Math.max(...placed.map((n) => n.x + n.w), ...boxes.map((b) => b.x + b.w), PAD) + PAD
  const height =
    Math.max(...placed.map((n) => n.y + n.h), ...boxes.map((b) => b.y + b.h), PAD) + PAD

  return {
    nodes: placed,
    edges: placedEdges,
    boxes,
    width,
    height,
    standaloneY,
    layers: layerCount,
    direction,
  }
}

/** Above this many objects, drawing the whole schema stops being a diagram and
 *  becomes a texture: a real 170-object database lays out over 7000px tall and
 *  fits at 35% zoom, where no label is readable. Past it, Flint draws a
 *  neighbourhood instead. */
export const FULL_GRAPH_LIMIT = 40

export interface FocusResult {
  graph: SchemaGraph
  /** Objects in the database that this view leaves out. */
  hidden: number
  /** Nodes whose fan-out was capped, and by how much. Reported rather than
   *  silently trimmed: a table with sixty consumers should say so. */
  capped: { id: string; hidden: number }[]
}

/** How many neighbours one node may contribute per hop.
 *
 *  Without a cap, a single raw table feeding sixty views produces a
 *  sixty-deep column and the "focused" view is as unreadable as the full one.
 *  The ones kept are the largest, on the grounds that if you are only shown
 *  eight of sixty, the eight that hold the data are the useful ones. */
const FAN_CAP = 8

/** The neighbourhood around one object: everything within `depth` hops, in
 *  either direction. */
export function focusSubgraph(
  graph: SchemaGraph,
  rootId: string,
  depth: number,
): FocusResult {
  const byId = new Map(graph.nodes.map((n) => [nodeId(n), n]))
  if (!byId.has(rootId)) {
    return { graph: { ...graph, nodes: [], edges: [] }, hidden: graph.nodes.length, capped: [] }
  }

  const adjacent = new Map<string, Set<string>>()
  const link = (a: string, b: string) => {
    if (!adjacent.has(a)) adjacent.set(a, new Set())
    adjacent.get(a)!.add(b)
  }
  for (const edge of graph.edges) {
    link(edge.from, edge.to)
    link(edge.to, edge.from)
  }

  // Bigger first, so a capped fan-out keeps the objects that hold the data.
  const weight = (id: string) => {
    const n = byId.get(id)
    return n ? n.bytes * 1e6 + n.rows : 0
  }

  const kept = new Set<string>([rootId])
  const capped: { id: string; hidden: number }[] = []
  let frontier = [rootId]

  for (let hop = 0; hop < depth; hop += 1) {
    const next: string[] = []
    for (const id of frontier) {
      const fresh = [...(adjacent.get(id) ?? [])]
        .filter((n) => !kept.has(n) && byId.has(n))
        .sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))
      if (fresh.length > FAN_CAP) {
        capped.push({ id, hidden: fresh.length - FAN_CAP })
      }
      for (const n of fresh.slice(0, FAN_CAP)) {
        kept.add(n)
        next.push(n)
      }
    }
    frontier = next
    if (frontier.length === 0) break
  }

  return {
    graph: {
      database: graph.database,
      nodes: graph.nodes.filter((n) => kept.has(nodeId(n))),
      edges: graph.edges.filter((e) => kept.has(e.from) && kept.has(e.to)),
    },
    hidden: graph.nodes.length - kept.size,
    capped,
  }
}

/** Everything upstream and downstream of one object, all the way out.
 *
 *  Deliberately not a neighbourhood. A neighbourhood spreads sideways: at one
 *  hop from a raw table it picks up every other view reading that table, which
 *  is precisely what you do not want when the question is "where do these rows
 *  come from and where do they end up". This follows the arrows and only the
 *  arrows — every ancestor back to a source, every descendant on to a leaf — so
 *  what comes back is the path this object sits on.
 *
 *  Nothing is capped here. The fan-out cap exists to keep a neighbourhood
 *  readable; a path that has been asked for in full is not improved by being
 *  trimmed, and a table with sixty consumers genuinely has sixty consumers. */
export function lineageSubgraph(graph: SchemaGraph, rootId: string): FocusResult {
  const byId = new Map(graph.nodes.map((n) => [nodeId(n), n]))
  if (!byId.has(rootId)) {
    return { graph: { ...graph, nodes: [], edges: [] }, hidden: graph.nodes.length, capped: [] }
  }

  const upstream = new Map<string, string[]>()
  const downstream = new Map<string, string[]>()
  for (const edge of graph.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue
    ;(downstream.get(edge.from) ?? downstream.set(edge.from, []).get(edge.from)!).push(edge.to)
    ;(upstream.get(edge.to) ?? upstream.set(edge.to, []).get(edge.to)!).push(edge.from)
  }

  const kept = new Set<string>([rootId])
  const walk = (adjacency: Map<string, string[]>) => {
    const queue = [rootId]
    while (queue.length > 0) {
      const id = queue.pop()!
      for (const next of adjacency.get(id) ?? []) {
        if (kept.has(next)) continue
        kept.add(next)
        queue.push(next)
      }
    }
  }
  walk(upstream)
  walk(downstream)

  return {
    graph: {
      database: graph.database,
      nodes: graph.nodes.filter((n) => kept.has(nodeId(n))),
      // Both ends on the path: an edge that shortcuts from an ancestor to a
      // descendant is part of how the data moves and is drawn as such.
      edges: graph.edges.filter((e) => kept.has(e.from) && kept.has(e.to)),
    },
    hidden: graph.nodes.length - kept.size,
    capped: [],
  }
}

/** The object a focused view should open on: the biggest table, falling back to
 *  the biggest object of any kind. Whatever holds the data is where a schema
 *  makes sense from. */
/** ClickHouse keeps a materialized view's rows in a hidden table of its own,
 *  named `.inner_id.<uuid>` under an Atomic database or `.inner.<view>` under
 *  the older one. They are routinely the largest objects in a schema, and they
 *  are never what anyone means: the name is a uuid, and the thing it stands for
 *  is already on the canvas as the view itself. */
export function isInnerTable(name: string): boolean {
  return name.startsWith('.inner')
}

export function defaultFocus(graph: SchemaGraph): string | undefined {
  const score = (n: GraphNode) => n.bytes * 1e6 + n.rows

  // Biggest, but only among the objects somebody named: opening the diagram on
  // `.inner_id.<uuid>` is opening it on an implementation detail.
  const named = graph.nodes.filter((n) => !isInnerTable(n.name))
  const visible = named.length > 0 ? named : graph.nodes

  // And only among the objects that are part of a pipeline. The page exists to
  // show how data moves, so centring it on the largest object in the database
  // is the wrong instinct when that object is connected to nothing — the
  // diagram opens as a single box captioned "not referenced by anything else".
  const wired = new Set<string>()
  for (const edge of graph.edges) {
    wired.add(edge.from)
    wired.add(edge.to)
  }
  const connected = visible.filter((n) => wired.has(nodeId(n)))
  const candidates = connected.length > 0 ? connected : visible

  const tables = candidates.filter((n) => n.kind === 'table')
  const pool = tables.length > 0 ? tables : candidates
  const best = [...pool].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name))[0]
  return best ? nodeId(best) : undefined
}

/** Ids reachable from `id` in either direction, one hop. Used to light the
 *  neighbourhood on hover. */
export function neighbourhood(edges: GraphEdge[], id: string): Set<string> {
  const near = new Set<string>([id])
  for (const edge of edges) {
    if (edge.from === id) near.add(edge.to)
    if (edge.to === id) near.add(edge.from)
  }
  return near
}
