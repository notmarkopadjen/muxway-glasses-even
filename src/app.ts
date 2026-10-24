// The app on the glasses: the pane list, panes held on it side by side,
// one pane, the answers, spoken replies; the polling of what is on screen
// and the long poll for events.

import { OsEventTypeList, type EvenAppBridge, type EvenHubEvent } from '@evenrealities/even_hub_sdk'
import { ANSWERS, short, type Answer } from './answers.ts'
import { ApiError, api } from './api.ts'
import { Glasses, type Page } from './glasses.ts'
import { paneName, parseEvents, parseHosts, parsePanes, type Attention, type Host, type Pane } from './protocol.ts'
import { forgetToken, getSettings, isConfigured } from './settings.ts'
import { rows as splitRows, typed } from './text.ts'
import * as V from './views.ts'
import { GRACE_SECONDS, MIN_SECONDS, Recorder, toneFrame } from './voice.ts'

type View =
  | { kind: 'list' }
  | { kind: 'split' }
  | { kind: 'pane'; pane: Pane; fromSplit: boolean }
  | { kind: 'answers'; pane: Pane }
  | { kind: 'confirm'; pane: Pane; answer: Answer }
  | { kind: 'listen'; pane: Pane }
  | { kind: 'heard'; pane: Pane }

interface Voice {
  phase: 'recording' | 'working' | 'review' | 'error'
  seconds: number
  text: string
  error: string
}

interface Attn {
  kind: Attention
  text: string
  at: number
}

const LIST_EVERY_MS = 10_000
const TOAST_MS = 10_000
const FLASH_MS = 4_000
const MENU_CLOSE_MS = 1500
const DOTS_MS = 500
const NOTE_MS = 3_000

export class App {
  private bridge: EvenAppBridge
  private log: (m: string, cls?: '' | 'ok' | 'bad') => void
  private view: Glasses
  private stack: View[] = [{ kind: 'list' }]
  private panes: Pane[] = []
  private hosts: Host[] = []
  private attention = new Map<string, Attn>()
  private listError: string | null = null
  private listBusy = false
  private listTimer: ReturnType<typeof setTimeout> | null = null
  /** What was read of each pane, by address; the pages wrap it to their width. */
  private readers = new Map<string, V.Reader & { etag: string }>()
  private readBusy = false
  private readTimer: ReturnType<typeof setTimeout> | null = null
  private offset = 0
  private reveal = false
  /** The panes held on the list, by address, at most three. */
  private selected: string[] = []
  /** Selection mode on the list: a tap selects the row under the cursor instead of opening it. */
  private selecting = false
  /** The column the last scroll opened, -1 for none. */
  private marked = -1
  /** The list's cursor and its window's first row. */
  private row = 0
  private winStart = 0
  /** Whether a listing has arrived since the start, or since the settings changed. */
  private loaded = false
  private dots = 1
  private dotsTimer: ReturnType<typeof setInterval> | null = null
  private flash: { text: string; until: number } | null = null
  private toast: { text: string; until: number } | null = null
  private clearTimer: ReturnType<typeof setTimeout> | null = null
  private clockTimer: ReturnType<typeof setInterval> | null = null
  private cursor: number | null = null
  private eventsRunning = false
  private eventsGen = 0
  private backoff = 5_000
  private foreground = true
  private menuAt = 0
  private unsubscribe: (() => void) | null = null
  private canSpeak = false
  private probed = false
  private recorder: Recorder
  private voice: Voice | null = null
  private voiceTimer: ReturnType<typeof setInterval> | null = null
  /** Frames from a generated tone instead of the mic: the test harness, loopback only. */
  toneMic = false
  private toneTimer: ReturnType<typeof setInterval> | null = null
  /** The phone pane is told which pane is open, for its reply box. */
  onPane: ((pane: Pane | null) => void) | null = null

  constructor(bridge: EvenAppBridge, log: (m: string, cls?: '' | 'ok' | 'bad') => void, trace: ((p: Page) => void) | null) {
    this.bridge = bridge
    this.log = log
    this.view = new Glasses(bridge, (m) => log('glasses: ' + m), trace)
    this.recorder = new Recorder(bridge)
    this.unsubscribe = bridge.onEvenHubEvent((e) => void this.onEvent(e))
  }

  // ---------------------------------------------------------------- lifecycle
  async start() {
    await this.redraw()
    this.wake()
  }

