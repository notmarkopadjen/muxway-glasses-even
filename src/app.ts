// The app on the glasses: a stack of pages, the gestures, the polling of
// the open pane and the pane list, the long poll for events, and the
// answers that go back.

import { OsEventTypeList, type EvenAppBridge, type EvenHubEvent } from '@evenrealities/even_hub_sdk'
import { ANSWERS, short, type Answer } from './answers.ts'
import { ApiError, api } from './api.ts'
import { BODY_LINES, Glasses, PIN_LINES, SPLIT_LINES, type Block, type MenuSpec, type Page } from './glasses.ts'
import { runsClaude, shapeClaude } from './lens.ts'
import { paneName, parseEvents, parsePanes, type Attention, type Pane } from './protocol.ts'
import { forgetToken, getSettings, isConfigured } from './settings.ts'
import { LINE_PX, rows as splitRows, wrapRows } from './text.ts'

type View =
  | { kind: 'panes'; page: number }
  | { kind: 'pane'; pane: Pane }
  | { kind: 'answers'; pane: Pane }
  | { kind: 'confirm'; pane: Pane; answer: Answer }

const MARK: Record<Attention | '', string> = { question: '★', permission: '★', done: '●', idle: '○', '': '·' }
const WORDS: Record<Attention, string> = { question: 'asks a question', permission: 'needs permission', idle: 'idle', done: 'done' }
const LIST_EVERY_MS = 10_000
const TOAST_MS = 10_000
const FLASH_MS = 4_000
const MENU_CLOSE_MS = 1500
const ROWS_PER_LIST_PAGE = 19

const MENU = { refresh: 1, reveal: 2, bottom: 3, panes: 4, needsYou: 5 }

interface Attn {
  kind: Attention
  text: string
  at: number
}

export class App {
  private view: Glasses
  private stack: View[] = [{ kind: 'panes', page: 0 }]
  private panes: Pane[] = []
  private attention = new Map<string, Attn>()
  private listError: string | null = null
  private listBusy = false
  private listTimer: ReturnType<typeof setTimeout> | null = null
  /** The open pane: its rows as the hub sent them, the lines they became, and where the view is. */
  private raw: string[] = []
  private etag = ''
  private body: string[] = []
  private pinned: string[] = []
  private offset = 0
  private reveal = false
  private paneError: string | null = null
  private paneBusy = false
  private paneTimer: ReturnType<typeof setTimeout> | null = null
  private flash: { text: string; until: number } | null = null
  private toast: { text: string; until: number } | null = null
  private clearTimer: ReturnType<typeof setTimeout> | null = null
  private cursor: number | null = null
  private eventsRunning = false
  private eventsGen = 0
  private backoff = 5_000
  private foreground = true
  private menuAt = 0
  private unsubscribe: (() => void) | null = null
  /** The phone pane is told which pane is open, for its reply box. */
  onPane: ((pane: Pane | null) => void) | null = null

  private bridge: EvenAppBridge
  private log: (m: string, cls?: '' | 'ok' | 'bad') => void

  constructor(bridge: EvenAppBridge, log: (m: string, cls?: '' | 'ok' | 'bad') => void, trace: ((p: Page) => void) | null) {
    this.bridge = bridge
    this.log = log
    this.view = new Glasses(bridge, (m) => log('glasses: ' + m), trace)
    this.unsubscribe = bridge.onEvenHubEvent((e) => void this.onEvent(e))
  }

  // ---------------------------------------------------------------- lifecycle
  async start() {
    await this.redraw()
    this.wake()
  }

