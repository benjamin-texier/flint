import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import type { QueryResult } from '../lib/api'
import type { ChartSpec } from '../lib/chart'
import { columnInsertion, tableInsertion } from '../lib/insert'
import type { Insertion } from '../lib/insert'
import { formStillOwns, startingSpec, type QuerySpec } from '../lib/query'

/** Which face a tab is wearing.
 *
 *  Asking a question and writing the SQL for one used to be two pages, and they
 *  looked alike enough that the nav had to name them twice. They are one page
 *  now with a switch on it — but the switch is a property of the *tab*, not of
 *  the page, and that is the whole design. A global mode would have one form
 *  and one statement for eight tabs, so flipping it would either throw one of
 *  them away or show you somebody else's question. A tab carries its own, so
 *  four tabs can be four forms, four statements, or any mix, and switching
 *  between them switches the mode with them. */
export type TabMode = 'sql' | 'build'

export interface QueryTab {
  id: string
  title: string
  mode: TabMode
  /** The statement.
   *
   *  In `sql` it is what somebody typed and the only source of truth. In
   *  `build` it is a *mirror* — the statement the server generated for the form,
   *  written back here so that everything downstream of the question (send to
   *  an alert, save, download, add to a dashboard, explain) reads one field and
   *  needs to know nothing about which face produced it. */
  sql: string
  /** The form behind a build tab.
   *
   *  Kept after a switch to SQL rather than thrown away, because that is what
   *  makes the switch worth having: a reader who flips to the statement to read
   *  it can flip back. See `formStillOwns` for when that stops being true. */
  spec: QuerySpec | null
  /** The statement the form last generated, as the server wrote it. What `sql`
   *  is compared against to know whether it has since been typed over. */
  specSql: string | null
  /** The form the reader chose for the result, remembered per tab.
   *
   *  On the page it was one value for every tab, which meant a chart picked in
   *  one tab described another tab's columns the moment you switched. It also
   *  died on every re-run: editing a query and running it again put you back on
   *  the table, and the picture you were building had to be found again. */
  chart: ChartSpec | null
  database: string | undefined
  running: boolean
  queryId: string | null
  result: QueryResult | null
  /** The statement that produced `result`, kept beside it.
   *
   *  The grid rewrites the query it is showing, which means it has to know which
   *  statement that was — not "the one under the caret now", which may be a
   *  different one three lines down. Cleared with the result it belongs to. */
  ranSql: string | null
  error: unknown
  wallMs: number | null
}

/** How the live editor lets the rest of the app write into it.
 *
 *  The rail sits outside the Query page and outside the router's outlet, but
 *  clicking a table there has to land at the caret — and the caret only exists
 *  inside CodeMirror. So the editor registers this pair while it is mounted, and
 *  anything that wants to put text in a query asks through `insert`. Held in a
 *  ref rather than in state: a caret moves on every keystroke and nothing else
 *  on the page needs to re-render when it does. */
export interface CaretWriter {
  read: () => { doc: string; pos: number }
  write: (insertion: Insertion) => void
}

interface TabsApi {
  tabs: QueryTab[]
  activeId: string
  active: QueryTab | undefined
  open: (sql?: string, database?: string) => void
  /** A new tab that opens on the form rather than on an empty statement. */
  openBuild: (database?: string) => void
  /** Reuse an untouched tab if there is one, so "Open in editor" twice in a
   *  row does not litter the strip. */
  openWith: (sql: string, database?: string) => void
  close: (id: string) => void
  select: (id: string) => void
  patch: (id: string, changes: Partial<QueryTab>) => void
  /** Turn one tab over. See `canSwitch` for when a tab may go back to its
   *  form — this does not check, because the control that offers it does. */
  setMode: (id: string, mode: TabMode) => void
  /** Called by the editor on mount and unmount. */
  bindWriter: (writer: CaretWriter | null) => void
  /** Put text in the query being written. `build` is asked for an insertion
   *  against the live document; with no editor mounted the text is appended to
   *  the active tab instead, which is the same intent without a caret to
   *  honour. */
  insert: (build: (doc: string, pos: number) => Insertion | null) => void
  /** The rail's click on a table, in whichever face the active tab wears: a
   *  reference written at the caret, or the form pointed at the table. */
  pickTable: (database: string, table: string) => void
  /** The rail's click on a column: written at the caret, or asked for. */
  pickColumn: (column: string) => void
}

const TabsContext = createContext<TabsApi | null>(null)

