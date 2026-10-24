// What every page says and draws, from the app's state. The layout is
// the Build Agents app's: a status line that doubles as a tab bar, rows
// with a bar chart lined up beside them, a footer, bold title bands,
// bordered boxes.

import { ANSWERS, short, type Answer } from './answers.ts'
import { barChart, positionBar, progressBar, sparkline, timelineChart } from './charts.ts'
import { HINT_Y, LINE_H, TOP, type Block, type MenuSpec, type Page } from './glasses.ts'
import { runsClaude, shapeClaude } from './lens.ts'
import { paneName, type Attention, type Host, type Pane } from './protocol.ts'
import { BAND_H, band, tiles, type Chart } from './raster.ts'
import { CANVAS_W, LINE_PX, textWidth, wrapRows } from './text.ts'

export const MARK: Record<Attention | '', string> = { question: '★', permission: '★', done: '●', idle: '○', '': '·' }
export const WORDS: Record<Attention, string> = { question: 'asks a question', permission: 'needs permission', idle: 'idle', done: 'done' }
export const SAY_IT = '» Say it'

export const MENU = { refresh: 1, reveal: 2, bottom: 3, list: 4, needsYou: 5, typeOnly: 6, sayAgain: 7, split: 8, columns: 9, home: 10 }

export type RingPage = 0 | 1 | 2
export const RING: RingPage[] = [0, 1, 2]

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
  columns: 2 | 3
  /** The selected pane's index, for the columns; -1 for none. */
  selected: number
  /** The first column's pane. */
  windowStart: number
  reading: (address: string) => Reader | undefined
}

export interface Reader {
  raw: string[]
  error: string | null
}

// --- geometry of a dashboard ---------------------------------------------------------
const ROWS = 5
const PITCH = 28
const LABEL_W = 330
const CHART_X = 336
const CHART_W = 240
const CHART_H = ROWS * PITCH
const FOOT_Y = TOP + CHART_H + 6
const FOOT_H = HINT_Y - 6 - FOOT_Y
const BODY_Y = TOP + BAND_H + 4
const COL_GAP = 8

export function needs(p: Pane): boolean {
  return p.attention === 'question' || p.attention === 'permission'
}

/** Panes in the order every page uses: those that need you first, then by address. */
export function sorted(panes: Pane[]): Pane[] {
  const rank = (p: Pane) => (needs(p) ? 0 : p.attention ? 1 : 2)
  return panes.slice().sort((a, b) => rank(a) - rank(b) || a.address.localeCompare(b.address))
}

export function rowLabel(p: Pane): string {
  const name = paneName(p)
  return `${MARK[p.attention]} ${name}` + (p.command && p.command !== name ? ` · ${p.command}` : '') + (p.writable ? '' : ' · read-only')
}

/** The status line, the same on every page: the ring's tabs with the current one in brackets, the host, the clock. */
export function statusHead(m: Model, current: RingPage | null): string {
  const n = m.panes.filter(needs).length
  const host = m.hosts[0]
  const groups = [`★ ${n}`, `≡ ${m.panes.length}`, `□□ ${m.columns}`]
  const line = (gap: string) =>
    groups.map((g, i) => (i === current ? `[${g}]` : g)).join(gap) + gap + (host ? `${host.online ? '●' : '○'} ${host.name}` : '○ no host') + gap + m.clock
  const wide = line('  ')
  return textWidth(wide) <= CANVAS_W - 32 ? wide : line(' ')
}

function hint(m: Model, base: string): Pick<Page, 'hint' | 'hintLevel' | 'hintBorder'> {
  if (m.toast) return { hint: m.toast, hintLevel: 4, hintBorder: true }
  if (m.listError) return { hint: m.listError, hintLevel: 4 }
  if (!m.configured) return { hint: 'set the hub and token on the phone', hintLevel: 4 }
  return { hint: base, hintLevel: 1 }
}

