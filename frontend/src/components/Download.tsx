import { FORMATS } from '../lib/export'

/** Give me this file now.
 *
 *  A real `<form>` with real submit buttons, and no JavaScript in the path at
 *  all. The reasons are not stylistic:
 *
 *  - A form submission is a **navigation**, so the browser streams the answer
 *    to disk with its own progress bar and its own cancel. `fetch` would have
 *    to hold the whole file in this tab's memory first, which defeats the one
 *    thing a download is for — a 1.1 GB export is not something to keep in a
 *    tab.
 *  - The session rides in the cookie, which a form sends and a header could
 *    not. The cookie is `SameSite=Lax`, so this shape opens no cross-site hole:
 *    a form on somebody else's page arrives at Flint with no session.
 *  - Three submit buttons in one form, each naming its own `format`, rather
 *    than a menu. A menu owes its reader arrow keys, an Escape and a focus
 *    trap; three buttons owe them nothing and say more.
 */
export function Download({
  sql,
  database,
  stem,
  note,
}: {
  sql: string
  database?: string
  /** What the file should be called, before the extension. */
  stem?: string
  /** What this download will hand over, in words — computed by whoever knows.
   *
   *  Passed in rather than worked out here, because the two places this appears
   *  know different things and must therefore say different things. A result in
   *  the editor cannot name its own size; a table often can. A component that
   *  guessed would end up saying the weaker of the two everywhere. */
  note: string
}) {
  const name = stem ?? 'export'
  return (
    <form className="dl" method="post" action="/api/export">
      <input type="hidden" name="sql" value={sql} />
      <input type="hidden" name="database" value={database ?? ''} />
      <input type="hidden" name="name" value={name} />
      {/* The size, said before the click rather than discovered afterwards in a
          file that cannot say it. */}
      {/* Ellipsised on a narrow tile, so the full sentence is on hover. The
          truncation is safe by construction — every wording puts the figure
          first and the reassurance last, so what survives the cut is the part
          that carries the claim — but "safe to truncate" is not "fine to
          lose". */}
      <span className="dl__says" title={note}>
        {note}
      </span>
      <div className="segmented" role="group" aria-label="Download this result">
        {FORMATS.map((f) => (
          <button
            key={f.format}
            className="segmented__item"
            type="submit"
            name="format"
            value={f.format}
            title={f.why}
          >
            {f.label}
          </button>
        ))}
      </div>
    </form>
  )
}
