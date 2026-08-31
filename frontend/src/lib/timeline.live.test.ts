/** The bucket-spelling contract, against a real server.
 *
 *  `timeline.ts` claims that `bucketOf` spells a bucket exactly as
 *  `clickhouse::timeline::Grain::column` spells it, and the whole continuous
 *  axis rests on that: the client generates the columns *between* the observed
 *  ones, so one character of difference produces two columns for one month — one
 *  from the server with data in it and one generated and always empty.
 *
 *  Neither side could check that claim alone. The Rust tests assert which date
 *  functions the SQL calls; the Vitest ones assert what the TypeScript formats.
 *  Nothing compared the two, which is the one comparison that matters, and it
 *  cannot be made without a ClickHouse: the server's own timezone, its week
 *  start and its version all get a say.
 *
 *  So this runs only when pointed at a Flint, and is skipped everywhere else:
 *
 *      FLINT_LIVE=http://127.0.0.1:8098 pnpm vitest run src/lib/timeline.live
 *
 *  `make check-live` does it, alongside the other checks that need something
 *  running. */

import { describe, expect, it } from 'vitest'

import {
  GRAINS,
  bucketOf,
  bucketSequence,
  parseStamp,
  type Grain,
  type PartitionTimeline,
} from './timeline'

const BASE = process.env.FLINT_LIVE
const UNPLACEABLE = new Set(['undated', 'all', 'tuple()'])

async function timeline(database: string, grain: Grain): Promise<PartitionTimeline> {
  const at = `${BASE}/api/databases/${encodeURIComponent(database)}/timeline?grain=${grain}`
  const answer = await fetch(at)
  if (!answer.ok) throw new Error(`${at} answered ${answer.status}`)
  return answer.json()
}

/** The fullest database this server has, since a check against an empty one
 *  proves nothing and passing is not the same as having looked. */
async function busiest(): Promise<string> {
  const list = (await (await fetch(`${BASE}/api/databases`)).json()) as {
    name: string
    bytes: number
  }[]
  const pick = [...list].sort((a, b) => b.bytes - a.bytes).find((d) => d.bytes > 0)
  if (!pick) throw new Error('no database on this server holds any data')
  return pick.name
}

describe.skipIf(!BASE)('the bucket spelling agrees with the server', () => {
  it('names every cell the way the client would name it', async () => {
    const database = await busiest()
    for (const grain of GRAINS) {
      if (grain === 'partition') continue
      const report = await timeline(database, grain)
      if (!report.available || report.cells.length === 0) continue

      const dated = report.cells.filter((c) => !UNPLACEABLE.has(c.partition))
      // A server with nothing dated says so through `datable`, and there is
      // nothing to compare; anything else has to agree cell by cell.
      if (!report.datable) {
        expect(dated).toHaveLength(0)
        continue
      }
      expect(dated.length).toBeGreaterThan(0)

      for (const cell of dated) {
        const at = parseStamp(cell.covers_from ?? '')
        expect(at, `${grain}: cell ${cell.table}/${cell.partition} carries no range`).not.toBeNull()
        expect(bucketOf(grain, at!), `${grain}: ${cell.table} at ${cell.covers_from}`).toBe(
          cell.partition,
        )
      }
    }
  })

  it('fills the axis without inventing a column beside an observed one', async () => {
    // The failure this catches: a generated sequence one character off, or one
    // bucket out of step, leaves the real column and a permanently empty
    // neighbour side by side — which reads as a gap in the data.
    const database = await busiest()
    for (const grain of GRAINS) {
      if (grain === 'partition') continue
      const report = await timeline(database, grain)
      if (!report.available || !report.span_from || !report.span_to) continue

      const generated = new Set(bucketSequence(grain, report.span_from, report.span_to))
      if (generated.size === 0) continue // past the cap; the axis is not filled
      const observed = new Set(
        report.cells.map((c) => c.partition).filter((p) => !UNPLACEABLE.has(p)),
      )
      const orphans = [...observed].filter((p) => !generated.has(p))
      expect(orphans, `${grain}: observed buckets the generated axis does not contain`).toEqual([])
    }
  })
})
