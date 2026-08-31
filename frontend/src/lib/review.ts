/** What the measurements mean, and what DDL would follow.
 *
 *  The backend counts; this decides. Every rule here is a sentence somebody
 *  could argue with — "six distinct values in a String column is worth a
 *  dictionary", "a Nullable that has never been null is paying for nothing" —
 *  so they live in one file, as pure functions, with a test each. That is the
 *  whole reason this is not in the SQL that measured it.
 *
 *  Four rules of conduct, because a schema recommendation that is wrong is
 *  worse than none at all:
 *
 *  **Nothing is claimed beyond the rows that were read.** A finding carries
 *  `verified`, and it is false whenever the numbers came from part of the
 *  table rather than all of it. "200,000 rows fit in a UInt16" is a hypothesis;
 *  the ALTER that acts on it needs the whole column, and the UI must not let
 *  the two look alike. Not "the first 200,000" — the sample is a `LIMIT` with
 *  no `ORDER BY`, so it is some rows and not the earliest ones, which is the
 *  better sample and also not a reproducible one.
 *
 *  **A saving is never predicted.** This file says what a column *costs today*
 *  — a figure ClickHouse measured — and never a percentage it would save. The
 *  saving is knowable, but only by materialising the change and weighing it,
 *  which is a different pass and an explicit one.
 *
 *  **The DDL is shown, never run.** `ALTER TABLE … MODIFY COLUMN` is a mutation
 *  that rewrites every part of the column; on a large table that is hours of
 *  disk. This produces the text and the caution; a human reads both.
 *
 *  **Where a change cannot be undone, say so louder than the saving.** Dropping
 *  a column is the data leaving. */

import type { ColumnFacts, ProbeOutcome, SchemaReview } from './api'
import { family, unwrap } from './chType'

export type Severity =
  /** Costs disk for nothing. */
  | 'save'
  /** The type is wrong for what is in it — a date stored as text. Usually about
   *  what you can *ask*, not what it costs. */
  | 'fix'
  /** Worth knowing, no action implied. */
  | 'note'

/** What a finding is *about*: the subject, not the stakes.
 *
 *  `Severity` says how much a finding matters; this says what it concerns, and
 *  they are different questions. Somebody who has decided that codecs are not
 *  their problem this afternoon wants every codec finding gone whatever it
 *  costs — and no ordering by disk gets them there, only a filter does. So the
 *  rules are gathered into the handful of subjects a reader actually holds an
 *  opinion about, rather than one category per rule: "text that is really a
 *  UUID" and "text that is really a date" are one decision, not two.
 *
 *  A kind is never a reason to drop a finding from the list on its own — the
 *  filter is the reader's, and it says what it hid. */
export type Kind =
  /** LowCardinality, wanted or outgrown. */
  | 'dictionary'
  /** The null-marker file, paid for and unused. */
  | 'nullable'
  /** A number reserving more bytes per row than its range needs. */
  | 'width'
  /** A String holding something with a shape of its own — a date, a UUID, a
   *  width every value keeps. */
  | 'text'
  /** Compression left at the table's default. */
  | 'codecs'
  /** A column that tells the rows apart from nothing. */
  | 'constant'

/** The order the filter lists them in: the changes that most often pay first,
 *  observations last. Also the order the tally is built in, so the dropdown
 *  does not reshuffle between two reviews of the same table. */
export const KINDS: Kind[] = ['dictionary', 'nullable', 'width', 'text', 'codecs', 'constant']

/** Short enough for a checkbox, specific enough to decide from. The gloss is
 *  what the checkbox is really promising to hide, said in one clause. */
export const KIND_LABEL: Record<Kind, { label: string; gloss: string }> = {
  dictionary: { label: 'Dictionaries', gloss: 'LowCardinality, wanted or outgrown' },
  nullable: { label: 'Nullable', gloss: 'a null marker nothing has ever set' },
  width: { label: 'Number width', gloss: 'bytes per row a range does not need' },
  text: { label: 'Text with a type', gloss: 'a date, a UUID or a fixed width, stored as characters' },
  codecs: { label: 'Codecs', gloss: 'columns on the table’s default compression' },
  constant: { label: 'Says nothing', gloss: 'one value in every row' },
}

