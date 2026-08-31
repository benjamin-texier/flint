import { describe, expect, it } from 'vitest'

import {
  consumerState,
  foldErrors,
  foldFiles,
  foldSeconds,
  kafkaVerdicts,
  never,
  orderedSettings,
  queueVerdicts,
  retryLoops,
  saysAssignments,
  type KafkaConsumer,
  type KafkaState,
  type QueueFile,
  type QueueState,
} from './stream'

/* The fixtures below are the shapes a real broker produced, `-1001` offsets and
   duplicated exceptions included. */

function consumer(over: Partial<KafkaConsumer> = {}): KafkaConsumer {
  return {
    consumer_id: 'ClickHouse-host-db-tbl-a928',
    assignments: [],
    last_poll: '2026-08-31 08:50:01',
    last_commit: '2026-08-31 08:50:00',
    last_rebalance: '1970-01-01 00:00:00',
    messages_read: 40,
    commits: 4,
    revocations: 0,
    assigned: 1,
    active: true,
    errors: [],
    ...over,
  }
}

const UNSTARTED = consumer({
  consumer_id: '',
  last_poll: '1970-01-01 00:00:00',
  last_commit: '1970-01-01 00:00:00',
  messages_read: 0,
  commits: 0,
  assigned: 0,
  active: false,
})

describe('never', () => {
  it('knows the epoch means it never happened', () => {
    expect(never('1970-01-01 00:00:00')).toBe(true)
    expect(never('')).toBe(true)
    expect(never('2026-08-31 08:50:01')).toBe(false)
  })
})

describe('consumerState', () => {
  it('calls a consumer that has never polled unstarted', () => {
    expect(consumerState(UNSTARTED)).toBe('unstarted')
  })

  it('calls a polling consumer with nothing wrong running', () => {
    expect(consumerState(consumer())).toBe('running')
  })

  it('does not call an old error a current one', () => {
    // The ring holds the last ten a consumer ever hit. One that committed after
    // its last error has recovered, and saying otherwise would flag every table
    // that ever hit a bad message.
    expect(
      consumerState(
        consumer({
          errors: [{ at: '2026-08-31 07:00:00', text: 'Cannot parse input' }],
          last_commit: '2026-08-31 08:00:00',
        }),
      ),
    ).toBe('running')
  })

  it('calls it failing when nothing has been committed since the error', () => {
    expect(
      consumerState(
        consumer({
          errors: [{ at: '2026-08-31 08:49:58', text: 'Cannot parse input' }],
          last_commit: '2026-08-31 08:43:02',
        }),
      ),
    ).toBe('failing')
  })

  it('calls it failing when it has never committed at all', () => {
    expect(
      consumerState(
        consumer({
          errors: [{ at: '2026-08-31 08:49:58', text: 'Cannot parse input' }],
          last_commit: '1970-01-01 00:00:00',
          commits: 0,
        }),
      ),
    ).toBe('failing')
  })

  it('calls a consumer that polled once and is now idle stopped', () => {
    expect(consumerState(consumer({ active: false }))).toBe('stopped')
  })
})

describe('foldErrors', () => {
  // One poison message, five attempts, each landing twice: bare, and wrapped.
  const ring = [
    { at: '2026-08-31 08:49:52', text: "Cannot parse input: expected '{' (at row 1)" },
    {
      at: '2026-08-31 08:49:52',
      text: "Code: 27. DB::Exception: Cannot parse input: expected '{' (at row 1): While executing Kafka. (CANNOT_PARSE_INPUT_ASSERTION_FAILED)",
    },
    { at: '2026-08-31 08:49:54', text: "Cannot parse input: expected '{' (at row 1)" },
    {
      at: '2026-08-31 08:49:54',
      text: "Code: 27. DB::Exception: Cannot parse input: expected '{' (at row 1): While executing Kafka. (CANNOT_PARSE_INPUT_ASSERTION_FAILED)",
    },
  ]

  it('folds both spellings of one error into one', () => {
    const folded = foldErrors(ring)
    expect(folded).toHaveLength(1)
    expect(folded[0]?.count).toBe(4)
    expect(folded[0]?.first).toBe('2026-08-31 08:49:52')
    expect(folded[0]?.last).toBe('2026-08-31 08:49:54')
  })

  it('keeps the spelling that names the error', () => {
    expect(foldErrors(ring)[0]?.text).toContain('CANNOT_PARSE_INPUT_ASSERTION_FAILED')
  })

  it('keeps two genuinely different errors apart, newest first', () => {
    const folded = foldErrors([
      { at: '2026-08-31 08:00:00', text: 'Connection refused' },
      { at: '2026-08-31 09:00:00', text: 'Cannot parse input' },
    ])
    expect(folded.map((f) => f.text)).toEqual(['Cannot parse input', 'Connection refused'])
  })

  it('has nothing to say about an empty ring', () => {
    expect(foldErrors([])).toEqual([])
  })
})

