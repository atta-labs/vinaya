import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

// Task `vinaya-adopter-portability-v1` 2 (Issue #232): `reader-resolvable-prose`
// and `retired-vocabulary` both defaulted an unconfigured `proseGates.doctrineRoot`
// to the bare literal `'aeg-root'`, resolved relative to the caller's cwd —
// permanently empty for every `vinaya init` adopter, none of whom ever gets a
// repo-relative `aeg-root/` (settled by experiment). The fix changes only the
// UNCONFIGURED default, via `resolveDoctrineRoot()` (`../commands/doctrine.js`
// — the same "package's own copy" resolution `vinaya doctrine` already uses).
// An explicit `proseGates.doctrineRoot` in `vinaya.config.json` must still win
// outright — this suite proves that priority holds.

const READER_BIN = join(import.meta.dir, '..', '..', 'src', 'checks', 'bin', 'check-reader-resolvable-prose.ts')
const RETIRED_BIN = join(import.meta.dir, '..', '..', 'src', 'checks', 'bin', 'check-retired-vocabulary.ts')
const INDEX_TS = join(import.meta.dir, '..', '..', 'src', 'index.ts')

function initFixture(name: string): string {
  const root = join(tmpdir(), `vinaya-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
  writeFileSync(join(root, 'README.md'), '# fixture\n')
  execFileSync('git', ['add', 'README.md'], { cwd: root })
  execFileSync('git', ['commit', '-q', '-m', 'Chore: initial commit'], { cwd: root })
  return root
}

describe('reader-resolvable-prose/retired-vocabulary doctrineRoot default — task vinaya-adopter-portability-v1 2', () => {
  it('both bins call resolveDoctrineRoot() as the unconfigured fallback, not a bare cwd-relative literal', () => {
    for (const bin of [READER_BIN, RETIRED_BIN]) {
      const source = readFileSync(bin, 'utf8')
      expect(source).toContain('resolveDoctrineRoot()')
      expect(source).not.toContain("proseGates?.doctrineRoot ?? 'aeg-root'")
      expect(source).not.toContain("loadConfig()?.proseGates?.doctrineRoot ?? 'aeg-root'")
    }
  })

  it('an explicit proseGates.doctrineRoot in vinaya.config.json still wins over resolveDoctrineRoot() — configured beats the package default', () => {
    const root = initFixture('prose-gates-config-wins')
    try {
      mkdirSync(join(root, 'configured-doctrine', 'roles'), { recursive: true })
      writeFileSync(
        join(root, 'configured-doctrine', 'glossary.md'),
        '## Glossary\n\n**Widget** — a fixture term, defined right here.\n'
      )
      writeFileSync(
        join(root, 'configured-doctrine', 'roles', 'x.md'),
        '---\nrole_id: x\n---\nThis page uses Widget correctly, since it is defined in the glossary.\n'
      )
      writeFileSync(
        join(root, 'vinaya.config.json'),
        JSON.stringify({ checks: {}, proseGates: { doctrineRoot: 'configured-doctrine' } }, null, 2)
      )
      execFileSync('git', ['add', '-A'], { cwd: root })
      execFileSync('git', ['commit', '-q', '-m', 'Chore: add fixture doctrine'], { cwd: root })

      const result = Bun.spawnSync(['bun', INDEX_TS, 'check', 'reader-resolvable-prose'], {
        cwd: root,
        env: { ...process.env, PR_BODY: undefined }
      })
      expect(result.exitCode).toBe(0)
      // Positive proof it read the CONFIGURED root, not the package default:
      // a finding (if any) would name a path under `configured-doctrine/`,
      // never this monorepo's own `aeg-root/`.
      expect(result.stderr.toString()).not.toContain('/aeg-root/')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
