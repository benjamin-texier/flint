import { describe, expect, it } from 'vitest'

import { edgeClass, edgeLabel, edgesOf, NO_EDGES } from './edges'

describe('edgesOf', () => {
  it('reports neither side when everything fits', () => {
    expect(edgesOf(0, 800, 800)).toEqual(NO_EDGES)
  })

  it('reports the right side on a scroller nobody has touched', () => {
    expect(edgesOf(0, 800, 1280)).toEqual({ left: false, right: true })
  })

  it('reports both sides in the middle', () => {
    expect(edgesOf(200, 800, 1280)).toEqual({ left: true, right: true })
  })

  it('reports only the left side at the end', () => {
    expect(edgesOf(480, 800, 1280)).toEqual({ left: true, right: false })
  })

  // Sub-pixel layout leaves a fraction of a pixel at either end, and a shade
  // for a scroll nobody can perform is a shade that cries wolf.
  it('treats a sub-pixel remainder as no edge at all', () => {
    expect(edgesOf(0, 800, 801.5)).toEqual(NO_EDGES)
    expect(edgesOf(478.6, 800, 1280)).toEqual({ left: true, right: false })
    expect(edgesOf(1.4, 800, 1280)).toEqual({ left: false, right: true })
  })
})

describe('edgeClass', () => {
  it('is empty when nothing continues', () => {
    expect(edgeClass(NO_EDGES)).toBe('')
  })

  it('names each side that continues', () => {
    expect(edgeClass({ left: false, right: true })).toBe(' is-more-right')
    expect(edgeClass({ left: true, right: true })).toBe(' is-more-left is-more-right')
  })
})

describe('edgeLabel', () => {
  it('leaves the name alone when the whole table is on screen', () => {
    expect(edgeLabel('Objects', NO_EDGES)).toBe('Objects')
  })

  it('says the region scrolls once part of it is off screen', () => {
    expect(edgeLabel('Objects', { left: false, right: true })).toBe('Objects, scrolls sideways')
  })
})
