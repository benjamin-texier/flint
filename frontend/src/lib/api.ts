/** Typed access to the Flint backend. */

export interface AppConfig {
  version: string
  /** Whether the manifest names the ClickHouse, or the browser does at
   *  sign-in. False is *unpinned*: a different first screen, and a narrower
   *  Flint — no workspace, nothing on a schedule, no account of its own. Sent
   *  as its own fact rather than inferred from `endpoint` being null, because
   *  the UI branches on it before it has anything to show. */
  pinned: boolean
  /** Null unpinned: there is no endpoint until somebody names one, and the one
   *  they named is on `Session` — it is theirs, not the deployment's. */
  endpoint: string | null
  /** The account Flint's own work runs as. Null unpinned, where there is no
   *  such account: everything runs as whoever signed in. */
  user: string | null
  default_database: string
  readonly: boolean
  /** What this deployment may do. Gates actions, never reads — see
   *  `lib/spaces`. */
  tier: import('./spaces').Tier
  /** Whether the Infrastructure space exists here at all. Off means absent:
   *  no navigation entry and no route, rather than a disabled control. */
  infrastructure: boolean
  max_result_rows: number
  query_timeout_secs: number
  /** What Flint attaches to every statement it sends. */
  query_settings: Record<string, string>
  /** Setting names the console may not carry, because Flint sends them itself.
   *  Published so the prompt can refuse one at the point of typing rather than
   *  letting it fail every statement that follows. */
  reserved_settings: string[]
  /** The database Flint persists into, or null when it is stateless. */
  workspace: string | null
  /** Whether alerts may POST anywhere. False makes the alert form say so
   *  up front rather than leaving it to be found in the history. */
  alert_webhooks: boolean
  /** Roles a published endpoint may be made to run as. Empty means this
   *  deployment delegates none, and the form does not offer the control. */
  delegatable_roles: string[]
  /** Whether everyone must sign in with their own ClickHouse credentials.
   *  A fact about the deployment; who you are is `Session`. */
  auth: boolean
}

/** Who is asking, and whether Flint is asking anybody. */
export interface Session {
  /** Whether signing in is required here at all. */
  required: boolean
  /** The ClickHouse user statements run as. Null only when signing in is
   *  required and nobody has. */
  user: string | null
  /** Which server *this session* is on, falling back to the manifest's where
   *  there is one. On an unpinned Flint two people can be signed in to two
   *  different ClickHouses, so the chrome reads this rather than `AppConfig`. */
  endpoint: string | null
  /** The account in the manifest — what Flint itself connects as. Shown on the
   *  sign-in screen so somebody can see which server they are signing in to,
   *  and as whom the schedule will keep running. Null unpinned: signing out
   *  leaves you as nobody, because there is no such account. */
  service_user: string | null
}

export interface Dashboard {
  id: string
  name: string
  /** JSON; parse with `parseSpec` from lib/dashboard. */
  spec: string
  created_at: string
  updated_at: string
}

export interface SavedQuery {
  id: string
  name: string
  sql: string
  database: string
  created_at: string
  updated_at: string
}

export interface ServerInfo {
  version: string
  uptime_seconds: number
  timezone: string
  current_user: string
  current_database: string
  databases: number
  tables: number
}

export interface DatabaseSummary {
  name: string
  engine: string
  /** The engine with its arguments. For a `PostgreSQL` or an `S3` database it
   *  is where the far end is written down; for an `Atomic` one it is the word
   *  `Atomic` again. */
  engine_full: string
  comment: string
  tables: number
  views: number
  materialized_views: number
  dictionaries: number
  bytes: number
  rows: number
}

export type ObjectKind = 'table' | 'view' | 'materialized_view' | 'dictionary'

export interface TableSummary {
  name: string
  engine: string
  comment: string
  total_rows: number | null
  total_bytes: number | null
  parts_rows: number
  parts_bytes: number
  sorting_key: string
  primary_key: string
  partition_key: string
  modified: string
  columns: number
  kind: ObjectKind
}

export interface ColumnDetail {
  name: string
  type: string
  position: number
  default_kind: string
  default_expression: string
  comment: string
  compression_codec: string
  ttl_expression: string
  in_partition_key: boolean
  in_sorting_key: boolean
  in_primary_key: boolean
  in_sampling_key: boolean
  compressed_bytes: number
  uncompressed_bytes: number
  nullable: boolean
}

export interface PartitionSummary {
  partition: string
  parts: number
  rows: number
  bytes: number
  uncompressed_bytes: number
  min_date: string
  max_date: string
  modified: string
}

export interface ProjectionSummary {
  name: string
  type: string
  sorting_key: string[]
  query: string
}

export interface TableRef {
  database: string
  name: string
  kind: ObjectKind
}

export interface TableDetail extends TableSummary {
  database: string
  engine_full: string
  create_query: string
  sampling_key: string
  ttl: string | null
  as_select: string
  uncompressed_bytes: number
  parts: number
  data_paths: string[]
  columns_detail?: never
  columns: number
  partitions: PartitionSummary[]
  projections: ProjectionSummary[]
  /** For a materialized view with no TO clause: the table ClickHouse made to
   *  hold its rows, and where this object's figures came from. */
  storage: string | null
  dependents: TableRef[]
  depends_on: TableRef[]
}

/** The backend flattens `TableSummary` into `TableDetail`, which collides on
 *  `columns` (a count on the summary, the column list on the detail). The
 *  detail response wins, so read the list through this shape. */
export interface TableDetailResponse extends Omit<TableDetail, 'columns'> {
  columns: ColumnDetail[]
}

