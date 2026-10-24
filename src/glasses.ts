// The glasses: 576 x 288, one proportional font, four greys. Two page
// kinds. A dash page is free-positioned text blocks, some with a border,
// and up to four image containers, and no list, so the firmware hands its
// scrolls to the app. A list page hands the highlight to the OS and gets
// taps back. Every page has a head line, a body and a hint line.
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
import { MAX_IMG_H, MAX_IMG_W } from './bitmap.ts'
import type { Chart } from './raster.ts'
import { CANVAS_W, LINE_PX, clampBytes, fitWidth } from './text.ts'

export const HEAD_H = 30
export const TOP = 34
export const HINT_Y = 258
export const HINT_H = 30
export const LINE_H = 28
/** Whole list rows only: a row is 40 px, and a sixth would be cut by the hint. */
export const LIST_H = 200
export const MAX_LIST_ITEMS = 20
export const LIST_ROW_PX = 490
export const LIST_ROW_BYTES = 63
export const MENU_LABEL_BYTES = 32
/** Text containers a page may hold are eight, the head and the hint among them. */
export const MAX_BLOCKS = 6
export const MAX_CHARTS = 4
/** Inner padding of a bordered block; a plain block has none, so whole lines fit. */
export const BORDER_PAD = 6

const ID_HEAD = 1
const ID_HINT = 2
const ID_LIST = 3
const ID_BLOCK0 = 10
const ID_CHART0 = 20
const HEAD_CHARS = 200
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
}

export interface MenuSpec {
  id: number
  label: string
}

export interface Page {
  kind: 'list' | 'dash'
  head: string
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
  return { kind, head: '', hint: '', hintLevel: 1, blocks: [], charts: [], items: [], menu: [] }
}

function level(n: number): number {
  return Math.max(0, Math.min(4, Math.round(n)))
}

function headText(s: string): string {
  return (fitWidth(s, LINE_PX) || ' ').slice(0, HEAD_CHARS)
}

/** The block's text: its lines fitted to its width, as many as it has room for. */
export function blockText(b: Block): string {
  const inner = b.border ? b.w - 2 * BORDER_PAD - 4 : b.w - 4
  const rows = Math.max(1, Math.floor((b.border ? b.h - 2 * BORDER_PAD : b.h) / LINE_H))
  return (b.lines.slice(0, rows).map((l) => fitWidth(l, inner)).join('\n') || ' ').slice(0, BLOCK_CHARS)
}

export function listRow(s: string): string {
  return clampBytes(fitWidth(s, LIST_ROW_PX), LIST_ROW_BYTES)
}

/** Everything that forces a rebuild rather than an in-place upgrade. */
function geometry(p: Page): string {
  return JSON.stringify([
    p.kind,
    p.items,
    !!p.hintBorder,
    p.blocks.map((b) => [b.x, b.y, b.w, b.h, !!b.border]),
    p.charts.map((c) => [c.x, c.y, c.w, c.h]),
    p.menu,
  ])
}

export class Glasses {
  private bridge: EvenAppBridge
  private log: (m: string) => void
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

  constructor(bridge: EvenAppBridge, log: (m: string) => void, trace: ((p: Page) => void) | null) {
    this.bridge = bridge
    this.log = log
    this.trace = trace
  }

  private text(id: number, name: string, x: number, y: number, w: number, h: number, content: string, lvl: number, capture: number, z: number, border = false) {
    return new TextContainerProperty({
      zOrderIndex: z,
      xPosition: x,
      yPosition: y,
      width: w,
      height: h,
      borderWidth: border ? 1 : 0,
      borderColor: border ? 4 : 0,
      borderRadius: 0,
      paddingLength: border ? BORDER_PAD : 0,
      containerID: id,
      containerName: name,
      isEventCapture: capture,
      content,
      textColor: level(lvl),
    })
  }

