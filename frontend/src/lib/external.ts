/** Where the rows actually are, when they are not in ClickHouse.
 *
 *  A dozen of ClickHouse's engines store nothing of their own. `S3` reads
 *  objects out of a bucket, `PostgreSQL` queries somebody else's database on
 *  every SELECT, `Kafka` drains a topic. Until now every page in Flint drew
 *  those tables as a MergeTree with an odd name and no size — which is the one
 *  thing they are not. The question a reader has in front of an `S3` table is
 *  *which bucket*, and the answer was already on the page: folded into
 *  `engine_full`, and shown nowhere but the DDL tab.
 *
 *  So this reads it. `system.tables.engine_full` is the definition as the server
 *  holds it, with credentials already replaced by `[HIDDEN]` — ClickHouse masks
 *  them unless `format_display_secrets_in_show_and_select` is on, and Flint
 *  never asks for that. Everything left in there is an address, and an address
 *  is what somebody is trying to read.
 *
 *  **Nothing here is guessed.** These signatures are positional and several are
 *  variadic: `S3` takes a path, or a path and a format, or a path with two
 *  credentials wedged between them. An argument this cannot name is counted,
 *  not labelled — a host presented as a database name is worse than an argument
 *  the page admits it did not read, and the DDL tab still holds the definition
 *  whole. */

/** What the far end *is*, which is the first thing to say about it: the reader
 *  of an `Iceberg` table wants to know it is a lake table before they want the
 *  bucket. */
export type ExternalKind = 'object_store' | 'lake' | 'file' | 'http' | 'database' | 'stream'

export const EXTERNAL_KIND_LABEL: Record<ExternalKind, string> = {
  object_store: 'Object storage',
  lake: 'A lake table on object storage',
  file: 'A file on the server',
  http: 'An HTTP endpoint',
  database: 'Another database',
  stream: 'A message queue',
}

export interface ExternalFact {
  label: string
  value: string
}

export interface ExternalSource {
  /** The engine as ClickHouse spells it — the expert reads this first. */
  engine: string
  kind: ExternalKind
  /** The thing being read, in the far end's own terms: an object path, a
   *  qualified table name, a list of topics. Empty when the definition names
   *  none, which a named collection does not. */
  target: string
  /** Where that thing lives — an endpoint, a broker list. Empty where the
   *  target already carries it, as a URL does. */
  at: string
  /** Everything else the definition said: format, compression, consumer group,
   *  the user it connects as. */
  facts: ExternalFact[]
  /** A named collection stands in for the whole connection, and its contents
   *  are in the server's configuration rather than in this definition. Saying
   *  which collection is then the entire honest answer. */
  collection: string | null
  /** True where the server wrote `[HIDDEN]` over a credential. Worth saying
   *  once: a reader who cannot see a password on a page they can screenshot
   *  should know it is the server withholding it and not Flint. */
  masked: boolean
  /** Arguments the parse did not recognise. Counted so the page can say the
   *  definition holds more than it shows. */
  unread: number
}

/** Engines whose rows live somewhere else. Prefix-anchored, because ClickHouse
 *  ships a family per storage — `IcebergS3`, `IcebergAzure`, `DeltaLakeS3` —
 *  and they differ in where the files are, not in what the table is. */
const EXTERNAL =
  /^(S3Queue|S3|GCS|COSN|OSS|AzureBlobStorage|AzureQueue|HDFS|Iceberg|DeltaLake|Hudi|Paimon|URL|File|MySQL|PostgreSQL|MaterializedPostgreSQL|MaterializedMySQL|MongoDB|SQLite|Redis|ODBC|JDBC|ExternalDistributed|Kafka|RabbitMQ|NATS)/

export function isExternalEngine(engine: string): boolean {
  return EXTERNAL.test(engine)
}

// ---------------------------------------------------------------------------
// Reading the definition
// ---------------------------------------------------------------------------

const HIDDEN = '[HIDDEN]'

interface Definition {
  args: string[]
  settings: Record<string, string>
  masked: boolean
  collection: string | null
}

