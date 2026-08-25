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
 *  The three ways *in* to the data stay adjacent — Explore browses the schema,
 *  Query writes the SQL, Build asks without writing any — because separating
 *  them made a reader cross a divider to find the other half of one idea. Then
 *  what Flint keeps, then what it watches. Alerts before Reports: an alert that
 *  has fired is more urgent than a report that is due.
 *
 *  The labels are verbs rather than the nouns of the product brief. `Build` is a
 *  query builder, not a gallery — calling it "Charts" would send someone
 *  looking for a page that does not exist, since charts come out of both Query
 *  and Build. */
const DATA: Space = {
  id: 'data',
  label: 'Data',
  home: '/',
  sections: [
    { id: 'explore', to: '/', label: 'Explore' },
    { id: 'query', to: '/query', label: 'Query' },
    { id: 'build', to: '/build', label: 'Build' },
    { id: 'dash', to: '/dash', label: 'Dashboards' },
    { id: 'alerts', to: '/alerts', label: 'Alerts', badge: '/alerts' },
    { id: 'reports', to: '/reports', label: 'Reports', badge: '/reports' },
    { id: 'apis', to: '/apis', label: 'APIs' },
    { id: 'diagnose', to: '/diagnose', label: 'Diagnostics' },
  ],
}

/** Infrastructure's sections — the four that exist.
 *
 *  Backups, Versions, Configuration, Schema and Audit are planned and absent,
 *  and absent means absent: a navigation entry leading to "not built yet" is a
 *  promise made in the wrong place. See ROADMAP.md.
 *
 *  `Replication` rather than `Clusters`, because `system.replicas` is what Flint
 *  reads today. It becomes Clusters when there is a topology to draw. */
const INFRA: Space = {
  id: 'infra',
  label: 'Infrastructure',
  home: '/infra/health',
  sections: [
    { id: 'health', to: '/infra/health', label: 'Health' },
    { id: 'pipelines', to: '/infra/pipelines', label: 'Pipelines' },
    {
      id: 'replication',
      to: '/infra/replication',
      label: 'Replication',
      badge: '/infra/replication',
    },
    { id: 'access', to: '/infra/access', label: 'Access' },
  ],
}

/** Which space a path belongs to. The prefix is the whole rule. */
export function spaceOf(pathname: string): SpaceId {
  return pathname === '/infra' || pathname.startsWith('/infra/') ? 'infra' : 'data'
}

/** The spaces this deployment has.
 *
 *  Infrastructure can be switched off whole, which is the point of it being a
 *  space: a team that only ever queries turns it off and never learns the other
 *  half is there. Undefined config means the answer has not arrived yet — show
 *  Data alone rather than flashing a section that may be about to vanish. */
export function spacesFor(config: { infrastructure?: boolean } | undefined): Space[] {
  return config?.infrastructure ? [DATA, INFRA] : [DATA]
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
 *  lighting the first thing. */
export function activeSection(pathname: string): string | undefined {
  const space = spaceById(spaceOf(pathname))
  const hit = space.sections.find((s) => s.to !== '/' && pathname.startsWith(s.to))
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