export interface MutateBody {
  database: string
  table: string
  /** The `WHERE`, as written. An expression, so it is spliced rather than
   *  bound — there is no binding for one. */
  predicate: string
  /** Empty for a delete. */
  set?: { column: string; expression: string }[]
}

export interface MutationPreview {
  /** Rows the predicate matches — how many actually change. */
  matches: number
  /** What a read with this predicate would touch, against the table's totals.
   *  The parts are the figure that matters: a mutation rewrites whole parts. */
  estimate: {
    parts: number
    rows: number
    marks: number
    total_parts: number
    total_rows: number
  }
  narrows: boolean
  statement: string
  /** What is worth saying before the button, built by the backend so the
   *  wording is not written a second time in the browser. */
  says: string[]
}

export interface PendingMutation {
  mutation_id: string
  command: string
  created: string
  parts_to_do: number
  fail_reason: string
}

export interface Inspected {
  /** The columns the file turned out to have, as the server inferred them. */
  columns: { name: string; type: string }[]
  /** A page of it, parsed with the format the import will use. */
  rows: string[][]
  mapping: {
    matched: string[]
    unmatched: string[]
    defaulted: string[]
    by_name: boolean
  }
  statement: string
}

export interface QueryResult {
  query_id: string
  columns: { name: string; type: string }[]
  rows: unknown[][]
  truncated: boolean
  rows_before_limit_at_least: number | null
  statistics: { elapsed: number; rows_read: number; bytes_read: number }
  summary: {
    read_rows: number
    read_bytes: number
    written_rows: number
    result_rows: number
    result_bytes: number
    elapsed_ns: number
  }
  kind: 'read' | 'command'
}

/** What `POST /api/check` answers: the statement run the way the scheduler
 *  will run it. */
export interface CheckResult {
  ok: boolean
  error?: string
  columns: { name: string; type: string }[]
  rows: unknown[][]
  truncated: boolean
  elapsed_ms: number
  verdict?: {
    state: 'ok' | 'firing' | 'error'
    message: string
    value?: number
  }
}

/** One column, as the schema review measured it. Counts only — what they mean
 *  is `lib/review`'s decision, and the two are deliberately separate. */
export interface ColumnFacts {
  name: string
  type: string
  nullable: boolean
  codec: string
  in_sorting_key: boolean
  in_partition_key: boolean
  /** Null when the table's parts are Compact, where per-column bytes do not
   *  exist at all. */
  compressed_bytes: number | null
  uncompressed_bytes: number | null
  /** Approximate — `uniqCombined`. Only ever compared against the
   *  LowCardinality threshold, where a percent of error changes nothing. */
  distinct: number
  distinct_capped: boolean
  /** Exact when it is 100 or less; 101 means "more than a hundred". The figure a
   *  rule may draw a conclusion from. */
  distinct_small: number
  nulls: number
  empties: number
  /** Text, always: an Int64's range does not survive a double. */
  min: string | null
  max: string | null
  min_len: number | null
  max_len: number | null
  not_a_date: number | null
  not_a_number: number | null
  not_a_uuid: number | null
  fractional: number | null
  /** Queries that read this column in the window. Null when the query log
   *  cannot be read at all — which is a different answer from zero, and the two
   *  must never be shown alike. */
  read_by: number | null
}

/** What weighing one proposed type change measured. Sizes in bytes, and never a
 *  prediction: `before` and `after` are the same rows written both ways. */
export interface ProbeOutcome {
  column: string
  from_type: string
  to_type: string
  /** Rows written into the scratch table. Zero when the conversion refused. */
  rows: number
  before_compressed: number
  after_compressed: number
  before_raw: number
  after_raw: number
  /** Bytes the engine moved to do the same work over each column — one grouping
   *  of the whole thing. Bytes, not milliseconds: a timing over a table written
   *  a second ago measures the page cache. */
  before_scanned: number
  after_scanned: number
  /** The column's real size today, or null where the parts are Compact. */
  column_compressed: number | null
  total_rows: number
  /** The server's own words when the conversion refused — a stronger finding
   *  than any saving. */
  refused: string | null
}

/** One shape of query that read a column — grouped by ClickHouse's own
 *  `normalized_query_hash`, so a hundred runs differing in a literal are one
 *  entry. */
export interface Reader {
  runs: number
  read_bytes: number
  read_rows: number
  max_ms: number
  users: number
  last_seen: string
  sample: string
}

export interface Readers {
  column: string
  days: number
  /** Distinct query shapes that read the column, including those past the
   *  limit — so a list of five can say what it is five of. */
  shapes: number
  /** Hours the log actually holds, computed by the server. Where this is short
   *  of `days`, it is what the panel says. */
  hours: number | null
  /** False when the query log could not be read at all. */
  available: boolean
  entries: Reader[]
}

/** One codec weighed against the column as it stands. Lossless, so the only
 *  question is bytes. */
export interface CodecReading {
  codec: string
  compressed: number
  raw: number
}

export interface CodecOutcome {
  column: string
  type: string
  /** The codec the column has today; empty when it takes the table's default. */
  current: string
  rows: number
  baseline: number
  baseline_raw: number
  candidates: CodecReading[]
  column_compressed: number | null
}

/** One column of a database, ranked by what it occupies. Metadata only — no
 *  sampling, no data read. */
export interface HeavyColumn {
  table: string
  column: string
  type: string
  compressed: number
  uncompressed: number
}

export interface Heavy {
  database: string
  /** Columns with measurable bytes in the database, including those past the
   *  limit. */
  columns_total: number
  /** Bytes the per-column accounting can see. */
  visible: number
  /** What the database's active parts occupy altogether. Often more than
   *  `visible`, because a Compact part keeps every column in one file. */
  on_disk: number
  compact_parts: number
  parts: number
  columns: HeavyColumn[]
}

