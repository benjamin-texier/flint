import type { Cleared } from '../lib/checkup'

/** The checks that ran and had nothing to say.
 *
 *  Both pages that judge a server draw these — `/checkup` per area, and the
 *  arrival under its ranking — and the rows are identical because the claim is
 *  identical. Extracted the moment there were two of them: `Stratum` on the
 *  arrival names the cost of the other choice, and it is worth paying there
 *  (a worklist row and a ranking row are genuinely different readings) and not
 *  here, where the difference would only ever be a bug.
 *
 *  A dash and a figure, never a tick and the word "fine": "we looked, and here
 *  is the number" is a different claim from "this is good", and only the first
 *  is Flint's to make. See `Cleared` in `lib/checkup`. */
export function ClearedList({
  cleared,
  also = false,
}: {
  cleared: Cleared[]
  /** Whether something was found as well, which changes only the count's verb.
   *  "2 checks came back clear" under an empty list; "2 checks also came back
   *  clear" under findings. */
  also?: boolean
}) {
  if (cleared.length === 0) return null
  return (
    <>
      {/* The count leads, and it counts the list below it. */}
      <p className="cleared__head label">
        {cleared.length} {cleared.length === 1 ? 'check' : 'checks'}
        {also ? ' also came back clear' : ' came back clear'}
      </p>
      <ul className="cleared">
        {cleared.map((c) => (
          <li className="cleared__row" key={c.id}>
            <span className="cleared__mark" aria-hidden="true" />
            <span className="cleared__label">{c.label}</span>
            <span className="cleared__reading">{c.reading}</span>
          </li>
        ))}
      </ul>
    </>
  )
}