/** For each character: its paren depth, and whether it sits inside a quoted
 *  string. One pass, because every split below needs both — a bucket path may
 *  hold a bracket and a topic name may hold a comma, and neither is structure.
 */
function mask(s: string): { depth: number[]; quoted: boolean[] } {
  const depth = new Array<number>(s.length).fill(0)
  const quoted = new Array<boolean>(s.length).fill(false)
  let d = 0
  let inString = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inString) {
      quoted[i] = true
      depth[i] = d
      // `\'` is how ClickHouse escapes a quote, `''` is how SQL does. Both
      // occur in the wild; neither ends the string.
      if (c === '\\') {
        i += 1
        if (i < s.length) {
          quoted[i] = true
          depth[i] = d
        }
      } else if (c === "'") {
        if (s[i + 1] === "'") {
          i += 1
          quoted[i] = true
          depth[i] = d
        } else {
          inString = false
        }
      }
      continue
    }
    if (c === "'") {
      inString = true
      quoted[i] = true
      depth[i] = d
      continue
    }
    if (c === '(') {
      depth[i] = d
      d += 1
      continue
    }
    if (c === ')') {
      d = Math.max(0, d - 1)
      depth[i] = d
      continue
    }
    depth[i] = d
  }
  return { depth, quoted }
}

/** Split on the commas that are structure: depth zero, outside any string. */
function splitTop(s: string, depth: number[], quoted: boolean[], from: number, to: number): string[] {
  const parts: string[] = []
  let start = from
  for (let i = from; i < to; i++) {
    if (s[i] === ',' && !quoted[i] && depth[i] === depth[from]) {
      parts.push(s.slice(start, i).trim())
      start = i + 1
    }
  }
  const last = s.slice(start, to).trim()
  if (last) parts.push(last)
  return parts.filter((p) => p.length > 0)
}

function unquote(raw: string): string {
  const s = raw.trim()
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s
      .slice(1, -1)
      .replace(/\\'/g, "'")
      .replace(/''/g, "'")
      .replace(/\\\\/g, '\\')
  }
  return s
}

/** The definition split into what it says, without deciding what any of it
 *  means. Two shapes exist and some engines use both: positional arguments in
 *  parentheses (`S3('…', 'Parquet')`), and a `SETTINGS` list (`Kafka SETTINGS
 *  kafka_topic_list = '…'`). */
function read(engineFull: string): Definition {
  const s = engineFull
  const { depth, quoted } = mask(s)
  const args: string[] = []
  const settings: Record<string, string> = {}
  let masked = false
  let collection: string | null = null

  let open = -1
  let close = -1
  for (let i = 0; i < s.length; i++) {
    if (quoted[i]) continue
    if (open === -1 && s[i] === '(' && depth[i] === 0) open = i
    else if (open !== -1 && s[i] === ')' && depth[i] === 0) {
      close = i
      break
    }
  }

  const take = (raw: string): void => {
    // `format = 'Parquet'` inside the parentheses is a named-collection
    // override, and belongs with the settings rather than with the positions.
    const [, name, value] = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/s.exec(raw) ?? []
    if (name && value !== undefined) {
      settings[name.toLowerCase()] = unquote(value)
      return
    }
    const arg = unquote(raw)
    // Kept in the list rather than dropped. These signatures are positional,
    // and a server with `format_display_secrets_in_show_and_select` on writes
    // the password out in full — a parse that silently closed the gap would
    // read the schema slot off the password on one server and off the schema
    // on the next.
    if (arg === HIDDEN) masked = true
    // A bare identifier in first position is a named collection: the connection
    // is configured on the server and this definition only points at it.
    if (args.length === 0 && collection === null && !raw.startsWith("'") && /^[A-Za-z_][\w.]*$/.test(raw)) {
      collection = arg
      return
    }
    args.push(arg)
  }

  if (open !== -1 && close !== -1) {
    for (const raw of splitTop(s, depth, quoted, open + 1, close)) take(raw)
  }

  // `SETTINGS` after the arguments, or in place of them. Only at depth zero:
  // an S3 path is allowed to contain the word.
  const after = close === -1 ? 0 : close + 1
  for (const m of s.slice(after).matchAll(/\bSETTINGS\b/gi)) {
    const at = after + (m.index ?? 0)
    if (quoted[at] || depth[at] !== 0) continue
    for (const raw of splitTop(s, depth, quoted, at + 'SETTINGS'.length, s.length)) {
      const [, name, expression] = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/s.exec(raw) ?? []
      if (!name || expression === undefined) continue
      const value = unquote(expression)
      if (value === HIDDEN) masked = true
      else settings[name.toLowerCase()] = value
    }
    break
  }

  return { args, settings, masked, collection }
}

