/**
 * Issue #660, O3, round 5 Principal ruling — "O3 becomes a check, and this
 * round closes it": four rounds of the reviewer naming individual sibling
 * fixtures by hand never converged (ninety-two test files under
 * `apps/cli/tests` start a real process). Rather than a fifth round of the
 * same, this file makes O3 mechanical: it walks the real tree, finds every
 * file that still spawns a real process WITHOUT going through the shared
 * `lib/process-fixture.ts` helper (or carrying that helper's own two-halves
 * pattern — VINAYA_* env stripping plus an explicit kill-and-diagnose
 * budget — inline), and requires every one of them to be named, by path, on
 * `GRANDFATHERED_FILES` below.
 *
 * The list is data, not a waiver — it fails in every direction the ruling
 * names:
 *   - a NEW non-compliant file (not yet on the list) fails the build — the
 *     list can never grow silently;
 *   - a LISTED file that has since been migrated to the shared helper (or
 *     otherwise hardened inline) fails the build too — a stale grandfather
 *     entry is exactly as wrong as a missing one, since it would let a
 *     REGRESSION on that file hide behind an entry that no longer describes
 *     it;
 *   - a file that regresses back to a raw spawn call after being migrated
 *     re-appears as a new offender, caught by the first case.
 *
 * Burning this list down is a later task, not this round's — see the
 * changeset for this round's own count.
 */

import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
const TESTS_ROOT = join(REPO_ROOT, 'apps/cli/tests')
const HELPER_PATH = 'apps/cli/tests/lib/process-fixture.ts'

function walk(dir: string, prefix: string): [string, string][] {
  const out: [string, string][] = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const abs = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.turbo') continue
    if (entry.isDirectory()) {
      out.push(...walk(abs, rel))
      continue
    }
    if (!/\.tsx?$/.test(entry.name)) continue
    out.push([rel, abs])
  }
  return out
}

/** Every `.ts`/`.tsx` file under `apps/cli/tests`, repo-relative, the helper itself excluded. */
function allTestTreeFiles(): [string, string][] {
  return walk(TESTS_ROOT, 'apps/cli/tests').filter(([rel]) => rel !== HELPER_PATH)
}

