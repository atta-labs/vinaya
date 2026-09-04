import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isTestFile } from '../../src/checks/bin/check-workspace-escape'
import type { CheckError } from '../../src/checks/contract'

// O2 (found live 2026-09-04): `*.test.ts`/`*.test.tsx` files are excluded
// from the swept surface entirely, silencing both this repo's own known
// false positive (`workspace-escape.test.ts`'s fixture `content:` strings,
// read as code by a text-scanning check that cannot tell a string literal
// from a real call site — see that file's own "KNOWN BLIND SPOT" doc) and
// `commands-router-coverage.test.ts`'s real cross-package reference, which
// this bin's own prior comment called a genuine finding. See this bin's
// module doc for why both are accepted as report-only noise now, not just
// the false positive.

const BIN = join(import.meta.dir, '..', '..', 'src', 'checks', 'bin', 'check-workspace-escape.ts')

let roots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** `realpathSync` — macOS's tmpdir is a symlink, and `git rev-parse --show-toplevel` resolves it. */
function newRoot(name: string): string {
  const raw = join(tmpdir(), `vinaya-workspace-escape-bin-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(raw, { recursive: true })
  const root = realpathSync(raw)
  roots.push(root)
  return root
}

function initRepo(root: string): void {
  git(root, ['init', '-q', '-b', 'main'])
  git(root, ['config', 'user.email', 'test@example.com'])
  git(root, ['config', 'user.name', 'Test'])
}

async function runBin(cwd: string): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn(['bun', BIN], { cwd, stdout: 'pipe', stderr: 'pipe', env: process.env })
  const exitCode = await proc.exited
  const stderr = await new Response(proc.stderr).text()
  const stdout = await new Response(proc.stdout).text()
  return { exitCode, stderr, stdout }
}

function parseFindings(stderr: string): CheckError[] {
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CheckError)
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

describe('isTestFile', () => {
  it('matches .test.ts and .test.tsx', () => {
    expect(isTestFile('packages/aeg-core/src/workspace-escape.test.ts')).toBe(true)
    expect(isTestFile('apps/cli/src/foo.test.tsx')).toBe(true)
  })

  it('does not match ordinary source files, including ones containing "test" in the name', () => {
    expect(isTestFile('apps/cli/src/checks/bin/check-workspace-escape.ts')).toBe(false)
    expect(isTestFile('packages/aeg-core/src/testing-utils.ts')).toBe(false)
  })
})

describe('check-workspace-escape (bin) — test files excluded from the swept surface (O2)', () => {
  it('a real escape in an ordinary .ts file is still reported', async () => {
    const root = newRoot('real-escape')
    initRepo(root)
    mkdirSync(join(root, 'packages', 'a', 'src'), { recursive: true })
    mkdirSync(join(root, 'packages', 'b', 'src'), { recursive: true })
    writeFileSync(join(root, 'packages', 'b', 'src', 'index.ts'), 'export const x = 1\n')
    writeFileSync(join(root, 'packages', 'a', 'src', 'reader.ts'), "readFileSync('../../b/src/index.ts', 'utf8')\n")
    git(root, ['add', '.'])
    git(root, ['commit', '-q', '-m', 'Chore: fixture'])

    const { exitCode, stderr } = await runBin(root)
    expect(exitCode).toBe(0)
    const findings = parseFindings(stderr)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.file).toBe('packages/a/src/reader.ts')
  })

  it('the identical escaping reference inside a .test.ts file is silent', async () => {
    const root = newRoot('test-file-escape')
    initRepo(root)
    mkdirSync(join(root, 'packages', 'a', 'src'), { recursive: true })
    mkdirSync(join(root, 'packages', 'b', 'src'), { recursive: true })
    writeFileSync(join(root, 'packages', 'b', 'src', 'index.ts'), 'export const x = 1\n')
    writeFileSync(
      join(root, 'packages', 'a', 'src', 'reader.test.ts'),
      "readFileSync('../../b/src/index.ts', 'utf8')\n"
    )
    git(root, ['add', '.'])
    git(root, ['commit', '-q', '-m', 'Chore: fixture'])

    const { exitCode, stderr } = await runBin(root)
    expect(exitCode).toBe(0)
    expect(parseFindings(stderr)).toHaveLength(0)
  })
})
