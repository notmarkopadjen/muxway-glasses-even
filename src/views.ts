// What every page says and draws, from the app's state: the pane list,
// the columns, the pane, the answers, the voice pages. Text from the top
// down, a hint at the foot, bordered boxes.

import { ANSWERS, type Answer } from './answers.ts'
import { sparkline } from './charts.ts'
import { groupsOf, pullTogether, type Groups } from './groups.ts'
import { BANNER_Y, LINE_H, RULE_H, TOP, type Block, type MenuSpec, type Page } from './glasses.ts'
import { runsClaude, shapeClaude } from './lens.ts'
import { folder, paneName, program, programSays, type Attention, type Host, type Mail, type Pane, type Talk, type TalkEnd } from './protocol.ts'
import { tiles, type Chart } from './raster.ts'
import { CANVAS_W, LINE_PX, byteLength, fitWidth, textWidth, typed, wrapRows } from './text.ts'

// The marks were found on the device: the font draws no check, no ring and no flag.
export const MARK: Record<Attention, string> = { question: '★', permission: '★', done: '√', idle: '○' }
const TURN = ['◐', '◑']
const NONE = '◌'
/** A parked pane's mark: the font has no moon, so the guideline's own fallback. */
export const LATER = 'zz'
export const WORDS: Record<Attention, string> = { question: 'asks a question', permission: 'needs permission', idle: 'idle', done: 'done' }
export const SAY_IT = '» Say it'
export const INBOX = '◆ inbox'

export const MENU = { refresh: 1, reveal: 2, bottom: 3, needsYou: 5, typeOnly: 6, sayAgain: 7, later: 8, next: 9, previous: 10, mail: 11, beside: 12, close: 13, split: 14, messages: 15 }

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
  /** The hub's inbox as last read, oldest first; null before the first read. */
  inbox: Pane[] | null
  /** The inbox page's cursor, an entry, and its window's first row. */
  inboxCursor: number
  inboxStart: number
  /** Whether the hub's feed holds anything, and how many entries arrived since the messages page was last opened. */
  feed: boolean
  unseen: number
  reading: (address: string) => Reader | undefined
}

export interface Reader {
  raw: string[]
  error: string | null
}

// --- geometry ------------------------------------------------------------------------------
// Everything ends at the banner's top: a toast grows the hint upward, and the glasses refuse a page
// whose containers overlap, without a word.
// The title gives two pixels of its row to the rule under it; the device shows it whole at 26 px.
const TITLE_H = LINE_H - RULE_H
const BODY_Y = TOP + TITLE_H + RULE_H
/** Lines of a pane under its title, down to the banner. */
const BODY_LINES = Math.floor((BANNER_Y - BODY_Y) / LINE_H)
const COL_GAP = 8
const FOOT_Y = TOP + 140 + 6
const FOOT_H = BANNER_Y - FOOT_Y
/** A bordered box of text from under the title down to the banner: the spoken reply, the suggestion. */
const BOX_W = LINE_PX - 16
const BOX_ROWS = Math.floor((BANNER_Y - 4 - BODY_Y - 12) / LINE_H)

/** A rule across the page: a bordered block with nothing in it, as high as its line. It takes the gestures. */
function rule(name: string, y: number): Block {
  return { name, x: 0, y, w: CANVAS_W, h: RULE_H, lines: [''], level: 4, border: true, pad: 0, capture: true }
}

/** The catcher's side: an unseen square in the top right corner that takes the gestures where no rule does. */
const CATCH = 16
/** Width left to a title row beside the catcher. */
const BESIDE_W = CANVAS_W - CATCH - 4
/** The pane's title block; the state sits beside it. */
const TITLE_W = 376
/** The rows' block leaves the corner to the catcher; a row's text is at most 490 px anyway. */
const ROW_W = CANVAS_W - CATCH - 6
/** What a block shows of a line: its width less the text's margin. */
const INNER = 4
function catcher(): Block {
  return { name: 'gesture', x: CANVAS_W - CATCH, y: TOP, w: CATCH, h: CATCH, lines: [''], level: 0, capture: true }
}

export function needs(p: Pane): boolean {
  return p.attention === 'question' || p.attention === 'permission'
}

/** Panes in the order every page uses: those that need you first, the parked ones last, by address between, a group of panes that talk kept together after its first member. */
export function sorted(panes: Pane[]): Pane[] {
  const rank = (p: Pane) => (p.later ? 3 : needs(p) ? 0 : p.attention ? 1 : 2)
  const byRank = panes.slice().sort((a, b) => rank(a) - rank(b) || a.address.localeCompare(b.address))
  return pullTogether(byRank, groupsOf(panes))
}

/** The bar every row of a group starts with: one bar down the list, the glasses' frame. */
export const BAR = '│ '

/** What a pane says about its mail, after its name: a word, since the font is not known to have the envelope. */
export function mailWord(p: Pane): string {
  return p.mail ? ` · mail ${p.mail}` : ''
}

