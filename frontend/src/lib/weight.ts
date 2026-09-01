/** What a table weighs, and whether Flint was allowed to find out.
 *
 *  ClickHouse answers the question twice and Flint reads both, which sounds like
 *  redundancy and is the opposite: the two sources fail in different places, and
 *  a page that knows only one of them goes blank where the other would have
 *  answered.
 *
 *  - **`system.parts`** is the accurate reading, summed over the active parts,
 *    and it is the one a role is most often refused. A read-only account granted
 *    `system.tables` and nothing else is an ordinary deployment; ClickHouse's own
 *    public demo server is one.
 *  - **`system.tables.total_bytes`** comes back for everybody who can see the
 *    table at all — and for a MergeTree it is `sum(bytes_on_disk)` over exactly
 *    the same parts, to the byte. It is the *same figure*, not an approximation
 *    of it.
 *
 *  So the fallback costs nothing in accuracy, and it is the difference between a
 *  server whose every size reads `0 B` and one that reports seven terabytes.
 *
 *  The compression ratio is a separate matter and used to be wrong. It needs the
 *  *uncompressed* size, which only `system.tables.total_bytes_uncompressed`
 *  carries; built from the two compressed figures, as it was, it read `1.0×` for
 *  every MergeTree table on every server — a column that looked measured and
 *  said nothing.
 */

/** The three fields any weighable object carries. Structural rather than a
 *  named type, so a table summary, a graph node and a search result can all be
 *  weighed without any of them importing the others. */
export interface Weighable {
  total_bytes?: number | null
  uncompressed_bytes?: number | null
  parts_bytes?: number | null
}

/** What this object occupies, or `null` where nothing said.
 *
 *  `null` is not zero, and keeping them apart is the whole point of the return
 *  type. An empty table is `0` and should print `0 B`; a table on a server whose
 *  `system.parts` is refused is `null` and should print nothing at all — Flint
 *  asked the wrong question, and four em-dashes claim it asked the right one and
 *  got no answer.
 */
export function onDisk(t: Weighable): number | null {
  /* `system.tables` first, and not merely because it is the one that survives a
     missing grant: it is also the only one with an answer for an engine that
     has no parts — a Log table, a Memory table, a Dictionary. `parts_bytes`
     covers the reverse case, a build or an engine where `total_bytes` is null
     but the parts are countable. */
  if (typeof t.total_bytes === 'number') return t.total_bytes
  if (typeof t.parts_bytes === 'number' && t.parts_bytes > 0) return t.parts_bytes
  return null
}

/** How much smaller the stored form is than the raw one, as a multiple.
 *
 *  `null` unless both halves are real and the arithmetic means something. In
 *  particular an empty table has no ratio: dividing zero by zero is not `1.0×`,
 *  and a table with nothing in it has not compressed anything.
 */
export function compression(t: Weighable): number | null {
  const raw = t.uncompressed_bytes
  const stored = onDisk(t)
  if (typeof raw !== 'number' || raw <= 0) return null
  if (stored === null || stored <= 0) return null
  const ratio = raw / stored
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null
}

/** What a set of objects weighs together, and how many of them could not say.
 *
 *  Both halves are returned because a header that prints a total without saying
 *  how much of the list it covers is a header nobody can reconcile — the rule
 *  the object lists already follow. `known: 0` is what a server with no
 *  `system.parts` and no `total_bytes` produces, and the caller drops the figure
 *  rather than printing `0 B`.
 */
export function weigh(objects: Weighable[]): { bytes: number; known: number; silent: number } {
  let bytes = 0
  let known = 0
  let silent = 0
  for (const object of objects) {
    const size = onDisk(object)
    if (size === null) silent += 1
    else {
      bytes += size
      known += 1
    }
  }
  return { bytes, known, silent }
}
