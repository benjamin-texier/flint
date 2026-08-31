import { describe, expect, it } from 'vitest'

import { ceiling, current, gaps, paths, peak, saturation, type Series } from './health'

const series = (values: (number | null)[], over: Partial<Series> = {}): Series => ({
  key: 'memory',
  label: 'Memory tracked',
  says: 'what it says',
  unit: 'count',
  points: values.map((v, i) => ({ t: `2026-08-25 12:0${i}:00`, v })),
  ...over,
})

describe('current', () => {
  it('is the last value that was measured, not the last point', () => {
    // A trailing gap must not read as "it dropped to nothing".
    expect(current(series([4, 9, null, null]))).toBe(9)
  })

  it('is null when nothing was measured at all', () => {
    expect(current(series([null, null]))).toBeNull()
    expect(current(series([]))).toBeNull()
  })
})

describe('peak', () => {
  it('ignores gaps', () => {
    expect(peak(series([1, null, 7, 3]))).toBe(7)
  })

  it('is null rather than zero when nothing was measured', () => {
    // Zero is a measurement. "Nothing was measured" is not.
    expect(peak(series([null]))).toBeNull()
  })
})

describe('gaps', () => {
  it('counts what could not be measured', () => {
    expect(gaps(series([1, null, 2, null, null]))).toBe(3)
    expect(gaps(series([1, 2]))).toBe(0)
  })
})

describe('ceiling', () => {
  it('uses a real limit exactly, so half full looks half full', () => {
    expect(ceiling(series([16], { limit: 32 }))).toBe(32)
  })

  it('leaves air above the peak when there is no limit', () => {
    // A flat line pinned to the top of its frame is indistinguishable from the
    // frame itself.
    expect(ceiling(series([100]))).toBeCloseTo(105)
  })

  it('never returns zero', () => {
    // A zero-height scale has no line in it, and dividing by it is worse.
    expect(ceiling(series([0, 0]))).toBe(1)
    expect(ceiling(series([null]))).toBe(1)
  })
})

describe('paths', () => {
  it('draws one run through measured points', () => {
    const [only, ...rest] = paths(series([0, 50, 100], { limit: 100 }), 100, 10)
    expect(rest).toEqual([])
    // Y is flipped: the largest value sits at the top of the box, which is y=0.
    expect(only).toBe('0.0,10.0 50.0,5.0 100.0,0.0')
  })

  it('breaks the line where nothing was measured', () => {
    // The rule this whole module exists for: a gap is drawn as a gap, because a
    // line diving to the floor says "it went bad" and a break says "nobody
    // knows".
    const runs = paths(series([10, null, 10], { limit: 10 }), 100, 10)
    expect(runs).toHaveLength(2)
  })

  it('makes a lone measured point visible instead of invisible', () => {
    const runs = paths(series([null, 5, null], { limit: 10 }), 100, 10)
    expect(runs).toHaveLength(1)
    // Doubled into a degenerate segment: a polyline of one point draws nothing.
    expect(runs[0]!.split(' ')).toHaveLength(2)
    expect(runs[0]!.split(' ')[0]).toBe(runs[0]!.split(' ')[1])
  })

  it('has nothing to draw for an empty window', () => {
    expect(paths(series([]), 100, 10)).toEqual([])
  })

  it('clamps a value above its own limit rather than drawing outside the box', () => {
    const [run] = paths(series([200], { limit: 100 }), 100, 10)
    expect(run).toBe('0.0,0.0 0.0,0.0')
  })
})

describe('saturation', () => {
  it('reports how close to a real ceiling it came', () => {
    expect(saturation(series([24], { limit: 32 }))).toBeCloseTo(75)
  })

  it('is null without a limit, because a share of nothing is not a figure', () => {
    expect(saturation(series([24]))).toBeNull()
  })

  it('is null when nothing was measured', () => {
    expect(saturation(series([null], { limit: 32 }))).toBeNull()
  })
})
