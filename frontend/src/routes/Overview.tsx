import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import { api } from '../lib/api'
import { bytes, count, exact, relativeTime, uptime } from '../lib/format'
import { diskVerdict, usableFree } from '../lib/diagnose'
import { headline, row, worst, type Reading, type Row } from '../lib/overview'
import { verdictOf } from '../lib/replication'
import { spaceById } from '../lib/spaces'
import { Headlines } from '../components/Headlines'
import { MetricLine } from '../components/MetricLine'
import { ErrorNote } from '../components/Note'

/** Infrastructure — the first page: is anything wrong.
 *
 *  `/infra` used to redirect to Health, which is the right page for working on
 *  the server and the wrong one for finding out whether you need to. This is one
 *  row per section, each with the figure that makes it checkable and a link to
 *  the page that holds the detail.
 *
 *  Every row is its own request. One section being slow, denied or broken leaves
 *  the other seven readable — and says so on its own line rather than taking the
 *  page down. */
/** The window the pipelines section asks for. A week, like the diagram's own
 *  traffic overlay: long enough that a weekly refresh counts, short enough to be
 *  about now. */
const PIPELINE_DAYS = 7

/** And the window the audit row counts over. The same week, so two rows on one
 *  page do not quietly mean different spans. */
const AUDIT_DAYS = 7

