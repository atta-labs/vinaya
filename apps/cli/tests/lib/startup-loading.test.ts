// Starting the command-line program loads only what its command runs: a start that records nothing loads no part of
// the Log sink, so an edit to the sink, its schema or its writers selects only the tests whose commands log.
import { afterAll, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSyncBudgeted } from '../../../../harness/kernel/conformance/unit/process-fixture'

const REPO_ROOT = join(import.meta.dir, '../../../..')
const ENTRY = join(REPO_ROOT, 'apps/cli/src/index.ts')
const dir = mkdtempSync(join(tmpdir(), 'startup-loading-'))
const preload = join(dir, 'loaded.ts')
writeFileSync(
  preload,
  "process.on('exit', () => process.stderr.write(`LOADED ${JSON.stringify(Object.keys(require.cache))}\\n`))\n"
)
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function loadedBy(args: string[]): string[] {
  const run = spawnSyncBudgeted('bun', ['--preload', preload, ENTRY, ...args], { cwd: REPO_ROOT, encoding: 'utf8' })
  const line = String(run.stderr)
    .split('\n')
    .find((l) => l.startsWith('LOADED '))
  expect(line).toBeDefined()
  return (JSON.parse((line as string).slice('LOADED '.length)) as string[]).map((p) => p.slice(REPO_ROOT.length + 1))
}

it('version loads no part of the Log sink and stays small', () => {
  const loaded = loadedBy(['version'])
  expect(loaded.filter((p) => p.startsWith('harness/kernel/log/') && !p.endsWith('/cli-operation-log.ts'))).toEqual(
    expect.not.arrayContaining(['harness/kernel/log/log-sink.ts', 'harness/kernel/log/client/narration.ts'])
  )
  expect(loaded).not.toContain('harness/kernel/log/log-sink.ts')
  expect(loaded).not.toContain('harness/kernel/log/client/loop-log.ts')
  expect(loaded).not.toContain('harness/kernel/log/client/narration.ts')
  expect(loaded).not.toContain('harness/processes/vinaya-strict/integration/log/log-sink-factory.ts')
  expect(loaded.length).toBeLessThanOrEqual(90)
}, 60_000)
