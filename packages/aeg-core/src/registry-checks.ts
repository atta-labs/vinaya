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
 * Rollout policy: G1 was report-only through its own rollout window; task 8
 * flipped it to blocking once the orphan backlog it existed to surface was
 * clean (0 findings against the real `enforcement.md` at the time of the
 * flip). G2 was report-only through plan-brief-v1 task 8, which found its
 * entire remaining backlog was not orphans at all — fourteen files were the
 * second physical form of an already-documented mechanism (`claimedCheckNames`
 * twin-form recognition, see `checkG2`'s own doc comment), and two more were
 * already `NON_GATE_BINS`-listed non-gate tooling — and flipped it to
 * blocking in the same task, on the same reasoning: a permanent `'info'`
 * finding on every run trains its readers to ignore it. G3–G6 are blocking
 * (`'fail'` on any violation).
 */

import { GATE_AUDIENCE, isShipped, NON_GATE_BINS } from './gate-audience'
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

/** The literal placeholder marker a registry-scaffold stub row's
 * non-mechanical cells carry (`registry-scaffold.ts`'s `PLACEHOLDER`,
 * duplicated here rather than imported to keep this module's zero-import
 * shape — the two are asserted equal by `registry-checks.test.ts`). A stub
 * that filled `implementation` alone would silence G2 outright (the whole
 * defect Issue #104 exists to close): this marker is what keeps a row G2
 * still flags loud until a human replaces it with the real "why". */
const SCAFFOLD_PLACEHOLDER = '[undocumented — fill in why]'

/** Every `packages/aeg-core/bin/*` basename (no extension) that implements no gate/refusal/detection mechanism of its own — a forge writer, a one-shot reporter, an eval harness. G2's twin candidate for `NON_GATE_BINS`: a file this list already names has nothing to be named FOR, so asking G2 to find it named by some row is the wrong question, not an unanswered one. */
const NON_GATE_BIN_NAMES: readonly string[] = NON_GATE_BINS

/**
 * `apps/cli/src/checks/bin/*.ts` candidates the general `claimedCheckNames`
 * derivation cannot see, each for a distinct, structural reason — hand-
 * maintained rather than folded into `GATE_AUDIENCE`, because each would
 * break an existing invariant that map enforces:
 *
 * - `check-dead-branch-push.ts` / `check-issue-assignment.ts`: their aeg-core
 *   twins (`check-push-target.ts`, `assign-task-issue.ts`) are genuinely NOT
 *   the same mechanism, only a closely related one an existing row's own
 *   prose already cross-references — `check-push-target.ts` is a lower-level
 *   helper `dead-branch-push`'s row already names as `implementation` (a
 *   single-purpose forge query, not a second copy of the check), and
 *   `assign-task-issue.ts` WRITES the assignment `issue-assignment` only
 *   verifies. `GATE_AUDIENCE`/`NON_GATE_BINS` correctly keep both classified
 *   by what they actually do; forcing a `shippedAs` claim onto either to
 *   satisfy G2 would misdescribe them.
 * - `check-closes-n.ts`: its twin, `verify-coherence.ts`, already ships as
 *   `coherence` (ring 0) via `GATE_AUDIENCE` — but `closes-n` is ring 1
 *   (`CLI_CHECK_RING`), and `ShippedGate` has exactly one `ring` per bin
 *   (`shipped-bin-audience.test.ts` asserts every name in a `shippedAs`
 *   array shares that one ring). One file genuinely ships as two checks at
 *   two different rings — `GATE_AUDIENCE`'s shape cannot say that without a
 *   type change out of this task's surface.
 *
 * Each entry names the ALREADY-DOCUMENTED row (by its `Action`/`CI check`
 * column text) that covers this candidate's mechanism, so a reader can go
 * verify the cross-reference by hand.
 */
const TWIN_CANDIDATE_EXCEPTIONS: Readonly<Record<string, string>> = {
  'apps/cli/src/checks/bin/check-dead-branch-push.ts':
    'Ring 0 "Pushing to a branch whose pull request already resolved" (implementation: check-push-target.ts)',
  'apps/cli/src/checks/bin/check-issue-assignment.ts':
    'Ring 0 "A task branch\'s first push (Issue self-assignment)" (implementation: assign-task-issue.ts)',
  'apps/cli/src/checks/bin/check-closes-n.ts': 'Ring 1 "Closes linkage" (implementation: verify-coherence.ts)'
}

/** A `.claude/hooks/*.sh` file that is real, installed plumbing — feeding an already-documented mechanism's OWN inputs (a transcript pointer, an outbox line) — but performs no pass/fail decision of its own, so it is not itself a candidate "gate" G2 can ask "which row is this?" about. Grown by hand as new hook scripts are added; `gate-audience.test.ts`'s bin-directory enumeration has no `.claude/hooks/` equivalent today. */
const NON_GATE_HOOK_SCRIPTS: readonly string[] = ['.claude/hooks/track-transcript.sh']

/**
 * G2 — every candidate hook/CLI file is named by SOME row's `implementation`,
 * AND no row still carries the scaffold's placeholder marker un-replaced.
 * `candidateFiles` is already-globbed by the caller (`.husky/*`,
 * `.claude/hooks/*.sh`, `packages/aeg-core/bin/*.ts`, excluding `.husky/_`).
 *
 * **Twin-form recognition (plan-brief-v1 8, O14).** The same enforcement
 * mechanism routinely ships as two physical files — a `packages/aeg-core/
 * bin/*.ts` standalone form and an `apps/cli/src/checks/bin/check-*.ts`
 * CLI-registered form — but a row's `implementation` cell holds exactly one
 * path (`GateRow.implementation: string`). Naming only one form orphaned
 * the other on every one of 14 checks this task found live: not a missing
 * row, but the SAME fact (this mechanism is documented) read through a
 * string-equality test too narrow to see its own second form. `claimedCheckNames`
 * already derives the `coreCheckRegistry()` name either physical shape
 * resolves to (G6 uses it for a row's `implementation`); calling it on the
 * CANDIDATE path too and checking for overlap with any row's claimed names
 * is the one-fact-one-implementation fix — no new row invents a second
 * fact for what is really one, already-documented mechanism.
 *
 * A `NON_GATE_BINS`-listed aeg-core bin (`report-tokens.ts`,
 * `eval-agent-compliance.ts`, …) and a listed non-gate hook script
 * (`track-transcript.sh`) implement no gate of their own — per the doctrine
 * this task also writes (`enforcement.md`), the honest fix for a candidate
 * that names no row is that this gate stops asking, never an invented row.
 *
 * Blocking as of this task (re-graded from report-only: the twin-form gap
 * above was G2's entire non-scaffold-placeholder backlog, and closing it
 * rather than merely explaining it away is what makes a 0-finding G2 run
 * mean something again).
 */
export function checkG2(rows: GateRow[], candidateFiles: string[]): RegistryCheckResult {
  const implementations = new Set(rows.map((r) => r.implementation).filter((p) => p !== ''))
  const claimedNames = new Set(rows.flatMap((r) => claimedCheckNames(r.implementation)))
  const findings: RegistryFinding[] = []
  for (const path of candidateFiles) {
    if (implementations.has(path)) continue
    if (path.startsWith(AEG_CORE_BIN_PATH_PREFIX) && NON_GATE_BIN_NAMES.includes(basenameNoExt(path))) continue
    if (NON_GATE_HOOK_SCRIPTS.includes(path)) continue
    if (path in TWIN_CANDIDATE_EXCEPTIONS) continue
    const candidateNames = claimedCheckNames(path)
    if (candidateNames.length > 0 && candidateNames.some((n) => claimedNames.has(n))) continue
    findings.push({
      path,
      reason: `"${path}" is not named as the implementation of any row in enforcement.md's ring tables`
    })
  }
  for (const row of rows) {
    const carriesPlaceholder = [row.summary, row.description, row.spec].some((cell) => cell === SCAFFOLD_PLACEHOLDER)
    if (carriesPlaceholder) {
      findings.push({
        row: row.action,
        path: row.implementation,
        reason: `${row.ring} row "${row.action}" still carries the scaffold placeholder marker — the why is owed`
      })
    }
  }
  return { check: 'G2', status: findings.length > 0 ? 'fail' : 'pass', findings }
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
