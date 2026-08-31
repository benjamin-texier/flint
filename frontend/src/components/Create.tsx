import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { api } from '../lib/api'
import { names, renamed, stillNamed } from '../lib/create'
import { formatDdl } from '../lib/ddl'
import { ErrorNote, Loading } from './Note'

/** Make a table, starting from one that already exists.
 *
 *  `create_table_query` is the definition the server itself holds, and it
 *  round-trips: the same text with the name changed creates the same shape. So
 *  the honest offer is not a form with fifteen fields but the real statement,
 *  editable — which is also the only way to reach the parts of ClickHouse's DDL
 *  a form would never cover.
 *
 *  Nothing here checks the SQL. ClickHouse's HTTP interface refuses a body with
 *  more than one statement and runs neither, which is a better guarantee than any
 *  string matching, and the backend adds only its own policy: this runs a
 *  `CREATE`, and not an `OR REPLACE` that would drop what is there. */
export function Create({
  database,
  table,
  onDone,
}: {
  database: string
  table: string
  onDone: () => void
}) {
  const original = `${database}.${table}`
  const [draft, setDraft] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const definition = useQuery({
    queryKey: ['schema', 'definition', database, table],
    queryFn: () => api.definition(database, table),
  })
  const act = useMutation({
    mutationFn: (statement: string) => api.create(statement),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['schema', 'objects'] })
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      onDone()
    },
  })

  if (definition.isPending) return <Loading label="Reading the definition" />
  if (definition.error) {
    return <ErrorNote error={definition.error} retry={() => definition.refetch()} />
  }

  const held = definition.data?.ddl ?? ''
  /* Pre-filled with the name already changed, because that is the first thing
     that has to change and leaving it to be discovered means the server answers
     "already exists" and the form looks broken rather than unfinished. */
  /* Broken into lines before it is offered. `create_table_query` comes back as
     one line, and for a thirty-column table that is two thousand characters of
     soft-wrapped text nobody can edit — which is what `formatDdl` already exists
     to fix on the table page and in the editor. */
  const start = formatDdl(renamed(held, original, `${original}_copy`))
  const text = draft ?? start
  const unchanged = stillNamed(text, original)
  const found = names(text)

  return (
    <div className="rbac__panel">
      <p className="says">
        This is the definition the server holds for {original}, with the name changed. Editing it
        makes a new object — a table&apos;s own definition cannot be rewritten in place, which is
        what the column and TTL controls above are for.
      </p>
      <textarea
        className="ddl"
        value={text}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        rows={Math.min(18, Math.max(6, text.split('\n').length + 1))}
      />
      <p className="rbac__row">
        <button
          className="btn"
          disabled={unchanged || !text.trim() || act.isPending}
          onClick={() => act.mutate(text)}
        >
          {act.isPending ? 'Creating…' : found ? `Create ${found}` : 'Create it'}
        </button>
        <button className="btn" onClick={() => setDraft(null)} disabled={draft === null}>
          Start again
        </button>
      </p>
      {unchanged ? (
        <p className="says">
          It still names {original}. Change the name — the server would answer that it already
          exists.
        </p>
      ) : null}
      {act.error ? (
        <p className="says says--wide says--throw">
          {act.error instanceof Error ? act.error.message : 'it was refused'}
        </p>
      ) : null}
    </div>
  )
}
