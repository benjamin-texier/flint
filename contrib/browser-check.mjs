/**
 * Every page, in a real browser: console errors, failed requests, and WCAG AA
 * contrast on every text/background pair the page actually renders.
 *
 *   node contrib/browser-check.mjs [base-url]
 *
 * Exits non-zero on the first thing a reader would notice. This exists because
 * the defects it finds are invisible to every other check in this repo: a
 * component that throws only when a stored record is in an older shape, a
 * button whose label drops below AA *while the pointer is on it*, a windowed
 * grid that renders six thousand pixels tall because its parent is unbounded.
 * All three shipped and all three were found here.
 *
 * The browser is the system's, not a downloaded one: set FLINT_BROWSER, or let
 * it look in the usual places.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const BASE = process.argv[2] ?? 'http://localhost:8096'

const BROWSERS = [
  process.env.FLINT_BROWSER,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)

/** Runs in the page. Walks visible text nodes, finds the first opaque
 *  background behind each, and measures the ratio. */
const AUDIT = `(() => {
  const parse = (c) => {
    const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null
    const [r, g, b, a = 1] = m[1].split(',').map(Number)
    return { r, g, b, a }
  }
  const bgOf = (el) => {
    let n = el
    while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor)
      if (c && c.a > 0.95) return c
      n = n.parentElement
    }
    return parse(getComputedStyle(document.body).backgroundColor)
  }
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }
  const out = []
  const seen = new Set()
  for (const el of document.querySelectorAll('body *')) {
    const text = (el.textContent || '').trim()
    if (!text || el.children.length > 0) continue
    if (el.offsetParent === null) continue
    const cs = getComputedStyle(el)
    const fg = parse(cs.color), bg = bgOf(el)
    if (!fg || !bg) continue
    const key = cs.color + '|' + bg.r + bg.g + bg.b + '|' + el.className
    if (seen.has(key)) continue
    seen.add(key)
    const px = parseFloat(cs.fontSize)
    const bold = parseInt(cs.fontWeight, 10) >= 700
    // WCAG AA: 3.0 for large text, 4.5 otherwise.
    const need = px >= 24 || (px >= 18.66 && bold) ? 3.0 : 4.5
    out.push({
      cls: (el.className || el.tagName).toString().slice(0, 44),
      text: text.slice(0, 26), px, r: Math.round(ratio(fg, bg) * 100) / 100, need,
    })
  }
  return out
})()`

/** `wait` is a selector that has to appear before the page counts as ready —
 *  auditing a spinner measures nothing. */
const PAGES = [
  /* `/` is the arrival board — a verdict about the server and the findings
     behind it. It used to redirect to a database, which is why this line waited
     for a graph node; the schema has its own address now and is checked below. */
  { path: '/', wait: '.arrival__verdict' },
  { path: '/explore', wait: '.gnode' },
  // Data's board. Waits for a row rather than for `main`, because every figure
  // on this page is dropped when its request has not landed — so `main` is
  // there a beat before there is anything on it to measure, and a contrast
  // audit of an empty page passes by having nothing to fail on. Needs a
  // workspace, like the four below it; without one the page is one note and
  // the audit is still worth running on it.
  { path: '/home', wait: '.home__row, .note--empty' },
  { path: '/server', wait: '.tbl' },
  // The same grid one level up: rows are databases. Its own entry because the
  // section is below the fold of the databases table and nothing else waits for
  // it — a server-scope grid that threw would have gone unnoticed.
  { path: '/server', wait: '.ptime__table' },
  { path: '/query', wait: 'main' },
  // The form is a face of the query page now, not a page. Both ways in are
  // walked: the mode parameter, which is what links to it, and `/build`, which
  // is the redirect that keeps the bookmarks and the pasted links working.
  { path: '/query?mode=build', wait: '.buildband' },
  { path: '/build', wait: 'main' },
  { path: '/dash', wait: 'main' },
  { path: '/diagnose', wait: '.tbl' },
  // Infrastructure. Each is a different set of system tables and a different
  // way of being unavailable, which is why they are walked separately rather
  // than trusted to behave like the page next door.
  // The board first: one row per section, and the row that could not be read
  // has to say so rather than showing green.
  { path: '/infra', wait: '.board' },
  { path: '/infra/health', wait: 'main' },
  { path: '/infra/pipelines', wait: 'main' },
  { path: '/infra/schema', wait: 'main' },
  { path: '/infra/backups', wait: 'main' },
  { path: '/infra/access', wait: 'main' },
  { path: '/infra/cluster', wait: 'main' },
  { path: '/infra/config', wait: 'main' },
  // The links that used to reach those views. They are in bookmarks and in
  // already-delivered webhooks, so the redirect is part of the product.
  { path: '/diagnose?view=pipelines', wait: 'main' },
  { path: '/diagnose?view=access', wait: 'main' },
  { path: '/diagnose?view=replication', wait: 'main' },
  // The path the cluster section had when it was only about replicas.
  { path: '/infra/replication', wait: 'main' },
  { path: '/alerts', wait: 'main' },
  { path: '/reports', wait: 'main' },
  { path: '/apis', wait: 'main' },
  // The key list, which is folded away by default and so would otherwise never
  // be rendered here — and it is the surface holding a secret, a warning and a
  // set of chips, all of which have their own contrast to keep.
  { path: '/apis?keys=1', wait: '.keys__list, .keys__lead' },
  // The table picker, likewise folded away by default — and the one surface
  // that renders a scrolling list of ticked rows, which is its own layout to
  // get wrong.
  { path: '/apis?expose=1', wait: '.expose__list, .expose__bar' },
]

/** A real table to open, discovered rather than assumed: the object page is the
 *  richest in the product and a fixed path would only work on one deployment. */
async function discover() {
  try {
    const dbs = await (await fetch(`${BASE}/api/databases`)).json()
    const internal = new Set(['system', 'INFORMATION_SCHEMA', 'information_schema'])
    const db = (Array.isArray(dbs) ? dbs : []).find((d) => !internal.has(d.name) && d.tables > 0)
    if (!db) return []
    const tables = await (await fetch(`${BASE}/api/databases/${encodeURIComponent(db.name)}/tables`)).json()
    // The fullest one: the preview, the profile and the grid all have more to
    // show, and an empty table would quietly skip most of what this checks.
    const table = (Array.isArray(tables) ? tables : [])
      .filter((t) => t.kind === 'table')
      .sort((a, b) => (b.parts_rows ?? 0) - (a.parts_rows ?? 0))[0]
    if (!table) return []
    const at = `/db/${encodeURIComponent(db.name)}/${encodeURIComponent(table.name)}`
    const database = `/db/${encodeURIComponent(db.name)}`
    return [
      /* The database's four readings by URL rather than by clicking: each one is
         a link somebody can send, so each one has to render from a cold load —
         which is a different path through the page than switching into it. */
      { path: `${database}?view=time`, wait: '.ptime, .note' },
      { path: `${database}?view=time&grain=month`, wait: '.ptime, .note' },
      { path: `${database}?view=mass`, wait: '.mass, .note' },
      { path: `${database}?view=together`, wait: '.paff, .note' },
      { path: `${database}?view=together&days=1`, wait: '.paff, .note' },
      /* The database-wide review, which opens on its ask rather than on an
         answer: it samples every table the pattern catches, and spending that
         before anybody asked is not a courtesy. Walked with a pattern too,
         since the pattern is in the URL and a link with one in it is the way
         this reading actually gets sent. */
      { path: `${database}?view=review`, wait: '.sweep__pick' },
      /* Which of these tables the workload argues about. A table of readings
         with a pill per row, and the one page in this feature whose whole job
         is comparison between rows — so its contrast has to hold in both
         themes like everything else here. */
      { path: `${database}?view=keys`, wait: 'main' },
      { path: `${database}?view=review&like=%25`, wait: '.sweep__pick' },
      { path: at, wait: 'main' },
      { path: `${at}?tab=columns`, wait: '.tbl' },
      { path: `${at}?tab=path`, wait: 'main' },
      { path: `${at}?tab=profile`, wait: 'main' },
      // Relations opens on its ask rather than on an answer: it reads every row
      // twice, and spending that before anybody asked is not a courtesy.
      { path: `${at}?tab=relations`, wait: '.rel__ask' },
      // The schema review: a panel of findings, each with a DDL and a caution.
      // Visited because its wording is the product — a recommendation nobody
      // can read is worse than none — and because its own contrast has to hold
      // in both themes like everything else here.
      { path: `${at}?tab=review`, wait: 'main' },
      /* The projection advisor: proposals in cards, each one a paragraph of
         argument, a statement and two folds. Its wording is the product in the
         same way the review's is, and it carries the one warning colour on the
         page — a caveat that fails AA is a caution nobody reads. */
      { path: `${at}?tab=projections`, wait: 'main' },
      { path: `${at}?tab=ddl`, wait: 'main' },
    ]
  } catch {
    return []
  }
}

/** One published endpoint, discovered the same way and for the same reason.
 *
 *  The endpoint page is the other rich one: a contract table, four traffic
 *  panels, a quota meter and two bar lists, half of which only render once
 *  something has actually called the address. A fixed slug would work on the
 *  dev stack and nowhere else, and a page nobody checks is a page whose
 *  contrast regresses quietly. */
async function discoverEndpoint() {
  try {
    const published = await (await fetch(`${BASE}/api/published`)).json()
    if (!Array.isArray(published) || published.length === 0) return []
    // The live one, and the address with the most revisions where there is a
    // choice: more revisions means the tablist renders, which is the one
    // control on the page with an ARIA contract to keep.
    const counts = new Map()
    for (const row of published) counts.set(row.slug, (counts.get(row.slug) ?? 0) + 1)
    const best = published
      .filter((row) => row.state === 'live')
      .sort((a, b) => (counts.get(b.slug) ?? 0) - (counts.get(a.slug) ?? 0))[0]
    if (!best) return []
    return [{ path: `/apis/${encodeURIComponent(best.slug)}`, wait: '.ep__panel, .note' }]
  } catch {
    return []
  }
}

