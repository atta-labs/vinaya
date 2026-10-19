import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { type CheckError, CHECK_SCHEMA_VERSION } from '../../src/checks/contract'
import { spawnBudgetedAsync, stripVinayaEnv } from '../lib/process-fixture'

/**
 * `check-first-push-dispatch.ts` spawned with a fake `gh` first on `PATH`. The
 * scratch repository has no `origin` and the run no `AEG_REPO`, so a readiness
 * classification resolves `UNKNOWN` without any network call.
 */
const BIN = join(import.meta.dir, '../../src/checks/bin/check-first-push-dispatch.ts')

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

type Forge = { kind: 'fail' } | { kind: 'output'; text: string }

async function run(branch: string, forge: Forge): Promise<{ exitCode: number; errors: CheckError[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'first-push-dispatch-'))
  dirs.push(dir)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' })
  const ghDir = join(dir, 'fakebin')
  mkdirSync(ghDir)
  const body =
    forge.kind === 'fail'
      ? "process.stderr.write('error connecting to api.github.com\\n')\nprocess.exit(1)"
      : `process.stdout.write(${JSON.stringify(forge.text)})`
  writeFileSync(join(ghDir, 'gh'), `#!/usr/bin/env bun\n${body}\n`)
  chmodSync(join(ghDir, 'gh'), 0o755)
  const env = { ...stripVinayaEnv(), PATH: `${ghDir}:${process.env.PATH}`, BRANCH: branch }
  delete (env as Record<string, string | undefined>).AEG_REPO
  const { status, stderr } = await spawnBudgetedAsync(['bun', BIN], { cwd: dir, env })
  const errors = stderr
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as CheckError)
  for (const e of errors) expect(e.schema).toBe(CHECK_SCHEMA_VERSION)
  return { exitCode: status, errors }
}

const TASK = 'task/some-tranche/1'

describe('first-push-dispatch bin', () => {
  it('a failing gh on a task branch allows the push with one warning naming the failed pull-request read', async () => {
    const r = await run(TASK, { kind: 'fail' })
    expect(r.exitCode).toBe(0)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]?.severity).toBe('warning')
    expect(r.errors[0]?.message).toContain('pull request')
    expect(r.errors[0]?.message).toContain('gh pr list')
  })

  it('an existing pull request exits 0 with no finding', async () => {
    const r = await run(TASK, { kind: 'output', text: JSON.stringify([{ number: 3 }]) })
    expect(r).toEqual({ exitCode: 0, errors: [] })
  })

  it('a non-task branch exits 0 with no finding', async () => {
    const r = await run('feature/x', { kind: 'fail' })
    expect(r).toEqual({ exitCode: 0, errors: [] })
  })

  it('no pull request and unknown readiness exits 0 with one warning naming readiness', async () => {
    const r = await run(TASK, { kind: 'output', text: '[]' })
    expect(r.exitCode).toBe(0)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]?.severity).toBe('warning')
    expect(r.errors[0]?.message).toContain('readiness')
    expect(r.errors[0]?.message).toContain('unknown')
  })
})
