import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import { api } from '../lib/api'
import type { QueryResult } from '../lib/api'
import type { GraphEdge, GraphNode } from '../lib/graph'
import { nodeId } from '../lib/graph'
import { KIND_LABEL, KIND_MEANING, explainEngine, storesParts } from '../lib/explain'
import { bytes, count, exact, ratio, relativeTime } from '../lib/format'
import type { TableTraffic } from '../lib/diagnose'
import { cellText } from '../lib/grid'
import { analyseDefinition } from '../lib/lineage'
import { shortType } from '../lib/chType'
import { KindGlyph } from './TypeBadge'
import { ExternalLine } from './ExternalSource'
import { isExternalEngine } from '../lib/external'

/** Fields of the first row, before the list becomes a wall. The count of what
 *  was left out goes underneath. */
const SAMPLE_FIELDS = 6

/** Columns of provenance before the panel becomes a list to scroll rather than
 *  read. The rest are one click away, on the object's own Sources tab. */
const PROVENANCE_ROWS = 8

/** What a selected object is, without leaving the diagram.
 *
 *  Kiali's graph does this: one click selects and fills a side panel, and you
 *  keep your place in the topology. Flint used to navigate away on click, which
 *  meant every question about a node cost you the view you had built up. */
export function NodePanel({
  node,
  edges,
  nodes,
  onClose,
  onCentre,
  onLineage,
  canCentre = true,
  traffic,
  trafficDays,
}: {
  node: GraphNode
  edges: GraphEdge[]
  nodes: GraphNode[]
  onClose: () => void
  onCentre: (id: string) => void
  /** Draw only what feeds this object and what it feeds. */
  onLineage?: (id: string) => void
  /** False when the whole schema is drawn and re-rooting would do nothing. */
  canCentre?: boolean
  /** What the query log says about this object, when it says anything. */
  traffic?: TableTraffic
  trafficDays?: number
}) {
  const id = nodeId(node)
  // The graph carries only what the diagram needed. The keys, the partitioning
  // and the TTL come from the table endpoint, so the panel deepens a moment
  // after it opens rather than making the diagram wait for them.
  const detail = useQuery({
    queryKey: ['table', node.database, node.name],
    queryFn: () => api.table(node.database, node.name),
  })

  const byId = new Map(nodes.map((n) => [nodeId(n), n]))
  const upstream = edges.filter((e) => e.to === id).map((e) => e.from)
  const downstream = edges.filter((e) => e.from === id).map((e) => e.to)

  const t = detail.data
  // The graph only carries sizes for the database in view, so for anything
  // else the fetched detail is the only real answer — and until it arrives,
  // there is no answer rather than a zero. Where both have something to say the
  // larger wins: a materialized view reports nothing for itself, and the figure
  // the graph carries is the storage table ClickHouse made for it.
  const rows = t ? Math.max(t.total_rows ?? t.parts_rows, node.rows) : node.external ? null : node.rows
  const disk = t ? Math.max(t.total_bytes ?? t.parts_bytes, node.bytes) : node.external ? null : node.bytes
  const compression = t && disk ? ratio(t.uncompressed_bytes, disk) : null
  const external = isExternalEngine(node.engine)

  const shape: [string, string | null | undefined][] = [
    ['engine', node.engine],
    ['order by', t?.sorting_key],
    ['partition by', t?.partition_key],
    ['ttl', t?.ttl],
  ]

  return (
    <aside className="npanel" aria-label={`${node.name} details`}>
      <header className="npanel__head">
        <KindGlyph kind={node.kind} size="lg" />
        <div className="npanel__title">
          <h3 className="npanel__name">{node.name}</h3>
          <p className="npanel__kind">
            {KIND_LABEL[node.kind]}
            {node.external ? ` in ${node.database}` : ''}
          </p>
        </div>
        <button className="npanel__close" onClick={onClose} aria-label="Close details">
          ×
        </button>
      </header>

      <p className="npanel__lead">{explainEngine(node.engine) ?? KIND_MEANING[node.kind]}</p>

      {/* Waits for the detail, like the keys below it: the graph carries the
          engine's name but not its arguments, and the address is in the
          arguments. */}
      {t ? <ExternalLine engine={node.engine} engineFull={t.engine_full} /> : null}

      <dl className="npanel__stats">
        {/* A view holds nothing, so it is given no size — but a materialized
            view's storage is real disk and belongs on the view. */}
        {/* Nothing about an external table's rows is on this server, so the
            zeroes `system.parts` returns for it are not a measurement — the
            same reason the diagram behind this panel draws its column count
            instead. */}
        {external ? null : node.kind === 'table' || (rows ?? 0) > 0 || (disk ?? 0) > 0 ? (
          <>
            <Stat label="rows" value={rows === null ? '—' : count(rows)} />
            <Stat label="on disk" value={disk === null ? '—' : bytes(disk)} />
            {compression ? <Stat label="compression" value={compression} accent /> : null}
          </>
        ) : null}
        <Stat label="columns" value={exact(node.columns || t?.columns.length)} />
        {t && storesParts(node.engine) ? <Stat label="parts" value={exact(t.parts)} /> : null}
      </dl>

      {/* Use, beside shape. The diagram says what depends on this; only the log
          says whether anyone asks for it. Reads and writes stay apart because a
          materialized view's target is written constantly and read never. */}
      {traffic ? (
        <dl className="npanel__stats">
          <Stat label={`reads / ${trafficDays ?? 7}d`} value={exact(traffic.reads)} />
          <Stat label="writes" value={exact(traffic.writes)} />
          {traffic.reads > 0 ? (
            <Stat label="last read" value={relativeTime(traffic.last_read)} />
          ) : null}
        </dl>
      ) : null}

      <Sample node={node} />

      <div className="npanel__shape">
        {shape
          .filter(([, value]) => value)
          .map(([key, value]) => (
            <div key={key}>
              <dt className="npanel__key">{key}</dt>
              <dd className="npanel__value">{value}</dd>
            </div>
          ))}
      </div>

      <Lineage
        title="Reads from"
        ids={upstream}
        byId={byId}
        empty="Nothing — this is a source."
        onCentre={onCentre}
      />
      <Lineage
        title="Read by"
        ids={downstream}
        byId={byId}
        empty="Nothing reads from this yet."
        onCentre={onCentre}
      />

      {t?.as_select ? (
        <Provenance asSelect={t.as_select} database={node.database} name={node.name} />
      ) : null}

      <div className="npanel__actions">
        <Link
          className="btn btn--spark"
          to={`/db/${encodeURIComponent(node.database)}/${encodeURIComponent(node.name)}`}
        >
          Open
        </Link>
        {canCentre ? (
          <button className="btn" onClick={() => onCentre(id)}>
            Centre here
          </button>
        ) : null}
        {onLineage ? (
          <button className="btn" onClick={() => onLineage(id)}>
            Whole path
          </button>
        ) : null}
      </div>
    </aside>
  )
}

