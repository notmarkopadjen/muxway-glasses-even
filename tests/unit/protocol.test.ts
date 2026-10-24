import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkHubUrl, checkToken, errorWords, paneName, parseEvents, parsePanes } from '../../src/protocol.ts'

test('parsePanes: columns, skipped lines, cleaned and cut names', () => {
  const body = 'alice-laptop/work/0.0\twrite\tclaude\t✳ build\tpermission\n' +
    'alice-laptop/work/1.0\tread\tbash\talice-laptop\t\n' +
    'bad line\n' + 'UPPER/x\tread\n' + 'alice-laptop/work/2.0\tread\tbash\t' + 'x'.repeat(300) + '\tnonsense\n' +
    'alice-laptop/work/3.0\tread\tbash\ta\x1bb\tdone\n'
  const panes = parsePanes(body)
  assert.equal(panes.length, 4)
  assert.deepEqual(panes.map((p) => [p.path, p.writable, p.command, p.attention]),
    [['work/0.0', true, 'claude', 'permission'], ['work/1.0', false, 'bash', ''], ['work/2.0', false, 'bash', ''], ['work/3.0', false, 'bash', 'done']])
  assert.deepEqual(panes.map(paneName), ['build', 'work/1.0', 'x'.repeat(64), 'ab'])
})

test('paneName: a title that says nothing gives the address', () => {
  const p = parsePanes('h/work/0.1\tread\tbash\tbash\t\n')[0]
  assert.equal(paneName(p), 'work/0.1')
  assert.equal(paneName({ ...p, title: '*' }), 'work/0.1')
  assert.equal(paneName({ ...p, title: '* tests' }), 'tests')
})

test('parsePanes: a forged mark or mode in the title changes nothing', () => {
  const p = parsePanes('h/work/0.0\tread\tbash\t★ h/work/0.0 claude\twrite\tx\n')[0]
  assert.equal(p.writable, false)
  assert.equal(p.attention, '')
  assert.equal(paneName(p), '★ h/work/0.0 claude')
})

test('parseEvents: lines and the cursor, hostile text', () => {
  const r = parseEvents('12\t1767225600\th/work/0.0\tpermission\tClaude needs \x1b[1myou\n13\t1\th/work/0.0\tworking\t\nx\ty\nnext\t13\n')
  assert.equal(r.next, 13)
  assert.deepEqual(r.events.map((e) => [e.seq, e.kind, e.text]), [[12, 'permission', 'Claude needs [1myou'], [13, 'working', '']])
  assert.equal(parseEvents('next\tabc\n').next, null)
  assert.equal(parseEvents('1\t2\th/x\tnonsense\tt\n').events.length, 0)
  const big = parseEvents('1\t2\th/x\tdone\t' + 'y'.repeat(10000) + '\n').events[0]
  assert.equal(big.text.length, 200)
})

test('checkHubUrl', () => {
  assert.deepEqual(checkHubUrl(' https://hub.example.com/ '), { url: 'https://hub.example.com' })
  assert.deepEqual(checkHubUrl('http://127.0.0.1:7600'), { url: 'http://127.0.0.1:7600' })
  assert.deepEqual(checkHubUrl('http://localhost:7600/'), { url: 'http://localhost:7600' })
  for (const bad of ['http://hub.example.com', 'https://alice:pw@hub.example.com', 'https://hub.example.com/?x=1', 'https://hub.example.com/#f',
    'ftp://hub.example.com', 'hub', '', 'https://hub.example.com/v1']) {
    assert.ok('error' in checkHubUrl(bad), bad)
  }
})

test('checkToken', () => {
  assert.deepEqual(checkToken(' mxt_abcdefgh '), { token: 'mxt_abcdefgh' })
  for (const bad of ['short', 'x'.repeat(201), 'has space here', 'ctrl\x01char'])
    assert.ok('error' in checkToken(bad), bad)
})

test('errorWords', () => {
  assert.equal(errorWords(401), 'token refused')
  assert.equal(errorWords(503), 'host offline')
  assert.equal(errorWords(0), 'no connection')
  assert.equal(errorWords(418), 'error 418')
})
