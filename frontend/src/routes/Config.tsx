import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { EmptyNote, ErrorNote, Loading } from '../components/Note'
import { api } from '../lib/api'
import { count } from '../lib/format'
import {
  hiding,
  matching,
  restartNote,
  saysBuild,
  saysFeatures,
  split,
  whoSet,
  type BuildReport,
  type ServerSetting,
  type SessionSetting,
  type SettingsReport,
  type SystemCommand,
} from '../lib/settings'
import { allows } from '../lib/spaces'

/** Infrastructure — Configuration. */
export function ConfigPage() {
  const report = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.settings(),
    staleTime: 30_000,
  })

  return (
    <div className="page page--diagnose">
      <header className="page__head">
        <p className="eyebrow">INFRASTRUCTURE</p>
        <div className="page__titlerow">
          <h1 className="page__title page__title--hero">What this server is running with</h1>
        </div>
      </header>

      {report.isPending ? <Loading label="Reading the configuration" /> : null}
      {report.error ? <ErrorNote error={report.error} retry={() => report.refetch()} /> : null}
      {report.data ? <Body report={report.data} /> : null}
      {/* From the report, because the backend publishes the eight commands with
          the sentence each one warns under. A second copy in this file made the
          Rust compiler call the originals dead — and would eventually have
          warned about something other than what the button does. */}
      {report.data ? <Console commands={report.data.commands} /> : null}
    </div>
  )
}

function Body({ report }: { report: SettingsReport }) {
  const [query, setQuery] = useState('')
  const { says, inert, obsolete } = split(report.server.items)
  const { profile, flints, compat } = whoSet(report.session.items)

  return (
    <>
      {/* Before the settings, because it is the coarser answer to the same
          question: a Debug build or a missing feature explains behaviour that no
          amount of reading the settings will. */}
      <Build report={report.build} />

      <section className="diag">
        <header className="diag__head">
          <h2 className="diag__title">The server&apos;s own configuration</h2>
          <p className="diag__sub">
            From <code>system.server_settings</code> — the effective configuration, rather than
            whichever file somebody believes is deployed. The {count(report.server.items.length)}{' '}
            below are the ones written down, out of {count(report.server_total)} the server has.
            Written down is not the same as different: {count(inert.length)} of them hold exactly
            the value the server would have used anyway.
          </p>
        </header>

        {report.server.blocked ? (
          <EmptyNote title="Not visible to this user">{report.server.blocked}</EmptyNote>
        ) : (
          <>
            <label className="cfg__find">
              <span className="label">FIND</span>
              <input
                className="input cfg__findbox"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="name or value"
                spellCheck={false}
              />
            </label>

            {obsolete.length ? (
              <Group
                title="Obsolete, and set anyway"
                note="The server still parses these and no longer acts on them. Configuration somebody wrote that does nothing — which no amount of reading the file would reveal."
                items={matching(obsolete, query)}
                total={obsolete.length}
              />
            ) : null}
            <Group
              title="Says something"
              note=""
              items={matching(says, query)}
              total={says.length}
            />
            {inert.length ? (
              <Group
                title="Says nothing"
                note="Written down, and identical to the default. Harmless, and half of a long list being inert is why nobody reads the list."
                items={matching(inert, query)}
                total={inert.length}
              />
            ) : null}
          </>
        )}
      </section>

      <section className="diag">
        <header className="diag__head">
          <h2 className="diag__title">What a statement here would run with</h2>
          <p className="diag__sub">
            From <code>system.settings</code>, which is not the same question: it answers for{' '}
            <em>this connection</em> — the signed-in account&apos;s profile, and anything the
            client attached. {count(report.session.items.length)} of{' '}
            {count(report.session_total)} differ from their defaults.
          </p>
        </header>

        {/* Here rather than under the server's configuration, where the first
            version put it: it is a fact about *this connection*, and that
            section is hidden whenever `system.server_settings` is denied —
            which is exactly the limited account most likely to be carrying a
            compatibility profile. */}
        {report.compatibility ? (
          <p className="cfg__loud">
            This connection runs in <code>compatibility</code> mode as{' '}
            <strong>{report.compatibility}</strong> — it deliberately behaves like an older
            ClickHouse, and any surprise about how it behaves should start here.
            {compat.length ? (
              <>
                {' '}
                One line, and {count(compat.length)} of the{' '}
                {count(report.session.items.length)} settings below differ because of it.
              </>
            ) : null}
          </p>
        ) : null}

        {report.session.blocked ? (
          <EmptyNote title="Not visible to this user">{report.session.blocked}</EmptyNote>
        ) : (
          <>
            {profile.length ? (
              <SessionTable
                title="Set for this account"
                note="From the account's settings profile, or pinned onto the account itself."
                items={profile}
              />
            ) : (
              <p className="diag__quiet">
                Nothing is set for this account — every difference below is Flint&apos;s own.
              </p>
            )}
            {compat.length ? (
              /* A count and no table. These are exact — measured by asking the
                 same question again with the line undone — and there are
                 hundreds of them that nobody chose, so listing them buries the
                 handful somebody did. */
              <>
                <h3 className="acc__group">The compatibility line&apos;s doing</h3>
                <p className="diag__quiet">
                  {count(compat.length)} more settings differ, and none of them is a choice
                  anybody made here: <code>compatibility = {report.compatibility}</code> moved all
                  of them at once. Measured rather than assumed — the same question asked again
                  with that one line undone, and these are what stopped differing.
                </p>
              </>
            ) : null}
            {flints.length ? (
              /* Separated because the server cannot tell them apart. A setting
                 that arrived on the request and one that came from a profile
                 reach `system.settings` identically, so the only way to be
                 honest about it is for Flint to say which ones it sent. */
              <SessionTable
                title="Flint's own, on every statement it sends"
                note="Not this server's configuration. Flint attaches a timeout, a row cap and a block size to everything it sends so a wide query returns a usable preview instead of an error — and they show up here indistinguishable from configuration, which is why they are listed apart."
                items={flints}
              />
            ) : null}
          </>
        )}
      </section>
    </>
  )
}

