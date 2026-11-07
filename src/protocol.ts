// Protocol v1: the listings as the hub answers them in JSON, and the
// rules a hub URL and a token have to pass before they are used. Pane
// content is read in text mode, see api.ts.

import { clean } from './text.ts'

export const PROTOCOL = 'v1'

export type Attention = 'question' | 'permission' | 'idle' | 'done'
export type EventKind = Attention | 'working'
export type Agent = 'claude' | 'codex' | 'gemini' | 'antigravity' | 'opencode' | 'copilot' | 'aider' | 'goose' | 'amp' | 'cursor'

export interface Pane {
  address: string
  host: string
  /** session/window.pane */
  path: string
  writable: boolean
  command: string
  title: string
  alias: string
  /** The directory the pane's program is in, for a writer under a preview root; '' when the host gives none. */
  cwd: string
  /** The AI harness in the pane, from its command or its title; '' for any other program. */
  agent: Agent | ''
  attention: Attention | ''
  /** When the attention arrived, seconds since the epoch; 0 when unknown. */
  attentionAt: number
  attentionText: string
  /** The fixed answers of a question (muxway ask); empty otherwise. */
  choices: string[]
  /** The pane's last activity, seconds since the epoch; 0 when unknown. */
  activity: number
  /** The screen changed in the ten seconds before the listing: the guideline's working, by the hub's clock. */
  moving: boolean
  /** The harness said working in its last event. */
  working: boolean
  /** The panes this one talked with in the last ten minutes, by address; empty otherwise. */
  talk: string[]
  /** Unread mail held for the pane's process; 0 for none. */
  mail: number
  /** The owner parked the pane for later. */
  later: boolean
  /** When it was parked, seconds since the epoch; 0 when awake or unknown. */
  laterAt: number
  /** tmux's pane id, %n; '' when the listing gave none. */
  id: string
  /** The session's name and the window's index, for a split. */
  session: string
  window: number
  /** The pane's size in cells; 0 when unknown. */
  width: number
  height: number
  /** The only pane of its session: closing it ends the session. */
  last: boolean
}

export interface Host {
  name: string
  online: boolean
  /** The host's agent parks panes for later. */
  later: boolean
  /** The agent starts sessions, closes panes, holds mail. */
  sessions: boolean
  close: boolean
  mail: boolean
  /** The key grammar the agent takes: 2, or 0 for the earlier list. */
  keys: number
}

export type TalkKind = 'text' | 'key' | 'answer' | 'mail'

/** One end of an exchange: the pane as it was, with its id to follow. */
export interface TalkEnd {
  address: string
  id: string
  alias: string
}

/** An entry of the hub's feed: who said what to whom. */
export interface Talk {
  seq: number
  at: number
  kind: TalkKind
  from: TalkEnd | null
  to: TalkEnd
  actor: string
  text: string
  bytes: number
  /** A mail's id, a reply's the mail it answers; 0 otherwise. */
  id: number
  replyTo: number
}

/** A mail a pane holds, as its host's agent keeps it. */
export interface Mail {
  id: number
  at: number
  from: TalkEnd | null
  actor: string
  text: string
  readAt: number
  replied: boolean
}

/** The desk: the view the owner's clients share, as the hub keeps it; read here, never written. */
export interface Desk {
  view: 'panes' | 'window'
  /** The panes open as tiles, at most four, by address; empty for a window desk. */
  panes: string[]
  /** The focused pane's address, or none. */
  focused: string
  /** The window the window view shows, host/session/window, or none. */
  window: string
}

export interface Event {
  seq: number
  at: number
  address: string
  kind: EventKind
  text: string
  choices: string[]
}

const ATTENTION = ['question', 'permission', 'idle', 'done'] as const
const HOST = /^[a-z0-9-]{1,32}$/
const ALIAS = /^@[a-z0-9-]{1,32}$/
const NAME = /^[A-Za-z0-9._-]{1,64}$/
const INDEX = /^[0-9]{1,4}$/
const MAX_LIST = 500
const MIN_CHOICES = 2
const MAX_CHOICES = 8
const MAX_CHOICE = 40
const MAX_TALK = 32
const MAX_MAIL = 999
const MAX_CWD = 256
const MAX_FOLDER = 32
/** A screen change this recent, at the listing, counts as working. */
export const WORKING_SECONDS = 10
const MAX_FEED = 100
const MAX_MAILBOX = 50
const MAX_MAIL_TEXT = 4000
const MAX_ACTOR = 32
const PANE_ID = /^%[0-9]{1,9}$/
const MAX_DESK = 4
const TALK_KINDS = ['text', 'key', 'answer', 'mail'] as const

