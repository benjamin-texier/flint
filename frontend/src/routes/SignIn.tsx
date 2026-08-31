import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { api, FlintError, type AppConfig } from '../lib/api'
import { parseDsn, worthSplitting } from '../lib/dsn'
import {
  capabilities,
  CHECKS,
  consequences,
  detected,
  reached,
  said,
  type Capability,
  type Preflight,
} from '../lib/preflight'

/** The sign-in screen, which is the whole page or nothing.
 *
 *  Not a modal over the app: there is no app behind it to look at, because every
 *  route needs a session and none of them can answer without one. A dialog would
 *  imply otherwise, and dashboards showing through a blur while saying "sign in"
 *  is a promise the backend does not keep. The bar across the top is not that
 *  app — it is the brand and one word about the connection, which is the one
 *  thing this screen can honestly say before anybody signs in.
 *
 *  The credentials are **ClickHouse's** — Flint has no users of its own — and the
 *  screen says so, because "username and password" with no further explanation
 *  invites people to invent an account that does not exist and then wonder why it
 *  is rejected. The host is named for the same reason: signing in to the wrong
 *  server is an easy mistake to make and an expensive one to diagnose.
 *
 *  **The interesting failure is not a refusal.** A wrong password is a wrong
 *  password and the form has always said so. Credentials that are *accepted* and
 *  then cannot read `system.query_log`, or land on a server whose session log is
 *  switched off, or on a Flint with no backup disk — those used to be discovered
 *  three clicks past this screen, as a page that loads and says nothing. So the
 *  panel on the right runs the reads Flint's own sections are built on, as the
 *  credentials on the form, *before* the session exists: see
 *  `src/clickhouse/preflight.rs` for the measurement and `lib/preflight` for
 *  what any of it means.
 *
 *  It is asked on **blur**, not on keystroke. A debounce would send the password
 *  to an address the browser named every time somebody paused mid-word; leaving
 *  a field is one deliberate "I have finished with this", and the last triple
 *  asked about is remembered so tabbing back and forth does not ask again. */