/** A real call, never a doc comment or a regex literal merely describing the shape (best-effort — a false positive just means an extra grandfather entry, never a missed one). */
const SPAWNS_REAL_PROCESS = /\b(?:spawnSync|execFileSync|fork|spawn)\s*\(|Bun\.spawn(?:Sync)?\s*\(/

/** `lib/process-fixture.ts`'s own `stripVinayaEnv` — imported, or reimplemented inline. */
const HAS_VINAYA_ENV_STRIP = /startsWith\(\s*['"]VINAYA_['"]\s*\)|stripVinayaEnv/

/** An explicit kill-on-timeout budget — `lib/process-fixture.ts`'s own `spawnSyncBudgeted`, or the same discipline reimplemented inline. */
const HAS_KILL_BUDGET = /killSignal|SIGKILL/

function importsSharedHelper(content: string): boolean {
  return /from\s+['"][^'"]*\/lib\/process-fixture(?:\.js)?['"]|from\s+['"]\.\/process-fixture(?:\.js)?['"]/.test(
    content
  )
}

/**
 * A file is compliant with O3 when it spawns no real process at all, OR it
 * goes through the shared helper (an import), OR it carries both halves of
 * the helper's own pattern inline (env-strip AND kill-budget) — the shape
 * every file the earlier rounds hardened by hand already has.
 */
function isNonCompliant(content: string): boolean {
  if (!SPAWNS_REAL_PROCESS.test(content)) return false
  if (importsSharedHelper(content)) return false
  return !(HAS_VINAYA_ENV_STRIP.test(content) && HAS_KILL_BUDGET.test(content))
}

/**
 * Round 5's own fix: the two build spawns (`package-root.test.ts`,
 * `commands/check-json-pipe.test.ts`) and the log-flush sibling group
 * (`lib/log-flush.test.ts`, `lib/log-webhook-flush.test.ts`,
 * `commands/log-flush.test.ts`) now go through `lib/process-fixture.ts`
 * directly and are NOT on this list — proven by the negative assertion
 * below, so a regression on any of them is caught as a new offender rather
 * than silently re-covered by a stale entry.
 *
 * Every other file below still spawns a real process (`git`, `gh`, `ln`,
 * `chmod`, a fake vendor binary, or the `vinaya` CLI itself for a command
 * that never touches the runtime-dir/driver-lock/control-store surface the
 * original incident was about) without the shared helper's pattern. Found
 * by search — `bun apps/cli/tests/process-fixture-coverage.test.ts`'s own
 * scan — never by memory, per round 3's ruling.
 */
const GRANDFATHERED_FILES: readonly string[] = [
  'apps/cli/tests/checks/bin-permissions.test.ts',
  'apps/cli/tests/checks/body-bare-digits-changeset-exempt.test.ts',
  'apps/cli/tests/checks/branch-topology.test.ts',
  'apps/cli/tests/checks/changeset-coverage-bin.test.ts',
  'apps/cli/tests/checks/check-dispatch-readiness-premise.test.ts',
  'apps/cli/tests/checks/check-exec-bits.test.ts',
  'apps/cli/tests/checks/check-pr-premise-reassert-own-body.test.ts',
  'apps/cli/tests/checks/check-review-gate-objectives.test.ts',
  'apps/cli/tests/checks/check-review-gate-true-head.test.ts',
  'apps/cli/tests/checks/check-workspace-escape.test.ts',
  'apps/cli/tests/checks/core-parity.test.ts',
  'apps/cli/tests/checks/doc-neutral-ci-parity.test.ts',
  'apps/cli/tests/checks/evidence-fresh.test.ts',
  'apps/cli/tests/checks/issue-checks.test.ts',
  'apps/cli/tests/checks/prose-gates-doctrine-root.test.ts',
  'apps/cli/tests/checks/quoted-command-bin.test.ts',
  'apps/cli/tests/checks/registry-gates.test.ts',
  'apps/cli/tests/checks/repo-root-resolution.test.ts',
  'apps/cli/tests/checks/runner.test.ts',
  'apps/cli/tests/checks/runner/cancelled.test.ts',
  'apps/cli/tests/checks/surface-scope.test.ts',
  'apps/cli/tests/checks/token-collection-pointer-hardening.test.ts',
  'apps/cli/tests/claude-command-emitter.test.ts',
  'apps/cli/tests/claude-stop-hook-emitter.test.ts',
  'apps/cli/tests/commands/brief-render.test.ts',
  'apps/cli/tests/commands/check-flip.test.ts',
  'apps/cli/tests/commands/check-roles-plan.test.ts',
  'apps/cli/tests/commands/check.test.ts',
  'apps/cli/tests/commands/issue-objectives.test.ts',
  'apps/cli/tests/commands/issue.test.ts',
  'apps/cli/tests/commands/pr-create-brief-comment.test.ts',
  'apps/cli/tests/commands/pr-rule.test.ts',
  'apps/cli/tests/commands/pr-verify-evidence-cwd.test.ts',
  'apps/cli/tests/commands/pr.test.ts',
  'apps/cli/tests/commands/review-post-print-only.test.ts',
  'apps/cli/tests/commands/review-post.test.ts',
  'apps/cli/tests/commands/review-status.test.ts',
  'apps/cli/tests/commands/task.test.ts',
  'apps/cli/tests/config.test.ts',
  'apps/cli/tests/demo.test.ts',
  'apps/cli/tests/detect.test.ts',
  'apps/cli/tests/diff-evidence.test.ts',
  'apps/cli/tests/doctor.test.ts',
  'apps/cli/tests/doctrine-resolution.test.ts',
  'apps/cli/tests/doctrine.test.ts',
  'apps/cli/tests/fixtures/checks/spawns-grandchild.ts',
  'apps/cli/tests/fixtures/checks/spawns-stubborn-grandchild.ts',
  'apps/cli/tests/forge-write.test.ts',
  'apps/cli/tests/init.test.ts',
  'apps/cli/tests/isolation/isolation-probe.test.ts',
  'apps/cli/tests/lib/artifacts/collect.test.ts',
  'apps/cli/tests/lib/artifacts/export.test.ts',
  'apps/cli/tests/lib/brief-assembly.test.ts',
  'apps/cli/tests/lib/dev-review-loop/gate-reading.test.ts',
  'apps/cli/tests/lib/dev-review-loop/reviewer-isolation.test.ts',
  'apps/cli/tests/lib/dispatch-task.test.ts',
  'apps/cli/tests/lib/dispatch/worker-boundary.test.ts',
  'apps/cli/tests/lib/forge-write.test.ts',
  'apps/cli/tests/lib/log-callers.test.ts',
  'apps/cli/tests/lib/remote-base.test.ts',
  'apps/cli/tests/lib/task-run/background.test.ts',
  'apps/cli/tests/lib/task-status.test.ts',
  'apps/cli/tests/lib/task-tools/read.test.ts',
  'apps/cli/tests/lib/test-selector.test.ts',
  'apps/cli/tests/lib/turbo-test-task-uncached.test.ts',
  'apps/cli/tests/milestone.test.ts',
  'apps/cli/tests/new-check.test.ts',
  'apps/cli/tests/new-noop-check.test.ts',
  'apps/cli/tests/new-role.test.ts',
  'apps/cli/tests/ops.test.ts',
  'apps/cli/tests/pr-report.test.ts',
  'apps/cli/tests/quickstart.test.ts',
  'apps/cli/tests/review-post.test.ts',
  'apps/cli/tests/studio.test.ts',
  'apps/cli/tests/tracked-hooks.test.ts',
  'apps/cli/tests/upgrade.test.ts'
]

describe('process-fixture coverage — O3 (#660, round 5): every real-process fixture is tracked, not remembered', () => {
  const files = allTestTreeFiles()

  it('the scan really walks the tree — not vacuously empty', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('the shared helper itself really implements both halves of the pattern', () => {
    const helperAbs = join(REPO_ROOT, HELPER_PATH)
    expect(existsSync(helperAbs), `${HELPER_PATH} not found`).toBe(true)
    const content = readFileSync(helperAbs, 'utf8')
    expect(content).toContain('export function stripVinayaEnv')
    expect(content).toContain('export function spawnSyncBudgeted')
    expect(HAS_KILL_BUDGET.test(content)).toBe(true)
  })

  it('no new non-compliant real-process fixture exists outside the grandfather list — the list never grows silently', () => {
    const grandfathered = new Set(GRANDFATHERED_FILES)
    const newOffenders = files
      .filter(([rel]) => !grandfathered.has(rel))
      .filter(([, abs]) => isNonCompliant(readFileSync(abs, 'utf8')))
      .map(([rel]) => rel)
    expect(newOffenders).toEqual([])
  })

  it('every grandfathered file is still genuinely non-compliant — a migrated file must be removed from the list, not left to hide a future regression behind a stale entry', () => {
    const stale = GRANDFATHERED_FILES.filter((rel) => {
      const entry = files.find(([r]) => r === rel)
      if (!entry) return false // a missing/renamed file is caught by the next test instead
      return !isNonCompliant(readFileSync(entry[1], 'utf8'))
    })
    expect(stale).toEqual([])
  })

  it('the grandfather list names no duplicate and no nonexistent file', () => {
    const existing = new Set(files.map(([rel]) => rel))
    expect(new Set(GRANDFATHERED_FILES).size).toBe(GRANDFATHERED_FILES.length)
    const missing = GRANDFATHERED_FILES.filter((rel) => !existing.has(rel))
    expect(missing).toEqual([])
  })

  it("round 5's own migrated files are compliant, not grandfathered — the check is not vacuous against a real fix", () => {
    const migrated = [
      'apps/cli/tests/package-root.test.ts',
      'apps/cli/tests/commands/check-json-pipe.test.ts',
      'apps/cli/tests/lib/log-flush.test.ts',
      'apps/cli/tests/lib/log-webhook-flush.test.ts',
      'apps/cli/tests/commands/log-flush.test.ts'
    ]
    for (const rel of migrated) {
      expect(GRANDFATHERED_FILES).not.toContain(rel)
      const abs = files.find(([r]) => r === rel)?.[1]
      expect(abs, `${rel} not found by the scan`).toBeDefined()
      const content = readFileSync(abs as string, 'utf8')
      expect(importsSharedHelper(content), `${rel} does not import the shared helper`).toBe(true)
      expect(isNonCompliant(content)).toBe(false)
    }
  })
})
