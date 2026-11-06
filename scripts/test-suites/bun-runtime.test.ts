import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { spawnBudgetedAsync, stripVinayaEnv } from '../../apps/cli/tests/lib/process-fixture'

test('a synchronous child is reaped after GC finalizes earlier piped streams', async () => {
  // Run out of process and asynchronously: a broken Bun cannot freeze this test's own event loop.
  const result = await spawnBudgetedAsync(
    [process.execPath, join(import.meta.dir, 'fixtures/bun-spawn-gc/probe.mjs')],
    { env: { ...stripVinayaEnv(), BUN_JSC_slowPathAllocsBetweenGCs: '3' } },
    15_000,
    'Bun synchronous-spawn GC regression'
  )
  expect(result.status).toBe(0)
  const probe = JSON.parse(result.stdout)
  expect(probe.collected).toBe(3)
  expect(probe.timedOut).toBe(false)
  expect(probe.output).toBe('polled\n')
  expect(probe.status).toBe(0)
}, 20_000)
