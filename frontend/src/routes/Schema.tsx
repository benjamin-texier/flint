import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'

import { api } from '../lib/api'
import { bytes, count } from '../lib/format'
import { declared, inferred, verdict } from '../lib/impact'
import { canTruncate, dropWording, type SchemaObject } from '../lib/schema'
import { allows } from '../lib/spaces'
import { Alter } from '../components/Alter'
import { Create } from '../components/Create'
import { Storage } from '../components/Storage'
import { EmptyNote, ErrorNote, Loading } from '../components/Note'

/** Infrastructure — Schema: the objects on this server, and how to remove them.
 *
 *  Deliberately not a schema editor. Creating and altering are the other half of
 *  this phase and are not here; what is here is the half that needed a *place*,
 *  because the rule set with the two spaces holds — no Data control may change
 *  structure, and the table page is Data. Dropping had nowhere it was allowed to
 *  live until this page existed.
 *
 *  Largest first. The reason to open a list of things you can delete is usually
 *  that something is too big. */
export function SchemaPage() {
  const config = useQuery({ queryKey: ['config'], queryFn: () => api.config() })
  /* Which row is being confirmed, held here rather than in the row: the
     confirmation is a full-width row of its own, and a cell cannot render one.
     It had to be — inside the cell the list of dependents was clipped at 343px
     of a 601px string, so the one thing the confirmation exists to show was the
     one thing you could not read. */
  const [confirming, setConfirming] = useState<{ qualified: string; action: 'drop' | 'truncate' } | null>(
    null,
  )
  /* Which row is open for alteration, held here for the same reason the
     confirmation is: the panel is a full-width row of its own, and a cell cannot
     render one. One at a time, so the strip of operations never sits beside
     another strip of operations. */
  const [altering, setAltering] = useState<string | null>(null)
  /* An alteration arriving by link, which is how the projection advisor hands
     a proposal over: it lives on the table page, the table page is Data, and
     Data may not change structure. So it sends the statement here rather than
     running it there. Read once into state, so closing the panel closes it and
     a URL nobody cleaned up does not reopen it on every render. */
  const [linked] = useSearchParams()
  const [invited, setInvited] = useState(() => {
    const target = linked.get('alter')
    const op = linked.get('op')
    if (!target || !op) return null
    const values: Record<string, string> = {}
    for (const field of ['name', 'query', 'column', 'kind', 'expression', 'granularity', 'expr', 'to', 'default_expr']) {
      const value = linked.get(field)
      if (value) values[field] = value
    }
    return { target, op, values }
  })
  /* The DDL editor, opened from a row and starting from that row's own
     definition. One at a time, and never beside the alter panel: they answer
     different questions and two open panels under one row read as one. */
  const [copying, setCopying] = useState<string | null>(null)
  const report = useQuery({
    queryKey: ['schema', 'objects'],
    queryFn: () => api.schemaObjects(),
    staleTime: 20_000,
  })
  const may = allows(config.data?.tier, 'admin')
  const data = report.data
  const objects = data?.objects ?? []

  return (
    <div className="page page--diagnose">
      <header className="page__head">
        <p className="eyebrow">INFRASTRUCTURE</p>
        <div className="page__titlerow">
          <h1 className="page__title page__title--hero">What is on this server</h1>
        </div>
      </header>

      <section className="diag">
        <header className="diag__head">
          <h2 className="diag__title">Objects</h2>
          <p className="diag__sub">
            Every database except ClickHouse&apos;s own, largest first. Removing something asks
            what depends on it first — and says how sure it is of the answer.
          </p>
        </header>

        {report.isPending ? <Loading label="Reading the schema" /> : null}
        {report.error ? <ErrorNote error={report.error} retry={() => report.refetch()} /> : null}
        {data && !data.available ? (
          <EmptyNote title="Not available here">{data.reason}.</EmptyNote>
        ) : null}

        {objects.length ? (
          <>
            <p className="diag__sub">
              {objects.length === data?.total
                ? `${count(data.total)} objects`
                : `Showing ${objects.length} of ${count(data?.total ?? 0)} objects`}
            </p>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Object</th>
                  <th>Kind</th>
                  <th className="tbl--n">Rows</th>
                  <th className="tbl--n">Size</th>
                  {may ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {objects.flatMap((o) => [
                  <tr key={o.qualified}>
                    <td className="tbl__key">
                      {/* Into Data, where reading it belongs. The two spaces stay
                          apart; a link across is not a control across. */}
                      <Link
                        className="link"
                        to={`/db/${encodeURIComponent(o.database)}/${encodeURIComponent(o.name)}`}
                      >
                        {o.qualified}
                      </Link>
                    </td>
                    <td className="mono-dim">{o.kind}</td>
                    {/* Dropped, not dashed: a view has no rows, and four
                        em-dashes would say Flint asked the wrong question. */}
                    <td className="tbl--n">{o.rows === null ? '' : count(o.rows)}</td>
                    <td className="tbl--n mono-dim">{o.bytes === null ? '' : bytes(o.bytes)}</td>
                    {may ? (
                      <td className="tbl--n">
                        <div className="oacts">
                          {canTruncate(o) ? (
                            <button
                              className="btn"
                              onClick={() => setConfirming({ qualified: o.qualified, action: 'truncate' })}
                            >
                              Empty
                            </button>
                          ) : null}
                          {canTruncate(o) ? (
                            <button
                              className="btn"
                              onClick={() => {
                                setConfirming(null)
                                setCopying(null)
                                setAltering(altering === o.qualified ? null : o.qualified)
                              }}
                            >
                              Alter
                            </button>
                          ) : null}
                          <button
                            className="btn"
                            onClick={() => {
                              setConfirming(null)
                              setAltering(null)
                              setCopying(copying === o.qualified ? null : o.qualified)
                            }}
                          >
                            Copy
                          </button>
                          <button
                            className="btn"
                            onClick={() => setConfirming({ qualified: o.qualified, action: 'drop' })}
                          >
                            Drop
                          </button>
                        </div>
                      </td>
                    ) : null}
                  </tr>,
                  may && confirming?.qualified === o.qualified ? (
                    <tr className="oacts__panelrow" key={`${o.qualified}-confirm`}>
                      <td colSpan={5}>
                        <Confirm
                          object={o}
                          action={confirming.action}
                          onDone={() => setConfirming(null)}
                        />
                      </td>
                    </tr>
                  ) : null,
                  may && (altering === o.qualified || invited?.target === o.qualified) ? (
                    <tr className="oacts__panelrow" key={`${o.qualified}-alter`}>
                      <td colSpan={5}>
                        <Alter
                          database={o.database}
                          table={o.name}
                          prefill={
                            invited?.target === o.qualified
                              ? { op: invited.op, values: invited.values }
                              : undefined
                          }
                          onDone={() => {
                            setAltering(null)
                            setInvited(null)
                          }}
                        />
                      </td>
                    </tr>
                  ) : null,
                  may && copying === o.qualified ? (
                    <tr className="oacts__panelrow" key={`${o.qualified}-copy`}>
                      <td colSpan={5}>
                        <Create
                          database={o.database}
                          table={o.name}
                          onDone={() => setCopying(null)}
                        />
                      </td>
                    </tr>
                  ) : null,
                ])}
              </tbody>
            </table>
          </>
        ) : null}
      </section>
      {/* After the objects, because it answers a question about them:
          where the bytes of the things above are allowed to go. */}
      <Storage />
    </div>
  )
}

/** Remove an object, having been told what that breaks.
 *
 *  The confirmation *is* the impact: it asks the server what depends on this and
 *  shows the answer before offering the button. Which is the whole argument for
 *  Flint keeping a lineage graph — it is the only thing here that no other
 *  ClickHouse console can put in front of a delete.
 *
 *  Full width, in a row of its own. It began inside the action cell and the list
 *  of dependents was clipped — 601px of names in a 343px box — so the one thing
 *  the confirmation exists to show was the one thing you could not read.
 *
 *  And it says how sure it is. `declared` is ClickHouse's own dependency list;
 *  `inferred` is Flint having read a definition with something that is
 *  deliberately not a SQL parser. One number over both would be a promise it
 *  cannot make about half of them. */
function Confirm({
  object,
  action,
  onDone,
}: {
  object: SchemaObject
  action: 'drop' | 'truncate'
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const impact = useQuery({
    queryKey: ['impact', object.database, object.name],
    queryFn: () => api.impact(object.database, object.name),
    // Only for a drop, and only once asked. Truncating leaves every definition
    // standing, so nothing downstream breaks — and fetching this for four
    // hundred rows would be four hundred graph traversals nobody asked for.
    enabled: action === 'drop',
    retry: false,
  })
  const act = useMutation({
    mutationFn: () => api.objectAction(object.database, object.name, action),
    onSuccess: () => {
      onDone()
      queryClient.invalidateQueries({ queryKey: ['schema', 'objects'] })
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      queryClient.invalidateQueries({ queryKey: ['databases'] })
    },
  })

  const line = verdict(impact.data)
  const sure = declared(impact.data)
  const guessed = inferred(impact.data)

  return (
    <div className="oconfirm">
      <div className="oconfirm__what">
        <p className="oconfirm__cost">
          {action === 'truncate'
            ? `Empty ${object.qualified}: ${
                object.rows === null ? 'every row' : `${count(object.rows)} rows`
              }, for good. The definition stays.`
            : `Drop ${object.kind} ${object.qualified}: ${
                object.rows === null ? 'the definition' : `${count(object.rows)} rows`
              }, for good.`}
        </p>

        {action === 'drop' && impact.isPending ? (
          <p className="oconfirm__names">asking what depends on it…</p>
        ) : null}

        {action === 'drop' && !impact.isPending ? (
          <p className="oconfirm__names">{line ? `${line}.` : 'Nothing reads it.'}</p>
        ) : null}

        {sure.length ? (
          <p className="oconfirm__names">
            <span className="oconfirm__how">ClickHouse registered these — they will break:</span>{' '}
            {sure.map((d) => d.qualified).join(', ')}
          </p>
        ) : null}

        {guessed.length ? (
          <p className="oconfirm__names oconfirm__names--soft">
            <span className="oconfirm__how">
              These name it in their definition, read by Flint rather than declared by the server:
            </span>{' '}
            {guessed.map((d) => d.qualified).join(', ')}
          </p>
        ) : null}
      </div>

      <div className="oconfirm__acts">
        <button
          className="btn"
          onClick={() => act.mutate()}
          disabled={act.isPending || (action === 'drop' && impact.isPending)}
        >
          {action === 'truncate' ? 'Empty it' : dropWording(sure.length + guessed.length)}
        </button>
        <button className="btn" onClick={onDone} disabled={act.isPending}>
          Keep it
        </button>
        {act.error ? (
          <span className="oconfirm__error">
            {act.error instanceof Error ? act.error.message : 'it was refused'}
          </span>
        ) : null}
      </div>
    </div>
  )
}
