// The evaluation harness is internal: no file outside the harness itself and
// the tests imports it, so nothing of it ships through the CLI. Imports are
// read by the TypeScript compiler's own pre-processor (static imports,
// re-exports, `import()` and `require`), not by a text pattern.
import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { importedPaths } from './not-shipped-imports.js'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..', '..')
const HARNESS_DIRS = [
  join(REPO_ROOT, 'harness', 'kernel', 'evals'),
  join(REPO_ROOT, 'harness', 'processes', 'vinaya-strict', 'evals')
]
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.git', '.worktrees', '.turbo', 'coverage'])
const SOURCE = /\.(?:[cm]?[jt]sx?)$/

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) out.push(...sourceFiles(join(dir, entry.name)))
    } else if (SOURCE.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(join(dir, entry.name))
    }
  }
  return out
}

function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir + sep)
}

/** Whether `path` lies in the harness: the kernel's evaluation folder, the process's, or a role's `evals` folder. */
function inHarness(path: string): boolean {
  if (HARNESS_DIRS.some((dir) => isInside(path, dir))) return true
  const parts = relative(REPO_ROOT, path).split(sep)
  return parts[0] === 'harness' && parts.includes('evals')
}

/** A test file, or any file under a `tests` directory. */
function isTest(path: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(path) || relative(REPO_ROOT, path).split(sep).includes('tests')
}

/** True when `file` imports, re-exports or loads any module inside the harness directory. */
function importsHarness(file: string): boolean {
  return importedPaths(file, REPO_ROOT).some(inHarness)
}

describe('the evaluation harness is not shipped', () => {
  const files = sourceFiles(REPO_ROOT)

  it('no file outside the harness and the tests imports the harness', () => {
    const offenders = files
      .filter((file) => !inHarness(file) && !isTest(file))
      .filter(importsHarness)
      .map((file) => relative(REPO_ROOT, file))
    expect(offenders).toEqual([])
  })

  it('sees an aliased import of the harness, as it sees a relative one', () => {
    const root = mkdtempSync(join(tmpdir(), 'not-shipped-alias-'))
    try {
      mkdirSync(join(root, 'packages/typescript-config'), { recursive: true })
      writeFileSync(
        join(root, 'packages/typescript-config/base.json'),
        JSON.stringify({ compilerOptions: { paths: { '@harness/kernel/*': ['../../harness/kernel/*'] } } })
      )
      mkdirSync(join(root, 'apps/cli/src'), { recursive: true })
      const aliased = join(root, 'apps/cli/src/aliased.ts')
      writeFileSync(
        aliased,
        "import { estimate } from '@harness/kernel/evals/estimators.js'\nexport const x = estimate\n"
      )
      const relativeImport = join(root, 'apps/cli/src/relative.ts')
      writeFileSync(
        relativeImport,
        "import { estimate } from '../../../harness/kernel/evals/estimators.js'\nexport const x = estimate\n"
      )
      const expected = join(root, 'harness/kernel/evals/estimators.js')
      expect(importedPaths(aliased, root)).toEqual([expected])
      expect(importedPaths(relativeImport, root)).toEqual([expected])
      // A repository with no base config reads exactly as before: the aliased specifier names no path.
      rmSync(join(root, 'packages'), { recursive: true })
      expect(importedPaths(aliased, root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('the scan sees the harness tests import it — the check above is not vacuous', () => {
    const importers = files.filter(importsHarness).map((file) => relative(REPO_ROOT, file))
    expect(importers).toContain(join('harness', 'processes', 'vinaya-strict', 'evals', 'suites', 'contracts.test.ts'))
    expect(importers).toContain(join('harness', 'kernel', 'evals', 'estimators.test.ts'))
    expect(files.some((file) => file === join(REPO_ROOT, 'apps', 'cli', 'src', 'index.ts'))).toBe(true)
  })
})
