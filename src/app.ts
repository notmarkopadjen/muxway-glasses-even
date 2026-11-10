// The app on the glasses: the pane list, panes held on it side by side,
// one pane, the answers, spoken replies; the polling of what is on screen
// and the long poll for events.

import { OsEventTypeList, type EvenAppBridge, type EvenHubEvent } from '@evenrealities/even_hub_sdk'
import { ANSWERS, choiceAnswer, keysFor, type Answer, type Piece } from './answers.ts'
import { commandsFor } from './commands.ts'
import { ApiError, api, type Answer as Reply } from './api.ts'
import { Glasses, type Page } from './glasses.ts'
import { paneKey, paneName, parseDesk, parseEvents, parseFeed, parseHosts, parseInbox, parseMailbox, parseOne, parsePanes, type Attention, type Desk, type Host, type Mail, type Pane, type Talk } from './protocol.ts'
import { forgetToken, getSettings, isConfigured } from './settings.ts'
import { rows as splitRows, typed } from './text.ts'
import * as V from './views.ts'
import { GRACE_SECONDS, MIN_SECONDS, Recorder, toneFrame } from './voice.ts'

type View =
  | { kind: 'list' }
  | { kind: 'inbox' }
  | { kind: 'split' }
  | { kind: 'pane'; pane: Pane; fromSplit: boolean }
  | { kind: 'answers'; pane: Pane; choices: Answer[]; offer: Answer | null }
  | { kind: 'more'; pane: Pane; what: 'keys' | 'commands'; answers: Answer[] }
  | { kind: 'confirm'; pane: Pane; answer: Answer }
  | { kind: 'offer'; pane: Pane; answer: Answer }
  | { kind: 'listen'; target: VoiceTarget }
  | { kind: 'heard'; target: VoiceTarget }
  /** Cancel / Confirm for what is not an answer; Confirm runs the act. The pane it is about, when it is, so the question goes with the pane. */
  | { kind: 'ask'; question: string; act: () => Promise<void>; pane?: Pane }
  /** The name for a new session on the host. */
  | { kind: 'session'; host: Host; dflt: string }
  /** The feed, whole or one pane's exchanges. */
  | { kind: 'messages'; about: Pane | null }
  /** One pane's mail. */
  | { kind: 'mail'; pane: Pane }

/** What a spoken text is for: the pane it is typed into, the pane it is mailed to (and the one it is read from), or a session's name. */
type VoiceTarget = { kind: 'input'; pane: Pane } | { kind: 'mail'; pane: Pane; to: Pane } | { kind: 'session'; host: Host }

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
  choices: string[]
}

const LIST_EVERY_MS = 10_000
const TOAST_MS = 10_000
const FLASH_MS = 4_000
const MENU_CLOSE_MS = 1500
const DOTS_MS = 500
const NOTE_MS = 3_000
/** Entries of the feed kept on the glasses; the hub's ring holds 500. */
const FEED_KEPT = 200

export class App {
  private bridge: EvenAppBridge
  private log: (m: string, cls?: '' | 'ok' | 'bad' | 'trace') => void
  /** The trace: what the app did with every gesture and timer, written only while the phone's switch is on. */
  private detail = (m: string) => {
    if (getSettings().detail) this.log(m, 'trace')
  }
  /** Draws in flight: more than none when the spinner's tick finds the last one unanswered. */
  private drawing = 0
  private view: Glasses
  private stack: View[] = [{ kind: 'list' }]
  private panes: Pane[] = []
  private hosts: Host[] = []
  private attention = new Map<string, Attn>()
  /** The panes whose last event said working, by address. */
  private working = new Set<string>()
  /** The hub's inbox as last read with the listing; null before it is read. */
  private inbox: Pane[] | null = null
  /** The hub's feed, oldest first, at most 200 entries, and its cursor. */
  private talk: Talk[] = []
  private talkCursor: number | null = null
  /** The newest seq seen when the messages page was last opened: what is newer counts as not looked at. */
  private seenSeq = 0
  /** The hub answered 404 to the feed: an older hub, asked once. */
  private noFeed = false
  /** The desk as last read with the listing, its ETag, and whether the hub has none (404, asked once). Read, never written. */
  private desk: Desk | null = null
  private deskEtag = ''
  private noDesk = false
  private listError: string | null = null
  private listBusy = false
  private listTimer: ReturnType<typeof setTimeout> | null = null
  /** What was read of each pane, by key (paneKey: the host and the id, so a reader is one pane's whatever its address); the pages wrap it to their width. */
  private readers = new Map<string, V.Reader & { etag: string }>()
  private readBusy = false
  private readTimer: ReturnType<typeof setTimeout> | null = null
  private offset = 0
  private reveal = false
  /** The panes held on the list, by key, at most three. */
  private selected: string[] = []
  /** Selection mode on the list: a tap selects the row under the cursor instead of opening it. */
  private selecting = false
  /** The column the scroll marked on the columns, -1 for none. */
  private marked = -1
  /** The list's cursor and its window's first row. */
  private row = 0
  private winStart = 0
  /** The inbox page's cursor, an entry, and its window's first row. */
  private inboxRow = 0
  private inboxStart = 0
  /** The messages page's and the mail page's, the same way. */
  private messagesRow = 0
  private messagesStart = 0
  private mailRow = 0
  private mailStart = 0
  /** The mailbox of the pane whose mail page is open; null before it is read. */
  private mailbox: Mail[] | null = null
  /** Whether a listing has arrived since the start, or since the settings changed. */
  private loaded = false
  private dots = 1
  private dotsTimer: ReturnType<typeof setInterval> | null = null
  private flash: { text: string; until: number } | null = null
  private toast: { text: string; until: number } | null = null
  private clearTimer: ReturnType<typeof setTimeout> | null = null
  /** Redraws now and then, so a row's "quiet 4m" grows older. */
  private tickTimer: ReturnType<typeof setInterval> | null = null
  /** Turns a working mark once a second while one is on the screen. */
  private spinTimer: ReturnType<typeof setInterval> | null = null
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
  /** The phone pane is told which pane is open, for its reply box, and which one a mail from it would go to. */
  onPane: ((pane: Pane | null, mailTo: Pane | null) => void) | null = null

