import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../lib/api'
import { concerns, countFor } from '../lib/attention'
import {
  activeSection,
  countIn,
  dataFor,
  keeps,
  outsideSpaces,
  spaceOf,
  spacesFor,
} from '../lib/spaces'

import type { AppConfig, ServerInfo, Session } from '../lib/api'
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
  session,
  theme,
  onToggleTheme,
  onFind,
}: {
  config: AppConfig | undefined
  server: ServerInfo | undefined
  session: Session | undefined
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

      {/* Beside Find rather than in either space's sections, because it is in
          neither — see `outsideSpaces`. Its position says so: everything to
          the left of the spacer is about the whole of Flint. */}
      <NavLink to="/checkup" className="chrome__checkup">
        Checkup
      </NavLink>

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
              /* The session's server, not the deployment's. On an unpinned
                 Flint they are not the same question: the manifest names
                 nothing, and two tabs signed in to two ClickHouses would
                 otherwise both claim to be on whichever one the config
                 mentioned. Falls back to the config for a Flint with no
                 sign-in, where the session says nothing. */
              text: hostOf(session?.endpoint ?? config?.endpoint),
              title: session?.endpoint ?? config?.endpoint ?? undefined,
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

      {/* Before the read-only pill, because it is the larger fact about this
          deployment: read-only says what Flint may do to your data, stateless
          says whether Flint is keeping anything of its own. */}
      {config && config.workspace === null ? <Stateless /> : null}

      {config?.readonly ? (
        <span className="pill" title="Flint sends readonly=2: writes are refused">
          read-only
        </span>
      ) : null}

      {/* Only where signing in is a thing. Beside the identity the facts strip
          already shows, because "you are analyst" and "stop being analyst"
          belong together — and a sign-out button on a deployment nobody signs
          into is a control that can only confuse. */}
      {session?.required ? <SignOut user={session.user} /> : null}

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
  const here = spaces.find((s) => s.id === spaceOf(pathname)) ?? dataFor(config)
  /* The checkup is in neither space, so neither tab lights and no section row
     is drawn. Lighting Data — which the prefix rule would do, since the rule's
     answer for anything outside `/infra` is Data — would tell a reader they
     are somewhere they are not. */
  const outside = outsideSpaces(pathname)

  /* Only where Flint keeps anything, and cached: this rides along on every
     page, so it must not be a request per navigation. */
  const watching = keeps(config)
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
              className={`chrome__space${!outside && here.id === space.id ? ' active' : ''}`}
              /* Not `aria-current="page"`: the space is the section of the site
                 you are in, not the page you are on — and the page link below
                 says that already. */
              aria-current={!outside && here.id === space.id ? 'true' : undefined}
            >
              {space.label}
              <Badge count={countIn(items, space.id)} />
            </Link>
          ))}
          <span className="chrome__navsep" aria-hidden="true" />
        </nav>
      ) : null}
      <nav className="chrome__sections" aria-label={`${here.label} sections`}>
        {(outside ? [] : here.sections).map((item) => (
          <NavLink
            key={item.id}
            to={item.to}
            /* `end` for the one section whose path is the stem of its siblings.
               NavLink adds its own `active` class *and* `aria-current="page"`
               on top of ours whenever the URL is under `to`, so without this
               `/infra/health` lit two tabs and announced two current pages —
               and a screen reader that is told twice where it is has been told
               nothing. `lib/spaces` decides which section that is; the bar only
               honours it. */
            end={item.exact}
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

/** The bar's one word for a Flint that keeps nothing, and the line that changes
 *  it.
 *
 *  Without `FLINT_WORKSPACE_DATABASE` four sections are absent from the nav
 *  (`lib/spaces` says which and why), and an absence with no explanation is
 *  indistinguishable from a build that lost them. This is that explanation,
 *  put where it is true on every page rather than repeated on the four pages
 *  nobody can now reach through the bar.
 *
 *  Stated as a mode and not as a fault: running stateless is a supported way to
 *  run Flint — it touches nothing, which is exactly what some deployments want
 *  — so the pill is quiet, and what it opens is an invitation rather than a
 *  remedy. */
function Stateless() {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="stateless" ref={wrap}>
      <button
        className="pill stateless__pill"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="This Flint has no workspace — nothing is stored"
      >
        <span className="stateless__dot" aria-hidden="true" />
        no workspace
      </button>

      {open ? (
        <div className="stateless__panel" role="dialog" aria-label="Running without a workspace">
          <p className="stateless__title">Flint is keeping nothing</p>
          <p className="stateless__note">
            No database was named for Flint's own metadata, so it writes nothing at all.
            Dashboards, Alerts, Reports and APIs are things it would have to keep, and they are
            out of the bar rather than in it and failing.
          </p>
          <p className="stateless__note">
            Explore, Query, Build and Diagnostics are unaffected: reading your server needs no
            workspace.
          </p>
          <p className="stateless__lede">Name one and the four come back:</p>
          <pre className="stateless__env">FLINT_WORKSPACE_DATABASE=flint</pre>
          <p className="stateless__note">
            Any database Flint's account may create tables in — it creates its own on startup,
            and touches nothing else. Restart to pick it up.
          </p>
        </div>
      ) : null}
    </div>
  )
}

/** Sign out, and go back to the sign-in screen.
 *
 *  The session query is invalidated rather than the page reloaded: React Query
 *  then re-asks who you are, gets "nobody", and `App` swaps the whole shell for
 *  the sign-in screen. The cache is cleared with it — everything in it was
 *  filtered by the grants of the person who just left. */
function SignOut({ user }: { user: string | null }) {
  const queryClient = useQueryClient()
  const out = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      /* Only the session, deliberately. Asking who you are is enough: it comes
         back "nobody", `App` swaps in the sign-in screen, and every other query
         is unmounted with it. Resetting them all instead sent a burst of
         requests that were refused — eight 401s in the console on the way out,
         for answers nothing was going to render. The stale grant-filtered cache
         is forgotten on the next sign-in, which is the moment it could
         actually be seen by somebody else. */
      queryClient.invalidateQueries({ queryKey: ['session'] })
    },
  })
  return (
    <button
      className="chrome__signout"
      onClick={() => out.mutate()}
      disabled={out.isPending}
      title={user ? `Signed in as ${user}` : 'Sign out'}
    >
      Sign out
    </button>
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

function hostOf(endpoint: string | null | undefined): string {
  if (!endpoint) return '—'
  try {
    const url = new URL(endpoint)
    return url.port ? `${url.hostname}:${url.port}` : url.hostname
  } catch {
    return endpoint
  }
}
