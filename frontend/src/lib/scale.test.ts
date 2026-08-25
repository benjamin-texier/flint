import { describe, expect, it } from 'vitest'

import { barScale } from './scale'

describe('barScale', () => {
  it('is the maximum on a narrow table, where a percentile would only distort', () => {
    expect(barScale([10, 20, 30, 40])).toBe(40)
    expect(barScale([7])).toBe(7)
  })

  it('ignores the outlier that would flatten every other bar', () => {
    expect(barScale([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10_000])).toBe(10)
  })

  it('counts only the columns that hold something', () => {
    expect(barScale([0, 0, 0, 5])).toBe(5)
    expect(barScale([0, 0])).toBe(0)
  })
})
