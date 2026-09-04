import { Suspense, lazy, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom'

import { api } from './lib/api'
import { rememberedDatabase, resolveDatabase } from './lib/database'
import { Chrome } from './components/Chrome'
import { spaceOf, spacesFor } from './lib/spaces'
import { Palette, usePaletteShortcut } from './components/Palette'
import { Console } from './components/Console'
import { AlertsRail } from './components/AlertsRail'
import { ExplorerRail } from './components/ExplorerRail'
import { CheckupPage } from './routes/Checkup'
import { ServerPage } from './routes/ServerPage'
import { OverviewPage } from './routes/Overview'
import { DatabasePage } from './routes/DatabasePage'
import { TableView } from './routes/TableView'
import { TabsProvider } from './editor/tabs'
import { ErrorNote, Loading } from './components/Note'
import { OutageBar, OutageScreen, useReach } from './components/Reach'
import { admits } from './lib/session'
import { SignIn } from './routes/SignIn'

// CodeMirror is two thirds of the bundle and the schema is the landing
// surface, so the editor loads only once someone opens a query tab.
const Editor = lazy(() => import('./routes/Editor').then((m) => ({ default: m.Editor })))
const DashboardList = lazy(() =>
  import('./routes/Dashboards').then((m) => ({ default: m.DashboardList })),
)
const DashboardView = lazy(() =>
  import('./routes/Dashboards').then((m) => ({ default: m.DashboardView })),
)
const DiagnosePage = lazy(() =>
  import('./routes/Diagnose').then((m) => ({ default: m.DiagnosePage })),
)
// Infrastructure. Lazy like the rest, and for one extra reason: a deployment
// that switched the space off should not pay for its code.
const HealthPage = lazy(() => import('./routes/Health').then((m) => ({ default: m.HealthPage })))
const PipelinesPage = lazy(() =>
  import('./routes/Pipelines').then((m) => ({ default: m.PipelinesPage })),
)
const ClusterPage = lazy(() => import('./routes/Cluster').then((m) => ({ default: m.ClusterPage })))
const AccessPage = lazy(() => import('./routes/Access').then((m) => ({ default: m.AccessPage })))
const AuditPage = lazy(() => import('./routes/Audit').then((m) => ({ default: m.AuditPage })))
const ConfigPage = lazy(() => import('./routes/Config').then((m) => ({ default: m.ConfigPage })))
const SchemaPage = lazy(() => import('./routes/Schema').then((m) => ({ default: m.SchemaPage })))
const BackupsPage = lazy(() =>
  import('./routes/Backups').then((m) => ({ default: m.BackupsPage })),
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
const PublishEndpointPage = lazy(() =>
  import('./routes/PublishEndpoint').then((m) => ({ default: m.PublishEndpointPage })),
)
/* Data's own board. Lazy for the same reason as the rest, and absent for the
   same reason as the four sections it summarises: a Flint with no workspace
   keeps nothing for it to list. */

/* The landing. Lazy like the rest, and it pulls `/checkup` in with it — they
   share the component that draws a finding, deliberately, so that two pages
   cannot drift apart on what a finding looks like. */
const ArrivalPage = lazy(() =>
  import('./routes/Arrival').then((m) => ({ default: m.ArrivalPage })),
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
  /* Whether there is a backend at all. Read before anything else is decided:
     the answers below — sign in, boot, render the shell — are all answers to
     "what should this person do now", and "nothing, the server is not there"
     outranks every one of them. */
  const reach = useReach()
  const config = useQuery({ queryKey: ['config'], queryFn: api.config })
  /* Who is asking. Never stale for long: a session can end while the tab sits
     open, and the answer decides whether there is an app to show at all. */
  const session = useQuery({ queryKey: ['session'], queryFn: api.session, staleTime: 10_000 })
  /* Signed in, or on a deployment that asks nobody to. Three answers, not two —
     see `lib/session`. */
  const admitted = admits(session.data)
  /* The server may be unreachable; the chrome says so rather than the app
     failing to render. Waits for admission, though — asked before it, this is
     one guaranteed 401 on every cold load of a Flint that requires signing in,
     and one spurious "your session ended" for a session that never began. */
  const server = useQuery({
    queryKey: ['server'],
    queryFn: api.server,
    retry: 1,
    enabled: admitted,
  })
  /* Whether the Infrastructure half of the product exists here at all —
     undefined until the config lands, which is a third answer and not a no.
     Asked once, at the top, because it decides both the bar and the routes, and
     they must not disagree: a link the nav shows and the router refuses is
     worse than either alone. */
  const infrastructure = config.data ? spacesFor(config.data).length > 1 : undefined
  const { pathname } = useLocation()

  /* Whether this page carries a rail — asked once, because two things need the
     answer and they were disagreeing. The rail is 264px of the left edge; the
     console launcher is fixed to the bottom-left corner and was sitting on top
     of the rail's last object and half of its "All databases" link on every
     Data page that has one. The launcher is not the rail's furniture, so it
     steps past it rather than the rail making room. */
  const railed = spaceOf(pathname) === 'data' && pathname !== '/home' && pathname !== '/'

  /* Nothing renders until both answers are in. A flash of the app followed by
     a sign-in screen would show a moment of somebody else's data — and worse, a
     flash of the sign-in screen on a deployment that requires no sign-in makes
     Flint look broken to everyone who has never needed one. */
  if (config.isPending || session.isPending) return <Boot />
  /* Nothing to show and no way to get it: the tab was opened onto a Flint that
     is not running. Before the sign-in screen on purpose — with the backend
     down, `session` is a failed request rather than "nobody is signed in", and
     asking for credentials that cannot be checked is a screen that blames the
     reader for the server. */
  if (reach.outage && !config.data) return <OutageScreen outage={reach.outage} since={reach.since} />
  if (!admitted) return <SignIn config={config.data} />

  return (
    <TabsProvider>
      <div className={`shell${railed ? ' shell--railed' : ''}`}>
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
          session={session.data}
          theme={theme}
          onToggleTheme={toggleTheme}
          onFind={() => setPaletteOpen(true)}
        />
        {/* Under the chrome and over everything else: the facts in the bar above
            it are from before the outage, and the pages below it are about to
            start saying they are waiting. */}
        {reach.outage ? <OutageBar outage={reach.outage} since={reach.since} /> : null}
        <Palette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
        <div className="shell__body">
          {/* The rail lists the objects in a database, which is a Data
              navigator: on an Infrastructure page it is the other product's
              furniture, and it costs the wide tables there 264px they need.
              Read off the URL rather than off the config, so it disappears the
              instant you cross over rather than a request later. */}
          {/* And a page may own its rail. The explorer is the Data space's
              default because most of its pages are about objects; the alerts
              are not, and a list of tables beside a list of alerts is a rail
              nothing on which answers a question the reader has. */}
          {/* And the home owns none at all: it is a board about what Flint
              keeps, not a way of browsing objects, and it carries its own two
              ways into the schema in its header. */}
          {/* And the arrival owns none either, for the reason the home owns
              none: it is a board about the *server*, not a way of browsing the
              objects on it, and a list of 162 tables beside a verdict is a rail
              on which nothing answers the question the reader has. It ends with
              its own way into the schema. */}
          {railed ? (
            pathname.startsWith('/alerts') ? (
              <AlertsRail />
            ) : (
              <ExplorerRail />
            )
          ) : null}
          <main className="shell__main" id="main" tabIndex={-1}>
            <Routes>
              {/* What Flint found, before anybody asked. `/` used to redirect
                  to a database, which answers what *exists* — and nobody's
                  first question about their own server is what exists. The
                  database is one click away and the page ends with it. */}
              <Route
                path="/"
                element={
                  <Suspense fallback={<Loading label="Reading this server" />}>
                    <ArrivalPage />
                  </Suspense>
                }
              />
              {/* Where the landing used to go. Kept as its own address because
                  it is in bookmarks, and because "take me straight to the
                  schema" is a reasonable thing to want a link for. */}
              <Route path="/explore" element={<LandingRoute />} />
              {/* Data's board was here. It is a section of the arrival now —
                  one home rather than two — and the address stays because it is
                  in bookmarks. */}
              <Route path="/home" element={<Navigate to="/" replace />} />
              {/* Neither space's, deliberately — see `outsideSpaces` in
                  `lib/spaces`. It reports on both and holds no controls. */}
              <Route path="/checkup" element={<CheckupPage />} />
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
              {/* Where the form used to live. It is a face of the query page
                  now, not a page — but the path is in bookmarks and in links
                  people have sent each other, so it still lands on the form. */}
              <Route path="/build" element={<Navigate to="/query?mode=build" replace />} />
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
              {/* One address, in full: its contract beside what has actually
                  been happening to it. */}
              <Route
                path="/apis/:slug"
                element={
                  <Suspense fallback={<Loading label="Reading the endpoint" />}>
                    <PublishEndpointPage />
                  </Suspense>
                }
              />
              {/* The routes exist whatever the answer; `InfraRoute` is what
                  makes "off" mean absent. Deciding out here instead sent every
                  direct link to /infra/* back to Data on the first render,
                  before the config had arrived to say otherwise. */}
              <Route
                path="/infra/health"
                element={
                  <InfraRoute allowed={infrastructure} label="Reading system tables">
                    <HealthPage />
                  </InfraRoute>
                }
              />
              <Route
                path="/infra/pipelines"
                element={
                  <InfraRoute allowed={infrastructure} label="Reading the views">
                    <PipelinesPage />
                  </InfraRoute>
                }
              />
              <Route
                path="/infra/cluster"
                element={
                  <InfraRoute allowed={infrastructure} label="Reading the cluster">
                    <ClusterPage />
                  </InfraRoute>
                }
              />
              {/* The path this section had when it was only about replicas. In
                  bookmarks, and in alert webhooks already delivered. */}
              <Route path="/infra/replication" element={<Navigate to="/infra/cluster" replace />} />
              <Route
                path="/infra/schema"
                element={
                  <InfraRoute allowed={infrastructure} label="Reading the schema">
                    <SchemaPage />
                  </InfraRoute>
                }
              />
              <Route
                path="/infra/backups"
                element={
                  <InfraRoute allowed={infrastructure} label="Reading the backup log">
                    <BackupsPage />
                  </InfraRoute>
                }
              />
              <Route
                path="/infra/access"
                element={
                  <InfraRoute allowed={infrastructure} label="Reading access control">
                    <AccessPage />
                  </InfraRoute>
                }
              />
              <Route
                path="/infra/audit"
                element={
                  <InfraRoute allowed={infrastructure} label="Reading the trail">
                    <AuditPage />
                  </InfraRoute>
                }
              />
              <Route
                path="/infra/config"
                element={
                  <InfraRoute allowed={infrastructure} label="Reading the configuration">
                    <ConfigPage />
                  </InfraRoute>
                }
              />
              {/* The first page of the space, rather than a redirect into the busiest
                  one. `/infra/health` is the right page for working on the server and
                  the wrong one for finding out whether you need to. */}
              <Route
                path="/infra"
                element={
                  <InfraRoute allowed={infrastructure} label="Reading the server">
                    <OverviewPage />
                  </InfraRoute>
                }
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
        </div>
        {/* Outside `<Routes>` and never unmounted, which is the whole of the
            feature: the transcript, the draft and the query still in flight
            belong to the session rather than to the page you happened to be on
            when you started them. Last in the shell so it sits over everything
            without a stacking context to fight. */}
        <Console />
      </div>
    </TabsProvider>
  )
}

/** The pause before Flint knows whether it has to ask who you are.
 *
 *  Deliberately almost nothing: this is a few hundred milliseconds on a local
 *  connection, and a spinner big enough to notice is a spinner you notice
 *  flickering. */
function Boot() {
  return (
    <div className="boot">
      <Loading label="Starting Flint" />
    </div>
  )
}

/** An Infrastructure page, or nothing at all.
 *
 *  Three answers, not two. `true` renders the page; `false` sends it to Data,
 *  which is what "the space is absent here" means for a URL somebody typed or
 *  bookmarked; `undefined` means the config has not arrived yet and holds,
 *  because guessing sent every direct link to an Infrastructure page straight
 *  back to Data — the bar lighting Explore on a page nobody asked for.
 *
 *  The redirect returns before the lazy element is rendered, so a deployment
 *  with the space switched off never fetches its chunk either. */
function InfraRoute({
  allowed,
  label,
  children,
}: {
  allowed: boolean | undefined
  label: string
  children: React.ReactNode
}) {
  if (allowed === undefined) return <Loading label="Checking what this deployment allows" />
  if (!allowed) return <Navigate to="/" replace />
  return <Suspense fallback={<Loading label={label} />}>{children}</Suspense>
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
