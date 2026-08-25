import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

import type { QueryResult } from '../lib/api'

export interface QueryTab {
  id: string
  title: string
  sql: string
  database: string | undefined
  running: boolean
  queryId: string | null
  result: QueryResult | null
  error: unknown
  wallMs: number | null
}

interface TabsApi {
  tabs: QueryTab[]
  activeId: string
  active: QueryTab | undefined
  open: (sql?: string, database?: string) => void
  /** Reuse an untouched tab if there is one, so "Open in editor" twice in a
   *  row does not litter the strip. */
  openWith: (sql: string, database?: string) => void
  close: (id: string) => void
  select: (id: string) => void
  patch: (id: string, changes: Partial<QueryTab>) => void
}

const TabsContext = createContext<TabsApi | null>(null)

/** Tabs and the active id are one value on purpose. Held separately they can
 *  disagree — an updater that also calls the other setter is not atomic, and
 *  React double-invokes updaters in development, so `activeId` can end up
 *  naming a tab that was never committed. Then a query's result lands on one
 *  tab while another renders. */
interface TabsState {
  tabs: QueryTab[]
  activeId: string
}

function blank(sql = '', database?: string): QueryTab {
  return {
    id: crypto.randomUUID(),
    title: titleFor(sql),
    sql,
    database,
    running: false,
    queryId: null,
    result: null,
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

  const openWith = useCallback((sql: string, database?: string) => {
    const fresh = blank(sql, database)
    setState((s) => {
      const reusable = s.tabs.find((t) => !t.sql.trim() && !t.running)
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
        return next
      }),
    }))
  }, [])

  const value = useMemo<TabsApi>(
    () => ({
      tabs: state.tabs,
      activeId: state.activeId,
      active: state.tabs.find((t) => t.id === state.activeId) ?? state.tabs[0],
      open,
      openWith,
      close,
      select,
      patch,
    }),
    [state, open, openWith, close, select, patch],
  )

  return <TabsContext.Provider value={value}>{children}</TabsContext.Provider>
}

export function useTabs(): TabsApi {
  const ctx = useContext(TabsContext)
  if (!ctx) throw new Error('useTabs must be used inside TabsProvider')
  return ctx
}
