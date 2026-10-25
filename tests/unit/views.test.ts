// The list's rows and layout, and the columns' mark: what the glasses say
// about a pane is only what the hub said or what its output shows.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Pane } from '../../src/protocol.ts'
import { HINT_Y, LINE_H } from '../../src/glasses.ts'
import { LIST_ROWS, answersPage, listLayout, listPage, listWindow, offerOf, panePage, rowLabel, selectedPanes, sorted, splitPage, stateWord, type Model } from '../../src/views.ts'

const NOW = 1_000_000

function pane(path: string, extra: Partial<Pane> = {}): Pane {
  return { address: 'alice-laptop/' + path, host: 'alice-laptop', path, writable: true, command: 'claude', title: '', alias: '', attention: '', attentionAt: 0, attentionText: '', activity: NOW - 10, ...extra }
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
  // A time ahead of now is clamped by the parser; here it must not go negative either.
  assert.equal(stateWord(pane('a/0.0', { activity: NOW + 500 }), NOW), 'active')
})

test('a row: mark, name, program, state, read-only, and the selection prefix', () => {
  assert.equal(rowLabel(pane('work/0.0', { title: 'build', attention: 'question' }), NOW), '★ build · claude · asks a question')
  assert.equal(rowLabel(pane('work/0.0', { title: 'build', activity: NOW - 240 }), NOW, 'on'), '[x] · build · claude · quiet 4m')
  assert.equal(rowLabel(pane('work/0.0', { title: 'build' }), NOW, 'off'), '[ ] · build · claude · active')
  assert.equal(rowLabel(pane('work/0.0', { command: 'bash', writable: false }), NOW), '· work/0.0 · bash · active · read-only')
})

test('the layout: panes, then in selection mode the actions', () => {
  const panes = [pane('w/1.0', { title: 'one' }), pane('w/2.0', { title: 'two' }), pane('w/3.0', { title: 'three' })]
  let l = listLayout(model(panes), NOW)
  assert.deepEqual(l.what.map((w) => w.kind), ['pane', 'pane', 'pane'])
  l = listLayout(model(panes, { selected: ['alice-laptop/w/2.0'] }), NOW)
  assert.deepEqual(l.what.map((w) => w.kind), ['pane', 'pane', 'pane'], 'actions outside selection mode')
  l = listLayout(model(panes, { selected: ['alice-laptop/w/2.0'], selecting: true }), NOW)
  assert.deepEqual(l.what.map((w) => w.kind), ['pane', 'pane', 'pane', 'clear'])
  assert.equal(l.items[1], '[x] · two · claude · active')
  assert.equal(l.items[0], '[ ] · one · claude · active')
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
  assert.deepEqual(answersPage(model([p]), p, offer, true).items.slice(0, 3), ['» "run the tests again"', '» Say it', 'Enter'])
  assert.equal(offerOf(p, ['a', '────────', '❯ ', '────────'], true), null)
  assert.equal(offerOf(p, ['a', '────────', '❯ Try "fix the bug"', '────────'], true), null)
  assert.equal(offerOf(pane('w/1.0', { writable: false }), CLAUDE, true), null)
  assert.equal(offerOf(p, CLAUDE, false), null)
  // A box over several rows is one line; control characters never reach the text sent.
  const long = offerOf(p, ['a', '────────', '❯ one\u001b[31m', '  two\u0007', '────────'], true)!
  assert.equal(long.pieces[0].text, 'one[31m two')
})

test('the columns: text titles, the mark, eight lines', () => {
  const panes = [pane('w/1.0', { title: 'one' }), pane('w/2.0', { title: 'two' })]
  const reading = { raw: Array.from({ length: 40 }, (_, i) => String(i)), error: null }
  const sel = ['alice-laptop/w/1.0', 'alice-laptop/w/2.0']
  let page = splitPage(model(panes, { selected: sel, reading: () => reading }))
  assert.equal(page.charts.length, 0)
  assert.deepEqual(page.blocks.filter((b) => b.name?.startsWith('title')).map((b) => b.lines[0]), ['· one · claude', '· two · claude'])
  assert.equal(page.blocks.find((b) => b.name === 'col0')!.lines.length, 8)
  assert.equal(page.hint, '▽ pick a pane · ● refresh · ×× the list')
  page = splitPage(model(panes, { selected: sel, marked: 1, reading: () => reading }))
  assert.equal(page.blocks.find((b) => b.name === 'title1')!.lines[0], '» · two · claude')
  assert.equal(page.hint, '▽ next pane · ● open two · ×× the list')
})
