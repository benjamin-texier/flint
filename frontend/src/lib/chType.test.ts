import { describe, expect, it } from 'vitest'

import { family, isNumeric, isTemporal, shortType, unwrap } from './chType'

describe('unwrap', () => {
  it('strips Nullable and LowCardinality, however nested', () => {
    expect(unwrap('LowCardinality(Nullable(String))')).toBe('String')
    expect(unwrap('Nullable(DateTime64(3))')).toBe('DateTime64(3)')
  })

  it('takes the value type out of a SimpleAggregateFunction', () => {
    expect(unwrap('SimpleAggregateFunction(sum, UInt64)')).toBe('UInt64')
  })

  it('leaves a plain type alone', () => {
    expect(unwrap('Array(String)')).toBe('Array(String)')
  })
})

describe('family', () => {
  it.each([
    ['UInt64', 'number'],
    ['Int8', 'number'],
    ['Float32', 'number'],
    ['Decimal(10, 2)', 'number'],
    ['String', 'string'],
    ['FixedString(16)', 'string'],
    ['UUID', 'string'],
    ['IPv6', 'string'],
    ['Date', 'time'],
    ['DateTime64(3)', 'time'],
    ['Bool', 'bool'],
    ["Enum8('a' = 1)", 'bool'],
    ['Array(String)', 'nested'],
    ['Map(String, UInt64)', 'nested'],
    ['Tuple(UInt8, String)', 'nested'],
    ['JSON', 'nested'],
    ['Point', 'other'],
  ])('classifies %s as %s', (type, expected) => {
    expect(family(type)).toBe(expected)
  })

  it('classifies through the wrappers', () => {
    expect(family('LowCardinality(Nullable(String))')).toBe('string')
    expect(family('Nullable(UInt32)')).toBe('number')
  })
})

describe('numeric and temporal predicates', () => {
  it('recognises numbers for right-alignment', () => {
    expect(isNumeric('Nullable(Float64)')).toBe(true)
    expect(isNumeric('String')).toBe(false)
  })

  it('recognises timestamps', () => {
    expect(isTemporal('DateTime')).toBe(true)
    expect(isTemporal('UInt32')).toBe(false)
  })
})

describe('shortType', () => {
  it('abbreviates the long wrappers without losing the inner type', () => {
    expect(shortType('LowCardinality(Nullable(String))')).toBe('LowCard(Nullable(String))')
  })
})