// The harnesses every client names, by command, and under an interpreter by their name in the title.
const AGENTS: [Agent, string, RegExp | null][] = [
  ['codex', 'Codex', null],
  ['gemini', 'Gemini', /\bgemini\b/i],
  ['antigravity', 'Antigravity', /\bantigravity\b/i],
  ['opencode', 'OpenCode', null],
  ['copilot', 'Copilot', /\bcopilot\b/i],
  ['aider', 'aider', null],
  ['goose', 'goose', null],
  ['amp', 'Amp', null],
  ['cursor', 'Cursor', null],
]
const COMMANDS: Record<string, Agent> = { codex: 'codex', gemini: 'gemini', agy: 'antigravity', opencode: 'opencode', copilot: 'copilot', aider: 'aider', goose: 'goose', amp: 'amp', 'cursor-agent': 'cursor' }
const INTERPRETERS = new Set(['node', 'bun', 'deno', 'python', 'python3', 'uv'])
const SPARK = /^[✳✶✻✽✢]\s*/u

/** The AI harness a pane runs, as the web names it: Claude by its command or its spark, the rest by command or title. */
export function agentOf(command: string, title: string): Agent | '' {
  if (command === 'claude' || SPARK.test(title)) return 'claude'
  const byCommand = COMMANDS[command]
  for (const [agent, , inTitle] of AGENTS) {
    if (byCommand === agent || (inTitle && INTERPRETERS.has(command) && inTitle.test(title))) return agent
  }
  return ''
}

export function agentName(agent: Agent): string {
  if (agent === 'claude') return 'Claude'
  return AGENTS.find((a) => a[0] === agent)?.[1] ?? agent
}

/** What a pane is known by on the app: its host and id when the listing gave an id (an address is a position, and the host renumbers panes when one closes; ids are tmux's, one host's), else its address. */
export function paneKey(p: Pick<Pane, 'host' | 'id' | 'address'>): string {
  return p.id ? `${p.host}:${p.id}` : p.address
}

/** The program named for a person: the harness, else the command. */
export function program(p: Pick<Pane, 'agent' | 'command'>): string {
  return p.agent ? agentName(p.agent) : p.command
}

/** A question's choices as the hub carries them: two to eight distinct short clean lines without a bar; anything else is no choices. */
export function parseChoices(v: unknown): string[] {
  if (!Array.isArray(v) || v.length < MIN_CHOICES || v.length > MAX_CHOICES) return []
  const out: string[] = []
  for (const c of v) {
    if (typeof c !== 'string') return []
    const s = clean(c).trim()
    if (!s || s !== c || s.length > MAX_CHOICE || s.includes('|') || out.includes(s)) return []
    out.push(s)
  }
  return out
}

/** The partners of a pane as the listing names them: distinct addresses, at most 32; anything else is no talk. */
export function parseTalk(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const item of v.slice(0, MAX_TALK)) {
    const a = item && typeof item === 'object' ? (item as Record<string, unknown>).address : undefined
    if (address(a) && !out.includes(a as string)) out.push(a as string)
  }
  return out
}

/** The unread mail a pane holds: a positive count, at most 999; anything else is none. */
export function parseMail(v: unknown): number {
  const n = v && typeof v === 'object' ? (v as Record<string, unknown>).unread : undefined
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) return 0
  return Math.min(n, MAX_MAIL)
}

function attention(s: unknown): Attention | '' {
  return typeof s === 'string' && (ATTENTION as readonly string[]).includes(s) ? (s as Attention) : ''
}

