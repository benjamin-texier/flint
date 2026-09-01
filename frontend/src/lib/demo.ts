/** The one server Flint will offer to open for somebody who has none.
 *
 *  A `docker run flint` with no environment at all is a working Flint that
 *  connects to nothing, and the screen it opens on asks for an address. That is
 *  the right screen and it is a bad first minute: the person most likely to be
 *  looking at it is the one who has not got a ClickHouse to hand, and asking
 *  them to go and find one is asking them to close the tab.
 *
 *  So Flint knows one address. ClickHouse's own public demo server holds real
 *  data at a scale nothing local does — seven terabytes and a quarter of a
 *  trillion rows, including every public GitHub event since 2011 — which is the
 *  difference between seeing that Flint draws a schema and seeing what it is
 *  *for*.
 *
 *  ## What it is not
 *
 *  Not a connection registry, and not the beginning of one. It is a literal, in
 *  one file, offered on one screen, and it travels down exactly the path a typed
 *  address travels: the same `vet`, the same `FLINT_TARGETS` fence, the same
 *  session. A deployment that narrowed `FLINT_TARGETS` refuses this like any
 *  other host, which is correct — an operator who fenced their Flint did not
 *  mean "except for the one server Flint likes".
 */
export interface Demo {
  /** How it is named to somebody deciding whether to press it. */
  name: string
  endpoint: string
  user: string
  /** Empty, and it has to be: this account is public and password-less, and a
   *  secret in this file would be a secret in the bundle. */
  password: string
  /** What is actually on it, in the one sentence that makes pressing it
   *  attractive. Figures rather than adjectives — "large" is what every demo
   *  claims. */
  holds: string
  /** And what Flint will *not* be able to show there, said before the click
   *  rather than discovered as four grey panels afterwards.
   *
   *  This is the whole reason the offer is honest. The demo account is granted
   *  the schema and the data and nothing else: `system.parts`, `system.disks`
   *  and `system.query_log` are all refused, so every reading in Flint that
   *  rests on what the *server has been doing* is unavailable there. Saying so
   *  first turns an apparently broken product into a correctly reported one. */
  withholds: string
}

export const DEMO: Demo = {
  name: 'ClickHouse’s public demo',
  endpoint: 'https://play.clickhouse.com',
  user: 'explorer',
  password: '',
  holds: '7 TiB and 246 billion rows — every public GitHub event since 2011, a decade of taxi trips, the web-analytics set the benchmarks use.',
  withholds:
    'Its account is granted the schema and the data, so the diagram, the types and the queries all work. What it cannot read is what the server has been *doing* — system.parts, system.disks and system.query_log are refused there, so storage, the workload and the checkup have nothing to answer with.',
}

/** Whether the form is currently pointed at the demo.
 *
 *  Compared on the endpoint alone, and loosely: somebody who took the offer and
 *  then changed the user is still on that server, and the sentence about what it
 *  withholds is still the one they need. Trailing slashes and case are noise —
 *  `normalise` on the server settles the real address, and this is only deciding
 *  what to say.
 */
export function isDemo(endpoint: string): boolean {
  const host = endpoint.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  return host === 'play.clickhouse.com'
}
