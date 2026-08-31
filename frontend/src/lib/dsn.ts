/** Reading a connection string somebody already has.
 *
 *  Nobody types an endpoint, a user and a password into three fields when they
 *  are holding one string that contains all three — they paste it into the first
 *  field and expect it to work. So the endpoint field takes a DSN, and this
 *  splits it.
 *
 *  Two rules run through everything below. **Say what was assumed**: a native
 *  port swapped for its HTTP twin and a database dropped are both changes to
 *  what somebody pasted, and a form that makes them silently is a form whose
 *  output nobody can reconcile against their notes. And **never invent a port**:
 *  where the string names none, none is filled in, because the wrong one fails
 *  with a message about the address rather than about the guess. */

export interface Dsn {
  endpoint: string
  /** Empty where the string carried none — the field it fills is then left
   *  alone rather than cleared, because a paste that names no user is not a
   *  statement that there isn't one. */
  user: string
  password: string
  /** What was changed or dropped on the way, in one sentence, or null when the
   *  string went in whole. */
  note: string | null
}

/** The native protocol's ports and the HTTP ports that ship beside them.
 *
 *  ClickHouse's own default pairs, which is the only reason this mapping is
 *  allowed to exist: 9000 and 8123 are the plain pair, 9440 and 8443 the TLS
 *  one. A deployment that has moved either is a deployment where the swap is
 *  wrong — hence the note, every time. */
const HTTP_TWIN: Record<string, { port: string; secure: boolean }> = {
  '9000': { port: '8123', secure: false },
  '9440': { port: '8443', secure: true },
}

/** Schemes that mean the native protocol rather than HTTP. `clickhouses` is the
 *  TLS spelling drivers use; `tcp` is what JDBC and some ORMs write. */
const NATIVE = new Set(['clickhouse', 'clickhouses', 'tcp', 'tcps', 'native'])

/** Splits a connection string, or null when it is not one.
 *
 *  Null rather than a best effort: this runs on every keystroke in a field whose
 *  ordinary content is a bare `host:8123`, and a parser that always returns
 *  something would rewrite what somebody is halfway through typing. */
export function parseDsn(raw: string): Dsn | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)
  /* No scheme means no DSN. `host:8123` is what the field is *for*, and it
     carries nothing this function could add — splitting it would be a rewrite
     with no gain. */
  if (!match?.[1]) return null
  const scheme = match[1].toLowerCase()

  let url: URL
  try {
    /* Parsed as `http` whatever the scheme says, because `URL` only exposes
       `port`, `username` and the rest for schemes it considers special —
       `clickhouse://` would come back with everything hidden in `pathname`. */
    url = new URL('http://' + trimmed.slice(match[0].length))
  } catch {
    return null
  }
  if (!url.hostname) return null

  const native = NATIVE.has(scheme)
  if (!native && scheme !== 'http' && scheme !== 'https') return null

  const notes: string[] = []

  /* TLS, from whichever of the three places said so. `?secure=true` is how the
     native drivers spell it and it appears on plenty of pasted strings. */
  let secure = scheme === 'https' || scheme === 'clickhouses' || scheme === 'tcps'
  const asked = url.searchParams.get('secure')
  if (asked !== null && asked !== '0' && asked !== 'false') secure = true

  let port = url.port
  const twin = HTTP_TWIN[port]
  if (twin) {
    /* The most common paste there is: a driver's DSN, whose port is the native
       one. Swapped rather than refused — a form that will not read the string
       everybody has is a form nobody uses — and stated, because a server whose
       HTTP port is not the default pair needs somebody to notice. */
    port = twin.port
    if (twin.secure) secure = true
    notes.push(`${url.port} is the native port, so this reads ${twin.port}`)
  } else if (native && !port) {
    /* A native DSN with no port at all. Nothing to swap and nothing to guess:
       9000 and 9440 are both defaults for the native protocol and neither is an
       HTTP port. */
    notes.push('this names no port — ClickHouse serves HTTP on 8123, or 8443 over TLS')
  }

  /* The database, which is not part of an endpoint. Flint opens on the server
     and every statement names its own database, so the only honest thing to do
     with it is drop it and say so. */
  const database = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '')
  if (database)
    notes.push(`the database \`${database}\` is dropped — an address does not carry one`)

  /* `hostname` keeps an IPv6 literal's brackets, which is what the address
     needs and what a hand-rolled split would have lost. */
  const host = port ? `${url.hostname}:${port}` : url.hostname
  return {
    endpoint: `${secure ? 'https' : 'http'}://${host}`,
    /* Percent-decoded: a password with an `@` or a `/` in it has to be escaped
       inside a URL and must not be escaped in the field. */
    user: safeDecode(url.username),
    password: safeDecode(url.password),
    note: notes.length ? notes.join('; ') : null,
  }
}

/** `decodeURIComponent`, except that a stray `%` is a character rather than a
 *  crash. A password is somebody's literal secret and may contain anything. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Whether a pasted string is worth splitting at all.
 *
 *  A DSN that is already a plain HTTP address with no credentials, no database
 *  and no native port has nothing to move — rewriting the field with an
 *  identical value, and announcing it, is noise. */
export function worthSplitting(dsn: Dsn, raw: string): boolean {
  return Boolean(dsn.user || dsn.password || dsn.note || dsn.endpoint !== raw.trim())
}
