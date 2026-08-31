import React from 'react'
import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import { bytes, count, duration } from '../lib/format'
import {
  appliesTo,
  appliesToNobody,
  byTable,
  closestToCeiling,
  countedPer,
  fullness,
  narrowed,
  pressure,
  reading,
  usageFor,
  window as everyWindow,
  type Ceiling,
  type LimitsReport,
  type ProfileSetting,
  type Section,
} from '../lib/limits'
import { asWindow } from '../lib/govern'
import { allows } from '../lib/spaces'
import { Drop, NewPolicy, NewProfile, NewQuota } from './Govern'
import { EmptyNote, ErrorNote, Loading } from './Note'

/** Quotas, settings profiles and row policies.
 *
 *  The other half of access: `AccessView` says what an account may *do*, and
 *  this says how much of it, with which settings, and over which rows. Three
 *  sections rather than one, because they are three system tables with three
 *  grants behind them and each can be refused on its own. */
export function LimitsView() {
  const config = useQuery({ queryKey: ['config'], queryFn: () => api.config() })
  /* Access control is `admin`, like the grants above: a row policy decides which
     rows somebody sees and a quota decides how many queries they get, which is
     the same kind of decision as a grant. Hidden below that tier rather than
     offered and refused. */
  const may = allows(config.data?.tier, 'admin')
  const report = useQuery({
    queryKey: ['limits'],
    queryFn: () => api.limits(),
    staleTime: 30_000,
  })

  return (
    <section className="diag">
      <header className="diag__head">
        <h2 className="diag__title">How much, and which rows</h2>
        <p className="diag__sub">
          A quota caps what an account may consume, a settings profile fixes the settings it runs
          with, and a row policy decides which rows it sees. Multi-tenant ClickHouse is configured
          almost entirely in these three places. Read-only, like the list above.
        </p>
      </header>

      {report.isPending ? <Loading label="Reading quotas, profiles and policies" /> : null}
      {report.error ? <ErrorNote error={report.error} retry={() => report.refetch()} /> : null}
      {report.data ? <Body report={report.data} may={may} /> : null}
    </section>
  )
}

