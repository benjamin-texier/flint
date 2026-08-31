import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api, type AppConfig } from '../lib/api'
import { relativeTime } from '../lib/format'
import {
  OPS,
  TONE_LABEL,
  deliveryNote,
  describeAlert,
  describeInterval,
  inSpace,
  intervalChoices,
  parseCondition,
  problemWith,
  STANDING_SAYS,
  saysElsewhere,
  selected,
  type Standing,
  serialiseCondition,
  toneOf,
  type Alert,
  type Metric,
  type Op,
} from '../lib/alert'
import { EmptyNote, ErrorNote, Loading } from '../components/Note'
import { CheckPanel } from '../components/CheckPanel'
import { readHandoff, suggestName, type Handoff } from '../lib/handoff'
import { keeps } from '../lib/spaces'

/** Alerts: a question asked on a schedule.
 *
 *  The page is deliberately one screen — the list, and one form. An alert has
 *  four moving parts and every extra step between writing it and arming it is a
 *  step where the thing you meant to be watched goes unwatched. */
export function AlertsPage() {
  const config = useQuery({ queryKey: ['config'], queryFn: () => api.config() })
  /* Not asked without a workspace: both live in it, and the refusal rendered as
     an error under the page's own account of why there is nothing here. */
  const stateful = keeps(config.data)
  const alerts = useQuery({
    queryKey: ['alerts'],
    queryFn: () => api.alerts(),
    enabled: stateful,
    retry: false,
  })
  const events = useQuery({
    queryKey: ['alert-events'],
    queryFn: () => api.alertEvents(undefined, 50),
    enabled: stateful,
    retry: false,
    refetchInterval: 20_000,
  })
  /* Listed where its subject lives, not where its author sits: an alert on
     `system.replicas` belongs beside the replicas even when an analyst wrote
     it, and one on `orders` belongs here even when an operator did. What cannot
     be placed appears in both lists rather than in neither. */
  /* What the rail beside this page has selected. The rail owns the filter and
     the URL owns the rail, so a link to "the two that are firing" is a link
     somebody can send — and the counts and the list cannot drift, because both
     read the same rule. */
  const [params, setParams] = useSearchParams()
  const here = inSpace(alerts.data ?? [], 'data')
  const state = params.get('state')
  const mine = selected(here, state)
  /* Clearing from the page rather than only from the rail: a reader who arrived
     on a link to "the ones that cannot run" has the rail's own row to toggle,
     but the sentence that told them about the fold should be able to undo it. */
  const clearFilter = () => {
    const next = new URLSearchParams(params)
    next.delete('state')
    setParams(next, { replace: true })
  }
  const elsewhere = saysElsewhere(alerts.data ?? [], 'data')
  const [editing, setEditing] = useState<Alert | null>(null)
  const [adding, setAdding] = useState(false)
  /* A statement handed over by the editor. Consumed once and cleared from the
     URL, so a reload does not reopen a form the reader already dismissed. */
  const [handoff, setHandoff] = useState<Handoff | null>(() => readHandoff(params))
  useEffect(() => {
    if (readHandoff(params)) {
      setAdding(true)
      setParams(new URLSearchParams(), { replace: true })
    }
  }, [params, setParams])

  const stateless = config.data?.workspace === null

  return (
    <div className="page page--alerts">
      <header className="page__head">
        <p className="eyebrow">ALERTS</p>
        <div className="page__titlerow">
          <h1 className="page__title page__title--hero">Watched for you</h1>
          {!stateless ? (
            <div className="page__actions">
              <button
                className="btn btn--spark"
                onClick={() => {
                  setEditing(null)
                  setAdding(true)
                }}
              >
                New alert
              </button>
            </div>
          ) : null}
        </div>
        <p className="page__lead">
          A statement, a condition, and how often to ask. Flint runs it in the background and
          records every change — read-only, always, whatever the rest of this Flint is allowed to
          do.
        </p>
      </header>

      {stateless ? (
        <EmptyNote title="Alerts need somewhere to live">
          Flint is running without a workspace, so it has nowhere to keep an alert or its
          history. Set `FLINT_WORKSPACE_DATABASE` to a database it may write to.
        </EmptyNote>
      ) : null}

      {alerts.isPending && !stateless ? <Loading label="Reading alerts" /> : null}
      {alerts.error ? <ErrorNote error={alerts.error} retry={() => alerts.refetch()} /> : null}

      {adding || editing ? (
        <AlertForm
          config={config.data}
          existing={editing}
          handoff={editing ? null : handoff}
          onDone={() => {
            setAdding(false)
            setEditing(null)
            setHandoff(null)
          }}
        />
      ) : null}

      {mine.length ? (
        <>
          {/* The count of what this page is not showing, in the words of the
              space that has them. A list quietly holding back half its rows
              reads as the whole truth, and an alert nobody can find is an alert
              nobody trusts. */}
          {elsewhere ? <p className="diag__quiet">{elsewhere}</p> : null}
          {/* And the count of what the rail's filter is holding back. A fold
              that does not state its own size reads as the whole list. */}
          {state ? (
            <p className="diag__quiet">
              Showing the {mine.length} of {here.length} that{' '}
              {STANDING_SAYS[state as Standing] ?? 'match'}.{' '}
              <button className="linkish" onClick={() => clearFilter()}>
                Show all {here.length}
              </button>
            </p>
          ) : null}
          <ul className="alist">
            {mine.map((alert) => (
              <AlertRow
                key={alert.id}
                alert={alert}
                webhooksAllowed={config.data?.alert_webhooks ?? true}
                onEdit={() => {
                  setAdding(false)
                  setEditing(alert)
                }}
              />
            ))}
          </ul>
        </>
      ) : state && here.length ? (
        /* Empty because of the fold, not because nothing is watched. Telling a
           reader who filtered to "firing" that they have written no alerts is
           the one sentence that is certainly wrong here — and the good news,
           that none are in that state, is the answer they came for. */
        <EmptyNote title={`None of your ${here.length} alerts ${STANDING_SAYS[state as Standing] ?? 'match'}`}>
          <button className="linkish" onClick={clearFilter}>
            Show all {here.length}
          </button>
        </EmptyNote>
      ) : alerts.data && !adding ? (
        <EmptyNote title="Nothing is being watched">
          Write a statement that finds the thing you would want to hear about — errors in the
          last hour, a queue that stopped moving — and Flint will keep asking.
        </EmptyNote>
      ) : null}

      {events.data?.length ? (
        <section className="diag">
          <header className="diag__head">
            <h2 className="diag__title">What has happened</h2>
            <p className="diag__sub">
              Only changes are recorded: a condition that stays true is one line, not one per
              check.
            </p>
          </header>
          <table className="tbl">
            <thead>
              <tr>
                <th>When</th>
                <th>Alert</th>
                <th>State</th>
                <th>Measured</th>
                <th>Delivery</th>
              </tr>
            </thead>
            <tbody>
              {events.data.map((e, i) => (
                <tr key={`${e.alert_id}-${e.at}-${i}`}>
                  <td className="mono-dim">{relativeTime(e.at)}</td>
                  <td className="tbl__key">{e.alert}</td>
                  <td>
                    <Tone state={e.state} />
                  </td>
                  <td className="tbl--n mono-dim">
                    {e.value === null ? <span className="dash">—</span> : e.value}
                  </td>
                  <td>
                    {e.delivered ? (
                      <span className="mono-dim">sent</span>
                    ) : (
                      <span className="says says--watch">{e.delivery_error || 'not sent'}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  )
}

function Tone({ state }: { state: string }) {
  const tone = toneOf(state)
  /* An alert's `ok` is "Recovered" — a change out of firing, which is news and
     earns the green. The product's other `ok`, a verdict that is simply fine,
     shares neither the meaning nor the chip. */
  return (
    <span className={`flag flag--${tone === 'ok' ? 'good' : tone}`}>{TONE_LABEL[tone]}</span>
  )
}

function AlertRow({
  alert,
  webhooksAllowed,
  onEdit,
}: {
  alert: Alert
  webhooksAllowed: boolean
  onEdit: () => void
}) {
  const client = useQueryClient()
  const condition = parseCondition(alert.condition)
  const note = deliveryNote(alert, webhooksAllowed)

  const remove = useMutation({
    mutationFn: () => api.deleteAlert(alert.id),
    onSuccess: () => client.invalidateQueries({ queryKey: ['alerts'] }),
  })
  const toggle = useMutation({
    mutationFn: () =>
      api.saveAlert({
        id: alert.id,
        name: alert.name,
        sql: alert.sql,
        database: alert.database,
        condition: alert.condition,
        interval_seconds: alert.interval_seconds,
        webhook: alert.webhook,
        enabled: !alert.enabled,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['alerts'] }),
  })

  return (
    <li className={`arow${alert.enabled ? '' : ' arow--off'}`}>
      <div className="arow__head">
        <h3 className="arow__name">{alert.name}</h3>
        <Tone state={alert.state} />
        {!alert.enabled ? <span className="flag flag--paused">Paused</span> : null}
        <span className="panel__spacer" />
        <button className="btn" onClick={() => toggle.mutate()} disabled={toggle.isPending}>
          {alert.enabled ? 'Pause' : 'Resume'}
        </button>
        <button className="btn" onClick={onEdit}>
          Edit
        </button>
        <button className="btn" onClick={() => remove.mutate()} disabled={remove.isPending}>
          Delete
        </button>
      </div>

      {/* The sentence, not the three fields: a condition that says the opposite
          of what was meant is invisible in dropdowns and obvious in English. */}
      <p className="arow__says">
        {condition ? (
          describeAlert(condition, alert.interval_seconds)
        ) : (
          <span className="says says--throw">
            This alert's condition cannot be read, so it will never fire. Edit it to set one.
          </span>
        )}
      </p>

      <pre className="arow__sql">{alert.sql}</pre>

      <p className="arow__foot">
        {alert.database ? <span className="mono-dim">{alert.database}</span> : null}
        {alert.last_event ? (
          <span className="mono-dim">last change {relativeTime(alert.last_event)}</span>
        ) : (
          <span className="mono-dim">nothing to report yet</span>
        )}
        {note ? <span className="says says--watch">{note}</span> : null}
      </p>
      {alert.last_message ? <p className="arow__last">{alert.last_message}</p> : null}
    </li>
  )
}

function AlertForm({
  config,
  existing,
  handoff,
  onDone,
}: {
  config: AppConfig | undefined
  existing: Alert | null
  /** A statement the editor sent over, when that is how we got here. */
  handoff: Handoff | null
  onDone: () => void
}) {
  const client = useQueryClient()
  const parsed = existing ? parseCondition(existing.condition) : null

  const [name, setName] = useState(
    existing?.name ?? (handoff ? suggestName(handoff, '') : ''),
  )
  const [sql, setSql] = useState(existing?.sql ?? handoff?.sql ?? '')
  const [database, setDatabase] = useState(
    existing?.database ?? handoff?.database ?? config?.default_database ?? '',
  )
  const [metric, setMetric] = useState<Metric>(parsed?.metric ?? 'rows')
  const [op, setOp] = useState<Op>(parsed?.op ?? '>')
  const [threshold, setThreshold] = useState(String(parsed?.threshold ?? 0))
  const [interval, setInterval] = useState(existing?.interval_seconds ?? 300)
  const [webhook, setWebhook] = useState(existing?.webhook ?? '')

  const problem = problemWith({ name, sql, threshold })
  const condition = { metric, op, threshold: Number(threshold) }

  const save = useMutation({
    mutationFn: () =>
      api.saveAlert({
        id: existing?.id,
        name,
        sql,
        database,
        condition: serialiseCondition(condition),
        interval_seconds: interval,
        webhook,
        enabled: existing?.enabled ?? true,
      }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['alerts'] })
      onDone()
    },
  })

  return (
    <section className="aform">
      <header className="aform__head">
        <h2 className="diag__title">{existing ? 'Edit this alert' : 'A new alert'}</h2>
      </header>

      <label className="aform__field">
        <span className="label">NAME</span>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Errors in the last hour"
        />
      </label>

      <label className="aform__field">
        <span className="label">STATEMENT</span>
        <textarea
          className="input input--area"
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          rows={4}
          spellCheck={false}
          placeholder="SELECT count() FROM events WHERE status = 'error' AND ts > now() - INTERVAL 1 HOUR"
        />
      </label>

      <div className="aform__row">
        <label className="aform__field aform__field--narrow">
          <span className="label">DATABASE</span>
          <input
            className="input"
            value={database}
            onChange={(e) => setDatabase(e.target.value)}
            placeholder="default"
          />
        </label>

        <label className="aform__field aform__field--narrow">
          <span className="label">NOTIFY WHEN</span>
          <select
            className="input"
            value={metric}
            onChange={(e) => setMetric(e.target.value as Metric)}
          >
            <option value="rows">the number of rows</option>
            <option value="value">the first value</option>
          </select>
        </label>

        <label className="aform__field aform__field--tiny">
          <span className="label">IS</span>
          <select className="input" value={op} onChange={(e) => setOp(e.target.value as Op)}>
            {OPS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>

        <label className="aform__field aform__field--tiny">
          <span className="label">THRESHOLD</span>
          <input
            className="input"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            inputMode="decimal"
          />
        </label>

        <label className="aform__field aform__field--narrow">
          <span className="label">CHECK EVERY</span>
          <select
            className="input"
            value={interval}
            onChange={(e) => setInterval(Number(e.target.value))}
          >
            {intervalChoices(interval).map((s) => (
              <option key={s} value={s}>
                {describeInterval(s)}
              </option>
            ))}
          </select>
        </label>
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

      {/* Read it back before arming it — and run it before arming it. */}
      <p className="aform__says">{describeAlert(condition, interval)}</p>
      <CheckPanel
        sql={sql}
        database={database}
        condition={serialiseCondition(condition)}
        label="What would this do right now?"
      />
      {webhook.trim() && config && !config.alert_webhooks ? (
        <p className="says says--wide says--watch">
          Webhook delivery is switched off on this Flint, so this alert will record its changes
          but send nothing.
        </p>
      ) : null}
      {!webhook.trim() ? (
        <p className="aform__hint">
          With no webhook the alert still runs and still keeps its history — that is a perfectly
          good place for it to live.
        </p>
      ) : null}

      {problem ? <p className="says says--wide says--watch">{problem}</p> : null}
      {save.error ? <ErrorNote error={save.error} /> : null}

      <div className="aform__actions">
        <button
          className="btn btn--spark"
          disabled={!!problem || save.isPending}
          onClick={() => save.mutate()}
        >
          {existing ? 'Save changes' : 'Start watching'}
        </button>
        <button className="btn" onClick={onDone}>
          Cancel
        </button>
      </div>
    </section>
  )
}