  private payload(p: Page) {
    const textObject = [this.text(ID_HEAD, 'head', 0, 0, CANVAS_W, HEAD_H, headText(p.head), 4, p.kind === 'list' ? 0 : 1, 1)]
    textObject.push(this.text(ID_HINT, 'hint', 0, HINT_Y, CANVAS_W, HINT_H, headText(p.hint), p.hintLevel, 0, 2, !!p.hintBorder))
    p.blocks.slice(0, MAX_BLOCKS).forEach((b, i) => textObject.push(this.text(ID_BLOCK0 + i, 'b' + i, b.x, b.y, b.w, b.h, blockText(b), b.level, 0, 3 + i, !!b.border)))
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

  /** The pictures a page may carry: at most four, none larger than a container; a larger one is
   * dropped and logged rather than letting the firmware refuse the whole page without a word. */
  private fitting(charts: Chart[]): Chart[] {
    const ok = charts.filter((c) => {
      if (c.w <= MAX_IMG_W && c.h <= MAX_IMG_H) return true
      this.log(`picture ${c.key} is ${c.w}x${c.h}, over ${MAX_IMG_W}x${MAX_IMG_H}: dropped`)
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

  private async apply(p: Page, gen: number): Promise<void> {
    this.trace?.({ ...p, items: p.items.map(listRow), charts: p.charts.map((c) => ({ ...c, bitmap: null })) })
    if (!this.created || this.dirty || geometry(p) !== geometry(this.last)) return this.draw(p, gen)
    const prev = this.last
    this.last = clone(p)
    if (p.head !== prev.head) await this.upgrade(ID_HEAD, 'head', headText(p.head))
    if (p.hint !== prev.hint || p.hintLevel !== prev.hintLevel) await this.upgrade(ID_HINT, 'hint', headText(p.hint), p.hintLevel)
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
    if (!this.created) {
      const r = await this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(payload))
      this.created = true
      this.dirty = r !== 0
      if (r !== 0) this.log('createStartUpPageContainer: ' + r)
      else await this.pushCharts(p, true, gen)
      return
    }
    const ok = await this.bridge.rebuildPageContainer(new RebuildPageContainer(payload))
    // The OS refuses a rebuild while its own menu is on top, which is what
    // happens when a menu entry changes the page: try again when it is gone.
    this.dirty = !ok
    if (ok) {
      this.retryMs = 500
      await this.pushCharts(p, true, gen)
      return
    }
    // Also refused for a page the firmware will never take, so the retries slow down.
    this.log('rebuildPageContainer refused')
    if (this.retry) clearTimeout(this.retry)
    this.retry = setTimeout(() => {
      this.retry = null
      if (this.dirty && !this.pending) void this.show(this.last)
    }, this.retryMs)
    this.retryMs = Math.min(5000, this.retryMs * 2)
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
      const r = await this.bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: ID_CHART0 + i, containerName: 'c' + i, imageData: c.bitmap.data() }))
      n++
      bytes += c.bitmap.bytes
      if (ImageRawDataUpdateResult.isSuccess(r)) this.pushed.set(ID_CHART0 + i, c.key)
      else this.log(`picture ${i}: ${r}`)
    }
    if (n) this.log(`${n} ${n === 1 ? 'picture' : 'pictures'}, ${Math.round(bytes / 1024)} KB, ${Date.now() - t0} ms${gen !== this.gen ? ' (page moved on)' : ''}`)
  }

  private async upgrade(id: number, name: string, content: string, textColor?: number) {
    await this.bridge.textContainerUpgrade(
      new TextContainerUpgrade({ containerID: id, containerName: name, content, ...(textColor === undefined ? {} : { textColor: level(textColor) }) }),
    )
  }
}

function clone(p: Page): Page {
  return { ...p, blocks: p.blocks.map((b) => ({ ...b, lines: b.lines.slice() })), charts: p.charts.slice(), items: p.items.slice(), menu: p.menu.map((m) => ({ ...m })) }
}
