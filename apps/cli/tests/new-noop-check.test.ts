import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CheckSpec } from '../src/checks/contract'
import { coreCheckRegistry } from '../src/checks/registry'
import { runChecks } from '../src/checks/runner'

const CLI_ENTRY = join(import.meta.dir, '..', 'src', 'index.ts')

let tmpDir: string | undefined

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = undefined
  }
})

describe('vinaya new noop-check (scaffold round-trip)', () => {
  it('generates a no-op that runs through runChecks unmodified and always passes', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vinaya-new-noop-check-'))
    const core = coreCheckRegistry()[0] as CheckSpec

    const proc = Bun.spawn(['bun', CLI_ENTRY, 'new', 'noop-check', core.name], {
      cwd: tmpDir,
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    expect(exitCode).toBe(0)
    expect(stdout).toContain('REPLACES')
    expect(stdout).toContain(`"scope": "${core.scope}"`)

    const generatedPath = join(tmpDir, 'vinaya', 'checks', `${core.name}.ts`)
    expect(existsSync(generatedPath)).toBe(true)

    const spec: CheckSpec = { name: core.name, run: generatedPath, scope: core.scope }
    const [outcome] = await runChecks([spec], {
      parallel: 1,
      diffOnly: false,
      changedFiles: null,
      defaultTimeoutMs: 5000
    })

    expect(outcome?.status).toBe('pass')
    expect(outcome?.exitCode).toBe(0)
    expect(outcome?.errors).toHaveLength(0)
  })

  // A dropped `ownWorkflow`/`requiresOpenPr` on the printed entry would
  // silently widen when the noop runs versus the core check it replaces
  // (`ownWorkflow` withholds a check from `--all` specifically to avoid a
  // second, stale conclusion — see `runsUnderAll` in `checks/registry.ts`).
  it('carries ownWorkflow through to the printed registration for a check that has it', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vinaya-new-noop-check-'))
    const core = coreCheckRegistry().find((spec) => spec.ownWorkflow) as CheckSpec
    expect(core).toBeTruthy()

    const proc = Bun.spawn(['bun', CLI_ENTRY, 'new', 'noop-check', core.name], {
      cwd: tmpDir,
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    expect(exitCode).toBe(0)

    const printed = JSON.parse(stdout.slice(stdout.indexOf('{')))
    expect(printed.checks[core.name].ownWorkflow).toBe(true)
  })

  it('omits requiresOpenPr/ownWorkflow from the printed registration for a check that has neither', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vinaya-new-noop-check-'))
    const core = coreCheckRegistry().find((spec) => !spec.ownWorkflow && !spec.requiresOpenPr) as CheckSpec
    expect(core).toBeTruthy()

    const proc = Bun.spawn(['bun', CLI_ENTRY, 'new', 'noop-check', core.name], {
      cwd: tmpDir,
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    expect(exitCode).toBe(0)

    const printed = JSON.parse(stdout.slice(stdout.indexOf('{')))
    expect(printed.checks[core.name]).not.toHaveProperty('ownWorkflow')
    expect(printed.checks[core.name]).not.toHaveProperty('requiresOpenPr')
  })

  // The opposite refusal from `new check`: a name that ISN'T a core check id
  // has nothing to silence — `new check` is the scaffolder for that shape.
  it('refuses a name that is not a core check id', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vinaya-new-noop-check-'))

    const proc = Bun.spawn(['bun', CLI_ENTRY, 'new', 'noop-check', 'myteam/demo-check'], {
      cwd: tmpDir,
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const exitCode = await proc.exited
    const stderr = await new Response(proc.stderr).text()

    expect(exitCode).toBe(2)
    expect(stderr).toContain('not a core check id')
    expect(existsSync(join(tmpDir, 'vinaya', 'checks'))).toBe(false)
  })

  it('refuses a missing argument with usage', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vinaya-new-noop-check-'))

    const proc = Bun.spawn(['bun', CLI_ENTRY, 'new', 'noop-check'], {
      cwd: tmpDir,
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const exitCode = await proc.exited
    const stderr = await new Response(proc.stderr).text()

    expect(exitCode).toBe(2)
    expect(stderr).toContain('Usage:')
  })
})
