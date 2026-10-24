// The glasses: 576 x 288, one proportional font, four greys. Two page
// kinds. A text page (the pane) carries no list, so the firmware hands
// its scrolls to the app, which pages the text itself. A list page (the
// panes, the answers, the confirmation) hands the highlight to the OS and
// gets taps back. Every page has a head line, a body and a hint line.
//
// A text change is an in-place upgrade; a layout change is a rebuild,
// during which input is dropped, so a page kind keeps one geometry. An
// oversize row rejects a whole page silently, so every row is clamped by
// pixels and by bytes before it leaves.

import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  MenuContainerProperty,
  MenuItemProperty,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { CANVAS_W, LINE_PX, clampBytes, fitWidth } from './text.ts'

export const HEAD_H = 30
export const TOP = 34
export const HINT_Y = 258
/** Whole list rows only: a row is 40 px, and a sixth would be cut by the hint. */
export const LIST_H = 200
export const HINT_H = 30
export const LINE_H = 28
/** Lines of pane text on a page without a pinned block. */
export const BODY_LINES = 8
/** Lines of text and of the pinned block when there is one. */
export const SPLIT_LINES = 6
export const PIN_LINES = 2
export const MAX_LIST_ITEMS = 20
export const LIST_ROW_PX = 490
export const LIST_ROW_BYTES = 63
export const MENU_LABEL_BYTES = 32

const ID_HEAD = 1
const ID_HINT = 2
const ID_LIST = 3
const ID_BLOCK0 = 10

export interface Block {
  /** Lines of text, joined with newlines. */
  lines: string[]
  /** How many lines the block has room for. */
  height: number
  level: number
}

export interface MenuSpec {
  id: number
  label: string
}

export interface Page {
  kind: 'list' | 'text'
  head: string
  hint: string
  hintLevel: number
  blocks: Block[]
  items: string[]
  menu: MenuSpec[]
}

export function emptyPage(kind: 'list' | 'text' = 'text'): Page {
  return { kind, head: '', hint: '', hintLevel: 1, blocks: [], items: [], menu: [] }
}

function level(n: number): number {
  return Math.max(0, Math.min(4, Math.round(n)))
}

// Caps on top of the pixel fit, for the firmware's own limits on a container's text.
const HEAD_CHARS = 200
const BLOCK_CHARS = 1900

function blockText(b: Block): string {
  return (b.lines.slice(0, b.height).map((l) => fitWidth(l, LINE_PX)).join('\n') || ' ').slice(0, BLOCK_CHARS)
}

function headText(s: string): string {
  return (fitWidth(s, LINE_PX) || ' ').slice(0, HEAD_CHARS)
}

export function listRow(s: string): string {
  return clampBytes(fitWidth(s, LIST_ROW_PX), LIST_ROW_BYTES)
}

/** Everything that forces a rebuild rather than an in-place upgrade. */
function geometry(p: Page): string {
  return JSON.stringify([p.kind, p.items, p.blocks.map((b) => b.height), p.menu])
}

export class Glasses {
  private created = false
  private dirty = false
  private retry: ReturnType<typeof setTimeout> | null = null
  private last: Page = emptyPage()
  private pending: Page | null = null
  private draining = false
  private done: Promise<void> = Promise.resolve()
  private lock: Promise<void> = Promise.resolve()

  private bridge: EvenAppBridge
  private log: (m: string) => void
  private trace: ((p: Page) => void) | null

  constructor(bridge: EvenAppBridge, log: (m: string) => void, trace: ((p: Page) => void) | null) {
    this.bridge = bridge
    this.log = log
    this.trace = trace
  }

  private text(id: number, name: string, y: number, h: number, content: string, lvl: number, capture: number, z: number) {
    return new TextContainerProperty({
      zOrderIndex: z,
      xPosition: 0,
      yPosition: y,
      width: CANVAS_W,
      height: h,
      borderWidth: 0,
      borderColor: 0,
      borderRadius: 0,
      paddingLength: 0,
      containerID: id,
      containerName: name,
      isEventCapture: capture,
      content,
      textColor: level(lvl),
    })
  }

  private payload(p: Page) {
    const textObject = [this.text(ID_HEAD, 'head', 0, HEAD_H, headText(p.head), 4, p.kind === 'list' ? 0 : 1, 1)]
    textObject.push(this.text(ID_HINT, 'hint', HINT_Y, HINT_H, headText(p.hint), p.hintLevel, 0, 2))
    let y = TOP
    p.blocks.forEach((b, i) => {
      textObject.push(this.text(ID_BLOCK0 + i, 'b' + i, y, b.height * LINE_H, blockText(b), b.level, 0, 3 + i))
      y += b.height * LINE_H + 6
    })
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
              zOrderIndex: 9,
              isEventCapture: 1,
              itemContainer: new ListItemContainerProperty({
                itemCount: items.length,
                itemWidth: CANVAS_W - 10,
                isItemSelectBorderEn: 1,
                itemName: items,
              }),
            }),
          ]
        : undefined
    const menu = p.menu.length
      ? new MenuContainerProperty({
          menuItems: p.menu.slice(0, 10).map((m) => new MenuItemProperty({ itemID: m.id, itemName: clampBytes(m.label, MENU_LABEL_BYTES) })),
        })
      : undefined
    return {
      containerTotalNum: textObject.length + (listObject ? 1 : 0),
      ...(listObject ? { listObject } : {}),
      textObject,
      ...(menu ? { menuObject: menu } : {}),
    }
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn)
    this.lock = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** Shows the page: the first call creates it, later ones rebuild or upgrade it in place. */
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
        try {
          await this.apply(p)
        } catch (e) {
          this.log('draw failed: ' + ((e as Error)?.message || e))
        }
      }
    } finally {
      this.draining = false
    }
  }

  private async apply(p: Page): Promise<void> {
    this.trace?.({ ...p, items: p.items.map(listRow) })
    if (!this.created || this.dirty || geometry(p) !== geometry(this.last)) return this.draw(p)
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
  }

  private async draw(p: Page): Promise<void> {
    const payload = this.payload(p)
    this.last = clone(p)
    this.dirty = false
    if (!this.created) {
      const r = await this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(payload))
      this.created = true
      this.dirty = r !== 0
      if (r !== 0) this.log('createStartUpPageContainer: ' + r)
      return
    }
    const ok = await this.bridge.rebuildPageContainer(new RebuildPageContainer(payload))
    // The OS refuses a rebuild while its own menu is on top, which is what
    // happens when a menu entry changes the page: try again when it is gone.
    this.dirty = !ok
    if (ok) return
    this.log('rebuildPageContainer refused')
    if (this.retry) clearTimeout(this.retry)
    this.retry = setTimeout(() => {
      this.retry = null
      if (this.dirty && !this.pending) void this.show(this.last)
    }, 500)
  }

  private async upgrade(id: number, name: string, content: string, textColor?: number) {
    await this.bridge.textContainerUpgrade(
      new TextContainerUpgrade({ containerID: id, containerName: name, content, ...(textColor === undefined ? {} : { textColor: level(textColor) }) }),
    )
  }
}

function clone(p: Page): Page {
  return { ...p, blocks: p.blocks.map((b) => ({ ...b, lines: b.lines.slice() })), items: p.items.slice(), menu: p.menu.map((m) => ({ ...m })) }
}
