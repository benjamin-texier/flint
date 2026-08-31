import { describe, expect, it } from 'vitest'

import {
  controlFor,
  enumMembers,
  fieldsFor,
  nullable,
  payload,
  saysComputed,
  saysDefaulting,
  saysWritten,
  willDefault,
  type Column,
  type Entry,
} from './rows'

const col = (name: string, type: string, extra: Partial<Column> = {}): Column => ({
  name,
  type,
  default_kind: '',
  default_expression: '',
  comment: '',
  nullable: /Nullable/.test(type),
  ...extra,
})

describe('enumMembers', () => {
  it('reads the set off the type, in declaration order', () => {
    expect(enumMembers("Enum8('ok' = 1, 'warn' = 2, 'error' = 3)")).toEqual(['ok', 'warn', 'error'])
    expect(enumMembers("Enum16('a' = -1, 'b' = 300)")).toEqual(['a', 'b'])
  })

  it('reaches through the wrappers', () => {
    expect(enumMembers("LowCardinality(Nullable(Enum8('a' = 1)))")).toEqual(['a'])
  })

  it('keeps a member that contains a comma or a quote', () => {
    // Legal types, and the reason the members are matched as quoted strings
    // rather than split on commas.
    expect(enumMembers("Enum8('a,b' = 1, 'c' = 2)")).toEqual(['a,b', 'c'])
    expect(enumMembers("Enum8('it\\'s' = 1)")).toEqual(["it's"])
  })

  it('answers nothing for a type that is not an enum', () => {
    expect(enumMembers('String')).toEqual([])
    expect(enumMembers('UInt8')).toEqual([])
  })
})

describe('controlFor', () => {
  it('gives an enum its list rather than a text box', () => {
    expect(controlFor("Enum8('ok' = 1)")).toBe('enum')
    expect(controlFor("Nullable(Enum16('ok' = 1))")).toBe('enum')
  })

  it('gives a bool two states', () => {
    expect(controlFor('Bool')).toBe('bool')
    expect(controlFor('Nullable(Bool)')).toBe('bool')
  })

  it('gives the structured types room', () => {
    expect(controlFor('Array(UInt8)')).toBe('long')
    expect(controlFor('JSON')).toBe('long')
    expect(controlFor('Map(String, UInt8)')).toBe('long')
  })

  it('gives a plain String one line, not a textarea', () => {
    /* It is ClickHouse's only string type, so it holds an email as often as a
       blob — and a textarea per String turned an eight-column table into a
       page of boxes, which is what the browser pass found. */
    expect(controlFor('String')).toBe('text')
    expect(controlFor('LowCardinality(Nullable(String))')).toBe('text')
  })

  it('gives everything else a line', () => {
    expect(controlFor('UInt32')).toBe('text')
    expect(controlFor('DateTime64(3)')).toBe('text')
    expect(controlFor('Decimal(9, 2)')).toBe('text')
    // A FixedString is bounded by definition, so it is not one of the long ones.
    expect(controlFor('FixedString(4)')).toBe('text')
  })
})

describe('nullable', () => {
  it('finds the wrapper wherever it sits', () => {
    expect(nullable('Nullable(String)')).toBe(true)
    // The case a prefix test gets wrong.
    expect(nullable('LowCardinality(Nullable(String))')).toBe(true)
    expect(nullable('String')).toBe(false)
  })
})

describe('fieldsFor', () => {
  const columns = [
    col('id', 'UInt32'),
    col('name', 'Nullable(String)'),
    col('note', 'String', { default_kind: 'DEFAULT', default_expression: "'none'" }),
    col('doubled', 'UInt32', { default_kind: 'MATERIALIZED', default_expression: 'id * 2' }),
    col('plus', 'UInt32', { default_kind: 'ALIAS', default_expression: 'id + 1' }),
  ]

  it('leaves out the columns the server computes', () => {
    // They are there and are computed, which is a different fact from being
    // absent — and neither of the server's two refusals says it.
    expect(fieldsFor(columns).map((f) => f.column.name)).toEqual(['id', 'name', 'note'])
  })

  it('keeps the table’s own declaration order', () => {
    expect(fieldsFor(columns).map((f) => f.column.name)).toEqual(['id', 'name', 'note'])
  })

  it('says what happens to a column left alone, where it can', () => {
    const [id, name, note] = fieldsFor(columns)
    expect(id!.optional).toBe(false)
    // Not "the type's zero" — true, but it reads as a promise Flint is making
    // about behaviour that is the engine's and differs per type.
    expect(id!.ifLeftAlone).toBeNull()
    expect(name!.optional).toBe(true)
    expect(name!.ifLeftAlone).toBe('the row gets a null')
    expect(note!.optional).toBe(true)
    expect(note!.ifLeftAlone).toBe("the table writes 'none'")
  })
})