function Body({ report, may }: { report: LimitsReport; may: boolean }) {
  return (
    <>
      <Group
        title="Quotas"
        make={may ? <NewQuota done={() => undefined} /> : undefined}
        section={report.quotas}
        empty="No quotas beyond the stock one — nothing on this server is capped."
      >
        {report.quotas.items.map((q) => (
          <li className="acc__item" key={q.name}>
            <div className="acc__head">
              <span className="acc__name">{q.name}</span>
              <span className="mono-dim">
                {appliesTo(q)} · {countedPer(q)}
              </span>
              {q.storage === 'users_xml' ? (
                <span className="flag flag--idle">from users.xml</span>
              ) : null}
              {/* Only what SQL wrote can be dropped by SQL — the same rule the
                  user and role controls follow, for the same reason. */}
              {may && q.storage !== 'users_xml' ? (
                <>
                  <Edit
                    label="quota"
                    form={(close) => (
                      <NewQuota
                        done={close}
                        initial={{
                          name: q.name,
                          key: q.keys[0] ?? '',
                          to: q.apply_to_list.join(', '),
                          /* Every ceiling of every interval, because the form
                             sends all of them — and one row per (interval,
                             dimension) is how the form holds them. */
                          rows: q.intervals.flatMap((iv) =>
                            iv.ceilings.map((c) => ({
                              window: asWindow(iv.duration_secs),
                              dimension: c.dimension.replace(/ /g, '_'),
                              max: String(c.max),
                            })),
                          ),
                        }}
                      />
                    )}
                  />
                  <Drop what="quota" name={q.name} />
                </>
              ) : null}
            </div>
            {q.intervals.map((iv) => (
              <div className="lim__interval" key={iv.duration_secs}>
                <p className="acc__line">
                  <span className="label">{everyWindow(iv.duration_secs).toUpperCase()}</span>
                  {iv.randomized ? (
                    <span className="mono-dim">offset per key, so no two windows end together</span>
                  ) : null}
                </p>
                {iv.ceilings.length === 0 ? (
                  /* Real and worth saying: the stock `default` quota has an
                     interval and not one ceiling in it, so it counts everything
                     and refuses nothing. An empty table would read as a bug. */
                  <p className="diag__quiet">No ceiling on any dimension — it counts, and caps nothing.</p>
                ) : (
                  <Ceilings
                    ceilings={iv.ceilings}
                    usage={usageFor(report.usage.items, q.name, iv.duration_secs)}
                    scope={report.usage_scope}
                    blocked={report.usage.blocked}
                  />
                )}
              </div>
            ))}
          </li>
        ))}
      </Group>

      {/* An account may be refused the quota definitions and still read its own
          consumption, and every usage row carries the ceilings it is counted
          against — so the answer to "how close am I" survives losing the list
          of quotas. Drawn only in that case: where the definitions are
          readable, the same figures are already beside them. */}
      {report.quotas.blocked && report.usage.items.length ? (
        <>
          <h3 className="acc__group">Your own consumption</h3>
          <p className="diag__quiet">
            The quotas themselves are not readable by this user, but what it has spent against
            them is.
          </p>
          <ul className="acc">
            {report.usage.items.map((u) => (
              <li className="acc__item" key={`${u.quota_name}-${u.duration_secs}`}>
                <div className="acc__head">
                  <span className="acc__name">{u.quota_name}</span>
                  <span className="mono-dim">{everyWindow(u.duration_secs)}</span>
                </div>
                {u.ceilings.length === 0 ? (
                  <p className="diag__quiet">
                    No ceiling on any dimension — it counts, and caps nothing.
                  </p>
                ) : (
                  <table className="tbl acc__grants">
                    <thead>
                      <tr>
                        <th>Caps</th>
                        <th className="tbl--n">Ceiling</th>
                        <th className="tbl--n">Spent</th>
                      </tr>
                    </thead>
                    <tbody>
                      {u.ceilings.map((c) => (
                        <tr key={c.dimension}>
                          <td className="tbl__key">{c.dimension}</td>
                          <td className="tbl--n mono-dim">{figure(c.max, c.unit)}</td>
                          <td className="tbl--n">
                            <Gauge c={c} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <Group
        title="Settings profiles"
        make={may ? <NewProfile done={() => undefined} /> : undefined}
        section={report.profiles}
        empty="No settings profiles are defined."
      >
        {report.profiles.items.map((p) => {
          /* A profile is fastened on from either end and the two look nothing
             alike in the tables. Showing only the profile's own list would
             report the stock `default` — which every query on the machine runs
             under — as applying to nobody. */
          const held = [...p.apply_to_list, ...p.attached_by_account]
          return (
            <li className="acc__item" key={p.name}>
              <div className="acc__head">
                <span className="acc__name">{p.name}</span>
                <span className="mono-dim">
                  {p.apply_to_all || held.length ? appliesTo({ ...p, apply_to_list: held }) : 'held by nobody'}
                </span>
                {p.storage === 'users_xml' ? (
                  <span className="flag flag--idle">from users.xml</span>
                ) : null}
                {p.inherits.length ? (
                  <span className="mono-dim">built on {p.inherits.join(', ')}</span>
                ) : null}
                {may && p.storage !== 'users_xml' ? (
                  <>
                    <Edit
                      label="profile"
                      form={(close) => (
                        <NewProfile
                          done={close}
                          initial={{
                            name: p.name,
                            to: [...p.apply_to_list, ...p.attached_by_account].join(', '),
                            /* All of them. The statement replaces the profile's
                               settings rather than amending, so a form starting
                               from one of them would drop the rest. */
                            rows: p.settings.map((st) => ({
                              setting: st.setting,
                              value: st.value,
                              min: st.min,
                              max: st.max,
                              fixed: st.writability === 'CONST',
                            })),
                          }}
                        />
                      )}
                    />
                    <Drop what="profile" name={p.name} />
                  </>
                ) : null}
              </div>
              {p.settings.length ? <Settings settings={p.settings} /> : null}
            </li>
          )
        })}
      </Group>

      {report.pinned.items.length ? (
        <Group
          title="Settings pinned to one account"
          section={report.pinned}
          empty=""
          note="Written by ALTER USER … SETTINGS, and part of no profile. A page reading only profiles would say an account runs with the profile's settings while the server runs it with these."
        >
          {report.pinned.items.map((p) => (
            <li className="acc__item" key={`${p.holder}-${p.is_user}`}>
              <div className="acc__head">
                <span className="acc__name">{p.holder}</span>
                <span className="mono-dim">{p.is_user ? 'user' : 'role'}</span>
              </div>
              <Settings settings={p.settings} />
            </li>
          ))}
        </Group>
      ) : null}

      <Group
        title="Row policies"
        make={may ? <NewPolicy done={() => undefined} /> : undefined}
        section={report.policies}
        empty="No row policies — every account sees every row of every table it may read."
      >
        {byTable(report.policies.items).map((g) => (
          <li className="acc__item" key={`${g.database}.${g.table}`}>
            <div className="acc__head">
              <span className="acc__name">
                {g.database}.{g.table}
              </span>
              <span className="mono-dim">narrowed for {narrowed(g).join(', ')}</span>
            </div>
            <ul className="lim__reading">
              {reading(g).map((line, i) => (
                <li key={i}>{line}</li>
              ))}
              {/* The half of row policies most likely to be got wrong: a table
                  with a policy on it is not a protected table. It is protected
                  for the accounts the policies name, and for nobody else. */}
              <li className="lim__else">Everybody else sees every row.</li>
            </ul>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Policy</th>
                  <th>Kind</th>
                  <th>Applies to</th>
                  <th>USING</th>
                  {may ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {[...g.permissive, ...g.restrictive].map((p) => (
                  <tr key={p.name}>
                    <td className="tbl__key">{p.short_name}</td>
                    <td>
                      {p.restrictive ? (
                        <span className="flag flag--error">restrictive</span>
                      ) : (
                        <span className="flag flag--idle">permissive</span>
                      )}
                    </td>
                    <td className="mono-dim">
                      {appliesTo(p)}
                      {appliesToNobody(p) ? (
                        <span className="says">it narrows nothing while it names nobody</span>
                      ) : null}
                    </td>
                    <td className="mono-dim">{p.filter}</td>
                    {may ? (
                      <td className="tbl--n">
                        <Edit
                          label="policy"
                          form={(close) => (
                            <NewPolicy
                              done={close}
                              initial={{
                                name: p.short_name,
                                database: p.database,
                                table: p.table,
                                filter: p.filter,
                                to: p.apply_to_list.join(', '),
                                restrictive: p.restrictive,
                              }}
                            />
                          )}
                        />
                        <Drop
                          what="policy"
                          name={p.short_name}
                          database={p.database}
                          table={p.table}
                        />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </li>
        ))}
      </Group>
    </>
  )
}

/** One section, with its own way of being empty.
 *
 *  A list that nobody may read and a list with nothing in it are different
 *  facts, and the first must not be drawn as the second. */
function Group<T>({
  title,
  section,
  empty,
  note,
  make,
  children,
}: {
  title: string
  section: Section<T>
  empty: string
  note?: string
  /* A form for making one of these, opened from the heading. Held here rather
     than in the caller so the toggle and the list stay together, and so only one
     family's form can be open at a time within its own group. */
  make?: React.ReactNode
  children: React.ReactNode
}) {
  const [making, setMaking] = React.useState(false)
  return (
    <>
      <h3 className="acc__group">
        {title}
        {make ? (
          <button
            className={`btn${making ? ' is-on' : ''}`}
            aria-expanded={making}
            onClick={() => setMaking(!making)}
          >
            {making ? 'Never mind' : 'New'}
          </button>
        ) : null}
      </h3>
      {making && make ? make : null}
      {note ? <p className="diag__quiet">{note}</p> : null}
      {section.blocked ? (
        <EmptyNote title="Not visible to this user">{section.blocked}</EmptyNote>
      ) : section.items.length === 0 ? (
        <p className="diag__quiet">{empty}</p>
      ) : (
        <ul className="acc">{children}</ul>
      )}
    </>
  )
}

function Settings({ settings }: { settings: ProfileSetting[] }) {
  return (
    <table className="tbl acc__grants">
      <thead>
        <tr>
          <th>Setting</th>
          <th className="tbl--n">Value</th>
          <th>Bounds</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {settings.map((s) => (
          <tr key={s.setting}>
            <td className="tbl__key">{s.setting}</td>
            <td className="tbl--n mono-dim">{s.value}</td>
            {/* Dropped rather than dashed: most settings have no floor and no
                ceiling, and a column of em-dashes says Flint asked the wrong
                question of every row. */}
            <td className="mono-dim">
              {s.min && s.max ? `${s.min} to ${s.max}` : s.min ? `at least ${s.min}` : s.max ? `at most ${s.max}` : ''}
            </td>
            <td>
              {s.writability === 'CONST' ? (
                <span className="flag flag--idle">fixed — cannot be changed</span>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** The ceilings of one interval, and what has been spent against them.
 *
 *  One row per account the quota counts separately: a quota keyed by user name
 *  has a set of counters per user, and summing them would report a ceiling
 *  nobody is actually near as nearly full. */
function Ceilings({
  ceilings,
  usage,
  scope,
  blocked,
}: {
  ceilings: Ceiling[]
  usage: ReturnType<typeof usageFor>
  scope: 'everyone' | 'you'
  blocked?: string
}) {
  const { shown, hidden } = closestToCeiling(usage, 6)
  return (
    <>
      <table className="tbl">
        <thead>
          <tr>
            <th>Caps</th>
            <th className="tbl--n">Ceiling</th>
            {shown.map((u) => (
              <th className="tbl--n" key={u.quota_key}>
                {u.quota_key || 'everyone'}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ceilings.map((c) => (
            <tr key={c.dimension}>
              <td className="tbl__key">{c.dimension}</td>
              <td className="tbl--n mono-dim">{figure(c.max, c.unit)}</td>
              {shown.map((u) => {
                const spent = u.ceilings.find((x) => x.dimension === c.dimension)
                return (
                  <td className="tbl--n" key={u.quota_key}>
                    {spent ? <Gauge c={spent} /> : null}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {hidden ? (
        <p className="diag__quiet">
          The {shown.length} nearest their ceiling, of {usage.length} accounts this quota counts
          separately.
        </p>
      ) : null}
      {blocked ? (
        <p className="diag__quiet">
          The ceilings are readable and the consumption is not: {blocked}
        </p>
      ) : scope === 'you' ? (
        /* Whose figures these are has to be on the screen. A quota that looks
           unused because *you* have not used it is a dangerous thing to
           conclude about a server other people are querying. */
        <p className="diag__quiet">
          These are your own figures. Reading everybody&apos;s needs SHOW QUOTAS, which this user
          does not have.
        </p>
      ) : null}
    </>
  )
}

function Gauge({ c }: { c: Ceiling }) {
  const band = pressure(c)
  const f = fullness(c)
  if (band === null || f === null) return null
  return (
    <span className="gauge" title={`${figure(c.used ?? 0, c.unit)} of ${figure(c.max, c.unit)}`}>
      <span className="gauge__value">{figure(c.used ?? 0, c.unit)}</span>
      <span className="gauge__track">
        {/* `max(2px, …)` because five queries against a thousand is half a
            percent, which rounds to nothing and draws as an empty bar — and an
            empty bar says none rather than some. Zero keeps no fill at all, so
            the sliver still means "not zero". */}
        <span
          className={`gauge__fill gauge__fill--${band}`}
          style={{ width: f > 0 ? `max(2px, ${f * 100}%)` : 0 }}
        />
      </span>
    </span>
  )
}

function figure(n: number, unit: Ceiling['unit']): string {
  if (unit === 'bytes') return bytes(n)
  if (unit === 'seconds') return duration(n)
  return count(n)
}

/** One control that opens an editing form beside the thing it edits.
 *
 *  Its own component so the open/closed state belongs to the row rather than to
 *  the page: two rows of the same family would otherwise share one flag and open
 *  together. */
function Edit({
  label,
  form,
}: {
  label: string
  form: (close: () => void) => React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <button
        className={`btn${open ? ' is-on' : ''}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Change
      </button>
      {open ? <span className="says">changing this {label} in place</span> : null}
      {open ? form(() => setOpen(false)) : null}
    </>
  )
}