// ---------------------------------------------------------------------------
// Object paths
// ---------------------------------------------------------------------------

export interface ObjectPath {
  /** The service the URL names: `s3.eu-west-2.amazonaws.com`, `minio:9000`.
   *  Empty for an `s3://` URL, which names no endpoint at all. */
  endpoint: string
  bucket: string
  /** Everything under the bucket, globs and all. */
  path: string
  /** Empty unless the host spelled one out. Never inferred: a region guessed
   *  from a hostname is a region somebody will act on. */
  region: string
}

/** Virtual-hosted AWS: `bucket.s3.eu-west-2.amazonaws.com`. */
const AWS_VIRTUAL = /^([^.]+)\.s3[.-](?:([a-z0-9-]+)\.)?amazonaws\.com$/i
/** Path-style AWS: `s3.eu-west-2.amazonaws.com/bucket/key`. */
const AWS_PATH = /^s3[.-](?:([a-z0-9-]+)\.)?amazonaws\.com$/i
/** Google's virtual-hosted spelling, which follows the same two shapes. */
const GCS_VIRTUAL = /^([^.]+)\.storage\.googleapis\.com$/i

/** A bucket URL split into the parts somebody would read out loud, or null
 *  where it is not one — a `file://`, or a string ClickHouse accepted and this
 *  does not recognise. Null rather than a best effort: half a bucket name is
 *  worse than the URL itself, which the page shows either way. */
