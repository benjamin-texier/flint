import { useEffect, useMemo, useRef, useState } from 'react'

import type { QueryResult } from '../lib/api'
import {
  MAX_SERIES,
  buildGrid,
  buildRing,
  cellFill,
  compact,
  needsFacets,
  niceTicks,
  parseNumber,
  indexTicks,
  parseTime,
  plotHeight,
  ringPath,
  timeTicks,
  timeLabel,
  type ChartSpec,
  type Grid,
} from '../lib/chart'
import { cellText } from './../lib/grid'

/** Charts for a query result, drawn as inline SVG.
 *
 *  Every spec here comes from the dataviz method and none of it is taste: 2px
 *  lines, bars capped at 24px with a 4px rounded data-end and a 2px surface gap,
 *  markers at least 8px carrying a 2px surface ring, hairline solid gridlines one
 *  step off the surface, a legend whenever there are two or more series and none
 *  when there is one, and text in text tokens — never in the series colour,
 *  which is illegible as type.
 *
 *  The hover layer is part of the deliverable, not an upgrade: a crosshair on the
 *  line chart, the mark itself on bars, nearest-point on scatter. It only ever
 *  enhances — the grid beside it is the table view, so no value is reachable by
 *  hovering alone. */

const PAD = { top: 14, right: 18, bottom: 30, left: 58 }
const MAX_BARS = 40

/* What the figure spends on things that are not the plot. Measured off the
 * rendered page rather than guessed, and only ever subtracted — a few pixels out
 * costs a few pixels of plot, where getting it wrong the other way clips the
 * bottom panel of a small-multiple stack, which is what it used to do. */
/** The series legend above the plot, with its gap. */
const LEGEND_H = 34
/** The one sentence a faceted figure says before its panels. */
const FACET_NOTE_H = 24
/** The x axis the panels share, printed once under the last of them. */
const FACET_AXIS_H = 22

interface Hover {
  /** Row index under the pointer. */
  row: number
  x: number
  y: number
}

