import { describe, expect, it } from 'vitest'

import {
  barScales,
  columnAggregate,
  nextAggregate,
  barWidth,
  cellText,
  selectionStats,
  displayOrder,
  inSpan,
  nextSort,
  prettyJSON,
  rawText,
  sampleColumn,
  shapeKey,
  span,
  spanSize,
  toTSV,
  widthChars,
} from './grid'

describe('cellText', () => {
  it('tells a NULL apart from an empty string', () => {
    expect(cellText(null)).toEqual({ text: 'NULL', kind: 'null' })
    expect(cellText(undefined)).toEqual({ text: 'NULL', kind: 'null' })
    expect(cellText('')).toEqual({ text: "''", kind: 'empty' })
  })

  it('leaves a big integer as the string it arrived as', () => {
    expect(cellText('9007199254740993')).toEqual({ text: '9007199254740993', kind: 'value' })
  })

  it('renders a structured value as compact JSON', () => {
    expect(cellText(['a', 'b']).text).toBe('["a","b"]')
  })
})

describe('rawText', () => {
  it('sends a NULL out as an empty field', () => {
    expect(rawText(null)).toBe('')
  })

  it('does not decorate an empty string', () => {
    expect(rawText('')).toBe('')
  })
})

describe('widthChars', () => {
  it('caps a column however long its values are', () => {
    const wide = widthChars({ name: 'payload', type: 'String' }, ['x'.repeat(4000)])
    expect(wide).toBe(64)
  })

  it('narrows to the values present rather than the type', () => {
    const codes = widthChars({ name: 'cc', type: 'String' }, ['FR', 'DE', 'BE'])
    const urls = widthChars({ name: 'cc', type: 'String' }, ['https://example.com/a/rather/long/path'])
    expect(codes).toBeLessThan(urls)
  })

  it('still leaves room for the header when the values are tiny', () => {
    const w = widthChars({ name: 'is_nullable_flag', type: 'UInt8' }, ['0', '1'])
    expect(w).toBeGreaterThanOrEqual('is_nullable_flag'.length)
  })

  it('falls back to the type when there is nothing to measure', () => {
    expect(widthChars({ name: 'ts', type: 'DateTime' }, [])).toBe(21)
  })
})

describe('sampleColumn', () => {
  it('never walks more than a couple of hundred values', () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => [i])
    expect(sampleColumn(rows, 0).length).toBeLessThanOrEqual(200)
  })

  it('reads the right column', () => {
    expect(sampleColumn([['a', 'b']], 1)).toEqual(['b'])
  })
})

describe('nextSort', () => {
  it('cycles ascending, descending, off', () => {
    const asc = nextSort([], 2)
    expect(asc).toEqual([{ column: 2, dir: 'asc' }])
    const desc = nextSort(asc, 2)
    expect(desc).toEqual([{ column: 2, dir: 'desc' }])
    expect(nextSort(desc, 2)).toEqual([])
  })

  it('starts over on a different column', () => {
    expect(nextSort([{ column: 2, dir: 'desc' }], 3)).toEqual([{ column: 3, dir: 'asc' }])
  })

  it('adds a level on a shift-click, in the order they were clicked', () => {
    const first = nextSort([], 1)
    const both = nextSort(first, 3, true)
    expect(both).toEqual([
      { column: 1, dir: 'asc' },
      { column: 3, dir: 'asc' },
    ])
  })

  it('cycles a level in place, and drops it on the third click', () => {
    const levels = [
      { column: 1, dir: 'asc' as const },
      { column: 3, dir: 'asc' as const },
    ]
    const flipped = nextSort(levels, 1, true)
    expect(flipped[0]).toEqual({ column: 1, dir: 'desc' })
    expect(flipped[1]).toEqual({ column: 3, dir: 'asc' })
    expect(nextSort(flipped, 1, true)).toEqual([{ column: 3, dir: 'asc' }])
  })

  it('collapses a stack to one column on a plain click', () => {
    const levels = [
      { column: 1, dir: 'desc' as const },
      { column: 3, dir: 'asc' as const },
    ]
    expect(nextSort(levels, 1)).toEqual([{ column: 1, dir: 'asc' }])
  })
})

