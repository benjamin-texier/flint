import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api, type SavedQuery } from '../lib/api'
import { relativeTime } from '../lib/format'
import { EmptyNote, ErrorNote, Loading } from '../components/Note'

/** Saved queries, and the form that adds one.
 *
 *  Naming and listing live in the same panel rather than behind a modal: you
 *  press Save, the name is already filled in from the tab, and the thing you
 *  just saved appears in the list underneath it. */
export function SavedPanel({
  currentSql,
  currentDatabase,
  suggestedName,
  workspace,
  onLoad,
  onClose,
}: {
  currentSql: string
  currentDatabase: string
  suggestedName: string
  workspace: string | null
  onLoad: (q: SavedQuery) => void
  onClose: () => void
}) {
  const client = useQueryClient()
  const [name, setName] = useState(suggestedName)
  const [editing, setEditing] = useState<string | null>(null)

  const saved = useQuery({
    queryKey: ['saved-queries'],
    queryFn: api.savedQueries,
    enabled: Boolean(workspace),
  })

  const invalidate = () => client.invalidateQueries({ queryKey: ['saved-queries'] })
  const save = useMutation({
    mutationFn: () =>
      api.saveQuery({
        ...(editing ? { id: editing } : {}),
        name: name.trim(),
        sql: currentSql,
        database: currentDatabase,
      }),
    onSuccess: () => {
      setEditing(null)
      invalidate()
    },
  })
  const remove = useMutation({ mutationFn: api.deleteQuery, onSuccess: invalidate })

  if (!workspace) {
    return (
      <section className="history">
        <header className="history__head">
          <h3 className="history__title">Saved queries</h3>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="history__body">
          <EmptyNote title="Flint is running without a workspace">
            It has nowhere to keep a saved query, and by design it will not create anything
            uninvited. Set <code>FLINT_WORKSPACE_DATABASE</code> to a database it may write to —
            <code>flint</code> is the conventional name — and restart. Your data is untouched
            either way: the workspace only ever holds Flint's own metadata.
          </EmptyNote>
        </div>
      </section>
    )
  }

  const canSave = name.trim().length > 0 && currentSql.trim().length > 0

  return (
    <section className="history">
      <header className="history__head">
        <h3 className="history__title">Saved queries</h3>
        <span className="panel__hint">in {workspace}</span>
        <span className="panel__spacer" />
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </header>

      <div className="saveform">
        <input
          className="frame__input saveform__name"
          value={name}
          placeholder="Name this query"
          aria-label="Name for the saved query"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canSave) save.mutate()
          }}
        />
        <button
          className="btn btn--spark"
          disabled={!canSave || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : editing ? 'Update' : 'Save'}
        </button>
        {editing ? (
          <button className="btn" onClick={() => setEditing(null)}>
            New instead
          </button>
        ) : null}
      </div>
      {save.error ? <ErrorNote error={save.error} /> : null}

      <div className="history__body">
        {saved.isPending ? <Loading label="Reading saved queries" /> : null}
        {saved.error ? <ErrorNote error={saved.error} retry={() => saved.refetch()} /> : null}
        {remove.error ? <ErrorNote error={remove.error} /> : null}
        {saved.data?.length === 0 ? (
          <EmptyNote title="Nothing saved yet">
            Name the query above and press Save. It lands in a table in {workspace}, so it is
            there for anyone else pointing Flint at this server.
          </EmptyNote>
        ) : null}

        {saved.data?.map((q) => (
          <div className={`savedrow${editing === q.id ? ' is-editing' : ''}`} key={q.id}>
            <button
              className="savedrow__open"
              onClick={() => onLoad(q)}
              title="Load into the editor"
            >
              <span className="savedrow__name">{q.name}</span>
              <code className="savedrow__sql">{q.sql.replace(/\s+/g, ' ').trim()}</code>
            </button>
            <span className="savedrow__meta">
              {q.database}
              <span className="savedrow__when">{relativeTime(q.updated_at)}</span>
            </span>
            <button
              className="savedrow__act"
              title="Overwrite this one with the editor's contents"
              onClick={() => {
                setEditing(q.id)
                setName(q.name)
              }}
            >
              ⤒
            </button>
            <button
              className="savedrow__act savedrow__act--del"
              title="Delete"
              onClick={() => remove.mutate(q.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}
