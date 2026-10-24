import { test } from 'node:test'
import assert from 'node:assert/strict'
import { byteLength, clampBytes, clean, fitWidth, rows, textWidth, typed, wrapRow, wrapRows } from '../../src/text.ts'

test('widths: measured glyphs, wide shapes, unknown glyphs', () => {
  assert.equal(textWidth('ll'), 8)
  assert.equal(textWidth('★'), 20)
  assert.equal(textWidth('č'), 11)
  assert.equal(textWidth(''), 0)
})

test('fitWidth cuts with an ellipsis', () => {
  assert.equal(fitWidth('abc', 100), 'abc')
  const cut = fitWidth('a'.repeat(100), 110)
  assert.ok(cut.endsWith('…') && textWidth(cut) <= 110, cut)
})

test('wrapRow: at spaces, inside a word when it must, indentation kept', () => {
  assert.deepEqual(wrapRow('', 100), [''])
  assert.deepEqual(wrapRow('aaa bbb ccc', 60), ['aaa', 'bbb', 'ccc'])
  const long = wrapRow('x'.repeat(30), 110)
  assert.equal(long.join(''), 'x'.repeat(30))
  assert.ok(long.every((l) => textWidth(l) <= 110))
  assert.deepEqual(wrapRow('    code here', 200), ['    code here'])
  assert.deepEqual(wrapRow('ab  cd', 1000), ['ab  cd'])
  const rule = wrapRow('─'.repeat(400), 568)
  assert.equal(rule.length, Math.ceil(400 / 28))
  assert.ok(rule.every((l) => textWidth(l) <= 568))
})

test('wrapRows keeps empty rows', () => {
  assert.deepEqual(wrapRows(['', 'abc', ''], 100), ['', 'abc', ''])
})

test('bytes: clamp and count in UTF-8', () => {
  assert.equal(byteLength('★'), 3)
  assert.equal(clampBytes('abc', 63), 'abc')
  const c = clampBytes('★'.repeat(40), 63)
  assert.ok(byteLength(c) <= 63 && c.endsWith('…'))
})

test('clean drops control characters and spells tabs as spaces', () => {
  assert.equal(clean('a\x1b[31mb\x07\x00c\u2028d\te'), 'a[31mbcd e')
  assert.equal(clean('ok é ★'), 'ok é ★')
})

test('rows splits a body and drops the trailing newline only', () => {
  assert.deepEqual(rows('a\r\nb\n\nc\n'), ['a', 'b', '', 'c'])
  assert.deepEqual(rows(''), [''])
  assert.deepEqual(rows('\n'), [''])
})

test('typed removes control characters and caps at 4096 bytes', () => {
  assert.equal(typed('make\ntest\x1b'), 'maketest')
  assert.equal(byteLength(typed('ä'.repeat(3000))), 4096)
})

test('wrapRow handles a quarter-megabyte row in one pass', () => {
  const t0 = Date.now()
  const lines = wrapRow('x'.repeat(262144), 568)
  assert.ok(Date.now() - t0 < 2000, 'took ' + (Date.now() - t0) + ' ms')
  assert.equal(lines.join('').length, 262144)
  assert.ok(lines.every((l) => textWidth(l) <= 568))
})
