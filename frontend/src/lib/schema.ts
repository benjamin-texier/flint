/** The objects on a server, for the section that can remove them.
 *
 *  Server-wide, because Infrastructure has no object rail — the rail is Data's
 *  navigator and does not follow you across the line. */

export interface SchemaObject {
  database: string
  name: string
  qualified: string
  engine: string
  kind: string
  /** Null where the object stores nothing. A view has no rows, and zero would be
   *  an answer to a question nobody asked. */
  rows: number | null
  bytes: number | null
}

export interface SchemaReport {
  available: boolean
  reason?: string
  objects: SchemaObject[]
  total: number
}

/** Whether emptying this object means anything.
 *
 *  A view stores nothing, so `TRUNCATE` on one is not a dangerous operation — it
 *  is a meaningless one, and the backend refuses it. Not offering the control is
 *  better than offering one that explains itself only after being pressed. */
export function canTruncate(object: SchemaObject): boolean {
  return object.kind === 'table'
}

/** How the final button should read.
 *
 *  "Drop it" when nothing depends on it. "Drop it anyway" when something does —
 *  the word carries the fact that Flint just told you something would break, and
 *  a confirmation that reads identically in both cases wastes the warning it
 *  just gave. */
export function dropWording(dependents: number): string {
  return dependents > 0 ? 'Drop it anyway' : 'Drop it'
}
