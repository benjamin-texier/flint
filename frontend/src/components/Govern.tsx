import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { api } from '../lib/api'
import { DIMENSIONS, KEYS, accounts, policyProblem, seconds } from '../lib/govern'

/** Everything here goes through one mutation, so every refusal reads the same
 *  way and the same lists go stale afterwards. */
function useGovern(done: () => void) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (change: Record<string, unknown>) => api.govern(change),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['limits'] })
      queryClient.invalidateQueries({ queryKey: ['access'] })
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      done()
    },
  })
}

function Refusal({ error }: { error: unknown }) {
  if (!error) return null
  return (
    <p className="says says--throw">
      {error instanceof Error ? error.message : 'the server refused it'}
    </p>
  )
}

/** Drop one quota, profile or policy.
 *
 *  Each of the three has its own statement, so the caller says which. Giving
 *  access back rather than taking it away, which is why there is no
 *  confirmation: what it undoes is visible in the list it sits in. */
export function Drop({
  what,
  name,
  database,
  table,
}: {
  what: 'quota' | 'profile' | 'policy'
  name: string
  database?: string
  table?: string
}) {
  const act = useGovern(() => {})
  const body =
    what === 'policy'
      ? { action: 'drop-policy', name, database, table }
      : { action: `drop-${what}`, name }
  return (
    <span className="bk__act">
      <button className="btn" disabled={act.isPending} onClick={() => act.mutate(body)}>
        {act.isPending ? 'Dropping…' : 'Drop'}
      </button>
      <Refusal error={act.error} />
    </span>
  )
}

/** A row policy.
 *
 *  The `TO` is required by the form as well as by the backend, so the button can
 *  carry the reason: a policy that names nobody is accepted by ClickHouse and
 *  does nothing at all — every account still sees every row, and nothing reports
 *  it. */
export function NewPolicy({
  done,
  initial,
}: {
  done: () => void
  /* Pre-filled when this is editing rather than making. Changing a policy is one
     statement where dropping and recreating is two, and the table is unprotected
     between them — which for a security control is the whole difference. */
  initial?: {
    name: string
    database: string
    table: string
    filter: string
    to: string
    restrictive: boolean
  }
}) {
  const act = useGovern(done)
  const editing = initial !== undefined
  const [v, setV] = useState(
    initial ?? {
      name: '',
      database: '',
      table: '',
      filter: '',
      to: '',
      restrictive: false,
    },
  )
  const set = (k: string, value: string | boolean) => setV({ ...v, [k]: value })
  const problem = policyProblem(v)

  return (
    <div className="rbac__panel">
      <form
        className="rbac__row"
        onSubmit={(e) => {
          e.preventDefault()
          if (!problem) {
            act.mutate({
              action: editing ? 'alter-policy' : 'create-policy',
              name: v.name.trim(),
              database: v.database.trim(),
              table: v.table.trim(),
              filter: v.filter.trim(),
              restrictive: v.restrictive,
              to: accounts(v.to),
            })
          }
        }}
      >
        {(['name', 'database', 'table'] as const).map((f) => (
          <label className="rbac__field" key={f}>
            <span className="label">{f.toUpperCase()}</span>
            <input value={v[f]} onChange={(e) => set(f, e.target.value)} spellCheck={false} />
          </label>
        ))}
        <label className="rbac__field">
          <span className="label">USING</span>
          <input
            value={v.filter}
            onChange={(e) => set('filter', e.target.value)}
            placeholder="tenant = 'c'"
            spellCheck={false}
          />
        </label>
        <label className="rbac__field">
          <span className="label">FOR</span>
          <input
            value={v.to}
            onChange={(e) => set('to', e.target.value)}
            placeholder="one account, or several"
            spellCheck={false}
          />
        </label>
        <label className="rbac__check">
          <input
            type="checkbox"
            checked={v.restrictive}
            onChange={(e) => set('restrictive', e.target.checked)}
          />
          <span>restrictive</span>
        </label>
        <button className="btn" disabled={!!problem || act.isPending}>
          {act.isPending ? 'Sending…' : editing ? 'Change it' : 'Create it'}
        </button>
      </form>
      {/* Permissive and restrictive compose differently, and the difference is
          not guessable from the word. */}
      <p className="says">
        {v.restrictive
          ? 'Restrictive: it narrows what the permissive policies left, and one standing alone narrows from every row.'
          : 'Permissive: it adds to what the other permissive policies allow. They union, they do not narrow each other.'}
      </p>
      {problem ? <p className="says">{problem}</p> : null}
      <Refusal error={act.error} />
    </div>
  )
}

