import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { api } from '../lib/api'
import { stretch } from '../lib/format'
import {
  outageHint,
  outageOf,
  outageTitle,
  probeDelay,
  reachAnswered,
  reachSnapshot,
  subscribeReach,
  type Outage,
  type Reach,
} from '../lib/reach'

/** What the window currently believes about reaching the backend. */
export function useReach(): Reach {
  return useSyncExternalStore(subscribeReach, reachSnapshot, reachSnapshot)
}

/** The check that decides whether the outage is over, and the countdown to the
 *  next one.
 *
 *  `/api/server` rather than `/api/config`, because it is the one read that
 *  exercises the whole chain: Flint answers it by asking ClickHouse, so a
 *  success clears either outage and there is no way to report Flint back while
 *  it still cannot see its database.
 *
 *  Any answer counts as back, including a refusal. A 401 is a running server
 *  saying who it will not serve, which is a different problem and one that has
 *  its own screen. */
function useProbe(outage: Outage) {
  const client = useQueryClient()
  /* How many checks have failed, kept in a ref: it decides how long to wait
     and nothing renders it, so it has no business causing a render of its
     own. */
  const attempts = useRef(0)
  const [deadline, setDeadline] = useState(() => Date.now() + probeDelay(0))
  const [now, setNow] = useState(() => Date.now())
  const [checking, setChecking] = useState(false)

  const check = useCallback(async () => {
    setChecking(true)
    try {
      await api.server()
      recover()
    } catch (error) {
      if (outageOf(error) === null) recover()
      else {
        attempts.current += 1
        setDeadline(Date.now() + probeDelay(attempts.current))
      }
    } finally {
      setChecking(false)
    }

    function recover() {
      reachAnswered()
      /* Everything on screen failed while this was down and React Query has
         given up on all of it — nothing refetches on its own, so the page
         would sit empty behind a strip that had just said it was back.
         Invalidating asks every mounted query again, at once, which is the
         restart the reader is expecting to see. */
      void client.invalidateQueries()
    }
  }, [client])

  // One timer for the next check, one for the second hand. Both keyed on the
  // deadline, so a check asked for by hand reschedules the automatic one
  // rather than racing it.
  useEffect(() => {
    const timer = window.setTimeout(() => void check(), Math.max(0, deadline - Date.now()))
    const tick = window.setInterval(() => setNow(Date.now()), 1000)
    return () => {
      window.clearTimeout(timer)
      window.clearInterval(tick)
    }
  }, [deadline, check])

  return { left: Math.max(0, Math.ceil((deadline - now) / 1000)), checking, check, outage }
}

/** How long it has been out, refreshed once a second so it stays true on a tab
 *  left open. */
function useElapsed(since: number): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(tick)
  }, [])
  return stretch(Math.max(0, (now - since) / 1000))
}

/** The state of the check, as one line. Said in the present tense while a
 *  request is actually in flight, because that is the half-second in which
 *  something might change.
 *
 *  Hidden from assistive technology on purpose: it is a second hand, and inside
 *  a strip that already announced itself as an alert it would re-announce a new
 *  number every second — the outage said once is the message, "checking again
 *  in 7s, checking again in 6s" is not. The button beside it is the part
 *  anybody can act on, and it is a plain labelled button. */
function Checking({
  checking,
  left,
  onCheck,
}: {
  checking: boolean
  left: number
  onCheck: () => void
}) {
  return (
    <>
      <span className="outage__next" aria-hidden="true">
        {checking ? 'checking…' : left > 0 ? `checking again in ${left}s` : 'checking…'}
      </span>
      <button className="btn" onClick={onCheck} disabled={checking}>
        Check now
      </button>
    </>
  )
}

/** The strip across the top of an app that is already on screen.
 *
 *  A strip and not a dialog: the page underneath is still worth looking at.
 *  Its figures are from before the outage and every panel says so in its own
 *  quiet way, but a schema you were reading a minute ago does not stop being
 *  the schema because the server went away, and blocking it behind a modal
 *  would take that away for nothing. */
export function OutageBar({ outage, since }: { outage: Outage; since: number }) {
  const { left, checking, check } = useProbe(outage)
  const elapsed = useElapsed(since)

  return (
    <div className="outage" role="alert">
      <span className="outage__pulse" aria-hidden="true" />
      <span className="outage__title">{outageTitle(outage)}</span>
      {/* The clock matters: "for 3 s" is a restart to wait out, "for 40 min" is
          something somebody has to go and fix. */}
      <span className="outage__for">for {elapsed}</span>
      <span className="outage__hint">{outageHint(outage)}</span>
      <span className="outage__spacer" />
      <Checking checking={checking} left={left} onCheck={() => void check()} />
    </div>
  )
}

/** The whole window, for the cold start: Flint was already down when the tab
 *  was opened, so there is no shell to put a strip on top of and nothing
 *  underneath it to read.
 *
 *  It deliberately does not look like the sign-in screen, which is what used to
 *  appear here — a page asking for credentials is a page saying "you are the
 *  problem", and the reader who types them in correctly and is refused again
 *  learns nothing. */
export function OutageScreen({ outage, since }: { outage: Outage; since: number }) {
  const { left, checking, check } = useProbe(outage)
  const elapsed = useElapsed(since)

  return (
    <div className="offline">
      <div className="offline__card">
        <div className="offline__brand">
          <svg className="mark" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M9.5 1 3 9h4l-1.5 6L13 6.5H8.5z" fill="currentColor" />
          </svg>
          <span className="offline__word">flint</span>
        </div>
        <h1 className="offline__title">
          <span className="outage__pulse" aria-hidden="true" />
          {outageTitle(outage)}
        </h1>
        <p className="offline__sub">{outageHint(outage)}</p>
        <p className="offline__for">Unanswered for {elapsed}.</p>
        <div className="offline__actions">
          <Checking checking={checking} left={left} onCheck={() => void check()} />
        </div>
      </div>
    </div>
  )
}
