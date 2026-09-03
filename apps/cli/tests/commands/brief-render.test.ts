import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { expandGlob, packageNameForPath, sha256OfFile } from '../../src/commands/brief.js'

/**
 * `vinaya brief render` — the local, network-free surface only. Full
 * end-to-end coverage (a real task Issue, dispatch-gate facts) would need a
 * live forge or an HTTP-level GraphQL mock; `createForgeSource`/
 * `fetchForgeFacts`/`fetchOpenIssuesByLabel` go straight to `@octokit/graphql`
 * over HTTP, not through a stubbable `gh` binary the way most other CLI
 * command tests fake the forge — same discipline
 * `apps/cli/tests/checks/branch-topology.test.ts` documents for the same
 * reason: exercise the pure/local pieces directly rather than a live network
 * call. The pure renderer itself (`renderBrief`/`parseRationaleFields`) is
 * covered exhaustively in `packages/aeg-core/src/brief-render.test.ts`.
 */

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPO_ROOT = join(CLI_ROOT, '..', '..')
const INDEX = join(CLI_ROOT, 'src', 'index.ts')

type CliResult = { status: number; stdout: string; stderr: string }

function runCli(args: string[]): CliResult {
  try {
    const stdout = execFileSync('bun', [INDEX, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

describe('vinaya brief render — usage refusals (no network reached)', () => {
  it('refuses with no tranche/task id', () => {
    const result = runCli(['brief', 'render'])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('Usage: vinaya brief render')
  })

  it('refuses with no --surfaces', () => {
    const result = runCli(['brief', 'render', 'some-tranche', '1'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('--surfaces')
  })

  it('refuses on an unknown brief subcommand', () => {
    const result = runCli(['brief', 'bogus'])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("Unknown 'brief' subcommand")
  })
})

describe('brief.ts local helpers — repo-root-relative', () => {
  // `expandGlob`/`packageNameForPath` build paths relative to `process.cwd()`
  // (the real command runs with cwd already at the repo root — Step 0's own
  // convention). `bun test` here runs with cwd at `apps/cli`, so this block
  // chdir's to the repo root for its own duration only.
  const originalCwd = process.cwd()
  beforeAll(() => process.chdir(REPO_ROOT))
  afterAll(() => process.chdir(originalCwd))

  it('expandGlob expands a real tracked file via git ls-files', () => {
    const matches = expandGlob('packages/aeg-core/src/brief-render.ts')
    expect(matches).toEqual(['packages/aeg-core/src/brief-render.ts'])
  })

  it('expandGlob resolves to an empty list for a glob matching no tracked file — the caller names the glob in its own refusal', () => {
    expect(expandGlob('packages/aeg-core/src/this-file-does-not-exist-anywhere.ts')).toEqual([])
  })

  it("packageNameForPath resolves a packages/<pkg> path to that workspace member's own package.json name", () => {
    expect(packageNameForPath('packages/aeg-core/src/brief-render.ts')).toBe('@attalabs/aeg-core')
  })

  it("packageNameForPath resolves an apps/<app> path to that workspace member's own package.json name", () => {
    expect(packageNameForPath('apps/cli/src/index.ts')).toBe('@attalabs/vinaya')
  })

  it('packageNameForPath resolves null for a path outside every workspace member', () => {
    expect(packageNameForPath('aeg-root/roles/developer.md')).toBeNull()
  })
})

describe('sha256OfFile', () => {
  it('is a 64-char lowercase hex digest, stable across two reads of the same file', () => {
    const path = join(REPO_ROOT, 'packages/aeg-core/src/brief-render.ts')
    const first = sha256OfFile(path)
    const second = sha256OfFile(path)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(first).toBe(second)
  })
})