describe('displayOrder', () => {
  const columns = [
    { name: 'n', type: 'Int64' },
    { name: 's', type: 'String' },
  ]

  it('is the identity without a sort', () => {
    const rows = [[3, 'c'], [1, 'a']]
    expect(displayOrder(rows, columns, [])).toEqual([0, 1])
  })

  it('compares Int64 as integers, not as doubles', () => {
    const rows = [['9007199254740993'], ['9007199254740992']]
    const order = displayOrder(rows, [{ name: 'n', type: 'Int64' }], [{ column: 0, dir: 'asc' }])
    expect(order).toEqual([1, 0])
  })

  it('sorts numbers numerically rather than lexically', () => {
    const rows = [[9], [10], [1]]
    expect(displayOrder(rows, [{ name: 'n', type: 'UInt32' }], [{ column: 0, dir: 'asc' }])).toEqual([
      2, 0, 1,
    ])
  })

  it('puts NULLs last whichever way it sorts', () => {
    const rows = [[null], [2], [1]]
    const col = [{ name: 'n', type: 'Nullable(Int32)' }]
    expect(displayOrder(rows, col, [{ column: 0, dir: 'asc' }])).toEqual([2, 1, 0])
    expect(displayOrder(rows, col, [{ column: 0, dir: 'desc' }])).toEqual([1, 2, 0])
  })

  it('is stable on ties', () => {
    const rows = [['a', 'first'], ['a', 'second'], ['a', 'third']]
    expect(displayOrder(rows, columns, [{ column: 0, dir: 'desc' }])).toEqual([0, 1, 2])
  })

  it('breaks a tie on the next level, and only then on the server order', () => {
    const rows = [
      ['b', 'x'],
      ['a', 'z'],
      ['a', 'y'],
    ]
    const levels = [
      { column: 0, dir: 'asc' as const },
      { column: 1, dir: 'desc' as const },
    ]
    expect(displayOrder(rows, columns, levels)).toEqual([1, 2, 0])
  })
})

describe('span', () => {
  it('normalises whichever corner you dragged from', () => {
    const forward = span({ row: 1, col: 1 }, { row: 4, col: 3 })
    const backward = span({ row: 4, col: 3 }, { row: 1, col: 1 })
    expect(forward).toEqual(backward)
    expect(spanSize(forward)).toBe(12)
  })

  it('knows what it contains', () => {
    const s = span({ row: 1, col: 1 }, { row: 2, col: 2 })
    expect(inSpan(s, 1, 2)).toBe(true)
    expect(inSpan(s, 0, 1)).toBe(false)
    expect(inSpan(s, 1, 3)).toBe(false)
  })
})

describe('toTSV', () => {
  const columns = [
    { name: 'a', type: 'String' },
    { name: 'b', type: 'Int32' },
    { name: 'c', type: 'String' },
  ]
  const rows = [
    ['one', 1, 'x'],
    ['two', 2, 'y'],
  ]

  it('emits only the selected block, in the order given', () => {
    expect(toTSV(rows, columns, [1, 0], [2, 0])).toBe('y\ttwo\nx\tone')
  })

  it('can carry the header', () => {
    expect(toTSV(rows, columns, [0], [0, 1], true)).toBe('a\tb\none\t1')
  })

  it('quotes a value that would tear the block apart', () => {
    const messy = [['has\ttab'], ['has\nnewline'], ['has "quotes"']]
    const col = [{ name: 'v', type: 'String' }]
    expect(toTSV(messy, col, [0, 1, 2], [0])).toBe(
      '"has\ttab"\n"has\nnewline"\n"has ""quotes"""',
    )
  })

  it('sends a NULL out as a blank field rather than the word', () => {
    expect(toTSV([[null, 1]], columns, [0], [0, 1])).toBe('\t1')
  })
})

describe('prettyJSON', () => {
  it('unfolds a structured value', () => {
    expect(prettyJSON({ a: 1 })).toBe('{\n  "a": 1\n}')
  })

  it('unfolds JSON that arrived as a string', () => {
    expect(prettyJSON('[1,2]')).toBe('[\n  1,\n  2\n]')
  })

  it('leaves a scalar alone', () => {
    expect(prettyJSON('hello')).toBeNull()
    expect(prettyJSON(42)).toBeNull()
    expect(prettyJSON(null)).toBeNull()
  })

  it('does not choke on something that only looks like JSON', () => {
    expect(prettyJSON('{not json')).toBeNull()
  })
})

describe('shapeKey', () => {
  it('is the same for the same shape and different for a different one', () => {
    const a = [{ name: 'id', type: 'UInt64' }]
    const b = [{ name: 'id', type: 'String' }]
    expect(shapeKey(a)).toBe(shapeKey([{ name: 'id', type: 'UInt64' }]))
    expect(shapeKey(a)).not.toBe(shapeKey(b))
  })
})

