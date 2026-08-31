/** Whether a streaming table is actually moving anything.
 *
 *  An `S3` table fails in front of the person who queried it. A `Kafka` or an
 *  `S3Queue` table does not: it runs in the background, and when it stops the
 *  only symptom is a target table that quietly stops growing. Everything here
 *  is the judgement half of that — the backend reads `system.kafka_consumers`
 *  and `system.s3queue_log` and does not decide what they mean, because what
 *  they mean is the part worth testing.
 *
 *  The rules below were written against a broker rather than against the
 *  documentation, and two of them exist only because of what that showed:
 *  a consumer's exception ring holds the last ten *ever*, so its contents are
 *  not by themselves a fault; and one poison message produces ten entries that
 *  are the same error under two different spellings, which is a wall of text
 *  unless they fold. */

export interface Assignment {
  topic: string
  partition: number
  /** Null on a partition assigned and not yet read from. The server reports
   *  `-1001` there — librdkafka's "no offset" — and the backend drops it. */
  offset: number | null
}

export interface StreamError {
  at: string
  text: string
}

export interface KafkaConsumer {
  /** Empty until it has joined the group, which it does not do until something
   *  reads the table. */
  consumer_id: string
  assignments: Assignment[]
  /** `1970-01-01 00:00:00` where it never happened — the server's own spelling,
   *  kept so that never and unknown stay different things. */
  last_poll: string
  last_commit: string
  last_rebalance: string
  messages_read: number
  commits: number
  revocations: number
  assigned: number
  active: boolean
  errors: StreamError[]
}

export interface KafkaState {
  consumers: { items: KafkaConsumer[]; blocked?: string }
  /** One chain per materialized view that drains this table: the view, then
   *  the table it writes into. */
  dependencies: string[][]
  missing: string[][]
}

export interface QueueFile {
  name: string
  status: string
  rows: number
  started: string
  ended: string
  millis: number
  exception: string
}

export interface QueueSetting {
  name: string
  value: string
}

export interface QueueState {
  files: { items: QueueFile[]; blocked?: string }
  processed: number
  failed: number
  rows: number
  since: string
  total: number
  settings: QueueSetting[]
}

export interface StreamReport {
  kind: 'kafka' | 'queue' | ''
  kafka?: KafkaState
  queue?: QueueState
}

/** The server writes the epoch for a thing that never happened, and a page that
 *  renders that as a date says a Kafka table last polled in 1970. */
export function never(timestamp: string): boolean {
  return !timestamp || timestamp.startsWith('1970')
}

export type ConsumerState = 'unstarted' | 'failing' | 'running' | 'stopped'

/** What one consumer is doing.
 *
 *  `failing` is deliberately not "has errors". The ring holds the last ten a
 *  consumer ever hit, so a table that recovered an hour ago still carries them;
 *  what makes an error current is that nothing has been committed since. */
export function consumerState(c: KafkaConsumer): ConsumerState {
  if (never(c.last_poll)) return 'unstarted'
  const last = c.errors.at(-1)?.at
  if (last && !never(last) && (never(c.last_commit) || last >= c.last_commit)) return 'failing'
  return c.active ? 'running' : 'stopped'
}

export interface FoldedError {
  text: string
  count: number
  first: string
  last: string
}

/** Ten entries that are one error, folded into one.
 *
 *  A consumer stuck on a malformed message re-reads it every couple of seconds,
 *  and each attempt lands twice: once as the bare parse failure and once
 *  wrapped as `Code: 27. DB::Exception: … While executing Kafka.`. Ten lines
 *  that say one thing are a wall; "the same error 10 times, over 8 seconds" is
 *  the sentence somebody needs. Folded on the message with its wrapping
 *  removed, and the fullest spelling of it is the one kept — that is the one
 *  carrying the error's name. */
export function foldErrors(errors: StreamError[]): FoldedError[] {
  const groups = new Map<string, FoldedError>()
  for (const error of errors) {
    const key = normalise(error.text)
    const found = groups.get(key)
    if (!found) {
      groups.set(key, { text: error.text, count: 1, first: error.at, last: error.at })
      continue
    }
    found.count += 1
    if (error.at < found.first) found.first = error.at
    if (error.at > found.last) found.last = error.at
    if (error.text.length > found.text.length) found.text = error.text
  }
  return [...groups.values()].sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0))
}

/** The same failure under either spelling: the wrapper ClickHouse adds when it
 *  re-throws carries a code at the front and an "executing" clause at the back,
 *  and neither changes which message is stuck. */
function normalise(text: string): string {
  return text
    .replace(/^Code:\s*\d+\.\s*DB::Exception:\s*/, '')
    .replace(/:\s*While executing.*$/, '')
    .trim()
}

/** The partitions this consumer holds, in a sentence.
 *
 *  Offsets are counted rather than listed: a topic with sixty partitions is a
 *  paragraph nobody reads, and the thing worth knowing is whether any of them
 *  has a position at all. */
export function saysAssignments(assignments: Assignment[]): string {
  if (assignments.length === 0) return 'no partitions assigned'
  const topics = [...new Set(assignments.map((a) => a.topic))]
  const placed = assignments.filter((a) => a.offset !== null).length
  const where =
    topics.length === 1 ? `of ${topics[0]}` : `across ${topics.length} topics`
  const n = `${assignments.length} ${assignments.length === 1 ? 'partition' : 'partitions'} ${where}`
  if (placed === 0) return `${n}, none with an offset yet`
  if (placed === assignments.length) return n
  return `${n}, ${placed} with an offset`
}

/** What is worth saying about this table's consumers, in the order worth
 *  reading. Ordered by how much trouble each is, the way the dictionary
 *  verdicts are: a topic nobody is draining comes before a consumer that is
 *  merely unsettled. */
