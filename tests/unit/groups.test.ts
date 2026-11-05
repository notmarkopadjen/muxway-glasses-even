// Groups from the listing's talk: partners of partners together, a lone
// pane out, the rows of a group pulled after its first member.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupsOf, pullTogether } from '../../src/groups.ts'
import type { Pane } from '../../src/protocol.ts'

function pane(path: string, talk: string[] = []): Pane {
  return { address: 'alice-laptop/' + path, host: 'alice-laptop', path, writable: true, command: 'bash', title: '', alias: '', cwd: '', agent: '', attention: '', attentionAt: 0, attentionText: '', choices: [], activity: 0, working: false, talk: talk.map((t) => 'alice-laptop/' + t), mail: 0, later: false, laterAt: 0, id: '', session: 'w', window: 0, width: 80, height: 24, last: false }
}

test('groupsOf joins partners of partners and numbers a group by its first member', () => {
  const panes = [pane('work/0.0'), pane('work/1.0', ['work/2.0']), pane('work/2.0', ['work/1.0', 'work/3.0']), pane('work/3.0'), pane('work/4.0', ['work/5.0']), pane('work/5.0')]
  const g = groupsOf(panes)
  assert.deepEqual([...g.entries()], [
    ['alice-laptop/work/1.0', 1],
    ['alice-laptop/work/2.0', 1],
    ['alice-laptop/work/3.0', 1],
    ['alice-laptop/work/4.0', 2],
    ['alice-laptop/work/5.0', 2],
  ])
})

test('a pane whose partners are not in the listing forms no group', () => {
  const g = groupsOf([pane('work/0.0', ['work/9.0']), pane('work/1.0')])
  assert.equal(g.size, 0)
  // One-sided talk is enough when both panes are listed.
  assert.equal(groupsOf([pane('work/0.0', ['work/1.0']), pane('work/1.0')]).size, 2)
})

test('pullTogether puts a group after its first member and leaves the rest in place', () => {
  const panes = [pane('work/0.0'), pane('work/1.0', ['work/3.0']), pane('work/2.0'), pane('work/3.0'), pane('work/4.0')]
  const rows = pullTogether(panes, groupsOf(panes))
  assert.deepEqual(rows.map((p) => p.path), ['work/0.0', 'work/1.0', 'work/3.0', 'work/2.0', 'work/4.0'])
  // Without groups nothing moves.
  assert.deepEqual(pullTogether(panes, new Map()).map((p) => p.path), panes.map((p) => p.path))
})

test('pullTogether keeps every row of a repeated address, grouped or not', () => {
  // A hostile listing may name one address five times; every row stays.
  const same = [pane('work/0.0'), pane('work/0.0'), pane('work/0.0')]
  assert.equal(pullTogether(same, new Map()).length, 3)
  const panes = [pane('work/0.0', ['work/2.0']), pane('work/1.0'), pane('work/2.0'), pane('work/0.0')]
  const rows = pullTogether(panes, groupsOf(panes))
  assert.deepEqual(rows.map((p) => p.path), ['work/0.0', 'work/2.0', 'work/0.0', 'work/1.0'])
})