describe('saysComputed', () => {
  it('names what the form is not offering', () => {
    const one = saysComputed([col('a', 'UInt8'), col('c', 'UInt8', { default_kind: 'ALIAS' })])
    expect(one).toContain('`c` is computed')
    expect(one).toContain('it is')
  })

  it('agrees with itself in the plural', () => {
    const two = saysComputed([
      col('c', 'UInt8', { default_kind: 'ALIAS' }),
      col('d', 'UInt8', { default_kind: 'MATERIALIZED' }),
    ])
    expect(two).toContain('`c`, `d` are computed')
    expect(two).toContain('they are')
  })

  it('says nothing where there is nothing to say', () => {
    expect(saysComputed([col('a', 'UInt8')])).toBeNull()
  })
})

describe('payload', () => {
  const fields = fieldsFor([col('id', 'UInt32'), col('name', 'Nullable(String)')])

  it('keeps a value, a null and an absence apart', () => {
    const entries: Record<string, Entry> = {
      id: { kind: 'value', text: '7' },
      name: { kind: 'null' },
    }
    expect(payload(fields, entries)).toEqual([
      { column: 'id', value: '7' },
      { column: 'name', value: null },
    ])
  })

  it('leaves a defaulted column out of the statement entirely', () => {
    // Which is what makes the table's own DEFAULT apply — there is no string
    // that could mean "default", because any such string is one somebody might
    // have meant to store.
    const entries: Record<string, Entry> = { id: { kind: 'value', text: '7' } }
    expect(payload(fields, entries)).toEqual([{ column: 'id', value: '7' }])
    expect(willDefault(fields, entries)).toEqual(['name'])
  })

  it('sends an empty box as an empty string, never as a null', () => {
    // Measured against a server: binding '' stores a zero-length string and
    // IS NULL comes back false. Two different answers.
    const entries: Record<string, Entry> = { name: { kind: 'value', text: '' } }
    expect(payload(fields, entries)).toEqual([{ column: 'name', value: '' }])
  })
})

describe('the sentences', () => {
  const fields = fieldsFor([
    col('id', 'UInt32'),
    col('name', 'Nullable(String)'),
    col('note', 'String', { default_kind: 'DEFAULT', default_expression: "'none'" }),
  ])

  /* Backticks and not JSX. `Note.tsx` renders the convention and says this bug
     has already reached the page twice; building the list as elements put a
     literal *seats`, `notes* on screen for a third time. */
  it('marks the column names with the convention the renderer understands', () => {
    const said = saysDefaulting(fields, { id: { kind: 'value', text: '1' } })
    expect(said).toBe('2 of 3 columns are left to the table: `name`, `note`.')
    expect(said!.split('`')).toHaveLength(5)
  })

  it('agrees with itself on one column', () => {
    const said = saysDefaulting(fields, {
      id: { kind: 'value', text: '1' },
      name: { kind: 'null' },
    })
    expect(said).toBe('1 of 3 column is left to the table: `note`.')
  })

  it('says nothing when every column was filled in', () => {
    expect(
      saysDefaulting(fields, {
        id: { kind: 'value', text: '1' },
        name: { kind: 'null' },
        note: { kind: 'value', text: 'x' },
      }),
    ).toBeNull()
  })

  it('reports what the server filled in, or just that it is written', () => {
    expect(saysWritten([])).toBe('Written.')
    expect(saysWritten(['a', 'b'])).toBe('Written. The table filled in `a`, `b`.')
  })
})
