import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useMemo } from 'react'

import { api } from '../lib/api'
import { bytes as fmtBytes, count } from '../lib/format'
import {
  AREAS,
  fromBackups,
  fromDetached,
  fromHeavy,
  fromQueries,
  fromStorage,
  fromTraffic,
  inArea,
  saysReport,
  type Area,
  type Finding,
  type Gain,
} from '../lib/checkup'
import { ErrorNote } from '../components/Note'

/** One page that answers "what do I have to do".
 *
 *  Flint had a great deal of analysis and no way to be asked. The schema
 *  review is per table, the projection advisor is per table, the storage
 *  reading is per disk — every one of them answers well, to somebody who
 *  already knew to go and look. This is the page for somebody who does not.
 *
 *  Three things shape it.
 *
 *  **It starts on its own, and reports as it lands.** Every reading is its own
 *  request, and each contributes findings the moment it answers. A page that
 *  waited for the slowest of eight would be a page nobody leaves open, and one
 *  section being denied or slow must not take the other seven down — the same
 *  rule the Infrastructure board already keeps.
 *
 *  **The expensive readings are buttons, not defaults.** Two of them cost
 *  real work: measuring a schema samples the rows, and reading the workload
 *  scans `system.query_log`. The roadmap's own line about the database-wide
 *  review is that spending that before anybody asked is not a courtesy, and
 *  that holds here more than anywhere — this page is the one somebody points
 *  at production.
 *
 *  **There is no score.** See `lib/checkup`: a finding carries what acting
 *  gives back in its own unit, and nothing adds a gigabyte to a second. */
export function CheckupPage() {
  const config = useQuery({ queryKey: ['config'], queryFn: api.config })

  /* Each of these is a reading the backend already produces. The checkup does
     not measure anything of its own — it judges, and the judging is in
     `lib/checkup` where it can be argued with in a test. */
  const storage = useQuery({ queryKey: ['diag', 'storage'], queryFn: api.diagnoseStorage })
  const detached = useQuery({ queryKey: ['parts', 'detached'], queryFn: api.detachedParts })
  const backups = useQuery({ queryKey: ['backups'], queryFn: api.backups })
  const databases = useQuery({ queryKey: ['databases'], queryFn: api.databases })

  /* The workload, behind its own button. `system.query_log` on a busy server
     is the most expensive thing this page can ask for, and on a server whose
     log has just rolled it answers nothing — so it is asked for deliberately
     and its absence is said rather than shown as an empty section. */
  const queries = useQuery({
    queryKey: ['diag', 'queries', 7],
    queryFn: () => api.diagnoseQueries(7),
    enabled: false,
  })
  const traffic = useQuery({
    queryKey: ['diag', 'traffic', 7],
    queryFn: () => api.diagnoseTraffic(7),
    enabled: false,
  })

  /* Where the bytes are, per database. Metadata only — no sampling — which is
     what lets it run on open. It proposes nothing; the review does that, and
     the review reads the values. */
  const names = (databases.data ?? [])
    .filter((d) => d.name !== 'system' && d.name !== 'INFORMATION_SCHEMA' && d.name !== 'information_schema')
    .map((d) => d.name)
  const heavy = useQuery({
    queryKey: ['checkup', 'heavy', names],
    queryFn: () => Promise.all(names.map((n) => api.heavy(n, 40))),
    enabled: names.length > 0,
  })

  const readings = [storage, detached, backups, heavy]
  const stillReading = readings.filter((r) => r.isPending || r.isFetching).length

  const findings: Finding[] = useMemo(
    () => [
      ...(storage.data ? fromStorage(storage.data) : []),
      ...(detached.data ? fromDetached(detached.data) : []),
      ...(backups.data ? fromBackups(backups.data) : []),
      ...(heavy.data ? fromHeavy(heavy.data) : []),
      ...(queries.data ? fromQueries(queries.data) : []),
      ...(traffic.data ? fromTraffic(traffic.data) : []),
    ],
    [storage.data, detached.data, backups.data, heavy.data, queries.data, traffic.data],
  )

  const workloadAsked = queries.fetchStatus !== 'idle' || queries.isFetched
  const workloadPending = queries.isFetching || traffic.isFetching

  return (
    <article className="page page--checkup">
      <header className="page__head">
        <p className="eyebrow">Checkup</p>
        <h1 className="page__title page__title--hero">What to change</h1>
        <p className="page__sub">{saysReport(findings, stillReading)}</p>
      </header>

      <div className="checkup__asks">
        <button
          className="btn"
          disabled={workloadPending}
          onClick={() => {
            void queries.refetch()
            void traffic.refetch()
          }}
        >
          {workloadPending ? 'Reading the log…' : 'Read the workload'}
        </button>
        {/* Said beside the button rather than after pressing it: the cost is
            the reason it is a button, so the reason belongs where the decision
            is made. */}
        <span className="says">
          Scans <code>system.query_log</code> over the last 7 days — what failed, what cost the
          most, and what nothing has read.
        </span>
      </div>

      {/* One error line per reading that could not answer, and the page carries
          on. A checkup that went blank because one grant was missing would be
          worse than one that says which grant. */}
      {readings.map((r, i) =>
        r.error ? <ErrorNote key={i} error={r.error} retry={() => void r.refetch()} /> : null,
      )}
      {queries.error ? <ErrorNote error={queries.error} retry={() => void queries.refetch()} /> : null}

      {AREAS.map((area) => (
        <AreaSection
          key={area.id}
          area={area}
          findings={inArea(findings, area.id)}
          waiting={waitingFor(area.id, { stillReading, workloadAsked, workloadPending })}
          workspace={Boolean(config.data?.workspace)}
        />
      ))}
    </article>
  )
}

