/** What a set of credentials will be able to do here, judged from what the
 *  server actually answered.
 *
 *  The measurement is `src/clickhouse/preflight.rs`, which attempts the reads
 *  Flint's sections are built on and reports what each one said. Nothing in
 *  that file decides what the answers *mean*, and nothing in this file talks to
 *  a server: the split is the repo's, and it is here because the judgement is
 *  the part that changes — a section moves, a third state turns out to matter,
 *  the wording of a consequence gets better — and it changes far more often than
 *  the SQL does.
 *
 *  Three states were not enough, which is the whole reason this is not a
 *  boolean per row. Measured on a real server: `system.session_log` came back
 *  `absent` — the log is switched off, the grants are fine, and reporting that
 *  as "refused" sends somebody to write a GRANT that will change nothing. Four
 *  verdicts, and each one implies a different fix:
 *
 *  - `granted`  — it works.
 *  - `refused`  — the grants stop it. A GRANT fixes it.
 *  - `partial`  — some of it works. Says which half is missing.
 *  - `off`      — the server or this deployment does not have the thing at all.
 *                 A configuration change fixes it; a grant will not.
 *
 *  And two rows are not about the credentials at all. Backups need a
 *  destination this deployment is allowed to write to, and alerts need somewhere
 *  for Flint to keep them plus something that ticks — neither is a grant, and
 *  both belong on this panel anyway, because the question behind it is "what
 *  will be there when I get in" rather than "what is in my grants". Those rows
 *  name the real gate rather than a plausible-looking privilege. */

/** What `Client::reach` said about one system table. The words are a payload
 *  contract with `clickhouse::preflight::word`, which is why that function
 *  spells them out instead of deriving them from the enum. */
export type ReachWord = 'readable' | 'denied' | 'absent' | 'unconfigured'

export interface Grant {
  what: string
  on: string
  revoked: boolean
  grantable: boolean
  statement: string
  direct: boolean
  via: string[]
}

export interface MyGrants {
  user: string
  roles: string[]
  grants: Grant[]
  revokes: Grant[]
  /** Set where a role's own grants could not be read, so a short list does not
   *  read as a complete one. */
  partial?: string
}

export interface Reading {
  reached_ms: number
  version: string
  databases?: number
  objects?: number
  nodes?: number
  /** Keyed by the bare system table name. A key that is *missing* means the
   *  probe itself failed — a socket, not a verdict — and is not the same as
   *  `denied`. */
  reach: Partial<Record<string, ReachWord>>
  grants?: MyGrants
}

export interface Preflight {
  reading: Reading
  /** Whether this deployment has a backup destination at all. */
  backups: boolean
  /** Where Flint keeps what you save, or null when it keeps nothing. */
  workspace: string | null
  /** Whether anything runs on a timer. A workspace no longer implies one. */
  scheduled: boolean
}

export type Verdict = 'granted' | 'refused' | 'partial' | 'off'

export interface Capability {
  id: string
  /** The sections this row stands for, in the words of the navigation. */
  label: string
  /** What the verdict rests on, in the server's own vocabulary: what is held
   *  where it is granted, what is missing where it is not. Monospaced, because
   *  every one of these is an identifier or a privilege rather than prose. */
  rests: string
  verdict: Verdict
  /** The word in the right-hand column. Not derived from the verdict: `off` is
   *  four different sentences depending on which thing is absent, and "off" on
   *  its own answers none of them. */
  word: string
}

/** Whether a privilege list carries one privilege.
 *
 *  Split rather than searched, because `SELECT` is a substring of nothing
 *  useful but `CREATE` is a substring of `CREATE TABLE`, `CREATE VIEW`,
 *  `CREATE TEMPORARY TABLE` — and a superuser's line, measured on a real
 *  server, is forty privileges long. A column list makes it worse:
 *  `SELECT(on_time)` is a SELECT, and `includes('SELECT')` on the raw string
 *  would also match `displaySecretsInShowAndSelect`.
 */
export function carries(what: string, privilege: string): boolean {
  return what
    .split(',')
    .map((p) => p.trim())
    .some((p) => p === privilege || p.startsWith(`${privilege}(`))
}

/** Everything a privilege is held on, named once each and shortest first.
 *
 *  Capped, and the cap counts itself. `GRANT SELECT ON *.*` to a user with
 *  eleven databases is one line; a per-database grant is eleven, and printing
 *  all of them turns a verdict somebody was meant to be able to check into a
 *  paragraph they will not read. */