export interface Finding {
  column: string
  /** Which subject this belongs to, so a reader can put a whole subject away. */
  kind: Kind
  /** The type proposed, or null for a finding that is only an observation. */
  proposal: string | null
  /** `String → LowCardinality(String)`, or a phrase for an observation. */
  headline: string
  /** The reasoning, in words. */
  why: string
  /** The numbers it rests on, verbatim, so the reader can disagree. */
  evidence: string
  ddl: string | null
  /** What the column occupies today — the ceiling on what is at stake, not a
   *  prediction. Null when the parts are Compact and per-column bytes do not
   *  exist. */
  bytes: number | null
  severity: Severity
  /** False when the measurement covered part of the table rather than all of
   *  it. */
  verified: boolean
  /** Why a human has to think before running the DDL. */
  caution: string | null
  /** True when the column is in the sorting or partition key.
   *
   *  The caution says so in words already, and words are enough for one table
   *  at a time. They stop being enough the moment a page offers to tick five
   *  tables at once: something has to be able to *decide* not to include the
   *  two whose ALTER ClickHouse would refuse, and it cannot decide by reading
   *  English. So the fact is carried beside the sentence about it. */
  inKey: boolean
  /** What has read this column lately, when the query log could say. Null when
   *  it could not — never rendered as "nothing read it". */
  usage: string | null
  /** What weighing this finding would measure: a type change, the codecs worth
   *  trying, or nothing that can be weighed. */
  weigh: 'type' | 'codecs' | null
}

/** How far back the usage figures actually reach, in words.
 *
 *  The window asked for is not the window granted: `system.query_log` commonly
 *  has a one-day TTL, and on the machine this was built against it held twelve
 *  hours. "Nothing has read this column in 7 days" is the sentence somebody
 *  drops a column on, so it has to be the truth — which is the reach of the log,
 *  not the reach of the question.
 *
 *  The hours are the server's own subtraction, never this side's: `event_time`
 *  is on ClickHouse's clock and a browser's is its own, and doing the arithmetic
 *  here quietly adds the offset between them. That mistake cost two hours out of
 *  twelve when it was made.
 *
 *  Exported and tested because it is the one piece of wording here that can be
 *  wrong by a factor of fourteen. */
export function windowOf(review: SchemaReview): string {
  const asked = `${review.usage_days} days`
  const hours = review.usage_hours
  if (hours === null || !Number.isFinite(hours)) return asked
  // Within a couple of hours of the window asked for, the distinction is noise.
  if (hours >= review.usage_days * 24 - 2) return asked
  if (hours >= 48) return `the ${Math.round(hours / 24)} days the log keeps`
  if (hours >= 2) return `the ${hours} hours the log keeps`
  return 'the last hour, which is all the log keeps'
}

/** Under this many rows nothing is worth saying about cardinality: every column
 *  of a fifty-row table looks low-cardinality. */
const MIN_ROWS_FOR_CARDINALITY = 100

/** ClickHouse's own guidance for `LowCardinality`: worth it below roughly ten
 *  thousand distinct values, a cost above it. The backend's `uniqUpTo` cap is
 *  the same figure, which is why `distinct_capped` alone answers the question. */
const LOW_CARDINALITY_CEILING = 10_000

/** And each value has to repeat before a dictionary pays for itself. */
const MIN_REPEATS = 10

/** Below this, a codec is not worth a mutation. Choosing one is free of risk —
 *  a codec is lossless — but rewriting every part of a column is not free of
 *  time, and shaving a few kilobytes is not a reason to spend it.
 *
 *  The floor is on the *measured* size, which means a table whose parts are
 *  Compact gets no codec findings at all: without a size there is no way to say
 *  the change is worth anything, and offering it on every numeric column of
 *  every table is how a review becomes noise. */
const CODEC_FLOOR = 64 * 1024

/** Where the backend's exact count stops being exact. Above it the figure is an
 *  estimate, and every sentence built on it says "about". */
const EXACT_UP_TO = 100

/** The integer types, narrowest first, with what they hold. `BigInt` because an
 *  Int64's ceiling does not survive a double — the whole point of this table is
 *  comparing against exactly those boundaries. */
const UNSIGNED: [string, bigint][] = [
  ['UInt8', 255n],
  ['UInt16', 65_535n],
  ['UInt32', 4_294_967_295n],
  ['UInt64', 18_446_744_073_709_551_615n],
]

const SIGNED: [string, bigint][] = [
  ['Int8', 127n],
  ['Int16', 32_767n],
  ['Int32', 2_147_483_647n],
  ['Int64', 9_223_372_036_854_775_807n],
]

const INTEGER = /^U?Int(8|16|32|64)$/