/** Two themes over twenty pages is minutes; while working on one surface you
 *  want that surface. `--only grid` / `--only /build` matches on the label. */
const ONLY = (() => {
  const i = process.argv.indexOf('--only')
  return i > -1 ? process.argv[i + 1] : null
})()
const wanted = (label) => !ONLY || label.includes(ONLY)

let failures = 0
const fail = (what) => {
  failures += 1
  console.log(`  FAIL ${what}`)
}

/* This file holds no session, and a Flint behind a sign-in serves the same one
   screen at every address. So without this it would audit the sign-in form
   twenty times and report a clean run — which is worse than a failure: a gate
   that passes while covering nothing teaches people to trust it.

   No credentials here on purpose. What this measures is contrast and console
   noise across every page, and the deployment to point it at is one that signs
   nobody in — `FLINT_AUTH` off, and a server in the manifest. An unpinned Flint
   asks for a session by construction, so it is one of the two this refuses. */
const asked = await fetch(`${BASE}/api/session`)
  .then((r) => r.json())
  .catch(() => null)
if (!asked) {
  console.log(`no Flint answering at ${BASE}`)
  process.exit(2)
}
if (asked.required && !asked.user) {
  /* Not a refusal, once you notice what is actually on the screen. Every address
     serves the sign-in form, so walking twenty of them would report a clean run
     having covered one page — and a gate that passes while covering nothing is
     worse than one that fails. But that page is also the *only* screen no other
     run can reach: with `FLINT_AUTH` off there is no sign-in to look at, so its
     contrast and its console have never been measured by anything. So audit the
     one page there is, in both themes, and say what was not covered. */
  console.log(
    'this Flint signs people in, and this check holds no session — so the sign-in screen\n' +
      'is the only page reachable. It is audited below, and it is the one screen no other\n' +
      'run can reach. For the other twenty, point this at a Flint with FLINT_AUTH off and\n' +
      'FLINT_CLICKHOUSE_URL set.',
  )
  const only = await open()
  try {
    for (const scheme of ['light', 'dark']) {
      console.log(`\n${scheme}`)
      /* `.signin__form` rather than `main`: the shell is not rendered here, and
         waiting for something the page does not draw would report the screen as
         never ready. The form, not the stage beside it — the stage renders with
         no config at all, so it would go green on a page whose form never
         arrived. */
      await visit(only, { path: '/', wait: '.signin__form' }, scheme)
    }
  } finally {
    await only.close()
  }
  console.log()
  if (failures) {
    console.log(`${failures} problem(s) on the sign-in screen`)
    process.exit(1)
  }
  console.log('the sign-in screen renders clean, and every text pair clears WCAG AA')
  /* Zero, not two. What it was asked to check, it checked — and the sentence
     above already says which pages it could not reach. Failing here would make
     `make check-live` unrunnable against a deployment that signs people in,
     which is most of the ones worth checking. */
  process.exit(0)
}

const discovered = await discover()
if (discovered.length === 0) {
  console.log('note: no user table found, so the object page is not covered')
}

const endpoints = await discoverEndpoint()
if (endpoints.length === 0) {
  console.log('note: nothing is published, so the endpoint page is not covered')
}

const browser = await open()
try {
  for (const scheme of ['light', 'dark']) {
    console.log(`\n${scheme}`)
    for (const page of [...PAGES, ...discovered, ...endpoints]) {
      if (wanted(page.path)) await visit(browser, page, scheme)
    }
    if (wanted('palette')) await palette(browser, scheme)
    if (wanted('grid')) await resultGrid(browser, scheme)
    if (wanted('diagram')) await diagram(browser, scheme)
    if (wanted('time')) await timeGrid(browser, scheme)
    if (wanted('mass')) await massMap(browser, scheme)
    if (wanted('together')) await together(browser, scheme)
    if (wanted('range')) await dashboardRange(browser, scheme)
    if (wanted('compare')) await compareTables(browser, scheme)
    if (wanted('shape')) await columnShape(browser, scheme)
    if (wanted('overtime')) await overTime(browser, scheme)
    if (wanted('index')) await onThisPage(browser, scheme)
    if (wanted('spark')) await sparks(browser, scheme)
    if (wanted('alerts')) await alertsRail(browser, scheme)
    if (wanted('board')) await board(browser, scheme)
    if (wanted('news')) await newsBand(browser, scheme)
    if (wanted('console')) await consoleDrawer(browser, scheme)
  }
} finally {
  await browser.close()
}

console.log()
if (failures) {
  console.log(`${failures} problem(s)`)
  process.exit(1)
}
console.log('every page renders clean, and every text pair clears WCAG AA')

async function open() {
  const chromium = await driver()
  if (!chromium) {
    console.error(
      'playwright-core is not installed. Run `pnpm install` in frontend/ — it is a dev dependency there.',
    )
    process.exit(2)
  }
  const executablePath = BROWSERS.find((p) => existsSync(p))
  if (!executablePath) {
    console.error(
      'no browser found. Set FLINT_BROWSER to a Chrome or Chromium binary.\nLooked in:\n  ' +
        BROWSERS.join('\n  '),
    )
    process.exit(2)
  }
  return chromium.launch({ executablePath, args: ['--no-sandbox', '--disable-gpu'] })
}

/** The driver lives in `frontend/node_modules`, and this script does not, so a
 *  bare import cannot find it. Tried both ways rather than assuming either. */
async function driver() {
  try {
    return (await import('playwright-core')).chromium
  } catch {
    /* fall through to the frontend's copy */
  }
  const here = dirname(fileURLToPath(import.meta.url))
  const local = join(here, '..', 'frontend', 'node_modules', 'playwright-core', 'index.mjs')
  if (!existsSync(local)) return null
  try {
    return (await import(`file://${local}`)).chromium
  } catch {
    return null
  }
}

/** Whether a console message is worth failing on.
 *
 *  Errors are, with one exception the response handler below already makes for
 *  itself: the browser logs its own `Failed to load resource` line for every 4xx,
 *  so a Flint running without a workspace database — where `/api/alerts` and the
 *  rest correctly answer 400 — failed this check forty-six times for the one
 *  thing the file says in as many words is not a fault. Judged by the request's
 *  URL rather than by the message, which does not carry it. */
function consoleNoise(m) {
  if (m.type() !== 'error') return false
  const url = m.location()?.url ?? ''
  return !(url.includes('/api/') && /Failed to load resource/.test(m.text()))
}

async function visit(browser, { path, wait }, colorScheme) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme })
  const noise = []
  page.on('console', (m) => consoleNoise(m) && noise.push(`console: ${m.text().slice(0, 120)}`))
  page.on('pageerror', (e) => noise.push(`threw: ${String(e).slice(0, 120)}`))
  page.on('response', (r) => {
    // A 4xx on a workspace endpoint is Flint's stateless mode answering, not a
    // fault; anything else is.
    if (r.status() >= 400 && !r.url().includes('/api/')) noise.push(`${r.status()} ${r.url()}`)
  })

  try {
    await page.goto(BASE + path, { waitUntil: 'networkidle' })
    // Generous: the schema page draws every object on a real database and this
    // script runs twenty of these back to back. A check that fails when the
    // machine is busy is a check people stop believing.
    await page.waitForSelector(wait, { timeout: 30_000 })
    // Long enough for the deferred queries a page fires after its first paint.
    await page.waitForTimeout(1800)
  } catch (e) {
    fail(`${path} never became ready: ${String(e).split('\n')[0]}`)
    await page.close()
    return
  }

  const pairs = await page.evaluate(AUDIT)
  const under = pairs.filter((p) => p.r < p.need)
  for (const p of under) {
    fail(`${path} ${p.r.toFixed(2)}:1 (needs ${p.need}) at ${p.px}px — ${JSON.stringify(p.text)} .${p.cls}`)
  }
  for (const n of noise) fail(`${path} ${n}`)
  if (!under.length && !noise.length) {
    console.log(`  ok   ${path.padEnd(22)} ${pairs.length} text pairs`)
  }
  await page.close()
}

/** The grid's own controls exist only once a result does: no URL reaches the
 *  selection statistics, the data bars, the totals row or the column picker, so
 *  a page load never audits them. */