/**
 * How a pane is named, as the guideline has it: the alias, then the program and its status
 * (`review · Claude · fixing the build`); unnamed, a harness is its name and what it says is its
 * status (`Claude · fixing the build`), any other program is named with what it says
 * (`vim · notes.md`). The mail and the folder go between the name and the status.
 */
export function nameParts(p: Pane): { name: string; status: string } {
  const prog = program(p)
  const said = programSays(p)
  if (p.alias) return { name: p.alias, status: (prog && prog !== p.alias ? ` · ${prog}` : '') + (said && said !== p.alias ? ` · ${said}` : '') }
  if (p.agent) return { name: prog, status: said && said.toLowerCase() !== prog.toLowerCase() ? ` · ${said}` : '' }
  if (!prog) return { name: said || p.path, status: '' }
  return { name: said && said !== prog ? `${prog} · ${said}` : prog, status: '' }
}

/** The folder after the name, when the whole line has room for it in the width; else the line without. */
function withFolder(before: string, after: string, p: Pane, room: number): string {
  const dir = folder(p)
  if (dir) {
    const line = `${before} · /${dir}${after}`
    if (textWidth(line) <= room) return line
  }
  return before + after
}

/** The pane's title line: the bar when it is in a group, the mark, the name, its mail, the folder, the program, a named pane's status. */
export function titleOf(p: Pane, groups: Groups, now: number, room = TITLE_W - INNER): string {
  const { name, status } = nameParts(p)
  return withFolder(`${groups.has(p.address) ? BAR : ''}${markOf(p, now)} ${name}${mailWord(p)}`, status, p, room)
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
  return { label, short: label, pieces: [{ text }, { key: 'Enter' }], secret: true }
}

function ago(seconds: number, now: number): string {
  const d = Math.max(0, now - seconds)
  if (d < 60) return `${d}s`
  if (d < 3600) return `${Math.floor(d / 60)}m`
  if (d < 86400) return `${Math.floor(d / 3600)}h`
  return `${Math.floor(d / 86400)}d`
}

// --- the list: the main screen ---------------------------------------------------------

/** A screen change this recent counts as working: the guideline's ten seconds. */
export const WORKING_SECONDS = 10

/** Whether the pane's screen changed in the last ten seconds, by the listing's activity. */
export function moving(p: Pick<Pane, 'activity'>, now: number): boolean {
  return p.activity > 0 && now - p.activity <= WORKING_SECONDS
}

/** A harness is working from its last working event until its next event, or while its screen moves; an idle notice while it still moves is working too, not waiting. */
export function isWorking(p: Pane, now: number): boolean {
  if (p.later || !p.agent) return false
  if (p.attention) return p.attention === 'idle' && moving(p, now)
  return p.working || moving(p, now)
}

/** What a row says about the pane's state: later with what waits underneath, else working, else the attention in words, else what its output says. */
export function stateWord(p: Pane, now: number): string {
  if (p.later) return 'later' + (p.attention ? ` · ${WORDS[p.attention]}` : '')
  if (isWorking(p, now)) return 'working'
  if (p.attention) return WORDS[p.attention]
  if (!p.activity) return ''
  if (moving(p, now)) return p.agent ? 'working' : 'active'
  return `quiet ${ago(p.activity, now)}`
}

/** A pane's mark: parked, else the half circle turned by the second while it works, else its attention's, else the dotted ring. */
export function markOf(p: Pane, now: number): string {
  if (p.later) return LATER
  if (isWorking(p, now)) return TURN[now % 2]
  if (p.attention) return MARK[p.attention]
  return NONE
}

/** Whether a page carries a turning mark, so it is drawn again next second. */
export function turning(p: Page): boolean {
  const texts = p.blocks.filter((b) => b.name?.startsWith('row') || b.name?.startsWith('title')).flatMap((b) => b.lines)
  return [...texts, ...p.items].some((t) => TURN.some((f) => t.includes(f)))
}

/** The cursor's lead on a row, counted in its width. */
const CURSOR = '> '

/** A pane's row: the bar when it is in a group, then in selection mode its box, [x] or [ ]; the folder only when the row has room. */
export function rowLabel(p: Pane, now: number, box: 'none' | 'on' | 'off' = 'none', grouped = false): string {
  const { name, status } = nameParts(p)
  const word = stateWord(p, now)
  const before = (grouped ? BAR : '') + (box === 'none' ? '' : box === 'on' ? '[x] ' : '[ ] ') + `${markOf(p, now)} ${name}` + mailWord(p)
  const after = status + (word ? ` · ${word}` : '') + (p.writable ? '' : ' · read-only')
  return withFolder(before, after, p, ROW_W - INNER - textWidth(CURSOR))
}

/** Rows on the list at once: the page's eight text containers less the hint; the window slides under the cursor. */
/** Rows on the list at once: one block of lines at the font's pitch, down to the hint's box. */
export const LIST_ROWS = Math.floor((BANNER_Y - TOP) / LINE_H)
export const MAX_SELECTED = 3

export type ListItem = { kind: 'pane'; pane: Pane } | { kind: 'inbox' } | { kind: 'messages' } | { kind: 'host'; host: Host } | { kind: 'open' } | { kind: 'clear' } | { kind: 'none' }

