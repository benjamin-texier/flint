import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'

import { api, type QueryResult } from '../lib/api'
import {
  COLUMNS,
  RANGES,
  REFRESH_CHOICES,
  WIDTHS,
  bindingsFor,
  declaredVariables,
  emptySpec,
  followsRange,
  saysRange,
  variableIssues,
  moveTile,
  parseSpec,
  patchTile,
  carriesDates,
  removeTile,
  serialiseSpec,
  tileZone,
  type DashboardSpec,
  type Tile,
} from '../lib/dashboard'
import { downloadNote } from '../lib/export'
import { declaredParams } from '../lib/publish'
import { lockSupport, saysLock } from '../lib/wall'
import { relativeTime } from '../lib/format'
import { Chart } from '../components/Chart'
import { Download } from '../components/Download'
import { ResultsGrid } from '../components/ResultsGrid'
import { EmptyNote, ErrorNote, Loading, Sentence } from '../components/Note'
import { keeps } from '../lib/spaces'

/** How tall a tile's plot may be. Matches `.tile__body`'s own floor: a board is
 *  read as a set of tiles at a glance, and one tile four times the height of its
 *  neighbours is a board nobody can scan. */
const TILE_PLOT_H = 240

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
        {/* Every other page in the product answers a question in its title —
            "What your queries cost", "Who can do what", "Whether the views are
            flowing". This one restated its own eyebrow, which is the one thing a
            title can say that the reader already knows. */}
        <h1 className="page__title page__title--hero">What you keep in front of you</h1>
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
  const config = useQuery({ queryKey: ['config'], queryFn: api.config })
  const dashboards = useQuery({
    queryKey: ['dashboards'],
    queryFn: api.dashboards,
    enabled: keeps(config.data),
  })
  const dashboard = dashboards.data?.find((d) => d.id === id)
  const server = useQuery({ queryKey: ['server'], queryFn: () => api.server() })

  const [draft, setDraft] = useState<DashboardSpec | null>(null)
  const board = useRef<HTMLElement>(null)
  const wall = useWall(board)
  const [editing, setEditing] = useState(false)
  // The stored spec is the source of truth until an edit starts.
  const spec = draft ?? (dashboard ? parseSpec(dashboard.spec) : emptySpec())

  const save = useMutation({
    mutationFn: (next: DashboardSpec) =>
      api.saveDashboard({ id: id!, name: dashboard!.name, spec: serialiseSpec(next) }),
    /* The refetch first, and the draft dropped only once it has landed.
       Dropping it straight away lets `spec` fall back to the *cached* dashboard
       for as long as the round trip takes — the version without the change just
       saved — and every tile re-keys to the old bindings and asks again with
       them. Invisible while the only controls were refresh and width, because
       neither changes what a tile asks for; a variable does, so the flap showed
       up as a tile firing twice and answering 400 in between. */
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['dashboards'] })
      setDraft(null)
    },
  })

  const edit = (next: DashboardSpec) => setDraft(next)

  /* Dragging is an *addition* to the two arrow buttons, never a replacement:
     those are the keyboard path, and dragging is not one. Taking them out for
     a grip would land this feature as an accessibility regression.

     What the two paths did share was silence — a tile moved and nothing said
     so, which is unreadable without sight of the grid. Both go through
     `rearrange` now, and it speaks. */
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [moved, setMoved] = useState('')

  const rearrange = (tileId: string, to: number) => {
    const from = spec.tiles.findIndex((t) => t.id === tileId)
    const target = Math.min(spec.tiles.length - 1, Math.max(0, to))
    if (from === -1 || from === target) return
    edit(moveTile(spec, tileId, target))
    setMoved(
      `Moved ${spec.tiles[from]!.title} to ${target + 1} of ${spec.tiles.length}.`,
    )
  }

  /* Where nothing can be stored no dashboard can exist, so an id in the URL is
     necessarily a link from somewhere else — a bookmark, or another Flint. The
     list is where the reason lives; it is one page and it says all of it. */
  if (config.data && !keeps(config.data)) return <Navigate to="/dash" replace />
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
    <article className={`page page--dash${wall.on ? ' page--wall' : ''}`} ref={board}>
      <header className="page__head">
        <p className="eyebrow">
          <Link to="/dash" className="link">
            Dashboards
          </Link>
        </p>
        <div className="page__titlerow">
          <h1 className="page__title page__title--hero">{dashboard.name}</h1>
          {/* Beside refresh, because they are the same kind of control: both say
              how the tiles read, and neither is part of what any one tile is. */}
          <label className="picker">
            <span>range</span>
            <select
              className="picker__select"
              value={spec.rangeHours}
              onChange={(e) => {
                const next = { ...spec, rangeHours: Number(e.target.value) }
                setDraft(next)
                save.mutate(next)
              }}
            >
              {RANGES.map((r) => (
                <option key={r.hours} value={r.hours}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
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
          <button className="btn btn--wall" onClick={wall.toggle}>
            {wall.on ? 'Leave full screen' : 'Full screen'}
          </button>
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
        <>
        {/* Every fold states its own count, and a range is a fold: a control that
            changes six of nine tiles and says nothing about the other three is a
            control nobody can trust. */}
        {wall.note ? <p className="dashgrid__range">{wall.note}</p> : null}
        {saysRange(spec) ? <p className="dashgrid__range">{saysRange(spec)}</p> : null}

        <Variables
          spec={spec}
          onSet={(name, value) => {
            const next = { ...spec, variables: { ...spec.variables, [name]: value } }
            setDraft(next)
            save.mutate(next)
          }}
        />
        <div className="dashgrid" style={{ gridTemplateColumns: `repeat(${COLUMNS}, 1fr)` }}>
          {spec.tiles.map((tile, index) => (
            <TileCard
              key={tile.id}
              tile={tile}
              index={index}
              count={spec.tiles.length}
              refreshSeconds={spec.refreshSeconds}
              rangeHours={spec.rangeHours}
              variables={spec.variables}
              spec={spec}
              editing={editing}
              serverZone={server.data?.timezone}
              dragging={dragging === tile.id}
              over={over === tile.id && dragging !== null && dragging !== tile.id}
              onGrab={() => setDragging(tile.id)}
              onDrop={() => {
                if (dragging && dragging !== tile.id) rearrange(dragging, index)
                setDragging(null)
                setOver(null)
              }}
              onOver={() => setOver(tile.id)}
              onRelease={() => {
                setDragging(null)
                setOver(null)
              }}
              onMove={(to) => rearrange(tile.id, to)}
              onWidth={(w) => edit(patchTile(spec, tile.id, { w }))}
              onRemove={() => edit(removeTile(spec, tile.id))}
            />
          ))}
        </div>

        {/* One announcement for both paths. A grid rearranged in silence is
            legible only to whoever can see it move. */}
        <p className="sr-only" role="status">
          {moved}
        </p>
        </>
      )}
    </article>
  )
}

