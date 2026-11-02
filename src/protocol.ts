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
  /** The harness said working in its last event. */
  working: boolean
}

export interface Host {
  name: string
  online: boolean
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
    agent: agentOf(command, title),
    attention: kind,
    attentionAt: att ? when(att.at, now) : 0,
    attentionText: att ? str(att.text, 200) : '',
    choices: kind === 'question' ? parseChoices(att?.choices) : [],
    activity: when(o.activity, now),
    working: false,
  }
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

/** The hub's inbox: the panes that wait, oldest first as the hub sorts them; a pane without attention is not one of them. */
export function parseInbox(body: string, now = Math.floor(Date.now() / 1000)): Pane[] {
  return parseList(body, 'inbox', now).filter((p) => p.attention)
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
    .map((h) => ({ name: h.name as string, online: h.online === true }))
}

/** The name a pane goes by: its alias, else its title, unless the title says nothing. */
export function paneName(p: Pane): string {
  if (p.alias) return p.alias
  let title = p.title
  // Claude Code's mark in front of its title is decoration; the list has marks of its own.
  if (title.startsWith('✳ ') || title.startsWith('* ')) title = title.slice(2).trim()
  else if (title === '✳' || title === '*') title = ''
  if (title.length === 0 || title === p.command || title === p.host) return p.path
  return title
}

/** The hub's JSON events, oldest first, and the cursor. */
export function parseEvents(body: string): { events: Event[]; next: number | null } {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return { events: [], next: null }
  }
  const o = (raw ?? {}) as Record<string, unknown>
  const next = typeof o.next === 'number' && Number.isInteger(o.next) && o.next >= 0 ? o.next : null
  const events: Event[] = []
  if (Array.isArray(o.events)) {
    for (const item of o.events.slice(0, 100)) {
      if (!item || typeof item !== 'object') continue
      const e = item as Record<string, unknown>
      const kind = e.kind
      if (typeof e.seq !== 'number' || !address(e.address) || typeof kind !== 'string') continue
      if (!(ATTENTION as readonly string[]).includes(kind) && kind !== 'working') continue
      const choices = kind === 'question' ? parseChoices(e.choices) : []
      events.push({ seq: e.seq, at: typeof e.at === 'number' ? e.at : 0, address: e.address as string, kind: kind as EventKind, text: str(e.text, 200), choices })
    }
  }
  return { events, next }
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

/** A refusal in a few words, for the hint. */
export function errorWords(status: number): string {
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