export const MESSAGES = '» messages'

/** A host's line: its name and state, and + session where its agent starts them. */
export function hostLine(h: Host, panes: Pane[]): string {
  const state = panes.some((p) => p.host === h.name) ? 'online' : 'nothing exposed'
  return `── ${h.name} · ${state}${h.sessions ? ' · + session' : ''} ──`
}

/** The hosts whose lines the list draws: the online ones, by name, and any host the listing names that the hosts call did not. */
export function listedHosts(m: Pick<Model, 'hosts' | 'panes'>): Host[] {
  const hosts = m.hosts.filter((h) => h.online || m.panes.some((p) => p.host === h.name)).map((h) => ({ ...h }))
  for (const p of m.panes) {
    if (!hosts.some((h) => h.name === p.host)) hosts.push({ name: p.host, online: true, later: false, sessions: false, close: false, mail: false, keys: 0 })
  }
  return hosts.sort((a, b) => a.name.localeCompare(b.name))
}

/** The panes that wait, oldest first, then the parked ones by their parking: what the inbox lists and counts. */
export function waiting(panes: Pane[]): Pane[] {
  const at = (p: Pane) => (p.later ? 1e12 + p.laterAt : p.attentionAt)
  return panes.filter((p) => p.attention || p.later).sort((a, b) => at(a) - at(b) || a.address.localeCompare(b.address))
}

