import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { api } from '../lib/api'
import { asks, body, missing, type Offered } from '../lib/alter'
import { bytes, count } from '../lib/format'
import { ErrorNote, Loading } from './Note'

/** Change a table's columns or its TTL.
 *
 *  Each operation carries the sentence saying what it costs *this* table, from
 *  the backend, before it is pressed — because the two facts that matter are not
 *  in the statement: whether it rewrites the data on disk, and what "done" will
 *  mean on a replicated table. Adding a column rewrites nothing; renaming one
 *  does, which is the one most likely to be got wrong. */
export function Alter({
  database,
  table,
  onDone,
  prefill,
}: {
  database: string
  table: string
  onDone: () => void
  /** An operation and its fields, filled in from a link.
   *
   *  How the projection advisor hands a proposal over. The advisor lives on the
   *  table page, which is Data, and Data may not change structure — so it
   *  produces the statement and sends the reader here, where the control that
   *  runs it lives. Filled in, not run: the form still has to be submitted, and
   *  every field is still editable, because a proposal is an argument and not an
   *  instruction. */
  prefill?: { op: string; values: Record<string, string> }
}) {
  const [chosen, setChosen] = useState<string | null>(prefill?.op ?? null)
  const [values, setValues] = useState<Record<string, string>>(prefill?.values ?? {})
  const queryClient = useQueryClient()

  const offered = useQuery({
    queryKey: ['schema', 'alterations', database, table],
    queryFn: () => api.alterations(database, table),
  })
  /* What the table already has, beside the controls that change it — because the
     finding here is one nothing else reports: an index or a projection that was
     declared and never built is in the definition, holds nothing, and every
     query ignores it. There is no status column for that; the size is the tell. */
  const derived = useQuery({
    queryKey: ['schema', 'derived', database, table],
    queryFn: () => api.derived(database, table),
  })
  const act = useMutation({
    mutationFn: (change: Record<string, unknown>) => api.alter(change),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['schema', 'objects'] })
      queryClient.invalidateQueries({ queryKey: ['schema', 'alterations', database, table] })
      queryClient.invalidateQueries({ queryKey: ['schema', 'derived', database, table] })
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      onDone()
    },
  })

  if (offered.isPending) return <Loading label="Reading what can be changed" />
  if (offered.error) return <ErrorNote error={offered.error} retry={() => offered.refetch()} />

  const picked = offered.data?.find((o) => o.op === chosen)
  const indexes = derived.data?.indexes.items ?? []
  const projections = derived.data?.projections.items ?? []
  return (
    <div className="rbac__panel">
      {derived.data?.verdicts.length ? (
        <div className="cfg__loud">
          {derived.data.verdicts.map((v, i) => (
            <p key={i}>{v}</p>
          ))}
        </div>
      ) : null}
      {indexes.length || projections.length ? (
        <table className="tbl">
          <thead>
            <tr>
              <th>Derived</th>
              <th>What</th>
              <th className="tbl--n">Holds</th>
            </tr>
          </thead>
          <tbody>
            {indexes.map((i) => (
              <tr key={`i-${i.name}`}>
                <td className="tbl__key">
                  {i.name}
                  <span className="says mono-dim">index {i.kind} on {i.expression}</span>
                </td>
                <td className="mono-dim">skip index</td>
                {/* The size *is* the status. Zero is not "small" here, it is
                    "never built", and there is no other column that says so. */}
                <td className="tbl--n mono-dim">
                  {i.inert ? <span className="says">nothing — never built</span> : bytes(i.compressed)}
                </td>
              </tr>
            ))}
            {projections.map((p) => (
              <tr key={`p-${p.name}`}>
                <td className="tbl__key">
                  {p.name}
                  <span className="says mono-dim">{p.query}</span>
                </td>
                <td className="mono-dim">{p.kind.toLowerCase()} projection</td>
                <td className="tbl--n mono-dim">
                  {p.inert ? (
                    <span className="says">nothing — never built</span>
                  ) : (
                    `${bytes(p.bytes)} · ${count(p.rows)} rows`
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <span className="rbac__strip">
        {(offered.data ?? []).map((o) => (
          <button
            className={`btn${chosen === o.op ? ' is-on' : ''}`}
            key={o.op}
            aria-expanded={chosen === o.op}
            onClick={() => {
              setValues({})
              setChosen(chosen === o.op ? null : o.op)
            }}
          >
            {o.label}
          </button>
        ))}
      </span>
      {picked ? (
        <Form
          offered={picked}
          database={database}
          table={table}
          values={values}
          setValues={setValues}
          onSend={(b) => act.mutate(b)}
          pending={act.isPending}
          error={act.error}
        />
      ) : null}
    </div>
  )
}

function Form({
  offered,
  database,
  table,
  values,
  setValues,
  onSend,
  pending,
  error,
}: {
  offered: Offered
  database: string
  table: string
  values: Record<string, string>
  setValues: (v: Record<string, string>) => void
  onSend: (body: Record<string, unknown>) => void
  pending: boolean
  error: unknown
}) {
  const short = missing(offered, values)
  return (
    <>
      {/* The cost, before the button rather than in the job list afterwards. It
          is the backend's sentence about this table, not a generic one about the
          statement. */}
      <p className={offered.destroys ? 'says says--throw' : 'says'}>{offered.costs}</p>
      <form
        className="rbac__row"
        onSubmit={(e) => {
          e.preventDefault()
          if (!short.length) onSend(body(offered, database, table, values))
        }}
      >
        {offered.needs.map((field) => (
          <label className="rbac__field" key={field}>
            <span className="label">{asks(field).toUpperCase()}</span>
            <input
              value={values[field] ?? ''}
              onChange={(e) => setValues({ ...values, [field]: e.target.value })}
              spellCheck={false}
            />
          </label>
        ))}
        <button className="btn" disabled={!!short.length || pending}>
          {pending ? 'Sending…' : offered.rewrites ? 'Rewrite it' : 'Add it'}
        </button>
      </form>
      {/* A type reaches the server as written: Flint does not parse ClickHouse's
          type grammar, which is large and moves between versions, and refusing a
          type this server understands would be worse than passing it on. What it
          refuses is a semicolon or a comment. */}
      {offered.needs.includes('kind') ? (
        <p className="says">
          The type goes to the server as you write it — Flint does not judge it, and the server
          refuses a conversion it cannot make rather than losing anything.
        </p>
      ) : null}
      {error ? (
        <p className="says says--wide says--throw">
          {error instanceof Error ? error.message : 'it was refused'}
        </p>
      ) : null}
    </>
  )
}
