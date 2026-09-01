import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import { relativeTime } from '../lib/format'
import { openers, serverOpeners } from '../lib/opener'

/** The query page with nothing on it yet.
 *
 *  What was here before was a grey card in the middle of a very large empty
 *  rectangle, explaining the keyboard shortcut. It was accurate and it was the
 *  least inviting thing in the product: on the one page somebody keeps open all
 *  day, the state they meet most often — a fresh tab — asked them to think of a
 *  question from a standing start.
 *
 *  So the empty state offers questions instead of describing a keyboard. Two
 *  sources, both of them real and neither invented:
 *
 *  - **This table's own first questions** — how many rows, a look at them, how
 *    they arrive over time, what repeats. Generated from the columns actually on
 *    the table, so nothing is offered that would fail on click. `lib/opener.ts`
 *    owns which ones apply and how they are worded, and is tested.
 *  - **What this server has been asked lately** — `system.query_log`, the same
 *    read the History drawer makes. Somebody coming back to a tab usually wants
 *    the query they ran twenty minutes ago, and making them open a drawer for it
 *    is a click charged for remembering.
 *
 *  Clicking either puts the statement in the tab and runs it. Nothing is hidden:
 *  the SQL is on the card before it is pressed, because a page that runs
 *  something you have not read is a page you learn to distrust exactly once. */
const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function StartHere({
  database,
  table,
  columns,
  onRun,
  hint,
}: {
  database: string | undefined
  /** The table this tab is about, when it is about one. Null on a blank SQL
   *  tab — there is nothing to ask a first question of, and inventing a subject
   *  would be picking somebody's table for them. */
  table: string | null
  columns: { name: string; type: string; in_sorting_key?: boolean }[]
  onRun: (sql: string) => void
  /** How this mode runs a statement, said once at the bottom. Written without a
   *  leading conjunction: this reads as "Or …" under a list of offers, and as a
   *  sentence of its own when there is nothing above it. */
  hint: string
}) {
  /* A table's own first questions when there is a table, and the server's when
     there is not. Never both: a blank tab offering four questions about a table
     nobody has named would be inventing the subject, and a tab that has one does
     not need to be told how to list the objects it came from. */
  const offers = table
    ? openers(
        database,
        table,
        columns,
        columns.filter((c) => c.in_sorting_key).map((c) => c.name),
      )
    : serverOpeners(database)

  /* The same query the History drawer makes, and the same cache key, so opening
     the drawer afterwards costs nothing. Six rows: enough to recognise the one
     you meant, short enough not to become a second page. */
  const history = useQuery({
    queryKey: ['history'],
    queryFn: () => api.history(100),
    staleTime: 15_000,
  })
  const recent = (history.data?.available ? history.data.entries : [])
    .filter((e) => !e.exception)
    .slice(0, 6)

  return (
    <div className="start">
      {offers.length > 0 ? (
        <section className="start__sec">
          <h2 className="start__head">
            {table ? (
              <>
                First questions about <code className="ident">{table}</code>
              </>
            ) : (
              'Somewhere to start'
            )}
          </h2>
          <div className="start__cards">
            {offers.map((o) => (
              <button
                key={o.id}
                className="opener"
                onClick={() => onRun(o.sql)}
                type="button"
                title="Runs this statement"
              >
                <span className="opener__title">{o.title}</span>
                <span className="opener__note">{o.note}</span>
                <code className="opener__sql">{o.sql}</code>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {recent.length > 0 ? (
        <section className="start__sec">
          <h2 className="start__head">Lately on this server</h2>
          <ul className="start__recent">
            {recent.map((e) => (
              <li key={e.query_id + e.event_time}>
                <button
                  className="start__row"
                  onClick={() => onRun(e.query)}
                  type="button"
                  title="Runs this statement"
                >
                  <span className="start__when">{relativeTime(e.event_time)}</span>
                  <code className="start__sql">{e.query.replace(/\s+/g, ' ').trim()}</code>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* The keyboard, kept — it was the whole of the old empty state and it is
          still the fastest way to run anything. A footnote once there is
          something on the page to press, and the whole sentence when there is
          not: `hint` leads with "Or", which reads as a fragment with nothing
          above it. */}
      <p className="start__hint">
        {offers.length > 0 || recent.length > 0 ? `Or ${hint}` : sentenceCase(hint)}
      </p>
    </div>
  )
}
