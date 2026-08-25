import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { FlintError } from '../lib/api'

/** Failure states say what happened and what to do about it — never an
 *  apology, never a bare stack trace. */
export function ErrorNote({ error, retry }: { error: unknown; retry?: () => void }) {
  const flint = error instanceof FlintError ? error : null
  const message = error instanceof Error ? error.message : String(error)

  const hint =
    flint?.kind === 'transport'
      ? 'Check FLINT_CLICKHOUSE_URL, and that ClickHouse is accepting HTTP connections.'
      : flint?.status === 401
        ? 'Set FLINT_CLICKHOUSE_USER and FLINT_CLICKHOUSE_PASSWORD, then restart Flint.'
        : flint?.status === 403
          ? 'This user lacks the grants for that. A read-only role still needs SELECT on system tables.'
          : null

  return (
    <div className="note note--error" role="alert">
      <div className="note__head">
        <span className="pill pill--warn">
          {flint?.clickhouseCode ? `clickhouse ${flint.clickhouseCode}` : 'error'}
        </span>
      </div>
      <p className="note__message">{message}</p>
      {hint ? <p className="note__hint">{hint}</p> : null}
      {retry ? (
        <button className="btn" onClick={retry}>
          Try again
        </button>
      ) : null}
    </div>
  )
}

/** An empty screen is an invitation to act. */
export function EmptyNote({
  title,
  children,
}: {
  title: string
  children?: ReactNode
}) {
  return (
    <div className="note note--empty">
      <p className="note__title">{title}</p>
      {children ? <p className="note__hint">{children}</p> : null}
    </div>
  )
}

/** When a wait stops being a wait and starts needing an explanation. Nothing is
 *  said for the first few seconds, because a fast page that flashes "still
 *  loading" reads as a product that does not know what it is doing. */
const PATIENT = 4000
const LONG = 15000

export function Loading({ label = 'Reading' }: { label?: string }) {
  const [waited, setWaited] = useState(0)

  useEffect(() => {
    const timers = [
      window.setTimeout(() => setWaited(PATIENT), PATIENT),
      window.setTimeout(() => setWaited(LONG), LONG),
    ]
    return () => timers.forEach(window.clearTimeout)
  }, [])

  return (
    <div className="loading" role="status">
      <span className="loading__spark" aria-hidden="true" />
      <span className="label">{label}</span>
      {waited >= LONG ? (
        <span className="loading__slow">
          still waiting — a query this long is usually a scan over a big table
        </span>
      ) : waited >= PATIENT ? (
        <span className="loading__slow">still waiting on ClickHouse</span>
      ) : null}
    </div>
  )
}
