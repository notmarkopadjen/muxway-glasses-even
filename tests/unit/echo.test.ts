// A key's echo rides on the input's answer: the app asks for the screen
// with every piece it types, draws a 200 at once and reads as before on a
// 204; rows named as another pane's are never drawn.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'
import { App } from '../../src/app.ts'
import { saveSettings } from '../../src/settings.ts'

const sys = (eventType: OsEventTypeList): EvenHubEvent => ({ sysEvent: { eventType } as never })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function fakeBridge() {
  const b = {
    cb: null as ((e: EvenHubEvent) => void) | null,
    pages: [] as unknown[],
    onEvenHubEvent(cb: (e: EvenHubEvent) => void) {
      b.cb = cb
      return () => {}
    },
    createStartUpPageContainer: async (p: unknown) => (b.pages.push(p), 0),
    rebuildPageContainer: async (p: unknown) => (b.pages.push(p), true),
    updateImageRawData: async () => 0,
    upgrades: [] as string[],
    textContainerUpgrade: async (u: { content?: string }) => (b.upgrades.push(u.content ?? ''), true),
    shutDownPageContainer: async () => true,
    setLocalStorage: async () => true,
    getLocalStorage: async () => '',
    audioControl: async () => true,
  }
  return b
}

type Mode = 'echo' | '204' | 'stranger'

/** One writable pane, %3 at work/0.0; a read gives its rows, an input answers by the mode. */
function echoingHub(mode: Mode) {
  const calls: { method: string; url: string; accept: string; body: string }[] = []
  let typed = false
  const text = (body: string, headers: Record<string, string>) =>
    new Response(body, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } })
  const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = String(url)
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ method: init?.method ?? 'GET', url: u, accept: headers.Accept ?? '', body: typeof init?.body === 'string' ? init.body : '' })
    const json = (body: string) => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (u.includes('/v1/events')) {
      if (u.includes('wait=')) await sleep(200)
      return json('{"events":[],"next":1}')
    }
    if (u.includes('/v1/hosts')) return json(JSON.stringify({ hosts: [{ name: 'alice-laptop', online: true }] }))
    if (u.includes('/input?')) {
      typed = true
      if (mode === '204') return new Response(null, { status: 204 })
      if (mode === 'stranger') return text('$ echo STRANGER-ROWS\nSTRANGER-ROWS\n$ \n', { ETag: '"s1"', 'Muxway-Pane': '%9' })
      return text('$ y\ny: command not found\n$ \n', { ETag: '"v2"', 'Muxway-Pane': '%3' })
    }
    if (u.includes('/v1/panes/alice-laptop/')) {
      const etag = typed ? '"v2"' : '"v1"'
      if (headers['If-None-Match'] === etag) return new Response(null, { status: 304, headers: { 'Muxway-Pane': '%3' } })
      return text(typed ? '$ y\nafter-the-read\n$ \n' : '$ make\nok\n$ \n', { ETag: etag, 'Muxway-Pane': '%3' })
    }
    if (u.includes('/v1/panes')) return json(JSON.stringify({ panes: [{ address: 'alice-laptop/work/0.0', mode: 'write', command: 'bash', title: 'test-pane', pane_id: '%3', activity: 1 }] }))
    return new Response(null, { status: 204 })
  }
  return { calls, fetch }
}

/** The app on the pane page with its first rows drawn. */
async function onPane(mode: Mode) {
  const hub = echoingHub(mode)
  globalThis.fetch = hub.fetch as typeof fetch
  await saveSettings({ hub: 'http://127.0.0.1:1', token: 'mxt_' + 'c'.repeat(43), every: 3 })
  const bridge = fakeBridge()
  const lines: string[] = []
  const app = new App(bridge as never, (m) => lines.push(m), null)
  await app.start()
  await sleep(150)
  bridge.cb!({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } as never })
  await sleep(150)
  bridge.cb!(sys(OsEventTypeList.CLICK_EVENT))
  await sleep(300)
  const drawn = () => bridge.upgrades.concat(bridge.pages.map((p) => JSON.stringify(p)))
  assert.ok(drawn().some((c) => c.includes('ok')), 'the pane\'s first rows were drawn')
  return { hub, bridge, app, lines, drawn }
}

const inputs = (hub: ReturnType<typeof echoingHub>) => hub.calls.filter((c) => c.method === 'POST' && c.url.includes('/input'))
const afterLastInput = (hub: ReturnType<typeof echoingHub>) => hub.calls.slice(hub.calls.lastIndexOf(inputs(hub).at(-1)!) + 1)

test('every piece asks for the screen: the input carries read=1 and the read\'s own lines, width and charset, Accept text/plain', async () => {
  const { hub, app } = await onPane('echo')
  try {
    assert.equal(await app.sendText('y', true), '')
    const posts = inputs(hub)
    assert.equal(posts.length, 2, hub.calls.map((c) => c.method + ' ' + c.url).join('\n'))
    for (const p of posts) {
      assert.ok(p.url.endsWith('/v1/panes/alice-laptop/work/0.0/input?read=1&lines=200&width=400&charset=latin1'), p.url)
      assert.equal(p.accept, 'text/plain')
    }
    assert.deepEqual(posts.map((p) => JSON.parse(p.body)), [{ text: 'y' }, { key: 'Enter' }])
  } finally {
    app.stop()
    await sleep(400)
  }
})

test('a 200 is the screen: drawn when the send resolves, no read of the pane after the last input', async () => {
  const { hub, app, drawn, lines } = await onPane('echo')
  try {
    await app.sendText('y', true)
    assert.ok(drawn().some((c) => c.includes('command not found')), 'the echo was not drawn')
    assert.ok(!afterLastInput(hub).some((c) => c.method === 'GET' && c.url.includes('/v1/panes/alice-laptop/')), 'the pane was read after the echo:\n' + afterLastInput(hub).map((c) => c.url).join('\n'))
    assert.ok(lines.some((l) => l.startsWith('POST input 200 ')), lines.join('\n'))
    assert.ok(!lines.some((l) => l.includes('command not found')), 'the rows reached the log')
  } finally {
    app.stop()
    await sleep(400)
  }
})

test('a 204, a hub before the echo: the pane is read at once after the last input and the read\'s rows are drawn', async () => {
  const { hub, app, drawn } = await onPane('204')
  try {
    await app.sendText('y', true)
    const after = afterLastInput(hub)
    assert.ok(after.some((c) => c.method === 'GET' && c.url.includes('/v1/panes/alice-laptop/')), 'no read followed the 204:\n' + after.map((c) => c.url).join('\n'))
    assert.ok(drawn().some((c) => c.includes('after-the-read')), 'the read\'s rows were not drawn')
  } finally {
    app.stop()
    await sleep(400)
  }
})

test('a 200 naming another pane: nothing of it is drawn and the listing is asked for', async () => {
  const { hub, app, drawn, lines } = await onPane('stranger')
  try {
    const listings = () => hub.calls.filter((c) => c.method === 'GET' && /\/v1\/panes$/.test(c.url)).length
    const before = listings()
    await app.sendText('y', true)
    await sleep(300)
    assert.ok(!drawn().some((c) => c.includes('STRANGER-ROWS')), 'a stranger\'s rows were drawn')
    assert.ok(listings() > before, 'the listing was not asked for')
    assert.ok(lines.some((l) => l.includes('POST input 200: %9 answered at work/0.0, not %3')), lines.join('\n'))
  } finally {
    app.stop()
    await sleep(400)
  }
})
