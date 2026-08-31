import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import { bytes } from '../lib/format'
import { fullnessOf, pressureOf } from '../lib/limits'
import { byPolicy, saysCap, type StorageReport } from '../lib/storage'
import { EmptyNote, ErrorNote, Loading } from './Note'

/** Where a table's data is allowed to live.
 *
 *  A policy holds volumes in priority order, a volume holds disks, and a part
 *  goes to the first volume that will take it. The three things worth reading
 *  here are not in the configuration file: which disks belong to no policy and so
 *  can never hold anything, whether a volume is being drained by the server right
 *  now, and whether the volumes of a "tier" are actually on different
 *  filesystems. */
export function Storage() {
  const report = useQuery({
    queryKey: ['storage', 'policies'],
    queryFn: () => api.storagePolicies(),
    staleTime: 30_000,
  })

  return (
    <section className="diag">
      <header className="diag__head">
        <h2 className="diag__title">Where data is allowed to live</h2>
        <p className="diag__sub">
          From <code>system.storage_policies</code> and <code>system.disks</code>. A part is
          written to the first volume of its table&apos;s policy that will take it, and the server
          moves parts downward on its own once a volume&apos;s free space falls under the
          policy&apos;s move factor.
        </p>
      </header>

      {report.isPending ? <Loading label="Reading the storage policies" /> : null}
      {report.error ? <ErrorNote error={report.error} retry={() => report.refetch()} /> : null}
      {report.data ? <Body report={report.data} /> : null}
    </section>
  )
}

function Body({ report }: { report: StorageReport }) {
  if (report.volumes.blocked) {
    return <EmptyNote title="Not visible to this user">{report.volumes.blocked}</EmptyNote>
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

      <h3 className="acc__group">Policies</h3>
      {byPolicy(report.volumes.items).map((g) => (
        <div className="lim__interval" key={g.policy}>
          <p className="acc__line">
            <span className="label">{g.policy.toUpperCase()}</span>
            <span className="mono-dim">
              {g.volumes.length === 1
                ? 'one volume, so nothing moves anywhere'
                : `${g.volumes.length} volumes, tried in this order`}
            </span>
          </p>
          <table className="tbl">
            <thead>
              <tr>
                <th>Volume</th>
                <th>Disks</th>
                <th className="tbl--n">Free</th>
                <th className="tbl--n">Move factor</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {g.volumes.map((v) => (
                <tr key={v.volume}>
                  <td className="tbl__key">
                    {v.volume}
                    <span className="says mono-dim">
                      {v.priority}
                      {v.kind === 'JBOD' && v.disks.length > 1 ? ' · spread across its disks' : ''}
                    </span>
                  </td>
                  <td className="mono-dim">{v.disks.join(', ')}</td>
                  <td className="tbl--n mono-dim">{Math.round(v.free_ratio * 100)}%</td>
                  {/* Dropped rather than dashed: zero means the server never
                      moves anything off this volume, which the figure `0%` would
                      read as "move when it is completely full". */}
                  <td className="tbl--n mono-dim">
                    {v.move_factor > 0 ? `${Math.round(v.move_factor * 100)}%` : ''}
                  </td>
                  <td>
                    {v.draining ? (
                      <span className="flag flag--error">being drained now</span>
                    ) : null}
                    {saysCap(v) ? <span className="says">{saysCap(v)}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <h3 className="acc__group">Disks</h3>
      <table className="tbl">
        <thead>
          <tr>
            <th>Disk</th>
            <th className="tbl--n">Used</th>
            <th className="tbl--n">Total</th>
            <th>In policies</th>
          </tr>
        </thead>
        <tbody>
          {report.disks.items.map((d) => {
            const used = d.total - d.free
            const band = pressureOf(used, d.total)
            const f = fullnessOf(used, d.total)
            return (
              <tr key={d.name}>
                <td className="tbl__key">
                  {d.name}
                  <span className="says mono-dim">{d.path}</span>
                </td>
                <td className="tbl--n">
                  {f !== null && band !== null ? (
                    <span className="gauge" title={`${bytes(used)} of ${bytes(d.total)}`}>
                      <span className="gauge__value">{bytes(used)}</span>
                      <span className="gauge__track">
                        <span
                          className={`gauge__fill gauge__fill--${band}`}
                          style={{ width: f > 0 ? `max(2px, ${f * 100}%)` : 0 }}
                        />
                      </span>
                    </span>
                  ) : (
                    <span className="mono-dim">{bytes(used)}</span>
                  )}
                </td>
                <td className="tbl--n mono-dim">{bytes(d.total)}</td>
                <td className="mono-dim">
                  {d.used_by.length ? (
                    d.used_by.join(', ')
                  ) : (
                    /* Not empty and not zero: a disk in no policy is capacity
                       nothing can reach, which is a different fact from a disk
                       that is merely unused. */
                    <span className="says">none — nothing can be written here</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </>
  )
}
