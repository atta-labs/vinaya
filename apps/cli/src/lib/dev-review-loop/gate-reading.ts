/**
 * `dev-review-loop`'s gate-reading concern — every forge/git read about a head's mechanical readiness:
 * mechanical CI conclusion, mergeability, base-head staleness, and a
 * developer's own worktree head. Pure reads, no forge-write function
 * anywhere in this module — moved out of `apps/cli/src/lib/dev-review-loop.ts`
 * verbatim; `dev-review-loop.ts` stays the composition root, re-exporting
 * every name below under the same path it always had.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { PRINCIPAL_TEST_PLAN_WAIT_CHECK_RUN_NAME } from '../principal-test-plan-wait-check-name.js'
import { REVIEW_GATE_CHECK_RUN_NAME } from '../review-gate-check-name.js'

/** Env-overridable, same idiom `dev-review-loop.ts`'s own `gatePollEnvOverride` uses — a fixture needs sub-millisecond backoff, real usage needs real spacing between retries. */
function shEnvOverride(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * `execFileSync`'s own default `maxBuffer` (1 MiB) is what broke
 * `fetchFrozenBrief`'s `gh issue view --json comments` read once a task
 * Issue's own log-dump comments passed it: one measured at 1,597,599 bytes,
 * and the loop exited
 * unable to read the very brief it needed to dispatch. Every `gh` read this
 * module makes (`fetchFrozenBrief`, `fetchIssueComments`,
 * `resolveIssueObjectives`, `fetchRulings` — all in `developer-dispatch.ts`,
 * all funneled through this one `sh()`) goes through the SAME 1 MiB ceiling,
 * so it is bounded here, once, generously (64 MiB) rather than left
 * unbounded: an Issue/PR's comment payload is adopter-influenced content,
 * not something this process should buffer with no ceiling at all.
 */
const MAX_GH_OUTPUT_BYTES = 64 * 1024 * 1024

/** Blocking, in-process sleep — `sh()` is itself fully synchronous (`execFileSync`), so an `async` backoff here would require threading a Promise through every one of this module's exported, synchronous read functions. */
function sleepSyncMs(ms: number): void {
  if (ms <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function sh(cmd: string, args: string[]): string {
  if (cmd !== 'gh') {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: MAX_GH_OUTPUT_BYTES
    }).trim()
  }
  // O5: every `gh` READ this driver makes retries this many times, total,
  // before a transient forge hiccup counts as a real failure — never
  // applied to `git` (this module's other `sh()` caller), and never to a
  // write (those never go through `sh()` — see `publication.ts`'s own
  // direct `execFileSync`). Read per call, not once at module load, so a
  // fixture can override it without needing a fresh module instance.
  const attempts = shEnvOverride('VINAYA_DEV_REVIEW_LOOP_GH_RETRY_ATTEMPTS', 3)
  const backoffMs = shEnvOverride('VINAYA_DEV_REVIEW_LOOP_GH_RETRY_BACKOFF_MS', 500)
  let lastErr: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return execFileSync(cmd, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: MAX_GH_OUTPUT_BYTES
      }).trim()
    } catch (err) {
      lastErr = err
      if (attempt < attempts) sleepSyncMs(backoffMs * attempt)
    }
  }
  throw lastErr
}

/**
 * The branch's true head via `git ls-remote` only — `gh pr view
 * headRefOid` is refused by name (Traps to avoid; a real fix moved both gates
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

type RestCheckRun = { id: number; name: string; status: string; conclusion: string | null; started_at: string }

/**
 * Every mechanical check-run GitHub reports for `headSha`, deduped to the
 * latest run per name, EXCLUDING `REVIEW_GATE_CHECK_RUN_NAME` and
 * `PRINCIPAL_TEST_PLAN_WAIT_CHECK_RUN_NAME` — the same exclusion
 * `check-review-gate.ts` already applies to its own name, imported from the
 * one shared constant rather than a second hardcoded name (Traps to avoid).
 * Both are excluded entirely, in every status, but for two different
 * reasons: a review gate that hasn't posted a verdict yet (no check-run
 * conclusion, or one still `in_progress`) must never read as pending CI
 * either — it is not CI at all; the principal-test-plan-wait check IS a real
 * mechanical check-run, but its own red is the Principal's own wait, not a
 * failure the Developer can fix by pushing — its own job is what actually
 * holds the merge open while it stays red. No other red check may be
 * excluded this way. `null` on a genuine fetch failure, read by
 * both callers below as `'pending'` (a transient hiccup reads the same as
 * "not resolved yet", never as red).
 */