  stop() {
    this.sleep()
    void this.endVoice()
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /** From the phone pane after settings were saved: start over with them. */
  async onSettingsChanged() {
    this.listError = null
    this.readers.clear()
    this.loaded = false
    this.selected = []
    this.selecting = false
    this.marked = -1
    this.stack = [{ kind: 'list' }]
    this.canSpeak = false
    this.probed = false
    this.sleep()
    await this.redraw()
    this.wake()
  }

  private wake() {
    this.foreground = true
    if (!this.clockTimer) this.clockTimer = setInterval(() => void this.redraw(), 30_000)
    if (!isConfigured()) return
    if (!this.loaded && !this.dotsTimer) {
      this.dotsTimer = setInterval(() => {
        this.dots = (this.dots % 3) + 1
        void this.redraw()
      }, DOTS_MS)
    }
    this.scheduleList(0)
    this.scheduleRead(0)
    this.runEvents()
  }

  private sleep() {
    this.foreground = false
    if (this.listTimer) clearTimeout(this.listTimer)
    if (this.readTimer) clearTimeout(this.readTimer)
    if (this.clockTimer) clearInterval(this.clockTimer)
    this.listTimer = this.readTimer = null
    this.clockTimer = null
    this.stopDots()
    this.eventsGen++
    this.eventsRunning = false
    if (this.voice?.phase === 'recording') void this.endVoice()
  }

  private stopDots() {
    if (this.dotsTimer) clearInterval(this.dotsTimer)
    this.dotsTimer = null
  }

  private async probeVoice() {
    if (!getSettings().voice) {
      this.canSpeak = false
      return
    }
    try {
      await api.transcribeProbe()
      this.canSpeak = true
      this.log('spoken replies: the hub has a transcriber')
    } catch (e) {
      this.canSpeak = false
      if (e instanceof ApiError && e.status === 404) this.log('spoken replies: no transcriber on the hub')
    }
  }

  // -------------------------------------------------------------------- data
  private get sorted(): Pane[] {
    return V.sorted(this.panes)
  }

  private scheduleList(ms: number) {
    if (this.listTimer) clearTimeout(this.listTimer)
    this.listTimer = setTimeout(() => void this.readList(), ms)
  }

  private async readList() {
    if (!this.foreground || this.listBusy || !isConfigured()) return
    this.listBusy = true
    const t0 = Date.now()
    try {
      const [a, h] = await Promise.all([api.panes(), api.hosts().catch(() => null)])
      this.panes = parsePanes(a.body)
      if (h) this.hosts = parseHosts(h.body)
      for (const p of this.panes) {
        const have = this.attention.get(p.address)
        if (p.attention) {
          if (!have || have.kind !== p.attention) this.attention.set(p.address, { kind: p.attention, text: p.attentionText, at: p.attentionAt * 1000 || have?.at || 0 })
        } else if (have && have.at < t0 - 2000) {
          this.attention.delete(p.address)
        }
      }
      this.listError = null
      this.loaded = true
      this.stopDots()
      // A pane that left the listing leaves the selection too.
      this.selected = this.selected.filter((addr) => this.panes.some((p) => p.address === addr))
      this.log(`GET panes ${a.status} ${this.panes.length} panes ${Date.now() - t0} ms`)
      if (!this.probed) {
        this.probed = true
        void this.probeVoice()
      }
    } catch (e) {
      this.listError = await this.failed(e, 'GET panes')
    } finally {
      this.listBusy = false
    }
    await this.redraw()
    if (this.foreground) this.scheduleList(LIST_EVERY_MS)
  }

  /** The panes on screen: the open pane, or the columns. */
  private watched(): Pane[] {
    const v = this.top
    if (v.kind === 'pane' || v.kind === 'answers' || v.kind === 'confirm' || v.kind === 'listen' || v.kind === 'heard') return [v.pane]
    if (v.kind === 'split') return this.columns()
    return []
  }

  /** The held panes in the list's order. */
  private columns(): Pane[] {
    return V.selectedPanes(this.model())
  }

  /** The pane a reply goes to: the open one, or the marked column. */
  private focus(): Pane | undefined {
    const v = this.top
    if (v.kind === 'split') return this.marked >= 0 ? this.columns()[this.marked] : undefined
    return this.watched()[0]
  }

  private scheduleRead(ms: number) {
    if (this.readTimer) clearTimeout(this.readTimer)
    this.readTimer = setTimeout(() => void this.readPanes(), ms)
  }

  /** Reads what is on screen, each pane with its own ETag; paused on a full pane, nothing is read. */
  private async readPanes(now = false) {
    if (!this.foreground || this.readBusy) return
    const v = this.top
    const paused = v.kind === 'pane' && this.offset > 0 && !now
    const panes = paused ? [] : this.watched()
    this.readBusy = true
    const t0 = Date.now()
    try {
      for (const p of panes) {
        const r = this.readers.get(p.address) ?? { raw: [], error: null, etag: '' }
        try {
          const a = await api.pane(p.address, r.etag)
          if (a.status !== 304) {
            r.raw = splitRows(a.body)
            r.etag = a.etag
          }
          r.error = null
          this.log(`GET pane ${a.status} ${a.body.length} chars ${Date.now() - t0} ms`)
        } catch (e) {
          r.error = await this.failed(e, 'GET pane')
          if (!this.foreground) return
        }
        this.readers.set(p.address, r)
      }
    } finally {
      this.readBusy = false
    }
    if (panes.length) await this.redraw()
    if (this.foreground) this.scheduleRead(getSettings().every * 1000)
  }

  /** A failed request in a few words; a refused token is forgotten at once. */
  private async failed(e: unknown, what: string): Promise<string> {
    const err = e instanceof ApiError ? e : new ApiError(0)
    this.log(`${what}: ${err.message}`, 'bad')
    if (err.status === 401) {
      await forgetToken()
      this.sleep()
      this.stack = [{ kind: 'list' }]
      this.panes = []
      this.selected = []
      this.marked = -1
      this.readers.clear()
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
      if (pane) {
        pane.attention = kind
        pane.attentionAt = Math.floor(Date.now() / 1000)
        pane.attentionText = text
      }
      this.toast = { text: `${V.MARK[kind]} ${name}: ${text || V.WORDS[kind]}`, until: Date.now() + TOAST_MS }
      this.later(TOAST_MS)
    }
    this.log(`event ${kind} on ${name}`)
    if (this.watched().some((p) => p.address === address)) this.scheduleRead(0)
    void this.redraw()
    this.scheduleList(0)
  }

  private later(ms: number) {
    if (this.clearTimer) clearTimeout(this.clearTimer)
    this.clearTimer = setTimeout(() => void this.redraw(), ms + 50)
  }

  // ---------------------------------------------------------------- gestures
  private async onEvent(e: EvenHubEvent) {
    if (e.audioEvent) {
      this.recorder.push(e.audioEvent.audioPcm as Uint8Array | number[] | undefined)
      return
    }
    if (e.menuItemClickEvent?.itemID != null) {
      this.menuAt = Date.now()
      this.awake()
      await this.onMenu(e.menuItemClickEvent.itemID)
      return
    }
    const sys = typeOf(e.sysEvent)
    const text = typeOf(e.textEvent)
    const list = typeOf(e.listEvent)
    const kinds = [sys, text, list]
    // Every gesture in the phone's log: what the glasses send is only known from there.
    this.log(`gesture${sys !== null ? ' sys ' + sys : ''}${text !== null ? ' text ' + text : ''}${list !== null ? ' list ' + list : ''}${e.listEvent?.currentSelectItemIndex !== undefined ? ' row ' + e.listEvent.currentSelectItemIndex : ''}`)
    if (e.listEvent || e.textEvent || (sys !== null && (sys <= OsEventTypeList.DOUBLE_CLICK_EVENT || sys === OsEventTypeList.LONG_PRESS_EVENT))) this.awake()
    if (kinds.includes(OsEventTypeList.LONG_PRESS_RELEASE_EVENT)) return
    if (kinds.includes(OsEventTypeList.LONG_PRESS_EVENT)) {
      await this.onHold()
      return
    }
    if (kinds.includes(OsEventTypeList.DOUBLE_CLICK_EVENT)) {
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
          if (this.top.kind !== 'answers' && this.top.kind !== 'confirm') await this.onTap()
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
    this.scheduleRead(0)
  }

  /** The double tap: back one page, and out of the app from the list, where the OS asks first. */
  private async back() {
    const v = this.top
    if (v.kind === 'list') {
      if (this.selecting) {
        this.selecting = false
        this.selected = []
        await this.redraw()
        return
      }
      // Nothing stops here: the OS says whether the wearer confirmed, with an exit event.
      await this.bridge.shutDownPageContainer(1)
      return
    }
    this.stack.pop()
    this.flash = null
    if (v.kind === 'listen' || v.kind === 'heard') await this.endVoice()
    if (v.kind === 'split') this.marked = -1
    if (v.kind === 'pane') {
      this.offset = 0
      this.reveal = false
      this.onPane?.(null)
    }
    await this.redraw()
    this.scheduleRead(0)
  }

  private async onScroll(dir: 1 | -1) {
    const v = this.top
    if (v.kind === 'list') {
      const n = V.listLayout(this.model(), Math.floor(Date.now() / 1000)).items.length
      const next = Math.max(0, Math.min(n - 1, this.row + dir))
      if (next === this.row) return
      this.row = next
      this.winStart = V.listWindow(n, next, this.winStart)
      await this.redraw()
      return
    }
    if (v.kind === 'split') {
      // The scroll opens a pane: the column after the marked one, or before it; the first or the last when none is marked.
      const cols = this.columns()
      if (!cols.length) return
      const next = this.marked < 0 ? (dir > 0 ? 0 : cols.length - 1) : this.marked + dir
      if (next < 0 || next >= cols.length) return
      this.marked = next
      await this.openPane(cols[next], true)
      return
    }
    if (v.kind !== 'pane') return
    const { size, total } = V.pageSize(v.pane, this.readers.get(v.pane.address), getSettings().lens, this.reveal)
    const pages = Math.max(1, Math.ceil(total / size))
    const was = this.offset
    if (dir < 0) this.offset = Math.min(pages - 1, this.offset + 1)
    else this.offset = Math.max(0, this.offset - 1)
    if (this.offset === was) return
    await this.redraw()
    if (this.offset === 0) this.scheduleRead(0)
  }

  private async onTap() {
    const v = this.top
    if (v.kind === 'listen') {
      if (this.voice?.phase === 'recording') await this.finishVoice(v.pane)
      else if (this.voice?.phase === 'error') await this.beginVoice(v.pane, true)
      return
    }
    if (v.kind === 'heard') {
      await this.sendVoice(v.pane, true)
      return
    }
    if (v.kind === 'list') {
      const row = this.listRow()
      if (!row) return
      switch (row.kind) {
        case 'pane':
          if (this.selecting) await this.toggle(row.pane)
          else await this.openPane(row.pane, false)
          break
        case 'open':
          this.marked = -1
          await this.push({ kind: 'split' })
          break
        case 'clear':
          this.selected = []
          this.selecting = false
          await this.redraw()
          break
      }
      return
    }
    if (v.kind === 'split') {
      const sel = this.focus()
      if (sel?.writable) await this.push({ kind: 'answers', pane: sel })
      else await this.readPanes(true)
      return
    }
    if (v.kind !== 'pane') return
    if (v.pane.writable) await this.push({ kind: 'answers', pane: v.pane })
    else await this.readPanes(true)
  }

  private async onSelect(idx: number) {
    const v = this.top
    if (v.kind === 'answers') {
      const offset = this.offersVoice(v.pane) ? 1 : 0
      if (offset && idx === 0) {
        await this.beginVoice(v.pane, false)
        return
      }
      const a = ANSWERS[idx - offset]
      if (a) await this.push({ kind: 'confirm', pane: v.pane, answer: a })
    } else if (v.kind === 'confirm') {
      const { pane, answer } = v
      this.stack.pop()
      this.stack.pop()
      await this.redraw()
      if (idx === 1) await this.send(pane, answer)
    }
  }

  /** The list's row under the cursor. */
  private listRow(): V.ListItem | undefined {
    const what = V.listLayout(this.model(), Math.floor(Date.now() / 1000)).what
    this.row = Math.max(0, Math.min(what.length - 1, this.row))
    return what[this.row]
  }

  /** A hold on the list starts selection mode with the pane under the cursor selected; in it, a hold selects too. */
  private async onHold() {
    if (this.top.kind !== 'list') return
    const row = this.listRow()
    if (!row || row.kind !== 'pane') return
    this.selecting = true
    await this.toggle(row.pane)
  }

  /** The pane joins the selection or leaves it, three at most. */
  private async toggle(pane: Pane) {
    const addr = pane.address
    if (this.selected.includes(addr)) this.selected = this.selected.filter((a) => a !== addr)
    else if (this.selected.length >= V.MAX_SELECTED) {
      this.toast = { text: `${V.MAX_SELECTED} panes at most · tap one to unselect it`, until: Date.now() + NOTE_MS }
      this.later(NOTE_MS)
    } else this.selected = this.selected.concat(addr)
    this.log(`${paneName(pane)}: ${this.selected.length} selected`)
    await this.redraw()
  }

  private async openPane(pane: Pane, fromSplit: boolean) {
    this.offset = 0
    this.reveal = false
    await this.push({ kind: 'pane', pane, fromSplit })
    this.onPane?.(pane)
  }

  private async onMenu(id: number) {
    const v = this.top
    switch (id) {
      case V.MENU.refresh:
        this.scheduleList(0)
        await this.readPanes(true)
        break
      case V.MENU.reveal:
        if (v.kind === 'pane') {
          this.reveal = !this.reveal
          await this.redraw()
        }
        break
      case V.MENU.bottom:
        this.offset = 0
        await this.redraw()
        this.scheduleRead(0)
        break
      case V.MENU.needsYou: {
        const pane = this.needsYou()
        if (!pane) break
        await this.goHome()
        await this.openPane(pane, false)
        break
      }
      case V.MENU.typeOnly:
        if (v.kind === 'heard') await this.sendVoice(v.pane, false)
        break
      case V.MENU.sayAgain:
        if (v.kind === 'heard' || v.kind === 'listen') await this.beginVoice(v.pane, true)
        break
    }
  }

  /** Back to the list, closing whatever is open. */
  private async goHome() {
    while (this.stack.length > 1) {
      const left = this.stack.pop()!
      if (left.kind === 'listen' || left.kind === 'heard') await this.endVoice()
      if (left.kind === 'pane') this.onPane?.(null)
    }
    this.offset = 0
    this.reveal = false
    this.marked = -1
    this.stack = [{ kind: 'list' }]
    await this.redraw()
    this.scheduleRead(0)
  }

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
    await this.readPanes(true)
  }

  /** From the phone pane: typed text to the open or selected pane. */
  async sendText(text: string, enter: boolean): Promise<string> {
    const pane = this.focus()
    if (!pane) return 'open a pane on the glasses first'
    if (!pane.writable) return 'that pane is read-only'
    try {
      await api.text(pane.address, text)
      if (enter) await api.key(pane.address, 'Enter')
    } catch (e) {
      return await this.failed(e, 'POST input')
    }
    this.flash = { text: enter ? 'sent from the phone, Enter' : 'typed from the phone', until: Date.now() + FLASH_MS }
    this.later(FLASH_MS)
    this.offset = 0
    await this.redraw()
    await this.readPanes(true)
    return ''
  }

  // ------------------------------------------------------------------- voice
  private offersVoice(pane: Pane): boolean {
    return this.canSpeak && pane.writable && getSettings().voice
  }

  private async beginVoice(pane: Pane, again: boolean) {
    await this.endVoice()
    this.voice = { phase: 'recording', seconds: 0, text: '', error: '' }
    if (again) {
      this.stack.pop()
      this.stack.push({ kind: 'listen', pane })
      await this.redraw()
    } else {
      // The answers list is left behind: the pane is where the text ends up.
      this.stack.pop()
      await this.push({ kind: 'listen', pane })
    }
    const ok = await this.recorder.start()
    if (!ok) this.log('audioControl did not confirm the mic; waiting for frames')
    if (this.toneMic) {
      let n = 0
      this.toneTimer = setInterval(() => this.recorder.push(toneFrame(n++)), 100)
    }
    this.voiceTimer = setInterval(() => void this.tickVoice(pane), 500)
    this.log('listening for ' + paneName(pane))
  }

  private async tickVoice(pane: Pane) {
    const v = this.voice
    if (!v || v.phase !== 'recording') return
    v.seconds = Math.max(this.recorder.seconds, this.recorder.elapsed)
    if (this.recorder.elapsed > GRACE_SECONDS && this.recorder.seconds === 0) {
      await this.stopMic()
      v.phase = 'error'
      v.error = 'no audio from the mic · let the Even app use it'
      this.log('no frames arrived from the mic', 'bad')
      await this.redraw()
      return
    }
    if (this.recorder.full) await this.finishVoice(pane)
    else await this.redraw()
  }

  private async stopMic() {
    if (this.voiceTimer) clearInterval(this.voiceTimer)
    if (this.toneTimer) clearInterval(this.toneTimer)
    this.voiceTimer = this.toneTimer = null
    await this.recorder.stop()
  }

  private async endVoice() {
    await this.stopMic()
    this.recorder.reset()
    this.voice = null
  }

  private async finishVoice(pane: Pane) {
    const v = this.voice
    if (!v || v.phase !== 'recording') return
    await this.stopMic()
    v.seconds = this.recorder.seconds
    if (this.recorder.seconds < MIN_SECONDS) {
      v.phase = 'error'
      v.error = this.recorder.seconds === 0 ? 'no audio from the mic · let the Even app use it' : 'too short · say it again'
      this.recorder.reset()
      await this.redraw()
      return
    }
    v.phase = 'working'
    await this.redraw()
    const t0 = Date.now()
    try {
      const a = await api.transcribe(this.recorder.wav())
      // What input takes: no control characters, at most 4096 bytes, whatever a hub answered.
      const text = typed(a.body).trim()
      if (!text) throw new ApiError(502)
      v.text = text
      v.phase = 'review'
      this.log(`transcribed ${v.seconds.toFixed(1)} s in ${Date.now() - t0} ms`, 'ok')
      this.stack.pop()
      this.stack.push({ kind: 'heard', pane })
    } catch (e) {
      v.phase = 'error'
      v.error = e instanceof ApiError ? e.message : 'transcription failed'
      this.log('transcription failed: ' + v.error, 'bad')
    }
    this.recorder.reset()
    await this.redraw()
  }

  private async sendVoice(pane: Pane, enter: boolean) {
    const text = this.voice?.text
    if (!text) return
    this.voice = null
    this.stack.pop()
    let words = enter ? 'sent what you said, Enter' : 'typed what you said'
    try {
      await api.text(pane.address, text)
      if (enter) await api.key(pane.address, 'Enter')
      this.log(`sent ${text.length} characters you said to ${paneName(pane)}`, 'ok')
    } catch (e) {
      words = await this.failed(e, 'POST input')
    }
    this.flash = { text: words, until: Date.now() + FLASH_MS }
    this.later(FLASH_MS)
    this.offset = 0
    await this.redraw()
    await this.readPanes(true)
  }

  // ------------------------------------------------------------------- pages
  private needsYou(): Pane | null {
    let best: Pane | null = null
    let bestAt = -1
    for (const p of this.sorted) {
      const a = this.attention.get(p.address)
      if (!a) continue
      const at = (V.needs(p) ? 1e13 : 0) + a.at
      if (at > bestAt) {
        best = p
        bestAt = at
      }
    }
    return best
  }

  private model(): V.Model {
    const now = new Date()
    const s = getSettings()
    return {
      configured: isConfigured(),
      panes: this.sorted,
      hosts: this.hosts,
      listError: this.listError,
      needsYou: this.needsYou(),
      flash: this.flash && this.flash.until > Date.now() ? this.flash.text : null,
      toast: this.toast && this.toast.until > Date.now() ? this.toast.text : null,
      clock: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      lens: s.lens,
      canSpeak: this.canSpeak,
      loaded: this.loaded,
      dots: this.dots,
      selected: this.selected,
      selecting: this.selecting,
      cursor: this.row,
      windowStart: this.winStart,
      marked: this.marked,
      reading: (address) => this.readers.get(address),
    }
  }

  private async redraw() {
    await this.view.show(this.page())
  }

  private page(): Page {
    const m = this.model()
    const v = this.top
    const now = Math.floor(Date.now() / 1000)
    switch (v.kind) {
      case 'list':
        return V.listPage(m, now)
      case 'split':
        return V.splitPage(m)
      case 'pane': {
        const r = this.readers.get(v.pane.address)
        const a = this.attention.get(v.pane.address)
        let state: string
        if (m.flash) state = m.flash
        else if (r?.error) state = r.error
        else if (a) state = V.WORDS[a.kind]
        else if (this.offset > 0) state = `paused · ${this.offset} ${this.offset === 1 ? 'page' : 'pages'} up`
        else state = r?.raw.length ? 'following' : 'reading…'
        return V.panePage(m, v.pane, r, { offset: this.offset, reveal: this.reveal, state })
      }
      case 'answers':
        return V.answersPage(m, v.pane, this.offersVoice(v.pane))
      case 'confirm':
        return V.confirmPage(m, v.pane, v.answer)
      case 'listen':
        return V.listenPage(m, v.pane, this.voiceView())
      case 'heard':
        return V.heardPage(m, v.pane, this.voiceView())
    }
  }

  private voiceView(): V.VoiceView {
    const s = this.voice ?? { phase: 'error' as const, seconds: 0, text: '', error: 'nothing recorded' }
    return { ...s, levels: this.recorder.levels }
  }
}

function typeOf(ev?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!ev) return null
  return ev.eventType ?? OsEventTypeList.CLICK_EVENT
}
