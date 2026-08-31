import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { api, FlintError, type AppConfig } from '../lib/api'
import { parseDsn, worthSplitting } from '../lib/dsn'

/** The sign-in screen, which is the whole page or nothing.
 *
 *  Not a modal over the app: there is no app behind it to look at, because every
 *  route needs a session and none of them can answer without one. A dialog would
 *  imply otherwise, and dashboards showing through a blur while saying "sign in"
 *  is a promise the backend does not keep.
 *
 *  The credentials are **ClickHouse's** — Flint has no users of its own — and the
 *  screen says so, because "username and password" with no further explanation
 *  invites people to invent an account that does not exist and then wonder why it
 *  is rejected. The host is named for the same reason: signing in to the wrong
 *  server is an easy mistake to make and an expensive one to diagnose. */
export function SignIn({ config }: { config: AppConfig | undefined }) {
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [endpoint, setEndpoint] = useState('')
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
      <form
        className="signin__card"
        onSubmit={(e) => {
          e.preventDefault()
          /* An empty endpoint is refused by the server with the right words,
             but a form that posts a request it knows will fail spends a round
             trip to say what it could have said itself. */
          if (user.trim() && (!unpinned || endpoint.trim())) signIn.mutate()
        }}
      >
        <div className="signin__brand">
          <svg className="mark" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M9.5 1 3 9h4l-1.5 6L13 6.5H8.5z" fill="currentColor" />
          </svg>
          <span className="signin__word">flint</span>
        </div>

        <h1 className="signin__title">{unpinned ? 'Point Flint at a server' : 'Sign in'}</h1>
        {/* Two paragraphs rather than one with a clause bolted on. Unpinned, the
            first thing to say is that there is no server yet — appending that to
            the sentence about credentials pushed five lines of prose above the
            first field, and the field is the answer to the question the heading
            just asked. */}
        <p className="signin__sub">
          {unpinned ? (
            <>
              Name a server, and sign in to it with your <strong>ClickHouse</strong> credentials —
              Flint has neither of its own. Your grants decide what you can see.
            </>
          ) : (
            <>
              With your <strong>ClickHouse</strong> credentials — Flint has no accounts of its own.
              Your grants decide what you can see, and the server records what you run.
            </>
          )}
        </p>

        {unpinned ? (
          <label className="signin__field">
            <span className="label">HTTP ENDPOINT</span>
            <input
              className="input"
              value={endpoint}
              onChange={(e) => {
                setEndpoint(e.target.value)
                setSplit(null)
              }}
              /* Nobody types three fields when they are holding one string that
                 contains all three. So this field reads a connection string and
                 distributes it — a paste, not a second mode with its own
                 textarea and its own button: the field somebody pastes into is
                 the one they were already aiming at. See `lib/dsn`, which also
                 decides when a string has nothing worth moving and this handler
                 should stay out of the way. */
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
                /* A full stop between the two halves, not another dash. What
                   moved and what was assumed are two statements, and joining
                   them with the punctuation the second one uses internally
                   turns four clauses into one unreadable sentence. */
                setSplit([moved, dsn.note].filter(Boolean).join('. ') || null)
              }}
              placeholder="http://localhost:8123"
              /* First field on the screen, so it takes the focus the user field
                 takes when the server is already decided. */
              autoFocus
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="url"
              inputMode="url"
            />
            {/* The note replaces the hint rather than stacking under it. A
                paste has just changed three fields, and what happened to them
                is more use than the general advice — which the note repeats
                anyway in the one case it applies to.

                `role="status"` because this appears without anybody moving the
                focus: a screen reader gets it politely, after the paste, which
                is the whole contract that role announces. */}
            {split ? (
              <span className="signin__hint" role="status">
                Read as a connection string: {split}.
              </span>
            ) : (
              /* The port, because 8123 and 9000 are one digit apart in the
                 documentation and only one of them is HTTP — pointing Flint at
                 the native protocol is the most common way this fails. And the
                 paste, said once, because a field that quietly does more than it
                 looks like is a field nobody tries. */
              <span className="signin__hint">
                ClickHouse's HTTP port, usually 8123 — not 9000, which is the native protocol. A
                connection string pasted here is split into the fields below.
              </span>
            )}
          </label>
        ) : null}

        <label className="signin__field">
          <span className="label">USER</span>
          <input
            className="input"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            autoComplete="username"
            autoFocus={!unpinned}
            spellCheck={false}
            /* A ClickHouse user name is a database identifier, and browsers
               like to capitalise the first letter of a text field on phones. */
            autoCapitalize="none"
          />
        </label>

        <label className="signin__field">
          <span className="label">PASSWORD</span>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
          {/* Said out loud rather than discovered: on a laptop most ClickHouse
              users have no password, and a form that looks incomplete without
              one makes people hunt for a secret that does not exist. */}
          <span className="signin__hint">Leave empty if your user has none.</span>
        </label>

        <button className="btn btn--spark signin__go" type="submit" disabled={signIn.isPending}>
          {unpinned
            ? signIn.isPending
              ? 'Connecting…'
              : 'Open this server'
            : signIn.isPending
              ? 'Signing in…'
              : 'Sign in'}
        </button>

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
          {unpinned ? (
            /* "Where does this keep my database password" is the first question
               a form like this raises, and the answer is short enough to give:
               in this process's memory, for as long as the session lives. There
               is no store to put it in — an unpinned Flint is stateless by
               construction. */
            'Nothing is written down: the address and the password live in this session and die with it.'
          ) : (
            <>
              {hostOf(config?.endpoint)}
              {config ? <span className="signin__sep" aria-hidden="true" /> : null}
              {config ? `Flint's own work runs as ${config.user}` : null}
            </>
          )}
        </p>
      </form>
    </div>
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
