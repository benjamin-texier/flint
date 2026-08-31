/** Where a table's data is allowed to live.
 *
 *  The judgements come from the backend, where they are tested against measured
 *  behaviour rather than against the shape of the tables — including the one that
 *  matters most, that a volume whose free space is under its policy's move factor
 *  is being drained continuously and will not keep anything moved onto it.
 */

export interface Disk {
  name: string
  path: string
  free: number
  total: number
  type: string
  /** The policies whose volumes include this disk. Empty means nothing can ever
   *  be written here. */
  used_by: string[]
}

export interface Volume {
  policy: string
  volume: string
  priority: number
  disks: string[]
  kind: string
  /** A part bigger than this skips the volume. Zero means no cap. */
  max_part: number
  move_factor: number
  /** Whether the server is draining it right now. */
  draining: boolean
  free_ratio: number
}

export interface StorageReport {
  disks: { items: Disk[]; blocked?: string }
  volumes: { items: Volume[]; blocked?: string }
  verdicts: string[]
}

/** Volumes grouped by their policy, in the order the server tries them. */
export function byPolicy(volumes: Volume[]): { policy: string; volumes: Volume[] }[] {
  const out: { policy: string; volumes: Volume[] }[] = []
  for (const v of [...volumes].sort((a, b) => a.priority - b.priority)) {
    const found = out.find((g) => g.policy === v.policy)
    if (found) found.volumes.push(v)
    else out.push({ policy: v.policy, volumes: [v] })
  }
  return out.sort((a, b) => a.policy.localeCompare(b.policy))
}

/** Where a partition could be moved, given the policy its table uses.
 *
 *  Only volumes of that policy: `MOVE PARTITION TO VOLUME` names a volume of the
 *  table's own policy, and offering one from another policy produces a statement
 *  the server refuses.
 */
export function destinationsFor(volumes: Volume[], policy: string): Volume[] {
  return byPolicy(volumes).find((g) => g.policy === policy)?.volumes ?? []
}

/** What a volume's own cap means, in words — or null where it has none. */
export function saysCap(v: Volume): string | null {
  if (v.max_part === 0) return null
  return `takes no part over ${v.max_part} bytes`
}