/** The first row, in the panel.
 *
 *  Engines and sorting keys say how an object is built; a row says what is in
 *  it, which is the question most clicks are actually asking. It is turned on
 *  its side deliberately: a grid of six columns in a 320px panel shows two of
 *  them, both ellipsised, whereas one row down the page shows every field with
 *  its value beside it — which is what makes an object recognisable. */
function Sample({ node }: { node: GraphNode }) {
  const sample = useQuery({
    queryKey: ['preview', node.database, node.name, 1],
    queryFn: () => api.preview(node.database, node.name, 1),
    // A view can be an expensive select. One attempt, and the answer is kept
    // long enough that clicking around the diagram does not re-run it.
    retry: false,
    staleTime: 5 * 60_000,
  })

  return (
    <section className="npanel__section">
      <h4 className="npanel__sectiontitle">First row</h4>
      {sample.isPending ? (
        <p className="npanel__none">Reading a row…</p>
      ) : sample.error ? (
        <p className="npanel__none">
          {sample.error instanceof Error ? sample.error.message : 'Could not read a row.'}
        </p>
      ) : sample.data && sample.data.rows.length > 0 ? (
        <FirstRow result={sample.data} />
      ) : (
        <p className="npanel__none">No rows yet.</p>
      )}
    </section>
  )
}

