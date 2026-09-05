import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * O2: no file other than `apps/cli/src/lib/log-sink.ts` performs the
 * outbox append, and no file other than the two named chokepoints calls
 * `log()`. Both are proved by walking the real source tree — a passing
 * assertion here is a fact about the tree, not a belief about it.
 */

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')
const SINK_PATH = 'apps/cli/src/lib/log-sink.ts'
const CALLER_ALLOWLIST = new Set(['apps/cli/src/lib/dispatch-role.ts', 'apps/cli/src/lib/dev-review-loop.ts'])

function sourceFiles(dir: string, prefix: string): [string, string][] {
  const out: [string, string][] = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const abs = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.turbo') continue
    if (entry.isDirectory()) {
      out.push(...sourceFiles(abs, rel))
      continue
    }
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue
    out.push([rel, abs])
  }
  return out
}

/** Every non-test `.ts`/`.tsx` file under `apps/cli/src` and each `packages/<name>/src`, repo-relative. */
function allSourceFiles(): [string, string][] {
  const out: [string, string][] = [...sourceFiles(join(REPO_ROOT, 'apps/cli/src'), 'apps/cli/src')]
  const packagesDir = join(REPO_ROOT, 'packages')
  for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue
    out.push(...sourceFiles(join(packagesDir, pkg.name, 'src'), `packages/${pkg.name}/src`))
  }
  return out
}

const OUTBOX_WRITE_CALLS = ['openSync', 'appendFileSync', 'writeFileSync']

describe('log-callers — O2', () => {
  const files = allSourceFiles()
  expect(files.length).toBeGreaterThan(0)

  it('no file other than the sink references the outbox alongside a write call', () => {
    const offenders = files
      .filter(([rel]) => rel !== SINK_PATH)
      .filter(([, abs]) => {
        const content = readFileSync(abs, 'utf8')
        return content.includes('outbox') && OUTBOX_WRITE_CALLS.some((call) => content.includes(call))
      })
      .map(([rel]) => rel)
    expect(offenders).toEqual([])
  })

  it('the sink itself really does perform the outbox append — the negative check above is not vacuous', () => {
    const sinkAbs = files.find(([rel]) => rel === SINK_PATH)?.[1]
    expect(sinkAbs, `${SINK_PATH} not found by the scan — fix the walker, not this assertion`).toBeDefined()
    const content = readFileSync(sinkAbs as string, 'utf8')
    expect(content.includes('outbox')).toBe(true)
    expect(OUTBOX_WRITE_CALLS.some((call) => content.includes(call))).toBe(true)
  })

  it('log() from log-sink is imported by no file outside the allowlist', () => {
    const importPattern = /from\s+['"][^'"]*\/log-sink(?:\.js)?['"]/
    const offenders = files
      .filter(([rel]) => rel !== SINK_PATH)
      .filter(([, abs]) => importPattern.test(readFileSync(abs, 'utf8')))
      .map(([rel]) => rel)
      .filter((rel) => !CALLER_ALLOWLIST.has(rel))
    expect(offenders).toEqual([])
  })

  it('the allowlist itself names no file that exists yet — both chokepoints land in a later task', () => {
    const existing = files.map(([rel]) => rel)
    for (const allowed of CALLER_ALLOWLIST) {
      expect(existing).not.toContain(allowed)
    }
  })
})
