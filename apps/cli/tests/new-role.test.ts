import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateRoleContract } from '../src/roles/contract'
import { resolveRoles } from '../src/roles/resolver'

const CLI_ENTRY = join(import.meta.dir, '..', 'src', 'index.ts')

let tmpDir: string | undefined

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = undefined
  }
})

describe('vinaya new role (scaffold round-trip)', () => {
  it('generates an additive role contract that resolves cleanly against resolveRoles', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vinaya-new-role-'))

    const proc = Bun.spawn(['bun', CLI_ENTRY, 'new', 'role', 'acme/qa-lead'], {
      cwd: tmpDir,
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    expect(exitCode).toBe(0)

    const generatedPath = join(tmpDir, 'vinaya', 'roles', 'qa-lead.md')
    expect(existsSync(generatedPath)).toBe(true)
    expect(stdout).toContain('"contract": "./vinaya/roles/qa-lead.md"')

    const validation = validateRoleContract(readFileSync(generatedPath, 'utf-8'))
    expect(validation.ok).toBe(true)
    if (!validation.ok) return
    expect(validation.contract.roleId).toBe('qa-lead')
    expect(validation.contract.title.length).toBeGreaterThan(0)
    expect(typeof validation.contract.order).toBe('number')

    // The scaffold must resolve as ADDITIVE, not just parse — task 6's real
    // contract, not a copy of it.
    const result = resolveRoles([], { 'acme/qa-lead': { key: 'acme/qa-lead', validation } })
    expect(result.failures).toEqual([])
    const additive = result.resolved.find((r) => r.name === 'acme/qa-lead')
    expect(additive?.state).toBe('additive')
    expect(additive?.renderId).toBe('qa-lead')
    expect(additive?.inertToGating).toBe(true)
  })

  // A bare key resolves as an OVERRIDE of a core role (`../src/roles/resolver.ts`)
  // — a complete replacement of that role's contract. Scaffolding a stub for
  // that shape is a real governance decision this command does not make.
  it('refuses a bare, un-namespaced key rather than scaffolding an override', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vinaya-new-role-'))

    const proc = Bun.spawn(['bun', CLI_ENTRY, 'new', 'role', 'developer'], {
      cwd: tmpDir,
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const exitCode = await proc.exited
    const stderr = await new Response(proc.stderr).text()

    expect(exitCode).toBe(2)
    expect(stderr).toContain('OVERRIDE')
    expect(existsSync(join(tmpDir, 'vinaya', 'roles', 'developer.md'))).toBe(false)
  })

  it('refuses a missing argument with usage', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vinaya-new-role-'))

    const proc = Bun.spawn(['bun', CLI_ENTRY, 'new', 'role'], {
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
