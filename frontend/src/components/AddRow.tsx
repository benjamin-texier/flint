import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'

import { api, type ColumnDetail } from '../lib/api'
import {
  fieldsFor,
  payload,
  saysComputed,
  saysDefaulting,
  saysWritten,
  type Entry,
  type Field,
} from '../lib/rows'
import { shortType } from '../lib/chType'
import { ErrorNote, Sentence } from './Note'
import { TypeBadge } from './TypeBadge'

/** Write one row into a table.
 *
 *  The form is the table's own columns and nothing else — no schema of Flint's,
 *  no mapping. What it has to get right is not the drawing but a distinction
 *  the engine makes and most forms do not: **a value, a null, and no value at
 *  all are three different answers**, and they produce three different rows.
 *
 *  - A value is bound as a query parameter declared with the column's own type,
 *    so ClickHouse parses it. Nothing here validates what fits in a
 *    `Decimal(38,10)`; a browser-side check would be a second, worse copy of
 *    something the server already does exactly.
 *  - A null is the keyword, and only offered where the type takes one.
 *  - No value at all leaves the column out of the statement, which is what
 *    makes the table's `DEFAULT` apply. It cannot be a magic string in a box,
 *    because any string that meant *default* is one somebody might have meant
 *    to store.
 *
 *  So every field says which of the three it is in, always, rather than leaving
 *  it to be inferred from whether a box looks empty — measured against a server
 *  first: binding `''` to a `Nullable(String)` stores a zero-length string and
 *  `IS NULL` comes back false. A blank box that guessed between those two would
 *  be guessing at the one thing the reader came here to decide. */
export function AddRow({
  database,
  table,
  columns,
}: {
  database: string
  table: string
  columns: ColumnDetail[]
}) {
  const [entries, setEntries] = useState<Record<string, Entry>>({})
  const [written, setWritten] = useState<{ statement: string; defaulted: string[] } | null>(null)
  const client = useQueryClient()

  const fields = useMemo(() => fieldsFor(columns), [columns])
  const computed = saysComputed(columns)
  const defaulting = saysDefaulting(fields, entries)

  const add = useMutation({
    mutationFn: () => api.insertRow({ database, table, fields: payload(fields, entries) }),
    onSuccess: (result) => {
      setWritten(result)
      setEntries({})
      /* The preview and the table's own figures both change. Invalidated by
         prefix rather than by naming each key: the row count on the header, the
         partition list and the preview grid are three different queries about
         the same fact, and a form that refreshed one of them would leave the
         page disagreeing with itself. */
      client.invalidateQueries({ queryKey: ['table', database, table] })
      client.invalidateQueries({ queryKey: ['preview', database, table] })
    },
  })

  const set = (name: string, entry: Entry | null) =>
    setEntries((prev) => {
      const next = { ...prev }
      if (entry === null) delete next[name]
      else next[name] = entry
      return next
    })

  if (fields.length === 0) {
    return (
      <p className="note">
        Every column of <code>{database}.{table}</code> is computed by the server, so there is
        nothing to fill in.
      </p>
    )
  }

  return (
    <div className="addrow">
      {/* Said before the form rather than discovered as a missing box: a form
          showing nine of a table's eleven columns with nothing explaining the
          other two reads as a form that has lost them. */}
      {computed ? <Sentence className="says addrow__computed" text={computed} /> : null}

      <div className="addrow__fields">
        {fields.map((field) => (
          <FieldRow
            key={field.column.name}
            field={field}
            entry={entries[field.column.name] ?? { kind: 'default' }}
            onChange={(entry) => set(field.column.name, entry)}
          />
        ))}
      </div>

      {add.error ? <ErrorNote error={add.error} /> : null}

      <div className="addrow__foot">
        <button
          className="btn btn--spark"
          disabled={add.isPending || payload(fields, entries).length === 0}
          onClick={() => {
            setWritten(null)
            add.mutate()
          }}
        >
          {add.isPending ? 'Writing…' : 'Write the row'}
        </button>
        {/* What the table will fill in, before the button and not after it. A
            row that comes back holding three columns nobody typed is a row
            somebody wanted to be told about first. */}
        {defaulting ? <Sentence className="says" text={defaulting} /> : null}
      </div>

      {written ? (
        <div className="addrow__done">
          <Sentence className="says" text={saysWritten(written.defaulted)} />
          {/* Verbatim, with the values still as parameters. "What did that
              button actually run" is the first question anybody asks of a tool
              that writes on their behalf — and showing the statement with the
              values spliced in would be showing something that never ran. */}
          <pre className="addrow__sql mono-dim">{written.statement}</pre>
        </div>
      ) : null}
    </div>
  )
}