describe('saysAssignments', () => {
  it('says so when a consumer holds nothing', () => {
    expect(saysAssignments([])).toBe('no partitions assigned')
  })

  it('counts the partitions with no position, which is what -1001 meant', () => {
    expect(
      saysAssignments([
        { topic: 'events', partition: 0, offset: null },
        { topic: 'events', partition: 1, offset: null },
        { topic: 'events', partition: 2, offset: null },
      ]),
    ).toBe('3 partitions of events, none with an offset yet')
  })

  it('says nothing extra when every partition has one', () => {
    expect(
      saysAssignments([
        { topic: 'events', partition: 0, offset: 12 },
        { topic: 'events', partition: 1, offset: 4 },
      ]),
    ).toBe('2 partitions of events')
  })

  it('counts the placed ones when only some are', () => {
    expect(
      saysAssignments([
        { topic: 'events', partition: 0, offset: 12 },
        { topic: 'events', partition: 1, offset: null },
      ]),
    ).toBe('2 partitions of events, 1 with an offset')
  })

  it('names the topics by count once there is more than one', () => {
    expect(
      saysAssignments([
        { topic: 'events', partition: 0, offset: 1 },
        { topic: 'clicks', partition: 0, offset: 1 },
      ]),
    ).toBe('2 partitions across 2 topics')
  })
})

function kafka(over: Partial<KafkaState> = {}): KafkaState {
  return {
    consumers: { items: [consumer()] },
    dependencies: [['db.mv', 'db.target']],
    missing: [],
    ...over,
  }
}

describe('kafkaVerdicts', () => {
  it('says nothing about a consumer that is simply working', () => {
    expect(kafkaVerdicts(kafka())).toEqual([])
  })

  it('explains a topic nobody is draining, which nothing else reports', () => {
    const said = kafkaVerdicts(
      kafka({ consumers: { items: [UNSTARTED, UNSTARTED] }, dependencies: [] }),
    )
    expect(said[0]).toMatch(/Nothing reads this table/)
    expect(said[0]).toMatch(/2 consumers/)
  })

  it('has nothing to say about a table with no consumers at all', () => {
    expect(kafkaVerdicts(kafka({ consumers: { items: [] }, dependencies: [] }))).toEqual([])
  })

  it('names a dependency the server cannot find', () => {
    expect(kafkaVerdicts(kafka({ missing: [['db.gone', 'db.target']] }))[0]).toMatch(
      /db.gone → db.target .* cannot find/,
    )
  })

  it('reports reading without committing, which is the stuck-consumer shape', () => {
    const said = kafkaVerdicts(
      kafka({ consumers: { items: [consumer({ messages_read: 444, commits: 0 })] } }),
    )
    expect(said.join(' ')).toMatch(/read 444 messages and committed none/)
  })

  it('quotes the error a failing consumer is stuck on', () => {
    const said = kafkaVerdicts(
      kafka({
        consumers: {
          items: [
            consumer({
              commits: 0,
              last_commit: '1970-01-01 00:00:00',
              errors: [{ at: '2026-08-31 08:49:58', text: 'Cannot parse input: expected {' }],
            }),
          ],
        },
      }),
    )
    expect(said.join(' ')).toMatch(/Cannot parse input/)
  })

  it('does not call a restart a rebalancing loop', () => {
    // Two or three rejoins is what starting up looks like.
    expect(
      kafkaVerdicts(kafka({ consumers: { items: [consumer({ assigned: 3, commits: 1 })] } })).join(
        ' ',
      ),
    ).not.toMatch(/rejoining/)
  })

  it('reports a group that is rejoining faster than it finishes work', () => {
    expect(
      kafkaVerdicts(
        kafka({ consumers: { items: [consumer({ assigned: 203, commits: 1 })] } }),
      ).join(' '),
    ).toMatch(/assigned partitions 203 times and committed 1/)
  })
})

function file(over: Partial<QueueFile> = {}): QueueFile {
  return {
    name: 'a.csv',
    status: 'Processed',
    rows: 2,
    started: '2026-08-31 08:45:11',
    ended: '2026-08-31 08:45:11',
    millis: 0,
    exception: '',
    ...over,
  }
}