function FirstRow({ result }: { result: QueryResult }) {
  const row = result.rows[0] ?? []
  const columns = result.columns.slice(0, SAMPLE_FIELDS)
  const hidden = result.columns.length - columns.length

  return (
    <>
      <dl className="sample">
        {columns.map((column, i) => {
          const { text, kind } = cellText(row[i])
          return (
            <div className="sample__field" key={column.name}>
              <dt className="sample__col" title={`${column.name} · ${column.type}`}>
                {column.name}
              </dt>
              <dd
                className={`sample__val${kind === 'value' ? '' : ' is-void'}`}
                title={`${text} · ${shortType(column.type)}`}
              >
                {text}
              </dd>
            </div>
          )
        })}
      </dl>
      {hidden > 0 ? (
        <p className="sample__note">
          {hidden} more {hidden === 1 ? 'column' : 'columns'} — open the object to read them all
        </p>
      ) : null}
    </>
  )
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="npanel__stat">
      <dd className={`npanel__statval${accent ? ' is-accent' : ''}`}>{value}</dd>
      <dt className="npanel__statlabel">{label}</dt>
    </div>
  )
}

function Lineage({
  title,
  ids,
  byId,
  empty,
  onCentre,
}: {
  title: string
  ids: string[]
  byId: Map<string, GraphNode>
  empty: string
  onCentre: (id: string) => void
}) {
  return (
    <section className="npanel__section">
      <h4 className="npanel__sectiontitle">
        {title}
        {ids.length > 0 ? <span className="npanel__n">{ids.length}</span> : null}
      </h4>
      {ids.length === 0 ? (
        <p className="npanel__none">{empty}</p>
      ) : (
        <ul className="npanel__list">
          {ids.map((id) => {
            const n = byId.get(id)
            if (!n) return null
            return (
              <li key={id}>
                <button className="npanel__link" onClick={() => onCentre(id)}>
                  <KindGlyph kind={n.kind} />
                  <span className="npanel__linkname">{n.name}</span>
                  {n.external ? <span className="npanel__linkdb">{n.database}</span> : null}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/** Column by column, in the panel.
 *
 *  "Reads from" says which tables; this says which of their columns, which is
 *  the question one step further in and the reason you clicked. The definition
 *  is already in hand — the panel fetched it for the keys and the engine — so
 *  this costs no request, and it is read here rather than server-side because
 *  the server's own reader answers a different question: it turns definitions
 *  into the *edges* this diagram is drawn from, not into columns. */
function Provenance({
  asSelect,
  database,
  name,
}: {
  asSelect: string
  database: string
  name: string
}) {
  const definition = analyseDefinition(asSelect)
  // Only columns whose source could actually be named. In a 320px panel, a row
  // reading `unique_id` under `unique_id` — a reference the reader could not
  // place, so it echoes the name back — is worse than no row: the Sources tab is
  // where the unplaced ones are accounted for honestly.
  const placed = (definition?.columns ?? [])
    .map((column) => ({ ...column, from: column.from.filter((ref) => ref.table) }))
    .filter((column) => column.name && column.from.length > 0)
  if (placed.length === 0) return null

  const shown = placed.slice(0, PROVENANCE_ROWS)
  const hidden = placed.length - shown.length

  return (
    <section className="npanel__section">
      <h4 className="npanel__sectiontitle">
        Column by column
        <span className="npanel__n">{placed.length}</span>
      </h4>
      <dl className="prov">
        {shown.map((column) => (
          <div className="prov__row" key={column.name}>
            <dt className="prov__out" title={column.expression}>
              {column.name}
            </dt>
            <dd className="prov__in">
              {column.from.map((ref) => (
                <span className="prov__ref" key={`${ref.table}.${ref.column}`}>
                  <span className="prov__table">{ref.table}.</span>
                  {ref.column}
                </span>
              ))}
            </dd>
          </div>
        ))}
      </dl>
      {hidden > 0 ? (
        <p className="npanel__none">
          <Link
            className="link"
            to={`/db/${encodeURIComponent(database)}/${encodeURIComponent(name)}?tab=sources`}
          >
            {hidden} more, with the source schemas
          </Link>
        </p>
      ) : null}
    </section>
  )
}