export interface SchemaReview {
  database: string
  table: string
  engine: string
  sorting_key: string
  partition_key: string
  total_rows: number
  /** Rows the pass looked at. */
  scanned: number
  /** True when that was every row — a verdict rather than a hypothesis. */
  verified: boolean
  part_type: string
  sizes_known: boolean
  degraded: boolean
  /** The window the `read_by` counts cover. */
  usage_days: number
  usage_known: boolean
  /** The oldest moment the query log still holds. Often far short of
   *  `usage_days`: a log with a one-day TTL answers a seven-day question with
   *  twelve hours, and saying "nothing read this in 7 days" on that is wrong by
   *  a factor of fourteen. */
  usage_since: string | null
  /** How many hours back that is, computed by the server — because `event_time`
   *  is on ClickHouse's clock and `Date.now()` is on the reader's, and
   *  subtracting one from the other silently adds the offset between them. */
  usage_hours: number | null
  /** Inserts into this table in the window. Load-bearing: for an INSERT
   *  ClickHouse logs no columns at all, so a table written to every minute
   *  looks unused from the read counts alone. */
  writes: number | null
  columns: ColumnFacts[]
}

/** One query shape against a table, as `system.query_log` recorded it.
 *
 *  `statement` is a real statement of that shape, literals and all — the
 *  advisor parses it because `query_log.columns` names every column a statement
 *  touched without saying *how*, and filtered-on and grouped-by are the whole
 *  question. */
export interface Pattern {
  hash: string
  runs: number
  statement: string
  avg_ms: number
  p95_ms: number
  total_ms: number
  read_rows: number
  read_bytes: number
  users: number
  last_seen: string
  first_seen: string
  tables: string[]
  /** Projections the server actually chose for this shape. Evidence rather
   *  than inference — empty on a server whose log does not record the field,
   *  which is why nothing is concluded from emptiness alone. */
  projections: string[]
}

/** A projection this table already carries. */
export interface Existing {
  name: string
  /** `Normal` or `Aggregate`. */
  kind: string
  query: string
  sorting_key: string[]
  parts: number
  rows: number
  bytes: number
  /** Declared and holding nothing: every query ignores it, and no error is
   *  raised anywhere. The size is the only tell. */
  inert: boolean
  /** Runs in the window the log says it answered. `null` where the log could
   *  not be read — a different answer from zero, and never shown as one. */
  used_by: number | null
}

export interface AdviceColumn {
  name: string
  type: string
  /** 1-based place in the sorting key, or null when it is not in it. */
  sorting_position: number | null
  in_partition_key: boolean
  compressed_bytes: number | null
}

export interface Advice {
  database: string
  table: string
  engine: string
  /** False for an engine that cannot carry a projection at all. */
  supported: boolean
  sorting_key: string[]
  partition_key: string
  total_rows: number
  table_bytes: number
  parts: number
  index_granularity: number
  columns: AdviceColumn[]
  existing: Existing[]
  window_days: number
  /** The oldest entry the log still holds, which is the window actually
   *  granted rather than the one asked for. */
  since: string | null
  workload: { items: Pattern[]; blocked?: string }
  /** Shapes and runs before the list was capped at the costliest few. Null
   *  where the workload could not be read at all. A list silently truncated
   *  reads as the whole truth, which is what these two exist to prevent. */
  shapes_total: number | null
  runs_total: number | null
}

/** One table of a database, and what its workload spends on it. */
export interface TableStanding {
  table: string
  engine: string
  rows: number
  bytes: number
  parts: number
  sorting_key: string[]
  projections: number
  projection_bytes: number
  /** Over the whole window, not over the samples below. */
  shapes: number
  runs: number
  total_ms: number
  read_rows: number
  /** The costliest shapes only — enough to read the access pattern from, and
   *  deliberately not the whole workload: that is the table tab's job. */
  samples: Pattern[]
}

export interface DatabaseAdvice {
  database: string
  window_days: number
  tables: TableStanding[]
  /** Tables that could hold a projection at all, before the cap. */
  tables_total: number
  /** Tables anything read in the window. */
  tables_read: number
  blocked?: string
}

/** What a proposed key measures out at. Counted, not modelled. */
export interface Measurement {
  keys: string[]
  total_rows: number
  groups: number
  /** False when `groups` is an estimate rather than a count. */
  groups_exact: boolean
  max_rows_per_key: number | null
  avg_rows_per_key: number | null
  /** What the columns the projection would hold cost today. Null where the
   *  parts are Compact and per-column bytes do not exist. */
  columns_compressed: number | null
  parts: number
  index_granularity: number
}

/** What an aggregate projection would actually weigh, built and measured
 *  rather than reasoned about. */
export interface Weight {
  rows: number
  /** What one part of it costs on disk — the same figure
   *  `system.projection_parts` reports, so the two can be compared. */
  on_disk: number
  uncompressed: number
  /** Active parts of the table, because a projection is written per part.
   *  Verified: three groups measured 1,995 bytes across five parts, and one
   *  part of the same grouping measured 399. */
  parts: number
  table_bytes: number
  /** The scratch table's definition, so the figure can be judged rather than
   *  taken on trust. */
  built: string
}

export interface SchemaEntry {
  database: string
  table: string
  columns: string[]
  types: string[]
  /** `table`, `view`, `materialized_view` or `dictionary`. */
  kind: string
}

export interface HistoryEntry {
  query_id: string
  query: string
  kind: string
  event_time: string
  duration_ms: number
  read_rows: number
  read_bytes: number
  result_rows: number
  memory_usage: number
  exception: string
  user: string
  databases: string[]
}

