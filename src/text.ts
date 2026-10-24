// Text for a 576 px wide display with one proportional font: measured
// glyph widths, wrapping and fitting by pixels, clamping by bytes, and the
// filters everything from the network goes through before it is shown.

export const CANVAS_W = 576
/** The widest line a full-width block shows without wrapping inside the firmware. */
export const LINE_PX = CANVAS_W - 8

// Advance widths of the firmware font in px, measured glyph by glyph on
// the simulator. A line is the sum of its glyphs.
const ADVANCE: Record<string, number> = {}
for (const [px, chars] of [
  [0, '`'],
  [4, "!':l|"],
  [5, ' ,./;I\\ij·’'],
  [6, '"()t'],
  [7, '1[]fr'],
  [8, '*J{}“”'],
  [9, 'L_kz•'],
  [10, '+-<=>EFT^ceos…×é'],
  [11, '2CSabdghnpquvxy'],
  [12, '03456789$?BDGHKNOPQRUZ»'],
  [13, 'AVXY'],
  [14, '#%'],
  [15, '&w—–€'],
  [16, 'MWm~'],
  [17, '@→'],
  [19, '│'],
] as const) {
  for (const ch of chars) ADVANCE[ch] = px
}

const WIDE = /[←-⯿]/

export function charWidth(ch: string): number {
  return ADVANCE[ch] ?? (WIDE.test(ch) ? 20 : 11)
}

export function textWidth(s: string): number {
  let w = 0
  for (const ch of s) w += charWidth(ch)
  return w
}

/** Cuts from the right until the line fits, with an ellipsis when it had to. */
export function fitWidth(s: string, maxPx: number): string {
  if (textWidth(s) <= maxPx) return s
  const chars = [...s]
  while (chars.length && textWidth(chars.join('')) > maxPx - 10) chars.pop()
  return chars.join('').trimEnd() + '…'
}

/**
 * Wraps one terminal row to the width: at spaces where it can, inside a
 * word where it must, so a long path or a rule loses nothing. The row's
 * indentation is kept on its first line. One pass over the glyphs, since
 * a hostile row can be as long as the whole body.
 */
export function wrapRow(row: string, maxPx: number): string[] {
  if (row.length === 0) return ['']
  const out: string[] = []
  let line = ''
  let width = 0
  const flush = () => {
    out.push(line.replace(/ +$/, ''))
    line = ''
    width = 0
  }
  for (const word of row.split(/(?<= )/)) {
    const ww = textWidth(word)
    if (width + ww <= maxPx) {
      line += word
      width += ww
      continue
    }
    if (line.trim().length > 0) flush()
    if (ww <= maxPx) {
      line = word
      width = ww
      continue
    }
    for (const ch of word) {
      const cw = charWidth(ch)
      if (width + cw > maxPx && line.length > 0) flush()
      line += ch
      width += cw
    }
  }
  if (line.length > 0 || out.length === 0) flush()
  return out
}

export function wrapRows(rows: string[], maxPx: number): string[] {
  const out: string[] = []
  for (const r of rows) out.push(...wrapRow(r, maxPx))
  return out
}

const encoder = new TextEncoder()

export function byteLength(s: string): number {
  return encoder.encode(s).length
}

/** Cuts to at most maxBytes of UTF-8, with an ellipsis when it had to. */
export function clampBytes(s: string, maxBytes: number): string {
  if (byteLength(s) <= maxBytes) return s
  let out = ''
  for (const ch of s) {
    if (byteLength(out + ch + '…') > maxBytes) break
    out += ch
  }
  return out + '…'
}

/** Drops control characters: C0, DEL, C1 and the line and paragraph separators. Tabs become a space. */
export function clean(s: string): string {
  return s.replace(/\t/g, ' ').replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]/g, '')
}

/** The rows of a text-mode body, each cleaned. A trailing newline ends the last row, it is not an extra one. */
export function rows(body: string): string[] {
  const text = body.replace(/\r/g, '')
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines.map(clean)
}

/** What the phone typed, as the hub takes it: no control characters, at most 4096 bytes. */
export function typed(s: string): string {
  let out = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '')
  while (byteLength(out) > 4096) out = out.slice(0, -1)
  return out
}