export function SignIn({ config }: { config: AppConfig | undefined }) {
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [endpoint, setEndpoint] = useState('')
  /* Whether the password is legible. A database password is typically pasted
     from somewhere else or typed from memory once a month, and the only way to
     check it before spending a round trip is to look at it. */
  const [shown, setShown] = useState(false)
  /* What a pasted connection string turned into. Held rather than derived,
     because it describes an event — "this is what I did with what you pasted" —
     and the moment somebody edits the field again it stops being true. */
  const [split, setSplit] = useState<string | null>(null)
  const queryClient = useQueryClient()

  /* Where the server comes from, which is the one thing that changes the shape
     of this screen. Undefined config means the request for it failed, and the
     pinned form is the safe reading: an endpoint field submitted to a pinned
     Flint is refused, so guessing the other way would put a control here that
     cannot work. */
  const unpinned = config ? !config.pinned : false
  const ready = user.trim() !== '' && (!unpinned || endpoint.trim() !== '')

  const signIn = useMutation({
    mutationFn: () => api.login(user, password, unpinned ? endpoint : undefined),
    onSuccess: () => {
      /* Everything cached was fetched as nobody, or as somebody else, and the
         answers are grant-filtered — so the cache is not merely stale, it is
         about a different person. `resetQueries` is the one that both forgets
         it and asks again: `clear()` drops the entries without re-subscribing
         the observers watching them, which left this very screen up after a
         successful sign-in because nothing ever re-asked who you were. */
      queryClient.resetQueries()
    },
  })

  const probe = useMutation({
    mutationFn: () => api.preflight(user, password, unpinned ? endpoint : undefined),
  })

  /* What the panel is currently about. Compared rather than watched, so that a
     reading stays on screen while somebody edits the field under it — it is
     dimmed and offers to run again, because clearing the answer they just read
     is the one thing worse than showing them a stale one. */
  const key = JSON.stringify([unpinned ? endpoint.trim() : '', user.trim(), password])
  /* State rather than a ref, though nothing renders the key itself: `stale` is
     derived from it and `stale` is on the screen, so a change that does not
     cause a render is a panel that lies. It happens to work as a ref today —
     every path that writes it also starts a mutation, which renders — and that
     is exactly the kind of accident that stops being true. */
  const [asked, setAsked] = useState<string | null>(null)
  const stale = asked !== null && asked !== key

  /* Which fields have to have been visited before Flint asks anything.
   *
   * Found in the browser rather than reasoned about: probing on *any* blur
   * meant that tabbing out of the user field fired a probe with the password
   * still empty, so every user who has a password watched the panel go red
   * before they had finished filling the form in. Nothing about the code was
   * wrong; the rule was. So the rule is now "once you have been through the
   * form" — the probe fires on the blur that completes the set, and on every
   * blur after that where something has actually changed.
   *
   * Password is in the set even though an empty one is legitimate: what matters
   * is that somebody has *been* there, not what they left behind. */
  const needed = unpinned ? ['endpoint', 'user', 'password'] : ['user', 'password']
  const [touched, setTouched] = useState<string[]>([])
  const been = needed.every((field) => touched.includes(field))

  const run = () => {
    if (!ready || asked === key) return
    setAsked(key)
    probe.mutate()
  }
  const leave = (field: string) => {
    const seen = touched.includes(field) ? touched : [...touched, field]
    if (seen.length !== touched.length) setTouched(seen)
    if (needed.every((f) => seen.includes(f))) run()
  }

  const submit = () => {
    /* An empty endpoint is refused by the server with the right words, but a
       form that posts a request it knows will fail spends a round trip to say
       what it could have said itself. */
    if (ready && !signIn.isPending) signIn.mutate()
  }

  /* ⌘↵ from anywhere on the page, which is the point of advertising it: Enter
     already submits from inside a field, and a shortcut that only repeats the
     default is noise. This one works with the focus in the panel, or nowhere —
     which is where it is after somebody has read the panel. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        submit()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    /* No dependency list on purpose: the handler closes over the fields, and a
       list would either be every one of them or a stale submit. Re-attaching
       one listener per render is cheaper than either. */
  })

  const refused = signIn.error instanceof FlintError && signIn.error.status === 401
  /* Some failures name their own cause. `not_clickhouse` is the whole sentence
     already — "what answered is not ClickHouse" — and following it with "this is
     not a credential problem" says the same thing a second time, worse. The hint
     exists to stop somebody retyping a password that was fine; a message that
     has already said where to look does not need it. */
  const explains = signIn.error instanceof FlintError && signIn.error.kind === 'not_clickhouse'
  const message =
    signIn.error instanceof Error ? signIn.error.message : signIn.error ? String(signIn.error) : null

  return (
    <div className="signin">
      {/* Not the app's chrome — that needs a session to fill. The brand, and the
          one fact this screen can state without one. */}
      <header className="signin__bar">
        <div className="signin__brand">
          <svg className="mark" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M9.5 1 3 9h4l-1.5 6L13 6.5H8.5z" fill="currentColor" />
          </svg>
          <span className="signin__word">flint</span>
        </div>
        <span className="signin__state">{unpinned ? 'not connected' : hostOf(config?.endpoint)}</span>
      </header>

      <div className="signin__body">
        <form
          className="signin__form"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <h1 className="signin__title">{unpinned ? 'Point Flint at a server' : 'Sign in'}</h1>
          {/* Two paragraphs' worth in two sentences, and the second one is the
              useful surprise: people reach for an admin account because a tool
              asking for a database password usually wants one. Read-only is
              enough for the whole of Data, and Flint's own bookkeeping is
              written with Flint's account rather than with yours. */}
          <p className="signin__sub">
            {unpinned ? (
              <>
                Your <strong>ClickHouse</strong> credentials — Flint has neither a server nor an
                account of its own. Read-only is enough for everything in Data, and your grants
                decide the rest.
              </>
            ) : (
              <>
                Your <strong>ClickHouse</strong> credentials — Flint has no accounts of its own.
                Read-only is enough for everything in Data, and the server records what you run.
              </>
            )}
          </p>

          {/* Each field is a `div` with an explicit `htmlFor`, not a wrapping
              `label`. The password field holds a button, and a button inside a
              label is a control whose click the label also claims. */}
          {unpinned ? (
            <div className="signin__field">
              <label className="label" htmlFor="signin-endpoint">
                HTTP endpoint
              </label>
              <div className="signin__wrap">
                <input
                  id="signin-endpoint"
                  className={`input signin__endpoint${probe.isPending || probe.data || probe.error ? ' signin__endpoint--said' : ''}`}
                  value={endpoint}
                  onChange={(e) => {
                    setEndpoint(e.target.value)
                    setSplit(null)
                  }}
                  onBlur={() => leave('endpoint')}
                  /* Nobody types three fields when they are holding one string
                     that contains all three. So this field reads a connection
                     string and distributes it — a paste, not a second mode with
                     its own textarea and its own button: the field somebody
                     pastes into is the one they were already aiming at. See
                     `lib/dsn`, which also decides when a string has nothing
                     worth moving and this handler should stay out of the way. */
                  onPaste={(e) => {
                    const raw = e.clipboardData.getData('text')
                    const dsn = parseDsn(raw)
                    if (!dsn || !worthSplitting(dsn, raw)) return
                    e.preventDefault()
                    setEndpoint(dsn.endpoint)
                    if (dsn.user) setUser(dsn.user)
                    if (dsn.password) setPassword(dsn.password)
                    const moved = dsn.password
                      ? 'the user and password are in the fields below'
                      : dsn.user
                        ? 'the user is in the field below'
                        : null
                    /* A full stop between the two halves, not another dash.
                       What moved and what was assumed are two statements, and
                       joining them with the punctuation the second one uses
                       internally turns four clauses into one unreadable
                       sentence. */
                    setSplit([moved, dsn.note].filter(Boolean).join('. ') || null)
                  }}
                  placeholder="http://localhost:8123"
                  /* First field on the screen, so it takes the focus the user
                     field takes when the server is already decided. */
                  autoFocus
                  spellCheck={false}
                  autoCapitalize="none"
                  autoComplete="url"
                  inputMode="url"
                  aria-describedby="signin-endpoint-hint"
                />
                {/* Inside the field, because it is about the address in it. And
                    `role="status"`: nobody moved the focus to get this, so a
                    screen reader should be told politely rather than
                    interrupted. */}
                <Latency probe={probe} stale={stale} />
              </div>
              {/* The note replaces the hint rather than stacking under it. A
                  paste has just changed three fields, and what happened to them
                  is more use than the general advice — which the note repeats
                  anyway in the one case it applies to. */}
              {split ? (
                <span className="signin__hint" id="signin-endpoint-hint" role="status">
                  Read as a connection string: {split}.
                </span>
              ) : (
                /* The port, because 8123 and 9000 are one digit apart in the
                   documentation and only one of them is HTTP — pointing Flint at
                   the native protocol is the most common way this fails. And the
                   paste, said once, because a field that quietly does more than
                   it looks like is a field nobody tries. */
                <span className="signin__hint" id="signin-endpoint-hint">
                  ClickHouse's HTTP port, usually 8123 — not 9000, the native protocol. A
                  connection string pasted here is split into the fields below.
                </span>
              )}
            </div>
          ) : null}

          {/* Two fields on one line. They are one thought — who you are — and
              stacking them put the button below the fold on a laptop once the
              panel beside it had a heading of its own. */}
          <div className="signin__pair">
            <div className="signin__field">
              <label className="label" htmlFor="signin-user">
                User
              </label>
              <input
                id="signin-user"
                className="input"
                value={user}
                onChange={(e) => setUser(e.target.value)}
                onBlur={() => leave('user')}
                autoComplete="username"
                autoFocus={!unpinned}
                spellCheck={false}
                /* A ClickHouse user name is a database identifier, and browsers
                   like to capitalise the first letter of a text field on
                   phones. */
                autoCapitalize="none"
              />
            </div>

            <div className="signin__field">
              <label className="label" htmlFor="signin-password">
                Password
              </label>
              <div className="signin__wrap">
                <input
                  id="signin-password"
                  className={`input signin__pw${shown ? ' signin__pw--shown' : ''}`}
                  type={shown ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onBlur={() => leave('password')}
                  autoComplete="current-password"
                  aria-describedby="signin-password-hint"
                />
                {/* The label names what the next click does, and there is no
                    `aria-pressed` alongside it: a toggle that both renames
                    itself and publishes a pressed state announces the same fact
                    twice, and one of the two readings is always stale. */}
                <button
                  type="button"
                  className="signin__reveal"
                  onClick={() => setShown((s) => !s)}
                >
                  {shown ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>
          </div>

          {/* Said out loud rather than discovered: on a laptop most ClickHouse
              users have no password, and a form that looks incomplete without
              one makes people hunt for a secret that does not exist. */}
          <span className="signin__hint" id="signin-password-hint">
            Leave the password empty if your user has none.
          </span>

          <div className="signin__go">
            <button className="btn btn--spark" type="submit" disabled={signIn.isPending}>
              {unpinned
                ? signIn.isPending
                  ? 'Connecting…'
                  : 'Open this server'
                : signIn.isPending
                  ? 'Signing in…'
                  : 'Sign in'}
            </button>
            <span className="signin__shortcut">
              or <span className="kbd">⌘↵</span>
            </span>
          </div>

          {message ? (
            <p className={`signin__error${refused ? '' : ' signin__error--server'}`} role="alert">
              {message}
              {refused || explains ? null : (
                /* A transport failure is not a wrong password, and telling
                   somebody it is sends them to retype a correct one. */
                <span className="signin__errorhint"> — this is not a credential problem.</span>
              )}
            </p>
          ) : null}

          <p className="signin__foot">
            {unpinned
              ? /* "Where does this keep my database password" is the first
                   question a form like this raises, and the answer is short
                   enough to give: in this process's memory, for as long as the
                   session lives. There is no store to put it in — an unpinned
                   Flint is stateless by construction. */
                'Nothing is written down: the address and the password live in this session and die with it.'
              : `Flint's own work runs as ${config?.user ?? 'the account in its manifest'}.`}
          </p>
        </form>

        <Panel probe={probe} stale={stale} ready={ready} been={been} onCheck={run} />
      </div>
    </div>
  )
}

type Probe = ReturnType<typeof useMutation<Preflight, Error, void, unknown>>

/** How long the server took to answer, inside the field that names it.
 *
 *  Three states and no fourth: asking, answered, and failed. There is
 *  deliberately no idle text — an empty field with "not checked" beside it is a
 *  label for the absence of an action nobody has taken yet. */
function Latency({ probe, stale }: { probe: Probe; stale: boolean }) {
  if (probe.isPending) {
    return (
      <span className="signin__latency" role="status">
        checking…
      </span>
    )
  }
  /* Which of the three failures it was decides what this field may claim — see
     `said`, and the browser check that found it claiming the wrong one. */
  const failed = said(probe.error instanceof FlintError ? probe.error : probe.error ? {} : null)
  if (failed) {
    return (
      <span className={`signin__latency signin__latency--${failed.tone}`} role="status">
        {failed.word}
      </span>
    )
  }
  if (!probe.data) return null
  return (
    <span className={`signin__latency signin__latency--ok${stale ? ' is-stale' : ''}`} role="status">
      {reached(probe.data.reading.reached_ms)}
    </span>
  )
}

/** What these credentials can do, before anybody commits to them.
 *
 *  Rendered in every state rather than appearing when there is something to say.
 *  It holds six rows whichever state it is in, and a panel that pops into
 *  existence on blur moves the button somebody was about to press. Empty, the
 *  six rows are still worth reading: they are what Flint is about to ask, which
 *  is a fair thing to show somebody before it asks it with their password. */
function Panel({
  probe,
  stale,
  ready,
  been,
  onCheck,
}: {
  probe: Probe
  stale: boolean
  ready: boolean
  /** Whether every field has been visited — see `needed` in `SignIn`. */
  been: boolean
  onCheck: () => void
}) {
  const reading = probe.data
  const rows = reading ? capabilities(reading) : null
  const notes = reading ? consequences(reading, rows ?? undefined) : []
  const failed = probe.error instanceof Error ? probe.error.message : null

  return (
    <aside className={`signin__panel${stale ? ' is-stale' : ''}`} aria-live="polite">
      <div className="signin__panelhead">
        <h2 className="signin__paneltitle">What these credentials can do</h2>
        {stale && ready ? (
          <button type="button" className="btn btn--quiet signin__again" onClick={onCheck}>
            Check again
          </button>
        ) : null}
      </div>
      <p className="signin__panelsub">
        {/* The claim the whole panel rests on, and the reason it is worth the
            round trip: what is refused is switched off up front, rather than
            found by opening a tab. */}
        Measured on the server as this user, not guessed. Anything refused is switched off before
        you meet it rather than failing mid-page.
      </p>

      {/* The failure, and then the checks anyway. Replacing the list with the
          error collapsed the panel to four lines and took the button beside it
          with it — and the list is still worth reading after a refusal: it says
          what Flint will measure once the password is right. */}
      {failed ? (
        <p className="signin__panelno" role="alert">
          {failed}
        </p>
      ) : null}

      <ul className="signin__checks">
        {/* The same six rows either way, and the ids come from one list — see
            `CHECKS`, which the tests hold against `capabilities`. */}
        {rows
          ? rows.map((row) => <Check key={row.id} row={row} label={row.label} />)
          : CHECKS.map((check) => <Check key={check.id} row={null} label={check.label} />)}
      </ul>

      {/* One line each, title and consequence on the same line: three of these
          fire at once on an ordinary laptop — a stateless Flint, no backup disk,
          a server whose session log is off — and at a paragraph apiece they
          buried the six rows they were annotating. */}
      {notes.map((note) => (
        <p className="signin__note" key={note.id}>
          <strong className="signin__notetitle">{note.title}</strong>
          {' — '}
          <span className="signin__notebody">{note.body}</span>
        </p>
      ))}

      {reading ? (
        <p className="signin__detected">
          <span className="label">detected</span>
          <span className="signin__figures">{detected(reading.reading).join(' · ')}</span>
        </p>
      ) : failed ? (
        /* Nothing to report about a server that would not answer, and a line
           saying so under a paragraph that already said it is the same
           sentence twice. */
        null
      ) : (
        <p className="signin__detected">
          <span className="signin__figures signin__figures--waiting">
            {ready && been
              ? 'Asking the server…'
              : ready
                ? 'Leave the last field and Flint will ask the server.'
                : 'Fill these in and Flint will ask the server.'}
          </span>
        </p>
      )}
    </aside>
  )
}

/** One check, with or without a verdict yet.
 *
 *  The swatch carries the verdict in Flint's own five-state palette, and `off`
 *  takes `--cold` rather than an amber: dormant is what it means. A thing this
 *  deployment does not have is neither working nor broken, and colouring it with
 *  either is a lie in both directions. */
function Check({ row, label }: { row: Capability | null; label: string }) {
  return (
    <li className={`signin__check${row ? ` signin__check--${row.verdict}` : ' signin__check--none'}`}>
      <span className="signin__swatch" aria-hidden="true" />
      <span className="signin__what">
        <span className="signin__label">{label}</span>
        {row ? <span className="signin__rests mono">{row.rests}</span> : null}
      </span>
      {row ? <span className="signin__verdict mono">{row.word}</span> : null}
    </li>
  )
}

/** Host and port only: the whole URL on a sign-in screen reads as noise, and
 *  the question it answers is "which server is this". */
function hostOf(endpoint: string | null | undefined): string {
  if (!endpoint) return 'not connected'
  try {
    const url = new URL(endpoint)
    return url.port ? `${url.hostname}:${url.port}` : url.hostname
  } catch {
    return endpoint
  }
}
