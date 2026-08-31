import { describe, expect, it } from 'vitest'

import { bytes, count, duration, exact, partsLabel, ratio, shortTime, splitTail, stretch } from './format'

describe('bytes', () => {
  it('scales to binary units', () => {
    expect(bytes(0)).toBe('0 B')
    expect(bytes(512)).toBe('512 B')
    expect(bytes(1024)).toBe('1.0 KiB')
    expect(bytes(1536)).toBe('1.5 KiB')
    expect(bytes(1024 ** 3 * 4.1)).toBe('4.1 GiB')
    expect(bytes(1024 ** 2 * 38)).toBe('38 MiB')
  })

  it('renders an absent value as a dash', () => {
    expect(bytes(null)).toBe('—')
  })
})

describe('count', () => {
  it('leaves small numbers exact and abbreviates large ones', () => {
    expect(count(0)).toBe('0')
    expect(count(999)).toBe('999')
    expect(count(1_240_000_000)).toBe('1.2 B')
    expect(count(540_495)).toBe('540.5 K')
  })

  it('renders an absent value as a dash', () => {
    expect(count(null)).toBe('—')
    expect(exact(undefined)).toBe('—')
  })
})

describe('duration', () => {
  it('picks the precision a human cares about', () => {
    expect(duration(0.0004)).toBe('<1 ms')
    expect(duration(0.031)).toBe('31 ms')
    expect(duration(1.234)).toBe('1.23 s')
    expect(duration(75)).toBe('1m 15s')
  })
})

describe('ratio', () => {
  it('reports a compression ratio', () => {
    expect(ratio(1000, 250)).toBe('4.0×')
    expect(ratio(52_940_460, 768_169)).toBe('69×')
  })

  it('returns null when there is nothing to compare', () => {
    expect(ratio(0, 100)).toBeNull()
    expect(ratio(100, 0)).toBeNull()
  })
})

describe('shortTime', () => {
  it('trims to minutes', () => {
    expect(shortTime('2026-06-01 12:03:44')).toBe('2026-06-01 12:03')
  })

  it('treats the epoch as absent, because ClickHouse uses it as a null', () => {
    expect(shortTime('1970-01-01 00:00:00')).toBe('—')
    expect(shortTime('')).toBe('—')
  })
})

describe('splitTail', () => {
  it('leaves a short name whole', () => {
    expect(splitTail('weather')).toEqual(['weather', ''])
  })

  it('keeps the last segment, which is what tells two names apart', () => {
    expect(splitTail('sensor_readings_hourly_latest')).toEqual([
      'sensor_readings_hourly',
      '_latest',
    ])
    expect(splitTail('warehouse_stock_movements')).toEqual(['warehouse_stock', '_movements'])
  })

  it('falls back to the last few characters when there is no segment to keep', () => {
    // `.inner_id.<uuid>` names differ only in the middle of the uuid, so the
    // end is still the better half to protect.
    const [head, tail] = splitTail('.inner_id.a07f1dc9-c81f-466a-8e68-d0dc5c6878ce')
    expect(tail).toBe('6878ce')
    expect(head + tail).toBe('.inner_id.a07f1dc9-c81f-466a-8e68-d0dc5c6878ce')
  })

  it('never loses a character', () => {
    for (const name of ['events', 'order_totals_rollup_mv', 'shipment_status_history']) {
      const [head, tail] = splitTail(name)
      expect(head + tail).toBe(name)
    }
  })
})

describe('partsLabel', () => {
  it('says nothing extra when there is only one partition', () => {
    expect(partsLabel(9, 1)).toBe('active parts')
    expect(partsLabel(9, 0)).toBe('active parts')
  })

  it('counts one part in the singular', () => {
    expect(partsLabel(1, 1)).toBe('active part')
    expect(partsLabel(1, 4)).toBe('active part')
  })

  it('reads a healthy table as about one part per partition', () => {
    expect(partsLabel(55, 50)).toBe('active parts · ~1 per partition')
  })

  it('gives a decimal while the number is small enough to care about', () => {
    expect(partsLabel(24, 10)).toBe('active parts · 2.4 per partition')
  })

  it('rounds once merges are plainly behind', () => {
    expect(partsLabel(4000, 40)).toBe('active parts · 100 per partition')
  })
})

describe('stretch', () => {
  it('reads a span of data at the coarseness it deserves', () => {
    expect(stretch(0.4)).toBe('<1 s')
    expect(stretch(45)).toBe('45 s')
    expect(stretch(600)).toBe('10 min')
    expect(stretch(12_000)).toBe('3 h 20 min')
    expect(stretch(7200)).toBe('2 h')
    expect(stretch(90_000)).toBe('1 d 1 h')
    expect(stretch(172_800)).toBe('2 d')
  })
})
