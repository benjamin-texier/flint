import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'

import { api } from '../lib/api'
import {
  type Comparison,
  HOW_LABEL,
  KIND_LABEL,
  blockers,
  columns,
  headline,
  qualified,
  storage,
} from '../lib/compare'
import { ErrorNote, Loading, Sentence } from './Note'

/** Two tables, side by side.
 *
 *  The question is asked constantly and answered by eye: a staging copy against
 *  production, a `_v2` against the table it will replace. Reading two
 *  `SHOW CREATE TABLE`s and holding both in your head is exactly the work a
 *  schema explorer should remove.
 *
 *  What it is compared against lives in the URL, so a link to a particular
 *  comparison is a link somebody can send — the rule every other view here
 *  follows. */
export function Compare({ database, table }: { database: string; table: string }) {
  const [params, setParams] = useSearchParams()
  const against = params.get('with') ?? ''

  const siblings = useQuery({
    queryKey: ['tables', database],
    queryFn: () => api.tables(database),
    staleTime: 60_000,
  })

  const found = useQuery({
    queryKey: ['compare', database, table, against],
    queryFn: () => api.compare(database, table, against),
    enabled: against.length > 0,
    staleTime: 60_000,
  })

  const pick = (value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set('with', value)
    else next.delete('with')
    setParams(next, { replace: true })
  }

  const others = (siblings.data ?? []).filter((t) => t.name !== table)

  return (
    <section className="cmp">
      <div className="cmp__pick">
        <label className="cmp__label" htmlFor="cmp-with">
          Compare <code className="ident">{table}</code> with
        </label>
        <select
          id="cmp-with"
          className="cmp__select"
          value={against}
          onChange={(e) => pick(e.target.value)}
        >
          <option value="">choose a table…</option>
          {others.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
        {/* Anything in another database is typed, because listing every table on
            the server to fill a menu is a request nobody asked for. */}
        <input
          className="cmp__other"
          placeholder="or database.table"
          defaultValue={against.includes('.') ? against : ''}
          onBlur={(e) => e.target.value && pick(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') pick((e.target as HTMLInputElement).value)
          }}
        />
      </div>

      {!against ? (
        <p className="cmp__idle">
          Column by column and setting by setting, in the direction that matters: whether the
          other table could stand in for this one.
        </p>
      ) : found.isPending ? (
        <Loading label="Reading both tables" />
      ) : found.error ? (
        <ErrorNote error={found.error} retry={() => found.refetch()} />
      ) : found.data ? (
        <Result comparison={found.data} />
      ) : null}
    </section>
  )
}

function Result({ comparison }: { comparison: Comparison }) {
  const c = comparison
  const changes = columns(c)
  const store = storage(c)
  const inTheWay = blockers(c)

  return (
    <>
      <Sentence className="cmp__says" text={headline(c)} />

      {inTheWay.length ? (
        <ul className="cmp__blockers">
          {inTheWay.map((line) => (
            <li key={line}>
              <Sentence text={line} />
            </li>
          ))}
        </ul>
      ) : null}

      {store.length ? (
        <table className="tbl cmp__tbl">
          <thead>
            <tr>
              <th>Setting</th>
              <th>{qualified(c.left)}</th>
              <th>{qualified(c.right)}</th>
            </tr>
          </thead>
          <tbody>
            {store.map((s) => (
              <tr key={s.what}>
                <td className="tbl__key">
                  {s.what}
                  {s.reordered ? <span className="tbl__note">same columns, different order</span> : null}
                </td>
                <td className="cmp__was">{s.left || <span className="dash">—</span>}</td>
                <td>{s.right || <span className="dash">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <table className="tbl cmp__tbl">
        <thead>
          <tr>
            <th>Column</th>
            <th>{qualified(c.left)}</th>
            <th>{qualified(c.right)}</th>
            <th>What changed</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((ch) => (
            <tr key={ch.name} className={`cmp__row cmp__row--${ch.kind}`}>
              <td className="tbl__key">
                <code className="ident">{ch.name}</code>
              </td>
              <td className="cmp__was">{ch.left?.type ?? <span className="dash">—</span>}</td>
              <td>{ch.right?.type ?? <span className="dash">—</span>}</td>
              <td>
                {ch.kind === 'same' && !ch.moved ? (
                  <span className="cmp__quiet">unchanged</span>
                ) : (
                  <>
                    <span className={`flag flag--cmp-${ch.kind}`}>{KIND_LABEL[ch.kind]}</span>
                    {ch.how ? <span className="cmp__how">{HOW_LABEL[ch.how]}</span> : null}
                    {/* A move alongside a retype: the first version of this hid
                        it behind the type, and a move is what breaks a
                        positional INSERT. */}
                    {ch.moved && ch.kind !== 'moved' ? (
                      <span className="cmp__how">
                        and moved to position {ch.right?.position}
                      </span>
                    ) : null}
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
