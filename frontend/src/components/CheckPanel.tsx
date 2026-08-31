import { useState } from 'react'

import { api, type CheckResult } from '../lib/api'

/** Try it before you arm it.
 *
 *  The statement runs the way the scheduler will run it — read-only, capped —
 *  so what you see here is what the thing you are about to arm will do. A test
 *  under different rules than the real thing is worse than no test. */
export function CheckPanel({
  sql,
  database,
  condition,
  params,
  blocked,
  label = 'Test it',
  onColumns,
}: {
  sql: string
  database: string
  /** An alert condition, when there is one: the verdict then says what this
   *  would do right now, which is the only question its author has. */
  condition?: string
  /** Values for the statement's placeholders, so a parameterised statement can
   *  be tested with what a caller would actually send. */
  params?: [string, string][]
  /** Why this cannot be tested here, when it cannot. Said instead of letting
   *  ClickHouse answer with "Substitution `city` is not set", which is true and
   *  unhelpful. */
  blocked?: string
  label?: string
  /** The columns the statement turned out to return, handed up as soon as it
   *  has run once.
   *
   *  A `DESCRIBE` is the only way to know them, and this panel is already
   *  doing one on the author's behalf — so a second round trip to learn the
   *  same thing would be a second round trip. What wants them is the contract
   *  editor above: a promise about a column the statement does not return is a
   *  promise the endpoint cannot keep, and the moment it is typed is the
   *  cheapest possible moment to say so. */
  onColumns?: (columns: string[]) => void
}) {
  const [result, setResult] = useState<CheckResult | null>(null)
  const [running, setRunning] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  const run = async () => {
    setRunning(true)
    setFailed(null)
    try {
      const answer = await api.check({ sql, database, condition, params })
      setResult(answer)
      // Only where it actually ran: a failed check knows nothing about the
      // columns, and handing up an empty list would read as "this statement
      // returns nothing" rather than "nobody has asked yet".
      if (answer.ok) onColumns?.(answer.columns.map((c) => c.name))
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="check">
      <div className="check__bar">
        <button
          className="btn"
          onClick={run}
          disabled={running || !sql.trim() || Boolean(blocked)}
          title={blocked ?? undefined}
        >
          {running ? 'Running…' : label}
        </button>
        {result?.ok ? (
          <span className="mono-dim">
            {result.rows.length} row{result.rows.length === 1 ? '' : 's'} in {result.elapsed_ms} ms
            {result.truncated ? ' (first few)' : ''}
          </span>
        ) : null}
      </div>

      {blocked ? <p className="says says--wide says--watch">{blocked}</p> : null}
      {failed ? <p className="says says--wide says--throw">{failed}</p> : null}

      {/* The verdict first: for an alert it is the answer, and the rows are
          only how it was reached. */}
      {result?.verdict ? (
        <p className={`check__verdict check__verdict--${result.verdict.state}`}>
          {result.verdict.message}
        </p>
      ) : null}

      {result && !result.ok ? (
        <p className="says says--wide says--throw">{result.error}</p>
      ) : null}

      {result?.ok && result.columns.length ? (
        <div className="check__table">
          <table className="tbl">
            <thead>
              <tr>
                {result.columns.map((c) => (
                  <th key={c.name}>
                    {c.name} <span className="mono-dim">{c.type}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.slice(0, 6).map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j} className="mono-dim">
                      {cell === null ? <span className="dash">∅</span> : String(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {result.rows.length > 6 ? (
            <p className="check__more">
              and {result.rows.length - 6} more of the first {result.rows.length}
            </p>
          ) : null}
        </div>
      ) : null}

      {result?.ok && !result.rows.length ? (
        /* Worth saying plainly: for a `rows > 0` alert this is the quiet case,
           and for a report section it is probably a mistake. */
        <p className="says says--wide says--watch">
          It ran, and returned no rows.
        </p>
      ) : null}
    </div>
  )
}
