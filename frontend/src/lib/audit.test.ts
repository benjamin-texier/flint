import { describe, expect, it } from 'vitest'

import {
  actorOf,
  KIND_LABEL,
  obstacles,
  outcomeNote,
  quiet,
  scopeSentence,
  type AuditEntry,
  type AuditReport,
} from './audit'

const report = (over: Partial<AuditReport> = {}): AuditReport => ({
  days: 7,
  entries: [],
  ...over,
})

describe('obstacles', () => {
  it('keeps the two halves apart', () => {
    // A grant on `system.query_log` and a missing workspace are fixed in
    // different places, and one merged "unavailable" would hide whichever half
    // still worked.
    const both = obstacles(
      report({ calls_unavailable: 'no SELECT on it', operations_unavailable: 'no workspace' }),
    )
    expect(both).toHaveLength(2)
    expect(both[0]).toContain('Calls and reads')
    expect(both[1]).toContain('Operations')
  })

  it('says nothing where nothing is blocked', () => {
    expect(obstacles(report())).toEqual([])
    expect(obstacles(undefined)).toEqual([])
  })
})

describe('quiet', () => {
  it('is true only when both halves were readable and nothing happened', () => {
    expect(quiet(report())).toBe(true)
  })

  it('is false when the list is empty because it could not be read', () => {
    // The distinction the page turns on: "nobody did anything" and "this cannot
    // see what anybody did" look identical and mean the opposite.
    expect(quiet(report({ calls_unavailable: 'no SELECT on it' }))).toBe(false)
    expect(quiet(report({ operations_unavailable: 'no workspace' }))).toBe(false)
  })

  it('is false when there is a trail', () => {
    expect(
      quiet(
        report({
          entries: [{ at: 'now', who: 'a', kind: 'dataset', what: 'db.t', outcome: 'ok' }],
        }),
      ),
    ).toBe(false)
  })

  it('is false before the answer arrives', () => {
    // Undefined is "not yet", and calling it quiet would tell somebody their
    // week was uneventful while the request is still in flight.
    expect(quiet(undefined)).toBe(false)
  })
})

describe('scopeSentence', () => {
  it('says what the trail does not hold, not only what it does', () => {
    // The question this answers is asked while looking at the page: is my
    // colleague's query missing because they ran none, or because this does not
    // show them?
    const said = scopeSentence(report())
    expect(said).toContain('Operations')
    expect(said).toContain('editor')
    expect(said).toContain('History')
  })
})

describe('actorOf', () => {
  const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
    at: 'now',
    who: 'default',
    kind: 'dataset',
    what: 'db.t',
    outcome: 'ok',
    ...over,
  })

  it('names the person where the log knows one', () => {
    // A dataset read and an operation are done *by* somebody: they signed in.
    expect(actorOf(entry({ who: 'analyst' }))).toEqual({ who: 'analyst' })
    expect(actorOf(entry({ kind: 'operation', who: 'analyst' }))).toEqual({ who: 'analyst' })
  })

  it('and refuses to name one where it does not', () => {
    // A published endpoint is called by whoever holds its token. The account in
    // the log is what the statement ran *as* — printing it under "Who" says a
    // named person made a call they may never have heard of.
    expect(actorOf(entry({ kind: 'endpoint', who: 'default' }))).toEqual({
      who: 'token holder',
      ranAs: 'default',
    })
  })
})

describe('outcomeNote', () => {
  it('says nothing about the ones that worked', () => {
    // A badge on every line is a badge nobody reads.
    expect(outcomeNote('ok')).toBeNull()
  })

  it('calls a refusal a refusal', () => {
    expect(outcomeNote('failed')?.label).toBe('refused')
  })

  it('and never calls an unfinished one that', () => {
    // A running job may yet succeed, and an interrupted one very often already
    // did. Under the boolean this replaced, both read as failures.
    const note = outcomeNote('unfinished')
    expect(note?.label).toBe('unfinished')
    expect(note?.tone).not.toContain('error')
  })
})

describe('KIND_LABEL', () => {
  it('reads as actions, because an audit is read to reconstruct them', () => {
    expect(KIND_LABEL.operation).toBe('ran')
    expect(KIND_LABEL.endpoint).toBe('called')
    expect(KIND_LABEL.dataset).toBe('read')
  })
})