/** Every row of the list and what each one is: the panes, then in selection mode its actions. */
export function listLayout(m: Model, now: number): { items: string[]; what: ListItem[] } {
  if (!m.configured) return { items: ['set the hub and token on the phone'], what: [{ kind: 'none' }] }
  if (!m.loaded) return { items: ['reading the hub…'], what: [{ kind: 'none' }] }
  if (!m.panes.length) return { items: ['no panes exposed to this token'], what: [{ kind: 'none' }] }
  const items: string[] = []
  const what: ListItem[] = []
  // While anything waits the first row is the way to the inbox; it has no box in selection mode.
  const n0 = waiting(m.panes).length
  if (n0) {
    items.push(`${INBOX} · ${n0} waiting`)
    what.push({ kind: 'inbox' })
  }
  if (m.feed) {
    items.push(MESSAGES + (m.unseen ? ` · mail ${m.unseen}` : ''))
    what.push({ kind: 'messages' })
  }
  const groups = groupsOf(m.panes)
  // A line per online host, its panes under it in the order they have across the list.
  for (const h of listedHosts(m)) {
    items.push(hostLine(h, m.panes))
    what.push({ kind: 'host', host: h })
    for (const p of m.panes) {
      if (p.host !== h.name) continue
      items.push(rowLabel(p, now, m.selecting ? (m.selected.includes(p.address) ? 'on' : 'off') : 'none', groups.has(p.address)))
      what.push({ kind: 'pane', pane: p })
    }
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
  // One block of rows, named by where its window starts; the cursor is the mark, since one block has
  // one brightness. The corner catcher beside it takes the gestures.
  const lines: string[] = []
  for (let i = 0; i < LIST_ROWS; i++) {
    const at = start + i
    lines.push(items[at] === undefined ? ' ' : (at === cursor && m.loaded ? CURSOR : '  ') + items[at])
  }
  const blocks: Block[] = [{ name: 'rows' + start, x: 2, y: TOP, w: ROW_W, h: LIST_ROWS * LINE_H, lines, level: 3 }, catcher()]
  // Where the window sits, in words: the glasses refused a thin bar drawn as a picture.
  const where = items.length > LIST_ROWS ? `${start + 1}–${Math.min(items.length, start + LIST_ROWS)} of ${items.length} · ` : ''
  const offline = m.hosts.filter((h) => !h.online).map((h) => `○ ${h.name} offline · `).join('')
  const n = waiting(m.panes).length
  const wait = n && m.loaded ? `◆ ${n} · ` : ''
  const base = !m.loaded
    ? 'reading the hub ' + '·'.repeat(Math.max(1, Math.min(3, m.dots)))
    : wait + offline + where + (m.selecting ? `▽ move · ● select · ${MAX_SELECTED} at most · ×× done` : '▽ move · ● open · hold to select · ×× exit')
  return { kind: 'dash', ...hint(m, base), blocks, charts: [], items: [], menu: [] }
}

// --- side by side -------------------------------------------------------------------------

export function splitPage(m: Model, now: number): Page {
  const shown = selectedPanes(m)
  const columns = Math.max(2, shown.length)
  const colW = Math.floor((CANVAS_W - COL_GAP * (columns - 1)) / columns)
  const blocks: Block[] = []
  const groups = groupsOf(m.panes)
  shown.forEach((p, i) => {
    const x = i * (colW + COL_GAP)
    const chosen = i === m.marked
    // The folder is measured with the mark's room whether or not the column is marked, so it does not come and go.
    const title = `${chosen ? '» ' : ''}${titleOf(p, groups, now, colW - INNER - textWidth('» '))}`
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
  if (shown.length) blocks.push(rule('rule1', TOP + TITLE_H))
  else blocks.push(footer(['the selected panes are gone', m.listError ?? '']))
  const sel = m.marked >= 0 ? shown[m.marked] : undefined
  const base = sel ? `▽ next pane · ● open ${paneName(sel)} · ×× the list` : '▽ pick a pane · ● refresh · ×× the list'
  const menu: MenuSpec[] = [{ id: MENU.refresh, label: 'Refresh' }]
  if (m.needsYou) menu.push({ id: MENU.needsYou, label: 'Go to: ' + paneName(m.needsYou) })
  return { kind: 'dash', ...hint(m, base), blocks, charts: [], items: [], menu }
}

// --- the pane -----------------------------------------------------------------------------

/** Whether the glasses may park or wake the pane: a writer, on a host whose agent parks. */
export function canPark(m: Pick<Model, 'hosts'>, p: Pane): boolean {
  return p.writable && m.hosts.some((h) => h.name === p.host && h.later)
}

/** The host of a pane as the hosts call lists it. */
export function hostOf(m: Pick<Model, 'hosts'>, p: Pane): Host | undefined {
  return m.hosts.find((h) => h.name === p.host)
}

/** The newest partner of the pane that is in the listing, for Beside. */
export function partnerOf(m: Pick<Model, 'panes'>, p: Pane): Pane | undefined {
  for (const a of p.talk) {
    const q = m.panes.find((x) => x.address === a)
    if (q) return q
  }
  return undefined
}

/** Whether the glasses may close the pane, or split its window: a writer, on a host whose agent allows it. */
export function canClose(m: Pick<Model, 'hosts'>, p: Pane): boolean {
  return p.writable && !!hostOf(m, p)?.close
}

/**
 * The pane page's menu, ten entries at most, the firmware's cap: Bottom reads the pane again, so
 * Refresh has no entry here; Next and Previous with more than one pane; Later or Wake, Go to, Mail,
 * Beside, Close pane and + pane each where it applies.
 */
export function paneMenu(m: Model, p: Pane, reveal: boolean): MenuSpec[] {
  const menu: MenuSpec[] = []
  if (m.lens) menu.push({ id: MENU.reveal, label: reveal ? 'Lens on' : 'Reveal all' })
  menu.push({ id: MENU.bottom, label: 'Bottom' })
  if (m.panes.length > 1) menu.push({ id: MENU.next, label: 'Next pane' }, { id: MENU.previous, label: 'Previous pane' })
  if (canPark(m, p)) menu.push({ id: MENU.later, label: p.later ? 'Wake' : 'Later' })
  if (m.needsYou && m.needsYou.address !== p.address) menu.push({ id: MENU.needsYou, label: 'Go to: ' + paneName(m.needsYou) })
  if (hostOf(m, p)?.mail) menu.push({ id: MENU.mail, label: 'Mail' })
  const partner = partnerOf(m, p)
  if (partner) menu.push({ id: MENU.beside, label: 'Beside: ' + paneName(partner) })
  if (canClose(m, p)) menu.push({ id: MENU.close, label: 'Close pane' })
  if (p.writable) menu.push({ id: MENU.split, label: '+ pane' })
  return menu
}

/** The next or the previous pane in the list's order, round at either end, parked panes skipped; undefined with no other. */
export function neighbour(panes: Pane[], p: Pane, dir: 1 | -1): Pane | undefined {
  const i = panes.findIndex((x) => x.address === p.address)
  if (i < 0 && !panes.length) return undefined
  for (let step = 1; step <= panes.length; step++) {
    const q = panes[(((i < 0 ? 0 : i) + dir * step) % panes.length + panes.length) % panes.length]
    if (q.address === p.address) return undefined
    if (!q.later) return q
  }
  return undefined
}

/** The words of the close confirmation: the pane, or the session when the pane is its last. */
export function closeQuestion(p: Pane): string {
  return p.last && p.session ? `end session ${p.session} on ${p.host}?` : `close ${paneName(p)} on ${p.host}?`
}

/** Beside on a wide pane, below on a tall one: the web's rule, in cells. */
export function splitDirection(p: Pick<Pane, 'width' | 'height'>): 'h' | 'v' {
  return p.width >= 2 * p.height ? 'h' : 'v'
}

/** A session's name as the hub takes it, from what was said or typed: lowercase, spaces made dashes, the rest of the grammar kept, 32 at most. */
export function sessionName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32)
}

/** The first of glasses-1, glasses-2, … that is no session of the host in the listing. */
export function defaultSession(panes: Pane[], host: string): string {
  const taken = new Set(panes.filter((p) => p.host === host).map((p) => p.session))
  for (let n = 1; ; n++) if (!taken.has(`glasses-${n}`)) return `glasses-${n}`
}

export interface PaneState {
  offset: number
  reveal: boolean
  state: string
}

const BODY_W = CANVAS_W - 4

/** The notice a pane page leads with: a question's or a permission's text, as the toast says it; nothing for the rest. */
export function noticeLine(p: Pane): string {
  return needs(p) ? `${MARK[p.attention as Attention]} ${p.attentionText || WORDS[p.attention as Attention]}` : ''
}

/** The state beside the title while nothing else is to say: the place, with read-only in front where the token cannot write. */
export function placeWord(p: Pane, room = CANVAS_W - TITLE_W - 8 - INNER): string {
  if (p.writable) return p.path
  const both = `read-only · ${p.path}`
  return textWidth(both) <= room ? both : 'read-only'
}

export function panePage(m: Model, p: Pane, r: Reader | undefined, st: PaneState, now: number): Page {
  const title = titleOf(p, groupsOf(m.panes), now)
  const blocks: Block[] = []
  blocks.push({ name: 'title', x: 0, y: TOP, w: TITLE_W, h: TITLE_H, lines: [title], level: 4 })
  blocks.push({ name: 'state', x: TITLE_W + 8, y: TOP, w: CANVAS_W - TITLE_W - 8, h: TITLE_H, lines: [st.state], level: 2 })
  const { size } = pageSize(p, r, m.lens, st.reveal)
  const body = r && r.raw.length ? shaped(p, r.raw, BODY_W - 4, m.lens, st.reveal) : []
  const end = body.length - st.offset * size
  const lines = body.slice(Math.max(0, end - size), Math.max(0, end))
  while (lines.length < size) lines.unshift('')
  // The notice's text leads the body, in the same block: its coming and going is an upgrade.
  const notice = noticeLine(p)
  if (notice) lines.unshift(notice)
  blocks.push(rule('rule1', TOP + TITLE_H))
  blocks.push({ name: 'body', x: 0, y: BODY_Y, w: BODY_W, h: BODY_LINES * LINE_H, lines, level: 3 })
  const menu = paneMenu(m, p, st.reveal)
  return {
    kind: 'dash',
    ...hint(m, `▽ page · ● ${p.writable ? 'answer' : 'refresh'} · ≡ menu · ×× back`),
    blocks,
    charts: [],
    items: [],
    menu,
  }
}

/** How many lines of the pane a page shows, for paging: one less under a notice. */
export function pageSize(p: Pane, r: Reader | undefined, lens: boolean, reveal: boolean): { size: number; total: number } {
  const body = r && r.raw.length ? shaped(p, r.raw, BODY_W - 4, lens, reveal) : []
  return { size: BODY_LINES - (noticeLine(p) ? 1 : 0), total: body.length }
}

// --- answers ------------------------------------------------------------------------------

export const KEYS_ROW = '→ keys'
export const COMMANDS_ROW = '→ commands: '

/** The answers: a question's choices first, then Claude's suggestion when there is one, then Say it, the fixed set, and the rows to the keys and the commands. */
export function answersPage(m: Model, p: Pane, choices: Answer[], offer: Answer | null, offerVoice: boolean, commands: string | null): Page {
  const items = choices.map((c) => c.label).concat(offer ? ['» ' + offer.label] : [], offerVoice ? [SAY_IT] : [], ANSWERS.map((a) => a.label), [KEYS_ROW], commands ? [COMMANDS_ROW + commands] : [])
  return { kind: 'list', ...hint(m, `answer ${paneName(p)} · ▽ choose · ● pick · ×× back`), blocks: [], charts: [], items, menu: [] }
}

/** The keys, or the program's commands, as a list of their own; a pick confirms as every answer. */
export function moreAnswersPage(m: Model, p: Pane, what: 'keys' | 'commands', answers: Answer[]): Page {
  return { kind: 'list', ...hint(m, `${what} for ${paneName(p)} · ▽ choose · ● pick · ×× back`), blocks: [], charts: [], items: answers.map((a) => a.label), menu: [] }
}

export function confirmPage(m: Model, p: Pane, a: Answer): Page {
  return askPage(m, `${a.choice !== undefined ? 'answer' : 'send'} ${a.short} to ${paneName(p)}?`)
}

/** The Cancel / Confirm page for anything that is not an answer: a close, a new pane, a session, a mail. */
export function askPage(m: Model, question: string): Page {
  return { kind: 'list', ...hint(m, `${question} · ×× back`), blocks: [], charts: [], items: ['Cancel', 'Confirm'], menu: [] }
}

/** The name for a new session: the default, and Say it when the hub transcribes; the phone's send names it too. */
export function sessionPage(m: Model, host: string, dflt: string, voice: boolean): Page {
  const items = ['» ' + dflt].concat(voice ? [SAY_IT] : [])
  return { kind: 'list', ...hint(m, `a session on ${host} · ● pick the name, or type it on the phone · ×× back`), blocks: [], charts: [], items, menu: [] }
}

// --- the inbox ----------------------------------------------------------------------------

/** How many rows the inbox lists: the OS list's most. */
export const INBOX_ROWS = 20

/** The inbox's row: the mark, the name, the program, the kind (later first on a parked pane) and how long it has waited, or been parked. */
export function inboxLabel(p: Pane, now: number): string {
  const { name, status } = nameParts(p)
  const prog = program(p)
  const since = p.attentionAt || p.laterAt
  // A named pane goes without its status here: the kind and the age matter more in 63 bytes. An unnamed one keeps what it says, which is what tells it apart.
  const who = p.alias ? name + (prog && prog !== name ? ` · ${prog}` : '') : name + status
  return `${markOf(p, now)} ${who} · ${stateWord(p, now)}` + (since ? ` · ${ago(since, now)}` : '')
}

/** The second row of an inbox entry: the notice's text, and a question's choices after »; nothing when there is neither. */
export function noticeRow(p: Pane): string {
  const choices = p.attention === 'question' && p.choices.length ? `» ${p.choices.join(' · ')}` : ''
  const text = p.attentionText
  if (!text && !choices) return ''
  return '    ' + (text && choices ? `${text} ${choices}` : text || choices)
}

/** The inbox's rows and, for each, which entry it belongs to (-1 for none): an entry is its row, then the notice's text and choices under it. */
export function inboxLayout(m: Model, now: number): { items: string[]; entry: number[] } {
  if (m.inbox === null) return { items: ['reading the inbox…'], entry: [-1] }
  if (!m.inbox.length) return { items: ['nothing waits for you'], entry: [-1] }
  const items: string[] = []
  const entry: number[] = []
  m.inbox.slice(0, INBOX_ROWS).forEach((p, i) => {
    items.push(inboxLabel(p, now))
    entry.push(i)
    const under = noticeRow(p)
    if (under) {
      items.push(under)
      entry.push(i)
    }
  })
  return { items, entry }
}

/** The first row on screen so the cursor's entry is whole on it; the window slides only when it must. */
export function inboxWindow(entry: number[], cursor: number, start: number): number {
  const first = entry.indexOf(cursor)
  const last = entry.lastIndexOf(cursor)
  if (first < 0) return listWindow(entry.length, 0, start)
  let s = listWindow(entry.length, first, start)
  if (last >= s + LIST_ROWS) s = last - LIST_ROWS + 1
  return s
}

/** The entry under the inbox's cursor, if any. */
export function inboxEntry(m: Model): Pane | undefined {
  return m.inbox?.slice(0, INBOX_ROWS)[m.inboxCursor]
}

/** A page of the app's own rows where the cursor moves by entry (an entry is one or more rows), as the inbox, the messages and the mail pages are. */
export function entriesBlocks(items: string[], entry: number[], cursor: number, start: number): Block[] {
  const lines: string[] = []
  for (let i = 0; i < LIST_ROWS; i++) {
    const at = start + i
    lines.push(items[at] === undefined ? ' ' : (entry[at] === cursor && at === entry.indexOf(cursor) ? CURSOR : '  ') + items[at])
  }
  return [{ name: 'rows' + start, x: 2, y: TOP, w: ROW_W, h: LIST_ROWS * LINE_H, lines, level: 3 }, catcher()]
}

/** The text of an entry wrapped under its head, indented, three rows at most, the third ending in an ellipsis when there was more. */
export function underRows(text: string, indent: string, rows = 3): string[] {
  const w = ROW_W - INNER - textWidth(CURSOR) - textWidth(indent)
  const out = wrapRows([text], w)
  const kept = out.slice(0, rows)
  if (out.length > rows) kept[rows - 1] = fitWidth(kept[rows - 1] + '…', w)
  return kept.map((r) => indent + r)
}

/** Every pane that waits, oldest first, drawn by the app as the list is: a tap opens the entry under the cursor, the menu parks or wakes it. */
export function inboxPage(m: Model, now: number): Page {
  const { items, entry } = inboxLayout(m, now)
  const cursor = Math.max(0, Math.min((m.inbox?.length ?? 1) - 1, m.inboxCursor))
  const start = inboxWindow(entry, cursor, m.inboxStart)
  const blocks = entriesBlocks(items, entry, cursor, start)
  const n = m.inbox?.length ?? 0
  const under = inboxEntry(m)
  const menu: MenuSpec[] = under && canPark(m, under) ? [{ id: MENU.later, label: under.later ? 'Wake' : 'Later' }] : []
  const park = menu.length ? ` · ≡ ${under!.later ? 'wake' : 'later'}` : ''
  return { kind: 'dash', ...hint(m, `inbox · ${n} waiting · ▽ move · ● open${park} · ×× back`), blocks, charts: [], items: [], menu }
}

// --- messages and mail --------------------------------------------------------------------

/** The name of a pane at one end of an exchange: its alias in the entry, the pane's name from the listing by its id then its address, else the address without the host; nobody is the actor. */
export function endName(m: Pick<Model, 'panes'>, end: TalkEnd | null, actor: string): string {
  if (!end) return actor || 'someone'
  if (end.alias) return end.alias
  const p = (end.id && m.panes.find((x) => x.id === end.id && x.host === end.address.split('/')[0])) || m.panes.find((x) => x.address === end.address)
  if (p) return paneName(p)
  return end.address.slice(end.address.indexOf('/') + 1)
}

/** The pane at one end, as the listing has it: by its id on its host, else by its address. */
export function endPane(m: Pick<Model, 'panes'>, end: TalkEnd | null): Pane | undefined {
  if (!end) return undefined
  return (end.id && m.panes.find((x) => x.id === end.id && x.host === end.address.split('/')[0])) || m.panes.find((x) => x.address === end.address)
}

/** Whether an entry is the pane's: it wrote it or received it, by id first, then by address. */
export function involves(t: Talk, p: Pane): boolean {
  const is = (e: TalkEnd | null) => !!e && ((!!p.id && e.id === p.id && e.address.split('/')[0] === p.host) || e.address === p.address)
  return is(t.from) || is(t.to)
}

/** The messages page's rows: each entry's head, who → whom and the age, with its kind, then the text under it; a reply one step further in when what it answers is on the page. */
export function messagesLayout(m: Pick<Model, 'panes'>, talk: Talk[], now: number): { items: string[]; entry: number[] } {
  if (!talk.length) return { items: ['nothing said yet'], entry: [-1] }
  const items: string[] = []
  const entry: number[] = []
  talk.forEach((t, i) => {
    const reply = t.replyTo > 0 && talk.some((x) => x.kind === 'mail' && x.id === t.replyTo)
    const kind = t.kind === 'mail' ? (t.replyTo ? ' · reply' : ' · mail') : t.kind === 'text' ? '' : ` · ${t.kind}`
    const lead = reply ? '  ' : ''
    items.push(`${lead}${endName(m, t.from, t.actor)} → ${endName(m, t.to, '')} · ${ago(t.at, now)}${kind}`)
    entry.push(i)
    if (t.text) {
      for (const r of underRows(t.text, lead + '    ')) {
        items.push(r)
        entry.push(i)
      }
    }
  })
  return { items, entry }
}

export function messagesPage(m: Model, talk: Talk[], about: Pane | null, cursor: number, start: number, now: number): Page {
  const { items, entry } = messagesLayout(m, talk, now)
  const c = Math.max(0, Math.min(talk.length - 1, cursor))
  const s = inboxWindow(entry, c, start)
  const blocks = entriesBlocks(items, entry, c, s)
  const t = talk[c]
  const open = t ? (t.kind === 'mail' ? '● the mail' : '● side by side') : ''
  const title = about ? `messages · ${paneName(about)}` : 'messages'
  return { kind: 'dash', ...hint(m, `${title} · ${talk.length} · ▽ move${open ? ' · ' + open : ''} · ×× back`), blocks, charts: [], items: [], menu: [] }
}

/** One row of the mail page: what came in from the mailbox, what went out from the feed, merged by time. */
export type MailEntry = { kind: 'in'; mail: Mail; at: number } | { kind: 'out'; talk: Talk; at: number }

export function mailEntries(mailbox: Mail[], talk: Talk[], p: Pane): MailEntry[] {
  const out: MailEntry[] = mailbox.map((mail) => ({ kind: 'in', mail, at: mail.at }))
  for (const t of talk) {
    if (t.kind !== 'mail' || !t.from) continue
    const mine = (!!p.id && t.from.id === p.id && t.from.address.split('/')[0] === p.host) || t.from.address === p.address
    if (mine) out.push({ kind: 'out', talk: t, at: t.at })
  }
  return out.sort((a, b) => a.at - b.at || (a.kind === 'in' ? a.mail.id : a.talk.seq) - (b.kind === 'in' ? b.mail.id : b.talk.seq))
}

export function mailLayout(m: Pick<Model, 'panes'>, entries: MailEntry[], now: number): { items: string[]; entry: number[] } {
  if (!entries.length) return { items: ['no mail'], entry: [-1] }
  const items: string[] = []
  const entry: number[] = []
  entries.forEach((e, i) => {
    let head: string
    let text: string
    if (e.kind === 'in') {
      head = `← ${endName(m, e.mail.from, e.mail.actor)} · ${ago(e.mail.at, now)}` + (e.mail.readAt ? '' : ' · unread') + (e.mail.replied ? ' · replied' : '')
      text = e.mail.text
    } else {
      head = `→ ${endName(m, e.talk.to, '')} · ${ago(e.talk.at, now)}` + (e.talk.bytes > e.talk.text.length ? ' · cut' : '')
      text = e.talk.text
    }
    items.push(head)
    entry.push(i)
    for (const r of underRows(text, '    ')) {
      items.push(r)
      entry.push(i)
    }
  })
  return { items, entry }
}

/** The pane a received mail is answered to: its origin, when that is a pane in the listing the token may write. */
export function mailBackTo(m: Pick<Model, 'panes'>, e: MailEntry | undefined): Pane | undefined {
  if (!e || e.kind !== 'in') return undefined
  const p = endPane(m, e.mail.from)
  return p?.writable ? p : undefined
}

export function mailPage(m: Model, p: Pane, mailbox: Mail[] | null, talk: Talk[], cursor: number, start: number, now: number): Page {
  const entries = mailbox ? mailEntries(mailbox, talk, p) : []
  const { items, entry } = mailbox ? mailLayout(m, entries, now) : { items: ['reading the mail…'], entry: [-1] }
  const c = Math.max(0, Math.min(entries.length - 1, cursor))
  const s = inboxWindow(entry, c, start)
  const blocks = entriesBlocks(items, entry, c, s)
  const unread = mailbox?.filter((x) => !x.readAt).length ?? 0
  const menu: MenuSpec[] = []
  if (p.writable && hostOf(m, p)?.mail) menu.push({ id: MENU.mail, label: `Mail ${paneName(p)}` })
  menu.push({ id: MENU.messages, label: `Messages with ${paneName(p)}` })
  const back = mailBackTo(m, entries[c]) ? ' · ● mail back' : ''
  return { kind: 'dash', ...hint(m, `mail · ${paneName(p)} · ${unread} unread · ▽ move${back} · ≡ menu · ×× back`), blocks, charts: [], items: [], menu }
}

function textBox(text: string): Block {
  const lines = wrapRows([text], BOX_W).slice(0, BOX_ROWS)
  return { name: 'text', x: 0, y: BODY_Y, w: CANVAS_W, h: BOX_ROWS * LINE_H + 12, lines, level: 4, border: true }
}

/** The suggestion's confirmation: every word that will be sent, in a box; a tap sends it. */
export function offerPage(m: Model, p: Pane, a: Answer): Page {
  const text = a.pieces[0]?.text ?? ''
  const blocks: Block[] = [{ name: 'title', x: 0, y: TOP, w: BESIDE_W, h: TITLE_H, lines: [`send this to ${paneName(p)}?`], level: 4 }, textBox(text), catcher()]
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

/** What a spoken text is for: typed into a pane, mailed to one, or a session's name. */
export type VoiceUse = { kind: 'input'; name: string } | { kind: 'mail'; name: string } | { kind: 'session'; host: string }

export function voiceUseOf(u: VoiceUse): string {
  return voiceFor(u)
}

function voiceFor(u: VoiceUse): string {
  return u.kind === 'input' ? u.name : u.kind === 'mail' ? `mail to ${u.name}` : `a session on ${u.host}`
}

export function listenPage(m: Model, u: VoiceUse, v: VoiceView): Page {
  const blocks: Block[] = []
  const charts: Chart[] = []
  const name = voiceFor(u)
  if (v.phase === 'recording') {
    blocks.push(catcher(), { name: 'state', x: 0, y: TOP, w: BESIDE_W, h: TITLE_H, lines: [`● listening · ${Math.round(v.seconds)} s · ${name}`], level: 4 })
    const graph = sparkline(v.levels, GRAPH_W, GRAPH_H)
    charts.push(...tiles(graph, 8, BODY_Y, `levels:${v.levels.length}:${v.levels.slice(-6).map((l) => Math.round(l * 20)).join(',')}`))
    blocks.push({ name: 'note', x: 8, y: BODY_Y + GRAPH_H + 24, w: CANVAS_W - 16, h: LINE_H * 2, lines: [`${Math.round(v.seconds)} of 60 s · tap when done`, 'what you say goes to your hub, then to its transcriber'], level: 2 })
    return { kind: 'dash', ...hint(m, '● stop · ×× cancel'), blocks, charts, items: [], menu: [] }
  }
  if (v.phase === 'working') {
    blocks.push(catcher(), { name: 'state', x: 0, y: TOP, w: BESIDE_W, h: TITLE_H, lines: [`transcribing ${v.seconds.toFixed(1)} s of audio…`], level: 4 })
    blocks.push({ name: 'note', x: 8, y: BODY_Y, w: CANVAS_W - 16, h: LINE_H * 2 + 12, lines: ['the hub is listening to it', 'a few seconds on a small server'], level: 2, border: true })
    return { kind: 'dash', ...hint(m, '×× cancel'), blocks, charts, items: [], menu: [] }
  }
  blocks.push(catcher(), { name: 'state', x: 0, y: TOP, w: BESIDE_W, h: TITLE_H, lines: [v.error || 'nothing recorded'], level: 4 })
  blocks.push({ name: 'note', x: 8, y: BODY_Y, w: CANVAS_W - 16, h: LINE_H + 12, lines: ['tap to say it again'], level: 2, border: true })
  return { kind: 'dash', ...hint(m, '● say it again · ×× cancel'), blocks, charts, items: [], menu: [] }
}

export function heardPage(m: Model, u: VoiceUse, v: VoiceView): Page {
  const blocks: Block[] = []
  blocks.push(catcher(), { name: 'title', x: 0, y: TOP, w: BESIDE_W, h: TITLE_H, lines: [`heard this · ${v.seconds.toFixed(1)} s · for ${voiceFor(u)}`], level: 4 })
  blocks.push(textBox(v.text))
  const menu: MenuSpec[] = u.kind === 'input' ? [{ id: MENU.typeOnly, label: 'Type without Enter' }] : []
  menu.push({ id: MENU.sayAgain, label: 'Say it again' })
  const act = u.kind === 'input' ? '● send + Enter' : u.kind === 'mail' ? '● mail' : '● name it'
  return { kind: 'dash', ...hint(m, `${act} · ≡ menu · ×× cancel`), blocks, charts: [], items: [], menu }
}
