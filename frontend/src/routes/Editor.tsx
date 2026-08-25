import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { keymap } from '@codemirror/view'
import { Prec } from '@codemirror/state'

import { api, FlintError, type AppConfig, type QueryResult, type SchemaEntry } from '../lib/api'
import { bytes, count, duration } from '../lib/format'
import { statementAt, tableInStatement } from '../lib/sql'
import { formatDdl } from '../lib/ddl'
import { ResultView } from '../components/ResultView'
import { EmptyNote, ErrorNote } from '../components/Note'
import { HistoryPanel } from './History'
import { SavedPanel } from './Saved'
import { DashPanel } from './DashPanel'
import { DESTINATIONS, handoffPath, type Destination } from '../lib/handoff'
import { clickhouseSql, flintHighlighting, flintTheme } from '../editor/setup'
import { useTabs } from '../editor/tabs'

export function Editor() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const [historyOpen, setHistoryOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [savedOpen, setSavedOpen] = useState(false)
  const [dashOpen, setDashOpen] = useState(false)
  // Whatever form the reader last chose for the result, so a dashboard tile can
  // be built to match what they are looking at.
  const [chart, setChart] = useState<import('../lib/chart').ChartSpec | null>(null)
  // null = follow the content. A drag pins it, and a double-click on the grip
  // hands it back.
  const [codeHeight, setCodeHeight] = useState<number | null>(null)
  const tabs = useTabs()
  const editor = useRef<ReactCodeMirrorRef>(null)

  const config = useQuery({ queryKey: ['config'], queryFn: api.config })
  const schema = useQuery({
    queryKey: ['schema'],
    queryFn: api.schema,
    staleTime: 5 * 60 * 1000,
  })

  const active = tabs.active
  // The tab may not carry a database yet (a fresh tab, or one opened without
  // one). Resolving it here means the picker, the run and the autocomplete all
  // agree on which database they are in.
  const database = active?.database ?? config.data?.default_database

  // Arriving from "Open in editor": seed a tab, then drop the params so a
  // refresh does not keep re-seeding it. Keyed on the SQL itself, because the
  // effect runs twice on mount in development and would otherwise open the
  // same query in two tabs.
  const { openWith } = tabs
  const seeded = useRef<string | null>(null)
  useEffect(() => {
    const sql = params.get('sql')
    if (!sql || seeded.current === sql) return
    seeded.current = sql
    openWith(sql, params.get('database') ?? undefined)
    setParams(new URLSearchParams(), { replace: true })
  }, [params, setParams, openWith])

  const run = useCallback(async () => {
    if (!active || active.running) return
    const view = editor.current?.view
    const caret = view?.state.selection.main
    const selected =
      caret && !caret.empty ? active.sql.slice(caret.from, caret.to) : null
    const statement = selected ?? statementAt(active.sql, caret?.head ?? active.sql.length)?.sql
    if (!statement?.trim()) return

    const queryId = crypto.randomUUID()
    tabs.patch(active.id, { running: true, queryId, error: null })
    const startedAt = performance.now()
    try {
      const result = await api.run({
        sql: statement,
        database,
        query_id: queryId,
      })
      tabs.patch(active.id, {
        running: false,
        queryId: null,
        result,
        error: null,
        wallMs: performance.now() - startedAt,
      })
    } catch (error) {
      tabs.patch(active.id, {
        running: false,
        queryId: null,
        error,
        wallMs: performance.now() - startedAt,
      })
    }
  }, [active, database, tabs])

  /** The statement the caret is in, or the selection. Everything that acts on
   *  "the query" acts on this. */
  const currentStatement = useCallback(() => {
    if (!active) return null
    const caret = editor.current?.view?.state.selection.main
    if (caret && !caret.empty) {
      return { sql: active.sql.slice(caret.from, caret.to), start: caret.from, end: caret.to }
    }
    return statementAt(active.sql, caret?.head ?? active.sql.length)
  }, [active])

  /** Format through ClickHouse, which knows the whole grammar, and fall back to
   *  the local clause-splitter if the server is too old for `formatQuery`. */
  const format = useCallback(async () => {
    if (!active) return
    const target = currentStatement()
    if (!target?.sql.trim()) return
    let formatted: string
    try {
      formatted = (await api.format(target.sql)).sql
    } catch {
      formatted = formatDdl(target.sql)
    }
    const next = active.sql.slice(0, target.start) + formatted + active.sql.slice(target.end)
    tabs.patch(active.id, { sql: next })
  }, [active, currentStatement, tabs])

  /** Run an EXPLAIN of the current statement. The plan comes back as an
   *  ordinary result set, so it travels the same path as any other query. */
  const explain = useCallback(
    async (kind: ExplainKind) => {
      if (!active) return
      const target = currentStatement()
      if (!target?.sql.trim()) return
      const queryId = crypto.randomUUID()
      tabs.patch(active.id, { running: true, queryId, error: null })
      const startedAt = performance.now()
      try {
        const result = await api.run({
          sql: EXPLAINS[kind].prefix + target.sql.trim(),
          database,
          query_id: queryId,
        })
        tabs.patch(active.id, {
          running: false,
          queryId: null,
          result,
          error: null,
          wallMs: performance.now() - startedAt,
        })
      } catch (error) {
        tabs.patch(active.id, { running: false, queryId: null, error, wallMs: performance.now() - startedAt })
      }
    },
    [active, currentStatement, database, tabs],
  )

  const cancel = useCallback(async () => {
    if (!active?.queryId) return
    try {
      await api.cancel(active.queryId)
    } catch (error) {
      tabs.patch(active.id, { error })
    }
  }, [active, tabs])

  // Cmd/Ctrl+Enter runs. Registered at high precedence so CodeMirror's own
  // Enter handling does not swallow it.
  const runKeymap = useMemo(
    () =>
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-Enter',
            preventDefault: true,
            run: () => {
              void run()
              return true
            },
          },
        ]),
      ),
    [run],
  )

  // Only the *name* of the FROM target is a dependency: rebuilding the
  // language extension on every keystroke would be wasteful, and the target
  // changes rarely.
  const fromTable = active ? tableInStatement(active.sql)?.table : undefined
  const extensions = useMemo(
    () => [
      runKeymap,
      clickhouseSql(schema.data ?? [], database, fromTable),
      flintTheme,
      flintHighlighting,
    ],
    [runKeymap, schema.data, database, fromTable],
  )

  if (!active) return null

  // A one-line query in a 370px pane is what the editor used to look like:
  // mostly emptiness, with the results squeezed underneath. Follow the
  // content instead, within bounds — enough room to keep typing, never more
  // than half the screen.
  const lines = active.sql.split('\n').length
  const autoHeight = Math.min(
    Math.max(window.innerHeight * 0.45, 220),
    Math.max(132, lines * 21.5 + 26),
  )

  return (
    <section className="editor">
      <div className="editor__bar">
        <DatabasePicker
          value={database}
          onChange={(next) => tabs.patch(active.id, { database: next })}
        />

        <div className="editor__actions">
          {active.running ? (
            <button className="btn" onClick={cancel}>
              Stop
            </button>
          ) : (
            <button className="btn btn--spark" onClick={() => void run()}>
              Run <span className="kbd">⌘↵</span>
            </button>
          )}
          <button className="btn" onClick={() => void format()} disabled={active.running}>
            Format
          </button>
          <label className="explain">
            <select
              className="picker__select explain__select"
              value=""
              onChange={(e) => {
                const kind = e.target.value as ExplainKind
                e.currentTarget.value = ''
                if (kind) void explain(kind)
              }}
              disabled={active.running}
              aria-label="Explain the statement"
            >
              <option value="">Explain…</option>
              {(Object.keys(EXPLAINS) as ExplainKind[]).map((k) => (
                <option key={k} value={k}>
                  {EXPLAINS[k].label}
                </option>
              ))}
            </select>
          </label>
          {/* Sending rather than retyping: a statement retyped on another page
              is a statement that will differ from the one that was tested. */}
          <label className="editor__pick">
            <select
              className="btn btn--select"
              value=""
              onChange={(e) => {
                const to = e.target.value as Destination | ''
                if (!to) return
                navigate(
                  handoffPath(to, {
                    sql: currentStatement()?.sql ?? active.sql,
                    database: database ?? '',
                    name: active.title || '',
                  }),
                )
              }}
              disabled={!active.sql.trim()}
              aria-label="Send this statement somewhere that keeps it"
              title={
                active.sql.trim()
                  ? 'Turn this statement into an alert, a report or an API'
                  : 'Write something first'
              }
            >
              <option value="">Send to…</option>
              {DESTINATIONS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className={`btn${dashOpen ? ' is-on' : ''}`}
            onClick={() => setDashOpen((o) => !o)}
            aria-pressed={dashOpen}
            disabled={!active.result}
            title={active.result ? 'Add this to a dashboard' : 'Run something first'}
          >
            Dashboards
          </button>
          <button
            className={`btn${savedOpen ? ' is-on' : ''}`}
            onClick={() => setSavedOpen((o) => !o)}
            aria-pressed={savedOpen}
          >
            Saved
          </button>
          <button
            className={`btn${settingsOpen ? ' is-on' : ''}`}
            onClick={() => setSettingsOpen((o) => !o)}
            aria-pressed={settingsOpen}
            title="What Flint sends with every statement"
          >
            Settings
          </button>
          <button
            className={`btn${historyOpen ? ' is-on' : ''}`}
            onClick={() => setHistoryOpen((open) => !open)}
            aria-pressed={historyOpen}
          >
            History
          </button>
        </div>

        <div className="editor__spacer" />
      </div>

      <TabStrip />

      <div className="editor__code" style={{ flex: `0 0 ${codeHeight ?? autoHeight}px` }}>
        <CodeMirror
          ref={editor}
          value={active.sql}
          height="100%"
          // `@uiw/react-codemirror` ships a light theme by default and it wins
          // over ours, which put near-white text on a white ground in dark
          // mode. Flint dresses the editor entirely from its own tokens.
          theme="none"
          basicSetup={{
            lineNumbers: true,
            foldGutter: false,
            highlightActiveLine: true,
            autocompletion: true,
            bracketMatching: true,
            closeBrackets: true,
          }}
          extensions={extensions}
          onChange={(sql) => tabs.patch(active.id, { sql })}
          placeholder="SELECT … — ⌘↵ runs the statement under the caret"
        />
      </div>

      {/* Drag to size the editor, double-click to let it follow the content
          again. */}
      <div
        className="editor__grip"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the editor"
        tabIndex={0}
        onDoubleClick={() => setCodeHeight(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') setCodeHeight((h) => Math.max(132, (h ?? autoHeight) - 24))
          if (e.key === 'ArrowDown') setCodeHeight((h) => Math.min(window.innerHeight * 0.7, (h ?? autoHeight) + 24))
        }}
        onPointerDown={(e) => {
          const start = e.clientY
          const from = codeHeight ?? autoHeight
          const el = e.currentTarget
          el.setPointerCapture(e.pointerId)
          const move = (ev: PointerEvent) =>
            setCodeHeight(
              Math.min(window.innerHeight * 0.7, Math.max(96, from + ev.clientY - start)),
            )
          const up = () => {
            el.releasePointerCapture(e.pointerId)
            el.removeEventListener('pointermove', move)
            el.removeEventListener('pointerup', up)
          }
          el.addEventListener('pointermove', move)
          el.addEventListener('pointerup', up)
        }}
      />

      <StatsStrip
        running={active.running}
        result={active.result}
        error={active.error}
        wallMs={active.wallMs}
        maxRows={config.data?.max_result_rows}
      />

      <div className="editor__results">
        {dashOpen ? (
          <DashPanel
            sql={currentStatement()?.sql ?? active.sql}
            database={database ?? ''}
            chart={chart}
            suggestedTitle={active.title || 'Untitled'}
            workspace={config.data?.workspace ?? null}
            onClose={() => setDashOpen(false)}
          />
        ) : savedOpen ? (
          <SavedPanel
            currentSql={active.sql}
            currentDatabase={database ?? ''}
            suggestedName={active.title || 'Untitled query'}
            workspace={config.data?.workspace ?? null}
            onClose={() => setSavedOpen(false)}
            onLoad={(q) => {
              tabs.openWith(q.sql, q.database)
              setSavedOpen(false)
            }}
          />
        ) : settingsOpen ? (
          <SettingsPanel config={config.data} onClose={() => setSettingsOpen(false)} />
        ) : historyOpen ? (
          <HistoryPanel
            onClose={() => setHistoryOpen(false)}
            onPick={(sql) => {
              tabs.patch(active.id, { sql })
              setHistoryOpen(false)
            }}
          />
        ) : active.error ? (
          <ErrorNote error={active.error} />
        ) : active.result ? (
          active.result.kind === 'command' ? (
            <EmptyNote title="Statement executed">
              This statement returned no rows.
            </EmptyNote>
          ) : active.result.rows.length === 0 ? (
            <EmptyNote title="No rows matched">
              The query ran and came back empty. Loosen the WHERE clause and run it again.
            </EmptyNote>
          ) : isPlan(active.result) ? (
            <pre className="code code--wrap plan">
              {active.result.rows.map((r) => String(r[0] ?? '')).join('\n')}
            </pre>
          ) : (
            <ResultView result={active.result} onChartChange={setChart} />
          )
        ) : (
          <EmptyNote title="Nothing has run in this tab yet">
            Write a statement above and press ⌘↵. Only the statement under the caret runs, so
            you can keep a scratchpad of queries in one tab.
          </EmptyNote>
        )}
      </div>
    </section>
  )
}