export interface HistoryResponse {
  available: boolean
  entries: HistoryEntry[]
  reason?: string
}

export type { SchemaGraph, GraphNode, GraphEdge } from './graph'

/** An error the backend classified for us. `kind` lets the UI respond to a
 *  bad password differently from a syntax error. */
export class FlintError extends Error {
  kind: string
  clickhouseCode: number | null
  status: number

  constructor(message: string, kind: string, clickhouseCode: number | null, status: number) {
    super(message)
    this.name = 'FlintError'
    this.kind = kind
    this.clickhouseCode = clickhouseCode
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
  } catch {
    throw new FlintError(
      'Flint is not responding. Is the server still running?',
      'network',
      null,
      0,
    )
  }

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`
    let kind = 'http'
    let code: number | null = null
    try {
      const body = await response.json()
      if (body?.error) {
        message = body.error.message ?? message
        kind = body.error.kind ?? kind
        code = body.error.clickhouse_code ?? null
      }
    } catch {
      /* a non-JSON error body — keep the status line */
    }
    throw new FlintError(message, kind, code, response.status)
  }
  return response.json() as Promise<T>
}

const enc = encodeURIComponent

/** A call to a published endpoint, made the way a caller would make it.
 *
 *  Deliberately not `request`: the sandbox has to show what an outside caller
 *  actually receives — the status, the body byte for byte in whichever format
 *  was asked for, and the paging headers, which are all a CSV or NDJSON
 *  consumer ever gets. */
export interface RawCall {
  status: number
  ok: boolean
  contentType: string
  body: string
  /** Only the headers that say something: `X-Flint-*` and `Link`. */
  headers: [string, string][]
  ms: number
}

const TOLD: string[] = [
  'x-flint-limit',
  'x-flint-offset',
  'x-flint-returned',
  'x-flint-has-more',
  'x-flint-total',
  'link',
]

export async function callPublished(path: string, token: string): Promise<RawCall> {
  const started = performance.now()
  const response = await fetch(path, {
    headers: token ? { 'X-Flint-Token': token } : {},
  })
  const body = await response.text()
  const headers: [string, string][] = []
  for (const name of TOLD) {
    const value = response.headers.get(name)
    if (value !== null) headers.push([name, value])
  }
  return {
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get('content-type') ?? '',
    body,
    headers,
    ms: Math.round(performance.now() - started),
  }
}

export const api = {
  config: () => request<AppConfig>('/config'),
  jobs: () => request<import('./job').JobReport>('/jobs'),
  optimize: (database: string, table: string, finalPass: boolean) =>
    request<import('./job').Job>('/optimize', {
      method: 'POST',
      body: JSON.stringify({ database, table, final_pass: finalPass }),
    }),
  cancelJob: (id: string) => request<{ cancelling: string; note: string }>(`/jobs/${enc(id)}/cancel`, {
    method: 'POST',
  }),
  session: () => request<Session>('/session'),
  /** `endpoint` only where the deployment has none of its own. A pinned Flint
   *  *refuses* the field rather than ignoring it — it would otherwise be an
   *  open proxy behind a manifest saying it is not — so sending it always
   *  would break every existing sign-in. */
  login: (user: string, password: string, endpoint?: string) =>
    request<{ user: string }>('/login', {
      method: 'POST',
      body: JSON.stringify(endpoint ? { user, password, endpoint } : { user, password }),
    }),
  logout: () => request<{ user: null }>('/logout', { method: 'POST' }),
  server: () => request<ServerInfo>('/server'),
  databases: () => request<DatabaseSummary[]>('/databases'),
  tables: (db: string) => request<TableSummary[]>(`/databases/${enc(db)}/tables`),
  table: (db: string, table: string) =>
    request<TableDetailResponse>(`/databases/${enc(db)}/tables/${enc(table)}`),
  preview: (db: string, table: string, limit = 100) =>
    request<QueryResult>(
      `/databases/${enc(db)}/tables/${enc(table)}/preview?limit=${limit}`,
    ),
  /** Whether the address an external table points at answers, asked once, now.
   *  A POST because it opens a connection to somebody else's infrastructure —
   *  it is a button, not a reading taken on page load. */
  connect: (db: string, table: string) =>
    request<import('./connect').Attempt>(
      `/databases/${enc(db)}/tables/${enc(table)}/connect`,
      { method: 'POST' },
    ),
  /** What a table's background reader is doing — a Kafka consumer's position
   *  and errors, or an S3Queue's log. Empty for every other engine, which is an
   *  answer rather than a failure. */
  stream: (db: string, table: string) =>
    request<import('./stream').StreamReport>(
      `/databases/${enc(db)}/tables/${enc(table)}/stream`,
    ),
  /** Every table on this server whose rows are not on it. One read, so the
   *  question "what does this server talk to" has an answer that is not thirty
   *  page loads. */
  outside: () => request<import('./outside').OutsideReport>('/outside'),
  schema: () => request<SchemaEntry[]>('/schema'),
  graph: (db: string) => request<import('./graph').SchemaGraph>(`/databases/${enc(db)}/graph`),
  /** The same database on a time axis: tables against partitions. Its own call
   *  rather than a field on the graph, so a role without `system.parts` loses
   *  this view and keeps the diagram. */
  /** The same grid one level up: every database on the server against time. The
   *  one question the per-database views cannot be asked, since each of them is
   *  scoped to one. */
  serverTimeline: (grain?: import('./timeline').Grain) =>
    request<import('./timeline').PartitionTimeline>(
      `/server/timeline${grain && grain !== 'partition' ? `?grain=${grain}` : ''}`,
    ),
  timeline: (db: string, grain?: import('./timeline').Grain) =>
    request<import('./timeline').PartitionTimeline>(
      `/databases/${enc(db)}/timeline${grain && grain !== 'partition' ? `?grain=${grain}` : ''}`,
    ),
  /** Where that database's disk is, column by column. Its own call for the same
   *  reason as the timeline: a different system table, and a different way of
   *  being unavailable. */
  mass: (db: string, tables?: number) =>
    request<import('./treemap').MassReport>(
      `/databases/${enc(db)}/mass${tables ? `?tables=${tables}` : ''}`,
    ),
  /** Which of that database's tables get read in the same statement. From the
   *  query log, so it is the only one of the four readings that can be
   *  unavailable because of how the server is configured rather than granted. */
  affinity: (db: string, days: number) =>
    request<import('./affinity').AffinityReport>(`/databases/${enc(db)}/affinity?days=${days}`),
  changes: (db: string, table: string, days = 30) =>
    request<import('./changes').ChangeReport>(
      `/databases/${enc(db)}/tables/${enc(table)}/changes?days=${days}`,
    ),
  impact: (db: string, table: string) =>
    request<import('./impact').Impact>(`/databases/${enc(db)}/tables/${enc(table)}/impact`),
  /** What one column of a table says about another. Asked for, never automatic:
   *  it reads every row twice. */
  relations: (db: string, table: string) =>
    request<import('./relations').Relations>(
      `/databases/${enc(db)}/tables/${enc(table)}/relations`,
    ),

  drift: (db: string, table: string) =>
    request<import('./drift').Drift>(`/databases/${enc(db)}/tables/${enc(table)}/drift`),

  compare: (db: string, table: string, against: string) =>
    request<import('./compare').Comparison>(
      `/databases/${enc(db)}/tables/${enc(table)}/compare?with=${encodeURIComponent(against)}`,
    ),

  distribution: (db: string, table: string, column: string) =>
    request<import('./distribution').Distribution>(
      `/databases/${enc(db)}/tables/${enc(table)}/columns/${enc(column)}/distribution`,
    ),
  profile: (db: string, table: string) =>
    request<import('./profile').TableProfile>(
      `/databases/${enc(db)}/tables/${enc(table)}/profile`,
    ),
  /** Where a database's disk is, one column at a time. The question that comes
   *  before opening any single table's review. */
  heavy: (db: string, limit = 30) =>
    request<Heavy>(`/databases/${enc(db)}/heavy?limit=${limit}`),
  /** The queries that read one column, biggest reader first. What the log
   *  cannot say — whether it was filtered on or ordered by — the reader sees for
   *  themselves in the SQL. */
  readers: (db: string, table: string, column: string, days = 7, limit = 5) =>
    request<Readers>(
      `/databases/${enc(db)}/tables/${enc(table)}/readers?column=${enc(column)}&days=${days}&limit=${limit}`,
    ),
  /** Weigh the codecs worth trying on a column. The candidates are the
   *  server's choice — a codec expression reaches a CREATE TABLE. */
  codecs: (db: string, table: string, column: string) =>
    request<CodecOutcome>(`/databases/${enc(db)}/tables/${enc(table)}/codecs`, {
      method: 'POST',
      body: JSON.stringify({ column }),
    }),
  /** Weigh a proposed type change: the same rows written both ways, measured.
   *  A POST because it writes a scratch table in Flint's own database. */
  probe: (db: string, table: string, body: { column: string; to_type: string; rows?: number }) =>
    request<ProbeOutcome>(`/databases/${enc(db)}/tables/${enc(table)}/probe`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** The schema review. `verify` reads every row instead of a prefix, which is
   *  the difference between a hypothesis and a verdict — and between a free
   *  query and a full scan, so it is never the default. */
  review: (db: string, table: string, verify = false) =>
    request<SchemaReview>(
      `/databases/${enc(db)}/tables/${enc(table)}/review${verify ? '?verify=true' : ''}`,
    ),
  history: (limit = 200) => request<HistoryResponse>(`/history?limit=${limit}`),

  /** What changed, over that window and the six behind it. Hours rather than
   *  days because "since you last looked" is a shorter unit than every other
   *  diagnostic's, and a day asked for as `days=1` reads as a rounding. */
  news: (hours = 24) =>
    request<import('./news').NewsReport>(`/diagnostics/news?hours=${hours}`),
  diagnoseQueries: (days: number) =>
    request<import('./diagnose').QueryReport>(`/diagnostics/queries?days=${days}`),
  diagnoseTraffic: (days: number) =>
    request<import('./diagnose').TrafficReport>(`/diagnostics/traffic?days=${days}`),
  diagnoseStorage: () => request<import('./diagnose').StorageReport>('/diagnostics/storage'),
  diagnoseActivity: () => request<import('./diagnose').ActivityReport>('/diagnostics/activity'),

  alerts: () => request<import('./alert').Alert[]>('/alerts'),
  saveAlert: (body: {
    id?: string
    name: string
    sql: string
    database: string
    condition: string
    interval_seconds: number
    webhook: string
    enabled: boolean
  }) => request<import('./alert').Alert[]>('/alerts', { method: 'POST', body: JSON.stringify(body) }),
  deleteAlert: (id: string) =>
    request<{ deleted: string }>(`/alerts/${enc(id)}`, { method: 'DELETE' }),
  check: (body: {
    sql: string
    database?: string
    condition?: string
    params?: [string, string][]
  }) =>
    request<CheckResult>('/check', { method: 'POST', body: JSON.stringify(body) }),

  /** Run a report now. Allowed under FLINT_READONLY: every section is a read,
   *  and the edition it writes is Flint's own bookkeeping. */
  /** Submits a job and returns as soon as it is recorded: an edition is a dozen
   *  statements, and holding the request open for all of them timed out in the
   *  browser while the work continued on the server. */
  runReport: (id: string) =>
    request<import('./job').Job>(`/reports/${id}/run`, { method: 'POST' }),

  published: () => request<import('./publish').Published[]>('/published'),
  /** Traffic per address, from Flint's own call log. A cache hit and a refusal
   *  never reach ClickHouse, so `system.query_log` cannot answer this. */
  publishedUsage: (hours: number) =>
    request<import('./publish').UsageIndex>(`/published/usage?hours=${hours}`),
  /** What a revision's statement returns, for whoever is writing its contract.
   *  A `DESCRIBE`, so it reads no data. */
  endpointColumns: (slug: string, revision?: number) =>
    request<import('./publish').EndpointColumns>(
      `/published/${enc(slug)}/columns${revision ? `?v=${revision}` : ''}`,
    ),
  endpointUsage: (slug: string, hours: number) =>
    request<import('./publish').EndpointUsage>(
      `/published/${enc(slug)}/usage?hours=${hours}`,
    ),
  /** Expose a handful of tables, one endpoint each.
   *
   *  The per-statement form is right for a join and wrong for the only other
   *  thing anyone publishes: read access to some tables, for a caller with no
   *  ClickHouse account. Anyone who *has* an account should use `POST
   *  /api/data` and name a dataset per call instead — nothing is published and
   *  their own grants decide what comes back. */
  publishTables: (body: {
    database: string
    tables: string[]
    public?: boolean
    max_rows?: number
    /** `draft` or `live`. Draft is the recommendation: fifteen addresses that
     *  started answering the moment somebody clicked once is a lot of surface
     *  to have appeared unread. */
    state?: 'draft' | 'live'
    cache_ttl?: number
    prefix?: string
    published_by?: string
  }) =>
    request<import('./publish').TablesPublished>('/published/tables', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** Start a new revision of an address, as a draft. The address gains a
   *  revision; nothing a caller can reach changes until it goes live. */
  newRevision: (slug: string) =>
    request<{ endpoints: import('./publish').Published[] }>(
      `/published/${enc(slug)}/revisions`,
      { method: 'POST' },
    ),
  /** Move one revision along its life. Going live also puts the revision it
   *  replaces on notice — one act, because a moment with two live revisions or
   *  none is a moment a caller can land in. */
  setRevisionState: (id: string, state: 'live' | 'retiring' | 'retired') =>
    request<{ endpoints: import('./publish').Published[]; minted?: string }>(
      `/revisions/${enc(id)}/state`,
      { method: 'POST', body: JSON.stringify({ state }) },
    ),
  keys: () => request<import('./publish').ApiKey[]>('/keys'),
  saveKey: (body: {
    id?: string
    name: string
    owner?: string
    /** The addresses it may call. Empty is every one of them. */
    scope?: string[]
    quota_per_day?: number
    enabled?: boolean
    rotate?: boolean
  }) =>
    request<{ keys: import('./publish').ApiKey[]; minted?: string }>('/keys', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteKey: (id: string) =>
    request<{ deleted: string }>(`/keys/${enc(id)}`, { method: 'DELETE' }),
  pipelines: (days: number) =>
    request<import('./pipeline').PipelineReport>(`/diagnostics/pipelines?days=${days}`),
  refreshView: (body: { database: string; view: string }) =>
    request<{ refreshed: string }>('/pipelines/refresh', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  access: () => request<import('./access').AccessReport>('/diagnostics/access'),
  /* What *you* may see, which is a different question from how access is
     arranged — and answerable for a user who cannot read a single access
     table. */
  myGrants: () => request<import('./grants').MyGrants>('/me/grants'),
  limits: () => request<import('./limits').LimitsReport>('/diagnostics/limits'),
  settings: () => request<import('./settings').SettingsReport>('/diagnostics/settings'),
  now: () => request<import('./now').NowReport>('/diagnostics/now'),
  trace: (kind: string, minutes: number) =>
    request<import('./trace').TraceReport>(
      `/diagnostics/trace?kind=${encodeURIComponent(kind)}&minutes=${minutes}`,
    ),
  keeper: () => request<import('./keeper').KeeperReport>('/cluster/keeper'),
  alterations: (database: string, table: string) =>
    request<import('./alter').Offered[]>(
      `/schema/alterations?database=${encodeURIComponent(database)}&table=${encodeURIComponent(table)}`,
    ),
  /** What the workload asks of one table, against what the table is sorted by.
   *  A read: every figure is one ClickHouse already had. */
  projectionAdvice: (database: string, table: string, days = 7) =>
    request<Advice>(
      `/databases/${enc(database)}/tables/${enc(table)}/projections?days=${days}`,
    ),
  /** Which tables in a database the workload argues about, heaviest first.
   *  Three reads for the whole database; the per-table tab does the rest. */
  databaseProjections: (database: string, days = 7) =>
    request<DatabaseAdvice>(`/databases/${enc(database)}/projections?days=${days}`),
  /** Count what a proposed key would come out at. A POST because it is a scan
   *  of every row of those columns — a cost somebody agrees to by pressing a
   *  button, never one that opening a page incurs. It writes nothing. */
  measureProjection: (
    database: string,
    table: string,
    body: { keys: { column: string; bucket: string | null }[]; columns: string[] },
  ) =>
    request<Measurement>(
      `/databases/${enc(database)}/tables/${enc(table)}/projections/measure`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  /** Build what an aggregate projection would hold, weigh it, and drop it. The
   *  one call here that writes — to Flint's own workspace, never to the table. */
  weighProjection: (
    database: string,
    table: string,
    body: {
      keys: { column: string; bucket: string | null }[]
      aggregates: { name: string; params: number[]; args: string[] }[]
    },
  ) =>
    request<Weight>(
      `/databases/${enc(database)}/tables/${enc(table)}/projections/weigh`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  derived: (database: string, table: string) =>
    request<import('./derived').DerivedReport>(
      `/schema/derived?database=${encodeURIComponent(database)}&table=${encodeURIComponent(table)}`,
    ),
  definition: (database: string, table: string) =>
    request<{ ddl: string }>(
      `/schema/definition?database=${encodeURIComponent(database)}&table=${encodeURIComponent(table)}`,
    ),
  create: (statement: string) =>
    request<import('./job').Job>('/schema/create', {
      method: 'POST',
      body: JSON.stringify({ statement }),
    }),
  alter: (change: Record<string, unknown>) =>
    request<import('./job').Job>('/schema/alter', {
      method: 'POST',
      body: JSON.stringify(change),
    }),
  storagePolicies: () => request<import('./storage').StorageReport>('/storage/policies'),
  dictionaries: () =>
    request<import('./dictionaries').DictionaryReport>('/dictionaries'),
  reloadDictionary: (database: string, name: string) =>
    request<import('./job').Job>('/dictionaries/reload', {
      method: 'POST',
      body: JSON.stringify({ database, name }),
    }),
  systemAct: (command: string) =>
    request<import('./job').Job>('/system/act', {
      method: 'POST',
      body: JSON.stringify({ command }),
    }),
  govern: (change: Record<string, unknown>) =>
    request<import('./job').Job>('/access/govern', {
      method: 'POST',
      body: JSON.stringify(change),
    }),
  accessAct: (change: Record<string, unknown>) =>
    request<import('./job').Job>('/access/act', {
      method: 'POST',
      body: JSON.stringify(change),
    }),
  replication: () =>
    request<import('./replication').ReplicationReport>('/diagnostics/replication'),
  topology: () => request<import('./cluster').Topology>('/cluster/topology'),
  series: (hours: number) =>
    request<import('./health').SeriesReport>(`/health/series?hours=${hours}`),
  backups: () => request<import('./backups').BackupReport>('/backups'),
  backupAction: (database: string, table: string, file: string, action: string) =>
    request<import('./job').Job>('/backups/act', {
      method: 'POST',
      body: JSON.stringify({ database, table, file, action }),
    }),
  schemaObjects: (limit = 400) =>
    request<import('./schema').SchemaReport>(`/schema/objects?limit=${limit}`),
  objectAction: (database: string, table: string, action: string) =>
    request<import('./job').Job>('/schema/object', {
      method: 'POST',
      body: JSON.stringify({ database, table, action }),
    }),
  detachedParts: () => request<import('./parts').DetachedReport>('/parts/detached'),
  partitionAction: (database: string, table: string, partitionId: string, action: string) =>
    request<import('./job').Job>('/parts/partition', {
      method: 'POST',
      body: JSON.stringify({ database, table, partition_id: partitionId, action }),
    }),
  detachedPartAction: (database: string, table: string, part: string, action: string) =>
    request<import('./job').Job>('/parts/detached/act', {
      method: 'POST',
      body: JSON.stringify({ database, table, part, action }),
    }),
  merges: (hours: number) =>
    request<import('./health').MergeReport>(`/health/merges?hours=${hours}`),
  healthErrors: (hours: number) =>
    request<import('./health').ErrorReport>(`/health/errors?hours=${hours}`),
  serverLog: (level: string, limit = 200) =>
    request<import('./health').LogReport>(`/health/log?level=${level}&limit=${limit}`),
  replicationQueue: (limit = 40) =>
    request<import('./cluster').QueueReport>(`/cluster/replication-queue?limit=${limit}`),
  replicaAction: (database: string, table: string, action: string) =>
    request<import('./job').Job>('/cluster/replica', {
      method: 'POST',
      body: JSON.stringify({ database, table, action }),
    }),
  ddlQueue: (limit = 40) =>
    request<import('./cluster').DdlReport>(`/cluster/ddl-queue?limit=${limit}`),
  killQuery: (queryId: string) =>
    request<{ asked: string; status: string; matched: boolean }>('/diagnostics/kill', {
      method: 'POST',
      body: JSON.stringify({ query_id: queryId }),
    }),

  audit: (days: number, limit: number) =>
    request<import('./audit').AuditReport>(
      `/diagnostics/audit?days=${days}&limit=${limit}`,
    ),
  apiUsage: (days: number) =>
    request<import('./diagnose').UsageReport>(`/diagnostics/api-usage?days=${days}`),
  /** Ask a dataset a question. The server writes the SQL, so the browser does
   *  not have to have a second opinion about what the question means. */
  dataset: (body: import('./dsl').DslQuery) =>
    request<import('./dsl').DslAnswer>('/data', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** The same question, built and handed back unrun — what a builder shows
   *  while somebody is still assembling it. */
  datasetSql: (body: import('./dsl').DslQuery) =>
    request<{ dataset: string; sql: string }>('/data', {
      method: 'POST',
      body: JSON.stringify({ ...body, explain: true }),
    }),
  savePublished: (body: {
    id?: string
    name: string
    slug: string
    sql: string
    database: string
    defaults: string
    token?: string
    /** Mint a fresh token even on an edit. Explicit, because a hashed token
     *  means every edit looks like one that left the field empty. */
    rotate?: boolean
    public: boolean
    enabled: boolean
    max_rows: number
    expires_at?: string
    run_as?: string
    /** Absent keeps what the endpoint had; `''` is a deliberate choice of the
     *  server's own zone. The two are different on purpose — `run_as` spells
     *  them the same way and so cannot be cleared once set. */
    timezone?: string
    /** The sentence a caller reads. Absent keeps. */
    description?: string
    /** Seconds an answer may be served from memory. Absent keeps. */
    cache_ttl?: number
    /** The revision's promises, as JSON. Absent keeps; `''` is a deliberate
     *  return to promising only what the placeholders say. Refused on a live
     *  or retiring revision — that is what a new revision is for. */
    contract?: string
    /** Where a *new* endpoint starts its life. Ignored on an edit: a state is
     *  moved by its own button and nothing else. */
    state?: 'draft' | 'live'
  }) =>
    request<{ endpoints: import('./publish').Published[]; minted?: string }>('/published', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deletePublished: (id: string) =>
    request<{ deleted: string }>(`/published/${enc(id)}`, { method: 'DELETE' }),
  /** What an endpoint says about itself: its parameters, the columns it
   *  returns and what each of those can be filtered with. Behind the same
   *  token as the data, so it is asked for the same way a caller would. */
  publishedSchema: (slug: string, token: string) =>
    request<import('./publish').EndpointSchema>(`/data/${enc(slug)}/schema`, {
      headers: token ? { 'X-Flint-Token': token } : {},
    }),

  timezones: () => request<string[]>('/timezones'),
  reports: () => request<import('./report').Report[]>('/reports'),
  saveReport: (body: {
    id?: string
    name: string
    spec: string
    schedule: string
    timezone: string
    webhook: string
    enabled: boolean
  }) => request<import('./report').Report[]>('/reports', { method: 'POST', body: JSON.stringify(body) }),
  deleteReport: (id: string) =>
    request<{ deleted: string }>(`/reports/${enc(id)}`, { method: 'DELETE' }),
  reportRuns: (reportId?: string, limit = 20) =>
    request<import('./report').ReportRun[]>(
      `/report-runs?limit=${limit}${reportId ? `&report_id=${enc(reportId)}` : ''}`,
    ),
  reportSnapshot: (runId: string) =>
    request<import('./report').Snapshot>(`/report-runs/${enc(runId)}`),

  alertEvents: (alertId?: string, limit = 50) =>
    request<import('./alert').AlertEvent[]>(
      `/alert-events?limit=${limit}${alertId ? `&alert_id=${enc(alertId)}` : ''}`,
    ),

  run: (body: {
    sql: string
    database?: string
    query_id?: string
    max_rows?: number
    /** Settings this one statement carries. Only the console sends these, and
     *  the route refuses any name Flint attaches itself — see
     *  `routes::query::vet_settings`. */
    settings?: Record<string, string>
  }) =>
    request<QueryResult>('/query', { method: 'POST', body: JSON.stringify(body) }),

  dashboards: () => request<Dashboard[]>('/dashboards'),
  saveDashboard: (body: { id?: string; name: string; spec: string }) =>
    request<Dashboard>('/dashboards', { method: 'POST', body: JSON.stringify(body) }),
  deleteDashboard: (id: string) =>
    request<{ deleted: string }>(`/dashboards/${enc(id)}`, { method: 'DELETE' }),

  /** Write one row. `value: null` is SQL NULL; a column left out of `fields`
   *  is left out of the statement, which is what makes its DEFAULT apply. */
  insertRow: (body: {
    database: string
    table: string
    fields: { column: string; value: string | null }[]
  }) =>
    request<{ statement: string; defaulted: string[] }>('/rows', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** What a mutation would reach, before anything runs. A read, so it is not
   *  behind the tier that runs one — finding out must not require doing it. */
  previewMutation: (body: MutateBody) =>
    request<MutationPreview>('/rows/preview', { method: 'POST', body: JSON.stringify(body) }),
  mutateRows: (body: MutateBody) =>
    request<import('./job').Job>('/rows/mutate', { method: 'POST', body: JSON.stringify(body) }),
  pendingMutations: (database: string, table: string) =>
    request<PendingMutation[]>(
      `/rows/pending?database=${enc(database)}&table=${enc(table)}`,
    ),

  /** What a file holds, before anything is written. A sample of it, as text. */
  inspectFile: (body: { database: string; table: string; format: string; sample: string }) =>
    request<Inspected>('/rows/inspect', { method: 'POST', body: JSON.stringify(body) }),
  /** The file itself. `fetch` streams a `File` body, so nothing is held in
   *  the tab — which is the point for a file too big to load another way. */
  importFile: (
    q: { database: string; table: string; format: string },
    file: File,
  ) =>
    request<{ before: number; after: number; written: number; statement: string }>(
      `/rows/import?database=${enc(q.database)}&table=${enc(q.table)}&format=${enc(q.format)}`,
      // Overrides the JSON default the helper sets: the body is a file.
      { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } },
    ),

  savedQueries: () => request<SavedQuery[]>('/saved-queries'),
  saveQuery: (body: { id?: string; name: string; sql: string; database: string }) =>
    request<SavedQuery>('/saved-queries', { method: 'POST', body: JSON.stringify(body) }),
  deleteQuery: (id: string) =>
    request<{ deleted: string }>(`/saved-queries/${enc(id)}`, { method: 'DELETE' }),

  /** Reformat via ClickHouse's own `formatQuery`. */
  format: (sql: string) =>
    request<{ sql: string }>('/format', { method: 'POST', body: JSON.stringify({ sql }) }),

  cancel: (queryId: string) =>
    request<{ cancelled: string }>(`/query/${enc(queryId)}/cancel`, { method: 'POST' }),
}
