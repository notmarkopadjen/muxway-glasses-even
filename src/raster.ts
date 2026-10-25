// Pictures as the glasses take them: a bitmap cut into image containers.

import { Bitmap, MAX_IMG_H, MAX_IMG_W } from './bitmap.ts'

export interface Chart {
  x: number
  y: number
  w: number
  h: number
  /** Identity of the pixels: a picture already on the glasses under this key is not pushed again. */
  key: string
  bitmap: Bitmap | null
}

/** A bitmap cut into as few image containers as the limits allow, all one size, top-left at (x, y). */
export function tiles(bmp: Bitmap, x: number, y: number, key: string): Chart[] {
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
      out.push({ x: x + c * tw, y: y + r * th, w: tw, h: th, key: `${key}:${r}:${c}`, bitmap: tb })
    }
  }
  return out
}