export function OverviewPage() {
  const sections = spaceById('infra').sections
  const at = (id: string) => sections.find((s) => s.id === id)!

  const server = useQuery({ queryKey: ['server'], queryFn: api.server })
  const activity = useQuery({
    queryKey: ['diag', 'activity'],
    queryFn: () => api.diagnoseActivity(),
  })
  const replication = useQuery({
    queryKey: ['diag', 'replication'],
    queryFn: () => api.replication(),
  })
  const pipelines = useQuery({
    queryKey: ['diag', 'pipelines'],
    queryFn: () => api.pipelines(PIPELINE_DAYS),
  })
  const detached = useQuery({ queryKey: ['parts', 'detached'], queryFn: () => api.detachedParts() })
  const backups = useQuery({ queryKey: ['backups'], queryFn: () => api.backups() })
  const access = useQuery({ queryKey: ['diag', 'access'], queryFn: () => api.access() })
  const audit = useQuery({
    queryKey: ['diag', 'audit', AUDIT_DAYS],
    queryFn: () => api.audit(AUDIT_DAYS, 200),
  })

  /** react-query's state, in the three words the rules care about. */
  const reading = <T,>(q: {
    data?: T
    error?: unknown
    isPending: boolean
  }): Reading<T & { available?: boolean; reason?: string }> => ({
    data: q.data as T & { available?: boolean; reason?: string },
    failed: q.error ? String((q.error as Error).message ?? q.error) : undefined,
    pending: q.isPending,
  })

  const rows: Row[] = [
    /* The disks are on the activity report rather than the storage one, which
       is a fact about the API and not about the server: `storage` is per table
       and per partition, `activity` is what the machine is doing and what it is
       sitting on. */
    row(at('health'), 'the disks', reading(activity), (a) => {
      const disks = a.disks ?? []
      if (disks.length === 0) return { standing: 'ok' as const, says: 'no disk reported' }
      const verdicts = disks.map(diskVerdict)
      const fullest = disks.reduce((worstDisk, d) =>
        usableFree(d) / Math.max(1, d.total) < usableFree(worstDisk) / Math.max(1, worstDisk.total)
          ? d
          : worstDisk,
      )
      const share = Math.round((usableFree(fullest) / Math.max(1, fullest.total)) * 100)
      return {
        standing: worst(verdicts.map((v) => v.level)),
        says: `${disks.length} ${disks.length === 1 ? 'disk' : 'disks'} · ${bytes(
          usableFree(fullest),
        )} free on ${fullest.name}, ${share}% of it`,
      }
    }),

    row(at('pipelines'), 'the pipelines', reading(pipelines), (p) => {
      const views = p.views ?? []
      const failing = views.filter((v) => v.failures > 0)
      if (!views.length) return { standing: 'ok' as const, says: 'no materialized view here' }
      return failing.length
        ? {
            standing: 'throw' as const,
            says: `${failing.length} of ${views.length} materialized ${
              views.length === 1 ? 'view has' : 'views have'
            } failed a write in the last ${p.window_days} days`,
          }
        : {
            standing: 'ok' as const,
            says: `${views.length} materialized ${
              views.length === 1 ? 'view' : 'views'
            }, none failing`,
          }
    }),

    row(at('cluster'), 'replication', reading(replication), (r) => {
      const replicas = r.replicas ?? []
      if (replicas.length === 0) {
        // Not a cluster is a fact about this server, not a fault in it.
        return { standing: 'ok' as const, says: 'no replicated table on this server' }
      }
      /* Judged by the Clusters page's own verdict rather than by thresholds
         invented here: two views of one fact that disagreed would be worse than
         either alone. */
      const verdicts = replicas.map(verdictOf)
      const lost = verdicts.filter((v) => v.health === 'lost')
      const stuck = verdicts.filter((v) => v.health === 'stuck')
      const behind = verdicts.filter((v) => v.health === 'behind')
      if (lost.length || stuck.length) {
        return {
          standing: 'throw' as const,
          says: `${lost.length + stuck.length} of ${replicas.length} replicas ${
            lost.length ? 'have lost parts' : 'are stuck'
          }`,
        }
      }
      return behind.length
        ? {
            standing: 'watch' as const,
            says: `${behind.length} of ${replicas.length} replicas are behind`,
          }
        : { standing: 'ok' as const, says: `${replicas.length} replicas, all keeping up` }
    }),

    row(at('schema'), 'detached parts', reading(detached), (d) => {
      if (d.total === 0) return { standing: 'ok' as const, says: 'nothing detached' }
      return {
        standing: d.quarantined > 0 ? ('watch' as const) : ('ok' as const),
        says: `${exact(d.total)} detached ${d.total === 1 ? 'part' : 'parts'} holding ${bytes(
          d.total_bytes,
        )}${d.quarantined > 0 ? `, ${exact(d.quarantined)} put aside by the server` : ', all detached by hand'}`,
      }
    }),

    row(at('backups'), 'the backups', reading(backups), (b) => {
      /* No destination is a deployment's decision, not a fault: `FLINT_BACKUP_DISK`
         is how a server sanctions one, and plenty of places back up by means
         Flint knows nothing about. Saying so plainly is right; calling it an
         incident would cry wolf on every one of them. */
      if (!b.disk) {
        return {
          standing: 'ok' as const,
          says: 'no destination configured here, so Flint takes no backups',
        }
      }
      const failed = (b.runs ?? []).filter((r) => r.status.includes('FAILED'))
      if (failed.length) {
        return {
          standing: 'throw' as const,
          says: `${failed.length} of ${b.runs.length} runs failed · writing to ${b.disk}`,
        }
      }
      const last = b.runs?.[0]
      return {
        standing: 'ok' as const,
        says: last
          ? `${b.runs.length} ${b.runs.length === 1 ? 'run' : 'runs'} recorded, the last ${relativeTime(last.finished_at || last.started_at)} · writing to ${b.disk}`
          : `writing to ${b.disk}, nothing recorded yet${b.persistent ? '' : ' — this list does not survive a restart'}`,
      }
    }),

    row(at('access'), 'the accounts', reading(access), (a) => {
      const users = a.users ?? []
      /* `no_password` is the one that matters: an account anybody can be. The
         others — plaintext in a file, sha256, a certificate — are a deployment's
         own trade-off and not this page's business. */
      const open = users.filter((u) => u.auth_type.includes('no_password'))
      if (open.length) {
        return {
          standing: 'throw' as const,
          says: `${open.length} of ${users.length} accounts have no password: ${open
            .map((u) => u.name)
            .slice(0, 3)
            .join(', ')}`,
        }
      }
      return {
        standing: 'ok' as const,
        says: `${users.length} ${users.length === 1 ? 'account' : 'accounts'}, ${
          a.roles?.length ?? 0
        } ${(a.roles?.length ?? 0) === 1 ? 'role' : 'roles'}, all with a password`,
      }
    }),

    row(at('audit'), 'the record', reading(audit), (a) => {
      const entries = a.entries ?? []
      const failed = entries.filter((e) => e.outcome !== 'ok')
      if (a.operations_unavailable && entries.length === 0) {
        // Not a fault: a stateless Flint keeps no record, and saying it is fine
        // would be claiming an empty log means nothing happened.
        return { standing: 'ok' as const, says: a.operations_unavailable }
      }
      return {
        standing: failed.length ? ('watch' as const) : ('ok' as const),
        says: `${exact(entries.length)} ${entries.length === 1 ? 'entry' : 'entries'} in the last ${
          a.days
        } days${failed.length ? `, ${failed.length} of them refused or failed` : ''}`,
      }
    }),

    row(at('config'), 'the server', reading(server), (s) => ({
      standing: 'ok' as const,
      says: `ClickHouse ${s.version} · up ${uptime(s.uptime_seconds)} · ${count(
        s.databases,
      )} databases, ${count(s.tables)} objects`,
    })),
  ]

  const running = activity.data?.available ? (activity.data.running ?? []) : []
  const merges = activity.data?.available ? (activity.data.merges ?? []) : []
  const said = headline(rows)

  return (
    <article className="page page--wide">
      <header className="page__head">
        <p className="eyebrow">Infrastructure</p>
        <h1 className="page__title page__title--hero">How it stands</h1>
        <p className="page__sub">
          {said
            ? said
            : 'Nothing on this server is asking for attention. Every section below says what it is looking at.'}
        </p>
      </header>

      <MetricLine
        metrics={[
          { value: exact(running.length), label: 'queries running' },
          { value: exact(merges.length), label: 'merges' },
        ]}
      />

      {/* Above the sections, and only when it has something: this board already
          answers "is anything wrong", and what the band adds is the other
          question — what somebody *did*. A second empty panel under a page whose
          own lead says nothing is wrong would be the same answer twice. */}
      <Headlines space="infra" />

      <section className="section">
        <h2 className="section__title">Section by section</h2>
        <ul className="board">
          {rows.map((r) => (
            <li key={r.id} className={`board__row board__row--${r.standing}`}>
              <Link className="board__name" to={r.to}>
                {r.label}
              </Link>
              <span className="board__says">{r.says}</span>
            </li>
          ))}
        </ul>
      </section>

      {server.error ? <ErrorNote error={server.error} retry={() => server.refetch()} /> : null}
    </article>
  )
}
