import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { api } from '../lib/api'
import { fullnessOf } from '../lib/limits'
import { saysUnnamed, share, short, type TraceReport } from '../lib/trace'
import { EmptyNote, ErrorNote, Loading } from './Note'

/** Where the processor actually went.
 *
 *  Four things this panel is careful about, and all four were measured rather
 *  than reasoned from the table:
 *
 *  - It counts the **innermost** frame. Counting every frame ranks
 *    `ThreadPoolImpl::worker()` above everything, because a stack of thirty
 *    frames has twenty-eight of plumbing identical in every sample.
 *  - It says how many samples it is drawing on, and refuses to rank a handful.
 *    The profiler fires once a second per busy thread, so a quiet server gives a
 *    dozen — and a bar chart over a dozen is a picture of nothing.
 *  - It counts what the build could not name. Roughly half the frames on an idle
 *    server come back empty, and dropping them silently would make the list look
 *    complete.
 *  - It keeps `CPU` and `Real` apart. One is where the processor was, the other
 *    is where threads were including every one that was waiting — an idle server
 *    had three million of the second against five thousand of the first. */
export function Trace() {
  const [kind, setKind] = useState<'cpu' | 'real'>('cpu')
  const [minutes, setMinutes] = useState(15)
  const report = useQuery({
    queryKey: ['trace', kind, minutes],
    queryFn: () => api.trace(kind, minutes),
    staleTime: 20_000,
  })

  return (
    <section className="diag">
      <header className="diag__head">
        <h2 className="diag__title">Where the processor went</h2>
        <p className="diag__sub">
          From <code>system.trace_log</code>, which the profiler writes by interrupting each busy
          thread once a second and noting the stack. These are samples and not measurements: they
          say where time probably went, in proportion, and nothing at all about a query that ran
          for less than a sampling period.
        </p>
        <p className="rbac__row">
          <span className="segmented">
            {(['cpu', 'real'] as const).map((k) => (
              <button
                className={`btn${kind === k ? ' is-on' : ''}`}
                key={k}
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
              >
                {k === 'cpu' ? 'Processor time' : 'Wall clock'}
              </button>
            ))}
          </span>
          <label className="rbac__field">
            <span className="label">OVER</span>
            <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
              <option value={5}>5 minutes</option>
              <option value={15}>15 minutes</option>
              <option value={60}>an hour</option>
              <option value={360}>6 hours</option>
            </select>
          </label>
        </p>
      </header>

      {report.isPending ? <Loading label="Reading the profiler" /> : null}
      {report.error ? <ErrorNote error={report.error} retry={() => report.refetch()} /> : null}
      {report.data ? <Body report={report.data} /> : null}
    </section>
  )
}

function Body({ report }: { report: TraceReport }) {
  if (report.blocked) {
    return <EmptyNote title="Nothing to profile">{report.blocked}</EmptyNote>
  }

  const unnamed = saysUnnamed(report)

  return (
    <>
      {/* Both sentences come from the backend. Written a second time here they
          would eventually differ from the rule that produced them, which is the
          drift the `SYSTEM` console already had to have removed from it. */}
      <p className="diag__quiet">{report.kind_says}</p>

      {report.note ? (
        <div className="cfg__loud">
          <p>{report.note}</p>
        </div>
      ) : null}

      {/* Below the threshold the note *replaces* the ranking rather than
          introducing it. A window holding ten samples draws eight rows tied at
          13%, which is the picture of nothing the note is warning about — and a
          warning printed above the thing it warns against is read as a caveat,
          not as an answer. So the backend having something to say here is the
          whole answer, and the table waits for a window that can fill it. */}
      {!report.note && unnamed ? <p className="diag__quiet">{unnamed}</p> : null}

      {!report.note && report.frames.length ? (
        <table className="tbl">
          <thead>
            <tr>
              <th>Function</th>
              <th className="tbl--n">Samples</th>
              <th className="tbl--n">Share of named</th>
            </tr>
          </thead>
          <tbody>
            {report.frames.map((f) => {
              const s = share(f, report.frames)
              return (
                <tr key={f.name}>
                  {/* The full name in the title: a demangled C++ symbol runs to
                      ninety characters of which the last twenty carry the
                      meaning, and the row shows those. */}
                  <td className="tbl__key mono-dim" title={f.name}>
                    {short(f.name)}
                  </td>
                  <td className="tbl--n mono-dim">{f.samples}</td>
                  <td className="tbl--n">
                    <span className="gauge">
                      <span className="gauge__value">{Math.round(s * 100)}%</span>
                      <span className="gauge__track">
                        <span
                          className="gauge__fill"
                          style={{ width: `max(2px, ${(fullnessOf(f.samples, report.frames[0]?.samples ?? 1) ?? 0) * 100}%)` }}
                        />
                      </span>
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : null}
    </>
  )
}