/** A quota, with its intervals.
 *
 *  Built rather than typed because the grammar does not insist on the comma
 *  between intervals and ClickHouse silently keeps only the last one without it. */
export function NewQuota({
  done,
  initial,
}: {
  done: () => void
  initial?: {
    name: string
    key: string
    to: string
    rows: { window: string; dimension: string; max: string }[]
  }
}) {
  const act = useGovern(done)
  const editing = initial !== undefined
  const [name, setName] = useState(initial?.name ?? '')
  const [key, setKey] = useState<string>(initial?.key ?? 'user_name')
  const [to, setTo] = useState(initial?.to ?? '')
  const [rows, setRows] = useState(
    initial?.rows ?? [{ window: '1m', dimension: 'queries', max: '' }],
  )

  const parsed = rows.map((r) => ({ ...r, secs: seconds(r.window), max: Number(r.max) }))
  const bad =
    !name.trim() ||
    !accounts(to).length ||
    parsed.some((r) => r.secs === null || !Number.isFinite(r.max) || r.max <= 0)

  return (
    <div className="rbac__panel">
      <div className="rbac__row">
        <label className="rbac__field">
          <span className="label">NAME</span>
          <input value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
        </label>
        <label className="rbac__field">
          <span className="label">COUNTED PER</span>
          <select value={key} onChange={(e) => setKey(e.target.value)}>
            {/* Empty is a real choice and the one that surprises: no key means
                one set of counters shared by everyone it applies to. */}
            <option value="">nothing — shared between them all</option>
            {KEYS.map((k) => (
              <option key={k} value={k}>
                {k.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </label>
        <label className="rbac__field">
          <span className="label">FOR</span>
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="one account, or several"
            spellCheck={false}
          />
        </label>
      </div>
      {rows.map((r, i) => (
        <div className="rbac__row" key={i}>
          <label className="rbac__field">
            <span className="label">EVERY</span>
            <input
              value={r.window}
              onChange={(e) => {
                const next = [...rows]
                next[i] = { ...r, window: e.target.value }
                setRows(next)
              }}
              placeholder="1m, 1h, 1d"
              spellCheck={false}
            />
          </label>
          <label className="rbac__field">
            <span className="label">AT MOST</span>
            <input
              value={r.max}
              onChange={(e) => {
                const next = [...rows]
                next[i] = { ...r, max: e.target.value }
                setRows(next)
              }}
              spellCheck={false}
            />
          </label>
          <label className="rbac__field">
            <span className="label">OF</span>
            <select
              value={r.dimension}
              onChange={(e) => {
                const next = [...rows]
                next[i] = { ...r, dimension: e.target.value }
                setRows(next)
              }}
            >
              {DIMENSIONS.map((d) => (
                <option key={d} value={d}>
                  {d.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </label>
          {parsed[i] && parsed[i].secs === null && r.window.trim() ? (
            <span className="says">that is not a window</span>
          ) : null}
        </div>
      ))}
      <p className="rbac__row">
        <button
          className="btn"
          onClick={() => setRows([...rows, { window: '1h', dimension: 'queries', max: '' }])}
        >
          Another ceiling
        </button>
        <button
          className="btn"
          disabled={bad || act.isPending}
          onClick={() =>
            act.mutate({
              action: editing ? 'alter-quota' : 'create-quota',
              name: name.trim(),
              keyed_by: key ? [key] : [],
              // One interval per window, so two ceilings over the same window
              // become one interval with two caps rather than two intervals.
              intervals: groupByWindow(parsed),
              to: accounts(to),
            })
          }
        >
          {act.isPending ? 'Sending…' : editing ? 'Change it' : 'Create it'}
        </button>
      </p>
      {editing ? (
        <p className="says">
          These are all of them. The statement replaces the profile&apos;s settings rather than
          adding to them, so anything removed here is removed from the profile.
        </p>
      ) : null}
      <Refusal error={act.error} />
    </div>
  )
}

/** Ceilings over the same window are one interval with two caps.
 *
 *  Sending them as two intervals of the same length is accepted and then only
 *  one survives — the same shape as the missing comma, arrived at from the
 *  other side. */
function groupByWindow(
  rows: { secs: number | null; dimension: string; max: number }[],
): { duration_secs: number; caps: { dimension: string; max: number }[] }[] {
  const out: { duration_secs: number; caps: { dimension: string; max: number }[] }[] = []
  for (const r of rows) {
    if (r.secs === null) continue
    const found = out.find((i) => i.duration_secs === r.secs)
    const cap = { dimension: r.dimension, max: r.max }
    if (found) found.caps.push(cap)
    else out.push({ duration_secs: r.secs, caps: [cap] })
  }
  return out
}

/** A settings profile.
 *
 *  `READONLY` going out is `writability = CONST` coming back, which is why the
 *  checkbox says what it does rather than repeating either word. */
export function NewProfile({
  done,
  initial,
}: {
  done: () => void
  initial?: {
    name: string
    to: string
    rows: { setting: string; value: string; min: string; max: string; fixed: boolean }[]
  }
}) {
  const act = useGovern(done)
  const editing = initial !== undefined
  const [name, setName] = useState(initial?.name ?? '')
  const [to, setTo] = useState(initial?.to ?? '')
  /* Pre-filled with **every** setting the profile has, because
     `ALTER SETTINGS PROFILE p SETTINGS x = y` replaces the whole list rather
     than amending it — a three-setting profile came back with one. Editing one
     field would otherwise drop the others silently, so the form starts from all
     of them and sends all of them. */
  const [rows, setRows] = useState(
    initial?.rows ?? [{ setting: '', value: '', min: '', max: '', fixed: false }],
  )
  const bad =
    !name.trim() ||
    !accounts(to).length ||
    rows.some((r) => !r.setting.trim() || !r.value.trim())

  return (
    <div className="rbac__panel">
      <div className="rbac__row">
        <label className="rbac__field">
          <span className="label">NAME</span>
          <input value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
        </label>
        <label className="rbac__field">
          <span className="label">FOR</span>
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="one account, or several"
            spellCheck={false}
          />
        </label>
      </div>
      {rows.map((r, i) => (
        <div className="rbac__row" key={i}>
          {(['setting', 'value', 'min', 'max'] as const).map((f) => (
            <label className="rbac__field" key={f}>
              <span className="label">{f === 'min' || f === 'max' ? `${f} (optional)`.toUpperCase() : f.toUpperCase()}</span>
              <input
                value={r[f]}
                onChange={(e) => {
                  const next = [...rows]
                  next[i] = { ...r, [f]: e.target.value }
                  setRows(next)
                }}
                spellCheck={false}
              />
            </label>
          ))}
          <label className="rbac__check">
            <input
              type="checkbox"
              checked={r.fixed}
              onChange={(e) => {
                const next = [...rows]
                next[i] = { ...r, fixed: e.target.checked }
                setRows(next)
              }}
            />
            <span>cannot be changed</span>
          </label>
        </div>
      ))}
      <p className="rbac__row">
        <button
          className="btn"
          onClick={() => setRows([...rows, { setting: '', value: '', min: '', max: '', fixed: false }])}
        >
          Another setting
        </button>
        <button
          className="btn"
          disabled={bad || act.isPending}
          onClick={() =>
            act.mutate({
              action: editing ? 'alter-profile' : 'create-profile',
              name: name.trim(),
              settings: rows.map((r) => ({
                setting: r.setting.trim(),
                value: r.value.trim(),
                min: r.min.trim(),
                max: r.max.trim(),
                fixed: r.fixed,
              })),
              to: accounts(to),
            })
          }
        >
          {act.isPending ? 'Sending…' : editing ? 'Change it' : 'Create it'}
        </button>
      </p>
      {editing ? (
        <p className="says">
          These are all of them. The statement replaces the profile&apos;s settings rather than
          adding to them, so anything removed here is removed from the profile.
        </p>
      ) : null}
      <Refusal error={act.error} />
    </div>
  )
}
