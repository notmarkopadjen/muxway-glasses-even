// The phone pane in Chromium: the settings form, the URL rules, the refusal
// of settings from a URL on a public origin, and the reply box without the
// glasses. Env: APP_URL, HUB_URL, TOKEN, SHOTS, TRACE.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const { APP_URL, HUB_URL, TOKEN, SHOTS, TRACE } = process.env
mkdirSync(SHOTS, { recursive: true })
let step = 0
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${String(++step).padStart(2, '0')}-${name}-phone.png` })
const fail = (m) => {
  throw new Error(m)
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 420, height: 860 } })
await ctx.tracing.start({ screenshots: true, snapshots: true })
try {
  const page = await ctx.newPage()
  await page.goto(APP_URL + '/')
  await page.waitForTimeout(4500) // the bridge is waited for, then given up on
  await shot(page, 'empty')

  // URL rules: http on the internet, user info, query.
  for (const bad of ['http://hub.example.com', 'https://alice:pw@hub.example.com', 'https://hub.example.com/?x=1']) {
    await page.fill('#hub', bad)
    await page.fill('#token', TOKEN)
    await page.click('#save')
    const conn = await page.textContent('#conn')
    if (!/http only|user name|query/.test(conn)) fail(`"${bad}" was not refused: ${conn}`)
  }
  await shot(page, 'url-refused')

  // Save and test against the proxy.
  await page.fill('#hub', HUB_URL)
  await page.fill('#token', TOKEN)
  await page.click('#save')
  await page.waitForFunction(() => /hub answered/.test(document.querySelector('#conn').textContent), null, { timeout: 15000 })
  const conn = await page.textContent('#conn')
  if (conn.includes(TOKEN)) fail('the token is on the phone screen')
  if ((await page.inputValue('#token')) !== '') fail('the token stays in the field')
  if ((await page.getAttribute('#token', 'placeholder')) !== 'stored') fail('the field does not say stored')
  await shot(page, 'tested')

  // The reply box without the glasses, and the mail button the same.
  await page.fill('#reply', 'echo hi')
  await page.click('#send')
  const sent = await page.textContent('#sent')
  if (!/Even app|glasses first/.test(sent)) fail(`reply without the glasses: ${sent}`)
  await shot(page, 'reply-refused')
  await page.fill('#reply', 'a mail')
  await page.click('#mail')
  const mailed = await page.textContent('#sent')
  if (!/Even app|glasses first|holds mail first/.test(mailed)) fail(`mail without the glasses: ${mailed}`)
  const to = await page.textContent('#to')
  if (!/open a pane on the glasses first/.test(to)) fail(`the to line: ${to}`)

  // The theme: amber by default, the others applied at once and kept with save.
  const theme = () => page.evaluate(() => [document.documentElement.dataset.theme, getComputedStyle(document.body).color])
  const [t0, amber] = await theme()
  if (t0 !== 'amber') fail(`the default theme is ${t0}`)
  await shot(page, 'amber')
  await page.selectOption('#theme', 'paper')
  const [t1, paper] = await theme()
  if (t1 !== 'paper' || paper === amber) fail(`paper not applied: ${t1} ${paper}`)
  await shot(page, 'paper')
  await page.click('#save')
  await page.waitForFunction(() => /hub answered/.test(document.querySelector('#conn').textContent), null, { timeout: 15000 })
  await page.reload()
  await page.waitForTimeout(4500)
  const [t2] = await theme()
  if (t2 !== 'paper') fail(`the theme was not kept: ${t2}`)
  await page.selectOption('#theme', 'green')
  const [t3, green] = await theme()
  if (t3 !== 'green' || green === paper || green === amber) fail(`green not applied: ${t3} ${green}`)
  await shot(page, 'green')

  // Nothing of the token in the page's log or the console.
  const log = await page.textContent('#log')
  if (log.includes(TOKEN)) fail('the token is in the phone log')

  // The trace switch: off by default, kept with save. Copy: the log on the clipboard, oldest line first.
  if (await page.isChecked('#detail')) fail('trace is on by default')
  await shot(page, 'trace-off')
  await page.check('#detail')
  await page.click('#save')
  await page.waitForFunction(() => /hub answered/.test(document.querySelector('#conn').textContent), null, { timeout: 15000 })
  await page.reload()
  await page.waitForTimeout(4500)
  if (!(await page.isChecked('#detail'))) fail('trace was not kept')
  await shot(page, 'trace-on')
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP_URL })
  const rows = await page.$$eval('#log > div', (els) => els.map((e) => e.textContent))
  await page.click('#copy')
  const copied = await page.textContent('#copied')
  if (copied !== `copied ${rows.length} lines`) fail(`copy said: ${copied}`)
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  const expected = rows.slice().reverse().join('\n') + '\n'
  if (clip !== expected) fail(`the clipboard holds:\n${clip}\nnot:\n${expected}`)
  if (clip.includes(TOKEN)) fail('the token is on the clipboard')
  await shot(page, 'copied')

  // Settings in the URL on a public origin are ignored, and said so.
  await ctx.route('https://glasses.example/**', async (route) => {
    const u = new URL(route.request().url())
    const res = await ctx.request.get(APP_URL + u.pathname)
    await route.fulfill({ status: res.status(), headers: { 'content-type': res.headers()['content-type'] || 'text/html' }, body: await res.body() })
  })
  const pub = await ctx.newPage()
  await pub.goto('https://glasses.example/?hub=' + encodeURIComponent(HUB_URL) + '&token=' + 'mxt_' + 'q'.repeat(43))
  await pub.waitForTimeout(4500)
  const note = await pub.textContent('#conn')
  if (!/ignored/.test(note)) fail(`settings from a public URL were not refused: ${note}`)
  if ((await pub.inputValue('#hub')) !== '') fail('the hub was taken from a public URL')
  await shot(pub, 'public-url-refused')
  console.log('phone tests passed')
} finally {
  await ctx.tracing.stop({ path: TRACE })
  await browser.close()
}
