import { describe, expect, it } from 'vitest'
import {
  describeAlert,
  describeCondition,
  describeInterval,
  deliveryNote,
  intervalChoices,
  parseCondition,
  problemWith,
  serialiseCondition,
  toneOf,
  type Alert,
  type Condition,
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