/** host/session/window.pane or host/@alias, as the protocol spells them; anything else is not a pane. */
function address(s: unknown): { host: string; path: string } | null {
  if (typeof s !== 'string' || s.length > 200) return null
  const [host, ...rest] = s.split('/')
  if (!HOST.test(host)) return null
  const path = rest.join('/')
  if (rest.length === 1) return ALIAS.test(path) ? { host, path } : null
  if (rest.length !== 2) return null
  const dot = rest[1].lastIndexOf('.')
  if (dot < 0 || !NAME.test(rest[0]) || !NAME.test(rest[1].slice(0, dot)) || !INDEX.test(rest[1].slice(dot + 1))) return null
  return { host, path }
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? clean(v).trim().slice(0, max) : ''
}

/** A time in seconds since the epoch, or 0 for anything else; a time in the future counts as now. */
function when(v: unknown, now: number): number {
  if (typeof v !== 'number' || !isFinite(v) || v <= 0) return 0
  return Math.min(Math.floor(v), now)
}

function parsePane(item: unknown, now: number): Pane | null {
  if (!item || typeof item !== 'object') return null
  const o = item as Record<string, unknown>
  const a = address(o.address)
  if (!a) return null
  const att = o.attention && typeof o.attention === 'object' ? (o.attention as Record<string, unknown>) : null
  const kind = attention(att?.kind)
  const command = str(o.command, 32)
  const title = str(o.title, 64)
  return {
    address: o.address as string,
    host: a.host,
    path: a.path,
    writable: o.mode === 'write',
    command,
    title,
    alias: str(o.alias, 32),
    cwd: str(o.cwd, MAX_CWD),
    agent: agentOf(command, title),
    attention: kind,
    attentionAt: att ? when(att.at, now) : 0,
    attentionText: att ? str(att.text, 200) : '',
    choices: kind === 'question' ? parseChoices(att?.choices) : [],
    activity: when(o.activity, now),
    moving: when(o.activity, now) > 0 && now - when(o.activity, now) <= WORKING_SECONDS,
    working: false,
    talk: parseTalk(o.talk),
    mail: parseMail(o.mail),
    later: o.later === true,
    laterAt: o.later === true ? when(o.later_at, now) : 0,
    id: paneId(o.pane_id),
    session: typeof o.session === 'string' && NAME.test(o.session) ? o.session : '',
    window: count(o.window_index, 9999),
    width: count(o.width, 9999),
    height: count(o.height, 9999),
    last: o.last === true,
  }
}

/** A pane id as the hub writes it, `%<digits>`; anything else is ''. */
export function paneId(v: unknown): string {
  return typeof v === 'string' && PANE_ID.test(v) ? v : ''
}

/** A non-negative integer up to a cap; anything else is 0. */
function count(v: unknown, max: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : 0
}

function parseList(body: string, key: string, now: number): Pane[] {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return []
  }
  const list = (raw as Record<string, unknown>)?.[key]
  if (!Array.isArray(list)) return []
  const out: Pane[] = []
  for (const item of list.slice(0, MAX_LIST)) {
    const p = parsePane(item, now)
    if (p) out.push(p)
  }
  return out
}

/** The hub's JSON listing of panes; an entry that is not a pane is skipped, and at most 500 are read. */
export function parsePanes(body: string, now = Math.floor(Date.now() / 1000)): Pane[] {
  return parseList(body, 'panes', now)
}

/** One pane as a creation answers it: {"pane": {...}}; null for anything else. */
export function parseOne(body: string, now = Math.floor(Date.now() / 1000)): Pane | null {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return null
  }
  return parsePane((raw as Record<string, unknown>)?.pane, now)
}

/** The hub's inbox: the panes that wait, oldest first as the hub sorts them, then the parked ones; a pane with neither is not one of them. */
export function parseInbox(body: string, now = Math.floor(Date.now() / 1000)): Pane[] {
  return parseList(body, 'inbox', now).filter((p) => p.attention || p.later)
}

/** The hub's JSON listing of hosts. */
export function parseHosts(body: string): Host[] {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return []
  }
  const list = (raw as { hosts?: unknown })?.hosts
  if (!Array.isArray(list)) return []
  return list
    .slice(0, MAX_LIST)
    .filter((h): h is Record<string, unknown> => !!h && typeof h === 'object' && typeof (h as Record<string, unknown>).name === 'string' && HOST.test((h as Record<string, unknown>).name as string))
    .map((h) => ({ name: h.name as string, online: h.online === true, later: h.later === true, sessions: h.sessions === true, close: h.close === true, mail: h.mail === true, keys: h.keys === 2 ? 2 : 0 }))
}

