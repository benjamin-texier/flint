import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useEffect, useMemo, useState } from 'react'

import { api } from '../lib/api'
import { bytes as fmtBytes, count, relativeTime } from '../lib/format'
import {
  AREAS,
  clearBackups,
  clearCold,
  clearDetached,
  clearQueries,
  clearSpend,
  clearStorage,
  clearTraffic,
  clearTwins,
  inAreaCleared,
  fromBackups,
  fromDetached,
  fromHeavy,
  fromCold,
  fromQueries,
  fromSpend,
  fromStorage,
  fromTraffic,
  fromTwins,
  SESSION_KEY,
  inArea,
  saysReport,
  saysSession,
  sessionWindow,
  type Area,
  type Cleared,
  type Finding,
  type Gain,
} from '../lib/checkup'
import {
  index as answerIndex,
  saysAway,
  saysStanding,
  split,
  standingOf,
  type Answer,
  type Standing,
} from '../lib/answers'
import { keeps } from '../lib/spaces'
import { ClearedList } from '../components/ClearedList'
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

  /* The mark, and nothing else. A session is a moment the browser remembers
     and a window computed from it — there is no session object anywhere,
     which is what lets this work on a Flint with no workspace.

     It lives in `localStorage` because leaving the tab is the whole point: you
     start it, go and put your application through its paces, and come back.
     A reload in between must not lose the mark. Wrapped, because the accessor
     itself throws in a private window and in a browser set to block site
     data, and a checkup that will not open because of that is worse than one
     with no session. */
  const [startedAt, setStartedAt] = useState<number | null>(() => {
    try {
      const raw = localStorage.getItem(SESSION_KEY)
      const at = raw === null ? NaN : Number(raw)
      return Number.isFinite(at) ? at : null
    } catch {
      return null
    }
  })
  /* Re-rendered once a second while a session runs, so "4 minutes" is not a
     figure that was true when the page loaded. Only while it runs: a page
     with nothing happening on it should not be waking up every second. */
  const [, tick] = useState(0)
  useEffect(() => {
    if (startedAt === null) return
    const timer = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [startedAt])

  const mark = (at: number | null) => {
    setStartedAt(at)
    try {
      if (at === null) localStorage.removeItem(SESSION_KEY)
      else localStorage.setItem(SESSION_KEY, String(at))
    } catch {
      /* A browser that will not store it still runs the session — the mark is
         held in state, and only surviving a reload is lost. Said nowhere,
         because the reader finds out by reloading and there is nothing they
         could do about it. */
    }
  }

  /* What has already been said about these findings.
     
     Only where Flint keeps anything: answering is reader state, and a
     stateless Flint has nowhere to put it. The page then shows no controls
     rather than controls that fail — the same rule the Data board follows for
     alerts and reports. */
  const config = useQuery({ queryKey: ['config'], queryFn: () => api.config() })
  const stateful = keeps(config.data)
  const answers = useQuery({
    queryKey: ['checkup', 'answers'],
    queryFn: () => api.answers(),
    enabled: stateful,
    retry: false,
  })
  const client = useQueryClient()
  const answer = useMutation({
    mutationFn: api.answerFinding,
    /* Refetched rather than patched in place. The count of how many times a
       finding has been answered is the server's, and a row that drew its own
       optimistic version of it would show a number the next load corrects. */
    onSuccess: () => client.invalidateQueries({ queryKey: ['checkup', 'answers'] }),
  })

  /* Each of these is a reading the backend already produces. The checkup does
     not measure anything of its own — it judges, and the judging is in
     `lib/checkup` where it can be argued with in a test. */
  const storage = useQuery({ queryKey: ['diag', 'storage'], queryFn: api.diagnoseStorage })
  const detached = useQuery({ queryKey: ['parts', 'detached'], queryFn: api.detachedParts })
  const backups = useQuery({ queryKey: ['backups'], queryFn: api.backups })
  const databases = useQuery({ queryKey: ['databases'], queryFn: api.databases })
  /* Not behind the workload button: it reads no log. Which is the whole reason
     it is worth having — on a server whose query log this role may not touch, it
     is the only substantial thing this page can still say. */
  const twins = useQuery({ queryKey: ['diag', 'twins'], queryFn: () => api.twins() })

  /* The workload, behind its own button. `system.query_log` on a busy server
     is the most expensive thing this page can ask for, and on a server whose
     log has just rolled it answers nothing — so it is asked for deliberately
     and its absence is said rather than shown as an empty section. */
  /* The window is fixed at the moment of reading, not held live: a query key
     carrying a number that changes every second would refetch every second.
     `read` is what was asked for, and it is only ever set by a button. */
  const [read, setRead] = useState<{ seconds?: number } | null>(null)
  const queries = useQuery({
    queryKey: ['diag', 'queries', read?.seconds ?? 7],
    queryFn: () => api.diagnoseQueries(7, read?.seconds),
    enabled: read !== null,
  })
  const traffic = useQuery({
    queryKey: ['diag', 'traffic', read?.seconds ?? 7],
    queryFn: () => api.diagnoseTraffic(7, read?.seconds),
    enabled: read !== null,
  })
  /* Behind the same button as the two above, and for the same reason: it reads
     `system.query_log` too. Its window is always the seven days — a session of
     ten minutes cannot tell anybody what nothing reads, which `lib/cold`
     refuses to claim anyway, and asking for it would spend a scan to be told
     so. */
  const cold = useQuery({
    queryKey: ['diag', 'cold', 7],
    queryFn: () => api.cold({ days: 7 }),
    enabled: read !== null,
  })
  /* Behind the same button, and always over the seven days for the same reason
     the cold reading is: who spends a ten-minute session is a question about
     ten minutes, which `lib/spend` refuses to answer anyway. */
  const spend = useQuery({
    queryKey: ['diag', 'spend', 7],
    queryFn: () => api.spend(7),
    enabled: read !== null,
  })
  /* Behind the same button, and it is the one that changes a *finding* rather
     than adding one: `system.backups` records this server's own `BACKUP`
     statement and nothing else, so a server backed up by clickhouse-backup — or
     by a volume snapshot, or by a replica in another rack — reads as a server
     with no backups. The freeze those tools leave in the query log is the only
     trace SQL has of them. Until the button is pressed the finding says so in as
     many words, rather than quietly asserting the larger claim. */
  const elsewhere = useQuery({
    queryKey: ['backups', 'elsewhere', 7],
    queryFn: () => api.backupsElsewhere(7),
    enabled: read !== null,
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

  const readings = [storage, detached, backups, heavy, twins]
  const stillReading = readings.filter((r) => r.isPending || r.isFetching).length

  const findings: Finding[] = useMemo(
    () => [
      ...(storage.data ? fromStorage(storage.data) : []),
      ...(detached.data ? fromDetached(detached.data) : []),
      ...(backups.data ? fromBackups(backups.data, elsewhere.data) : []),
      ...(heavy.data ? fromHeavy(heavy.data) : []),
      ...(queries.data ? fromQueries(queries.data) : []),
      ...(traffic.data ? fromTraffic(traffic.data) : []),
      ...(cold.data ? fromCold(cold.data) : []),
      ...(spend.data ? fromSpend(spend.data) : []),
      ...(twins.data ? fromTwins(twins.data) : []),
    ],
    [
      storage.data,
      detached.data,
      backups.data,
      elsewhere.data,
      heavy.data,
      queries.data,
      traffic.data,
      cold.data,
      spend.data,
      twins.data,
    ],
  )

  /* What came back clear, from the same readings the findings come from. Built
     here rather than derived from `findings.length === 0`, because "no finding
     in this area" and "these five checks passed" are different claims and only
     the second one is worth printing: see `Cleared`. */
  const cleared: Cleared[] = useMemo(
    () => [
      ...(storage.data ? clearStorage(storage.data) : []),
      ...(detached.data ? clearDetached(detached.data) : []),
      ...(backups.data ? clearBackups(backups.data, elsewhere.data) : []),
      ...(twins.data ? clearTwins(twins.data) : []),
      ...(queries.data ? clearQueries(queries.data) : []),
      ...(traffic.data ? clearTraffic(traffic.data) : []),
      ...(cold.data ? clearCold(cold.data) : []),
      ...(spend.data ? clearSpend(spend.data) : []),
    ],
    [
      storage.data,
      detached.data,
      backups.data,
      elsewhere.data,
      twins.data,
      queries.data,
      traffic.data,
      cold.data,
      spend.data,
    ],
  )

  const answered = useMemo(() => answerIndex(answers.data), [answers.data])
  const listed = useMemo(() => split(findings, answered).open, [findings, answered])
  const workloadAsked = read !== null
  const workloadPending =
    queries.isFetching || traffic.isFetching || cold.isFetching || spend.isFetching

  return (
    <article className="page page--checkup">
      <header className="page__head">
        <p className="eyebrow">Checkup</p>
        <h1 className="page__title page__title--hero">What to change</h1>
        {/* Counted over what the page actually lists. A headline saying seven
            above a list of six is the defect this codebase calls out in every
            other cap: the count follows the list, and what was put away is
            counted where it was put away. */}
        <p className="page__sub">{saysReport(listed, stillReading)}</p>
      </header>

      <div className="checkup__asks">
        <button
          className="btn"
          disabled={workloadPending}
          onClick={() => setRead({})}
        >
          {workloadPending && !read?.seconds ? 'Reading the log…' : 'Read the last 7 days'}
        </button>
        {/* Said beside the button rather than after pressing it: the cost is
            the reason it is a button, so the reason belongs where the decision
            is made. */}
        <span className="says">
          Scans <code>system.query_log</code> — what failed, what cost the most, and what nothing
          has read.
        </span>
      </div>

      {/* The session. Mark a moment, go and put the application through its
          paces, come back. A QA pass puts hundreds of statements through a
          server in ten minutes and a seven-day window buries every one. */}
      <div className="checkup__session">
        {startedAt === null ? (
          <>
            <button className="btn" onClick={() => mark(Date.now())}>
              Start watching
            </button>
            <span className="says">
              Marks this moment. Go and use the application, then come back and read only what
              happened in between.
            </span>
          </>
        ) : (
          <>
            <button
              className="btn btn--spark"
              disabled={workloadPending}
              onClick={() => setRead({ seconds: sessionWindow(startedAt) ?? 60 })}
            >
              Read these {saysSession(startedAt)}
            </button>
            <button className="btn" onClick={() => mark(null)}>
              Forget the mark
            </button>
            <span className="says checkup__watching">
              Watching since {new Date(startedAt).toLocaleTimeString()}. Nothing is being recorded —
              the server's own log is, and this is only the moment to read it from.
            </span>
          </>
        )}
      </div>

      {/* One error line per reading that could not answer, and the page carries
          on. A checkup that went blank because one grant was missing would be
          worse than one that says which grant. */}
      {readings.map((r, i) =>
        r.error ? <ErrorNote key={i} error={r.error} retry={() => void r.refetch()} /> : null,
      )}
      {queries.error ? <ErrorNote error={queries.error} retry={() => void queries.refetch()} /> : null}

      {/* Which window the workload findings are of. On a page that can show
          two different spans of the same log, leaving this to be remembered
          is how somebody reads a ten-minute session as a week. */}
      {queries.data ? (
        <p className="says checkup__window">
          The workload below is {saysWindow(queries.data.window_seconds)} of{' '}
          <code>system.query_log</code>.
        </p>
      ) : null}

      {answer.error ? <ErrorNote error={answer.error} /> : null}

      {AREAS.map((area) => (
        <AreaSection
          key={area.id}
          area={area}
          findings={inArea(findings, area.id)}
          cleared={inAreaCleared(cleared, area.id)}
          waiting={waitingFor(area.id, { stillReading, workloadAsked, workloadPending })}
          answers={answered}
          onAnswer={stateful ? (body) => answer.mutate(body) : undefined}
          answering={answer.isPending ? (answer.variables?.finding ?? null) : null}
        />
      ))}
    </article>
  )
}

/** The window a reading covered, in the unit that suits its size.
 *
 *  From seconds and never from `window_days`, which is zero for a session and
 *  would print "the last 0 days" over the reading somebody just asked for. */
export function saysWindow(seconds: number): string {
  if (seconds < 90) return `the last ${seconds} seconds`
  if (seconds < 5400) return `the last ${Math.round(seconds / 60)} minutes`
  if (seconds < 172800) return `the last ${Math.round(seconds / 3600)} hours`
  return `the last ${Math.round(seconds / 86400)} days`
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

/** What a row can be answered with, as the page hands it down. */
export type Answering = (body: {
  finding: string
  state: 'dismissed' | 'accepted' | 'reopened'
  note?: string
  area?: string
  object?: string
  title?: string
  gain_kind?: string
  gain_n?: number
}) => void

function AreaSection({
  area,
  findings,
  cleared,
  waiting,
  answers,
  onAnswer,
  answering,
}: {
  area: (typeof AREAS)[number]
  findings: Finding[]
  /** The checks in this area that ran and came back clear. Shown *with* the
   *  findings rather than instead of them: an area with one thing to change and
   *  four things that are fine is telling the reader both, and hiding the four
   *  is what made a healthy page look like a broken one. */
  cleared: Cleared[]
  waiting: string | null
  answers: Map<string, Answer>
  /** Absent on a stateless Flint, where there is nowhere to keep an answer.
   *  The rows then draw no controls rather than controls that fail. */
  onAnswer?: Answering
  /** The finding whose answer is in flight, so its own row can say so. */
  answering: string | null
}) {
  const [showAway, setShowAway] = useState(false)
  const { open, away } = split(findings, answers)
  const put = saysAway(away)
  return (
    <section className="section">
      <h2 className="section__title">{area.label}</h2>
      <p className="says">{area.lead}</p>
      {waiting ? <p className="says checkup__waiting">{waiting}</p> : null}

      {open.length > 0 ? (
        <ul className="checkup__list">
          {open.map((f) => (
            <FindingRow
              key={f.id}
              finding={f}
              standing={standingOf(f, answers.get(f.id))}
              onAnswer={onAnswer}
              busy={answering === f.id}
            />
          ))}
        </ul>
      ) : null}

      {/* Counted, never silently dropped — and a click away, because the
          reader who put them away is the one most likely to want them back. */}
      {put ? (
        <p className="says checkup__putaway">
          <button className="linkish" onClick={() => setShowAway(!showAway)} type="button">
            {showAway ? `Hide the ${put.toLowerCase()}` : put}
          </button>
        </p>
      ) : null}
      {showAway && away.length > 0 ? (
        <ul className="checkup__list checkup__list--away">
          {away.map((f) => (
            <FindingRow
              key={f.id}
              finding={f}
              standing={standingOf(f, answers.get(f.id))}
              onAnswer={onAnswer}
              busy={answering === f.id}
            />
          ))}
        </ul>
      ) : null}

      <ClearedList cleared={cleared} also={open.length > 0} />

      {/* Neither a finding nor a clearance, and not waiting either: every
          reading this area is made of came back unreadable. Said rather than
          left blank — a section with nothing in it has told the reader that
          everything is fine, which is the one thing it does not know. */}
      {!waiting && findings.length === 0 && cleared.length === 0 ? (
        <p className="says">
          Nothing here could be read on this server, so nothing here speaks for it.
        </p>
      ) : null}
    </section>
  )
}

/** One finding, drawn the way this page draws it.
 *
 *  Exported because the arrival board shows the same findings, and two
 *  renderings of one `Finding` would drift — the day somebody adds a field
 *  here, the home stops showing it and nobody notices, because both pages still
 *  look finished. */
export function FindingRow({
  finding,
  standing,
  onAnswer,
  busy,
}: {
  finding: Finding
  /** Where it stands. Absent on the arrival board, which lists findings and
   *  does not answer them — it is a page that reports and links, and answering
   *  is an act. */
  standing?: Standing
  onAnswer?: Answering
  busy?: boolean
}) {
  /* The note is asked for rather than assumed. A dismissal with no reason is
     the one that somebody else finds six weeks later and cannot evaluate —
     "kept on purpose for the audit" is what makes the row worth keeping, and
     it is the difference between a hide button and an answer. Empty is still
     allowed: a reader who will not explain themselves should not be stopped
     from putting away something they know is fine. */
  const [asking, setAsking] = useState<'dismissed' | 'accepted' | null>(null)
  const [note, setNote] = useState('')
  const [showing, setShowing] = useState(false)
  const mark = standing ? saysStanding(standing) : null

  const send = (state: 'dismissed' | 'accepted' | 'reopened', text = '') => {
    onAnswer?.({
      finding: finding.id,
      state,
      note: text,
      area: finding.area,
      object: finding.object ?? '',
      title: finding.title,
      /* The worth travels with the answer, and it is what the re-evaluation
         compares against later. A dismissal is a judgement about a figure,
         not about an id. */
      gain_kind: finding.gain.kind,
      gain_n: finding.gain.kind === 'none' ? 0 : finding.gain.n,
    })
    setAsking(null)
    setNote('')
  }

  return (
    <li
      className={`checkup__row checkup__row--${finding.urgency}${
        standing && standing.kind !== 'open' ? ` checkup__row--${standing.kind}` : ''
      }`}
    >
      <div className="checkup__head">
        <span className="checkup__title">{finding.title}</span>
        {/* The unit is part of the figure and never dropped: "4.2 GB" and
            "4.2 s" are the two answers this page must never let a reader
            confuse, and a bare 4.2 would. */}
        <Worth gain={finding.gain} />
      </div>
      <p className="says checkup__why">{finding.why}</p>
      <p className="says checkup__evidence">{finding.evidence}</p>
      {/* What was said about it, and when. A stale dismissal says both figures
          here — it is back on the page precisely because they differ. */}
      {mark ? (
        <p className={`says checkup__mark checkup__mark--${standing?.kind}`}>
          {mark}
          {standing && standing.kind !== 'open' ? (
            <span className="checkup__markwhen">
              {' '}
              · {relativeTime(standing.answer.at)}
              {/* Above one, somebody has changed their mind about this before
                  — which is the whole reason the table is a log — and the
                  count is a way in rather than a fact on its own. */}
              {standing.answer.times > 1 ? (
                <>
                  {' · '}
                  <button className="linkish" onClick={() => setShowing(!showing)} type="button">
                    {showing ? 'hide what was said' : `answered ${standing.answer.times} times`}
                  </button>
                </>
              ) : null}
            </span>
          ) : null}
        </p>
      ) : null}
      {showing ? <History finding={finding.id} /> : null}
      <div className="checkup__acts">
        {finding.act ? (
          <Link className="link checkup__act" to={finding.act.to}>
            {finding.act.label} →
          </Link>
        ) : null}
        {onAnswer && asking === null ? (
          /* A reopened finding is an open one again, so it is offered the same
             two answers rather than an Undo for an undo. */
          standing && (standing.kind === 'away' || standing.kind === 'accepted' || standing.kind === 'stale') ? (
            <button className="linkish" disabled={busy} onClick={() => send('reopened')} type="button">
              {busy ? 'Reopening…' : 'Reopen'}
            </button>
          ) : (
            <>
              <button className="linkish" disabled={busy} onClick={() => setAsking('dismissed')} type="button">
                Put away
              </button>
              <button className="linkish" disabled={busy} onClick={() => setAsking('accepted')} type="button">
                Accept
              </button>
            </>
          )
        ) : null}
      </div>
      {asking ? (
        <form
          className="checkup__answer"
          onSubmit={(e) => {
            e.preventDefault()
            send(asking, note.trim())
          }}
        >
          <input
            className="input bfield bfield--sm"
            autoFocus
            value={note}
            placeholder={asking === 'dismissed' ? 'why this is fine here (optional)' : 'what you will do (optional)'}
            aria-label={asking === 'dismissed' ? 'Why this finding is fine here' : 'What you will do about this finding'}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              // Escape leaves without answering, which is the contract every
              // other dismissible thing in this product keeps.
              if (e.key === 'Escape') {
                e.stopPropagation()
                setAsking(null)
                setNote('')
              }
            }}
          />
          <button className="btn btn--soft" type="submit" disabled={busy}>
            {asking === 'dismissed' ? 'Put it away' : 'Accept it'}
          </button>
          <button className="linkish" type="button" onClick={() => setAsking(null)}>
            Cancel
          </button>
        </form>
      ) : null}
    </li>
  )
}

/** Everything ever said about one finding.
 *
 *  Asked for only when somebody opens it, and only ever for the one row: a
 *  page that fetched every finding's history to show a count nobody clicked
 *  would spend a request per row to answer a question nobody asked. Each
 *  entry keeps the *words the finding had then* — it is recomputed on every
 *  visit, so a row reading "dismissed `schema:cold:orders`" would be a record
 *  nobody can act on six weeks later. */
function History({ finding }: { finding: string }) {
  const past = useQuery({
    queryKey: ['checkup', 'answers', 'history', finding],
    queryFn: () => api.answerHistory(finding),
    retry: false,
  })
  if (past.isPending) return <p className="says checkup__markwhen">Reading what was said…</p>
  if (past.error) return <ErrorNote error={past.error} retry={() => void past.refetch()} />
  return (
    <ol className="checkup__history">
      {(past.data ?? []).map((a) => (
        <li className="checkup__past" key={`${a.at}-${a.state}`}>
          <span className="checkup__paststate">{a.state}</span>
          <span className="checkup__pastwho">{a.who}</span>
          {/* To the second. The milliseconds are in the row because two
              answers can land in one second and the order matters; printed,
              they are three digits of noise on every line. */}
          <span className="checkup__pastwhen">{a.at.slice(0, 19)}</span>
          {a.note ? <span className="checkup__pastnote">{a.note}</span> : null}
          {/* What it claimed at the time, which is the half a recomputed
              finding cannot tell you. Dropped where a version that did not
              record it wrote the row, rather than printed as a zero. */}
          {a.title && a.title !== '' ? <span className="checkup__pastsaid">{a.title}</span> : null}
        </li>
      ))}
      {/* Whose clock, said once rather than per row. The audit page learned
          this the hard way: an unlabelled naive timestamp is read as the
          reader's own, and here that would date somebody's decision to the
          wrong afternoon. */}
      {(past.data ?? []).length > 0 ? (
        <li className="checkup__past checkup__pastnote">By the server's clock.</li>
      ) : null}
    </ol>
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
