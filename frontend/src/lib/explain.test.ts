import { describe, expect, it } from 'vitest'

import {
  engineBehaviour,
  explainEngine,
  internalName,
  splitEngine,
  storesParts,
  KIND_MEANING,
} from './explain'

describe('explainEngine', () => {
  it.each([
    ['MergeTree', /standard ClickHouse table/],
    ['ReplicatedMergeTree', /standard ClickHouse table/],
    ['SummingMergeTree', /Adds up the numeric columns/],
    ['ReplicatedSummingMergeTree', /Adds up the numeric columns/],
    ['ReplacingMergeTree', /last row for each sorting key/],
    ['AggregatingMergeTree', /aggregate functions/],
    ['Distributed', /fans queries out/],
    ['Memory', /RAM only/],
    ['MaterializedView', /every insert/],
    ['View', /saved query/],
    ['Dictionary', /in-memory lookup/],
  ])('explains %s', (engine, pattern) => {
    expect(explainEngine(engine)).toMatch(pattern)
  })

  it('prefers the more specific family', () => {
    // VersionedCollapsing must not be swallowed by the Collapsing entry.
    expect(explainEngine('VersionedCollapsingMergeTree')).toMatch(/version column/)
    expect(explainEngine('CollapsingMergeTree')).not.toMatch(/version column/)
  })

  it('returns null for an engine it does not know', () => {
    expect(explainEngine('SomeFutureEngine')).toBeNull()
  })

  it('keeps the view and dictionary sentences in step with the kind meanings', () => {
    expect(explainEngine('MaterializedView')).toBe(KIND_MEANING.materialized_view)
    expect(explainEngine('Dictionary')).toBe(KIND_MEANING.dictionary)
  })
})

describe('storesParts', () => {
  it('is true for the MergeTree family, where partitions and TTLs mean something', () => {
    expect(storesParts('MergeTree')).toBe(true)
    expect(storesParts('ReplicatedSummingMergeTree')).toBe(true)
  })

  it('is false for engines that keep no parts', () => {
    expect(storesParts('Memory')).toBe(false)
    expect(storesParts('View')).toBe(false)
    expect(storesParts('Distributed')).toBe(false)
  })
})

describe('internalName', () => {
  it('recognises the tables ClickHouse creates for a materialized view', () => {
    expect(internalName('.inner_id.3f49bf7f-aeb7-4931-b21f-cdc3ea412e03')).toBe(true)
    expect(internalName('.inner.daily_totals')).toBe(true)
  })

  it('leaves objects somebody wrote alone', () => {
    expect(internalName('events')).toBe(false)
    expect(internalName('inner_join_results')).toBe(false)
  })
})

describe('engineBehaviour', () => {
  it('separates a plain MergeTree from the family that collapses rows', () => {
    expect(engineBehaviour('MergeTree')).toBe('keeps')
    expect(engineBehaviour('ReplacingMergeTree')).toBe('folds')
    expect(engineBehaviour('SummingMergeTree')).toBe('folds')
    expect(engineBehaviour('VersionedCollapsingMergeTree')).toBe('folds')
  })

  it('reads through the Replicated and Shared prefixes', () => {
    expect(engineBehaviour('ReplicatedMergeTree')).toBe('keeps')
    expect(engineBehaviour('ReplicatedReplacingMergeTree')).toBe('folds')
    expect(engineBehaviour('SharedAggregatingMergeTree')).toBe('folds')
  })

  it('knows the engines that hold no rows of their own', () => {
    expect(engineBehaviour('Distributed')).toBe('passes')
    expect(engineBehaviour('Kafka')).toBe('passes')
    expect(engineBehaviour('MaterializedView')).toBe('passes')
    expect(engineBehaviour('Buffer')).toBe('passes')
  })

  /* `Merge` and `MergeTree` differ by four letters and mean opposite things
     here — one reads other tables, the other is the table. */
  it('does not read a MergeTree as a Merge', () => {
    expect(engineBehaviour('Merge')).toBe('passes')
    expect(engineBehaviour('MergeTree')).toBe('keeps')
  })

  it('assumes an engine it has never heard of keeps what it is given', () => {
    expect(engineBehaviour('Memory')).toBe('keeps')
    expect(engineBehaviour('SomeFutureEngine')).toBe('keeps')
  })
})

describe('splitEngine', () => {
  it('puts the qualifier first and the family second', () => {
    expect(splitEngine('ReplacingMergeTree')).toEqual(['Replacing', 'MergeTree'])
    expect(splitEngine('ReplicatedSummingMergeTree')).toEqual(['ReplicatedSumming', 'MergeTree'])
  })

  it('leaves a name with nothing to split whole', () => {
    expect(splitEngine('MergeTree')).toEqual(['', 'MergeTree'])
    expect(splitEngine('Distributed')).toEqual(['', 'Distributed'])
  })
})