  constructor(bridge: EvenAppBridge, log: (m: string, cls?: '' | 'ok' | 'bad' | 'trace') => void, trace: ((p: Page) => void) | null) {
    this.bridge = bridge
    this.log = log
    this.view = new Glasses(bridge, (m) => log('glasses: ' + m), trace, (m) => {
      if (getSettings().detail) this.detail('glasses: ' + m())
    })
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
    this.desk = null
    this.deskEtag = ''
    this.noDesk = false
    this.selected = []
    this.selecting = false
    this.marked = -1
    this.setStack('settings saved')
    this.canSpeak = false
    this.probed = false
    this.sleep()
    await this.redraw()
    this.wake()
  }

  private wake() {
    this.detail('wake')
    this.foreground = true
    if (!this.tickTimer) this.tickTimer = setInterval(() => void this.redraw(), 30_000)
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
    this.detail('sleep')
    this.foreground = false
    if (this.listTimer) clearTimeout(this.listTimer)
    if (this.readTimer) clearTimeout(this.readTimer)
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.listTimer = this.readTimer = null
    this.tickTimer = null
    this.spin(false)
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
    this.detail(ms ? `list in ${ms / 1000} s` : 'list now')
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
          if (!have || have.kind !== p.attention) this.attention.set(p.address, { kind: p.attention, text: p.attentionText, at: p.attentionAt * 1000 || have?.at || 0, choices: p.choices })
          else if (p.choices.length) have.choices = p.choices
          this.working.delete(p.address)
        } else if (have && have.at < t0 - 2000) {
          this.attention.delete(p.address)
        }
        p.working = this.working.has(p.address)
      }
      await Promise.all([this.readInbox(), this.readFeed(), this.readMailbox(), this.readDesk()])
      this.listError = null
      this.loaded = true
      this.stopDots()
      // A pane that left the listing leaves the selection too; one that moved is followed, by its key.
      this.selected = this.selected.filter((key) => this.panes.some((p) => paneKey(p) === key))
      this.reconcile()
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
    if (v.kind === 'pane' || v.kind === 'answers' || v.kind === 'more' || v.kind === 'confirm' || v.kind === 'offer') return [v.pane]
    if ((v.kind === 'listen' || v.kind === 'heard') && v.target.kind !== 'session') return [v.target.pane]
    if (v.kind === 'split') return this.columns()
    return []
  }

  /** The held panes in the list's order. */
  private columns(): Pane[] {
    return V.selectedPanes(this.model())
  }

  /** The phone's to line: the pane a reply goes to, and the pane a mail would. */
  private aim() {
    this.onPane?.(this.focus() ?? null, this.mailTarget() ?? null)
  }

  /** The pane a mail from the phone or the voice goes to: the sender of the received mail under the cursor on the mail page, else the open pane where its host holds mail. */
  private mailTarget(): Pane | undefined {
    const v = this.top
    if (v.kind === 'mail') {
      const back = V.mailBackTo({ panes: this.panes }, this.mailEntries()[this.mailRow])
      if (back) return back
      const p = this.current(v.pane)
      return p.writable && this.hosts.some((h) => h.name === p.host && h.mail) ? p : undefined
    }
    const p = this.focus()
    return p && p.writable && this.hosts.some((h) => h.name === p.host && h.mail) ? p : undefined
  }

  private mailEntries(): V.MailEntry[] {
    const v = this.top
    return v.kind === 'mail' && this.mailbox ? V.mailEntries(this.mailbox, this.talk, this.current(v.pane)) : []
  }

  /** The feed as the messages page shows it: whole, or one pane's. */
  private shownTalk(): Talk[] {
    const v = this.top
    if (v.kind !== 'messages') return []
    return v.about ? this.talk.filter((t) => V.involves(t, v.about!)) : this.talk
  }

  /** The pane a reply goes to: the open one, or the marked column. */
  private focus(): Pane | undefined {
    const v = this.top
    if (v.kind === 'split') return this.marked >= 0 ? this.columns()[this.marked] : undefined
    return this.watched()[0]
  }

  private scheduleRead(ms: number) {
    this.detail(ms ? `read in ${ms / 1000} s` : 'read now')
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
        try {
          const a = await api.pane(p.address, this.readers.get(paneKey(p))?.etag ?? '')
          if (this.took(p, a, 'GET pane')) this.log(`GET pane ${a.status} ${a.body.length} chars ${Date.now() - t0} ms`)
        } catch (e) {
          const r = this.readers.get(paneKey(p)) ?? { raw: [], error: null, etag: '' }
          r.error = await this.failed(e, 'GET pane')
          this.readers.set(paneKey(p), r)
          if (!this.foreground) return
          // No pane at the address while the listing names one there: the window changed since. The listing says
          // where the pane is now, or that it is gone; a listing that does not name it has said its word already.
          if (e instanceof ApiError && e.status === 404 && this.panes.some((x) => paneKey(x) === paneKey(p))) this.scheduleList(0)
        }
      }
    } finally {
      this.readBusy = false
    }
    if (panes.length) await this.redraw()
    if (this.foreground) this.scheduleRead(getSettings().every * 1000)
  }

  /**
   * The pane's screen from an answer that carries one: a read's, or an input's with the echo (200; a 204 from a hub
   * before the echo carries nothing and is not looked at). Rows the hub names as another pane's (Muxway-Pane) are
   * not taken: the host renumbered since the listing named the pane at the address, the rows held are the pane's
   * own, and the listing says where the pane is now. Returns whether the answer was the pane's.
   */
  private took(p: Pane, a: Reply, what: string): boolean {
    if (a.status === 204) return false
    if (a.pane && p.id && a.pane !== p.id) {
      this.log(`${what} ${a.status}: ${a.pane} answered at ${p.path}, not ${p.id}`)
      if (this.panes.some((x) => paneKey(x) === paneKey(p))) this.scheduleList(0)
      return false
    }
    const r = this.readers.get(paneKey(p)) ?? { raw: [], error: null, etag: '' }
    if (a.status !== 304) {
      r.raw = splitRows(a.body)
      r.etag = a.etag
    }
    r.error = null
    this.readers.set(paneKey(p), r)
    return true
  }

  /** The pieces of an input, each with the screen once it landed; whether the last one's screen was drawn in. */
  private async type(pane: Pane, pieces: Piece[]): Promise<boolean> {
    let echoed = false
    for (const p of pieces) {
      if (p.text === undefined && p.key === undefined) continue
      const a = p.text !== undefined ? await api.text(pane.address, p.text) : await api.key(pane.address, p.key!)
      echoed = a.status === 200 && this.took(pane, a, 'POST input')
      if (echoed) this.log(`POST input 200 ${a.body.length} chars`)
    }
    return echoed
  }

  /** A failed request in a few words; a refused token is forgotten at once. */
  private async failed(e: unknown, what: string): Promise<string> {
    const err = e instanceof ApiError ? e : new ApiError(0)
    this.log(`${what}: ${err.message}`, 'bad')
    if (err.status === 401) {
      await forgetToken()
      this.sleep()
      this.setStack('token refused')
      this.panes = []
      this.selected = []
      this.marked = -1
      this.readers.clear()
      this.aim()
      return 'token refused · set it on the phone'
    }
    // A lockout pauses the app; the hub's one creation per two seconds is only a wait.
    if (err.status === 429 && err.code !== 'rate_limited') {
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
          if (this.cursor !== null) for (const ev of r.events) this.onNotify(ev.address, ev.kind, ev.text, ev.choices)
          else this.recent(r.events)
          // Another client changed the desk: the row follows with the listing, which reads the desk.
          if (this.cursor !== null && r.desk) {
            this.log('event desk')
            this.scheduleList(0)
          }
          this.cursor = r.next
          // An answer without a cursor, a body cut at the cap or garbled, restarts the poll without one: after
          // the wait of a failed poll, never at once, or a hub that answers that way is asked two hundred times a second.
          // The wait doubles like a failed poll's: only an answer with a cursor resets it.
          if (r.next === null) {
            this.log(`GET events: no cursor, again in ${this.backoff / 1000} s`, 'bad')
            await new Promise((r) => setTimeout(r, this.backoff))
            this.backoff = Math.min(60_000, this.backoff * 2)
          } else this.backoff = 5_000
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

  /** The hub's recent events, read at start: a pane whose last one said working is working before its next event. Nothing is replayed as a toast. */
  private recent(events: { address: string; kind: Attention | 'working' }[]) {
    for (const ev of events) {
      if (ev.kind === 'working') this.working.add(ev.address)
      else this.working.delete(ev.address)
    }
    for (const p of this.panes) p.working = !p.attention && this.working.has(p.address)
    if (this.working.size) this.log(`${this.working.size} working from the recent events`)
    void this.redraw()
  }

  private onNotify(address: string, kind: Attention | 'working', text: string, choices: string[] = []) {
    const pane = this.panes.find((p) => p.address === address)
    const name = pane ? paneName(pane) : address.slice(address.indexOf('/') + 1)
    if (kind === 'working') {
      this.attention.delete(address)
      this.working.add(address)
      if (pane) {
        pane.attention = ''
        pane.choices = []
        pane.working = true
      }
    } else {
      this.attention.set(address, { kind, text, at: Date.now(), choices })
      this.working.delete(address)
      if (pane) {
        pane.attention = kind
        pane.attentionAt = Math.floor(Date.now() / 1000)
        pane.attentionText = text
        pane.choices = choices
        pane.working = false
      }
      // A parked pane keeps the kind underneath and stays quiet: no toast. Nor does an idle on a
      // harness whose screen still moves: it is working, and the words follow once the screen stops.
      if (!pane?.later && !(kind === 'idle' && pane && V.isWorking(pane))) {
        this.toast = { text: `${V.MARK[kind]} ${name}: ${text || V.WORDS[kind]}`, until: Date.now() + TOAST_MS }
        this.detail(`toast ${kind} on ${name}`)
        this.later(TOAST_MS)
      }
    }
    this.log(`event ${kind} on ${name}`)
    if (this.watched().some((p) => p.address === address)) this.scheduleRead(0)
    void this.redraw()
    this.scheduleList(0)
  }

  private later(ms: number) {
    this.detail(`clear in ${ms / 1000} s`)
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
          if (!['answers', 'confirm', 'more', 'ask', 'session'].includes(this.top.kind)) await this.onTap()
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

  /** A view's name for the trace: its kind and the pane it is about. */
  private viewName(v: View): string {
    return 'pane' in v && v.pane ? `${v.kind} ${paneName(v.pane)}` : v.kind
  }

  /** The stack starts over at the list, for the trace's sake in one place. */
  private setStack(why: string) {
    this.detail(`view: ${this.viewName(this.top)} → list (1) · ${why}`)
    this.stack = [{ kind: 'list' }]
  }

  private async push(v: View) {
    this.flash = null
    this.detail(`view: ${this.viewName(this.top)} → ${this.viewName(v)} (${this.stack.length + 1})`)
    this.stack.push(v)
    await this.redraw()
    this.scheduleRead(0)
    this.aim()
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
    this.detail(`view: ${this.viewName(v)} → ${this.viewName(this.top)} (${this.stack.length}) · back`)
    this.flash = null
    if (v.kind === 'listen' || v.kind === 'heard') await this.endVoice()
    if (v.kind === 'split') this.marked = -1
    if (v.kind === 'pane') {
      this.offset = 0
      this.reveal = false
    }
    await this.redraw()
    this.scheduleRead(0)
    this.aim()
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
    if (v.kind === 'inbox') {
      const n = Math.min(this.inbox?.length ?? 0, V.INBOX_ROWS)
      const next = Math.max(0, Math.min(n - 1, this.inboxRow + dir))
      if (next === this.inboxRow) return
      this.inboxRow = next
      this.inboxStart = V.inboxWindow(V.inboxLayout(this.model(), Math.floor(Date.now() / 1000)).entry, next, this.inboxStart)
      await this.redraw()
      return
    }
    if (v.kind === 'messages') {
      const talk = this.shownTalk()
      const next = Math.max(0, Math.min(talk.length - 1, this.messagesRow + dir))
      if (next === this.messagesRow) return
      this.messagesRow = next
      this.messagesStart = V.inboxWindow(V.messagesLayout(this.model(), talk, Math.floor(Date.now() / 1000)).entry, next, this.messagesStart)
      await this.redraw()
      return
    }
    if (v.kind === 'mail') {
      const entries = this.mailEntries()
      const next = Math.max(0, Math.min(entries.length - 1, this.mailRow + dir))
      if (next === this.mailRow) return
      this.mailRow = next
      this.mailStart = V.inboxWindow(V.mailLayout(this.model(), entries, Math.floor(Date.now() / 1000)).entry, next, this.mailStart)
      await this.redraw()
      this.aim()
      return
    }
    if (v.kind === 'split') {
      // The scroll marks a column, the next or the previous; the first or the last when none is marked. A tap opens it.
      const cols = this.columns()
      if (!cols.length) return
      const next = this.marked < 0 ? (dir > 0 ? 0 : cols.length - 1) : this.marked + dir
      if (next < 0 || next >= cols.length) return
      this.marked = next
      await this.redraw()
      return
    }
    if (v.kind !== 'pane') return
    const { size, total } = V.pageSize(v.pane, this.readers.get(paneKey(v.pane)), getSettings().lens, this.reveal)
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
      if (this.voice?.phase === 'recording') await this.finishVoice(v.target)
      else if (this.voice?.phase === 'error') await this.beginVoice(v.target, true)
      return
    }
    if (v.kind === 'heard') {
      await this.useVoice(v.target, true)
      return
    }
    if (v.kind === 'offer') {
      this.stack.pop()
      this.stack.pop()
      await this.send(v.pane, v.answer)
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
        case 'desk': {
          if (this.selecting) break
          const d = V.deskPane(this.desk, this.sorted)
          if (d?.pane) await this.openPane(d.pane, false)
          else this.note("the desk's panes are not in the listing")
          break
        }
        case 'inbox':
          await this.openInbox()
          break
        case 'host':
          if (row.host.sessions && !this.selecting) await this.push({ kind: 'session', host: row.host, dflt: V.defaultSession(this.panes, row.host.name) })
          break
        case 'messages':
          if (!this.selecting) await this.openMessages(null)
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
    if (v.kind === 'inbox') {
      const p = V.inboxEntry(this.model())
      if (p) await this.openPane(p, false)
      return
    }
    if (v.kind === 'messages') {
      const t = this.shownTalk()[this.messagesRow]
      if (!t) return
      const m = { panes: this.panes }
      if (t.kind === 'mail') {
        const to = V.endPane(m, t.to)
        if (to) await this.openMail(to, t)
        else this.note('a pane is gone')
        return
      }
      const from = V.endPane(m, t.from)
      const to = V.endPane(m, t.to)
      if (from && to && from.address !== to.address) await this.beside(from, to)
      else this.note('a pane is gone')
      return
    }
    if (v.kind === 'mail') {
      const back = V.mailBackTo({ panes: this.panes }, this.mailEntries()[this.mailRow])
      if (!back) return
      await this.mailBy(v.pane, back)
      return
    }
    if (v.kind === 'split') {
      const sel = this.focus()
      if (sel) await this.openPane(sel, true)
      else await this.readPanes(true)
      return
    }
    if (v.kind !== 'pane') return
    if (v.pane.writable) await this.openAnswers(v.pane)
    else await this.readPanes(true)
  }

  /** The answers, with a question's choices and Claude's suggestion as they stand now: the confirmation sends these, not a later reading. */
  private async openAnswers(pane: Pane) {
    const offer = V.offerOf(pane, this.readers.get(paneKey(pane))?.raw ?? [], getSettings().lens)
    const choices = this.choicesOf(pane).map(choiceAnswer)
    await this.push({ kind: 'answers', pane, choices, offer })
  }

  /** The choices of the question on the pane, from the listing or the event that brought it. */
  private choicesOf(pane: Pane): string[] {
    const a = this.attention.get(pane.address)
    if (a?.kind === 'question' && a.choices.length) return a.choices
    const p = this.current(pane)
    return p.attention === 'question' ? p.choices : []
  }

  /** The inbox page over the list, read again as it opens. */
  private async openInbox() {
    this.inboxRow = 0
    this.inboxStart = 0
    await this.push({ kind: 'inbox' })
    await this.readInbox()
    await this.redraw()
  }

  /** The inbox comes with every listing: Go to takes its first awake entry, the hub's oldest. */
  private async readInbox() {
    try {
      const a = await api.inbox()
      this.inbox = parseInbox(a.body)
      this.log(`GET inbox ${a.status} ${this.inbox.length} waiting`)
    } catch (e) {
      // An older hub has no inbox: the page says so when opened, the list goes on.
      if (!(e instanceof ApiError && e.status === 404)) this.listError = await this.failed(e, 'GET inbox')
    }
  }

  /** The open mail page's mailbox, with every listing while it is open. */
  private async readMailbox() {
    const v = this.top
    if (v.kind !== 'mail') return
    try {
      const a = await api.mailbox(v.pane.address)
      this.mailbox = parseMailbox(a.body)
      this.log(`GET mail ${a.status} ${this.mailbox.length} mails`)
    } catch (e) {
      this.toast = { text: await this.failed(e, 'GET mail'), until: Date.now() + NOTE_MS }
      this.later(NOTE_MS)
      if (this.mailbox === null) this.mailbox = []
    }
  }

  /** The desk comes with every listing: the view the owner's clients share, read here and never written; a 304 keeps what was read. */
  private async readDesk() {
    if (this.noDesk) return
    try {
      const a = await api.desk(this.deskEtag)
      if (a.status === 304) return
      this.desk = parseDesk(a.body)
      this.deskEtag = a.etag
      this.log(`GET desk ${a.status} ${this.desk ? `${this.desk.view} ${this.desk.panes.length} panes` : 'no desk'}`)
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        this.noDesk = true
        this.log('GET desk: not on this hub')
      } else await this.failed(e, 'GET desk')
    }
  }

  /** The feed comes with every listing too: the first time the hub's recent entries, then what is newer than the cursor. */
  private async readFeed() {
    if (this.noFeed) return
    try {
      const a = await api.talk(this.talkCursor)
      const r = parseFeed(a.body)
      // A cursor behind the one held is a hub that started over: its recent entries are the feed now, none of them new.
      const restarted = this.talkCursor !== null && r.next !== null && r.next < this.talkCursor
      if (restarted) this.talk = []
      const fresh = this.talkCursor === null || restarted ? r.talk : r.talk.filter((t) => t.seq > this.talkCursor!)
      if (this.talkCursor === null || restarted) this.seenSeq = r.next ?? 0
      this.talk = this.talk.concat(fresh).slice(-FEED_KEPT)
      if (r.next !== null) this.talkCursor = r.next
      if (fresh.length) this.log(`GET talk ${a.status} ${fresh.length} new`)
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        this.noFeed = true
        this.log('GET talk: not on this hub')
      } else await this.failed(e, 'GET talk')
    }
  }

  private async onSelect(idx: number) {
    const v = this.top
    if (v.kind === 'answers') {
      const c = v.choices[idx]
      if (c) {
        await this.push({ kind: 'confirm', pane: v.pane, answer: c })
        return
      }
      idx -= v.choices.length
      if (v.offer) {
        if (idx === 0) {
          await this.push({ kind: 'offer', pane: v.pane, answer: v.offer })
          return
        }
        idx--
      }
      const voice = this.offersVoice(v.pane) ? 1 : 0
      if (voice && idx === 0) {
        await this.beginVoice({ kind: 'input', pane: v.pane }, false)
        return
      }
      idx -= voice
      const a = ANSWERS[idx]
      if (a) {
        await this.push({ kind: 'confirm', pane: v.pane, answer: a })
        return
      }
      idx -= ANSWERS.length
      if (idx === 0) {
        const host = this.hosts.find((h) => h.name === v.pane.host)
        await this.push({ kind: 'more', pane: v.pane, what: 'keys', answers: keysFor(host?.keys === 2) })
        return
      }
      const row = commandsFor(v.pane.command)
      if (idx === 1 && row) await this.push({ kind: 'more', pane: v.pane, what: 'commands', answers: row.commands })
    } else if (v.kind === 'more') {
      const a = v.answers[idx]
      if (a) await this.push({ kind: 'confirm', pane: v.pane, answer: a })
    } else if (v.kind === 'session') {
      if (idx === 0) await this.askSession(v.host, v.dflt)
      else if (idx === 1 && this.canSpeak && getSettings().voice) await this.beginVoice({ kind: 'session', host: v.host }, false)
    } else if (v.kind === 'ask') {
      this.stack.pop()
      await this.redraw()
      if (idx === 1) await v.act()
    } else if (v.kind === 'confirm') {
      const { pane, answer } = v
      // Back to the pane: the confirmation, the list it came from, and the answers under that list.
      while (this.top.kind === 'confirm' || this.top.kind === 'more' || this.top.kind === 'answers') this.stack.pop()
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
    const key = paneKey(pane)
    if (this.selected.includes(key)) this.selected = this.selected.filter((k) => k !== key)
    else if (this.selected.length >= V.MAX_SELECTED) {
      this.toast = { text: `${V.MAX_SELECTED} panes at most · tap one to unselect it`, until: Date.now() + NOTE_MS }
      this.later(NOTE_MS)
    } else this.selected = this.selected.concat(key)
    this.log(`${paneName(pane)}: ${this.selected.length} selected`)
    await this.redraw()
  }

  private async openPane(pane: Pane, fromSplit: boolean) {
    this.offset = 0
    this.reveal = false
    // Opening a parked pane is the owner coming back: it wakes, where the glasses may wake it.
    if (pane.later && V.canPark({ hosts: this.hosts }, pane)) {
      try {
        await api.later(pane.address, false)
        pane.later = false
        this.log(`woke ${paneName(pane)}`, 'ok')
      } catch (e) {
        await this.failed(e, 'POST later')
      }
      this.scheduleList(0)
    }
    await this.push({ kind: 'pane', pane, fromSplit })
    this.aim()
  }

  /** The pane as the last listing has it, found by its key (so at its address now, after a renumber), else as it was opened. */
  private current(pane: Pane): Pane {
    const key = paneKey(pane)
    return this.panes.find((x) => paneKey(x) === key) ?? pane
  }

  /** The pane a view is about, for the follow and the word when it is gone; none for the list, the inbox, the columns, the whole feed and a session's name. */
  private viewPane(v: View): Pane | undefined {
    switch (v.kind) {
      case 'pane':
      case 'answers':
      case 'more':
      case 'confirm':
      case 'offer':
      case 'mail':
      case 'ask':
        return v.pane
      case 'messages':
        return v.about ?? undefined
      case 'listen':
      case 'heard':
        return v.target.kind === 'session' ? undefined : v.target.pane
      default:
        return undefined
    }
  }

  /** The view with its pane as the listing has it now, after a follow. */
  private withPane(v: View, q: Pane): View {
    switch (v.kind) {
      case 'pane':
      case 'answers':
      case 'more':
      case 'confirm':
      case 'offer':
      case 'mail':
      case 'ask':
        return { ...v, pane: q }
      case 'messages':
        return { ...v, about: q }
      case 'listen':
      case 'heard': {
        const t = v.target
        if (t.kind === 'session') return v
        return { ...v, target: t.kind === 'mail' ? { ...t, pane: q, to: paneKey(t.to) === paneKey(q) ? q : t.to } : { ...t, pane: q } }
      }
      default:
        return v
    }
  }

  /**
   * After a listing, the panes the pages hold are found by key. One the host moved (it renumbers when a pane
   * closes) is followed: the pages keep it at its new address, and what was read at the old one is dropped,
   * since after the renumber those rows may be another pane's. One that is gone while its host is there closes
   * its pages with a word; a pane whose host is away stays, and the reads say so.
   */
  private reconcile() {
    const hostThere = (p: Pane) => this.hosts.some((h) => h.name === p.host && h.online) || this.panes.some((x) => x.host === p.host)
    let followed = false
    let gone: Pane | undefined
    for (let i = 1; i < this.stack.length; i++) {
      const held = this.viewPane(this.stack[i])
      if (!held?.id) continue
      const key = paneKey(held)
      const now = this.panes.find((x) => paneKey(x) === key)
      if (!now) {
        if (hostThere(held)) gone = held
        continue
      }
      if (now.address === held.address) continue
      const r = this.readers.get(key)
      if (r) {
        r.raw = []
        r.etag = ''
        r.error = null
      }
      for (let j = 1; j < this.stack.length; j++) {
        const held2 = this.viewPane(this.stack[j])
        if (held2 && paneKey(held2) === key) this.stack[j] = this.withPane(this.stack[j], now)
      }
      this.log(`followed ${paneName(now)} to ${now.path}`)
      followed = true
    }
    if (gone) {
      const key = paneKey(gone)
      const about = (v: View) => {
        const p = this.viewPane(v)
        return !!p && paneKey(p) === key
      }
      // Every page about the pane, from the top; the page under them comes back.
      while (this.stack.length > 1 && about(this.top)) {
        const left = this.stack.pop()!
        if (left.kind === 'listen' || left.kind === 'heard') void this.endVoice()
        if (left.kind === 'pane') {
          this.offset = 0
          this.reveal = false
        }
      }
      this.detail(`view: pane ${paneName(gone)} → ${this.viewName(this.top)} (${this.stack.length}) · gone`)
      this.log(`${paneName(gone)} is gone`)
      this.toast = { text: `${paneName(gone)} is gone`, until: Date.now() + NOTE_MS }
      this.later(NOTE_MS)
      this.scheduleRead(0)
    }
    if (followed || gone) this.aim()
  }

  /** Parks the open pane for later, or wakes it; the host keeps the mark and every client sees it. */
  private async park(held: Pane, on: boolean) {
    const pane = this.current(held)
    let words = on ? 'parked' : 'woken'
    try {
      await api.later(pane.address, on)
      // The listing's pane and the one the page holds (an inbox entry, say) both show it before the next listing.
      pane.later = held.later = on
      this.log(`${words} ${paneName(pane)}`, 'ok')
    } catch (e) {
      words = await this.failed(e, 'POST later')
    }
    // The pane page flashes it in its state; the inbox has only the hint.
    if (this.top.kind === 'inbox') this.toast = { text: words, until: Date.now() + NOTE_MS }
    else this.flash = { text: words, until: Date.now() + FLASH_MS }
    this.later(FLASH_MS)
    await this.redraw()
    this.scheduleList(0)
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
      case V.MENU.later: {
        const p = v.kind === 'pane' ? this.current(v.pane) : v.kind === 'inbox' ? V.inboxEntry(this.model()) : undefined
        if (p && V.canPark({ hosts: this.hosts }, p)) await this.park(p, !p.later)
        break
      }
      case V.MENU.typeOnly:
        if (v.kind === 'heard') await this.useVoice(v.target, false)
        break
      case V.MENU.sayAgain:
        if (v.kind === 'heard' || v.kind === 'listen') await this.beginVoice(v.target, true)
        break
      case V.MENU.next:
      case V.MENU.previous:
        if (v.kind === 'pane') {
          const q = V.neighbour(this.sorted, v.pane, id === V.MENU.next ? 1 : -1)
          if (q) await this.showPane(q)
        }
        break
      case V.MENU.mail:
        if (v.kind === 'pane') await this.openMail(this.current(v.pane), null)
        else if (v.kind === 'mail') {
          const p = this.current(v.pane)
          if (p.writable && this.hosts.some((h) => h.name === p.host && h.mail)) await this.mailBy(p, p)
        }
        break
      case V.MENU.messages:
        if (v.kind === 'mail') await this.openMessages(this.current(v.pane))
        break
      case V.MENU.beside:
        if (v.kind === 'pane') {
          const partner = V.partnerOf({ panes: this.panes }, this.current(v.pane))
          if (partner) await this.beside(v.pane, partner)
        }
        break
      case V.MENU.close:
        if (v.kind === 'pane') {
          const p = this.current(v.pane)
          if (V.canClose({ hosts: this.hosts }, p)) await this.push({ kind: 'ask', question: V.closeQuestion(p), act: () => this.close(p), pane: p })
        }
        break
      case V.MENU.split:
        if (v.kind === 'pane' && v.pane.writable) await this.push({ kind: 'ask', question: `one more pane beside ${paneName(v.pane)}?`, act: () => this.split(v.pane), pane: v.pane })
        break
    }
  }

  /** The open pane gives way to another on the same page: next, previous, a new one. */
  private async showPane(q: Pane) {
    const v = this.top
    if (v.kind !== 'pane') return
    this.stack[this.stack.length - 1] = { kind: 'pane', pane: q, fromSplit: v.fromSplit }
    this.offset = 0
    this.reveal = false
    this.flash = null
    this.aim()
    await this.redraw()
    this.scheduleRead(0)
  }

  /** A word in the hint for a moment. */
  private note(text: string) {
    this.toast = { text, until: Date.now() + NOTE_MS }
    this.later(NOTE_MS)
    void this.redraw()
  }

  /** The messages page, whole from the list's row or one pane's from its mail page, the cursor on the newest; opening it clears the count. */
  private async openMessages(about: Pane | null) {
    this.seenSeq = this.talk.length ? this.talk[this.talk.length - 1].seq : this.seenSeq
    const n = about ? this.talk.filter((t) => V.involves(t, about)).length : this.talk.length
    this.messagesRow = Math.max(0, n - 1)
    this.messagesStart = 0
    await this.push({ kind: 'messages', about })
    this.messagesStart = V.inboxWindow(V.messagesLayout(this.model(), this.shownTalk(), Math.floor(Date.now() / 1000)).entry, this.messagesRow, 1e9)
    await this.redraw()
  }

  /** The mail page of a pane, the cursor on the newest entry, or on the given mail. */
  private async openMail(p: Pane, at: Talk | null) {
    this.mailbox = null
    this.mailRow = 0
    this.mailStart = 0
    await this.push({ kind: 'mail', pane: p })
    await this.readMailbox()
    const entries = this.mailEntries()
    const i = at ? entries.findIndex((e) => (e.kind === 'in' ? e.mail.id === at.id : e.talk.seq === at.seq)) : -1
    this.mailRow = i >= 0 ? i : Math.max(0, entries.length - 1)
    this.mailStart = V.inboxWindow(V.mailLayout(this.model(), entries, Math.floor(Date.now() / 1000)).entry, this.mailRow, 1e9)
    await this.redraw()
    this.aim()
  }

  /** A mail by voice to the pane, read from the pane whose page is open; without a transcriber the phone's mail button is the way. */
  private async mailBy(from: Pane, to: Pane) {
    if (!(this.canSpeak && getSettings().voice)) {
      this.note("say it needs a transcriber · the phone's mail button")
      return
    }
    // The mail page stays under the voice pages, unlike the answers list.
    this.stack.push({ kind: 'mail', pane: from })
    await this.beginVoice({ kind: 'mail', pane: from, to }, false)
  }

  /** From the phone: a mail for the pane the glasses aim at, confirmed on the glasses. */
  async mailText(text: string): Promise<string> {
    const to = this.mailTarget()
    if (!to) return 'open a pane whose host holds mail first'
    const t = typed(text).slice(0, 4000)
    if (!t) return 'nothing to mail'
    const peek = t.length > 40 ? t.slice(0, 39) + '…' : t
    await this.push({ kind: 'ask', question: `mail this to ${paneName(to)}? "${peek}"`, act: () => this.mail(to, t), pane: to })
    return ''
  }

  /** The columns with the pane and its partner, the pane first, nothing marked; the pair is the selection from here. */
  private async beside(p: Pane, partner: Pane) {
    this.selected = [paneKey(p), paneKey(partner)]
    this.marked = -1
    await this.push({ kind: 'split' })
  }

  /** Closes the pane where the latest listing has it: a confirmation taken after a renumber reaches the pane, not its old address. */
  private async close(held: Pane) {
    const p = this.current(held)
    try {
      await api.close(p.address)
      this.log(`closed ${paneName(p)}`, 'ok')
      await this.goHome()
      this.toast = { text: `closed ${paneName(p)}`, until: Date.now() + NOTE_MS }
      this.later(NOTE_MS)
    } catch (e) {
      this.flash = { text: await this.failed(e, 'POST close'), until: Date.now() + FLASH_MS }
      this.later(FLASH_MS)
    }
    await this.redraw()
    this.scheduleList(0)
  }

  private async split(held: Pane) {
    const p = this.current(held)
    try {
      const a = await api.split(p.host, p.session, p.window, V.splitDirection(p))
      const q = parseOne(a.body)
      this.log(`split ${paneName(p)}`, 'ok')
      if (q) await this.showPane(q)
    } catch (e) {
      this.flash = { text: await this.failed(e, 'POST panes'), until: Date.now() + FLASH_MS }
      this.later(FLASH_MS)
    }
    await this.redraw()
    this.scheduleList(0)
  }

  /** The session's name folded to the grammar, then Cancel / Confirm; the name page it came from is left behind. */
  private async askSession(host: Host, raw: string) {
    const name = V.sessionName(raw)
    if (!name) {
      this.toast = { text: 'not a session name', until: Date.now() + NOTE_MS }
      this.later(NOTE_MS)
      await this.redraw()
      return
    }
    if (this.top.kind === 'session') this.stack.pop()
    await this.push({ kind: 'ask', question: `start session ${name} on ${host.name}?`, act: () => this.session(host, name) })
  }

  /** A message for the pane's process, held by its host and never typed; the words land on the pane page or the hint. */
  private async mail(held: Pane, text: string) {
    const to = this.current(held)
    let words = `mailed ${paneName(to)}`
    try {
      await api.mail(to.address, text)
      this.log(`${words}, ${new TextEncoder().encode(text).length} bytes`, 'ok')
    } catch (e) {
      words = await this.failed(e, 'POST mail')
    }
    if (this.top.kind === 'pane') this.flash = { text: words, until: Date.now() + FLASH_MS }
    else this.toast = { text: words, until: Date.now() + NOTE_MS }
    this.later(FLASH_MS)
    await this.redraw()
    this.scheduleList(0)
  }

  private async session(host: Host, name: string) {
    try {
      const a = await api.session(host.name, name)
      const q = parseOne(a.body)
      this.log(`session ${name} on ${host.name}`, 'ok')
      if (q) await this.openPane(q, false)
    } catch (e) {
      this.toast = { text: await this.failed(e, 'POST sessions'), until: Date.now() + NOTE_MS }
      this.later(NOTE_MS)
    }
    await this.redraw()
    this.scheduleList(0)
  }

  /** Back to the list, closing whatever is open. */
  private async goHome() {
    while (this.stack.length > 1) {
      const left = this.stack.pop()!
      if (left.kind === 'listen' || left.kind === 'heard') await this.endVoice()
      if (left.kind === 'pane') this.aim()
    }
    this.offset = 0
    this.reveal = false
    this.marked = -1
    this.setStack('home')
    await this.redraw()
    this.scheduleRead(0)
  }

  /** An answer to the pane where the latest listing has it. */
  private async send(held: Pane, answer: Answer) {
    const pane = this.current(held)
    if (answer.choice !== undefined) {
      await this.answer(pane, answer.choice)
      return
    }
    let words = 'sent ' + answer.short
    let echoed = false
    try {
      echoed = await this.type(pane, answer.pieces)
      // The suggestion is pane text: the log keeps its size only.
      const what = answer.secret ? `the suggestion, ${new TextEncoder().encode(answer.pieces[0]?.text ?? '').length} bytes` : answer.short
      this.log(`sent ${what} to ${paneName(pane)}`, 'ok')
    } catch (e) {
      words = await this.failed(e, 'POST input')
    }
    await this.sent(words, echoed)
  }

  /** After an input: the flash, the view at the bottom, one draw; the pane read at once unless its screen came with the answer. */
  private async sent(words: string, echoed: boolean) {
    this.flash = { text: words, until: Date.now() + FLASH_MS }
    this.later(FLASH_MS)
    this.offset = 0
    await this.redraw()
    if (!echoed) await this.readPanes(true)
  }

  /** A question's choice to the process that asked; the hub refuses one that is not on offer or no longer asked. */
  private async answer(held: Pane, choice: string) {
    const pane = this.current(held)
    let words = 'answered ' + choice
    try {
      await api.answer(pane.address, choice)
      this.attention.delete(pane.address)
      pane.attention = ''
      pane.choices = []
      this.log(`answered ${paneName(pane)}`, 'ok')
    } catch (e) {
      words = e instanceof ApiError && e.status === 400 ? 'not one of the choices' : await this.failed(e, 'POST answer')
    }
    this.flash = { text: words, until: Date.now() + FLASH_MS }
    this.later(FLASH_MS)
    this.offset = 0
    await this.redraw()
    this.scheduleList(0)
    await this.readPanes(true)
  }

  /** From the phone pane: typed text to the open or selected pane. */
  async sendText(text: string, enter: boolean): Promise<string> {
    const v = this.top
    if (v.kind === 'session') {
      await this.askSession(v.host, text)
      return V.sessionName(text) ? '' : 'not a session name'
    }
    const held = this.focus()
    if (!held) return 'open a pane on the glasses first'
    const pane = this.current(held)
    if (!pane.writable) return 'that pane is read-only'
    let echoed = false
    try {
      echoed = await this.type(pane, enter ? [{ text }, { key: 'Enter' }] : [{ text }])
    } catch (e) {
      return await this.failed(e, 'POST input')
    }
    await this.sent(enter ? 'sent from the phone, Enter' : 'typed from the phone', echoed)
    return ''
  }

  // ------------------------------------------------------------------- voice
  private offersVoice(pane: Pane): boolean {
    return this.canSpeak && pane.writable && getSettings().voice
  }

  private async beginVoice(target: VoiceTarget, again: boolean) {
    await this.endVoice()
    this.voice = { phase: 'recording', seconds: 0, text: '', error: '' }
    if (again) {
      this.stack.pop()
      this.stack.push({ kind: 'listen', target })
      await this.redraw()
    } else {
      // The list it was picked from is left behind: the pane, or the mail page, is where the text ends up.
      this.stack.pop()
      await this.push({ kind: 'listen', target })
    }
    const ok = await this.recorder.start()
    if (!ok) this.log('audioControl did not confirm the mic; waiting for frames')
    if (this.toneMic) {
      let n = 0
      this.toneTimer = setInterval(() => this.recorder.push(toneFrame(n++)), 100)
    }
    this.voiceTimer = setInterval(() => void this.tickVoice(target), 500)
    this.log('listening for ' + V.voiceUseOf(this.useOf(target)))
  }

  /** The voice pages' words for a target. */
  private useOf(t: VoiceTarget): V.VoiceUse {
    if (t.kind === 'input') return { kind: 'input', name: paneName(t.pane) }
    if (t.kind === 'mail') return { kind: 'mail', name: paneName(t.to) }
    return { kind: 'session', host: t.host.name }
  }

  private async tickVoice(target: VoiceTarget) {
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
    if (this.recorder.full) await this.finishVoice(target)
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

  private async finishVoice(target: VoiceTarget) {
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
      this.stack.push({ kind: 'heard', target })
    } catch (e) {
      v.phase = 'error'
      v.error = e instanceof ApiError ? e.message : 'transcription failed'
      this.log('transcription failed: ' + v.error, 'bad')
    }
    this.recorder.reset()
    await this.redraw()
  }

  /** What was heard goes where it was for: typed into the pane, asked as a mail, or as a session's name. */
  private async useVoice(target: VoiceTarget, enter: boolean) {
    const text = this.voice?.text
    if (!text) return
    if (target.kind === 'input') {
      await this.sendVoice(target.pane, text, enter)
      return
    }
    this.voice = null
    this.stack.pop()
    if (target.kind === 'session') {
      await this.askSession(target.host, text)
      return
    }
    await this.push({ kind: 'ask', question: `mail this to ${paneName(target.to)}?`, act: () => this.mail(target.to, text) })
  }

  private async sendVoice(held: Pane, text: string, enter: boolean) {
    const pane = this.current(held)
    this.voice = null
    this.stack.pop()
    let words = enter ? 'sent what you said, Enter' : 'typed what you said'
    let echoed = false
    try {
      echoed = await this.type(pane, enter ? [{ text }, { key: 'Enter' }] : [{ text }])
      this.log(`sent ${text.length} characters you said to ${paneName(pane)}`, 'ok')
    } catch (e) {
      words = await this.failed(e, 'POST input')
    }
    await this.sent(words, echoed)
  }

  // ------------------------------------------------------------------- pages
  /** The pane to go to: the hub's inbox's first awake entry, the one that has waited longest by the hub's clock; none before the inbox is read. */
  private needsYou(): Pane | null {
    const first = this.inbox?.find((p) => p.attention && !p.later)
    if (!first) return null
    return this.current(first)
  }

  private model(): V.Model {
    const s = getSettings()
    return {
      configured: isConfigured(),
      panes: this.sorted,
      hosts: this.hosts,
      listError: this.listError,
      needsYou: this.needsYou(),
      flash: this.flash && this.flash.until > Date.now() ? this.flash.text : null,
      toast: this.toast && this.toast.until > Date.now() ? this.toast.text : null,
      lens: s.lens,
      canSpeak: this.canSpeak,
      loaded: this.loaded,
      dots: this.dots,
      selected: this.selected,
      selecting: this.selecting,
      cursor: this.row,
      windowStart: this.winStart,
      marked: this.marked,
      inbox: this.inbox,
      inboxCursor: this.inboxRow,
      inboxStart: this.inboxStart,
      feed: this.talk.length > 0,
      unseen: this.talk.filter((t) => t.seq > this.seenSeq).length,
      desk: V.deskPane(this.desk, this.sorted),
      reading: (p) => this.readers.get(paneKey(p)),
    }
  }

  private async redraw() {
    const page = this.page()
    const t0 = Date.now()
    this.drawing++
    try {
      await this.view.show(page)
    } finally {
      this.drawing--
    }
    this.detail(`draw ${page.kind === 'list' ? this.top.kind + ' (OS list)' : this.top.kind} · ${Date.now() - t0} ms`)
    this.spin(this.foreground && V.turning(page))
  }

  private spin(on: boolean) {
    if (on && !this.spinTimer) {
      this.detail('spin on')
      this.spinTimer = setInterval(() => {
        if (this.drawing) this.detail(`tick: ${this.drawing} draw${this.drawing === 1 ? '' : 's'} still in flight`)
        void this.redraw()
      }, 1000)
    }
    if (!on && this.spinTimer) {
      this.detail('spin off')
      clearInterval(this.spinTimer)
      this.spinTimer = null
    }
  }

  private page(): Page {
    const m = this.model()
    const v = this.top
    const now = Math.floor(Date.now() / 1000)
    switch (v.kind) {
      case 'list':
        return V.listPage(m, now)
      case 'inbox':
        return V.inboxPage(m, now)
      case 'split':
        return V.splitPage(m, now)
      case 'pane': {
        const p = this.current(v.pane)
        const r = this.readers.get(paneKey(p))
        const a = this.attention.get(p.address)
        let state: string
        if (m.flash) state = m.flash
        else if (r?.error) state = r.error
        // The state has room for a few words: the kind as the hub names it, after later.
        else if (p.later) state = 'later' + (a ? ` · ${a.kind}` : '')
        else if (a) state = V.WORDS[a.kind]
        else if (this.offset > 0) state = `paused · ${this.offset} ${this.offset === 1 ? 'page' : 'pages'} up`
        else state = r?.raw.length ? V.placeWord(p) : 'reading…'
        return V.panePage(m, p, r, { offset: this.offset, reveal: this.reveal, state }, now)
      }
      case 'answers':
        return V.answersPage(m, v.pane, v.choices, v.offer, this.offersVoice(v.pane), v.pane.writable ? (commandsFor(v.pane.command)?.whose ?? null) : null)
      case 'more':
        return V.moreAnswersPage(m, v.pane, v.what, v.answers)
      case 'confirm':
        return V.confirmPage(m, v.pane, v.answer)
      case 'offer':
        return V.offerPage(m, v.pane, v.answer)
      case 'listen':
        return V.listenPage(m, this.useOf(v.target), this.voiceView())
      case 'heard':
        return V.heardPage(m, this.useOf(v.target), this.voiceView())
      case 'ask':
        return V.askPage(m, v.question)
      case 'messages':
        return V.messagesPage(m, this.shownTalk(), v.about, this.messagesRow, this.messagesStart, now)
      case 'mail':
        return V.mailPage(m, this.current(v.pane), this.mailbox, this.talk, this.mailRow, this.mailStart, now)
      case 'session':
        return V.sessionPage(m, v.host.name, v.dflt, this.canSpeak && getSettings().voice)
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
