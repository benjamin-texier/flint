import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import { api } from '../lib/api'
import type { ChartSpec } from '../lib/chart'
import { addTile, emptySpec, parseSpec, serialiseSpec } from '../lib/dashboard'
import { ErrorNote, Loading } from '../components/Note'
import { NeedsWorkspace } from '../components/NeedsWorkspace'

/** Add what is on screen to a dashboard.
 *
 *  Deliberately in the editor rather than on the dashboard: you build a tile by
 *  getting a query right first, and the moment it is right is the moment to keep
 *  it. The chart form travels with it, so the tile renders the way you left it. */
export function DashPanel({
  sql,
  database,
  chart,
  suggestedTitle,
  workspace,
  onClose,
}: {
  sql: string
  database: string
  chart: ChartSpec | null
  suggestedTitle: string
  workspace: string | null
  onClose: () => void
}) {
  const client = useQueryClient()
  const [title, setTitle] = useState(suggestedTitle)
  const [added, setAdded] = useState<string | null>(null)

  const dashboards = useQuery({
    queryKey: ['dashboards'],
    queryFn: api.dashboards,
    enabled: Boolean(workspace),
  })

  const add = useMutation({
    mutationFn: async (id: string) => {
      const target = dashboards.data?.find((d) => d.id === id)
      if (!target) throw new Error('that dashboard is gone')
      const next = addTile(parseSpec(target.spec), {
        title: title.trim() || suggestedTitle,
        sql,
        database,
        chart,
        w: 6,
        h: 1,
      })
      return api.saveDashboard({ id, name: target.name, spec: serialiseSpec(next) })
    },
    onSuccess: (d) => {
      setAdded(d.id)
      client.invalidateQueries({ queryKey: ['dashboards'] })
    },
  })

  const create = useMutation({
    mutationFn: async (name: string) => {
      const spec = addTile(emptySpec(), {
        title: title.trim() || suggestedTitle,
        sql,
        database,
        chart,
        w: 6,
        h: 1,
      })
      return api.saveDashboard({ name, spec: serialiseSpec(spec) })
    },
    onSuccess: (d) => {
      setAdded(d.id)
      client.invalidateQueries({ queryKey: ['dashboards'] })
    },
  })

  const [newName, setNewName] = useState('')

  if (!workspace) {
    return (
      <section className="history">
        <header className="history__head">
          <h3 className="history__title">Dashboards</h3>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="history__body">
          <NeedsWorkspace holds="a dashboard" />
        </div>
      </section>
    )
  }

  return (
    <section className="history">
      <header className="history__head">
        <h3 className="history__title">Add to a dashboard</h3>
        <span className="panel__hint">
          {chart ? `as a ${chart.kind} chart` : 'as a table'}
        </span>
        <span className="panel__spacer" />
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </header>

      <div className="saveform">
        <input
          className="frame__input saveform__name"
          value={title}
          placeholder="Title for the tile"
          aria-label="Title for the tile"
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>

      <div className="history__body">
        {added ? (
          <p className="dashadded">
            Added. <Link className="link" to={`/dash/${added}`}>Open the dashboard</Link>
          </p>
        ) : null}
        {add.error ? <ErrorNote error={add.error} /> : null}
        {create.error ? <ErrorNote error={create.error} /> : null}
        {dashboards.isPending ? <Loading label="Reading dashboards" /> : null}

        {dashboards.data?.map((d) => (
          <div className="savedrow" key={d.id}>
            <span className="savedrow__name">{d.name}</span>
            <span className="panel__spacer" />
            <span className="savedrow__meta">{parseSpec(d.spec).tiles.length} tiles</span>
            <button
              className="btn"
              disabled={add.isPending || !sql.trim()}
              onClick={() => add.mutate(d.id)}
            >
              Add
            </button>
          </div>
        ))}

        <div className="saveform saveform--bare">
          <input
            className="frame__input saveform__name"
            value={newName}
            placeholder="…or a new dashboard"
            aria-label="Name for a new dashboard"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newName.trim()) create.mutate(newName.trim())
            }}
          />
          <button
            className="btn btn--spark"
            disabled={!newName.trim() || create.isPending || !sql.trim()}
            onClick={() => create.mutate(newName.trim())}
          >
            Create with this tile
          </button>
        </div>
      </div>
    </section>
  )
}
