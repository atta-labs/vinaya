/**
 * Issue #660, O3, round 5 Principal ruling — "O3 becomes a check, and this
 * round closes it": four rounds of the reviewer naming individual sibling
 * fixtures by hand never converged (ninety-two test files under
 * `apps/cli/tests` start a real process). Rather than a fifth round of the
 * same, this file makes O3 mechanical: it walks the real tree, finds every
 * real-process CALL SITE that neither goes through the shared
 * `lib/process-fixture.ts` helper nor carries that helper's own two-halves
 * pattern (VINAYA_* env stripping plus an explicit kill-and-diagnose
 * budget) at that call's own scope, and requires every file with at least
 * one such call site to be named, by path, on `GRANDFATHERED_FILES` below.
 *
 * Round 5 review, BLOCKER F1 — the first version of this check compared the
 * env-strip and kill-budget PATTERNS against a file's WHOLE TEXT (or
 * treated any import of the shared helper as clearing the entire file),
 * which let one hardened call in a file hide a completely unrelated, fully
 * raw call elsewhere in the SAME file — exactly what happened to
 * `conformance/harness.ts`'s `ensureCliBuilt`, `commands/dispatch-task.test.ts`'s
 * identical build spawn, and `package-root.test.ts`'s `run()` CLI helper.
 * This version instead:
 *   - finds every real spawn call textually (skipping comments/strings so a
 *     doc comment that merely MENTIONS `spawn()` is never mistaken for one);
 *   - exempts a small set of inert setup utilities (`git`, `chmod`, `mkdir`,
 *     …) invoked by a literal or an obviously-named identifier — the
 *     category the ruling itself named as legitimately out of scope
 *     ("git, gh, ln, chmod, a fake vendor binary");
 *   - for every remaining call, requires the file as a whole to strip
 *     VINAYA_* somewhere (env-composition is legitimately threaded through
 *     parameters across functions — `conformance/harness.ts`'s
 *     `buildSandbox`/`SpawnRpcClient` split is the reference case) AND the
 *     call's own nearest TOP-LEVEL declaration (the function, class, or
 *     `it(...)`/`describe(...)` callback that contains it — never the whole
 *     file) to carry the kill-budget evidence, since budget/diagnostic is
 *     always co-located with the actual spawn in every real fixture this
 *     task has hardened.
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
 *
 * Round 7 Principal ruling — "a shell is not a utility": `sh` and `bash`
 * were in `SAFE_UTILITY_COMMANDS` alongside `git`/`chmod`/`mkdir`, but a
 * shell doesn't do one fixed thing the way those do — it runs whatever
 * string it's handed, so `spawnSync('bash', ['-c', 'bun ...'])` (or the
 * `sh` equivalent) hid an arbitrary command, including the `vinaya` CLI or
 * a build, behind a "safe" wrapper the scan never looked past. Round 7
 * removes both from the safe list, which reclassified three files
 * (`claude-command-emitter.test.ts`, `claude-stop-hook-emitter.test.ts`,
 * `init.test.ts`) from silently-safe to real offenders; none of the three
 * already routed through the shared helper, so all three were added to
 * `GRANDFATHERED_FILES` below rather than hardened inline — that inline
 * work is the same later task the list's burn-down already is, not this
 * round's.
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

/**
 * `content` with every line comment, block comment, and string/template
 * literal replaced by same-length whitespace (newlines preserved, so every
 * OTHER index — and therefore every line number computed from it — stays
 * aligned with the original text). Used only to decide where a real call
 * sits; a doc comment's prose (`` `spawn()` `` in backticks, or a regex
 * literal spelling out `execFileSync(` as a string to describe the shape,
 * as `log-callers.test.ts` does) can never be mistaken for one.
 */
function stripNonCode(content: string): string {
  const out: string[] = []
  let i = 0
  const n = content.length
  while (i < n) {
    const c = content[i]
    if (c === '/' && content[i + 1] === '/') {
      const nl = content.indexOf('\n', i)
      const end = nl === -1 ? n : nl
      out.push(' '.repeat(end - i))
      i = end
      continue
    }
    if (c === '/' && content[i + 1] === '*') {
      const end = content.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      out.push(content.slice(i, stop).replace(/[^\n]/g, ' '))
      i = stop
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      let j = i + 1
      while (j < n && content[j] !== quote) {
        if (content[j] === '\\') j++
        j++
      }
      j++
      out.push(content.slice(i, j).replace(/[^\n]/g, ' '))
      i = j
      continue
    }
    out.push(c as string)
    i++
  }
  return out.join('')
}