export function heldOn(grants: Grant[], privilege: string, limit = 3): string[] {
  const on = grants
    .filter((g) => !g.revoked && carries(g.what, privilege))
    .map((g) => g.on)
  const unique = [...new Set(on)]
  /* `*.*` swallows the rest: a wildcard over everything and a grant on one
     database beside it is one fact, and the narrower one adds nothing to a line
     whose job is to say what the reader may touch. */
  if (unique.includes('*.*')) return ['*.*']
  unique.sort((a, b) => a.length - b.length || a.localeCompare(b))
  if (unique.length <= limit) return unique
  return [...unique.slice(0, limit), `and ${unique.length - limit} more`]
}

/** The user's own objects, excluding the server's furniture. A `SELECT` on
 *  `system.query_log` is what the Diagnostics row rests on, and repeating it
 *  under "Explore" would credit one grant to two capabilities. */
function ownData(grants: Grant[]): Grant[] {
  return grants.filter((g) => !g.on.startsWith('system.') && g.on !== 'system.*')
}

const SYSTEM = 'system'

/** The six things the panel checks, in the order somebody asks about them.
 *
 *  Exported because the panel has an *empty* state — the checks are listed
 *  before Flint has asked the server anything, so you can see what is about to
 *  be measured — and a second copy of these labels for that state is a second
 *  copy to fall out of date. `capabilities` returns the same ids in the same
 *  order, and a test holds the two together. */
export const CHECKS: { id: string; label: string }[] = [
  { id: 'explore', label: 'Explore, query, dashboards' },
  { id: 'diagnostics', label: 'Query cost diagnostics' },
  { id: 'pipelines', label: 'Pipelines and health' },
  { id: 'schedule', label: 'Alerts and scheduled reports' },
  { id: 'backups', label: 'Backup and restore' },
  { id: 'access', label: 'Access and audit review' },
]

const labelOf = (id: string): string => CHECKS.find((c) => c.id === id)?.label ?? id

/** One row, for one thing the reader will or will not be able to do.
 *
 *  Order is the order somebody asks: what they came for first (the data), then
 *  what it cost, then what the server is doing, then the three that depend on
 *  the deployment as much as on the grants. */
export function capabilities(pre: Preflight): Capability[] {
  const { reading } = pre
  const reach = (table: string): ReachWord | undefined => reading.reach[table]
  const grants = reading.grants?.grants ?? []
  const knowGrants = reading.grants !== undefined

  return [
    explore(reach('tables'), reading.databases, grants),
    diagnostics(reach('query_log')),
    pipelines(reach('parts'), reach('merges')),
    schedule(pre),
    backups(pre, grants, knowGrants),
    access(reach('users'), reach('session_log')),
  ]
}

function explore(
  tables: ReachWord | undefined,
  databases: number | undefined,
  grants: Grant[],
): Capability {
  const held = heldOn(ownData(grants), 'SELECT')
  const base = {
    id: 'explore',
    label: labelOf('explore'),
    rests: held.length ? `SELECT on ${held.join(', ')}` : 'SELECT on a database',
  }
  if (tables === 'denied') return { ...base, verdict: 'refused', word: 'refused' }
  if (tables === undefined) return { ...base, verdict: 'partial', word: 'could not tell' }
  /* Readable and empty. Not a refusal — the reader may ask, and there is
     nothing to ask about, which is a different morning entirely: a grant will
     not fix an empty server. `databases` counts what this user can see, so 1
     is `system` alone. */
  if (databases !== undefined && databases <= 1) {
    return { ...base, verdict: 'off', word: 'nothing granted' }
  }
  return { ...base, verdict: 'granted', word: 'granted' }
}

function diagnostics(log: ReachWord | undefined): Capability {
  const base = {
    id: 'diagnostics',
    label: labelOf('diagnostics'),
    rests: `SELECT on ${SYSTEM}.query_log`,
  }
  switch (log) {
    case 'readable':
      return { ...base, verdict: 'granted', word: 'granted' }
    case 'denied':
      return { ...base, verdict: 'refused', word: 'refused' }
    /* The log is a server setting, and it is off. A GRANT will not turn it on,
       so this must not say "refused" — that sends somebody to edit access
       control for something access control never touched. */
    case 'absent':
      return { ...base, verdict: 'off', word: 'switched off' }
    default:
      return { ...base, verdict: 'partial', word: 'could not tell' }
  }
}

