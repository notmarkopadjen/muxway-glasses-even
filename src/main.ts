import { waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { App } from './app.ts'
import type { Page } from './glasses.ts'
import { isLoopback } from './protocol.ts'
import { mountPhone, plog, showOpenPane } from './phone.ts'
import { TEST_BUILD, loadSettings } from './settings.ts'
import './phone.css'

let app: App | null = null

/** Every drawn page to the test harness, which serves the page: a test build on loopback only. */
function tracer(): ((p: Page) => void) | null {
  if (!TEST_BUILD) return null
  const id = new URLSearchParams(window.location.search).get('trace')
  if (!id || !/^[a-z0-9]{1,32}$/.test(id) || !isLoopback(window.location.hostname)) return null
  let seq = 0
  return (p) => {
    void fetch('/trace/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seq: seq++, page: p }), keepalive: true }).catch(() => {})
  }
}

async function boot() {
  const trace = tracer()
  // Read before the settings loader strips the query from the address.
  const toneMic = TEST_BUILD && new URLSearchParams(window.location.search).get('mic') === 'tone' && isLoopback(window.location.hostname)
  // The bridge exists inside the Even app and the simulator only; in a
  // plain browser the phone pane still works for the settings.
  const bridge = await Promise.race<EvenAppBridge | null>([waitForEvenAppBridge(), new Promise<null>((r) => setTimeout(() => r(null), 4000))])
  await loadSettings(bridge)
  mountPhone({
    onSaved: () => void app?.onSettingsChanged(),
    send: (text, enter) => (app ? app.sendText(text, enter) : Promise.resolve('open the app from the Even app to reply')),
  })
  showOpenPane(null)
  if (!bridge) {
    plog('no Even bridge: settings only')
    return
  }
  plog('bridge ready')
  app = new App(bridge, plog, trace)
  app.onPane = showOpenPane
  // The test harness has no microphone: a generated tone stands in, in a test build from loopback only.
  app.toneMic = toneMic
  await app.start()
}

boot().catch((e) => plog('boot failed: ' + ((e as Error)?.message || e), 'bad'))
