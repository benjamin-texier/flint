# Configuration in depth

*[← back to the README](../README.md)*

The variable table lives in the [README](../README.md#configuration). This is
the reasoning behind the three settings that are more than a value: what Flint
needs to be granted, what signing in changes, and what running without a server
in the manifest means.

### Grants

Flint reads `system.databases`, `system.tables`, `system.columns`,
`system.parts`, and — where they exist — `system.projections` and
`system.query_log`. A user with `SELECT` on those plus the data you want to
explore is enough. Nothing is required beyond `SELECT`.

Set `FLINT_READONLY=true` to have Flint send `readonly=2` on every statement,
so the server rejects writes even if the credentials could perform them.

**What you may see** is the reader's side of that, on the server page under the
list of databases. It exists because ClickHouse *filters* the system tables
rather than refusing them: a user holding no grants at all gets a perfectly
successful, perfectly empty inventory — no error, nothing to explain where the
databases went. Measured on a user created for the purpose.

It asks `SHOW GRANTS`, which answers even for a user with no privilege on
`system.grants` — and that is the user asking. Three things it does with the
answer, each because of what the answer turned out to be:

- **A revoke is not a permission.** `SHOW GRANTS` returns statements, and one of
  them can be `REVOKE SELECT ON analytics.orders FROM you`. Listed among the
  grants it says the opposite of what it means, so those get their own short
  table under their own heading.
- **A role is expanded.** `GRANT analyst TO you` says nothing about what
  `analyst` carries. The roles come from `system.enabled_roles` — switched on,
  not merely granted — and each is asked for its own grants. Where one cannot be
  read, the panel says so rather than letting a short list read as a complete
  one.
- **One privilege by two paths is one row.** Held directly *and* through a role
  is ordinary, and it is also the thing worth knowing when a role is taken away.

Arranging access stays in Infrastructure → Users & RBAC. This is read-only and
about you.

### Signing in

Off by default: Flint connects as the account in its manifest, and anyone who can
reach the port is that account. That is the right shape for a sidecar on a
laptop, and the wrong one for a Flint several people share.

`FLINT_AUTH=true` puts a sign-in screen in front of everything, and it takes
**ClickHouse** credentials — Flint has no accounts of its own, and this is the
one design decision the whole feature rests on:

- **Authorisation is already written.** It is `system.grants`. Somebody who may
  not read a table is refused by the server, not by a check of Flint's that could
  be wrong, stale, or missed on a route nobody remembered.
- **The audit trail is already written.** `system.query_log` carries `user`, so
  every statement is attributable without a table of Flint's own — and the
  history page already displays it.
- **"Who can do what" changes meaning.** The access page stops being an
  administrator's dashboard and becomes your own standing.

What it costs, said plainly rather than discovered later:

- Flint holds each signed-in password **in memory** for the life of the session,
  because ClickHouse's HTTP interface authenticates every request and there is
  nothing else to hold. It is never written to disk, never sent to the browser,
  and redacted in `Debug` so a stray log line cannot leak it.
- Sessions live in the process. A Flint that restarts asks everyone to sign in
  again — the honest consequence of a sidecar with no store.
- The cookie is `HttpOnly`, `SameSite=Lax`, and marked `Secure` when
  `X-Forwarded-Proto` says the request arrived over TLS. Authentication is
  therefore same-origin: `FLINT_CORS_ORIGIN` is for a dev server proxying `/api`,
  not for a separate front end holding a session.

#### What the screen tells you before you sign in

A wrong password is a wrong password, and the form has always said so. The
expensive failure is the one that *succeeds*: credentials that are accepted and
then cannot read `system.query_log`, or a server whose session log is switched
off, or a Flint with no backup disk. All three used to be discovered three clicks
later, as a page that loads and says nothing.

So the sign-in screen asks first. `POST /api/preflight` takes the same body as
`/api/login`, opens no session, and runs the reads Flint's own sections are built
on **as the credentials on the form** — then the panel beside the fields says what
each one will be able to do.

- **It attempts the read rather than interpreting the grant.** `SHOW GRANTS` has
  to be parsed — wildcards, roles, revokes — and every parse is a second
  implementation of ClickHouse's access rules that can disagree with it.
  `SELECT count() FROM system.query_log WHERE 0` cannot disagree with anything.
  The grants are still read, for a different job: to *name* what a verdict rests
  on, because "granted" beside `SELECT on analytics.*` is a sentence somebody can
  check and "granted" on its own asks to be trusted.
- **Four verdicts, because three were wrong.** Measured on a real server:
  `system.session_log` came back *absent* — the log is off, the grants are fine,
  and reporting that as "refused" sends somebody to write a `GRANT` that will
  change nothing. So: `granted`, `refused` (a `GRANT` fixes it), `partial` (and
  which half is missing), `off` (the server or this deployment does not have the
  thing at all; a configuration change fixes it, a grant will not).
- **Two rows are not about your grants**, and say so. Backups need a destination
  this deployment may write to; alerts need somewhere for Flint to keep them and
  something that ticks. Flint writes its own bookkeeping with its own account, so
  naming your `CREATE TABLE` there would be a plausible sentence that is false —
  those rows name `FLINT_BACKUP_DISK` and `FLINT_WORKSPACE_DATABASE` instead.
- **It fires on blur, not on keystroke**, once every field has been visited. A
  debounce would send the password to a browser-named address every time somebody
  paused mid-word — and probing on *any* blur meant leaving the user field fired a
  probe with the password still empty, so everybody with a password watched the
  panel go red before they had finished filling the form in.
- **It shares the sign-in dial budget** rather than getting one of its own. It is
  the same socket to the same chosen address, and a second pool of eight would
  double what one caller can hold open while each limit looked correctly small.
  It is vetted by the same `FLINT_TARGETS` fence, through the same function.

Measurement lives in `src/clickhouse/preflight.rs` and decides nothing;
`frontend/src/lib/preflight.ts` decides what any of it means and is where the
tests are. That split is deliberate — the judgement is the part that changes.

**A script signs in the same way, and holds a bearer instead of a cookie.** Post
`bearer: true` and the session comes back in the body rather than as a
`Set-Cookie`:

```bash
curl -s localhost:8080/api/login \
  -H 'content-type: application/json' \
  -d '{"user":"analyst","password":"…","bearer":true}'
# {"user":"analyst","bearer":"3f2b…","expires_in":43200}

curl -s localhost:8080/api/databases -H 'Authorization: Bearer 3f2b…'
```

Every route behind the sign-in accepts either envelope, and neither is stronger
than the other — it is the same session, resolved the same way, running every
statement as the same ClickHouse user. Three things are worth knowing before you
put one in a cron job:

- It is **opt-in and exclusive**. Asking for a bearer suppresses the cookie: a
  caller that wants one has said it is not a browser, and issuing both would put
  a second copy of the same secret somewhere nobody watches. The browser's cookie
  stays `HttpOnly` precisely because the id is never in a body it can read.
- `expires_in` is an **idle** window, not a deadline — `FLINT_SESSION_IDLE_HOURS`,
  twelve by default — and every call pushes it back. What that means for a script
  is that the honest design is to **re-authenticate on a 401** rather than to
  refresh on a timer, because a Flint that restarts invalidates every bearer at
  once. Sessions live in the process; that is the same cost the browser pays,
  said again because a cron job feels like it should be more durable than a tab.
- The credential you store is therefore your **ClickHouse** one, in whatever
  vault you already keep secrets in — not a Flint token. That is deliberate: it
  keeps the durable secret out of Flint's memory, and it means the answer to
  "what may this script see" is `system.grants`, exactly as it is for a person.

Where a bearer and a cookie both arrive on one request the bearer wins, because a
cookie is sent whether or not the caller meant it. The consequence is worth
knowing before it costs you an afternoon: an **expired bearer is refused even
when the cookie beside it is still good**. It was the claim the request made, and
answering it as somebody else would be the silent substitution this ordering
exists to prevent.
- **Flint's own work still runs as the manifest account**: the workspace it saves
  into, the alert scheduler, the report runner, the health probe. Which means a
  report or an alert reads whatever *that* account can read, and anyone signed in
  can see the edition it produced. If some data must not be visible to everyone
  who can sign in, do not put it in a scheduled report.
- Three routes stay open, because they have to be: `/api/health` (the container's
  liveness probe), `/api/config` and `/api/session` (how the browser learns it
  must sign in), and `GET /api/data/<address>` — the published endpoints, which
  carry their own tokens and are called by machines that have no session.
  `POST /api/data` is the exception under that prefix and is *not* open: it is a
  dataset read, it runs as whoever is asking, and it has no token of its own.
  Exemption is visible in a handler's signature rather than kept in a list, so a
  new route is open until it asks for a caller — which is the thing to check when
  adding one.

Signing in does not change what a tier permits. `FLINT_TIER` is about the
deployment; signing in is about you.

**Restrict people with grants, not with the `readonly` profile.** A ClickHouse
user on `readonly=1` cannot change *settings*, and Flint attaches a timeout and a
row cap to every statement it sends — so such a user cannot use Flint at all. The
sign-in screen says exactly that rather than blaming the password, but the fix is
at your end: `GRANT SELECT ON db.*` is how a read-only user is made, and
`readonly=2` is the profile that still permits settings.

A narrowly-granted user is worth having for development, because most of what
Flint does when it is *refused* is invisible while signed in as an account
allowed everything: `contrib/dev-users.xml` adds one to the compose fixture
(`flint_probe` / `probe`, holding `SELECT` on `analytics` and nothing else).
Signed in as that user, the explorer shows one database, the database's size is
dropped rather than dashed because `system.parts` is unreadable, and each
diagnostic names the grant it would need.

### Starting without a server

Leave `FLINT_CLICKHOUSE_URL` unset and Flint starts **unpinned**: it boots
connected to nothing, opens on a form asking where to go, and the browser names
the server. `docker run -p 8080:8080 flint` with no environment at all is a
working Flint.

It is a real mode rather than a degraded one, but it is a **narrower** Flint, and
the narrowing is structural rather than a policy anyone chose:

- **Signing in is required, whatever `FLINT_AUTH` says.** The endpoint arrives
  with a session, so there is nothing to connect *as* until somebody signs in.
  `Config::sign_in_required` is one method rather than a flag flipped at boot,
  so the invariant holds for any `AppState` — including one built in a test,
  which is where a gate gets quietly built without one.
- **Nothing runs on a schedule.** Alerts, reports and long jobs are questions put
  to the *explored* server with nobody's browser open, and a schedule has no
  session to borrow one from. So they are off here — the scheduler and the job
  runner are not spawned, the boot log says so, and `/api/config` answers
  `scheduled: false` so the two sections are absent rather than present and
  failing.
- **Stateless is the default, not the only option.** `FLINT_WORKSPACE_DATABASE`
  alone is still refused — a workspace with no server to put it in does not boot.
  But `FLINT_WORKSPACE_URL` gives Flint's own tables a server of their own, and
  then an unpinned Flint *keeps* things: saved queries, dashboards and published
  endpoints all work, because each is answered by whoever is signed in. Only the
  timed two stay off. This is also the shape worth having when pinned: with the
  workspace elsewhere, connecting Flint to a server creates nothing on it.
- **Two people can be on two different ClickHouses.** "Which server" stops being
  a fact about the deployment and becomes a fact about your session:
  `/api/config` answers `endpoint: null` and `pinned: false`, and `/api/session`
  answers the one you named. The chrome reads the second.
- **The timezone follows the connection.** It is read in the same round trip that
  checks the credentials and kept on the session, because it changes only when
  ClickHouse restarts and the dataset API states it on every answer.
- **One browser holds one server.** The session lives in a cookie, and a browser
  has one cookie jar per profile — so a second tab opens straight into the server
  the first one signed in to, without a sign-in screen. Signing out and in
  somewhere else moves *every* tab: the one that never asked shows the new server
  on its next read. Verified, not assumed, and the chrome does not lie about it —
  it names the server on every page, and after such a move it names the new one.
  Two servers at once means two browser profiles, or two Flints.

The endpoint field reads a **connection string**. Nobody types three fields when
they are holding one string that contains all three, so pasting
`clickhouse://analyst:secret@warehouse:9000/analytics` into it fills all three
and says what it did: the native port read as its HTTP twin, the database
dropped because an address does not carry one. Two rules in `lib/dsn`: say what
was assumed, and never invent a port — where the string names none, none is
filled in, because the wrong one fails with a message about the address rather
than about the guess.

The endpoint is a string that arrived from a browser and that this process then
dials, which is the shape of an SSRF. So:

- It is taken apart before it is used (`src/target.rs`): `http`/`https` only,
  credentials in the address refused rather than used, query and fragment
  dropped, and the link-local ranges — `169.254.0.0/16` and `fe80::/10` —
  refused outright. Refused as a parsed **address**, not as text: that address
  has a dozen legal spellings, and while `Url` normalises the numeric ones
  (`2852039166`, `0xa9.0xfe.0xa9.0xfe`, octal, a trailing dot) to the same IPv4
  literal, it keeps `[::ffff:169.254.169.254]` as `[::ffff:a9fe:a9fe]` — the same
  address in IPv6's clothes, which Linux routes without complaint. A check on the
  text let that one through.
- `FLINT_TARGETS` narrows it — `host`, `host:port` or `scheme://host:port`,
  comma-separated. What is absent does not constrain: `clickhouse` permits that
  host on any port over either scheme.
- **Empty means any**, because requiring it would take the mode's whole point
  away, and the boot log says so in a warning rather than leaving it to be
  assumed. Set it on an unpinned Flint that is not on your own laptop.
- Eight sign-in dials may be outstanding at once; the ninth is refused with
  `429` until one returns. That closes a resource hole rather than the scanning
  one, and the difference is measured: twenty parallel sign-ins at an address
  that *hangs* leave the process holding eight ten-second connections instead of
  twenty, but forty at an address that fails *fast* finish in 91ms — a permit
  comes back in milliseconds, so a port sweep, which is made of fast failures, is
  not slowed at all. `FLINT_TARGETS` is the only thing that stops that one.
- The fence checks the host as *written*, not as resolved. A name under somebody
  else's control can point anywhere, so `FLINT_TARGETS` is the boundary and the
  rest is a fence. `src/target.rs` says so at the top rather than in a commit
  message.

There are **three** ways an address fails, and they send you to three different
places — so Flint names them separately:

| What happened | What you see |
| --- | --- |
| Nothing is listening | `could not reach ClickHouse at http://…` |
| ClickHouse answered, and said no | its own message — a wrong password, a missing grant |
| Something answered, and it is not ClickHouse | `reached http://…, and what answered is not ClickHouse: it answered 400 and sent no ClickHouse headers` |

The third is new with this mode, and it is the one an unpinned Flint meets most,
because the address is typed by hand. It used to be reported as a decode failure,
which reads as a bug in Flint, or — worse, when the peer answered non-2xx — as a
ClickHouse exception carrying somebody else's XML, which puts a stranger's error
text in ClickHouse's mouth. The signal is that no `X-ClickHouse-*` header came
back: a real ClickHouse sends the summary, the display name and the exception
code even when it is refusing you. It is used **only to reclassify a failure**,
never to refuse a working answer, so a reverse proxy that strips those headers
keeps working.

The opening line of what *did* answer goes to Flint's log, not to the caller.
That message is read before anybody has signed in, so quoting a stranger's body
would turn the error into a fingerprinting oracle — not merely "something is
listening on 9100" but "and it answers with XML". The status code a caller learns
anyway; the line they would not, and the operator who needs it is reading the log.

A pinned Flint **refuses** an endpoint offered at sign-in rather than ignoring
it. Ignoring is the tempting reading and the wrong one: a caller answered `200`
has every reason to think the address was used, and a pinned Flint that took the
field would be an open proxy behind a manifest promising it is not.
