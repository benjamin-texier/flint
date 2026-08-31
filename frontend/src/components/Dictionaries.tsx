import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../lib/api'
import { bytes, count, duration } from '../lib/format'
import {
  everLoaded,
  saysFound,
  saysLifetime,
  type Dictionary,
  type DictionaryReport,
} from '../lib/dictionaries'
import { allows } from '../lib/spaces'
import { EmptyNote, ErrorNote, Loading } from './Note'

/** Dictionaries, and whether they are actually working.
 *
 *  A dictionary is the one piece of ClickHouse that fails and keeps answering:
 *  one that loaded successfully and has since been failing to refresh returns
 *  the values it had, and no query result says so. Its status column says so
 *  either — it reads `LOADED` — which is why the verdicts come from the backend
 *  rather than from the colour of a row. */
export function Dictionaries() {
  const config = useQuery({ queryKey: ['config'], queryFn: () => api.config() })
  const may = allows(config.data?.tier, 'ddl')
  const report = useQuery({
    queryKey: ['dictionaries'],
    queryFn: () => api.dictionaries(),
    staleTime: 20_000,
  })

  return (
    <section className="diag">
      <header className="diag__head">
        <h2 className="diag__title">Dictionaries</h2>
        <p className="diag__sub">
          From <code>system.dictionaries</code>. The thing worth knowing is that a dictionary which
          loaded once and is now failing to refresh keeps answering with what it had — its status
          still reads <code>LOADED</code>, so nothing a query returns will tell you.
        </p>
      </header>

      {report.isPending ? <Loading label="Reading the dictionaries" /> : null}
      {report.error ? <ErrorNote error={report.error} retry={() => report.refetch()} /> : null}
      {report.data ? <Body report={report.data} may={may} /> : null}
    </section>
  )
}

function Body({ report, may }: { report: DictionaryReport; may: boolean }) {
  if (report.items.blocked) {
    return <EmptyNote title="Not visible to this user">{report.items.blocked}</EmptyNote>
  }
  if (report.items.items.length === 0) {
    return <p className="diag__quiet">No dictionaries are defined on this server.</p>
  }

  return (
    <>
      {report.verdicts.length ? (
        <div className="cfg__loud">
          {report.verdicts.map((v, i) => (
            <p key={i}>{v}</p>
          ))}
        </div>
      ) : null}

      <table className="tbl">
        <thead>
          <tr>
            <th>Dictionary</th>
            <th>State</th>
            <th className="tbl--n">Keys</th>
            <th className="tbl--n">Memory</th>
            <th>Refresh</th>
            <th>Notes</th>
            {may ? <th /> : null}
          </tr>
        </thead>
        <tbody>
          {report.items.items.map((d) => (
            <tr key={`${d.database}.${d.name}`}>
              <td className="tbl__key">
                {d.database}.{d.name}
                {/* Dropped rather than dashed: before its first load the server
                    does not know the source either. */}
                {d.source ? <span className="says mono-dim">{d.source}</span> : null}
              </td>
              <td>
                <span className="mono-dim">{d.status.toLowerCase()}</span>
                {d.worrying ? <span className="flag flag--error">needs a look</span> : null}
                {d.status === 'NOT_LOADED' && report.lazy ? (
                  /* Not a fault. `dictionaries_lazy_load` is on, so nobody has
                     queried it yet — and flagging that would make every fresh
                     server look broken. */
                  <span className="says">nobody has queried it yet, and this server loads them lazily</span>
                ) : null}
              </td>
              {/* Empty rather than zero where nothing has been measured: a zero
                  is a measurement. */}
              <td className="tbl--n mono-dim">{everLoaded(d) ? count(d.elements) : ''}</td>
              <td className="tbl--n mono-dim">{everLoaded(d) ? bytes(d.bytes) : ''}</td>
              <td className="mono-dim">
                {saysLifetime(d)}
                {everLoaded(d) ? (
                  <span className="says">last at {d.last_success}</span>
                ) : null}
              </td>
              <td>
                {saysFound(d) ? <span className="says">{saysFound(d)}</span> : null}
                {d.loading_secs > 1 ? (
                  <span className="says">takes {duration(d.loading_secs)} to load</span>
                ) : null}
                {d.exception ? (
                  <span className="says says--throw">{d.exception.split('\n')[0]}</span>
                ) : null}
              </td>
              {may ? (
                <td className="tbl--n">
                  <Reload dictionary={d} />
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

/** Load it again, now.
 *
 *  The one action on this page whose effect is observable: the status, the key
 *  count and the last-success time all move. A large dictionary reloads by
 *  fetching its whole source again, so it is a job rather than a request that
 *  returns. */
function Reload({ dictionary }: { dictionary: Dictionary }) {
  const queryClient = useQueryClient()
  const act = useMutation({
    mutationFn: () => api.reloadDictionary(dictionary.database, dictionary.name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dictionaries'] })
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
    },
  })

  return (
    <span className="bk__act">
      <button className="btn" onClick={() => act.mutate()} disabled={act.isPending}>
        {act.isPending ? 'Reloading…' : 'Reload'}
      </button>
      {act.error ? (
        <span className="says says--throw">
          {act.error instanceof Error ? act.error.message : 'it was refused'}
        </span>
      ) : null}
    </span>
  )
}
