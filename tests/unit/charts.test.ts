import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Bitmap, G1, G3 } from '../../src/bitmap.ts'
import { barChart, sparkline, timelineChart } from '../../src/charts.ts'
import { tiles } from '../../src/raster.ts'
import type { Pane } from '../../src/protocol.ts'

test('bitmap: rect, frame, hatch and lines stay inside', () => {
  const b = new Bitmap(10, 6)
  b.rect(-5, -5, 100, 100, G3)
  assert.equal(b.lit, 60)
  const f = new Bitmap(10, 6)
  f.frame(0, 0, 10, 6, G1)
  assert.equal(f.lit, 28)
  const h = new Bitmap(10, 6)
  h.hatch(0, 0, 10, 6, G3)
  assert.equal(h.lit, 30)
  const l = new Bitmap(10, 6)
  l.line(0, 0, 9, 5, G3)
  assert.ok(l.lit >= 10 && l.lit <= 15)
  assert.equal(b.data().length, 60)
})

test('barChart: bar lengths follow the fraction, clamped', () => {
  const b = barChart([{ frac: 1 }, { frac: 0.5 }, { frac: 0 }, { frac: 7 }, { frac: NaN }], 100, 140, 28)
  const row = (i: number) => {
    const y = i * 28 + 14
    let n = 0
    for (let x = 0; x < 100; x++) if (b.d[y * 100 + x] === G3) n++
    return n
  }
  assert.equal(row(0), 94)
  assert.ok(Math.abs(row(1) - 47) <= 1)
  assert.equal(row(2), 0)
  assert.equal(row(3), 94)
  assert.equal(row(4), 0)
})

test('timelineChart: the marker sits where the entry arrived', () => {
  const b = timelineChart([{ at: 1 }, { at: 0 }], 100, 56, 28)
  const firstLit = (i: number) => {
    const y = i * 28 + 8
    for (let x = 0; x < 100; x++) if (b.d[y * 100 + x] === G3) return x
    return -1
  }
  assert.ok(firstLit(0) > 85)
  assert.equal(firstLit(1), 3)
})

test('sparkline draws something only with data', () => {
  assert.ok(sparkline([], 100, 40).lit <= 100)
  const s = sparkline(Array.from({ length: 50 }, (_, i) => Math.abs(Math.sin(i / 3))), 100, 40)
  assert.ok(s.lit > 150)
})

test('tiles: a wide picture is cut into containers the glasses accept', () => {
  const t = tiles(new Bitmap(560, 60), 8, 70, 'k')
  assert.equal(t.length, 2)
  assert.deepEqual(t.map((c) => [c.x, c.y, c.w, c.h]), [[8, 70, 280, 60], [288, 70, 280, 60]])
  assert.equal(tiles(new Bitmap(284, 30), 0, 0, 'k').length, 1)
})