/** A control for every `{name:Type}` the tiles declare.
 *
 *  The same binding the range uses, with the names read off the statements
 *  instead of fixed. A dashboard whose tiles ask for `region` gets a box for
 *  `region`; one whose tiles ask for nothing shows nothing at all.
 *
 *  What is in the way is said *above* the boxes rather than left to appear as a
 *  broken tile: an unset parameter is not an empty result — ClickHouse answers
 *  `Substitution 'region' is not set` — and a reader looking at an error where
 *  they expected data has no way to know a text box three feet up would fix it. */
function Variables({
  spec,
  onSet,
}: {
  spec: DashboardSpec
  onSet: (name: string, value: string) => void
}) {
  const declared = declaredVariables(spec)
  if (declared.length === 0) return null
  const issues = variableIssues(spec)

  return (
    <div className="vars">
      <div className="vars__row">
        {declared.map((v) => (
          <label className="vars__one" key={v.name} data-value={spec.variables[v.name] ?? '—'}>
            <span className="vars__name">
              {v.name}
              <span className="vars__type">{v.types.join(' / ')}</span>
            </span>
            <input
              className="vars__input"
              defaultValue={spec.variables[v.name] ?? ''}
              placeholder={`used by ${v.usedBy.length} ${v.usedBy.length === 1 ? 'tile' : 'tiles'}`}
              onBlur={(e) => {
                if (e.target.value !== (spec.variables[v.name] ?? '')) onSet(v.name, e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
            />
          </label>
        ))}
      </div>
      {issues.length ? (
        <ul className="vars__issues">
          {issues.map((line) => (
            <li key={line}>
              <Sentence text={line} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}


/** Full screen, and the screen lock where the browser will give one.
 *
 *  The state follows `fullscreenchange` rather than the button, because Escape
 *  leaves full screen without going near a click handler — and a page that
 *  thinks it is still on the wall is a page with its chrome missing and no way
 *  to get it back.
 *
 *  The lock is asked for and never promised. Measured: over `http://127.0.0.1`
 *  it is granted, and over a LAN address in plain HTTP — which is how a wall
 *  display is actually served — `navigator.wakeLock` is `undefined` and reaching
 *  for it throws. So the reach is guarded and the reason is offered rather than
 *  the failure. */
function useWall(target: React.RefObject<HTMLElement | null>) {
  const [on, setOn] = useState(false)
  const held = useRef<{ release: () => Promise<void> } | null>(null)
  const lock = lockSupport(
    typeof navigator === 'undefined' ? undefined : navigator,
    typeof window === 'undefined' ? undefined : window.isSecureContext,
  )

  useEffect(() => {
    const follow = () => setOn(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', follow)
    return () => document.removeEventListener('fullscreenchange', follow)
  }, [])

  useEffect(() => {
    if (!on) {
      held.current?.release().catch(() => {})
      held.current = null
      return
    }
    if (lock !== 'available') return
    let cancelled = false
    navigator.wakeLock
      ?.request('screen')
      .then((sentinel) => {
        if (cancelled) sentinel.release().catch(() => {})
        else held.current = sentinel
      })
      // A refusal is not a failure of the dashboard: the browser may decline on
      // battery, and the wall still shows what it shows.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [on, lock])

  const toggle = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
      return
    }
    // Requires a user gesture, which this is, and can still be refused — in
    // which case `fullscreenchange` never fires and the page stays as it was.
    target.current?.requestFullscreen?.().catch(() => {})
  }

  return { on, toggle, note: on ? saysLock(lock) : null }
}

function TileCard({
  tile,
  index,
  count,
  refreshSeconds,
  rangeHours,
  variables,
  spec,
  editing,
  serverZone,
  dragging,
  over,
  onGrab,
  onOver,
  onDrop,
  onRelease,
  onMove,
  onWidth,
  onRemove,
}: {
  tile: Tile
  serverZone: string | undefined
  index: number
  count: number
  refreshSeconds: number
  rangeHours: number
  variables: Record<string, string>
  spec: DashboardSpec
  editing: boolean
  /** This tile is the one being carried. */
  dragging: boolean
  /** Another tile is being carried and would land here. */
  over: boolean
  onGrab: () => void
  onOver: () => void
  onDrop: () => void
  onRelease: () => void
  onMove: (to: number) => void
  onWidth: (w: number) => void
  onRemove: () => void
}) {
  // Each tile owns its query. Keyed on the SQL, so editing a tile's query
  // refetches only that tile.
  /* The window is computed per fetch rather than held in the key: a dashboard
     left open on a wall must keep meaning "the last seven days", and a `from`
     frozen at the moment the range was chosen would quietly become an absolute
     one. The key carries the *choice* so changing it refetches; the values come
     from the clock at the moment of asking. */
  /* The window is computed per fetch rather than held in the key: a dashboard
     left open on a wall must keep meaning "the last seven days", and a `from`
     frozen at the moment the range was chosen would quietly become an absolute
     one. The key carries the *choices* so changing one refetches; the values
     come from the clock at the moment of asking. */
  const asks = followsRange(tile.sql)
  const mine = declaredParams(tile.sql).filter((p) => variables[p] !== undefined)
  const result = useQuery<QueryResult>({
    queryKey: [
      'tile',
      tile.sql,
      tile.database,
      asks ? rangeHours : 0,
      mine.map((p) => `${p}=${variables[p]}`).join('&'),
    ],
    queryFn: () => {
      const params = bindingsFor(tile, spec)
      return api.run({
        sql: tile.sql,
        database: tile.database,
        ...(Object.keys(params).length ? { params } : {}),
      })
    },
    refetchInterval: refreshSeconds > 0 ? refreshSeconds * 1000 : false,
    // Hold the previous render while refetching rather than flashing a skeleton.
    placeholderData: (prev) => prev,
  })

  // Read off what came back, not off the statement: whether this tile has a
  // date in it is a fact about its answer.
  const zone =
    result.data && carriesDates(result.data.columns.map((c) => c.type))
      ? tileZone(tile.sql, serverZone)
      : undefined

  /* `draggable` is set on the node at the moment the grip is pressed rather
     than held in state, and that is a requirement rather than a shortcut: the
     browser reads the attribute when it decides whether a `pointerdown` is the
     start of a drag, and a React state change is not guaranteed to have
     rendered by then. Setting it from the grip and not on the card is what
     keeps a tile's own table selectable and scrollable while arranging. */
  const card = useRef<HTMLElement>(null)
  const grip = (on: boolean) => () => {
    if (card.current) card.current.draggable = on
  }

  return (
    <section
      ref={card}
      className={`tile${editing ? ' is-editing' : ''}${result.isFetching ? ' is-busy' : ''}${
        dragging ? ' is-dragging' : ''
      }${over ? ' is-over' : ''}`}
      style={{ gridColumn: `span ${tile.w}` }}
      onDragStart={(e) => {
        // A drag with no payload is refused outright by Firefox.
        e.dataTransfer.setData('text/plain', tile.id)
        e.dataTransfer.effectAllowed = 'move'
        onGrab()
      }}
      onDragEnd={() => {
        grip(false)()
        onRelease()
      }}
      onDragOver={(e) => {
        // Without this the drop never fires: the default is to refuse.
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        onOver()
      }}
      onDrop={(e) => {
        e.preventDefault()
        grip(false)()
        onDrop()
      }}
    >
      <header className="tile__head">
        {/* The full title on hover, because the line beside it can now be long
            enough to squeeze this one: a zone like `America/Argentina/Salta`
            in a four-column tile costs the last word of whatever the author
            called it. Truncated is acceptable; truncated and unrecoverable is
            not. */}
        <h3 className="tile__title" title={tile.title}>
          {tile.title}
        </h3>
        <span className="panel__spacer" />
        {editing ? (
          <>
            {/* A grip and not a control: the arrows beside it are the whole
                keyboard contract, and a third focusable thing that does the
                same job only lengthens the tab order. Hidden from assistive
                technology for the same reason — dragging is not a gesture it
                can offer, and announcing a handle nobody can use is worse than
                announcing nothing. */}
            <span
              className="tile__grip"
              aria-hidden="true"
              title="Drag to arrange"
              onPointerDown={grip(true)}
              onPointerUp={grip(false)}
            >
              ⠿
            </span>
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
          <span className="tile__meta">
            {tile.database}
            {/* Whose days these are, where the tile has days and Flint can say
                so without guessing. A reader never sees the statement, so this
                slot is the only place the answer can appear — and a bar per
                day read from another country is otherwise a bar per somebody
                else's day, silently. */}
            {zone ? <> · days in {zone}</> : null}
          </span>
        )}
      </header>

      {/* In the header's row rather than under the grid, and that is a
          constraint rather than a preference: a tile has no bounded footer to
          sit in. `.tile__body` is `flex: 1; overflow: auto`, but `.tile` itself
          has no height — `tile.h` is in the spec and never reaches the style —
          so a tile grows to its content and anything after the grid lands
          wherever that ends. Measured on a 1,169-row tile: the tile was 29,395
          pixels tall and the control sat at y=29,557, which is not a control.
          The header is the only part of a tile guaranteed to be on screen.

          A chart is the one place Flint shows rows without letting you read
          them one by one, so "give me the numbers behind this" is the question
          a tile provokes most — and its reader cannot even see the statement to
          take it elsewhere. */}
      {result.data && result.data.rows.length > 0 && !editing ? (
        <div className="tile__take">
          <Download
            sql={tile.sql}
            database={tile.database}
            stem={tile.title || 'tile'}
            note={downloadNote(result.data.rows.length, result.data.truncated)}
          />
        </div>
      ) : null}

      <div className="tile__body">
        {result.error ? (
          <ErrorNote error={result.error} retry={() => result.refetch()} />
        ) : !result.data ? (
          <Loading label="Running" />
        ) : result.data.rows.length === 0 ? (
          <EmptyNote title="No rows" />
        ) : tile.chart ? (
          /* A tile knows how tall it is and the chart does not, so it says.
             Without it the chart takes the aspect rule's answer — half its own
             width, up to 560px — which is right on the query page and four
             times a tile on a board of them. */
          <Chart result={result.data} spec={tile.chart} room={TILE_PLOT_H} />
        ) : (
          <ResultsGrid result={result.data} />
        )}
      </div>

    </section>
  )
}
