/**
 * `dev-review-loop`'s gate-reading concern (`review-validity-v1` task 8,
 * `#506`, O8) — every forge/git read about a head's mechanical readiness:
 * mechanical CI conclusion, mergeability, base-head staleness, and a
 * developer's own worktree head. Pure reads, no forge-write function
 * anywhere in this module — moved out of `apps/cli/src/lib/dev-review-loop.ts`
 * verbatim; `dev-review-loop.ts` stays the composition root, re-exporting
 * every name below under the same path it always had.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { REVIEW_GATE_CHECK_RUN_NAME } from '../review-gate-check-name.js'

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/**
 * The branch's true head via `git ls-remote` only — `gh pr view
 * headRefOid` is refused by name (Traps to avoid; `#403` moved both gates
 * off it because it can lag a push). Throws, never returns a placeholder,
 * on a genuine resolution failure — a caller with nothing to fall back to
 * should not be handed an empty string.
 */
export function resolveHead(branch: string): string {
  let out: string
  try {
    out = sh('git', ['ls-remote', 'origin', `refs/heads/${branch}`])
  } catch (err) {
    throw new Error(
      `resolveHead: \`git ls-remote origin refs/heads/${branch}\` failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  const sha = out.split(/\s+/)[0] ?? ''
  if (!sha) throw new Error(`resolveHead: branch \`${branch}\` has no head on \`origin\` (empty ls-remote output).`)
  return sha
}

type RestCheckRun = { id: number; name: string; status: string; conclusion: string | null }

/**
 * Every mechanical check-run GitHub reports for `headSha`, deduped to the
 * latest run per name, EXCLUDING `REVIEW_GATE_CHECK_RUN_NAME` — the same
 * exclusion `check-review-gate.ts` already applies to itself, imported from
 * the one shared constant rather than a second hardcoded name
 * (task `#488`, O1, Traps to avoid). Excluded
 * entirely, in every status: a review gate that hasn't posted a verdict yet
 * (no check-run conclusion, or one still `in_progress`) must never read as
 * pending CI either — it is not CI at all. `null` on a genuine fetch
 * failure, read by both callers below as `'pending'` (a transient hiccup
 * reads the same as "not resolved yet", never as red).
 */
function fetchMechanicalCheckRuns(headSha: string): RestCheckRun[] | null {
  let out: string
  try {
    out = sh('gh', [
      'api',
      `repos/{owner}/{repo}/commits/${headSha}/check-runs`,
      '--paginate',
      '--jq',
      '.check_runs[] | {id, name, status, conclusion}'
    ])
  } catch {
    return null
  }
  const runs: RestCheckRun[] = out
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RestCheckRun)

  const latestByName = new Map<string, RestCheckRun>()
  for (const run of runs) {
    const seen = latestByName.get(run.name)
    if (!seen || run.id > seen.id) latestByName.set(run.name, run)
  }
  return Array.from(latestByName.values()).filter((r) => r.name !== REVIEW_GATE_CHECK_RUN_NAME)
}

/**
 * The mechanical gate's own conclusion for `headSha` — never the review
 * gate's own check-run (excluded by `fetchMechanicalCheckRuns`), so a head
 * with green CI and no verdicts yet reads as green, never red (O1).
 * `'pending'` when any latest-per-name mechanical run has not completed, the
 * fetch fails, or no mechanical check-run exists at all yet — the driver is
 * expected to poll this, not treat one `'pending'` read as final.
 */
export function fetchCiConclusion(headSha: string): 'green' | 'red' | 'pending' {
  const latest = fetchMechanicalCheckRuns(headSha)
  if (latest === null || latest.length === 0) return 'pending'
  if (latest.some((r) => r.status !== 'completed')) return 'pending'
  if (latest.every((r) => r.conclusion === 'success' || r.conclusion === 'neutral' || r.conclusion === 'skipped')) {
    return 'green'
  }
  return 'red'
}

/**
 * The names of every completed, non-passing mechanical check-run for
 * `headSha` — never the review gate's own (same exclusion as
 * `fetchCiConclusion`). Used to tell the developer exactly what to fix (O3)
 * instead of a bare "CI is red." Empty when the fetch fails or nothing has
 * failed yet (a still-`pending` run names nothing — there is nothing to fix
 * until it resolves).
 */
