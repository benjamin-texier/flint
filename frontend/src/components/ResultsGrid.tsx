import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

import type { QueryResult } from '../lib/api'
import { family, familyColor, shortType } from '../lib/chType'
import type { Aggregate, CellKind, CellRef, GridColumn, Sort } from '../lib/grid'
import {
  barScales,
  barWidth,
  cellText,
  columnAggregate,
  displayOrder,
  inSpan,
  nextAggregate,
  nextSort,
  prettyJSON,
  rawText,
  sampleColumn,
  selectionStats,
  shapeKey,
  span,
  spanSize,
  toTSV,
  widthChars,
} from '../lib/grid'
import { TypeIcon } from './TypeIcon'
import { count, exact } from '../lib/format'

/* The virtualizer needs these as numbers, so they are stated here and again as
 * `--table-row-h`, `--table-head-h` and `--table-pad` in the stylesheet, where
 * the reference tables read them too. The two statements have to agree. */
/** A computed figure, at the size it reads best: compact past a thousand, where
 *  the digits stop carrying information and start costing width, and two
 *  decimals below it, where an average of 3.22 is the answer and 3 is not. */
function figure(value: number): string {
  if (Math.abs(value) >= 1000) return count(value)
  return Number.isInteger(value) ? String(value) : (Math.round(value * 100) / 100).toString()
}

/** One figure over the selection, with the exact number in the title: something
 *  about to be pasted into a report has to be readable in full somewhere. */
function Stat({ label, value }: { label: string; value: number }) {
  const round = Number.isInteger(value) ? value : Math.round(value * 100) / 100
  return (
    <span className="gridshell__stat" title={`${label} ${exact(round)}`}>
      <span className="gridshell__statkey">{label}</span>
      {figure(value)}
    </span>
  )
}

const ROW_H = 25
const HEAD_H = 34
const GUTTER_W = 58
/** Twice `--table-pad`: the padding either side of `.grid__cell`. */
const CELL_PAD = 22
const MIN_W = 52
const MAX_W = 900
/** Pixels of columns kept rendered either side of the port, so a flick sideways
 *  does not show a bare stripe before React catches up. */
const OVERSCAN_X = 320
const FALLBACK_CH = 7.8

/** A virtualized result grid.
 *
 *  Both axes are windowed: rows because there can be ten thousand of them, and
 *  columns because `system.columns` and friends are eighty wide and rendering
 *  eighty cells forty times over is eighty times more DOM than the eye can
 *  read. Row heights are fixed, column widths are measured from the values
 *  actually present, and a column you drag wider stays wider for that shape of
 *  result. Cells are selectable and copy out as TSV, because reading a value is
 *  only half of what anyone does with a query result. */
