// What the phone pane sets and the glasses use. One JSON record under one
// key in localStorage and in the Even app's own store, which survives a
// wipe of the WebView's storage. The token is in it, so nothing here is
// ever logged.

import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { checkHubUrl, checkToken, isLoopback } from './protocol.ts'

export interface Settings {
  hub: string
  token: string
  /** seconds between reads of the open pane while following, 1 to 30 */
  every: number
  /** rows asked from the hub per read, 50 to 500 */
  lines: number
  /** latin1 (every glyph the font has) or utf-8 */
  charset: 'latin1' | 'utf-8'
  /** the Claude Code lens on panes that run it */
  lens: boolean
  /** spoken replies, when the hub has a transcriber */
  voice: boolean
}

const KEY = 'muxway.settings.v1'

// Set by vite's define: true in a test build alone (vite build --mode test), see docs/testing.md.
declare const __MX_TEST__: boolean
export const TEST_BUILD = typeof __MX_TEST__ !== 'undefined' && __MX_TEST__

const DEFAULTS: Settings = { hub: '', token: '', every: 3, lines: 200, charset: 'latin1', lens: true, voice: true }

let current: Settings = { ...DEFAULTS }
let bridge: EvenAppBridge | null = null

function bounded(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt
}

function normalize(s: Partial<Settings> | null | undefined): Settings {
  const hub = checkHubUrl(s?.hub ?? '')
  const token = checkToken(s?.token ?? '')
  return {
    hub: 'url' in hub ? hub.url : '',
    token: 'token' in token ? token.token : '',
    every: bounded(s?.every, 1, 30, DEFAULTS.every),
    lines: bounded(s?.lines, 50, 500, DEFAULTS.lines),
    charset: s?.charset === 'utf-8' ? 'utf-8' : 'latin1',
    lens: s?.lens !== false,
    voice: s?.voice !== false,
  }
}

function readLocal(): Settings | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? normalize(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

function writeLocal(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* storage blocked */
  }
}

/** Whether the page may take settings from its URL: a test build, served from loopback. */
function takesQuery(loc: { hostname: string }): boolean {
  return TEST_BUILD && isLoopback(loc.hostname)
}

/**
 * Settings from the page's own URL, taken only by a test build served
 * from loopback: the simulator and the test harness. A packed or
 * sideloaded app never takes a token from a URL; the production build
 * has no code for it.
 */
export function fromQuery(loc: { hostname: string; search: string }): Partial<Settings> | null {
  const q = new URLSearchParams(loc.search)
  if (![...q.keys()].some((k) => k in DEFAULTS)) return null
  if (!takesQuery(loc)) return null
  const out: Partial<Settings> = {}
  for (const k of ['hub', 'token', 'charset'] as const) {
    const v = q.get(k)
    if (v !== null) (out as Record<string, unknown>)[k] = v
  }
  for (const k of ['every', 'lines'] as const) {
    const v = q.get(k)
    if (v !== null) out[k] = Number(v)
  }
  for (const k of ['lens', 'voice'] as const) {
    const v = q.get(k)
    if (v !== null) out[k] = v !== '0' && v !== 'false'
  }
  return out
}

/** True when the URL carries settings the page may not take: the phone pane says so. */
export function refusedQuery(loc: { hostname: string; search: string }): boolean {
  const q = new URLSearchParams(loc.search)
  return [...q.keys()].some((k) => k in DEFAULTS) && !takesQuery(loc)
}

export async function loadSettings(b: EvenAppBridge | null): Promise<Settings> {
  bridge = b
  let s = readLocal()
  if (!s && b) {
    try {
      const raw = await b.getLocalStorage(KEY)
      if (raw) s = normalize(JSON.parse(raw))
    } catch {
      /* no host store */
    }
  }
  const q = fromQuery(window.location)
  if (q) {
    s = normalize({ ...(s ?? {}), ...q })
    await saveSettings(s)
    try {
      window.history.replaceState(null, '', window.location.pathname)
    } catch {
      /* ignore */
    }
  }
  current = s ?? { ...DEFAULTS }
  return current
}

export async function saveSettings(s: Partial<Settings>): Promise<Settings> {
  current = normalize({ ...current, ...s })
  writeLocal(current)
  if (bridge) {
    try {
      await bridge.setLocalStorage(KEY, JSON.stringify(current))
    } catch {
      /* ignore */
    }
  }
  return current
}

/** Forgets the token, after the hub refused it. */
export function forgetToken(): Promise<Settings> {
  return saveSettings({ token: '' })
}

export function getSettings(): Settings {
  return current
}

export function isConfigured(): boolean {
  return current.hub.length > 0 && current.token.length > 0
}
