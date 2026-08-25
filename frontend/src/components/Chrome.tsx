import { Link, NavLink, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import { concerns, countFor } from '../lib/attention'
import { activeSection, countIn, spaceOf, spacesFor } from '../lib/spaces'

import type { AppConfig, ServerInfo } from '../lib/api'
import { uptime } from '../lib/format'

/** The struck flint: a stone edge and the spark off it. */
function Mark() {
  return (
    <svg className="mark" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M9.5 1 3 9h4l-1.5 6L13 6.5H8.5z" fill="currentColor" />
    </svg>
  )
}

export function Chrome({
  config,
  server,
  theme,
  onToggleTheme,
  onFind,
}: {
  config: AppConfig | undefined
  server: ServerInfo | undefined
  theme: 'dark' | 'light'
  onToggleTheme: () => void
  /** Opens the palette. A visible affordance, because a shortcut nobody is
   *  told about is a shortcut nobody uses. */
  onFind: () => void
}) {
  return (
    <header className="chrome">
      <NavLink to="/" className="chrome__brand">
        <Mark />
        <span className="chrome__word">flint</span>
      </NavLink>

      <Nav config={config} />

      {/* The label and the shortcut are dropped on a narrow bar, so an explicit
          name carries over: with the text hidden, the button must still say what
          it is to a screen reader. */}
      <button
        className="chrome__find"
        onClick={onFind}
        title="Find anything (⌘K)"
        aria-label="Find anything"
      >
        <svg className="chrome__glass" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="6.8" cy="6.8" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M10.2 10.2 14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <span className="chrome__findlabel">Find</span>
        <span className="kbd chrome__findkbd">⌘K</span>
      </button>

      <div className="chrome__spacer" />

      {server ? (
        /* Each fact carries its own leading rule, so dropping a fact on a
           narrow bar drops its separator with it — squeezed, they used to
           collapse into a row of stray punctuation. The host is the last to go:
           "which server am I on" is the one you cannot infer from the page. */
        <div className="chrome__facts">
          {[
            {
              key: 'host',
              text: hostOf(config?.endpoint),
              title: config?.endpoint,
            },
            { key: 'user', text: server.current_user, title: 'Connected as' },
            { key: 'version', text: `v${server.version}`, title: 'Server version' },
            {
              key: 'uptime',
              text: `up ${uptime(server.uptime_seconds)}`,
              title: 'Server uptime',
            },
          ].map((fact, i) => (
            <span className={`chrome__fact chrome__fact--${fact.key}`} key={fact.key} title={fact.title}>
              {i > 0 ? <span className="chrome__sep" aria-hidden="true" /> : null}
              {fact.text}
            </span>
          ))}
        </div>
      ) : (
        <span className="chrome__fact chrome__fact--warn">not connected</span>
      )}

      {config?.readonly ? (
        <span className="pill" title="Flint sends readonly=2: writes are refused">
          read-only
        </span>
      ) : null}

      <button
        className="chrome__theme"
        onClick={onToggleTheme}
        title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
        aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      >
        {theme === 'dark' ? '◑' : '◐'}
      </button>
    </header>
  )
}

/** Two spaces, then the sections of the one you are in.
 *
 *  Flat, the twelve destinations read as one undifferentiated list, and
 *  "Dashboards" sat between "Query" and "Diagnose" as though those were the same
 *  kind of thing. They are not the same kind of thing at all: one half of this
 *  product answers questions about rows, the other operates a server. So the bar
 *  says which half you are in before it says where in it you are — see
 *  `lib/spaces` for where the line falls and why.
 *
 *  Where a deployment has only Data, the switcher is not rendered at all: a
 *  chooser with one choice is furniture. That is the whole visible difference for
 *  anyone who runs Flint the way it has always run. */
function Nav({ config }: { config: AppConfig | undefined }) {
  const { pathname } = useLocation()
  const spaces = spacesFor(config)
  /* A path can name a space this deployment does not have — a bookmark from
     before Infrastructure was switched off. The router sends it back to Data;
     the bar must not light a tab for the space it is leaving. */
  const here = spaces.find((s) => s.id === spaceOf(pathname)) ?? spaces[0]

  /* Only where Flint keeps anything, and cached: this rides along on every
     page, so it must not be a request per navigation. */
  const watching = Boolean(config?.workspace)
  const alerts = useQuery({
    queryKey: ['alerts'],
    queryFn: () => api.alerts(),
    enabled: watching,
    staleTime: 60_000,
    retry: false,
  })
  const reports = useQuery({
    queryKey: ['reports'],
    queryFn: () => api.reports(),
    enabled: watching,
    staleTime: 60_000,
    retry: false,
  })
  /* Needs no workspace — it is a read of `system.replicas` — but it does need
     somewhere to be shown, and with Infrastructure switched off there is
     nowhere. Shares the cache entry the replication page uses. */
  const replication = useQuery({
    queryKey: ['replication'],
    queryFn: () => api.replication(),
    enabled: spaces.length > 1,
    staleTime: 60_000,
    retry: false,
  })
  const items = concerns({
    alerts: alerts.data,
    reports: reports.data,
    replication: replication.data,
  })
  const at = activeSection(pathname)

  return (
    <div className="chrome__nav">
      {spaces.length > 1 ? (
        <nav className="chrome__spaces" aria-label="Spaces">
          {spaces.map((space) => (
            <Link
              key={space.id}
              to={space.home}
              className={`chrome__space${here.id === space.id ? ' active' : ''}`}
              /* Not `aria-current="page"`: the space is the section of the site
                 you are in, not the page you are on — and the page link below
                 says that already. */
              aria-current={here.id === space.id ? 'true' : undefined}
            >
              {space.label}
              <Badge count={countIn(items, space.id)} />
            </Link>
          ))}
        </nav>
      ) : null}
      <nav className="chrome__sections" aria-label={`${here.label} sections`}>
        {here.sections.map((item) => (
          <NavLink
            key={item.id}
            to={item.to}
            className={`chrome__link${at === item.id ? ' active' : ''}`}
          >
            {item.label}
            {item.badge ? <Badge count={countFor(items, item.badge)} /> : null}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}

/** Nothing at zero. An indicator that is always lit is not an indicator, and
 *  the number is the point — "3" is actionable where a dot is not. */
function Badge({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span className="chrome__badge" aria-label={`${count} needing attention`}>
      {count}
    </span>
  )
}

function hostOf(endpoint: string | undefined): string {
  if (!endpoint) return '—'
  try {
    const url = new URL(endpoint)
    return url.port ? `${url.hostname}:${url.port}` : url.hostname
  } catch {
    return endpoint
  }
}