/** A pane named in the feed or a mail: its address checked, its id and alias cleaned; null for anything else. */
function talkEnd(v: unknown): TalkEnd | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (!address(o.address)) return null
  return { address: o.address as string, id: paneId(o.pane_id), alias: str(o.alias, 32) }
}

function actorName(v: unknown): string {
  return v && typeof v === 'object' ? str((v as Record<string, unknown>).name, MAX_ACTOR) : ''
}

/** The hub's feed, oldest first, and the cursor: an entry whose destination is no pane, or whose seq is no integer, is dropped. */
export function parseFeed(body: string, now = Math.floor(Date.now() / 1000)): { talk: Talk[]; next: number | null } {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return { talk: [], next: null }
  }
  const o = (raw ?? {}) as Record<string, unknown>
  const next = typeof o.next === 'number' && Number.isInteger(o.next) && o.next >= 0 ? o.next : null
  const talk: Talk[] = []
  if (Array.isArray(o.talk)) {
    for (const item of o.talk.slice(0, MAX_FEED)) {
      if (!item || typeof item !== 'object') continue
      const e = item as Record<string, unknown>
      const to = talkEnd(e.to)
      const kind = typeof e.kind === 'string' && (TALK_KINDS as readonly string[]).includes(e.kind) ? (e.kind as TalkKind) : null
      if (!to || !kind || typeof e.seq !== 'number' || !Number.isInteger(e.seq) || e.seq < 0) continue
      talk.push({
        seq: e.seq,
        at: when(e.at, now),
        kind,
        from: talkEnd(e.from),
        to,
        actor: actorName(e.actor),
        text: str(e.text, 200),
        bytes: count(e.bytes, 1 << 30),
        id: count(e.id, Number.MAX_SAFE_INTEGER),
        replyTo: count(e.reply_to, Number.MAX_SAFE_INTEGER),
      })
    }
  }
  return { talk, next }
}

/** A pane's mailbox as the hub lists it, oldest first; a mail without an integer id is dropped, fifty are kept. */
export function parseMailbox(body: string, now = Math.floor(Date.now() / 1000)): Mail[] {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return []
  }
  const list = (raw as Record<string, unknown>)?.mail
  if (!Array.isArray(list)) return []
  const out: Mail[] = []
  for (const item of list.slice(0, MAX_MAILBOX)) {
    if (!item || typeof item !== 'object') continue
    const m = item as Record<string, unknown>
    if (typeof m.id !== 'number' || !Number.isInteger(m.id) || m.id < 0) continue
    out.push({ id: m.id, at: when(m.at, now), from: talkEnd(m.from), actor: actorName(m.actor), text: str(m.text, MAX_MAIL_TEXT), readAt: when(m.read_at, now), replied: m.replied === true })
  }
  return out
}

/** What the program says about itself: its title without Claude's mark, or nothing when it only repeats the command or the host. */
export function programSays(p: Pick<Pane, 'title' | 'command' | 'host'>): string {
  let title = p.title
  // Claude Code's mark in front of its title is decoration; the list has marks of its own.
  if (title.startsWith('✳ ') || title.startsWith('* ')) title = title.slice(2).trim()
  else if (title === '✳' || title === '*') title = ''
  if (title === p.command || title === p.host) return ''
  return title
}

/** The name a pane goes by: its alias, else what the program says, else its address. */
export function paneName(p: Pane): string {
  if (p.alias) return p.alias
  return programSays(p) || p.path
}

/** The last segment of the directory the pane works in; '' without one. */
export function folder(p: Pick<Pane, 'cwd'>): string {
  const parts = p.cwd.split('/').filter((s) => s.length)
  return (parts[parts.length - 1] ?? '').slice(0, MAX_FOLDER)
}

