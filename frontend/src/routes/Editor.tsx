import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { keymap } from '@codemirror/view'
import { Prec } from '@codemirror/state'

import { api, FlintError, type AppConfig, type QueryResult, type SchemaEntry } from '../lib/api'
import { bytes, count, duration } from '../lib/format'
import { statementAt } from '../lib/sql'
import { rememberedDatabase, resolveDatabase } from '../lib/database'
import { formatDdl } from '../lib/ddl'
import { ResultView } from '../components/ResultView'
import type { GridQuery } from '../components/ResultsGrid'
import { EmptyNote, ErrorNote, Loading } from '../components/Note'
import { StartHere } from '../components/StartHere'
import { HistoryPanel } from './History'
import { SavedPanel } from './Saved'
import { DashPanel } from './DashPanel'
import { DESTINATIONS, handoffPath, type Destination } from '../lib/handoff'
import { clickhouseSql, flintHighlighting, flintTheme } from '../editor/setup'
import { flintCompletion } from '../editor/complete'
import { BuildPane } from '../editor/BuildPane'
import { canSwitch, useTabs, type Switchable, type TabMode, type QueryTab } from '../editor/tabs'
import { asResult, specToDsl } from '../lib/dsl'
import { builtDownloadNote } from '../lib/export'
import {
  clearSpecOrder,
  cycleSpecOrder,
  describe as describeSpec,
  dropSpecColumn,
  filterSpec,
  literal,
  quoteIdent,
  type Op,
  type QuerySpec,
} from '../lib/query'
import { rerunPolicy, worthExplaining } from '../lib/cost'
import { readPlan, verdicts } from '../lib/plan'
import {
  addFilter,
  bodyOf,
  cellPredicate,
  groupTerms,
  isDistinct,
  removeGroupTerm,
  untouched,
  clearOrder,
  cycleOrder,
  dropColumn,
  fromRef,
  orderTerms,
  removeOrderTerm,
  removeTerm,
  rewritable,
  selectItems,
  setLimit,
  setSelectList,
  shapeOf,
  whereTerms,
  type CellOp,
} from '../lib/rewrite'
import { TypeIcon } from '../components/TypeIcon'

/** The query page: one question, asked either way.
 *
 *  Writing SQL and building a question without writing any used to be two
 *  pages. They were never two products — the same database picker, the same run,
 *  the same statistics, the same grid, the same charts, the same handoffs —
 *  and keeping them apart meant every one of those had to be built twice, so
 *  half of them only ever got built once. The form had no chart, no download and
 *  no history; the editor had no way to ask a question without knowing the
 *  language.
 *
 *  So it is one page with a switch on it, and the switch belongs to the tab —
 *  see `TabMode`. Everything below the composing band is identical in both
 *  modes, because it *is* the same code: one stats strip, one result view, one
 *  set of panels. What differs is only what a run posts (a statement, or the
 *  document the server writes the statement from) and what a click on a column
 *  header edits (the text, or the form).
 *
 *  The one asymmetry is deliberate and stated on the control: a form becomes
 *  SQL, and SQL becomes a form again only while it is still the statement the
 *  form wrote. Nothing here parses SQL back into a spec, and a switch that
 *  pretended otherwise would be the mode switch that eats your work. */
