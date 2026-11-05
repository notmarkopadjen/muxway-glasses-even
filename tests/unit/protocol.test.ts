import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentOf, agentName, checkHubUrl, checkToken, errorWords, folder, paneName, parseChoices, programSays, parseEvents, parseFeed, parseHosts, parseInbox, parseMailbox, parsePanes } from '../../src/protocol.ts'
import { errorCode } from '../../src/api.ts'

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

test('agentOf: every harness by its command, three by their name in the title under an interpreter, Claude by its spark', () => {
  assert.deepEqual(['claude', 'codex', 'gemini', 'agy', 'opencode', 'copilot', 'aider', 'goose', 'amp', 'cursor-agent'].map((c) => agentOf(c, 'x')),
    ['claude', 'codex', 'gemini', 'antigravity', 'opencode', 'copilot', 'aider', 'goose', 'amp', 'cursor'])
  assert.equal(agentOf('bash', '✳ build'), 'claude')
  assert.equal(agentOf('bash', '✳'), 'claude')
  // The hub spells the spark as * only in text mode; a listing is JSON, so a * in a title is any program's.
  assert.equal(agentOf('bash', '* build'), '')
  assert.equal(agentOf('node', 'gemini'), 'gemini')
  assert.equal(agentOf('python3', 'Antigravity · notes'), 'antigravity')
  assert.equal(agentOf('bun', 'GitHub Copilot'), 'copilot')
  assert.deepEqual([agentOf('node', 'server'), agentOf('bash', 'gemini'), agentOf('vim', 'codex.md'), agentOf('', '')], ['', '', '', ''])
  assert.deepEqual(['claude', 'codex', 'antigravity', 'opencode', 'aider'].map((a) => agentName(a as never)), ['Claude', 'Codex', 'Antigravity', 'OpenCode', 'aider'])
  const p = parsePanes(JSON.stringify({ panes: [pane({ command: 'codex', title: 'codex' }), pane({ command: 'node', title: 'copilot' })] }), NOW)
  assert.deepEqual(p.map((x) => x.agent), ['codex', 'copilot'])
})

