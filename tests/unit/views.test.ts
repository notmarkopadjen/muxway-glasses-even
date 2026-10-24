// The list's rows and layout, and the columns' mark: what the glasses say
// about a pane is only what the hub said or what its output shows.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Pane } from '../../src/protocol.ts'
import { LIST_ROWS, listLayout, listWindow, rowLabel, selectedPanes, sorted, stateWord, statusHead, type Model } from '../../src/views.ts'

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
    clock: '16:51',
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

test('before the first listing: one row and the dots in the head', () => {
  const m = model([], { loaded: false, dots: 2 })
  assert.deepEqual(listLayout(m, NOW).items, ['reading the hub…'])
  assert.equal(listLayout(m, NOW).what[0].kind, 'none')
  assert.equal(statusHead(m), 'reading the hub ··')
  assert.equal(statusHead(model([pane('w/0.0', { attention: 'question' })])), '★ 1  ≡ 1  ● alice-laptop  16:51')
  assert.deepEqual(listLayout(model([], { configured: false }), NOW).items, ['set the hub and token on the phone'])
  assert.deepEqual(listLayout(model([]), NOW).items, ['no panes exposed to this token'])
})