function FieldRow({
  field,
  entry,
  onChange,
}: {
  field: Field
  entry: Entry
  onChange: (entry: Entry | null) => void
}) {
  const { column, control, members } = field
  const name = column.name
  const isNull = entry.kind === 'null'
  const isDefault = entry.kind === 'default'
  const text = entry.kind === 'value' ? entry.text : ''
  const describedBy = `${name}-state`

  const value = (next: string) => onChange({ kind: 'value', text: next })

  return (
    <div className={`addrow__field${isDefault ? ' is-untouched' : ''}`}>
      <label className="addrow__label" htmlFor={`f-${name}`}>
        <span className="addrow__name">{name}</span>
        {/* `TypeBadge` already prints the short type, coloured by family, with
            the full one on hover — the same badge the Columns tab uses. A
            second copy beside it was exactly that: `email String String`. */}
        <TypeBadge type={column.type} />
      </label>

      <div className="addrow__control">
        {control === 'enum' ? (
          <select
            id={`f-${name}`}
            className="picker__select"
            aria-describedby={describedBy}
            value={text}
            onChange={(e) => value(e.target.value)}
            disabled={isNull}
          >
            {/* The empty option is not a value — it is what an untouched field
                looks like, and choosing it puts the field back to untouched
                rather than storing a member that is not in the set. */}
            <option value="">—</option>
            {members.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        ) : control === 'bool' ? (
          <select
            id={`f-${name}`}
            className="picker__select"
            aria-describedby={describedBy}
            value={text}
            onChange={(e) => value(e.target.value)}
            disabled={isNull}
          >
            <option value="">—</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : control === 'long' ? (
          <textarea
            id={`f-${name}`}
            className="addrow__input addrow__input--long"
            rows={2}
            aria-describedby={describedBy}
            value={text}
            disabled={isNull}
            onChange={(e) => value(e.target.value)}
          />
        ) : (
          <input
            id={`f-${name}`}
            className="addrow__input"
            type="text"
            aria-describedby={describedBy}
            value={text}
            disabled={isNull}
            onChange={(e) => value(e.target.value)}
          />
        )}

        <div className="addrow__acts">
          {/* Only where the declared type takes one. An offer to write a null
              into a `String` is an offer to produce an error. */}
          {/Nullable\(/.test(column.type) ? (
            <button
              type="button"
              className={`addrow__act${isNull ? ' is-on' : ''}`}
              aria-pressed={isNull}
              title={`Write a null into ${name}`}
              onClick={() => onChange(isNull ? null : { kind: 'null' })}
            >
              null
            </button>
          ) : null}
          <button
            type="button"
            className="addrow__act"
            disabled={isDefault}
            title={`Leave ${name} out of the statement`}
            onClick={() => onChange(null)}
          >
            clear
          </button>
        </div>
      </div>

      {/* Which of the three states this field is in, in words and always. The
          distinction is the whole point of the form and it is not one a reader
          can get from looking at a box. */}
      <p className="addrow__state says" id={describedBy}>
        {isNull ? (
          <>writes a null</>
        ) : isDefault ? (
          field.ifLeftAlone ? (
            <>not written — {field.ifLeftAlone}</>
          ) : (
            /* Left deliberately short of naming the type's zero. ClickHouse
               does write one — `''`, `0`, the epoch — but it is the engine's
               behaviour and it differs per type, so saying it here would read
               as a promise Flint is making. */
            <>not written — the engine decides what this column holds</>
          )
        ) : text === '' ? (
          <>writes an empty value, which is not a null</>
        ) : control === 'enum' || control === 'bool' ? (
          /* Naming the type here would print the whole member list —
             `Enum8('free' = 1, 'pro' = 2, 'team' = 3)` in the middle of a
             sentence — and it would be telling the reader something they just
             chose from a list. */
          <>writes {text}</>
        ) : (
          <>writes what is typed, parsed as {shortType(column.type)}</>
        )}
        {column.comment ? <span className="addrow__comment"> · {column.comment}</span> : null}
      </p>
    </div>
  )
}