export function objectPath(url: string): ObjectPath | null {
  const [, name, rest] = /^([a-z0-9+.-]+):\/\/(.*)$/i.exec(url) ?? []
  if (!name || rest === undefined) return null
  const protocol = name.toLowerCase()

  // `s3://bucket/key` and its cousins name no endpoint — the client's own
  // configuration decides which one, and this page has not seen it.
  if (protocol !== 'http' && protocol !== 'https') {
    const cut = rest.indexOf('/')
    if (cut <= 0) return null
    return { endpoint: '', bucket: rest.slice(0, cut), path: rest.slice(cut + 1), region: '' }
  }

  // Parsed by hand rather than with `URL`, which percent-encodes the braces in
  // a ClickHouse glob: `{2020..2024}` would come back as `%7B2020..2024%7D`.
  const [, host, rooted] = /^([^/?#]+)(\/[^?#]*)?/.exec(rest) ?? []
  if (!host) return null
  const path = (rooted ?? '').replace(/^\//, '')

  const virtual = AWS_VIRTUAL.exec(host) ?? GCS_VIRTUAL.exec(host)
  const bucket = virtual?.[1]
  if (bucket) {
    return {
      endpoint: host.slice(bucket.length + 1),
      bucket,
      path,
      region: virtual?.[2] ?? '',
    }
  }

  const cut = path.indexOf('/')
  return {
    endpoint: host,
    bucket: cut === -1 ? path : path.slice(0, cut),
    path: cut === -1 ? '' : path.slice(cut + 1),
    region: AWS_PATH.exec(host)?.[1] ?? '',
  }
}

// ---------------------------------------------------------------------------
// Naming the arguments
// ---------------------------------------------------------------------------

/** The formats ClickHouse names, by the prefix they all start with. A list of
 *  every spelling would be four hundred entries and out of date by the next
 *  release; the families are stable, and this is only ever asked to tell a
 *  format from a bucket path or a compression method. */
const FORMAT =
  /^(CSV|TSV|TabSeparated|JSON|BSON|Parquet|ORC|Arrow|Avro|Native|Protobuf|CapnProto|MsgPack|RowBinary|Values|Template|Regexp|CustomSeparated|LineAsString|RawBLOB|Npy|Pretty|Markdown|SQLInsert|XML|Form|One|Hive)/i

const COMPRESSION = /^(gzip|gz|deflate|brotli|br|xz|LZMA|zstd|zst|lz4|bz2|snappy|none|auto)$/i

/** Reads a bucket-shaped definition: a URL first, then some subset of an access
 *  key, a format and a compression method, in an order the signature leaves
 *  open. Recognised by shape rather than by position, because the positions are
 *  not fixed and a wrong label here would be a bucket presented as a format. */
function objectStore(engine: string, kind: ExternalKind, d: Definition): ExternalSource {
  const [url, ...rest] = d.args
  const facts: ExternalFact[] = []
  let unread = 0
  let format = d.settings.format ?? ''
  let compression = d.settings.compression_method ?? d.settings.compression ?? ''
  let key = ''
  let anonymous = false

  // The credential pair, found by where the server put its `[HIDDEN]` rather
  // than by counting: what sits directly in front of the hidden argument is the
  // access key on every one of these signatures, and it is the half of the pair
  // that is not a secret.
  const claimed = new Set<number>()
  const secret = rest.indexOf(HIDDEN)
  if (secret !== -1) {
    claimed.add(secret)
    if (secret >= 1) {
      key = rest[secret - 1] ?? ''
      claimed.add(secret - 1)
    }
  }

  rest.forEach((arg, i) => {
    if (claimed.has(i)) return
    if (/^NOSIGN$/i.test(arg)) anonymous = true
    else if (!format && FORMAT.test(arg)) format = arg
    else if (!compression && COMPRESSION.test(arg)) compression = arg
    else unread += 1
  })

  const parsed = url ? objectPath(url) : null
  if (parsed?.region) facts.push({ label: 'region', value: parsed.region })
  if (anonymous) facts.push({ label: 'credentials', value: 'none — read anonymously' })
  if (format) facts.push({ label: 'format', value: format })
  if (compression && !/^(none|auto)$/i.test(compression)) {
    facts.push({ label: 'compression', value: compression })
  }
  if (key) facts.push({ label: 'access key', value: key })

  return {
    engine,
    kind,
    target: parsed ? [parsed.bucket, parsed.path].filter(Boolean).join('/') : (url ?? ''),
    at: parsed?.endpoint ?? '',
    facts,
    collection: d.collection,
    masked: d.masked,
    unread,
  }
}

/** A queue-shaped definition, which ClickHouse writes as settings rather than
 *  arguments: `Kafka SETTINGS kafka_topic_list = 'events'`. */
function stream(engine: string, d: Definition, spec: { at: string; target: string; facts: [string, string][] }): ExternalSource {
  const facts: ExternalFact[] = []
  for (const [key, label] of spec.facts) {
    const value = d.settings[key]
    if (value) facts.push({ label, value })
  }
  const list = (value: string): string => value.split(',').map((p) => p.trim()).filter(Boolean).join(', ')
  return {
    engine,
    kind: 'stream',
    target: list(d.settings[spec.target] ?? ''),
    at: list(d.settings[spec.at] ?? ''),
    facts,
    collection: d.collection,
    masked: d.masked,
    unread: 0,
  }
}

/** A connection-shaped definition: the engines whose arguments really are
 *  positional and fixed, where naming them is a lookup rather than a guess. */
function connection(
  engine: string,
  d: Definition,
  slots: string[],
  build: (v: Record<string, string>) => { target: string; at: string; facts: ExternalFact[] },
): ExternalSource {
  const values: Record<string, string> = {}
  d.args.forEach((arg, i) => {
    const slot = slots[i]
    if (slot) values[slot] = arg
  })
  for (const [key, value] of Object.entries(d.settings)) {
    if (slots.includes(key) && !values[key]) values[key] = value
  }
  const built = build(values)
  return {
    engine,
    kind: 'database',
    ...built,
    collection: d.collection,
    masked: d.masked,
    unread: Math.max(0, d.args.length - slots.length),
  }
}

/** `shop.public.orders`, dropping what the definition did not say. A schema is
 *  only in the name when the definition named one: ClickHouse leaves it to the
 *  connection's search path otherwise, and `public` filled in here would be
 *  Flint asserting a schema it has not seen. */
function qualified(...parts: (string | undefined)[]): string {
  return parts.filter((p) => p && p.length > 0).join('.')
}

// ---------------------------------------------------------------------------

export interface ExternalOptions {
  /** A `PostgreSQL` database engine takes the same arguments as the table
   *  engine minus the table, so which one is being read decides what argument
   *  three is. */
  scope?: 'table' | 'database'
  /** `system.tables.data_paths`, which is where a `File` table's path lives —
   *  its definition carries only the format. */
  paths?: string[]
}

/** What a table or a database points at, or null when it points at nothing
 *  outside ClickHouse — which is most of them. */
export function externalSource(
  engine: string,
  engineFull: string,
  options: ExternalOptions = {},
): ExternalSource | null {
  if (!isExternalEngine(engine)) return null
  const scope = options.scope ?? 'table'
  const d = read(engineFull)

  if (/^(S3Queue|S3|GCS|COSN|OSS)$/i.test(engine)) {
    // The bucket-backed database engine takes the same first argument, so one
    // reader serves both; it simply has no key beneath it.
    return objectStore(engine, 'object_store', d)
  }
  if (/^(AzureBlobStorage|AzureQueue)$/i.test(engine)) {
    return objectStore(engine, 'object_store', d)
  }
  if (/^(Iceberg|DeltaLake|Hudi|Paimon)/i.test(engine)) {
    return objectStore(engine, 'lake', d)
  }
  if (/^HDFS$/i.test(engine)) {
    const [uri, format] = d.args
    return {
      engine,
      kind: 'object_store',
      target: uri ?? '',
      at: '',
      facts: format ? [{ label: 'format', value: format }] : [],
      collection: d.collection,
      masked: d.masked,
      unread: Math.max(0, d.args.length - 2),
    }
  }
  if (/^URL$/i.test(engine)) {
    const [url, format, compression] = d.args
    const facts: ExternalFact[] = []
    if (format) facts.push({ label: 'format', value: format })
    if (compression) facts.push({ label: 'compression', value: compression })
    return {
      engine,
      kind: 'http',
      target: url ?? '',
      at: '',
      facts,
      collection: d.collection,
      masked: d.masked,
      unread: Math.max(0, d.args.length - 3),
    }
  }
  if (/^File$/i.test(engine)) {
    // The definition holds the format and nothing else; the path is a
    // measurement the server makes, and it arrives separately.
    const [format] = d.args
    const path = options.paths?.[0] ?? ''
    return {
      engine,
      kind: 'file',
      target: path,
      at: '',
      facts: format ? [{ label: 'format', value: format }] : [],
      collection: d.collection,
      masked: d.masked,
      unread: 0,
    }
  }
  if (/^Kafka$/i.test(engine)) {
    return stream(engine, d, {
      at: 'kafka_broker_list',
      target: 'kafka_topic_list',
      facts: [
        ['kafka_group_name', 'consumer group'],
        ['kafka_format', 'format'],
        ['kafka_num_consumers', 'consumers'],
        ['kafka_security_protocol', 'security'],
      ],
    })
  }
  if (/^RabbitMQ$/i.test(engine)) {
    return stream(engine, d, {
      at: 'rabbitmq_host_port',
      target: 'rabbitmq_routing_key_list',
      facts: [
        ['rabbitmq_exchange_name', 'exchange'],
        ['rabbitmq_exchange_type', 'exchange type'],
        ['rabbitmq_queue_base', 'queue'],
        ['rabbitmq_format', 'format'],
      ],
    })
  }
  if (/^NATS$/i.test(engine)) {
    return stream(engine, d, {
      at: 'nats_url',
      target: 'nats_subjects',
      facts: [
        ['nats_queue_group', 'queue group'],
        ['nats_format', 'format'],
      ],
    })
  }
  if (/^(PostgreSQL|MaterializedPostgreSQL)$/i.test(engine)) {
    const slots =
      scope === 'database'
        ? ['host', 'database', 'user', 'secret', 'schema']
        : ['host', 'database', 'table', 'user', 'secret', 'schema']
    return connection(engine, d, slots, (v) => ({
      target: qualified(v.database, v.schema, v.table),
      at: v.host ?? '',
      facts: v.user ? [{ label: 'as', value: v.user }] : [],
    }))
  }
  if (/^(MySQL|MaterializedMySQL)$/i.test(engine)) {
    const slots =
      scope === 'database'
        ? ['host', 'database', 'user', 'secret']
        : ['host', 'database', 'table', 'user', 'secret']
    return connection(engine, d, slots, (v) => ({
      target: qualified(v.database, v.table),
      at: v.host ?? '',
      facts: v.user ? [{ label: 'as', value: v.user }] : [],
    }))
  }
  if (/^MongoDB$/i.test(engine)) {
    return connection(engine, d, ['host', 'database', 'collection', 'user', 'secret'], (v) => ({
      target: qualified(v.database, v.collection),
      at: v.host ?? '',
      facts: v.user ? [{ label: 'as', value: v.user }] : [],
    }))
  }
  if (/^SQLite$/i.test(engine)) {
    return connection(engine, d, ['path', 'table'], (v) => ({
      target: v.table ?? '',
      at: v.path ?? '',
      facts: [],
    }))
  }
  if (/^Redis$/i.test(engine)) {
    return connection(engine, d, ['host', 'db_index', 'secret', 'pool_size'], (v) => ({
      target: v.db_index ? `database ${v.db_index}` : '',
      at: v.host ?? '',
      facts: v.pool_size ? [{ label: 'pool', value: v.pool_size }] : [],
    }))
  }
  if (/^(ODBC|JDBC)$/i.test(engine)) {
    return connection(engine, d, ['connection', 'database', 'table'], (v) => ({
      target: qualified(v.database, v.table),
      at: v.connection ?? '',
      facts: [],
    }))
  }
  if (/^ExternalDistributed$/i.test(engine)) {
    // Its first argument is the engine of the far end, which is the fact that
    // makes the rest of the row readable.
    return connection(engine, d, ['remote', 'host', 'database', 'table', 'user', 'secret'], (v) => ({
      target: qualified(v.database, v.table),
      at: v.host ?? '',
      facts: [
        ...(v.remote ? [{ label: 'over', value: v.remote }] : []),
        ...(v.user ? [{ label: 'as', value: v.user }] : []),
      ],
    }))
  }
  return null
}

// ---------------------------------------------------------------------------
// Saying it
// ---------------------------------------------------------------------------

/** The location on one line, for a tooltip or a diagram node: `flint/events on
 *  s3:9000`. Falls back to the named collection, which is the whole of what a
 *  collection-shaped definition says. */
export function externalWhere(s: ExternalSource): string {
  if (s.target && s.at) return `${s.target} on ${s.at}`
  if (s.target) return s.target
  if (s.at) return s.at
  return s.collection ?? ''
}

/** What the definition did not say, and why — the sentences that keep a reader
 *  from mistaking a short panel for a complete one.
 *
 *  The masking sentence names ClickHouse on purpose. A page that shows a bucket,
 *  a user and no password looks like a page that is being coy; the truth is that
 *  the server hands out `[HIDDEN]` and Flint never asks it not to, and a reader
 *  who knows that stops looking for the setting in Flint. */
export function externalNotes(s: ExternalSource): string[] {
  const notes: string[] = []
  if (s.collection) {
    notes.push(
      `The connection is the named collection ${s.collection}, which lives in the server's configuration rather than in this definition.`,
    )
  }
  if (s.masked) {
    notes.push('ClickHouse masks the credential in its own definition, so Flint never sees it.')
  }
  if (s.unread === 1) {
    notes.push('One further argument in the definition is not named here; the DDL tab has it whole.')
  } else if (s.unread > 1) {
    notes.push(
      `${s.unread} further arguments in the definition are not named here; the DDL tab has it whole.`,
    )
  }
  return notes
}
