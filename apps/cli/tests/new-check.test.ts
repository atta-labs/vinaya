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

describe('vinaya new check (scaffold round-trip)', () => {
  it('generates a check that runs through runChecks unmodified and emits a valid CheckError', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vinaya-new-check-'))

    const proc = Bun.spawn(['bun', CLI_ENTRY, 'new', 'check', 'myteam/demo-check'], {
      cwd: tmpDir,
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const exitCode = await proc.exited
    expect(exitCode).toBe(0)

    const generatedPath = join(tmpDir, 'scripts', 'vinaya-checks', 'demo-check.ts')
    expect(existsSync(generatedPath)).toBe(true)

    const spec: CheckSpec = { name: 'myteam/demo-check', run: generatedPath, scope: 'diff' }
    const [outcome] = await runChecks([spec], {
      parallel: 1,
      diffOnly: false,
      changedFiles: null,
      defaultTimeoutMs: 5000
    })

    expect(outcome?.status).toBe('fail')
    expect(outcome?.exitCode).toBe(1)
    expect(outcome?.errors).toHaveLength(1)
    expect(outcome?.errors[0]?.check).toBe('myteam/demo-check')
    expect(outcome?.errors[0]?.schema).toBe(1)
    expect(outcome?.errors[0]?.agent_recovery_prompt).toBeTruthy()
  })

  // The execution flip made a bare key fatal: `vinaya check` refuses its
  // ENTIRE run over a key the resolver cannot classify. A scaffolder that
  // can only emit bare names therefore hands every adopter a repo where
  // nothing runs — these two cases are that gap, closed.
  it('refuses a bare, un-namespaced name — the shape the flip made fatal', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vinaya-new-check-'))

    const proc = Bun.spawn(['bun', CLI_ENTRY, 'new', 'check', 'demo-check'], {
      cwd: tmpDir,
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const exitCode = await proc.exited
    const stderr = await new Response(proc.stderr).text()

    expect(exitCode).toBe(2)
    expect(stderr).toContain('<yourname>/<id>')
    expect(existsSync(join(tmpDir, 'scripts', 'vinaya-checks', 'demo-check.ts'))).toBe(false)
  })

  it('refuses a core check id rather than scaffolding a stub over a core gate', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vinaya-new-check-'))
    const coreName = coreCheckRegistry()[0]?.name as string

    const proc = Bun.spawn(['bun', CLI_ENTRY, 'new', 'check', coreName], {
      cwd: tmpDir,
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const exitCode = await proc.exited
    const stderr = await new Response(proc.stderr).text()

    expect(exitCode).toBe(2)
    expect(stderr).toContain('core check id')
    expect(stderr).toContain('REPLACES')
    expect(existsSync(join(tmpDir, 'scripts', 'vinaya-checks', `${coreName}.ts`))).toBe(false)
  })
})
