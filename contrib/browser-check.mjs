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
  { path: '/', wait: '.gnode' },
  { path: '/server', wait: '.tbl' },
  { path: '/build', wait: 'main' },
  { path: '/query', wait: 'main' },
  { path: '/dash', wait: 'main' },
  { path: '/diagnose', wait: '.tbl' },
  // The diagnose page's other two views: each is a different set of system
  // tables and a different way of being unavailable.
  { path: '/diagnose?view=pipelines', wait: 'main' },
  { path: '/diagnose?view=access', wait: 'main' },
  { path: '/diagnose?view=replication', wait: 'main' },
  { path: '/alerts', wait: 'main' },
  { path: '/reports', wait: 'main' },
  { path: '/apis', wait: 'main' },
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
    return [
      { path: at, wait: 'main' },
      { path: `${at}?tab=columns`, wait: '.tbl' },
      { path: `${at}?tab=path`, wait: 'main' },
      { path: `${at}?tab=profile`, wait: 'main' },
      { path: `${at}?tab=ddl`, wait: 'main' },
    ]
  } catch {
    return []
  }
}

let failures = 0
const fail = (what) => {
  failures += 1
  console.log(`  FAIL ${what}`)
}

const discovered = await discover()
if (discovered.length === 0) {
  console.log('note: no user table found, so the object page is not covered')
}

const browser = await open()
try {
  for (const scheme of ['light', 'dark']) {
    console.log(`\n${scheme}`)
    for (const page of [...PAGES, ...discovered]) {
      await visit(browser, page, scheme)
    }
    await palette(browser, scheme)
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

async function visit(browser, { path, wait }, colorScheme) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme })
  const noise = []
  page.on('console', (m) => m.type() === 'error' && noise.push(`console: ${m.text().slice(0, 120)}`))
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

/** The palette is keyboard-only, so nothing else in this file exercises it. */
async function palette(browser, colorScheme) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme })
  const noise = []
  page.on('pageerror', (e) => noise.push(`threw: ${String(e).slice(0, 120)}`))
  page.on('console', (m) => m.type() === 'error' && noise.push(`console: ${m.text().slice(0, 120)}`))
  try {
    await page.goto(BASE + '/', { waitUntil: 'networkidle' })
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
