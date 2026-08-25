/**
 * registry-checks.ts — G1–G6, the deterministic coherence checks that make
 * `aeg-root/enforcement.md`'s three ring tables (parsed by
 * `registry-parse.ts`) load-bearing instead of decorative.
 *
 * Pure — no `fs`, no `git`/`gh` I/O, no `fetch`. All forge/filesystem facts
 * are injected by the caller (`bin/verify-registry.ts` /
 * `apps/cli/src/checks/bin/check-registry-gates.ts`, the I/O shims),
 * mirroring `coherence-checks.ts`'s shape exactly (plain executables,
 * deterministic pass/fail, no config conditionals).
 *
 * Rollout policy: G2 ships report-only — it can only ever report `'info'`,
 * never `'fail'`, so it never affects CI's exit code (the accepted shape for
 * G2's inverse sweep, unchanged by task 8). G1 was report-only through its
 * own rollout window; task 8 flips it to blocking now that the orphan
 * backlog it existed to surface is clean (0 findings against the real
 * `enforcement.md` at the time of the flip). G3–G6 are blocking (`'fail'` on
 * any violation).
 */

import { GATE_AUDIENCE, isShipped } from './gate-audience'
import type { GateRow } from './registry-parse'

export type RegistryCheckStatus = 'pass' | 'fail' | 'info'

export type RegistryFinding = {
  row?: string
  path?: string
  reason: string
}

export type RegistryCheckResult = {
  check: 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6'
  status: RegistryCheckStatus
  findings: RegistryFinding[]
}

/**
 * G1 — every row's non-empty `implementation` resolves on disk. Blocking as
 * of task 8 (re-graded from report-only: eleven permanent `info` findings on
 * every run had become indistinguishable from silence, which is how the gap
 * this tranche closes stayed invisible; the report-only window had already
 * cleared the backlog it existed to surface).
 */
export function checkG1(rows: GateRow[], existsFn: (path: string) => boolean): RegistryCheckResult {
  const findings: RegistryFinding[] = []
  for (const row of rows) {
    if (row.implementation === '') continue
    if (!existsFn(row.implementation)) {
      findings.push({
        row: row.action,
        path: row.implementation,
        reason: `${row.ring} row "${row.action}" names implementation "${row.implementation}", which does not exist on disk`
      })
    }
  }
  return { check: 'G1', status: findings.length > 0 ? 'fail' : 'pass', findings }
}

/**
 * G2 — every candidate hook/CLI file is named by SOME row's `implementation`.
 * `candidateFiles` is already-globbed by the caller (`.husky/*`,
 * `.claude/hooks/*.sh`, `packages/aeg-core/bin/*.ts`, excluding `.husky/_`).
 * Report-only this tranche — same as G1, never `'fail'`.
 */
export function checkG2(rows: GateRow[], candidateFiles: string[]): RegistryCheckResult {
  const implementations = new Set(rows.map((r) => r.implementation).filter((p) => p !== ''))
  const findings: RegistryFinding[] = []
  for (const path of candidateFiles) {
    if (!implementations.has(path)) {
      findings.push({
        path,
        reason: `"${path}" is not named as the implementation of any row in enforcement.md's ring tables`
      })
    }
  }
  return { check: 'G2', status: findings.length > 0 ? 'info' : 'pass', findings }
}

/**
 * G3 — every file that makes a GitHub-crossing call is named by SOME Ring-0
 * row's `implementation` — "no seventh way into GitHub". `crossingFiles` is
 * already-detected by the caller via a source-grep. Blocking.
 */
export function checkG3(ring0Rows: GateRow[], crossingFiles: string[]): RegistryCheckResult {
  const ring0Implementations = new Set(ring0Rows.map((r) => r.implementation))
  const findings: RegistryFinding[] = []
  for (const path of crossingFiles) {
    if (!ring0Implementations.has(path)) {
      findings.push({
        path,
        reason: `"${path}" makes a GitHub-crossing call but is not named by any Ring-0 row's implementation — a seventh, unlisted way into GitHub`
      })
    }
  }
  return { check: 'G3', status: findings.length > 0 ? 'fail' : 'pass', findings }
}

/**
 * G4 — every `#NNN` cited in enforcement.md's body resolves in the forge.
 * `resolveFn` wraps `gh issue view`/`gh pr view` (caller injects). Blocking.
 * Broad reading (brief): every `#`-prefixed 3-or-more-digit number
 * occurring anywhere in the body is checked, not just ones near keywords
 * like "incident" — an incomplete keyword net would create a
 * false-negative gap. The current repo's real citations are all 3-4
 * digits; the lower bound of 3 exists only to exclude unrelated short
 * numerals (ring/tier numbers) that are never written with a `#` prefix
 * anyway — there is deliberately no upper bound, so a longer fabricated
 * number is still caught.
 */
