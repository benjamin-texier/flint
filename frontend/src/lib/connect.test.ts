import { describe, expect, it } from 'vitest'

import { saysAttempt, saysElapsed, saysShort, verdictOf, type Attempt } from './connect'

/* Every fixture below is a response the endpoint actually returned, against a
   dead DNS name, a real AWS bucket this account may not read, and a File table
   with one row in it. */

const attempt = (over: Partial<Attempt> = {}): Attempt => ({
  ok: true,
  elapsed_ms: 6,
  found: true,
  error: '',
  refused: '',
  ...over,
})

describe('verdictOf', () => {
  it('separates reached from empty, which are both successes', () => {
    expect(verdictOf(attempt())).toBe('reached')
    expect(verdictOf(attempt({ found: false }))).toBe('empty')
  })

  it('calls a failure a failure', () => {
    expect(
      verdictOf(attempt({ ok: false, found: false, error: 'Host not found: redis.internal' })),
    ).toBe('failed')
  })

  it('does not call a refusal a failure', () => {
    // The backend sends `ok: false` with a refusal, because it did not run —
    // and a refusal rendered in red says the connection is broken when nobody
    // has looked.
    expect(
      verdictOf(attempt({ ok: false, found: false, refused: 'there is nothing to reach.' })),
    ).toBe('refused')
  })
})

describe('saysElapsed', () => {
  it('uses milliseconds where a working connection lives', () => {
    expect(saysElapsed(6)).toBe('6 ms')
    expect(saysElapsed(642)).toBe('642 ms')
  })

  it('switches to seconds where the digits stop being readable', () => {
    expect(saysElapsed(1000)).toBe('1.0 s')
    expect(saysElapsed(4231)).toBe('4.2 s')
  })
})

describe('saysAttempt', () => {
  it('quotes the server rather than rewording it', () => {
    const said = saysAttempt(
      attempt({
        ok: false,
        found: false,
        elapsed_ms: 32,
        error:
          'Try 2. Connection to `pg.internal:5432` failed with error: could not translate host name "pg.internal" to address',
      }),
    )
    expect(said).toMatch(/No answer after 32 ms/)
    expect(said).toMatch(/could not translate host name/)
  })

  it('says reachable and empty in one sentence, since that is one finding', () => {
    expect(saysAttempt(attempt({ found: false, elapsed_ms: 3 }))).toBe(
      'Answered in 3 ms, with no row to give — the far end is reachable and there is nothing in it.',
    )
  })

  it('passes a refusal through in its own words', () => {
    expect(saysAttempt(attempt({ ok: false, refused: 'Reading this table takes from the queue.' }))).toBe(
      'Reading this table takes from the queue.',
    )
  })
})

describe('saysShort', () => {
  const long = attempt({
    ok: false,
    found: false,
    elapsed_ms: 63,
    error:
      "Received error from remote server https://example.org/data.jsonl. HTTP status code: 404 'Not Found', body length: 559 bytes, body: '<!doctype html><html lang=\"en\"><head><title>Example Domain</title>",
  })

  it('leaves a message that already fits alone', () => {
    const short = attempt({ found: false, elapsed_ms: 3 })
    expect(saysShort(short, 200)).toBe(saysAttempt(short))
  })

  it('cuts a remote server’s 404 page down to a line', () => {
    const said = saysShort(long)
    expect(said.length).toBeLessThanOrEqual(131)
    expect(said.endsWith('…')).toBe(true)
    // The half that identifies the failure survives the cut.
    expect(said).toMatch(/No answer after 63 ms/)
  })

  it('cuts at a word, since half a hostname is a different hostname', () => {
    const full = saysAttempt(long)
    const kept = saysShort(long).slice(0, -1)
    expect(full.startsWith(kept)).toBe(true)
    // The character the cut landed on is a space in the original, so no token
    // is left half-written.
    expect(full[kept.length]).toBe(' ')
  })
})
