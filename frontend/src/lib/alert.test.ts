import { describe, expect, it } from 'vitest'
import { type Alert, type Condition, deliveryNote, describeAlert, describeCondition, describeInterval, inSpace, intervalChoices, parseCondition, problemWith, saysElsewhere, serialiseCondition, toneOf,
  counts,
  destinations,
  selected,
  standingOf,
  STANDINGS,
} from './alert'

const cond = (over: Partial<Condition> = {}): Condition => ({
  metric: 'rows',
  op: '>',
  threshold: 0,
  ...over,
})

const alert = (over: Partial<Alert> = {}): Alert => ({
  id: 'a',
  name: 'A',
  sql: 'SELECT 1',
  database: '',
  space: 'data',
  space_note: '',
  condition: serialiseCondition(cond()),
  interval_seconds: 300,
  webhook: '',
  enabled: true,
  created_at: '',
  updated_at: '',
  state: '',
  last_event: '',
  last_message: '',
  last_delivered: false,
  last_delivery_error: '',
  ...over,
})

describe('counts and standings', () => {
  it('calls a paused alert paused, whatever state it last had', () => {
    // "Firing but not being evaluated" is a thing somebody needs to see as
    // paused. Counted as firing it would send them looking for an incident that
    // nothing is watching.
    expect(standingOf(alert({ enabled: false, state: 'firing' }))).toBe('paused')
    expect(standingOf(alert({ state: 'firing' }))).toBe('firing')
    expect(standingOf(alert({ state: '' }))).toBe('idle')
  })

  it('counts every alert exactly once', () => {
    const list = [
      alert({ state: 'firing' }),
      alert({ state: 'firing' }),
      alert({ state: 'error' }),
      alert({ enabled: false, state: 'firing' }),
      alert({ state: 'ok' }),
      alert(),
    ]
    const c = counts(list)
    expect(c).toEqual({ firing: 2, error: 1, paused: 1, ok: 1, idle: 1 })
    expect(Object.values(c).reduce((a, b) => a + b, 0)).toBe(list.length)
  })
})

describe('destinations', () => {
  it('groups by host, because a token is not something to print in a rail', () => {
    const list = [
      alert({ webhook: 'https://hooks.slack.com/services/T00/B11/xoxb-secret' }),
      alert({ webhook: 'https://hooks.slack.com/services/T00/B22/another-secret' }),
      alert({ webhook: 'https://events.pagerduty.com/v2/enqueue' }),
    ]
    const where = destinations(list)
    expect(where.map((d) => d.label)).toEqual(['hooks.slack.com', 'events.pagerduty.com'])
    expect(where[0]!.alerts).toBe(2)
  })

  it('lists the alerts that tell nobody as a destination of their own', () => {
    // "This one tells nobody" is the fact somebody most needs to see in a list
    // of where things go.
    expect(destinations([alert()])[0]!.label).toBe('history only')
  })

  it('puts a failing destination first, and says why it failed', () => {
    const list = [
      alert({ webhook: 'https://ok.example/hook', last_event: 'x', last_delivered: true }),
      alert({
        webhook: 'https://bad.example/hook',
        last_event: 'x',
        last_delivered: false,
        last_delivery_error: '401 Unauthorized',
      }),
    ]
    const where = destinations(list)
    expect(where[0]!.label).toBe('bad.example')
    expect(where[0]!.failing).toBe('401 Unauthorized')
    expect(where[1]!.failing).toBeNull()
  })

  it('tells never tried apart from every delivery arrived', () => {
    // Both have no failure to show, and they are not the same answer.
    const never = destinations([alert({ webhook: 'https://x.example/h' })])[0]!
    const arrived = destinations([
      alert({ webhook: 'https://x.example/h', last_event: 'x', last_delivered: true }),
    ])[0]!
    expect(never.tried).toBe(false)
    expect(arrived.tried).toBe(true)
  })
})

