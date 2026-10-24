// Pixels for what the firmware font cannot do: a bold title band, drawn
// in the WebView's canvas and sent as an image like a chart.
// Anti-aliased edges land on the two middle greys, which is what keeps a
// canvas font smooth on a four-level display.

import { Bitmap, G1, G2, G3, MAX_IMG_H, MAX_IMG_W } from './bitmap.ts'

const TITLE_FONT = 'bold 23px system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
export const BAND_H = 30

export interface Chart {
  x: number
  y: number
  w: number
  h: number
  /** Identity of the pixels: a picture already on the glasses under this key is not pushed again. */
  key: string
  bitmap: Bitmap | null
  /** The words a band shows, for the trace; a chart has none. */
  text?: string
}

const cache = new Map<string, Bitmap | null>()

/**
 * One line of bold text, `w` wide and BAND_H tall, cut with an ellipsis
 * when it does not fit; inverted draws black on white. Null where the
 * WebView has no canvas, and the caller shows plain text instead.
 */
export function band(text: string, w: number, inverted = false): Bitmap | null {
  const key = `${w}:${inverted ? 1 : 0}:${text}`
  if (cache.has(key)) return cache.get(key)!
  const bmp = drawBand(text, w, inverted)
  if (cache.size > 48) cache.delete(cache.keys().next().value as string)
  cache.set(key, bmp)
  return bmp
}

function drawBand(text: string, w: number, inverted: boolean): Bitmap | null {
  let ctx: CanvasRenderingContext2D | null = null
  try {
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = BAND_H
    ctx = canvas.getContext('2d')
  } catch {
    return null
  }
  if (!ctx) return null
  ctx.font = TITLE_FONT
  const pad = 6
  const room = w - 2 * pad
  let s = text.replace(/\s+/g, ' ').trim()
  if (ctx.measureText(s).width > room) {
    while (s && ctx.measureText(s + '…').width > room) s = s.slice(0, -1)
    s = s.trimEnd() + '…'
  }
  ctx.fillStyle = inverted ? '#fff' : '#000'
  ctx.fillRect(0, 0, w, BAND_H)
  ctx.fillStyle = inverted ? '#000' : '#fff'
  ctx.textBaseline = 'middle'
  ctx.fillText(s, pad, BAND_H / 2 + 1)
  const rgba = ctx.getImageData(0, 0, w, BAND_H).data
  const bmp = new Bitmap(w, BAND_H)
  for (let p = 0; p < w * BAND_H; p++) {
    const v = rgba[p * 4]
    bmp.d[p] = v < 48 ? 0 : v < 120 ? G1 : v < 200 ? G2 : G3
  }
  return bmp
}

/** A bitmap cut into as few image containers as the limits allow, all one size, top-left at (x, y). */
export function tiles(bmp: Bitmap, x: number, y: number, key: string, text?: string): Chart[] {
  const cols = Math.ceil(bmp.w / MAX_IMG_W)
  const rows = Math.ceil(bmp.h / MAX_IMG_H)
  const tw = Math.ceil(bmp.w / cols)
  const th = Math.ceil(bmp.h / rows)
  const out: Chart[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tb = new Bitmap(tw, th)
      for (let yy = 0; yy < th; yy++) {
        const sy = r * th + yy
        if (sy >= bmp.h) break
        for (let xx = 0; xx < tw; xx++) {
          const sx = c * tw + xx
          if (sx < bmp.w) tb.d[yy * tw + xx] = bmp.d[sy * bmp.w + sx]
        }
      }
      out.push({ x: x + c * tw, y: y + r * th, w: tw, h: th, key: `${key}:${r}:${c}`, bitmap: tb, ...(text !== undefined ? { text } : {}) })
    }
  }
  return out
}