async function resultGrid(browser, colorScheme) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme })
  const noise = []
  page.on('pageerror', (e) => noise.push(`threw: ${String(e).slice(0, 120)}`))
  page.on('console', (m) => consoleNoise(m) && noise.push(`console: ${m.text().slice(0, 120)}`))
  const before = failures
  try {
    // `system.numbers` is on every server and every value is present: a block of
    // NULLs would report no statistics, which is correct behaviour and a useless
    // check. The text column is there so "only the declared numbers count" is
    // exercised rather than assumed.
    const sql =
      'SELECT number AS n, number * 3 AS triple, toString(number) AS label FROM system.numbers LIMIT 50'
    await page.goto(`${BASE}/query?sql=${encodeURIComponent(sql)}`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /^Run/ }).click()
    await page.waitForSelector('.grid__cell', { timeout: 20_000 })

    for (const label of ['data bars', 'totals']) {
      const button = page.getByRole('button', { name: label })
      if (await button.count()) await button.first().click()
    }
    await page.waitForTimeout(600)
    if (!(await page.locator('.grid__totals').count())) fail('grid: the totals row did not appear')
    if (!(await page.locator('.grid__cell[style*="linear-gradient"]').count()))
      fail('grid: data bars drew nothing')

    // A block of numbers in the *body*: the totals row carries the same numeric
    // class for alignment, and a cell there answers no pointer.
    const numeric = page.locator('.grid__body .grid__cell--num').nth(3)
    if (await numeric.count()) {
      await numeric.click()
      for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowDown')
      await page.waitForTimeout(500)
      if ((await page.locator('.gridshell__stat').count()) < 4)
        fail('grid: a selected block of numbers reported no statistics')
    }

    const picker = page.getByRole('button', { name: /^columns/ })
    if (await picker.count()) {
      await picker.first().click()
      await page.waitForTimeout(400)
      if (!(await page.locator('.colpick__item').count())) fail('grid: the column picker was empty')
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
      if (await page.locator('.colpick').count()) fail('grid: the column picker ignored Escape')
    }

    const pairs = await page.evaluate(AUDIT)
    for (const p of pairs.filter((p) => p.r < p.need)) {
      fail(`grid ${p.r.toFixed(2)}:1 (needs ${p.need}) — ${JSON.stringify(p.text)} .${p.cls}`)
    }
    for (const n of noise) fail(`grid ${n}`)
    if (failures === before) console.log(`  ok   ${'result grid'.padEnd(22)} ${pairs.length} text pairs`)
  } catch (e) {
    fail(`result grid: ${String(e).split('\n')[0]}`)
  }
  await page.close()
}

/** The details panel and the node menu are both behind a pointer, so the schema
 *  page audited on load covers neither. */
async function diagram(browser, colorScheme) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme })
  const noise = []
  page.on('pageerror', (e) => noise.push(`threw: ${String(e).slice(0, 120)}`))
  page.on('console', (m) => consoleNoise(m) && noise.push(`console: ${m.text().slice(0, 120)}`))
  const before = failures
  try {
    await page.goto(`${BASE}/explore`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.gnode', { timeout: 20_000 })
    await page.locator('.gnode').first().click()
    await page.waitForSelector('.npanel', { timeout: 8000 })
    await page.waitForTimeout(1200)

    await page.locator('.gnode').first().click({ button: 'right' })
    await page.waitForSelector('.nmenu', { timeout: 6000 })
    const pairs = await page.evaluate(AUDIT)
    for (const p of pairs.filter((p) => p.r < p.need)) {
      fail(`diagram ${p.r.toFixed(2)}:1 (needs ${p.need}) — ${JSON.stringify(p.text)} .${p.cls}`)
    }
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    if (await page.locator('.nmenu').count()) fail('diagram: the node menu ignored Escape')
    for (const n of noise) fail(`diagram ${n}`)
    if (failures === before) console.log(`  ok   ${'diagram panel'.padEnd(22)} ${pairs.length} text pairs`)
  } catch (e) {
    fail(`diagram: ${String(e).split('\n')[0]}`)
  }
  await page.close()
}

/** The frame's two obligations, asserted together because they are each other's
 *  counterweight: the page must not scroll sideways, *and* a table wider than its
 *  frame must scroll inside it. Either alone can be satisfied by a mistake — a
 *  page that does not scroll because the columns were clipped away is worse than
 *  one that does. Both were real: the matrix scrolled the window 54px at
 *  twenty-odd columns, which `contain: paint` on the frame fixed, and clipping is
 *  exactly what that property would cause if the overflow rule were ever lost. */
async function framed(page, what) {
  const r = await page.evaluate(() => {
    const box = document.querySelector('.ptime__scroll, .paff__scroll')
    const table = box?.querySelector('table')
    return {
      spill: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      frame: box ? Math.round(box.getBoundingClientRect().width) : 0,
      table: table ? Math.round(table.getBoundingClientRect().width) : 0,
      scrolls: box ? box.scrollWidth - box.clientWidth : 0,
    }
  })
  if (r.spill > 1) fail(`${what}: the page scrolls ${r.spill}px sideways`)
  if (r.table > r.frame + 1 && r.scrolls < 1) {
    fail(`${what}: a ${r.table}px table in a ${r.frame}px frame that does not scroll — clipped`)
  }
}

/** The partition grid, which is a mode of the schema section rather than a page
 *  and so is reached by nothing above. Two things are checked that only a
 *  browser can answer: that the grid's own frame scrolls sideways instead of the
 *  document — a wide database is hundreds of columns and a page that scrolls
 *  horizontally is the failure this rule exists to prevent — and that the cells
 *  and their labels clear AA in both schemes. */
async function timeGrid(browser, colorScheme) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme })
  const noise = []
  page.on('pageerror', (e) => noise.push(`threw: ${String(e).slice(0, 120)}`))
  page.on('console', (m) => consoleNoise(m) && noise.push(`console: ${m.text().slice(0, 120)}`))
  const before = failures
  try {
    const dbs = await (await fetch(`${BASE}/api/databases`)).json()
    const internal = new Set(['system', 'INFORMATION_SCHEMA', 'information_schema'])
    const db = (Array.isArray(dbs) ? dbs : []).find((d) => !internal.has(d.name) && d.tables > 0)
    if (!db) {
      console.log(`  --   ${'partition grid'.padEnd(22)} no user database to draw`)
      await page.close()
      return
    }

    await page.goto(`${BASE}/db/${encodeURIComponent(db.name)}`, { waitUntil: 'networkidle' })
    // Scoped to the section's own controls throughout: `Rows` is also a column
    // of the object list further down the page, and a locator that matches both
    // fails on a page where nothing is wrong.
    const schema = page.locator('.schema')
    await schema.getByRole('button', { name: 'Time' }).click()
    /* `.note` as well as the table: a role without `SELECT` on `system.parts`
       gets an explanation instead of a grid, which is the designed answer and
       not a fault. Waiting only for the table turned that into a twenty-second
       timeout and a red line — this check told anybody running it against a
       narrowly-granted deployment that Flint was broken, for behaving exactly as
       documented. Verified against such a role, which the dev cluster keeps as
       `flint_probe`. */
    await page.waitForSelector('.ptime__table, .note', { timeout: 20_000 })
    await page.waitForTimeout(800)

    if (!(await page.locator('.ptime__table').count())) {
      const why = ((await page.locator('.note').first().textContent()) ?? '').replace(/\s+/g, ' ')
      const pairs = await page.evaluate(AUDIT)
      for (const p of pairs.filter((p) => p.r < p.need)) {
        fail(`partition grid ${p.r.toFixed(2)}:1 (needs ${p.need}) — ${JSON.stringify(p.text)}`)
      }
      for (const n of noise) fail(`partition grid ${n}`)
      if (failures === before) {
        console.log(`  ok   ${'partition grid'.padEnd(22)} the empty answer: ${why.slice(0, 60)}`)
      }
      await page.close()
      return
    }

    const cells = await page.locator('.pmark').count()
    if (cells === 0) fail('partition grid: the table rendered with no cells')

    // Every metric, because a fault in one is invisible behind the default.
    for (const metric of ['Rows', 'Parts', 'On disk']) {
      await schema.getByRole('button', { name: metric, exact: true }).click()
      await page.waitForTimeout(250)
      if (!(await page.locator('.ptime__table').count())) {
        fail(`partition grid: switching to ${metric} emptied the grid`)
      }
    }

    /* And every scale, where the parts carry a date. Each one is a different
       query, and the columns have to come back named in that scale's own terms —
       a grid of months whose header still reads `202605` is a grid that ignored
       the control. */
    if (await schema.getByRole('button', { name: 'Months', exact: true }).count()) {
      for (const [grain, shape] of [
        ['Months', /^\d{4}-\d{2}$/],
        ['Weeks', /^\d{4}-\d{2}-\d{2}$/],
        ['Days', /^\d{4}-\d{2}-\d{2}$/],
        ['Quarters', /^\d{4}-Q[1-4]$/],
        ['Years', /^\d{4}$/],
      ]) {
        await schema.getByRole('button', { name: grain, exact: true }).click()
        await page.waitForSelector('.ptime__table', { timeout: 15_000 })
        await page.waitForTimeout(500)
        /* Asserted on the column's `title`, which carries the bucket as the
           server named it. The visible label is deliberately shorter than that
           on a daily axis — ten characters do not fit a cell — and testing the
           visible one made this check fail the day that shortening arrived,
           for a change that was correct. The contract here is the server's
           spelling; how much of it is drawn is the layout's business. */
        const names = await page.locator('.ptime__col').evaluateAll((els) =>
          els.map((e) => e.getAttribute('title') ?? ''),
        )
        const cols = names.filter((c) => !c.startsWith('undated') && !c.startsWith('tuple()'))
        if (cols.length === 0) fail(`partition grid: ${grain} drew no dated column`)
        // At its widest — a daily axis is thousands of pixels — which is where
        // the frame either holds or hands the page a sideways scrollbar.
        await framed(page, `partition grid at ${grain}`)
        const wrong = cols.filter((c) => !shape.test(c))
        if (wrong.length) {
          fail(`partition grid: ${grain} named a column ${JSON.stringify(wrong[0])}`)
        }
        /* And the shortening itself, which only a browser can answer. On a daily
           axis a ten-character head is clipped to `2026-0…` in a cell's width,
           so every date column is drawn as `MM-DD` and the year moves to the
           line above the grid, which has room for it. Both halves are asserted:
           a header that grew its year back would be unreadable, and a line that
           lost the range would leave the year nowhere at all. */
        if (grain === 'Days' || grain === 'Weeks') {
          const shown = await page.locator('.ptime__collabel').allTextContents()
          const dates = shown.filter((c) => /\d/.test(c) && c !== 'undated')
          const long = dates.filter((c) => !/^\d{2}-\d{2}$/.test(c))
          if (long.length) {
            fail(`partition grid: ${grain} drew a column head as ${JSON.stringify(long[0])}`)
          }
          const line = (await page.locator('.ptime__text').textContent()) ?? ''
          if (!/\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}/.test(line)) {
            fail(`partition grid: ${grain} says no range above the grid, so the year is nowhere`)
          }
        }
      }
      await schema.getByRole('button', { name: 'Partitions', exact: true }).click()
      await page.waitForTimeout(500)
    }

    /* The row's sparkline, and the property it was moved for: it shares the line
       with the row's figures rather than taking one of its own, because this
       grid's whole argument is density. A change that gives it back its own line
       shows up here as a taller header and nowhere else. */
    const shape = await page.evaluate(() => {
      const head = document.querySelector('.ptime__row')
      const spark = document.querySelector('.ptime__spark')
      if (!head) return null
      const h = head.getBoundingClientRect()
      const s = spark?.getBoundingClientRect()
      return {
        header: Math.round(h.height),
        spills: s ? Math.round(s.right - h.right) : 0,
      }
    })
    if (shape && shape.header > 60) {
      fail(`partition grid: a row header is ${shape.header}px tall, so the grid has lost its density`)
    }
    if (shape && shape.spills > 1) {
      fail(`partition grid: the sparkline hangs ${shape.spills}px past its header`)
    }

    await framed(page, 'partition grid')

    const pairs = await page.evaluate(AUDIT)
    for (const p of pairs.filter((p) => p.r < p.need)) {
      fail(`partition grid ${p.r.toFixed(2)}:1 (needs ${p.need}) — ${JSON.stringify(p.text)} .${p.cls}`)
    }
    for (const n of noise) fail(`partition grid ${n}`)
    if (failures === before) {
      console.log(`  ok   ${'partition grid'.padEnd(22)} ${cells} cells, ${pairs.length} text pairs`)
    }
  } catch (e) {
    fail(`partition grid: ${String(e).split('\n')[0]}`)
  }
  await page.close()
}

