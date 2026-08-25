import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import { bytes, count, duration, relativeTime } from '../lib/format'
import { EmptyNote, ErrorNote, Loading } from '../components/Note'

/** Recent SELECTs from `system.query_log`, one click from being re-run.
 *  Deliberately a panel over the results rather than a separate page: you
 *  reach for history mid-query, not as a destination. */
export function HistoryPanel({
  onPick,
  onClose,
}: {
  onPick: (sql: string) => void
  onClose: () => void
}) {
  const history = useQuery({
    queryKey: ['history'],
    queryFn: () => api.history(100),
    staleTime: 15_000,
  })

  return (
    <section className="history">
      <header className="history__head">
        <h3 className="history__title label">Recent queries</h3>
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </header>

      <div className="history__body">
        {history.isPending ? <Loading label="Reading query_log" /> : null}
        {history.error ? (
          <ErrorNote error={history.error} retry={() => history.refetch()} />
        ) : null}

        {history.data && !history.data.available ? (
          <EmptyNote title="No query history">
            {history.data.reason ?? 'system.query_log is not available.'} Enable it in
            ClickHouse to see what has been running.
          </EmptyNote>
        ) : null}

        {history.data?.available && history.data.entries.length === 0 ? (
          <EmptyNote title="Nothing in the last 7 days">
            Run a query and it shows up here.
          </EmptyNote>
        ) : null}

        {history.data?.entries.map((entry) => (
          <button
            key={entry.query_id + entry.event_time}
            className={`histrow${entry.exception ? ' histrow--failed' : ''}`}
            onClick={() => onPick(entry.query)}
            title="Load this query into the current tab"
          >
            <span className="histrow__when">{relativeTime(entry.event_time)}</span>
            <code className="histrow__sql">{entry.query.replace(/\s+/g, ' ').trim()}</code>
            <span className="histrow__facts">
              {entry.exception ? (
                <span className="histrow__failed">failed</span>
              ) : (
                <>
                  <span>{count(entry.read_rows)} read</span>
                  <span>{bytes(entry.read_bytes)}</span>
                  <span>{duration(entry.duration_ms / 1000)}</span>
                </>
              )}
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}
