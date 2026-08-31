/** Published endpoints, as the UI sees them.
 *
 *  The parameter list is discovered from the statement, exactly as the server
 *  does it, so the form can show what an endpoint will ask its callers for
 *  without a round trip — and so the two can never disagree about it. */

export interface Published {
  id: string
  name: string
  slug: string
  sql: string
  database: string
  /** JSON object of defaults, `{"days":"7"}`. */
  defaults: string
  /** Whether the stored token is hashed. False means this endpoint predates
   *  hashing and its token is sitting in the workspace in clear — one rotation
   *  fixes it, and nobody would know to without being told. The token itself is
   *  never on the wire: it is readable once, at the moment it is minted. */
  token_hashed: boolean
  /** Empty for an endpoint that does not expire. */
  expires_at: string
  /** The role a call assumes, or empty for the account in the manifest. */
  run_as: string
  /** Where this endpoint's days begin, or empty for the server's own zone.
   *  The endpoint's and not the caller's: two people asking this address on
   *  the same afternoon have to be shown the same days. */
  timezone: string
  public: boolean
  enabled: boolean
  max_rows: number
  created_at: string
  updated_at: string
  /** The contract revision — the number in `?v=`, and the one people mean when
   *  they say "we are still on v3". Several revisions share one address. */
  revision: number
  state: RevisionState
  /** The sentence a caller reads before writing the call. */
  description: string
  /** Seconds an answer may be served from memory. 0 is no cache. */
  cache_ttl: number
  /** The revision's promises, as JSON — see `Contract`. Empty promises only
   *  what the statement's placeholders already say. */
  contract: string
  published_by: string
  /** What the statement reads from, derived on the server from the statement
   *  itself. Absent where reading it does not say — a join, a table function —
   *  and absent is dropped rather than dashed. */
  source?: string
}

/** Where a revision sits in its life. One way, and the order is the order. */
export type RevisionState = 'draft' | 'live' | 'retiring' | 'retired'

/** What each state means, in the words the page uses. Kept here rather than in
 *  the component because both pages say it and they must say the same thing. */
export const STATE_NOTE: Record<RevisionState, string> = {
  draft: 'Reachable at no address. Review its parameters and columns before anything outside can call it.',
  live: 'What a bare address reaches. Exactly one revision per address is live.',
  retiring: 'Still answering, and on notice. Callers pinned to it keep working; Flint will not delete it while it is being called.',
  retired: 'Answers exactly as an address that never existed.',
}

/** Whether a call can reach this revision at all. */
export function answers(state: RevisionState): boolean {
  return state === 'live' || state === 'retiring'
}

/** The promises a revision makes. Mirrors `published::contract::Contract`. */
export interface Contract {
  params: ParamRule[]
  columns: Exposure
  /** The columns `?order=` accepts. Empty means sorting is not offered. */
  order_by: string[]
  max_limit?: number
}

export interface ParamRule {
  name: string
  min?: string
  max?: string
  one_of?: string[]
  /** The far end of a window this parameter opens, and how wide it may get. */
  window_to?: string
  window_days?: number
  note?: string
}

export interface Exposure {
  /** An allow-list. Empty means every column the statement returns. */
  only?: string[]
  /** A deny-list, applied after it — a column in both is denied. */
  never?: string[]
}

export const EMPTY_CONTRACT: Contract = { params: [], columns: {}, order_by: [] }

/** Read a stored contract.
 *
 *  Unparseable is empty rather than an error, matching the server: a contract
 *  that promises nothing is the state every endpoint was in before contracts
 *  existed, and a page that refused to render over it would hide the very
 *  endpoint somebody needs to go and fix. */
