// The glasses: a create or rebuild carries the short blocks whole, and the long ones as a space with their
// text following as an upgrade; one that was not sent is sent with the next page.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Glasses, LIGHT_BYTES, emptyPage, heavy, type Block, type Page } from '../../src/glasses.ts'

type Call = { kind: 'create' | 'rebuild' | 'upgrade'; texts: string[] }

function fakeBridge(fail: { upgrades: number } = { upgrades: 0 }) {
  const calls: Call[] = []
  const texts = (p: { textObject?: { content?: string }[] }) => (p.textObject ?? []).map((t) => t.content ?? '')
  return {
    calls,
    createStartUpPageContainer: async (p: never) => (calls.push({ kind: 'create', texts: texts(p) }), 0),
    rebuildPageContainer: async (p: never) => (calls.push({ kind: 'rebuild', texts: texts(p) }), true),
    textContainerUpgrade: async (u: { content?: string }) => {
      if (fail.upgrades > 0) {
        fail.upgrades--
        throw new Error('bridge down')
      }
      calls.push({ kind: 'upgrade', texts: [u.content ?? ''] })
      return true
    },
    updateImageRawData: async () => 0,
  }
}

const title: Block = { name: 'title', x: 0, y: 0, w: 356, h: 26, lines: ['◌ build · Claude'], level: 4 }
const body = (lines: string[]): Block => ({ name: 'body', x: 0, y: 28, w: 572, h: 224, lines, level: 3 })
const EIGHT = ['$ make', 'ok', '$ ls', 'a b c', '', '', '', '$ ']
function page(lines: string[], hint = 'the hint'): Page {
  return { ...emptyPage('dash'), hint, blocks: [title, body(lines)] }
}

test('heavy: more than one line, or one over the light bytes; blank text never', () => {
  assert.equal(heavy(title), false)
  assert.equal(heavy(body(EIGHT)), true)
  assert.equal(heavy(body(['', '', '', '', '', '', '', ''])), false, 'eight blank lines are a space either way')
  assert.equal(heavy({ ...title, lines: ['x'.repeat(LIGHT_BYTES)] }), false)
  assert.equal(heavy({ ...title, w: 2000, lines: ['x'.repeat(LIGHT_BYTES + 1)] }), true)
})

test('a create or rebuild carries the body as a space and its text follows as an upgrade; short blocks go whole', async () => {
  const bridge = fakeBridge()
  const g = new Glasses(bridge as never, () => {}, null)
  await g.show(page(EIGHT))
  assert.deepEqual(
    bridge.calls.map((c) => c.kind),
    ['create', 'upgrade'],
  )
  assert.deepEqual(bridge.calls[0].texts, ['the hint', '◌ build · Claude', ' '], 'the hint and the title whole, the body a space')
  assert.equal(bridge.calls[1].texts[0], EIGHT.join('\n'))
  // The same page again: nothing to send. A new line: one upgrade, no rebuild.
  bridge.calls.length = 0
  await g.show(page(EIGHT))
  assert.deepEqual(bridge.calls, [])
  await g.show(page([...EIGHT.slice(1), '$ make']))
  assert.deepEqual(
    bridge.calls.map((c) => c.kind),
    ['upgrade'],
  )
  // A geometry change: a rebuild with the body a space, then its text; a page of short blocks alone has no upgrade after.
  bridge.calls.length = 0
  const cols: Page = { ...emptyPage('dash'), hint: 'h', blocks: [{ ...title, w: 280 }, { ...title, name: 'title1', x: 288, w: 268 }] }
  await g.show(cols)
  assert.deepEqual(
    bridge.calls.map((c) => c.kind),
    ['rebuild'],
  )
  bridge.calls.length = 0
  await g.show(page(EIGHT))
  assert.deepEqual(
    bridge.calls.map((c) => c.kind),
    ['rebuild', 'upgrade'],
  )
  assert.equal(bridge.calls[0].texts[2], ' ')
  assert.equal(bridge.calls[1].texts[0], EIGHT.join('\n'))
})

test('an upgrade that fails leaves the block blank in the memory of the page, so the next apply sends it again', async () => {
  const fail = { upgrades: 1 }
  const bridge = fakeBridge(fail)
  const log: string[] = []
  const g = new Glasses(bridge as never, (m) => log.push(m), null)
  await g.show(page(EIGHT))
  assert.deepEqual(
    bridge.calls.map((c) => c.kind),
    ['create'],
  )
  assert.ok(log.some((m) => m.startsWith('draw failed')), log.join('|'))
  bridge.calls.length = 0
  await g.show(page(EIGHT))
  assert.deepEqual(
    bridge.calls.map((c) => c.kind),
    ['upgrade'],
  )
  assert.equal(bridge.calls[0].texts[0], EIGHT.join('\n'))
})
