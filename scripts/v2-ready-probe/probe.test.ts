import { expect, test } from 'bun:test'

export const READY_PROBE_FAILS = true

test('ready-gate probe', () => {
  if (process.env.VINAYA_PUSH_MODE === 'ready') {
    expect(READY_PROBE_FAILS).toBe(false)
  } else {
    expect(typeof READY_PROBE_FAILS).toBe('boolean')
  }
})
