import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import {
  layoutSchema,
  neighbourhood,
  nodeId,
  type Direction,
  type SchemaGraph,
} from '../lib/graph'
import { NodePanel } from './NodePanel'
import { NodeMenu } from './NodeMenu'
import { bytes, count } from '../lib/format'
import { type TableTraffic } from '../lib/diagnose'
import { KIND_MEANING, KIND_PLURAL, KIND_LABEL, explainEngine } from '../lib/explain'

const MIN_ZOOM = 0.35
const MAX_ZOOM = 2.2
/** Fitting never blows a small diagram up past this — two tables filling the
 *  viewport would look like a mistake. */
const MAX_FIT = 1.4

interface View {
  x: number
  y: number
  k: number
}

/** The schema, drawn as the pipeline it is.
 *
 *  Nodes are real buttons positioned over an SVG edge layer rather than SVG
 *  shapes: that keeps them focusable and tabbable, lets CSS handle truncation
 *  and hover, and leaves the SVG to do the one thing it is better at — curves. */
type Orientation = 'auto' | Direction

export function SchemaCanvas({
  graph,
  onCentre,
  onLineage,
  bar,
  traffic,
  trafficMax,
  trafficDays,
  trafficReason,
}: {
  graph: SchemaGraph
  /** Re-root a focused view. Absent when the whole schema is on screen, where
   *  there is nothing to re-centre. */
  onCentre?: (id: string) => void
  /** Draw only the path through one object. Absent when there is nothing to
   *  narrow — a schema already drawn whole still has paths worth isolating, so
   *  this is not tied to whether the view is focused. */
  onLineage?: (id: string) => void
  /** Caption and controls belonging to the diagram — which slice is drawn, how
   *  far it reaches. Rendered as the frame's top row so it goes full screen
   *  with the diagram instead of being left behind on the page. */
  bar?: ReactNode
  /** Reads and writes keyed by qualified `database.table`. The diagram draws
   *  dependencies, which are permanent; this is the layer that says which of
   *  them anyone actually uses. */
  traffic?: Map<string, TableTraffic>
  /** The read count the bars are scaled against. Passed in rather than derived
   *  here, so filtering the diagram does not rescale it. */
  trafficMax?: number
  trafficDays?: number
  /** Why there is no traffic to show, when there is none. Said on the disabled
   *  toggle rather than left as a button that does nothing. */
  trafficReason?: string
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
  const [hovered, setHovered] = useState<string | null>(null)
  const [orientation, setOrientation] = useState<Orientation>('auto')
  const [full, setFull] = useState(false)
  const [filter, setFilter] = useState('')
  const [kinds, setKinds] = useState<Set<string>>(() => new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [showTraffic, setShowTraffic] = useState(false)
  /** The right-click menu: which node, and where the cursor was. */
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [animate, setAnimate] = useState(true)

  // Filtering narrows what is drawn rather than dimming it: a schema you have
  // asked to see part of should lay that part out properly, not leave it
  // spread across the gaps where the rest used to be.
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle && kinds.size === 0) return graph
    const keep = new Set(
      graph.nodes
        .filter(
          (n) =>
            (kinds.size === 0 || kinds.has(n.kind)) &&
            (!needle || n.name.toLowerCase().includes(needle)),
        )
        .map(nodeId),
    )
    return {
      database: graph.database,
      nodes: graph.nodes.filter((n) => keep.has(nodeId(n))),
      edges: graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
    }
  }, [graph, filter, kinds])

  // Both orientations, so the better fit can be chosen rather than guessed.
  // Cheap: this is pure arithmetic over at most a few hundred nodes.
  const lr = useMemo(() => layoutSchema(visible, 'lr'), [visible])
  const tb = useMemo(() => layoutSchema(visible, 'tb'), [visible])

  const [box, setBox] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = viewport.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      const r = entry?.contentRect
      if (r) setBox({ w: r.width, h: r.height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const fitScale = (l: { width: number; height: number }) =>
    box.w === 0 ? 0 : Math.min((box.w - 48) / l.width, (box.h - 48) / l.height)

  const layout =
    orientation === 'lr' ? lr : orientation === 'tb' ? tb : fitScale(tb) > fitScale(lr) ? tb : lr

  const selectedNode = graph.nodes.find((n) => nodeId(n) === selected)

  // The diagram sets the height of the row — a two-table schema in a 620px box
  // reads as emptiness rather than as room to breathe — but never less than the
  // details panel needs, or the row opens a hole beside it.
  const bodyH = Math.max(selectedNode ? 460 : 260, Math.min(620, layout.height + 96))

  const fit = useCallback(() => {
    const rect = viewport.current?.getBoundingClientRect()
    if (!rect || layout.width === 0) return
    const margin = 24
    const k = Math.min(
      (rect.width - margin * 2) / layout.width,
      (rect.height - margin * 2) / layout.height,
      MAX_FIT,
    )
    const scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, k))
    setView({
      x: (rect.width - layout.width * scale) / 2,
      y: (rect.height - layout.height * scale) / 2,
      k: scale,
    })
  }, [layout.width, layout.height])

  // Fit whenever the diagram changes — or the frame around it does — before
  // paint, so it never flashes at the wrong scale. The observed box is a
  // dependency because the row's height follows the layout: without it the view
  // could be computed against the canvas the *previous* layout had, which left
  // the diagram scaled for a taller frame and clipped at the bottom.
  useLayoutEffect(fit, [fit, box.w, box.h])

  useEffect(() => {
    const onResize = () => fit()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [fit])

  // Fullscreen is the frame, not the page: the diagram is the only thing worth
  // the whole screen. Exiting by Escape goes through the same event, so the
  // button and the keyboard stay in step.
  useEffect(() => {
    const onChange = () => {
      setFull(document.fullscreenElement === frame.current)
      // The frame has just changed size; refit on the next frame, once layout
      // has settled.
      requestAnimationFrame(() => fit())
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [fit])

  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void frame.current?.requestFullscreen?.()
  }

  // Wheel pans, ctrl/⌘+wheel zooms about the cursor — the convention every
  // canvas tool shares.
  useEffect(() => {
    const el = viewport.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      if (event.ctrlKey || event.metaKey) {
        const rect = el.getBoundingClientRect()
        const px = event.clientX - rect.left
        const py = event.clientY - rect.top
        setView((v) => {
          const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.k * Math.exp(-event.deltaY / 320)))
          // Keep the point under the cursor pinned while scaling.
          return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k }
        })
      } else {
        setView((v) => ({ ...v, x: v.x - event.deltaX, y: v.y - event.deltaY }))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const drag = useRef<{ id: number; x: number; y: number } | null>(null)
  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return
    // A node is a click, not a drag — and so is anything in the HUD. Capturing
    // the pointer here retargets the pointerup, so the button under the cursor
    // never sees its click: the zoom control and the legend both stop working
    // the moment the canvas decides a press on them is the start of a pan.
    if ((event.target as HTMLElement).closest('.gnode, .canvas__hud')) return
    drag.current = { id: event.pointerId, x: event.clientX - view.x, y: event.clientY - view.y }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: React.PointerEvent) => {
    const d = drag.current
    if (!d || d.id !== event.pointerId) return
    setView((v) => ({ ...v, x: event.clientX - d.x, y: event.clientY - d.y }))
  }
  const onPointerUp = () => {
    drag.current = null
  }

  const near = useMemo(
    () => (hovered ? neighbourhood(graph.edges, hovered) : null),
    [graph.edges, hovered],
  )

  const zoom = (factor: number) =>
    setView((v) => {
      const rect = viewport.current?.getBoundingClientRect()
      const px = (rect?.width ?? 0) / 2
      const py = (rect?.height ?? 0) / 2
      const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.k * factor))
      return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k }
    })

  const menuNode = menu ? graph.nodes.find((n) => nodeId(n) === menu.id) : undefined

  const centre = (id: string) => {
    setSelected(id)
    onCentre?.(id)
  }

  if (graph.nodes.length === 0) {
    return (
      <div className="canvas canvas--empty">
        <p className="canvas__emptytitle">Nothing to draw yet</p>
        <p className="canvas__emptyhint">
          This database has no tables, views or dictionaries. Create one in ClickHouse and it
          appears here.
        </p>
      </div>
    )
  }

  // A wall of unrelated cards is not a diagram. Past a couple of dozen objects
  // with nothing joining them, the list below this is the better view and the
  // honest thing to say is that there is no flow to show.
  if (graph.edges.length === 0 && graph.nodes.length > 24) {
    return (
      <div className="canvas canvas--empty">
        <p className="canvas__emptytitle">No relationships to draw</p>
        <p className="canvas__emptyhint">
          None of the {graph.nodes.length} objects in this database reads from another. Add a
          view or a materialized view and the flow appears here — meanwhile the list below is
          the faster way in.
        </p>
      </div>
    )
  }

  const empty = layout.nodes.length === 0 && (filter.trim() !== '' || kinds.size > 0)
  const busiest = trafficMax ?? 0

  return (
    <div className={`frame${full ? ' is-full' : ''}`} ref={frame}>
      {bar ? <div className="frame__lead">{bar}</div> : null}
      <div className="frame__bar">
        <div className="frame__search">
          <svg className="frame__glass" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="6.8" cy="6.8" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M10.2 10.2 14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <input
            className="frame__input"
            type="search"
            value={filter}
            placeholder="Filter the diagram"
            aria-label="Filter objects in the diagram"
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>

        <span className="panel__spacer" />

        <div className="segmented" role="group" aria-label="Flow direction">
          {(
            [
              ['auto', 'Auto'],
              ['lr', 'Across'],
              ['tb', 'Down'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              className={`segmented__item${orientation === id ? ' is-on' : ''}`}
              aria-pressed={orientation === id}
              title={
                id === 'auto'
                  ? 'Whichever direction fits the frame better'
                  : id === 'lr'
                    ? 'Data flows left to right'
                    : 'Data flows top to bottom'
              }
              onClick={() => setOrientation(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <button
          className={`btn${animate ? ' is-on' : ''}`}
          onClick={() => setAnimate((a) => !a)}
          aria-pressed={animate}
          title="Dots travelling the edges show which way data moves"
        >
          Flow
        </button>

        <button
          className={`btn${showTraffic ? ' is-on' : ''}`}
          onClick={() => setShowTraffic((t) => !t)}
          aria-pressed={showTraffic}
          disabled={!traffic || traffic.size === 0}
          title={
            trafficReason ??
            (traffic && traffic.size
              ? `How much each object was actually read in the last ${trafficDays ?? 7} days`
              : 'No read counts available for this database')
          }
        >
          Traffic
        </button>

        <button className="btn" onClick={toggleFull} aria-pressed={full}>
          {full ? 'Exit full screen' : 'Full screen'}
        </button>
      </div>

    <div className="frame__body" style={{ ['--body-h' as string]: `${bodyH}px` }}>
    <div
      className={`canvas${hovered ? ' is-focusing' : ''}${animate ? '' : ' is-still'}`}
      ref={viewport}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={fit}
    >
      <div
        className="canvas__stage"
        style={{
          width: layout.width,
          height: layout.height,
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
          // The dot grid scales with the view, which is what makes zooming feel
          // like moving through space rather than resizing a picture.
          ['--grid' as string]: `${Math.round(26 * view.k)}px`,
        }}
      >
        <svg
          className="canvas__edges"
          width={layout.width}
          height={layout.height}
          aria-hidden="true"
        >
          {layout.edges.map((edge) => {
            const lit = !near || (near.has(edge.from) && near.has(edge.to))
            return (
              <g
                key={edge.id}
                className={`gedge gedge--${edge.kind}${lit ? '' : ' is-dim'}${
                  near && lit ? ' is-lit' : ''
                }`}
              >
                <path className="gedge__line" d={edge.path} />
                <path className="gedge__flow" d={edge.path} />
                <path className="gedge__head" d={arrowhead(edge.path)} />
              </g>
            )
          })}
        </svg>

          {layout.boxes.map((group) => (
          <div
            className="gbox"
            key={group.database}
            style={{ left: group.x, top: group.y, width: group.w, height: group.h }}
          >
            <span className="gbox__label">{group.database}</span>
          </div>
        ))}

      {layout.standaloneY !== null ? (
          <div className="canvas__band" style={{ top: layout.standaloneY }}>
            <span className="canvas__bandlabel">
              not referenced by anything else in this database
            </span>
          </div>
        ) : null}

        {layout.nodes.map((node, i) => {
          const lit = !near || near.has(node.id)
          const read = showTraffic ? traffic?.get(`${node.database}.${node.name}`) : undefined
          return (
            <button
              key={node.id}
              type="button"
              className={`gnode gnode--${node.kind}${lit ? '' : ' is-dim'}${
                hovered === node.id ? ' is-focused' : ''
              }${selected === node.id ? ' is-selected' : ''}${
                node.external ? ' gnode--external' : ''
              }`}
              style={{
                left: node.x,
                top: node.y,
                width: node.w,
                height: node.h,
                // Reveal in dependency order: sources first, then what reads them.
                ['--delay' as string]: `${Math.min(600, (node.layer + 1) * 55 + i * 12)}ms`,
              }}
              onMouseEnter={() => setHovered(node.id)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(node.id)}
              onBlur={() => setHovered(null)}
              // Single click inspects, double click re-roots — the same split
              // Kiali uses, where selecting is cheap and changing the point of
              // view is deliberate.
              onClick={() => setSelected(node.id)}
              onDoubleClick={(e) => {
                e.stopPropagation()
                centre(node.id)
              }}
              // Right click selects too: the menu should act on the node you
              // are looking at in the panel, not on whatever was there before.
              onContextMenu={(e) => {
                e.preventDefault()
                setSelected(node.id)
                setMenu({ id: node.id, x: e.clientX, y: e.clientY })
              }}
              title={[node.comment, explainEngine(node.engine) ?? KIND_MEANING[node.kind]]
                .filter(Boolean)
                .join('\n\n')}
            >
              <span className="gnode__top">
                <span className="gnode__name">{node.name}</span>
                {node.external ? <span className="gnode__db">{node.database}</span> : null}
              </span>
              <span className="gnode__engine">{node.engine}</span>
              <span className="gnode__facts">
                {/* Sizes are only gathered for the database in view, so an
                    object from elsewhere says where it lives rather than
                    claiming to hold nothing. */}
                {node.external ? (
                  <span>in {node.database}</span>
                ) : node.kind === 'table' || node.rows > 0 || node.bytes > 0 ? (
                  <>
                    <span>{count(node.rows)} rows</span>
                    <span className="gnode__sep" />
                    <span>{bytes(node.bytes)}</span>
                  </>
                ) : (
                  <span>{node.columns} columns</span>
                )}
              </span>

              {/* Reads as a length against the busiest object in view. Bare
                  counts on a diagram are unreadable at a glance and the whole
                  point of putting them here is the glance; the number itself
                  is a click away in the panel. */}
              {showTraffic ? (
                <span className="gnode__traffic">
                  {/* The track is a real element, not a backdrop, so the label
                      beside it can never be struck through by its own scale. */}
                  <span className="gnode__track">
                    {read && read.reads > 0 ? (
                      <span
                        className="gnode__trafficbar"
                        style={{
                          width: `${Math.min(100, Math.max(3, (read.reads / Math.max(1, busiest)) * 100))}%`,
                        }}
                      />
                    ) : null}
                  </span>
                  {read && read.reads > 0 ? (
                    <span className="gnode__trafficnum">{count(read.reads)}</span>
                  ) : (
                    <span className="gnode__trafficnone">no reads</span>
                  )}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>

      <div className="canvas__hud">
        {/* The legend is the filter. It was already naming the kinds and
            counting them at the foot of the diagram while a second row of
            buttons said the same words at the top; one of the two had to go,
            and the one attached to the picture is the one that reads. */}
        <div className="canvas__legend" role="group" aria-label="Filter by kind">
          {(['table', 'view', 'materialized_view', 'dictionary'] as const).map((kind) => {
            // Presence comes from the whole graph and the count from what is
            // drawn: a kind switched off has to stay clickable to come back.
            if (!graph.nodes.some((x) => x.kind === kind)) return null
            const n = layout.nodes.filter((x) => x.kind === kind).length
            const on = kinds.size === 0 || kinds.has(kind)
            return (
              <button
                className={`lgd lgd--${kind}${on ? '' : ' is-off'}`}
                key={kind}
                aria-pressed={kinds.has(kind)}
                title={`${KIND_MEANING[kind]}\n\nClick to show only this kind.`}
                onClick={() =>
                  setKinds((current) => {
                    const next = new Set(current)
                    if (next.has(kind)) next.delete(kind)
                    else next.add(kind)
                    return next
                  })
                }
              >
                <i className={`glyph glyph--${kind}`} />
                {n} {n === 1 ? KIND_LABEL[kind] : KIND_PLURAL[kind]}
              </button>
            )
          })}
        </div>
        <div className="canvas__zoom">
          <button className="iconbtn" onClick={() => zoom(1 / 1.25)} aria-label="Zoom out">
            −
          </button>
          <button className="iconbtn iconbtn--wide" onClick={fit}>
            Fit
          </button>
          <button className="iconbtn" onClick={() => zoom(1.25)} aria-label="Zoom in">
            +
          </button>
        </div>
      </div>

      {showTraffic ? (
        /* What the bars mean, and what they leave out. A magnitude drawn
           without its window and its exclusions is a number you cannot argue
           with. */
        <p className="canvas__hint canvas__hint--traffic">
          Bar length is reads over the last {trafficDays ?? 7} days, scaled against the
          busiest object here. Flint's own metadata queries are excluded; a table read
          only by something that does not reach `query_log` reads as unread.
        </p>
      ) : (
        <p className="canvas__hint">
          Hover to trace lineage · click for details · right-click for actions · drag to
          pan · ⌘scroll to zoom
        </p>
      )}

      {empty ? (
        <div className="canvas__nomatch">
          <p className="canvas__emptytitle">Nothing matches</p>
          <p className="canvas__emptyhint">
            No object in this view is called “{filter.trim()}”
            {kinds.size > 0 ? ' among the kinds you have selected' : ''}.
          </p>
        </div>
      ) : null}
    </div>

    {selectedNode ? (
      <NodePanel
        node={selectedNode}
        nodes={graph.nodes}
        edges={graph.edges}
        onClose={() => setSelected(null)}
        onCentre={centre}
        onLineage={onLineage}
        canCentre={!!onCentre}
        traffic={traffic?.get(`${selectedNode.database}.${selectedNode.name}`)}
        trafficDays={trafficDays}
      />
    ) : null}
    </div>

    {menu && menuNode ? (
      <NodeMenu
        node={menuNode}
        x={menu.x}
        y={menu.y}
        onCentre={onCentre ? () => centre(nodeId(menuNode)) : undefined}
        onLineage={onLineage ? () => onLineage(nodeId(menuNode)) : undefined}
        onClose={() => setMenu(null)}
      />
    ) : null}
    </div>
  )
}

/** A small triangle at the end of a path, pointing along it. The path always
 *  arrives horizontally from the left, so the direction is known. */
function arrowhead(path: string): string {
  const numbers = path.match(/-?[\d.]+/g)
  if (!numbers || numbers.length < 8) return ''
  const x = Number(numbers[numbers.length - 2])
  const y = Number(numbers[numbers.length - 1])
  const s = 5
  return `M ${x} ${y} L ${x - s - 1} ${y - s * 0.7} L ${x - s - 1} ${y + s * 0.7} Z`
}
