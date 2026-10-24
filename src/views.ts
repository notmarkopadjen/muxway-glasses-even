// What every page says and draws, from the app's state: the pane list,
// the columns, the pane, the answers, the voice pages. A status line on
// top, a hint at the foot, bold title bands, bordered boxes.

import { ANSWERS, short, type Answer } from './answers.ts'
import { positionBar, progressBar, sparkline } from './charts.ts'
import { HINT_Y, LINE_H, TOP, type Block, type MenuSpec, type Page } from './glasses.ts'
import { runsClaude, shapeClaude } from './lens.ts'
import { paneName, type Attention, type Host, type Pane } from './protocol.ts'
import { MAX_IMG_H } from './bitmap.ts'
import { BAND_H, band, tiles, type Chart } from './raster.ts'
import { CANVAS_W, LINE_PX, textWidth, wrapRows } from './text.ts'

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
  clock: string
  lens: boolean
  canSpeak: boolean
  /** Whether a listing has arrived since the start. */
  loaded: boolean
  /** The dots after "reading the hub" while it has not, 1 to 3. */
  dots: number
  /** The panes held on the list, by address, at most three. */
  selected: string[]
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
const BODY_Y = TOP + BAND_H + 4
const COL_GAP = 8
const BAR_W = 8
const FOOT_Y = TOP + 140 + 6
const FOOT_H = HINT_Y - 6 - FOOT_Y

export function needs(p: Pane): boolean {
  return p.attention === 'question' || p.attention === 'permission'
}

/** Panes in the order every page uses: those that need you first, then by address. */
export function sorted(panes: Pane[]): Pane[] {
  const rank = (p: Pane) => (needs(p) ? 0 : p.attention ? 1 : 2)
  return panes.slice().sort((a, b) => rank(a) - rank(b) || a.address.localeCompare(b.address))
}