/** Which ClickHouse this actually is.
 *
 *  Quiet on an ordinary server, which is the point: it speaks up on the one that
 *  needs explaining — an unofficial build, a Debug build, a feature compiled
 *  out. The library versions are here rather than in a footnote because
 *  `tzdata` decides what every `DateTime` conversion returns, and a stale one is
 *  wrong without an error. */
function Build({ report }: { report: BuildReport }) {
  const identity = saysBuild(report)
  if (report.blocked) {
    return (
      <section className="diag">
        <header className="diag__head">
          <h2 className="diag__title">Which ClickHouse this is</h2>
        </header>
        <EmptyNote title="Not visible to this user">{report.blocked}</EmptyNote>
      </section>
    )
  }
  if (!identity) return null

  return (
    <section className="diag">
      <header className="diag__head">
        <h2 className="diag__title">Which ClickHouse this is</h2>
        <p className="diag__sub">
          From <code>system.build_options</code>. A version alone is not an identity — two servers
          both reporting {report.version} can be an official release and somebody&apos;s branch,
          and the commit is what tells them apart.
        </p>
      </header>

      {report.verdicts.length ? (
        <div className="cfg__loud">
          {report.verdicts.map((v, i) => (
            <p key={i}>{v}</p>
          ))}
        </div>
      ) : null}

      <p className="acc__line">
        <span className="label">BUILD</span>
        <span className="mono-dim">{identity}</span>
      </p>
      <p className="acc__line">
        <span className="label">COMMIT</span>
        <span className="mono-dim">
          {report.git_hash.slice(0, 12)} on {report.git_branch}, {report.git_date}
        </span>
      </p>
      <p className="acc__line">
        <span className="label">BUILT WITH</span>
        <span className="mono-dim">
          {report.compiler}
          {/* Not trivia: `tzdata` decides what every DateTime conversion
              returns, and a stale one is wrong with no error at all. */}
          {report.tzdata ? ` · tzdata ${report.tzdata}` : ''}
          {report.openssl ? ` · OpenSSL ${report.openssl}` : ''}
        </span>
      </p>
      <p className="diag__quiet">{saysFeatures(report)}</p>
    </section>
  )
}

