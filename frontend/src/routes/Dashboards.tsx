import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { api, type QueryResult } from '../lib/api'
import {
  COLUMNS,
  REFRESH_CHOICES,
  WIDTHS,
  emptySpec,
  moveTile,
  parseSpec,
  patchTile,
  removeTile,
  serialiseSpec,
  type DashboardSpec,
  type Tile,
} from '../lib/dashboard'
import { relativeTime } from '../lib/format'
import { Chart } from '../components/Chart'
import { ResultsGrid } from '../components/ResultsGrid'
import { EmptyNote, ErrorNote, Loading } from '../components/Note'

/** The list of dashboards, and the way to make one. */
export function DashboardList() {
  const client = useQueryClient()
  const navigate = useNavigate()
  const config = useQuery({ queryKey: ['config'], queryFn: api.config })
  const workspace = config.data?.workspace ?? null
  const [name, setName] = useState('')

  const dashboards = useQuery({
    queryKey: ['dashboards'],
    queryFn: api.dashboards,
    enabled: Boolean(workspace),
  })
  const create = useMutation({
    mutationFn: () => api.saveDashboard({ name: name.trim(), spec: serialiseSpec(emptySpec()) }),
    onSuccess: (d) => {
      setName('')
      client.invalidateQueries({ queryKey: ['dashboards'] })
      navigate(`/dash/${d.id}`)
    },
  })
  const remove = useMutation({
    mutationFn: api.deleteDashboard,
    onSuccess: () => client.invalidateQueries({ queryKey: ['dashboards'] }),
  })

  if (!workspace) {
    return (
      <article className="page">
        <header className="page__head">
          <p className="eyebrow">Dashboards</p>
          <h1 className="page__title page__title--hero">Nothing to keep them in</h1>
        </header>
        <EmptyNote title="Flint is running without a workspace">
          A dashboard has to be stored somewhere, and Flint will not create anything uninvited.
          Set <code>FLINT_WORKSPACE_DATABASE</code> to a database it may write to and restart.
          Only Flint's own metadata goes there — your tables are untouched.
        </EmptyNote>
      </article>
    )
  }

  return (
    <article className="page">
      <header className="page__head">
        <p className="eyebrow">Dashboards</p>
        <h1 className="page__title page__title--hero">Dashboards</h1>
        <p className="page__lead">
          Each tile is a query and a chart. Build one from the editor — run something, pick a
          form, then add it here.
        </p>
      </header>

      <div className="saveform saveform--bare">
        <input
          className="frame__input saveform__name"
          value={name}
          placeholder="Name a new dashboard"
          aria-label="Name for the new dashboard"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && name.trim()) create.mutate()
          }}
        />
        <button
          className="btn btn--spark"
          disabled={!name.trim() || create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? 'Creating…' : 'Create'}
        </button>
      </div>
      {create.error ? <ErrorNote error={create.error} /> : null}

      <section className="section">
        {dashboards.isPending ? <Loading label="Reading dashboards" /> : null}
        {dashboards.error ? (
          <ErrorNote error={dashboards.error} retry={() => dashboards.refetch()} />
        ) : null}
        {dashboards.data?.length === 0 ? (
          <EmptyNote title="No dashboards yet">Name one above to get started.</EmptyNote>
        ) : null}
        {dashboards.data && dashboards.data.length > 0 ? (
          <div className="panel">
            <div className="panel__scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th className="tbl--n">Tiles</th>
                    <th>Updated</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {dashboards.data.map((d) => (
                    <tr key={d.id}>
                      <td className="tbl__key">
                        <Link className="link" to={`/dash/${d.id}`}>
                          {d.name}
                        </Link>
                      </td>
                      <td className="tbl--n">{parseSpec(d.spec).tiles.length}</td>
                      <td className="mono-dim">{relativeTime(d.updated_at)}</td>
                      <td className="tbl--n">
                        <button
                          className="savedrow__act savedrow__act--del"
                          title={`Delete ${d.name}`}
                          onClick={() => remove.mutate(d.id)}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
        {remove.error ? <ErrorNote error={remove.error} /> : null}
      </section>
    </article>
  )
}

/** One dashboard: a twelve-column grid of tiles, each running its own query. */
export function DashboardView() {
  const { id } = useParams()
  const client = useQueryClient()
  const dashboards = useQuery({ queryKey: ['dashboards'], queryFn: api.dashboards })
  const dashboard = dashboards.data?.find((d) => d.id === id)

  const [draft, setDraft] = useState<DashboardSpec | null>(null)
  const [editing, setEditing] = useState(false)
  // The stored spec is the source of truth until an edit starts.
  const spec = draft ?? (dashboard ? parseSpec(dashboard.spec) : emptySpec())

  const save = useMutation({
    mutationFn: (next: DashboardSpec) =>
      api.saveDashboard({ id: id!, name: dashboard!.name, spec: serialiseSpec(next) }),
    onSuccess: () => {
      setDraft(null)
      client.invalidateQueries({ queryKey: ['dashboards'] })
    },
  })

  const edit = (next: DashboardSpec) => setDraft(next)

  if (dashboards.error) return <ErrorNote error={dashboards.error} />
  if (!dashboards.data) return <Loading label="Reading the dashboard" />
  if (!dashboard) {
    return (
      <article className="page">
        <EmptyNote title="No such dashboard">
          It may have been deleted. <Link to="/dash" className="link">Back to the list</Link>.
        </EmptyNote>
      </article>
    )
  }

  return (
    <article className="page page--dash">
      <header className="page__head">
        <p className="eyebrow">
          <Link to="/dash" className="link">
            Dashboards
          </Link>
        </p>
        <div className="page__titlerow">
          <h1 className="page__title page__title--hero">{dashboard.name}</h1>
          <label className="picker">
            <span>refresh</span>
            <select
              className="picker__select"
              value={spec.refreshSeconds}
              onChange={(e) => {
                const next = { ...spec, refreshSeconds: Number(e.target.value) }
                setDraft(next)
                save.mutate(next)
              }}
            >
              {REFRESH_CHOICES.map((s) => (
                <option key={s} value={s}>
                  {s === 0 ? 'off' : s < 60 ? `${s}s` : `${s / 60}m`}
                </option>
              ))}
            </select>
          </label>
          {/* A dashboard shows now; a report keeps then. Offering the jump
              here is the point at which someone wants both: the arrangement
              they have just made, recorded every week. */}
          <Link className="btn" to={`/reports?from_dashboard=${encodeURIComponent(id ?? '')}`}>
            Keep this on a schedule
          </Link>
          <button
            className={`btn${editing ? ' is-on' : ''}`}
            onClick={() => setEditing((v) => !v)}
            aria-pressed={editing}
          >
            {editing ? 'Done arranging' : 'Arrange'}
          </button>
          {draft ? (
            <button
              className="btn btn--spark"
              disabled={save.isPending}
              onClick={() => save.mutate(draft)}
            >
              {save.isPending ? 'Saving…' : 'Save layout'}
            </button>
          ) : null}
        </div>
      </header>
      {save.error ? <ErrorNote error={save.error} /> : null}

      {spec.tiles.length === 0 ? (
        <EmptyNote title="This dashboard is empty">
          Run a query in the editor, choose a chart, then use <strong>Dashboards</strong> there to
          add it here.
        </EmptyNote>
      ) : (
        <div className="dash" style={{ gridTemplateColumns: `repeat(${COLUMNS}, 1fr)` }}>
          {spec.tiles.map((tile, index) => (
            <TileCard
              key={tile.id}
              tile={tile}
              index={index}
              count={spec.tiles.length}
              refreshSeconds={spec.refreshSeconds}
              editing={editing}
              onMove={(to) => edit(moveTile(spec, tile.id, to))}
              onWidth={(w) => edit(patchTile(spec, tile.id, { w }))}
              onRemove={() => edit(removeTile(spec, tile.id))}
            />
          ))}
        </div>
      )}
    </article>
  )
}

function TileCard({
  tile,
  index,
  count,
  refreshSeconds,
  editing,
  onMove,
  onWidth,
  onRemove,
}: {
  tile: Tile
  index: number
  count: number
  refreshSeconds: number
  editing: boolean
  onMove: (to: number) => void
  onWidth: (w: number) => void
  onRemove: () => void
}) {
  // Each tile owns its query. Keyed on the SQL, so editing a tile's query
  // refetches only that tile.
  const result = useQuery<QueryResult>({
    queryKey: ['tile', tile.sql, tile.database],
    queryFn: () => api.run({ sql: tile.sql, database: tile.database }),
    refetchInterval: refreshSeconds > 0 ? refreshSeconds * 1000 : false,
    // Hold the previous render while refetching rather than flashing a skeleton.
    placeholderData: (prev) => prev,
  })

  return (
    <section
      className={`tile${editing ? ' is-editing' : ''}${result.isFetching ? ' is-busy' : ''}`}
      style={{ gridColumn: `span ${tile.w}` }}
    >
      <header className="tile__head">
        <h3 className="tile__title">{tile.title}</h3>
        <span className="panel__spacer" />
        {editing ? (
          <>
            <button
              className="savedrow__act"
              disabled={index === 0}
              title="Move earlier"
              onClick={() => onMove(index - 1)}
            >
              ‹
            </button>
            <button
              className="savedrow__act"
              disabled={index === count - 1}
              title="Move later"
              onClick={() => onMove(index + 1)}
            >
              ›
            </button>
            <select
              className="picker__select tile__width"
              value={tile.w}
              aria-label="Tile width"
              onChange={(e) => onWidth(Number(e.target.value))}
            >
              {WIDTHS.map((w) => (
                <option key={w} value={w}>
                  {Math.round((w / COLUMNS) * 100)}%
                </option>
              ))}
            </select>
            <button className="savedrow__act savedrow__act--del" title="Remove" onClick={onRemove}>
              ×
            </button>
          </>
        ) : (
          <span className="tile__meta">{tile.database}</span>
        )}
      </header>

      <div className="tile__body">
        {result.error ? (
          <ErrorNote error={result.error} retry={() => result.refetch()} />
        ) : !result.data ? (
          <Loading label="Running" />
        ) : result.data.rows.length === 0 ? (
          <EmptyNote title="No rows" />
        ) : tile.chart ? (
          <Chart result={result.data} spec={tile.chart} />
        ) : (
          <ResultsGrid result={result.data} />
        )}
      </div>
    </section>
  )
}
