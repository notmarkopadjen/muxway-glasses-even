import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_SECONDS, Recorder, SAMPLE_RATE, rms, toneFrame, wavFile } from '../../src/voice.ts'

test('wavFile: a 44-byte header around mono 16-bit PCM at 16 kHz', () => {
  const pcm = new Uint8Array(3200)
  const wav = new DataView(wavFile(pcm, SAMPLE_RATE))
  assert.equal(wav.byteLength, 44 + 3200)
  assert.equal(String.fromCharCode(wav.getUint8(0), wav.getUint8(1), wav.getUint8(2), wav.getUint8(3)), 'RIFF')
  assert.equal(wav.getUint16(20, true), 1)
  assert.equal(wav.getUint16(22, true), 1)
  assert.equal(wav.getUint32(24, true), 16000)
  assert.equal(wav.getUint16(34, true), 16)
  assert.equal(wav.getUint32(40, true), 3200)
})

test('rms: silence is 0, a tone is loud, a frame is 100 ms', () => {
  assert.equal(rms(new Uint8Array(3200)), 0)
  const f = toneFrame(0)
  assert.equal(f.length, 3200)
  assert.ok(rms(f) > 0.3 && rms(f) <= 1)
})

test('recorder: frames only while open, capped at the longest clip, dropped on reset', async () => {
  const calls: unknown[] = []
  const bridge = { audioControl: async (...a: unknown[]) => (calls.push(a), true) }
  const r = new Recorder(bridge as never)
  r.push(toneFrame(0))
  assert.equal(r.seconds, 0, 'a frame before start was kept')
  assert.equal(await r.start(), true)
  for (let i = 0; i < 10; i++) r.push(toneFrame(i))
  assert.equal(r.seconds, 1)
  assert.ok(r.level > 0.3)
  r.push(Array.from(toneFrame(10)))
  assert.equal(r.seconds, 1.1, 'a number array frame counts too')
  for (let i = 0; i < MAX_SECONDS * 10 + 5; i++) r.push(toneFrame(i))
  assert.equal(r.seconds, MAX_SECONDS)
  assert.equal(r.full, true)
  assert.equal(r.wav().byteLength, 44 + MAX_SECONDS * SAMPLE_RATE * 2)
  await r.stop()
  assert.deepEqual(calls.map((c) => (c as unknown[])[0]), [true, false])
  r.push(toneFrame(0))
  r.reset()
  assert.equal(r.seconds, 0)
  await r.stop()
  assert.equal(calls.length, 2, 'stop closed an already closed mic')
})