test('parseChoices: two to eight distinct clean lines of 1 to 40 characters without a bar, else none', () => {
  assert.deepEqual(parseChoices(['yes', 'no']), ['yes', 'no'])
  assert.deepEqual(parseChoices(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
  for (const bad of [['yes'], Array.from({ length: 9 }, (_, i) => 'c' + i), ['yes', 'x'.repeat(41)], ['yes', 'a|b'], ['yes', 'a\x1bb'], ['yes', ' no'], ['yes', 'yes'], ['yes', 7], 'yes', null, ['yes', '']]) {
    assert.deepEqual(parseChoices(bad), [], JSON.stringify(bad))
  }
  const body = JSON.stringify({ panes: [
    pane({ attention: { kind: 'question', at: NOW - 1, text: 'deploy?', choices: ['yes', 'no'] } }),
    pane({ address: 'alice-laptop/work/1.0', attention: { kind: 'permission', at: NOW - 1, text: 'run it?', choices: ['yes', 'no'] } }),
    pane({ address: 'alice-laptop/work/2.0', attention: { kind: 'question', at: NOW - 1, text: 'x', choices: ['only'] } }),
  ] })
  assert.deepEqual(parsePanes(body, NOW).map((p) => p.choices), [['yes', 'no'], [], []])
})

test('parseInbox: the waiting panes as the hub orders them, nothing without attention', () => {
  const body = JSON.stringify({ inbox: [
    pane({ address: 'alice-laptop/work/1.0', command: 'codex', title: 'codex', attention: { kind: 'done', at: NOW - 100, text: 'finished' } }),
    pane({ attention: { kind: 'question', at: NOW - 50, text: 'deploy?', choices: ['yes', 'no'] } }),
    pane({ address: 'alice-laptop/work/2.0' }),
    'junk',
  ], count: 2 })
  const inbox = parseInbox(body, NOW)
  assert.deepEqual(inbox.map((p) => [p.path, p.agent, p.attention, p.choices]), [['work/1.0', 'codex', 'done', []], ['work/0.0', '', 'question', ['yes', 'no']]])
  assert.deepEqual(parseInbox('{"panes":[]}'), [])
  assert.deepEqual(parseInbox('nope'), [])
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

test('programSays: the title without the spark, nothing when it repeats the command or the host', () => {
  const p = parsePanes(JSON.stringify({ panes: [pane({ command: 'claude', title: '✳ fixing the build' })] }), NOW)[0]
  assert.equal(programSays(p), 'fixing the build')
  assert.equal(programSays({ ...p, title: '✳' }), '')
  assert.equal(programSays({ ...p, title: '' }), '')
  assert.equal(programSays({ ...p, title: 'claude' }), '')
  assert.equal(programSays({ ...p, title: 'alice-laptop' }), '')
  assert.equal(programSays({ ...p, command: 'vim', title: 'notes.md' }), 'notes.md')
})

test('parsePanes: cwd read, cleaned and cut; folder is its last segment', () => {
  const panes = parsePanes(JSON.stringify({ panes: [
    pane({ cwd: '/home/alice/src/muxway' }),
    pane({ address: 'alice-laptop/work/1.0', cwd: '/' }),
    pane({ address: 'alice-laptop/work/2.0' }),
    pane({ address: 'alice-laptop/work/3.0', cwd: ['/x'] }),
    pane({ address: 'alice-laptop/work/4.0', cwd: '/a\x1b[1m/../' + 'b'.repeat(100) }),
    pane({ address: 'alice-laptop/work/5.0', cwd: '/x/'.repeat(200) + 'deep' }),
  ] }), NOW)
  assert.deepEqual(panes.map(folder), ['muxway', '', '', '', 'b'.repeat(32), 'x'])
  assert.equal(panes[0].cwd, '/home/alice/src/muxway')
  assert.equal(panes[4].cwd.includes('\x1b'), false)
  assert.equal(panes[5].cwd.length, 256)
})

test('parsePanes: a forged mark or mode in the title changes nothing', () => {
  const p = parsePanes(JSON.stringify({ panes: [pane({ mode: 'read', title: '★ h/work/0.0 claude write permission' })] }), NOW)[0]
  assert.equal(p.writable, false)
  assert.equal(p.attention, '')
})

test('parseHosts', () => {
  assert.deepEqual(parseHosts('{"hosts":[{"name":"alice-laptop","online":true},{"name":"BAD HOST","online":true},{"name":"bob","online":"yes"}]}'), [
    { name: 'alice-laptop', online: true, later: false, sessions: false, close: false, mail: false, keys: 0 },
    { name: 'bob', online: false, later: false, sessions: false, close: false, mail: false, keys: 0 },
  ])
  const able = parseHosts('{"hosts":[{"name":"alice-laptop","online":true,"sessions":true,"close":true,"mail":true,"keys":2},{"name":"bob","sessions":"yes","close":1,"mail":null,"keys":3}]}')
  assert.deepEqual(able.map((h) => [h.sessions, h.close, h.mail, h.keys]), [[true, true, true, 2], [false, false, false, 0]])
  assert.deepEqual(parseHosts('nope'), [])
  assert.equal(parseHosts('{"hosts":[{"name":"alice-laptop","online":true,"later":true},{"name":"bob","later":"yes"}]}').map((h) => h.later).join(), 'true,false')
})

test('parsePanes: later only when true, its time clamped; parseInbox keeps a parked entry with nothing pending', () => {
  const panes = parsePanes(JSON.stringify({ panes: [
    pane({ later: true, later_at: NOW - 40 }),
    pane({ address: 'alice-laptop/work/1.0', later: 'yes', later_at: NOW - 40 }),
    pane({ address: 'alice-laptop/work/2.0', later: 1 }),
    pane({ address: 'alice-laptop/work/3.0', later: true, later_at: 'soon' }),
    pane({ address: 'alice-laptop/work/4.0', later: true, later_at: NOW + 1e9 }),
    pane({ address: 'alice-laptop/work/5.0', later: true, later_at: -1 }),
    pane({ address: 'alice-laptop/work/6.0', later: false, later_at: NOW - 40 }),
  ] }), NOW)
  assert.deepEqual(panes.map((p) => [p.later, p.laterAt]), [[true, NOW - 40], [false, 0], [false, 0], [true, 0], [true, NOW], [true, 0], [false, 0]])
  const inbox = parseInbox(JSON.stringify({ inbox: [
    pane({ attention: { kind: 'done', at: NOW - 10 } }),
    pane({ address: 'alice-laptop/work/1.0', later: true, later_at: NOW - 5 }),
    pane({ address: 'alice-laptop/work/2.0' }),
  ] }), NOW)
  assert.deepEqual(inbox.map((p) => p.path), ['work/0.0', 'work/1.0'])
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
        { seq: 17, at: 3, address: 'h/work/0.0', kind: 'question', text: 'deploy?', choices: ['yes', 'no'] },
        { seq: 18, at: 3, address: 'h/work/0.0', kind: 'question', text: 'deploy?', choices: ['yes', 'a|b'] },
        { seq: 19, at: 3, address: 'h/work/0.0', kind: 'done', text: 'x', choices: ['yes', 'no'] },
      ],
      next: 15,
    }),
  )
  assert.equal(r.next, 15)
  assert.deepEqual(r.events.map((e) => [e.seq, e.kind, e.text.length]), [[12, 'permission', 19], [13, 'working', 0], [15, 'done', 200], [17, 'question', 7], [18, 'question', 7], [19, 'done', 1]])
  assert.deepEqual(r.events.slice(3).map((e) => e.choices), [['yes', 'no'], [], []])
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
  assert.equal(errorWords(409), 'no question there now')
  assert.equal(errorWords(0), 'no connection')
  assert.equal(errorWords(418), 'error 418')
  assert.equal(errorWords(409, 'mailbox_full'), 'mailbox full')
  assert.equal(errorWords(409, 'exists'), 'that name exists')
  assert.equal(errorWords(409, 'too_many'), 'too many there')
  assert.equal(errorWords(409, 'something_else'), 'no question there now')
  assert.equal(errorCode('{"error":"mailbox_full"}'), 'mailbox_full')
  assert.equal(errorCode('{"error":"<script>"}'), '')
  assert.equal(errorCode('not json'), '')
})