/** The hub's JSON events, oldest first, and the cursor. */
/** The hub's events: the notifications, the cursor, and whether a `desk` event (it names no pane: the desk changed) was among them. */
export function parseEvents(body: string): { events: Event[]; next: number | null; desk: boolean } {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return { events: [], next: null, desk: false }
  }
  const o = (raw ?? {}) as Record<string, unknown>
  const next = typeof o.next === 'number' && Number.isInteger(o.next) && o.next >= 0 ? o.next : null
  const events: Event[] = []
  let desk = false
  if (Array.isArray(o.events)) {
    for (const item of o.events.slice(0, 100)) {
      if (!item || typeof item !== 'object') continue
      const e = item as Record<string, unknown>
      const kind = e.kind
      if (kind === 'desk') {
        desk = true
        continue
      }
      if (typeof e.seq !== 'number' || !address(e.address) || typeof kind !== 'string') continue
      if (!(ATTENTION as readonly string[]).includes(kind) && kind !== 'working') continue
      const choices = kind === 'question' ? parseChoices(e.choices) : []
      events.push({ seq: e.seq, at: typeof e.at === 'number' ? e.at : 0, address: e.address as string, kind: kind as EventKind, text: str(e.text, 200), choices })
    }
  }
  return { events, next, desk }
}

/** A window's address, host/session/window, by the grammar. */
function windowAddress(s: unknown): boolean {
  if (typeof s !== 'string' || s.length > 200) return false
  const parts = s.split('/')
  return parts.length === 3 && HOST.test(parts[0]) && NAME.test(parts[1]) && INDEX.test(parts[2])
}

/** The desk as the hub answers GET /v1/desk: the view, the first four distinct panes by the grammar, the focused pane and the window when they pass it; anything else is no desk. */
export function parseDesk(body: string): Desk | null {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return null
  }
  const d = (raw as Record<string, unknown>)?.desk
  if (!d || typeof d !== 'object') return null
  const o = d as Record<string, unknown>
  if (o.view !== 'panes' && o.view !== 'window') return null
  const panes: string[] = []
  if (Array.isArray(o.panes)) {
    for (const a of o.panes) {
      if (panes.length >= MAX_DESK) break
      if (address(a) && !panes.includes(a as string)) panes.push(a as string)
    }
  }
  return { view: o.view, panes, focused: address(o.focused) ? (o.focused as string) : '', window: windowAddress(o.window) ? (o.window as string) : '' }
}

/** The hub's URL as the app will use it, or why it is refused. */
export function checkHubUrl(raw: string): { url: string } | { error: string } {
  const s = raw.trim().replace(/\/+$/, '')
  if (s.length === 0) return { error: 'Set the hub URL' }
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return { error: 'Not a URL' }
  }
  if (u.username || u.password) return { error: 'No user name in the URL' }
  if (u.search || u.hash) return { error: 'No query or fragment in the URL' }
  if (u.pathname !== '/' && u.pathname !== '') return { error: 'The hub URL has no path' }
  if (u.protocol === 'http:') {
    if (!isLoopback(u.hostname)) return { error: 'http only reaches localhost; use https' }
  } else if (u.protocol !== 'https:') {
    return { error: 'https required' }
  }
  return { url: u.origin }
}

export function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

/** A token as pasted: printable ASCII, 8 to 200 characters. */
export function checkToken(raw: string): { token: string } | { error: string } {
  const s = raw.trim()
  if (s.length < 8 || s.length > 200) return { error: 'A token is 8 to 200 characters' }
  if (/[^\x21-\x7e]/.test(s)) return { error: 'A token has no spaces or control characters' }
  return { token: s }
}

/** The hub's codes that say more than their status. */
const CODES: Record<string, string> = { mailbox_full: 'mailbox full', exists: 'that name exists', too_many: 'too many there', bad_input: 'refused by the hub' }

/** A refusal in a few words, for the hint. */
export function errorWords(status: number, code = ''): string {
  if (CODES[code]) return CODES[code]
  switch (status) {
    case -1:
      return 'set the hub and token on the phone'
    case 0:
      return 'no connection'
    case 400:
      return 'refused by the hub'
    case 401:
      return 'token refused'
    case 403:
      return 'read only'
    case 404:
      return 'not found'
    case 409:
      return 'no question there now'
    case 413:
      return 'too large'
    case 429:
      return 'locked out, wait'
    case 502:
    case 504:
      return 'hub unreachable'
    case 503:
      return 'host offline'
    default:
      return 'error ' + status
  }
}
