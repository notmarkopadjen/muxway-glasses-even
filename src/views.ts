// What every page says and draws, from the app's state: the pane list,
// the columns, the pane, the answers, the voice pages. Text from the top
// down, a hint at the foot, bordered boxes.

import { ANSWERS, type Answer } from './answers.ts'
import { sparkline } from './charts.ts'
import { HINT_Y, LINE_H, TOP, type Block, type MenuSpec, type Page } from './glasses.ts'
import { runsClaude, shapeClaude } from './lens.ts'
import { paneName, type Attention, type Host, type Pane } from './protocol.ts'
import { tiles, type Chart } from './raster.ts'
import { CANVAS_W, LINE_PX, byteLength, typed, wrapRows } from './text.ts'

export const MARK: Record<Attention | '', string> = { question: '★', permission: '★', done: '●', idle: '○', '': '·' }
export const WORDS: Record<Attention, string> = { question: 'asks a question', permission: 'needs permission', idle: 'idle', done: 'done' }
export const SAY_IT = '» Say it'

export const MENU = { refresh: 1, reveal: 2, bottom: 3, needsYou: 5, typeOnly: 6, sayAgain: 7 }

/** What the app holds and the pages read. */
export interface Model {
  configured: boolean
  panes: Pane[]
  hosts: Host[]
  listError: string | null
  needsYou: Pane | null
  flash: string | null
  toast: string | null
  lens: boolean
  canSpeak: boolean
  /** Whether a listing has arrived since the start. */
  loaded: boolean
  /** The dots after "reading the hub" while it has not, 1 to 3. */
  dots: number
  /** The panes held on the list, by address, at most three. */
  selected: string[]
  /** Selection mode: a tap on a row selects it instead of opening it. */
  selecting: boolean
  /** The list's cursor: the row a tap or a hold acts on. */
  cursor: number
  /** The list's first row on screen. */
  windowStart: number
  /** The column the last scroll opened, -1 for none. */
  marked: number
  reading: (address: string) => Reader | undefined
}

export interface Reader {
  raw: string[]
  error: string | null
}

// --- geometry ------------------------------------------------------------------------------
const TITLE_H = 30
const BODY_Y = TOP + TITLE_H
/** Lines of a pane under its title, down to the hint. */
const BODY_LINES = Math.floor((HINT_Y - BODY_Y) / LINE_H)
const COL_GAP = 8
const FOOT_Y = TOP + 140 + 6
const FOOT_H = HINT_Y - 6 - FOOT_Y
/** A bordered box of text from under the title down to the hint: the spoken reply, the suggestion. */
const BOX_W = LINE_PX - 16
const BOX_ROWS = Math.floor((HINT_Y - 4 - BODY_Y - 12) / LINE_H)

export function needs(p: Pane): boolean {
  return p.attention === 'question' || p.attention === 'permission'
}

/** Panes in the order every page uses: those that need you first, then by address. */
export function sorted(panes: Pane[]): Pane[] {
  const rank = (p: Pane) => (needs(p) ? 0 : p.attention ? 1 : 2)
  return panes.slice().sort((a, b) => rank(a) - rank(b) || a.address.localeCompare(b.address))
}

function hint(m: Model, base: string): Pick<Page, 'hint' | 'hintLevel' | 'hintBorder'> {
  if (m.toast) return { hint: m.toast, hintLevel: 4, hintBorder: true }
  if (m.listError) return { hint: m.listError, hintLevel: 4 }
  if (!m.configured) return { hint: 'set the hub and token on the phone', hintLevel: 4 }
  return { hint: base, hintLevel: 1 }
}

function footer(lines: string[]): Block {
  return { name: 'footer', x: 2, y: FOOT_Y, w: CANVAS_W - 4, h: FOOT_H, lines, level: 3 }
}