/** A real call — matched against `stripNonCode`'s output, never raw content. */
const SPAWNS_REAL_PROCESS = /\b(?:spawnSync|execFileSync|fork|spawn)\s*\(|Bun\.spawn(?:Sync)?\s*\(/g

/** `lib/process-fixture.ts`'s own `stripVinayaEnv` — imported, or reimplemented inline, anywhere in the file. */
const HAS_VINAYA_ENV_STRIP = /startsWith\(\s*['"]VINAYA_['"]\s*\)|stripVinayaEnv/

/** An explicit kill-on-timeout budget — `lib/process-fixture.ts`'s own `spawnSyncBudgeted`/`spawnBudgetedAsync`, or the same discipline reimplemented inline, within the call's own top-level declaration. */
const HAS_KILL_BUDGET = /killSignal|SIGKILL/

/**
 * Inert setup utilities — never the `vinaya` CLI, never a build, never
 * anything the O3 incident (a leaked `VINAYA_RUNTIME_DIR` racing a driver
 * lock, or a hang with no budget) is actually about. The ruling's own words
 * name this category explicitly as out of scope for this round ("git, gh,
 * ln, chmod, a fake vendor binary"). `bun`/`node`/`vinaya` are deliberately
 * NEVER in this set — those are the exact risk-bearing invocations.
 *
 * Round 7 review — `sh`/`bash` do NOT belong here and are deliberately
 * absent. Unlike `git`/`chmod`/`mkdir`, a shell doesn't do one fixed thing:
 * it runs whatever string it's handed, so a `spawnSync('bash', ['-c', 'bun
 * ...'])` (or the same via `sh -c`) hid an arbitrary — possibly
 * risk-bearing — command from this scan behind a "safe" wrapper. A shell
 * spawn is now classified exactly like any other real process.
 */
const SAFE_UTILITY_COMMANDS = new Set([
  'git',
  'chmod',
  'true',
  'mkdir',
  'which',
  'mkfifo',
  'cat',
  'ln',
  'kill',
  'jq',
  'ps',
  'rm',
  'cp',
  'touch',
  'id',
  'whoami'
])

/** The call's first argument — a literal (`'git'`, `['bun', …]`) or a bare identifier (`realGit`, `cmd`) — read from the ORIGINAL content (never `stripNonCode`'s blanked text, which would hide the literal's own quotes). */
function commandHint(content: string, matchEnd: number): string | null {
  const tail = content.slice(matchEnd, matchEnd + 40)
  const literal = /^\s*\[?\s*['"]([a-zA-Z0-9_./-]+)['"]/.exec(tail)
  if (literal) return literal[1] as string
  const identifier = /^\s*\[?\s*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(tail)
  return identifier ? (identifier[1] as string) : null
}

function isSafeCommand(hint: string | null): boolean {
  if (!hint) return false
  if (SAFE_UTILITY_COMMANDS.has(hint)) return true
  // An identifier NAMED for a safe utility (`realGit`, `gitBin`) resolved
  // through a function parameter or `which` call rather than a literal —
  // common in these fixtures' own `write­Fake*` helpers. Never matches
  // `bun`/`node`/`vinaya`-named identifiers, which must still prove the
  // real pattern.
  return /git/i.test(hint) && !/bun|node|vinaya/i.test(hint)
}

/**
 * The [start, end) span of the smallest brace-delimited block that both (a)
 * opens at file-level nesting depth 0→1 and (b) contains `index` — the
 * call's own top-level function, class, or `it(...)`/`describe(...)`
 * callback. A class's constructor and its other methods share ONE span
 * (`conformance/harness.ts`'s `SpawnRpcClient`: the constructor spawns, a
 * SEPARATE method holds the kill-on-timeout budget — the same class, the
 * same span, correctly read as one unit), while two unrelated top-level
 * functions never share a span (the exact BLOCKER this round fixes).
 */
function topLevelSpans(content: string): [number, number][] {
  const spans: [number, number][] = []
  const stack: number[] = []
  let i = 0
  const n = content.length
  while (i < n) {
    const c = content[i]
    if (c === '/' && content[i + 1] === '/') {
      const nl = content.indexOf('\n', i)
      i = nl === -1 ? n : nl + 1
      continue
    }
    if (c === '/' && content[i + 1] === '*') {
      const end = content.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      i++
      while (i < n && content[i] !== quote) {
        if (content[i] === '\\') i++
        i++
      }
      i++
      continue
    }
    if (c === '{') {
      if (stack.length === 0) spans.push([i, -1])
      stack.push(i)
    } else if (c === '}') {
      stack.pop()
      if (stack.length === 0 && spans.length > 0) {
        const last = spans[spans.length - 1] as [number, number]
        if (last[1] === -1) last[1] = i + 1
      }
    }
    i++
  }
  return spans.filter((s) => s[1] !== -1)
}

function spanFor(spans: readonly [number, number][], index: number): [number, number] | null {
  for (const [start, end] of spans) {
    if (index >= start && index < end) return [start, end]
  }
  return null
}

/**
 * Every non-compliant real-process call site in `content` — a real spawn,
 * not an inert utility, whose containing file never strips VINAYA_*
 * anywhere, or whose own top-level declaration carries no kill-budget
 * evidence.
 */
function nonCompliantCallSites(content: string): string[] {
  const offenses: string[] = []
  const spans = topLevelSpans(content)
  const fileHasVinayaStrip = HAS_VINAYA_ENV_STRIP.test(content)
  const codeOnly = stripNonCode(content)
  const re = new RegExp(SPAWNS_REAL_PROCESS.source, 'g')
  let match: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
  while ((match = re.exec(codeOnly)) !== null) {
    const hint = commandHint(content, match.index + match[0].length)
    if (isSafeCommand(hint)) continue
    const span = spanFor(spans, match.index)
    const scope = span ? content.slice(span[0], span[1]) : content
    if (!(fileHasVinayaStrip && HAS_KILL_BUDGET.test(scope))) {
      const line = content.slice(0, match.index).split('\n').length
      offenses.push(`line ${line}: ${match[0]}`)
    }
  }
  return offenses
}

function isNonCompliant(content: string): boolean {
  return nonCompliantCallSites(content).length > 0
}

/**
 * Round 5's own fix: the two build spawns (`package-root.test.ts`,
 * `commands/check-json-pipe.test.ts`), the log-flush sibling group
 * (`lib/log-flush.test.ts`, `lib/log-webhook-flush.test.ts`,
 * `commands/log-flush.test.ts`), and the three round-4-named sites
 * (`lib/dev-review-loop/gate-reading.test.ts`, `conformance/harness.ts`,
 * `commands/dispatch-task.test.ts`) are all NOT on this list — proven by
 * the negative assertion below, so a regression on any of them is caught
 * as a new offender rather than silently re-covered by a stale entry.
 * `commands/task-status.test.ts` and `lib/dispatch.test.ts` (already fully
 * migrated in earlier rounds) are also absent — this round's move to
 * call-site precision re-verified both and found no gap.
 *
 * Every other file below still spawns a real process (`git`, a fake vendor
 * binary, or the `vinaya` CLI itself for a command that never touches the
 * runtime-dir/driver-lock/control-store surface the original incident was
 * about) without the shared helper's pattern at that call's own scope.
 * Found by search — `bun apps/cli/tests/process-fixture-coverage.test.ts`'s
 * own scan — never by memory, per round 3's ruling.
 *
 * Round 7 adds exactly three entries — `claude-command-emitter.test.ts`,
 * `claude-stop-hook-emitter.test.ts`, `init.test.ts` — the files
 * reclassified by removing `sh`/`bash` from `SAFE_UTILITY_COMMANDS`. The
 * list holds 55 entries as of round 7 (52 carried over from round 5 plus
 * these three); round 5's own list of names above this comment is
 * unchanged and still accurate for what it describes.
 */
const GRANDFATHERED_FILES: readonly string[] = [
  'apps/cli/tests/checks/body-bare-digits-changeset-exempt.test.ts',
  'apps/cli/tests/checks/branch-topology.test.ts',
  'apps/cli/tests/checks/changeset-coverage-bin.test.ts',
  'apps/cli/tests/checks/check-dispatch-readiness-premise.test.ts',
  'apps/cli/tests/checks/check-exec-bits.test.ts',
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
  'apps/cli/tests/doctrine-resolution.test.ts',
  'apps/cli/tests/doctrine.test.ts',
  'apps/cli/tests/fixtures/checks/spawns-grandchild.ts',
  'apps/cli/tests/fixtures/checks/spawns-stubborn-grandchild.ts',
  'apps/cli/tests/init.test.ts',
  'apps/cli/tests/isolation/isolation-probe.test.ts',
  'apps/cli/tests/lib/artifacts/collect.test.ts',
  'apps/cli/tests/lib/artifacts/export.test.ts',
  'apps/cli/tests/lib/dispatch/worker-boundary.test.ts',
  'apps/cli/tests/lib/forge-write.test.ts',
  'apps/cli/tests/lib/test-selector.test.ts',
  'apps/cli/tests/lib/turbo-test-task-uncached.test.ts',
  'apps/cli/tests/milestone.test.ts',
  'apps/cli/tests/new-check.test.ts',
  'apps/cli/tests/new-noop-check.test.ts',
  'apps/cli/tests/new-role.test.ts',
  'apps/cli/tests/ops.test.ts',
  'apps/cli/tests/pr-report.test.ts',
  'apps/cli/tests/review-post.test.ts'
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
    expect(content).toContain('export async function spawnBudgetedAsync')
    expect(HAS_KILL_BUDGET.test(content)).toBe(true)
  })

  it('no new non-compliant real-process call site exists outside the grandfather list — the list never grows silently', () => {
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

  it("round 5's own migrated/hardened files are compliant, not grandfathered — the check is not vacuous against a real fix", () => {
    const fixed = [
      'apps/cli/tests/package-root.test.ts',
      'apps/cli/tests/commands/check-json-pipe.test.ts',
      'apps/cli/tests/lib/log-flush.test.ts',
      'apps/cli/tests/lib/log-webhook-flush.test.ts',
      'apps/cli/tests/commands/log-flush.test.ts',
      'apps/cli/tests/lib/dev-review-loop/gate-reading.test.ts',
      'apps/cli/tests/conformance/harness.ts',
      'apps/cli/tests/commands/dispatch-task.test.ts'
    ]
    for (const rel of fixed) {
      expect(GRANDFATHERED_FILES).not.toContain(rel)
      const abs = files.find(([r]) => r === rel)?.[1]
      expect(abs, `${rel} not found by the scan`).toBeDefined()
      const content = readFileSync(abs as string, 'utf8')
      expect(isNonCompliant(content), `${rel}: ${nonCompliantCallSites(content).join(', ')}`).toBe(false)
    }
  })

  it('the call-site check catches a raw call hiding behind an unrelated hardened one in the same file — the exact BLOCKER round 5 review found', () => {
    // Line 11 (`stillRaw`'s own spawnSync) is the only offense expected —
    // line 8 (`hardened`'s spawnSync) carries the pattern at its own call
    // site, and the two functions must NOT be conflated into one scope.
    const twoFunctionsOneHardenedOneRaw = [
      "import { spawnSync } from 'node:child_process'",
      'function stripVinayaEnv(env) {',
      '  const out = { ...env }',
      "  for (const k of Object.keys(out)) if (k.startsWith('VINAYA_')) delete out[k]",
      '  return out',
      '}',
      'function hardened() {',
      "  return spawnSync('bun', ['x'], { env: stripVinayaEnv(process.env), timeout: 1000, killSignal: 'SIGKILL' })",
      '}',
      'function stillRaw() {',
      "  return spawnSync('bun', ['y'], { env: process.env })",
      '}'
    ].join('\n')

    const offenses = nonCompliantCallSites(twoFunctionsOneHardenedOneRaw)
    expect(offenses).toEqual(['line 11: spawnSync('])
  })
})