function label(i: number, text: string, level: number): Block {
  return { name: 'row' + i, x: 2, y: TOP + i * PITCH, w: LABEL_W, h: PITCH, lines: [text], level }
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

// --- the ring --------------------------------------------------------------------------

export function needsYouPage(m: Model, now: number): Page {
  const rows = m.panes.filter((p) => p.attention).slice(0, ROWS)
  const blocks: Block[] = []
  for (let i = 0; i < ROWS; i++) {
    const p = rows[i]
    blocks.push(label(i, p ? `${MARK[p.attention]} ${paneName(p)} · ${p.command}${p.attention ? ' · ' + WORDS[p.attention] : ''}` : ' ', p && needs(p) ? 4 : 3))
  }
  const asks = m.panes.filter(needs).length
  const done = m.panes.filter((p) => p.attention === 'done').length
  const idle = m.panes.filter((p) => p.attention === 'idle').length
  const oldest = Math.max(1, ...rows.filter((p) => p.attentionAt).map((p) => now - p.attentionAt))
  const span = Math.max(600, oldest * 1.1)
  const chart = timelineChart(
    rows.map((p) => ({ at: p.attentionAt ? 1 - (now - p.attentionAt) / span : 0.98, dim: !needs(p) })),
    CHART_W,
    CHART_H,
    PITCH,
    [0.25, 0.5, 0.75],
  )
  const foot = rows.length
    ? [`★ ${asks} ${asks === 1 ? 'asks' : 'ask'} · ● ${done} done · ○ ${idle} idle`, `bar = time waited, up to ${ago(now - span, now)}`]
    : ['nothing needs you', `${m.panes.length} ${m.panes.length === 1 ? 'pane' : 'panes'} working quietly`]
  blocks.push(footer(foot))
  const key = rows.map((p) => `${p.address}:${p.attention}:${Math.floor((now - p.attentionAt) / 30)}`).join('|') + `:${span}`
  return {
    kind: 'dash',
    head: statusHead(m, 0),
    ...hint(m, '▽ Panes · ● open · ≡ menu · ×× exit'),
    blocks,
    charts: [{ x: CHART_X, y: TOP, w: CHART_W, h: CHART_H, key: 'needs:' + key, bitmap: chart }],
    items: [],
    menu: ringMenu(m, 0),
  }
}

export function panesPage(m: Model, now: number): Page {
  const rows = m.panes.slice(0, ROWS)
  const blocks: Block[] = []
  for (let i = 0; i < ROWS; i++) {
    const p = rows[i]
    blocks.push(label(i, p ? rowLabel(p) : ' ', p && needs(p) ? 4 : 3))
  }
  // Recency on a log scale: full for a minute ago, empty for a day.
  const recency = (p: Pane) => (p.activity ? 1 - Math.min(1, Math.max(0, Math.log(Math.max(1, (now - p.activity) / 60)) / Math.log(1440))) : 0)
  const chart = barChart(
    rows.map((p) => ({ frac: recency(p), dim: !p.writable })),
    CHART_W,
    CHART_H,
    PITCH,
  )
  const online = m.hosts.filter((h) => h.online).length
  const foot = [
    `${m.panes.length} ${m.panes.length === 1 ? 'pane' : 'panes'} on ${m.hosts.length} ${m.hosts.length === 1 ? 'host' : 'hosts'}` +
      (m.hosts.length ? `, ${online} online` : '') +
      (m.panes.length > ROWS ? ` · ${m.panes.length - ROWS} more in the list` : ''),
    'bar = how recently the pane was active',
  ]
  blocks.push(footer(foot))
  const key = rows.map((p) => `${p.address}:${Math.round(recency(p) * 40)}:${p.writable}`).join('|')
  return {
    kind: 'dash',
    head: statusHead(m, 1),
    ...hint(m, '▽ Needs you / Side by side · ● the list · ≡ menu · ×× exit'),
    blocks,
    charts: [{ x: CHART_X, y: TOP, w: CHART_W, h: CHART_H, key: 'panes:' + key, bitmap: chart }],
    items: [],
    menu: ringMenu(m, 1),
  }
}

/** The columns' window over the panes: `start` slides only when the selection leaves it. */
export function window(panes: Pane[], columns: number, selected: number, start: number): { start: number; shown: Pane[] } {
  const n = panes.length
  if (n === 0) return { start: 0, shown: [] }
  let s = Math.max(0, Math.min(start, n - columns))
  if (selected >= 0) {
    const sel = Math.min(n - 1, selected)
    if (sel < s) s = sel
    if (sel >= s + columns) s = sel - columns + 1
  }
  return { start: s, shown: panes.slice(s, s + columns) }
}

export function splitPage(m: Model): Page {
  const { start, shown } = window(m.panes, m.columns, m.selected, m.windowStart)
  const colW = Math.floor((CANVAS_W - COL_GAP * (m.columns - 1)) / m.columns)
  const lines = Math.floor((HINT_Y - 4 - BODY_Y) / LINE_H)
  const blocks: Block[] = []
  const charts: Chart[] = []
  shown.forEach((p, i) => {
    const x = i * (colW + COL_GAP)
    const chosen = start + i === m.selected
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
  if (!shown.length) blocks.push(footer(['no panes to show', m.listError ?? '']))
  const sel = m.selected >= 0 ? m.panes[Math.min(m.panes.length - 1, m.selected)] : undefined
  const base = sel ? `▽ select · ● ${sel.writable ? 'answer' : 'refresh'} · ×× open the pane · ≡ menu` : '▽ select a pane · ≡ menu · ×× main menu'
  return { kind: 'dash', head: statusHead(m, 2), ...hint(m, base), blocks, charts, items: [], menu: ringMenu(m, 2) }
}

function ringMenu(m: Model, page: RingPage): MenuSpec[] {
  const menu: MenuSpec[] = [{ id: MENU.refresh, label: 'Refresh' }]
  if (page !== 0) menu.push({ id: MENU.home, label: 'Needs you' })
  if (page !== 1) menu.push({ id: MENU.list, label: 'Panes' })
  if (page !== 2) menu.push({ id: MENU.split, label: 'Side by side' })
  menu.push({ id: MENU.columns, label: m.columns === 2 ? 'Three columns' : 'Two columns' })
  if (m.needsYou) menu.push({ id: MENU.needsYou, label: 'Go to: ' + paneName(m.needsYou) })
  return menu
}

// --- the pane -----------------------------------------------------------------------------

export interface PaneState {
  offset: number
  reveal: boolean
  state: string
}

const BAND_W = 376
const BAR_W = 8
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
  menu.push({ id: MENU.bottom, label: 'Bottom' }, { id: MENU.list, label: 'Panes' }, { id: MENU.split, label: 'Side by side' })
  if (m.needsYou && m.needsYou.address !== p.address) menu.push({ id: MENU.needsYou, label: 'Go to: ' + paneName(m.needsYou) })
  return {
    kind: 'dash',
    head: statusHead(m, null),
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

// --- lists ----------------------------------------------------------------------------------

export const ROWS_PER_LIST_PAGE = 19

export function listPage(m: Model, page: number): Page {
  const shown = m.panes.slice(page * ROWS_PER_LIST_PAGE)
  const items = shown.slice(0, ROWS_PER_LIST_PAGE).map(rowLabel)
  if (shown.length > ROWS_PER_LIST_PAGE) items.push(`→ next ${shown.length - ROWS_PER_LIST_PAGE} more`)
  const menu: MenuSpec[] = [{ id: MENU.refresh, label: 'Refresh' }, { id: MENU.home, label: 'Needs you' }, { id: MENU.split, label: 'Side by side' }]
  if (m.needsYou) menu.push({ id: MENU.needsYou, label: 'Go to: ' + paneName(m.needsYou) })
  return { kind: 'list', head: statusHead(m, 1), ...hint(m, '▽ choose · ● open · ×× back'), blocks: [], charts: [], items, menu }
}

export function answersPage(m: Model, p: Pane, offerVoice: boolean): Page {
  const items = (offerVoice ? [SAY_IT] : []).concat(ANSWERS.map((a) => a.label))
  return { kind: 'list', head: statusHead(m, null), ...hint(m, `answer ${paneName(p)} · ▽ choose · ● pick · ×× back`), blocks: [], charts: [], items, menu: [{ id: MENU.list, label: 'Panes' }] }
}

export function confirmPage(m: Model, p: Pane, a: Answer): Page {
  return {
    kind: 'list',
    head: statusHead(m, null),
    ...hint(m, `send ${short(a)} to ${paneName(p)}? · ×× back`),
    blocks: [],
    charts: [],
    items: ['Cancel', 'Confirm'],
    menu: [{ id: MENU.list, label: 'Panes' }],
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
    return { kind: 'dash', head: statusHead(m, null), ...hint(m, '● stop · ×× cancel'), blocks, charts, items: [], menu: [{ id: MENU.list, label: 'Panes' }] }
  }
  if (v.phase === 'working') {
    blocks.push({ name: 'state', x: 0, y: TOP, w: CANVAS_W, h: BAND_H, lines: [`transcribing ${v.seconds.toFixed(1)} s of audio…`], level: 4 })
    blocks.push({ name: 'note', x: 8, y: BODY_Y, w: CANVAS_W - 16, h: LINE_H * 2 + 12, lines: ['the hub is listening to it', 'a few seconds on a small server'], level: 2, border: true })
    return { kind: 'dash', head: statusHead(m, null), ...hint(m, '×× cancel'), blocks, charts, items: [], menu: [{ id: MENU.list, label: 'Panes' }] }
  }
  blocks.push({ name: 'state', x: 0, y: TOP, w: CANVAS_W, h: BAND_H, lines: [v.error || 'nothing recorded'], level: 4 })
  blocks.push({ name: 'note', x: 8, y: BODY_Y, w: CANVAS_W - 16, h: LINE_H + 12, lines: ['tap to say it again'], level: 2, border: true })
  return { kind: 'dash', head: statusHead(m, null), ...hint(m, '● say it again · ×× cancel'), blocks, charts, items: [], menu: [{ id: MENU.list, label: 'Panes' }] }
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
  const menu: MenuSpec[] = [{ id: MENU.typeOnly, label: 'Type without Enter' }, { id: MENU.sayAgain, label: 'Say it again' }, { id: MENU.list, label: 'Panes' }]
  return { kind: 'dash', head: statusHead(m, null), ...hint(m, '● send + Enter · ≡ menu · ×× cancel'), blocks, charts, items: [], menu }
}