/** The EXPLAIN family, in the order they are useful: what it will do, how it
 *  will do it, how much it thinks it will read, how it read your SQL. */
const EXPLAINS = {
  plan: { label: 'Plan (with indexes)', prefix: 'EXPLAIN PLAN indexes = 1 ' },
  pipeline: { label: 'Pipeline', prefix: 'EXPLAIN PIPELINE ' },
  estimate: { label: 'Estimate', prefix: 'EXPLAIN ESTIMATE ' },
  syntax: { label: 'Rewritten SQL', prefix: 'EXPLAIN SYNTAX ' },
  tree: { label: 'Query tree', prefix: 'EXPLAIN QUERY TREE ' },
} as const

type ExplainKind = keyof typeof EXPLAINS

/** An EXPLAIN plan comes back as one String column called `explain`. It is a
 *  tree, so it belongs in a <pre>, not in a grid one line tall. `ESTIMATE`
 *  returns a real table and goes to the grid like anything else. */
function isPlan(result: QueryResult): boolean {
  return result.columns.length === 1 && result.columns[0]?.name === 'explain'
}

function SettingsPanel({
  config,
  onClose,
}: {
  config: AppConfig | undefined
  onClose: () => void
}) {
  // The server's own non-default settings, which explain behaviour Flint does
  // not control.
  const changed = useQuery({
    queryKey: ['changed-settings'],
    queryFn: () =>
      api.run({
        sql:
          'SELECT name, value, description FROM system.settings ' +
          'WHERE changed ORDER BY name LIMIT 200',
      }),
    staleTime: 60_000,
  })

  return (
    <section className="history">
      <header className="history__head">
        <h3 className="history__title">Settings</h3>
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="history__body">
        <h4 className="setgroup">Sent with every statement</h4>
        <table className="settbl">
          <tbody>
            {Object.entries(config?.query_settings ?? {}).map(([k, v]) => (
              <tr key={k}>
                <td className="settbl__k">{k}</td>
                <td className="settbl__v">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="bhint">
          `max_result_rows` is one past the cap on purpose: it is how Flint knows whether more
          rows exist behind the ones it shows.
        </p>

        <h4 className="setgroup">Changed on the server</h4>
        {changed.error ? <ErrorNote error={changed.error} /> : null}
        {changed.data && changed.data.rows.length === 0 ? (
          <p className="bhint">Every setting is at its default.</p>
        ) : null}
        {changed.data && changed.data.rows.length > 0 ? (
          <table className="settbl">
            <tbody>
              {changed.data.rows.map((r) => (
                <tr key={String(r[0])}>
                  <td className="settbl__k" title={String(r[2] ?? '')}>
                    {String(r[0])}
                  </td>
                  <td className="settbl__v">{String(r[1])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </section>
  )
}

function TabStrip() {
  const tabs = useTabs()
  return (
    <div className="tabstrip" role="tablist">
      {tabs.tabs.map((t, i) => (
        <div
          key={t.id}
          role="tab"
          aria-selected={t.id === tabs.activeId}
          className={`tabstrip__tab${t.id === tabs.activeId ? ' is-active' : ''}`}
        >
          <button className="tabstrip__pick" onClick={() => tabs.select(t.id)}>
            {t.running ? <span className="tabstrip__running" aria-label="running" /> : null}
            {t.title || `query ${i + 1}`}
          </button>
          {tabs.tabs.length > 1 ? (
            <button
              className="tabstrip__close"
              onClick={() => tabs.close(t.id)}
              aria-label={`Close ${t.title || `query ${i + 1}`}`}
            >
              ×
            </button>
          ) : null}
        </div>
      ))}
      <button className="tabstrip__add" onClick={() => tabs.open()} aria-label="New query tab">
        +
      </button>
    </div>
  )
}

function DatabasePicker({
  value,
  onChange,
}: {
  value: string | undefined
  onChange: (db: string) => void
}) {
  const databases = useQuery({ queryKey: ['databases'], queryFn: api.databases })
  const current = value ?? ''

  return (
    <label className="picker">
      <span className="label">database</span>
      <select
        className="picker__select"
        value={current}
        onChange={(e) => onChange(e.target.value)}
      >
        {databases.data?.some((d) => d.name === current) ? null : (
          <option value={current}>{current || '—'}</option>
        )}
        {databases.data?.map((d) => (
          <option key={d.name} value={d.name}>
            {d.name}
          </option>
        ))}
      </select>
    </label>
  )
}

/** The one place the spark lives in motion: while a query is in flight an
 *  ember travels along this strip. */
function StatsStrip({
  running,
  result,
  error,
  wallMs,
  maxRows,
}: {
  running: boolean
  result: QueryResult | null
  error: unknown
  wallMs: number | null
  maxRows: number | undefined
}) {
  const facts: string[] = []
  if (result) {
    facts.push(`${count(result.statistics.rows_read)} rows read`)
    facts.push(bytes(result.statistics.bytes_read))
    facts.push(duration(result.statistics.elapsed))
    if (result.kind === 'read') facts.push(`${count(result.rows.length)} returned`)
    if (result.summary.written_rows > 0) {
      facts.push(`${count(result.summary.written_rows)} written`)
    }
  } else if (wallMs !== null && error) {
    facts.push(`failed after ${duration(wallMs / 1000)}`)
  }

  const truncated = result?.truncated ?? false

  return (
    <div className={`stats${running ? ' stats--running' : ''}`} aria-live="polite">
      <span className="stats__state label">
        {running ? 'running' : error ? 'failed' : result ? 'done' : 'idle'}
      </span>
      {facts.map((f) => (
        <span className="stats__fact" key={f}>
          {f}
        </span>
      ))}
      {truncated ? (
        <span className="pill pill--warn" title="Raise FLINT_MAX_RESULT_ROWS to see more">
          truncated at {maxRows ? count(maxRows) : 'the row cap'}
        </span>
      ) : null}
      {error instanceof FlintError && error.clickhouseCode ? (
        <span className="stats__fact stats__fact--warn">code {error.clickhouseCode}</span>
      ) : null}
    </div>
  )
}

export type { SchemaEntry }
