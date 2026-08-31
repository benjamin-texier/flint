/** Reading a file into a table: the parts that are decisions rather than DOM.
 *
 *  Everything here is a guess offered to the reader, never one acted on
 *  silently. The format decides how every byte of the file is read, and a
 *  wrong guess produces either an error or — much worse — a table full of
 *  rows split in the wrong places. So the guess is a default in a control the
 *  reader can see and change, and the preview is what confirms it. */

/** The formats Flint reads a file as.
 *
 *  Text only. Parquet is not here, and its absence is a consequence rather
 *  than an oversight: the sample is inferred by sending it to the server as a
 *  `String` parameter, and a `String` is text. The promise this feature makes
 *  is that the parsed rows are on screen before anything is written, and that
 *  is the promise a binary format would break. */
export const FORMATS = ['CSVWithNames', 'CSV', 'TSVWithNames', 'TSV', 'JSONEachRow'] as const
export type Format = (typeof FORMATS)[number]

/** What this file probably is, from its name and its first line.
 *
 *  The extension decides the delimiter and the first line decides whether
 *  there is a header, which is the half a file name cannot answer. The test
 *  for a header is that no field in the first line parses as a number — crude,
 *  and right on the files people actually have, where a header is words and a
 *  data row usually has an id or a date in it. It is a default, and the
 *  preview is what settles it. */
export function guessFormat(fileName: string, firstLine: string): Format {
  const name = fileName.toLowerCase()
  if (/\.(ndjson|jsonl)$/.test(name) || firstLine.trimStart().startsWith('{')) return 'JSONEachRow'
  const tabbed = /\.(tsv|tab)$/.test(name) || (firstLine.includes('\t') && !firstLine.includes(','))
  return looksLikeHeader(firstLine, tabbed ? '\t' : ',')
    ? tabbed
      ? 'TSVWithNames'
      : 'CSVWithNames'
    : tabbed
      ? 'TSV'
      : 'CSV'
}

/** Whether a line reads as names rather than as values. */
export function looksLikeHeader(line: string, delimiter: string): boolean {
  const fields = line
    .trim()
    .split(delimiter)
    .map((f) => f.trim().replace(/^"|"$/g, ''))
  if (fields.length === 0 || fields.every((f) => f === '')) return false
  // A single empty-ish field is not evidence either way; anything numeric is
  // evidence against.
  return fields.every((f) => f !== '' && !/^-?\d+(\.\d+)?$/.test(f))
}

export interface Mapping {
  matched: string[]
  unmatched: string[]
  defaulted: string[]
  by_name: boolean
}

/** What the mapping means for this import, in sentences.
 *
 *  Strings with backticks, rendered by `Sentence` — the convention that keeps
 *  the wording assertable and keeps backticks off the screen.
 *
 *  The unmatched case is the one worth being loud about, and only for a format
 *  that matches by name: a `*WithNames` file with a column the table does not
 *  have is an error at import, whereas a headerless one is matched by position
 *  and never consults a name at all. Two different facts, and reporting the
 *  second as the first would send somebody renaming columns for no reason. */
export function saysMapping(mapping: Mapping, fileColumns: number): string[] {
  const out: string[] = []
  const names = (list: string[]) => list.map((n) => `\`${n}\``).join(', ')

  if (!mapping.by_name) {
    out.push(
      `This format carries no column names, so the ${fileColumns} fields are matched to the table by position, left to right. The names above are the ones the server invented to describe them.`,
    )
    return out
  }

  out.push(
    mapping.matched.length === fileColumns
      ? `All ${fileColumns} of the file's columns match a column of the table.`
      : `${mapping.matched.length} of the file's ${fileColumns} columns match: ${names(mapping.matched)}.`,
  )
  if (mapping.unmatched.length > 0) {
    out.push(
      `${names(mapping.unmatched)} ${
        mapping.unmatched.length === 1 ? 'has' : 'have'
      } no column of that name in the table, and the import will be refused rather than dropping ${
        mapping.unmatched.length === 1 ? 'it' : 'them'
      }.`,
    )
  }
  if (mapping.defaulted.length > 0) {
    out.push(
      `The file says nothing about ${names(mapping.defaulted)}, so ${
        mapping.defaulted.length === 1 ? 'it takes its' : 'they take their'
      } default.`,
    )
  }
  return out
}

/** Whether this file can be imported as it stands. */
export function blocked(mapping: Mapping): boolean {
  return mapping.by_name && mapping.unmatched.length > 0
}

/** A file size as a reader would say it. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
