import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import { EmptyNote, ErrorNote, Loading } from './Note'

/** The levels somebody would actually ask for, worst first.
 *
 *  `Warning` is the default, not `Trace`. This server holds 2.2 million rows in
 *  `system.text_log` and a few hundred of them matter; a page that opens on ten
 *  thousand lines of trace is a page that hides the one line you wanted. */
const LEVELS = ['error', 'warning', 'information', 'debug', 'trace'] as const

/** The tail of the server's own log — the thing people open a shell for.
 *
 *  Newest first, and deliberately not live: a log that scrolls while you are
 *  reading it is a log you cannot read. The button is how it moves. */
export function ServerLog() {
  const [level, setLevel] = useState<string>('warning')
  const report = useQuery({
    queryKey: ['health', 'log', level],
    queryFn: () => api.serverLog(level),
    staleTime: 10_000,
  })
  const lines = report.data?.lines ?? []

  return (
    <section className="diag">
      <header className="diag__head">
        <h2 className="diag__title">The server&apos;s log</h2>
        <p className="diag__sub">
          <code>system.text_log</code>, newest first, at the level chosen and everything worse
          than it. Not live: a log that scrolls while you read it is a log you cannot read.
        </p>
      </header>

      <div className="diag__filter">
        <span className="label">LEVEL</span>
        <div className="segmented">
          {LEVELS.map((l) => (
            <button
              key={l}
              className={`segmented__item${level === l ? ' is-on' : ''}`}
              onClick={() => setLevel(l)}
            >
              {l}
            </button>
          ))}
        </div>
        <button className="btn" onClick={() => report.refetch()} disabled={report.isFetching}>
          {report.isFetching ? 'Reading…' : 'Refresh'}
        </button>
      </div>

      {report.isPending ? <Loading label="Reading the log" /> : null}
      {report.error ? <ErrorNote error={report.error} retry={() => report.refetch()} /> : null}
      {report.data && !report.data.available ? (
        <EmptyNote title="No log here">{report.data.reason}.</EmptyNote>
      ) : null}

      {report.data?.available && lines.length === 0 ? (
        <p className="diag__quiet">
          Nothing at this level — which for `warning` and above is the answer you want.
        </p>
      ) : null}

      {lines.length ? (
        <div className="tlog">
          {lines.map((line, i) => (
            <div className={`tlog__line tlog__line--${line.level.toLowerCase()}`} key={i}>
              <span className="tlog__at">{line.at}</span>
              <span className="tlog__level">{line.level}</span>
              <span className="tlog__logger" title={line.logger}>
                {line.logger}
              </span>
              {/* The full text on hover: clamped to three lines above, because
                  a ClickHouse message carries paragraphs and a tail that cannot
                  be scanned is not a tail. */}
              <span className="tlog__msg" title={line.message}>
                {line.message}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}