function Group({
  title,
  note,
  items,
  total,
}: {
  title: string
  note: string
  items: ServerSetting[]
  total: number
}) {
  const held = hiding(items.length, total)
  return (
    <>
      <h3 className="acc__group">{title}</h3>
      {note ? <p className="diag__quiet">{note}</p> : null}
      {held ? <p className="diag__quiet">{held}</p> : null}
      {items.length === 0 ? null : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Setting</th>
              <th>Value</th>
              <th>Default</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.name}>
                <td className="tbl__key" title={s.description}>
                  {s.name}
                </td>
                <td className="mono-dim cfg__value">{s.value}</td>
                {/* Dropped rather than dashed where it is the same: the column
                    exists to show the difference, and repeating the value says
                    the difference is nothing. */}
                <td className="mono-dim cfg__value">{s.value === s.default ? '' : s.default}</td>
                <td>
                  {restartNote(s) ? <span className="says">{restartNote(s)}</span> : null}
                  {s.obsolete ? <span className="flag flag--error">obsolete</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

function SessionTable({
  title,
  note,
  items,
}: {
  title: string
  note: string
  items: SessionSetting[]
}) {
  return (
    <>
      <h3 className="acc__group">{title}</h3>
      <p className="diag__quiet">{note}</p>
      <table className="tbl">
        <thead>
          <tr>
            <th>Setting</th>
            <th>Value</th>
            <th>Default</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {items.map((s) => (
            <tr key={s.name}>
              <td className="tbl__key" title={s.description}>
                {s.name}
              </td>
              <td className="mono-dim cfg__value">{s.value}</td>
              <td className="mono-dim cfg__value">{s.value === s.default ? '' : s.default}</td>
              <td>
                {/* `Production` is the common case and says nothing. The others
                    are ClickHouse's own word for how much it stands behind the
                    setting, and an experimental one turned on is a finding. */}
                {s.tier && s.tier !== 'Production' ? (
                  <span className="flag flag--idle">{s.tier.toLowerCase()}</span>
                ) : null}
                {s.obsolete ? <span className="flag flag--error">obsolete</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

/** The `SYSTEM` statements worth a button.
 *
 *  Every one is instant and none of them destroys data, which is exactly why
 *  each carries the sentence saying what it costs *before* being pressed: a
 *  button that returns immediately and says nothing invites being pressed to see
 *  what happens. */
function Console({ commands }: { commands: SystemCommand[] }) {
  const config = useQuery({ queryKey: ['config'], queryFn: () => api.config() })
  const may = allows(config.data?.tier, 'admin')
  const queryClient = useQueryClient()
  const [chosen, setChosen] = useState<string | null>(null)
  const act = useMutation({
    mutationFn: (command: string) => api.systemAct(command),
    onSuccess: () => {
      setChosen(null)
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
  })

  if (!may) return null
  const picked = commands.find((c) => c.id === chosen)

  return (
    <section className="diag">
      <header className="diag__head">
        <h2 className="diag__title">Operating the server</h2>
        <p className="diag__sub">
          Flint reads configuration and asks the server to reload it. It does not edit the files —
          those belong to whatever deploys them.
        </p>
      </header>
      <div className="cfg__cmds">
        {commands.map((c) => (
          <button
            className={`btn${chosen === c.id ? ' is-on' : ''}`}
            key={c.id}
            aria-expanded={chosen === c.id}
            onClick={() => setChosen(chosen === c.id ? null : c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>
      {picked ? (
        <div className="rbac__panel">
          <p>{picked.costs}</p>
          {!picked.observable ? (
            /* The decision this console needed. `SYSTEM STOP MERGES` leaves no
               flag anywhere — the `Merge` metric reads zero whether merges are
               stopped or idle, verified by stopping them and looking — so a tool
               offering the switch is offering one with nothing to show its
               position. Said, rather than implied away. */
            <p className="says says--wide says--throw">
              The server reports no state for this, so nothing on this page will look different
              afterwards. The job row — who pressed it, and when — is the only record there is.
            </p>
          ) : null}
          <p className="rbac__row">
            <code className="mono-dim">{picked.statement}</code>
            <button className="btn" disabled={act.isPending} onClick={() => act.mutate(picked.id)}>
              {act.isPending ? 'Sending…' : 'Send it'}
            </button>
            <button className="btn" onClick={() => setChosen(null)}>
              Cancel
            </button>
          </p>
          {act.error ? (
            <p className="says says--wide says--throw">
              {act.error instanceof Error ? act.error.message : 'the server refused it'}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
