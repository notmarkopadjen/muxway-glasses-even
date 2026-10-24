// The calls the client makes: listings in JSON, pane content in text
// mode, with the caps a hostile
// server runs into: a timeout, at most 256 KiB of a body, and every byte
// decoded by the charset the answer names, Latin-1 when it cannot be read
// as it says.

import { getSettings } from './settings.ts'
import { errorWords } from './protocol.ts'

export const MAX_BODY = 256 * 1024
const TIMEOUT_MS = 20_000
const LONG_POLL_MS = 45_000

export interface Answer {
  status: number
  body: string
  etag: string
}

export class ApiError extends Error {
  status: number
  constructor(status: number) {
    super(errorWords(status))
    this.status = status
  }
}

async function readCapped(res: Response): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer()).slice(0, MAX_BODY)
  const reader = res.body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done || !value) break
    parts.push(value)
    total += value.length
    if (total >= MAX_BODY) {
      void reader.cancel()
      break
    }
  }
  const out = new Uint8Array(Math.min(total, MAX_BODY))
  let at = 0
  for (const p of parts) {
    const n = Math.min(p.length, out.length - at)
    out.set(p.subarray(0, n), at)
    at += n
    if (at >= out.length) break
  }
  return out
}

/** The body as text: UTF-8 when it is well-formed, else by the label, else Latin-1. */
export function decode(bytes: Uint8Array, contentType: string): string {
  const label = /charset=([A-Za-z0-9._-]{1,40})/i.exec(contentType)?.[1]?.toLowerCase()
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    /* not UTF-8 */
  }
  if (label && label !== 'utf-8' && label !== 'utf8') {
    try {
      return new TextDecoder(label).decode(bytes)
    } catch {
      /* a label the browser does not know */
    }
  }
  return new TextDecoder('iso-8859-1').decode(bytes)
}

async function call(method: 'GET' | 'POST', path: string, opts: { body?: string | ArrayBuffer; contentType?: string; etag?: string; timeout?: number; json?: boolean } = {}): Promise<Answer> {
  const { hub, token } = getSettings()
  if (!hub || !token) throw new ApiError(-1)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeout ?? TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(hub + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: opts.json ? 'application/json' : 'text/plain',
        ...(opts.body !== undefined ? { 'Content-Type': opts.contentType ?? 'application/json' } : {}),
        ...(opts.etag ? { 'If-None-Match': opts.etag } : {}),
      },
      body: opts.body,
      signal: ctrl.signal,
      cache: 'no-store',
      credentials: 'omit',
    })
  } catch {
    clearTimeout(timer)
    throw new ApiError(0)
  }
  let bytes: Uint8Array
  try {
    bytes = await readCapped(res)
  } catch {
    clearTimeout(timer)
    throw new ApiError(0)
  }
  clearTimeout(timer)
  if (res.status >= 400) throw new ApiError(res.status)
  return { status: res.status, body: decode(bytes, res.headers.get('Content-Type') ?? ''), etag: res.headers.get('ETag') ?? '' }
}

function q(params: Record<string, string | number>): string {
  return new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()
}

export const api = {
  me: () => call('GET', '/v1/me', { json: true }),
  /** The listings come as JSON: the bars need activity and the attention's time, which text mode has not. */
  panes: () => call('GET', '/v1/panes', { json: true }),
  hosts: () => call('GET', '/v1/hosts', { json: true }),
  /** The last rows, unwrapped (width 400): the glasses wrap by pixels themselves. */
  pane: (address: string, etag: string) =>
    call('GET', `/v1/panes/${address}?` + q({ lines: getSettings().lines, width: 400, charset: getSettings().charset }), { etag }),
  text: (address: string, text: string) => call('POST', `/v1/panes/${address}/input`, { body: JSON.stringify({ text }) }),
  key: (address: string, key: string) => call('POST', `/v1/panes/${address}/input`, { body: JSON.stringify({ key }) }),
  /** Whether the hub has a transcriber: 204, or 404 which the caller reads as no. */
  transcribeProbe: () => call('GET', '/v1/transcribe'),
  /** A 16 kHz mono WAV to text; the transcriber may take a while. */
  transcribe: (wav: ArrayBuffer) => call('POST', '/v1/transcribe', { body: wav, contentType: 'audio/wav', timeout: 95_000 }),
  /** One long poll; without a cursor only the cursor is wanted. */
  events: (after: number | null) =>
    call('GET', '/v1/events?' + q(after === null ? { limit: 1 } : { after, wait: 25, limit: 50 }), { timeout: LONG_POLL_MS, json: true }),
}
