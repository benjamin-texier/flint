/** The two spaces, and which one a page belongs to.
 *
 *  Flint is two products in one binary. **Data** works on rows: explore, query,
 *  visualise, expose. **Infrastructure** works on structure and on the server:
 *  replication, health, access. They share a binary, a connection and a design
 *  system, and they must never share a screen — an analyst opening Flint to
 *  answer a question should not pass a `DROP PARTITION` button on the way, and
 *  an operator draining a replica should not walk through somebody's dashboards
 *  to reach the replication queue.
 *
 *  The membership rule is the URL prefix and nothing else. A page is
 *  Infrastructure because it lives under `/infra`, which means the question
 *  "which space am I in" is answerable from the address bar alone — by the nav,
 *  by a bookmark, and by whoever reads a link somebody pasted. */

export type SpaceId = 'data' | 'infra'

/** What the deployment lets Flint do. Ordered; every tier carries the ones
 *  below it. Mirrors `config::Tier` in the backend, which is the authority. */
export type Tier = 'read' | 'data' | 'ddl' | 'admin'

const ORDER: Tier[] = ['read', 'data', 'ddl', 'admin']

/** Whether a tier reaches a required one. For gating an action, never for
 *  gating a read: everything Flint displays today changes nothing. */
export function allows(tier: Tier | undefined, need: Tier): boolean {
  return ORDER.indexOf(tier ?? 'read') >= ORDER.indexOf(need)
}

export interface Section {
  id: string
  to: string
  label: string
  /** The `to` that concerns point at, when this section carries a badge. */
  badge?: string
  /** What the deployment must have for this section to exist. `'workspace'`
   *  means the page has nothing to show and nothing to write without
   *  `FLINT_WORKSPACE_DATABASE` — see `spacesFor`.
   *
   *  `'schedule'` is the stricter one, and it exists because a workspace stopped
   *  implying a schedule. `FLINT_WORKSPACE_URL` lets Flint keep its own tables on
   *  a server of its own, so an unpinned deployment can now save things while
   *  having no server to *ask* — the browser names that one at sign-in, which is
   *  too late for something that ticks. An alert or a report is a question on a
   *  timer, so it needs both halves; a dashboard only needs somewhere to be
   *  written down. Every `'schedule'` section also needs a workspace, which
   *  `dataFor` relies on rather than restating per section. */
  needs?: 'workspace' | 'schedule'
  /** Whether this section holds only its own path, rather than everything
   *  underneath it.
   *
   *  For the one section whose `to` is a prefix of its siblings': `/infra` is a
   *  page in its own right *and* the stem of `/infra/health`, so the ordinary
   *  prefix rule would give it every Infrastructure page and light `Home` on all
   *  eight of them. See `activeSection`. */
  exact?: boolean
}

export interface Space {
  id: SpaceId
  label: string
  /** Where the space link goes: its first section. */
  home: string
  sections: Section[]
}

/** Data's sections, in the order somebody asks for them.
 *
 *  `Home` first, and it is the one section that is about Flint rather than
 *  about ClickHouse: what this workspace has been made to answer. Infrastructure
 *  has had a board behind its own name since `/infra` stopped redirecting to
 *  Health; Data's name landed on a database, which answers "what is on this
 *  server" and never "what is this workspace for". See `lib/workspace` for why
 *  it is not — and must not become — an inventory of the server.
 *
 *  The two ways *in* to the data stay adjacent — Explore browses the schema,
 *  Query asks it something — because separating them made a reader cross a
 *  divider to find the other half of one idea. Then what Flint keeps, then what
 *  it watches. Alerts before Reports: an alert that has fired is more urgent
 *  than a report that is due.
 *
 *  `Build` was a third entry here and is not one any more. It was never a
 *  different product from Query: same database, same run, same results, same
 *  charts — only a different surface to compose on, and two nav entries for one
 *  page meant every affordance had to be built twice and half of them only ever
 *  were once. It is a switch inside Query now, per tab, and `/build` still
 *  resolves for the bookmarks. The labels are verbs rather than the nouns of the
 *  product brief. */