describe('describeInterval', () => {
  it('reads as a person would say it', () => {
    expect(describeInterval(60)).toBe('minute')
    expect(describeInterval(300)).toBe('5 minutes')
    expect(describeInterval(3600)).toBe('hour')
    expect(describeInterval(21_600)).toBe('6 hours')
    expect(describeInterval(86_400)).toBe('day')
  })
})

describe('describeAlert', () => {
  it('states the whole thing as one sentence', () => {
    // The point of the sentence: a condition that says the opposite of what was
    // meant is invisible in three dropdowns and obvious in a line of English.
    expect(describeAlert(cond(), 300)).toBe(
      'Every 5 minutes, run this and notify when the number of rows > 0.',
    )
    expect(describeAlert(cond({ metric: 'value', op: '<', threshold: 99.5 }), 3600)).toBe(
      'Every hour, run this and notify when the first value < 99.5.',
    )
  })
})

describe('parseCondition', () => {
  it('round trips what it serialises', () => {
    const c = cond({ metric: 'value', op: '>=', threshold: 12.5 })
    expect(parseCondition(serialiseCondition(c))).toEqual(c)
  })

  it('refuses anything it cannot fully read', () => {
    // Each of these would otherwise become a silently-never-firing alert.
    expect(parseCondition('')).toBeNull()
    expect(parseCondition('{}')).toBeNull()
    expect(parseCondition('{"metric":"rows","op":"~","threshold":1}')).toBeNull()
    expect(parseCondition('{"metric":"guess","op":">","threshold":1}')).toBeNull()
    expect(parseCondition('{"metric":"rows","op":">","threshold":"lots"}')).toBeNull()
    expect(parseCondition('{"metric":"rows","op":">"}')).toBeNull()
  })

  it('refuses a threshold that is not a real number', () => {
    expect(parseCondition('{"metric":"rows","op":">","threshold":null}')).toBeNull()
  })
})

describe('describeCondition', () => {
  it('names what is being measured, not the field name', () => {
    expect(describeCondition(cond())).toBe('the number of rows > 0')
    expect(describeCondition(cond({ metric: 'value', op: '!=', threshold: 3 }))).toBe(
      'the first value != 3',
    )
  })
})

describe('toneOf', () => {
  it('treats no state as its own thing, not as healthy', () => {
    expect(toneOf('')).toBe('idle')
    expect(toneOf('ok')).toBe('ok')
    expect(toneOf('firing')).toBe('firing')
    expect(toneOf('error')).toBe('error')
    expect(toneOf('something else')).toBe('idle')
  })
})

describe('deliveryNote', () => {
  it('says when an alert has nowhere to send', () => {
    expect(deliveryNote(alert(), true)).toContain('only writes to its own history')
  })

  it('says when the server will not send it', () => {
    const note = deliveryNote(alert({ webhook: 'http://x' }), false)
    expect(note).toContain('switched off')
  })

  it('says nothing when delivery will work', () => {
    expect(deliveryNote(alert({ webhook: 'http://x' }), true)).toBeNull()
  })
})

describe('problemWith', () => {
  it('catches the three ways the form is not ready', () => {
    expect(problemWith({ name: '', sql: 'SELECT 1', threshold: '0' })).toContain('name')
    expect(problemWith({ name: 'A', sql: '  ', threshold: '0' })).toContain('statement')
    expect(problemWith({ name: 'A', sql: 'SELECT 1', threshold: 'many' })).toContain('number')
    expect(problemWith({ name: 'A', sql: 'SELECT 1', threshold: '' })).toContain('number')
  })

  it('accepts a negative and a zero threshold', () => {
    expect(problemWith({ name: 'A', sql: 'SELECT 1', threshold: '0' })).toBeNull()
    expect(problemWith({ name: 'A', sql: 'SELECT 1', threshold: '-5' })).toBeNull()
  })
})

