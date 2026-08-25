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
  token: string
  public: boolean
  enabled: boolean
  max_rows: number
  created_at: string
  updated_at: string
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

export function snippet(
  kind: SnippetKind,
  endpoint: Published,
  origin: string,
  call: Call,
): string {
  const url = `${origin}${callUrl(endpoint.slug, call)}`
  switch (kind) {
    case 'curl':
      return curlFor(endpoint, origin, call)
    case 'python':
      return pythonSnippet(endpoint, origin, url)
    case 'javascript':
      return javascriptSnippet(endpoint, origin, url)
    case 'sheets':
      return sheetsSnippet(endpoint, origin, call)
  }
}

function pythonSnippet(endpoint: Published, origin: string, url: string): string {
  const headers = endpoint.public
    ? 'headers = {}'
    : `headers = {"X-Flint-Token": "${endpoint.token}"}`
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

function javascriptSnippet(endpoint: Published, origin: string, url: string): string {
  const headers = endpoint.public
    ? '{}'
    : `{ "X-Flint-Token": "${endpoint.token}" }`
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
function sheetsSnippet(endpoint: Published, origin: string, call: Call): string {
  const csv: Call = { ...call, format: 'csv' }
  const pairs = callQuery(csv)
  if (!endpoint.public) pairs.push(['token', endpoint.token])
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
export function curlExample(endpoint: Published, origin: string): string {
  return curlFor(endpoint, origin, defaultCall(endpoint))
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
export function curlFor(endpoint: Published, origin: string, call: Call): string {
  const url = `${origin}${callUrl(endpoint.slug, call)}`
  const auth = endpoint.public ? '' : ` \\\n  -H "X-Flint-Token: ${endpoint.token}"`
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