/** The mass map, which is the other mode of the same section. Its own check
 *  because it is laid out against a *measured* frame: every defect this file
 *  exists to catch — a canvas collapsed to zero height, a diagram fitted to a
 *  stale size — is a measurement bug, and none of them is visible to tsc. */
async function massMap(browser, colorScheme) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme })
  const noise = []
  page.on('pageerror', (e) => noise.push(`threw: ${String(e).slice(0, 120)}`))
  page.on('console', (m) => consoleNoise(m) && noise.push(`console: ${m.text().slice(0, 120)}`))
  const before = failures
  try {
    const dbs = await (await fetch(`${BASE}/api/databases`)).json()
    const internal = new Set(['INFORMATION_SCHEMA', 'information_schema'])
    const db = (Array.isArray(dbs) ? dbs : []).find((d) => !internal.has(d.name) && d.bytes > 0)
    if (!db) {
      console.log(`  --   ${'mass map'.padEnd(22)} no database holding any disk`)
      await page.close()
      return
    }

    await page.goto(`${BASE}/db/${encodeURIComponent(db.name)}`, { waitUntil: 'networkidle' })
    await page.locator('.schema').getByRole('button', { name: 'Mass' }).click()
    await page.waitForSelector('.mblock', { timeout: 20_000 })
    await page.waitForTimeout(800)

    const blocks = await page.locator('.mblock').count()
    if (blocks === 0) fail('mass map: the frame rendered with no blocks')

    /* Each block is a button, and a button is announced by its contents — which
       here are its columns. The first block on a real database announced itself
       as "temperaturepayloadtagslatency_ms…" with the table's own name last,
       until an explicit label replaced it. Nothing but a browser reports what a
       control is actually called. */
    const named = await page.locator('.mblock').evaluateAll((els) =>
      els.map((el) => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim()),
    )
    const wrong = named.filter((n) => !/, \d/.test(n))
    if (wrong.length) {
      fail(`mass map: a block is announced as ${JSON.stringify(wrong[0].slice(0, 40))}`)
    }

    // Laid out against a measured frame, so the two ways that goes wrong are
    // worth asserting outright rather than inferring from a screenshot.
    const box = await page.locator('.mass__frame').boundingBox()
    if (!box || box.height < 100) fail(`mass map: the frame is ${box?.height ?? 0}px tall`)
    const spill = await page.evaluate(() => {
      const frame = document.querySelector('.mass__frame')
      if (!frame) return -1
      const f = frame.getBoundingClientRect()
      let worst = 0
      for (const b of document.querySelectorAll('.mblock')) {
        const r = b.getBoundingClientRect()
        worst = Math.max(worst, r.right - f.right, r.bottom - f.bottom)
      }
      return worst
    })
    if (spill > 1) fail(`mass map: a block hangs ${Math.round(spill)}px outside the frame`)

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    if (overflow > 1) fail(`mass map: the page scrolls ${overflow}px sideways`)

    const pairs = await page.evaluate(AUDIT)
    for (const p of pairs.filter((p) => p.r < p.need)) {
      fail(`mass map ${p.r.toFixed(2)}:1 (needs ${p.need}) — ${JSON.stringify(p.text)} .${p.cls}`)
    }
    for (const n of noise) fail(`mass map ${n}`)
    if (failures === before) {
      console.log(`  ok   ${'mass map'.padEnd(22)} ${blocks} blocks, ${pairs.length} text pairs`)
    }
  } catch (e) {
    fail(`mass map: ${String(e).split('\n')[0]}`)
  }
  await page.close()
}

/** The co-access matrix, the fourth reading of the same section. Reached by
 *  nothing above, and the only one of the four that can be legitimately empty —
 *  a server whose query log is off, or a database nobody has joined across —
 *  so an empty state here is checked as a rendered answer rather than treated
 *  as a failure. */
async function together(browser, colorScheme) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme })
  const noise = []
  page.on('pageerror', (e) => noise.push(`threw: ${String(e).slice(0, 120)}`))
  page.on('console', (m) => consoleNoise(m) && noise.push(`console: ${m.text().slice(0, 120)}`))
  const before = failures
  try {
    const dbs = await (await fetch(`${BASE}/api/databases`)).json()
    const internal = new Set(['system', 'INFORMATION_SCHEMA', 'information_schema'])
    const db = (Array.isArray(dbs) ? dbs : []).find((d) => !internal.has(d.name) && d.tables > 0)
    if (!db) {
      console.log(`  --   ${'co-access matrix'.padEnd(22)} no user database to read`)
      await page.close()
      return
    }

    await page.goto(`${BASE}/db/${encodeURIComponent(db.name)}`, { waitUntil: 'networkidle' })
    await page.locator('.schema').getByRole('button', { name: 'Together' }).click()
    await page.waitForSelector('.paff__table, .note', { timeout: 20_000 })
    await page.waitForTimeout(600)

    const drawn = await page.locator('.paff__table').count()
    const cells = await page.locator('.amark').count()
    if (drawn && cells === 0) fail('co-access matrix: the table rendered with no cells')

    /* Every window, because each is a different query and a fault in one hides
       behind the default. The sentence above the matrix has to name the window it
       actually answered — a control that changed the count but not the words
       would leave the reader sure they were looking at a week. */
    const schema = page.locator('.schema')
    for (const [label, said] of [
      ['Today', /over 1 day\b/],
      ['A month', /over 30 days\b/],
      ['A week', /over 7 days\b/],
    ]) {
      if (!(await schema.getByRole('button', { name: label, exact: true }).count())) continue
      await schema.getByRole('button', { name: label, exact: true }).click()
      await page.waitForTimeout(700)
      const line = (await page.locator('.paff__text, .note').first().textContent()) ?? ''
      if (!said.test(line)) {
        fail(`co-access matrix: ${label} says ${JSON.stringify(line.slice(0, 60))}`)
      }
    }

    await framed(page, 'co-access matrix')

    const pairs = await page.evaluate(AUDIT)
    for (const p of pairs.filter((p) => p.r < p.need)) {
      fail(`co-access ${p.r.toFixed(2)}:1 (needs ${p.need}) — ${JSON.stringify(p.text)} .${p.cls}`)
    }
    for (const n of noise) fail(`co-access matrix ${n}`)
    if (failures === before) {
      const what = drawn ? `${cells} cells` : 'the empty answer'
      console.log(`  ok   ${'co-access matrix'.padEnd(22)} ${what}, ${pairs.length} text pairs`)
    }
  } catch (e) {
    fail(`co-access matrix: ${String(e).split('\n')[0]}`)
  }
  await page.close()
}

/** A dashboard-wide range, and the one thing that makes it trustworthy.
 *
 *  The range reaches a tile only if that tile's statement declares `{from:...}`
 *  — a convention, because the alternative is Flint parsing somebody's SQL to
 *  find a time column and inject a `WHERE`, which this codebase refuses to do
 *  and which would be wrong on the first statement with a subquery in it.
 *
 *  Which means a range can silently reach half a dashboard. So what is checked
 *  here is not that the control works but that the page **says** how far it
 *  reaches, and that the tiles which follow it actually re-ask when it moves. */
