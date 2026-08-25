import { familyColor, shortType } from '../lib/chType'

/** A ClickHouse type, coloured by family so a schema reads chromatically. */
export function TypeBadge({ type }: { type: string }) {
  return (
    <span className="type" style={{ color: familyColor(type) }} title={type}>
      {shortType(type)}
    </span>
  )
}

/** The same four shapes the rail and the diagram use: square for a table,
 *  diamond for a materialized view, ring for a view, disc for a dictionary.
 *
 *  Drawn rather than typed. The box-drawing characters this replaced were
 *  inconsistent across platforms, looked like 2005, and — being text — had to
 *  clear text contrast in a colour chosen to work as a fill. */
export function KindGlyph({ kind, size }: { kind: string; size?: 'lg' }) {
  return (
    <i
      className={`glyph glyph--${kind}${size ? ` glyph--${size}` : ''}`}
      role="img"
      aria-label={kind.replace('_', ' ')}
    />
  )
}
