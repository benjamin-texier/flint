import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import {
  ROLE_LABEL,
  ROLE_MEANING,
  ROLE_ORDER,
  nullRatio,
  roleOf,
  showsTopValues,
  type ColumnProfile,
  type Role,
} from '../lib/profile'
import { bytes as _bytes, count, exact } from '../lib/format'
import { TypeIcon } from './TypeIcon'
import { EmptyNote, ErrorNote, Loading } from './Note'

/** What is in this table.
 *
 *  The brief's test for this page: open an unfamiliar table and understand it
 *  without writing a query. So the roles come first — which column is the time,
 *  which are the measurements, which are the categories — and the per-column
 *  detail sits under them. */
export function Profile({ database, table }: { database: string; table: string }) {
  const profile = useQuery({
    queryKey: ['profile', database, table],
    queryFn: () => api.profile(database, table),
    // A full-table scan; not something to repeat on every focus.
    staleTime: 5 * 60 * 1000,
  })

  const grouped = useMemo(() => {
    if (!profile.data) return []
    const scanned = profile.data.scanned
    const by = new Map<Role, ColumnProfile[]>()
    for (const c of profile.data.columns) {
      const role = roleOf(c, scanned)
      if (!by.has(role)) by.set(role, [])
      by.get(role)!.push(c)
    }
    return ROLE_ORDER.filter((r) => by.has(r)).map((r) => [r, by.get(r)!] as const)
  }, [profile.data])

  if (profile.error) return <ErrorNote error={profile.error} retry={() => profile.refetch()} />
  if (!profile.data) return <Loading label="Reading the data" />
  if (profile.data.columns.length === 0) {
    return <EmptyNote title="Nothing to profile">This object exposes no columns.</EmptyNote>
  }
  // Nothing in it yet. A profile of no rows is a wall of dashes — thirty-six of
  // them on a wide table — which says only that Flint asked anyway. The roles
  // are still worth showing: they come from the column types, not the data.
  if (profile.data.scanned === 0) {
    return (
      <div className="stack">
        <EmptyNote title="Nothing in it yet">
          There are no rows to profile. Distinct counts, ranges and most-common values all need
          data; the column roles below come from the types, so they hold regardless.
        </EmptyNote>
        <RoleCards grouped={grouped} />
      </div>
    )
  }

  const { scanned, sampled } = profile.data

  return (
    <div className="stack">
      <p className="page__lead">
        {sampled ? (
          <>
            Based on the first {count(scanned)} rows — enough to characterise the data without
            reading all of it.
          </>
        ) : (
          <>Every one of the {count(scanned)} rows was read. Distinct counts are approximate.</>
        )}
      </p>

      <RoleCards grouped={grouped} />

      <div className="panel">
        <div className="panel__bar">
          <span className="panel__count">
            {profile.data.columns.length}{' '}
            {profile.data.columns.length === 1 ? 'column' : 'columns'}
          </span>
          <span className="panel__spacer" />
          <span className="panel__hint">distinct counts are approximate</span>
        </div>
        <div className="panel__scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th>Column</th>
                <th>Role</th>
                <th className="tbl--n">Distinct</th>
                <th className="tbl--n">Null</th>
                <th className="tbl--n">Min</th>
                <th className="tbl--n">Max</th>
                <th className="tbl--n">Mean</th>
                <th>Most common</th>
              </tr>
            </thead>
            <tbody>
              {profile.data.columns.map((c) => {
                const role = roleOf(c, scanned)
                const ratio = nullRatio(c, scanned)
                return (
                  <tr key={c.name}>
                    <td className="tbl__key">
                      <span className="tbl__head">
                        <TypeIcon type={c.type} />
                        {c.name}
                      </span>
                      <span className="tbl__note">{c.type}</span>
                    </td>
                    <td>
                      <span className={`rolepill rolepill--${role}`}>{ROLE_LABEL[role]}</span>
                    </td>
                    <td className="tbl--n">{exact(c.distinct)}</td>
                    <td className="tbl--n">
                      {c.nullable ? <NullBar ratio={ratio} nulls={c.nulls} /> : <span className="dash">—</span>}
                    </td>
                    <td className="tbl--n">{c.min ?? <span className="dash">—</span>}</td>
                    <td className="tbl--n">{c.max ?? <span className="dash">—</span>}</td>
                    <td className="tbl--n">{trimNumber(c.mean) ?? <span className="dash">—</span>}</td>
                    <td>
                      {showsTopValues(c) ? (
                        <span className="tops">
                          {c.top.slice(0, 4).map((v) => (
                            <span className="top" key={v} title={v}>
                              {v || '∅'}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="dash">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

/** Nulls read better as a proportion than as a count: 6% tells you whether the
 *  column is usable, 29,995 does not. */
function NullBar({ ratio, nulls }: { ratio: number; nulls: number }) {
  const percent = ratio * 100
  return (
    <span className="nullbar" title={`${exact(nulls)} rows`}>
      <span className="nullbar__value">
        {percent === 0 ? '0' : percent < 0.1 ? '<0.1' : percent.toFixed(percent < 10 ? 1 : 0)}%
      </span>
      <span className="nullbar__track">
        <span className="nullbar__fill" style={{ width: `${Math.min(100, percent)}%` }} />
      </span>
    </span>
  )
}

/** ClickHouse returns a Float64 mean at full precision; `30.299999237060547`
 *  is noise, not information. */
function trimNumber(value: string | null): string | null {
  if (value === null) return null
  const n = Number(value)
  if (!Number.isFinite(n)) return value
  return Math.abs(n) >= 1000 ? n.toFixed(0) : String(Number(n.toPrecision(6)))
}

/** What each column is for, as the brief frames it. Grouped by role and drawn
 *  from the types, so this is the one part of a profile that survives an empty
 *  table. */
function RoleCards({ grouped }: { grouped: readonly (readonly [Role, ColumnProfile[]])[] }) {
  return (
    <div className="roles">
      {grouped.map(([role, cols]) => (
        <section className={`role role--${role}`} key={role}>
          <h3 className="role__head" title={ROLE_MEANING[role]}>
            {ROLE_LABEL[role]}
            <span className="role__n">{cols.length}</span>
          </h3>
          <p className="role__why">{ROLE_MEANING[role]}</p>
          <div className="role__cols">
            {cols.map((c) => (
              <span className="role__col" key={c.name} title={c.type}>
                <TypeIcon type={c.type} />
                {c.name}
              </span>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