async function dashboardRange(browser, colorScheme) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 }, colorScheme })
  const before = failures
  const asked = []
  page.on('request', (r) => {
    if (r.url().includes('/api/query')) {
      const body = r.postData() ?? ''
      if (body.includes('"params"')) asked.push(body)
    }
  })
  try {
    const list = await (await fetch(`${BASE}/api/dashboards`)).json()
    const boards = Array.isArray(list) ? list : []
    if (!boards.length) {
      console.log(`  --   ${'a dashboard range'.padEnd(22)} no dashboard to open`)
      await page.close()
      return
    }
    let seen = null
    for (const board of boards) {
      await page.goto(`${BASE}/dash/${encodeURIComponent(board.id)}`, { waitUntil: 'networkidle' })
      await page.waitForSelector('.dashgrid, .note', { timeout: 25_000 })
      if (await page.locator('.dashgrid').count()) {
        seen = board
        break
      }
    }
    if (!seen) {
      console.log(`  --   ${'a dashboard range'.padEnd(22)} no dashboard with tiles`)
      await page.close()
      return
    }
    await page.waitForTimeout(1500)

    const picker = page.locator('.picker select').first()
    if (!(await picker.count())) {
      fail('a dashboard range: no range control')
      await page.close()
      return
    }

    await picker.selectOption('720')
    await page.waitForTimeout(2500)

    /* Whatever the range is set to, the page says how far it reaches — or says
       nothing at all, which is only correct when no tile is under a range. */
    const note = await page.locator('.dashgrid__range').count()
    const tiles = await page.locator('.dashgrid > *').count()
    if (tiles > 0 && note === 0) {
      fail('a dashboard range: a range is set and the page does not say what it reaches')
    }
    if (note) {
      const said = ((await page.locator('.dashgrid__range').textContent()) ?? '').trim()
      if (!/\d/.test(said)) fail(`a dashboard range: the note counts nothing — ${JSON.stringify(said)}`)
    }

    /* Variables, where the dashboard's tiles declare any. The value of the
       warning is the whole feature: an unset parameter is not an empty tile, it
       is a raw `Substitution 'city' is not set` where a reader expected data,
       and the fix is a text box three inches up that they have no way to guess
       at. So what is checked is that the page says so. */
    const boxes = await page.locator('.vars__input').count()
    if (boxes > 0) {
      const unset = await page
        .locator('.vars__input')
        .evaluateAll((els) => els.filter((e) => !e.value).length)
      const warnings = await page.locator('.vars__issues li').count()
      if (unset > 0 && warnings === 0) {
        fail(`a dashboard range: ${unset} variables have no value and the page says nothing`)
      }
      // Each control is labelled with the name and the type the tiles declared,
      // or it is a box nobody can fill correctly.
      const named = await page.locator('.vars__name').count()
      if (named !== boxes) fail(`a dashboard range: ${boxes} variable boxes, ${named} labelled`)
    }

    /* A tile that declares the window asks with it. Nothing to check where no
       tile does — which is itself the state the note above has to describe. */
    if (asked.length) {
      const bad = asked.filter((b) => {
        try {
          const sent = JSON.parse(b)
          const p = sent.params ?? {}
          // Only a statement that declares the window is judged on it: a tile
          // carrying a variable and no `{from:…}` is right to send neither, and
          // the first version of this check called that a fault.
          if (!String(sent.sql ?? '').includes('{from:')) return Object.keys(p).length === 0
          return !p.from || !p.to || Number.isNaN(Date.parse(String(p.from).replace(' ', 'T')))
        } catch {
          return true
        }
      })
      if (bad.length) fail(`a dashboard range: ${bad.length} tiles asked with an unusable window`)
    }

    /* The wall. Two things, and the second is the one that strands somebody:
       what full screen hides, and that leaving it puts the chrome back however
       it was left — the browser owns the exit, and Escape never goes near a
       click handler. */
    const exits = page.getByRole('button', { name: 'Full screen' })
    if (await exits.count()) {
      const before = await page.locator('.picker').count()
      await exits.click()
      await page.waitForTimeout(900)
      const onWall = await page.evaluate(() => ({
        wall: Boolean(document.querySelector('.page--wall')),
        buttons: [...document.querySelectorAll('.page__titlerow .btn')].filter(
          (e) => getComputedStyle(e).display !== 'none',
        ).length,
        pickers: [...document.querySelectorAll('.picker')].filter(
          (e) => getComputedStyle(e).display !== 'none',
        ).length,
      }))
      if (!onWall.wall) fail('a dashboard range: full screen did not put the page on the wall')
      if (onWall.pickers > 0) {
        fail(`a dashboard range: ${onWall.pickers} controls survived full screen`)
      }
      // Exactly one, and it is the way out. A wall with no exit is a wall.
      if (onWall.buttons !== 1) {
        fail(`a dashboard range: ${onWall.buttons} buttons on the wall, expected only the exit`)
      }

      // However the browser leaves, the page follows it.
      await page.evaluate(() => document.exitFullscreen?.())
      await page.waitForTimeout(700)
      const back = await page.locator('.picker').count()
      if (await page.locator('.page--wall').count()) {
        fail('a dashboard range: the page stayed on the wall after the browser left full screen')
      }
      if (back !== before) fail(`a dashboard range: ${before} controls before the wall, ${back} after`)
    }

    await framed(page, 'a dashboard range')

    const pairs = await page.evaluate(AUDIT)
    for (const p of pairs.filter((p) => p.r < p.need)) {
      fail(`a dashboard range ${p.r.toFixed(2)}:1 (needs ${p.need}) — ${JSON.stringify(p.text)} .${p.cls}`)
    }
    if (failures === before) {
      console.log(
        `  ok   ${'a dashboard range'.padEnd(22)} ${seen.name}: ${tiles} tiles, ${asked.length} asked with a window, ${pairs.length} text pairs`,
      )
    }
  } catch (e) {
    fail(`a dashboard range: ${String(e).split('\n')[0]}`)
  }
  await page.close()
}

/** Two tables side by side, and the two things only a browser settles.
 *
 *  That the picker actually drives the page — the comparison lives in the URL so
 *  a link to one is sendable, and a select that changes state without changing
 *  the address breaks that quietly. And that the sentences reach the page as
 *  prose: the wording is built as plain strings with backticks around
 *  identifiers, a convention nothing renders until something does. */
async function compareTables(browser, colorScheme) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1200 }, colorScheme })
  const noise = []
  page.on('pageerror', (e) => noise.push(`threw: ${String(e).slice(0, 120)}`))
  page.on('console', (m) => consoleNoise(m) && noise.push(`console: ${m.text().slice(0, 120)}`))
  const before = failures
  try {
    /* A database with two tables in it, found rather than named. Comparing a
       table with itself is a valid answer — "identical" — but it exercises none
       of the rules, so a second table is what this needs. */
    const dbs = await (await fetch(`${BASE}/api/databases`)).json()
    const internal = new Set(['system', 'INFORMATION_SCHEMA', 'information_schema'])
    let found = null
    for (const db of (Array.isArray(dbs) ? dbs : []).filter((d) => !internal.has(d.name))) {
      const list = await (await fetch(`${BASE}/api/databases/${encodeURIComponent(db.name)}/tables`)).json()
      const tables = list?.tables ?? list ?? []
      if (tables.length >= 2) {
        found = [db.name, tables[0].name, tables[1].name]
        break
      }
    }
    if (!found) {
      console.log(`  --   ${'two tables compared'.padEnd(22)} no database with two tables`)
      await page.close()
      return
    }
    const [db, left, right] = found

    await page.goto(
      `${BASE}/db/${encodeURIComponent(db)}/${encodeURIComponent(left)}?tab=compare`,
      { waitUntil: 'networkidle' },
    )
    await page.waitForSelector('.cmp__pick', { timeout: 25_000 })
    await page.waitForTimeout(600)

    await page.selectOption('#cmp-with', right)
    await page.waitForSelector('.cmp__says', { timeout: 25_000 })
    await page.waitForTimeout(700)

    // The comparison is in the address, or it is not a link anybody can send.
    if (new URL(page.url()).searchParams.get('with') !== right) {
      fail('two tables compared: choosing a table did not change the address')
    }

    const said = ((await page.locator('.cmp__says').textContent()) ?? '').trim()
    if (said.length < 20) fail(`two tables compared: said ${JSON.stringify(said)}`)

    const body = (await page.locator('.cmp').textContent()) ?? ''
    if (body.includes('`')) {
      fail('two tables compared: backticks reached the page')
    }

    /* Every column of both tables has a row: a diff that lists only what changed
       leaves the reader to work out whether the rest was read at all. */
    const rows = await page.locator('.cmp__tbl').last().locator('tbody tr').count()
    const both = await (
      await fetch(
        `${BASE}/api/databases/${encodeURIComponent(db)}/tables/${encodeURIComponent(left)}/compare?with=${encodeURIComponent(right)}`,
      )
    ).json()
    const union = new Set([
      ...(both.left?.columns ?? []).map((c) => c.name),
      ...(both.right?.columns ?? []).map((c) => c.name),
    ]).size
    if (rows !== union) fail(`two tables compared: ${rows} rows against ${union} columns across the two`)

    await framed(page, 'two tables compared')

    const pairs = await page.evaluate(AUDIT)
    for (const p of pairs.filter((p) => p.r < p.need)) {
      fail(`two tables compared ${p.r.toFixed(2)}:1 (needs ${p.need}) — ${JSON.stringify(p.text)} .${p.cls}`)
    }
    for (const n of noise) fail(`two tables compared ${n}`)
    if (failures === before) {
      console.log(
        `  ok   ${'two tables compared'.padEnd(22)} ${db}: ${left} against ${right}, ${rows} columns, ${pairs.length} text pairs`,
      )
    }
  } catch (e) {
    fail(`two tables compared: ${String(e).split('\n')[0]}`)
  }
  await page.close()
}

/** A column's shape, opened from the profile.
 *
 *  Three things only a browser can check. That the shape is *reachable* — it
 *  hangs off a button in a table cell, which no route test exercises. That a
 *  bucket holding rows draws a bar with height, since a bar computed to 0.4% of
 *  the panel is present in the DOM and invisible on the screen. And that the
 *  sentence above it renders as prose: the wording is built as a plain string
 *  with backticks around identifiers, which is a convention nothing renders
 *  until something does, and it reached the page with its backticks showing
 *  twice before anybody looked at it rather than at the test. */
