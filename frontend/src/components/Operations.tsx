import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../lib/api'
import {
  anyRunning,
  elapsedMs,
  says,
  spaceOfKind,
  stoppable,
  tookFor,
  type Job,
} from '../lib/job'
import type { SpaceId } from '../lib/spaces'
import { EmptyNote, ErrorNote } from './Note'

/** Long operations Flint started on somebody's behalf.
 *
 *  Above everything, and outside the shut-out branch: a job is Flint's own
 *  bookkeeping in its own workspace, so a role that cannot read `system.parts`
 *  can still see what it asked for. And it is the first thing you want on this
 *  page — "is the thing I started still going" outranks every standing figure.
 *
 *  No progress bar. ClickHouse does not report a percentage for a merge, and a
 *  bar that fills at a rate Flint invented is worse than a number that is simply
 *  how long it has been going. */
export function Operations({ space }: { space: SpaceId }) {
  const queryClient = useQueryClient()
  const report = useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.jobs(),
    retry: false,
    /* Only while something is going. A list of finished jobs re-asked every two
       seconds is a request per two seconds for an answer that cannot change. */
    refetchInterval: (query) => (anyRunning(query.state.data?.jobs ?? []) ? 2_000 : false),
  })
  const stop = useMutation({
    mutationFn: (id: string) => api.cancelJob(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['jobs'] }),
  })
  /* When the list arrived, not when React happened to render — `Date.now()` in a
     render body is impure and ticks unpredictably. This advances with each
     refetch, which is every two seconds while anything is running, and that is
     as often as a duration needs to move. */
  const now = report.dataUpdatedAt
  /* Filed by what the job does, not by who submitted it — see `spaceOfKind`.
     An operator reading Health should not have to scroll past somebody's report
     editions, and a reader on the Reports page has no business being shown a
     merge they cannot act on. */
  const jobs = (report.data?.jobs ?? []).filter((j) => spaceOfKind(j.kind) === space)

  /* Nothing at all, and no reason to say so: on a Flint where nobody has ever
     started one, an empty panel headed "Operations" is furniture. */
  if (!report.data?.available && !report.error) return null
  if (report.data?.available && jobs.length === 0) return null

  return (
    <section className="diag">
      <header className="diag__head">
        {/* Not "Editions running": the list keeps the recent ones too, and a
            title that promises only what is in flight is a title nobody can
            reconcile with the rows under it. */}
        <h2 className="diag__title">{space === 'data' ? 'Asked for by hand' : 'Operations'}</h2>
        <p className="diag__sub">
          {space === 'data'
            ? 'Editions asked for by hand. The schedule makes its own, and they are listed with the report.'
            : "Work Flint started for somebody, and what became of it. Each one ran as the user who asked, so the server's own log attributes it to them."}
        </p>
      </header>
      {report.error ? <ErrorNote error={report.error} retry={() => report.refetch()} /> : null}
      {report.data && !report.data.available ? (
        <EmptyNote title="Not kept here">{report.data.reason}.</EmptyNote>
      ) : null}
      {jobs.length ? (
        <table className="tbl">
          <thead>
            <tr>
              <th>Operation</th>
              <th>State</th>
              <th>Asked by</th>
              <th className="tbl--n">Took</th>
              <th>What happened</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => {
              const verdict = says(job.state)
              return (
                <tr key={job.id}>
                  <td className="tbl__key">{job.label}</td>
                  <td>
                    <span className={`flag flag--job-${verdict.level}`}>{verdict.label}</span>
                  </td>
                  <td className="mono-dim">{job.submitted_by}</td>
                  <td className="tbl--n mono-dim">{took(job, now)}</td>
                  <td className="mono-dim">{job.detail}</td>
                  <td className="tbl--n">
                    {stoppable(job) ? (
                      <button
                        className="btn"
                        onClick={() => stop.mutate(job.id)}
                        disabled={stop.isPending}
                        title="Ask the server to stop it. Work already begun may still finish."
                      >
                        Stop
                      </button>
                    ) : null}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : null}
    </section>
  )
}

/** How long it took, or nothing at all.
 *
 *  A job whose end Flint never saw has no duration — see `elapsedMs`. Dropped
 *  rather than dashed: a dash is for a figure that should exist and does not, and
 *  this one should not exist. */
function took(job: Job, nowMs: number): string {
  const ms = elapsedMs(job, nowMs)
  return ms === null ? '' : tookFor(ms)
}

