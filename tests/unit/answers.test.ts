import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ANSWERS, keysFor } from '../../src/answers.ts'
import { MAX_COMMANDS, commandsFor, isShell } from '../../src/commands.ts'
import { byteLength } from '../../src/text.ts'

const KEYS = ['Enter', 'Tab', 'BTab', 'BSpace', 'Escape', 'Up', 'Down', 'Left', 'Right', 'PageUp', 'PageDown', 'Home', 'End', 'C-c', 'C-d', 'C-z', 'C-l']

test('answers: only protocol keys and printable text, labels fit a row', () => {
  for (const a of ANSWERS) {
    assert.ok(byteLength(a.label) <= 63, a.label)
    for (const p of a.pieces) {
      if (p.key !== undefined) assert.ok(KEYS.includes(p.key), p.key)
      if (p.text !== undefined) assert.ok(/^[\x21-\x7e]{1,4}$/.test(p.text), p.text)
      assert.equal(p.key !== undefined || p.text !== undefined, true)
    }
  }
  assert.equal(ANSWERS.length, 8)
  assert.equal(ANSWERS[3].short, '1')
  assert.equal(ANSWERS[1].short, 'y, Enter')
  for (const a of ANSWERS) assert.ok(a.short.length > 0 && a.label.startsWith(a.short), a.label)
})

test('the keys list: the guideline\'s twelve on a host with the key grammar, six on an older one, every key the protocol\'s', () => {
  const all = keysFor(true)
  assert.deepEqual(all.map((k) => k.label), ['Up', 'Down', 'Left', 'Right', 'PageUp', 'PageDown', 'Home', 'End', 'Tab', 'Shift-Tab', 'Enter', 'Esc'])
  assert.deepEqual(keysFor(false).map((k) => k.label), ['Up', 'Down', 'Tab', 'Shift-Tab', 'Enter', 'Esc'])
  for (const k of all) {
    assert.equal(k.pieces.length, 1)
    assert.ok(KEYS.includes(k.pieces[0].key!), k.label)
    assert.equal('grammar' in k, false)
  }
})

test('the commands: by the hub\'s command only, twenty at most, each its text and Enter, the ones that fill the line left out', () => {
  const claude = commandsFor('claude')!
  assert.equal(claude.whose, "Claude Code's")
  assert.equal(claude.commands.length, MAX_COMMANDS)
  assert.deepEqual(claude.commands.slice(0, 3).map((c) => c.label), ['/clear', '/exit', '/compact'])
  assert.ok(!claude.commands.some((c) => c.label === '/rename'))
  assert.deepEqual(claude.commands[0].pieces, [{ text: '/clear' }, { key: 'Enter' }])
  assert.equal(commandsFor('codex')!.commands.length, 10)
  assert.ok(!commandsFor('codex')!.commands.some((c) => c.label === '/mention'))
  assert.ok(!commandsFor('agy')!.commands.some((c) => ['/plan', '/goal', '/rename', '/effort'].includes(c.label)))
  const shell = commandsFor('bash')!
  assert.equal(shell.whose, "the shell's")
  assert.equal(shell.commands.length, MAX_COMMANDS)
  assert.equal(shell.commands[0].label, 'exit')
  assert.equal(commandsFor('zsh')!.whose, "the shell's")
  assert.equal(commandsFor('python3'), null)
  assert.equal(commandsFor('node'), null)
  assert.equal(commandsFor(''), null)
  assert.equal(isShell('fish'), true)
  for (const row of [claude, shell, commandsFor('codex')!, commandsFor('agy')!]) for (const c of row.commands) assert.ok(/^[\x21-\x7e][\x20-\x7e]{0,30}$/.test(c.pieces[0].text!), c.label)
})