export function ResultsGrid({ result }: { result: QueryResult }) {
  const scroller = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  // Focus stays on the grid while the arrow keys move a cell inside it, so the
  // only way to tell assistive technology which cell that is is to name it and
  // point at it. Without this, a screen reader user arrows around a grid that
  // says nothing back.
  const gridId = useId()
  const cellId = (row: number, col: number) => `${gridId}c${row}-${col}`
  const charW = useCharWidth()
  const columns = result.columns
  const shape = useMemo(() => shapeKey(columns), [columns])

  const [sort, setSort] = useState<Sort[]>([])
  const [pinned, setPinned] = useState<number[]>([])
  const [widthOverrides, setWidthOverrides] = useState<Record<number, number>>({})
  const [anchor, setAnchor] = useState<CellRef | null>(null)
  const [head, setHead] = useState<CellRef | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const [bars, setBars] = useState(false)
  const [hidden, setHidden] = useState<ReadonlySet<number>>(() => new Set())
  const [totals, setTotals] = useState(false)
  /** Per column, because the useful footer is a sum of bytes beside an average
   *  of ratios — one calculation for the whole row would be wrong twice. */
  const [aggregates, setAggregates] = useState<Record<number, Aggregate>>({})
  const [picking, setPicking] = useState(false)
  const picker = useRef<HTMLDivElement>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [scrollX, setScrollX] = useState(0)
  const [portW, setPortW] = useState(0)

  // A new shape of result is a new grid: nothing about the old one still means
  // anything, except the widths somebody dragged the last time they ran it.
  useEffect(() => {
    setWidthOverrides(loadWidths(shape))
    setHidden(new Set())
    setPicking(false)
    setTotals(false)
    setAggregates({})
    setSort([])
    setPinned([])
    setAnchor(null)
    setHead(null)
    setInspecting(false)
  }, [shape])

  useEffect(() => {
    const stop = () => {
      dragging.current = false
    }
    window.addEventListener('pointerup', stop)
    return () => window.removeEventListener('pointerup', stop)
  }, [])

  useEffect(() => {
    if (!flash) return
    const timer = window.setTimeout(() => setFlash(null), 2600)
    return () => window.clearTimeout(timer)
  }, [flash])

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    setPortW(el.clientWidth)
    const observer = new ResizeObserver(() => setPortW(el.clientWidth))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // A popover dismisses itself: Escape, or a press anywhere that is not in it.
  // The same contract the diagram's menu keeps, for the same reason — a panel
  // that can only be closed by the button that opened it is a trap.
  useEffect(() => {
    if (!picking) return
    const onDown = (event: PointerEvent) => {
      if (!picker.current?.contains(event.target as Node)) setPicking(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPicking(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [picking])

  const baseCh = useMemo(
    () => columns.map((c, i) => widthChars(c, sampleColumn(result.rows, i))),
    [columns, result.rows],
  )
  const widths = useMemo(
    () =>
      baseCh.map((ch, i) => {
        const override = widthOverrides[i]
        // Ceil, plus a pixel: rounding down costs the last character of every
        // value that fits exactly, which is most of a DateTime column.
        return override ?? Math.ceil(ch * charW) + CELL_PAD + 1
      }),
    [baseCh, widthOverrides, charW],
  )

  /** Columns left to right as they are drawn: the pinned ones first, then the
   *  rest in the order the query asked for them, minus anything put away.
   *  Everything about selection and keyboard movement counts in this space, so a
   *  copy matches what you see — including the fact that a hidden column is not
   *  in the copy either. */
  const visual = useMemo(() => {
    const isPinned = new Set(pinned)
    const shown = (i: number) => !hidden.has(i)
    const rest = columns.map((_, i) => i).filter((i) => !isPinned.has(i) && shown(i))
    return [...pinned.filter(shown), ...rest]
  }, [pinned, columns, hidden])

  const layout = useMemo(() => {
    const frozen = pinned.filter((i) => !hidden.has(i))
    const frozenW = frozen.reduce((sum, i) => sum + (widths[i] ?? 0), GUTTER_W)
    const flow: { index: number; x: number; w: number }[] = []
    let x = 0
    for (let p = frozen.length; p < visual.length; p++) {
      const index = visual[p] ?? 0
      const w = widths[index] ?? MIN_W
      flow.push({ index, x, w })
      x += w
    }
    return { frozen, frozenW, flow, innerW: frozenW + x }
  }, [pinned, visual, widths, hidden])

  // The horizontal window. A linear walk over a few hundred columns is nothing
  // next to a repaint, and it keeps the arithmetic legible.
  const [firstCol, lastCol] = useMemo(() => {
    const { flow, frozenW } = layout
    if (flow.length === 0) return [0, -1] as const
    const left = scrollX - OVERSCAN_X
    const right = scrollX + Math.max(portW - frozenW, 0) + OVERSCAN_X
    let a = 0
    while (a < flow.length - 1 && (flow[a + 1]?.x ?? 0) <= left) a++
    let b = a
    while (b < flow.length - 1 && (flow[b]?.x ?? 0) + (flow[b]?.w ?? 0) < right) b++
    return [a, b] as const
  }, [layout, scrollX, portW])

  const window_ = layout.flow.slice(firstCol, lastCol + 1)

  const order = useMemo(() => displayOrder(result.rows, columns, sort), [result.rows, columns, sort])

  // Sampled like the widths are: a scale read off every 200th row is the same
  // scale, and a bar is a comparison rather than a measurement.
  const scales = useMemo(() => (bars ? barScales(result.rows, columns) : []), [bars, result.rows, columns])
  const barsPossible = useMemo(
    () => columns.some((c) => family(c.type) === 'number'),
    [columns],
  )
  const rows = useVirtualizer({
    count: order.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  })

  const selection = anchor && head ? span(anchor, head) : null

  // The spreadsheet reflex: select a block of numbers and the sum is right
  // there. Exact rather than sampled — the whole result is already in the
  // browser, so there is nothing to approximate — and skipped for a single
  // cell, where the value beside it is the answer.
  const stats = useMemo(() => {
    if (!selection || spanSize(selection) < 2) return null
    return selectionStats(
      result.rows,
      columns,
      order.slice(selection.row0, selection.row1 + 1),
      visual.slice(selection.col0, selection.col1 + 1),
    )
  }, [selection, result.rows, columns, order, visual])

  /** Bring a cell into view. Pinned columns are always in view by definition,
   *  and the sticky header eats the top of the port, so neither axis is a plain
   *  `scrollIntoView`. */
  const reveal = useCallback(
    (row: number, col: number) => {
      const el = scroller.current
      if (!el) return
      const top = row * ROW_H
      const portH = el.clientHeight - HEAD_H
      if (top < el.scrollTop) el.scrollTop = top
      else if (top + ROW_H > el.scrollTop + portH) el.scrollTop = top + ROW_H - portH
      const item = layout.flow[col - layout.frozen.length]
      if (!item) return
      const portX = el.clientWidth - layout.frozenW
      if (item.x < el.scrollLeft) el.scrollLeft = item.x
      else if (item.x + item.w > el.scrollLeft + portX) el.scrollLeft = item.x + item.w - portX
    },
    [layout],
  )

  const move = useCallback(
    (row: number, col: number, extend: boolean) => {
      const target = {
        row: clamp(row, 0, order.length - 1),
        col: clamp(col, 0, visual.length - 1),
      }
      setHead(target)
      if (!extend || !anchor) setAnchor(target)
      reveal(target.row, target.col)
    },
    [order.length, visual.length, anchor, reveal],
  )

  const pick = (row: number, col: number, extend: boolean) => {
    scroller.current?.focus({ preventScroll: true })
    dragging.current = true
    setHead({ row, col })
    if (!extend || !anchor) setAnchor({ row, col })
  }

  const copy = useCallback(
    (withHeader: boolean) => {
      if (!selection) return
      const rowIndices = order.slice(selection.row0, selection.row1 + 1)
      const colIndices = visual.slice(selection.col0, selection.col1 + 1)
      const tsv = toTSV(result.rows, columns, rowIndices, colIndices, withHeader)
      const size = spanSize(selection)
      navigator.clipboard.writeText(tsv).then(
        () => setFlash(`${size} ${size === 1 ? 'cell' : 'cells'} copied`),
        () => setFlash('the browser would not give up the clipboard'),
      )
    },
    [selection, order, visual, result.rows, columns],
  )

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const mod = event.metaKey || event.ctrlKey
    const at = head ?? { row: 0, col: 0 }
    const page = Math.max(1, Math.floor(((scroller.current?.clientHeight ?? 0) - HEAD_H) / ROW_H) - 1)
    const handled = () => {
      event.preventDefault()
      event.stopPropagation()
    }

    switch (event.key) {
      case 'ArrowDown':
        handled()
        return move(mod ? order.length - 1 : at.row + 1, at.col, event.shiftKey)
      case 'ArrowUp':
        handled()
        return move(mod ? 0 : at.row - 1, at.col, event.shiftKey)
      case 'ArrowRight':
        handled()
        return move(at.row, mod ? visual.length - 1 : at.col + 1, event.shiftKey)
      case 'ArrowLeft':
        handled()
        return move(at.row, mod ? 0 : at.col - 1, event.shiftKey)
      case 'PageDown':
        handled()
        return move(at.row + page, at.col, event.shiftKey)
      case 'PageUp':
        handled()
        return move(at.row - page, at.col, event.shiftKey)
      case 'Home':
        handled()
        return move(mod ? 0 : at.row, 0, event.shiftKey)
      case 'End':
        handled()
        return move(mod ? order.length - 1 : at.row, visual.length - 1, event.shiftKey)
      case 'Enter':
        handled()
        if (!head) move(0, 0, false)
        return setInspecting(true)
      case 'Escape':
        handled()
        if (inspecting) return setInspecting(false)
        setAnchor(null)
        return setHead(null)
      case 'a':
        if (!mod) return
        handled()
        setAnchor({ row: 0, col: 0 })
        return setHead({ row: order.length - 1, col: visual.length - 1 })
      case 'c':
        if (!mod) return
        handled()
        return copy(event.shiftKey)
      default:
    }
  }

  const startResize = (event: ReactPointerEvent<HTMLDivElement>, index: number) => {
    event.preventDefault()
    event.stopPropagation()
    const handle = event.currentTarget
    const startX = event.clientX
    const startW = widths[index] ?? MIN_W
    let last = startW
    handle.setPointerCapture(event.pointerId)
    const drag = (moved: PointerEvent) => {
      last = clamp(startW + moved.clientX - startX, MIN_W, MAX_W)
      setWidthOverrides({ ...widthOverrides, [index]: last })
    }
    const stop = () => {
      handle.releasePointerCapture(event.pointerId)
      handle.removeEventListener('pointermove', drag)
      handle.removeEventListener('pointerup', stop)
      saveWidths(shape, { ...widthOverrides, [index]: last })
    }
    handle.addEventListener('pointermove', drag)
    handle.addEventListener('pointerup', stop)
  }

  const autoWidth = (index: number) => {
    const next = { ...widthOverrides }
    delete next[index]
    setWidthOverrides(next)
    saveWidths(shape, next)
  }

  const togglePin = (index: number) => {
    setPinned((current) =>
      current.includes(index) ? current.filter((i) => i !== index) : [...current, index],
    )
    setAnchor(null)
    setHead(null)
  }

  const applySort = (index: number, extend: boolean) => {
    setSort((current) => nextSort(current, index, extend))
    setAnchor(null)
    setHead(null)
    setInspecting(false)
    if (scroller.current) scroller.current.scrollTop = 0
  }

  const headCell = (index: number, col: number, style: CSSProperties) => {
    const column = columns[index]
    if (!column) return null
    const level = sort.findIndex((s) => s.column === index)
    const sorted = level === -1 ? null : sort[level]!.dir
    const isPinned = pinned.includes(index)
    return (
      <div
        className={`grid__cell grid__headcell${head?.col === col ? ' is-activecol' : ''}`}
        key={index}
        role="columnheader"
        aria-colindex={index + 1}
        aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}
        style={style}
      >
        <button
          className="grid__sort"
          onClick={(event) => applySort(index, event.shiftKey)}
          title={`Sort the ${result.rows.length} rows on screen by ${column.name} · shift-click to add a level`}
          type="button"
        >
          <TypeIcon type={column.type} />
          <span className="grid__colname">{column.name}</span>
          <span className="grid__coltype" style={{ color: familyColor(column.type) }}>
            {shortType(column.type)}
          </span>
          {sorted ? <SortMark dir={sorted} /> : null}
          {/* The rank only appears once there is a stack to rank within. */}
          {sorted && sort.length > 1 ? (
            <span className="grid__sortlevel">{level + 1}</span>
          ) : null}
        </button>
        <button
          className={`grid__pin${isPinned ? ' is-on' : ''}`}
          onClick={() => togglePin(index)}
          title={isPinned ? 'Unpin this column' : 'Pin this column to the left'}
          aria-pressed={isPinned}
          type="button"
        >
          <PinMark />
        </button>
        <div
          className="grid__resize"
          onPointerDown={(event) => startResize(event, index)}
          onDoubleClick={() => autoWidth(index)}
          title="Drag to resize · double-click to fit"
          role="presentation"
        />
      </div>
    )
  }

  const bodyCell = (
    row: readonly unknown[],
    display: number,
    index: number,
    col: number,
    style: CSSProperties,
  ) => {
    const column = columns[index]
    if (!column) return null
    const value = row[index]
    const { text, kind } = cellText(value)
    const selected = selection ? inSpan(selection, display, col) : false
    const active = head?.row === display && head.col === col
    const clipped = text.length * charW + CELL_PAD > (widths[index] ?? 0)
    return (
      <div
        id={cellId(display, col)}
        className={
          'grid__cell' +
          (kind === 'value' ? '' : kind === 'null' ? ' grid__cell--null' : ' grid__cell--empty') +
          (family(column.type) === 'number' ? ' grid__cell--num' : '') +
          (selected ? ' is-sel' : '') +
          (active ? ' is-active' : '')
        }
        key={index}
        role="gridcell"
        aria-colindex={index + 1}
        aria-selected={selected}
        style={{
          ...style,
          color: valueColor(column.type, kind),
          // Behind the figure, not instead of it: the bar is a background so the
          // number stays selectable, copyable and exactly where it was.
          ...(bars && barWidth(value, scales[index] ?? null) > 0
            ? {
                backgroundImage: `linear-gradient(to right, var(--bar-cell) ${barWidth(
                  value,
                  scales[index] ?? null,
                )}%, transparent 0)`,
              }
            : null),
        }}
        title={clipped ? text.slice(0, 400) : undefined}
        onPointerDown={(event) => pick(display, col, event.shiftKey)}
        onPointerEnter={() => {
          if (dragging.current) move(display, col, true)
        }}
        onDoubleClick={() => setInspecting(true)}
      >
        {text}
      </div>
    )
  }

  const totalCell = (index: number, style: CSSProperties) => {
    const column = columns[index]
    if (!column) return null
    const kind = aggregates[index] ?? 'sum'
    const value = columnAggregate(result.rows, columns, index, kind)
    return (
      <div
        className={`grid__cell grid__cell--total${value === null ? '' : ' grid__cell--num'}`}
        key={index}
        style={style}
      >
        {value === null ? null : (
          <button
            className="grid__totalbtn"
            onClick={() => setAggregates((c) => ({ ...c, [index]: nextAggregate(kind) }))}
            title={`${kind} of ${column.name} over these ${result.rows.length} rows: ${exact(
              Math.round(value * 100) / 100,
            )} · click to change the calculation`}
            type="button"
          >
            <span className="grid__totalkind">{kind}</span>
            {figure(value)}
          </button>
        )}
      </div>
    )
  }

  const inspected = inspecting && head ? visual[head.col] : undefined
  const inspectedColumn = inspected === undefined ? undefined : columns[inspected]

  return (
    <div className="gridshell">
      <div className="gridshell__bar">
        <div className="gridshell__state">
          {sort.length > 0 ? (
            <>
              <span className="gridshell__sorted">
                sorted by{' '}
                {sort
                  .map(
                    (level) =>
                      `${columns[level.column]?.name} ${
                        level.dir === 'asc' ? 'ascending' : 'descending'
                      }`,
                  )
                  .join(', then ')}
              </span>
              <span className="gridshell__caveat">
                these {result.rows.length} rows, not the table
              </span>
              <button className="gridshell__clear" onClick={() => setSort([])} type="button">
                clear
              </button>
            </>
          ) : selection && spanSize(selection) > 1 ? (
            <>
              <span className="gridshell__sel">
                {selection.row1 - selection.row0 + 1} × {selection.col1 - selection.col0 + 1}{' '}
                selected
              </span>
              {stats ? (
                <span className="gridshell__stats num" role="status">
                  <Stat label="sum" value={stats.sum} />
                  <Stat label="avg" value={stats.avg} />
                  <Stat label="min" value={stats.min} />
                  <Stat label="max" value={stats.max} />
                  <span className="gridshell__stat is-dim">
                    <span className="gridshell__statkey">numbers</span>
                    {exact(stats.numbers)}
                  </span>
                </span>
              ) : null}
            </>
          ) : null}
        </div>
        {columns.length > 1 ? (
          <div className="gridshell__picker" ref={picker}>
            <button
              className={`gridshell__toggle${hidden.size > 0 ? ' is-on' : ''}`}
              aria-expanded={picking}
              onClick={() => setPicking((p) => !p)}
              title="Choose which columns are drawn"
              type="button"
            >
              {hidden.size > 0 ? `columns · ${hidden.size} hidden` : 'columns'}
            </button>
            {picking ? (
              <div className="colpick" role="group" aria-label="Columns to draw">
                <div className="colpick__head">
                  <span className="colpick__count">
                    {columns.length - hidden.size} of {columns.length} drawn
                  </span>
                  <button
                    className="colpick__all"
                    onClick={() => setHidden(new Set())}
                    type="button"
                  >
                    show all
                  </button>
                </div>
                <div className="colpick__list">
                  {columns.map((column, index) => (
                    <label className="colpick__item" key={index}>
                      <input
                        type="checkbox"
                        checked={!hidden.has(index)}
                        onChange={() =>
                          setHidden((current) => {
                            const next = new Set(current)
                            if (next.has(index)) next.delete(index)
                            // The last drawn column stays: a grid of nothing is
                            // not a view of a result, it is a bug report.
                            else if (columns.length - next.size > 1) next.add(index)
                            return next
                          })
                        }
                      />
                      <span className="colpick__name">{column.name}</span>
                      <span
                        className="colpick__type"
                        style={{ color: familyColor(column.type) }}
                      >
                        {shortType(column.type)}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        {barsPossible ? (
          <button
            className={`gridshell__toggle${totals ? ' is-on' : ''}`}
            aria-pressed={totals}
            onClick={() => setTotals((t) => !t)}
            title="A row of totals over the rows on screen"
            type="button"
          >
            totals
          </button>
        ) : null}
        {barsPossible ? (
          <button
            className={`gridshell__toggle${bars ? ' is-on' : ''}`}
            aria-pressed={bars}
            onClick={() => setBars((b) => !b)}
            title="A bar in each numeric cell, scaled against the column"
            type="button"
          >
            data bars
          </button>
        ) : null}
        <div className={`gridshell__hint${flash ? ' is-flash' : ''}`} aria-live="polite">
          {flash ?? 'arrows move · shift extends · ⌘C copies · ⏎ inspects'}
        </div>
      </div>

      <div className="gridshell__main">
        <div
          className="grid"
          ref={scroller}
          role="grid"
          tabIndex={0}
          aria-rowcount={order.length}
          aria-colcount={columns.length}
          aria-activedescendant={head ? cellId(head.row, head.col) : undefined}
          onScroll={() => {
            const el = scroller.current
            if (el && el.scrollLeft !== scrollX) setScrollX(el.scrollLeft)
          }}
          onKeyDown={onKeyDown}
        >
          <div
            className={`grid__canvas${scrollX > 0 ? ' is-lifted' : ''}`}
            style={{ width: layout.innerW }}
          >
            <div className="grid__head" role="row">
              <div className="grid__frozen" style={{ width: layout.frozenW }}>
                <div
                  className="grid__cell grid__cell--gutter grid__cell--corner label"
                  style={{ width: GUTTER_W }}
                >
                  #
                </div>
                {layout.frozen.map((index, col) => headCell(index, col, { width: widths[index] }))}
              </div>
              {window_.map((item, i) =>
                headCell(item.index, layout.frozen.length + firstCol + i, {
                  position: 'absolute',
                  left: layout.frozenW + item.x,
                  width: item.w,
                }),
              )}
            </div>

            <div className="grid__body" role="rowgroup" style={{ height: rows.getTotalSize() }}>
              {rows.getVirtualItems().map((virtual) => {
                const row = result.rows[order[virtual.index] ?? 0] ?? []
                const display = virtual.index
                return (
                  <div
                    className="grid__row"
                    key={virtual.key}
                    role="row"
                    aria-rowindex={display + 1}
                    style={{ transform: `translateY(${virtual.start}px)` }}
                  >
                    <div className="grid__frozen" style={{ width: layout.frozenW }}>
                      <div
                        className="grid__cell grid__cell--gutter"
                        style={{ width: GUTTER_W }}
                        onPointerDown={() => {
                          scroller.current?.focus({ preventScroll: true })
                          setAnchor({ row: display, col: 0 })
                          setHead({ row: display, col: visual.length - 1 })
                        }}
                        title="Select this row"
                      >
                        {display + 1}
                      </div>
                      {layout.frozen.map((index, col) =>
                        bodyCell(row, display, index, col, { width: widths[index] }),
                      )}
                    </div>
                    {window_.map((item, i) =>
                      bodyCell(row, display, item.index, layout.frozen.length + firstCol + i, {
                        position: 'absolute',
                        left: layout.frozenW + item.x,
                        width: item.w,
                      }),
                    )}
                  </div>
                )
              })}
            </div>

            {totals ? (
              <div className="grid__totals" role="row">
                <div className="grid__frozen" style={{ width: layout.frozenW }}>
                  <div className="grid__cell grid__cell--gutter grid__cell--total label" style={{ width: GUTTER_W }}>
                    Σ
                  </div>
                  {layout.frozen.map((index) => totalCell(index, { width: widths[index] }))}
                </div>
                {window_.map((item) =>
                  totalCell(item.index, {
                    position: 'absolute',
                    left: layout.frozenW + item.x,
                    width: item.w,
                  }),
                )}
              </div>
            ) : null}
          </div>
        </div>

        {inspectedColumn && head ? (
          <CellInspector
            column={inspectedColumn}
            value={(result.rows[order[head.row] ?? 0] ?? [])[inspected ?? 0]}
            row={head.row + 1}
            onClose={() => {
              setInspecting(false)
              scroller.current?.focus({ preventScroll: true })
            }}
          />
        ) : null}
      </div>
    </div>
  )
}

/** The whole value, unfolded. A grid cell is one line tall and a `String` can
 *  be a megabyte of JSON; this is where that gets read rather than guessed at
 *  from the first forty characters. */
function CellInspector({
  column,
  value,
  row,
  onClose,
}: {
  column: GridColumn
  value: unknown
  row: number
  onClose: () => void
}) {
  const raw = rawText(value)
  const pretty = prettyJSON(value)
  const { kind } = cellText(value)
  const facts = [
    `row ${row}`,
    kind === 'null' ? 'NULL' : kind === 'empty' ? 'empty string' : `${raw.length} chars`,
    pretty ? 'JSON' : null,
  ].filter(Boolean)

  return (
    <aside className="inspect" aria-label={`Value of ${column.name}`}>
      <header className="inspect__head">
        <div className="inspect__id">
          <div className="inspect__name">{column.name}</div>
          <div className="inspect__type" style={{ color: familyColor(column.type) }}>
            {column.type}
          </div>
        </div>
        <button className="inspect__close" onClick={onClose} aria-label="Close" type="button">
          ×
        </button>
      </header>
      <div className="inspect__meta label">{facts.join(' · ')}</div>
      <pre className={`inspect__value${kind === 'value' ? '' : ' inspect__value--absent'}`}>
        {kind === 'null' ? 'NULL' : (pretty ?? raw)}
      </pre>
      <footer className="inspect__foot">
        <button
          className="btn"
          onClick={() => void navigator.clipboard.writeText(raw)}
          type="button"
        >
          Copy value
        </button>
      </footer>
    </aside>
  )
}

function SortMark({ dir }: { dir: 'asc' | 'desc' }) {
  return (
    <svg className="grid__sortmark" viewBox="0 0 8 8" aria-hidden="true">
      <path d={dir === 'asc' ? 'M4 1.5 7 6H1z' : 'M4 6.5 1 2h6z'} fill="currentColor" />
    </svg>
  )
}

function PinMark() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M4.6 1.4h2.8l-.4 3.1 1.7 1.7v.9H3.3v-.9L5 4.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <path d="M6 7.1v3.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

/** Numbers, timestamps, booleans and nested values carry their family's colour,
 *  the same one the type name wears in the header. Strings do not: they are the
 *  majority of most results, and a grid where every cell is coloured has told
 *  you nothing about any of them.
 *
 *  Pulled back towards the ink, though. A hue that reads well on one type badge
 *  is loud down two hundred rows of a timestamp column, and the colour only has
 *  to say which family this is — not compete with the value for attention. */
function valueColor(type: string, kind: CellKind): string | undefined {
  if (kind !== 'value') return undefined
  const f = family(type)
  if (f === 'string' || f === 'other') return undefined
  return `color-mix(in srgb, var(--t-${f}) 82%, var(--chalk))`
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high))
}

/** The grid is monospaced, so one character measures every column. Measured
 *  rather than assumed, because the fallback font's advance is not JetBrains
 *  Mono's and the columns would be wrong until it loaded. */
function measureChar(): number {
  const probe = document.createElement('span')
  probe.className = 'grid__probe'
  probe.textContent = '0'.repeat(64)
  document.body.appendChild(probe)
  const width = probe.getBoundingClientRect().width / 64
  probe.remove()
  return width > 1 ? width : FALLBACK_CH
}

function useCharWidth(): number {
  const [width, setWidth] = useState(FALLBACK_CH)
  useLayoutEffect(() => {
    const settle = () => {
      const next = measureChar()
      setWidth((current) => (Math.abs(current - next) > 0.05 ? next : current))
    }
    settle()
    // The first measurement can land before the webfont does.
    void document.fonts?.ready.then(settle)
  }, [])
  return width
}

/* -- Remembered widths --------------------------------------------------- */

const WIDTH_STORE = 'flint.grid.widths.'

function loadWidths(shape: string): Record<number, number> {
  try {
    const raw = window.localStorage.getItem(WIDTH_STORE + shape)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<number, number>) : {}
  } catch {
    return {}
  }
}

function saveWidths(shape: string, widths: Record<number, number>) {
  try {
    if (Object.keys(widths).length === 0) window.localStorage.removeItem(WIDTH_STORE + shape)
    else window.localStorage.setItem(WIDTH_STORE + shape, JSON.stringify(widths))
  } catch {
    // Private mode, a full quota. A remembered column width is not worth a throw.
  }
}