test('parsePanes: the id, the session and window, the size and last; junk is nothing', () => {
  const [p, q] = parsePanes(JSON.stringify({ panes: [
    pane({ pane_id: '%3', session: 'work', window_index: 2, width: 80, height: 24, last: true }),
    pane({ address: 'alice-laptop/work/1.0', pane_id: 'three', session: 'wo rk', window_index: -1, width: '80', height: 1e9, last: 'yes' }),
  ] }), NOW)
  assert.deepEqual([p.id, p.session, p.window, p.width, p.height, p.last], ['%3', 'work', 2, 80, 24, true])
  assert.deepEqual([q.id, q.session, q.window, q.width, q.height, q.last], ['', '', 0, 0, 9999, false])
})

test('parseFeed: entries oldest first with both ends checked, the cursor; junk dropped, a hundred kept', () => {
  const entry = (o: Record<string, unknown>) => ({ seq: 42, at: NOW - 60, actor: { id: 'x', name: 'reviewer' }, from: { host: 'alice-laptop', address: 'alice-laptop/work/1.0', pane_id: '%3', alias: 'review' }, to: { host: 'alice-laptop', address: 'alice-laptop/work/0.0', pane_id: '%5' }, kind: 'text', bytes: 13, text: 'run the tests', ...o })
  const { talk, next } = parseFeed(JSON.stringify({ talk: [
    entry({}),
    entry({ seq: 43, kind: 'mail', id: 7, text: 'a\x1bb', bytes: 5000, from: null }),
    entry({ seq: 44, kind: 'mail', id: 8, reply_to: 7, actor: { name: 'r'.repeat(100) } }),
    entry({ seq: 45, to: { address: 'nope' } }),
    entry({ seq: 'x' }),
    entry({ seq: 46, kind: 'wave' }),
    entry({ seq: 47, from: { address: 'nope' }, text: 'y'.repeat(500), at: NOW + 999 }),
    'junk',
  ], next: 47 }), NOW)
  assert.equal(next, 47)
  assert.deepEqual(talk.map((t) => t.seq), [42, 43, 44, 47])
  assert.deepEqual([talk[0].from?.alias, talk[0].to.id, talk[0].actor, talk[0].kind, talk[0].bytes, talk[0].id], ['review', '%5', 'reviewer', 'text', 13, 0])
  assert.deepEqual([talk[1].from, talk[1].text, talk[1].id, talk[1].bytes], [null, 'ab', 7, 5000])
  assert.deepEqual([talk[2].replyTo, talk[2].actor.length], [7, 32])
  assert.deepEqual([talk[3].from, talk[3].text.length, talk[3].at], [null, 200, NOW])
  assert.deepEqual(parseFeed('junk'), { talk: [], next: null })
  assert.deepEqual(parseFeed('{"next":"abc"}'), { talk: [], next: null })
  const many = JSON.stringify({ talk: Array.from({ length: 300 }, (_, i) => entry({ seq: i })), next: 300 })
  assert.equal(parseFeed(many, NOW).talk.length, 100)
})

