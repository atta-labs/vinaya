import { expect, test } from 'bun:test'

export const readyGateProbe = true

test('ready gate requires the probe to be repaired', () => {
  expect(typeof readyGateProbe).toBe('boolean')
  if (process.env.VINAYA_PUSH_MODE === 'ready') {
    expect(readyGateProbe).toBe(false)
  }
})
