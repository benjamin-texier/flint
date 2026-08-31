import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import {
  group,
  shortlist,
  isGroup,
  leftOut,
  says,
  saysGroup,
  span,
  suggests,
  thin,
} from '../lib/relations'
import { EmptyNote, ErrorNote } from './Note'

/** What one column of this table says about another.
 *
 *  The other tabs describe the table: its columns, its shape, what it reads
 *  from. This one describes the *rows*, and says something the DDL cannot — that
 *  two columns carry the same information, that one fixes another, that a third
 *  stopped varying at some point nobody recorded.
 *
 *  It is asked for rather than run on arrival. The comparison reads every row of
 *  the table, and spending that on somebody's behalf before they asked is not a
 *  courtesy — the same rule the preview follows when it refuses to sort a table
 *  by a column its key does not lead with. */
export function Relations({ database, table }: { database: string; table: string }) {
  const found = useQuery({
    queryKey: ['relations', database, table],
    queryFn: () => api.relations(database, table),
    // Never on mount: the button below is the consent.
    enabled: false,
    staleTime: 5 * 60_000,
  })

  if (found.error) return <ErrorNote error={found.error} retry={() => found.refetch()} />

  if (!found.data) {
    return (
      <section className="rel">
        <p className="rel__ask">
          Reads every row of this table once, twice over: what each column takes as values, then
          what every eligible pair of them takes together. Nothing is written and nothing leaves the
          server.
        </p>
        <button className="btn btn--spark" onClick={() => found.refetch()} disabled={found.isFetching}>
          {found.isFetching ? 'Comparing…' : 'Compare the columns'}
        </button>
      </section>
    )
  }

  const r = found.data
  if (!r.available) {
    return (
      <EmptyNote title="Nothing to compare from">
        {r.reason ?? 'the columns of this table cannot be read'}.
      </EmptyNote>
    )
  }

  const omissions = leftOut(r)
  const items = group(r.findings)
  const shown = shortlist(items)

  return (
    <section className="rel">
      <div className="rel__bar">
        <p className="rel__span">{span(r)}</p>
        <span className="panel__spacer" />
        <button className="btn" onClick={() => found.refetch()} disabled={found.isFetching}>
          {found.isFetching ? 'Comparing…' : 'Again'}
        </button>
      </div>

      {r.findings.length === 0 ? (
        /* A real answer, and the good one: every column carries something the
           others do not. Said in a sentence rather than as an empty list, which
           reads as a query that failed. */
        <EmptyNote title="Nothing says the same thing twice">
          No column of this table is fixed by another, and none holds a single value. Every one of
          them carries something the rest do not.
        </EmptyNote>
      ) : (
        <ul className="rel__list">
          {shown.map((item) =>
            isGroup(item) ? (
              <li key={`group:${item.columns.join()}`} className="rel__item rel__item--mirrors">
                <p className="rel__what">
                  {/* No space between: a group's sentence opens with the comma
                      that follows the first name, and `{' '}` put one in front
                      of it — `active , visible`. */}
                  <code className="rel__col">{item.columns[0]}</code>
                  <span className="rel__says">{saysGroup(item)}</span>
                </p>
                <p className="rel__then">
                  All but one of them could be dropped, or derived from the one that stays, without
                  losing anything the rows contain.
                </p>
              </li>
            ) : (
              <li
                key={`${item.kind}:${item.a}:${item.b ?? ''}`}
                className={`rel__item rel__item--${item.kind}`}
              >
                <p className="rel__what">
                  <code className="rel__col">{item.a}</code>{' '}
                  <span className="rel__says">{says(item, r.rows)}</span>
                </p>
                {suggests(item) ? <p className="rel__then">{suggests(item)}</p> : null}
              </li>
            ),
            )}
        </ul>
      )}

      <p className="rel__caption">
        Read from the rows, not from the schema: a column fixes another when pairing the two
        produces no combination the first did not already have. Nothing here is a rule the database
        enforces — it is what these rows happen to hold today. {thin(r)}
        {items.length > shown.length ? (
          <span className="rel__left">
            {' '}
            · {items.length - shown.length} more not listed — the weakest of each kind, so that
            every kind is seen
          </span>
        ) : null}
        {omissions.length ? <span className="rel__left"> · {omissions.join(' · ')}</span> : null}
      </p>
    </section>
  )
}
