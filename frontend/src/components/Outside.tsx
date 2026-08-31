import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import { api } from '../lib/api'
import { EXTERNAL_KIND_LABEL } from '../lib/external'
import { saysAttempt, saysShort, verdictOf, type Attempt } from '../lib/connect'
import { groupLabel, groupOutside, saysOutside, type OutsideEntry } from '../lib/outside'
import { EmptyNote, ErrorNote, Loading } from './Note'

/** Everywhere this server reads from, and whether those places answer.
 *
 *  The object page answers this one table at a time, which is the right shape
 *  for "what is this table" and the wrong one for the question somebody arrives
 *  with. Credentials rotate on a bucket and thirty tables stop working at once;
 *  a host is decommissioned and nobody knows which tables pointed at it.
 *
 *  Grouped by the far end rather than by the engine, because the far end is what
 *  breaks together. And the checking is per table rather than per group, however
 *  much a green tick on a bucket would please: two tables on one bucket can
 *  carry different credentials, so "this bucket is fine" would be a claim about
 *  a table nobody asked. Each answer here is about the table it names. */
export function Outside() {
  const report = useQuery({ queryKey: ['outside'], queryFn: api.outside, staleTime: 60_000 })
  /* Verdicts by qualified name, held here rather than in the rows: "check them
     all" is one action over the whole list, and a row that owns its own result
     cannot be driven from outside itself. */
  const [answers, setAnswers] = useState<Record<string, Attempt | 'asking'>>({})
  const [checking, setChecking] = useState(false)

  if (report.isPending) return <Loading label="Reading what this server points at" />
  if (report.error) return <ErrorNote error={report.error} retry={() => report.refetch()} />
  const data = report.data
  if (!data) return null
  if (data.tables.blocked) {
    return <EmptyNote title="Not visible to this user">{data.tables.blocked}</EmptyNote>
  }

  const groups = groupOutside(data.tables.items)
  if (groups.length === 0) {
    return (
      <p className="out__none">
        Nothing on this server reads from outside it. Every table here keeps its own rows.
      </p>
    )
  }

  const entries = groups.flatMap((g) => g.entries)
  const qualified = (entry: OutsideEntry) => `${entry.table.database}.${entry.table.name}`

  /* One at a time, in order. Each of these opens a connection to somebody else's
     infrastructure, and firing forty at once is a thing a monitoring system does
     on purpose and a page should not do because a button was pressed. */
  const checkAll = async () => {
    setChecking(true)
    for (const entry of entries) {
      const key = qualified(entry)
      setAnswers((was) => ({ ...was, [key]: 'asking' }))
      try {
        const attempt = await api.connect(entry.table.database, entry.table.name)
        setAnswers((was) => ({ ...was, [key]: attempt }))
      } catch {
        setAnswers((was) => {
          const next = { ...was }
          delete next[key]
          return next
        })
      }
    }
    setChecking(false)
  }

  return (
    <div className="out">
      <div className="out__bar">
        <p className="out__says">{saysOutside(groups, data.total)}</p>
        <span className="panel__spacer" />
        <button className="btn" onClick={checkAll} disabled={checking}>
          {checking ? 'Asking each of them…' : 'Check every address'}
        </button>
      </div>

      {groups.map((group) => (
        <div className="out__group" key={group.key}>
          <div className="out__head">
            <span className="out__where">{groupLabel(group)}</span>
            <span className="out__what">
              {EXTERNAL_KIND_LABEL[group.kind]} · {group.engines.join(', ')}
            </span>
            <span className="panel__spacer" />
            <span className="out__count">
              {group.entries.length} {group.entries.length === 1 ? 'table' : 'tables'}
            </span>
          </div>
          <table className="tbl">
            <tbody>
              {group.entries.map((entry) => {
                const answer = answers[qualified(entry)]
                return (
                  <tr key={qualified(entry)}>
                    <td className="tbl__key">
                      <Link
                        to={`/db/${encodeURIComponent(entry.table.database)}/${encodeURIComponent(entry.table.name)}`}
                      >
                        {entry.table.database}.{entry.table.name}
                      </Link>
                      {answer && answer !== 'asking' ? (
                        <span
                          className={`says says--wide out__verdict--${verdictOf(answer)}`}
                          title={saysAttempt(answer)}
                        >
                          {saysShort(answer)}
                        </span>
                      ) : null}
                      {answer === 'asking' ? <span className="says">asking…</span> : null}
                    </td>
                    {/* What this one reads, which is the part of the address the
                        group heading does not carry. */}
                    <td className="out__target mono-dim">{entry.target}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}
