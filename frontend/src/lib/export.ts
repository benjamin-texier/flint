/** What a download is about to give you, said before you ask for it.
 *
 *  A page states what it left out; a file cannot. Nothing in a Parquet footer
 *  mentions the four million rows that did not fit, and a CSV that stops at ten
 *  thousand looks exactly like a CSV of a ten-thousand-row table. So the
 *  honesty has to happen here, on the control, before the click.
 */

export const FORMATS = [
  { format: 'csv', label: 'CSV', why: 'Opens in a spreadsheet.' },
  { format: 'jsonl', label: 'JSONL', why: 'One JSON document per line, for a script.' },
  { format: 'parquet', label: 'Parquet', why: 'Typed and compressed, for a dataframe.' },
] as const

export type ExportFormat = (typeof FORMATS)[number]['format']

/** What the control says about the size of what it will hand over.
 *
 *  Two cases, and the difference is the whole point:
 *
 *  - The page was cut. The download is *not* what is on screen, and Flint does
 *    not know what it is instead — `rows_before_limit_at_least` comes back null
 *    on a statement truncated by the row cap rather than by a `LIMIT`, and
 *    `rows_read` counts what the server read before it stopped, which is not a
 *    total either. So say the one true thing: this gives the whole result, and
 *    the whole result is more than you are looking at. A figure invented here
 *    would be a figure nobody could reconcile — the same reason an absent size
 *    is dropped rather than dashed.
 *  - The page is everything. Then the count on screen *is* the count in the
 *    file, and saying it is worth more than being vague.
 */
export function downloadNote(rowsShown: number, truncated: boolean): string {
  if (truncated) {
    return `Downloads the whole result, not only the ${rowsShown.toLocaleString()} rows shown.`
  }
  const rows = rowsShown === 1 ? '1 row' : `${rowsShown.toLocaleString()} rows`
  return `Downloads ${rows} — everything this statement returned.`
}

/** The same claim for a table, where the count is sometimes actually known.
 *
 *  This is the case the editor's note cannot have. A table's row count is a
 *  fact ClickHouse already keeps, so when nothing narrows it, the download can
 *  name its own size instead of gesturing at it — which is the whole reason
 *  this control is worth putting on a table at all.
 *
 *  Three answers:
 *
 *  - **Filtered.** The count stops being known the moment a `WHERE` appears;
 *    ClickHouse would have to count to find out, and Flint is not going to run
 *    a second pass over the table to decorate a button. So it says what it
 *    knows — this is more than the preview — and names no figure.
 *  - **Whole, and counted.** A `MergeTree` knows exactly how many rows it
 *    holds. Say it.
 *  - **Whole, and uncountable.** A view has no row count, and neither does a
 *    table on an engine that does not keep one. An absent figure is dropped,
 *    not dashed: the sentence simply stops claiming a number.
 *
 *  In every case the preview's own `LIMIT` does not apply, and the wording says
 *  so — a download that quietly honoured it would hand back two hundred rows
 *  under a button labelled with the whole table.
 */
export function tableDownloadNote(
  total: number | null | undefined,
  filtered: boolean,
  rowsShown: number,
): string {
  if (filtered) {
    return `Downloads every row matching the filters above, not only the ${rowsShown.toLocaleString()} shown.`
  }
  if (total === null || total === undefined) {
    return `Downloads every row, not only the ${rowsShown.toLocaleString()} shown.`
  }
  const rows = total === 1 ? '1 row' : `${total.toLocaleString()} rows`
  return `Downloads all ${rows}, not only the ${rowsShown.toLocaleString()} shown.`
}

/** A filename stem from what the reader is actually looking at.
 *
 *  Kept in step with the server's own rule rather than duplicating it: the
 *  server sanitises whatever arrives, so this only has to produce something
 *  meaningful, not something safe. `analytics.events` beats `export` on a
 *  desktop that already holds four of them.
 */
export function stemFor(database: string | undefined, table: string | undefined): string {
  const parts = [database, table].filter((p): p is string => Boolean(p && p.trim()))
  return parts.length ? parts.join('.') : 'export'
}

/** The same claim for a question asked through the form.
 *
 *  The editor's note reads the result to work out what a download will contain;
 *  here the *question* already says it. A form carries its own row limit, set
 *  in a field the reader can see, and the statement it generates carries that
 *  limit into the export — so the honest sentence names the figure the reader
 *  chose rather than the number of rows that happened to come back.
 *
 *  The two are not the same and the difference is the point: a run that
 *  returned 3 rows under a limit of 500 will still export at most 500, because
 *  the file is a re-run and the data may have moved since. Saying "3 rows"
 *  there would be a promise about somebody else's table.
 *
 *  A limit of zero is the form's way of saying *no limit*, and the download
 *  honours it — this is the one place in Flint where a whole result leaves the
 *  page, and the dataset API's own page cap does not travel with it. */
export function builtDownloadNote(limit: number): string {
  if (limit <= 0) return 'Downloads every row that matches — the form asks for no limit.'
  return `Downloads what the form asks for: at most ${limit.toLocaleString()} rows.`
}
