// The evaluation harness is internal: no file outside the harness itself and
// the tests imports it, so nothing of it ships through the CLI. Imports are
// read by the TypeScript compiler's own pre-processor (static imports,
// re-exports, `import()` and `require`), not by a text pattern.
import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const HARNESS_DIR = join(REPO_ROOT, 'apps', 'cli', 'src', 'lib', 'dev-review-eval')
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

/** A test file, or any file under a `tests` directory. */
function isTest(path: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(path) || relative(REPO_ROOT, path).split(sep).includes('tests')
}

/** True when `file` imports, re-exports or loads any module inside the harness directory. */
function importsHarness(file: string): boolean {
  const info = ts.preProcessFile(readFileSync(file, 'utf8'), true, true)
  return info.importedFiles.some(({ fileName }) => {
    if (fileName.includes('dev-review-eval')) return true
    if (!fileName.startsWith('.')) return false
    return isInside(resolve(dirname(file), fileName), HARNESS_DIR)
  })
}

describe('the evaluation harness is not shipped', () => {
  const files = sourceFiles(REPO_ROOT)

  it('no file outside the harness and the tests imports the harness', () => {
    const offenders = files
      .filter((file) => !isInside(file, HARNESS_DIR) && !isTest(file))
      .filter(importsHarness)
      .map((file) => relative(REPO_ROOT, file))
    expect(offenders).toEqual([])
  })

  it('the scan sees the harness tests import it — the check above is not vacuous', () => {
    const importers = files.filter(importsHarness).map((file) => relative(REPO_ROOT, file))
    expect(importers).toContain(join('apps', 'cli', 'tests', 'eval', 'contracts.test.ts'))
    expect(importers).toContain(join('apps', 'cli', 'tests', 'eval', 'estimators.test.ts'))
    expect(files.some((file) => file === join(REPO_ROOT, 'apps', 'cli', 'src', 'index.ts'))).toBe(true)
  })
})
