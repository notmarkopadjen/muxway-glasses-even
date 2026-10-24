// The app against a bridge and a hub that are both stand-ins: what it
// asks for, and that leaving the foreground stops every request until the
// app is back.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'
import { App } from '../../src/app.ts'
import { saveSettings } from '../../src/settings.ts'

const LIST = 'alice-laptop/work/0.0\twrite\tbash\ttest-pane\t\n'

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
    textContainerUpgrade: async () => true,
    shutDownPageContainer: async () => true,
    setLocalStorage: async () => true,
    getLocalStorage: async () => '',
    mic: [] as boolean[],
    audioControl: async (open: boolean) => (b.mic.push(open), true),
  }
  return b
}

function fakeHub(stt = false) {
  const calls: string[] = []
  const bodies: unknown[] = []
  const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = String(url)
    calls.push(init?.method === 'POST' ? 'POST ' + u : u)
    if (init?.body !== undefined) bodies.push(init.body)
    if (u.includes('/v1/transcribe')) {
      if (!stt) return new Response('{"error":"not_found"}', { status: 404 })
      if (init?.method === 'POST') return new Response('run the tests again\n', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
      return new Response(null, { status: 204 })
    }
    if (u.includes('/v1/events')) {
      if (u.includes('wait=')) await new Promise((r) => setTimeout(r, 300))
      return new Response('next\t1\n', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
    }
    if (u.includes('/v1/panes/')) {
      if ((init?.headers as Record<string, string>)?.['If-None-Match'] === '"v1"') return new Response(null, { status: 304 })
      return new Response('$ make\nok\n$ \n', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', ETag: '"v1"' } })
    }
    if (u.includes('/v1/panes')) return new Response(LIST, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
    return new Response(null, { status: 204 })
  }
  return { calls, bodies, fetch }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const sys = (eventType: OsEventTypeList): EvenHubEvent => ({ sysEvent: { eventType } as never })

test('foreground exit stops the requests, enter and gestures resume them', async () => {
  const hub = fakeHub()
  globalThis.fetch = hub.fetch as typeof fetch
  await saveSettings({ hub: 'http://127.0.0.1:1', token: 'mxt_' + 'a'.repeat(43), every: 1 })
  const bridge = fakeBridge()
  const app = new App(bridge as never, () => {}, null)
  await app.start()
  await sleep(150)
  assert.ok(hub.calls.some((c) => c.includes('/v1/panes?')), 'the list was read')
  assert.ok(hub.calls.some((c) => c.includes('/v1/events?limit=1')), 'the cursor was taken')
  assert.ok(!hub.calls.some((c) => c.includes('token')), 'no token in a URL')

  bridge.cb!({ listEvent: { eventType: OsEventTypeList.CLICK_EVENT, currentSelectItemIndex: 0 } as never })
  await sleep(150)
  const reads = () => hub.calls.filter((c) => c.includes('/v1/panes/alice-laptop')).length
  assert.ok(reads() >= 1, 'the pane was read on opening')
  await sleep(1200)
  assert.ok(reads() >= 2, 'the pane is followed')
  assert.ok(hub.calls.some((c) => c.includes('charset=latin1')), 'Latin-1 by default')

  bridge.cb!(sys(OsEventTypeList.FOREGROUND_EXIT_EVENT))
  await sleep(400)
  const frozen = hub.calls.length
  await sleep(1500)
  assert.equal(hub.calls.length, frozen, 'requests went on in the background')

  bridge.cb!(sys(OsEventTypeList.FOREGROUND_ENTER_EVENT))
  await sleep(300)
  assert.ok(hub.calls.length > frozen, 'nothing resumed on foreground enter')

  bridge.cb!(sys(OsEventTypeList.FOREGROUND_EXIT_EVENT))
  await sleep(400)
  const again = hub.calls.length
  bridge.cb!({ textEvent: { eventType: OsEventTypeList.SCROLL_TOP_EVENT } as never })
  await sleep(300)
  assert.ok(hub.calls.length > again, 'a gesture did not wake the app')
  app.stop()
  await sleep(400)
})

test('a spoken reply: Say it, frames, stop, read back, send with Enter', async () => {
  const hub = fakeHub(true)
  globalThis.fetch = hub.fetch as typeof fetch
  await saveSettings({ hub: 'http://127.0.0.1:1', token: 'mxt_' + 'b'.repeat(43), every: 1, voice: true })
  const bridge = fakeBridge()
  const app = new App(bridge as never, () => {}, null)
  app.toneMic = true
  await app.start()
  await sleep(200)
  bridge.cb!({ listEvent: { eventType: OsEventTypeList.CLICK_EVENT, currentSelectItemIndex: 0 } as never }) // the pane
  await sleep(200)
  bridge.cb!(sys(OsEventTypeList.CLICK_EVENT)) // answers
  await sleep(100)
  const answers = bridge.pages[bridge.pages.length - 1] as { listObject?: { itemContainer: { itemName: string[] } }[] }
  assert.equal(answers.listObject?.[0].itemContainer.itemName[0], '» Say it')
  bridge.cb!({ listEvent: { eventType: OsEventTypeList.CLICK_EVENT, currentSelectItemIndex: 0 } as never }) // Say it
  await sleep(1300)
  assert.deepEqual(bridge.mic, [true], 'the mic was not opened once')
  bridge.cb!(sys(OsEventTypeList.CLICK_EVENT)) // stop
  await sleep(300)
  assert.deepEqual(bridge.mic, [true, false], 'the mic was not closed')
  const wav = hub.bodies.find((b) => b instanceof ArrayBuffer) as ArrayBuffer
  assert.ok(wav && wav.byteLength > 44 + 16000, 'no clip of at least a second was posted')
  bridge.cb!(sys(OsEventTypeList.CLICK_EVENT)) // send
  await sleep(300)
  const posts = hub.bodies.filter((b) => typeof b === 'string')
  assert.deepEqual(posts, ['{"text":"run the tests again"}', '{"key":"Enter"}'])
  app.stop()
  await sleep(300)
})

test('without a transcriber the answers offer no Say it', async () => {
  const hub = fakeHub(false)
  globalThis.fetch = hub.fetch as typeof fetch
  await saveSettings({ hub: 'http://127.0.0.1:1', token: 'mxt_' + 'c'.repeat(43), every: 1, voice: true })
  const bridge = fakeBridge()
  const app = new App(bridge as never, () => {}, null)
  await app.start()
  await sleep(200)
  bridge.cb!({ listEvent: { eventType: OsEventTypeList.CLICK_EVENT, currentSelectItemIndex: 0 } as never })
  await sleep(200)
  bridge.cb!(sys(OsEventTypeList.CLICK_EVENT))
  await sleep(100)
  const answers = bridge.pages[bridge.pages.length - 1] as { listObject?: { itemContainer: { itemName: string[] } }[] }
  assert.equal(answers.listObject?.[0].itemContainer.itemName[0], 'Enter')
  app.stop()
  await sleep(300)
})