const DATA: Space = {
  id: 'data',
  label: 'Data',
  home: '/home',
  sections: [
    { id: 'home', to: '/home', label: 'Home', needs: 'workspace' },
    { id: 'explore', to: '/', label: 'Explore' },
    { id: 'query', to: '/query', label: 'Query' },
    { id: 'dash', to: '/dash', label: 'Dashboards', needs: 'workspace' },
    { id: 'alerts', to: '/alerts', label: 'Alerts', badge: '/alerts', needs: 'schedule' },
    { id: 'reports', to: '/reports', label: 'Reports', badge: '/reports', needs: 'schedule' },
    { id: 'apis', to: '/apis', label: 'APIs', needs: 'workspace' },
    { id: 'diagnose', to: '/diagnose', label: 'Diagnostics' },
  ],
}

/** Infrastructure's sections.
 *
 *  `Home` first, then the eight that exist. Versions is planned and absent,
 *  and absent means absent: a navigation entry leading to "not built yet" is a
 *  promise made in the wrong place. See ROADMAP.md.
 *
 *  `Clusters` rather than `Replication`, now that there is a topology to draw:
 *  the section holds the ring from `system.clusters`, this replica's own queue,
 *  and the distributed DDL ledger, with the per-table replica health inside it.
 *  The old `/infra/replication` path still resolves — it is in bookmarks and in
 *  already-delivered alert webhooks. */
const INFRA: Space = {
  id: 'infra',
  label: 'Infrastructure',
  // The board, not the busiest page. Clicking the space's own name should
  // answer "is anything wrong", and Health answers "what is it doing" — which is
  // the next question, not the first.
  home: '/infra',
  sections: [
    /* The board, and the only way back to it from a page inside the space —
       until this existed, `/infra` was reachable by clicking the space's own
       name and by nothing else, so an operator who had gone into Health had no
       tab that took them back out to "is anything wrong". Data's `Home` made
       the asymmetry visible; it was there before it. */
    { id: 'home', to: '/infra', label: 'Home', exact: true },
    { id: 'health', to: '/infra/health', label: 'Health' },
    { id: 'pipelines', to: '/infra/pipelines', label: 'Pipelines' },
    {
      id: 'cluster',
      to: '/infra/cluster',
      label: 'Clusters',
      badge: '/infra/cluster',
    },
    { id: 'schema', to: '/infra/schema', label: 'Schema' },
    { id: 'backups', to: '/infra/backups', label: 'Backups' },
    { id: 'access', to: '/infra/access', label: 'Access' },
    { id: 'config', to: '/infra/config', label: 'Config' },
    { id: 'audit', to: '/infra/audit', label: 'Audit' },
  ],
}

/** Which space a path belongs to. The prefix is the whole rule. */
export function spaceOf(pathname: string): SpaceId {
  return pathname === '/infra' || pathname.startsWith('/infra/') ? 'infra' : 'data'
}

/** The one page that belongs to neither space.
 *
 *  The membership rule above is load-bearing and this is a deliberate
 *  exception to it, so it is written here beside the rule rather than left to
 *  be discovered in the chrome.
 *
 *  The checkup reports on the schema, the workload, the machine and what is
 *  not covered — which is both spaces at once, and putting it in either would
 *  make half of what it says look like it belonged somewhere else. It gets to
 *  do that because **it holds no controls**: every finding links to the page
 *  that acts, and that page keeps its own space, its own tier and its own
 *  confirmation. The rule the two spaces exist to enforce is about controls,
 *  and this page has none to misplace.
 *
 *  A page reached from here therefore *changes* space, which is why the link
 *  to it sits outside the space bar rather than in either space's sections. */
export function outsideSpaces(pathname: string): boolean {
  return pathname === '/checkup'
}

/** The spaces this deployment has, with the sections it can actually serve.
 *
 *  Infrastructure can be switched off whole, which is the point of it being a
 *  space: a team that only ever queries turns it off and never learns the other
 *  half is there. Undefined config means the answer has not arrived yet — show
 *  Data alone rather than flashing a section that may be about to vanish.
 *
 *  Five of Data's sections need somewhere to write. Home, Dashboards, Alerts,
 *  Reports and APIs are all *things Flint keeps*, and a Flint started without
 *  `FLINT_WORKSPACE_DATABASE` keeps nothing — by design, not by failure. Four of
 *  them used to be in the bar on such a deployment and each one opened on an
 *  error, which reads as four broken pages rather than one deliberate mode. So
 *  they are absent instead, and the bar carries a single note saying why (see
 *  `Chrome`) — the same rule Infrastructure already follows: a capability the
 *  deployment does not have is not offered and then refused.
 *
 *  Their routes stay: a bookmark or a pasted link still resolves, onto a page
 *  that explains the one line of configuration that brings it back. */
