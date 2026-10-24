import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ANSWERS, short } from '../../src/answers.ts'
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
  assert.equal(ANSWERS.length <= 19, true)
  assert.equal(short(ANSWERS[3]), '1')
  assert.equal(short(ANSWERS[1]), 'y, Enter')
})
