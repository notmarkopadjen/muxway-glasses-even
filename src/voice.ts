// The microphone: the Even app pushes 16 kHz mono 16-bit PCM frames while
// the mic is open; they are kept in memory, wrapped in a WAV for the hub,
// and dropped after. Nothing is stored.

import { AudioInputSource, type EvenAppBridge } from '@evenrealities/even_hub_sdk'

export const SAMPLE_RATE = 16_000
const BYTES_PER_SAMPLE = 2
/** The longest clip; the hub takes 4 MiB, this is a quarter of it. */
export const MAX_SECONDS = 60
export const MIN_SECONDS = 0.5
/** Seconds without a frame after which the mic is given up on. */
export const GRACE_SECONDS = 4
const MAX_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE * MAX_SECONDS
/** Frames kept for the graph: fourteen seconds. */
const LEVEL_HISTORY = 140

/** Loudness of one frame, 0 to 1. */
export function rms(buf: Uint8Array): number {
  const n = buf.length >> 1
  if (!n) return 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const s = ((buf[i * 2] | (buf[i * 2 + 1] << 8)) << 16) >> 16
    sum += s * s
  }
  return Math.min(1, Math.sqrt(sum / n) / 8000)
}

export class Recorder {
  private bridge: EvenAppBridge
  private chunks: Uint8Array[] = []
  private bytes = 0
  private startedAt = 0
  private open = false
  /** Loudness of the last frame, 0 to 1. */
  level = 0
  /** Loudness of the last frames, oldest first: the graph on the listening page. */
  levels: number[] = []

  constructor(bridge: EvenAppBridge) {
    this.bridge = bridge
  }

  get recording(): boolean {
    return this.open
  }

  get seconds(): number {
    return this.bytes / (SAMPLE_RATE * BYTES_PER_SAMPLE)
  }

  /** Seconds since the mic was asked for, for the grace period. */
  get elapsed(): number {
    return this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0
  }

  get full(): boolean {
    return this.bytes >= MAX_BYTES
  }

  /** Opens the mic. The host answers true when it did; the simulator never does, so a false is a warning only. */
  async start(): Promise<boolean> {
    this.reset()
    this.startedAt = Date.now()
    this.open = true
    try {
      return await this.bridge.audioControl(true, AudioInputSource.Glasses)
    } catch {
      return false
    }
  }

  /** One frame from the host, while recording. */
  push(pcm: Uint8Array | number[] | undefined) {
    if (!this.open || !pcm) return
    const buf = pcm instanceof Uint8Array ? pcm : Uint8Array.from(pcm)
    if (!buf.length || this.bytes >= MAX_BYTES) return
    const take = buf.length <= MAX_BYTES - this.bytes ? buf : buf.subarray(0, MAX_BYTES - this.bytes)
    this.chunks.push(take)
    this.bytes += take.length
    this.level = rms(take)
    this.levels.push(this.level)
    if (this.levels.length > LEVEL_HISTORY) this.levels.splice(0, this.levels.length - LEVEL_HISTORY)
  }

  async stop() {
    if (!this.open) return
    this.open = false
    try {
      await this.bridge.audioControl(false)
    } catch {
      /* the host may have closed it already */
    }
  }

  wav(): ArrayBuffer {
    const pcm = new Uint8Array(this.bytes)
    let at = 0
    for (const c of this.chunks) {
      pcm.set(c, at)
      at += c.length
    }
    return wavFile(pcm, SAMPLE_RATE)
  }

  reset() {
    this.chunks = []
    this.bytes = 0
    this.startedAt = 0
    this.level = 0
    this.levels = []
  }
}

/** A 44-byte RIFF/WAVE header around mono 16-bit PCM. */
export function wavFile(pcm: Uint8Array, sampleRate: number): ArrayBuffer {
  const out = new ArrayBuffer(44 + pcm.length)
  const view = new DataView(out)
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true)
  view.setUint16(32, BYTES_PER_SAMPLE, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, pcm.length, true)
  new Uint8Array(out, 44).set(pcm)
  return out
}

/** One 100 ms frame of a 440 Hz tone, what the test harness feeds in place of a microphone. */
export function toneFrame(index: number): Uint8Array {
  const samples = SAMPLE_RATE / 10
  const out = new Uint8Array(samples * BYTES_PER_SAMPLE)
  for (let i = 0; i < samples; i++) {
    const t = (index * samples + i) / SAMPLE_RATE
    const v = Math.round(6000 * Math.sin(2 * Math.PI * 440 * t))
    out[i * 2] = v & 0xff
    out[i * 2 + 1] = (v >> 8) & 0xff
  }
  return out
}
