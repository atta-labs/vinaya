import { expect, test } from 'bun:test'

export const readyGateProbe = true

test('ready-gate probe requires the repaired constant in ready mode', () => {
  expect(typeof readyGateProbe).toBe('boolean')
  if (process.env.VINAYA_PUSH_MODE === 'ready') {
    expect(readyGateProbe).toBe(false)
  }
})