export function checkG4(content: string, resolveFn: (n: number) => boolean): RegistryCheckResult {
  const cited = new Set<number>()
  for (const hit of content.matchAll(/#(\d{3,})\b/g)) {
    cited.add(Number(hit[1]))
  }
  const findings: RegistryFinding[] = []
  for (const n of cited) {
    if (!resolveFn(n)) {
      findings.push({
        reason: `#${n} is cited in enforcement.md but does not resolve to a real Issue or PR in the forge`
      })
    }
  }
  return { check: 'G4', status: findings.length > 0 ? 'fail' : 'pass', findings }
}

/**
 * G5 — every contract's producer/consumer is a real role_id; every role's
 * `performs`/`refuses_when` is present and non-empty. Blocking.
 *
 * "The action exists" is satisfied by presence/well-formedness of the
 * role's own frontmatter — there is no second, independent registry of
 * valid actions to cross-reference `performs` entries against.
 */
export function checkG5(
  roles: Array<{ file: string; role_id: string; performs: string[]; refuses_when: string }>,
  contracts: Array<{ file: string; producer: string; consumer: string }>
): RegistryCheckResult {
  const roleIds = new Set(roles.map((r) => r.role_id))
  const findings: RegistryFinding[] = []

  for (const contract of contracts) {
    if (!roleIds.has(contract.producer)) {
      findings.push({
        path: contract.file,
        reason: `contract "${contract.file}" names producer "${contract.producer}", which is not a real role_id`
      })
    }
    if (!roleIds.has(contract.consumer)) {
      findings.push({
        path: contract.file,
        reason: `contract "${contract.file}" names consumer "${contract.consumer}", which is not a real role_id`
      })
    }
  }

  for (const role of roles) {
    if (role.performs.length === 0) {
      findings.push({ path: role.file, reason: `role "${role.role_id}" has an empty performs array` })
    }
    if (role.refuses_when.trim() === '') {
      findings.push({ path: role.file, reason: `role "${role.role_id}" has an empty refuses_when` })
    }
  }

  return { check: 'G5', status: findings.length > 0 ? 'fail' : 'pass', findings }
}

const SHIPPED_BIN_PATH_PREFIX = 'apps/cli/src/checks/bin/check-'
const AEG_CORE_BIN_PATH_PREFIX = 'packages/aeg-core/bin/'

function basenameNoExt(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  return base.replace(/\.ts$/, '')
}

/**
 * Every `coreCheckRegistry()` name a `product`-audience row's implementation
 * could resolve to. Two shapes: a path directly under the shipped bin
 * directory names its own check 1:1 (`apps/cli/src/checks/bin/check-doc-
 * coverage-push.ts` -> `doc-coverage-push`); a path under
 * `packages/aeg-core/bin/` resolves through `GATE_AUDIENCE`, the same map
 * `shipped-bin-audience.test.ts` (`apps/cli`) already asserts agrees with
 * the registry — reused here rather than re-derived, so doctrine and code
 * cannot silently disagree about what a bin ships as. Neither shape matches
 * (e.g. a `.github/workflows/*.yml` path, `checks/runner.ts`, a forge-write
 * command) resolves to no candidate at all — correct, since those are not
 * `coreCheckRegistry()` checks by construction.
 */
function claimedCheckNames(implementation: string): string[] {
  if (implementation.startsWith(SHIPPED_BIN_PATH_PREFIX) && implementation.endsWith('.ts')) {
    return [implementation.slice(SHIPPED_BIN_PATH_PREFIX.length, -'.ts'.length)]
  }
  if (implementation.startsWith(AEG_CORE_BIN_PATH_PREFIX)) {
    const audience = GATE_AUDIENCE[basenameNoExt(implementation)]
    if (audience && isShipped(audience)) {
      return Array.isArray(audience.shippedAs) ? audience.shippedAs : [audience.shippedAs]
    }
  }
  return []
}

/**
 * G6 — every row doctrine marks `product` must actually resolve to a
 * `coreCheckRegistry()` entry ("claimed checks must ship" — the parity gate
 * this task exists for). `registeredCheckNames` is caller-injected
 * (`coreCheckRegistry().map(s => s.name)`, from `apps/cli`, which
 * `aeg-core` cannot import without closing a dependency cycle — same
 * reasoning `gate-audience.ts` documents for `GATE_AUDIENCE` itself).
 * Blocking. A row left at the default `repo-own` audience makes no shipped
 * claim and is never checked here.
 */
export function checkG6(rows: GateRow[], registeredCheckNames: Set<string>): RegistryCheckResult {
  const findings: RegistryFinding[] = []
  for (const row of rows) {
    if (row.audience !== 'product') continue
    const candidates = claimedCheckNames(row.implementation)
    if (!candidates.some((name) => registeredCheckNames.has(name))) {
      findings.push({
        row: row.action,
        path: row.implementation,
        reason: `${row.ring} row "${row.action}" is marked \`product\` but its implementation "${row.implementation}" does not resolve to a coreCheckRegistry() entry`
      })
    }
  }
  return { check: 'G6', status: findings.length > 0 ? 'fail' : 'pass', findings }
}
