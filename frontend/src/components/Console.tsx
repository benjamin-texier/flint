/** The console: a prompt on ClickHouse, on every page, that you hide rather
 *  than close.
 *
 *  **Why it is mounted where it is.** This component lives in `App`, outside
 *  `<Routes>`, and it is never unmounted. That single fact is the whole feature:
 *  the transcript, the scroll position, the half-written statement and the query
 *  still in flight all survive navigating from a table to a dashboard to the
 *  cluster page, because nothing ever tears them down. Hiding is a class, not an
 *  unmount. A console you lose by clicking a link is a console nobody starts a
 *  long query in.
 *
 *  **Why it is not a terminal.** There is no shell behind it — no PTY, no
 *  filesystem, no `ls`. It borrows the *look* of `clickhouse-client` (its box
 *  rules, its status line, its `use`) because that is the interface anybody
 *  reaching for a prompt here already knows, and it borrows nothing else. What
 *  it gains by being a web view rather than a terminal emulator is everything a
 *  terminal emulator makes you rebuild: the browser's own selection, copy and
 *  paste, and the completion `lib/complete` already computes from the live
 *  schema.
 *
 *  **Why it spans both spaces.** The Roadmap's one rule is that no *page*
 *  belongs to both Data and Infrastructure. This is not a page — it is the
 *  connection Flint already holds, exposed. What it may do is decided by the
 *  grants of the account you signed in as, which is the same answer the product
 *  gives everywhere else, and a more honest one than hiding the prompt in half
 *  the app while every statement Flint runs on your behalf goes through anyway. */

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router-dom'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'

import { api } from '../lib/api'
import { rememberedDatabase } from '../lib/database'
import {
  announce,
  applySettings,
  asText,
  asTsv,
  blame,
  clampHeight,
  databaseInPath,
  describeSettings,
  HELP,
  parseMeta,
  print,
  recall,
  remember,
  splitError,
  splitStatements,
  summarise,
  type Entry,
} from '../lib/console'
import { duration } from '../lib/format'
import { clickhouseSql, flintHighlighting } from '../editor/setup'
import { flintCompletion } from '../editor/complete'
import { promptKeymap, promptTheme } from '../editor/prompt'
import { useTabs } from '../editor/tabs'

const OPEN_KEY = 'flint.console.open'
const HEIGHT_KEY = 'flint.console.height'
const HISTORY_KEY = 'flint.console.history'

/** How much scrollback the console keeps. A hundred statements is more than
 *  anybody scrolls back through, and the cap exists because a tab left open for
 *  a week would otherwise hold every result set of that week in memory. What
 *  falls off the top is counted and said, like every other cap in the product. */
const SCROLLBACK = 100

/** How many rows the console asks for.
 *
 *  Far below the deployment's own cap, and deliberately: the transcript prints
 *  every row it is given as real DOM — no virtualisation, because a box drawn
 *  with rules cannot be windowed without the rules lying about where the table
 *  ends — so ten thousand rows would be thirty thousand elements in a drawer
 *  nobody is going to scroll through anyway.
 *
 *  A console is for the quick answer. The result that wants a grid has a grid:
 *  every entry carries "Open in the editor", and the line under a capped table
 *  says so in as many words. Two hundred is what fits a screen a few times
 *  over, which is the most anybody reads at a prompt. */
const CONSOLE_ROWS = 200

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    /* private browsing, blocked storage — the console still works, it just
       starts fresh every time */
    return null
  }
}

function keep(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* nothing to do: this session keeps it in memory either way */
  }
}