/** Whether a tab may be switched to the form, and what to say when it may not.
 *
 *  The one-way door, stated once. A form can always be turned into a statement,
 *  because that is a translation the product already does on every keystroke.
 *  The other direction is not a translation — nothing in Flint reads SQL back
 *  into a spec — so it is only ever the *return* of a statement that came out
 *  of a form and has not been touched since.
 *
 *  Saying so on the control is the point. A switch that silently kept the form
 *  and dropped your edits, or silently kept the edits and reset the form, would
 *  be the mode switch that eats your work; a disabled switch with a sentence on
 *  it is a door somebody can see is locked. */
export function canSwitch(tab: QueryTab, to: TabMode): { ok: true } | { ok: false; why: string } {
  if (tab.mode === to) return { ok: true }
  if (to === 'sql') return { ok: true }
  if (tab.spec === null) {
    // Nothing typed, nothing to lose: this tab has never been anything.
    if (!tab.sql.trim()) return { ok: true }
    return {
      ok: false,
      why: 'This statement was written by hand, and nothing here reads SQL back into a form. Open a new form tab instead — the + does both.',
    }
  }
  if (!formStillOwns(tab.sql, tab.specSql)) {
    return {
      ok: false,
      why: 'The statement has been edited since the form wrote it, and the form cannot read those edits back. Undo them to return, or keep the SQL.',
    }
  }
  return { ok: true }
}

/** Tabs and the active id are one value on purpose. Held separately they can
 *  disagree — an updater that also calls the other setter is not atomic, and
 *  React double-invokes updaters in development, so `activeId` can end up
 *  naming a tab that was never committed. Then a query's result lands on one
 *  tab while another renders. */
interface TabsState {
  tabs: QueryTab[]
  activeId: string
}

function blank(sql = '', database?: string, mode: TabMode = 'sql'): QueryTab {
  return {
    id: crypto.randomUUID(),
    title: titleFor(sql),
    mode,
    sql,
    // A form tab starts on no table: the pane picks the first one it can see,
    // which needs the database's object list and therefore cannot happen here.
    spec: mode === 'build' ? startingSpec(database ?? '', '') : null,
    specSql: null,
    chart: null,
    database,
    running: false,
    queryId: null,
    result: null,
    ranSql: null,
    error: null,
    wallMs: null,
  }
}

/** Name a tab after what it reads, so a strip of eight tabs is navigable. */
function titleFor(sql: string): string {
  const match = /\bfrom\s+`?([A-Za-z_][\w$]*)`?(?:\.`?([A-Za-z_][\w$]*)`?)?/i.exec(sql)
  return match?.[2] ?? match?.[1] ?? ''
}

/** Editor state lives above the router so navigating to the explorer and back
 *  does not discard your tabs, results or in-flight query. */
