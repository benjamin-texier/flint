import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../lib/api'
import { bytes, relativeTime } from '../lib/format'
import { attachIsRoutine, says, summary, type DetachedPart } from '../lib/parts'
import { allows } from '../lib/spaces'
import { EmptyNote, ErrorNote, Loading } from './Note'

/** Parts on the disk that are not in the table.
 *
 *  Nothing else shows this, and nothing in ClickHouse cleans it up. A partition
 *  detached in March is still occupying disk in December, and the way people find
 *  out is that a disk fills.
 *
 *  The screen exists to keep two things apart that look identical in a directory
 *  listing: a part somebody detached on purpose, and a part the server put aside
 *  because it was broken. Reattaching the first is the next step in a procedure.
 *  Reattaching the second puts a broken part back into a table. */
export function DetachedParts() {
  const config = useQuery({ queryKey: ['config'], queryFn: () => api.config() })
  const report = useQuery({
    queryKey: ['parts', 'detached'],
    queryFn: () => api.detachedParts(),
    staleTime: 20_000,
  })
  const data = report.data
  const parts = data?.parts ?? []
  const line = summary(data)

  /* Attaching puts data back and is undone by detaching again. Deleting a
     detached part is permanent, so it needs the tier that operates the server
     rather than the one that reshapes a schema — and the backend checks the same
     thing. */
  const mayAttach = allows(config.data?.tier, 'ddl')
  const mayDelete = allows(config.data?.tier, 'admin')

  /* Nothing detached is the common case and the good one. Said in one line
     rather than an empty table: a section that renders headers over no rows
     reads as a section that failed. */
  if (data?.available && parts.length === 0) {
    return (
      <section className="diag">
        <header className="diag__head">
          <h2 className="diag__title">Detached parts</h2>
        </header>
        <p className="diag__quiet">
          Nothing is detached. Parts left in <code>detached/</code> occupy disk that nothing will
          reclaim on its own, so an empty answer here is the one you want.
        </p>
      </section>
    )
  }

  return (
    <section className="diag">
      <header className="diag__head">
        <h2 className="diag__title">Detached parts</h2>
        <p className="diag__sub">
          Data on the disk that is not in its table. ClickHouse never removes these on its own —
          a partition detached in March is still here in December — and the two ways a part gets
          here are opposite situations, so they are marked apart.
        </p>
      </header>

      {report.isPending ? <Loading label="Reading detached parts" /> : null}
      {report.error ? <ErrorNote error={report.error} retry={() => report.refetch()} /> : null}
      {data && !data.available ? <EmptyNote title="Not available here">{data.reason}.</EmptyNote> : null}

      {line ? (
        <p className={data && data.quarantined > 0 ? 'says says--watch' : 'diag__sub'}>
          {line} · {bytes(data?.total_bytes ?? 0)} on disk
        </p>
      ) : null}

      {parts.length ? (
        <table className="tbl">
          <thead>
            <tr>
              <th>Table</th>
              <th>Part</th>
              <th className="tbl--n">Size</th>
              <th>Detached</th>
              <th>Why</th>
              {mayAttach || mayDelete ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {parts.map((part) => {
              const verdict = says(part)
              return (
                <tr key={`${part.qualified}-${part.name}`}>
                  <td className="tbl__key">{part.qualified}</td>
                  <td className="mono-dim">{part.name}</td>
                  <td className="tbl--n mono-dim">{bytes(part.bytes)}</td>
                  <td className="mono-dim">{relativeTime(part.detached_at)}</td>
                  <td>
                    <span className={`flag flag--${verdict.level}`}>{verdict.text}</span>
                  </td>
                  {mayAttach || mayDelete ? (
                    <td className="tbl--n">
                      <Actions part={part} mayAttach={mayAttach} mayDelete={mayDelete} />
                    </td>
                  ) : null}
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : null}
    </section>
  )
}

function Actions({
  part,
  mayAttach,
  mayDelete,
}: {
  part: DetachedPart
  mayAttach: boolean
  mayDelete: boolean
}) {
  const [confirming, setConfirming] = useState(false)
  const queryClient = useQueryClient()
  const act = useMutation({
    mutationFn: (action: string) =>
      api.detachedPartAction(part.database, part.table, part.name, action),
    onSuccess: () => {
      setConfirming(false)
      queryClient.invalidateQueries({ queryKey: ['parts', 'detached'] })
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      queryClient.invalidateQueries({ queryKey: ['diag', 'storage'] })
    },
  })
  const routine = attachIsRoutine(part)

  if (confirming) {
    return (
      <div className="dparts__confirm">
        <span className="dparts__cost">deletes {bytes(part.bytes)}, permanently</span>
        <button className="btn" onClick={() => act.mutate('drop')} disabled={act.isPending}>
          Delete it
        </button>
        <button className="btn" onClick={() => setConfirming(false)}>
          Keep it
        </button>
      </div>
    )
  }

  return (
    <div className="dparts__acts">
      {mayAttach ? (
        <button
          /* The routine case gets the emphasis; a quarantined part gets the same
             control without it, and its reason is in the row beside it. Not
             refused — a broken part is sometimes exactly what you want back, once
             you have read why it was set aside. */
          className={`btn${routine ? ' btn--spark' : ''}`}
          onClick={() => act.mutate('attach')}
          disabled={act.isPending}
          title={
            routine
              ? 'Put this part back in the table'
              : `The server set this part aside: ${part.reason}. Attaching it puts it back as it is.`
          }
        >
          {act.isPending ? 'Working…' : 'Attach'}
        </button>
      ) : null}
      {mayDelete ? (
        <button className="btn" onClick={() => setConfirming(true)} disabled={act.isPending}>
          Delete
        </button>
      ) : null}
      {act.error ? (
        <span className="dparts__error">
          {act.error instanceof Error ? act.error.message : 'it was refused'}
        </span>
      ) : null}
    </div>
  )
}
