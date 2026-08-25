/** The scaffolding both diagnostic pages stand on.
 *
 *  Diagnostics used to be one page. It is two — Data asks what the statements
 *  did, Infrastructure asks what the server is doing — and these three pieces
 *  are the part that has no side to take: how a section reports being denied,
 *  and how a verdict is printed. Shared rather than copied, because the two
 *  pages saying "not available here" differently would read as two products
 *  built by different people, which is the one thing the split must not cause.
 *
 *  Every section can be individually unavailable, because on a locked-down role
 *  most of them are. That is why they load independently rather than as one
 *  request — a user granted `system.parts` but not `system.query_log` should
 *  still get the storage half of the page. */

import type { Level, Verdict } from '../lib/diagnose'
import { EmptyNote, ErrorNote, Loading } from './Note'

export type Q<T> = {
  data: T | undefined
  error: unknown
  isPending: boolean
  refetch: () => void
}

/** One wrapper so every section handles pending, error and "not granted" the
 *  same way — the third being the common case on a read-only role. */
export function Section({
  title,
  sub,
  q,
  children,
}: {
  title: string
  sub?: string
  q: Q<{ available: boolean; reason?: string }>
  children: React.ReactNode
}) {
  return (
    <section className="diag">
      <header className="diag__head">
        <h2 className="diag__title">{title}</h2>
        {sub ? <p className="diag__sub">{sub}</p> : null}
      </header>
      {q.isPending ? <Loading label="Reading system tables" /> : null}
      {q.error ? <ErrorNote error={q.error} retry={() => q.refetch()} /> : null}
      {q.data && !q.data.available ? (
        <EmptyNote title="Not available here">
          {q.data.reason}. Everything else on this page is unaffected.
        </EmptyNote>
      ) : null}
      {q.data?.available ? children : null}
    </section>
  )
}

export function Says({ verdict }: { verdict: Verdict }) {
  if (verdict.level === 'ok') return null
  return <span className={`says says--${verdict.level}`}>{verdict.says}</span>
}

export function Flag({ level, children }: { level: Level; children: React.ReactNode }) {
  return <span className={`flag flag--${level}`}>{children}</span>
}

