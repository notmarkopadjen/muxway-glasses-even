// The app against a bridge and a hub that are both stand-ins: what it
// asks for, and that leaving the foreground stops every request until the
// app is back.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'
import { App } from '../../src/app.ts'
import { saveSettings } from '../../src/settings.ts'

const LIST = JSON.stringify({ panes: [{ address: 'alice-laptop/work/0.0', mode: 'write', command: 'bash', title: 'test-pane', activity: 1 }] })
/** The same pane, just written to, so a working event makes it work. */
const LIVE = () => JSON.stringify({ panes: [{ address: 'alice-laptop/work/0.0', mode: 'write', command: 'codex', title: 'build', activity: Math.floor(Date.now() / 1000) }] })
const HOSTS = JSON.stringify({ hosts: [{ name: 'alice-laptop', online: true }] })

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
    mic: [] as boolean[],
    audioControl: async (open: boolean) => (b.mic.push(open), true),
  }
  return b
}

function fakeHub(stt = false, working = false) {
  const calls: string[] = []
  let told = false
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
      if (working && u.includes('wait=') && !told) {
        told = true
        return new Response(JSON.stringify({ events: [{ seq: 1, at: 1, address: 'alice-laptop/work/0.0', kind: 'working', text: '' }], next: 2 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{"events":[],"next":1}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (u.includes('/v1/hosts')) return new Response(HOSTS, { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (u.includes('/v1/panes/')) {
      if ((init?.headers as Record<string, string>)?.['If-None-Match'] === '"v1"') return new Response(null, { status: 304 })
      return new Response('$ make\nok\n$ \n', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', ETag: '"v1"' } })
    }
    if (u.includes('/v1/panes')) return new Response(working ? LIVE() : LIST, { status: 200, headers: { 'Content-Type': 'application/json' } })
    return new Response(null, { status: 204 })
  }
  return { calls, bodies, fetch }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('a recent answer without a cursor is asked again after the wait of a failed poll, not at once', async () => {
  const hub = fakeHub()
  const garbled = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    if (String(url).includes('/v1/events')) {
      hub.calls.push(String(url))
      return new Response('{"events": [{"seq": 1, "at": 1, "address": "alice-laptop/work/0.0", "kind": "worki', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return hub.fetch(url, init)
  }
  globalThis.fetch = garbled as typeof fetch
  await saveSettings({ hub: 'http://127.0.0.1:1', token: 'mxt_' + 'a'.repeat(43), every: 1 })
  const bridge = fakeBridge()
  const lines: string[] = []
  const app = new App(bridge as never, (m) => lines.push(m), null)
  await app.start()
  await sleep(800)
  const recent = hub.calls.filter((c) => c.includes('/v1/events?limit=50'))
  assert.equal(recent.length, 1, `the recent events were asked for ${recent.length} times in under a second`)
  assert.ok(lines.some((l) => l.startsWith('GET events: no cursor, again in 5 s')), lines.join('\n'))
  assert.ok(!hub.calls.some((c) => c.includes('/v1/events?after=')), 'a poll went on without a cursor')
  bridge.cb!(sys(OsEventTypeList.FOREGROUND_EXIT_EVENT))
  await sleep(100)
})
const sys = (eventType: OsEventTypeList): EvenHubEvent => ({ sysEvent: { eventType } as never })

test('foreground exit stops the requests, enter and gestures resume them', async () => {
  const hub = fakeHub()
  globalThis.fetch = hub.fetch as typeof fetch
  await saveSettings({ hub: 'http://127.0.0.1:1', token: 'mxt_' + 'a'.repeat(43), every: 1 })
  const bridge = fakeBridge()
  const app = new App(bridge as never, () => {}, null)
  await app.start()
  await sleep(150)
  assert.ok(hub.calls.some((c) => c.endsWith('/v1/panes')), 'the list was read')
  assert.ok(hub.calls.some((c) => c.includes('/v1/events?limit=50')), 'the recent events were read for the cursor')
  assert.ok(!hub.calls.some((c) => c.includes('token')), 'no token in a URL')

  bridge.cb!({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } as never }) // the first row is the host's line: one down is the pane
  await sleep(150)
  bridge.cb!(sys(OsEventTypeList.CLICK_EVENT))
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
  bridge.cb!({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } as never }) // past the host's line
  await sleep(150)
  bridge.cb!(sys(OsEventTypeList.CLICK_EVENT)) // the first pane
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
  bridge.cb!({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } as never })
  await sleep(150)
  bridge.cb!(sys(OsEventTypeList.CLICK_EVENT))
  await sleep(200)
  bridge.cb!(sys(OsEventTypeList.CLICK_EVENT))
  await sleep(100)
  const answers = bridge.pages[bridge.pages.length - 1] as { listObject?: { itemContainer: { itemName: string[] } }[] }
  assert.equal(answers.listObject?.[0].itemContainer.itemName[0], 'Enter')
  app.stop()
  await sleep(300)
})

test('a working mark turns once a second, in place, and stops with the foreground', async () => {
  const hub = fakeHub(false, true)
  globalThis.fetch = hub.fetch as typeof fetch
  await saveSettings({ hub: 'http://127.0.0.1:1', token: 'mxt_' + 'a'.repeat(43), every: 1 })
  const bridge = fakeBridge()
  const app = new App(bridge as never, () => {}, null)
  await app.start()
  await sleep(600)
  const marks = () => bridge.upgrades.filter((c) => c.includes('◐ Codex') || c.includes('◑ Codex'))
  await sleep(2300)
  const seen = marks()
  assert.ok(seen.length >= 2, `the mark turned: ${seen.length} upgrades`)
  assert.ok(seen.some((c) => c.includes('◐')) && seen.some((c) => c.includes('◑')), 'both halves were drawn')
  assert.equal(bridge.pages.length, 1, 'the turn is an upgrade, not a rebuild')
  bridge.cb!(sys(OsEventTypeList.FOREGROUND_EXIT_EVENT))
  await sleep(300)
  const frozen = marks().length
  await sleep(2200)
  assert.equal(marks().length, frozen, 'the mark went on turning in the background')
  app.stop()
  await sleep(400)
})

test('the trace: off, the log is as before; on, every draw, view change and timer is a line, never the token or the pane', async () => {
  const hub = fakeHub(false, true)
  globalThis.fetch = hub.fetch as typeof fetch
  const token = 'mxt_' + 'd'.repeat(43)
  const lines: { m: string; cls: string }[] = []
  const log = (m: string, cls = '') => void lines.push({ m, cls })
  await saveSettings({ hub: 'http://127.0.0.1:1', token, every: 1, detail: false })
  const bridge = fakeBridge()
  const app = new App(bridge as never, log, null)
  await app.start()
  await sleep(300)
  assert.equal(lines.filter((l) => l.cls === 'trace').length, 0, 'nothing traced while the switch is off')
  await saveSettings({ detail: true })
  await app.onSettingsChanged()
  await sleep(300)
  bridge.cb!({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } as never })
  await sleep(150)
  bridge.cb!(sys(OsEventTypeList.CLICK_EVENT)) // the pane
  await sleep(300)
  bridge.cb!(sys(OsEventTypeList.DOUBLE_CLICK_EVENT)) // back
  await sleep(1500)
  app.stop()
  await sleep(400)
  const traced = lines.filter((l) => l.cls === 'trace').map((l) => l.m)
  const has = (re: RegExp) => assert.ok(traced.some((m) => re.test(m)), `${re}: ${traced.join(' | ')}`)
  has(/^view: list → pane build \(2\)$/)
  has(/^view: pane build → list \(1\) · back$/)
  has(/^glasses: rebuild \d+ containers · \d+(\.\d+)? (B|KB) · \d+ ms · ok$/)
  has(/^glasses: rebuild: .*changed$/)
  has(/^glasses: upgrade \w+ · \d+(\.\d+)? (B|KB) · \d+ ms$/)
  has(/^draw pane · \d+ ms$/)
  has(/^draw list · \d+ ms$/)
  has(/^spin on$/)
  has(/^read now$/)
  has(/^wake$/)
  for (const m of lines.map((l) => l.m)) {
    assert.ok(!m.includes(token) && !m.includes('mxt_'), 'the token in the log')
    assert.ok(!m.includes('$ make') && !m.includes('make\n'), 'pane content in the log: ' + m)
  }
})

/** Three panes of one window as tmux has them, and the host renumbering when one closes: the listing names each pane by id at its address, a read at an address gives the rows of whoever sits there, and names them in Muxway-Pane as the core does since #315 (`header: false` is a hub before that). */
function renumberingHub(opts: { header?: boolean } = {}) {
  const header = opts.header ?? true
  const calls: string[] = []
  // address → the pane there: its id and name; the rows name the pane.
  let at = new Map([
    ['work/0.0', { id: '%1', name: 'test-pane' }],
    ['work/0.1', { id: '%2', name: 'second' }],
    ['work/0.2', { id: '%3', name: 'third' }],
  ])
  let kept = at
  let online = true
  let pending: string | null = null
  // The listing the hub still gives while lagging: the reads answer the new map before the listing says so.
  let lagging: typeof at | null = null
  const listing = () =>
    JSON.stringify({ panes: [...(lagging ?? at)].map(([path, p]) => ({ address: 'alice-laptop/' + path, mode: 'write', command: 'bash', title: p.name, pane_id: p.id, activity: 1 })) })
  const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = String(url)
    calls.push(u)
    const json = (body: string) => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (u.includes('/v1/events')) {
      if (u.includes('wait=')) {
        await new Promise((r) => setTimeout(r, 200))
        if (pending) {
          const ev = pending
          pending = null
          return json(JSON.stringify({ events: [{ seq: 2, at: 1, address: 'alice-laptop/' + ev, kind: 'done', text: '' }], next: 2 }))
        }
      }
      return json('{"events":[],"next":1}')
    }
    if (u.includes('/v1/hosts')) return json(JSON.stringify({ hosts: [{ name: 'alice-laptop', online }] }))
    const m = /\/v1\/panes\/alice-laptop\/(work\/\d\.\d)\?/.exec(u)
    if (m) {
      const p = at.get(m[1])
      if (!p) return new Response('{"error":"not_found"}', { status: 404, headers: { 'Content-Type': 'application/json' } })
      const etag = `"${p.id}-rows"`
      const named = header ? { 'Muxway-Pane': p.id } : {}
      if ((init?.headers as Record<string, string>)?.['If-None-Match'] === etag) return new Response(null, { status: 304, headers: named })
      return new Response(`$ echo ${p.name}-rows\n${p.name}-rows\n$ \n`, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', ETag: etag, ...named } })
    }
    if (u.includes('/v1/panes')) return json(listing())
    return new Response(null, { status: 204 })
  }
  return {
    calls,
    fetch,
    /** The pane at the address closes: the ones after it move up one. */
    kill(path: string) {
      const rest = [...at].filter(([p]) => p !== path).map(([, p]) => p)
      at = new Map(rest.map((p, i) => [`work/0.${i}`, p]))
    },
    /** The listing keeps saying what it said until catchUp: the reads are ahead of it. */
    lag() {
      lagging = at
    },
    catchUp() {
      lagging = null
    },
    /** An event the app reads as a reason to list again. */
    poke(path: string) {
      pending = path
    },
    /** The host is away: offline, nothing listed, every read refused. */
    away() {
      kept = at
      at = new Map()
      online = false
    },
    back() {
      at = kept
      online = true
    },
  }
}

for (const header of [true, false]) {
  test(`a pane page shows its own pane or nothing (reads ${header ? 'with' : 'without'} Muxway-Pane): the host renumbers, the page follows by id with a blank body first, then the pane goes and the page closes with a word; a host away closes nothing`, async () => {
    const hub = renumberingHub({ header })
    globalThis.fetch = hub.fetch as typeof fetch
    await saveSettings({ hub: 'http://127.0.0.1:1', token: 'mxt_' + 'b'.repeat(43), every: 1 })
    const bridge = fakeBridge()
    const lines: string[] = []
    const app = new App(bridge as never, (m) => lines.push(m), null)
    try {
      await own(app, bridge, hub, lines)
    } finally {
      app.stop()
      await sleep(400)
    }
  })
}

test('a read that names another pane is not drawn: the host renumbers before the listing says so, the stranger\'s rows never show under the pane\'s title, the listing is asked for at once, and the pane\'s own rows come back where it is now', async () => {
  const hub = renumberingHub()
  globalThis.fetch = hub.fetch as typeof fetch
  await saveSettings({ hub: 'http://127.0.0.1:1', token: 'mxt_' + 'b'.repeat(43), every: 1 })
  const bridge = fakeBridge()
  const lines: string[] = []
  const app = new App(bridge as never, (m) => lines.push(m), null)
  try {
    await app.start()
    await sleep(300)
    bridge.cb!({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } as never })
    await sleep(150)
    bridge.cb!({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } as never })
    await sleep(150)
    bridge.cb!(sys(OsEventTypeList.CLICK_EVENT))
    await sleep(600)
    assert.ok(bridge.upgrades.some((c) => c.includes('second-rows')), 'second\'s rows were drawn')
    const drawn = () => bridge.upgrades.concat(bridge.pages.map((p) => JSON.stringify(p)))
    const listings = () => hub.calls.filter((c) => /\/v1\/panes(\?|$)/.test(c)).length
    // test-pane closes and the listing lags behind: the read at work/0.1 answers third's rows, named %3, while the
    // listing still names second (%2) there. No event comes.
    hub.lag()
    hub.kill('work/0.0')
    const before = listings()
    await sleep(1500)
    assert.ok(lines.some((l) => l.includes('%3 answered at work/0.1, not %2')), lines.join('\n'))
    assert.ok(listings() > before, 'the listing was not asked for after the stranger answered')
    assert.ok(!lines.some((l) => l.startsWith('followed')), 'nothing to follow while the listing lags')
    assert.equal(drawn().filter((c) => c.includes('third-rows')).length, 0, 'a stranger\'s rows were drawn')
    assert.ok(bridge.upgrades.some((c) => c.includes('second-rows')), 'the rows held, second\'s own, stayed')
    // The listing catches up: the page follows second to work/0.0 and its own rows come back there.
    hub.catchUp()
    hub.poke('work/0.0')
    await sleep(2500)
    assert.ok(lines.includes('followed second to work/0.0'), lines.join('\n'))
    assert.equal(drawn().filter((c) => c.includes('third-rows')).length, 0, 'a stranger\'s rows were drawn after the follow')
    assert.ok(hub.calls.some((c) => c.includes('/v1/panes/alice-laptop/work/0.0?')), 'second was not read where it is now')
    const own2 = bridge.upgrades.filter((c) => c.includes('second-rows')).length
    assert.ok(own2 >= 2, 'second\'s rows did not come back at the new address')
  } finally {
    app.stop()
    await sleep(400)
  }
})

async function own(app: App, bridge: ReturnType<typeof fakeBridge>, hub: ReturnType<typeof renumberingHub>, lines: string[]) {
  await app.start()
  await sleep(300)
  // The host's line, test-pane, second: two down and a tap opens second (work/0.1).
  bridge.cb!({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } as never })
  await sleep(150)
  bridge.cb!({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } as never })
  await sleep(150)
  bridge.cb!(sys(OsEventTypeList.CLICK_EVENT))
  await sleep(600)
  const reads = (path: string) => hub.calls.filter((c) => c.includes('/v1/panes/alice-laptop/' + path + '?')).length
  assert.ok(reads('work/0.1') >= 1, 'second was read at work/0.1')
  assert.ok(bridge.upgrades.some((c) => c.includes('second-rows')), 'its rows were drawn')
  const drawn = () => bridge.upgrades.concat(bridge.pages.map((p) => JSON.stringify(p)))

  // test-pane closes: second is work/0.0 and third sits at work/0.1, where the page still reads.
  hub.kill('work/0.0')
  hub.poke('work/0.1')
  await sleep(1500)
  const followed = lines.findIndex((l) => l === 'followed second to work/0.0')
  assert.ok(followed >= 0, lines.join('\n'))
  const before = reads('work/0.0')
  await sleep(1300)
  assert.ok(reads('work/0.0') > before, 'the page reads second where it is now')
  assert.ok(bridge.upgrades.some((c) => c === 'work/0.0'), 'the state shows the new place')
  // From the follow on, nothing of third is drawn under second's title: the rows read at the old address were dropped and the body was blank until the first read at the new one.
  const strangers = drawn().filter((c) => c.includes('third-rows')).length
  await sleep(1200)
  assert.equal(drawn().filter((c) => c.includes('third-rows')).length, strangers, 'a stranger\'s rows were drawn after the follow')
  assert.ok(bridge.upgrades.some((c) => c.includes('second-rows')), 'second\'s own rows came back')
  assert.ok(!lines.some((l) => l.includes('is gone')), 'nothing was gone yet')

  // The host goes away: the page stays and the reads say so.
  hub.away()
  hub.poke('work/0.0')
  await sleep(1500)
  assert.ok(!lines.some((l) => l.includes('is gone')), 'a pane whose host is away was given up: ' + lines.filter((l) => l.includes('gone')).join(', '))
  assert.ok(hub.calls.some((c) => c.includes('/v1/panes/alice-laptop/work/0.0?')), 'the page kept reading')

  // The host is back without second: the page closes with a word, the list is drawn.
  hub.back()
  hub.kill('work/0.0')
  hub.poke('work/0.0')
  await sleep(1500)
  assert.ok(lines.includes('second is gone'), lines.join('\n'))
  assert.ok(drawn().some((c) => c.includes('second is gone')), 'the word was not drawn')
  assert.ok(drawn().some((c) => c.includes('third') && c.includes('alice-laptop')), 'the list did not come back')
}
