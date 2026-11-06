// The glasses: 576 x 288, one proportional font, four greys. Two page
// kinds. A dash page is free-positioned text blocks, some with a border,
// and up to four image containers, and no list, so the firmware hands its
// scrolls to the app. A list page hands the highlight to the OS and gets
// taps back. Every page has a body and a hint line.
//
// A text change is an in-place upgrade; a layout change is a rebuild,
// during which input is dropped and pictures are wiped, so each page kind
// keeps its geometry and pictures are pushed again after a rebuild, in
// order, skipping those already there, and stopping for a page the wearer
// has left.

import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  ListContainerProperty,
  ListItemContainerProperty,
  MenuContainerProperty,
  MenuItemProperty,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { MAX_IMG_H, MAX_IMG_W, MIN_IMG } from './bitmap.ts'
import type { Chart } from './raster.ts'
import { CANVAS_W, LINE_PX, byteLength, clampBytes, fitWidth } from './text.ts'

export const TOP = 0
export const HINT_Y = 258
export const HINT_H = 30
export const LINE_H = 28
/** Whole list rows only: a row is 40 px, and a seventh would be cut by the hint. */
export const LIST_H = 240
export const MAX_LIST_ITEMS = 20
export const LIST_ROW_PX = 490
export const LIST_ROW_BYTES = 63
export const MENU_LABEL_BYTES = 32
/** Text containers a page may hold are eight, the hint among them. */
export const MAX_BLOCKS = 7
export const MAX_CHARTS = 4
/** Inner padding of a bordered block; a plain block has none, so whole lines fit. */
export const BORDER_PAD = 6
/** The banner's padding: the hint line grows upward by twice this, so its one row fits without a scrollbar. */
export const BANNER_PAD = 3
/** The hint's box top, the banner's too: no block of any page reaches under it, or the glasses refuse the page. */
export const BANNER_Y = HINT_Y - 2 * BANNER_PAD
/** A rule: a bordered container this high draws as a line on the glasses (seen on the device, 2026-11-03). */
export const RULE_H = 2

/** A block whose text is one line of at most this many bytes goes into a create or rebuild whole; a longer one
 * follows as an upgrade, since the device refused a rebuild with a pane's eight lines in it (2026-11-06) and
 * takes the same text as an upgrade. */
export const LIGHT_BYTES = 96

const ID_HINT = 2
const ID_LIST = 3
const ID_BLOCK0 = 10
const ID_CHART0 = 20
const HINT_CHARS = 200
const BLOCK_CHARS = 1900

export interface Block {
  /** A name for tests and for the trace; not sent. */
  name?: string
  x: number
  y: number
  w: number
  h: number
  lines: string[]
  level: number
  border?: boolean
  /** The border's padding when it is not the default: a rule has none. */
  pad?: number
  /** The block that takes the gestures: one with nothing to show, so the firmware's scroll of it moves nothing. */
  capture?: boolean
}

export interface MenuSpec {
  id: number
  label: string
}

export interface Page {
  kind: 'list' | 'dash'
  hint: string
  hintLevel: number
  /** The hint drawn as a banner, bordered and bright: a toast. */
  hintBorder?: boolean
  blocks: Block[]
  charts: Chart[]
  items: string[]
  menu: MenuSpec[]
}

export function emptyPage(kind: 'list' | 'dash' = 'dash'): Page {
  return { kind, hint: '', hintLevel: 1, blocks: [], charts: [], items: [], menu: [] }
}

function level(n: number): number {
  return Math.max(0, Math.min(4, Math.round(n)))
}

function hintText(s: string): string {
  return (fitWidth(s, LINE_PX) || ' ').slice(0, HINT_CHARS)
}

/** The block's text: its lines fitted to its width, as many as it has room for. */
export function blockText(b: Block): string {
  const inner = b.border ? b.w - 2 * BORDER_PAD - 4 : b.w - 4
  const rows = Math.max(1, Math.floor((b.border ? b.h - 2 * BORDER_PAD : b.h) / LINE_H))
  return (b.lines.slice(0, rows).map((l) => fitWidth(l, inner)).join('\n') || ' ').slice(0, BLOCK_CHARS)
}

/** Whether the block's text is too long for a create or rebuild and follows as an upgrade; blank text never is. */
export function heavy(b: Block): boolean {
  const text = blockText(b)
  return text.trim().length > 0 && (text.includes('\n') || byteLength(text) > LIGHT_BYTES)
}

