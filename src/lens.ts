// The Claude Code lens, as in the Java ME client: Claude Code ends its
// screen with chrome (the summary of the last turn, notices on the
// right, a rule that may carry the session name, the input box, a rule
// and a footer). On the glasses only the conversation is wanted: the
// chrome waits until revealed, and what the box holds, Claude's
// suggestion, is offered as the first answer.

export interface Shaped {
  body: string[]
  pinned: string[]
}

const MARKS = '✻✽✶✢✦✧·*'

export function runsClaude(command: string): boolean {
  return command === 'claude'
}

/**
 * Null when the rows are not Claude Code's screen. Forced, the lens does
 * its best with any rows and answers null only when there is nothing to
 * pin.
 */
export function shapeClaude(rows: string[], reveal: boolean, forced: boolean): Shaped | null {
  let below = -1
  let above = -1
  for (let i = rows.length - 1; i >= 0 && above < 0; i--) {
    // The bottom rule is clean; the one above it may carry the session name.
    if (isRule(rows[i], below >= 0)) {
      if (below < 0) below = i
      else above = i
    }
  }
  if (above < 0) return forced ? prompt(rows, reveal) : null
  const first = chrome(rows, above)
  if (reveal) return { body: revealed(rows, first, above, below), pinned: [] }
  const pinned = isEmpty(rows, above + 1, below) ? [] : rows.slice(above + 1, below)
  return { body: transcript(rows, first), pinned }
}

/** Without rules, the last prompt row near the bottom is the box and what follows it is footer. */
function prompt(rows: string[], reveal: boolean): Shaped | null {
  let box = -1
  for (let i = rows.length - 1; i >= 0 && i >= rows.length - 8 && box < 0; i--) {
    if (rows[i].startsWith('❯') || rows[i].startsWith('> ') || rows[i] === '>') box = i
  }
  if (box < 0) return null
  const first = chrome(rows, box)
  if (reveal) return { body: revealed(rows, first, -1, -1), pinned: [] }
  return { body: transcript(rows, first), pinned: isEmpty(rows, box, box + 1) ? [] : [rows[box]] }
}

/** Where the chrome starts above row at: blank rows and right-aligned notices, then the summary of the last turn. */
function chrome(rows: string[], at: number): number {
  let first = at
  while (first > 0 && (rows[first - 1].length === 0 || rows[first - 1].startsWith('        '))) first--
  if (first > 0 && isSummary(rows[first - 1])) first--
  return first
}

/** The rows before the chrome, without the blank rows Claude fills a tall terminal with. */
function transcript(rows: string[], first: number): string[] {
  let end = first
  while (end > 0 && rows[end - 1].length === 0) end--
  return rows.slice(0, end)
}

/** Everything in place but the rules (-1 for none) and the blank rows around the chrome; notices lose their alignment. */
function revealed(rows: string[], first: number, above: number, below: number): string[] {
  let end = first
  while (end > 0 && rows[end - 1].length === 0) end--
  const out: string[] = []
  for (let i = 0; i < rows.length; i++) {
    if (i === above || i === below || (i >= end && rows[i].length === 0)) continue
    out.push(i >= first && rows[i].startsWith('        ') ? rows[i].trim() : rows[i])
  }
  return out
}

/** True when the box rows hold nothing but the prompt mark, or Claude's own hint (Try "..."). */
function isEmpty(rows: string[], from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    let r = rows[i].trim()
    if (r.startsWith('❯') || r.startsWith('>')) r = r.slice(1).trim()
    if (r.length > 0 && !(i === from && r.startsWith('Try "'))) return false
  }
  return true
}

/** The summary of the last turn: a spinner mark, then a duration such as 58s or 5m 27s. */
export function isSummary(s: string): boolean {
  if (s.length < 3 || s[1] !== ' ' || !MARKS.includes(s[0])) return false
  return /\d+[sm](?![a-z])/.test(s.slice(2))
}

/**
 * A row of horizontal lines: three or more line characters, or twenty
 * dashes once the hub spelt them in ASCII. Loose, text up to half as long
 * as the line is allowed, which is how Claude writes the session name
 * into its top rule.
 */
export function isRule(s: string, loose = false): boolean {
  let lines = 0
  let dashes = 0
  let other = 0
  for (const c of s) {
    if (c === '─' || c === '━' || c === '═') lines++
    else if (c === '-' || c === '=') dashes++
    else if (c !== ' ') other++
  }
  if (other > 0 && (!loose || other * 2 > lines + dashes)) return false
  return lines >= 3 || (lines === 0 && dashes >= 20)
}
