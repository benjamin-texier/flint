import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../lib/api'
import { endpointPath, type TablesPublished } from '../lib/publish'
import { ErrorNote, Loading } from './Note'
import { bytes, count } from '../lib/format'

/** Several tables, one act.
 *
 *  Publishing has always been per statement, which is right for the analyst who
 *  needs a join today and wrong for the only other thing anyone uses it for:
 *  handing a partner, or a spreadsheet, read access to a handful of tables.
 *  That was fifteen visits to a form to type fifteen variations of `SELECT *
 *  FROM t`, and the fifteenth is where somebody makes the mistake.
 *
 *  The panel says out loud, before anything is ticked, that most people should
 *  not be here — anyone with a ClickHouse account gets more from `POST
 *  /api/data`, which publishes nothing and answers under their own grants. This
 *  is for the caller who has no account, which is the one thing publishing does
 *  that nothing else can. */
export function ExposeTables({
  defaultDatabase,
  onDone,
}: {
  defaultDatabase: string
  onDone: () => void
}) {
  const client = useQueryClient()
  const databases = useQuery({ queryKey: ['databases'], queryFn: () => api.databases() })
  const [database, setDatabase] = useState(defaultDatabase)
  const tables = useQuery({
    queryKey: ['tables', database],
    queryFn: () => api.tables(database),
    enabled: Boolean(database),
  })

  const [chosen, setChosen] = useState<string[]>([])
  const [prefix, setPrefix] = useState('')
  const [live, setLive] = useState(false)
  const [isPublic, setPublic] = useState(false)
  const [maxRows, setMaxRows] = useState(1000)
  const [cacheTtl, setCacheTtl] = useState(0)
  const [done, setDone] = useState<TablesPublished | null>(null)

  /* Everything but a dictionary. A dictionary is read through `dictGet` rather
     than selected from the way this generates, so offering one here would be
     offering a row that fails on its first call. */
  const offerable = (tables.data ?? []).filter(
    (t) => t.kind !== 'dictionary',
  )
  const hidden = (tables.data?.length ?? 0) - offerable.length

  const expose = useMutation({
    mutationFn: () =>
      api.publishTables({
        database,
        tables: chosen,
        public: isPublic,
        max_rows: maxRows,
        state: live ? 'live' : 'draft',
        cache_ttl: cacheTtl,
        prefix,
      }),
    onSuccess: (out) => {
      setDone(out)
      setChosen([])
      client.invalidateQueries({ queryKey: ['published'] })
    },
  })

  if (done) return <Outcome outcome={done} onDone={onDone} />

  return (
    <section className="aform expose">
      <header className="aform__head">
        <h2 className="diag__title">Expose tables</h2>
      </header>

      <p className="aform__hint">
        One endpoint per table, each serving <code>SELECT * FROM table</code> — with filters, a
        sort, a projection, paging and a count layered on top by the same machinery every
        published endpoint uses. No join and no aggregate: for those, publish a statement.
      </p>
      {/* Said before anything is ticked, because for most people it is the
          answer and this panel is not. */}
      <p className="says says--watch says--wide">
        If these callers have ClickHouse accounts, do not use this. <code>POST /api/data</code>{' '}
        lets them name a table per call, publishes nothing, and answers under their own grants and
        row policies. Publishing is for the caller who has no account — a partner, a spreadsheet —
        because that is the one thing it does that nothing else can.
      </p>

      <div className="aform__row">
        <label className="aform__field aform__field--narrow">
          <span className="label">DATABASE</span>
          <select
            className="input"
            value={database}
            onChange={(e) => {
              setDatabase(e.target.value)
              setChosen([])
            }}
          >
            {(databases.data ?? []).map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label className="aform__field aform__field--narrow">
          <span className="label">ADDRESS PREFIX</span>
          <input
            className="input"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            placeholder="none"
            aria-describedby="expose-prefix"
          />
        </label>
        <label className="aform__field aform__field--tiny">
          <span className="label">MAX ROWS</span>
          <input
            className="input"
            value={maxRows}
            onChange={(e) => setMaxRows(Math.max(1, Number(e.target.value) || 1))}
            inputMode="numeric"
          />
        </label>
        <label className="aform__field aform__field--tiny">
          <span className="label">CACHE (S)</span>
          <input
            className="input"
            value={cacheTtl}
            onChange={(e) => setCacheTtl(Math.max(0, Number(e.target.value) || 0))}
            inputMode="numeric"
          />
        </label>
        <label className="aform__field aform__field--narrow">
          <span className="label">ACCESS</span>
          <select
            className="input"
            value={isPublic ? 'public' : 'token'}
            onChange={(e) => setPublic(e.target.value === 'public')}
          >
            <option value="token">each needs its token</option>
            <option value="public">anyone with the address</option>
          </select>
        </label>
        <label className="aform__field aform__field--narrow">
          <span className="label">START AS</span>
          <select
            className="input"
            value={live ? 'live' : 'draft'}
            onChange={(e) => setLive(e.target.value === 'live')}
          >
            <option value="draft">drafts, to review</option>
            <option value="live">live now</option>
          </select>
        </label>
      </div>

      <p className="aform__hint" id="expose-prefix">
        An address is the table's own name, lower-cased, with the prefix in front of it — so{' '}
        <code>{endpointPath(`${prefix}${offerable[0]?.name ?? 'orders'}`.toLowerCase())}</code>. A
        name that will not make an address is skipped and named rather than reshaped into one
        nobody chose.{' '}
        {live ? (
          <strong>
            These will start answering the moment you press the button. Fifteen addresses that
            appeared unread is a lot of surface — drafts exist so somebody can look first.
          </strong>
        ) : (
          <>Drafts answer nothing at any address until you take each one live.</>
        )}
      </p>

      {tables.isPending && database ? <Loading label="Reading the tables" /> : null}
      {tables.error ? <ErrorNote error={tables.error} retry={() => tables.refetch()} /> : null}

      {offerable.length ? (
        <>
          <div className="expose__bar">
            <span className="label">TABLES</span>
            <button
              className="btn"
              onClick={() => setChosen(offerable.map((t) => t.name))}
              disabled={chosen.length === offerable.length}
            >
              All {offerable.length}
            </button>
            <button className="btn" onClick={() => setChosen([])} disabled={chosen.length === 0}>
              None
            </button>
            <span className="mono-dim">
              {chosen.length} of {offerable.length} chosen
              {/* Every fold states its own count. */}
              {hidden > 0 ? ` · ${hidden} that cannot be served this way are not listed` : ''}
            </span>
          </div>
          <ul className="expose__list">
            {offerable.map((table) => (
              <li key={table.name}>
                <label className="expose__row">
                  <input
                    type="checkbox"
                    checked={chosen.includes(table.name)}
                    onChange={() =>
                      setChosen((held) =>
                        held.includes(table.name)
                          ? held.filter((n) => n !== table.name)
                          : [...held, table.name],
                      )
                    }
                  />
                  <code className="expose__name">{table.name}</code>
                  <span className="expose__kind">{table.kind}</span>
                  {/* An absent figure is dropped, not dashed: a view has no
                      size, and four em-dashes would say Flint asked the wrong
                      question of it. */}
                  <span className="expose__rows">
                    {table.total_rows !== null ? count(table.total_rows) : null}
                  </span>
                  <span className="expose__bytes">
                    {table.total_bytes !== null ? bytes(table.total_bytes) : null}
                  </span>
                  <span className="expose__sort">
                    {table.sorting_key ? (
                      <>sortable by {table.sorting_key}</>
                    ) : (
                      <span className="mono-dim">no sort offered</span>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {expose.error ? <ErrorNote error={expose.error} /> : null}

      <div className="aform__actions">
        <button
          className="btn btn--spark"
          disabled={chosen.length === 0 || expose.isPending}
          onClick={() => expose.mutate()}
        >
          {expose.isPending
            ? 'Publishing…'
            : `Expose ${chosen.length} table${chosen.length === 1 ? '' : 's'}`}
        </button>
        <button className="btn" onClick={onDone} disabled={expose.isPending}>
          Cancel
        </button>
      </div>
    </section>
  )
}

/** What came of it — and, once, the tokens.
 *
 *  This screen exists because of the tokens. Each is minted here and hashed on
 *  the way in, so this is the only moment any of them can be read; a batch that
 *  scrolled away having quietly handed over fifteen unreadable secrets would be
 *  the worst possible version of this feature. */
function Outcome({ outcome, onDone }: { outcome: TablesPublished; onDone: () => void }) {
  const minted = outcome.published.filter((p) => p.minted)
  return (
    <section className="aform expose">
      <header className="aform__head">
        <h2 className="diag__title">
          {outcome.published.length} published
          {outcome.skipped.length ? `, ${outcome.skipped.length} skipped` : ''}
        </h2>
      </header>

      {minted.length ? (
        <>
          <p className="says says--watch says--wide">
            {minted.length === 1 ? 'This token is' : 'These tokens are'} readable now and never
            again — {minted.length === 1 ? 'it is' : 'they are'} stored hashed. Copy{' '}
            {minted.length === 1 ? 'it' : 'them'} before leaving this screen; afterwards the only
            thing any page can offer is a new one.
          </p>
          <pre className="expose__tokens">
            {minted.map((p) => `${endpointPath(p.slug)}\t${p.minted}`).join('\n')}
          </pre>
        </>
      ) : null}

      {outcome.published.length ? (
        <ul className="expose__done">
          {outcome.published.map((p) => (
            <li key={p.slug}>
              <code>{endpointPath(p.slug)}</code>
              <span className="mono-dim">from {p.table}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* Named, not counted. Somebody who asked for fifteen and got twelve
          needs to know which three and why. */}
      {outcome.skipped.length ? (
        <ul className="expose__skipped">
          {outcome.skipped.map((s) => (
            <li key={s.table}>
              <code>{s.table}</code>
              <span className="says says--watch">{s.why}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="aform__actions">
        <button className="btn btn--spark" onClick={onDone}>
          Done
        </button>
      </div>
    </section>
  )
}
