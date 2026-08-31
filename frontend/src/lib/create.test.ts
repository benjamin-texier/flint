import { describe, expect, it } from 'vitest'

import { names, renamed, stillNamed } from './create'

describe('names', () => {
  it('finds the object a create names', () => {
    expect(names('CREATE TABLE analytics.devices (x UInt8) ENGINE = Memory')).toBe(
      'analytics.devices',
    )
    // As the server reports it: backquotes on the columns and not on the name.
    expect(
      names('CREATE TABLE analytics.devices (`device_id` String) ENGINE = ReplacingMergeTree'),
    ).toBe('analytics.devices')
    expect(names('CREATE MATERIALIZED VIEW db.mv TO db.t AS SELECT 1')).toBe('db.mv')
    expect(names('CREATE DICTIONARY reference.tenant_label (id UInt64)')).toBe(
      'reference.tenant_label',
    )
    expect(names('CREATE TABLE IF NOT EXISTS db.t (x UInt8)')).toBe('db.t')
  })

  it('steps over the comments somebody brought with their DDL', () => {
    expect(names('-- the events table\nCREATE TABLE db.t (x UInt8)')).toBe('db.t')
    expect(names('/* one */ CREATE TABLE db.t (x UInt8)')).toBe('db.t')
  })

  it('strips the backquotes the server puts on a reserved name', () => {
    expect(names('CREATE TABLE `db`.`order` (x UInt8)')).toBe('db.order')
  })

  it('gives up rather than guessing', () => {
    // Being wrong costs a suggestion, not a statement.
    expect(names('DROP TABLE db.t')).toBeNull()
    expect(names('')).toBeNull()
  })
})

describe('stillNamed', () => {
  it('catches a definition nobody has renamed yet', () => {
    const ddl = 'CREATE TABLE analytics.devices (x UInt8) ENGINE = Memory'
    expect(stillNamed(ddl, 'analytics.devices')).toBe(true)
    expect(stillNamed(ddl.replace('devices', 'devices_copy'), 'analytics.devices')).toBe(false)
  })
})

describe('renamed', () => {
  it('changes the name and leaves a column of the same name alone', () => {
    const ddl = 'CREATE TABLE db.events (events String) ENGINE = Memory'
    expect(renamed(ddl, 'db.events', 'db.events_copy')).toBe(
      'CREATE TABLE db.events_copy (events String) ENGINE = Memory',
    )
  })

  it('returns the text unchanged when the name is not in it', () => {
    expect(renamed('CREATE TABLE a.b (x UInt8)', 'c.d', 'e.f')).toBe('CREATE TABLE a.b (x UInt8)')
  })
})
