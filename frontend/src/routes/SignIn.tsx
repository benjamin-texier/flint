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
 *  Two halves rather than one card in the middle of nothing. This is the only
 *  screen every user sees, and a 380px box centred in an empty field says
 *  nothing about what they are signing in to — the previous version spent a
 *  whole viewport saying "there is a form here". So the left half says what
 *  Flint is by *doing* it: the schema, drawn, in the same ink and the same
 *  colour key as the real diagram. The right half is the form, on its own
 *  surface, with room to breathe.
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
      <section className="signin__stage">
        <div className="signin__brand">
          <svg className="mark" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M9.5 1 3 9h4l-1.5 6L13 6.5H8.5z" fill="currentColor" />
          </svg>
          <span className="signin__word">flint</span>
        </div>

        {/* Not an `h1`: the page's subject is signing in, and the form's heading
            is the one thing on the screen that says what to do next. This is the
            claim above it, sized like a headline and outranked by one. */}
        <p className="signin__pitch">
          Your ClickHouse,{' '}
          <br />
          drawn.
        </p>
        <p className="signin__blurb">
          Tables, the views over them and the pipes between — with the sizes, the costs and what to
          change about them. One binary, no second database.
        </p>

        <Drawing />

        {/* The drawing is a drawing, and saying so is cheaper than letting
            somebody wonder whose schema they are looking at before they have
            connected to anything. */}
        <p className="signin__caption">
          An example, not a reading. Yours arrives once you are in.
        </p>
      </section>

      <div className="signin__panel">
        <form
          className="signin__form"
          onSubmit={(e) => {
            e.preventDefault()
            /* An empty endpoint is refused by the server with the right words,
               but a form that posts a request it knows will fail spends a round
               trip to say what it could have said itself. */
            if (user.trim() && (!unpinned || endpoint.trim())) signIn.mutate()
          }}
        >
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
                With your <strong>ClickHouse</strong> credentials — Flint has no accounts of its
                own. Your grants decide what you can see, and the server records what you run.
              </>
            )}
          </p>

          {/* Each field is a `div` with an explicit `htmlFor`, not a wrapping
              `label`. The password field holds a button, and a button inside a
              label is a control whose click the label also claims — the
              structure has to change for the reveal to be a plain button. */}
          {unpinned ? (
            <div className="signin__field">
              <label className="label" htmlFor="signin-endpoint">
                HTTP endpoint
              </label>
              <input
                id="signin-endpoint"
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
                aria-describedby="signin-endpoint-hint"
              />
              {/* The note replaces the hint rather than stacking under it. A
                  paste has just changed three fields, and what happened to them
                  is more use than the general advice — which the note repeats
                  anyway in the one case it applies to.

                  `role="status"` because this appears without anybody moving the
                  focus: a screen reader gets it politely, after the paste, which
                  is the whole contract that role announces. */}
              {split ? (
                <span className="signin__hint" id="signin-endpoint-hint" role="status">
                  Read as a connection string: {split}.
                </span>
              ) : (
                /* The port, because 8123 and 9000 are one digit apart in the
                   documentation and only one of them is HTTP — pointing Flint at
                   the native protocol is the most common way this fails. And the
                   paste, said once, because a field that quietly does more than it
                   looks like is a field nobody tries. */
                <span className="signin__hint" id="signin-endpoint-hint">
                  ClickHouse's HTTP port, usually 8123 — not 9000, which is the native protocol. A
                  connection string pasted here is split into the fields below.
                </span>
              )}
            </div>
          ) : null}

          <div className="signin__field">
            <label className="label" htmlFor="signin-user">
              User
            </label>
            <input
              id="signin-user"
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
          </div>

          <div className="signin__field">
            <label className="label" htmlFor="signin-password">
              Password
            </label>
            <div className="signin__wrap">
              <input
                id="signin-password"
                className="input signin__pw"
                type={shown ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                aria-describedby="signin-password-hint"
              />
              {/* The label names what the next click does, and there is no
                  `aria-pressed` alongside it: a toggle that both renames itself
                  and publishes a pressed state announces the same fact twice,
                  and one of the two readings is always the stale one. */}
              <button
                type="button"
                className="signin__reveal"
                onClick={() => setShown((s) => !s)}
              >
                {shown ? 'Hide' : 'Show'}
              </button>
            </div>
            {/* Said out loud rather than discovered: on a laptop most ClickHouse
                users have no password, and a form that looks incomplete without
                one makes people hunt for a secret that does not exist. */}
            <span className="signin__hint" id="signin-password-hint">
              Leave empty if your user has none.
            </span>
          </div>

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
    </div>
  )
}

