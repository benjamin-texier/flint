import { describe, expect, it } from 'vitest'

import { DEMO, isDemo } from './demo'

describe('the demo server Flint offers', () => {
  it('carries no secret', () => {
    /* The account is public and password-less, and it has to stay that way: a
       password here is a password in the bundle every browser downloads. */
    expect(DEMO.password).toBe('')
  })

  it('is reached over TLS', () => {
    /* Flint would send the credentials of whoever pressed the button — nobody's,
       here — but the *statements* and their answers are somebody's, and a demo
       that teaches plain HTTP as the shape of a ClickHouse address is teaching
       the wrong thing. */
    expect(DEMO.endpoint.startsWith('https://')).toBe(true)
  })

  it('says what it cannot show before anybody presses it', () => {
    /* The point of the sentence, and the reason it is a field rather than
       markup: a demo whose storage, workload and checkup pages are all empty
       looks broken unless somebody said first that they would be. */
    for (const denied of ['system.parts', 'system.query_log']) {
      expect(DEMO.withholds).toContain(denied)
    }
  })

  it('recognises the server however the address was written', () => {
    for (const written of [
      'https://play.clickhouse.com',
      'https://play.clickhouse.com/',
      'http://PLAY.clickhouse.com',
      '  play.clickhouse.com  ',
    ]) {
      expect(isDemo(written), written).toBe(true)
    }
  })

  it('does not mistake another server for it', () => {
    for (const written of [
      'http://localhost:8123',
      'https://play.clickhouse.com.evil.test',
      'https://clickhouse.com',
      '',
    ]) {
      expect(isDemo(written), written).toBe(false)
    }
  })
})
