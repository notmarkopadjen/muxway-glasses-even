// The phone pane: the only place a token is typed, a reply box for the
// pane open on the glasses, and a log of status codes, sizes and timings.
// Never a token, never pane content.

import { api } from './api.ts'
import { checkHubUrl, checkToken, type Pane, paneName } from './protocol.ts'
import { THEMES, forgetToken, getSettings, refusedQuery, saveSettings, type Settings, type Theme } from './settings.ts'
import { typed } from './text.ts'

export type Cls = '' | 'ok' | 'bad'

const $ = (id: string) => document.getElementById(id)

export function plog(msg: string, cls: Cls = '') {
  const el = $('log')
  if (!el) return
  const line = document.createElement('div')
  if (cls) line.className = cls
  const t = new Date()
  const hh = String(t.getHours()).padStart(2, '0')
  const mm = String(t.getMinutes()).padStart(2, '0')
  const ss = String(t.getSeconds()).padStart(2, '0')
  line.textContent = `${hh}:${mm}:${ss} ${msg}`
  el.prepend(line)
  while (el.childElementCount > 40) el.lastElementChild?.remove()
}

function say(id: string, text: string, cls: Cls = '') {
  const el = $(id)
  if (!el) return
  el.textContent = text
  el.className = 'status ' + cls
}

export interface PhoneHooks {
  onSaved: (s: Settings) => void
  send: (text: string, enter: boolean) => Promise<string>
  /** The text as a mail for the pane the glasses aim at, confirmed there. */
  mail: (text: string) => Promise<string>
}

/** The page's colours: the guideline's tokens, by the theme's name on the root. */
export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme
}

export function mountPhone(hooks: PhoneHooks) {
  const hub = $('hub') as HTMLInputElement | null
  const token = $('token') as HTMLInputElement | null
  const every = $('every') as HTMLInputElement | null
  const lines = $('lines') as HTMLInputElement | null
  const charset = $('charset') as HTMLSelectElement | null
  const lens = $('lens') as HTMLInputElement | null
  const voice = $('voice') as HTMLInputElement | null
  const theme = $('theme') as HTMLSelectElement | null
  const reply = $('reply') as HTMLTextAreaElement | null
  if (!hub || !token || !every || !lines || !charset || !lens || !voice || !theme || !reply) return

  const fill = () => {
    const s = getSettings()
    hub.value = s.hub
    token.value = ''
    token.placeholder = s.token ? 'stored' : 'paste the token'
    every.value = String(s.every)
    lines.value = String(s.lines)
    charset.value = s.charset
    lens.checked = s.lens
    voice.checked = s.voice
    theme.value = s.theme
    applyTheme(s.theme)
    say('conn', s.token ? 'token stored · not tested yet' : 'no token yet', s.token ? '' : 'bad')
  }
  fill()
  if (refusedQuery(window.location)) say('conn', 'settings in the URL are ignored here: type them below', 'bad')

  $('save')?.addEventListener('click', async () => {
    const u = checkHubUrl(hub.value)
    if ('error' in u) return say('conn', u.error, 'bad')
    const next: Partial<Settings> = { hub: u.url, every: Number(every.value), lines: Number(lines.value), charset: charset.value === 'utf-8' ? 'utf-8' : 'latin1', lens: lens.checked, voice: voice.checked, theme: THEMES.includes(theme.value as Theme) ? (theme.value as Theme) : 'amber' }
    if (token.value.trim()) {
      const t = checkToken(token.value)
      if ('error' in t) return say('conn', t.error, 'bad')
      next.token = t.token
    } else if (!getSettings().token) {
      return say('conn', 'paste a token', 'bad')
    }
    const s = await saveSettings(next)
    fill()
    plog('settings saved')
    hooks.onSaved(s)
    await test()
  })
  $('test')?.addEventListener('click', test)
  $('forget')?.addEventListener('click', async () => {
    await forgetToken()
    fill()
    plog('token forgotten')
    hooks.onSaved(getSettings())
  })
  const sendReply = async (enter: boolean) => {
    const text = typed(reply.value)
    if (!text) return say('sent', 'nothing to send', 'bad')
    say('sent', 'sending…')
    const err = await hooks.send(text, enter)
    if (err) return say('sent', err, 'bad')
    reply.value = ''
    say('sent', enter ? 'sent, with Enter' : 'typed, without Enter', 'ok')
  }
  $('send')?.addEventListener('click', () => void sendReply(true))
  $('type')?.addEventListener('click', () => void sendReply(false))
  // The theme follows the select at once; it is kept with save.
  theme.addEventListener('change', () => applyTheme(THEMES.includes(theme.value as Theme) ? (theme.value as Theme) : 'amber'))
  $('mail')?.addEventListener('click', async () => {
    const text = typed(reply.value)
    if (!text) return say('sent', 'nothing to mail', 'bad')
    say('sent', 'asking on the glasses…')
    const err = await hooks.mail(text)
    if (err) return say('sent', err, 'bad')
    reply.value = ''
    say('sent', 'confirm the mail on the glasses', 'ok')
  })

  async function test() {
    say('conn', 'testing…')
    const t0 = Date.now()
    try {
      const a = await api.me()
      let name = 'token'
      try {
        const me = JSON.parse(a.body) as { name?: unknown; write?: unknown }
        if (typeof me.name === 'string') name = `token "${me.name.slice(0, 40)}"`
        if (Array.isArray(me.write) && me.write.length === 0) name += ', read-only'
      } catch {
        /* not JSON: an older hub */
      }
      let voiceNote = ''
      try {
        await api.transcribeProbe()
        voiceNote = ' · spoken replies available'
      } catch {
        voiceNote = ' · no transcriber on the hub'
      }
      say('conn', `hub answered in ${Date.now() - t0} ms · ${name}${voiceNote}`.slice(0, 160), 'ok')
      plog(`GET me ${a.status} ${Date.now() - t0} ms`, 'ok')
    } catch (e) {
      const msg = (e as Error)?.message || String(e)
      say('conn', 'failed: ' + msg, 'bad')
      plog('GET me failed: ' + msg, 'bad')
    }
  }
}

/** Which pane the reply box talks to, and which one a mail would go to. */
export function showOpenPane(pane: Pane | null, mailTo: Pane | null = null) {
  const el = $('to')
  if (!el) return
  const typing = pane ? `to ${paneName(pane)} (${pane.command})${pane.writable ? '' : ' · read-only'}` : 'open a pane on the glasses first'
  el.textContent = mailTo ? `${typing} · mail to ${paneName(mailTo)}` : typing
}