export function TabsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<TabsState>(() => {
    const first = blank()
    return { tabs: [first], activeId: first.id }
  })

  // Every id is minted *outside* the updater: an updater that calls
  // `crypto.randomUUID()` is impure and yields a different tab on each of
  // React's two invocations.
  const open = useCallback((sql = '', database?: string) => {
    const tab = blank(sql, database)
    setState((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }))
  }, [])

  const openBuild = useCallback((database?: string) => {
    const tab = blank('', database, 'build')
    setState((s) => {
      // An untouched empty statement is not worth keeping beside a new form —
      // it is the tab Flint opened on, not one anybody made.
      const spare = s.tabs.find((t) => t.mode === 'sql' && !t.sql.trim() && !t.running)
      if (spare) {
        return {
          tabs: s.tabs.map((t) =>
            t.id === spare.id
              ? { ...t, mode: 'build', spec: startingSpec(database ?? t.database ?? '', ''), database: database ?? t.database }
              : t,
          ),
          activeId: spare.id,
        }
      }
      return { tabs: [...s.tabs, tab], activeId: tab.id }
    })
  }, [])

  const openWith = useCallback((sql: string, database?: string) => {
    const fresh = blank(sql, database)
    setState((s) => {
      // A form tab is never "untouched", whatever its statement says: its
      // statement is generated, and overwriting it would leave a form whose
      // question and whose SQL are two different questions.
      const reusable = s.tabs.find((t) => t.mode === 'sql' && !t.sql.trim() && !t.running)
      if (reusable) {
        return {
          tabs: s.tabs.map((t) =>
            t.id === reusable.id ? { ...t, sql, database, title: titleFor(sql) } : t,
          ),
          activeId: reusable.id,
        }
      }
      return { tabs: [...s.tabs, fresh], activeId: fresh.id }
    })
  }, [])

  const close = useCallback((id: string) => {
    setState((s) => {
      if (s.tabs.length === 1) return s
      const index = s.tabs.findIndex((t) => t.id === id)
      const tabs = s.tabs.filter((t) => t.id !== id)
      // Closing the active tab selects its neighbour, not the first tab.
      const activeId =
        s.activeId === id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? s.activeId) : s.activeId
      return { tabs, activeId }
    })
  }, [])

  const select = useCallback((id: string) => {
    setState((s) => (s.activeId === id ? s : { ...s, activeId: id }))
  }, [])

  const patch = useCallback((id: string, changes: Partial<QueryTab>) => {
    setState((s) => ({
      ...s,
      tabs: s.tabs.map((t) => {
        if (t.id !== id) return t
        const next = { ...t, ...changes }
        if (changes.sql !== undefined) next.title = titleFor(changes.sql)
        // A form names its tab before it has generated anything: the table is
        // known the moment it is chosen, and a strip of tabs called "query 3"
        // is a strip nobody can navigate.
        if (next.mode === 'build' && next.spec?.table) next.title = next.spec.table
        return next
      }),
    }))
  }, [])

  const setMode = useCallback((id: string, mode: TabMode) => {
    setState((s) => ({
      ...s,
      tabs: s.tabs.map((t) => {
        if (t.id !== id || t.mode === mode) return t
        if (mode === 'build') {
          return {
            ...t,
            mode,
            spec: t.spec ?? startingSpec(t.database ?? '', ''),
            // Back to the statement the form wrote, which by `canSwitch` is
            // the statement that is already there.
            sql: t.specSql ?? t.sql,
          }
        }
        // Nothing is discarded on the way out. The form stays on the tab, and
        // `specSql` stays beside it, which is what lets the reader come back
        // for as long as they have not typed over the statement.
        return { ...t, mode }
      }),
    }))
  }, [])

  const writer = useRef<CaretWriter | null>(null)
  const bindWriter = useCallback((next: CaretWriter | null) => {
    writer.current = next
  }, [])

  const insert = useCallback((build: (doc: string, pos: number) => Insertion | null) => {
    const live = writer.current
    if (live) {
      const { doc, pos } = live.read()
      const insertion = build(doc, pos)
      if (insertion) live.write(insertion)
      return
    }
    setState((s) => {
      const active = s.tabs.find((t) => t.id === s.activeId)
      if (!active) return s
      // Never into a form tab's mirror: the next keystroke on the form
      // regenerates that statement, so the text would vanish without a word.
      // The rail does not reach here in that case — `pickTable` and
      // `pickColumn` send the same click to the form instead.
      if (active.mode === 'build') return s
      const insertion = build(active.sql, active.sql.length)
      if (!insertion) return s
      const sql =
        active.sql.slice(0, insertion.from) + insertion.text + active.sql.slice(insertion.to)
      return {
        ...s,
        tabs: s.tabs.map((t) => (t.id === active.id ? { ...t, sql, title: titleFor(sql) } : t)),
      }
    })
  }, [])

  const activeTab = state.tabs.find((t) => t.id === state.activeId) ?? state.tabs[0]

  const pickTable = useCallback(
    (database: string, table: string) => {
      if (!activeTab) return
      if (activeTab.mode === 'build') {
        // A different table is a different question: its columns are not this
        // one's, so the projections and filters cannot survive it. The same
        // rule the form has always applied when the table picker changes.
        patch(activeTab.id, { spec: startingSpec(database, table), database, result: null, ranSql: null, error: null })
        return
      }
      insert((doc, pos) => tableInsertion(doc, pos, { database, table }, activeTab.database))
    },
    [activeTab, insert, patch],
  )

  const pickColumn = useCallback(
    (column: string) => {
      if (!activeTab) return
      if (activeTab.mode === 'build') {
        const spec = activeTab.spec
        if (!spec) return
        // Asking for a column twice is not a second question. The click is a
        // no-op rather than an error: the column is already in the answer.
        if (spec.projections.some((p) => p.column === column)) return
        patch(activeTab.id, {
          spec: {
            ...spec,
            projections: [
              ...spec.projections,
              { id: crypto.randomUUID(), column, agg: null, bucket: null },
            ],
          },
        })
        return
      }
      insert((doc, pos) => columnInsertion(doc, pos, column))
    },
    [activeTab, insert, patch],
  )

  const value = useMemo<TabsApi>(
    () => ({
      tabs: state.tabs,
      activeId: state.activeId,
      active: activeTab,
      open,
      openBuild,
      openWith,
      close,
      select,
      patch,
      setMode,
      bindWriter,
      insert,
      pickTable,
      pickColumn,
    }),
    [
      state,
      activeTab,
      open,
      openBuild,
      openWith,
      close,
      select,
      patch,
      setMode,
      bindWriter,
      insert,
      pickTable,
      pickColumn,
    ],
  )

  return <TabsContext.Provider value={value}>{children}</TabsContext.Provider>
}

export function useTabs(): TabsApi {
  const ctx = useContext(TabsContext)
  if (!ctx) throw new Error('useTabs must be used inside TabsProvider')
  return ctx
}
