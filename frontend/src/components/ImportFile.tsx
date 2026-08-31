import { useMutation } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'

import { api, type Inspected } from '../lib/api'
import { FORMATS, blocked, fileSize, guessFormat, saysMapping, type Format } from '../lib/importFile'
import { count } from '../lib/format'
import { ErrorNote, Sentence } from './Note'

/* Bigger than the server's own cap on purpose: it trims to whole lines, and
   it can only do that if it was given more than it keeps. The ceiling is not
   here anyway — the sample ends up in a URL, and `http::Uri` stops at 65,535
   bytes. See `SAMPLE_BYTES` in `routes/rows.rs`. */
const SAMPLE_BYTES = 16 * 1024

/** Load a file into a table.
 *
 *  The whole feature is the word *before*. What a file turns out to hold, how
 *  it lines up with the table, and a page of its rows parsed exactly as the
 *  import will parse them — all on screen before a byte is written. An import
 *  control that only reports afterwards is one nobody can use on data they
 *  care about.
 *
 *  Two shapes fall out of that and are worth naming:
 *
 *  - **The sample is read here, the file is sent whole later.** The browser
 *    slices the first 16 KB and posts it as text for inference; the file
 *    itself goes up once, on confirm, as the body of one request the browser
 *    streams. Flint keeps nothing between the two, which is what lets a file
 *    larger than its memory work.
 *  - **All of it or none of it.** The server counts the rows it accepts and
 *    says nothing about the ones it turns away, so a partial load would be one
 *    Flint could not describe. A bad row stops the file and the server names
 *    it — measured, and nothing lands when it does. */

export function ImportFile({ database, table }: { database: string; table: string }) {
  const [file, setFile] = useState<File | null>(null)
  const [format, setFormat] = useState<Format>('CSVWithNames')
  const [found, setFound] = useState<Inspected | null>(null)
  const [done, setDone] = useState<{ written: number; after: number } | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const client = useQueryClient()

  const look = useMutation({
    mutationFn: async (next: { file: File; format: Format }) => {
      const sample = await next.file.slice(0, SAMPLE_BYTES).text()
      return api.inspectFile({ database, table, format: next.format, sample })
    },
    onSuccess: setFound,
  })

  const load = useMutation({
    mutationFn: () => api.importFile({ database, table, format }, file!),
    onSuccess: (result) => {
      setDone(result)
      setFound(null)
      setFile(null)
      if (input.current) input.current.value = ''
      client.invalidateQueries({ queryKey: ['table', database, table] })
      client.invalidateQueries({ queryKey: ['preview', database, table] })
    },
  })

  /* Picking a file guesses its format and inspects it in one gesture. The
     guess is a default in a control the reader can see, never one acted on
     silently: the format decides how every byte is read, and a wrong one does
     not fail — it splits the rows in the wrong places. */
  const choose = async (picked: File | null) => {
    setFound(null)
    setDone(null)
    setFile(picked)
    if (!picked) return
    const head = await picked.slice(0, 4096).text()
    const guessed = guessFormat(picked.name, head.split('\n')[0] ?? '')
    setFormat(guessed)
    look.mutate({ file: picked, format: guessed })
  }

  const reformat = (next: Format) => {
    setFormat(next)
    setFound(null)
    setDone(null)
    if (file) look.mutate({ file, format: next })
  }

  const stopped = found ? blocked(found.mapping) : false

  return (
    <div className="impf">
      <div className="impf__pick">
        <input
          ref={input}
          type="file"
          className="impf__file"
          aria-label="File to load"
          onChange={(e) => void choose(e.target.files?.[0] ?? null)}
        />
        <label className="picker">
          <span>read as</span>
          <select
            className="picker__select"
            value={format}
            onChange={(e) => reformat(e.target.value as Format)}
          >
            {FORMATS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        {file ? <span className="says">{fileSize(file.size)}</span> : null}
      </div>

      {look.error ? <ErrorNote error={look.error} /> : null}
      {load.error ? <ErrorNote error={load.error} /> : null}
      {look.isPending ? <p className="says">Reading the first of it…</p> : null}

      {found ? (
        <div className="impf__found">
          {saysMapping(found.mapping, found.columns.length).map((line) => (
            <Sentence key={line} className="says" text={line} />
          ))}

          {/* Parsed by the server, with the same format the import will use —
              so this is not Flint's reading of the file, it is the one that
              will be written. */}
          <div className="impf__grid">
            <table className="tbl">
              <thead>
                <tr>
                  {found.columns.map((c) => (
                    <th key={c.name}>
                      {c.name}
                      <span className="says mono-dim">{c.type}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {found.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j} className="mono-dim">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="says">
            The first {found.rows.length} rows of the file, parsed by the server as {format}.
          </p>

          <pre className="addrow__sql mono-dim">{found.statement}</pre>

          <p className="says">
            A row the table refuses stops the whole file, and nothing is written. The server counts
            the rows it takes and says nothing about the ones it turns away, so Flint will not
            offer a partial load it could not describe.
          </p>

          <button
            className="btn btn--spark"
            disabled={load.isPending || stopped}
            onClick={() => load.mutate()}
          >
            {load.isPending ? 'Loading…' : `Load ${file ? fileSize(file.size) : 'the file'}`}
          </button>
        </div>
      ) : null}

      {done ? (
        <p className="says impf__done">
          {count(done.written)} rows written. The table holds {count(done.after)}.
        </p>
      ) : null}
    </div>
  )
}
