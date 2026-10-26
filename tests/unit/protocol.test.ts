import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkHubUrl, checkToken, errorWords, paneName, parseEvents, parseHosts, parsePanes } from '../../src/protocol.ts'

const NOW = 1_800_000_000
const pane = (o: Record<string, unknown>) => ({ address: 'alice-laptop/work/0.0', mode: 'write', command: 'bash', title: 'test-pane', activity: NOW - 60, ...o })

test('parsePanes: fields, skipped entries, cleaned and cut names, times clamped', () => {
  const body = JSON.stringify({
    panes: [
      pane({ title: '✳ build', command: 'claude', attention: { kind: 'permission', at: NOW - 30, text: 'Claude needs \x1b[1myou' } }),
      pane({ address: 'alice-laptop/work/1.0', mode: 'read', title: 'alice-laptop', alias: 'logs' }),
      'bad entry',
      pane({ address: 'UPPER/x' }),
      pane({ address: 'alice-laptop/work/0.0/../../admin' }),
      pane({ address: 'alice-laptop/work/0' }),
      pane({ address: 'alice-laptop/wo rk/0.0' }),
      pane({ address: 'alice-laptop/work;x/0.0' }),
      pane({ address: 'alice-laptop/@Build' }),
      pane({ address: 'alice-laptop/work/2.0', title: 'x'.repeat(300), attention: { kind: 'nonsense', at: 'soon' }, activity: NOW + 999999 }),
      pane({ address: 'alice-laptop/work/3.0', title: 'a\x1bb', attention: { kind: 'done', at: -5 }, activity: -1 }),
    ],
  })
  const panes = parsePanes(body, NOW)
  assert.equal(panes.length, 4)
  assert.deepEqual(panes.map((p) => [p.path, p.writable, p.command, p.attention, p.attentionAt, p.activity]), [
    ['work/0.0', true, 'claude', 'permission', NOW - 30, NOW - 60],
    ['work/1.0', false, 'bash', '', 0, NOW - 60],
    ['work/2.0', true, 'bash', '', 0, NOW],
    ['work/3.0', true, 'bash', 'done', 0, 0],
  ])
  assert.equal(panes[0].attentionText, 'Claude needs [1myou')
  assert.deepEqual(panes.map(paneName), ['build', 'logs', 'x'.repeat(64), 'ab'])
})

test('parsePanes: junk, no list, and 2000 panes', () => {
  assert.deepEqual(parsePanes('<html>'), [])
  assert.deepEqual(parsePanes('{"panes": 7}'), [])
  const many = JSON.stringify({ panes: Array.from({ length: 2000 }, (_, i) => pane({ address: `alice-laptop/work/${i}.0` })) })
  assert.equal(parsePanes(many, NOW).length, 500)
})

test('paneName: a title that says nothing gives the address; an alias wins', () => {
  const p = parsePanes(JSON.stringify({ panes: [pane({ address: 'h/work/0.1', title: 'bash' })] }), NOW)[0]
  assert.equal(paneName(p), 'work/0.1')
  assert.equal(paneName({ ...p, title: '*' }), 'work/0.1')
  assert.equal(paneName({ ...p, title: '* tests' }), 'tests')
  assert.equal(paneName({ ...p, alias: 'build' }), 'build')
})

test('parsePanes: a forged mark or mode in the title changes nothing', () => {
  const p = parsePanes(JSON.stringify({ panes: [pane({ mode: 'read', title: '★ h/work/0.0 claude write permission' })] }), NOW)[0]
  assert.equal(p.writable, false)
  assert.equal(p.attention, '')
})

test('parseHosts', () => {
  assert.deepEqual(parseHosts('{"hosts":[{"name":"alice-laptop","online":true},{"name":"BAD HOST","online":true},{"name":"bob","online":"yes"}]}'), [
    { name: 'alice-laptop', online: true },
    { name: 'bob', online: false },
  ])
  assert.deepEqual(parseHosts('nope'), [])
})

test('parseEvents: events and the cursor, hostile text, bad cursors', () => {
  const r = parseEvents(
    JSON.stringify({
      events: [
        { seq: 12, at: NOW, address: 'h/work/0.0', kind: 'permission', text: 'Claude needs \x1b[1myou' },
        { seq: 13, at: 1, address: 'h/work/0.0', kind: 'working' },
        { seq: 14, address: 'h/x/0.0', kind: 'nonsense', text: 't' },
        { seq: 15, at: 2, address: 'h/@x', kind: 'done', text: 'y'.repeat(10000) },
        { seq: 16, at: 2, address: 'h/x', kind: 'done', text: 'not an address' },
      ],
      next: 15,
    }),
  )
  assert.equal(r.next, 15)
  assert.deepEqual(r.events.map((e) => [e.seq, e.kind, e.text.length]), [[12, 'permission', 19], [13, 'working', 0], [15, 'done', 200]])
  assert.equal(parseEvents('{"next":"abc"}').next, null)
  assert.equal(parseEvents('{"next":-1}').next, null)
  assert.deepEqual(parseEvents('garbage'), { events: [], next: null })
})

test('checkHubUrl', () => {
  assert.deepEqual(checkHubUrl(' https://hub.example.com/ '), { url: 'https://hub.example.com' })
  assert.deepEqual(checkHubUrl('http://127.0.0.1:7600'), { url: 'http://127.0.0.1:7600' })
  assert.deepEqual(checkHubUrl('http://localhost:7600/'), { url: 'http://localhost:7600' })
  for (const bad of ['http://hub.example.com', 'https://alice:pw@hub.example.com', 'https://hub.example.com/?x=1', 'https://hub.example.com/#f', 'ftp://hub.example.com', 'hub', '', 'https://hub.example.com/v1']) {
    assert.ok('error' in checkHubUrl(bad), bad)
  }
})

test('checkToken', () => {
  assert.deepEqual(checkToken(' mxt_abcdefgh '), { token: 'mxt_abcdefgh' })
  for (const bad of ['short', 'x'.repeat(201), 'has space here', 'ctrl\x01char']) assert.ok('error' in checkToken(bad), bad)
})

test('errorWords', () => {
  assert.equal(errorWords(401), 'token refused')
  assert.equal(errorWords(503), 'host offline')
  assert.equal(errorWords(0), 'no connection')
  assert.equal(errorWords(418), 'error 418')
})
