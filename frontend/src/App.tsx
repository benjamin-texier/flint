import { Suspense, lazy, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Navigate, Route, Routes, useParams } from 'react-router-dom'

import { api } from './lib/api'
import { rememberedDatabase, resolveDatabase } from './lib/database'
import { Chrome } from './components/Chrome'
import { Palette, usePaletteShortcut } from './components/Palette'
import { ExplorerRail } from './components/ExplorerRail'
import { ServerPage } from './routes/ServerPage'
import { DatabasePage } from './routes/DatabasePage'
import { TableView } from './routes/TableView'
import { TabsProvider } from './editor/tabs'
import { ErrorNote, Loading } from './components/Note'

// CodeMirror is two thirds of the bundle and the schema is the landing
// surface, so the editor loads only once someone opens a query tab.
const Editor = lazy(() => import('./routes/Editor').then((m) => ({ default: m.Editor })))
const Builder = lazy(() => import('./routes/Builder').then((m) => ({ default: m.Builder })))
const DashboardList = lazy(() =>
  import('./routes/Dashboards').then((m) => ({ default: m.DashboardList })),
)
const DashboardView = lazy(() =>
  import('./routes/Dashboards').then((m) => ({ default: m.DashboardView })),
)
const DiagnosePage = lazy(() =>
  import('./routes/Diagnose').then((m) => ({ default: m.DiagnosePage })),
)
const AlertsPage = lazy(() =>
  import('./routes/Alerts').then((m) => ({ default: m.AlertsPage })),
)
const ReportsPage = lazy(() =>
  import('./routes/Reports').then((m) => ({ default: m.ReportsPage })),
)
const PublishPage = lazy(() =>
  import('./routes/Publish').then((m) => ({ default: m.PublishPage })),
)

type Theme = 'dark' | 'light'

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem('flint.theme')
      if (saved === 'dark' || saved === 'light') return saved
    } catch {
      /* private browsing, blocked storage — fall through to the default */
    }
    // Light unless the system asks for dark: Flint sits next to a browser full
    // of dashboards, not in a night-time editor.
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('flint.theme', theme)
    } catch {
      /* nothing to do: the theme still applies for this session */
    }
  }, [theme])

  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))]
}

export function App() {
  const [theme, toggleTheme] = useTheme()
  const [paletteOpen, setPaletteOpen] = useState(false)
  usePaletteShortcut(() => setPaletteOpen(true))
  const config = useQuery({ queryKey: ['config'], queryFn: api.config })
  // The server may be unreachable; the chrome says so rather than the app
  // failing to render.
  const server = useQuery({ queryKey: ['server'], queryFn: api.server, retry: 1 })

  return (
    <TabsProvider>
      <div className="shell">
        {/* The rail lists every object in the database — 162 focusable things on
            a real schema, which is 170 Tab presses between the top of the page
            and the content. WCAG calls a way past a repeated block a level A
            requirement, and it was missing. */}
        <a className="skip" href="#main">
          Skip to content
        </a>
        <Chrome
          config={config.data}
          server={server.data}
          theme={theme}
          onToggleTheme={toggleTheme}
          onFind={() => setPaletteOpen(true)}
        />
        <Palette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
        <div className="shell__body">
          <ExplorerRail />
          <main className="shell__main" id="main" tabIndex={-1}>
            <Routes>
              <Route path="/" element={<LandingRoute />} />
              <Route path="/server" element={<ServerPage />} />
              <Route path="/db/:database" element={<DatabaseRoute />} />
              <Route path="/db/:database/:table" element={<TableRoute />} />
              <Route
                path="/dash"
                element={
                  <Suspense fallback={<Loading label="Loading dashboards" />}>
                    <DashboardList />
                  </Suspense>
                }
              />
              <Route
                path="/dash/:id"
                element={
                  <Suspense fallback={<Loading label="Loading the dashboard" />}>
                    <DashboardView />
                  </Suspense>
                }
              />
              <Route
                path="/build"
                element={
                  <Suspense fallback={<Loading label="Loading the builder" />}>
                    <Builder />
                  </Suspense>
                }
              />
              <Route
                path="/query"
                element={
                  <Suspense fallback={<Loading label="Loading the editor" />}>
                    <Editor />
                  </Suspense>
                }
              />
              <Route
                path="/diagnose"
                element={
                  <Suspense fallback={<Loading label="Reading system tables" />}>
                    <DiagnosePage />
                  </Suspense>
                }
              />
              <Route
                path="/alerts"
                element={
                  <Suspense fallback={<Loading label="Reading alerts" />}>
                    <AlertsPage />
                  </Suspense>
                }
              />
              <Route
                path="/reports"
                element={
                  <Suspense fallback={<Loading label="Reading reports" />}>
                    <ReportsPage />
                  </Suspense>
                }
              />
              <Route
                path="/apis"
                element={
                  <Suspense fallback={<Loading label="Reading endpoints" />}>
                    <PublishPage />
                  </Suspense>
                }
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
        </div>
      </div>
    </TabsProvider>
  )
}

/** Flint opens on a database, never on an inventory screen. Which one: the last
 *  you looked at, else the fullest that is yours rather than ClickHouse's. */
function LandingRoute() {
  const databases = useQuery({ queryKey: ['databases'], queryFn: api.databases })

  if (databases.error)
    return <ErrorNote error={databases.error} retry={() => databases.refetch()} />
  if (!databases.data) return <Loading label="Finding your data" />

  const target = resolveDatabase(databases.data, rememberedDatabase())
  if (!target) return <Navigate to="/server" replace />
  return <Navigate to={`/db/${encodeURIComponent(target)}`} replace />
}

function DatabaseRoute() {
  const { database } = useParams()
  if (!database) return <Navigate to="/" replace />
  return <DatabasePage database={database} />
}

function TableRoute() {
  const { database, table } = useParams()
  if (!database || !table) return <Navigate to="/" replace />
  return <TableView database={database} table={table} />
}