function asBigInt(value: string | null | undefined): bigint | null {
  if (!value || !/^-?\d+$/.test(value)) return null
  try {
    return BigInt(value)
  } catch {
    return null
  }
}

/** The narrowest integer type that holds this range, or null when the range is
 *  not integral. Unsigned when nothing is negative — which is most counters, and
 *  doubles the headroom for free. */
export function narrowestInteger(min: string | null, max: string | null): string | null {
  const lo = asBigInt(min)
  const hi = asBigInt(max)
  if (lo === null || hi === null) return null
  if (lo >= 0n) {
    const fit = UNSIGNED.find(([, ceiling]) => hi <= ceiling)
    return fit?.[0] ?? null
  }
  // A signed type's negative reach is one further than its positive one, so the
  // magnitude to fit is whichever end is further from zero.
  const reach = -lo - 1n > hi ? -lo - 1n : hi
  const fit = SIGNED.find(([, ceiling]) => reach <= ceiling)
  return fit?.[0] ?? null
}

/** Where a type sits in the family, so "narrower" can be compared at all. */
function width(type: string): number {
  const bits = /(\d+)$/.exec(type)
  return bits ? Number(bits[1]) : 0
}

/** Rebuild a type with a different core, keeping the wrappers that were there.
 *  `Nullable(LowCardinality(String))` retyped to `UUID` has to come back as
 *  `Nullable(UUID)`, or the proposal quietly drops the nullability. */
