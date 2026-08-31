import { describe, expect, it } from 'vitest'

import {
  activeSection,
  allows,
  countIn,
  dataFor,
  keeps,
  spaceById,
  spaceOf,
  spacesFor,
} from './spaces'

/** A deployment that has everything, for the tests that are about something
 *  else. Written out rather than defaulted, so a test that cares about a
 *  capability has to say so. */
const FULL = { infrastructure: true, workspace: 'flint' }

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
    expect(spacesFor(FULL).map((s) => s.id)).toEqual(['data', 'infra'])
  })

  it('shows Data alone before the config has arrived', () => {
    // A section that appears and then vanishes on the first page load reads as
    // a bug; Data is the half that is always there.
    expect(spacesFor(undefined).map((s) => s.id)).toEqual(['data'])
  })

  it('drops the five sections that need somewhere to write', () => {
    // Stateless is a supported way to run Flint, not a broken one: the pages
    // that could only ever refuse are absent rather than present and failing.
    expect(spacesFor({ workspace: null }).flatMap((s) => s.sections.map((x) => x.id))).toEqual([
      'explore',
      'query',
      'diagnose',
    ])
  })

  it('keeps them once a workspace is named', () => {
    expect(spacesFor({ workspace: 'flint' }).flatMap((s) => s.sections.map((x) => x.id))).toEqual([
      'home',
      'explore',
      'query',
      'dash',
      'alerts',
      'reports',
      'apis',
      'diagnose',
    ])
  })

  it('withholds them until the config says there is one', () => {
    // Same rule as Infrastructure's: show what may vanish and the first load
    // reads as four sections crashing out of the bar.
    expect(spacesFor(undefined).flatMap((s) => s.sections.map((x) => x.id))).not.toContain('dash')
  })

  it('sends the Data link to the home, and to the schema without one', () => {
    // The space's name must never open the page that exists to explain why the
    // page is missing. Stateless, `Data` means what it has always meant.
    expect(dataFor({ workspace: 'flint' }).home).toBe('/home')
    expect(dataFor({ workspace: null }).home).toBe('/')
    expect(dataFor(undefined).home).toBe('/')
  })

  it('leaves the section table itself alone', () => {
    // The filter must copy: `spaceById` is the table every other reader shares,
    // and a Flint that started stateless once must not lose the sections for
    // the rest of the session.
    spacesFor({ workspace: null })
    expect(spaceById('data').sections.map((s) => s.id)).toContain('dash')
  })
})

describe('keeps', () => {
  it('is true only where a workspace database is named', () => {
    expect(keeps({ workspace: 'flint' })).toBe(true)
    expect(keeps({ workspace: null })).toBe(false)
  })

  it('treats an unanswered config as keeping nothing', () => {
    // The gate decides whether a request is sent. Guessing "yes" sends it and
    // renders the refusal, which is the bug this exists to prevent.
    expect(keeps(undefined)).toBe(false)
  })
})

describe('activeSection', () => {
  it('lights the section holding the page', () => {
    expect(activeSection('/query')).toBe('query')
    expect(activeSection('/dash/abc')).toBe('dash')
    expect(activeSection('/infra/cluster')).toBe('cluster')
  })

  it('lights Home only on the home', () => {
    // `/` is Explore's, and it stays Explore's: Flint still opens on a database
    // and the home is a place you go to, not the place you land.
    expect(activeSection('/home')).toBe('home')
    expect(activeSection('/')).toBe('explore')
  })

  it('gives every unclaimed Data page to Explore', () => {
    // A NavLink to "/" would only ever light up on the landing redirect itself.
    expect(activeSection('/')).toBe('explore')
    expect(activeSection('/db/analytics')).toBe('explore')
    expect(activeSection('/server')).toBe('explore')
  })

  it('lights Home on the board and not on the pages under it', () => {
    // `/infra` is both a page and the stem of every sibling. Under the plain
    // prefix rule Home claimed all eight of them and the bar lit Home while the
    // reader was looking at Health.
    expect(activeSection('/infra')).toBe('home')
    expect(activeSection('/infra/health')).toBe('health')
    expect(activeSection('/infra/audit')).toBe('audit')
  })

  it('lights nothing for an unknown Infrastructure page', () => {
    // Infrastructure has no catch-all: guessing would light Health on a page
    // that is not Health.
    // Deliberately a section that does not exist yet — this test broke when
    // `/infra/backups` became real, and again when `/infra/audit` did. The
    // example moves, the rule stays.
    expect(activeSection('/infra/versions')).toBeUndefined()
  })
})

describe('countIn', () => {
  const items = [
    { to: '/alerts' },
    { to: '/alerts' },
    { to: '/reports' },
    { to: '/apis' },
    { to: '/infra/cluster' },
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
    for (const space of spacesFor(FULL)) {
      expect(spaceOf(space.home)).toBe(space.id)
    }
  })

  it('claims no section for a space it does not belong to', () => {
    for (const space of spacesFor(FULL)) {
      for (const section of space.sections) {
        expect(spaceOf(section.to)).toBe(space.id)
      }
    }
  })

  it('sends each space link to that space’s own first section', () => {
    // Both boards are now reachable from inside their space, not only from the
    // space's name — which is the whole point of the entry existing.
    for (const space of spacesFor(FULL)) {
      expect(space.sections[0]?.to).toBe(space.home)
    }
  })

  it('badges a section with a target that is the section itself', () => {
    // A badge counting concerns that point somewhere else is a number nobody
    // can reconcile with the page it sits on.
    for (const space of spacesFor(FULL)) {
      for (const section of space.sections) {
        if (section.badge) expect(section.badge).toBe(section.to)
      }
    }
  })

  it('keeps Infrastructure to the sections that are built', () => {
    // Absent means absent: a link to "not built yet" is a promise made in the
    // wrong place. Update this list — and ROADMAP.md — when one lands.
    expect(spaceById('infra').sections.map((s) => s.id)).toEqual([
      'home',
      'health',
      'pipelines',
      'cluster',
      'schema',
      'backups',
      'access',
      'config',
      'audit',
    ])
  })
})