/* ── The drawing ─────────────────────────────────────────────────────────────
 *
 * Five objects and four edges, in the diagram's own geometry: a node is a slab
 * with a coloured rail down its leading edge, and the rail's colour is the
 * object's kind. Same tokens as `SchemaCanvas`, so the colour key somebody
 * learns here is the one that is still true a minute later.
 *
 * Positions are written out rather than laid out. The real page runs a layout
 * over a graph it has just fetched; there is no graph here, and importing the
 * layout to arrange five hard-coded nodes would be machinery pretending to be
 * a measurement. */
const NODE_W = 92
const NODE_H = 40

const DRAWN_NODES = [
  { name: 'events', kind: 'table', x: 4, y: 12 },
  { name: 'users', kind: 'table', x: 4, y: 108 },
  { name: 'daily_mv', kind: 'materialized_view', x: 146, y: 60 },
  { name: 'daily', kind: 'table', x: 288, y: 12 },
  { name: 'geo', kind: 'dictionary', x: 288, y: 156 },
] as const

/* `gap` is the spacing between the dots travelling an edge, which in the real
 * diagram carries how many rows crossed it in the window — so three pipes at
 * three spacings, and the widest gap on the edge that ought to move least.
 *
 * The dictionary's edge has no `gap` at all, and that is the same rule the
 * product follows rather than an omission: an edge that never had rows to move
 * has no dots by construction. It is drawn dashed too, because Flint mostly
 * *infers* this kind of reference rather than being told about it. */
const DRAWN_WIRES: { d: string; gap?: number; inferred?: boolean }[] = [
  { d: 'M96 32 C118 32 124 80 146 80', gap: 14 },
  { d: 'M96 128 C118 128 124 80 146 80', gap: 30 },
  { d: 'M238 80 C260 80 266 32 288 32', gap: 20 },
  { d: 'M334 156 V52', inferred: true },
]

/** The schema, drawn — the one thing this product does that a sentence cannot.
 *
 *  `aria-hidden`, and the caption under it carries the whole message in words:
 *  a screen reader walking a sign-in form has no use for five node names, and
 *  reading them out would be reading out an example schema as though it were
 *  the server's. */
function Drawing() {
  return (
    <div className="signin__draw">
      <svg className="signin__svg" viewBox="0 0 380 208" aria-hidden="true">
        {DRAWN_WIRES.map((wire, i) => (
          <path
            key={`wire-${i}`}
            className={`signin__wire${wire.inferred ? ' signin__wire--inferred' : ''}`}
            {...(wire.inferred ? {} : { pathLength: 1 })}
            d={wire.d}
            style={{ ['--delay' as string]: `${200 + i * 90}ms` }}
          />
        ))}
        {DRAWN_WIRES.map((wire, i) =>
          wire.gap ? (
            <path
              key={`flow-${i}`}
              className="signin__flow"
              d={wire.d}
              style={{
                ['--gap' as string]: wire.gap,
                /* After the wire it runs on has finished drawing: dots arriving
                   on a line that is still half there read as a rendering bug. */
                ['--delay' as string]: `${760 + i * 90}ms`,
              }}
            />
          ) : null,
        )}
        {DRAWN_NODES.map((node, i) => (
          <g
            key={node.name}
            className={`signin__node signin__node--${node.kind}`}
            style={{ ['--delay' as string]: `${i * 70}ms` }}
          >
            <rect
              className="signin__nodebox"
              x={node.x}
              y={node.y}
              width={NODE_W}
              height={NODE_H}
              rx={8}
            />
            <rect
              className="signin__noderail"
              x={node.x + 1.5}
              y={node.y + 6}
              width={3}
              height={NODE_H - 12}
              rx={1.5}
            />
            <text className="signin__nodename" x={node.x + 14} y={node.y + 24}>
              {node.name}
            </text>
          </g>
        ))}
      </svg>
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
