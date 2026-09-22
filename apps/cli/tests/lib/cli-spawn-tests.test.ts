// Issue #702, O1/O3 — a test that spawns the built CLI as a subprocess names
// no import of the code it exercises, so it was invisible to reachability
// regardless of what changed: a change to `apps/cli/src/lib/log-sink.ts`
// alone made `vinaya check --all` print a warning twenty-five times instead
// of once, a real regression this repository's own pre-push selection never
// had a chance to catch, caught only because CI runs everything.
//
// These are unit tests of the classifier itself (`cliSpawnEdgeOf`), in the
// same style `apps/cli/tests/lib/repo-scanner-tests.test.ts`-adjacent fixtures
// in `test-selector.test.ts` use for `scannedRootsOf`. How the selector
// consumes each outcome (the entrypoint's own `all:` edge, or the coarse
// `scan:` fallback) is proved separately in `test-selector.test.ts`.
import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cliSpawnEdgeOf } from '../../src/lib/cli-spawn-tests'
import { loadTypeScript } from '../../src/lib/ts-module-graph'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')

describe('cliSpawnEdgeOf classifies a test file’s own spawn shapes', () => {
  const ts = loadTypeScript(REPO_ROOT) as NonNullable<ReturnType<typeof loadTypeScript>>

  function fixture(testBody: string): { root: string; file: string; entrypoint: string } {
    const root = mkdtempSync(join(tmpdir(), 'vinaya-cli-spawn-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'tests'), { recursive: true })
    writeFileSync(join(root, 'src', 'index.ts'), 'export const noop = 1\n')
    const file = join(root, 'tests', 'spawn.test.ts')
    writeFileSync(file, testBody)
    return { root, file, entrypoint: join(root, 'src', 'index.ts') }
  }

  it('a direct Bun.spawn of `bun <entrypoint>` classifies as the precise entrypoint edge', () => {
    const { root, file, entrypoint } = fixture(
      [
        "import { join } from 'node:path'",
        "const INDEX = join(import.meta.dir, '..', 'src', 'index.ts')",
        "test('runs cli', () => Bun.spawn(['bun', INDEX, 'check'], { stdout: 'pipe' }))",
        ''
      ].join('\n')
    )
    try {
      expect(cliSpawnEdgeOf(ts, file, readFileSync(file, 'utf8'), root, entrypoint)).toBe('entrypoint')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("execFileSync('bun', [entrypoint, ...args]) — the shape most of the 58 identified tests use — is also precise", () => {
    const { root, file, entrypoint } = fixture(
      [
        "import { execFileSync } from 'node:child_process'",
        "import { dirname } from 'node:path'",
        "import { fileURLToPath } from 'node:url'",
        "import { join } from 'node:path'",
        "const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')",
        "const INDEX = join(CLI_ROOT, 'src', 'index.ts')",
        "const args = ['check', '--all']",
        "test('runs cli', () => execFileSync('bun', [INDEX, ...args], { encoding: 'utf8' }))",
        ''
      ].join('\n')
    )
    try {
      expect(cliSpawnEdgeOf(ts, file, readFileSync(file, 'utf8'), root, entrypoint)).toBe('entrypoint')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('an ordinary spawn of something else entirely (git) is neither precise nor a fallback — reachability is untouched', () => {
    const { root, file, entrypoint } = fixture(
      [
        "import { execFileSync } from 'node:child_process'",
        "test('git init', () => execFileSync('git', ['init', '-q'], { cwd: '/tmp' }))",
        ''
      ].join('\n')
    )
    try {
      expect(cliSpawnEdgeOf(ts, file, readFileSync(file, 'utf8'), root, entrypoint)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a computed argument list (`bun`, plus args built by a helper) still proves `bun` but not the entrypoint — falls back', () => {
    const { root, file, entrypoint } = fixture(
      [
        "function pickArgs() { return ['check', '--all'] }",
        "test('runs cli', () => Bun.spawn(['bun', ...pickArgs()], { stdout: 'pipe' }))",
        ''
      ].join('\n')
    )
    try {
      expect(cliSpawnEdgeOf(ts, file, readFileSync(file, 'utf8'), root, entrypoint)).toBe('fallback')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('the entrypoint threaded through an indirect wrapper’s own parameter — not a module-level binding — falls back', () => {
    const { root, file, entrypoint } = fixture(
      [
        "import { execFileSync } from 'node:child_process'",
        "import { join } from 'node:path'",
        "const INDEX = join(import.meta.dir, '..', 'src', 'index.ts')",
        "function runCli(entry) { return execFileSync('bun', [entry], { encoding: 'utf8' }) }",
        "test('runs cli', () => runCli(INDEX))",
        ''
      ].join('\n')
    )
    try {
      // `INDEX` resolves at module scope, but the call that actually spawns
      // (`execFileSync` inside `runCli`) sees only its own parameter `entry` —
      // invisible to a top-level-only static read, the same conservative limit
      // `repo-scanner-tests.ts`'s own evaluator has always had.
      expect(cliSpawnEdgeOf(ts, file, readFileSync(file, 'utf8'), root, entrypoint)).toBe('fallback')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('the entrypoint spawned through a different binary (never proven `bun`) falls back, not to silence', () => {
    const { root, file, entrypoint } = fixture(
      [
        "import { execFileSync } from 'node:child_process'",
        "import { join } from 'node:path'",
        "const INDEX = join(import.meta.dir, '..', 'src', 'index.ts')",
        "test('runs via node', () => execFileSync('node', [INDEX, 'check'], { encoding: 'utf8' }))",
        ''
      ].join('\n')
    )
    try {
      expect(cliSpawnEdgeOf(ts, file, readFileSync(file, 'utf8'), root, entrypoint)).toBe('fallback')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