describe('intervalChoices', () => {
  it('keeps an interval the alert already has, even off-list', () => {
    // Otherwise editing an alert set to 10s through the API would show
    // "minute" and quietly save that instead.
    expect(intervalChoices(10)).toContain(10)
    expect(intervalChoices(10)[0]).toBe(10)
  })

  it('does not duplicate one that is already offered', () => {
    const choices = intervalChoices(300)
    expect(choices.filter((s) => s === 300)).toHaveLength(1)
  })

  it('stays in ascending order', () => {
    const choices = intervalChoices(7200)
    expect([...choices].sort((a, b) => a - b)).toEqual(choices)
  })
})

describe('deliveryNote, failed delivery', () => {
  const failing = alert({
    webhook: 'http://x',
    last_event: '2026-08-24 10:00:00',
    last_delivered: false,
    last_delivery_error: 'the endpoint answered 500',
  })

  it('leads with a notification that did not get through', () => {
    expect(deliveryNote(failing, true)).toContain('500')
  })

  it('says nothing once it does get through', () => {
    expect(deliveryNote({ ...failing, last_delivered: true }, true)).toBeNull()
  })

  it('does not accuse a brand-new alert of failing', () => {
    expect(deliveryNote({ ...failing, last_event: '' }, true)).toBeNull()
  })
})

describe('inSpace', () => {
  const at = (space: string, name = space): Alert =>
    ({ id: name, name, space, space_note: '' }) as Alert

  it('lists an alert where its subject lives, not where its author sits', () => {
    // The rule the two spaces are built on. An operator watching
    // `system.replicas` and an analyst watching `orders` each find their own.
    const all = [at('data'), at('infra')]
    expect(inSpace(all, 'data').map((a) => a.name)).toEqual(['data'])
    expect(inSpace(all, 'infra').map((a) => a.name)).toEqual(['infra'])
  })

  it('shows an alert nobody can place in both, rather than in neither', () => {
    // A `merge(...)` names no table, so what it reads is unknown. Dropped from
    // both lists it becomes an alert that is switched on and invisible.
    const all = [at('data'), at('unplaceable')]
    expect(inSpace(all, 'data')).toHaveLength(2)
    expect(inSpace(all, 'infra').map((a) => a.name)).toEqual(['unplaceable'])
  })
})

describe('saysElsewhere', () => {
  const at = (space: string): Alert => ({ id: space, name: space, space, space_note: '' }) as Alert

  it('says what it is holding back, and where it went', () => {
    expect(saysElsewhere([at('data'), at('infra'), at('infra')], 'data')).toBe(
      '2 more alerts are listed under Infrastructure, beside what they watch.',
    )
  })

  it('counts one as one', () => {
    expect(saysElsewhere([at('infra'), at('data')], 'infra')).toBe(
      '1 more alert is listed under Data, beside the tables they watch.',
    )
  })

  it('stays quiet when nothing is elsewhere', () => {
    expect(saysElsewhere([at('data'), at('unplaceable')], 'data')).toBeNull()
  })
})

describe('the rail and the list read the same rule', () => {
  const at = (state: string, enabled = true) => alert({ state, enabled })

  it('selects exactly what it counted', () => {
    /* The failure this pairing exists to prevent: a rail claiming "2 firing"
       beside a list showing three. Held to each other here rather than trusted
       to stay in step. */
    const list = [at('firing'), at('firing'), at('error'), at('ok', false), at('')]
    const tally = counts(list)
    for (const standing of STANDINGS) {
      expect(selected(list, standing)).toHaveLength(tally[standing])
    }
    expect(STANDINGS.reduce((n, s) => n + tally[s], 0)).toBe(list.length)
  })

  it('hands back the whole list when nothing is selected', () => {
    const list = [at('firing'), at('')]
    expect(selected(list, null)).toBe(list)
    expect(selected(list, '')).toBe(list)
  })

  it('selects nothing for a standing that does not exist', () => {
    // A link to a standing the product no longer has should come up empty and
    // say so, not quietly return everything as though it had been honoured.
    expect(selected([at('firing'), at('')], 'smouldering')).toHaveLength(0)
  })
})