/** The pane's rows through the lens, wrapped to a width. Claude's input box is not drawn: what it holds is offered as an answer. */
export function shaped(p: Pane, raw: string[], widthPx: number, lens: boolean, reveal: boolean): string[] {
  const s = lens ? shapeClaude(raw, reveal, runsClaude(p.command)) : null
  return wrapRows(s ? s.body : raw, widthPx)
}

/** The most a suggestion may hold: the box on its confirmation shows it whole, or it is not offered. */
export const OFFER_BYTES = 200

/**
 * Claude's suggestion, from its input box, as an answer: the text and Enter. Null when the box is
 * empty, when the hub does not name the program claude (two rules in any shell's output are not a
 * box), or when the text would not fit its confirmation whole.
 */
export function offerOf(p: Pane, raw: string[], lens: boolean): Answer | null {
  if (!lens || !p.writable || !runsClaude(p.command) || !raw.length) return null
  const s = shapeClaude(raw, false, true)
  if (!s) return null
  const text = typed(
    s.pinned
      .map((r) => r.trim().replace(/^(❯|>)\s*/, ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
  if (!text || byteLength(text) > OFFER_BYTES || wrapRows([text], BOX_W).length > BOX_ROWS) return null
  const label = `"${text}"`
  return { label, short: label, pieces: [{ text }, { key: 'Enter' }] }
}

function ago(seconds: number, now: number): string {
  const d = Math.max(0, now - seconds)
  if (d < 60) return `${d}s`
  if (d < 3600) return `${Math.floor(d / 60)}m`
  if (d < 86400) return `${Math.floor(d / 3600)}h`
  return `${Math.floor(d / 86400)}d`
}

// --- the list: the main screen ---------------------------------------------------------

/** What a row says about the pane's state: the attention in words, else what its output says. */
export function stateWord(p: Pane, now: number): string {
  if (p.attention) return WORDS[p.attention]
  if (!p.activity) return ''
  return now - p.activity < 60 ? 'active' : `quiet ${ago(p.activity, now)}`
}

/** A pane's row; in selection mode it starts with its box, [x] or [ ]. */
export function rowLabel(p: Pane, now: number, box: 'none' | 'on' | 'off' = 'none'): string {
  const name = paneName(p)
  const word = stateWord(p, now)
  return (box === 'none' ? '' : box === 'on' ? '[x] ' : '[ ] ') + `${MARK[p.attention]} ${name}` + (p.command && p.command !== name ? ` · ${p.command}` : '') + (word ? ` · ${word}` : '') + (p.writable ? '' : ' · read-only')
}

/** Rows on the list at once: the page's eight text containers less the hint; the window slides under the cursor. */
export const LIST_ROWS = 7
/** The rows spread down to the hint, so no band is left dark under them. */
const ROW_PITCH = Math.floor((HINT_Y - TOP) / LIST_ROWS)
export const MAX_SELECTED = 3
const ROW_W = CANVAS_W - 4

export type ListItem = { kind: 'pane'; pane: Pane } | { kind: 'open' } | { kind: 'clear' } | { kind: 'none' }

/** Every row of the list and what each one is: the panes, then in selection mode its actions. */
export function listLayout(m: Model, now: number): { items: string[]; what: ListItem[] } {
  if (!m.configured) return { items: ['set the hub and token on the phone'], what: [{ kind: 'none' }] }
  if (!m.loaded) return { items: ['reading the hub…'], what: [{ kind: 'none' }] }
  if (!m.panes.length) return { items: ['no panes exposed to this token'], what: [{ kind: 'none' }] }
  const items: string[] = []
  const what: ListItem[] = []
  for (const p of m.panes) {
    items.push(rowLabel(p, now, m.selecting ? (m.selected.includes(p.address) ? 'on' : 'off') : 'none'))
    what.push({ kind: 'pane', pane: p })
  }
  const n = selectedPanes(m).length
  if (m.selecting) {
    if (n >= 2) {
      items.push(`→ open ${n} side by side`)
      what.push({ kind: 'open' })
    }
    items.push(n ? '→ clear selection' : '→ leave selection')
    what.push({ kind: 'clear' })
  }
  return { items, what }
}

/** The first row on screen: the window slides only when the cursor leaves it. */
export function listWindow(count: number, cursor: number, start: number): number {
  let s = Math.max(0, Math.min(start, count - LIST_ROWS))
  if (cursor < s) s = cursor
  if (cursor >= s + LIST_ROWS) s = cursor - LIST_ROWS + 1
  return Math.max(0, s)
}

/** The selected panes in the list's order; a pane that left the listing is not among them. */
export function selectedPanes(m: Model): Pane[] {
  return m.panes.filter((p) => m.selected.includes(p.address))
}

/**
 * The list is drawn by the app, not the OS: a page without a list container hands its scrolls
 * and its long press to the app, which is how a row can be held. The cursor's row is brightest;
 * every row is one block with its geometry fixed, so moving the cursor is an upgrade, not a rebuild.
 */
export function listPage(m: Model, now: number): Page {
  const { items } = listLayout(m, now)
  const cursor = Math.max(0, Math.min(items.length - 1, m.cursor))
  const start = listWindow(items.length, cursor, m.windowStart)
  const blocks: Block[] = []
  for (let i = 0; i < LIST_ROWS; i++) {
    const at = start + i
    // The cursor is a mark, not only a brightness: on the glasses the brightest row alone was missed.
    const text = items[at] === undefined ? ' ' : (at === cursor && m.loaded ? '> ' : '  ') + items[at]
    blocks.push({ name: 'row' + at, x: 2, y: TOP + i * ROW_PITCH, w: ROW_W, h: ROW_PITCH, lines: [text], level: at === cursor && m.loaded ? 4 : 3 })
  }
  // Where the window sits, in words: the glasses refused a thin bar drawn as a picture.
  const where = items.length > LIST_ROWS ? `${start + 1}–${Math.min(items.length, start + LIST_ROWS)} of ${items.length} · ` : ''
  const offline = m.hosts.filter((h) => !h.online).map((h) => `○ ${h.name} offline · `).join('')
  const base = !m.loaded
    ? 'reading the hub ' + '·'.repeat(Math.max(1, Math.min(3, m.dots)))
    : offline + where + (m.selecting ? `▽ move · ● select · ${MAX_SELECTED} at most · ×× done` : '▽ move · ● open · hold to select · ×× exit')
  return { kind: 'dash', ...hint(m, base), blocks, charts: [], items: [], menu: [] }
}

// --- side by side -------------------------------------------------------------------------

export function splitPage(m: Model): Page {
  const shown = selectedPanes(m)
  const columns = Math.max(2, shown.length)
  const colW = Math.floor((CANVAS_W - COL_GAP * (columns - 1)) / columns)
  const blocks: Block[] = []
  shown.forEach((p, i) => {
    const x = i * (colW + COL_GAP)
    const chosen = i === m.marked
    const title = `${chosen ? '» ' : ''}${MARK[p.attention]} ${paneName(p)} · ${p.command}`
    blocks.push({ name: 'title' + i, x, y: TOP, w: colW, h: TITLE_H, lines: [title], level: chosen ? 4 : 2 })
    const r = m.reading(p.address)
    let text: string[]
    if (r?.error) text = [r.error]
    else if (!r || !r.raw.length) text = ['reading…']
    else {
      text = shaped(p, r.raw, colW - 4, m.lens, false).slice(-BODY_LINES)
      while (text.length < BODY_LINES) text.unshift('')
    }
    blocks.push({ name: 'col' + i, x, y: BODY_Y, w: colW, h: BODY_LINES * LINE_H, lines: text, level: chosen ? 4 : 2 })
  })
  if (!shown.length) blocks.push(footer(['the selected panes are gone', m.listError ?? '']))
  const sel = m.marked >= 0 ? shown[m.marked] : undefined
  const base = sel ? `▽ next pane · ● open ${paneName(sel)} · ×× the list` : '▽ pick a pane · ● refresh · ×× the list'
  const menu: MenuSpec[] = [{ id: MENU.refresh, label: 'Refresh' }]
  if (m.needsYou) menu.push({ id: MENU.needsYou, label: 'Go to: ' + paneName(m.needsYou) })
  return { kind: 'dash', ...hint(m, base), blocks, charts: [], items: [], menu }
}

// --- the pane -----------------------------------------------------------------------------

export interface PaneState {
  offset: number
  reveal: boolean
  state: string
}

const TITLE_W = 376
const BODY_W = CANVAS_W - 4

export function panePage(m: Model, p: Pane, r: Reader | undefined, st: PaneState): Page {
  const title = `${MARK[p.attention]} ${paneName(p)} · ${p.command || '?'}`
  const blocks: Block[] = []
  blocks.push({ name: 'title', x: 0, y: TOP, w: TITLE_W, h: TITLE_H, lines: [title], level: 4 })
  blocks.push({ name: 'state', x: TITLE_W + 8, y: TOP, w: CANVAS_W - TITLE_W - 8, h: TITLE_H, lines: [st.state], level: 2 })
  const body = r && r.raw.length ? shaped(p, r.raw, BODY_W - 4, m.lens, st.reveal) : []
  const end = body.length - st.offset * BODY_LINES
  const lines = body.slice(Math.max(0, end - BODY_LINES), Math.max(0, end))
  while (lines.length < BODY_LINES) lines.unshift('')
  blocks.push({ name: 'body', x: 0, y: BODY_Y, w: BODY_W, h: BODY_LINES * LINE_H, lines, level: 3 })
  const menu: MenuSpec[] = [{ id: MENU.refresh, label: 'Refresh' }]
  if (m.lens) menu.push({ id: MENU.reveal, label: st.reveal ? 'Lens on' : 'Reveal all' })
  menu.push({ id: MENU.bottom, label: 'Bottom' })
  if (m.needsYou && m.needsYou.address !== p.address) menu.push({ id: MENU.needsYou, label: 'Go to: ' + paneName(m.needsYou) })
  return {
    kind: 'dash',
    ...hint(m, `▽ page · ● ${p.writable ? 'answer' : 'refresh'} · ≡ menu · ×× back`),
    blocks,
    charts: [],
    items: [],
    menu,
  }
}

/** How many lines of the pane a page shows, for paging. */
export function pageSize(p: Pane, r: Reader | undefined, lens: boolean, reveal: boolean): { size: number; total: number } {
  const body = r && r.raw.length ? shaped(p, r.raw, BODY_W - 4, lens, reveal) : []
  return { size: BODY_LINES, total: body.length }
}

// --- answers ------------------------------------------------------------------------------

/** The answers: Claude's suggestion first when there is one, then Say it, then the fixed set. */
export function answersPage(m: Model, p: Pane, offer: Answer | null, offerVoice: boolean): Page {
  const items = (offer ? ['» ' + offer.label] : []).concat(offerVoice ? [SAY_IT] : [], ANSWERS.map((a) => a.label))
  return { kind: 'list', ...hint(m, `answer ${paneName(p)} · ▽ choose · ● pick · ×× back`), blocks: [], charts: [], items, menu: [] }
}

export function confirmPage(m: Model, p: Pane, a: Answer): Page {
  return {
    kind: 'list',
    ...hint(m, `send ${a.short} to ${paneName(p)}? · ×× back`),
    blocks: [],
    charts: [],
    items: ['Cancel', 'Confirm'],
    menu: [],
  }
}

function textBox(text: string): Block {
  const lines = wrapRows([text], BOX_W).slice(0, BOX_ROWS)
  return { name: 'text', x: 0, y: BODY_Y, w: CANVAS_W, h: BOX_ROWS * LINE_H + 12, lines, level: 4, border: true }
}

/** The suggestion's confirmation: every word that will be sent, in a box; a tap sends it. */
export function offerPage(m: Model, p: Pane, a: Answer): Page {
  const text = a.pieces[0]?.text ?? ''
  const blocks: Block[] = [{ name: 'title', x: 0, y: TOP, w: CANVAS_W, h: TITLE_H, lines: [`send this to ${paneName(p)}?`], level: 4 }, textBox(text)]
  return { kind: 'dash', ...hint(m, '● send + Enter · ×× back'), blocks, charts: [], items: [], menu: [] }
}

// --- spoken replies -------------------------------------------------------------------------

export interface VoiceView {
  phase: 'recording' | 'working' | 'review' | 'error'
  seconds: number
  text: string
  error: string
  levels: number[]
}

const GRAPH_H = 60
const GRAPH_W = 560

export function listenPage(m: Model, p: Pane, v: VoiceView): Page {
  const blocks: Block[] = []
  const charts: Chart[] = []
  const name = paneName(p)
  if (v.phase === 'recording') {
    blocks.push({ name: 'state', x: 0, y: TOP, w: CANVAS_W, h: TITLE_H, lines: [`● listening · ${Math.round(v.seconds)} s · ${name}`], level: 4 })
    const graph = sparkline(v.levels, GRAPH_W, GRAPH_H)
    charts.push(...tiles(graph, 8, BODY_Y, `levels:${v.levels.length}:${v.levels.slice(-6).map((l) => Math.round(l * 20)).join(',')}`))
    blocks.push({ name: 'note', x: 8, y: BODY_Y + GRAPH_H + 24, w: CANVAS_W - 16, h: LINE_H * 2, lines: [`${Math.round(v.seconds)} of 60 s · tap when done`, 'what you say goes to your hub, then to its transcriber'], level: 2 })
    return { kind: 'dash', ...hint(m, '● stop · ×× cancel'), blocks, charts, items: [], menu: [] }
  }
  if (v.phase === 'working') {
    blocks.push({ name: 'state', x: 0, y: TOP, w: CANVAS_W, h: TITLE_H, lines: [`transcribing ${v.seconds.toFixed(1)} s of audio…`], level: 4 })
    blocks.push({ name: 'note', x: 8, y: BODY_Y, w: CANVAS_W - 16, h: LINE_H * 2 + 12, lines: ['the hub is listening to it', 'a few seconds on a small server'], level: 2, border: true })
    return { kind: 'dash', ...hint(m, '×× cancel'), blocks, charts, items: [], menu: [] }
  }
  blocks.push({ name: 'state', x: 0, y: TOP, w: CANVAS_W, h: TITLE_H, lines: [v.error || 'nothing recorded'], level: 4 })
  blocks.push({ name: 'note', x: 8, y: BODY_Y, w: CANVAS_W - 16, h: LINE_H + 12, lines: ['tap to say it again'], level: 2, border: true })
  return { kind: 'dash', ...hint(m, '● say it again · ×× cancel'), blocks, charts, items: [], menu: [] }
}

export function heardPage(m: Model, p: Pane, v: VoiceView): Page {
  const blocks: Block[] = []
  blocks.push({ name: 'title', x: 0, y: TOP, w: CANVAS_W, h: TITLE_H, lines: [`heard this · ${v.seconds.toFixed(1)} s · for ${paneName(p)}`], level: 4 })
  blocks.push(textBox(v.text))
  const menu: MenuSpec[] = [{ id: MENU.typeOnly, label: 'Type without Enter' }, { id: MENU.sayAgain, label: 'Say it again' }]
  return { kind: 'dash', ...hint(m, '● send + Enter · ≡ menu · ×× cancel'), blocks, charts: [], items: [], menu }
}
