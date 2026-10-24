// Charts are bitmaps pushed into image containers; the labels live in
// text containers beside them on the same row pitch. The glasses have
// no drawable font, so a chart is bars, ticks and rules only.

import { Bitmap, G1, G2, G3 } from './bitmap.ts'

export interface BarRow {
  /** Solid part, 0 to 1 of the width. */
  frac: number
  /** One grey down: present but not the point. */
  dim?: boolean
}

const PAD = 3

function clampFrac(n: number | null | undefined): number {
  if (n == null || !isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

/** Horizontal bars on a dashed track, one per row, on the label column's pitch. */
export function barChart(rows: BarRow[], w: number, h: number, pitch: number): Bitmap {
  const b = new Bitmap(w, h)
  const bh = Math.max(6, pitch - 12)
  rows.forEach((r, i) => {
    const y = i * pitch + Math.round((pitch - bh) / 2)
    if (y + bh > h) return
    const track = w - PAD * 2
    b.dashes(PAD, y + Math.floor(bh / 2), track, G1)
    const solid = clampFrac(r.frac) * track
    if (solid >= 1) b.rect(PAD, y, solid, bh, r.dim ? G2 : G3)
  })
  return b
}

export interface TimelineRow {
  /** Where the row's entry arrived, 0 to 1 of the span, 1 being now. */
  at: number
  dim?: boolean
}

const DOT = 4

/** A marker per row at the moment its entry arrived; the distance to the right edge is the wait. */
export function timelineChart(rows: TimelineRow[], w: number, h: number, pitch: number, ticks: number[] = []): Bitmap {
  const b = new Bitmap(w, h)
  const bh = Math.max(6, pitch - 12)
  const track = w - PAD * 2
  for (const t of ticks) {
    const x = Math.round(PAD + clampFrac(t) * track)
    for (let y = 0; y < h; y += 3) b.px(x, y, G1)
  }
  b.vline(PAD + track - 1, 0, h, G2)
  rows.forEach((r, i) => {
    const y = i * pitch + Math.round((pitch - bh) / 2)
    if (y + bh > h) return
    b.dashes(PAD, y + Math.floor(bh / 2), track, G1)
    const x = Math.round(PAD + Math.min(track - DOT, clampFrac(r.at) * track))
    b.rect(x, y, DOT, bh, r.dim ? G2 : G3)
    // The wait itself, as a thin line from the marker to now.
    b.hline(x + DOT, y + Math.floor(bh / 2), track - (x - PAD) - DOT, G2)
  })
  return b
}

/** A short history as a line, the newest at the right edge, with a baseline. */
export function sparkline(values: number[], w: number, h: number): Bitmap {
  const b = new Bitmap(w, h)
  b.hline(0, h - 1, w, G1)
  const n = values.length
  if (n < 3) return b
  const hi = Math.max(...values, 0.05) * 1.25
  const yOf = (v: number) => 1 + (1 - v / hi) * (h - 4)
  let prev: number | null = null
  for (let x = 0; x < w; x++) {
    const t = (x / (w - 1)) * (n - 1)
    const i = Math.min(n - 2, Math.floor(t))
    const y = yOf(values[i] + (values[i + 1] - values[i]) * (t - i))
    if (x % 8 === 0) for (let yy = Math.round(y) + 6; yy < h - 2; yy += 6) b.px(x, yy, G1)
    if (prev == null) b.px(x, Math.round(y), G3)
    else b.line(x - 1, prev, x, y, G3)
    b.px(x, Math.round(y) + 1, G2)
    prev = y
  }
  b.rect(w - 3, Math.round(prev ?? 0) - 1, 3, 3, G3)
  return b
}
