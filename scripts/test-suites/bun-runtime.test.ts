import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnBudgetedAsync, stripVinayaEnv } from '../../harness/kernel/conformance/unit/process-fixture'

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

test('Bun resolves a hoisted package independently of the importing manifest dependency range', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bun-hoisted-resolution-')))
  try {
    const workspace = join(root, 'packages', 'probe')
    const installed = join(root, 'node_modules', 'installed-probe')
    mkdirSync(join(workspace, 'src'), { recursive: true })
    mkdirSync(installed, { recursive: true })
    const module = join(installed, 'index.js')
    writeFileSync(
      join(installed, 'package.json'),
      '{"name":"installed-probe","version":"1.0.0","type":"module","main":"index.js"}'
    )
    writeFileSync(module, 'export default import.meta.path\n')
    const probe = join(workspace, 'src', 'probe.ts')
    writeFileSync(probe, "import resolved from 'installed-probe'\nconsole.log(resolved)\n")
    for (const dependencies of [{ 'installed-probe': '^1.0.0' }, { 'installed-probe': '^2.0.0' }, undefined]) {
      writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'probe', dependencies }))
      const result = await spawnBudgetedAsync(
        [process.execPath, probe],
        { cwd: workspace, env: stripVinayaEnv() },
        5_000,
        'Bun hoisted manifest dependency probe'
      )
      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe(module)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 20_000)