function queue(over: Partial<QueueState> = {}): QueueState {
  return {
    files: { items: [file()] },
    processed: 1,
    failed: 0,
    rows: 2,
    since: '2026-08-31 08:45:11',
    total: 1,
    settings: [],
    ...over,
  }
}

describe('retryLoops', () => {
  it('finds the object the queue keeps coming back to', () => {
    expect(
      retryLoops([
        file({ name: 'c.csv', status: 'Failed', rows: 0 }),
        file({ name: 'c.csv', status: 'Failed', rows: 0 }),
        file({ name: 'c.csv', status: 'Failed', rows: 0 }),
        file({ name: 'a.csv' }),
      ]),
    ).toEqual([{ name: 'c.csv', attempts: 3 }])
  })

  it('does not call one failure a loop', () => {
    expect(retryLoops([file({ name: 'c.csv', status: 'Failed' })])).toEqual([])
  })
})

describe('queueVerdicts', () => {
  it('says nothing about a queue that is simply working', () => {
    expect(queueVerdicts(queue())).toEqual([])
  })

  it('counts the failures against the attempts', () => {
    expect(queueVerdicts(queue({ failed: 3, total: 6 }))[0]).toMatch(/3 of 6 attempts failed/)
  })

  it('names an object being retried forever', () => {
    const said = queueVerdicts(
      queue({
        failed: 3,
        total: 6,
        files: {
          items: [
            file({ name: 'c.csv', status: 'Failed', rows: 0 }),
            file({ name: 'c.csv', status: 'Failed', rows: 0 }),
          ],
        },
      }),
    )
    expect(said.join(' ')).toMatch(/c.csv has failed 2 times/)
  })

  it('reports the silent one: taken, counted as done, and empty', () => {
    const said = queueVerdicts(
      queue({ files: { items: [file({ name: 'bad.csv', rows: 0 })] } }),
    )
    expect(said.join(' ')).toMatch(/1 object was taken and produced no rows/)
    expect(said.join(' ')).toMatch(/will not read them again/)
  })
})

describe('orderedSettings', () => {
  it('puts mode first, because it decides what every row of the log means', () => {
    expect(
      orderedSettings([
        { name: 'keeper_path', value: '/clickhouse/s3queue/incoming' },
        { name: 'after_processing', value: 'keep' },
        { name: 'mode', value: 'unordered' },
      ]).map((s) => s.name),
    ).toEqual(['mode', 'after_processing', 'keeper_path'])
  })
})

describe('foldFiles', () => {
  const failure = (started: string) =>
    file({
      name: 'c.csv',
      status: 'Failed',
      rows: 0,
      started,
      exception: "Code: 27. DB::Exception: Cannot parse input: While executing ParallelParsing",
    })

  it('folds one object retried three times into one row', () => {
    const folded = foldFiles([
      failure('2026-08-31 08:48:16'),
      failure('2026-08-31 08:46:45'),
      failure('2026-08-31 08:45:44'),
      file({ name: 'a.csv', started: '2026-08-31 08:45:11' }),
    ])
    expect(folded).toHaveLength(2)
    expect(folded[0]).toMatchObject({ attempts: 3, first: '2026-08-31 08:45:44', last: '2026-08-31 08:48:16' })
    expect(folded[0]?.file.name).toBe('c.csv')
    expect(folded[1]).toMatchObject({ attempts: 1 })
  })

  it('keeps a failure and a later success as two rows', () => {
    const folded = foldFiles([
      file({ name: 'c.csv', status: 'Processed', rows: 3, started: '2026-08-31 09:00:00' }),
      failure('2026-08-31 08:48:16'),
    ])
    expect(folded).toHaveLength(2)
    expect(folded[0]?.file.status).toBe('Processed')
  })

  it('carries the newest attempt, whose figures are the current ones', () => {
    const folded = foldFiles([failure('2026-08-31 08:45:44'), failure('2026-08-31 08:48:16')])
    expect(folded[0]?.file.started).toBe('2026-08-31 08:48:16')
  })
})

describe('foldSeconds', () => {
  it('measures the span rather than printing both ends', () => {
    expect(foldSeconds('2026-08-31 08:49:52', '2026-08-31 08:50:10')).toBe(18)
  })

  it('is zero for a fold that happened at one instant', () => {
    expect(foldSeconds('2026-08-31 08:49:52', '2026-08-31 08:49:52')).toBe(0)
  })

  it('is zero rather than NaN on a timestamp it cannot read', () => {
    expect(foldSeconds('', '2026-08-31 08:49:52')).toBe(0)
  })
})