async function columnShape(browser, colorScheme) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1200 }, colorScheme })
  const noise = []
  page.on('pageerror', (e) => noise.push(`threw: ${String(e).slice(0, 120)}`))
  page.on('console', (m) => consoleNoise(m) && noise.push(`console: ${m.text().slice(0, 120)}`))
  const before = failures
  try {
    const dbs = await (await fetch(`${BASE}/api/databases`)).json()
    const internal = new Set(['system', 'INFORMATION_SCHEMA', 'information_schema'])
    let found = null
    for (const db of (Array.isArray(dbs) ? dbs : []).filter((d) => !internal.has(d.name))) {
      const list = await (await fetch(`${BASE}/api/databases/${encodeURIComponent(db.name)}/tables`)).json()
      const table = (list?.tables ?? list ?? []).find((t) => (t.rows ?? t.total_rows ?? 0) > 1000)
      if (table) {
        found = [db.name, table.name]
        break
      }
    }
    if (!found) {
      console.log(`  --   ${"a column's shape".padEnd(22)} no table with rows to read`)
      await page.close()
      return
    }
    const [db, table] = found

    await page.goto(
      `${BASE}/db/${encodeURIComponent(db)}/${encodeURIComponent(table)}?tab=profile`,
      { waitUntil: 'networkidle' },
    )
    await page.waitForSelector('.tbl__note', { timeout: 30_000 })
    await page.waitForTimeout(1200)

    const opener = page.locator('.dist__open').first()
    if (!(await opener.count())) {
      fail("a column's shape: no column opens one")
      await page.close()
      return
    }
    const column = ((await opener.textContent()) ?? '').trim()
    await opener.click()
    await page.waitForSelector('.dist__says', { timeout: 30_000 })
    await page.waitForTimeout(700)

    if ((await opener.getAttribute('aria-expanded')) !== 'true') {
      fail("a column's shape: the button does not announce that it opened")
    }

    const said = ((await page.locator('.dist__says').first().textContent()) ?? '').trim()
    if (said.length < 12) fail(`a column's shape: ${db}.${table}.${column} said ${JSON.stringify(said)}`)
    if (said.includes('`')) {
      fail(`a column's shape: backticks reached the page — ${JSON.stringify(said.slice(0, 60))}`)
    }

    /* Every bar with rows behind it has height on the screen. A bucket holding
       0.4% of the tallest is in the DOM either way; only a rendered box says
       whether anybody can see it. */
    const bars = await page.locator('.dist__bar').count()
    if (bars > 0) {
      const invisible = await page.locator('.dist__fill').evaluateAll((els) =>
        els.filter((e) => {
          const title = e.getAttribute('title') ?? ''
          const rows = Number((title.split(':')[1] ?? '0').replace(/[^0-9]/g, ''))
          return rows > 0 && e.getBoundingClientRect().height < 1
        }).length,
      )
      if (invisible > 0) fail(`a column's shape: ${invisible} bars hold rows and draw nothing`)
    }

    await framed(page, "a column's shape")

    const pairs = await page.evaluate(AUDIT)
    for (const p of pairs.filter((p) => p.r < p.need)) {
      fail(`a column's shape ${p.r.toFixed(2)}:1 (needs ${p.need}) — ${JSON.stringify(p.text)} .${p.cls}`)
    }
    for (const n of noise) fail(`a column's shape ${n}`)
    if (failures === before) {
      console.log(
        `  ok   ${"a column's shape".padEnd(22)} ${db}.${table}.${column}: ${bars} buckets, ${pairs.length} text pairs`,
      )
    }
  } catch (e) {
    fail(`a column's shape: ${String(e).split('\n')[0]}`)
  }
  await page.close()
}

/** A table read over time, and the three answers it has to be able to give.
 *
 *  The findings are maths and are tested as maths. What only a browser can say
 *  is whether the tab is *reachable* — this one and its sibling were both
 *  addressable by URL and missing from the tab strip, which no unit test and no
 *  route test can see — and whether a sparkline drawn from a series with holes
 *  in it renders anything at all. */
async function overTime(browser, colorScheme) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 }, colorScheme })
  const noise = []
  page.on('pageerror', (e) => noise.push(`threw: ${String(e).slice(0, 120)}`))
  page.on('console', (m) => consoleNoise(m) && noise.push(`console: ${m.text().slice(0, 120)}`))
  const before = failures
  try {
    /* A table with a date column and rows in it, found rather than named: this
       check has to run against whatever server the repo is pointed at. */
    const dbs = await (await fetch(`${BASE}/api/databases`)).json()
    const internal = new Set(['system', 'INFORMATION_SCHEMA', 'information_schema'])
    let found = null
    for (const db of (Array.isArray(dbs) ? dbs : []).filter((d) => !internal.has(d.name))) {
      const list = await (await fetch(`${BASE}/api/databases/${encodeURIComponent(db.name)}/tables`)).json()
      const table = (list?.tables ?? list ?? []).find((t) => (t.rows ?? t.total_rows ?? 0) > 1000)
      if (table) {
        found = [db.name, table.name]
        break
      }
    }
    if (!found) {
      console.log(`  --   ${'a table over time'.padEnd(22)} no table with rows to read`)
      await page.close()
      return
    }
    const [db, table] = found

    await page.goto(`${BASE}/db/${encodeURIComponent(db)}/${encodeURIComponent(table)}`, {
      waitUntil: 'networkidle',
    })
    await page.waitForSelector('[role="tab"]', { timeout: 20_000 })

    // Reachable by hand, not only by address.
    const named = await page.getByRole('tab', { name: 'Over time' }).count()
    if (named === 0) {
      fail('a table over time: the tab is not in the tab strip')
      await page.close()
      return
    }
    await page.getByRole('tab', { name: 'Over time' }).click()
    await page.waitForTimeout(500)

    // Read on consent, like the relations tab: this reads every row once.
    const ask = page.getByRole('button', { name: /Read it over time/ })
    if (!(await ask.count())) fail('a table over time: no consent before a full scan')
    await ask.click()
    await page.waitForSelector('.drift__row, .note', { timeout: 40_000 })
    await page.waitForTimeout(800)

    const said = ((await page.locator('.rel__span, .note').first().textContent()) ?? '').trim()
    if (said.length < 20) fail(`a table over time: ${db}.${table} said ${JSON.stringify(said)}`)

    /* Every spark drawn has something in it. A series with holes is the whole
       reason this draws segments rather than one polyline, and an empty box is
       how that goes wrong — invisibly, and only in a browser. */
    const blank = await page
      .locator('.drift__spark')
      .evaluateAll((els) => els.filter((e) => e.querySelectorAll('polyline, circle').length === 0).length)
    if (blank > 0) fail(`a table over time: ${blank} sparklines rendered empty`)

    // And the peak beside each, because the scale is per row and nothing else
    // on the page says what it is.
    const sparks = await page.locator('.drift__spark').count()
    const peaks = await page.locator('.drift__peak').count()
    if (sparks !== peaks) fail(`a table over time: ${sparks} sparks against ${peaks} peaks`)

    await framed(page, 'a table over time')

    const pairs = await page.evaluate(AUDIT)
    for (const p of pairs.filter((p) => p.r < p.need)) {
      fail(`a table over time ${p.r.toFixed(2)}:1 (needs ${p.need}) — ${JSON.stringify(p.text)} .${p.cls}`)
    }
    for (const n of noise) fail(`a table over time ${n}`)
    if (failures === before) {
      const findings = await page.locator('.drift__finding').count()
      console.log(
        `  ok   ${'a table over time'.padEnd(22)} ${db}.${table}: ${sparks} shapes, ${findings} findings, ${pairs.length} text pairs`,
      )
    }
  } catch (e) {
    fail(`a table over time: ${String(e).split('\n')[0]}`)
  }
  await page.close()
}

/** "On this page", and the one property that makes it worth having: that it
 *  names every section the page shows, in the order it shows them.
 *
 *  The index is read from the rendered page, so it cannot drift by construction
 *  — but "by construction" is a claim about a selector, and a selector is a
 *  guess about markup somebody else will change. Health's sections are built
 *  eleven different ways already; the twelfth will be built a twelfth way. This
 *  is the check that notices. */
async function onThisPage(browser, colorScheme) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme })
  const before = failures
  const seen = []
  try {
    for (const path of ['/infra/health', '/diagnose']) {
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
      await page.waitForSelector('.page--diagnose', { timeout: 20_000 })
      // Sections load independently; the index fills in as they arrive.
      await page.waitForTimeout(4000)

      const { listed, headings } = await page.evaluate(() => ({
        listed: [...document.querySelectorAll('.onpage__link')].map((a) => a.textContent.trim()),
        headings: [...document.querySelectorAll('.page--diagnose section h2')].map((h) =>
          h.textContent.trim(),
        ),
      }))

      if (headings.length >= 3 && listed.length === 0) {
        fail(`${path}: ${headings.length} sections and no index`)
        continue
      }
      if (JSON.stringify(listed) !== JSON.stringify(headings)) {
        fail(
          `${path}: the index lists ${listed.length} of ${headings.length} sections` +
            ` — missing ${JSON.stringify(headings.filter((h) => !listed.includes(h)).slice(0, 4))}`,
        )
        continue
      }

      /* And every entry reaches something. An anchor that scrolls nowhere is
         worse than no anchor: it reads as a broken page rather than as a page
         with nothing there. */
      const reachable = await page.evaluate(() =>
        [...document.querySelectorAll('.onpage__link')]
          .map((a) => a.getAttribute('href') ?? '')
          .filter((h) => !h.startsWith('#') || !document.getElementById(h.slice(1))).length,
      )
      if (reachable > 0) fail(`${path}: ${reachable} index entries point at nothing`)
      seen.push(`${path}:${listed.length}`)
    }
    if (failures === before) {
      console.log(`  ok   ${'on this page'.padEnd(22)} ${seen.join('  ')}`)
    }
  } catch (e) {
    fail(`on this page: ${String(e).split('\n')[0]}`)
  }
  await page.close()
}