export function listRow(s: string): string {
  return clampBytes(fitWidth(s, LIST_ROW_PX), LIST_ROW_BYTES)
}

/** Everything that forces a rebuild rather than an in-place upgrade. */
function geometry(p: Page): string {
  return JSON.stringify([
    p.kind,
    p.items,
    p.blocks.map((b) => [b.x, b.y, b.w, b.h, !!b.border, b.pad, !!b.capture]),
    p.charts.map((c) => [c.x, c.y, c.w, c.h]),
    p.menu,
  ])
}

/** The JSON bytes of what is handed to the bridge, which is what crosses to the Even app. */
function kb(o: unknown): string {
  const n = new TextEncoder().encode(JSON.stringify(o)).length
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`
}

export class Glasses {
  private bridge: EvenAppBridge
  private log: (m: string) => void
  /** The trace: every bridge call with its size and time, why a rebuild, when a retry. The line is built only when
   * the switch is on, so a page costs nothing more while it is off. */
  private detail: (m: () => string) => void
  private trace: ((p: Page) => void) | null
  private created = false
  private dirty = false
  private retry: ReturnType<typeof setTimeout> | null = null
  private retryMs = 500
  private last: Page = emptyPage()
  private pending: Page | null = null
  private draining = false
  private done: Promise<void> = Promise.resolve()
  private lock: Promise<void> = Promise.resolve()
  private pushed = new Map<number, string>()
  private gen = 0

  constructor(bridge: EvenAppBridge, log: (m: string) => void, trace: ((p: Page) => void) | null, detail: (m: () => string) => void = () => {}) {
    this.bridge = bridge
    this.log = log
    this.trace = trace
    this.detail = detail
  }

  private text(id: number, name: string, x: number, y: number, w: number, h: number, content: string, lvl: number, capture: number, z: number, border = false, pad = BORDER_PAD) {
    return new TextContainerProperty({
      zOrderIndex: z,
      xPosition: x,
      yPosition: y,
      width: w,
      height: h,
      borderWidth: border ? 1 : 0,
      borderColor: border ? 4 : 0,
      borderRadius: 0,
      paddingLength: border ? pad : 0,
      containerID: id,
      containerName: name,
      isEventCapture: capture,
      content,
      textColor: level(lvl),
    })
  }

  /** The create or rebuild payload: the heavy blocks hold a space, their text follows (fill). */
  private payload(p: Page) {
    // On a list page the list takes the gestures; on a dash page the block marked for it, one with
    // nothing to show, since the firmware scrolls the text of the container that takes them (the
    // hint moved with every scroll while it did). The hint is a box with exactly one line inside,
    // the banner's shape; its top edge is the rule above the footer on every page, and a banner is
    // the same box, brighter, so a toast is an upgrade and not a rebuild.
    const blocks = p.blocks.slice(0, MAX_BLOCKS)
    const caught = p.kind === 'list' || blocks.some((b) => b.capture)
    const textObject = [this.text(ID_HINT, 'hint', 0, BANNER_Y, CANVAS_W, HINT_H + 2 * BANNER_PAD, hintText(p.hint), p.hintLevel, caught ? 0 : 1, 2, true, BANNER_PAD)]
    blocks.forEach((b, i) => textObject.push(this.text(ID_BLOCK0 + i, 'b' + i, b.x, b.y, b.w, b.h, heavy(b) ? ' ' : blockText(b), b.level, b.capture ? 1 : 0, 3 + i, !!b.border, b.pad ?? BORDER_PAD)))
    const imageObject = this.fitting(p.charts).map(
      (c, i) => new ImageContainerProperty({ xPosition: c.x, yPosition: c.y, width: c.w, height: c.h, containerID: ID_CHART0 + i, containerName: 'c' + i, zOrderIndex: 12 + i }),
    )
    const items = (p.items.length ? p.items : ['(empty)']).slice(0, MAX_LIST_ITEMS).map(listRow)
    const listObject =
      p.kind === 'list'
        ? [
            new ListContainerProperty({
              xPosition: 0,
              yPosition: TOP,
              width: CANVAS_W,
              height: LIST_H,
              borderWidth: 0,
              borderColor: 0,
              borderRadius: 0,
              paddingLength: 2,
              containerID: ID_LIST,
              containerName: 'list',
              zOrderIndex: 11,
              isEventCapture: 1,
              itemContainer: new ListItemContainerProperty({ itemCount: items.length, itemWidth: CANVAS_W - 10, isItemSelectBorderEn: 1, itemName: items }),
            }),
          ]
        : undefined
    const menu = p.menu.length
      ? new MenuContainerProperty({ menuItems: p.menu.slice(0, 10).map((m) => new MenuItemProperty({ itemID: m.id, itemName: clampBytes(m.label, MENU_LABEL_BYTES) })) })
      : undefined
    return {
      containerTotalNum: textObject.length + imageObject.length + (listObject ? 1 : 0),
      ...(listObject ? { listObject } : {}),
      textObject,
      ...(imageObject.length ? { imageObject } : {}),
      ...(menu ? { menuObject: menu } : {}),
    }
  }

  /** The pictures a page may carry: at most four, none larger than a container and none thinner than
   * the glasses take; one outside is dropped and logged rather than letting the firmware refuse the
   * whole page without a word. */
  private fitting(charts: Chart[]): Chart[] {
    const ok = charts.filter((c) => {
      if (c.w <= MAX_IMG_W && c.h <= MAX_IMG_H && c.w >= MIN_IMG && c.h >= MIN_IMG) return true
      this.log(`picture ${c.key} is ${c.w}x${c.h}, not within ${MIN_IMG}x${MIN_IMG} and ${MAX_IMG_W}x${MAX_IMG_H}: dropped`)
      return false
    })
    if (ok.length > MAX_CHARTS) this.log(`${ok.length} pictures on one page: only ${MAX_CHARTS} shown`)
    return ok.slice(0, MAX_CHARTS)
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn)
    this.lock = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** Shows the page: the first call creates it, later ones rebuild or upgrade it in place. The newest page replaces one still waiting. */
  show(p: Page): Promise<void> {
    this.pending = p
    if (!this.draining) {
      this.draining = true
      this.done = this.exclusive(() => this.drain())
    }
    return this.done
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending) {
        const p = this.pending
        this.pending = null
        const gen = ++this.gen
        try {
          await this.apply(p, gen)
        } catch (e) {
          this.log('draw failed: ' + ((e as Error)?.message || e))
        }
      }
    } finally {
      this.draining = false
    }
  }

  /** Which of the page's geometry differs from the last page's: the reason for a rebuild, for the trace. */
  private changed(p: Page): string {
    const a = p
    const b = this.last
    const parts: string[] = []
    if (a.kind !== b.kind) parts.push('kind')
    if (JSON.stringify(a.items) !== JSON.stringify(b.items)) parts.push('items')
    if (JSON.stringify(a.blocks.map((x) => [x.x, x.y, x.w, x.h, !!x.border, x.pad, !!x.capture])) !== JSON.stringify(b.blocks.map((x) => [x.x, x.y, x.w, x.h, !!x.border, x.pad, !!x.capture]))) parts.push('blocks')
    if (JSON.stringify(a.charts.map((c) => [c.x, c.y, c.w, c.h])) !== JSON.stringify(b.charts.map((c) => [c.x, c.y, c.w, c.h]))) parts.push('charts')
    if (JSON.stringify(a.menu) !== JSON.stringify(b.menu)) parts.push('menu')
    return parts.join(', ')
  }

  private async apply(p: Page, gen: number): Promise<void> {
    this.trace?.({ ...p, items: p.items.map(listRow), charts: p.charts.map((c) => ({ ...c, bitmap: null })) })
    if (!this.created || this.dirty || geometry(p) !== geometry(this.last)) {
      this.detail(() => (!this.created ? 'create: the first page' : this.dirty ? 'rebuild: the last one was refused' : 'rebuild: ' + this.changed(p) + ' changed'))
      return this.draw(p, gen)
    }
    const prev = this.last
    this.last = clone(p)
    if (p.hint !== prev.hint || p.hintLevel !== prev.hintLevel) await this.upgrade(ID_HINT, 'hint', hintText(p.hint), p.hintLevel)
    for (let i = 0; i < p.blocks.length; i++) {
      const a = p.blocks[i]
      const b = prev.blocks[i]
      const text = blockText(a)
      if (b && text === blockText(b) && a.level === b.level) continue
      await this.upgrade(ID_BLOCK0 + i, 'b' + i, text, a.level)
    }
    await this.pushCharts(p, false, gen)
  }

  private async draw(p: Page, gen: number): Promise<void> {
    const payload = this.payload(p)
    this.last = clone(p)
    this.dirty = false
    const t0 = Date.now()
    if (!this.created) {
      const r = await this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(payload))
      this.detail(() => `create ${payload.containerTotalNum} containers · ${kb(payload)} · ${Date.now() - t0} ms · ${r === 0 ? 'ok' : 'code ' + r}`)
      this.created = true
      this.dirty = r !== 0
      if (r !== 0) this.log('createStartUpPageContainer: ' + r)
      else {
        // The page is new on the glasses: its pictures are gone whatever fill does, so the next push sends them all.
        this.pushed.clear()
        await this.fill(p, gen)
        await this.pushCharts(p, true, gen)
      }
      return
    }
    const ok = await this.bridge.rebuildPageContainer(new RebuildPageContainer(payload))
    this.detail(() => `rebuild ${payload.containerTotalNum} containers · ${kb(payload)} · ${Date.now() - t0} ms · ${ok ? 'ok' : 'refused'}`)
    // The OS refuses a rebuild while its own menu is on top, which is what
    // happens when a menu entry changes the page: try again when it is gone.
    this.dirty = !ok
    if (ok) {
      this.retryMs = 500
      this.pushed.clear()
      await this.fill(p, gen)
      await this.pushCharts(p, true, gen)
      return
    }
    // Also refused for a page the firmware will never take, so the retries slow down.
    this.log('rebuildPageContainer refused')
    this.detail(() => `retry in ${this.retryMs} ms`)
    if (this.retry) clearTimeout(this.retry)
    this.retry = setTimeout(() => {
      this.retry = null
      if (this.dirty && !this.pending) void this.show(this.last)
    }, this.retryMs)
    this.retryMs = Math.min(5000, this.retryMs * 2)
  }

  /** The heavy blocks' text after a create or rebuild, in block order. One not sent, because the page moved on or
   * the bridge threw, is left blank in `last`, so the next apply of the page sends it. */
  private async fill(p: Page, gen: number) {
    const blocks = p.blocks.slice(0, MAX_BLOCKS)
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]
      if (!heavy(b)) continue
      if (gen !== this.gen) {
        this.last.blocks[i] = { ...b, lines: [] }
        continue
      }
      try {
        await this.upgrade(ID_BLOCK0 + i, 'b' + i, blockText(b), b.level)
      } catch (e) {
        this.last.blocks[i] = { ...b, lines: [] }
        throw e
      }
    }
  }

  /** Pictures after a rebuild (force) or those whose key changed; a page that moved on ends the loop. */
  private async pushCharts(p: Page, force: boolean, gen: number) {
    if (force) this.pushed.clear()
    const t0 = Date.now()
    let n = 0
    let bytes = 0
    const charts = this.fitting(p.charts)
    for (let i = 0; i < charts.length; i++) {
      if (gen !== this.gen) break
      const c = charts[i]
      if (!c.bitmap || this.pushed.get(ID_CHART0 + i) === c.key) continue
      const t1 = Date.now()
      const size = c.bitmap.bytes
      const r = await this.bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: ID_CHART0 + i, containerName: 'c' + i, imageData: c.bitmap.data() }))
      this.detail(() => `picture c${i} · ${Math.round(size / 1024)} KB · ${Date.now() - t1} ms · ${ImageRawDataUpdateResult.isSuccess(r) ? 'ok' : r}`)
      n++
      bytes += c.bitmap.bytes
      if (ImageRawDataUpdateResult.isSuccess(r)) this.pushed.set(ID_CHART0 + i, c.key)
      else this.log(`picture ${i}: ${r}`)
    }
    if (n) this.log(`${n} ${n === 1 ? 'picture' : 'pictures'}, ${Math.round(bytes / 1024)} KB, ${Date.now() - t0} ms${gen !== this.gen ? ' (page moved on)' : ''}`)
  }

  private async upgrade(id: number, name: string, content: string, textColor?: number) {
    const u = new TextContainerUpgrade({ containerID: id, containerName: name, content, ...(textColor === undefined ? {} : { textColor: level(textColor) }) })
    const t0 = Date.now()
    await this.bridge.textContainerUpgrade(u)
    this.detail(() => `upgrade ${name} · ${kb(u)} · ${Date.now() - t0} ms`)
  }
}

function clone(p: Page): Page {
  return { ...p, blocks: p.blocks.map((b) => ({ ...b, lines: b.lines.slice() })), charts: p.charts.slice(), items: p.items.slice(), menu: p.menu.map((m) => ({ ...m })) }
}