export function kafkaVerdicts(state: KafkaState): string[] {
  const out: string[] = []
  const consumers = state.consumers.items
  if (consumers.length === 0) return out

  // The one that explains a "stalled" topic more often than anything else, and
  // the one nothing else in ClickHouse will tell you.
  if (state.dependencies.length === 0) {
    out.push(
      `Nothing reads this table, so nothing is being consumed. A Kafka table is drained by a materialized view selecting from it; without one the server still creates its ${consumers.length} ${consumers.length === 1 ? 'consumer' : 'consumers'} and they never poll.`,
    )
  }

  for (const chain of state.missing) {
    out.push(
      `${chain.join(' → ')} is listed as reading this table and the server cannot find it.`,
    )
  }

  const failing = consumers.filter((c) => consumerState(c) === 'failing')
  if (failing.length > 0) {
    const top = foldErrors(failing.flatMap((c) => c.errors))[0]
    out.push(
      `${failing.length} of ${consumers.length} ${consumers.length === 1 ? 'consumer' : 'consumers'} ${failing.length === 1 ? 'is' : 'are'} failing and nothing has been committed since${top ? `: ${top.text}` : '.'}`,
    )
  }

  // Read and never committed. On a consumer stuck at the head of a partition
  // this climbs for hours while the target table holds nothing, which is the
  // shape of the bug that makes this panel worth having.
  for (const c of consumers.filter((c) => c.messages_read > 0 && c.commits === 0)) {
    out.push(
      `A consumer has read ${c.messages_read.toLocaleString('en-GB')} messages and committed none, so nothing it has read has reached a target table.`,
    )
  }

  // Churn. Ten is not a threshold anybody chose — it is low enough to catch a
  // group that is genuinely thrashing and high enough that a restart, which
  // rebalances two or three times, does not read as one.
  for (const c of consumers.filter((c) => c.assigned >= 10 && c.assigned > c.commits)) {
    out.push(
      `A consumer has been assigned partitions ${c.assigned} times and committed ${c.commits}: the group is rejoining faster than it is finishing work.`,
    )
  }

  return out
}

export interface FoldedFile {
  file: QueueFile
  attempts: number
  first: string
  last: string
}

/** The log folded by what actually happened.
 *
 *  A queue retrying one unparseable object writes a row per attempt, each
 *  carrying the same six-line exception. Three attempts is three walls of red
 *  saying one thing — the same shape the consumer's exception ring has, and the
 *  same answer: repeats are folded and counted. The attempts are still real, so
 *  the count and the span are kept; it is the text that stops repeating.
 *
 *  Folded on the object *and* the outcome, so a file that failed twice and then
 *  succeeded reads as two rows rather than as one confused one. */
export function foldFiles(files: QueueFile[]): FoldedFile[] {
  const groups = new Map<string, FoldedFile>()
  for (const file of files) {
    const key = `${file.name}\u0000${file.status}\u0000${normalise(file.exception)}`
    const found = groups.get(key)
    if (!found) {
      groups.set(key, { file, attempts: 1, first: file.started, last: file.started })
      continue
    }
    found.attempts += 1
    if (file.started < found.first) found.first = file.started
    if (file.started > found.last) {
      found.last = file.started
      // The newest attempt is the one whose figures are current.
      found.file = file
    }
  }
  return [...groups.values()].sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0))
}

/** How long a fold spans, in seconds.
 *
 *  Ten copies of one error eighteen seconds apart print as "just now to just
 *  now" if the two ends are formatted as times — a range that says nothing. The
 *  span says it in one figure instead. */
export function foldSeconds(first: string, last: string): number {
  const a = Date.parse(first.replace(' ', 'T') + 'Z')
  const b = Date.parse(last.replace(' ', 'T') + 'Z')
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.max(0, Math.round((b - a) / 1000))
}

/** A file the queue has tried more than once and failed each time.
 *
 *  `s3queue_loading_retries` makes this the designed behaviour rather than a
 *  fault, which is exactly why it needs saying: a queue quietly retrying one
 *  unparseable object forever looks, from the target table, like a queue that
 *  has stopped. */
export function retryLoops(files: QueueFile[]): { name: string; attempts: number }[] {
  const counts = new Map<string, number>()
  for (const f of files.filter((f) => f.status === 'Failed')) {
    counts.set(f.name, (counts.get(f.name) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([, attempts]) => attempts > 1)
    .map(([name, attempts]) => ({ name, attempts }))
    .sort((a, b) => b.attempts - a.attempts)
}

export function queueVerdicts(state: QueueState): string[] {
  const out: string[] = []
  const files = state.files.items

  if (state.failed > 0) {
    out.push(
      `${state.failed} of ${state.total} attempts failed. A failed object is not skipped — the queue comes back to it.`,
    )
  }

  for (const loop of retryLoops(files)) {
    out.push(`${loop.name} has failed ${loop.attempts} times, and the queue is still retrying it.`)
  }

  // Taken, parsed, and empty. The silent one: nothing failed, nothing arrived.
  const empty = files.filter((f) => f.status === 'Processed' && f.rows === 0)
  if (empty.length > 0) {
    out.push(
      `${empty.length} ${empty.length === 1 ? 'object was' : 'objects were'} taken and produced no rows. The queue counts them as done and will not read them again.`,
    )
  }

  return out
}

/** What the queue's own settings say about how it behaves, where they were set.
 *  `mode` first: it decides whether an object can be taken twice, which changes
 *  what every row of the log means. */
export function orderedSettings(settings: QueueSetting[]): QueueSetting[] {
  const rank = (name: string) => (name === 'mode' ? 0 : name === 'keeper_path' ? 2 : 1)
  return [...settings].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
}