export function parseContract(raw: string): Contract {
  if (!raw?.trim()) return EMPTY_CONTRACT
  try {
    const parsed = JSON.parse(raw) as Partial<Contract>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY_CONTRACT
    return {
      params: Array.isArray(parsed.params) ? parsed.params : [],
      columns: parsed.columns && typeof parsed.columns === 'object' ? parsed.columns : {},
      order_by: Array.isArray(parsed.order_by) ? parsed.order_by : [],
      max_limit: typeof parsed.max_limit === 'number' ? parsed.max_limit : undefined,
    }
  } catch {
    return EMPTY_CONTRACT
  }
}

/** The two ways a contract can name a column the statement does not return.
 *
 *  They look alike and are not, and lumping them together produces a sentence
 *  that is wrong about one of them.
 *
 *  A name in `only` or `order_by` is a column the endpoint **offers and cannot
 *  produce**. Every reader handles it differently and none well: the OpenAPI
 *  document and the tool definition drop it, so a caller never learns it was
 *  offered; the page shows it, so a person believes it is there; and a caller
 *  who asks for it by name gets a ClickHouse error about an unknown identifier,
 *  which tells them nothing they can act on.
 *
 *  A name in `never` is a column the deny-list is **guarding and cannot find**.
 *  That is harmless on its own — it refuses something nobody can ask for — but
 *  it is almost never what somebody meant. A `never: ["device_ids"]` beside a
 *  returned `device_id` reads as protection and is none, and the column it was
 *  written to keep inside is leaving on every call.
 *
 *  Nothing is reported where `returns` is empty: that is "nobody has asked what
 *  this statement returns yet" rather than "it returns nothing", and flagging
 *  every column of an untested statement would train people to ignore this. */
export interface StalePromises {
  /** Named as available, and not there. */
  offered: string[]
  /** Named as forbidden, and not there — so guarding nothing. */
  guarding: string[]
}

export function unkeepablePromises(contract: Contract, returns: string[]): StalePromises {
  if (returns.length === 0) return { offered: [], guarding: [] }
  const has = new Set(returns)
  const missing = (names: string[]) => [...new Set(names.filter((n) => !has.has(n)))]
  return {
    // De-duplicated across the two lists it can come from: a name in both
    // `only` and `order_by` is one mistake, not two.
    offered: missing([...(contract.columns.only ?? []), ...contract.order_by]),
    guarding: missing(contract.columns.never ?? []),
  }
}

/** A list of column names, as the sentences here quote them. */
export function quoted(names: string[]): string {
  return names.map((n) => `\`${n}\``).join(', ')
}

export function contractIsEmpty(contract: Contract): boolean {
  return (
    contract.params.length === 0 &&
    !contract.columns.only?.length &&
    !contract.columns.never?.length &&
    contract.order_by.length === 0 &&
    contract.max_limit === undefined
  )
}

/** One address, with every revision of it — what the list page shows as a
 *  group and the detail page opens on.
 *
 *  `live` can be absent: an address whose only revision is a draft has never
 *  answered anything, and that is a state the page has to be able to draw
 *  rather than a case to filter out. */
export interface Address {
  slug: string
  name: string
  revisions: Published[]
  live?: Published
  /** The revision the page opens on: the live one, or the newest thing there
   *  is where nothing is live. */
  current: Published
}

/** Group revisions into addresses, newest revision first within each.
 *
 *  The server already orders by slug then revision, but the page must not
 *  depend on that: a grouping that is only correct because of an ORDER BY in
 *  another language is a grouping that breaks silently when somebody adds a
 *  filter. */
