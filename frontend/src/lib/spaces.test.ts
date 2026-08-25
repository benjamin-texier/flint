import { describe, expect, it } from 'vitest'

import {
  activeSection,
  allows,
  countIn,
  spaceById,
  spaceOf,
  spacesFor,
} from './spaces'

describe('spaceOf', () => {
  it('reads the space off the path prefix', () => {
    expect(spaceOf('/')).toBe('data')
    expect(spaceOf('/query')).toBe('data')
    expect(spaceOf('/db/analytics/events')).toBe('data')
    expect(spaceOf('/infra/health')).toBe('infra')
    expect(spaceOf('/infra')).toBe('infra')
  })

  it('does not mistake a path that merely starts with the same letters', () => {
    // The one that would have bitten: a Data page named "infrastructure-cost"
    // must not answer that it is an Infrastructure page.
    expect(spaceOf('/infrastructure-cost')).toBe('data')
  })
})

describe('spacesFor', () => {
  it('drops Infrastructure entirely when the deployment turns it off', () => {
    expect(spacesFor({ infrastructure: false }).map((s) => s.id)).toEqual(['data'])
  })

  it('shows both when it is on', () => {
    expect(spacesFor({ infrastructure: true }).map((s) => s.id)).toEqual(['data', 'infra'])
  })

  it('shows Data alone before the config has arrived', () => {
    // A section that appears and then vanishes on the first page load reads as
    // a bug; Data is the half that is always there.
    expect(spacesFor(undefined).map((s) => s.id)).toEqual(['data'])
  })
})

describe('activeSection', () => {
  it('lights the section holding the page', () => {
    expect(activeSection('/query')).toBe('query')
    expect(activeSection('/dash/abc')).toBe('dash')
    expect(activeSection('/infra/replication')).toBe('replication')
  })

  it('gives every unclaimed Data page to Explore', () => {
    // A NavLink to "/" would only ever light up on the landing redirect itself.
    expect(activeSection('/')).toBe('explore')
    expect(activeSection('/db/analytics')).toBe('explore')
    expect(activeSection('/server')).toBe('explore')
  })

  it('lights nothing for an unknown Infrastructure page', () => {
    // Infrastructure has no catch-all: guessing would light Health on a page
    // that is not Health.
    expect(activeSection('/infra/backups')).toBeUndefined()
  })
})

describe('countIn', () => {
  const items = [
    { to: '/alerts' },
    { to: '/alerts' },
    { to: '/reports' },
    { to: '/apis' },
    { to: '/infra/replication' },
  ]

  it('files each concern under the space that can act on it', () => {
    expect(countIn(items, 'data')).toBe(4)
    expect(countIn(items, 'infra')).toBe(1)
  })

  it('is zero rather than absent when a space is quiet', () => {
    expect(countIn([{ to: '/alerts' }], 'infra')).toBe(0)
  })
})

describe('allows', () => {
  it('carries every tier below the one asked for', () => {
    expect(allows('admin', 'ddl')).toBe(true)
    expect(allows('ddl', 'data')).toBe(true)
    expect(allows('data', 'ddl')).toBe(false)
    expect(allows('read', 'data')).toBe(false)
  })

  it('treats an unknown tier as the most restrictive one', () => {
    // The config request can fail; a missing answer must not read as permission.
    expect(allows(undefined, 'data')).toBe(false)
    expect(allows(undefined, 'read')).toBe(true)
  })
})

describe('the sections themselves', () => {
  it('sends each space link to a page that space actually owns', () => {
    for (const space of spacesFor({ infrastructure: true })) {
      expect(spaceOf(space.home)).toBe(space.id)
    }
  })

  it('claims no section for a space it does not belong to', () => {
    for (const space of spacesFor({ infrastructure: true })) {
      for (const section of space.sections) {
        expect(spaceOf(section.to)).toBe(space.id)
      }
    }
  })

  it('badges a section with a target that is the section itself', () => {
    // A badge counting concerns that point somewhere else is a number nobody
    // can reconcile with the page it sits on.
    for (const space of spacesFor({ infrastructure: true })) {
      for (const section of space.sections) {
        if (section.badge) expect(section.badge).toBe(section.to)
      }
    }
  })

  it('keeps Infrastructure to the sections that are built', () => {
    // Absent means absent: a link to "not built yet" is a promise made in the
    // wrong place. Update this list — and ROADMAP.md — when one lands.
    expect(spaceById('infra').sections.map((s) => s.id)).toEqual([
      'health',
      'pipelines',
      'replication',
      'access',
    ])
  })
})
