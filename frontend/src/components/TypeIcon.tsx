import { family } from '../lib/chType'

/** The little mark in front of a column name that says what kind of value the
 *  column holds. Borrowed from Dashfile's grid: it reads faster than the type
 *  name, and it survives the column being too narrow to show the type at all.
 *  The type name still sits beside it for anyone who wants the exact answer. */
export function TypeIcon({ type }: { type: string }) {
  const f = family(type)
  const color = `var(--t-${f})`

  if (f === 'number') {
    return (
      <span className="ticon" style={{ color }} aria-hidden="true">
        #
      </span>
    )
  }
  if (f === 'string') {
    return (
      <span className="ticon ticon--aa" style={{ color }} aria-hidden="true">
        Aa
      </span>
    )
  }
  if (f === 'nested') {
    return (
      <span className="ticon" style={{ color }} aria-hidden="true">
        [ ]
      </span>
    )
  }
  if (f === 'time') {
    return (
      <svg className="ticon__svg" style={{ color }} viewBox="0 0 12 12" aria-hidden="true">
        <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <path d="M6 3.4V6l1.9 1.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" fill="none" />
      </svg>
    )
  }
  if (f === 'bool') {
    return (
      <svg className="ticon__svg" style={{ color }} viewBox="0 0 12 12" aria-hidden="true">
        <rect x="0.8" y="3" width="10.4" height="6" rx="3" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <circle cx="8.2" cy="6" r="1.5" fill="currentColor" />
      </svg>
    )
  }
  return (
    <span className="ticon" style={{ color }} aria-hidden="true">
      •
    </span>
  )
}
