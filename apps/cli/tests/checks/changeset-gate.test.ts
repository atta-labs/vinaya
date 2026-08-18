import { afterAll, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The `changeset` gate's refusal cases, each one a defect a security pass
 * measured at a previous head of this branch (all three exited 0):
 *
 *   - an unresolvable base passed the gate instead of refusing on no evidence
 *   - deleting or modifying someone ELSE'S queued entry scored as compliance,
 *     harming the release while clearing the gate
 *   - deleting `.changeset/config.json` silenced the gate for that same diff
 */
const BIN = join(import.meta.dir, '../../src/checks/bin/check-changeset.ts')
const DIRS: string[] = []

afterAll(() => {
  for (const d of DIRS) rmSync(d, { recursive: true, force: true })
})

function sh(cwd: string, cmd: string, args: string[]): void {
  execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
}

/** A repo with a queued entry from someone else, and a shipped-source edit on `work`. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'changeset-gate-'))
  DIRS.push(dir)
  sh(dir, 'git', ['init', '-q', '-b', 'main'])
  sh(dir, 'git', ['config', 'user.email', 't@example.com'])
  sh(dir, 'git', ['config', 'user.name', 'test'])
  mkdirSync(join(dir, 'apps/cli/src'), { recursive: true })
  mkdirSync(join(dir, '.changeset'), { recursive: true })
  writeFileSync(join(dir, '.changeset/config.json'), '{}\n')
  writeFileSync(join(dir, '.changeset/other-persons-entry.md'), '---\n"pkg": patch\n---\nqueued by someone else\n')
  writeFileSync(join(dir, 'apps/cli/src/x.ts'), 'export const a = 1\n')
  sh(dir, 'git', ['add', '-A'])
  sh(dir, 'git', ['commit', '-qm', 'base'])
  sh(dir, 'git', ['checkout', '-qb', 'work'])
  writeFileSync(join(dir, 'apps/cli/src/x.ts'), 'export const a = 2\n')
  sh(dir, 'git', ['add', '-A'])
  sh(dir, 'git', ['commit', '-qm', 'ship'])
  return dir
}

async function run(dir: string, base = 'main'): Promise<number> {
  const proc = Bun.spawn(['bun', BIN], {
    cwd: dir,
    env: { ...process.env, BASE_SHA: base },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  return await proc.exited
}

describe('the changeset gate refuses rather than fails open', () => {
  it('refuses a shipped-source diff that adds no entry', async () => {
    expect(await run(repo())).toBe(1)
  })

  it('passes when the diff adds its OWN entry', async () => {
    const dir = repo()
    writeFileSync(join(dir, '.changeset/mine.md'), '---\n"pkg": patch\n---\nmine\n')
    sh(dir, 'git', ['add', '-A'])
    sh(dir, 'git', ['commit', '-qm', 'add own'])
    expect(await run(dir)).toBe(0)
  })

  it("refuses when the diff DELETES someone else's queued entry", async () => {
    const dir = repo()
    sh(dir, 'git', ['rm', '-q', '.changeset/other-persons-entry.md'])
    sh(dir, 'git', ['commit', '-qm', "delete other's"])
    expect(await run(dir)).toBe(1)
  })

  it("refuses when the diff MODIFIES someone else's queued entry", async () => {
    const dir = repo()
    writeFileSync(join(dir, '.changeset/other-persons-entry.md'), '---\n"pkg": patch\n---\nedited\n')
    sh(dir, 'git', ['add', '-A'])
    sh(dir, 'git', ['commit', '-qm', "touch other's"])
    expect(await run(dir)).toBe(1)
  })

  it('refuses when the diff deletes .changeset/config.json, rather than silencing itself', async () => {
    const dir = repo()
    sh(dir, 'git', ['rm', '-q', '.changeset/config.json'])
    sh(dir, 'git', ['commit', '-qm', 'kill config'])
    expect(await run(dir)).toBe(1)
  })

  it('refuses when no base ref resolves, rather than passing on no evidence', async () => {
    expect(await run(repo(), 'origin/does-not-exist')).toBe(1)
  })
})