test('parseMailbox: the mails with their origin, read time and reply; junk dropped, fifty kept', () => {
  const mail = (o: Record<string, unknown>) => ({ id: 7, at: NOW - 30, actor: { name: 'reviewer' }, from: { address: 'alice-laptop/work/1.0', pane_id: '%3', alias: 'review' }, text: 'run the tests', ...o })
  const box = parseMailbox(JSON.stringify({ mail: [
    mail({}),
    mail({ id: 8, read_at: NOW - 10, replied: true, from: null, text: 'x'.repeat(5000) + '\x07' }),
    mail({ id: 'nine' }),
    mail({ id: 10, read_at: 'soon', replied: 'yes', from: { address: 'bad' } }),
    null,
  ] }), NOW)
  assert.deepEqual(box.map((m) => m.id), [7, 8, 10])
  assert.deepEqual([box[0].from?.alias, box[0].readAt, box[0].replied, box[0].actor], ['review', 0, false, 'reviewer'])
  assert.deepEqual([box[1].from, box[1].readAt, box[1].replied, box[1].text.length], [null, NOW - 10, true, 4000])
  assert.deepEqual([box[2].from, box[2].readAt, box[2].replied], [null, 0, false])
  assert.deepEqual(parseMailbox('junk'), [])
  assert.deepEqual(parseMailbox('{"mail":{}}'), [])
  assert.equal(parseMailbox(JSON.stringify({ mail: Array.from({ length: 80 }, (_, i) => mail({ id: i })) }), NOW).length, 50)
})

test('parsePanes: talk partners and unread mail within their caps, junk ignored', () => {
  const partners = Array.from({ length: 40 }, (_, i) => ({ address: `alice-laptop/work/${i}.0`, pane_id: `%${i}`, at: NOW, way: 'to' }))
  const body = JSON.stringify({
    panes: [
      pane({ talk: [{ address: 'alice-laptop/work/1.0', pane_id: '%1', at: NOW, way: 'to' }, { address: 'alice-laptop/work/1.0' }, { address: 'bob-desktop/work/0.0', way: 'from' }], mail: { unread: 2, at: NOW } }),
      pane({ address: 'alice-laptop/work/1.0', talk: partners, mail: { unread: 1e9, at: NOW } }),
      pane({ address: 'alice-laptop/work/2.0', talk: [{ address: 'x'.repeat(300) }, { address: 'UPPER/x' }, 'alice-laptop/work/0.0', null], mail: { unread: -1 } }),
      pane({ address: 'alice-laptop/work/3.0', talk: 'alice-laptop/work/0.0', mail: { unread: '3' } }),
      pane({ address: 'alice-laptop/work/4.0', talk: { address: 'alice-laptop/work/0.0' }, mail: 5 }),
      pane({ address: 'alice-laptop/work/5.0', mail: { unread: 2.5 } }),
    ],
  })
  const panes = parsePanes(body, NOW)
  assert.equal(panes.length, 6)
  assert.deepEqual(panes[0].talk, ['alice-laptop/work/1.0', 'bob-desktop/work/0.0'])
  assert.equal(panes[0].mail, 2)
  assert.equal(panes[1].talk.length, 32)
  assert.equal(panes[1].mail, 999)
  assert.deepEqual(panes.slice(2).map((p) => [p.talk, p.mail]), [[[], 0], [[], 0], [[], 0], [[], 0]])
  // A pane without the fields is a pane without talk or mail.
  const plain = parsePanes(JSON.stringify({ panes: [pane({})] }), NOW)[0]
  assert.deepEqual([plain.talk, plain.mail], [[], 0])
})
