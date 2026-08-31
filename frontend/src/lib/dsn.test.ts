import { describe, expect, it } from 'vitest'

import { parseDsn, worthSplitting } from './dsn'

describe('parseDsn', () => {
  it('leaves a bare host and port alone', () => {
    // What the field is for. There is nothing to split out, and a parser that
    // rewrote it would be editing what somebody is halfway through typing.
    expect(parseDsn('localhost:8123')).toBeNull()
    expect(parseDsn('clickhouse')).toBeNull()
    expect(parseDsn('')).toBeNull()
    expect(parseDsn('   ')).toBeNull()
  })

  it('splits credentials out of an http address', () => {
    const dsn = parseDsn('http://analyst:hunter2@ch.example.com:8123')
    expect(dsn).toEqual({
      endpoint: 'http://ch.example.com:8123',
      user: 'analyst',
      password: 'hunter2',
      note: null,
    })
  })

  it('reads a driver DSN and says which port it assumed', () => {
    // The most common paste there is, and the one the endpoint field would
    // otherwise send straight at the native protocol.
    const dsn = parseDsn('clickhouse://analyst:hunter2@warehouse:9000/analytics')
    expect(dsn?.endpoint).toBe('http://warehouse:8123')
    expect(dsn?.user).toBe('analyst')
    expect(dsn?.note).toContain('9000 is the native port')
    expect(dsn?.note).toContain('8123')
    // The database is dropped, and dropping it is stated rather than silent.
    expect(dsn?.note).toContain('`analytics` is dropped')
  })

  it('carries TLS over from the port, the scheme or the query', () => {
    expect(parseDsn('clickhouse://ch:9440')?.endpoint).toBe('https://ch:8443')
    expect(parseDsn('clickhouses://ch:8443')?.endpoint).toBe('https://ch:8443')
    expect(parseDsn('clickhouse://ch:8443?secure=true')?.endpoint).toBe('https://ch:8443')
    // And `secure=false` is not a reason to turn it on.
    expect(parseDsn('http://ch:8123?secure=false')?.endpoint).toBe('http://ch:8123')
  })

  it('never invents a port', () => {
    // A native DSN with no port names neither of the two HTTP ports, so nothing
    // is filled in — the address is left short and the note says what to add.
    const dsn = parseDsn('clickhouse://analyst@warehouse')
    expect(dsn?.endpoint).toBe('http://warehouse')
    expect(dsn?.note).toContain('8123')
    expect(dsn?.note).toContain('8443')
  })

  it('decodes a password that had to be escaped', () => {
    // A secret with an `@` in it cannot be written literally in a URL, and must
    // not stay escaped in the field.
    expect(parseDsn('http://analyst:p%40ss%2Fword@ch:8123')?.password).toBe('p@ss/word')
    // A stray percent is a character, not a crash.
    expect(parseDsn('http://analyst:100%@ch:8123')?.password).toBe('100%')
  })

  it('keeps an IPv6 literal bracketed', () => {
    expect(parseDsn('clickhouse://[::1]:9000')?.endpoint).toBe('http://[::1]:8123')
  })

  it('refuses a scheme that is not ClickHouse over HTTP or native', () => {
    for (const raw of ['postgres://ch:5432', 'file:///etc/passwd', 'jdbc://ch:8123']) {
      expect(parseDsn(raw), raw).toBeNull()
    }
  })

  it('reports a ClickHouse Cloud address unchanged', () => {
    // Already an HTTP address on its own port: nothing assumed, nothing said.
    const dsn = parseDsn('https://abc123.eu-west-1.aws.clickhouse.cloud:8443')
    expect(dsn?.endpoint).toBe('https://abc123.eu-west-1.aws.clickhouse.cloud:8443')
    expect(dsn?.note).toBeNull()
    expect(dsn?.user).toBe('')
  })
})

describe('worthSplitting', () => {
  it('says no to a string that is already the address', () => {
    // Rewriting a field with the value it already holds, and announcing it, is
    // noise where the whole point is to explain a change.
    const raw = 'http://ch:8123'
    expect(worthSplitting(parseDsn(raw)!, raw)).toBe(false)
  })

  it('says yes when there is something to move or to state', () => {
    for (const raw of [
      'http://analyst@ch:8123',
      'clickhouse://ch:9000',
      'http://ch:8123/analytics',
      'https://ch:8443/',
    ]) {
      expect(worthSplitting(parseDsn(raw)!, raw), raw).toBe(true)
    }
  })
})