export function fetchFailingCheckNames(headSha: string): string[] {
  const latest = fetchMechanicalCheckRuns(headSha)
  if (latest === null) return []
  return latest
    .filter((r) => r.status === 'completed')
    .filter((r) => r.conclusion !== 'success' && r.conclusion !== 'neutral' && r.conclusion !== 'skipped')
    .map((r) => r.name)
}
// --- mergeability (O4/O5/O7) ------------------------------------------------

/** The forge's own three-value answer (GitHub's `mergeable` GraphQL field, read via `gh pr view --json mergeable`) — `UNKNOWN` is the forge still computing it, never read as clean and never as conflicting (O7); the caller polls. */
export type MergeableState = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'

export function fetchMergeableState(prNumber: number): MergeableState {
  let out: string
  try {
    out = sh('gh', ['pr', 'view', String(prNumber), '--json', 'mergeable'])
  } catch (err) {
    throw new Error(
      `fetchMergeableState: could not fetch PR #${prNumber}'s mergeable state: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  const parsed = JSON.parse(out) as { mergeable?: string }
  return parsed.mergeable === 'MERGEABLE' || parsed.mergeable === 'CONFLICTING' ? parsed.mergeable : 'UNKNOWN'
}

/**
 * Pure: `git merge-tree --write-tree`'s own `CONFLICT (...): ... in <path>`
 * lines — unit-testable with no git call. Sorted and de-duplicated so a
 * conflict git reports on more than one internal pass still names each file
 * once.
 */
export function parseMergeTreeConflictFiles(mergeTreeOutput: string): string[] {
  const files = new Set<string>()
  for (const line of mergeTreeOutput.split('\n')) {
    const m = /^CONFLICT \([^)]*\):.* in (.+)$/.exec(line.trim())
    if (m?.[1]) files.add(m[1].trim())
  }
  return [...files].sort()
}

/**
 * O4/O6: the conflicting file(s) GitHub's own `mergeable: CONFLICTING`
 * doesn't name directly — computed locally with `git merge-tree
 * --write-tree` (git ≥ 2.38) against the same two refs the forge just
 * judged, rather than a second, possibly-disagreeing merge algorithm. A
 * best-effort `git fetch` first: this driver's own checkout may not have
 * `headBranch`'s newest commits locally yet.
 */
export function fetchConflictingFiles(baseBranch: string, headBranch: string): string[] {
  try {
    execFileSync('git', ['fetch', '--quiet', 'origin', baseBranch, headBranch], {
      stdio: ['ignore', 'ignore', 'ignore']
    })
  } catch {
    // Best-effort — the refs may already be current locally.
  }
  try {
    execFileSync('git', ['merge-tree', '--write-tree', `origin/${baseBranch}`, `origin/${headBranch}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return []
  } catch (err) {
    const stdout = (err as { stdout?: string }).stdout ?? ''
    return parseMergeTreeConflictFiles(stdout)
  }
}

// --- base-head staleness (O8) ------------------------------------------------

/**
 * O8: any commit touching one of these paths between the loop's recorded
 * start-of-loop base head and a freshly re-read base head means the base
 * moved past THIS driver's own code (or the policy it calls, or the
 * review-post rendering it shares) — a live loop must never keep judging
 * rounds against a gate that has since changed underneath it. Exported so
 * both the driver and its tests share the exact same list.
 */
export const DRIVER_OWNED_PATHS = [
  'apps/cli/src/lib/dev-review-loop.ts',
  'apps/cli/src/commands/review-post.ts',
  'packages/aeg-core/src'
] as const

/** `git log --oneline <oldSha>..<newSha> -- <DRIVER_OWNED_PATHS>` — one line per commit touching this driver's own code in that range, empty when none. */
export function gitCommitsTouchingDriverPaths(oldSha: string, newSha: string): string[] {
  try {
    const out = sh('git', ['log', '--oneline', `${oldSha}..${newSha}`, '--', ...DRIVER_OWNED_PATHS])
    return out ? out.split('\n').filter((l) => l.length > 0) : []
  } catch {
    return []
  }
}

// --- worktree head (O2/O3) ---------------------------------------------------

/** `null` when the worktree doesn't exist locally, or `git -C <path> rev-parse HEAD` otherwise fails — a fact this driver may simply not have (it runs from the repo root, not necessarily the same machine/checkout as the developer's own worktree). */
export function readWorktreeHead(worktreePath: string): string | null {
  if (!existsSync(worktreePath)) return null
  try {
    return sh('git', ['-C', worktreePath, 'rev-parse', 'HEAD'])
  } catch {
    return null
  }
}

export { sh }
