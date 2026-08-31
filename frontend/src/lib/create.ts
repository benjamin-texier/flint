/** Running a `CREATE` somebody wrote.
 *
 *  Nothing here validates SQL, and nothing needs to: ClickHouse's HTTP interface
 *  refuses a body holding more than one statement and runs neither of them, which
 *  is a stronger guarantee than any string matching could give. What these do is
 *  shape the offer — find the name so the form can change it, and notice when
 *  nobody has.
 */

/** The object a `CREATE` names, or null where it cannot tell.
 *
 *  A regular expression over DDL is the wrong tool for understanding a statement
 *  and the right one for this: being wrong costs a suggestion rather than a
 *  statement, so it gives up instead of guessing.
 */
export function names(ddl: string): string | null {
  const m = ddl.match(
    /^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMPORARY\s+)?(?:MATERIALIZED\s+VIEW|LIVE\s+VIEW|WINDOW\s+VIEW|VIEW|TABLE|DICTIONARY|DATABASE)\s+(?:IF\s+NOT\s+EXISTS\s+)?([`\w.]+)/i,
  )
  const found = m?.[1]
  return found ? found.replace(/`/g, '') : null
}

/** Whether the statement still names the object it was copied from.
 *
 *  The offer is "start from this table's definition", and the name is the first
 *  thing that has to change — otherwise the server answers "already exists" and
 *  the form looks broken rather than unfinished.
 */
export function stillNamed(ddl: string, original: string): boolean {
  return names(ddl) === original
}

/** Rename the object a definition creates, for the starting point.
 *
 *  The first occurrence only: a column that happens to share the table's name is
 *  not the thing being renamed.
 */
export function renamed(ddl: string, from: string, to: string): string {
  const at = ddl.indexOf(from)
  if (at === -1) return ddl
  return ddl.slice(0, at) + to + ddl.slice(at + from.length)
}
