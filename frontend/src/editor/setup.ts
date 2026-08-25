import { sql, SQLDialect, type SQLNamespace } from '@codemirror/lang-sql'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { tags as t } from '@lezer/highlight'

import type { SchemaEntry } from '../lib/api'

/** ClickHouse's SQL, as far as the highlighter needs to know: backtick-quoted
 *  identifiers, `--` and `/* *\/` comments, and its own keyword set. */
const ClickHouse = SQLDialect.define({
  keywords:
    'select from where prewhere group by order limit offset having distinct all any as on using join left right inner full outer cross array asof semi anti global union intersect except with recursive case when then else end and or not in like ilike between is null asc desc nulls first last insert into values update delete alter table create drop attach detach rename truncate optimize final deduplicate materialize view materialized live window dictionary database if exists replace engine partition primary key sample sign version ttl settings codec default alias ephemeral comment cluster on function format outfile infile set show describe explain grant revoke system kill query check exchange move to disk volume freeze unfreeze modify add column index projection constraint apply clear rows step totals cube rollup interval extract cast collate',
  builtin:
    'MergeTree ReplacingMergeTree SummingMergeTree AggregatingMergeTree CollapsingMergeTree VersionedCollapsingMergeTree GraphiteMergeTree ReplicatedMergeTree ReplicatedReplacingMergeTree Distributed Memory Log TinyLog StripeLog Null Set Join View MaterializedView Dictionary Buffer Kafka S3 URL File MySQL PostgreSQL SQLite MongoDB HDFS Merge Int8 Int16 Int32 Int64 Int128 Int256 UInt8 UInt16 UInt32 UInt64 UInt128 UInt256 Float32 Float64 Decimal Decimal32 Decimal64 Decimal128 Decimal256 Bool String FixedString UUID Date Date32 DateTime DateTime64 Enum8 Enum16 Array Tuple Map Nested Nullable LowCardinality AggregateFunction SimpleAggregateFunction IPv4 IPv6 JSON Dynamic Variant Point Ring Polygon MultiPolygon',
  types: '',
  operatorChars: '+-*/%<>!=~&|^',
  identifierQuotes: '`"',
  specialVar: '@',
  slashComments: true,
  hashComments: false,
  doubleDollarQuotedStrings: false,
  backslashEscapes: true,
})

/** Turn Flint's flat schema snapshot into the nested namespace CodeMirror
 *  wants, so `events.` completes columns and `analytics.` completes tables.
 *  The current database is also lifted to the top level, which is what you
 *  actually type. */
function toNamespace(entries: SchemaEntry[], currentDatabase: string | undefined): SQLNamespace {
  const root: Record<string, SQLNamespace> = {}

  for (const entry of entries) {
    const columns = entry.columns.map((name, i) => ({
      label: name,
      type: 'property' as const,
      detail: entry.types[i] ?? '',
    }))
    const db = (root[entry.database] ??= { self: { label: entry.database, type: 'schema' }, children: {} }) as {
      children: Record<string, SQLNamespace>
    }
    db.children[entry.table] = { self: { label: entry.table, type: 'type' }, children: columns }

    if (entry.database === currentDatabase) {
      root[entry.table] = { self: { label: entry.table, type: 'type' }, children: columns }
    }
  }
  return root
}

export function clickhouseSql(
  entries: SchemaEntry[],
  currentDatabase: string | undefined,
  /** The table the caret's statement reads from, so bare column names
   *  complete without having to qualify them. */
  defaultTable?: string | undefined,
): Extension {
  return sql({
    dialect: ClickHouse,
    schema: toNamespace(entries, currentDatabase),
    defaultSchema: currentDatabase,
    defaultTable,
    upperCaseKeywords: true,
  })
}

/** The editor is dressed entirely from the app's tokens, so it changes with
 *  the theme instead of carrying its own palette. */
export const flintTheme: Extension = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: 'var(--size-body)',
    backgroundColor: 'var(--slab)',
    color: 'var(--chalk)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-data)',
    // No ligatures in the editor. JetBrains Mono renders `!=` as `≠` and `->`
    // as an arrow, which is handsome and wrong here: a SQL editor has to show
    // the characters that are actually in the statement.
    fontVariantLigatures: 'none',
    lineHeight: '1.65',
    backgroundColor: 'var(--slab)',
  },
  '.cm-content': { padding: '10px 0', caretColor: 'var(--spark)' },
  '.cm-gutters': {
    backgroundColor: 'var(--slab)',
    color: 'var(--chalk-faint)',
    border: 'none',
    paddingRight: '4px',
  },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '2.5rem', paddingRight: '10px' },
  '.cm-activeLine': { backgroundColor: 'rgb(255 255 255 / 3%)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--chalk-dim)' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--spark)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--spark-wash)',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--slab-hover)' },
  '.cm-matchingBracket': {
    backgroundColor: 'transparent',
    color: 'var(--spark)',
    outline: '1px solid var(--spark-line)',
  },
  '.cm-placeholder': { color: 'var(--chalk-faint)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--slab-raised)',
    border: '1px solid var(--line-strong)',
    borderRadius: 'var(--radius)',
    fontFamily: 'var(--font-data)',
    fontSize: 'var(--size-data)',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--spark-wash)',
    color: 'var(--chalk)',
  },
  '.cm-completionDetail': { color: 'var(--chalk-faint)', fontStyle: 'normal', marginLeft: '1em' },
  '.cm-completionIcon': { color: 'var(--chalk-faint)' },
})

/// Syntax colours, keyed on lezer tags rather than CSS classes — CodeMirror 6
/// emits neither `.tok-*` nor `.cm-keyword`, so a stylesheet alone leaves
/// `basicSetup`'s light-background default in force and identifiers turn
/// unreadable on a dark ground.
///
/// The palette is the same one the schema browser uses: a string literal here
/// is the same sage as a `String` column there.
const flintHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword], color: 'var(--t-bool)', fontWeight: '500' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--t-string)' },
  { tag: [t.number, t.bool, t.null, t.integer, t.float], color: 'var(--t-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--chalk-faint)', fontStyle: 'italic' },
  { tag: [t.typeName, t.standard(t.name), t.className], color: 'var(--t-nested)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--t-time)' },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: 'var(--chalk-dim)' },
  { tag: [t.variableName, t.propertyName, t.name, t.attributeName], color: 'var(--chalk)' },
  { tag: t.invalid, color: 'var(--alarm)' },
])

/// Everything the editor needs, in the order precedence requires: our
/// highlighting must come after `basicSetup`'s default to win.
export const flintHighlighting: Extension = syntaxHighlighting(flintHighlight)