/** One spark per view.
 *
 *  The palette Flint is drawn to spends the accent once per page, on the thing
 *  you are being asked to do. Nothing in `tsc` or Vitest can see that rule: it
 *  is not a property of any one rule in the stylesheet but of how many of them
 *  happen to light up together on a rendered page, and it decays one innocent
 *  commit at a time — a nav pill here, a headline figure there, each defensible
 *  alone. Counted here at rest, with no pointer and no focus, because the rule
 *  is about what the eye lands on when the page is still.
 *
 *  Two exemptions, both deliberate. The wordmark and its bolt are the brand
 *  mark rather than an affordance — the palette's own lockups draw them in the
 *  accent. And the skip link is painted but off-screen until it is focused. */
async function sparks(browser, colorScheme) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme })
  const before = failures
  const seen = []
  try {
    for (const path of [
      '/',
      '/alerts',
      '/query',
      '/infra',
      '/infra/health',
      '/infra/pipelines',
      '/infra/cluster',
      '/infra/schema',
      '/dash',
      '/apis',
      '/reports',
      '/diagnose',
    ]) {
      await page.goto(BASE + path, { waitUntil: 'networkidle' })
      await page.waitForTimeout(1800)
      const lit = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement)
        const want = root.getPropertyValue('--spark').trim().toLowerCase()
        const hex = (c) => {
          const m = c.match(/\d+/g)
          return m ? `#${m.slice(0, 3).map((n) => (+n).toString(16).padStart(2, '0')).join('')}` : c
        }
        const out = []
        for (const e of document.querySelectorAll('body *')) {
          const cls = typeof e.className === 'string' ? e.className : ''
          // The brand mark and the skip link, exempt above.
          if (/chrome__brand|chrome__mark|\bskip\b/.test(cls)) continue
          if (e.closest('.chrome__brand')) continue
          const s = getComputedStyle(e)
          if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') continue
          const r = e.getBoundingClientRect()
          if (r.width === 0 || r.height === 0) continue
          const painted =
            (hex(s.color) === want && e.textContent.trim()) ||
            hex(s.backgroundColor) === want ||
            (hex(s.borderBottomColor) === want && parseFloat(s.borderBottomWidth) > 0) ||
            hex(s.fill) === want
          if (painted) out.push(cls.split(' ')[0] || e.tagName.toLowerCase())
        }
        return out
      })
      seen.push(`${path}:${lit.length}`)
      if (lit.length > 1) {
        fail(`${path} lights the accent ${lit.length} times at rest — ${lit.join(', ')}`)
      }
    }
    if (failures === before) {
      console.log(`  ok   ${'one spark per view'.padEnd(22)} ${seen.join('  ')}`)
    }
  } catch (e) {
    fail(`sparks: ${String(e).split('\n')[0]}`)
  }
  await page.close()
}

/** The alerts rail, and the one thing about it no unit test can see: that the
 *  count it prints and the list the page draws are the same list.
 *
 *  `selected()` and `counts()` are tested in Vitest against the same array. What
 *  cannot be tested there is that the *page* and the *rail* read the same array
 *  at all — they are two components, each fetching for itself, each applying the
 *  space rule on its own. A rail claiming six beside a list of two is the failure
 *  this pairing exists to prevent, and it only exists once both are mounted. */
async function alertsRail(browser, colorScheme) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme })
  const noise = []
  page.on('pageerror', (e) => noise.push(`threw: ${String(e).slice(0, 120)}`))
  page.on('console', (m) => consoleNoise(m) && noise.push(`console: ${m.text().slice(0, 120)}`))
  const before = failures
  try {
    const res = await fetch(`${BASE}/api/alerts`)
    if (!res.ok) {
      // No workspace is a deployment's decision, not a fault: without one Flint
      // has nowhere to keep an alert, and the page says so itself.
      console.log(`  --   ${'alerts rail'.padEnd(22)} no workspace, so no alerts to rail`)
      await page.close()
      return
    }

    await page.goto(`${BASE}/alerts`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.railset__row, .note', { timeout: 20_000 })
    await page.waitForTimeout(600)

    const rows = await page.locator('.railset__row').count()
    if (rows === 0) {
      console.log(`  --   ${'alerts rail'.padEnd(22)} no alerts defined`)
      await page.close()
      return
    }

    /* Read every row's claim, then hold each one to it. "Everything" is the
       total and the rest must add up to it — a filter nobody can reach, or one
       that counts rows it does not select, is invisible to `tsc`. */
    const claims = await page.locator('.railset__row').evaluateAll((els) =>
      els.map((e) => ({
        name: e.querySelector('.railset__name')?.textContent?.trim() ?? '',
        n: Number(e.querySelector('.railset__count')?.textContent?.trim() ?? -1),
        all: e.classList.contains('railset__row--all'),
      })),
    )
    const total = claims.find((c) => c.all)?.n ?? -1
    const parts = claims.filter((c) => !c.all)
    const summed = parts.reduce((a, c) => a + c.n, 0)
    if (summed !== total) {
      fail(`alerts rail: the states count ${summed} against ${total} in all`)
    }

    for (const part of parts) {
      await page.getByRole('button', { name: new RegExp(`^${part.name}\\s`) }).click()
      await page.waitForTimeout(400)
      const drawn = await page.locator('.alist > li').count()
      if (drawn !== part.n) {
        fail(`alerts rail: ${JSON.stringify(part.name)} counts ${part.n}, the page draws ${drawn}`)
      }
      // A fold that does not state its own size reads as the whole list.
      const said = (await page.locator('.diag__quiet, .empty__title').allTextContents()).join(' ')
      if (!said.includes(String(total))) {
        fail(`alerts rail: filtered to ${JSON.stringify(part.name)} without saying it held ${total}`)
      }
      if (!new URL(page.url()).searchParams.get('state')) {
        fail(`alerts rail: ${JSON.stringify(part.name)} filtered without saying so in the URL`)
      }
    }

    await framed(page, 'alerts rail')

    const pairs = await page.evaluate(AUDIT)
    for (const p of pairs.filter((p) => p.r < p.need)) {
      fail(`alerts rail ${p.r.toFixed(2)}:1 (needs ${p.need}) — ${JSON.stringify(p.text)} .${p.cls}`)
    }
    for (const n of noise) fail(`alerts rail ${n}`)
    if (failures === before) {
      console.log(
        `  ok   ${'alerts rail'.padEnd(22)} ${total} alerts across ${parts.length} states, ${pairs.length} text pairs`,
      )
    }
  } catch (e) {
    fail(`alerts rail: ${String(e).split('\n')[0]}`)
  }
  await page.close()
}

/** The Infrastructure board: one row per section, and never a green row for a
 *  section it could not read.
 *
 *  The count is the point. The page shipped with five rows against eight
 *  sections, which reads as though three of them do not exist — and no unit test
 *  can see the mismatch, because the nav and the board are only assembled
 *  together in a browser. */
/** The band each board opens with: what changed since you last looked.
 *
 *  Worth its own check rather than riding on the `/home` page walk, because the
 *  one way this feature fails is the one a page audit cannot see. Every sentence
 *  it prints is generated from measurements — a figure, a multiplier, a table
 *  name — so a row that renders perfectly and says "took 1.0× the rows it
 *  usually takes" is a clean page and a broken feature. What is checked here is
 *  that every row is a sentence with a subject and somewhere to go, and that the
 *  three columns still hold their figures on one line.
 */
async function newsBand(browser, colorScheme) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme })
  const noise = []
  page.on('pageerror', (e) => noise.push(`threw: ${String(e).slice(0, 120)}`))
  page.on('console', (m) => consoleNoise(m) && noise.push(`console: ${m.text().slice(0, 120)}`))
  const before = failures
  try {
    await page.goto(`${BASE}/home`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.news', { timeout: 20_000 })
    // The report reads six periods of the query log, which is the slowest read
    // on the page by a distance.
    await page.waitForSelector('.news__list, .news__quiet', { timeout: 30_000 })

    const rows = await page.locator('.news__row').count()
    const quiet = await page.locator('.news__quiet').count()
    /* One or the other, never neither: a band that has rendered its heading and
       nothing under it has told the reader that nothing changed without ever
       saying so — which is the failure this whole feature exists to remove. */
    if (rows === 0 && quiet === 0) fail('news: the band says neither a headline nor why not')

    const says = await page.locator('.news__says').allTextContents()
    const mute = says.filter((t) => t.trim().length < 12)
    if (mute.length) fail(`news: ${mute.length} row(s) say nothing`)

    /* A multiplier that rounds to one is a sentence contradicting itself. */
    for (const t of says) {
      if (/\b1\.0×/.test(t)) fail(`news: a row says it moved 1.0× — ${JSON.stringify(t)}`)
    }

    const hrefs = await page
      .locator('.news__subject')
      .evaluateAll((els) => els.map((e) => e.getAttribute('href')))
    for (const href of hrefs) {
      if (!href || href === '/') fail(`news: a headline leads nowhere (${String(href)})`)
    }

    /* Three columns on one line, or the measurement has broken across two and
       reads as two measurements. Checked at the width the band is designed for
       rather than at the breakpoint, where it is meant to stack. */
    const wrapped = await page.locator('.news__figure').evaluateAll((els) =>
      els.filter((e) => e.getClientRects().length > 1).length,
    )
    if (wrapped) fail(`news: ${wrapped} figure(s) wrapped onto a second line`)

    const overflow = await page.evaluate(() => {
      const list = document.querySelector('.news__list')
      return list ? list.scrollWidth - list.clientWidth : 0
    })
    if (overflow > 1) fail(`news: the list scrolls ${overflow}px sideways`)

    const pairs = await page.evaluate(AUDIT)
    for (const p of pairs.filter((p) => p.r < p.need)) {
      fail(`news ${p.r.toFixed(2)}:1 (needs ${p.need}) — ${JSON.stringify(p.text)} .${p.cls}`)
    }
    for (const n of noise) fail(`news ${n}`)
    if (failures === before) {
      console.log(
        `  ok   ${'what changed'.padEnd(22)} ${rows ? `${rows} headline(s)` : 'quiet'}, ${pairs.length} text pairs`,
      )
    }
  } finally {
    await page.close()
  }
}