function rewrap(type: string, core: string, { keepLowCardinality = false } = {}): string {
  const nullable = /\bNullable\(/.test(type)
  const low = keepLowCardinality && /\bLowCardinality\(/.test(type)
  let out = core
  if (low) out = `LowCardinality(${out})`
  if (nullable) out = `Nullable(${out})`
  return out
}

/** What a null becomes when the `Nullable` wrapper is dropped — and whether
 *  ClickHouse insists on being told.
 *
 *  `MODIFY COLUMN connected Bool` over a `Nullable(Bool)` does not run. Measured
 *  against 26.7: it is refused outright, `BAD_ARGUMENTS`, *"Please specify
 *  `DEFAULT` expression in ALTER MODIFY COLUMN statement"* — because dropping
 *  the nullability asks a question the server will not answer for us. A null has
 *  to become *something*, and only the person running the statement knows what.
 *
 *  `defaultValueOfTypeName` answers it for every target type at once, rather
 *  than a table of literals per family — `false`, `0`, `''`, the nil UUID, the
 *  epoch — and it answers with exactly the value an `INSERT` that omits the
 *  column already writes. So the column lands where it would have landed anyway;
 *  the expression exists because the statement will not run without one, not
 *  because Flint has an opinion about the value.
 *
 *  Null when nothing is being dropped, which is most proposals: `Nullable(Int64)
 *  → Nullable(UInt16)` narrows inside the wrapper and needs none of this.
 *
 *  Exported because `sweep.ts` writes the same DDL for many tables at once and
 *  `alter.ts` hands a single one over to Infrastructure to be run — three places
 *  that have to agree on when the clause appears, and on its wording. */
export function nullFill(from: string, to: string): string | null {
  if (!/\bNullable\(/.test(from) || /\bNullable\(/.test(to)) return null
  return `defaultValueOfTypeName('${to}')`
}

/** The sentence that has to travel with that `DEFAULT`, and it is the reverse
 *  of the one this rule used to carry.
 *
 *  Before the clause was there the statement simply failed on a null, and the
 *  caution could honestly say so — "one null anywhere makes this ALTER fail".
 *  With the `DEFAULT`, which is not optional, the failure mode inverts. Measured
 *  on a three-row table holding one null: the `ALTER` succeeds without a word
 *  and that row comes back as `false`, sitting beside the rows that were always
 *  `false` and no longer distinguishable from them. Flint counted zero nulls
 *  over what it read; the clause is a licence to overwrite any it did not see.
 *  Which is the whole risk of this finding, so it is stated wherever the DDL is
 *  rather than left to be inferred from the type. */
function fillCaution(verified: boolean): string {
  return verified
    ? 'Dropping the Nullable needs a DEFAULT, and ClickHouse will not run the statement without one — so a null does not fail the ALTER, it silently becomes the type’s zero value. Every row here was read and none was null, but the source can still send one tomorrow and the column will have nowhere to put it.'
    : 'Dropping the Nullable needs a DEFAULT, and ClickHouse will not run the statement without one — so a null this sample did not see does not fail the ALTER, it silently becomes the type’s zero value, indistinguishable from a real one and with no undo. Verify over every row first.'
}

/** One `MODIFY COLUMN`, or two statements when the first cannot stand alone.
 *
 *  The second is `REMOVE DEFAULT`, and it is there so that running the DDL
 *  leaves the schema where the headline said it would. The headline says
 *  `Nullable(Bool) → Bool`; without the second statement what stays in `SHOW
 *  CREATE TABLE` is `Bool DEFAULT defaultValueOfTypeName('Bool')`, indefinitely
 *  — a scar from a suggestion that was only ever about the type. It costs
 *  nothing to undo: measured against 26.7, `REMOVE DEFAULT` registers no row in
 *  `system.mutations` at all, where the `MODIFY COLUMN` above it registers one.
 *  And it cannot ride along in the same statement — an `ALTER` naming one column
 *  twice is rejected. */
function alter(review: SchemaReview, column: string, from: string, type: string): string {
  const head = `ALTER TABLE ${ident(review.database)}.${ident(review.table)}`
  const fill = nullFill(from, type)
  if (fill === null) return `${head}\n  MODIFY COLUMN ${ident(column)} ${type}`
  return `${head}\n  MODIFY COLUMN ${ident(column)} ${type} DEFAULT ${fill};\n\n${head}\n  MODIFY COLUMN ${ident(column)} REMOVE DEFAULT`
}

/** Backticks unless the name is a bare identifier — the same rule as everywhere
 *  else in Flint. Local rather than imported from `query` so this file has no
 *  reason to know about the query builder; exported so that `sweep.ts`, which
 *  writes the same DDL for several tables at once, quotes a name exactly the
 *  way the single-table statement above it does. Two spellings of one rule is
 *  how a name ends up backticked on one line and bare on the next. */
export function ident(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name.replace(/`/g, '\\`')}\``
}

/** How many rows the figures describe. */
function rowsOf(review: SchemaReview): number {
  return review.scanned
}

/** A column in the sorting or partition key cannot be retyped casually: it is
 *  the table's physical order, and ClickHouse refuses most changes to it
 *  outright. */
function keyCaution(column: ColumnFacts): string | null {
  if (column.in_partition_key) {
    return 'This column is in the partition key. ClickHouse will refuse most changes to it; the table has to be rebuilt instead.'
  }
  if (column.in_sorting_key) {
    return 'This column is in the sorting key, which is the table’s physical order. ClickHouse refuses most type changes here.'
  }
  return null
}

/** Said once by the panel, above the list, rather than on every card: a caveat
 *  printed nine times is a caveat nobody reads. Exported so the page and this
 *  file cannot drift on what it says. */
export const MUTATION_COST =
  'Every MODIFY COLUMN below is a mutation: ClickHouse rewrites every part of that column, which on a large table is hours of disk.'

function join(...parts: (string | null)[]): string | null {
  const kept = parts.filter((p): p is string => Boolean(p))
  return kept.length > 0 ? kept.join(' ') : null
}

/* -- The rules --------------------------------------------------------- */

export function findings(review: SchemaReview): Finding[] {
  const out: Finding[] = []
  const rows = rowsOf(review)
  const verified = review.verified

  for (const column of review.columns) {
    const bytes = column.compressed_bytes ?? null
    const core = unwrap(column.type)
    const fam = family(column.type)
    const low = /\bLowCardinality\(/.test(column.type)
    // Two counts, and which one is in play decides how the evidence is worded:
    // a rule may only *conclude* from the exact one.
    const exact = column.distinct_small <= EXACT_UP_TO
    const distinct = exact ? column.distinct_small : column.distinct
    const howMany = `${exact ? '' : 'about '}${distinct.toLocaleString('en-GB')} distinct`
    // Said once per column and attached to each of its findings: what a column
    // costs is only half the question, and what reads it is the half that
    // decides whether the change is worth anybody's afternoon.
    // "Nothing read it" and "nothing uses it" are not the same sentence, and
    // conflating them is how a review talks somebody into dropping a column
    // their application writes to every minute. ClickHouse logs no columns for
    // an INSERT, so the write count is the only thing standing between the two.
    const written = review.writes !== null && review.writes > 0
    const window = windowOf(review)
    const usage =
      column.read_by === null
        ? null
        : column.read_by === 0
          ? written
            ? `nothing has read this column in ${window}, though the table took ${review.writes!.toLocaleString('en-GB')} ${review.writes === 1 ? 'insert' : 'inserts'}`
            : `nothing has read this column in ${window}`
          : `read by ${column.read_by.toLocaleString('en-GB')} ${
              column.read_by === 1 ? 'query' : 'queries'
            } in ${window}`
    const push = (
      f: Omit<Finding, 'column' | 'bytes' | 'verified' | 'usage' | 'weigh' | 'inKey'>,
    ) =>
      out.push({
        ...f,
        column: column.name,
        bytes,
        verified,
        usage,
        inKey: column.in_sorting_key || column.in_partition_key,
        weigh: f.proposal ? 'type' : null,
      })

    // ── A column that says nothing ────────────────────────────────────
    // Exactly one value is a claim, not an estimate, so it rests on the exact
    // count alone.
    if (rows > 0 && column.distinct_small <= 1) {
      const only = column.nulls === rows ? 'null in every row' : 'one value throughout'
      const unread = column.read_by === 0
      push({
        kind: 'constant',
        proposal: null,
        headline: 'carries no information here',
        why:
          `Every row has the same value, so nothing in this table can be told apart by it. If that is by design — a tenant id in a single-tenant table — it costs little; if it is not, something upstream has stopped filling it.` +
          (unread && !written
            ? ` Nothing has read it in ${window} either, so dropping it would go unnoticed by every query the log has seen.`
            : written
              ? ` The table is still taking inserts, and an INSERT that names this column fails the moment it is dropped — so this is a conversation with whatever writes it, not a DDL to run.`
              : ''),
        evidence: `${only}, over ${rows.toLocaleString('en-GB')} rows`,
        ddl: `ALTER TABLE ${ident(review.database)}.${ident(review.table)}\n  DROP COLUMN ${ident(column.name)}`,
        severity: 'note',
        caution: join(
          'Dropping a column is the data leaving, and there is no undo.',
          keyCaution(column),
        ),
      })
    }

    // ── A Nullable that has never been null ──────────────────────────
    if (column.nullable && column.nulls === 0 && rows > 0 && !core.includes('Nothing')) {
      const target = column.type.replace(/Nullable\((.*)\)/, '$1')
      push({
        kind: 'nullable',
        proposal: target,
        headline: `${column.type} → ${target}`,
        why: 'A Nullable column carries a second file of null markers beside the values, and it cannot be used by some of ClickHouse’s optimisations. Nothing in this column has ever been null.',
        evidence: `0 nulls in ${rows.toLocaleString('en-GB')} rows${column.empties > 0 ? ` · ${column.empties.toLocaleString('en-GB')} empty strings, which are not nulls` : ''}`,
        ddl: alter(review, column.name, column.type, target),
        severity: 'save',
        caution: join(fillCaution(verified), keyCaution(column)),
      })
    }

    // ── Text that would rather be a dictionary ───────────────────────
    if (
      fam === 'string' &&
      !low &&
      core === 'String' &&
      rows >= MIN_ROWS_FOR_CARDINALITY &&
      !column.distinct_capped &&
      distinct > 1 &&
      distinct <= LOW_CARDINALITY_CEILING &&
      distinct * MIN_REPEATS <= rows
    ) {
      const target = rewrap(column.type, 'String', { keepLowCardinality: false })
      const proposal = /Nullable/.test(column.type)
        ? 'LowCardinality(Nullable(String))'
        : 'LowCardinality(String)'
      push({
        kind: 'dictionary',
        proposal,
        headline: `${target} → ${proposal}`,
        why: `Each value repeats about ${Math.round(rows / distinct).toLocaleString('en-GB')} times. A LowCardinality column stores the distinct values once per part and the rows as small integers into that dictionary, which is both smaller on disk and faster to group by.`,
        evidence: `${howMany} values in ${rows.toLocaleString('en-GB')} rows`,
        ddl: alter(review, column.name, column.type, proposal),
        severity: 'save',
        caution: keyCaution(column),
      })
    }

    // ── A dictionary that has outgrown itself ────────────────────────
    if (low && column.distinct_capped) {
      const target = column.type.replace(/LowCardinality\((.*)\)/, '$1')
      push({
        kind: 'dictionary',
        proposal: target,
        headline: `${column.type} → ${target}`,
        why: `Past roughly ten thousand distinct values a dictionary stops paying: it is held per part, and every part now carries a large one. This column is above that.`,
        evidence: `more than ${LOW_CARDINALITY_CEILING.toLocaleString('en-GB')} distinct values in ${rows.toLocaleString('en-GB')} rows`,
        ddl: alter(review, column.name, column.type, target),
        severity: 'fix',
        caution: keyCaution(column),
      })
    }

    // ── An integer with far more room than it uses ───────────────────
    if (fam === 'number' && INTEGER.test(core)) {
      const narrow = narrowestInteger(column.min ?? null, column.max ?? null)
      if (narrow && width(narrow) < width(core)) {
        const target = rewrap(column.type, narrow, { keepLowCardinality: true })
        const ceiling = (narrow.startsWith('U') ? UNSIGNED : SIGNED).find(
          ([name]) => name === narrow,
        )![1]
        push({
          kind: 'width',
          proposal: target,
          headline: `${column.type} → ${target}`,
          why: `${core} reserves ${width(core) / 8} bytes per row; ${narrow} holds everything seen here in ${width(narrow) / 8}.`,
          evidence: `range ${column.min} … ${column.max} · ${narrow} holds up to ${ceiling.toLocaleString('en-GB')}`,
          ddl: alter(review, column.name, column.type, target),
          severity: 'save',
          caution: join(
            verified
              ? `Headroom is what matters here, not the current maximum: ${column.max} today against a ceiling of ${ceiling.toLocaleString('en-GB')}.`
              : 'The largest value may be outside the rows read, and a value past the ceiling would be truncated. Verify over every row first.',
              keyCaution(column),
          ),
        })
      }
    }

    // ── A float holding whole numbers ────────────────────────────────
    if (fam === 'number' && core.startsWith('Float') && column.fractional === 0 && rows > 0) {
      const narrow = narrowestInteger(column.min ?? null, column.max ?? null)
      const target = narrow ? rewrap(column.type, narrow, { keepLowCardinality: true }) : null
      push({
        kind: 'width',
        proposal: target,
        headline: target ? `${column.type} → ${target}` : 'holds only whole numbers',
        why: 'Every value in this column is a whole number, so the mantissa is being paid for and never used. An integer type is also exactly comparable, which a float is not.',
        evidence: `no fractional value in ${rows.toLocaleString('en-GB')} rows · range ${column.min} … ${column.max}`,
        ddl: target ? alter(review, column.name, column.type, target) : null,
        severity: 'save',
        caution: join(
          verified ? null : 'Verify over every row first.',
          keyCaution(column),
        ),
      })
    }

    // ── Text that is really a UUID ───────────────────────────────────
    if (
      fam === 'string' &&
      core === 'String' &&
      column.not_a_uuid === 0 &&
      column.min_len === 36 &&
      column.max_len === 36 &&
      rows > 0
    ) {
      const target = rewrap(column.type, 'UUID', { keepLowCardinality: false })
      push({
        kind: 'text',
        proposal: target,
        headline: `${column.type} → ${target}`,
        why: 'A UUID stored as text is 36 characters; stored as a UUID it is 16 bytes, and comparisons stop being string comparisons.',
        evidence: `every value is a 36-character UUID, over ${rows.toLocaleString('en-GB')} rows`,
        ddl: alter(review, column.name, column.type, target),
        severity: 'save',
        caution: join(
          verified ? null : 'Verify over every row first.',
          'The text form is not preserved: a UUID comes back lower-case and canonically hyphenated.',
          keyCaution(column),
        ),
      })
    }

    // ── Text that is really a date ───────────────────────────────────
    if (
      fam === 'string' &&
      core === 'String' &&
      column.not_a_date === 0 &&
      // Digits alone parse as a date too — `20240501` is a valid DateTime to
      // ClickHouse — and a column of numbers is not a column of dates. A real
      // date has separators, which is exactly what makes it fail the number
      // test.
      (column.not_a_number ?? 0) > 0 &&
      (column.min_len ?? 0) >= 8 &&
      (column.max_len ?? 0) <= 32 &&
      rows > 0
    ) {
      const asDate = (column.max_len ?? 0) <= 10
      const target = rewrap(column.type, asDate ? 'Date' : 'DateTime', {
        keepLowCardinality: false,
      })
      push({
        kind: 'text',
        proposal: target,
        headline: `${column.type} → ${target}`,
        why: 'Every value parses as a date. As text, a range query on it is a string comparison and the primary key cannot help; as a date it is four or eight bytes and the usual time functions apply.',
        evidence: `every non-empty value parses as a date, over ${rows.toLocaleString('en-GB')} rows · lengths ${column.min_len}–${column.max_len}`,
        ddl: alter(review, column.name, column.type, target),
        severity: 'fix',
        caution: join(
          verified ? null : 'Verify over every row first.',
          'Check the time zone the strings were written in: a DateTime is stored as an instant, and the conversion reads them in the server’s zone.',
          keyCaution(column),
        ),
      })
    }

    // ── A column taking the table's default compression ──────────────
    //
    // Unlike every other finding here, this one proposes nothing: a codec is
    // lossless, so there is nothing at stake but bytes, and which codec wins
    // cannot be reasoned about. On this project's own data `DoubleDelta` made a
    // DateTime three times smaller, while `Gorilla` — the codec every guide
    // recommends for floats — made a Float32 column 29% *bigger* than the
    // default. So the finding is an offer to weigh, and the answer is measured.
    if (
      (fam === 'number' || fam === 'time') &&
      !column.codec &&
      rows > 0 &&
      bytes !== null &&
      bytes >= CODEC_FLOOR
    ) {
      out.push({
        kind: 'codecs',
        column: column.name,
        bytes,
        verified,
        usage,
        inKey: column.in_sorting_key || column.in_partition_key,
        weigh: 'codecs',
        proposal: null,
        headline: 'takes the table\u2019s default compression',
        why: 'A codec is lossless: it changes how the column is written, never what it holds. Which one is smallest depends on the values — deltas win on a clock and lose on a duration — so this is worth weighing rather than reasoning about.',
        evidence: `${column.type}, no codec of its own`,
        ddl: null,
        severity: 'save',
        caution: null,
      })
    }

    // ── Text of one fixed length ─────────────────────────────────────
    if (
      fam === 'string' &&
      core === 'String' &&
      !low &&
      column.min_len !== null &&
      column.min_len === column.max_len &&
      (column.max_len ?? 0) > 0 &&
      (column.max_len ?? 0) <= 32 &&
      column.distinct_capped &&
      column.not_a_uuid !== 0
    ) {
      const n = column.max_len!
      const target = rewrap(column.type, `FixedString(${n})`, { keepLowCardinality: false })
      push({
        kind: 'text',
        proposal: target,
        headline: `${column.type} → ${target}`,
        why: `Every value is exactly ${n} characters. A FixedString drops the per-value length prefix; it also pads on read, which is a behaviour change worth knowing about.`,
        evidence: `every value is ${n} characters, over ${rows.toLocaleString('en-GB')} rows`,
        ddl: alter(review, column.name, column.type, target),
        severity: 'note',
        caution: join(
          'A FixedString pads shorter values with null bytes rather than rejecting them, so anything shorter arriving later is silently padded.',
          keyCaution(column),
        ),
      })
    }
  }

  return rank(out)
}

/** Biggest column first, because that is where the disk is; findings with no
 *  measurable size go last rather than pretending to be small. Severity breaks
 *  a tie, and the name breaks that, so the order is stable between runs. */
export function rank(list: Finding[]): Finding[] {
  const bySeverity: Record<Severity, number> = { save: 0, fix: 1, note: 2 }
  return [...list].sort((a, b) => {
    if (a.bytes !== b.bytes) {
      if (a.bytes === null) return 1
      if (b.bytes === null) return -1
      return b.bytes - a.bytes
    }
    return bySeverity[a.severity] - bySeverity[b.severity] || a.column.localeCompare(b.column)
  })
}

/** What the columns with a proposal occupy today. Not a saving — the ceiling on
 *  one, and only over the columns whose size is known. */
export function atStake(list: Finding[]): { bytes: number; columns: number; unknown: number } {
  let bytes = 0
  let columns = 0
  let unknown = 0
  const seen = new Set<string>()
  for (const finding of list) {
    if (finding.severity === 'note' || seen.has(finding.column)) continue
    seen.add(finding.column)
    if (finding.bytes === null) unknown += 1
    else {
      bytes += finding.bytes
      columns += 1
    }
  }
  return { bytes, columns, unknown }
}

/** The kinds actually present, in the settled order, with how many entries
 *  each holds.
 *
 *  Only the kinds that are there: a checkbox for a category this table has
 *  nothing in reads as a filter that failed, and offering to hide nothing is
 *  not an offer. The count is the whole list's, not the filtered one's — it is
 *  what ticking the box would bring back.
 *
 *  Anything carrying a kind, not `Finding` alone: `sweep.ts` groups the same
 *  findings by column across a whole database and its groups carry the kind
 *  through, so the same dropdown has to be able to count them. One filter over
 *  two readings of one set of findings — the alternative is a second tally that
 *  agrees with this one until somebody edits one of them. */
export function tally<T extends { kind: Kind }>(list: T[]): { kind: Kind; count: number }[] {
  return KINDS.map((kind) => ({
    kind,
    count: list.filter((entry) => entry.kind === kind).length,
  })).filter((entry) => entry.count > 0)
}

/** The kinds put away, read back from wherever they were stored.
 *
 *  Anything that is not a kind Flint has *now* is dropped rather than kept: a
 *  preference saved against a category that has since been renamed or split
 *  would otherwise sit in storage hiding a list nobody can un-hide, because the
 *  checkbox that would tick it back on no longer exists. Parsing is where that
 *  is caught, so every surface reading the preference is safe by construction
 *  rather than by remembering to check. */
export function parseKinds(raw: string | null | undefined): Set<Kind> {
  if (!raw) return new Set()
  const known = new Set<string>(KINDS)
  return new Set(raw.split(',').filter((part): part is Kind => known.has(part)))
}

/** And back to a string. Null when nothing is hidden, so the caller clears the
 *  key rather than storing an empty one — an empty value and an absent value
 *  mean the same thing here, and two spellings of one state is a bug waiting
 *  for whoever writes the next reader. */
export function serialiseKinds(kinds: Set<Kind>): string | null {
  // Written in the settled order rather than insertion order, so ticking two
  // boxes in either sequence stores the same string.
  const kept = KINDS.filter((kind) => kinds.has(kind))
  return kept.length > 0 ? kept.join(',') : null
}

/* -- What a measurement means ------------------------------------------ */

export interface Reading {
  rows: number
  before: number
  after: number
  /** How many times smaller the compressed column is. Null when there is
   *  nothing to divide by — a column of nothing weighs nothing. */
  ratio: number | null
  /** The same for the raw bytes. Worth its own figure because the two often
   *  disagree, and the disagreement is the whole lesson: halving the bytes a
   *  value occupies barely moves the file when compression had already found
   *  the redundancy. */
  rawRatio: number | null
  /** The measured ratio applied to what the column really occupies. Null when
   *  that size is not knowable — never a guess in its place. */
  projected: number | null
  /** Bytes one grouping moved, each way, and how many times fewer. This is the
   *  performance figure — and it is a figure about *bytes*. How much faster a
   *  query gets depends on the query, the disk and the cache, so no multiplier
   *  of seconds is offered anywhere. */
  beforeScanned: number
  afterScanned: number
  scanRatio: number | null
  /** True when the change makes it *bigger*, which happens and must be said. */
  worse: boolean
}

export function reading(outcome: ProbeOutcome): Reading {
  const ratio =
    outcome.after_compressed > 0 && outcome.before_compressed > 0
      ? outcome.before_compressed / outcome.after_compressed
      : null
  const rawRatio =
    outcome.after_raw > 0 && outcome.before_raw > 0 ? outcome.before_raw / outcome.after_raw : null
  const scanRatio =
    outcome.after_scanned > 0 && outcome.before_scanned > 0
      ? outcome.before_scanned / outcome.after_scanned
      : null
  return {
    rows: outcome.rows,
    before: outcome.before_compressed,
    after: outcome.after_compressed,
    ratio,
    rawRatio,
    beforeScanned: outcome.before_scanned,
    afterScanned: outcome.after_scanned,
    scanRatio,
    projected:
      ratio !== null && outcome.column_compressed !== null
        ? outcome.column_compressed / ratio
        : null,
    worse: ratio !== null && ratio < 1,
  }
}

/** `2.4×`, at one decimal, or null when there is no ratio to name. */
export function times(ratio: number | null): string | null {
  if (ratio === null || !Number.isFinite(ratio)) return null
  return `${(Math.round(ratio * 10) / 10).toLocaleString('en-GB')}×`
}

/** The DDL for a codec somebody picked after weighing. The type is repeated
 *  because ClickHouse's `MODIFY COLUMN` takes the whole definition — leaving it
 *  out is how a column quietly becomes something else. */
export function codecDdl(
  database: string,
  table: string,
  column: string,
  type: string,
  codec: string,
): string {
  const q = (name: string) =>
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name.replace(/`/g, '\\`')}\``
  return `ALTER TABLE ${q(database)}.${q(table)}\n  MODIFY COLUMN ${q(column)} ${type} CODEC(${codec})`
}
