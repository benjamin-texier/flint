import { useEffect, useMemo, useRef, useState } from 'react'

import type { QueryResult } from '../lib/api'
import {
  MAX_SERIES,
  compact,
  needsFacets,
  niceTicks,
  parseNumber,
  parseTime,
  timeLabel,
  type ChartSpec,
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

interface Hover {
  /** Row index under the pointer. */
  row: number
  x: number
  y: number
}

export function Chart({ result, spec }: { result: QueryResult; spec: ChartSpec }) {
  const wrap = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(720)
  const [hover, setHover] = useState<Hover | null>(null)
  const height = spec.kind === 'stat' ? 160 : 300

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      const w = entry?.contentRect.width
      if (w && w > 0) setWidth(w)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

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
          {hover && spec.kind !== 'bar' ? (
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
  hover,
  onHover,
}: {
  result: QueryResult
  spec: ChartSpec
  model: Model
  width: number
  hover: Hover | null
  onHover: (h: Hover | null) => void
}) {
  const panelH = Math.max(96, Math.round(300 / Math.min(3, model.series.length)))
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
    </div>
  )
}

interface Model {
  xs: number[]
  series: { name: string; points: { x: number; y: number }[] }[]
  xMin: number
  xMax: number
  yMin: number
  yMax: number
  labels: [string, string]
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

  const isTime = spec.x >= 0 && spec.kind === 'line'
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
  if (spec.kind === 'bar' || filled) yMin = Math.min(0, yMin)
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
    xMin,
    xMax,
    yMin,
    yMax,
    labels: [labelOf(0), labelOf(rows.length - 1)],
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
