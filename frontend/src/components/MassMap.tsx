import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { familyColor, family, type TypeFamily } from '../lib/chType'
import { bytes as fmtBytes, exact, ratio } from '../lib/format'
import { buildMap, leftOut, type MassBlock, type MassCell, type MassReport } from '../lib/treemap'
import { EmptyNote } from './Note'

/** Where the disk is, drawn as proportion.
 *
 *  The object list below this page already carries every table's size, sorted.
 *  This answers the question that list is bad at: *which of these is the disk* —
 *  proportion is a shape, and one glance at it says what a column of figures
 *  says only after several additions.
 *
 *  Divided to the column, because a column store is the one place where that is
 *  the honest unit, and coloured by type family in the same vocabulary the type
 *  badges use — so "all of this disk is one String" arrives without anybody
 *  having to read a single label. */
export function MassMap({ report, database }: { report: MassReport; database: string }) {
  const frame = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const navigate = useNavigate()

  /* Measured rather than assumed: a treemap laid out against a width the
     element does not have is the bug this codebase has actually shipped twice —
     a canvas at zero height, a diagram fitted to a stale size. */
  useLayoutEffect(() => {
    const el = frame.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width)
    })
    observer.observe(el)
    setWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [])

  /* A wide, short frame beats a square one here: the blocks are labelled with
     table names, which are wide, and the page below wants the room. */
  const height = Math.round(Math.min(520, Math.max(280, width * 0.42)))
  const map = useMemo(
    () => buildMap(report, { x: 0, y: 0, w: width, h: height }),
    [report, width, height],
  )
  const omissions = leftOut(map)

  if (!report.available) {
    return (
      <EmptyNote title="No sizes to draw">
        {report.reason ?? 'system.parts_columns cannot be read here'}, so there is nothing to
        measure. The schema diagram is unaffected.
      </EmptyNote>
    )
  }

  if (report.tables.length === 0) {
    return (
      <EmptyNote title="Nothing stored yet">
        No table in {database} holds column data, so there is no disk to divide up.
      </EmptyNote>
    )
  }

  const families = [
    ...new Set(
      map.blocks.flatMap((b) => b.cells.filter((c) => c.type).map((c) => family(c.type!))),
    ),
  ]

  return (
    <div className="mass">
      <div className="mass__bar">
        <p className="mass__text">
          {fmtBytes(report.tables.reduce((sum, t) => sum + t.bytes, 0))} across{' '}
          {report.tables.length} {report.tables.length === 1 ? 'table' : 'tables'}
          {map.shareOfBytes !== null && map.omittedTables > 0 ? (
            <span className="mass__rest">
              {' '}
              {/* "of this database's" alone — a possessive with nothing it
                  possesses — is what stood here, and it stood unread because
                  the line only appears once the row cap has left something out,
                  which no database on a development server ever did. */}
              · {Math.round(map.shareOfBytes * 100)}% of this database's disk
            </span>
          ) : null}
        </p>
        <span className="panel__spacer" />
        {families.length ? (
          <ul className="mass__key">
            {families.map((f) => (
              <li key={f} className="mass__keyitem">
                <span
                  className="mass__swatch"
                  style={{ background: `var(--t-${f})` }}
                  aria-hidden="true"
                />
                {FAMILY_LABEL[f]}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="mass__frame" ref={frame} style={{ height }}>
        {width > 0
          ? map.blocks.map((block) => (
              <Block
                key={block.table.table}
                block={block}
                undivided={report.columns_reason}
                onOpen={() =>
                  navigate(
                    `/db/${encodeURIComponent(database)}/${encodeURIComponent(block.table.table)}`,
                  )
                }
              />
            ))
          : null}
      </div>

      <p className="mass__caption">
        Area is disk: a block is everything a table's active parts take, the same figure the
        headline above prints, and the cells inside divide it column by column. What the columns
        do not account for — the marks and the primary key index, which belong to none of them —
        is drawn as its own cell rather than spread over the ones that do. Colour is the type
        family.
        {report.columns_reason ? ` No column breakdown here: ${report.columns_reason}.` : ''}
        {omissions.length ? <span className="mass__left"> · {omissions.join(' · ')}</span> : null}
      </p>
    </div>
  )
}

/** Why a block is not divided. The two reasons are different facts: one is
 *  about this drawing and a wider frame would fix it, the other is about how
 *  ClickHouse stores a small table and no frame ever will. */
const WHOLE_REASON: Record<'none' | 'small' | 'compact' | 'capped', string> = {
  none: '',
  small: '\ntoo small here to divide into its columns',
  compact:
    '\nits parts are compact — every column in one file, so ClickHouse reports no per-column sizes',
  capped: '\nits columns were not fetched: the answer had reached its column cap',
}

const FAMILY_LABEL: Record<TypeFamily, string> = {
  number: 'Numbers',
  string: 'Strings',
  time: 'Dates',
  bool: 'Bools & enums',
  nested: 'Nested',
  other: 'Other',
}

/** One table. The block is the button, not each cell: a treemap of two hundred
 *  focusable rectangles is a tab order nobody can get out of, and every cell in
 *  a block goes to the same place anyway. */
function Block({
  block,
  onOpen,
  undivided,
}: {
  block: MassBlock
  onOpen: () => void
  /** Why *nothing* on the map has a column breakdown, where that is the case.
   *  It outranks the per-block reason: a block is only "compact" if the server
   *  answered about columns at all, and saying so where it did not would be a
   *  precise claim about storage that happens to be false. */
  undivided?: string
}) {
  const t = block.table
  const compression = ratio(t.uncompressed_bytes, t.bytes)
  const reason = undivided ? `\n${undivided}` : WHOLE_REASON[block.whole ?? 'none']
  const named = block.w > 78 && block.h > 30
  /* Named explicitly, because a button is announced by its contents and this
     one contains its columns: the first block on a real database announced
     itself as "temperaturepayloadtagslatency_ms…", with the table's own name
     last. The cells are the picture; the label is the fact. */
  const label = `${t.table}, ${fmtBytes(t.bytes)}${
    t.columns > 0 ? ` in ${exact(t.columns)} ${t.columns === 1 ? 'column' : 'columns'}` : ''
  }`
  return (
    <button
      className={`mblock${block.whole ? ' mblock--whole' : ''}`}
      aria-label={label}
      style={{ left: block.x, top: block.y, width: block.w, height: block.h }}
      title={`${t.table}\n${fmtBytes(t.bytes)}${compression ? ` · ${compression}` : ''}${
        t.columns > 0 ? ` · ${exact(t.columns)} ${t.columns === 1 ? 'column' : 'columns'}` : ''
      }${reason}`}
      onClick={onOpen}
    >
      {block.cells.map((cell) => (
        <Cell key={`${cell.table}.${cell.label}`} cell={cell} />
      ))}
      {named ? <span className="mblock__name">{t.table}</span> : null}
    </button>
  )
}

function Cell({ cell }: { cell: MassCell }) {
  const compression = ratio(cell.uncompressed_bytes, cell.bytes)
  /* Neither a fold nor the overhead cell has a colour: one stands for columns
     that are not all one type, the other is not a column at all, and giving
     either a family colour would be an invented fact. */
  const fill = cell.type
    ? `color-mix(in srgb, ${familyColor(cell.type)} 62%, var(--slab))`
    : 'var(--slab-hover)'
  const named = cell.w > 58 && cell.h > 19
  return (
    <span
      className={`mcell${cell.kind === 'column' ? '' : ` mcell--${cell.kind}`}`}
      style={{ left: cell.x, top: cell.y, width: cell.w, height: cell.h, background: fill }}
      title={`${cell.label}${cell.type ? ` · ${cell.type}` : ''}\n${fmtBytes(cell.bytes)}${
        cell.kind === 'column' && compression ? ` · ${compression}` : ''
      }${
        cell.kind === 'overhead'
          ? '\nthe marks and the primary key index, which belong to no column'
          : cell.kind === 'projection'
            ? '\na second copy of some of these columns, stored under the same parts'
            : ''
      }`}
    >
      {/* Decoration: the cell's figures are in its title and the block above it
          carries the name a reader is announced. Left in the accessibility tree
          it becomes part of the button's own name. */}
      {named ? (
        <span className="mcell__name" aria-hidden="true">
          {cell.label}
        </span>
      ) : null}
    </span>
  )
}
