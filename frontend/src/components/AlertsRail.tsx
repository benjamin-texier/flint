import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'

import { api } from '../lib/api'
import {
  STANDINGS,
  inSpace,
  STANDING_LABEL,
  counts,
  destinations,
  type Standing,
} from '../lib/alert'

/** The rail beside the alerts.
 *
 *  The Data space has one rail — the schema explorer — and it followed the
 *  reader onto every page in the space, including this one. A list of tables
 *  beside a list of alerts is the wrong rail on the wrong page: nothing on it
 *  can be clicked to answer a question anybody has while looking at alerts.
 *
 *  This one answers two: **how many are in each state**, which is the filter,
 *  and **where the notifications go**, which is the question nobody thinks to
 *  ask until the day one of them stops arriving. */
export function AlertsRail() {
  const [params, setParams] = useSearchParams()
  const alerts = useQuery({ queryKey: ['alerts'], queryFn: () => api.alerts() })
  /* The same space rule the page applies, applied here rather than assumed: a
     rail counting six while the list below it shows two is precisely the drift
     this pairing exists to prevent. What the other space holds is the page's
     line to write, beneath the list it is missing from. */
  const list = inSpace(alerts.data ?? [], 'data')
  const tally = counts(list)
  const where = destinations(list)
  const on = params.get('state')

  const select = (standing: Standing | null) => {
    const next = new URLSearchParams(params)
    // Everything is the default and stays unwritten, so the plain address is
    // the whole list — the same rule the database views follow.
    if (!standing || standing === on) next.delete('state')
    else next.set('state', standing)
    setParams(next, { replace: true })
  }

  const firing = tally.firing + tally.error

  return (
    <aside className="rail rail--alerts">
      <div className="rail__head">
        <h2 className="rail__title">Alerts</h2>
        <p className="rail__sub">
          {list.length} defined
          {firing > 0 ? ` · ${firing} asking for you` : ''}
        </p>
      </div>

      <ul className="railset">
        <li>
          <button
            className={`railset__row railset__row--all${on === null ? ' is-on' : ''}`}
            aria-pressed={on === null}
            onClick={() => select(null)}
          >
            <span className="railset__name">Everything</span>
            <span className="railset__count">{list.length}</span>
          </button>
        </li>
        {STANDINGS.filter((s) => tally[s] > 0).map((s) => (
          <li key={s}>
            <button
              className={`railset__row railset__row--${s}${on === s ? ' is-on' : ''}`}
              aria-pressed={on === s}
              onClick={() => select(s)}
            >
              <span className="railset__name">{STANDING_LABEL[s]}</span>
              <span className="railset__count">{tally[s]}</span>
            </button>
          </li>
        ))}
      </ul>

      {where.length ? (
        <div className="rail__block">
          <p className="rail__label">Where they go</p>
          <ul className="railset railset--plain">
            {where.map((d) => (
              <li key={d.label} className="railset__dest">
                <span className="railset__name" title={d.label}>
                  {d.label}
                </span>
                <span
                  className={`railset__state${d.failing ? ' railset__state--failing' : ''}`}
                  title={
                    d.failing
                      ? `The last notification did not get through: ${d.failing}`
                      : d.tried
                        ? 'The last notification arrived'
                        : 'Nothing has been sent here yet'
                  }
                >
                  {/* A fixed word, not the first word of whatever the transport
                      said: that read "the" and "error" in two adjacent rows.
                      The message itself is one hover away, in full. And a
                      destination nothing has been sent to yet says nothing —
                      a dash is for a figure that should exist and does not. */}
                  {d.failing ? 'failing' : d.tried ? 'delivered' : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </aside>
  )
}
