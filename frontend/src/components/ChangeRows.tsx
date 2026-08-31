import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { api, type ColumnDetail, type MutateBody, type MutationPreview } from '../lib/api'
import { count } from '../lib/format'
import { writable } from '../lib/rows'
import { ErrorNote, Sentence } from './Note'

/** Change or remove rows that are already there.
 *
 *  ClickHouse has no cell edit, so this is not a grid with a pencil on it. An
 *  `ALTER … UPDATE` is an asynchronous rewrite and a `DELETE` is the same, and
 *  a pencil icon would lie about what the click does. What it is instead is a
 *  predicate, the count it matches, and a job.
 *
 *  **Nothing runs without a preview.** That is the whole shape of this
 *  component and it is not a courtesy: the figure a reader needs is not how
 *  many rows match but how many *parts* get rewritten, and those are different
 *  numbers. A predicate matching one row in every part costs exactly what one
 *  matching all of them costs. Only the server can answer that — it is asked
 *  with `EXPLAIN ESTIMATE` — so the button that runs the mutation is not there
 *  until the answer is on screen. */
export function ChangeRows({
  database,
  table,
  columns,
}: {
  database: string
  table: string
  columns: ColumnDetail[]
}) {
  const [predicate, setPredicate] = useState('')
  const [sets, setSets] = useState<{ column: string; expression: string }[]>([])
  const [preview, setPreview] = useState<MutationPreview | null>(null)
  const client = useQueryClient()

  const settable = columns.filter(writable)
  const body = (): MutateBody => ({
    database,
    table,
    predicate,
    set: sets.filter((s) => s.column && s.expression.trim() !== ''),
  })
  const isUpdate = sets.some((s) => s.column && s.expression.trim() !== '')

  const look = useMutation({
    mutationFn: () => api.previewMutation(body()),
    onSuccess: setPreview,
  })
  const run = useMutation({
    mutationFn: () => api.mutateRows(body()),
    onSuccess: () => {
      setPreview(null)
      client.invalidateQueries({ queryKey: ['jobs'] })
      client.invalidateQueries({ queryKey: ['table', database, table] })
      client.invalidateQueries({ queryKey: ['mutations', database, table] })
    },
  })

  /* Unfinished only, polled while any is running. A finished mutation is
     history and history is not progress — and `parts_to_do` standing still is
     the tell that something is wedged, which nothing else in Data reports. */
  const pending = useQuery({
    queryKey: ['mutations', database, table],
    queryFn: () => api.pendingMutations(database, table),
    refetchInterval: (q) => ((q.state.data?.length ?? 0) > 0 ? 2000 : false),
  })

  /* Any edit invalidates the answer on screen. A preview of one predicate
     beside a button that would run another is the single worst thing this
     component could do, so the answer is dropped the moment its question
     changes. */
  const change = <T,>(set: (v: T) => void) => (value: T) => {
    setPreview(null)
    set(value)
  }

  return (
    <div className="chrows">
      <label className="chrows__row">
        <span className="label">Which rows</span>
        <input
          className="addrow__input"
          value={predicate}
          placeholder="ts &gt;= '2026-01-01' AND city = 'Oslo'"
          onChange={(e) => change(setPredicate)(e.target.value)}
        />
      </label>
      {/* Through `Sentence`, not as JSX text: a backtick in JSX is a backtick
          on the screen, which is the fourth time that has been written in this
          codebase and the second in this session. */}
      <Sentence
        className="says"
        text={
          'A `WHERE`, as you would write it. Flint does not parse it — the server compiles it for the preview, so a mistyped column is refused before anything runs.'
        }
      />

      <div className="chrows__sets">
        <p className="label">
          Set — leave empty to delete the matching rows instead
        </p>
        {sets.map((s, i) => (
          <div className="chrows__set" key={i}>
            <select
              className="picker__select"
              aria-label="Column to set"
              value={s.column}
              onChange={(e) =>
                change(setSets)(sets.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)))
              }
            >
              <option value="">—</option>
              {settable.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            <span className="chrows__eq">=</span>
            <input
              className="addrow__input"
              aria-label="Expression to set it to"
              placeholder="0, now(), concat(a, b)"
              value={s.expression}
              onChange={(e) =>
                change(setSets)(
                  sets.map((x, j) => (j === i ? { ...x, expression: e.target.value } : x)),
                )
              }
            />
            <button
              className="addrow__act"
              onClick={() => change(setSets)(sets.filter((_, j) => j !== i))}
            >
              remove
            </button>
          </div>
        ))}
        <button
          className="addrow__act"
          onClick={() => change(setSets)([...sets, { column: '', expression: '' }])}
        >
          add an assignment
        </button>
      </div>

      {look.error ? <ErrorNote error={look.error} /> : null}
      {run.error ? <ErrorNote error={run.error} /> : null}

      <div className="chrows__foot">
        <button
          className="btn"
          disabled={predicate.trim() === '' || look.isPending}
          onClick={() => look.mutate()}
        >
          {look.isPending ? 'Looking…' : 'What would this reach?'}
        </button>
      </div>

      {preview ? (
        <div className="chrows__preview">
          {/* The backend's own sentences. Written once, where the arithmetic
              is, rather than a second time here where they could drift from
              the numbers they describe. */}
          {preview.says.map((line) => (
            <Sentence key={line} className="says" text={line} />
          ))}
          {!preview.narrows && preview.estimate.total_parts > 1 ? (
            <p className="chrows__loud">
              Every part of this table is rewritten. On {count(preview.estimate.total_rows)} rows
              that is the whole table's worth of work, whether {count(preview.matches)} rows change
              or one does.
            </p>
          ) : null}
          <pre className="addrow__sql mono-dim">{preview.statement}</pre>
          <button
            className="btn btn--spark"
            disabled={run.isPending || preview.matches === 0}
            onClick={() => run.mutate()}
          >
            {run.isPending
              ? 'Starting…'
              : isUpdate
                ? `Update ${count(preview.matches)} rows`
                : `Delete ${count(preview.matches)} rows`}
          </button>
        </div>
      ) : null}

      {/* Progress, and the only place a wedged mutation says why. The job list
          says a statement was sent; this says how far the server has got with
          it, which on a big table is the question for the next hour. */}
      {pending.data && pending.data.length > 0 ? (
        <div className="chrows__pending">
          <p className="label">
            {pending.data.length} unfinished {pending.data.length === 1 ? 'mutation' : 'mutations'}{' '}
            on this table
          </p>
          <table className="tbl">
            <thead>
              <tr>
                <th>Command</th>
                <th>Started</th>
                <th className="tbl--n">Parts to do</th>
              </tr>
            </thead>
            <tbody>
              {pending.data.map((m) => (
                <tr key={m.mutation_id}>
                  <td className="tbl__key">
                    <code>{m.command}</code>
                    {/* Reported nowhere else in Data. A mutation stuck on one
                        part sits at the same count indefinitely and this is the
                        only line that says what stopped it. */}
                    {m.fail_reason ? (
                      <span className="says says--throw">{m.fail_reason}</span>
                    ) : null}
                  </td>
                  <td className="mono-dim">{m.created}</td>
                  <td className="tbl--n mono-dim">{m.parts_to_do}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}