/** The status line, the same on every page: panes that need you, panes in all, the host, the clock. */
export function statusHead(m: Model): string {
  if (m.configured && !m.loaded) return 'reading the hub ' + '·'.repeat(Math.max(1, Math.min(3, m.dots)))
  const n = m.panes.filter(needs).length
  const line = (gap: string) => [`★ ${n}`, `≡ ${m.panes.length}`, m.hosts[0] ? `${m.hosts[0].online ? '●' : '○'} ${m.hosts[0].name}` : '○ no host', m.clock].join(gap)
  const wide = line('  ')
  return textWidth(wide) <= CANVAS_W - 32 ? wide : line(' ')
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

/** The pane's rows through the lens, wrapped to a width: the body and the pinned box. */
export function shaped(p: Pane, raw: string[], widthPx: number, lens: boolean, reveal: boolean): { body: string[]; pinned: string[] } {
  const s = lens ? shapeClaude(raw, reveal, runsClaude(p.command)) : null
  return { body: wrapRows(s ? s.body : raw, widthPx), pinned: s ? wrapRows(s.pinned, widthPx) : [] }
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

export function rowLabel(p: Pane, now: number, selected = false): string {
  const name = paneName(p)
  const word = stateWord(p, now)
  return (selected ? '» ' : '') + `${MARK[p.attention]} ${name}` + (p.command && p.command !== name ? ` · ${p.command}` : '') + (word ? ` · ${word}` : '') + (p.writable ? '' : ' · read-only')
}

/** Rows on the list at once: the page's eight text containers less the head and the hint; the window slides under the cursor. */
export const LIST_ROWS = 6
export const MAX_SELECTED = 3
const ROW_W = CANVAS_W - BAR_W - 8

export type ListItem = { kind: 'pane'; pane: Pane } | { kind: 'open' } | { kind: 'clear' } | { kind: 'none' }

/** Every row of the list and what each one is: the panes, then the selection's actions. */
export function listLayout(m: Model, now: number): { items: string[]; what: ListItem[] } {
  if (!m.configured) return { items: ['set the hub and token on the phone'], what: [{ kind: 'none' }] }
  if (!m.loaded) return { items: ['reading the hub…'], what: [{ kind: 'none' }] }
  if (!m.panes.length) return { items: ['no panes exposed to this token'], what: [{ kind: 'none' }] }
  const items: string[] = []
  const what: ListItem[] = []
  for (const p of m.panes) {
    items.push(rowLabel(p, now, m.selected.includes(p.address)))
    what.push({ kind: 'pane', pane: p })
  }
  const n = selectedPanes(m).length
  if (n >= 2) {
    items.push(`→ open ${n} side by side`)
    what.push({ kind: 'open' })
  }
  if (n >= 1) {
    items.push('→ clear selection')
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
    const text = items[at] ?? ' '
    blocks.push({ name: 'row' + at, x: 2, y: TOP + i * LINE_H, w: ROW_W, h: LINE_H, lines: [text], level: at === cursor && m.loaded ? 4 : 3 })
  }
  const bar = positionBar(items.length, Math.max(0, items.length - start - LIST_ROWS), LIST_ROWS, BAR_W, Math.min(MAX_IMG_H, LIST_ROWS * LINE_H))
  const charts = tiles(bar, CANVAS_W - BAR_W, TOP, `list:${items.length}:${start}`)
  const n = selectedPanes(m).length
  const base = !m.loaded ? 'reading the hub…' : n ? `▽ move · ● open · hold to select · ${MAX_SELECTED} at most · ×× exit` : '▽ move · ● open · hold to select · ×× exit'
  return { kind: 'dash', head: statusHead(m), ...hint(m, base), blocks, charts, items: [], menu: [] }
}

// --- side by side -------------------------------------------------------------------------

export function splitPage(m: Model): Page {
  const shown = selectedPanes(m)
  const columns = Math.max(2, shown.length)
  const colW = Math.floor((CANVAS_W - COL_GAP * (columns - 1)) / columns)
  const lines = Math.floor((HINT_Y - 4 - BODY_Y) / LINE_H)
  const blocks: Block[] = []
  const charts: Chart[] = []
  shown.forEach((p, i) => {
    const x = i * (colW + COL_GAP)
    const chosen = i === m.marked
    const title = `${MARK[p.attention]} ${paneName(p)} · ${p.command}`
    const art = band(title, colW, chosen)
    if (art) charts.push(...tiles(art, x, TOP, `band:${colW}:${chosen ? 1 : 0}:${title}`, (chosen ? '» ' : '') + title))
    else blocks.push({ name: 'title' + i, x, y: TOP, w: colW, h: BAND_H, lines: [(chosen ? '» ' : '') + title], level: chosen ? 4 : 2 })
    const r = m.reading(p.address)
    let text: string[]
    if (r?.error) text = [r.error]
    else if (!r || !r.raw.length) text = ['reading…']
    else {
      const s = shaped(p, r.raw, colW - 4, m.lens, false)
      const body = s.pinned.length ? s.body.slice(-(lines - s.pinned.length)).concat(s.pinned) : s.body.slice(-lines)
      text = body
      while (text.length < lines) text.unshift('')
    }
    blocks.push({ name: 'col' + i, x, y: BODY_Y, w: colW, h: lines * LINE_H, lines: text, level: chosen ? 4 : 2 })
  })
  if (!shown.length) blocks.push(footer(['the selected panes are gone', m.listError ?? '']))
  const sel = m.marked >= 0 ? shown[m.marked] : undefined
  const base = sel ? `▽ next pane · ● ${sel.writable ? 'answer' : 'refresh'} · ×× the list` : '▽ open a pane · ● refresh · ×× the list'
  const menu: MenuSpec[] = [{ id: MENU.refresh, label: 'Refresh' }]
  if (m.needsYou) menu.push({ id: MENU.needsYou, label: 'Go to: ' + paneName(m.needsYou) })
  return { kind: 'dash', head: statusHead(m), ...hint(m, base), blocks, charts, items: [], menu }
}

// --- the pane -----------------------------------------------------------------------------

export interface PaneState {
  offset: number
  reveal: boolean
  state: string
}

const BAND_W = 376
const BODY_W = CANVAS_W - BAR_W - 8
const PIN_LINES = 2

export function panePage(m: Model, p: Pane, r: Reader | undefined, st: PaneState): Page {
  const title = `${MARK[p.attention]} ${paneName(p)} · ${p.command || '?'}`
  const charts: Chart[] = []
  const blocks: Block[] = []
  const art = band(title, BAND_W)
  if (art) charts.push(...tiles(art, 0, TOP, `band:${BAND_W}:0:${title}`, title))
  else blocks.push({ name: 'title', x: 0, y: TOP, w: BAND_W, h: BAND_H, lines: [title], level: 4 })
  blocks.push({ name: 'state', x: BAND_W + 8, y: TOP, w: CANVAS_W - BAND_W - 8, h: BAND_H, lines: [st.state], level: 2 })
  const s = r && r.raw.length ? shaped(p, r.raw, BODY_W - 4, m.lens, st.reveal) : { body: [], pinned: [] }
  const total = Math.floor((HINT_Y - 4 - BODY_Y) / LINE_H)
  const pin = s.pinned.length ? PIN_LINES : 0
  const size = pin ? total - pin - 1 : total
  const end = s.body.length - st.offset * size
  const lines = s.body.slice(Math.max(0, end - size), Math.max(0, end))
  while (lines.length < size) lines.unshift('')
  blocks.push({ name: 'body', x: 0, y: BODY_Y, w: BODY_W, h: size * LINE_H, lines, level: 3 })
  if (pin) blocks.push({ name: 'pinned', x: 0, y: BODY_Y + size * LINE_H + 4, w: BODY_W, h: pin * LINE_H + 12, lines: s.pinned.slice(-pin), level: 4, border: true })
  const bar = positionBar(s.body.length, st.offset * size, size, BAR_W, total * LINE_H)
  charts.push(...tiles(bar, CANVAS_W - BAR_W, BODY_Y, `pos:${s.body.length}:${st.offset}:${size}`))
  const menu: MenuSpec[] = [{ id: MENU.refresh, label: 'Refresh' }]
  if (m.lens) menu.push({ id: MENU.reveal, label: st.reveal ? 'Lens on' : 'Reveal all' })
  menu.push({ id: MENU.bottom, label: 'Bottom' })
  if (m.needsYou && m.needsYou.address !== p.address) menu.push({ id: MENU.needsYou, label: 'Go to: ' + paneName(m.needsYou) })
  return {
    kind: 'dash',
    head: statusHead(m),
    ...hint(m, `▽ page · ● ${p.writable ? 'answer' : 'refresh'} · ≡ menu · ×× back`),
    blocks,
    charts,
    items: [],
    menu,
  }
}

/** How many lines of the pane a page shows, for paging. */
export function pageSize(p: Pane, r: Reader | undefined, lens: boolean, reveal: boolean): { size: number; total: number } {
  const s = r && r.raw.length ? shaped(p, r.raw, BODY_W - 4, lens, reveal) : { body: [], pinned: [] }
  const total = Math.floor((HINT_Y - 4 - BODY_Y) / LINE_H)
  const size = s.pinned.length ? total - PIN_LINES - 1 : total
  return { size, total: s.body.length }
}

// --- answers ------------------------------------------------------------------------------

export function answersPage(m: Model, p: Pane, offerVoice: boolean): Page {
  const items = (offerVoice ? [SAY_IT] : []).concat(ANSWERS.map((a) => a.label))
  return { kind: 'list', head: statusHead(m), ...hint(m, `answer ${paneName(p)} · ▽ choose · ● pick · ×× back`), blocks: [], charts: [], items, menu: [] }
}

export function confirmPage(m: Model, p: Pane, a: Answer): Page {
  return {
    kind: 'list',
    head: statusHead(m),
    ...hint(m, `send ${short(a)} to ${paneName(p)}? · ×× back`),
    blocks: [],
    charts: [],
    items: ['Cancel', 'Confirm'],
    menu: [],
  }
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
    blocks.push({ name: 'state', x: 0, y: TOP, w: CANVAS_W, h: BAND_H, lines: [`● listening · ${Math.round(v.seconds)} s · ${name}`], level: 4 })
    const graph = sparkline(v.levels, GRAPH_W, GRAPH_H)
    charts.push(...tiles(graph, 8, BODY_Y, `levels:${v.levels.length}:${v.levels.slice(-6).map((l) => Math.round(l * 20)).join(',')}`))
    charts.push(...tiles(progressBar(v.seconds / 60, GRAPH_W, 8), 8, BODY_Y + GRAPH_H + 8, `progress:${Math.round(v.seconds)}`))
    blocks.push({ name: 'note', x: 8, y: BODY_Y + GRAPH_H + 24, w: CANVAS_W - 16, h: LINE_H * 2, lines: [`${Math.round(v.seconds)} of 60 s · tap when done`, 'what you say goes to your hub, then to its transcriber'], level: 2 })
    return { kind: 'dash', head: statusHead(m), ...hint(m, '● stop · ×× cancel'), blocks, charts, items: [], menu: [] }
  }
  if (v.phase === 'working') {
    blocks.push({ name: 'state', x: 0, y: TOP, w: CANVAS_W, h: BAND_H, lines: [`transcribing ${v.seconds.toFixed(1)} s of audio…`], level: 4 })
    blocks.push({ name: 'note', x: 8, y: BODY_Y, w: CANVAS_W - 16, h: LINE_H * 2 + 12, lines: ['the hub is listening to it', 'a few seconds on a small server'], level: 2, border: true })
    return { kind: 'dash', head: statusHead(m), ...hint(m, '×× cancel'), blocks, charts, items: [], menu: [] }
  }
  blocks.push({ name: 'state', x: 0, y: TOP, w: CANVAS_W, h: BAND_H, lines: [v.error || 'nothing recorded'], level: 4 })
  blocks.push({ name: 'note', x: 8, y: BODY_Y, w: CANVAS_W - 16, h: LINE_H + 12, lines: ['tap to say it again'], level: 2, border: true })
  return { kind: 'dash', head: statusHead(m), ...hint(m, '● say it again · ×× cancel'), blocks, charts, items: [], menu: [] }
}

export function heardPage(m: Model, p: Pane, v: VoiceView): Page {
  const blocks: Block[] = []
  const charts: Chart[] = []
  const title = `heard this · ${v.seconds.toFixed(1)} s · for ${paneName(p)}`
  const art = band(title, CANVAS_W)
  if (art) charts.push(...tiles(art, 0, TOP, `band:${CANVAS_W}:0:${title}`, title))
  else blocks.push({ name: 'title', x: 0, y: TOP, w: CANVAS_W, h: BAND_H, lines: [title], level: 4 })
  const rows = Math.floor((HINT_Y - 4 - BODY_Y - 12) / LINE_H)
  const lines = wrapRows([v.text], LINE_PX - 16).slice(0, rows)
  blocks.push({ name: 'text', x: 0, y: BODY_Y, w: CANVAS_W, h: rows * LINE_H + 12, lines, level: 4, border: true })
  const menu: MenuSpec[] = [{ id: MENU.typeOnly, label: 'Type without Enter' }, { id: MENU.sayAgain, label: 'Say it again' }]
  return { kind: 'dash', head: statusHead(m), ...hint(m, '● send + Enter · ≡ menu · ×× cancel'), blocks, charts, items: [], menu }
}