export function Chart({
  result,
  spec,
  room,
}: {
  result: QueryResult
  spec: ChartSpec
  /** How tall the caller can afford, when it knows. A dashboard tile does; the
   *  query page does not and would rather the chart took the aspect rule's
   *  answer. Left out means unbounded, which `plotHeight` reads as "decide from
   *  the width". */
  room?: number
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 720, h: 0 })
  const [hover, setHover] = useState<Hover | null>(null)

  /* The observer was here before and did nothing, because `.chart` was a flex
     item with no width of its own: its width came from its content, and its
     content was an SVG asking for 100% of its width. A sizing loop that
     settled at the 720px this state opens on — so every chart in the product
     was drawn at 720×300 whatever it was given, a quarter of the room on the
     query page. `.chart` now fills its parent, which makes this measurement
     mean something. */
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      const r = entry?.contentRect
      if (r && r.width > 0) setBox({ w: r.width, h: r.height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const width = box.w
  /* The height the plot may have.
     
     `room` when the caller knows — a tile does. Otherwise the figure's own
     measured height, which is real wherever `.chart` is a stretched flex item
     and is *not* circular there: the figure takes its height from the row it
     sits in, so drawing a taller SVG inside it does not make it taller. Where
     that is not true the caller passes `room` instead, which is why the tile
     does. The legend comes off first: it is above the plot, in the same box. */
  const legend = spec.series.length > 1 ? LEGEND_H : 0
  const available = room ?? Math.max(0, box.h - legend)

  /* A stat is type, not a plot, and has no aspect to keep. Everything else is
     bounded by `plotHeight` — see it for the floor and the two ceilings. */
  const height = spec.kind === 'stat' ? 160 : plotHeight(width, available)

  const names = spec.series.map((i) => result.columns[i]?.name ?? '')
  const hidden = spec.omitted ?? 0

  return (
    <figure className="chart" ref={wrap}>
      {spec.series.length > 1 ? (
        <figcaption className="chart__legend">
          {names.map((n, i) => (
            <span className="chart__key" key={n}>
              <i className="chart__swatch" style={{ background: seriesColor(i) }} />
              {n}
            </span>
          ))}
          {hidden > 0 ? (
            <span className="chart__omitted">
              {hidden} more {hidden === 1 ? 'measure' : 'measures'} not plotted
            </span>
          ) : null}
        </figcaption>
      ) : null}

      {spec.kind === 'stat' ? (
        <Stat result={result} spec={spec} />
      ) : spec.kind === 'donut' ? (
        <Donut result={result} spec={spec} />
      ) : spec.kind === 'heatmap' ? (
        <Heat result={result} spec={spec} />
      ) : (
        <Plot
          result={result}
          spec={spec}
          width={width}
          height={height}
          hover={hover}
          onHover={setHover}
        />
      )}
    </figure>
  )
}

function seriesColor(i: number): string {
  return `var(--series-${(i % MAX_SERIES) + 1})`
}

/** The figure form: one number, big, in the interface sans, with proportional
 *  figures — `tabular-nums` makes a large standalone number look loose. */
function Stat({ result, spec }: { result: QueryResult; spec: ChartSpec }) {
  const i = spec.series[0]!
  const raw = result.rows[0]?.[i]
  const n = parseNumber(raw)
  return (
    <div className="hero">
      <div className="hero__value">{Number.isFinite(n) ? compact(n) : cellText(raw).text}</div>
      <div className="hero__label">{result.columns[i]?.name}</div>
      {Number.isFinite(n) && Math.abs(n) >= 1e4 ? (
        <div className="hero__exact">{n.toLocaleString('en')}</div>
      ) : null}
    </div>
  )
}

function Plot({
  result,
  spec,
  width,
  height,
  hover,
  onHover,
}: {
  result: QueryResult
  spec: ChartSpec
  width: number
  height: number
  hover: Hover | null
  onHover: (h: Hover | null) => void
}) {
  const plotW = Math.max(80, width - PAD.left - PAD.right)
  const plotH = height - PAD.top - PAD.bottom

  const model = useMemo(() => buildModel(result, spec), [result, spec])
  if (!model) return <p className="chart__none">Nothing in this result plots.</p>
  if (model.refusal) return <p className="chart__none">{model.refusal}</p>

  // Incommensurate measures get a panel each rather than a shared axis they
  // cannot both use, and never a second y axis.
  const faceted =
    spec.kind === 'line' &&
    needsFacets(
      model.series.map((s) => {
        const ys = s.points.map((p) => p.y).filter(Number.isFinite)
        return ys.length
          ? { min: Math.min(...ys), max: Math.max(...ys) }
          : { min: NaN, max: NaN }
      }),
    )

  if (faceted) {
    return (
      <Facets
        result={result}
        spec={spec}
        model={model}
        width={width}
        height={height}
        hover={hover}
        onHover={onHover}
      />
    )
  }

  const { xs, series, xMin, xMax, yMin, yMax, labels, truncated } = model
  /* Headroom: when the data max sits above the top gridline, the tallest mark
     would touch the plot ceiling and read as clipped — and a value on its cap
     would have nowhere to go. Raise the ceiling one step and draw that line. */
  const baseTicks = niceTicks(yMin, yMax)
  const step = baseTicks.length > 1 ? baseTicks[1]! - baseTicks[0]! : 0
  const top = baseTicks.length ? baseTicks[baseTicks.length - 1]! : yMax
  const yTicks = yMax > top && step > 0 ? [...baseTicks, top + step] : baseTicks
  const yTop = yTicks.length ? Math.max(yMax, yTicks[yTicks.length - 1]!) : yMax
  const sx = (v: number) => (xMax === xMin ? plotW / 2 : ((v - xMin) / (xMax - xMin)) * plotW)
  const sy = (v: number) => (yTop === yMin ? plotH / 2 : plotH - ((v - yMin) / (yTop - yMin)) * plotH)

  /* The x axis. Not for bars: a bar's identity is its category, printed under
     it, and a positional tick over a band scale would point between two bars.
     `model.isTime` decides which ladder — calendar steps, or whole positions. */
  const xTicks =
    spec.kind === 'bar'
      ? []
      : model.isTime
        ? timeTicks(xMin, xMax, plotW)
        : indexTicks(xMin, xMax, plotW)

  const band = plotW / Math.max(1, xs.length)
  // Widen with the band, so six categories read as bars and forty still leave
  // the 2px surface gap between them.
  const barW = Math.min(56, Math.max(2, Math.min(band * 0.55, band - 2)))

  /* Categories and their values, or neither: a value floating over an unnamed
     bar is noise, so both ride the same fit test. */
  const barLabels =
    spec.kind === 'bar' ? model.series[0]!.points.map((_, i) => model.rowLabelShort(i)) : null
  const labelled = barLabels !== null && labelsFit(barLabels, band)

  const nearest = (px: number) => {
    if (spec.kind === 'bar') return Math.min(xs.length - 1, Math.max(0, Math.floor(px / band)))
    let best = 0
    let bestD = Infinity
    xs.forEach((v, i) => {
      const d = Math.abs(sx(v) - px)
      if (d < bestD) {
        bestD = d
        best = i
      }
    })
    return best
  }

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - box.left - PAD.left
    if (px < -8 || px > plotW + 8) return onHover(null)
    const row = nearest(px)
    onHover({ row, x: PAD.left + (spec.kind === 'bar' ? band * row + band / 2 : sx(xs[row]!)), y: 0 })
  }

  const description = `${spec.kind} chart of ${series.map((s) => s.name).join(', ')}`

  return (
    <div className="chart__body">
      <svg
        className="chart__svg"
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={description}
        onPointerMove={onMove}
        onPointerLeave={() => onHover(null)}
      >
        <g transform={`translate(${PAD.left} ${PAD.top})`}>
          {/* Hairline, solid, one step off the surface. Never dashed. */}
          {yTicks.map((t) => (
            <line key={t} className="chart__grid" x1={0} x2={plotW} y1={sy(t)} y2={sy(t)} />
          ))}
          {yTicks.map((t) => (
            <text key={`l${t}`} className="chart__tick" x={-10} y={sy(t)} textAnchor="end" dy="0.32em">
              {compact(t)}
            </text>
          ))}

          {spec.kind === 'bar'
            ? series[0]!.points.map((p, i) =>
                Number.isFinite(p.y) ? (
                  <Bar
                    key={i}
                    x={band * i + (band - barW) / 2}
                    width={barW}
                    y={sy(Math.max(0, p.y))}
                    base={sy(Math.max(0, Math.min(0, yMin)))}
                    lit={hover?.row === i}
                  />
                ) : null,
              )
            : null}

          {spec.kind === 'area' && model.stacked
            ? model.stacked.map((stack, si) => (
                <path
                  key={series[si]!.name}
                  className="chart__band"
                  d={bandPath(stack, xs, sx, sy)}
                  fill={seriesColor(si)}
                />
              ))
            : null}

          {/* The 2px surface gap the marks spec asks for between adjacent
              fills, drawn as its own line along each boundary rather than as a
              stroke around each band.

              Stroking the polygon was the first attempt and it scalloped: a
              round join puts a 1px arc at every vertex, and at two hundred
              points across six hundred pixels the vertices are three pixels
              apart, so the boundary came out as a row of bumps rather than a
              line. Measured in the browser at 4×, one bump per 3.2px — the
              point spacing exactly. A line of its own also leaves the baseline
              and the two ends unstroked, which is where the rest of the
              artefacts were. */}
          {spec.kind === 'area' && model.stacked
            ? model.stacked
                .slice(0, -1)
                .map((stack, si) => (
                  <path
                    key={`edge-${series[si]!.name}`}
                    className="chart__seam"
                    d={linePath(
                      xs.map((x, i) => ({ x, y: stack.upper[i] ?? 0 })),
                      sx,
                      sy,
                    )}
                  />
                ))
            : null}

          {spec.kind === 'line'
            ? series.map((s, si) => (
                <g key={s.name}>
                  {series.length === 1 ? (
                    <path
                      className="chart__area"
                      d={areaPath(s.points, sx, sy, plotH)}
                      fill={seriesColor(si)}
                    />
                  ) : null}
                  <path
                    className="chart__line"
                    d={linePath(s.points, sx, sy)}
                    stroke={seriesColor(si)}
                  />
                  <EndMarker points={s.points} sx={sx} sy={sy} color={seriesColor(si)} />
                </g>
              ))
            : null}

          {spec.kind === 'scatter'
            ? series[0]!.points.map((p, i) =>
                Number.isFinite(p.x) && Number.isFinite(p.y) ? (
                  <circle
                    key={i}
                    className={`chart__dot${hover?.row === i ? ' is-lit' : ''}`}
                    cx={sx(p.x)}
                    cy={sy(p.y)}
                    r={4}
                    fill={seriesColor(0)}
                  />
                ) : null,
              )
            : null}

          {/* The crosshair finds the X so the reader aims at a position, not at
              a 2px line. Bars are their own hit target and get none. */}
          {hover && spec.kind !== 'bar' && spec.kind !== 'area' ? (
            <line
              className="chart__cross"
              x1={hover.x - PAD.left}
              x2={hover.x - PAD.left}
              y1={0}
              y2={plotH}
            />
          ) : null}

          {hover && spec.kind === 'area' ? (
            <line
              className="chart__cross"
              x1={hover.x - PAD.left}
              x2={hover.x - PAD.left}
              y1={0}
              y2={plotH}
            />
          ) : null}

          <line className="chart__axis" x1={0} x2={plotW} y1={plotH} y2={plotH} />
        </g>

        {/* A bar's category is its identity, so it is labelled under the bar
            whenever every label fits in full — otherwise the two ends, and the
            tooltip and table carry the rest. Never clipped. */}
        {labelled && barLabels ? (
          model.series[0]!.points.map((p, i) =>
            Number.isFinite(p.y) ? (
              <g key={i}>
                <text
                  className="chart__tick chart__tick--x"
                  x={PAD.left + band * i + band / 2}
                  y={height - 10}
                  textAnchor="middle"
                >
                  {barLabels[i]}
                </text>
                <text
                  className="chart__value"
                  x={PAD.left + band * i + band / 2}
                  y={PAD.top + sy(Math.max(0, p.y)) - 6}
                  textAnchor="middle"
                >
                  {compact(p.y)}
                </text>
              </g>
            ) : null,
          )
        ) : xTicks.length > 0 ? (
          /* An axis, rather than the two end captions this used to print. A
             label under each tick, and a hairline up the plot at it: "when was
             that spike" is the one question a time series is always asked, and
             two labels at the extremes is not an answer.
             
             The ends are pinned rather than centred. A label centred on the
             first tick hangs off the left of the plot, which is how an axis ends
             up wider than the figure that holds it. */
          xTicks.map((t, i) => {
            const px = PAD.left + sx(t.value)
            const first = px - PAD.left < 12
            const last = plotW - (px - PAD.left) < 12
            return (
              <g key={`${t.value}-${i}`}>
                <line
                  className="chart__grid chart__grid--x"
                  x1={px}
                  x2={px}
                  y1={PAD.top}
                  y2={PAD.top + plotH}
                />
                <text
                  className="chart__tick chart__tick--x"
                  x={first ? PAD.left : last ? width - PAD.right : px}
                  y={height - 10}
                  textAnchor={first ? 'start' : last ? 'end' : 'middle'}
                >
                  {t.label}
                </text>
              </g>
            )
          })
        ) : (
          <>
            <text className="chart__tick chart__tick--x" x={PAD.left} y={height - 10}>
              {labels[0]}
            </text>
            <text
              className="chart__tick chart__tick--x"
              x={width - PAD.right}
              y={height - 10}
              textAnchor="end"
            >
              {labels[1]}
            </text>
          </>
        )}
      </svg>

      {hover ? (
        <Tooltip
          result={result}
          spec={spec}
          model={model}
          row={hover.row}
          x={hover.x}
          width={width}
        />
      ) : null}

      {truncated > 0 ? (
        <p className="chart__note">
          First {MAX_BARS} of {MAX_BARS + truncated} rows. Narrow the query to chart the rest.
        </p>
      ) : null}
    </div>
  )
}

