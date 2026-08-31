import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import { api } from '../lib/api'
import type { GraphNode } from '../lib/graph'
import { KIND_LABEL, explainEngine, splitEngine } from '../lib/explain'
import { QUEUE_UNREADABLE, backgroundReader, isExternalEngine } from '../lib/external'
import { bytes, count, exact } from '../lib/format'
import { ErrorNote, Loading } from './Note'
import { ResultsGrid } from './ResultsGrid'
import { KindGlyph } from './TypeBadge'

/** Rows fetched for a peek. Enough to see what the columns hold and how wide
 *  they are; short of the point where this becomes the reading of the table
 *  rather than a look at it — that is the object's own Preview tab, which can
 *  order, filter and export. */
const ROWS = 20

/** The rows behind the box you just clicked.
 *
 *  The diagram says what an object is called and what it is joined to; it
 *  cannot say what is *in* it, and that is usually the next question — a table
 *  named `events` tells you nothing about whether its `type` column holds four
 *  values or four million. So selecting a node swaps the object list underneath
 *  the diagram for this. The list is not lost: clicking the background of the
 *  canvas puts it back, and so does the button here.
 *
 *  It replaces the list rather than sitting beside it because the page has one
 *  column and two tables stacked in it would push the second below the fold,
 *  where nobody reads it. */
export function TablePeek({
  node,
  database,
  onClose,
}: {
  node: GraphNode
  /** The database the page is about, which is not always the node's: the
   *  diagram reaches into other databases for the objects a view here reads. */
  database: string
  onClose: () => void
}) {
  /* Not asked for at all on a queue. Clicking a node to look at it is not
     consent to take a message off somebody's topic, and a `SELECT` here would
     do exactly that on any server with
     `stream_like_engine_allow_direct_select` on. */
  const queue = backgroundReader(node.engine)
  const preview = useQuery({
    queryKey: ['preview', node.database, node.name, ROWS],
    queryFn: () => api.preview(node.database, node.name, ROWS),
    /* The peek is a look, not a monitor: the rows it shows are a sample and a
       sample that changes under the reader is worse than a slightly old one. */
    staleTime: 60_000,
    retry: false,
    enabled: !queue,
  })

  /* The diagram is most of a screen tall, so the panel that replaced the list
     underneath it is usually below the fold: clicking a table and having the
     answer appear somewhere you cannot see is the same as it not appearing.
     `nearest` scrolls the least that makes it visible and does nothing at all
     when it already is — which is the case when you click a second node with
     this open. */
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    panel.current?.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' })
  }, [node.database, node.name])

  const [qualifier, family] = splitEngine(node.engine)
  const result = preview.data
  /* What the diagram already knows, which is nothing at all for an object in
     another database — sizes are only gathered for the one in view. An absent
     figure is dropped rather than dashed. */
  /* And nothing at all for a table whose rows are in a bucket, a topic or on
     another server: `system.parts` returns zero for it, and a zero drawn here
     reads as an empty table rather than as a table this server has never
     held. */
  const elsewhere = node.external || isExternalEngine(node.engine)
  const rows = elsewhere ? null : node.rows
  const disk = elsewhere ? null : node.bytes

  return (
    <section className="section" ref={panel}>
      <div className="panel peek">
        <div className="panel__bar">
          <span className="peek__what">
            <KindGlyph kind={node.kind} />
            <span className="peek__name">{node.name}</span>
            {node.database !== database ? (
              <span className="peek__db">in {node.database}</span>
            ) : null}
          </span>

          <span className="peek__engine" title={explainEngine(node.engine) ?? undefined}>
            {qualifier ? <span className="peek__enginekey">{qualifier}</span> : null}
            {family}
          </span>

          {rows !== null || disk !== null ? (
            <span className="peek__figures">
              {rows !== null ? <span>{count(rows)} rows</span> : null}
              {disk !== null ? <span>{bytes(disk)}</span> : null}
            </span>
          ) : null}

          <span className="panel__spacer" />

          <Link
            className="btn"
            to={`/db/${encodeURIComponent(node.database)}/${encodeURIComponent(node.name)}`}
          >
            Open the {KIND_LABEL[node.kind]}
          </Link>
          {/* Says what going back lands on, because the thing it replaced is
              off screen while this is open. */}
          <button className="btn" onClick={onClose}>
            Back to the list
          </button>
        </div>

        {queue ? (
          <div className="peek__note">
            <p className="peek__quiet">{QUEUE_UNREADABLE}</p>
          </div>
        ) : preview.error ? (
          <div className="peek__note">
            <ErrorNote error={preview.error} retry={() => preview.refetch()} />
          </div>
        ) : result ? (
          <>
            <div className="peek__grid">
              <ResultsGrid result={result} />
            </div>
            {/* Which rows these are. `LIMIT` with no `ORDER BY` returns
                whatever ClickHouse reads first — usually the oldest parts — and
                a reader who takes the top of this for the newest rows will
                draw the wrong conclusion from it. */}
            <p className="peek__foot">
              The first {exact(result.rows.length)} rows ClickHouse returned, in stored order —
              not the newest. The {KIND_LABEL[node.kind]}’s own Preview tab can order, filter
              and export them.
            </p>
          </>
        ) : (
          <div className="peek__note">
            <Loading label={`Reading ${node.name}`} />
          </div>
        )}
      </div>
    </section>
  )
}