export function Editor() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  /* Which drawer is open under the results, or none.
   *
   *  Four booleans before, and they could all be true at once — the render only
   *  ever showed the first, so pressing Saved while History was open lit two
   *  buttons and answered one of them. `aria-pressed` on a control that is on
   *  and not showing is worse than no state at all: it is the page telling a
   *  screen reader something the screen does not say. One value, so the buttons
   *  cannot lie, and the second press on the open one closes it. */
  const [panel, setPanel] = useState<Panel | null>(null)
  const toggle = useCallback(
    (which: Panel) => setPanel((open) => (open === which ? null : which)),
    [],
  )
  // null = follow the content. A drag pins it, and a double-click on the grip
  // hands it back.
  const [codeHeight, setCodeHeight] = useState<number | null>(null)
  /** How tall the form's clauses are, as the form measures them. Null until it
   *  has said, and irrelevant in SQL — an editor's own content height is a line
   *  count, which this side can work out for itself. */
  const [formHeight, setFormHeight] = useState<number | null>(null)
  /** Why a gesture on the grid could not be carried into the form — the
   *  bucketed column that cannot be filtered, the total that cannot be matched
   *  with `contains`. Cleared as soon as anything else happens. */
  const [refused, setRefused] = useState<string | null>(null)
  /* What the last read of a statement into this tab's form could not carry.
     
     Kept per tab, because the strip that shows it belongs to one question and
     a list left over from another tab would be a list about somebody else's
     query. Cleared when the tab is turned back over: the statement is the
     truth again, and nothing has been lost from it. */
  const [carried, setCarried] = useState<{ tab: string; dropped: string[] } | null>(null)
  /** Why the last rewrite was not run for you — null when everything on screen
   *  is what the statement says. */
  const [awaiting, setAwaiting] = useState<string | null>(null)
  /** What the plan on screen actually answers, when that needs saying. An
   *  EXPLAIN is the one result on this page that is not the query's own answer,
   *  and which pass produced it changes how to read it. */
  const [explainNote, setExplainNote] = useState<string | null>(null)
  /** The plan read back for the statement whose rows are on screen.
   *
   *  Deliberately *not* through `runSql`: asking why a read was large must not
   *  cost you the rows you were looking at, which is what the Explain menu does
   *  by design. This fetch keeps the result and puts the verdicts beside it. */
  const [why, setWhy] = useState<{
    said: ReturnType<typeof verdicts>
    sql: string
    /** True when the EXPLAIN itself was refused. Different from a plan that
     *  simply had nothing to say — a read of `system.numbers` prunes nothing
     *  because there is nothing to prune, and telling somebody the server
     *  refused would be a lie about their query. */
    failed: boolean
  } | null>(null)
  const [whyRunning, setWhyRunning] = useState(false)
  /** The editor view exists only after CodeMirror mounts, and the rail's clicks
   *  need it. */
  const [ready, setReady] = useState(false)
  const tabs = useTabs()
  const editor = useRef<ReactCodeMirrorRef>(null)

  const config = useQuery({ queryKey: ['config'], queryFn: api.config })
  const schema = useQuery({
    queryKey: ['schema'],
    queryFn: api.schema,
    staleTime: 5 * 60 * 1000,
  })

  const active = tabs.active
  // The tab may not carry a database yet (a fresh tab, or one opened without
  // one). Resolving it here means the picker, the run and the autocomplete all
  // agree on which database they are in.
  const database = active?.database ?? config.data?.default_database

  // Arriving from "Open in editor": seed a tab, then drop the params so a
  // refresh does not keep re-seeding it. Keyed on the SQL itself, because the
  // effect runs twice on mount in development and would otherwise open the
  // same query in two tabs.
  const { openWith, openBuild } = tabs
  const seeded = useRef<string | null>(null)
  useEffect(() => {
    const sql = params.get('sql')
    if (!sql || seeded.current === sql) return
    seeded.current = sql
    openWith(sql, params.get('database') ?? undefined)
    setParams(new URLSearchParams(), { replace: true })
  }, [params, setParams, openWith])

  /* Arriving to look at the saved list rather than to write something —
     `/query?panel=saved`, which is where the home's "All N statements" leads.
     The list is a panel on this page and not a page of its own, so a link to it
     has to be a link to this page with the panel open. Dropped from the URL like
     the rest, so a refresh does not re-open a panel somebody has closed. */
  const seededPanel = useRef(false)
  useEffect(() => {
    if (params.get('panel') !== 'saved' || seededPanel.current) return
    seededPanel.current = true
    setPanel('saved')
    setParams(new URLSearchParams(), { replace: true })
  }, [params, setParams])

  /* Arriving on the form rather than on the editor — `/query?mode=build`, which
     is where the old `/build` path now leads and what the palette's "Build"
     opens. Dropped from the URL once honoured, for the same reason the seeded
     statement is: a refresh should not open a second one. */
  const seededMode = useRef(false)
  useEffect(() => {
    if (params.get('mode') !== 'build' || seededMode.current) return
    seededMode.current = true
    openBuild(params.get('database') ?? undefined)
    setParams(new URLSearchParams(), { replace: true })
  }, [params, setParams, openBuild])

  /** Run one statement. Everything that runs anything goes through here —
   *  the Run button, ⌘↵, an EXPLAIN, and every rewrite the grid makes — so there
   *  is one place that records what was run beside its result. `ranSql` is what
   *  lets the grid know which statement its headers are allowed to edit.
   *
   *  `remember` is false for an EXPLAIN: the plan of a query is not the query,
   *  and letting a header click rewrite `EXPLAIN PLAN SELECT …` would be
   *  nonsense. */
  const runSql = useCallback(
    async (statement: string, remember = true): Promise<boolean> => {
      if (!active || !statement.trim()) return false
      const queryId = crypto.randomUUID()
      tabs.patch(active.id, { running: true, queryId, error: null })
      setAwaiting(null)
      setWhy(null)
      if (remember) setExplainNote(null)
      const startedAt = performance.now()
      try {
        const result = await api.run({ sql: statement, database, query_id: queryId })
        tabs.patch(active.id, {
          running: false,
          queryId: null,
          result,
          ranSql: remember ? statement : null,
          error: null,
          wallMs: performance.now() - startedAt,
        })
        return true
      } catch (error) {
        tabs.patch(active.id, {
          running: false,
          queryId: null,
          error,
          wallMs: performance.now() - startedAt,
        })
        return false
      }
    },
    [active, database, tabs],
  )

  /* ── The form's half of the page ───────────────────────────────────────
     The spec lives on the tab; everything derived from it lives here, so that
     the strip, the Run button and the grid all read one translation rather than
     three that can disagree. */
  const mode: TabMode = active?.mode ?? 'sql'
  const spec = active?.spec ?? null

  /* The question, as the server's own query language writes it.

     The form used to build SQL in the browser and post the SQL. It no longer
     does: two query languages in one product is two sets of rules that drift,
     and these two had already drifted — `uniq` meant an estimate on this side
     and an exact count on the other, under one word. So the spec becomes a
     document, the server writes the statement, and there is one place that
     decides what a filter or an aggregate means. */
  const translated = useMemo(
    () => (mode === 'build' && spec ? specToDsl(spec) : null),
    [mode, spec],
  )
  const dsl = translated && 'query' in translated ? translated.query : null
  const blocked = translated && 'blocked' in translated ? translated.blocked : null

  /* And the server hands the statement back, so the strip below can show it
     while somebody is assembling the question rather than only after they run
     it. It reads no data — `explain` builds and returns. */
  const explained = useQuery({
    queryKey: ['dataset-sql', JSON.stringify(dsl)],
    queryFn: () => api.datasetSql(dsl as NonNullable<typeof dsl>),
    enabled: Boolean(dsl),
    retry: false,
    staleTime: 60_000,
  })
  const generated = explained.data?.sql ?? null

  /* The generated statement, mirrored onto the tab.

     This is what makes the rest of the page mode-blind: Save, Send to…, the
     dashboard tile, the download and Explain all read `tab.sql`, and none of
     them has to know whether a person or the server wrote it. `specSql` is
     written with it, and is what `canSwitch` compares against to know whether
     the statement is still the form's own. */
  useEffect(() => {
    if (!active || mode !== 'build' || !generated) return
    if (active.specSql === generated && active.sql === generated) return
    tabs.patch(active.id, { sql: generated, specSql: generated })
  }, [active, mode, generated, tabs])

  /* A form opens on a database worth opening on.
     
     The editor may sit on `default` forever — you type the name you want, and
     an empty scratchpad on the wrong database costs nothing. A form on the
     wrong database is not a form: it has no tables to offer, so it has no
     question to ask. So a build tab that carries no database of its own is
     given the one Explore would have opened on — the last you looked at, else
     the fullest that is yours rather than ClickHouse's. */
  const databases = useQuery({
    queryKey: ['databases'],
    queryFn: api.databases,
    enabled: mode === 'build',
  })
  useEffect(() => {
    if (mode !== 'build' || !active || active.database || !databases.data) return
    const target = resolveDatabase(databases.data, rememberedDatabase())
    if (target) tabs.patch(active.id, { database: target })
  }, [mode, active, databases.data, tabs])

  /** The table this tab is about, or null when it is about nothing yet.
   *
   *  The form always knows: it is the dataset picker's value. In SQL it is read
   *  off whatever is in the band — the statement being written, not the one that
   *  ran — because the empty state's job is to offer a first question about the
   *  table somebody has already started typing, and `ranSql` is null in exactly
   *  the state that matters. A statement too compound to have one table has
   *  none, and the offers stay away rather than guessing which of the two the
   *  reader meant. */
  const subject = useMemo(() => {
    if (mode === 'build') return spec?.table ?? null
    const text = active?.sql.trim()
    if (!text) return null
    const shaped = shapeOf(text)
    return rewritable(shaped) ? (fromRef(shaped)?.table ?? null) : null
  }, [mode, spec?.table, active?.sql])

  /* The question in words, above the SQL, because the mistake it catches — "by
     city" where you meant "by day" — is invisible in a SELECT and obvious in
     English. The column list is the same one the form reads: React Query hands
     back the one request, not two — and the empty state's first questions read
     it too, which is why this is keyed on the subject rather than on the form's
     own table. */
  const built = useQuery({
    queryKey: ['table', database, subject],
    queryFn: () => api.table(database!, subject!),
    enabled: Boolean(database && subject),
    staleTime: 5 * 60_000,
  })
  const sentence = useMemo(
    () =>
      spec
        ? describeSpec(
            spec,
            (built.data?.columns ?? []).map((c) => ({ name: c.name, type: c.type })),
          )
        : '',
    [spec, built.data],
  )

  const setSpec = useCallback(
    (next: QuerySpec) => {
      if (!active) return
      setRefused(null)
      tabs.patch(active.id, { spec: next })
    },
    [active, tabs],
  )

  /** Ask the question the form is describing.
   *
   *  Through `/api/data`, never through the editor's own endpoint: the document
   *  is what the server reads, and rendering its SQL here to post it back would
   *  be the second query language all over again. The `query_id` is minted the
   *  same way it is for a statement, so Stop stops this too. */
  const runBuilt = useCallback(async () => {
    if (!active || !dsl || active.running) return
    const queryId = crypto.randomUUID()
    tabs.patch(active.id, { running: true, queryId, error: null })
    setAwaiting(null)
    setRefused(null)
    setWhy(null)
    const startedAt = performance.now()
    try {
      const answer = await api.dataset({ ...dsl, query_id: queryId })
      tabs.patch(active.id, {
        running: false,
        queryId: null,
        result: asResult(answer, queryId),
        // The statement the server actually ran, not the one it rendered a
        // moment ago for the strip — they are the same today, and a download
        // built from the wrong one would be nobody's fault and everybody's
        // problem.
        ranSql: answer.sql,
        sql: answer.sql,
        specSql: answer.sql,
        error: null,
        wallMs: performance.now() - startedAt,
      })
    } catch (error) {
      tabs.patch(active.id, {
        running: false,
        queryId: null,
        error,
        wallMs: performance.now() - startedAt,
      })
    }
  }, [active, dsl, tabs])

  const runStatement = useCallback(async () => {
    if (!active || active.running) return
    const view = editor.current?.view
    const caret = view?.state.selection.main
    const selected = caret && !caret.empty ? active.sql.slice(caret.from, caret.to) : null
    const statement = selected ?? statementAt(active.sql, caret?.head ?? active.sql.length)?.sql
    if (!statement?.trim()) return
    await runSql(statement)
  }, [active, runSql])

  /** One Run, whichever face the tab is wearing. Everything that runs from a
   *  keystroke, a button or a rewritten filter comes through here. */
  const run = useCallback(async () => {
    if (mode === 'build') await runBuilt()
    else await runStatement()
  }, [mode, runBuilt, runStatement])

  /* ⌘↵ runs in both modes. In SQL it is a CodeMirror binding, registered at
     high precedence below; the form has no editor to bind it to, so it is a
     window listener for exactly as long as the form is on screen. Same
     shortcut, same meaning — a person should not have to remember which half
     of the page they are on. */
  useEffect(() => {
    if (mode !== 'build') return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      void run()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, run])

  /** The statement the caret is in, or the selection. Everything that acts on
   *  "the query" acts on this. */
  const currentStatement = useCallback(() => {
    if (!active) return null
    const caret = editor.current?.view?.state.selection.main
    if (caret && !caret.empty) {
      return { sql: active.sql.slice(caret.from, caret.to), start: caret.from, end: caret.to }
    }
    return statementAt(active.sql, caret?.head ?? active.sql.length)
  }, [active])

  /** Format through ClickHouse, which knows the whole grammar, and fall back to
   *  the local clause-splitter if the server is too old for `formatQuery`. */
  const format = useCallback(async () => {
    if (!active) return
    const target = currentStatement()
    if (!target?.sql.trim()) return
    let formatted: string
    try {
      formatted = (await api.format(target.sql)).sql
    } catch {
      formatted = formatDdl(target.sql)
    }
    const next = active.sql.slice(0, target.start) + formatted + active.sql.slice(target.end)
    tabs.patch(active.id, { sql: next })
  }, [active, currentStatement, tabs])

  /** Run an EXPLAIN of the current statement. The plan comes back as an
   *  ordinary result set, so it travels the same path as any other query. */
  const explain = useCallback(
    async (kind: ExplainKind) => {
      const target = currentStatement()
      const statement = target?.sql.trim()
      if (!statement) return
      const explainer: Explainer = EXPLAINS[kind]
      const shaped = shapeOf(statement)
      // ClickHouse only explains a SELECT, and what it says otherwise is a
      // syntax error pointing at the second word — which reads as "your SQL is
      // wrong" when the SQL is fine and the question was.
      if (!shaped.isSelect) {
        setExplainNote(null)
        tabs.patch(active!.id, {
          error: new Error(
            `${explainer.label} only works on a SELECT. This statement is something else, and ClickHouse will not explain it.`,
          ),
          result: null,
          ranSql: null,
        })
        return
      }
      // The wrapped form only makes sense for a SELECT, and only where the
      // author has not already had their say about the analyzer.
      const wrappable =
        explainer.wrap !== undefined &&
        shaped.isSelect &&
        !/analyz/i.test(bodyOf(shaped, 'settings'))
      setExplainNote(null)
      if (wrappable) {
        if (await runSql(explainer.wrap!(statement), false)) {
          setExplainNote(explainer.note ?? null)
          return
        }
      }
      if (await runSql(explainer.plain(statement), false)) {
        setExplainNote(wrappable ? (explainer.fallbackNote ?? null) : (explainer.note ?? null))
      }
    },
    [currentStatement, runSql],
  )

  /* ── The statement the grid is showing ──────────────────────────────────
     Not "the statement under the caret": the caret may have moved since the
     query ran, and a header click has to edit the query whose rows are on
     screen. The span is found by looking for that text in the document, which
     survives edits elsewhere in the tab and fails safe — no match, no
     rewriting. */
  const ran = active?.ranSql ?? null
  const shape = useMemo(() => (ran ? shapeOf(ran) : null), [ran])
  const editable = shape !== null && rewritable(shape)

  const ranSpan = useCallback((): { start: number; end: number } | null => {
    if (!active || !ran) return null
    const at = active.sql.indexOf(ran)
    return at === -1 ? null : { start: at, end: at + ran.length }
  }, [active, ran])

  /** Put a rewritten statement back in the document, and run it if the last run
   *  was cheap enough to make that a courtesy rather than a liberty. */
  const rewrite = useCallback(
    (next: string) => {
      if (!active || !ran || next === ran) return
      const span = ranSpan()
      if (!span) return
      const sql = active.sql.slice(0, span.start) + next + active.sql.slice(span.end)
      tabs.patch(active.id, { sql })
      const policy = rerunPolicy(
        active.result
          ? {
              elapsed: active.result.statistics.elapsed,
              bytesRead: active.result.statistics.bytes_read,
            }
          : null,
      )
      if (policy.auto) void runSql(next)
      else {
        // The text has changed and the rows have not. Say so, and say why.
        tabs.patch(active.id, { ranSql: next })
        setAwaiting(policy.why)
      }
    },
    [active, ran, ranSpan, runSql, tabs],
  )

  /** How to order by a result column.
   *
   *  By the select-list expression when the column *is* one — ordering by an
   *  alias that shadows a column name resolves to the wrong thing — and by the
   *  name otherwise, which is what an aliased aggregate needs. */
  const orderRef = useCallback(
    (column: string): string => {
      const item = shape ? (selectItems(shape) ?? []).find((i) => i.resultName === column) : null
      if (item && !item.alias && item.expr !== '*') return item.expr
      return quoteIdent(column)
    },
    [shape],
  )

  const columnNames = useMemo(
    () => (active?.result?.columns ?? []).map((c) => c.name),
    [active?.result],
  )

  /* A gesture on the grid, carried into the form.

     The form has no text to rewrite, so a re-run cannot simply follow the
     statement: the spec changes, React renders, and only then is there a new
     document to post. This flag is that one tick of patience. */
  const rerun = useRef(false)
  useEffect(() => {
    if (!rerun.current || !dsl) return
    rerun.current = false
    void runBuilt()
  }, [dsl, runBuilt])

  /** Apply a spec edit the grid asked for, and re-run it if the last run was
   *  cheap enough to make that a courtesy rather than a liberty — the same
   *  policy, off the same figures, as a rewritten statement. */
  const editSpec = useCallback(
    (edit: ReturnType<typeof filterSpec> | QuerySpec) => {
      if (!active) return
      if ('refused' in edit) {
        setRefused(edit.refused)
        return
      }
      const next = 'spec' in edit ? edit.spec : edit
      setRefused(null)
      tabs.patch(active.id, { spec: next })
      const policy = rerunPolicy(
        active.result
          ? {
              elapsed: active.result.statistics.elapsed,
              bytesRead: active.result.statistics.bytes_read,
            }
          : null,
      )
      if (policy.auto) rerun.current = true
      else setAwaiting(policy.why)
    },
    [active, tabs],
  )

  /** What the grid may do to the form. Every gesture the statement offers, on
   *  the question instead — see `lib/query`, which decides which section of the
   *  form each one lands in. */
  const buildGrid: GridQuery | undefined = useMemo(() => {
    if (mode !== 'build' || !spec || spec.projections.length === 0) return undefined
    return {
      // Not "add to the WHERE": which side of the grouping this lands on is the
      // form's decision, not the clicker's, and `filterSpec` makes it.
      filterLabel: 'Add this filter',
      order: spec.orderings.map((o) => ({ column: o.ref, desc: o.desc })),
      onSort: (column, extend) => editSpec(cycleSpecOrder(spec, column.name, extend)),
      onClearOrder: () => editSpec(clearSpecOrder(spec)),
      onFilter: (column, op, value) => editSpec(filterSpec(spec, column.name, op as Op, value)),
      // The same rule the statement follows: a question that selects one thing
      // cannot be narrowed by dropping it.
      onDrop:
        spec.projections.length > 1
          ? (column) => editSpec(dropSpecColumn(spec, column.name))
          : undefined,
    }
  }, [mode, spec, editSpec])

  /** What the grid may do to the statement. Absent — and every gesture stays
   *  local — when the statement is one this app declines to rewrite. */
  const sqlGrid: GridQuery | undefined = useMemo(() => {
    if (!shape || !editable || !ran) return undefined
    return {
      order: orderTerms(shape).map((term) => ({
        column: term.expr.replace(/`/g, ''),
        desc: term.desc,
      })),
      onSort: (column, extend) => rewrite(cycleOrder(ran, orderRef(column.name), extend)),
      onClearOrder: () => rewrite(clearOrder(ran)),
      onFilter: (column, op, value) => {
        const predicate = cellPredicate(column.name, column.type, op as CellOp, value, literal)
        if (predicate) rewrite(addFilter(ran, predicate))
      },
      // A statement whose select list cannot be narrowed — one bare `count()` —
      // simply does not offer it, rather than offering it and doing nothing.
      onDrop:
        columnNames.length > 1
          ? (column) => rewrite(dropColumn(ran, column.name, columnNames))
          : undefined,
    }
  }, [shape, editable, ran, rewrite, orderRef, columnNames])

  const gridQuery = mode === 'build' ? buildGrid : sqlGrid

  /** Read the plan of the statement whose rows are on screen. */
  const explainWhy = useCallback(async () => {
    if (!ran) return
    setWhyRunning(true)
    try {
      const plan = await api.run({
        sql: `EXPLAIN PLAN indexes = 1 ${ran.trim()}`,
        database,
        query_id: crypto.randomUUID(),
      })
      const text = plan.rows.map((row) => String(row[0] ?? '')).join('\n')
      setWhy({ said: verdicts(readPlan(text)), sql: ran, failed: false })
    } catch {
      // An EXPLAIN the server refuses is not worth an error page over: the
      // statistics it was offered beside are still true.
      setWhy({ said: [], sql: ran, failed: true })
    } finally {
      setWhyRunning(false)
    }
  }, [database, ran])

  const cancel = useCallback(async () => {
    if (!active?.queryId) return
    try {
      await api.cancel(active.queryId)
    } catch (error) {
      tabs.patch(active.id, { error })
    }
  }, [active, tabs])

  // Cmd/Ctrl+Enter runs. Registered at high precedence so CodeMirror's own
  // Enter handling does not swallow it.
  const runKeymap = useMemo(
    () =>
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-Enter',
            preventDefault: true,
            run: () => {
              void run()
              return true
            },
          },
        ]),
      ),
    [run],
  )

  /* The completion reads the live document itself, so this no longer has to be
     rebuilt when the FROM target changes — only when the schema snapshot or the
     database does. */
  const extensions = useMemo(
    () => [
      runKeymap,
      clickhouseSql(),
      flintCompletion({ schema: schema.data ?? [], database }),
      flintTheme,
      flintHighlighting,
    ],
    [runKeymap, schema.data, database],
  )

  /* The rail writes here. Bound while this page is mounted and the view exists;
     unbound on the way out, so a click on a table elsewhere in the app goes back
     to navigating. */
  const { bindWriter } = tabs
  useEffect(() => {
    // Unbound while the form is up. There is no caret to honour then, and the
    // rail sends its clicks to the form instead — see `pickTable`.
    if (!ready || mode !== 'sql') return
    bindWriter({
      read: () => {
        const view = editor.current?.view
        const doc = view?.state.doc.toString() ?? ''
        return { doc, pos: view?.state.selection.main.head ?? doc.length }
      },
      write: (insertion) => {
        const view = editor.current?.view
        if (!view) return
        const caret = insertion.from + (insertion.caret ?? insertion.text.length)
        view.dispatch({
          changes: { from: insertion.from, to: insertion.to, insert: insertion.text },
          selection: { anchor: caret },
          scrollIntoView: true,
        })
        view.focus()
      },
    })
    return () => bindWriter(null)
  }, [bindWriter, ready, mode])

  if (!active) return null

  // A one-line query in a 370px pane is what the editor used to look like:
  // mostly emptiness, with the results squeezed underneath. Follow the content
  // instead, within bounds. The ceiling is deliberately lower than it was — now
  // that the grid can edit the statement, the statement is something you read a
  // line of and the rows are what you look at.
  const lines = active.sql.split('\n').length
  /* The form follows its content now, which it could not when it was five
     columns: a section had a column whether or not anything was in it, so the
     band had to open tall enough for the emptiest possible form and then stayed
     that tall for ever. What the clauses occupy is measured by the form itself
     and handed up — see `onNaturalHeight`.

     The floor is the column palette's: a one-clause question would otherwise
     squeeze the pane the picking happens in down to a line. The ceiling is a bit
     under half the window — past that the form is eating the answer, and the
     grip is there for anybody who genuinely wants that. */
  const autoHeight =
    mode === 'build'
      ? Math.min(
          Math.max(formHeight ?? 214, 196),
          Math.max(260, window.innerHeight * 0.44),
        )
      : Math.min(Math.max(window.innerHeight * 0.32, 170), Math.max(96, lines * 21.5 + 22))

  return (
    <section className="editor">
      {/* Three zones, and the order is the sentence: *where* you are asking,
          *how* you are asking, *what happens now*. Before this the bar was nine
          controls of equal weight in one row, so Run — the only one anybody
          presses on purpose — was the same size and the same colour as
          Settings. Now the spark is spent once, on the act, and the drawers sit
          at the far end as one quiet group of one-at-a-time. */}
      <div className="editor__bar">
        <div className="editor__where">
          <DatabasePicker
            value={database}
            onChange={(next) => tabs.patch(active.id, { database: next })}
          />

          <ModeSwitch
            tab={active}
            onSwitch={(next, allowed) => {
              tabs.setMode(active.id, next, allowed.ok ? allowed.spec : undefined)
              setCarried(
                next === 'build' && allowed.ok && allowed.dropped?.length
                  ? { tab: active.id, dropped: allowed.dropped }
                  : null,
              )
            }}
          />
        </div>

        {/* The act, and the two things you do *to a statement* before you run
            it. Joined into one cluster rather than spaced out as peers: Format
            and Explain are about the query in the band above, and Run is what
            they are in aid of. */}
        <div className="editor__act">
          {active.running ? (
            <button className="btn btn--stop" onClick={cancel}>
              <span className="btn__dot" aria-hidden="true" />
              Stop
            </button>
          ) : (
            <button
              className="btn btn--spark btn--run"
              onClick={() => void run()}
              disabled={mode === 'build' && !dsl}
              title={mode === 'build' && blocked ? blocked : 'Run the statement — ⌘↵'}
            >
              <span className="btn__play" aria-hidden="true" />
              Run <span className="kbd">⌘↵</span>
            </button>
          )}
          {/* Nothing to format in a generated statement: the server writes it,
              and this button would tidy something the next keystroke rewrites. */}
          {mode === 'sql' ? (
            <button
              className="btn btn--soft"
              onClick={() => void format()}
              disabled={active.running}
            >
              Format
            </button>
          ) : null}
          <label className="editor__pick">
            <select
              className="btn btn--soft btn--select"
              value=""
              onChange={(e) => {
                const kind = e.target.value as ExplainKind
                e.currentTarget.value = ''
                if (kind) void explain(kind)
              }}
              disabled={active.running}
              aria-label="Explain the statement"
            >
              <option value="">Explain…</option>
              {(Object.keys(EXPLAINS) as ExplainKind[]).map((k) => (
                <option key={k} value={k}>
                  {EXPLAINS[k].label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="editor__spacer" />

        {/* Sending rather than retyping: a statement retyped on another page
            is a statement that will differ from the one that was tested. */}
        <label className="editor__pick">
          <select
            className="btn btn--soft btn--select"
            value=""
            onChange={(e) => {
              const to = e.target.value as Destination | ''
              if (!to) return
              navigate(
                handoffPath(to, {
                  sql: currentStatement()?.sql ?? active.sql,
                  database: database ?? '',
                  name: active.title || '',
                }),
              )
            }}
            disabled={!active.sql.trim()}
            aria-label="Send this statement somewhere that keeps it"
            title={
              active.sql.trim()
                ? 'Turn this statement into an alert, a report or an API'
                : 'Write something first'
            }
          >
            <option value="">Send to…</option>
            {DESTINATIONS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>

        {/* The four drawers, as one group of one-at-a-time — which is what the
            render has always done and what the four separate toggles denied.
            Quieter than the act on purpose: opening a drawer is not asking a
            question, and on the page where asking is the point these had been
            shouting as loudly as Run. */}
        <div className="segmented" role="group" aria-label="Panels under the result">
          {DRAWERS.map((d) => {
            const off = d.id === 'dashboards' && !active.result
            return (
              <button
                key={d.id}
                className={`segmented__item${panel === d.id ? ' is-on' : ''}`}
                onClick={() => toggle(d.id)}
                aria-pressed={panel === d.id}
                disabled={off}
                title={off ? 'Run something first' : d.hint}
                type="button"
              >
                {d.label}
              </button>
            )
          })}
        </div>
      </div>

      <TabStrip />

      {/* The one place the two faces differ. Same band, same height, same grip
          under it — so the switch above reads as a switch and not as a second
          page that happens to look similar. */}
      <div
        className={`editor__code${mode === 'build' ? ' editor__code--build' : ''}`}
        style={{ flex: `0 0 ${codeHeight ?? autoHeight}px` }}
      >
        {mode === 'build' ? (
          active.spec ? (
            <BuildPane
              spec={active.spec}
              onChange={setSpec}
              database={database}
              onNaturalHeight={setFormHeight}
            />
          ) : (
            <Loading label="Opening the form" />
          )
        ) : (
        <CodeMirror
          ref={editor}
          value={active.sql}
          height="100%"
          // `@uiw/react-codemirror` ships a light theme by default and it wins
          // over ours, which put near-white text on a white ground in dark
          // mode. Flint dresses the editor entirely from its own tokens.
          theme="none"
          basicSetup={{
            lineNumbers: true,
            foldGutter: false,
            highlightActiveLine: true,
            // Off here, on in `extensions`: two `autocompletion()` instances
            // would race to say what belongs at the caret.
            autocompletion: false,
            bracketMatching: true,
            closeBrackets: true,
          }}
          extensions={extensions}
          onCreateEditor={() => setReady(true)}
          onChange={(sql) => tabs.patch(active.id, { sql })}
          placeholder="SELECT … — ⌘↵ runs the statement under the caret"
        />
        )}
      </div>

      {/* Drag to size the editor, double-click to let it follow the content
          again. */}
      <div
        className="editor__grip"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the editor"
        tabIndex={0}
        onDoubleClick={() => setCodeHeight(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') setCodeHeight((h) => Math.max(132, (h ?? autoHeight) - 24))
          if (e.key === 'ArrowDown') setCodeHeight((h) => Math.min(window.innerHeight * 0.7, (h ?? autoHeight) + 24))
        }}
        onPointerDown={(e) => {
          const start = e.clientY
          const from = codeHeight ?? autoHeight
          const el = e.currentTarget
          el.setPointerCapture(e.pointerId)
          const move = (ev: PointerEvent) =>
            setCodeHeight(
              Math.min(window.innerHeight * 0.7, Math.max(96, from + ev.clientY - start)),
            )
          const up = () => {
            el.releasePointerCapture(e.pointerId)
            el.removeEventListener('pointermove', move)
            el.removeEventListener('pointerup', up)
          }
          el.addEventListener('pointermove', move)
          el.addEventListener('pointerup', up)
        }}
      />

      {/* What is about to run, said in the slot where the statement's own
          clauses are said. In SQL that is a row of chips you can take back; in
          the form it is the sentence and the statement the form produced —
          which the brief asks to be on screen always, so nobody has to trust a
          generated query blindly. */}
      {mode === 'build' ? (
        <BuiltStrip
          sentence={sentence}
          sql={active.sql}
          blocked={blocked}
          limit={active.spec?.limit ?? 0}
          pending={explained.isFetching}
          error={explained.error}
          carried={carried?.tab === active.id ? carried.dropped : null}
          onDismissCarried={() => setCarried(null)}
        />
      ) : active.result && shape && ran ? (
        <QueryStrip
          shape={shape}
          sql={ran}
          editable={editable}
          database={database}
          resultColumns={columnNames}
          onRewrite={rewrite}
        />
      ) : null}

      {/* A gesture the form could not carry. Said between the question and
          the answer, because that is what it is about: the question did not
          change, so the answer below has not either. For exactly as long as it
          is true — a click that quietly does nothing is the one that stops
          people trusting the ones that work. */}
      {refused ? <p className="editor__refused">{refused}</p> : null}

      {/* ── The answer ────────────────────────────────────────────────────
          One block, with the figures as its head.

          The figures used to be a strip of their own, above the clauses, above
          the result — so the page read: question, *how the answer went*,
          question again, answer. Four bands, two of them about the query and
          two about its answer, interleaved. Now the composing band and the
          clauses belong to the question, and everything that describes what
          came back — how many rows, how long, why it read so much, and the rows
          themselves — is one surface underneath. Two things on the page instead
          of six, and the reader's eye has somewhere to land. */}
      <div className={`answer${active.running ? ' is-running' : ''}`}>
        <StatsStrip
          running={active.running}
          result={active.result}
          error={active.error}
          wallMs={active.wallMs}
          maxRows={config.data?.max_result_rows}
          awaiting={awaiting}
          mode={mode}
        />

        {/* Why a large read was large — offered on the figures, never on a guess
            about what the query meant, and never at the cost of the rows. */}
        {active.result && ran && worthExplaining(active.result.statistics.bytes_read) ? (
          <div className="whystrip">
            {why && why.sql === ran ? (
              why.said.length > 0 ? (
                <ul className="planread">
                  {why.said.map((verdict) => (
                    <li className={`planread__v planread__v--${verdict.tone}`} key={verdict.text}>
                      <span className="planread__text">{verdict.text}</span>
                      {verdict.evidence ? (
                        <span className="planread__ev num">{verdict.evidence}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="bhint">
                  {why.failed
                    ? 'The server would not explain this statement, so there is nothing to add to the figures above.'
                    : 'The plan has nothing to add: this read had no parts or granules to skip, so the figures above are the whole story.'}
                </p>
              )
            ) : (
              <button className="whystrip__ask" onClick={() => void explainWhy()} type="button">
                {whyRunning
                  ? 'Reading the plan…'
                  : `It read ${bytes(active.result.statistics.bytes_read)} — why?`}
              </button>
            )}
          </div>
        ) : null}

          <div className="answer__body">
          {panel === 'dashboards' ? (
            <DashPanel
              sql={currentStatement()?.sql ?? active.sql}
              database={database ?? ''}
              chart={active.chart}
              suggestedTitle={active.title || 'Untitled'}
              workspace={config.data?.workspace ?? null}
              onClose={() => setPanel(null)}
            />
          ) : panel === 'saved' ? (
            <SavedPanel
              currentSql={active.sql}
              currentDatabase={database ?? ''}
              suggestedName={active.title || 'Untitled query'}
              workspace={config.data?.workspace ?? null}
              onClose={() => setPanel(null)}
              onLoad={(q) => {
                tabs.openWith(q.sql, q.database)
                setPanel(null)
              }}
            />
          ) : panel === 'settings' ? (
            <SettingsPanel config={config.data} onClose={() => setPanel(null)} />
          ) : panel === 'history' ? (
            <HistoryPanel
              onClose={() => setPanel(null)}
              onPick={(sql) => {
                // A statement out of the history is a statement, whatever this
                // tab was showing: nothing reads it back into a form, so the tab
                // turns over with it rather than holding a form its SQL no longer
                // matches. The form stays on the tab — it is one Escape back.
                tabs.patch(active.id, { sql, mode: 'sql' })
                setPanel(null)
              }}
            />
          ) : active.error ? (
            <ErrorNote error={active.error} />
          ) : active.result ? (
            active.result.kind === 'command' ? (
              <EmptyNote title="Statement executed">
                This statement returned no rows.
              </EmptyNote>
            ) : active.result.rows.length === 0 ? (
              <EmptyNote title="No rows matched">
                The query ran and came back empty. Loosen the WHERE clause and run it again.
              </EmptyNote>
            ) : isPlan(active.result) ? (
              <PlanView
                text={active.result.rows.map((r) => String(r[0] ?? '')).join('\n')}
                note={explainNote}
              />
            ) : (
              <ResultView
                /* Keyed by tab so the chart and the analyses panel belong to the
                   question they were opened on. Without it React keeps one
                   instance across a tab switch, and the form you picked for one
                   result describes another result's columns. */
                key={active.id}
                result={active.result}
                chosenKind={active.chart?.kind ?? null}
                onChartChange={(chart) => tabs.patch(active.id, { chart })}
                query={gridQuery}
                /* `ranSql`, not what is in the editor now. The file has to be the
                   result on screen — a reader who typed three more characters
                   after running would otherwise download an answer to a question
                   they never asked, and nothing would say so. */
                download={ran ? downloadFor(mode, ran, active.spec, database, active.title) : undefined}
              />
            )
          ) : (
            /* Nothing has run in this tab. Offered rather than explained — see
               `StartHere`. A statement picked here goes into the tab *and* runs,
               because the card it was pressed on says it will; and the tab turns
               over to SQL with it, because nothing reads a statement back into a
               form and a form holding somebody else's SQL is the mode switch
               that eats your work. */
            <StartHere
              database={database}
              table={subject}
              columns={built.data?.columns ?? []}
              onRun={(sql) => {
                tabs.patch(active.id, { sql, mode: 'sql' })
                void runSql(sql)
              }}
              hint={
                mode === 'build'
                  ? 'pick a column or two in the form above and press ⌘↵ — the statement in between is exactly what gets sent.'
                  : 'write a statement above and press ⌘↵. Only the statement under the caret runs, so one tab holds a scratchpad of them.'
              }
            />
          )}
        </div>
      </div>
    </section>
  )
}

/** Which face this tab wears, and whether it may change.
 *
 *  Two buttons rather than a checkbox, because there are two named things here
 *  and neither is the negation of the other. The direction that cannot be taken
 *  is disabled and carries its reason — see `canSwitch`, which owns the rule. A
 *  control that is simply missing teaches nothing; one that says "the statement
 *  has been edited since the form wrote it" teaches the whole design in a
 *  sentence. */
function ModeSwitch({
  tab,
  onSwitch,
}: {
  tab: QueryTab
  onSwitch: (mode: TabMode, allowed: Switchable) => void
}) {
  /* Reading a statement is a parse, and this renders on every keystroke in the
     editor. Once per statement, not once per character. */
  const readings = useMemo(
    () => ({ build: canSwitch(tab, 'build'), sql: canSwitch(tab, 'sql') }) as Record<TabMode, Switchable>,
    [tab],
  )

  return (
    <div className="segmented" role="group" aria-label="How to ask this question">
      {MODES.map(({ id, label, hint }) => {
        const allowed = readings[id]
        const on = tab.mode === id
        return (
          <button
            key={id}
            className={`segmented__item${on ? ' is-on' : ''}`}
            aria-pressed={on}
            disabled={!allowed.ok}
            title={allowed.ok ? (allowed.dropped?.length ? carriedTitle(allowed.dropped, hint) : hint) : allowed.why}
            onClick={() => onSwitch(id, allowed)}
            type="button"
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

/** The tooltip on a switch that will work but will not carry everything. The
 *  count leads, because the count is what decides whether to click. */
function carriedTitle(dropped: string[], hint: string): string {
  const n = dropped.length
  return `${hint} ${n} thing${n === 1 ? '' : 's'} in this statement ${
    n === 1 ? 'has' : 'have'
  } no place in the form and will be dropped — the switch says which.`
}

/** The drawers that can be open under the result. One at a time — see
 *  `panel`. */
type Panel = 'dashboards' | 'saved' | 'settings' | 'history'

const DRAWERS: { id: Panel; label: string; hint: string }[] = [
  { id: 'saved', label: 'Saved', hint: 'Statements this workspace keeps' },
  { id: 'history', label: 'History', hint: 'What this server has been asked lately' },
  { id: 'dashboards', label: 'Dashboards', hint: 'Add this result to a dashboard' },
  { id: 'settings', label: 'Settings', hint: 'What Flint sends with every statement' },
]

const MODES: { id: TabMode; label: string; hint: string }[] = [
  { id: 'build', label: 'Form', hint: 'Ask without writing SQL. The statement is generated and shown.' },
  { id: 'sql', label: 'SQL', hint: 'Write the statement yourself.' },
]

/** What a download will hand over, which is a different fact in each mode.
 *
 *  In SQL the statement is the whole truth and the note reads the result. A
 *  generated statement carries one figure nobody typed — the row past the page,
 *  which is how the answer knows there is more behind it — and exporting that
 *  row would hand over a file with one more line than the question asked for.
 *  So the form's limit is put back before the statement leaves, and the note
 *  names the limit rather than the rows that happened to come back. */
function downloadFor(
  mode: TabMode,
  ran: string,
  spec: QuerySpec | null,
  database: string | undefined,
  stem: string,
): { sql: string; database?: string; stem?: string; note?: string } {
  if (mode !== 'build' || !spec) return { sql: ran, database, stem }
  return {
    sql: setLimit(ran, spec.limit),
    database,
    stem,
    note: builtDownloadNote(spec.limit),
  }
}

/** The statement the form is about to send, and the sentence it says.
 *
 *  It sits where the SQL tab's clause chips sit, and it is deliberately not
 *  editable: this text is regenerated on every change to the form, so an edit
 *  here would be lost on the next keystroke without a word. The way to take it
 *  over is the switch above, which keeps it.
 *
 *  **Open by default, and closable.** The brief is explicit that the generated
 *  statement should be on screen rather than hidden, so that is where a first
 *  visit finds it — the whole argument for a form that stays close to SQL is
 *  that you can read what it wrote. But it is also six lines of vertical space
 *  taken from the answer, on the page where the answer is the point, and the
 *  sentence above it already carries the reading that catches a wrong grouping.
 *  So somebody who has learned to trust it can fold it away, and the choice is
 *  remembered. The sentence never folds: a question with nothing on screen
 *  saying what it asks is the thing this strip exists to prevent. */
function BuiltStrip({
  sentence,
  sql,
  blocked,
  limit,
  pending,
  error,
  carried,
  onDismissCarried,
}: {
  sentence: string
  sql: string
  blocked: string | null
  limit: number
  pending: boolean
  error: unknown
  /** What the statement this form was read out of said, and the form cannot.
   *  Null when the form was not read out of anything. */
  carried: string[] | null
  onDismissCarried: () => void
}) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem('flint.builtSql') !== 'closed'
    } catch {
      /* private browsing, blocked storage — the default is the promise */
      return true
    }
  })
  const toggle = () => {
    setOpen((was) => {
      try {
        localStorage.setItem('flint.builtSql', was ? 'closed' : 'open')
      } catch {
        /* nothing to do: the fold still holds for this session */
      }
      return !was
    })
  }

  return (
    <div className={`builtstrip${open ? '' : ' is-folded'}`}>
      {/* Read out of a statement, and not all of it fitted.
          
          Above the sentence rather than below the SQL: the sentence is the
          question as it now stands, and reading it without knowing what fell
          out of it on the way in is exactly the misreading this says out loud.
          Dismissible, because it is about a translation that already happened
          and stops being news the moment it has been read. */}
      {carried && carried.length > 0 ? (
        <div className="builtstrip__carried" role="status">
          <p className="builtstrip__carriedhead">
            <span>
              Read from the statement. {carried.length}{' '}
              {carried.length === 1 ? 'thing' : 'things'} could not come with it:
            </span>
            <button
              className="builtstrip__fold"
              onClick={onDismissCarried}
              title="Dismiss — the SQL below is what the form will send"
              type="button"
            >
              Dismiss
            </button>
          </p>
          <ul className="builtstrip__carriedlist">
            {carried.map((said) => (
              <li key={said}>{said}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="builtstrip__says">
        <span className="label">{blocked ? 'not yet a question' : 'asking'}</span>
        <span className="builtstrip__sentence">{blocked ?? sentence}</span>
        {blocked ? null : (
          <button
            className="builtstrip__fold"
            onClick={toggle}
            aria-expanded={open}
            title={open ? 'Fold the generated statement away' : 'Show the statement this will send'}
            type="button"
          >
            SQL <span aria-hidden="true">{open ? '▾' : '▸'}</span>
          </button>
        )}
      </p>
      {error ? (
        <ErrorNote error={error} />
      ) : blocked || !open ? null : (
        <>
          <pre className={`code code--wrap builtstrip__sql${pending ? ' is-stale' : ''}`}>{sql}</pre>
          {/* The one figure in there that nobody typed. Said here rather than
              left to look like an off-by-one — and only where the figure is,
              which is inside the fold with the statement it belongs to. */}
          {limit > 0 && sql.includes(`LIMIT ${limit + 1}`) ? (
            <p className="builtstrip__note mono-dim">
              One row past your {limit}: it is how the answer knows whether there is more behind
              it, and it is dropped before you see it.
            </p>
          ) : null}
        </>
      )}
    </div>
  )
}

/** The query, as a row of things you can take back.
 *
 *  Every gesture on this page that edits the SQL — a header click, a cell
 *  filter, a top value in the analyses panel — adds a clause to a statement the
 *  reader may not be looking at. Without this strip the page would be doing
 *  arithmetic behind their back: the rows change, and *why* they changed is four
 *  lines up in a text editor they were not reading.
 *
 *  So this states the query as a sentence of removable parts. Each chip is one
 *  clause of the statement, in the order SQL writes them, and each one can be
 *  undone where it is. It is not a second model of the query — every chip is read
 *  from the statement on each render and every × writes back to it.
 */
function QueryStrip({
  shape,
  sql,
  editable,
  database,
  resultColumns,
  onRewrite,
}: {
  shape: import('../lib/rewrite').Shape
  sql: string
  editable: boolean
  database: string | undefined
  resultColumns: string[]
  onRewrite: (next: string) => void
}) {
  const ref = fromRef(shape)
  if (!editable || !ref) {
    return (
      <div className="qstrip qstrip--closed">
        <span className="qstrip__note">
          {shape.compound
            ? 'A statement with a UNION in it is read-only here — its clauses belong to more than one SELECT. The editor above still runs it.'
            : shape.isSelect
              ? 'This statement reads something other than a plain table, so the grid leaves its clauses alone. The editor above still runs it.'
              : 'Only a SELECT can be edited from the grid. The editor above still runs this.'}
        </span>
      </div>
    )
  }

  const prewhere = whereTerms(shape, 'prewhere')
  const where = whereTerms(shape)
  const group = groupTerms(shape)
  const having = whereTerms(shape, 'having')
  const order = orderTerms(shape)
  const limit = Number(bodyOf(shape, 'limit'))
  const skipped = untouched(shape)

  return (
    <div className="qstrip">
      <span className="qstrip__key label">from</span>
      <span className="qstrip__from">
        {ref.database ? `${ref.database}.` : ''}
        {ref.table}
      </span>

      <SelectChip
        shape={shape}
        sql={sql}
        database={ref.database ?? database}
        table={ref.table}
        resultColumns={resultColumns}
        onRewrite={onRewrite}
      />

      {/* Not a chip: removing the DISTINCT would change the row count, which is
          not what anybody clicking around a strip of filters expects. Stated
          because nothing else on the page reveals it. */}
      {isDistinct(shape) ? (
        <span className="qstrip__flag" title="Only distinct rows are returned">
          distinct
        </span>
      ) : null}

      {prewhere.length > 0 ? (
        <>
          <span
            className="qstrip__key label"
            title="Filtered before the other columns are read — ClickHouse’s own trick for a wide table"
          >
            prewhere
          </span>
          {prewhere.map((term) => (
            <Chip
              key={term.start}
              label={term.text}
              title={`Take ${term.text} out of the PREWHERE`}
              onRemove={() => onRewrite(removeTerm(sql, term, 'prewhere'))}
            />
          ))}
        </>
      ) : null}

      {where.length > 0 ? (
        <>
          <span className="qstrip__key label">where</span>
          {where.map((term) => (
            <Chip
              key={term.start}
              label={term.text}
              title={`Take ${term.text} out of the WHERE`}
              onRemove={() => onRewrite(removeTerm(sql, term))}
            />
          ))}
        </>
      ) : null}

      {group.terms.length > 0 ? (
        <>
          <span className="qstrip__key label">by</span>
          {group.terms.map((term) => (
            <Chip
              key={term.start}
              label={term.text}
              title={`Stop grouping by ${term.text}`}
              onRemove={() => onRewrite(removeGroupTerm(sql, term.text))}
            />
          ))}
          {/* Shown, never removable: WITH TOTALS modifies the grouping rather
              than adding to it. */}
          {group.modifier ? (
            <span className="qstrip__flag" title="One extra row for the whole set">
              {group.modifier.toLowerCase()}
            </span>
          ) : null}
        </>
      ) : null}

      {having.length > 0 ? (
        <>
          <span
            className="qstrip__key label"
            title="Applied after the grouping, so it can filter an aggregate"
          >
            having
          </span>
          {having.map((term) => (
            <Chip
              key={term.start}
              label={term.text}
              title={`Take ${term.text} out of the HAVING`}
              onRemove={() => onRewrite(removeTerm(sql, term, 'having'))}
            />
          ))}
        </>
      ) : null}

      {order.length > 0 ? (
        <>
          <span className="qstrip__key label">order</span>
          {order.map((term) => (
            <Chip
              key={term.expr}
              label={`${term.expr}${term.desc ? ' ↓' : ' ↑'}`}
              title={`Stop ordering by ${term.expr}`}
              onRemove={() => onRewrite(removeOrderTerm(sql, term.expr))}
            />
          ))}
        </>
      ) : null}

      <label className="qstrip__limit">
        <span className="label">limit</span>
        <select
          className="picker__select"
          value={Number.isFinite(limit) && limit > 0 ? String(limit) : ''}
          onChange={(event) => onRewrite(setLimit(sql, Number(event.target.value)))}
          aria-label="How many rows to ask for"
        >
          {/* The statement's own cap is always an option, even an odd one:
              a picker that silently rounds 250 to 500 is a picker that edits
              your query for having opened it. */}
          {LIMITS.includes(limit) ? null : (
            <option value={String(limit)}>{Number.isFinite(limit) && limit > 0 ? limit : 'none'}</option>
          )}
          {LIMITS.map((n) => (
            <option key={n} value={String(n)}>
              {n}
            </option>
          ))}
          <option value="0">none</option>
        </select>
      </label>

      {/* The clauses this strip cannot act on, named rather than skipped: a
          sentence that reads the query back has to admit the words it left
          out. */}
      {skipped.length > 0 ? (
        <span
          className="qstrip__skipped"
          title="This strip does not edit these — the editor above does"
        >
          also {skipped.map((name) => SKIPPED_LABEL[name]).join(', ')}
        </span>
      ) : null}
    </div>
  )
}

const SKIPPED_LABEL: Partial<Record<import('../lib/rewrite').ClauseName, string>> = {
  with: 'a WITH',
  offset: 'an OFFSET',
  settings: 'SETTINGS',
  format: 'a FORMAT',
}

const LIMITS = [100, 500, 1000, 10_000]

function Chip({
  label,
  title,
  onRemove,
}: {
  label: string
  title: string
  onRemove: () => void
}) {
  return (
    <span className="qchip">
      <span className="qchip__text" title={label}>
        {label}
      </span>
      <button className="qchip__x" onClick={onRemove} title={title} aria-label={title} type="button">
        ×
      </button>
    </span>
  )
}

/** The columns the query asks for, and the ones it could.
 *
 *  This is the chip that answers "give me these four fields of this table"
 *  without writing them out: it lists the table's columns, ticks the ones the
 *  select list names, and rewrites the list when one is toggled. Reading a
 *  `SELECT *` back as "all of them" is safe here because the result's own column
 *  list *is* what the star expanded to.
 *
 *  It steps aside for a select list it cannot represent. `SELECT host,
 *  count()` is not a subset of the table's columns, and a tick-list that
 *  pretended otherwise would drop the aggregate the moment anybody used it. */
function SelectChip({
  shape,
  sql,
  database,
  table,
  resultColumns,
  onRewrite,
}: {
  shape: import('../lib/rewrite').Shape
  sql: string
  database: string | undefined
  table: string
  resultColumns: string[]
  onRewrite: (next: string) => void
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  const detail = useQuery({
    queryKey: ['table', database, table],
    queryFn: () => api.table(database!, table),
    enabled: open && Boolean(database),
    staleTime: 5 * 60_000,
  })

  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const items = selectItems(shape) ?? []
  const star = items.length === 1 && items[0]!.expr === '*'
  const named = items.map((item) => item.resultName)
  const plain = star || named.every((name) => name !== null)
  const chosen = new Set(star ? resultColumns : named.filter((n): n is string => n !== null))

  const all = detail.data?.columns.map((c) => ({ name: c.name, type: c.type })) ?? []

  const toggle = (name: string) => {
    const next = new Set(chosen)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    // The last column stays: a SELECT with nothing in it is not a narrower
    // query, it is a syntax error.
    if (next.size === 0) return
    const ordered = all.filter((column) => next.has(column.name)).map((column) => column.name)
    if (ordered.length === 0) return
    onRewrite(
      ordered.length === all.length
        ? setSelectList(sql, ['*'])
        : setSelectList(sql, ordered.map(quoteIdent)),
    )
  }

  if (!plain) {
    return (
      <>
        <span className="qstrip__key label">select</span>
        <span className="qstrip__from" title={items.map((i) => i.text).join(', ')}>
          {items.length} {items.length === 1 ? 'expression' : 'expressions'}
        </span>
      </>
    )
  }

  return (
    <>
      <span className="qstrip__key label">select</span>
      {/* Naming the columns is worth one click of its own.
 
          A star is the fastest thing to type and the worst thing to keep: on a
          columnar store the columns you do not name are the ones you do not pay
          for, and a named list is also what makes every other affordance on this
          page possible — you cannot drop a column out of a `*`. The expansion
          uses the result's own column list, which *is* what the star meant on
          the last run, so this needs nothing from the server. */}
      {star && resultColumns.length > 0 ? (
        <button
          className="qchip qchip--button"
          onClick={() => onRewrite(setSelectList(sql, resultColumns.map(quoteIdent)))}
          title={`Write the ${resultColumns.length} columns out, so the query names what it reads`}
          type="button"
        >
          expand ★
        </button>
      ) : null}
      <div className="qstrip__pick" ref={box}>
        <button
          className={`qchip qchip--button${open ? ' is-on' : ''}`}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          title="Which of this table’s columns the query asks for"
          type="button"
        >
          {star ? `all ${resultColumns.length}` : `${chosen.size} of this table’s columns`}
        </button>
        {open ? (
          <div className="selpick" role="group" aria-label={`Columns of ${table} to select`}>
            {detail.isPending ? <p className="bhint">Reading the column list…</p> : null}
            {detail.error ? <ErrorNote error={detail.error} /> : null}
            {all.length > 0 ? (
              <div className="selpick__list">
                {all.map((column) => (
                  <label className="selpick__item" key={column.name}>
                    <input
                      type="checkbox"
                      checked={chosen.has(column.name)}
                      onChange={() => toggle(column.name)}
                    />
                    <TypeIcon type={column.type} />
                    <span className="selpick__name">{column.name}</span>
                  </label>
                ))}
              </div>
            ) : null}
            {all.length > 0 ? (
              <p className="bhint">
                Unticking one takes it out of the SELECT, so the server stops reading it.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  )
}

interface Explainer {
  label: string
  /** The plain form, which every server understands. */
  plain: (sql: string) => string
  /** A better form to try first, when there is one. */
  wrap?: (sql: string) => string
  /** What the answer on screen is, when the plain reading of it would mislead. */
  note?: string
  /** What it is instead, when `wrap` was refused by the server. */
  fallbackNote?: string
}

/** A plan, read back as statements and then printed in full.
 *
 *  The figures are already in the text — parts and granules against the totals,
 *  which index pruned, the PREWHERE the server chose, which side a join builds.
 *  Nobody reads them out of forty lines of box drawing, so `lib/plan` does the
 *  arithmetic and this puts the sentences above the text rather than instead of
 *  it: the plan stays, because a verdict somebody cannot check is a verdict they
 *  have to take on faith. */
function PlanView({ text, note }: { text: string; note: string | null }) {
  const said = useMemo(() => verdicts(readPlan(text)), [text])
  return (
    <div className="planview">
      {note ? <p className="planview__note">{note}</p> : null}
      {said.length > 0 ? (
        <ul className="planread">
          {said.map((verdict) => (
            <li className={`planread__v planread__v--${verdict.tone}`} key={verdict.text}>
              <span className="planread__text">{verdict.text}</span>
              {verdict.evidence ? (
                <span className="planread__ev num">{verdict.evidence}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <pre className="code code--wrap plan">{text}</pre>
    </div>
  )
}

/** The EXPLAIN family, in the order they are useful: what it will do, how it
 *  will do it, how much it thinks it will read, how it read your SQL.
 *
 *  `Rewritten SQL` needs the wrapper, and the reason is worth writing down.
 *  Since the new analyzer became the default, `EXPLAIN SYNTAX` prints your query
 *  back at you almost unchanged — the rewriting it used to show (a `*` expanded
 *  into real columns, constants folded, predicates moved) now happens in the
 *  query tree instead. The pass that answers "what did ClickHouse turn my SQL
 *  into" still exists, behind `enable_analyzer = 0`, and the only way to ask for
 *  it without that setting appearing in the answer is to put it on a wrapper
 *  query: `viewExplain` runs the EXPLAIN as a table function, so the setting
 *  belongs to the wrapper and the output is nothing but the rewritten SQL.
 *
 *  On a server where that setting does not exist the wrapper fails, the plain
 *  form runs instead, and the note says which one you are reading. */
const EXPLAINS = {
  plan: { label: 'Plan (with indexes)', plain: (sql) => `EXPLAIN PLAN indexes = 1 ${sql}` },
  pipeline: { label: 'Pipeline', plain: (sql) => `EXPLAIN PIPELINE ${sql}` },
  estimate: { label: 'Estimate', plain: (sql) => `EXPLAIN ESTIMATE ${sql}` },
  syntax: {
    label: 'Rewritten SQL',
    wrap: (sql) =>
      `SELECT * FROM viewExplain('EXPLAIN SYNTAX', '', (${sql}))\nSETTINGS enable_analyzer = 0`,
    plain: (sql) => `EXPLAIN SYNTAX ${sql}`,
    note: 'How the pre-analyzer pass rewrites your SQL — the one that expands `*` into real columns, folds constants and moves predicates. The current analyzer does this in the query tree instead, so this is a reading of your query rather than the plan that will run.',
    fallbackNote:
      'This server would not answer for the older analyzer, so this is the current one — which mostly prints your query back. Try the query tree for what it actually resolved to.',
  },
  tree: {
    label: 'Query tree',
    plain: (sql) => `EXPLAIN QUERY TREE ${sql}`,
    note: 'The analyzer’s own resolution: every column it worked out, with the type it gave it.',
  },
  // `satisfies` rather than an annotation, so the keys stay the five literals
  // the picker walks and every entry is still checked against the shape.
} satisfies Record<string, Explainer>

type ExplainKind = keyof typeof EXPLAINS

/** An EXPLAIN plan comes back as one String column called `explain`. It is a
 *  tree, so it belongs in a <pre>, not in a grid one line tall. `ESTIMATE`
 *  returns a real table and goes to the grid like anything else. */
function isPlan(result: QueryResult): boolean {
  return result.columns.length === 1 && result.columns[0]?.name === 'explain'
}

function SettingsPanel({
  config,
  onClose,
}: {
  config: AppConfig | undefined
  onClose: () => void
}) {
  // The server's own non-default settings, which explain behaviour Flint does
  // not control.
  const changed = useQuery({
    queryKey: ['changed-settings'],
    queryFn: () =>
      api.run({
        sql:
          'SELECT name, value, description FROM system.settings ' +
          'WHERE changed ORDER BY name LIMIT 200',
      }),
    staleTime: 60_000,
  })

  return (
    <section className="history">
      <header className="history__head">
        <h3 className="history__title">Settings</h3>
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="history__body">
        <h4 className="setgroup">Sent with every statement</h4>
        <table className="settbl">
          <tbody>
            {Object.entries(config?.query_settings ?? {}).map(([k, v]) => (
              <tr key={k}>
                <td className="settbl__k">{k}</td>
                <td className="settbl__v">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="bhint">
          `max_result_rows` is one past the cap on purpose: it is how Flint knows whether more
          rows exist behind the ones it shows.
        </p>

        <h4 className="setgroup">Changed on the server</h4>
        {changed.error ? <ErrorNote error={changed.error} /> : null}
        {changed.data && changed.data.rows.length === 0 ? (
          <p className="bhint">Every setting is at its default.</p>
        ) : null}
        {changed.data && changed.data.rows.length > 0 ? (
          <table className="settbl">
            <tbody>
              {changed.data.rows.map((r) => (
                <tr key={String(r[0])}>
                  <td className="settbl__k" title={String(r[2] ?? '')}>
                    {String(r[0])}
                  </td>
                  <td className="settbl__v">{String(r[1])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </section>
  )
}

/** The open questions.
 *
 *  A tab says which face it wears, because the strip is how somebody finds the
 *  one they were working in and "the form on system.query_log" and "the SQL on
 *  system.query_log" are two different tabs with the same name. The mark is
 *  read out too — a glyph nobody can hear is a distinction only sighted readers
 *  get. */
/** The tabs, as a tablist that behaves like one.
 *
 *  It has carried `role="tablist"` since it was written and honoured none of
 *  what that announces: every tab was its own tab stop, so tabbing through the
 *  page walked all of them, and the arrow keys did nothing. A role is a promise
 *  about the keyboard — this repo says so in as many words — and one that is
 *  announced and not kept is worse than none, because a screen reader tells
 *  somebody to press an arrow that has no effect.
 *
 *  So: one tab stop, moved by the arrows, Home and End to the ends, and Delete
 *  to close — which is the pattern for a closable tab, and the reason the × is
 *  not a tab stop of its own. */
function TabStrip() {
  const tabs = useTabs()
  const strip = useRef<HTMLDivElement>(null)

  /** Move the selection, and take the focus with it: an arrow key that selects a
   *  tab and leaves the focus behind is an arrow key that cannot be pressed
   *  twice. */
  const go = (to: number) => {
    const list = tabs.tabs
    if (list.length === 0) return
    const wrapped = (to + list.length) % list.length
    const target = list[wrapped]
    if (!target) return
    tabs.select(target.id)
    // After React has moved the tab stop onto the newly selected tab.
    requestAnimationFrame(() => {
      strip.current?.querySelector<HTMLElement>('[role="tab"][tabindex="0"]')?.focus()
    })
  }

  const at = tabs.tabs.findIndex((t) => t.id === tabs.activeId)

  return (
    <div
      className="tabstrip"
      role="tablist"
      ref={strip}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') go(at + 1)
        else if (e.key === 'ArrowLeft') go(at - 1)
        else if (e.key === 'Home') go(0)
        else if (e.key === 'End') go(tabs.tabs.length - 1)
        else if ((e.key === 'Delete' || e.key === 'Backspace') && tabs.tabs.length > 1) {
          const doomed = tabs.tabs[at]
          if (doomed) tabs.close(doomed.id)
        } else return
        e.preventDefault()
      }}
    >
      {tabs.tabs.map((t, i) => {
        const on = t.id === tabs.activeId
        return (
          <div key={t.id} className={`tabstrip__tab${on ? ' is-active' : ''}`}>
            <button
              className="tabstrip__pick"
              role="tab"
              aria-selected={on}
              /* One tab stop for the whole strip — the arrows walk the rest. */
              tabIndex={on ? 0 : -1}
              onClick={() => tabs.select(t.id)}
            >
              {t.running ? <span className="tabstrip__running" aria-label="running" /> : null}
              {t.mode === 'build' ? (
                <span className="tabstrip__mode" title="A form">
                  <span className="sr-only">form: </span>⊞
                </span>
              ) : null}
              {t.title || `query ${i + 1}`}
            </button>
            {tabs.tabs.length > 1 ? (
              /* Not a tab stop: it lives inside a tablist, which holds one, and
                 the keyboard closes a tab with Delete on the tab itself. */
              <button
                className="tabstrip__close"
                tabIndex={-1}
                onClick={() => tabs.close(t.id)}
                aria-label={`Close ${t.title || `query ${i + 1}`}`}
              >
                ×
              </button>
            ) : null}
          </div>
        )
      })}
      <button className="tabstrip__add" onClick={() => tabs.open()} aria-label="New SQL tab">
        +
      </button>
      {/* The other way in, offered rather than hidden behind the switch: a tab
          that has never held anything can become a form, but so can a person
          who simply wants one and does not want to think about tabs. */}
      <button
        className="tabstrip__add"
        onClick={() => tabs.openBuild()}
        aria-label="New form tab"
        title="A new question, without writing SQL"
      >
        ⊞
      </button>
    </div>
  )
}

function DatabasePicker({
  value,
  onChange,
}: {
  value: string | undefined
  onChange: (db: string) => void
}) {
  const databases = useQuery({ queryKey: ['databases'], queryFn: api.databases })
  const current = value ?? ''

  return (
    <label className="picker">
      <span className="label">database</span>
      <select
        className="picker__select"
        value={current}
        onChange={(e) => onChange(e.target.value)}
      >
        {databases.data?.some((d) => d.name === current) ? null : (
          <option value={current}>{current || '—'}</option>
        )}
        {databases.data?.map((d) => (
          <option key={d.name} value={d.name}>
            {d.name}
          </option>
        ))}
      </select>
    </label>
  )
}

/** The one place the spark lives in motion: while a query is in flight an
 *  ember travels along this strip. */
function StatsStrip({
  running,
  result,
  error,
  wallMs,
  maxRows,
  awaiting,
  mode,
}: {
  running: boolean
  result: QueryResult | null
  error: unknown
  wallMs: number | null
  maxRows: number | undefined
  /** Set when a click rewrote the statement but the rows on screen are still
   *  the old ones, with the reason it was not run for you. */
  awaiting: string | null
  /** What changed under the rows, in the words of the face the reader is
   *  looking at: a statement in SQL, a question in the form. */
  mode: TabMode
}) {
  const facts: string[] = []
  if (result) {
    facts.push(`${count(result.statistics.rows_read)} rows read`)
    facts.push(bytes(result.statistics.bytes_read))
    facts.push(duration(result.statistics.elapsed))
    if (result.kind === 'read') facts.push(`${count(result.rows.length)} returned`)
    if (result.summary.written_rows > 0) {
      facts.push(`${count(result.summary.written_rows)} written`)
    }
  } else if (wallMs !== null && error) {
    facts.push(`failed after ${duration(wallMs / 1000)}`)
  }

  const truncated = result?.truncated ?? false

  return (
    <div className={`stats${running ? ' stats--running' : ''}`} aria-live="polite">
      <span className="stats__state label">
        {running ? 'running' : awaiting ? 'changed' : error ? 'failed' : result ? 'done' : 'idle'}
      </span>
      {/* The rows on screen no longer answer the statement above them, and this
          is the only place that can admit it. It says why rather than just
          nagging: a re-run was withheld because the last one was expensive. */}
      {awaiting && !running ? (
        <span className="stats__changed">
          the {mode === 'build' ? 'question' : 'statement'} changed — ⌘↵ to run it
          <span className="stats__why">{awaiting}</span>
        </span>
      ) : null}
      {facts.map((f) => (
        <span className="stats__fact" key={f}>
          {f}
        </span>
      ))}
      {truncated ? (
        <span className="pill pill--warn" title="Raise FLINT_MAX_RESULT_ROWS to see more">
          truncated at {maxRows ? count(maxRows) : 'the row cap'}
        </span>
      ) : null}
      {error instanceof FlintError && error.clickhouseCode ? (
        <span className="stats__fact stats__fact--warn">code {error.clickhouseCode}</span>
      ) : null}
    </div>
  )
}

export type { SchemaEntry }
