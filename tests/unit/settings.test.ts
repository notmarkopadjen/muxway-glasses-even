// The settings record: the trace switch is a boolean that only true turns on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getSettings, saveSettings } from '../../src/settings.ts'

test('the trace switch: off by default, on only by true', async () => {
  assert.equal(getSettings().detail, false)
  await saveSettings({ detail: 'yes' as never })
  assert.equal(getSettings().detail, false, 'a string is not on')
  await saveSettings({ detail: true })
  assert.equal(getSettings().detail, true)
  await saveSettings({ detail: false })
  assert.equal(getSettings().detail, false)
})