function fetchMechanicalCheckRuns(headSha: string): RestCheckRun[] | null {
  let out: string
  try {
    out = sh('gh', [
      'api',
      `repos/{owner}/{repo}/commits/${headSha}/check-runs`,
      '--paginate',
      '--jq',
      '.check_runs[] | {id, name, status, conclusion, started_at}'
    ])
  } catch {
    return null
  }
  const runs: RestCheckRun[] = out
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RestCheckRun)

  // O3: the newest `started_at` wins, not the highest `id` — a check
  // re-run (the same name, requested again after an earlier failure) is
  // what this dedupe exists for, and GitHub's own run ids are an
  // implementation detail this driver never relied on being monotonic
  // with re-run order. Ties (an identical timestamp) keep whichever run
  // this loop saw first — real re-runs a Principal or CI triggers by hand
  // are always seconds apart, never truly simultaneous.
  const latestByName = new Map<string, RestCheckRun>()
  for (const run of runs) {
    const seen = latestByName.get(run.name)
    if (!seen || Date.parse(run.started_at) > Date.parse(seen.started_at)) latestByName.set(run.name, run)
  }
  return Array.from(latestByName.values()).filter(
    (r) => r.name !== REVIEW_GATE_CHECK_RUN_NAME && r.name !== PRINCIPAL_TEST_PLAN_WAIT_CHECK_RUN_NAME
  )
}

/**
 * The mechanical gate's own conclusion for `headSha` — never the review
 * gate's own check-run (excluded by `fetchMechanicalCheckRuns`), so a head
 * with green CI and no verdicts yet reads as green, never red.
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

/** One completed, non-passing mechanical check-run — the identity a pause built from it can be audited against. */
export type FailingCheckRun = { name: string; id: number; startedAt: string | null }

/**
 * Every completed, non-passing mechanical check-run for `headSha` — never
 * the review gate's own (same exclusion as `fetchCiConclusion`). Already
 * deduped to the newest run per check name (`fetchMechanicalCheckRuns`'s own
 * O3), so a failure a later same-named run has superseded with a
 * pass is never in this list. Used to tell the developer
 * exactly what to fix, and to name the run a pause was built from, instead
 * of a bare "CI is red." Empty when the fetch fails or nothing has failed
 * yet (a still-`pending` run names nothing — there is nothing to fix until
 * it resolves).
 */
export function fetchFailingCheckRuns(headSha: string): FailingCheckRun[] {
  const latest = fetchMechanicalCheckRuns(headSha)
  if (latest === null) return []
  return latest
    .filter((r) => r.status === 'completed')
    .filter((r) => r.conclusion !== 'success' && r.conclusion !== 'neutral' && r.conclusion !== 'skipped')
    .map((r) => ({ name: r.name, id: r.id, startedAt: r.started_at ?? null }))
}

/** O3: the display form a pause detail (or a gate-red retry prompt) names a failing run by — the check name plus its run id, so the SAME name appearing again in a later, superseded run is never mistaken for the one a pause was actually built from. */
export function describeFailingCheckRun(run: FailingCheckRun): string {
  return run.startedAt ? `${run.name} (run ${run.id}, started ${run.startedAt})` : `${run.name} (run ${run.id})`
}
// --- mergeability ------------------------------------------------

/** The forge's own three-value answer (GitHub's `mergeable` GraphQL field, read via `gh pr view --json mergeable`) — `UNKNOWN` is the forge still computing it, never read as clean and never as conflicting; the caller polls. */
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
 * issue-711 O4: the forge's own three-value pull-request state (`gh pr view
 * --json state`) — `OPEN` covers every in-progress state a pause can be
 * watched through; `MERGED`/`CLOSED` are the two forge-side terminal facts
 * `runDriverLoop`'s own watch loop polls for (`driver-watch.ts`), alongside
 * a `--cancel` resolution, to decide the driver has genuinely ended rather
 * than merely paused. Never a re-derivation of `MergeableState`, above — a
 * mergeable head can still belong to an open, unpublished pull request.
 */
export type PrOpenState = 'OPEN' | 'MERGED' | 'CLOSED'

export function fetchPrState(prNumber: number): PrOpenState {
  let out: string
  try {
    out = sh('gh', ['pr', 'view', String(prNumber), '--json', 'state'])
  } catch (err) {
    throw new Error(
      `fetchPrState: could not fetch PR #${prNumber}'s state: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  const parsed = JSON.parse(out) as { state?: string }
  return parsed.state === 'MERGED' || parsed.state === 'CLOSED' ? parsed.state : 'OPEN'
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

// --- base-head staleness ------------------------------------------------

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
  'apps/cli/src/lib/dev-review-loop/',
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

// --- worktree head ---------------------------------------------------

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