describe('selectionStats', () => {
  const rows = [
    [1, 'a', '10', '7'],
    [2, 'b', null, '8'],
    [3, 'c', '30', '9'],
  ]
  const columns = [
    { name: 'n', type: 'UInt8' },
    { name: 'label', type: 'String' },
    { name: 'big', type: 'Int64' },
    { name: 'digits', type: 'String' },
  ]

  it('sums, averages and bounds the block the reader selected', () => {
    const stats = selectionStats(rows, columns, [0, 1, 2], [0])
    expect(stats).toEqual({ cells: 3, numbers: 3, sum: 6, avg: 2, min: 1, max: 3 })
  })

  it('counts a quoted 64-bit integer as the number it is', () => {
    const stats = selectionStats(rows, columns, [0, 2], [2])
    expect(stats?.sum).toBe(40)
    expect(stats?.numbers).toBe(2)
  })

  it('leaves a String column of digits alone — it is text somebody chose', () => {
    expect(selectionStats(rows, columns, [0, 1, 2], [3])).toBeNull()
  })

  it('counts every selected cell, and only the numbers among them', () => {
    const stats = selectionStats(rows, columns, [0, 1, 2], [0, 1, 2])
    expect(stats?.cells).toBe(9)
    expect(stats?.numbers).toBe(5)
  })

  it('says nothing rather than zero for a block of text', () => {
    expect(selectionStats(rows, columns, [0, 1], [1])).toBeNull()
  })
})

describe('barScales', () => {
  const columns = [
    { name: 'n', type: 'UInt32' },
    { name: 'label', type: 'String' },
    { name: 'delta', type: 'Int32' },
  ]

  it('scales a wide numeric column to its 90th percentile', () => {
    const rows = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10_000].map((n) => [n, 'x', 0])
    expect(barScales(rows, columns)[0]).toBe(10)
  })

  it('scales a short column to its maximum, where a percentile would distort', () => {
    const rows = [[1, 'a', 0], [2, 'b', 0], [3, 'c', 0], [400, 'd', 0]]
    expect(barScales(rows, columns)[0]).toBe(400)
  })

  it('gives no bar to text, or to a column that goes negative', () => {
    const rows = [[1, '2', -5], [2, '3', 4]]
    const scales = barScales(rows, columns)
    expect(scales[1]).toBeNull()
    expect(scales[2]).toBeNull()
  })
})

describe('barWidth', () => {
  it('is the share of the scale, clamped at full', () => {
    expect(barWidth(5, 10)).toBe(50)
    expect(barWidth(20, 10)).toBe(100)
  })

  it('draws nothing for a null, a zero or a column with no scale', () => {
    expect(barWidth(null, 10)).toBe(0)
    expect(barWidth(0, 10)).toBe(0)
    expect(barWidth(5, null)).toBe(0)
  })
})

describe('columnAggregate', () => {
  const columns = [
    { name: 'n', type: 'Nullable(Int32)' },
    { name: 's', type: 'String' },
  ]
  const rows = [[4, 'a'], [null, 'b'], ['6', 'c']]

  it('aggregates the numbers that are there, over the rows on screen', () => {
    expect(columnAggregate(rows, columns, 0, 'sum')).toBe(10)
    expect(columnAggregate(rows, columns, 0, 'avg')).toBe(5)
    expect(columnAggregate(rows, columns, 0, 'min')).toBe(4)
    expect(columnAggregate(rows, columns, 0, 'max')).toBe(6)
  })

  it('counts the values present, not the rows', () => {
    expect(columnAggregate(rows, columns, 0, 'count')).toBe(2)
  })

  it('asks nothing of a column that is not a number', () => {
    expect(columnAggregate(rows, columns, 1, 'sum')).toBeNull()
    expect(columnAggregate(rows, columns, 1, 'count')).toBeNull()
  })

  it('has nothing to say about a column of NULLs, except how many there are', () => {
    const empty = [[null], [null]]
    const col = [{ name: 'n', type: 'Nullable(Int32)' }]
    expect(columnAggregate(empty, col, 0, 'sum')).toBeNull()
    expect(columnAggregate(empty, col, 0, 'count')).toBe(0)
  })
})

describe('nextAggregate', () => {
  it('walks the list and comes back round', () => {
    expect(nextAggregate('sum')).toBe('avg')
    expect(nextAggregate('count')).toBe('sum')
  })
})