/** One panel per series, each on its own scale, sharing the x axis. The panel
 *  title names the series, so no panel needs a legend of one. */
function Facets({
  result,
  spec,
  model,
  width,
  height,
  hover,
  onHover,
}: {
  result: QueryResult
  spec: ChartSpec
  model: Model
  width: number
  /** What the whole stack has to fit in, which the panels divide. */
  height: number
  hover: Hover | null
  onHover: (h: Hover | null) => void
}) {
  /* One panel per series, each bounded on its own. Dividing a fixed 300 by the
     count — which is what this did — gave two measures 150px each and three
     100px, so the more a query had to say the less room each part of it got.
     
     The note and the shared axis come off before the division, and the gaps
     between panels with them: a stack sized as though it were all plot is a
     stack whose last panel and whose x axis are below the fold, clipped by the
     card with nothing saying so. */
  const panels = Math.min(3, model.series.length)
  const chrome = FACET_NOTE_H + FACET_AXIS_H + panels * 12
  const stack = plotHeight(width, Math.max(0, height - chrome), panels)
  const panelH = Math.max(96, Math.round(stack / panels))
  const plotW = Math.max(80, width - PAD.left - PAD.right)

  return (
    <div className="chart__body">
      <p className="chart__note">
        These measures are too far apart in scale to share an axis, so each has its own.
      </p>
      {model.series.map((s, si) => {
        const ys = s.points.map((p) => p.y).filter(Number.isFinite)
        const yMax = ys.length ? Math.max(...ys) : 1
        const yMin = ys.length ? Math.min(...ys) : 0
        return (
          <Facet
            key={s.name}
            name={s.name}
            colour={seriesColor(si)}
            points={s.points}
            xMin={model.xMin}
            xMax={model.xMax}
            yMin={yMin === yMax ? Math.min(0, yMin) : yMin}
            yMax={yMin === yMax ? (yMax === 0 ? 1 : yMax * 1.1) : yMax}
            width={width}
            plotW={plotW}
            height={panelH}
            hover={hover}
            onHover={onHover}
            xs={model.xs}
          />
        )
      })}
      <div className="chart__facetaxis" style={{ paddingLeft: PAD.left, paddingRight: PAD.right }}>
        <span>{model.labels[0]}</span>
        <span>{model.labels[1]}</span>
      </div>
      {hover ? (
        <Tooltip result={result} spec={spec} model={model} row={hover.row} x={hover.x} width={width} />
      ) : null}
    </div>
  )
}