function pipelines(parts: ReachWord | undefined, merges: ReachWord | undefined): Capability {
  const base = {
    id: 'pipelines',
    label: labelOf('pipelines'),
    rests: `SELECT on ${SYSTEM}.parts, ${SYSTEM}.merges`,
  }
  const ok = [parts, merges].filter((r) => r === 'readable').length
  if (ok === 2) return { ...base, verdict: 'granted', word: 'granted' }
  if (ok === 0) return { ...base, verdict: 'refused', word: 'refused' }
  /* Half of it. Named rather than rounded either way: the storage figures come
     from `parts` and what the server is *doing* comes from `merges`, so which
     half is missing decides which page is thin. */
  const missing = parts === 'readable' ? 'merges' : 'parts'
  return { ...base, verdict: 'partial', word: `no ${SYSTEM}.${missing}` }
}

/** Alerts and Reports, which no grant decides.
 *
 *  Flint writes its own bookkeeping with its own account, so the reader's
 *  `CREATE TABLE` is not the gate and naming it here would be a plausible
 *  sentence that is false. Two deployment facts are the gate: somewhere to keep
 *  what you save, and something that ticks. They came apart when the workspace
 *  got a server of its own — an unpinned Flint can now remember a dashboard
 *  while having no server to *ask* on a timer — so they are two verdicts, not
 *  one. */
function schedule(pre: Preflight): Capability {
  const base = { id: 'schedule', label: labelOf('schedule') }
  if (!pre.workspace) {
    return {
      ...base,
      rests: 'FLINT_WORKSPACE_DATABASE',
      verdict: 'off',
      word: 'nothing kept',
    }
  }
  if (!pre.scheduled) {
    return {
      ...base,
      rests: `${pre.workspace}, and a server in the manifest`,
      verdict: 'off',
      word: 'no schedule',
    }
  }
  return { ...base, rests: pre.workspace, verdict: 'granted', word: 'granted' }
}

function backups(pre: Preflight, grants: Grant[], knowGrants: boolean): Capability {
  const base = { id: 'backups', label: labelOf('backups') }
  /* The disk first, and before the grants are even looked at. A user who holds
     BACKUP on a Flint with nowhere to write it cannot take a backup, and
     telling them the privilege is granted would be true and useless. */
  if (!pre.backups) {
    return {
      ...base,
      rests: 'FLINT_BACKUP_DISK, sanctioned by the server',
      verdict: 'off',
      word: 'no disk',
    }
  }
  if (!knowGrants) {
    return { ...base, rests: 'BACKUP, RESTORE', verdict: 'partial', word: 'could not tell' }
  }
  const held = heldOn(grants, 'BACKUP')
  if (!held.length) {
    return { ...base, rests: 'BACKUP, RESTORE', verdict: 'refused', word: 'refused' }
  }
  return { ...base, rests: `BACKUP on ${held.join(', ')}`, verdict: 'granted', word: 'granted' }
}

function access(users: ReachWord | undefined, log: ReachWord | undefined): Capability {
  const base = {
    id: 'access',
    label: labelOf('access'),
    rests: `${SYSTEM}.users, ${SYSTEM}.session_log`,
  }
  if (users === 'denied') return { ...base, verdict: 'refused', word: 'refused' }
  if (users !== 'readable') return { ...base, verdict: 'partial', word: 'could not tell' }
  if (log === 'readable') return { ...base, verdict: 'granted', word: 'granted' }
  /* Who exists, without what they did. `session_log` is off by default on a
     good many servers, so this is the ordinary case rather than the odd one. */
  if (log === 'absent') return { ...base, verdict: 'partial', word: 'no history' }
  return { ...base, verdict: 'partial', word: 'users only' }
}

export interface Consequence {
  id: string
  /** What will be different, in the words of the thing that changes. */
  title: string
  body: string
}

