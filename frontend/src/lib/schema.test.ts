import { describe, expect, it } from 'vitest'

import { canTruncate, dropWording, type SchemaObject } from './schema'

const object = (over: Partial<SchemaObject> = {}): SchemaObject => ({
  database: 'analytics',
  name: 'events',
  qualified: 'analytics.events',
  engine: 'MergeTree',
  kind: 'table',
  rows: 504328,
  bytes: 2815045,
  ...over,
})

describe('canTruncate', () => {
  it('offers it only where there are rows to remove', () => {
    expect(canTruncate(object())).toBe(true)
    // A view stores nothing: truncating one is not dangerous, it is
    // meaningless — and a control that explains itself only after being pressed
    // is worse than no control.
    expect(canTruncate(object({ kind: 'view' }))).toBe(false)
    expect(canTruncate(object({ kind: 'materialized view' }))).toBe(false)
    expect(canTruncate(object({ kind: 'dictionary' }))).toBe(false)
  })
})

describe('dropWording', () => {
  it('changes when something is about to break', () => {
    // A confirmation that reads identically whether or not Flint just warned you
    // wastes the warning.
    expect(dropWording(0)).toBe('Drop it')
    expect(dropWording(1)).toBe('Drop it anyway')
    expect(dropWording(9)).toBe('Drop it anyway')
  })
})
