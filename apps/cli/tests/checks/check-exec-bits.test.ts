import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'bun:test'

/**
 * `exec-bits` against real git repositories, because the fact it reads —
 * the INDEX mode — has no meaningful stub. A working tree can carry the
 * exec bit correctly while the index carries it wrong, which is precisely
 * the failure this check exists to catch, so a fixture that does not have a
 * real index would test the wrong thing.
 */

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'checks', 'bin', 'check-exec-bits.ts')

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'] })
}

/**
 * A repo with one base commit on `main` and a second commit on top adding
 * `relPath` at `mode`. The base commit is what `resolveChangedFiles` diffs
 * against, so the added file is genuinely "in this diff".
 */
function repoStaging(relPath: string, mode: '100644' | '100755', content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'exec-bits-'))
  tempDirs.push(dir)
  git(dir, ['init', '--initial-branch=main'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  writeFileSync(join(dir, 'README.md'), '# base\n')
  git(dir, ['add', 'README.md'])
  git(dir, ['commit', '-m', 'base'])

  const abs = join(dir, relPath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
  if (mode === '100755') chmodSync(abs, 0o755)
  git(dir, ['add', relPath])
  if (mode === '100755') git(dir, ['update-index', '--chmod=+x', relPath])
  else git(dir, ['update-index', '--chmod=-x', relPath])
  git(dir, ['commit', '-m', 'add file'])
  return dir
}

function run(cwd: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('bun', [BIN], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BASE_SHA: 'main~1' }
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

describe('exec-bits — a checks/bin/ path', () => {
  it('fails naming the file when it is staged 100644', () => {
    const dir = repoStaging('apps/cli/src/checks/bin/check-x.ts', '100644', '#!/usr/bin/env bun\nconsole.log(1)\n')
    const result = run(dir)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('check-x.ts')
    expect(result.stderr).toContain('100644')
    expect(result.stderr).toContain('git update-index --chmod=+x')
  })

  it('passes when it is staged 100755', () => {
    const dir = repoStaging('apps/cli/src/checks/bin/check-x.ts', '100755', '#!/usr/bin/env bun\nconsole.log(1)\n')
    const result = run(dir)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('0 not 100755')
  })
})

describe('exec-bits — the shebang signal, independent of path', () => {
  it('catches a staged script with a shebang outside any checks/bin/ directory', () => {
    const dir = repoStaging('scripts/release.sh', '100644', '#!/bin/sh\necho hi\n')
    const result = run(dir)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('scripts/release.sh')
  })

  it('ignores an ordinary file with neither signal', () => {
    const dir = repoStaging('docs/notes.md', '100644', '# notes\n')
    const result = run(dir)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('0 executable file(s) judged')
  })
})

describe('exec-bits — this repo, the check running over its own corpus', () => {
  it("agrees with git that every one of this repo's own check bins is 100755", () => {
    const out = execFileSync('git', ['ls-files', '-s', 'apps/cli/src/checks/bin'], {
      cwd: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'),
      encoding: 'utf8'
    })
    const notExecutable = out
      .split('\n')
      .filter((l) => l.trim() !== '')
      .filter((l) => !l.startsWith('100755'))
    expect(notExecutable).toEqual([])
  })
})
