import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import { api } from '../lib/api'
import { keeps } from '../lib/spaces'
import { TONE_LABEL, inSpace, parseCondition, saysElsewhere, toneOf, describeAlert } from '../lib/alert'
import { EmptyNote } from './Note'

/** Infrastructure — the alerts that watch this server.
 *
 *  Which space *lists* an alert follows what it queries, not who wrote it. An
 *  alert on `system.replicas` belongs beside the replicas even when an analyst
 *  wrote it, and one on `orders` belongs in Data even when an operator did. The
 *  placement is decided by asking ClickHouse which tables the statement resolves
 *  to, so it stays right when a table is dropped under a stored alert.
 *
 *  Read-only, and deliberately: writing an alert stays in one place, so there is
 *  one form to learn and one page that owns the shape of them. This is the
 *  operator finding out what is already watching, next to the thing watched. */
export function WatchedHere() {
  const config = useQuery({ queryKey: ['config'], queryFn: () => api.config() })
  /* Not asked without a workspace. A stateless Flint keeps no alerts, and a
     refusal rendered as an error would say something is broken when the
     deployment is exactly as configured. */
  const stateful = keeps(config.data)
  const alerts = useQuery({
    queryKey: ['alerts'],
    queryFn: () => api.alerts(),
    enabled: stateful,
    retry: false,
  })

  if (!stateful || !alerts.data) return null

  const mine = inSpace(alerts.data, 'infra')
  const elsewhere = saysElsewhere(alerts.data, 'infra')

  return (
    <section className="section">
      <h2 className="section__title">Watched on this server</h2>
      <p className="section__sub">
        Alerts whose statement reads the server about itself. Where an alert is listed follows
        what it queries rather than who wrote it — <Link to="/alerts">writing one</Link> stays in
        one place.
      </p>

      {mine.length ? (
        <>
          {elsewhere ? <p className="diag__quiet">{elsewhere}</p> : null}
          <table className="tbl">
            <thead>
              <tr>
                <th>Alert</th>
                <th>Reads</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {mine.map((a) => {
                const condition = parseCondition(a.condition)
                return (
                  <tr key={a.id}>
                    <td
                      className="tbl__key"
                      title={condition ? describeAlert(condition, a.interval_seconds) : a.sql}
                    >
                      {a.name}
                      {a.enabled ? null : <span className="says">switched off</span>}
                    </td>
                    {/* The server's own answer about what the statement reads,
                        which is also how the alert got onto this page. An alert
                        that cannot be placed says why here rather than being
                        filed silently under a guess. */}
                    <td className="mono-dim">{a.space_note}</td>
                    <td>
                      {/* The same badge the Data list uses, from the same
                          helper: two spellings of "firing" would eventually
                          disagree about what firing looks like. */}
                      <span className={`flag flag--${toneOf(a.state)}`}>
                        {TONE_LABEL[toneOf(a.state)]}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </>
      ) : (
        <EmptyNote title="Nothing watches this server">
          {elsewhere
            ? `No alert reads system tables. ${elsewhere}`
            : 'No alert has been written yet. One that reads a system table will appear here rather than in Data.'}
        </EmptyNote>
      )}
    </section>
  )
}
