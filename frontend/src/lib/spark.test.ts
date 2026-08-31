import { describe, expect, it } from 'vitest'

import { sparkline } from './spark'

const BOX = { width: 100, height: 20, inset: 0 }

describe('sparkline', () => {
  it('puts the peak at the top and the smallest value at the bottom', () => {
    const { segments, peak } = sparkline([1, 2, 4], BOX)
    expect(peak).toBe(4)
    expect(segments).toHaveLength(1)
    const points = segments[0]!.split(' ').map((p) => p.split(',').map(Number))
    expect(points[0]).toEqual([0, 15]) // 1/4 of the way up a 20px box
    expect(points[2]).toEqual([100, 0])
  })

  it('breaks the line at a hole rather than drawing through it', () => {
    // The rule that makes this different from any charting sparkline: a bucket a
    // table has nothing in is the absence of a measurement, not a measurement of
    // nothing. Joining across it draws a dive to the floor and a climb back out
    // — an event that did not happen.
    const { segments, dots } = sparkline([4, 4, undefined, 4, 4], BOX)
    expect(segments).toHaveLength(2)
    expect(dots).toHaveLength(0)
    expect(segments[0]).toBe('0,0 25,0')
    expect(segments[1]).toBe('75,0 100,0')
  })

  it('draws a lone value as a dot, since a segment of one draws nothing', () => {
    const { segments, dots } = sparkline([undefined, 5, undefined], BOX)
    expect(segments).toHaveLength(0)
    expect(dots).toEqual([{ x: 50, y: 0 }])
  })

  it('is nothing at all when there is nothing to draw', () => {
    // Dropped rather than drawn as a flat line on the floor, which would say the
    // table held nothing rather than that nothing is known.
    expect(sparkline([], BOX)).toEqual({ segments: [], dots: [], peak: 0 })
    expect(sparkline([undefined, undefined], BOX)).toEqual({ segments: [], dots: [], peak: 0 })
    expect(sparkline([0, 0], BOX)).toEqual({ segments: [], dots: [], peak: 0 })
  })

  it('centres a single column instead of pinning it to the left edge', () => {
    // At the left edge it reads as the start of a line that is not there.
    expect(sparkline([7], BOX).dots).toEqual([{ x: 50, y: 0 }])
  })

  it('keeps the stroke inside the box', () => {
    // A value at the peak drawn at y=0 is sliced in half by the edge.
    const { segments } = sparkline([1, 9], { width: 100, height: 20, inset: 2 })
    const ys = segments[0]!.split(' ').map((p) => Number(p.split(',')[1]))
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(2)
    expect(Math.max(...ys)).toBeLessThanOrEqual(18)
  })

  it('scales to its own peak, not to anything outside it', () => {
    // Two rows of very different size have the same shape drawn at the same
    // height on purpose: the figures beside them already say which is bigger,
    // and a row flattened against its neighbour's maximum says nothing.
    const small = sparkline([1, 2], BOX).segments[0]
    const large = sparkline([1000, 2000], BOX).segments[0]
    expect(small).toBe(large)
  })
})