function loadHistory(): string[] {
  try {
    const raw = stored(HISTORY_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : []
  } catch {
    return []
  }
}

export function Console() {
  const [open, setOpen] = useState(() => stored(OPEN_KEY) === '1')
  const [height, setHeight] = useState(() => Number(stored(HEIGHT_KEY)) || 340)
  const [entries, setEntries] = useState<Entry[]>([])
  const [dropped, setDropped] = useState(0)
  const [draft, setDraft] = useState('')
  /* Null means "follow the page". See `databaseInPath`. */
  const [pinned, setPinned] = useState<string | null>(null)
  /* What every statement from this console carries. Deliberately *not*
     persisted: a `max_execution_time` of 1 that survived a week and a browser
     restart is a haunting, not a convenience. See `parseSet` for why the
     console holds these at all. */
  const [settings, setSettings] = useState<Record<string, string>>({})

  const editor = useRef<ReactCodeMirrorRef>(null)
  const log = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLElement>(null)
  const launcher = useRef<HTMLButtonElement>(null)
  /* Whether the transcript is following the bottom. A console that yanks you
     back down while you are reading three answers up is a console you cannot
     read. */
  const stuck = useRef(true)
  const history = useRef<string[]>(loadHistory())
  const cursor = useRef<number | null>(null)
  /* What was being typed before the arrow keys walked off into the history, so
     Down all the way back returns it rather than an empty line. */
  const stash = useRef('')
  /* Mirrors of state that callbacks read without being rebuilt when it
     changes. The console leans on this more than most components, and for one
     reason: the prompt's CodeMirror extensions — the keymap, and with it the
     completion — are rebuilt whenever any of their inputs change, and
     rebuilding them mid-keystroke throws away the open completion menu. So the
     handlers close over refs and stay identical for the component's life. */
  const draftText = useRef('')
  draftText.current = draft

  const navigate = useNavigate()
  const tabs = useTabs()
  const { pathname } = useLocation()

  /* Already in the cache — `App` reads it before anything renders — and not
     gated on `open` like the three below, because the console needs it to know
     which setting names it must refuse. */
  const config = useQuery({ queryKey: ['config'], queryFn: api.config })
  /* The rest is not fetched until the console has been opened: the schema alone
     is a real request, and most sessions never open the thing. Disabled is not
     forgotten — react-query keeps what it already has, so hiding the console
     and bringing it back does not cost the schema twice. */
  const server = useQuery({ queryKey: ['server'], queryFn: api.server, enabled: open })
  const databases = useQuery({ queryKey: ['databases'], queryFn: api.databases, enabled: open })
  const schema = useQuery({ queryKey: ['schema'], queryFn: api.schema, enabled: open })

  const database =
    pinned ?? databaseInPath(pathname) ?? rememberedDatabase() ?? server.data?.current_database ?? ''

  const databaseRef = useRef(database)
  databaseRef.current = database
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const openRef = useRef(open)
  openRef.current = open

  const running = entries.find((entry) => entry.state === 'running')
  const runningRef = useRef<Entry | undefined>(undefined)
  runningRef.current = running
  /* Statements killed on purpose, so the rejection their own request is about to
     produce can be reported as a cancellation rather than as a failure. */
  const killed = useRef(new Set<string>())

  useEffect(() => {
    keep(OPEN_KEY, open ? '1' : '0')
  }, [open])

  /* The drawer is `position: fixed`, so nothing in the layout knows it is
     there. This is what tells it: the shell reserves exactly the height the
     console occupies, and the bottom of a wide table stays reachable instead of
     sitting under a panel. Written as a custom property rather than as a React
     prop because the element that has to react to it is three components away
     and owned by the shell. */
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--console-h', open ? `${height}px` : '0px')
  }, [open, height])

  /* ── The transcript ─────────────────────────────────────────────────────── */

  const push = useCallback((entry: Entry) => {
    setEntries((prev) => {
      const next = [...prev, entry]
      if (next.length <= SCROLLBACK) return next
      setDropped((n) => n + next.length - SCROLLBACK)
      return next.slice(next.length - SCROLLBACK)
    })
  }, [])

  const patch = useCallback((id: string, changes: Partial<Entry>) => {
    setEntries((prev) => prev.map((entry) => (entry.id === id ? { ...entry, ...changes } : entry)))
  }, [])

  const say = useCallback(
    (lines: string[]) => {
      push({
        id: crypto.randomUUID(),
        sql: '',
        database: databaseRef.current,
        at: Date.now(),
        state: 'note',
        note: lines,
      })
    },
    [push],
  )

  const wipe = useCallback(() => {
    setEntries([])
    setDropped(0)
  }, [])

  /** Put it away, and put the focus somewhere real.
   *
   *  The drawer becomes `inert` on the way out, so whatever was focused inside
   *  it stops being focusable and the browser drops focus on `<body>` — which
   *  strands a keyboard at the top of the document. The launcher is where the
   *  console went, so that is where the focus goes; but only if it was in here
   *  to begin with, because hiding the console with `Ctrl+\`` while typing
   *  somewhere else must not steal the caret. */
  const hide = useCallback(() => {
    const inside = panel.current?.contains(document.activeElement) ?? false
    setOpen(false)
    if (inside) requestAnimationFrame(() => launcher.current?.focus())
  }, [])
  const hideRef = useRef(hide)
  hideRef.current = hide

  /* ── Running ────────────────────────────────────────────────────────────── */

  /** One statement — the console's own words, or the server's.
   *
   *  Answers whether it worked, because that is what decides whether the rest
   *  of a pasted script should run. */
  const runOne = useCallback(
    async (sql: string): Promise<boolean> => {
      const meta = parseMeta(sql)

      if (meta?.kind === 'help') {
        say(HELP)
        return true
      }
      if (meta?.kind === 'hide') {
        hideRef.current()
        return true
      }
      if (meta?.kind === 'clear') {
        wipe()
        return true
      }
      if (meta?.kind === 'settings') {
        say(describeSettings(settingsRef.current))
        return true
      }
      if (meta?.kind === 'reset') {
        const had = Object.keys(settingsRef.current).length
        settingsRef.current = {}
        setSettings({})
        say([
          had === 0
            ? 'There was nothing to drop.'
            : `Dropped ${had === 1 ? 'the one setting' : `all ${had} settings`} this console was carrying.`,
        ])
        return true
      }
      if (meta?.kind === 'set') {
        /* Refused here rather than at the server, because the server's refusal
           would arrive one statement too late: the setting would already be
           held, and every statement after it would carry — and fail on — the
           same name. The list is the server's; see `reserved_settings`. */
        const reserved = config.data?.reserved_settings ?? []
        const clash = meta.changes.find((change) =>
          reserved.includes(change.name.toLowerCase()),
        )
        if (clash) {
          say([
            `\`${clash.name}\` is Flint's to set, not the console's — it rides on every statement Flint sends, and a prompt that could change it could argue with this deployment's own limits.`,
            'Nothing was held.',
          ])
          return false
        }
        const next = applySettings(settingsRef.current, meta.changes)
        settingsRef.current = next
        setSettings(next)
        say([
          'Held by this console, and put on every statement it sends from now on.',
          'Nowhere else in Flint: not a dashboard tile, not an endpoint, not the same statement opened in the editor. Reloading the tab drops them.',
          ...describeSettings(next).slice(1),
        ])
        return true
      }
      if (meta?.kind === 'use') {
        const known = databases.data?.some((d) => d.name === meta.database)
        // Only refuse on an answer we actually have. With the list not yet
        // fetched, taking somebody's word for it is better than a false "there
        // is no such database".
        if (databases.data && !known) {
          say([
            `There is no database called ${meta.database} here.`,
            `This server has ${databases.data.length}: ${databases.data
              .slice(0, 8)
              .map((d) => d.name)
              .join(', ')}${databases.data.length > 8 ? `, and ${databases.data.length - 8} more` : ''}.`,
          ])
          return false
        }
        databaseRef.current = meta.database
        setPinned(meta.database)
        say([
          `Unqualified names now resolve in ${meta.database}.`,
          'The console stays there while you move around the app — the ⟲ beside the name gives it back to the page.',
        ])
        return true
      }

      const id = crypto.randomUUID()
      const queryId = crypto.randomUUID()
      const carried = settingsRef.current
      push({
        id,
        sql,
        database: databaseRef.current,
        at: Date.now(),
        state: 'running',
        queryId,
      })
      try {
        const result = await api.run({
          sql,
          database: databaseRef.current || undefined,
          query_id: queryId,
          max_rows: CONSOLE_ROWS,
          ...(Object.keys(carried).length > 0 ? { settings: carried } : null),
        })
        // It finished before the kill reached it, or the kill never landed.
        // Either way this id is spent, and leaving it in the set would report
        // the *next* failure on a reused id as a cancellation.
        killed.current.delete(queryId)
        patch(id, { state: 'done', result })
        return true
      } catch (error) {
        if (killed.current.delete(queryId)) {
          patch(id, { state: 'cancelled' })
        } else {
          patch(id, {
            state: 'error',
            error: error instanceof Error ? error.message : String(error),
            // What this statement was carrying, recorded whole. `blame` is
            // what decides which of them — if any — this particular failure is
            // about; the entry keeps the list because the view cannot ask the
            // console what it was holding three statements ago.
            ...(Object.keys(carried).length > 0
              ? { carried: Object.keys(carried).sort() }
              : null),
          })
        }
        return false
      }
    },
    // `config.data` is here for the reserved-setting refusal above. Left out,
    // this callback could keep an answer from before the config landed — and
    // the one guard that stops the console pinning a setting the server will
    // refuse would quietly do nothing.
    [config.data, databases.data, patch, push, say, wipe],
  )

  const submit = useCallback(async () => {
    const typed = draftText.current.trim()
    if (!typed) return
    /* One at a time, as a client is.
     *
     * Not a restriction for its own sake: `Stop` and `Ctrl+C` cancel *the*
     * running statement, and with two in flight there is no such thing — one of
     * them would keep going with nothing on screen offering to stop it. The
     * draft is left alone, so Enter once the first has landed runs what was
     * already typed. */
    if (runningRef.current) {
      say(['One statement at a time. ⌃C — or Stop — cancels the one that is running.'])
      return
    }

    history.current = remember(history.current, typed)
    keep(HISTORY_KEY, JSON.stringify(history.current))
    cursor.current = null
    stash.current = ''
    setDraft('')
    // Pressing Enter is asking to see the answer, wherever the transcript had
    // been scrolled to.
    stuck.current = true

    const statements = splitStatements(typed)
    for (let i = 0; i < statements.length; i += 1) {
      const sql = statements[i]
      if (!sql) continue
      const ok = await runOne(sql)
      if (ok) continue
      // A script is a sequence, and the statement after the one that failed
      // almost always assumed it had worked. Stopping is the safe reading —
      // and it is said, with the count, rather than silently.
      const left = statements.length - i - 1
      if (left > 0) {
        say([
          `Stopped there. ${left === 1 ? 'One statement was' : `${left} statements were`} not run — ${
            statements.length
          } were pasted.`,
        ])
      }
      return
    }
  }, [runOne, say])

  /** Ctrl+C, and the Stop button. Synchronous on purpose: the keymap needs to
   *  know *now* whether it took the keystroke or whether the browser should. */
  const stop = useCallback((): boolean => {
    const entry = runningRef.current
    if (!entry?.queryId) return false
    killed.current.add(entry.queryId)
    void api.cancel(entry.queryId).catch(() => {
      // The kill itself failing is not worth an entry: either the query had
      // already finished, in which case its own result is about to land, or the
      // account cannot kill it, in which case the error it eventually returns
      // says so better than a line here would.
      killed.current.delete(entry.queryId!)
    })
    return true
  }, [])

  const walk = useCallback((direction: -1 | 1) => {
    const next = recall(history.current, cursor.current, direction)
    if (next.sql === null) return
    if (cursor.current === null && direction === -1) stash.current = draftText.current
    cursor.current = next.index
    setDraft(next.index === null ? stash.current : next.sql)
  }, [])

  /* Stable across renders so the editor's extensions are not rebuilt — and with
     them the completion — on every keystroke. */
  const submitRef = useRef(submit)
  submitRef.current = submit
  const keys = useMemo(
    () =>
      promptKeymap({
        run: () => void submitRef.current(),
        history: walk,
        cancel: stop,
        hide: () => hideRef.current(),
        clear: wipe,
      }),
    [stop, walk, wipe],
  )

  const extensions = useMemo(
    () => [
      keys,
      clickhouseSql(),
      flintCompletion({ schema: schema.data ?? [], database }),
      promptTheme,
      flintHighlighting,
    ],
    [database, keys, schema.data],
  )

  /* ── The drawer ─────────────────────────────────────────────────────────── */

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Ctrl/Cmd+` — the key every console in every other product is on, and one
      // the app has not already spent: ⌘K and / belong to the palette.
      if ((event.ctrlKey || event.metaKey) && event.code === 'Backquote') {
        event.preventDefault()
        if (openRef.current) hideRef.current()
        else setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // The point of opening it is to type in it.
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => editor.current?.view?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  // A console scrolled to anywhere but the bottom is a console showing you the
  // answer to a question you have stopped asking.
  useLayoutEffect(() => {
    if (!open || entries.length === 0) return
    if (!stuck.current) return
    const el = log.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries, open])

  const drag = useRef<{ from: number; height: number } | null>(null)
  const resize = useCallback((next: number) => {
    setHeight(() => {
      const clamped = clampHeight(next, window.innerHeight)
      keep(HEIGHT_KEY, String(clamped))
      return clamped
    })
  }, [])

  const carriedCount = Object.keys(settings).length

  /* One sentence for a screen reader, covering every way a statement can end.
     See `announce` — announcing only the successes left a failed statement
     completely silent, which is the outcome that most needed saying. */
  const spoken = useMemo(() => announce(entries), [entries])

  return (
    <>
      <button
        ref={launcher}
        type="button"
        className={`cfab${open ? ' is-away' : ''}${running ? ' is-busy' : ''}`}
        aria-expanded={open}
        aria-controls="flint-console"
        inert={open}
        onClick={() => setOpen(true)}
      >
        <span className="cfab__glyph" aria-hidden="true">
          ›<i className="cfab__bar" />
        </span>
        <span className="cfab__label">Console</span>
        {/* The one thing that turns a button somebody clicks into a key
            somebody presses. */}
        <kbd className="cfab__key" aria-hidden="true">
          ⌃`
        </kbd>
        {running ? <span className="cfab__pip" aria-hidden="true" /> : null}
        <span className="sr-only">
          {running ? 'Open the console — a statement is running' : 'Open the console'}
        </span>
      </button>

      <section
        ref={panel}
        id="flint-console"
        className={`cons${open ? ' is-open' : ''}`}
        style={{ height: `${height}px` }}
        aria-label="ClickHouse console"
        inert={!open}
      >
        <div
          className="cons__grip"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the console"
          /* A separator that reports a value has to report its range too, or
             the figure is a number with nothing to be a fraction of. The bounds
             are `clampHeight`'s, asked rather than restated. */
          aria-valuenow={height}
          aria-valuemin={clampHeight(0, window.innerHeight)}
          aria-valuemax={clampHeight(Number.MAX_SAFE_INTEGER, window.innerHeight)}
          aria-valuetext={`${height} pixels tall`}
          tabIndex={0}
          onPointerDown={(event) => {
            drag.current = { from: event.clientY, height }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            if (!drag.current) return
            resize(drag.current.height + (drag.current.from - event.clientY))
          }}
          onPointerUp={() => {
            drag.current = null
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowUp') resize(height + 24)
            else if (event.key === 'ArrowDown') resize(height - 24)
            else return
            event.preventDefault()
          }}
        />

        <header className="cons__bar">
          <span
            className="cons__dot"
            data-state={running ? 'busy' : 'idle'}
            aria-hidden="true"
          />
          <span className="cons__who">
            {server.data ? (
              <>
                {server.data.current_user}
                <span className="cons__at">@</span>
                {server.data.version}
              </>
            ) : (
              'connecting'
            )}
          </span>

          <label className="cons__db">
            <span className="sr-only">Database unqualified names resolve in</span>
            <select
              value={database}
              onChange={(event) => setPinned(event.target.value)}
              disabled={!databases.data}
            >
              {/* The current one always appears, even before the list lands or
                  when it is a database this account cannot enumerate. */}
              {databases.data?.some((d) => d.name === database) ? null : (
                <option value={database}>{database || '—'}</option>
              )}
              {databases.data?.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          {pinned ? (
            <button
              type="button"
              className="cons__unpin"
              onClick={() => setPinned(null)}
              title="Follow the page again"
            >
              ⟲<span className="sr-only"> follow the page again</span>
            </button>
          ) : null}

          {/* Settings the console is carrying. Invisible state is a trap, and
              this is state that changes what every statement means — so it is
              on the bar, and clicking it says exactly what is held. */}
          {carriedCount > 0 ? (
            <button
              type="button"
              className="cons__chip"
              onClick={() => say(describeSettings(settings))}
            >
              {carriedCount} setting{carriedCount === 1 ? '' : 's'}
            </button>
          ) : null}

          <span className="cons__gap" />

          {/* Announced, not printed. However the last statement ended, it is
              already written an inch below — and saying it twice on screen
              makes the bar look like it is reporting something else. A screen
              reader has no transcript to watch appear, so it keeps the words.
              See `announce` for why it covers failures too. */}
          <p className="cons__live sr-only" role="status" aria-live="polite">
            {spoken}
          </p>

          <button
            type="button"
            className="cons__act"
            onClick={wipe}
            disabled={entries.length === 0}
          >
            Clear
          </button>
          <button
            type="button"
            className="cons__act cons__act--icon"
            onClick={hide}
            title="Hide the console — it keeps everything"
          >
            ▾<span className="sr-only"> hide the console</span>
          </button>
        </header>

        <div
          className="cons__log"
          ref={log}
          tabIndex={0}
          role="log"
          aria-label="Console transcript"
          onScroll={(event) => {
            const el = event.currentTarget
            // Within a line of the bottom counts as "at the bottom": a
            // transcript that is one pixel short after a result lands would
            // otherwise stop following for good.
            stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
        >
          {dropped > 0 ? (
            <p className="cons__dropped">
              {dropped === 1 ? '1 earlier statement is' : `${dropped} earlier statements are`} no
              longer here — the console keeps the last {SCROLLBACK}.
            </p>
          ) : null}

          {entries.length === 0 && dropped === 0 ? (
            <p className="cons__empty">
              A prompt on ClickHouse, as {server.data?.current_user ?? 'whoever you signed in as'}.
              Type <code>help</code> for the keys.
            </p>
          ) : null}

          {entries.map((entry) => (
            <EntryView
              key={entry.id}
              entry={entry}
              onRecall={(sql) => {
                setDraft(sql)
                cursor.current = null
                editor.current?.view?.focus()
              }}
              onEdit={(sql, db) => {
                /* The editor is a different surface with its own connection
                   options, and it does not carry what this console is holding.
                   A statement that only ran because of a `SET` would quietly
                   behave differently over there, so the handoff says so rather
                   than letting it be discovered. */
                const carried = Object.keys(settingsRef.current).sort()
                if (carried.length > 0) {
                  say([
                    `Opened in the editor without ${carried.join(', ')} — the editor does not carry this console's settings.`,
                  ])
                }
                tabs.openWith(sql, db)
                navigate('/query')
              }}
              onStop={stop}
            />
          ))}
        </div>

        <div className="cons__prompt">
          <span className="cons__cue" aria-hidden="true">
            {database || 'ch'} <span className="cons__caret">›</span>
          </span>
          <div className="cons__input">
            <CodeMirror
              ref={editor}
              value={draft}
              theme="none"
              basicSetup={{
                lineNumbers: false,
                foldGutter: false,
                highlightActiveLine: false,
                highlightActiveLineGutter: false,
                // Ours, from `editor/complete` — two sources answering the same
                // question is how a menu ends up with 1,500 entries in it.
                autocompletion: false,
                searchKeymap: false,
                foldKeymap: false,
                lintKeymap: false,
                bracketMatching: true,
                closeBrackets: true,
              }}
              extensions={extensions}
              onChange={(value) => {
                setDraft(value)
                // Typing leaves the history. Otherwise Up from an edited recall
                // jumps from where you *were* rather than from what you have.
                cursor.current = null
              }}
              placeholder="SELECT … — Enter runs it, help lists the keys"
            />
          </div>
          {running ? (
            <button type="button" className="cons__stop" onClick={stop}>
              Stop
              <kbd>⌃C</kbd>
            </button>
          ) : null}
        </div>
      </section>
    </>
  )
}

/* ── One thing that was typed, and what came back ────────────────────────── */

function EntryView({
  entry,
  onRecall,
  onEdit,
  onStop,
}: {
  entry: Entry
  onRecall: (sql: string) => void
  onEdit: (sql: string, database: string) => void
  onStop: () => boolean
}) {
  const result = entry.result
  const printed = useMemo(
    () => (result && result.columns.length > 0 ? print(result.columns, result.rows) : null),
    [result],
  )
  const summary = useMemo(() => (result ? summarise(result) : null), [result])

  if (entry.state === 'note') {
    return (
      <div className="cons__entry cons__entry--note">
        {entry.note?.map((line, i) => (
          <p key={i} className="cons__note">
            {line || ' '}
          </p>
        ))}
      </div>
    )
  }

  return (
    <div className="cons__entry">
      <div className="cons__said">
        <span className="cons__cue" aria-hidden="true">
          {entry.database} <span className="cons__caret">›</span>
        </span>
        <button
          type="button"
          className="cons__sql"
          onClick={() => onRecall(entry.sql)}
          title="Put this back in the prompt"
        >
          {entry.sql}
        </button>
        <span className="cons__tools">
          <button type="button" onClick={() => void navigator.clipboard?.writeText(entry.sql)}>
            Copy SQL
          </button>
          {printed ? (
            <>
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(asText(printed))}
              >
                Copy table
              </button>
              <button
                type="button"
                onClick={() =>
                  void navigator.clipboard?.writeText(
                    asTsv(result!.columns, result!.rows),
                  )
                }
              >
                Copy TSV
              </button>
            </>
          ) : null}
          <button type="button" onClick={() => onEdit(entry.sql, entry.database)}>
            Open in the editor
          </button>
        </span>
        {/* When, not how long ago. The console outlives the page you started it
            from, so a transcript read half an hour later has to be able to say
            which of these ran before the deploy. */}
        <time className="cons__when" dateTime={new Date(entry.at).toISOString()}>
          {new Date(entry.at).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })}
        </time>
      </div>

      {entry.state === 'running' ? (
        <p className="cons__running">
          <span className="cons__ticker" aria-hidden="true" />
          Running<Elapsed since={entry.at} />
          <button type="button" className="cons__linkish" onClick={onStop}>
            cancel
          </button>
        </p>
      ) : null}

      {entry.state === 'cancelled' ? (
        <p className="cons__note">Cancelled. Whatever it had read was thrown away.</p>
      ) : null}

      {entry.state === 'error' ? (
        <Failure message={entry.error ?? ''} carried={entry.carried} />
      ) : null}

      {printed ? (
        <div className="cons__table">
          <div className="cons__row">
            <span className="cons__rule">┌</span>
            {printed.head.map((head, i) => (
              <Fragment key={i}>
                {i > 0 ? <span className="cons__rule">┬</span> : null}
                <span className="cons__rule">{head.before}</span>
                <span className="cons__head">{head.name}</span>
                <span className="cons__rule">{head.after}</span>
              </Fragment>
            ))}
            <span className="cons__rule">┐</span>
          </div>
          {printed.body.map((row, r) => (
            <div className="cons__row" key={r}>
              <span className="cons__rule">{'│ '}</span>
              {row.map((cell, c) => (
                <Fragment key={c}>
                  {c > 0 ? <span className="cons__rule">{' │ '}</span> : null}
                  <span className={`cons__cell is-${cell.kind}`}>{cell.text}</span>
                </Fragment>
              ))}
              <span className="cons__rule">{' │'}</span>
            </div>
          ))}
          <div className="cons__row">
            <span className="cons__rule">{printed.bottom}</span>
          </div>
        </div>
      ) : null}

      {summary ? (
        <p className="cons__stat">
          {summary.line}
          {summary.capped ? <span className="cons__capped">{summary.capped}</span> : null}
        </p>
      ) : null}
    </div>
  )
}