function Facet({
  name,
  colour,
  points,
  xs,
  xMin,
  xMax,
  yMin,
  yMax,
  width,
  plotW,
  height,
  hover,
  onHover,
}: {
  name: string
  colour: string
  points: { x: number; y: number }[]
  xs: number[]
  xMin: number
  xMax: number
  yMin: number
  yMax: number
  width: number
  plotW: number
  height: number
  hover: Hover | null
  onHover: (h: Hover | null) => void
}) {
  const plotH = height - PAD.top
  const sx = (v: number) => (xMax === xMin ? plotW / 2 : ((v - xMin) / (xMax - xMin)) * plotW)
  const sy = (v: number) => (yMax === yMin ? plotH / 2 : plotH - ((v - yMin) / (yMax - yMin)) * plotH)
  const ticks = niceTicks(yMin, yMax, 2)

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - box.left - PAD.left
    if (px < -8 || px > plotW + 8) return onHover(null)
    let best = 0
    let bestD = Infinity
    xs.forEach((v, i) => {
      const d = Math.abs(sx(v) - px)
      if (d < bestD) {
        bestD = d
        best = i
      }
    })
    onHover({ row: best, x: PAD.left + sx(xs[best]!), y: 0 })
  }

  return (
    <div className="facet">
      <p className="facet__name" style={{ paddingLeft: PAD.left }}>
        <i className="chart__swatch" style={{ background: colour }} />
        {name}
      </p>
      <svg
        className="chart__svg"
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${name} over time`}
        onPointerMove={onMove}
        onPointerLeave={() => onHover(null)}
      >
        <g transform={`translate(${PAD.left} ${PAD.top})`}>
          {ticks.map((t) => (
            <line key={t} className="chart__grid" x1={0} x2={plotW} y1={sy(t)} y2={sy(t)} />
          ))}
          {ticks.map((t) => (
            <text key={`t${t}`} className="chart__tick" x={-10} y={sy(t)} textAnchor="end" dy="0.32em">
              {compact(t)}
            </text>
          ))}
          <path className="chart__area" d={areaPath(points, sx, sy, plotH)} fill={colour} />
          <path className="chart__line" d={linePath(points, sx, sy)} stroke={colour} />
          <EndMarker points={points} sx={sx} sy={sy} color={colour} />
          {hover ? (
            <line className="chart__cross" x1={sx(xs[hover.row]!)} x2={sx(xs[hover.row]!)} y1={0} y2={plotH} />
          ) : null}
          <line className="chart__axis" x1={0} x2={plotW} y1={plotH} y2={plotH} />
        </g>
      </svg>
    </div>
  )
}

/** 4px rounded data-end, square at the baseline: the shape says which end is
 *  the value and which is zero. */
function Bar({
  x,
  width,
  y,
  base,
  lit,
}: {
  x: number
  width: number
  y: number
  base: number
  lit: boolean
}) {
  const h = Math.max(0, base - y)
  const r = Math.min(4, width / 2, h)
  const d = `M ${x} ${base} L ${x} ${y + r} Q ${x} ${y} ${x + r} ${y} L ${x + width - r} ${y} Q ${
    x + width
  } ${y} ${x + width} ${y + r} L ${x + width} ${base} Z`
  return <path className={`chart__bar${lit ? ' is-lit' : ''}`} d={d} fill={seriesColor(0)} />
}

/** The last point carries a marker: ≥8px across, with a 2px ring in the surface
 *  colour so it stays legible where it crosses the line. */
function EndMarker({
  points,
  sx,
  sy,
  color,
}: {
  points: { x: number; y: number }[]
  sx: (v: number) => number
  sy: (v: number) => number
  color: string
}) {
  const last = [...points].reverse().find((p) => Number.isFinite(p.y))
  if (!last) return null
  return <circle className="chart__end" cx={sx(last.x)} cy={sy(last.y)} r={4} fill={color} />
}

function linePath(
  points: { x: number; y: number }[],
  sx: (v: number) => number,
  sy: (v: number) => number,
): string {
  let d = ''
  let open = false
  for (const p of points) {
    if (!Number.isFinite(p.y)) {
      // A gap rather than a line drawn through missing data.
      open = false
      continue
    }
    d += `${open ? 'L' : 'M'} ${round(sx(p.x))} ${round(sy(p.y))} `
    open = true
  }
  return d.trim()
}

function areaPath(
  points: { x: number; y: number }[],
  sx: (v: number) => number,
  sy: (v: number) => number,
  plotH: number,
): string {
  const good = points.filter((p) => Number.isFinite(p.y))
  if (good.length < 2) return ''
  const top = good.map((p) => `${round(sx(p.x))} ${round(sy(p.y))}`).join(' L ')
  return `M ${round(sx(good[0]!.x))} ${plotH} L ${top} L ${round(sx(good[good.length - 1]!.x))} ${plotH} Z`
}

const round = (n: number) => Math.round(n * 10) / 10

const TICK_FONT = '10.5px "Plus Jakarta Sans", system-ui, sans-serif'
/** Fallback when there is no canvas (jsdom): pessimistic, so the answer errs
 *  towards dropping a label rather than letting it collide. */
const CHAR_W = 7.2
const LABEL_GAP = 8

let ctx: CanvasRenderingContext2D | null | undefined

/** Real text width, because guessing it is how labels end up overlapping. */
function textWidth(text: string): number {
  if (ctx === undefined) {
    try {
      ctx = document.createElement('canvas').getContext('2d')
      if (ctx) ctx.font = TICK_FONT
    } catch {
      ctx = null
    }
  }
  return ctx ? ctx.measureText(text).width : text.length * CHAR_W
}

/** Every label in full, or none of them.
 *
 *  Truncating each one to what fits sounds accommodating but destroys the thing
 *  the label is for: thirty bars all reading `segm…` name nothing, and an
 *  ellipsis mid-word is the clipping the spec forbids. When they don't all fit,
 *  the two ends label the axis and the tooltip and table carry the rest. */
function labelsFit(labels: string[], band: number): boolean {
  return labels.every((l) => textWidth(l) + LABEL_GAP <= band)
}

function Tooltip({
  result,
  spec,
  model,
  row,
  x,
  width,
}: {
  result: QueryResult
  spec: ChartSpec
  model: Model
  row: number
  x: number
  width: number
}) {
  const flip = x > width * 0.6
  return (
    <div
      className={`chartip${flip ? ' chartip--left' : ''}`}
      style={{ left: flip ? undefined : x + 12, right: flip ? width - x + 12 : undefined }}
      role="status"
    >
      <p className="chartip__x">{model.rowLabel(row)}</p>
      {/* Every series at this position, so the pointer never has to land on a
          mark to get a value. The value leads; the name follows. */}
      {model.series.map((s, si) => (
        <p className="chartip__row" key={s.name}>
          <i className="chartip__key" style={{ background: seriesColor(si) }} />
          <span className="chartip__value">
            {Number.isFinite(s.points[row]?.y ?? NaN)
              ? compact(s.points[row]!.y)
              : cellText(result.rows[row]?.[spec.series[si]!]).text}
          </span>
          <span className="chartip__name">{s.name}</span>
        </p>
      ))}
      {/* The figure a stacked chart is actually read for. Its top edge asserts
          this number, and asserting it in a picture while withholding it from
          the tooltip is the one omission this form cannot afford. */}
      {model.stacked ? (
        <p className="chartip__row chartip__row--total">
          <i className="chartip__key chartip__key--none" />
          <span className="chartip__value">
            {compact(model.stacked[model.stacked.length - 1]!.upper[row] ?? NaN)}
          </span>
          <span className="chartip__name">together</span>
        </p>
      ) : null}
    </div>
  )
}

interface Model {
  xs: number[]
  series: { name: string; points: { x: number; y: number }[] }[]
  /** Cumulative bands, parallel to `series`, for the one form that stacks.
   *  `series` keeps the raw values throughout, so the tooltip reports what each
   *  measure actually was rather than where its band happened to sit. */
  stacked?: { lower: number[]; upper: number[] }[]
  /** Why this result cannot be drawn in the form that was asked for. Set
   *  instead of drawing, never as well as. */
  refusal?: string
  xMin: number
  xMax: number
  yMin: number
  yMax: number
  labels: [string, string]
  /** Whether the x axis is time. Decides which tick ladder the axis walks —
   *  calendar steps, or whole positions — and the model is the only thing that
   *  knows, since it is what parsed the column. */
  isTime: boolean
  truncated: number
  rowLabel: (row: number) => string
  /** Just the category, for a label under a bar. */
  rowLabelShort: (row: number) => string
}

export function buildModel(result: QueryResult, spec: ChartSpec): Model | null {
  if (spec.series.length === 0) return null

  // Bars are one mark per row, so the row count is the mark count; past forty
  // they stop being readable and the chart says what it left out.
  const cap = spec.kind === 'bar' ? MAX_BARS : result.rows.length
  const rows = result.rows.slice(0, cap)
  const truncated = Math.max(0, result.rows.length - rows.length)
  if (rows.length === 0) return null

  const isTime = spec.x >= 0 && (spec.kind === 'line' || spec.kind === 'area')

  /* A line's x axis is ordered by definition: the segment drawn between two
     points asserts that one came after the other. A `GROUP BY` hands its rows
     back in whatever order the engine produced them, so plotting them in row
     order drew a scribble across the middle of an ordinary time series — a
     picture of ClickHouse's memory layout rather than of the data.
     Ordered here rather than by attaching an `ORDER BY` to everybody's query:
     the requirement belongs to the picture, and a question is allowed to come
     back unordered. Bars keep row order on purpose — theirs is the query's,
     and re-sorting one would overrule a `ORDER BY` somebody wrote. */
  if (isTime) rows.sort((a, b) => parseTime(a[spec.x]) - parseTime(b[spec.x]))

  const xs = rows.map((r, i) => {
    if (spec.x < 0) return i
    if (isTime) return parseTime(r[spec.x])
    if (spec.kind === 'scatter') return parseNumber(r[spec.x])
    return i
  })

  const series = spec.series.map((ci) => ({
    name: result.columns[ci]?.name ?? '',
    points: rows.map((r, i) => ({ x: xs[i]!, y: parseNumber(r[ci]) })),
  }))

  const ys = series.flatMap((s) => s.points.map((p) => p.y)).filter(Number.isFinite)
  if (ys.length === 0) return null

  /* A stack cannot draw a negative, and the reason is not aesthetic: the top
     edge of a stacked area is the sum, and a band that descends makes the edge
     stop meaning that. The picker offers the form from the *shape* of the
     result — it never sees a value — so this is where the claim it makes gets
     checked against the numbers, and refused in words rather than drawn wrong.
     ClickHouse produces negatives here readily: a `sum(delta)`, a difference
     between two counts. */
  if (spec.kind === 'area' && ys.some((y) => y < 0)) {
    return {
      xs,
      series,
      xMin: 0,
      xMax: 0,
      yMin: 0,
      yMax: 0,
      labels: ['', ''],
      isTime: false,
      truncated,
      rowLabel: () => '',
      rowLabelShort: () => '',
      refusal:
        'These measures go negative, and a stack cannot draw that — its top edge would stop being the total. Read them as a line.',
    }
  }

  const xsGood = xs.filter(Number.isFinite)
  const xMin = Math.min(...xsGood)
  const xMax = Math.max(...xsGood)
  let yMin = Math.min(...ys)
  let yMax = Math.max(...ys)
  // A bar encodes its value as a length and a filled area encodes it as an
  // area, so both have to start at zero — an area rising from 50 says the
  // quantity is far bigger than it is. A bare multi-series line has no fill to
  // mislead with, and forcing zero on it flattens the shape it exists to show.
  const filled = spec.kind === 'line' && series.length === 1
  if (spec.kind === 'bar' || filled || spec.kind === 'area') yMin = Math.min(0, yMin)

  /* The bands, bottom series first. A measure missing at one x contributes
     nothing to the total there rather than carrying the stack across the gap:
     its band pinches shut, which is what "no value here" looks like, and the
     edge above it drops by exactly what is absent. Interpolating instead would
     put a number in the total that the query never returned. */
  let stacked: Model['stacked']
  if (spec.kind === 'area') {
    const running = new Array<number>(rows.length).fill(0)
    stacked = series.map((s) => {
      const lower = [...running]
      s.points.forEach((pt, i) => {
        running[i] = running[i]! + (Number.isFinite(pt.y) ? pt.y : 0)
      })
      return { lower, upper: [...running] }
    })
    yMax = Math.max(...running, 0)
  }
  if (yMin === yMax) {
    yMin = Math.min(0, yMin)
    yMax = yMax === 0 ? 1 : yMax * 1.1
  }

  const labelOf = (i: number): string => {
    if (spec.x < 0) return `row ${i + 1}`
    const v = rows[i]?.[spec.x]
    if (isTime) {
      const t = parseTime(v)
      return Number.isFinite(t) ? timeLabel(t, xMax - xMin) : cellText(v).text
    }
    return cellText(v).text
  }

  return {
    xs,
    series,
    stacked,
    xMin,
    xMax,
    yMin,
    yMax,
    labels: [labelOf(0), labelOf(rows.length - 1)],
    isTime,
    truncated,
    rowLabelShort: (row) => (spec.x < 0 ? String(row + 1) : cellText(rows[row]?.[spec.x]).text),
    rowLabel: (row) => {
      if (spec.x < 0) return `row ${row + 1}`
      const v = rows[row]?.[spec.x]
      if (isTime) {
        const t = parseTime(v)
        return Number.isFinite(t) ? new Date(t).toISOString().replace('T', ' ').slice(0, 19) : cellText(v).text
      }
      return `${result.columns[spec.x]?.name}: ${cellText(v).text}`
    },
  }
}

/** A stacked band: along the top edge, then back along the one below it.
 *
 *  Both edges are walked over the same `xs`, so a band never closes against a
 *  point its neighbour does not have — which is what produces the sawtooth a
 *  stack drawn from two independently filtered point lists gets. */
function bandPath(
  band: { lower: number[]; upper: number[] },
  xs: number[],
  sx: (v: number) => number,
  sy: (v: number) => number,
): string {
  if (xs.length < 2) return ''
  const top = xs.map((x, i) => `${round(sx(x))} ${round(sy(band.upper[i] ?? 0))}`).join(' L ')
  const back = [...xs]
    .map((x, i) => ({ x, i }))
    .reverse()
    .map(({ x, i }) => `${round(sx(x))} ${round(sy(band.lower[i] ?? 0))}`)
    .join(' L ')
  return `M ${top} L ${back} Z`
}

/* ── The ring ───────────────────────────────────────────────────────────────
 *
 * A donut and not a pie, for one reason that is not taste: the hole is where
 * the total goes. Every slice is a claim about a share, and a share with no
 * total beside it cannot be checked against anything — a pie has nowhere to
 * put that number and this form has a hole shaped exactly like it.
 *
 * The form is only ever offered where it can be honest — six slices or fewer,
 * a result Flint did not cut — so there is no "other" wedge here and no
 * remainder outside the circle. See `suggestCharts`. */

const RING = { box: 320, outer: 100, inner: 62, label: 116 }

function Donut({ result, spec }: { result: QueryResult; spec: ChartSpec }) {
  const [lit, setLit] = useState<number | null>(null)
  const value = spec.series[0]!
  const labels = result.rows.map((r) => cellText(r[spec.x]).text)
  const ring = buildRing(
    labels,
    result.rows.map((r) => parseNumber(r[value])),
  )
  if (typeof ring === 'string') return <p className="chart__none">{ring}</p>

  const c = RING.box / 2
  const name = result.columns[value]?.name ?? ''

  return (
    <div className="chart__body">
      <div className="donut">
        <svg
          className="donut__svg"
          width={RING.box}
          height={RING.box}
          viewBox={`0 0 ${RING.box} ${RING.box}`}
          role="img"
          aria-label={`${name} by ${result.columns[spec.x]?.name}, as shares of ${compact(ring.total)}`}
        >
          {ring.slices.map((s, i) => (
            <path
              key={s.label}
              className={`donut__slice${lit === i ? ' is-lit' : ''}`}
              d={ringPath(c, c, RING.outer, RING.inner, s.from, s.to)}
              fill={seriesColor(i)}
              onPointerEnter={() => setLit(i)}
              onPointerLeave={() => setLit(null)}
            >
              <title>{`${s.label}\n${s.value.toLocaleString('en')} — ${percent(s.share)}`}</title>
            </path>
          ))}

          {/* The share, outside the ring rather than on it.
              Inside was the first attempt and it failed twice over. It puts
              type on a categorical hue, which this file forbids everywhere
              else because a hue is illegible as text — and it was measured
              failing AA outright: the surface white it needed reaches only
              4.32:1 on the first slot and 4.10:1 on the fourth, against the
              4.5 that 10.5px demands. Outside, the label wears a text token
              and the contrast is the page's, whatever colour the slice is.

              Shown where the neighbouring labels will not collide, which out
              here is a question of arc length at the label's own radius rather
              than at the band's. The ones that miss out are not lost: every
              slice is named with its share in the legend, in full. */}
          {ring.slices.map((s) => {
            const angle = (s.from + s.to) / 2
            const sin = Math.sin(angle)
            if (s.share * 2 * Math.PI * RING.label < 14) return null
            return (
              <text
                key={s.label}
                className="donut__share"
                x={c + RING.label * sin}
                y={c - RING.label * Math.cos(angle)}
                textAnchor={sin > 0.1 ? 'start' : sin < -0.1 ? 'end' : 'middle'}
                dy="0.32em"
              >
                {percent(s.share)}
              </text>
            )
          })}

          {/* What the slices are shares of. The whole reason this is a ring. */}
          <text className="donut__total" x={c} y={c} textAnchor="middle" dy="0.1em">
            {compact(ring.total)}
          </text>
          <text className="donut__totallabel" x={c} y={c + 20} textAnchor="middle">
            together
          </text>
        </svg>

        {/* Always present, and it carries the figures rather than only the
            colours: identity is never colour alone, and a share is not a
            number anybody can read off an angle. */}
        <ul className="donut__legend">
          {ring.slices.map((s, i) => (
            <li
              key={s.label}
              className={`donut__key${lit === i ? ' is-lit' : ''}`}
              onPointerEnter={() => setLit(i)}
              onPointerLeave={() => setLit(null)}
            >
              <i className="chart__swatch" style={{ background: seriesColor(i) }} />
              <span className="donut__name" title={s.label}>
                {s.label}
              </span>
              <span className="donut__figure">{compact(s.value)}</span>
              <span className="donut__pct">{percent(s.share)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/** A share, at the precision a reader can act on. Under a tenth of a percent
 *  is `<0.1%` rather than `0%`: a slice that is drawn is a slice that is there,
 *  and printing zero beside a visible wedge is the contradiction the reader
 *  has to resolve. */
function percent(share: number): string {
  const pct = share * 100
  if (pct > 0 && pct < 0.1) return '<0.1%'
  return `${pct >= 10 ? Math.round(pct) : Number(pct.toPrecision(2))}%`
}

/* ── The grid ───────────────────────────────────────────────────────────────
 *
 * Two axes and a measure, where the value lives at a crossing rather than
 * along a line. One hue, more-is-darker: this is magnitude, so the colour job
 * is sequential and never the categorical palette — six hues across a grid
 * would say the cells are six different kinds of thing.
 *
 * It scrolls rather than truncates. Every other axis in this file has a fixed
 * band to fit its labels into and drops them when they do not fit; a grid has
 * a scroll container instead, so the honest answer here is to give each label
 * the room it needs and let the reader scroll to it. Nothing is ever `segm…`. */

const CELL = { w: 26, h: 22, gap: 2 }

function Heat({ result, spec }: { result: QueryResult; spec: ChartSpec }) {
  const value = spec.series[0]!
  const grid = useMemo(
    () =>
      spec.y === undefined
        ? null
        : buildGrid(result.rows, spec.x, spec.y, value, (v) => cellText(v).text),
    [result.rows, spec.x, spec.y, value],
  )
  if (!grid) return <p className="chart__none">Nothing in this result plots.</p>

  /* Both axes are sized to their own labels, and the measurement errs long.
     `textWidth` measures on a canvas, which cannot be told about
     `font-variant-numeric: tabular-nums` — and these labels are dates and
     device ids, which is to say almost all figures, where tabular is the wider
     of the two. It also answers with the fallback face when the webfont has
     not loaded yet. Both errors run the same way: the room comes out short and
     the label is clipped, which is the one outcome this file forbids
     everywhere. Measured before it was fixed: all 25 column labels over the
     top edge by 8px, and the last one 23px past the right.

     So the room is the larger of what the canvas says and what the character
     count implies at the pessimistic width the bar labels already use. */
  const room = (label: string) => Math.max(textWidth(label), label.length * CHAR_W)
  const gutter = Math.ceil(Math.max(24, ...grid.ys.map(room)) + 10)
  // A label at -45° reaches as far up as it does across, so the band above the
  // grid and the margin past its last column are the same number.
  const band = Math.ceil(Math.max(...grid.xs.map(room)) / Math.SQRT2 + 10)
  const w = gutter + grid.xs.length * CELL.w + band
  const h = band + grid.ys.length * CELL.h + 2
  const xName = result.columns[spec.x]?.name ?? ''
  const yName = result.columns[spec.y!]?.name ?? ''

  return (
    <div className="chart__body">
      <div className="heat">
        <svg
          className="heat__svg"
          width={w}
          height={h}
          viewBox={`0 0 ${w} ${h}`}
          role="img"
          aria-label={`${result.columns[value]?.name} at each crossing of ${xName} and ${yName}`}
        >
          {grid.xs.map((x, i) => (
            <text
              key={x}
              className="chart__tick heat__x"
              transform={`translate(${gutter + i * CELL.w + CELL.w / 2} ${band - 6}) rotate(-45)`}
            >
              {x}
            </text>
          ))}

          {grid.ys.map((y, r) => (
            <text
              key={y}
              className="chart__tick"
              x={gutter - 8}
              y={band + r * CELL.h + CELL.h / 2}
              textAnchor="end"
              dy="0.32em"
            >
              {y}
            </text>
          ))}

          {grid.cells.map((row, r) =>
            row.map((v, i) => {
              const x = gutter + i * CELL.w
              const y = band + r * CELL.h
              const label = `${grid.xs[i]} · ${grid.ys[r]}`
              /* A crossing the query never returned is not a crossing that
                 returned nothing. Drawn as an outline rather than as the
                 palest step of the ramp, because the palest step is what a
                 real zero wears and the two facts are different answers. */
              if (v === null) {
                return (
                  <rect
                    key={`${r}-${i}`}
                    className="heat__none"
                    x={x + CELL.gap / 2}
                    y={y + CELL.gap / 2}
                    width={CELL.w - CELL.gap}
                    height={CELL.h - CELL.gap}
                    rx={2}
                  >
                    <title>{`${label}\nnever together`}</title>
                  </rect>
                )
              }
              return (
                <rect
                  key={`${r}-${i}`}
                  className="heat__cell"
                  x={x + CELL.gap / 2}
                  y={y + CELL.gap / 2}
                  width={CELL.w - CELL.gap}
                  height={CELL.h - CELL.gap}
                  rx={2}
                  fillOpacity={cellFill(v, grid.scale)}
                >
                  <title>
                    {`${label}\n${v.toLocaleString('en')}${
                      grid.scale > 0 && v > grid.scale ? '\npast the scale — drawn full' : ''
                    }`}
                  </title>
                </rect>
              )
            }),
          )}
        </svg>
      </div>

      <HeatScale grid={grid} xName={xName} yName={yName} />
    </div>
  )
}

/** The ramp, and everything the grid left out.
 *
 *  The scale is the 90th percentile rather than the maximum, so the darkest
 *  cell is not necessarily the largest value — which is a fact a reader has to
 *  be told, not one they can infer. Every cap states its own count on the same
 *  rule as the rest of the product. */
function HeatScale({ grid, xName, yName }: { grid: Grid; xName: string; yName: string }) {
  const notes: string[] = []
  if (grid.xCut > 0) notes.push(`${grid.xs.length} of ${grid.xs.length + grid.xCut} ${xName} values`)
  if (grid.yCut > 0) notes.push(`${grid.ys.length} of ${grid.ys.length + grid.yCut} ${yName} values`)
  if (grid.past > 0) {
    notes.push(`${grid.past} ${grid.past === 1 ? 'cell is' : 'cells are'} past the scale, drawn full`)
  }
  return (
    <div className="heat__foot">
      <span className="heat__ramp" aria-hidden="true">
        {[0.2, 0.4, 0.6, 0.8, 1].map((f) => (
          <i key={f} style={{ '--fill': f } as React.CSSProperties} />
        ))}
      </span>
      <span className="heat__scale">
        none to {compact(grid.scale)}
        {grid.past > 0 ? ' (the 90th percentile, not the largest)' : ''}
      </span>
      {notes.length ? <span className="chart__omitted">{notes.join(' · ')}</span> : null}
    </div>
  )
}
