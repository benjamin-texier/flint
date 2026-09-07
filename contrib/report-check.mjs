/** Report and alert editing in a real browser, with a workspace supplied at the
 *  HTTP boundary. No ClickHouse is needed and no report is actually saved.
 *
 *    cd frontend && pnpm dev
 *    node contrib/report-check.mjs http://localhost:5173
 *
 *  These failures depend on React preserving a mounted form's state: a pure
 *  function test cannot catch fields from one report being saved into another.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { chromium } from '../frontend/node_modules/playwright-core/index.mjs'

const base = process.argv[2] ?? 'http://localhost:5173'
const executablePath = [
  process.env.FLINT_BROWSER,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => p && existsSync(p))
assert.ok(executablePath, 'Set FLINT_BROWSER to a Chrome or Chromium binary')

const reports = [
  {
    id: 'first', name: 'Morning sales',
    spec: JSON.stringify({ sections: [{ title: 'Sales', sql: 'SELECT 1 AS sales', database: 'sales' }] }),
    schedule: JSON.stringify({ kind: 'daily', minute: 540 }),
    timezone: 'Europe/Paris', webhook: 'https://example.com/sales', enabled: true,
    created_at: '', updated_at: '', last_run: '', last_status: '', runs: 0,
  },
  {
    id: 'second', name: 'Weekly errors',
    spec: JSON.stringify({ sections: [{ title: 'Errors', sql: 'SELECT 2 AS errors', database: 'logs' }] }),
    schedule: JSON.stringify({ kind: 'weekly', dow: 5, minute: 960 }),
    timezone: 'UTC', webhook: 'https://example.com/errors', enabled: false,
    created_at: '', updated_at: '', last_run: '', last_status: '', runs: 0,
  },
]
const dashboard = {
  id: 'board', name: 'Kept dashboard', created_at: '', updated_at: '',
  spec: JSON.stringify({ tiles: [{
    id: 'tile', title: 'Total', sql: 'SELECT 3 AS total', database: 'analytics',
    chart: null, w: 6, h: 1,
  }] }),
}
const alerts = [
  {
    id: 'alert-first', name: 'Sales stopped', sql: 'SELECT 1 AS sales', database: 'sales',
    condition: JSON.stringify({ metric: 'rows', op: '<', threshold: 1 }),
    interval_seconds: 300, webhook: 'https://example.com/sales', enabled: true,
  },
  {
    id: 'alert-second', name: 'Errors rising', sql: 'SELECT 2 AS errors', database: 'logs',
    condition: JSON.stringify({ metric: 'value', op: '>=', threshold: 42 }),
    interval_seconds: 900, webhook: 'https://example.com/errors', enabled: false,
  },
].map((alert) => ({
  ...alert, created_at: '', updated_at: '', state: '', last_event: '', last_message: '',
  last_delivered: false, last_delivery_error: '', space: 'data', space_note: '',
}))

const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--disable-gpu'] })
try {
  for (const colorScheme of ['light', 'dark']) {
    const page = await browser.newPage({ colorScheme, viewport: { width: 1440, height: 1000 } })
    const errors = []
    const posted = []
    let dashboardFailure = false
    let holdDashboards = false
    let releaseDashboards
    let holdSave = false
    let releaseSave
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/api/**', async (route) => {
      const request = route.request()
      const path = new URL(request.url()).pathname.slice(4)
      let data = []
      if (path === '/config') data = {
        pinned: true, auth: false, endpoint: 'http://example.test:8123', user: 'default',
        version: 'test', default_database: 'default', workspace: 'flint', scheduled: true,
        readonly: false, tier: 'admin', infrastructure: false, query_settings: {},
        reserved_settings: [], delegatable_roles: [], alert_webhooks: true,
        max_result_rows: 10000, query_timeout_secs: 120,
      }
      if (path === '/session') data = { required: false, user: 'default', service_user: 'default' }
      if (path === '/server') data = {
        version: 'test', timezone: 'UTC', uptime_seconds: 60, current_user: 'default',
        current_database: 'default', databases: 0, tables: 0,
      }
      if (path === '/jobs') data = { available: true, jobs: [] }
      if (path === '/timezones') data = ['UTC', 'Europe/Paris']
      if (path === '/reports' || path === '/alerts') {
        if (request.method() === 'POST') {
          posted.push(request.postDataJSON())
          if (holdSave) await new Promise((resolve) => { releaseSave = resolve })
        }
        data = path === '/reports' ? reports : alerts
      }
      if (path === '/dashboards') {
        if (holdDashboards) await new Promise((resolve) => { releaseDashboards = resolve })
        if (dashboardFailure) {
          return route.fulfill({ status: 403, json: {
            error: { message: 'Dashboard access refused', kind: 'http' },
          } })
        }
        data = [dashboard, { ...dashboard, id: 'empty', spec: '{"tiles":[]}' }]
      }
      await route.fulfill({ json: data })
    })

    const form = page.locator('.page--reports .aform')
    const name = form.getByPlaceholder('Monday morning numbers')
    const edit = (title) => page.locator('.arow').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
      .getByRole('button', { name: 'Edit', exact: true })
    const waitValue = (locator, value) => locator.evaluate((el, expected) => {
      if (el.value !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(el.value)}`)
    }, value)
    const navigate = (path) => page.evaluate((to) => {
      window.history.pushState({}, '', to)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }, path)

    await page.goto(`${base}/reports`)
    await edit('Morning sales').click()
    await waitValue(name, 'Morning sales')
    await name.fill('Unsaved sales draft')
    await edit('Weekly errors').click()
    await waitValue(name, 'Weekly errors')
    await waitValue(form.locator('textarea'), 'SELECT 2 AS errors')
    await waitValue(form.getByPlaceholder('database'), 'logs')
    await waitValue(form.getByLabel(/^RUNS/), 'weekly')
    await waitValue(form.getByLabel(/^ON/), '5')
    await waitValue(form.getByLabel('AT', { exact: true }), '16:00')
    await waitValue(form.getByLabel(/^IN/), 'UTC')
    await waitValue(form.getByLabel('WEBHOOK (OPTIONAL)'), 'https://example.com/errors')
    await form.getByRole('button', { name: 'Save changes' }).click()
    await form.waitFor({ state: 'hidden' })
    assert.equal(posted.at(-1).id, 'second')
    assert.equal(posted.at(-1).name, 'Weekly errors')
    assert.equal(posted.at(-1).enabled, false)
    assert.deepEqual(JSON.parse(posted.at(-1).spec), JSON.parse(reports[1].spec))

    // Creating after editing must reset every field, including the schedule.
    await edit('Weekly errors').click()
    await page.getByRole('button', { name: 'New report', exact: true }).click()
    await waitValue(name, '')
    await waitValue(form.locator('textarea'), '')
    await waitValue(form.getByLabel(/^RUNS/), 'daily')
    await waitValue(form.getByLabel('WEBHOOK (OPTIONAL)'), '')
    await form.getByRole('button', { name: 'Cancel', exact: true }).click()

    // A save completing after another report is opened must not close its draft.
    holdSave = true
    await edit('Morning sales').click()
    await form.getByRole('button', { name: 'Save changes' }).click()
    await page.waitForFunction(() => document.querySelector('.aform button.btn--spark')?.disabled)
    await edit('Weekly errors').click()
    await name.fill('Weekly draft still being edited')
    assert.ok(releaseSave)
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/reports') && r.request().method() === 'POST')
    const refreshed = page.waitForResponse((r) => r.url().endsWith('/api/reports') && r.request().method() === 'GET')
    releaseSave()
    await saved
    await (await refreshed).finished()
    holdSave = false
    await waitValue(name, 'Weekly draft still being edited')

    // Handing over SQL while already on this route must replace the old form.
    await navigate('/reports?sql=SELECT+4&database=analytics&name=Sent+question')
    await page.waitForURL('**/reports')
    await waitValue(name, 'Sent question')
    await waitValue(form.locator('textarea'), 'SELECT 4')
    await form.getByRole('button', { name: 'Cancel', exact: true }).click()

    holdDashboards = true
    await page.goto(`${base}/reports?from_dashboard=board`)
    await page.getByText('Reading the dashboard', { exact: true }).waitFor()
    assert.equal(await form.count(), 0)
    assert.ok(releaseDashboards)
    releaseDashboards()
    holdDashboards = false
    await name.waitFor()
    await waitValue(name, 'Kept dashboard')
    await waitValue(form.locator('textarea'), 'SELECT 3 AS total')
    await page.getByRole('button', { name: 'New report', exact: true }).click()
    await waitValue(name, '')
    await name.fill('Unfinished new report')
    await page.getByRole('button', { name: 'New report', exact: true }).click()
    await waitValue(name, '')

    // Choosing to start a report while the source is loading cancels that
    // handoff; its delayed answer must not overwrite the new draft.
    holdDashboards = true
    await page.goto(`${base}/reports?from_dashboard=board`)
    await page.getByText('Reading the dashboard', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'New report', exact: true }).click()
    await name.fill('Draft while waiting')
    const loaded = page.waitForResponse('**/api/dashboards')
    releaseDashboards()
    await (await loaded).finished()
    holdDashboards = false
    await waitValue(name, 'Draft while waiting')

    await page.goto(`${base}/reports?from_dashboard=empty`)
    await page.getByText('That dashboard has no sections', { exact: true }).waitFor()
    assert.equal(await form.count(), 0)

    await page.goto(`${base}/reports?from_dashboard=missing`)
    await page.getByText('That dashboard is gone', { exact: true }).waitFor()
    assert.equal(await form.count(), 0)

    dashboardFailure = true
    await page.goto(`${base}/reports?from_dashboard=board`)
    await page.getByText('Dashboard access refused', { exact: true }).waitFor()
    assert.equal(await form.count(), 0)
    dashboardFailure = false
    await page.getByRole('button', { name: 'Try again', exact: true }).click()
    await name.waitFor()
    await waitValue(name, 'Kept dashboard')

    const alertForm = page.locator('.page--alerts .aform')
    const alertName = alertForm.getByLabel('NAME', { exact: true })
    await page.goto(`${base}/alerts`)
    await edit('Sales stopped').click()
    await alertName.fill('Unsaved sales alert')
    await edit('Errors rising').click()
    await waitValue(alertName, 'Errors rising')
    await waitValue(alertForm.locator('textarea'), 'SELECT 2 AS errors')
    await waitValue(alertForm.getByLabel('DATABASE', { exact: true }), 'logs')
    await waitValue(alertForm.getByLabel(/^NOTIFY WHEN/), 'value')
    await waitValue(alertForm.getByLabel(/^IS/), '>=')
    await waitValue(alertForm.getByLabel('THRESHOLD', { exact: true }), '42')
    await waitValue(alertForm.getByLabel(/^CHECK EVERY/), '900')
    await alertForm.getByRole('button', { name: 'Save changes' }).click()
    await alertForm.waitFor({ state: 'hidden' })
    const expectedAlert = Object.fromEntries(Object.entries(alerts[1]).filter(([key]) =>
      ['id', 'name', 'sql', 'database', 'condition', 'interval_seconds', 'webhook', 'enabled'].includes(key)))
    assert.deepEqual(posted.at(-1), expectedAlert)

    await edit('Errors rising').click()
    await page.getByRole('button', { name: 'New alert', exact: true }).click()
    await waitValue(alertName, '')
    await waitValue(alertForm.locator('textarea'), '')
    await waitValue(alertForm.getByLabel(/^NOTIFY WHEN/), 'rows')
    await waitValue(alertForm.getByLabel('THRESHOLD', { exact: true }), '0')
    await waitValue(alertForm.getByLabel(/^CHECK EVERY/), '300')

    holdSave = true
    await edit('Sales stopped').click()
    await alertForm.getByRole('button', { name: 'Save changes' }).click()
    await page.waitForFunction(() => document.querySelector('.aform button.btn--spark')?.disabled)
    await edit('Errors rising').click()
    await alertName.fill('Alert draft still being edited')
    const alertsRefreshed = page.waitForResponse((r) => r.url().endsWith('/api/alerts') && r.request().method() === 'GET')
    releaseSave()
    await (await alertsRefreshed).finished()
    holdSave = false
    await waitValue(alertName, 'Alert draft still being edited')

    // Only the handoff is consumed; the alert rail's active filter survives.
    await navigate('/alerts?sql=SELECT+5&database=analytics&name=Sent+alert&state=paused')
    await page.waitForURL('**/alerts?state=paused')
    await waitValue(alertName, 'Sent alert')
    await waitValue(alertForm.locator('textarea'), 'SELECT 5')
    await waitValue(alertForm.getByLabel('DATABASE', { exact: true }), 'analytics')
    await page.getByRole('button', { name: 'New alert', exact: true }).click()
    await waitValue(alertName, '')
    await alertName.fill('Another unfinished draft')
    await page.getByRole('button', { name: 'New alert', exact: true }).click()
    await waitValue(alertName, '')

    assert.deepEqual(errors, [], `Browser errors in ${colorScheme}`)
    await page.close()
    console.log(`${colorScheme}: report and alert identity, fresh drafts, late saves and handoffs passed`)
  }
} finally {
  await browser.close()
}