/** What a section says while it has nothing yet — which is not the same
 *  sentence as having nothing to say. An empty section that looks finished is
 *  a section that has told the reader everything is fine. */
function waitingFor(
  area: Area,
  s: { stillReading: number; workloadAsked: boolean; workloadPending: boolean },
): string | null {
  if (area === 'queries') {
    if (s.workloadPending) return 'Reading the query log.'
    if (!s.workloadAsked) return 'Not read yet — the workload is behind the button above.'
    return null
  }
  return s.stillReading > 0 ? 'Still reading.' : null
}

function AreaSection({
  area,
  findings,
  waiting,
  workspace,
}: {
  area: (typeof AREAS)[number]
  findings: Finding[]
  waiting: string | null
  workspace: boolean
}) {
  return (
    <section className="section">
      <h2 className="section__title">{area.label}</h2>
      <p className="says">{area.lead}</p>
      {waiting ? (
        <p className="says checkup__waiting">{waiting}</p>
      ) : findings.length === 0 ? (
        <p className="says">Nothing here is asking to be changed.</p>
      ) : (
        <ul className="checkup__list">
          {findings.map((f) => (
            <FindingRow key={f.id} finding={f} />
          ))}
        </ul>
      )}
      {area.id === 'schema' && !workspace ? null : null}
    </section>
  )
}

function FindingRow({ finding }: { finding: Finding }) {
  return (
    <li className={`checkup__row checkup__row--${finding.urgency}`}>
      <div className="checkup__head">
        <span className="checkup__title">{finding.title}</span>
        {/* The unit is part of the figure and never dropped: "4.2 GB" and
            "4.2 s" are the two answers this page must never let a reader
            confuse, and a bare 4.2 would. */}
        <Worth gain={finding.gain} />
      </div>
      <p className="says checkup__why">{finding.why}</p>
      <p className="says checkup__evidence">{finding.evidence}</p>
      {finding.act ? (
        <Link className="link checkup__act" to={finding.act.to}>
          {finding.act.label} →
        </Link>
      ) : null}
    </li>
  )
}

/** What acting gives back.
 *
 *  A finding with no quantity prints nothing rather than a dash or a zero: an
 *  absent figure is dropped, and printing `0` beside a backup that has never
 *  been taken would say acting on it is worth nothing. */
function Worth({ gain }: { gain: Gain }) {
  if (gain.kind === 'none') return null
  const said =
    gain.kind === 'bytes'
      ? fmtBytes(gain.n)
      : gain.kind === 'seconds'
        ? `${gain.n < 1 ? gain.n.toFixed(2) : Math.round(gain.n)} s`
        : count(gain.n)
  return (
    <span className={`checkup__worth checkup__worth--${gain.kind}`}>
      {said}
      <span className="checkup__worthlabel">
        {gain.kind === 'bytes' ? 'on disk' : gain.kind === 'seconds' ? 'of query time' : 'rows'}
      </span>
    </span>
  )
}