export function byAddress(rows: Published[]): Address[] {
  const groups = new Map<string, Published[]>()
  for (const row of rows) {
    const held = groups.get(row.slug)
    if (held) held.push(row)
    else groups.set(row.slug, [row])
  }
  const out: Address[] = []
  for (const [slug, revisions] of groups) {
    revisions.sort((a, b) => b.revision - a.revision)
    const live = revisions.find((r) => r.state === 'live')
    const current = live ?? revisions[0]
    if (!current) continue
    out.push({ slug, name: current.name, revisions, live, current })
  }
  // Four bands, in the order somebody scanning this page cares about them: what
  // is serving, what is serving on notice, what is waiting to be reviewed, and
  // what is history. Within a band, alphabetical — the only ordering somebody
  // can predict well enough to find a row without reading every one.
  const rank = (x: Address): number => {
    if (x.live) return 0
    if (x.revisions.some((r) => answers(r.state))) return 1
    if (x.revisions.some((r) => r.state === 'draft')) return 2
    return 3
  }
  out.sort((a, b) => rank(a) - rank(b) || a.slug.localeCompare(b.slug))
  return out
}

/** Which revisions the list shows as their own rows.
 *
 *  Every one that a caller can still reach, plus any draft — because a draft
 *  is precisely the thing somebody needs to see in order to do something about
 *  it. A retired revision is left out and counted instead: it answers nothing
 *  and it is never coming back. */
export function listedRevisions(address: Address): Published[] {
  return address.revisions.filter((r) => answers(r.state) || r.state === 'draft')
}

/** How many revisions of this address the list is not showing, and why.
 *
 *  Every cap, fold or filter states its own count. */
export function hiddenNote(address: Address): string | null {
  const hidden = address.revisions.length - listedRevisions(address).length
  if (hidden <= 0) return null
  return `${hidden} retired revision${hidden === 1 ? '' : 's'} not shown`
}

/** The next revision number this address would hand out. */
export function nextRevision(address: Address): number {
  return Math.max(0, ...address.revisions.map((r) => r.revision)) + 1
}

/** Whether this revision's promises can still be edited in place.
 *
 *  A live or retiring revision's statement and contract are frozen — callers
 *  pinned to it pinned to a shape, and changing it under them without changing
 *  the number is worse than no versioning at all. The server enforces this;
 *  the page says it before somebody types. */
export function contractIsFrozen(endpoint: Published): boolean {
  return answers(endpoint.state)
}

/** Mirrors the server's rule: this lands in a URL and in people's scripts. */
export function validSlug(slug: string): boolean {
  return (
    slug.length > 0 &&
    slug.length <= 64 &&
    /^[a-z0-9_-]+$/.test(slug) &&
    !slug.startsWith('-') &&
    !slug.endsWith('-')
  )
}

/** Turn a name into a usable address, so nobody has to learn the rule. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
}

/** The parameters a statement declares, from ClickHouse's own `{name:Type}`
 *  syntax. Sorted and de-duplicated, like the server's. */
export function declaredParams(sql: string): string[] {
  return declaredParamsTyped(sql).map((p) => p.name)
}

/** The same list, with the type each parameter was declared with — which is
 *  what tells a caller whether `since` wants a date or an epoch. */
export function declaredParamsTyped(sql: string): { name: string; type: string }[] {
  const found = new Map<string, string>()
  const re = /\{\s*([A-Za-z0-9_]+)\s*:\s*([^{}]+?)\s*\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(sql)) !== null) {
    if (m[1] && m[2]?.trim() && !found.has(m[1])) found.set(m[1], m[2].trim())
  }
  return [...found.entries()]
    .map(([name, type]) => ({ name, type }))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
}

