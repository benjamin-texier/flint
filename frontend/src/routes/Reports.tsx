import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../lib/api'
import { relativeTime } from '../lib/format'
import {
  DAYS,
  EVERY_HOURS,
  STATUS_LABEL,
  STATUS_TONE,
  asResult,
  clockOf,
  describeSchedule,
  minuteOf,
  parseSchedule,
  parseSections,
  problemWithReport,
  sectionsFromDashboard,
  serialiseSchedule,
  statusOf,
  type Report,
  type Schedule,
  type Section,
} from '../lib/report'
import { parseSpec } from '../lib/dashboard'
import { Chart } from '../components/Chart'
import { ResultsGrid } from '../components/ResultsGrid'
import { EmptyNote, ErrorNote, Loading } from '../components/Note'
import { CheckPanel } from '../components/CheckPanel'
import { readHandoff, suggestName, type Handoff } from '../lib/handoff'

/** Reports: what the numbers were, kept.
 *
 *  The page is built around the distinction that justifies the feature — a
 *  dashboard shows now, a report keeps then — so the runs are as prominent as
 *  the definitions, and opening one shows what it found at the time rather than
 *  re-running anything. */
export function ReportsPage() {
  const config = useQuery({ queryKey: ['config'], queryFn: () => api.config() })
  const server = useQuery({ queryKey: ['server'], queryFn: () => api.server() })
  const reports = useQuery({ queryKey: ['reports'], queryFn: () => api.reports(), retry: false })
  const runs = useQuery({
    queryKey: ['report-runs'],
    queryFn: () => api.reportRuns(undefined, 20),
    retry: false,
    refetchInterval: 30_000,
  })
  const [editing, setEditing] = useState<Report | null>(null)
  const [adding, setAdding] = useState(false)
  const [openRun, setOpenRun] = useState<string | null>(null)
  const [params, setParams] = useSearchParams()
  const [handoff, setHandoff] = useState<Handoff | null>(() => readHandoff(params))
  /* A whole dashboard, offered as a report. Held by id rather than carried in
     the URL: the spec is the dashboard's own and can be read where it lives. */
  const [fromDashboard, setFromDashboard] = useState<string | null>(() =>
    params.get('from_dashboard'),
  )
  const dashboards = useQuery({
    queryKey: ['dashboards'],
    queryFn: () => api.dashboards(),
    enabled: Boolean(fromDashboard),
    retry: false,
  })
  const source = fromDashboard
    ? dashboards.data?.find((d) => d.id === fromDashboard)
    : undefined
  const seeded = useMemo(() => {
    if (!source) return null
    const spec = parseSpec(source.spec)
    return { name: source.name, sections: sectionsFromDashboard(spec.tiles) }
  }, [source])

  /* A plain handoff can open at once — it is already in hand. A dashboard has
     to be fetched first: opening the form before it arrives gives an empty one
     whose save button is disabled, which is what navigating straight to the
     link used to do. */
  useEffect(() => {
    if (readHandoff(params)) {
      setAdding(true)
      setParams(new URLSearchParams(), { replace: true })
    }
  }, [params, setParams])
  useEffect(() => {
    if (!params.get('from_dashboard') || !dashboards.isSuccess) return
    setAdding(true)
    setParams(new URLSearchParams(), { replace: true })
  }, [params, setParams, dashboards.isSuccess])

  const stateless = config.data?.workspace === null
  const timezone = server.data?.timezone

  return (
    <div className="page page--reports">
      <header className="page__head">
        <p className="eyebrow">REPORTS</p>
        <div className="page__titlerow">
          <h1 className="page__title page__title--hero">What the numbers were</h1>
          {!stateless ? (
            <button
              className="btn btn--spark"
              onClick={() => {
                setEditing(null)
                setAdding(true)
              }}
            >
              New report
            </button>
          ) : null}
        </div>
        <p className="page__lead">
          A dashboard shows you now. A report runs on a schedule and keeps what it found, so
          "what did this look like three weeks ago" has an answer. Each run is a snapshot —
          opening one shows the numbers as they were, not as they are.
        </p>
      </header>

      {stateless ? (
        <EmptyNote title="Reports need somewhere to live">
          Flint is running without a workspace, so it has nowhere to keep a report or its
          snapshots. Set `FLINT_WORKSPACE_DATABASE` to a database it may write to.
        </EmptyNote>
      ) : null}

      {reports.isPending && !stateless ? <Loading label="Reading reports" /> : null}
      {reports.error ? <ErrorNote error={reports.error} retry={() => reports.refetch()} /> : null}

      {adding || editing ? (
        <ReportForm
          existing={editing}
          handoff={editing ? null : handoff}
          seeded={editing ? null : seeded}
          timezone={timezone}
          defaultDatabase={config.data?.default_database ?? ''}
          webhooksAllowed={config.data?.alert_webhooks ?? true}
          onDone={() => {
            setAdding(false)
            setEditing(null)
            setHandoff(null)
            setFromDashboard(null)
          }}
        />
      ) : null}

      {fromDashboard && dashboards.data && !source ? (
        <EmptyNote title="That dashboard is gone">
          Nothing here has that id any more, so there is nothing to build a report from.
        </EmptyNote>
      ) : null}

      {reports.data?.length ? (
        <ul className="alist">
          {reports.data.map((report) => (
            <ReportRow
              key={report.id}
              report={report}
              timezone={timezone}
              onEdit={() => {
                setAdding(false)
                setEditing(report)
              }}
            />
          ))}
        </ul>
      ) : reports.data && !adding ? (
        <EmptyNote title="Nothing is being kept">
          Write the statements you would want a record of — last week's totals, the month's
          errors — and Flint will run them on a schedule and keep each answer.
        </EmptyNote>
      ) : null}

      {runs.data?.length ? (
        <section className="diag">
          <header className="diag__head">
            <h2 className="diag__title">Editions</h2>
            <p className="diag__sub">
              Every run that has been kept. Snapshots are held for six months, and each section
              keeps up to 500 rows.
            </p>
          </header>
          <table className="tbl">
            <thead>
              <tr>
                <th>When</th>
                <th>Report</th>
                <th>Result</th>
                <th className="tbl--n">Sections</th>
                <th>Delivery</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {runs.data.map((run) => (
                <tr key={run.run_id}>
                  <td className="mono-dim">{relativeTime(run.at)}</td>
                  <td className="tbl__key">{run.report}</td>
                  <td>
                    <Status status={run.status} />
                    {run.error ? <span className="says says--watch">{run.error}</span> : null}
                  </td>
                  <td className="tbl--n">{run.sections}</td>
                  <td>
                    {run.delivered ? (
                      <span className="mono-dim">sent</span>
                    ) : (
                      <span className="says says--watch">
                        {run.delivery_error || 'not sent'}
                      </span>
                    )}
                  </td>
                  <td>
                    <button className="btn" onClick={() => setOpenRun(run.run_id)}>
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {openRun ? <SnapshotView runId={openRun} onClose={() => setOpenRun(null)} /> : null}
    </div>
  )
}

function Status({ status }: { status: string }) {
  const s = statusOf(status)
  return <span className={`flag flag--${STATUS_TONE[s]}`}>{STATUS_LABEL[s]}</span>
}

function ReportRow({
  report,
  timezone,
  onEdit,
}: {
  report: Report
  timezone: string | undefined
  onEdit: () => void
}) {
  const client = useQueryClient()
  const schedule = parseSchedule(report.schedule)
  const sections = useMemo(() => {
    try {
      const spec = JSON.parse(report.spec) as { sections?: Section[] }
      return spec.sections ?? []
    } catch {
      return []
    }
  }, [report.spec])

  const remove = useMutation({
    mutationFn: () => api.deleteReport(report.id),
    onSuccess: () => client.invalidateQueries({ queryKey: ['reports'] }),
  })
  const toggle = useMutation({
    mutationFn: () =>
      api.saveReport({
        id: report.id,
        name: report.name,
        spec: report.spec,
        schedule: report.schedule,
        webhook: report.webhook,
        enabled: !report.enabled,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['reports'] }),
  })

  return (
    <li className={`arow${report.enabled ? '' : ' arow--off'}`}>
      <div className="arow__head">
        <h3 className="arow__name">{report.name}</h3>
        <Status status={report.last_status} />
        {!report.enabled ? <span className="flag flag--idle">Paused</span> : null}
        <span className="panel__spacer" />
        <button className="btn" onClick={() => toggle.mutate()} disabled={toggle.isPending}>
          {report.enabled ? 'Pause' : 'Resume'}
        </button>
        <button className="btn" onClick={onEdit}>
          Edit
        </button>
        <button className="btn" onClick={() => remove.mutate()} disabled={remove.isPending}>
          Delete
        </button>
      </div>

      <p className="arow__says">
        {schedule ? (
          describeSchedule(schedule, timezone)
        ) : (
          <span className="says says--throw">
            This report's schedule cannot be read, so it will never run. Edit it to set one.
          </span>
        )}
      </p>

      <ol className="rsections">
        {sections.map((s, i) => (
          <li key={i} className="rsections__item">
            <span className="rsections__title">{s.title || `Section ${i + 1}`}</span>
            <code className="rsections__sql">{s.sql.replace(/\s+/g, ' ').trim()}</code>
          </li>
        ))}
      </ol>

      <p className="arow__foot">
        <span className="mono-dim">
          {report.runs ? `${report.runs} edition${report.runs === 1 ? '' : 's'} kept` : 'no editions yet'}
        </span>
        {report.last_run ? (
          <span className="mono-dim">last ran {relativeTime(report.last_run)}</span>
        ) : null}
      </p>
    </li>
  )
}

/** One kept edition, rendered through the same table and chart components a
 *  live result uses — so a snapshot never looks like a lesser thing. */
function SnapshotView({ runId, onClose }: { runId: string; onClose: () => void }) {
  const snapshot = useQuery({
    queryKey: ['report-snapshot', runId],
    queryFn: () => api.reportSnapshot(runId),
  })
  const sections = useMemo(
    () => (snapshot.data ? parseSections(snapshot.data.sections) : []),
    [snapshot.data],
  )

  return (
    <section className="snap">
      <header className="snap__head">
        <div>
          <p className="eyebrow">EDITION</p>
          <h2 className="snap__title">{snapshot.data?.report ?? 'Loading'}</h2>
          {snapshot.data ? (
            <p className="snap__when">
              as it was on {snapshot.data.at.slice(0, 19)} · <Status status={snapshot.data.status} />
            </p>
          ) : null}
        </div>
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </header>

      {snapshot.isPending ? <Loading label="Reading the snapshot" /> : null}
      {snapshot.error ? <ErrorNote error={snapshot.error} /> : null}

      {sections.map((section, i) => (
        <article className="snap__section" key={i}>
          <header className="snap__sectionhead">
            <h3 className="diag__title">{section.title || `Section ${i + 1}`}</h3>
            {section.truncated ? (
              <span className="flag flag--idle">first 500 rows</span>
            ) : null}
          </header>

          {section.error ? (
            <EmptyNote title="This section could not run">{section.error}</EmptyNote>
          ) : (
            <>
              {/* The chart the report was defined with, drawn from the stored
                  rows. No re-query: the point is what it was. */}
              {section.chart ? (
                <Chart result={asResult(section) as never} spec={section.chart} />
              ) : null}
              {/* The grid is windowed and expects a bounded parent. Without one
                  a 500-row section renders six thousand pixels tall and the
                  windowing buys nothing. */}
              <div className="snap__grid">
                <ResultsGrid result={asResult(section) as never} />
              </div>
            </>
          )}
        </article>
      ))}
    </section>
  )
}

function ReportForm({
  existing,
  handoff,
  seeded,
  timezone,
  defaultDatabase,
  webhooksAllowed,
  onDone,
}: {
  existing: Report | null
  /** A statement the editor sent over: it becomes the first section. */
  handoff: Handoff | null
  /** A whole dashboard offered as a report: its tiles become the sections. */
  seeded: { name: string; sections: Section[] } | null
  timezone: string | undefined
  defaultDatabase: string
  webhooksAllowed: boolean
  onDone: () => void
}) {
  const client = useQueryClient()
  const parsedSchedule = existing ? parseSchedule(existing.schedule) : null
  const parsedSections: Section[] = useMemo(() => {
    if (seeded?.sections.length) return seeded.sections
    if (!existing) {
      return [
        {
          title: handoff ? suggestName(handoff, '') : '',
          sql: handoff?.sql ?? '',
          database: handoff?.database || defaultDatabase,
        },
      ]
    }
    try {
      const spec = JSON.parse(existing.spec) as { sections?: Section[] }
      return spec.sections?.length ? spec.sections : [{ title: '', sql: '', database: defaultDatabase }]
    } catch {
      return [{ title: '', sql: '', database: defaultDatabase }]
    }
  }, [existing, defaultDatabase, handoff, seeded])

  const [name, setName] = useState(
    existing?.name ?? seeded?.name ?? (handoff ? suggestName(handoff, '') : ''),
  )
  const [sections, setSections] = useState<Section[]>(parsedSections)
  const [kind, setKind] = useState<Schedule['kind']>(parsedSchedule?.kind ?? 'daily')
  const [hours, setHours] = useState(
    parsedSchedule?.kind === 'every' ? parsedSchedule.hours : 6,
  )
  const [dow, setDow] = useState(parsedSchedule?.kind === 'weekly' ? parsedSchedule.dow : 1)
  const [time, setTime] = useState(
    clockOf(
      parsedSchedule && parsedSchedule.kind !== 'every' ? parsedSchedule.minute : 540,
    ),
  )
  const [webhook, setWebhook] = useState(existing?.webhook ?? '')

  const minute = minuteOf(time)
  const schedule: Schedule | null =
    kind === 'every'
      ? { kind: 'every', hours }
      : minute === null
        ? null
        : kind === 'daily'
          ? { kind: 'daily', minute }
          : { kind: 'weekly', dow, minute }

  const problem = problemWithReport({ name, sections }) ?? (schedule ? null : 'That is not a time of day.')

  const save = useMutation({
    mutationFn: () =>
      api.saveReport({
        id: existing?.id,
        name,
        spec: JSON.stringify({ sections: sections.filter((s) => s.sql.trim()) }),
        schedule: serialiseSchedule(schedule!),
        webhook,
        enabled: existing?.enabled ?? true,
      }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['reports'] })
      onDone()
    },
  })

  const patch = (i: number, change: Partial<Section>) =>
    setSections((list) => list.map((s, j) => (i === j ? { ...s, ...change } : s)))

  return (
    <section className="aform">
      <header className="aform__head">
        <h2 className="diag__title">{existing ? 'Edit this report' : 'A new report'}</h2>
      </header>

      <label className="aform__field">
        <span className="label">NAME</span>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Monday morning numbers"
        />
      </label>

      {sections.map((section, i) => (
        <div className="rform__section" key={i}>
          <div className="rform__sectionhead">
            <span className="label">SECTION {i + 1}</span>
            {sections.length > 1 ? (
              <button
                className="btn"
                onClick={() => setSections((list) => list.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            ) : null}
          </div>
          <input
            className="input"
            value={section.title}
            onChange={(e) => patch(i, { title: e.target.value })}
            placeholder="Errors by day"
          />
          <textarea
            className="input input--area"
            value={section.sql}
            onChange={(e) => patch(i, { sql: e.target.value })}
            rows={3}
            spellCheck={false}
            placeholder="SELECT toDate(ts) AS day, count() FROM events GROUP BY day ORDER BY day"
          />
          <input
            className="input"
            value={section.database}
            onChange={(e) => patch(i, { database: e.target.value })}
            placeholder="database"
          />
          {/* Per section: each one is its own statement, and a report that runs
              with gaps is a report whose gaps were never tested. */}
          <CheckPanel sql={section.sql} database={section.database} />
        </div>
      ))}

      <button
        className="btn"
        onClick={() =>
          setSections((list) => [...list, { title: '', sql: '', database: defaultDatabase }])
        }
      >
        Add a section
      </button>

      <div className="aform__row">
        <label className="aform__field aform__field--narrow">
          <span className="label">RUNS</span>
          <select
            className="input"
            value={kind}
            onChange={(e) => setKind(e.target.value as Schedule['kind'])}
          >
            <option value="daily">every day</option>
            <option value="weekly">every week</option>
            <option value="every">on an interval</option>
          </select>
        </label>

        {kind === 'weekly' ? (
          <label className="aform__field aform__field--narrow">
            <span className="label">ON</span>
            <select className="input" value={dow} onChange={(e) => setDow(Number(e.target.value))}>
              {DAYS.map((d, i) => (
                <option key={d} value={i + 1}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {kind === 'every' ? (
          <label className="aform__field aform__field--narrow">
            <span className="label">EVERY</span>
            <select
              className="input"
              value={hours}
              onChange={(e) => setHours(Number(e.target.value))}
            >
              {EVERY_HOURS.map((h) => (
                <option key={h} value={h}>
                  {h === 1 ? 'hour' : `${h} hours`}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="aform__field aform__field--tiny">
            <span className="label">AT</span>
            <input
              className="input"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              placeholder="09:00"
            />
          </label>
        )}
      </div>

      <label className="aform__field">
        <span className="label">WEBHOOK (OPTIONAL)</span>
        <input
          className="input"
          value={webhook}
          onChange={(e) => setWebhook(e.target.value)}
          placeholder="https://hooks.example.com/…"
        />
      </label>

      <p className="aform__says">
        {schedule ? describeSchedule(schedule, timezone) : 'That is not a time of day.'}
      </p>
      <p className="aform__hint">
        {/* Both caveats up front: the schedule is the server's clock, and the
            webhook says a report ran rather than carrying it. */}
        Times are ClickHouse's own timezone{timezone ? ` (${timezone})` : ''}. A webhook is told
        that the report ran and how it went — the snapshot itself stays here, where it can be
        read.
      </p>
      {webhook.trim() && !webhooksAllowed ? (
        <p className="says says--watch">
          Webhook delivery is switched off on this Flint, so this will be recorded but not sent.
        </p>
      ) : null}

      {problem ? <p className="says says--watch">{problem}</p> : null}
      {save.error ? <ErrorNote error={save.error} /> : null}

      <div className="aform__actions">
        <button
          className="btn btn--spark"
          disabled={!!problem || save.isPending}
          onClick={() => save.mutate()}
        >
          {existing ? 'Save changes' : 'Start keeping it'}
        </button>
        <button className="btn" onClick={onDone}>
          Cancel
        </button>
      </div>
    </section>
  )
}
