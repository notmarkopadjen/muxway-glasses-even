// Protocol v1 in text mode: the lines the hub answers, and the rules a
// hub URL and a token have to pass before they are used.

import { clean } from './text.ts'

export const PROTOCOL = 'v1'

export type Attention = 'question' | 'permission' | 'idle' | 'done'
export type EventKind = Attention | 'working'

export interface Pane {
  address: string
  host: string
  /** session/window.pane */
  path: string
  writable: boolean
  command: string
  title: string
  attention: Attention | ''
}

export interface Event {
  seq: number
  at: number
  address: string
  kind: EventKind
  text: string
}

const ATTENTION = ['question', 'permission', 'idle', 'done'] as const
const HOST = /^[a-z0-9-]{1,32}$/

function attention(s: string): Attention | '' {
  return (ATTENTION as readonly string[]).includes(s) ? (s as Attention) : ''
}

function address(s: string): { host: string; path: string } | null {
  const slash = s.indexOf('/')
  if (slash < 1 || s.length > 200) return null
  const host = s.slice(0, slash)
  const path = s.slice(slash + 1)
  if (!HOST.test(host) || path.length === 0 || /[^\x21-\x7e]/.test(path)) return null
  return { host, path }
}

/** One pane per line: address, mode, command, title, attention. A line that is not one is skipped. */
export function parsePanes(body: string): Pane[] {
  const out: Pane[] = []
  for (const line of body.split('\n')) {
    const f = line.replace(/\r$/, '').split('\t')
    if (f.length < 2) continue
    const a = address(f[0])
    if (!a) continue
    out.push({
      address: f[0],
      host: a.host,
      path: a.path,
      writable: f[1] === 'write',
      command: clean(f[2] ?? '').trim().slice(0, 32),
      title: clean(f[3] ?? '').trim().slice(0, 64),
      attention: attention(f[4] ?? ''),
    })
  }
  return out
}

/** The name a pane goes by: its title, unless the title says nothing. */
export function paneName(p: Pane): string {
  let title = p.title
  // Claude Code's mark in front of its title is decoration; the list has marks of its own.
  if (title.startsWith('✳ ') || title.startsWith('* ')) title = title.slice(2).trim()
  else if (title === '✳' || title === '*') title = ''
  if (title.length === 0 || title === p.command || title === p.host) return p.path
  return title
}

/** Events, oldest first, and the cursor from the last line. */
export function parseEvents(body: string): { events: Event[]; next: number | null } {
  const events: Event[] = []
  let next: number | null = null
  for (const line of body.split('\n')) {
    const f = line.replace(/\r$/, '').split('\t')
    if (f[0] === 'next' && f.length === 2 && /^\d{1,15}$/.test(f[1])) {
      next = Number(f[1])
      continue
    }
    if (f.length < 4 || !/^\d{1,15}$/.test(f[0]) || !/^\d{1,15}$/.test(f[1]) || !address(f[2])) continue
    const kind = f[3]
    if (!(ATTENTION as readonly string[]).includes(kind) && kind !== 'working') continue
    events.push({ seq: Number(f[0]), at: Number(f[1]), address: f[2], kind: kind as EventKind, text: clean(f.slice(4).join(' ')).trim().slice(0, 200) })
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

/** A refusal in a few words, for a head line. */
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