  stop() {
    this.sleep()
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /** From the phone pane after settings were saved: start over with them. */
  async onSettingsChanged() {
    this.listError = null
    this.paneError = null
    this.etag = ''
    this.sleep()
    await this.redraw()
    this.wake()
  }

  private wake() {
    this.foreground = true
    if (!isConfigured()) return
    this.scheduleList(0)
    if (this.top.kind === 'pane') this.schedulePane(0)
    this.runEvents()
  }

  private sleep() {
    this.foreground = false
    if (this.listTimer) clearTimeout(this.listTimer)
    if (this.paneTimer) clearTimeout(this.paneTimer)
    this.listTimer = this.paneTimer = null
    this.eventsGen++
    this.eventsRunning = false
  }

  // -------------------------------------------------------------------- data
  private scheduleList(ms: number) {
    if (this.listTimer) clearTimeout(this.listTimer)
    this.listTimer = setTimeout(() => void this.readList(), ms)
  }

  private async readList() {
    if (!this.foreground || this.listBusy || !isConfigured()) return
    this.listBusy = true
    const t0 = Date.now()
    try {
      const a = await api.panes()
      this.panes = parsePanes(a.body)
      for (const p of this.panes) {
        const have = this.attention.get(p.address)
        if (p.attention) {
          if (!have || have.kind !== p.attention) this.attention.set(p.address, { kind: p.attention, text: have?.text ?? '', at: have?.at ?? 0 })
        } else if (have && have.at < t0 - 2000) {
          this.attention.delete(p.address)
        }
      }
      this.listError = null
      this.log(`GET panes ${a.status} ${this.panes.length} panes ${Date.now() - t0} ms`)
    } catch (e) {
      this.listError = await this.failed(e, 'GET panes')
    } finally {
      this.listBusy = false
    }
    await this.redraw()
    if (this.foreground) this.scheduleList(LIST_EVERY_MS)
  }

  private schedulePane(ms: number) {
    if (this.paneTimer) clearTimeout(this.paneTimer)
    this.paneTimer = setTimeout(() => void this.readPane(), ms)
  }

  private get open(): Pane | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const v = this.stack[i]
      if (v.kind !== 'panes') return v.pane
    }
    return null
  }

  private async readPane(now = false) {
    const pane = this.open
    if (!pane || !this.foreground || this.paneBusy) return
    if (this.offset > 0 && !now) return
    this.paneBusy = true
    const t0 = Date.now()
    try {
      const a = await api.pane(pane.address, this.etag)
      if (a.status !== 304) {
        this.raw = splitRows(a.body)
        this.etag = a.etag
        this.shape(pane)
      }
      this.paneError = null
      this.log(`GET pane ${a.status} ${a.body.length} chars ${Date.now() - t0} ms`)
    } catch (e) {
      this.paneError = await this.failed(e, 'GET pane')
    } finally {
      this.paneBusy = false
    }
    await this.redraw()
    if (this.foreground && this.open) this.schedulePane(getSettings().every * 1000)
  }

  /** The rows through the lens, then wrapped by pixels. */
  private shape(pane: Pane) {
    let shaped = null
    if (getSettings().lens) shaped = shapeClaude(this.raw, this.reveal, runsClaude(pane.command))
    this.body = wrapRows(shaped ? shaped.body : this.raw, LINE_PX)
    this.pinned = shaped ? wrapRows(shaped.pinned, LINE_PX) : []
    const pages = Math.max(1, Math.ceil(this.body.length / this.pageSize))
    if (this.offset > pages - 1) this.offset = pages - 1
  }

  private get pageSize(): number {
    return this.pinned.length ? SPLIT_LINES : BODY_LINES
  }

  /** A failed request in a few words for the head; a refused token is forgotten at once. */
  private async failed(e: unknown, what: string): Promise<string> {
    const err = e instanceof ApiError ? e : new ApiError(0)
    this.log(`${what}: ${err.message}`, 'bad')
    if (err.status === 401) {
      await forgetToken()
      this.sleep()
      this.stack = [{ kind: 'panes', page: 0 }]
      this.panes = []
      this.onPane?.(null)
      return 'token refused · set it on the phone'
    }
    if (err.status === 429) {
      this.sleep()
      setTimeout(() => this.wake(), 10_000)
    }
    return err.message
  }

  private runEvents() {
    if (this.eventsRunning) return
    this.eventsRunning = true
    const gen = ++this.eventsGen
    void (async () => {
      while (gen === this.eventsGen && this.foreground) {
        try {
          const a = await api.events(this.cursor)
          if (gen !== this.eventsGen) return
          const r = parseEvents(a.body)
          this.backoff = 5_000
          if (this.cursor !== null) for (const ev of r.events) this.onNotify(ev.address, ev.kind, ev.text)
          this.cursor = r.next
        } catch (e) {
          if (gen !== this.eventsGen) return
          const err = e instanceof ApiError ? e : new ApiError(0)
          this.log('GET events: ' + err.message, 'bad')
          if (err.status === 401 || err.status === 429) {
            this.listError = await this.failed(err, 'GET events')
            await this.redraw()
            return
          }
          await new Promise((r) => setTimeout(r, this.backoff))
          this.backoff = Math.min(60_000, this.backoff * 2)
        }
      }
    })().finally(() => {
      if (gen === this.eventsGen) this.eventsRunning = false
    })
  }

  private onNotify(address: string, kind: Attention | 'working', text: string) {
    const pane = this.panes.find((p) => p.address === address)
    const name = pane ? paneName(pane) : address.slice(address.indexOf('/') + 1)
    if (kind === 'working') {
      this.attention.delete(address)
      if (pane) pane.attention = ''
    } else {
      this.attention.set(address, { kind, text, at: Date.now() })
      if (pane) pane.attention = kind
      this.toast = { text: `${MARK[kind]} ${name}: ${text || WORDS[kind]}`, until: Date.now() + TOAST_MS }
      this.later(TOAST_MS)
    }
    this.log(`event ${kind} on ${name}`)
    if (this.open?.address === address) this.schedulePane(0)
    void this.redraw()
    this.scheduleList(0)
  }

  /** Redraws once the flash or the toast has run out. */
  private later(ms: number) {
    if (this.clearTimer) clearTimeout(this.clearTimer)
    this.clearTimer = setTimeout(() => void this.redraw(), ms + 50)
  }

  // ---------------------------------------------------------------- gestures
  private async onEvent(e: EvenHubEvent) {
    if (e.menuItemClickEvent?.itemID != null) {
      this.menuAt = Date.now()
      this.awake()
      await this.onMenu(e.menuItemClickEvent.itemID)
      return
    }
    const sys = typeOf(e.sysEvent)
    const text = typeOf(e.textEvent)
    const list = typeOf(e.listEvent)
    if (e.listEvent || e.textEvent || (sys !== null && sys <= OsEventTypeList.DOUBLE_CLICK_EVENT)) this.awake()
    if (sys === OsEventTypeList.DOUBLE_CLICK_EVENT || text === OsEventTypeList.DOUBLE_CLICK_EVENT || list === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      await this.back()
      return
    }
    if (text === OsEventTypeList.SCROLL_TOP_EVENT || text === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      await this.onScroll(text === OsEventTypeList.SCROLL_BOTTOM_EVENT ? 1 : -1)
      return
    }
    if (e.listEvent) {
      if (list === OsEventTypeList.SCROLL_BOTTOM_EVENT || list === OsEventTypeList.SCROLL_TOP_EVENT) return
      const idx = e.listEvent.currentSelectItemIndex
      await this.onSelect(typeof idx === 'number' && idx >= 0 ? idx : 0)
      return
    }
    if (e.sysEvent) {
      switch (sys) {
        case OsEventTypeList.CLICK_EVENT:
          if (this.top.kind === 'pane') await this.onTap()
          break
        case OsEventTypeList.FOREGROUND_EXIT_EVENT:
          if (Date.now() - this.menuAt > MENU_CLOSE_MS) this.sleep()
          break
        case OsEventTypeList.FOREGROUND_ENTER_EVENT:
          this.wake()
          break
        case OsEventTypeList.SYSTEM_EXIT_EVENT:
        case OsEventTypeList.ABNORMAL_EXIT_EVENT:
          this.stop()
          break
      }
    }
  }

  /** A gesture reaches the app only while it is on screen, whatever the last foreground event said. */
  private awake() {
    if (!this.foreground) this.wake()
  }

  private get top(): View {
    return this.stack[this.stack.length - 1]
  }

  private async push(v: View) {
    this.flash = null
    this.stack.push(v)
    await this.redraw()
  }

  private async back() {
    if (this.stack.length === 1) {
      this.stop()
      await this.bridge.shutDownPageContainer()
      return
    }
    const left = this.stack.pop()!
    this.flash = null
    if (left.kind === 'pane') {
      this.raw = []
      this.body = []
      this.pinned = []
      this.etag = ''
      this.offset = 0
      this.reveal = false
      this.paneError = null
      if (this.paneTimer) clearTimeout(this.paneTimer)
      this.paneTimer = null
      this.onPane?.(null)
    }
    await this.redraw()
  }

  private async onScroll(dir: 1 | -1) {
    if (this.top.kind !== 'pane') return
    const pages = Math.max(1, Math.ceil(this.body.length / this.pageSize))
    const was = this.offset
    if (dir < 0) this.offset = Math.min(pages - 1, this.offset + 1)
    else this.offset = Math.max(0, this.offset - 1)
    if (this.offset === was) return
    await this.redraw()
    if (this.offset === 0) this.schedulePane(0)
  }

  private async onTap() {
    const v = this.top
    if (v.kind !== 'pane') return
    if (v.pane.writable) await this.push({ kind: 'answers', pane: v.pane })
    else await this.readPane(true)
  }

  private async onSelect(idx: number) {
    const v = this.top
    if (v.kind === 'panes') {
      const shown = this.listed(v.page)
      if (idx === ROWS_PER_LIST_PAGE && shown.length > ROWS_PER_LIST_PAGE) {
        v.page++
        await this.redraw()
        return
      }
      const pane = shown[idx]
      if (!pane) return
      await this.openPane(pane)
    } else if (v.kind === 'answers') {
      const a = ANSWERS[idx]
      if (a) await this.push({ kind: 'confirm', pane: v.pane, answer: a })
    } else if (v.kind === 'confirm') {
      const { pane, answer } = v
      this.stack.pop()
      this.stack.pop()
      await this.redraw()
      if (idx === 1) await this.send(pane, answer)
    }
  }

  private async openPane(pane: Pane) {
    this.raw = []
    this.body = []
    this.pinned = []
    this.etag = ''
    this.offset = 0
    this.reveal = false
    this.paneError = null
    await this.push({ kind: 'pane', pane })
    this.onPane?.(pane)
    this.schedulePane(0)
  }

  private async onMenu(id: number) {
    switch (id) {
      case MENU.refresh:
        this.scheduleList(0)
        if (this.top.kind === 'pane') await this.readPane(true)
        break
      case MENU.reveal:
        if (this.top.kind === 'pane') {
          this.reveal = !this.reveal
          this.shape(this.top.pane)
          await this.redraw()
        }
        break
      case MENU.bottom:
        this.offset = 0
        await this.redraw()
        this.schedulePane(0)
        break
      case MENU.panes:
        while (this.stack.length > 1) await this.back()
        break
      case MENU.needsYou: {
        const pane = this.needsYou()
        if (!pane) break
        while (this.stack.length > 1) await this.back()
        await this.openPane(pane)
        break
      }
    }
  }

  /** Sends the answer piece by piece and says what happened in the head. */
  private async send(pane: Pane, answer: Answer) {
    let words = 'sent ' + short(answer)
    try {
      for (const p of answer.pieces) {
        if (p.text !== undefined) await api.text(pane.address, p.text)
        else if (p.key !== undefined) await api.key(pane.address, p.key)
      }
      this.log(`sent ${short(answer)} to ${paneName(pane)}`, 'ok')
    } catch (e) {
      words = await this.failed(e, 'POST input')
    }
    this.flash = { text: words, until: Date.now() + FLASH_MS }
    this.later(FLASH_MS)
    this.offset = 0
    await this.redraw()
    await this.readPane(true)
  }

  /** From the phone pane: typed text to the open pane. */
  async sendText(text: string, enter: boolean): Promise<string> {
    const pane = this.open
    if (!pane) return 'open a pane on the glasses first'
    if (!pane.writable) return 'that pane is read-only'
    try {
      await api.text(pane.address, text)
      if (enter) await api.key(pane.address, 'Enter')
    } catch (e) {
      return await this.failed(e, 'POST input')
    }
    this.flash = { text: enter ? 'sent from the phone ⏎' : 'typed from the phone', until: Date.now() + FLASH_MS }
    this.later(FLASH_MS)
    this.offset = 0
    await this.redraw()
    await this.readPane(true)
    return ''
  }

  // ------------------------------------------------------------------- pages
  private sorted(): Pane[] {
    const rank = (p: Pane) => (p.attention === 'question' || p.attention === 'permission' ? 0 : p.attention ? 1 : 2)
    return this.panes.slice().sort((a, b) => rank(a) - rank(b) || a.address.localeCompare(b.address))
  }

  private listed(page: number): Pane[] {
    return this.sorted().slice(page * ROWS_PER_LIST_PAGE)
  }

  private needsYou(): Pane | null {
    let best: Pane | null = null
    let bestAt = -1
    for (const p of this.sorted()) {
      const a = this.attention.get(p.address)
      if (!a) continue
      const at = (a.kind === 'question' || a.kind === 'permission' ? 1e13 : 0) + a.at
      if (at > bestAt) {
        best = p
        bestAt = at
      }
    }
    return best
  }

  private async redraw() {
    await this.view.show(this.page())
  }

  private hint(base: string): { hint: string; hintLevel: number } {
    if (this.toast && this.toast.until > Date.now()) return { hint: this.toast.text, hintLevel: 4 }
    return { hint: base, hintLevel: 1 }
  }

  private page(): Page {
    const v = this.top
    const menu: MenuSpec[] = [{ id: MENU.refresh, label: 'Refresh' }]
    const needs = this.needsYou()
    if (v.kind === 'panes') {
      let head: string
      if (this.listError) head = 'muxway · ' + this.listError
      else if (!isConfigured()) head = 'muxway · set the hub and token on the phone'
      else {
        const n = this.panes.length
        const m = this.panes.filter((p) => p.attention === 'question' || p.attention === 'permission').length
        head = `muxway · ${n} ${n === 1 ? 'pane' : 'panes'}` + (m ? ` · ${m} ${m === 1 ? 'needs' : 'need'} you` : '')
      }
      const shown = this.listed(v.page)
      const items = shown.slice(0, ROWS_PER_LIST_PAGE).map((p) => {
        const name = paneName(p)
        return `${MARK[p.attention]} ${name}` + (p.command && p.command !== name ? ` · ${p.command}` : '') + (p.writable ? '' : ' · read-only')
      })
      if (shown.length > ROWS_PER_LIST_PAGE) items.push(`→ next ${shown.length - ROWS_PER_LIST_PAGE} more`)
      if (needs) menu.push({ id: MENU.needsYou, label: 'Needs you: ' + paneName(needs) })
      return { kind: 'list', head, ...this.hint('▽ choose · ● open · ×× exit'), blocks: [], items, menu }
    }
    if (v.kind === 'pane') {
      const p = v.pane
      const a = this.attention.get(p.address)
      let state: string
      if (this.flash && this.flash.until > Date.now()) state = this.flash.text
      else if (this.paneError) state = this.paneError
      else if (a) state = WORDS[a.kind]
      else if (this.offset > 0) state = `paused · ${this.offset} ${this.offset === 1 ? 'page' : 'pages'} up`
      else state = this.raw.length ? 'following' : 'reading…'
      const head = `${MARK[a?.kind ?? '']} ${paneName(p)} · ${p.command || '?'} · ${state}`
      const size = this.pageSize
      const end = this.body.length - this.offset * size
      const lines = this.body.slice(Math.max(0, end - size), Math.max(0, end))
      while (lines.length < size) lines.unshift('')
      const blocks: Block[] = [{ lines, height: size, level: 3 }]
      if (this.pinned.length) blocks.push({ lines: this.pinned.slice(-PIN_LINES), height: PIN_LINES, level: 4 })
      if (getSettings().lens) menu.push({ id: MENU.reveal, label: this.reveal ? 'Lens on' : 'Reveal all' })
      menu.push({ id: MENU.bottom, label: 'Bottom' }, { id: MENU.panes, label: 'Panes' })
      if (needs && needs.address !== p.address) menu.push({ id: MENU.needsYou, label: 'Needs you: ' + paneName(needs) })
      const base = `▽ page · ● ${p.writable ? 'answer' : 'refresh'} · ≡ menu · ×× back`
      return { kind: 'text', head, ...this.hint(base), blocks, items: [], menu }
    }
    if (v.kind === 'answers') {
      menu.push({ id: MENU.panes, label: 'Panes' })
      return { kind: 'list', head: 'answer ' + paneName(v.pane), ...this.hint('▽ choose · ● pick · ×× back'), blocks: [], items: ANSWERS.map((a) => a.label), menu }
    }
    menu.push({ id: MENU.panes, label: 'Panes' })
    return {
      kind: 'list',
      head: `send ${short(v.answer)} to ${paneName(v.pane)}?`,
      ...this.hint('▽ choose · ● pick · ×× back'),
      blocks: [],
      items: ['Cancel', 'Confirm'],
      menu,
    }
  }
}

function typeOf(ev?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!ev) return null
  return ev.eventType ?? OsEventTypeList.CLICK_EVENT
}