/** What a reader will actually notice, for the verdicts that change the app.
 *
 *  Not one per row. A row that says "refused" beside the privilege it wants has
 *  already explained itself; these are for the cases where the *consequence* is
 *  somewhere else — a tab that will not be there, a page that will be thin —
 *  because a section quietly missing from the navigation is the thing people
 *  file bugs about.
 *
 *  One sentence each, and none of them repeats the environment variable or the
 *  system table its row already names. Three of these can fire at once — a
 *  stateless Flint with no backup disk on a server whose session log is off,
 *  which is an ordinary laptop — and at a paragraph apiece that was eighteen
 *  lines of prose under a panel of six two-line rows. The row says what is
 *  missing; the note says what you will notice. */
export function consequences(pre: Preflight, rows = capabilities(pre)): Consequence[] {
  const by = (id: string) => rows.find((r) => r.id === id)
  const out: Consequence[] = []

  if (by('explore')?.verdict !== 'granted') {
    out.push({
      id: 'explore',
      title: 'There will be nothing to explore',
      body: 'Signing in will work and every page will be empty.',
    })
  }
  if (by('backups')?.verdict === 'off') {
    out.push({
      id: 'backups',
      title: 'Backups will be hidden',
      body: 'There is nowhere for this Flint to write one.',
    })
  }
  if (by('schedule')?.verdict === 'off') {
    out.push({
      id: 'schedule',
      title: 'Alerts and Reports will be hidden',
      body: pre.workspace
        ? 'Nothing here runs on a timer, and an alert is a question on a schedule.'
        : 'This Flint writes nothing down, so Dashboards and saved queries go with them.',
    })
  }
  if (by('diagnostics')?.verdict === 'off') {
    out.push({
      id: 'diagnostics',
      title: 'Diagnostics will be empty',
      body: 'The log is off server-wide, so no tool can read what a query cost. A setting, not a grant.',
    })
  }
  if (by('access')?.word === 'no history') {
    out.push({
      id: 'access',
      title: 'Audit will show who exists, not what they did',
      body: 'The session log is off on this server, so there is no sign-in history.',
    })
  }
  return out
}

/** The footer line: what Flint found, in the order it matters.
 *
 *  Every figure drops rather than dashing when it is absent, which is the
 *  house rule — a count that was refused is not a count of zero, and four
 *  em-dashes on a sign-in screen say Flint asked the wrong question. */
export function detected(reading: Reading): string[] {
  const parts: string[] = []
  if (reading.version) parts.push(`v${reading.version}`)
  if (reading.databases !== undefined) parts.push(plural(reading.databases, 'database'))
  if (reading.objects !== undefined) parts.push(plural(reading.objects, 'object'))
  /* One node is "single node" rather than "1 node": the figure is not the point,
     the shape is, and a cluster of one is the thing an operator wants named. */
  if (reading.nodes !== undefined) {
    parts.push(reading.nodes === 1 ? 'single node' : plural(reading.nodes, 'node'))
  }
  return parts
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** What the endpoint field can honestly say when the probe came back an error.
 *
 *  Found in the browser, and it was a lie: a wrong password put "no answer"
 *  beside an address that had answered in five milliseconds. The three failures
 *  are three different mornings and only one of them is about the field they sit
 *  in —
 *
 *  - **401.** The socket opened, ClickHouse replied, and it refused the
 *    credentials. The address is *right*, so the field says so and the panel
 *    carries the refusal. There is no duration to report: the error arrived
 *    instead of the answer that was being timed.
 *  - **not ClickHouse.** Something answered and it was not a database. That is
 *    about the address, and it is the one failure this field should be loud
 *    about.
 *  - **anything else.** Nothing answered.
 *
 *  Returns `null` where there is nothing to say, rather than a word for it. */
export function said(
  error: { status?: number; kind?: string } | null | undefined,
): { word: string; tone: 'ok' | 'no' | 'plain' } | null {
  if (!error) return null
  if (error.status === 401) return { word: 'reached', tone: 'ok' }
  if (error.kind === 'not_clickhouse') return { word: 'not ClickHouse', tone: 'no' }
  return { word: 'no answer', tone: 'plain' }
}

/** How long the first round trip took, said the way somebody reads it.
 *
 *  Sub-millisecond is reported as `<1 ms` rather than `0 ms`: a zero is a
 *  measurement that failed, and this one succeeded faster than the clock. */
export function reached(ms: number): string {
  if (ms <= 0) return 'reached in <1 ms'
  if (ms < 1000) return `reached in ${ms} ms`
  return `reached in ${(ms / 1000).toFixed(1)} s`
}