export function parseDefaults(raw: string): Record<string, string> {
  try {
    const d = JSON.parse(raw)
    if (!d || typeof d !== 'object' || Array.isArray(d)) return {}
    return Object.fromEntries(
      Object.entries(d as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')]),
    )
  } catch {
    return {}
  }
}

export function serialiseDefaults(defaults: Record<string, string>): string {
  // Only the ones with something in them: an empty default is not a default,
  // and storing it would satisfy a required parameter with a blank.
  return JSON.stringify(
    Object.fromEntries(Object.entries(defaults).filter(([, v]) => v.trim() !== '')),
  )
}

/** Which parameters a caller must always supply: declared, with no default. */
export function requiredParams(sql: string, defaults: Record<string, string>): string[] {
  return declaredParams(sql).filter((p) => !(p in defaults))
}

/** The URL of an endpoint, relative to wherever Flint is served from. */
export function endpointPath(slug: string): string {
  return `/api/data/${slug}`
}

/** Where the endpoint describes itself for everything that is not Flint —
 *  Swagger UI, Postman, a client generator. */
export function openapiPath(slug: string): string {
  return `${endpointPath(slug)}/openapi.json`
}

/** The same endpoint, as a tool definition an agent framework can be handed.
 *
 *  Beside the OpenAPI document rather than instead of it: a client generator
 *  wants paths and responses, and a model-calling framework wants one name, one
 *  sentence and one argument schema. Both are generated from the same facts, so
 *  neither can go stale against the other. */
export function toolPath(slug: string): string {
  return `${endpointPath(slug)}/tool.json`
}

/* ── Taking it away ───────────────────────────────────────────────────────
 *
 *  The pitch is that a spreadsheet or a five-line script can fetch this, so the
 *  page had better be able to hand over the five lines. Each snippet pages the
 *  way the endpoint wants to be paged — by following the link it gives you —
 *  because a caller who writes `offset += 100` by hand is the caller this whole
 *  cursor apparatus exists to spare. */

export type SnippetKind = 'curl' | 'python' | 'javascript' | 'sheets'

export const SNIPPETS: { kind: SnippetKind; label: string }[] = [
  { kind: 'curl', label: 'curl' },
  { kind: 'python', label: 'Python' },
  { kind: 'javascript', label: 'JavaScript' },
  { kind: 'sheets', label: 'Spreadsheet' },
]

/** What a snippet shows where the real token is no longer knowable.
 *
 *  It is not knowable on purpose: a token is hashed on its way into the
 *  workspace and handed back exactly once, so a page opened tomorrow has
 *  nothing to paste. Showing a placeholder is the honest version of that —
 *  the alternative, keeping the secret readable so the snippet stays
 *  copy-pasteable, is the thing the hashing was for. */
export const TOKEN_PLACEHOLDER = 'YOUR_TOKEN'

export function snippet(
  kind: SnippetKind,
  endpoint: Published,
  origin: string,
  call: Call,
  token: string = TOKEN_PLACEHOLDER,
): string {
  const url = `${origin}${callUrl(endpoint.slug, call)}`
  switch (kind) {
    case 'curl':
      return curlFor(endpoint, origin, call)
    case 'python':
      return pythonSnippet(endpoint, origin, url, token)
    case 'javascript':
      return javascriptSnippet(endpoint, origin, url, token)
    case 'sheets':
      return sheetsSnippet(endpoint, origin, call, token)
  }
}

function pythonSnippet(
  endpoint: Published,
  origin: string,
  url: string,
  token: string,
): string {
  const headers = endpoint.public
    ? 'headers = {}'
    : `headers = {"X-Flint-Token": "${token}"}`
  return [
    'import requests',
    '',
    `url = "${url}"`,
    headers,
    '',
    'rows = []',
    'while url:',
    '    answer = requests.get(url, headers=headers)',
    '    answer.raise_for_status()',
    '    page = answer.json()',
    '    rows.extend(page["rows"])',
    '    # Follow the link rather than counting: it carries a cursor, so',
    '    # nothing is lost or repeated when rows arrive between two pages.',
    '    next_page = page["page"].get("next")',
    `    url = "${origin}" + next_page if next_page else None`,
    '',
    'print(len(rows), "rows")',
  ].join('\n')
}

function javascriptSnippet(
  endpoint: Published,
  origin: string,
  url: string,
  token: string,
): string {
  const headers = endpoint.public ? '{}' : `{ "X-Flint-Token": "${token}" }`
  return [
    `const headers = ${headers}`,
    `let url = "${url}"`,
    'const rows = []',
    '',
    'while (url) {',
    '  const answer = await fetch(url, { headers })',
    '  if (!answer.ok) throw new Error(await answer.text())',
    '  const page = await answer.json()',
    '  rows.push(...page.rows)',
    '  // The link carries a cursor, so this cannot skip or repeat a row.',
    `  url = page.page.next ? "${origin}" + page.page.next : null`,
    '}',
    '',
    'console.log(rows.length, "rows")',
  ].join('\n')
}

/** A spreadsheet cannot send a header, which is the whole story here. */
function sheetsSnippet(
  endpoint: Published,
  origin: string,
  call: Call,
  token: string,
): string {
  const csv: Call = { ...call, format: 'csv' }
  const pairs = callQuery(csv)
  if (!endpoint.public) pairs.push(['token', token])
  const query = pairs
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
  return `=IMPORTDATA("${origin}${endpointPath(endpoint.slug)}${query ? `?${query}` : ''}")`
}

/** What a reader needs to know before pasting the spreadsheet one. */
export function sheetsCaveat(endpoint: Published): string | null {
  if (endpoint.public) {
    return 'One cell, refreshed on the spreadsheet\'s own schedule. It fetches one page — raise the endpoint\'s row cap if the sheet needs more than one.'
  }
  return 'A spreadsheet cannot send a header, so this is the one place the token goes in the URL — where it lands in the spreadsheet\'s own logs and in anyone\'s screen share of it. Make the endpoint public, or accept that.'
}

/** Every endpoint this Flint publishes, in one document. Needs no token: it is
 *  guarded the way the endpoint list already is. */
export function allOpenapiPath(): string {
  return '/api/published/openapi.json'
}

/** The next page, out of the `Link` header — which every format carries, so
 *  this works for CSV and NDJSON as well as for the JSON envelope. */
export function nextLink(headers: [string, string][]): string | null {
  const link = headers.find(([name]) => name.toLowerCase() === 'link')?.[1]
  const found = link?.match(/<([^>]+)>\s*;\s*rel="next"/)
  return found?.[1] ?? null
}

/** A ready-to-paste example of the simplest call the endpoint takes. */
export function curlExample(
  endpoint: Published,
  origin: string,
  token: string = TOKEN_PLACEHOLDER,
): string {
  return curlFor(endpoint, origin, defaultCall(endpoint), token)
}

/* ── The call itself ──────────────────────────────────────────────────────
 *
 *  Everything below mirrors `src/published/shape.rs`. The two have to agree —
 *  a builder that writes a URL the server reads differently is worse than no
 *  builder at all — so the rules that matter are asserted on both sides. */

/** Query-string names Flint reads for itself. A statement that declares a
 *  parameter of the same name takes it back, and the server says so. */
export const RESERVED = ['token', 'format', 'limit', 'offset', 'order', 'select', 'count']

/** The closed set of filter operators, in the words a reader uses for them. */
export const OPERATORS: { op: string; label: string; takesValue: boolean; list?: boolean }[] = [
  { op: 'eq', label: 'is', takesValue: true },
  { op: 'ne', label: 'is not', takesValue: true },
  { op: 'gt', label: 'is after / above', takesValue: true },
  { op: 'gte', label: 'is at or above', takesValue: true },
  { op: 'lt', label: 'is before / below', takesValue: true },
  { op: 'lte', label: 'is at or below', takesValue: true },
  { op: 'like', label: 'matches', takesValue: true },
  { op: 'ilike', label: 'matches, any case', takesValue: true },
  { op: 'in', label: 'is one of', takesValue: true, list: true },
  { op: 'nin', label: 'is none of', takesValue: true, list: true },
  { op: 'isnull', label: 'is null', takesValue: false },
  { op: 'notnull', label: 'is not null', takesValue: false },
]

export function operatorLabel(op: string): string {
  return OPERATORS.find((o) => o.op === op)?.label ?? op
}

export function operatorTakesValue(op: string): boolean {
  return OPERATORS.find((o) => o.op === op)?.takesValue ?? true
}

export interface ParameterDoc {
  name: string
  type: string
  required: boolean
  default?: string
}

export interface ColumnDoc {
  name: string
  type: string
  /** Empty for a column that is returned but cannot be filtered. */
  filter: string[]
}

/** What `GET /api/data/<slug>/schema` answers. */
export interface EndpointSchema {
  name: string
  slug: string
  method: string
  path: string
  public: boolean
  parameters: ParameterDoc[]
  /** Null when the statement cannot be described without running it. */
  columns: ColumnDoc[] | null
  columns_note?: string
  paging: { max_limit: number; default_limit: number }
  formats: string[]
  reserved: string[]
  /** Reserved names this statement took for itself. */
  shadowed: string[]
}

export interface FilterTerm {
  column: string
  op: string
  value: string
}

export interface SortTerm {
  column: string
  desc: boolean
}

export type CallFormat = 'json' | 'csv' | 'ndjson'

/** One call to an endpoint, as the sandbox holds it. */
export interface Call {
  /** Values for the parameters the statement declares. */
  values: Record<string, string>
  filters: FilterTerm[]
  order: SortTerm[]
  select: string[]
  /** Null leaves it to the endpoint's own page size. */
  limit: number | null
  offset: number
  count: boolean
  format: CallFormat
}

export const emptyCall: Call = {
  values: {},
  filters: [],
  order: [],
  select: [],
  limit: null,
  offset: 0,
  count: false,
  format: 'json',
}

/** The query string, as ordered pairs — parameters first, because they are the
 *  question, and the shape after, because it is only how the answer is cut. */
export function callQuery(call: Call): [string, string][] {
  const pairs: [string, string][] = []
  for (const [name, value] of Object.entries(call.values)) {
    if (value !== '') pairs.push([name, value])
  }
  for (const f of call.filters) {
    if (!f.column) continue
    if (!operatorTakesValue(f.op)) pairs.push([f.column, f.op])
    else if (f.value !== '') pairs.push([f.column, `${f.op}.${f.value}`])
  }
  if (call.select.length) pairs.push(['select', call.select.join(',')])
  if (call.order.length) {
    pairs.push(['order', call.order.map((s) => `${s.column}${s.desc ? '.desc' : ''}`).join(',')])
  }
  if (call.limit !== null) pairs.push(['limit', String(call.limit)])
  if (call.offset > 0) pairs.push(['offset', String(call.offset)])
  if (call.count) pairs.push(['count', 'exact'])
  if (call.format !== 'json') pairs.push(['format', call.format])
  return pairs
}

export function callUrl(slug: string, call: Call): string {
  const pairs = callQuery(call)
  const query = pairs
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
  return `${endpointPath(slug)}${query ? `?${query}` : ''}`
}

/** A ready-to-paste example of this exact call. The token goes in a header
 *  rather than the query string: a token in a URL ends up in logs, in a proxy's
 *  access log and in someone's shell history. */
export function curlFor(
  endpoint: Published,
  origin: string,
  call: Call,
  token: string = TOKEN_PLACEHOLDER,
): string {
  const url = `${origin}${callUrl(endpoint.slug, call)}`
  const auth = endpoint.public ? '' : ` \\\n  -H "X-Flint-Token: ${token}"`
  return `curl "${url}"${auth}`
}

/** The simplest call this endpoint takes: its parameters, at their defaults,
 *  and nothing else. What the card shows before anyone opens the builder. */
export function defaultCall(endpoint: Published): Call {
  const defaults = parseDefaults(endpoint.defaults)
  return {
    ...emptyCall,
    values: Object.fromEntries(
      declaredParams(endpoint.sql).map((p) => [p, defaults[p] ?? `<${p}>`]),
    ),
  }
}

/** Which columns of a schema can be filtered, and which are only returned. */
export function filterable(schema: EndpointSchema | undefined): ColumnDoc[] {
  return (schema?.columns ?? []).filter((c) => c.filter.length > 0)
}

/** The operators this column takes, or every one of them when the schema could
 *  not be read — a builder that offers nothing is worse than one that offers
 *  something the server may refuse by name. */
export function opsFor(schema: EndpointSchema | undefined, column: string): string[] {
  const found = schema?.columns?.find((c) => c.name === column)
  return found ? found.filter : OPERATORS.map((o) => o.op)
}


/** What is wrong with the form, in the reader's terms. */
export function problemWithPublished(input: {
  name: string
  slug: string
  sql: string
}): string | null {
  if (!input.name.trim()) return 'Give the endpoint a name.'
  if (!input.slug.trim()) return 'Give the endpoint an address.'
  if (!validSlug(input.slug.trim())) {
    return 'An address may hold lower-case letters, digits, dashes and underscores only, and may not start or end with a dash.'
  }
  if (!input.sql.trim()) return 'An endpoint needs a statement to serve.'
  return null
}

/* ── Traffic ───────────────────────────────────────────────────────────────
 *
 *  Mirrors `published::usage`. Every figure here comes out of Flint's own call
 *  log rather than `system.query_log`, and the reason is worth repeating where
 *  the page will read it: a cache hit never reaches ClickHouse, a refusal runs
 *  no statement, and a query-log row records the account the statement ran as —
 *  which is Flint's, for every endpoint. Three of these panels cannot be built
 *  from the query log even in principle. */

export interface SlugUsage {
  slug: string
  /** Which revision took these calls. Several rows share a slug. */
  revision: number
  calls: number
  cached: number
  failures: number
  /** Absent where nothing was answered: a revision whose every call in the
   *  window was refused has no p95, and zero would read as instant. */
  p95_ms?: number
  avg_ms?: number
  last_call: string
  keys: number
}

export interface UsageIndex {
  available: boolean
  reason?: string
  window_hours: number
  usage: SlugUsage[]
}

export interface KeyUsage {
  key_id: string
  key_name: string
  owner: string
  calls_today: number
  /** 0 is no limit, and the page draws no bar for it — a meter with no ceiling
   *  is a shape that implies one. */
  quota_per_day: number
  throttled_today: number
  last_call: string
}

export interface CallerUsage {
  /** Empty where the call carried no key: a public endpoint, or one called
   *  with its own shared token. Shown as "no key", never as blank. */
  key_name: string
  label: string
  calls: number
  last_call: string
}

export interface RefusalUsage {
  status: number
  reason: string
  calls: number
  last_call: string
}

export interface CacheUsage {
  ttl: number
  hits: number
  misses: number
  /** Absent where nothing has been served either way. A rate needs a
   *  denominator, and 0% is a claim about an endpoint nobody has called. */
  hit_rate?: number
  avg_hit_ms?: number
  avg_miss_ms?: number
  /** The age of the oldest answer this process could still hand back. Absent
   *  where it holds nothing, which is not an age of zero. */
  oldest_held?: number
  held: number
}

export interface EndpointUsage {
  available: boolean
  reason?: string
  window_hours: number
  cache: CacheUsage
  keys: KeyUsage[]
  callers: CallerUsage[]
  refusals: RefusalUsage[]
  calls: number
  failures: number
}

/** What a revision's statement returns.
 *
 *  `known` is the field that matters: an empty list because Flint could not
 *  describe the statement is a different answer from an empty list because the
 *  statement returns nothing, and only one of them should make a page mark
 *  every promised column as unkeepable. */
export interface EndpointColumns {
  revision: number
  known: boolean
  columns: { name: string; type: string }[]
}

/** What came of exposing a batch of tables.
 *
 *  `skipped` is the half that matters: a caller who asked for fifteen and got
 *  twelve needs to know which three and why, and a count alone sends them
 *  comparing two lists by hand. */
export interface TablesPublished {
  endpoints: Published[]
  published: { table: string; slug: string; minted?: string }[]
  skipped: { table: string; why: string }[]
}

export interface ApiKey {
  id: string
  name: string
  owner: string
  /** The addresses it may call. Empty is every one of them. */
  scope: string[]
  quota_per_day: number
  enabled: boolean
  created_at: string
}

/** The key a traffic row is filed under: one address, one revision.
 *
 *  A composite key rather than a nested map, because every lookup wants both
 *  halves and a two-level map turns "did this revision answer anything" into a
 *  question with two ways of being undefined. */
export function usageKey(slug: string, revision: number): string {
  return `${slug}\u0000${revision}`
}

/** Traffic keyed by address and revision.
 *
 *  A revision absent from the report answered nothing in the window. That is a
 *  different thing from Flint being unable to read the log at all, which is
 *  what `available` says — and the page draws them differently, because "not
 *  called" is a fact and "cannot tell" is not. */
export function usageBySlug(report: UsageIndex | undefined): Map<string, SlugUsage> {
  if (!report?.available) return new Map()
  return new Map(report.usage.map((u) => [usageKey(u.slug, u.revision), u]))
}


/** Calls that never reached a revision at all.
 *
 *  A wrong address, a pin for a revision that does not exist, a missing key:
 *  all refused before Flint knew which revision was being asked for, so they
 *  are recorded against revision 0 and match no row in the table. Counted here
 *  rather than dropped, because a list that quietly omits them reads as the
 *  whole truth — and "somebody is hammering an address that does not exist" is
 *  the sort of thing you only ever learn from a figure that refused to
 *  disappear. */
export function unreachedCalls(report: UsageIndex | undefined): number {
  if (!report?.available) return 0
  return report.usage
    .filter((row) => row.revision === 0)
    .reduce((sum, row) => sum + row.calls + row.failures, 0)
}

/** The share of answers that came from memory, or nothing.
 *
 *  Nothing in two different situations, and both matter. An endpoint with no
 *  cache has no rate — 0% would read as a cache that is failing rather than one
 *  that is off. An endpoint nobody has called has no denominator, and 0% would
 *  be a claim about traffic that does not exist. */
export function hitRate(ttl: number, calls: number, cached: number): number | null {
  if (ttl <= 0 || calls <= 0) return null
  return cached / calls
}

/** How full a key's day is, as a fraction, or nothing where it has no ceiling.
 *
 *  Clamped at 1: a quota is checked before a call is answered, so the count can
 *  sit exactly at the limit, and a bar drawn past its own end reads as a bug
 *  rather than as the overflow it is not. */
export function quotaFilled(usage: KeyUsage): number | null {
  if (usage.quota_per_day <= 0) return null
  return Math.min(1, usage.calls_today / usage.quota_per_day)
}

/** The sentence beneath a key's bar, or nothing where there is nothing to add.
 *
 *  Only ever says something that is true right now: a key being throttled is
 *  today's news, and a key merely close to its ceiling is worth a word before
 *  it becomes today's news. */
export function quotaNote(usage: KeyUsage): string | null {
  if (usage.throttled_today > 0) {
    return `throttled ${usage.throttled_today} time${usage.throttled_today === 1 ? '' : 's'} today`
  }
  const filled = quotaFilled(usage)
  if (filled !== null && filled >= 0.8) {
    const left = usage.quota_per_day - usage.calls_today
    return `${left} call${left === 1 ? '' : 's'} left today`
  }
  return null
}

/** How the caller list is shown: a name, and what it said it was doing.
 *
 *  A call that carried no key is "no key" rather than an empty cell, because
 *  anonymous is a real and permanent answer here — a public endpoint has no
 *  caller to name — and a blank reads as a figure Flint failed to fetch. */
export function callerName(caller: CallerUsage): string {
  const who = caller.key_name || 'no key'
  return caller.label ? `${who} · ${caller.label}` : who
}
