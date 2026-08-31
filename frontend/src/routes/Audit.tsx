import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import {
  actorOf,
  KIND_LABEL,
  obstacles,
  outcomeNote,
  quiet,
  scopeSentence,
  type AuditEntry,
} from '../lib/audit'
import { count, duration } from '../lib/format'
import { EmptyNote, ErrorNote, Loading } from '../components/Note'

const WINDOWS = [1, 7, 30] as const

/** Infrastructure — Audit. */
export function AuditPage() {
  const [days, setDays] = useState<number>(7)
  const report = useQuery({
    queryKey: ['audit', days],
    queryFn: () => api.audit(days, 200),
  })
  /* Every time on this page is the server's, and on the page about *when*
     things happened that has to be said. A reader whose watch is two hours off
     ClickHouse's would otherwise line an incident up against the wrong rows —
     the Reports page names it for the same reason. */
  const server = useQuery({ queryKey: ['server'], queryFn: () => api.server() })
  const timezone = server.data?.timezone

  const blocked = obstacles(report.data)

  return (
    <div className="page page--diagnose">
      <header className="page__head">
        <p className="eyebrow">INFRASTRUCTURE</p>
        <div className="page__titlerow">
          <h1 className="page__title page__title--hero">Who did what</h1>
        </div>
        <p className="page__lead">{scopeSentence(report.data)}</p>
        {/* A window, not a filter: an audit is read by somebody asking about a
            period, and the period is the first thing they know. The control is
            Diagnostics', because two pages that ask the same question should
            not ask it two ways. */}
        <div className="diag__filter">
          <span className="label">WINDOW</span>
          <div className="segmented">
            {WINDOWS.map((n) => (
              <button
                key={n}
                className={`segmented__item${days === n ? ' is-on' : ''}`}
                onClick={() => setDays(n)}
              >
                {n === 1 ? '24 hours' : `${n} days`}
              </button>
            ))}
          </div>
        </div>
      </header>

      {report.isPending ? <Loading label="Reading the trail" /> : null}
      {report.error ? <ErrorNote error={report.error} retry={() => report.refetch()} /> : null}

      {/* Two halves, two reasons. A single "unavailable" would hide whichever
          one still worked, and they are fixed in different places. */}
      {blocked.map((why) => (
        <p className="says says--wide says--watch" key={why}>
          {why}
        </p>
      ))}

      {quiet(report.data) ? (
        <EmptyNote title="Nothing in this window">
          Nobody ran an operation, called an endpoint or read a dataset in the last{' '}
          {days === 1 ? '24 hours' : `${days} days`}. Both halves of the trail were readable, so
          this is quiet rather than unavailable.
        </EmptyNote>
      ) : null}

      {report.data?.entries.length ? (
        <>
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">When{timezone ? <span className="mono-dim"> {timezone}</span> : null}</th>
                <th scope="col">Who</th>
                <th scope="col">Did</th>
                <th scope="col">What</th>
                <th scope="col" className="tbl--n">
                  Took
                </th>
                <th scope="col" className="tbl--n">
                  Read
                </th>
              </tr>
            </thead>
            <tbody>
              {report.data.entries.map((entry, at) => (
                <Row key={`${entry.at}-${entry.what}-${at}`} entry={entry} />
              ))}
            </tbody>
          </table>
          {/* The cap, counting itself. A trail that stops without saying so
              reads as the whole of what happened. */}
          {report.data.note ? <p className="mono-dim">{report.data.note}</p> : null}
        </>
      ) : null}
    </div>
  )
}

function Row({ entry }: { entry: AuditEntry }) {
  const actor = actorOf(entry)
  return (
    <tr>
      <td className="mono-dim">{entry.at}</td>
      {/* Two facts where the log carries one: an endpoint is called by whoever
          holds its token, and the account is only what it ran as. Saying the
          account "did" it is the one misstatement an audit cannot afford.
          Prose is not mono — only a real account name is. */}
      <td>{actor.ranAs ? actor.who : <span className="mono">{actor.who}</span>}</td>
      <td>
        {/* The verb, then what qualified it: the tier that permitted an
            operation, or the account an endpoint ran as. Both go here rather
            than in Who, because both answer "how", and Who has to stay the
            answer to "who". Two elements, not one string: the first draft
            rendered "ranadmin". */}
        {KIND_LABEL[entry.kind]}
        {entry.tier ? <span className="mono-dim"> {entry.tier}</span> : null}
        {actor.ranAs ? <span className="mono-dim"> as {actor.ranAs}</span> : null}
      </td>
      <td>
        <span className="mono">{entry.what}</span>
        {/* Flagged, because a refusal is the thing an audit is most read for
            and a row that reads like every other one buries it. Nothing on the
            ones that worked: a badge on every line is a badge nobody reads. */}
        {(() => {
          const note = outcomeNote(entry.outcome)
          return note ? <span className={note.tone}>{note.label}</span> : null
        })()}
        {/* The server's own words, on purpose. This is read by whoever runs the
            server, about their own server — an API refusal is translated before
            it leaves Flint, and this is the opposite case. */}
        {entry.detail ? <p className="mono-dim">{entry.detail}</p> : null}
      </td>
      {/* Dropped rather than dashed where there is none: a job read some
          unknown number of rows, and a zero would answer a question nobody can
          check. */}
      <td className="tbl--n mono-dim">
        {entry.duration_ms === undefined ? '' : duration(entry.duration_ms / 1000)}
      </td>
      <td className="tbl--n mono-dim">
        {entry.read_rows === undefined ? '' : count(entry.read_rows)}
      </td>
    </tr>
  )
}