export function spacesFor(
  config:
    | { infrastructure?: boolean; workspace?: string | null; scheduled?: boolean }
    | undefined,
): Space[] {
  const data = dataFor(config)
  return config?.infrastructure ? [data, INFRA] : [data]
}

/** Data, with only the sections this deployment can serve.
 *
 *  The space's own link moves with them. `Data` points at the home, which is one
 *  of the five — so on a stateless deployment it points at the schema instead,
 *  the way it always did. A space name that opens the page explaining why the
 *  page is not there would be the refusal this whole rule exists to avoid.
 *
 *  A copy, never the table: `spaceById` hands `DATA` itself to everyone, and
 *  filtering in place would drop the five sections for the rest of the session
 *  the first time a stateless answer arrived. */
export function dataFor(
  config: { workspace?: string | null; scheduled?: boolean } | undefined,
): Space {
  if (keeps(config) && runs(config)) return DATA
  // Two gates rather than one, and the order matters only in that a deployment
  // with no workspace has no schedule either — so the first filter subsumes the
  // second and the home link moves. With a workspace but nothing to ask, Home
  // stays where it is and only the two timed sections go.
  const sections = DATA.sections.filter(
    (s) => (s.needs !== 'workspace' || keeps(config)) && (s.needs !== 'schedule' || runs(config)),
  )
  return keeps(config) ? { ...DATA, sections } : { ...DATA, home: '/', sections }
}

/** Whether this deployment keeps anything at all.
 *
 *  One reading of `config.workspace` for the whole frontend: pages gate their
 *  requests on it rather than firing them and rendering the refusal, which is
 *  what put an error box under every one of those pages' own explanations.
 *  Undefined config counts as stateless — the queries wait one tick for the
 *  answer instead of guessing at it. */
export function keeps(config: { workspace?: string | null } | undefined): boolean {
  return Boolean(config?.workspace)
}

/** Whether anything on this deployment runs on a timer.
 *
 *  A stricter `keeps`. The backend decides it — a workspace *and* a pinned
 *  server — and sends one boolean, because the frontend reading two fields and
 *  combining them itself is the same rule written in two places, and the second
 *  copy is the one that goes stale. Undefined counts as no, for `keeps`' reason:
 *  waiting a tick beats guessing. */
export function runs(config: { scheduled?: boolean } | undefined): boolean {
  return Boolean(config?.scheduled)
}

export function spaceById(id: SpaceId): Space {
  return id === 'infra' ? INFRA : DATA
}

/** Which section holds the current page.
 *
 *  `Explore` owns everything in Data that is not one of the others — a table, a
 *  database, the server page — because those are all ways of browsing the
 *  schema. Infrastructure has no such catch-all: every one of its pages is a
 *  section, so an unrecognised `/infra/...` path lights nothing rather than
 *  lighting the first thing.
 *
 *  A section marked `exact` holds only its own path. That is Infrastructure's
 *  `Home`, whose `/infra` is the stem of every sibling: under the plain prefix
 *  rule it would claim all eight of them, and the bar would light `Home` while
 *  the reader was looking at Health. It also keeps the no-catch-all rule intact
 *  — `/infra/versions` still lights nothing rather than falling back to the
 *  board, because a path nobody recognises is not the board. */
export function activeSection(pathname: string): string | undefined {
  const space = spaceById(spaceOf(pathname))
  const hit = space.sections.find((s) =>
    s.exact ? pathname === s.to : s.to !== '/' && pathname.startsWith(s.to),
  )
  if (hit) return hit.id
  return space.id === 'data' ? 'explore' : undefined
}

/** How many concerns belong to a space, for the badge on its name.
 *
 *  Derived from where each concern points rather than from a field on the
 *  concern, so the split follows the routes and cannot drift out of step with
 *  them. Splitting the count at all is the point: a Data user inheriting an
 *  alarm about a replica they cannot touch is noise, and an operator missing it
 *  because it was filed under somebody's dashboard is worse. */
export function countIn(items: { to: string }[], space: SpaceId): number {
  return items.filter((i) => spaceOf(i.to) === space).length
}
