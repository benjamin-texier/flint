import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../lib/api'
import { bytes, count, relativeTime } from '../lib/format'
import {
  HEALTH_LABEL,
  forcingFor,
  verdictOf,
  type PipelineReport,
  type View,
} from '../lib/pipeline'
import { EmptyNote, ErrorNote, Loading } from '../components/Note'

/** Infrastructure — Pipelines.
 *
 *  Keeps its window control, unlike Health: a view's run history is exactly the
 *  kind of figure a window scopes, and "nothing ran" over 24 hours and over 30
 *  days are different answers. */
export function PipelinesPage() {
  const [days, setDays] = useState<number>(7)
  const config = useQuery({ queryKey: ['config'], queryFn: () => api.config() })

  return (
    <div className="page page--diagnose">
      <header className="page__head">
        <p className="eyebrow">INFRASTRUCTURE</p>
        <div className="page__titlerow">
          <h1 className="page__title page__title--hero">Whether the views are flowing</h1>
        </div>
        <div className="diag__filter">
          <span className="label">WINDOW</span>
          <div className="segmented">
            {[1, 7, 30].map((w) => (
              <button
                key={w}
                className={`segmented__item${days === w ? ' is-on' : ''}`}
                onClick={() => setDays(w)}
              >
                {w === 1 ? '24 hours' : `${w} days`}
              </button>
            ))}
          </div>
        </div>
      </header>
      {/* Read-only until the config says otherwise, not the other way round: a
          refresh button offered on a read-only deployment fails at the click. */}
      <PipelinesView days={days} readonly={config.data?.readonly ?? true} />
    </div>
  )
}

/** Are the materialized views flowing?
 *
 *  One row per view, and the verdict first — the numbers are how it was reached,
 *  not the answer. */
export function PipelinesView({ days, readonly }: { days: number; readonly: boolean }) {
  const report = useQuery({
    queryKey: ['pipelines', days],
    queryFn: () => api.pipelines(days),
    staleTime: 20_000,
  })

  return (
    <>
      <section className="diag">
        <header className="diag__head">
          <h2 className="diag__title">Materialized views</h2>
          <p className="diag__sub">
            A classic view is a trigger on inserts into its source; a refreshable one runs on its
            own schedule. They break in different ways and are read from different places, so the
            verdict combines both — plus whether the target table is still there, which is the
            breakage neither log can see.
          </p>
        </header>

        {report.isPending ? <Loading label="Reading the views" /> : null}
        {report.error ? <ErrorNote error={report.error} retry={() => report.refetch()} /> : null}

        {report.data && !report.data.log_available ? (
          <p className="says says--wide says--watch">
            {report.data.log_reason} — a view with no runs below means “we cannot tell”, not
            “nothing happened”.
          </p>
        ) : null}

        {report.data?.views.length === 0 ? (
          <EmptyNote title="No materialized views">
            Nothing in your databases is a materialized view, so there is no pipeline to check.
          </EmptyNote>
        ) : null}

        {report.data?.views.map((view) => (
          <ViewRow
            key={`${view.database}.${view.name}`}
            view={view}
            report={report.data}
            readonly={readonly}
          />
        ))}
      </section>
    </>
  )
}

function ViewRow({
  view,
  report,
  readonly,
}: {
  view: View
  report: PipelineReport
  readonly: boolean
}) {
  const client = useQueryClient()
  const [showBackfill, setShowBackfill] = useState(false)
  const verdict = verdictOf(view, report.log_available)
  const forcing = forcingFor(view)

  const refresh = useMutation({
    mutationFn: () => api.refreshView({ database: view.database, view: view.name }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['pipelines'] }),
  })

  return (
    <article className={`pipe pipe--${verdict.health}`}>
      <header className="pipe__head">
        <h3 className="pipe__name">
          {view.database}.{view.name}
        </h3>
        <span className={`flag flag--${verdict.health === 'flowing' ? 'ok' : verdict.health === 'broken' ? 'firing' : 'idle'}`}>
          {HEALTH_LABEL[verdict.health]}
        </span>
        {view.refreshable ? <span className="flag flag--idle">refreshable</span> : null}
        <span className="panel__spacer" />
        {forcing.kind === 'refresh' ? (
          <button
            className="btn"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending || readonly}
            title={
              readonly
                ? 'Flint is read-only, so it will not refresh a view'
                : 'Tell this view to run now'
            }
          >
            {refresh.isPending ? 'Refreshing…' : 'Refresh now'}
          </button>
        ) : null}
        {forcing.kind === 'backfill' ? (
          <button className="btn" onClick={() => setShowBackfill((s) => !s)}>
            {showBackfill ? 'Hide backfill' : 'How to fill a gap'}
          </button>
        ) : null}
      </header>

      <p className="pipe__says">{verdict.says}</p>

      <p className="pipe__facts">
        {view.target ? (
          <span className="mono-dim">
            → {view.target}
            {view.target_exists ? '' : ' (missing)'}
          </span>
        ) : (
          <span className="mono-dim">→ its own storage</span>
        )}
        <span className="mono-dim">
          {count(view.target_rows)} rows · {bytes(view.target_bytes)}
        </span>
        {view.last_write && !view.last_write.startsWith('1970') ? (
          <span className="mono-dim">last written {relativeTime(view.last_write)}</span>
        ) : null}
        {view.refreshable ? (
          <>
            {view.last_success && !view.last_success.startsWith('1970') ? (
              <span className="mono-dim">last success {relativeTime(view.last_success)}</span>
            ) : null}
            {view.next_refresh && !view.next_refresh.startsWith('1970') ? (
              <span className="mono-dim">next {view.next_refresh.slice(0, 16)}</span>
            ) : null}
          </>
        ) : report.log_available && view.runs > 0 ? (
          <span className="mono-dim">
            {count(view.runs)} run{view.runs === 1 ? '' : 's'} · {count(view.written_rows)} rows
            written · {Math.round(view.avg_ms)} ms
          </span>
        ) : null}
      </p>

      {view.last_error ? <p className="says says--wide says--throw">{view.last_error}</p> : null}
      {refresh.error ? <ErrorNote error={refresh.error} /> : null}

      {showBackfill && forcing.kind === 'backfill' ? (
        <div className="pipe__backfill">
          {/* Written, never run: filling a gap twice double-counts, and only
              the reader knows whether it has already been filled once. */}
          <p className="pipe__warn">
            A classic materialized view has nothing to refresh — it only ever fires on an insert.
            To fill a gap you insert the missing rows yourself. Flint writes the statement and
            stops there: run as-is it recomputes <em>everything</em>, which double-counts what is
            already in the target. Narrow it to the window you are missing first.
          </p>
          <pre className="pipe__sql">{forcing.statement}</pre>
        </div>
      ) : null}
      {forcing.kind === 'none' ? <p className="says says--wide says--watch">{forcing.why}</p> : null}
    </article>
  )
}