async function board(browser, colorScheme) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme })
  const noise = []
  page.on('pageerror', (e) => noise.push(`threw: ${String(e).slice(0, 120)}`))
  page.on('console', (m) => consoleNoise(m) && noise.push(`console: ${m.text().slice(0, 120)}`))
  const before = failures
  try {
    await page.goto(`${BASE}/infra`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.board', { timeout: 20_000 })
    // Long enough for a row whose request is retrying to settle: a row stuck on
    // "reading" is the one state that must not be mistaken for either answer.
    await page.waitForTimeout(9000)

    const rows = await page.locator('.board__row').count()
    const sections = await page
      .locator('nav a[href^="/infra/"]')
      .evaluateAll((els) => new Set(els.map((e) => e.getAttribute('href'))).size)
    if (sections > 0 && rows !== sections) {
      fail(`board: ${rows} rows against ${sections} sections in the nav`)
    }

    const still = await page.locator('.board__row--reading').count()
    if (still > 0) fail(`board: ${still} rows still reading after nine seconds`)

    /* Every row says something, and a row that could not be read carries the
       reason rather than a shrug. */
    const said = await page.locator('.board__says').allTextContents()
    const mute = said.filter((t) => t.trim().length < 4)
    if (mute.length) fail(`board: ${mute.length} rows say nothing`)

    const pairs = await page.evaluate(AUDIT)
    for (const p of pairs.filter((p) => p.r < p.need)) {
      fail(`board ${p.r.toFixed(2)}:1 (needs ${p.need}) — ${JSON.stringify(p.text)} .${p.cls}`)
    }
    for (const n of noise) fail(`board ${n}`)
    if (failures === before) {
      const blind = await page.locator('.board__row--unknown').count()
      console.log(
        `  ok   ${'infrastructure board'.padEnd(22)} ${rows} rows${blind ? `, ${blind} unread` : ''}, ${pairs.length} text pairs`,
      )
    }
  } catch (e) {
    fail(`board: ${String(e).split('\n')[0]}`)
  }
  await page.close()
}

/** The palette is keyboard-only, so nothing else in this file exercises it. */
/** The console, which no URL reaches.
 *
 *  It is a drawer that opens on a keystroke and every surface inside it exists
 *  only after somebody has typed something: the printed box and its rules, a
 *  NULL cell against an empty-string cell, the line that says what a result
 *  cost, a folded ClickHouse error and the grammar behind it, the console's own
 *  notes, and the chip that says which settings are being carried. None of that
 *  is on any page this file visits, so without this the newest text in the
 *  product would be the only text nothing measures.
 *
 *  It also checks the two behaviours that are the feature rather than the
 *  paint: Escape puts the drawer away and gives the focus back to the launcher
 *  it came from, and the hidden drawer is `inert` — a panel that keeps its tab
 *  stops while invisible is a keyboard trap with no way out. */
async function consoleDrawer(browser, colorScheme) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme })
  const noise = []
  page.on('pageerror', (e) => noise.push(`threw: ${String(e).slice(0, 120)}`))
  page.on('console', (m) => consoleNoise(m) && noise.push(`console: ${m.text().slice(0, 120)}`))
  const before = failures
  const run = async (sql) => {
    await page.locator('.cons__input .cm-content').click()
    await page.keyboard.type(sql)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(900)
  }

  try {
    /* Any page with the shell on it would do — the console is mounted outside
       the router. The schema is used because it is the page somebody would
       actually have open when they reach for the console. */
    await page.goto(BASE + '/explore', { waitUntil: 'networkidle' })
    await page.waitForSelector('.gnode', { timeout: 15_000 })
    await page.keyboard.press('Control+`')
    await page.waitForSelector('.cons.is-open', { timeout: 6000 })

    /* One statement that draws every kind of cell the printer knows: a number
       right-aligned, a string left-aligned, a NULL and an empty string — which
       have to stay distinguishable, because in ClickHouse they are very
       different answers. */
    await run(
      "SELECT number AS n, toString(number) AS s, if(number = 1, NULL, 'x') AS maybe, '' AS blank FROM system.numbers LIMIT 3",
    )
    if ((await page.locator('.cons__table').count()) === 0) fail('console printed no table')
    if ((await page.locator('.cons__cell.is-null').count()) === 0) fail('console printed no NULL cell')
    if ((await page.locator('.cons__cell.is-empty').count()) === 0)
      fail('console printed no empty-string cell')

    // The console's own voice, and the chip that says what it is carrying.
    await run('help')
    await run('SET max_threads = 3')
    if ((await page.locator('.cons__chip').count()) === 0)
      fail('console carried a setting without saying so on its bar')

    /* An error, folded, and then unfolded — the grammar behind the fold is its
       own colour on its own ground and has never been measured otherwise. */
    await run('SELEKT 1')
    if ((await page.locator('.cons__error').count()) === 0) fail('console swallowed an error')
    const more = page.locator('.cons__linkish').last()
    if (await more.count()) {
      await more.click()
      await page.waitForTimeout(300)
    }

    const pairs = await page.evaluate(AUDIT)
    for (const p of pairs.filter((p) => p.r < p.need)) {
      fail(`console ${p.r.toFixed(2)}:1 (needs ${p.need}) at ${p.px}px — ${JSON.stringify(p.text)} .${p.cls}`)
    }

    // Away, and the focus with it.
    await page.locator('.cons__input .cm-content').click()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    if (await page.locator('.cons.is-open').count()) fail('console did not hide on Escape')
    const after = await page.evaluate(() => ({
      focus: document.activeElement?.className ?? '',
      inert: document.getElementById('flint-console')?.inert === true,
      kept: document.querySelectorAll('#flint-console .cons__entry').length,
    }))
    if (!after.focus.includes('cfab'))
      fail(`console left the focus on ${JSON.stringify(after.focus)} rather than on its launcher`)
    if (!after.inert) fail('hidden console is still in the tab order')
    if (after.kept === 0) fail('hiding the console threw its transcript away')

    /* And at the width of a phone. The bar is a flex row of six things, and at
       420px the account and the server version pushed `Clear` and the hide
       button clean off the right edge — which left no way to put the console
       away except the keyboard. Measured rather than eyeballed, because it is
       invisible at every width this file otherwise runs at. */
    await page.keyboard.press('Control+`')
    await page.waitForSelector('.cons.is-open', { timeout: 6000 })
    await page.setViewportSize({ width: 420, height: 760 })
    await page.waitForTimeout(600)
    const narrow = await page.evaluate(() => {
      const bar = document.querySelector('.cons__bar')
      const hide = document.querySelector('.cons__act--icon')?.getBoundingClientRect()
      const root = document.documentElement
      return {
        bar: bar ? bar.scrollWidth - bar.clientWidth : -1,
        hidden: !hide || hide.width === 0 || hide.right > window.innerWidth,
        page: root.scrollWidth - root.clientWidth,
      }
    })
    if (narrow.bar > 0) fail(`console bar overflows by ${narrow.bar}px at 420px`)
    if (narrow.hidden) fail('console cannot be hidden by pointer at 420px')
    if (narrow.page > 0) fail(`console makes the page scroll sideways by ${narrow.page}px at 420px`)

    for (const n of noise) fail(`console ${n}`)
    if (failures === before) {
      console.log(
        `  ok   ${'console'.padEnd(22)} ${pairs.length} text pairs, ${after.kept} entries kept, fits 420px`,
      )
    }
  } catch (e) {
    fail(`console: ${String(e).split('\n')[0]}`)
  }
  await page.close()
}

async function palette(browser, colorScheme) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme })
  const noise = []
  page.on('pageerror', (e) => noise.push(`threw: ${String(e).slice(0, 120)}`))
  page.on('console', (m) => consoleNoise(m) && noise.push(`console: ${m.text().slice(0, 120)}`))
  try {
    await page.goto(BASE + '/explore', { waitUntil: 'networkidle' })
    await page.waitForSelector('.gnode', { timeout: 15_000 })
    await page.keyboard.press('Control+k')
    await page.waitForSelector('.pal__box', { timeout: 6000 })
    await page.keyboard.type('e')
    await page.waitForTimeout(1200)
    const hits = await page.evaluate(() => document.querySelectorAll('.pal__hit').length)
    if (hits === 0) fail('palette found nothing for a single letter')
    const pairs = await page.evaluate(AUDIT)
    for (const p of pairs.filter((p) => p.r < p.need)) {
      fail(`palette ${p.r.toFixed(2)}:1 (needs ${p.need}) — ${JSON.stringify(p.text)} .${p.cls}`)
    }
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    if (await page.locator('.pal__box').count()) fail('palette did not close on Escape')
    for (const n of noise) fail(`palette ${n}`)
    if (!failures) console.log(`  ok   ${'palette'.padEnd(22)} ${hits} hits, ${pairs.length} text pairs`)
  } catch (e) {
    fail(`palette: ${String(e).split('\n')[0]}`)
  }
  await page.close()
}