/** A ClickHouse error, with its grammar folded away.
 *
 *  See `splitError` for why. The rest is one click behind a control that says
 *  how much there is, so nobody has to wonder whether the console shortened
 *  something important. */
function Failure({ message, carried }: { message: string; carried?: string[] }) {
  const [whole, setWhole] = useState(false)
  const { head, rest } = useMemo(() => splitError(message), [message])
  /* Only the settings this failure is plausibly about — see `blame`. Naming
     everything the console held turned a refused write on a read-only server
     into an accusation against `max_threads`. */
  const suspect = useMemo(() => blame(message, carried ?? []), [message, carried])

  return (
    <div className="cons__error">
      <p className="cons__errorHead">{head}</p>
      {suspect.length > 0 ? (
        <p className="cons__blame">
          This statement was carrying {suspect.join(', ')}, which the server is complaining about.{' '}
          <code>SET {suspect[0]} = DEFAULT</code> drops it; <code>reset</code> drops them all.
        </p>
      ) : null}
      {rest ? (
        whole ? (
          <p className="cons__errorRest">{rest}</p>
        ) : (
          <button type="button" className="cons__linkish" onClick={() => setWhole(true)}>
            and {rest.length} more characters the server said
          </button>
        )
      ) : null}
    </div>
  )
}

/** How long the statement has been running.
 *
 *  Silent for the first second, because most statements answer inside it and a
 *  clock that flashes up and vanishes on every `SELECT 1` is noise. Past that
 *  it is the one thing worth knowing — and it matters here more than in a page,
 *  because the console survives navigation: the statement you started on a
 *  table page is still going while you read a dashboard, and "Running…" with no
 *  figure cannot tell you whether that is two seconds or two minutes. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    // Half a second. Fast enough that the figure never looks stuck, slow enough
    // that it is not a stopwatch demanding to be watched.
    const tick = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(tick)
  }, [])

  const seconds = (now - since) / 1000
  if (seconds < 1) return <>…</>
  return <> for {duration(seconds)}</>
}
