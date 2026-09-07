import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * O2: no file other than `apps/cli/src/lib/log-sink.ts` performs the
 * outbox append, and no file other than the named chokepoints calls
 * `log()`. Both are proved by walking the real source tree — a passing
 * assertion here is a fact about the tree, not a belief about it.
 *
 * Amended by task 2 (#405): `vinaya log flush` (`apps/cli/src/commands/log.ts`)
 * is the first real caller of either — it logs its own `forge_write` line
 * through `log()`, and it is the one file besides the sink allowed to touch
 * the outbox path directly, since truncation is a lifecycle half `log()`
 * itself never performs.
 *
 * Amended by task 3 (#406): `dispatchRole` (`apps/cli/src/lib/dispatch.ts`) —
 * NOT `dispatch-role.ts`, the earlier forward-looking guess this file's own
 * `FUTURE_CALLER_ALLOWLIST` once carried; the real Surface Map named
 * `dispatch.ts` — is the second real caller. It only reads the outbox (to
 * poll for its own lines actually landing before returning), never appends
 * or truncates, so it is not added to `OUTBOX_TRUNCATE_ALLOWLIST`.
 *
 * Amended by task 5 (#415): `devReviewLoop` (`apps/cli/src/lib/dev-review-loop.ts`)
 * is the third real caller, moved out of `FUTURE_CALLER_ALLOWLIST` now that
 * it exists. It reads the outbox the same way `dispatch.ts` does (polling
 * for its own log lines), and it separately WRITES under the outbox root —
 * but never the ndjson log file itself: `writeHeldVerdict` writes one
 * `<outboxRoot>/dev-review-loop/<task>/round-<n>-<role>.md` file per held
 * reviewer verdict, a third category next to log-sink's append and flush's
 * truncate. `OUTBOX_HELD_VERDICT_ALLOWLIST` names this explicitly rather
 * than silently widening `OUTBOX_TRUNCATE_ALLOWLIST` to cover a write it
 * does not describe.
 */

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')
const SINK_PATH = 'apps/cli/src/lib/log-sink.ts'
const FLUSH_PATH = 'apps/cli/src/commands/log.ts'
const DISPATCH_PATH = 'apps/cli/src/lib/dispatch.ts'
const DEV_REVIEW_LOOP_PATH = 'apps/cli/src/lib/dev-review-loop.ts'
const FUTURE_CALLER_ALLOWLIST = new Set<string>([])
const CALLER_ALLOWLIST = new Set([...FUTURE_CALLER_ALLOWLIST, FLUSH_PATH, DISPATCH_PATH, DEV_REVIEW_LOOP_PATH])
const OUTBOX_TRUNCATE_ALLOWLIST = new Set([FLUSH_PATH])
const OUTBOX_HELD_VERDICT_ALLOWLIST = new Set([DEV_REVIEW_LOOP_PATH])

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

  it('no file other than the sink (or the flush, or the held-verdict writer) references the outbox alongside a write call', () => {
    const offenders = files
      .filter(
        ([rel]) => rel !== SINK_PATH && !OUTBOX_TRUNCATE_ALLOWLIST.has(rel) && !OUTBOX_HELD_VERDICT_ALLOWLIST.has(rel)
      )
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

  it('the still-future allowlist entries name no file that exists yet — those chokepoints land in a later task', () => {
    const existing = files.map(([rel]) => rel)
    for (const allowed of FUTURE_CALLER_ALLOWLIST) {
      expect(existing).not.toContain(allowed)
    }
  })

  it('the flush allowlist entry does exist — task 2 is the landed caller, not a future one', () => {
    const existing = files.map(([rel]) => rel)
    expect(existing).toContain(FLUSH_PATH)
  })

  it('the dispatch allowlist entry does exist — task 3 is the landed caller, not a future one', () => {
    const existing = files.map(([rel]) => rel)
    expect(existing).toContain(DISPATCH_PATH)
  })

  it('the dev-review-loop allowlist entry does exist — task 5 is the landed caller, not a future one', () => {
    const existing = files.map(([rel]) => rel)
    expect(existing).toContain(DEV_REVIEW_LOOP_PATH)
  })
})
