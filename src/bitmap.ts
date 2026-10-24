// A four-grey raster for the glasses' image containers: one byte per
// pixel, row-major, quantised by the host to four levels, at most 288 x
// 144 per container. A rebuild wipes the pixels, so pictures are pushed
// again after one.

export const G0 = 0
export const G1 = 85
export const G2 = 170
export const G3 = 255

export const MAX_IMG_W = 288
export const MAX_IMG_H = 144

export class Bitmap {
  readonly w: number
  readonly h: number
  readonly d: Uint8Array

  constructor(w: number, h: number) {
    this.w = w
    this.h = h
    this.d = new Uint8Array(w * h)
  }

  px(x: number, y: number, v: number) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    this.d[y * this.w + x] = v
  }

  rect(x: number, y: number, w: number, h: number, v: number) {
    const x0 = Math.max(0, Math.round(x))
    const y0 = Math.max(0, Math.round(y))
    const x1 = Math.min(this.w, Math.round(x + w))
    const y1 = Math.min(this.h, Math.round(y + h))
    for (let yy = y0; yy < y1; yy++) this.d.fill(v, yy * this.w + x0, yy * this.w + x1)
  }

  frame(x: number, y: number, w: number, h: number, v: number) {
    this.rect(x, y, w, 1, v)
    this.rect(x, y + h - 1, w, 1, v)
    this.rect(x, y, 1, h, v)
    this.rect(x + w - 1, y, 1, h, v)
  }

  hline(x: number, y: number, w: number, v: number) {
    this.rect(x, y, w, 1, v)
  }

  vline(x: number, y: number, h: number, v: number) {
    this.rect(x, y, 1, h, v)
  }

  /** Checkerboard fill: a shade of its own where two greys would not tell apart. */
  hatch(x: number, y: number, w: number, h: number, v: number, step = 2) {
    const x0 = Math.max(0, Math.round(x))
    const y0 = Math.max(0, Math.round(y))
    const x1 = Math.min(this.w, Math.round(x + w))
    const y1 = Math.min(this.h, Math.round(y + h))
    for (let yy = y0; yy < y1; yy++) for (let xx = x0 + ((yy % step) + step) % step; xx < x1; xx += step) this.d[yy * this.w + xx] = v
  }

  /** Dashed rule, for tracks and scales. */
  dashes(x: number, y: number, w: number, v: number, on = 3, off = 4) {
    for (let i = 0; i < w; i++) if (i % (on + off) < on) this.px(Math.round(x + i), Math.round(y), v)
  }

  line(x0: number, y0: number, x1: number, y1: number, v: number) {
    let x = Math.round(x0)
    let y = Math.round(y0)
    const xe = Math.round(x1)
    const ye = Math.round(y1)
    const dx = Math.abs(xe - x)
    const dy = -Math.abs(ye - y)
    const sx = x < xe ? 1 : -1
    const sy = y < ye ? 1 : -1
    let err = dx + dy
    for (;;) {
      this.px(x, y, v)
      if (x === xe && y === ye) return
      const e2 = 2 * err
      if (e2 >= dy) {
        err += dy
        x += sx
      }
      if (e2 <= dx) {
        err += dx
        y += sy
      }
    }
  }

  /** The pixels as the host takes them: a JSON array of numbers (the Even app shows nothing for a base64 string). */
  data(): number[] {
    return Array.from(this.d)
  }

  get bytes(): number {
    return this.d.length
  }

  /** How many pixels are lit at all, for tests. */
  get lit(): number {
    let n = 0
    for (const v of this.d) if (v) n++
    return n
  }
}
