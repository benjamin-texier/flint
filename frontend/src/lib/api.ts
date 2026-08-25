/** Typed access to the Flint backend. */

export interface AppConfig {
  version: string
  endpoint: string
  user: string
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
  /** The database Flint persists into, or null when it is stateless. */
  workspace: string | null
  /** Whether alerts may POST anywhere. False makes the alert form say so
   *  up front rather than leaving it to be found in the history. */
  alert_webhooks: boolean
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
  server: () => request<ServerInfo>('/server'),
  databases: () => request<DatabaseSummary[]>('/databases'),
  tables: (db: string) => request<TableSummary[]>(`/databases/${enc(db)}/tables`),
  table: (db: string, table: string) =>
    request<TableDetailResponse>(`/databases/${enc(db)}/tables/${enc(table)}`),
  preview: (db: string, table: string, limit = 100) =>
    request<QueryResult>(
      `/databases/${enc(db)}/tables/${enc(table)}/preview?limit=${limit}`,
    ),
  schema: () => request<SchemaEntry[]>('/schema'),
  graph: (db: string) => request<import('./graph').SchemaGraph>(`/databases/${enc(db)}/graph`),
  profile: (db: string, table: string) =>
    request<import('./profile').TableProfile>(
      `/databases/${enc(db)}/tables/${enc(table)}/profile`,
    ),
  history: (limit = 200) => request<HistoryResponse>(`/history?limit=${limit}`),

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

  published: () => request<import('./publish').Published[]>('/published'),
  pipelines: (days: number) =>
    request<import('./pipeline').PipelineReport>(`/diagnostics/pipelines?days=${days}`),
  refreshView: (body: { database: string; view: string }) =>
    request<{ refreshed: string }>('/pipelines/refresh', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  access: () => request<import('./access').AccessReport>('/diagnostics/access'),
  replication: () =>
    request<import('./replication').ReplicationReport>('/diagnostics/replication'),
  killQuery: (queryId: string) =>
    request<{ asked: string; status: string; matched: boolean }>('/diagnostics/kill', {
      method: 'POST',
      body: JSON.stringify({ query_id: queryId }),
    }),

  apiUsage: (days: number) =>
    request<import('./diagnose').UsageReport>(`/diagnostics/api-usage?days=${days}`),
  savePublished: (body: {
    id?: string
    name: string
    slug: string
    sql: string
    database: string
    defaults: string
    token?: string
    public: boolean
    enabled: boolean
    max_rows: number
  }) =>
    request<import('./publish').Published[]>('/published', {
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

  reports: () => request<import('./report').Report[]>('/reports'),
  saveReport: (body: {
    id?: string
    name: string
    spec: string
    schedule: string
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

  run: (body: { sql: string; database?: string; query_id?: string; max_rows?: number }) =>
    request<QueryResult>('/query', { method: 'POST', body: JSON.stringify(body) }),

  dashboards: () => request<Dashboard[]>('/dashboards'),
  saveDashboard: (body: { id?: string; name: string; spec: string }) =>
    request<Dashboard>('/dashboards', { method: 'POST', body: JSON.stringify(body) }),
  deleteDashboard: (id: string) =>
    request<{ deleted: string }>(`/dashboards/${enc(id)}`, { method: 'DELETE' }),

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
