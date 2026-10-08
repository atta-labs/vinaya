/**
 * Issue #709, O2 — the ONE shared in-process harness for `devReviewLoop`.
 *
 * `dev-review-loop.test.ts` used to drive every scenario by spawning the
 * whole CLI as a real OS process (`spawnSync('bun', [INDEX, 'dev-review-loop',
 * …])`) with fake `claude`/`gh`/`git` binaries on `$PATH`. The profile
 * (Issue #709, O1) showed that per-round subprocess machinery — the
 * identity-settle `ps` polling, 50-70 real `git`/`gh` fake-binary spawns —
 * is where the file's wall time goes, not the loop logic under test. This
 * harness removes it: it drives `devReviewLoop()` in-process through the
 * `LoopDeps` it already takes, so the same round assessment, publish/pause/
 * resume logic runs against plain in-memory fakes and function calls.
 *
 * ONE mutable in-memory `LoopWorld` backs every fake (the ruling's design):
 * the branch head per push-state, the PR's number and open-state, the gate
 * result, the posted comments, and each role's per-round outcome all live in
 * that one object. Every fake reads from and writes to it, so a state
 * transition such as the head appearing after the Developer's push happens
 * once, in the world (`world.developerPushed = true`), not re-scripted per
 * fixture. A fixture states only how its scenario differs from the default,
 * clean-round-1-to-publish world (`makeWorld({ … })`), then calls
 * `runLoopInProcess(world)`.
 *
 * The driver still writes its real on-disk artifacts — held verdicts, the
 * control store, pause state, the driver lock, logged events — under
 * `world.runtimeDir` (a real temp dir). Those files are genuine, so a test
 * that reads `roundDir(...)/reviewer.md` or the control store reads exactly
 * what the driver wrote, unchanged from the subprocess era. Only the process
 * boundary and the network/`gh`/`git` leaves are faked.
 *
 * The four forge-WRITE operations (`postMarkedComment`, the two pause
 * comments, `publishRound`) are the seam this landed in
 * `apps/cli/src/lib/dev-review-loop.ts` (documented in
 * `apps/cli/specs/loop.md` § "The in-process test seam"): their fakes record
 * to `world.postedComments` instead of shelling out to `gh`.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  devReviewLoop,
  type DriverResult,
  type DriverWatchDeps,
  type LoopDeps,
  type LoopInput,
  type LoopResult,
  runDriverLoop
} from '../../src/lib/dev-review-loop.js'
import { resetDefaultLogSinkContext, resetTrustAnchorConfigMemo } from '../../src/lib/log-sink.js'
import { resetRuntimeDirCache } from '../../src/lib/run-paths.js'
import type { DispatchHandle } from '../../src/lib/dispatch.js'
import type { DeveloperTurnOutput } from '../../src/lib/dev-review-loop/turn-result.js'
import type { DevToolContext } from '../../src/lib/task-tools/dev-tools-server.js'
import {
  pauseMarker,
  renderNoPushStopComment,
  renderPauseComment,
  sanitizePublicPauseDetail
} from '../../src/lib/dev-review-loop/pause-resume.js'
import {
  type DeferredFindingEntry,
  type DeferredFindingsIssueRef,
  markedCommentBody
} from '../../src/lib/forge-write.js'
import {
  DEFAULT_REVIEW_POLICY,
  type IssueSurface,
  objectivesOf,
  objectivesVersion,
  renderObjectives
} from '@attalabs/aeg-core'
import { FIXTURE_REPO, isolatedConfigFixture } from './process-fixture.js'

/** The role output files a fake reviewer/security dispatch writes into its work dir — the exact grammar the real reviewer binary produces. */
export type RoleOutcome = {
  /** One line per finding, or `''` for a clean review. */
  findings: string
  /** `report.txt` body — the role's own report grammar (BRIEF_CONFORMANCE… for reviewer, CONFIG_SCAN/SECRETS for security). */
  report: string
  /** `objectives.txt` body (`O1|MET|done.` by default); pass `null` to write none (an escalation report writes no objectives file). */
  objectives: string | null
  /** The vendor session id this dispatch reports. */
  sessionId: string
  /** When true, the dispatch writes NO artifact files at all — the "a reviewer that wrote nothing" infrastructure-pause scenario. */
  writesNothing?: boolean
}

export const CLEAN_REVIEWER: RoleOutcome = {
  findings: '',
  report: 'BRIEF_CONFORMANCE: yes\nSPEC_CONFORMANCE: yes\nSCOPE: small\nTESTS: pass\nDOCS: n/a\n',
  objectives: 'O1|MET|done.\n',
  sessionId: 'rev-session-1'
}
export const CLEAN_SECURITY: RoleOutcome = {
  findings: '',
  report: 'CONFIG_SCAN: clean\nSECRETS: none found — atta-labs/secret-scan passed\n',
  objectives: 'O1|MET|done.\n',
  sessionId: 'sec-session-1'
}

/** One posted comment, recorded by a forge-write fake in place of a real `gh` post. */
export type PostedComment = { kind: 'issue' | 'pr'; ref: string; marker: string; body: string }

/** One dispatch the fake `dispatchRole` recorded — role, round, and the exact prompt it was handed (dropped before; recorded now so a test can assert the reviewer prompt carries its role doctrine — Traps to avoid). `prompt` is optional so the file-local fakes that predate this recording still type-check. */
/** `cwd` is optional so the many pre-existing fixtures that never inspect it still type-check — it carries `opts.cwd`, the worktree a Developer dispatch is confined to (round 3 Principal ruling: always set, round 1 included, once `createTaskWorktree` runs). */
export type DispatchRecord = { role: string; round: number; resumeId: string | null; prompt?: string; cwd?: string }

export type LoopWorld = {
  task: number
  branch: string
  /** The pushed head sha. `resolveHead` returns it once `developerPushed` is true; before that the branch has no remote head. */
  head: string
  base: string
  mergeBase: string
  prNumber: number
  /** issue-711 O4: the forge's own pull-request state `runDriverLoop`'s watch loop polls (`fetchPrState`) — defaults to `'OPEN'`; a fixture flips it to `'MERGED'`/`'CLOSED'` to drive the driver's own terminal `'ended'` exits. */
  prState: 'OPEN' | 'MERGED' | 'CLOSED'
  /** Flips true the first time the Developer role is dispatched — the head then resolves and the PR opens, exactly as the fake `gh` keyed on `.fake-dev-invoked`. */
  developerPushed: boolean
  /**
   * O2 (issue #919): the branch already exists on the remote (`resolveHead`
   * succeeds) with no push behind it yet — decoupled from `developerPushed`,
   * and from `findOpenPrForBranch` (which stays `null` while this is set), so a
   * fixture can reach the branch-exists-with-no-open-PR sub-case of the
   * round-1 entry, where `afterDeveloperTurnBeforePrPoll` resumes to open the
   * PR and `createTaskWorktree` must NOT fire. Defaults `false`.
   */
  remoteBranchExists: boolean
  /**
   * O3 (#1046): the remote task branch exists but still sits at the DEFAULT
   * BRANCH'S TIP (`world.base`) — the commit-free ref the driver's own round-1
   * `createTaskWorktree` leaves it at BEFORE the first Developer turn, carrying
   * no task commits. While this holds AND nothing has pushed real work yet
   * (`!developerPushed`), `resolveHead` returns `world.base`, never a throw — so
   * the branch is modeled AT THE TIP, never as missing (Traps to avoid), which
   * is the state the round-1 no-push detection must fire on. Set by the fake
   * `createTaskWorktree`, cleared by the fake `pushTaskBranch` (a real push
   * advances the branch beyond the tip). Defaults `false`.
   */
  branchAtBaseTip?: boolean
  /** The developer's local worktree head; defaults to `head` (nothing unpushed). */
  worktreeHead: string
  gate: 'green' | 'red' | 'pending'
  failingCheckRuns: { id: number; name: string; conclusion: string }[]
  /** Each failing run's job-log tail by run id, as `readFailedCheckLogTail` returns it; an absent id reads as an unreadable log (`null`). */
  failedCheckLogTails: Record<number, string>
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  conflictingFiles: string[]
  frozenBrief: string
  objectivesText: string
  sourceRevision: string
  rulings: string[]
  rulingOrdinal: number
  /** The newest principal ruling ordinal on the TASK ISSUE — the baseline a no-pull-request escalation records, read separately from the pull-request one so a fixture can hold a ruling on one and not the other. */
  issueRulingOrdinal: number
  rulingAuthor: string | null
  developerStop: string | null
  /** The PR body `checkPremiseAtHead` reads each round; the default carries only `Closes #<task>` (no `Premise:` block, so the reassert is dormant). */
  prBody: string
  shortstat: string
  /** O2: the `git diff --unified=0` a fixture wants the driver to see between the previous round's head and the current head (`gitUnifiedDiff`); `undefined` (the default) leaves the unchanged-line rule inactive. */
  roundDiff?: string
  /** O3: the task Issue's `## Surface` a fixture wants the driver to resolve (`resolveTaskSurface`); `undefined` (the default) leaves the out-of-Surface rule inactive. */
  surface?: IssueSurface | null
  /** The configured agent-config scanner argv the fake `resolveSecurityScanCommand` returns; `undefined`/`null` (the default) tells the security pass no scanner is configured. */
  securityScanCommand?: readonly string[] | null
  /** The pull request's changed paths the fake `gitChangedPaths` returns, deciding scan applicability; `undefined` (the default) is no changed paths, so a configured scanner reports `not_applicable`. */
  changedPaths?: readonly string[]
  /** The result the fake `runSecurityScanSubprocess` returns when the scan is configured and applicable; `undefined` (the default) is a clean run. */
  securityScanResult?: { ok: true; output: string } | { ok: false; reason: string }
  /** O1/O2: the per-role doctrine the fake `resolveReviewerDoctrine` returns into each reviewer/security prompt; `undefined` (the default) injects no doctrine block. */
  roleDoctrine?: Partial<Record<'reviewer' | 'security', string | null>>
  /** role-reach-v1/2, O1: the developer doctrine the fake `resolveDeveloperDoctrine` prepends to a fresh (non-resumed) developer dispatch; `undefined`/`null` (the default) prepends nothing, the pre-task shape. */
  developerDoctrine?: string | null
  /**
   * Per-round role outcomes; a round with no entry uses the clean default.
   * A role's value may be a single `RoleOutcome` (every attempt in the round
   * gets it, the original shape) or an array — attempt `n` (1-indexed) gets
   * `array[n - 1]`, clamped to the array's last entry once attempts exceed
   * its length. issue-711 O6: this is what lets a fixture write a MISMATCHED
   * `objectives.txt` on attempt 1 and a covering one on attempt 2, proving
   * the one-fresh-retry actually recovers rather than merely re-failing.
   */
  roleOutcomes: Record<
    number,
    {
      reviewer?: RoleOutcome | RoleOutcome[]
      security?: RoleOutcome | RoleOutcome[]
      developer?: { sessionId: string }
    }
  >
  /** The evidence-report outcome the fake `runEvidenceReport` returns. */
  evidenceOutcome: { ok: true; gatesFailed: boolean } | { ok: false; reason: string }
  /**
   * When true, the fake `runEvidenceReport` blocks (yielding) until a reviewer/
   * security dispatch has begun (`reviewerDispatchStarted`), setting
   * `evidenceReportTimedOut` if that never happens within a bounded number of
   * yields. This is the in-process analogue of the spawned rendezvous fixture:
   * it proves the report and the reviewer dispatches genuinely overlap inside
   * the driver's own `Promise.all`, and DEADLOCKS (bounded) if a regression
   * serializes the report ahead of reviewer dispatch.
   */
  blockEvidenceUntilReviewerStarts: boolean
  /** Set the instant a reviewer/security dispatch begins — the rendezvous signal above. */
  reviewerDispatchStarted: boolean
  /** Set if `blockEvidenceUntilReviewerStarts` never observed a reviewer start within its budget. */
  evidenceReportTimedOut: boolean
  // --- developer publication (agent-confinement-v1/1) ---
  /**
   * When true, `<repoRoot>/.worktrees/<branch>` is created so the driver's
   * publication step passes its worktree-existence check and proceeds. Default
   * `false` — the publication step is then a no-op (`existsSync` false), which
   * is why every pre-task fixture that fakes a published turn needs no change.
   */
  worktreeExists?: boolean
  /** What `readWorktreeBranch` returns; default the task `branch`. A fixture sets a different value to exercise the O7 branch check. */
  worktreeBranchName?: string
  /** `readUnpushedWorkDetail().dirtyFiles` — the Developer's uncommitted work; default `[]`. */
  worktreeDirty: string[]
  /** `readUnpushedWorkDetail().aheadCount` — local commits ahead of the remote; default `0`. */
  worktreeAhead: number
  /** `gitWorktreeChangedPaths` — the paths the turn changed, for the O7 Surface check; default `[]`. */
  worktreeChangedPaths: string[]
  /** Added-content diff visible to the pre-publication credential scan; default an empty readable diff. */
  worktreeDiffText: string | null
  /** The sha `commitWorktree` returns and sets the worktree head to; default `sha('c')`. */
  nextCommitSha: string
  /** When set, `pushTaskBranch` refuses with this text (O4); default `null` (the push lands). */
  pushRefusal: string | null
  /** Set true once `openTaskPullRequest` opens the PR; `findOpenPrForBranch` then returns it too. */
  prOpened: boolean
  /** `fetchIssueTitle` — the PR title the publication step uses; default a stable `[task <n>] …`. */
  issueTitle: string
  /** Each commit the driver's publication step made (`commitWorktree`). */
  commits: Array<{ header: string; sha: string }>
  /** Each push the driver's publication step made (`pushTaskBranch`). */
  pushes: Array<{ sha: string }>
  /** Each pull-request open the driver's publication step made (`openTaskPullRequest`). */
  prOpens: Array<{ title: string; body: string }>
  // --- dev-tools (O2–O5): the gate-backed context the driver hosts per turn ---
  /** The `DevToolContext` the loop built this turn — captured by the fake `startDevTools` so a test can drive the agent's tool calls directly (no real bridge exists in-process). `null` until the first dispatch. */
  devToolContext: DevToolContext | null
  /** Each body the agent published through `update_pull_request_body`. */
  prBodyUpdates: string[]
  /** How many times the agent called `refresh_evidence`. */
  evidenceRefreshes: number
  /** How many times the agent called `run_checks`. */
  runChecksCalls: number
  /** The result `run_checks`/`refresh_evidence` report — default a clean pass. */
  runChecksPassed: boolean
  // --- recorded side effects, for assertions ---
  /** O1/O2: each developer branch the loop created on the remote at round-1 start (`createTaskWorktree`) — empty on a start that found the branch already there (an open PR, or a remote branch with none). */
  remoteBranchCreations: string[]
  postedComments: PostedComment[]
  dispatches: DispatchRecord[]
  /** How many times each role was dispatched, cumulative across rounds. */
  dispatchCountByRole: Record<string, number>
  /**
   * The turn result each fake Developer dispatch returns as its native
   * structured output — `undefined` (the default) means a valid `completed`
   * result citing the handoff ids its prompt lists (`defaultDeveloperTurnOutput`).
   * A fixture that tests the controller returns its own, per round and per
   * Developer dispatch of that round (1-based).
   */
  developerTurnOutput?: (round: number, prompt: string, dispatchOfRound: number) => DeveloperTurnOutput | undefined
  publishedRounds: number[]
  /** Each `writeDeferredFindingsIssue` call this run recorded — O1/O3: a publish with deferred findings appends one, a clean publish appends none. */
  deferredIssueWrites: Array<{ prNumber: number; entries: DeferredFindingEntry[] }>
  /** The tracking Issue number the fake `writeDeferredFindingsIssue` returns — stable across calls, modelling one Issue per pull request (O2). */
  deferredIssueNumber: number
  /** The `deferredIssue` ref each `publishRound` was handed — O1: non-empty when the summary was to link the tracking Issue. */
  publishedDeferredIssues: DeferredFindingsIssueRef[]
  evidenceReportCalls: number
  reexecCalls: string[][]
  exitCalls: number[]
  sweepCalls: number[]
  terminateCalls: number[]
  // --- infra ---
  runtimeDir: string
  repoRoot: string
  /** The isolated `$HOME` this run's log sink resolves under — the `home` of the world's own `isolatedConfigFixture` (Issue #833). */
  home: string
  logPath: string
  cleanup: () => void
}

/** A 40-char sha made of one repeated letter, e.g. `sha('a') === 'a'.repeat(40)`. */
function sha(ch: string): string {
  return ch.repeat(40)
}

const tempDirs: string[] = []

/** Every temp dir any world created this file — call in `afterEach`. */
export function cleanupWorlds(): void {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

export const DEFAULT_TASK = 9001

/**
 * Build a world whose default is the shortest real scenario `assessRound`
 * supports: round 1, gate green, both reviewers clean, ends on publish. Pass
 * `overrides` to state only what a scenario changes.
 */
export function makeWorld(overrides: Partial<LoopWorld> = {}): LoopWorld {
  const task = overrides.task ?? DEFAULT_TASK
  // Issue #833: the loop harness runs against an ISOLATED CONFIGURATION — the
  // very same `isolatedConfigFixture` every real-subprocess fixture already
  // uses (`process-fixture.ts`), not a second isolation path. Its working
  // directory holds a `vinaya.config.json` that DECLARES a `logs.folder`, and
  // that declaration is the whole fix: an unattended caller (which `devReviewLoop`
  // marks itself as) whose local config declares a folder can never resolve the
  // DEFAULT BRANCH's `logs.url` server over the trust anchor and deliver fake
  // round events to it — `log-sink.ts`'s `resolveTrustAnchorLogsDestination`
  // refuses a local folder the default branch does not itself declare and falls
  // back to the per-run default folder, never the server. Before this, the
  // harness declared no config at all, so an unattended loop resolved the
  // trust-anchor server (the memoized default-branch config on a CI runner, or
  // a cached real-repo identity) and delivered under the real task's Issue
  // number, next to the fixture's own `${DEFAULT_TASK}` events.
  //
  // `runtimeDir` is the fixture's OWN runtime dir, so the folder the config
  // declares and the default folder an unattended caller falls back to are one
  // place — `<runtimeDir>/logs` — which is exactly where `outboxLines` reads.
  const configFixture = isolatedConfigFixture('vinaya-drl-inproc-')
  tempDirs.push(configFixture.home)
  const runtimeDir = configFixture.runtimeDir
  const repoRoot = configFixture.cwd
  const logDir = tempDir('vinaya-drl-inproc-log-')
  const logPath = join(logDir, `${task}.ndjson`)
  const world: LoopWorld = {
    task,
    branch: `task/dev-review-loop-v1/${task}`,
    head: sha('a'),
    base: sha('b'),
    mergeBase: sha('b'),
    prNumber: 123,
    prState: 'OPEN',
    developerPushed: false,
    remoteBranchExists: false,
    worktreeHead: sha('a'),
    gate: 'green',
    failingCheckRuns: [],
    failedCheckLogTails: {},
    mergeable: 'MERGEABLE',
    conflictingFiles: [],
    frozenBrief:
      '<!-- aeg:brief:v1 -->\nBrief hash: deadbeef\nDo the thing.\n\n## Objectives\n\nO1. Do the thing.\n\n## Planner rationale\n\nOut of scope for facts.\n',
    objectivesText: 'O1. Do the thing.',
    sourceRevision: '(none — pre-task-4 frozen brief)',
    rulings: [],
    rulingOrdinal: 0,
    issueRulingOrdinal: 0,
    rulingAuthor: null,
    developerStop: null,
    prBody: `Closes #${task}`,
    shortstat: ' 2 files changed, 10 insertions(+), 3 deletions(-)',
    roleOutcomes: {},
    worktreeDirty: [],
    worktreeAhead: 0,
    worktreeChangedPaths: [],
    worktreeDiffText: '',
    nextCommitSha: sha('c'),
    pushRefusal: null,
    prOpened: false,
    issueTitle: `[task ${task}] do the thing`,
    commits: [],
    pushes: [],
    prOpens: [],
    devToolContext: null,
    prBodyUpdates: [],
    evidenceRefreshes: 0,
    runChecksCalls: 0,
    runChecksPassed: true,
    remoteBranchCreations: [],
    evidenceOutcome: { ok: true, gatesFailed: false },
    blockEvidenceUntilReviewerStarts: false,
    reviewerDispatchStarted: false,
    evidenceReportTimedOut: false,
    postedComments: [],
    dispatches: [],
    dispatchCountByRole: {},
    publishedRounds: [],
    deferredIssueWrites: [],
    deferredIssueNumber: 7777,
    publishedDeferredIssues: [],
    evidenceReportCalls: 0,
    reexecCalls: [],
    exitCalls: [],
    sweepCalls: [],
    terminateCalls: [],
    runtimeDir,
    repoRoot,
    home: configFixture.home,
    logPath,
    cleanup: cleanupWorlds,
    ...overrides
  }
  // A fixture that exercises the driver's publication step needs the task
  // worktree to exist (the step's own `existsSync` guard) — create it here so
  // the real `existsSync(<repoRoot>/.worktrees/<branch>)` the driver runs finds it.
  if (world.worktreeExists) {
    mkdirSync(join(repoRoot, '.worktrees', world.branch), { recursive: true })
  }
  return world
}

function roleOutcomeFor(world: LoopWorld, role: 'reviewer' | 'security', round: number, attempt: number): RoleOutcome {
  const configured = world.roleOutcomes[round]?.[role]
  if (!configured) return role === 'reviewer' ? CLEAN_REVIEWER : CLEAN_SECURITY
  if (!Array.isArray(configured)) return configured
  return configured[Math.min(attempt, configured.length) - 1]!
}

function writeRoleArtifacts(workDir: string, outcome: RoleOutcome): void {
  mkdirSync(workDir, { recursive: true })
  writeFileSync(join(workDir, 'findings.txt'), outcome.findings)
  writeFileSync(join(workDir, 'report.txt'), outcome.report)
  if (outcome.objectives !== null) writeFileSync(join(workDir, 'objectives.txt'), outcome.objectives)
}

function handle(resumeId: string | null, effectId: string, turnOutput?: DeveloperTurnOutput): DispatchHandle {
  return {
    exitCode: 0,
    durationMs: 1,
    usage: { input: 10, output: 5 },
    resumeId,
    timedOut: false,
    effectId,
    ...(turnOutput !== undefined ? { turnOutput } : {})
  }
}

/** A `completed` turn result as Claude's adapter would hand it over. */
export function completedTurnOutput(
  fields: { summary?: string; confidence?: number; explanation?: string; addressedFindingIds?: string[] } = {}
): DeveloperTurnOutput {
  return {
    adapter: 'claude --json-schema',
    event: 'result (subtype success) .structured_output',
    raw: {
      turnResult: {
        schemaVersion: 1,
        status: 'completed',
        summary: fields.summary ?? 'fixture turn',
        confidence: fields.confidence ?? 90,
        confidenceExplanation: fields.explanation ?? 'the fixture work is done',
        addressedFindingIds: fields.addressedFindingIds ?? [],
        sourceUses: null,
        reportedChecks: null
      }
    }
  }
}

/** The finding ids a prompt lists for the Developer to cite (`- R1-CR-1: …` in a findings prompt, `- R1-CR-1` in a correction). */
export function handoffIdsInPrompt(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(/^- (R\d+-(?:CR|SEC)-\d+)(?::|$)/gm)].map((m) => m[1]!))]
}

/** The default fake Developer's turn result: `completed`, confidence 90, citing every handoff id its prompt lists. */
export function defaultDeveloperTurnOutput(prompt: string): DeveloperTurnOutput {
  return completedTurnOutput({ addressedFindingIds: handoffIdsInPrompt(prompt) })
}

/** The fake Developer's turn result for this dispatch — the world's own when it names one, else the default. */
export function fakeDeveloperTurnOutput(world: LoopWorld, round: number, prompt: string): DeveloperTurnOutput {
  const n = world.dispatches.filter((d) => d.role === 'developer' && d.round === round).length
  return world.developerTurnOutput?.(round, prompt, n) ?? defaultDeveloperTurnOutput(prompt)
}

/**
 * A complete `LoopDeps` whose every fake reads from and writes to `world`.
 * Poll intervals are near-zero (`assessRound`'s retry COUNT is the behaviour
 * under test, never the wall-clock gap between polls — Issue #709's profile).
 */
export function makeInProcessDeps(world: LoopWorld): Partial<LoopDeps> {
  let dispatchSeq = 0
  return {
    dispatchRole: async (role, _agent, prompt, opts): Promise<DispatchHandle> => {
      const round = opts.round ?? 1
      world.dispatchCountByRole[role] = (world.dispatchCountByRole[role] ?? 0) + 1
      if (role === 'developer') {
        world.developerPushed = true
        const sessionId = world.roleOutcomes[round]?.developer?.sessionId ?? 'dev-session-1'
        world.dispatches.push({ role, round, resumeId: sessionId, prompt, cwd: opts.cwd })
        return handle(sessionId, `eff-dev-${++dispatchSeq}`, fakeDeveloperTurnOutput(world, round, prompt))
      }
      // code-reviewer | security: write the role's artifacts into the work
      // dir the loop granted it (`extraWritableDirs[0]` — see
      // `dispatchReviewer` in dev-review-loop.ts).
      world.reviewerDispatchStarted = true
      const workDir = opts.extraWritableDirs?.[0]
      const reviewRole = role === 'code-reviewer' ? 'reviewer' : 'security'
      const attempt = world.dispatches.filter((d) => d.role === role && d.round === round).length + 1
      const outcome = roleOutcomeFor(world, reviewRole, round, attempt)
      if (workDir && !outcome.writesNothing) writeRoleArtifacts(workDir, outcome)
      world.dispatches.push({ role, round, resumeId: outcome.sessionId, prompt })
      return handle(outcome.sessionId, `eff-${reviewRole}-${++dispatchSeq}`)
    },
    // issue #945: the policy read is injected here to the built-in defaults, so
    // an in-process run neither reaches the real `gh api` trust-anchor read (a
    // live network round-trip, 404 → defaults, per in-process test) nor depends
    // on it resolving. A fixture exercising a FAILED read overrides this with a
    // throwing `reviewPolicy`; one exercising a custom policy overrides it with
    // its own value.
    reviewPolicy: () => DEFAULT_REVIEW_POLICY,
    // O1/O2: default to the world's own per-role doctrine (a fixture states its
    // own; the default is `null` — no doctrine injected, the pre-task shape).
    resolveReviewerDoctrine: async (role) => world.roleDoctrine?.[role] ?? null,
    // role-reach-v1/2, O1: default to the world's own developer doctrine (a
    // fixture states its own; the default is `null` — nothing prepended, the
    // pre-task shape).
    resolveDeveloperDoctrine: async () => world.developerDoctrine ?? null,
    resolveHead: (_branch) => {
      // O3 (#1046): the branch sits at the default branch's tip — the
      // commit-free ref the driver created before round 1 — until a real push
      // advances it beyond the tip (`pushTaskBranch` clears
      // `branchAtBaseTip`) or a fixture models the push with `developerPushed`.
      // Returns `world.base` (the tip), NEVER a throw: the branch EXISTS, it
      // just carries no task commits yet. This is what the round-1 no-push
      // detection fires on, modeled at the tip rather than as a missing branch.
      if (world.branchAtBaseTip && !world.developerPushed) return world.base
      // The branch resolves once the Developer has pushed, OR when a fixture
      // declares the remote branch already exists with no push behind it yet
      // (`remoteBranchExists`) — the latter reaches O2's branch-exists-with-no-
      // open-PR sub-case, kept independent of `findOpenPrForBranch`.
      if (!world.developerPushed && !world.remoteBranchExists)
        throw new Error('resolveHead: branch has no head on origin yet (in-process fake)')
      return world.head
    },
    fetchCiConclusion: (_head) => world.gate,
    fetchFailingCheckRuns: (_head) => world.failingCheckRuns.map((c) => ({ ...c })) as never,
    readFailedCheckLogTail: (jobId) => world.failedCheckLogTails[jobId] ?? null,
    fetchRulings: (_pr) => [...world.rulings],
    fetchNewestRulingOrdinal: (_pr) => world.rulingOrdinal,
    fetchNewestRulingAuthor: (_pr) => world.rulingAuthor,
    fetchNewestIssueRulingOrdinal: (_issue) => world.issueRulingOrdinal,
    fetchFrozenBrief: (_issue) => world.frozenBrief,
    resolveIssueObjectives: (_issue) => {
      // Parse the world's frozen brief with the REAL parser so a held
      // verdict's `Objectives version:`/`O<n>: MET` lines carry the same
      // version and objective list the production resolver would produce.
      const parsed = objectivesOf(world.frozenBrief)
      const objectives = parsed.ok ? parsed.objectives : []
      return {
        text: objectives.length > 0 ? renderObjectives(objectives) : '',
        version: objectives.length > 0 ? objectivesVersion(objectives) : null,
        edit: null,
        objectives
      } as never
    },
    fetchSourceRevision: (_issue) => world.sourceRevision,
    developerBranchFor: (_n) => world.branch,
    // Stubbed READY by default — no in-process fixture's fake branch
    // resolves on a real forge, so the real implementation (which shells
    // out to `check-dispatch-readiness.ts`/`verify-dispatch.ts`) would fail
    // every fixture's dispatch before it ever reaches `dispatchRole`. A
    // fixture exercising a NOT READY gate overrides this with its own
    // `{ready: false, ...}`.
    checkTaskDispatchReadiness: (_branch) => ({ ready: true, output: 'stubbed ready — in-process fixture' }),
    findOpenPrForBranch: (branch) =>
      world.developerPushed || world.prOpened ? { number: world.prNumber, branch } : null,
    fetchIssueTitle: (_issue) => world.issueTitle,
    // O1/O2: record the round-1 worktree/remote-branch creation so a test can
    // assert it fires exactly on the genuinely-fresh path and never on an
    // attach/reentry.
    createTaskWorktree: (branch: string) => {
      world.remoteBranchCreations.push(branch)
      // O3 (#1046): the driver creates `.worktrees/<branch>` and pushes the
      // branch to the remote AT `origin/main`'s tip — a commit-free ref —
      // before the first Developer turn. Model exactly that: the remote branch
      // now EXISTS (never missing) and sits at the default branch's tip, so the
      // round-1 no-push detection fires on that state rather than on a stubbed
      // missing branch (Traps to avoid). A real push later clears
      // `branchAtBaseTip` (`pushTaskBranch`).
      world.remoteBranchExists = true
      world.branchAtBaseTip = true
    },
    readResumeRecord: () => null,
    runtimeDir: () => world.runtimeDir,
    repoRoot: () => world.repoRoot,
    gitRevParseOriginMain: () => world.base,
    gitIsAncestor: (ancestor, descendant) => ancestor === descendant,
    gitMergeBase: async (_head) => world.mergeBase,
    gitFetch: () => {},
    gitDiffShortstat: (_base, _head) => world.shortstat,
    // O2/O3: both deferral-rule inputs default to inactive here — the loop's
    // pre-task behaviour (every in-Surface finding blocks). A fixture
    // exercising the unchanged-line or out-of-Surface rule sets `world.roundDiff`
    // / `world.surface`; a test that stubs neither sees no deferral at all.
    gitUnifiedDiff: (_from, _to) => world.roundDiff ?? null,
    resolveTaskSurface: (_task) => world.surface ?? null,
    // The agent-config scan's three deps, wired
    // to the world so an in-process fixture drives the scan without a real
    // trust-anchor fetch, a real `git diff`, or a spawned scanner. The defaults
    // (no command, no changed paths) make every round's scan `not_configured` —
    // the loop's pre-task behaviour, save the one new "no scanner configured"
    // line the security prompt now always carries. A fixture sets
    // `world.securityScanCommand` + `world.changedPaths` to exercise a real ran/
    // not-applicable/failed decision.
    resolveSecurityScanCommand: () => world.securityScanCommand ?? null,
    gitChangedPaths: (_base, _head) => world.changedPaths ?? [],
    runSecurityScanSubprocess: (_command, _cwd) =>
      world.securityScanResult ?? { ok: true, output: '(fake scan: clean)' },
    fetchLoopHistory: (_pr) => ({ rounds: [], totalWallMs: 0, totalFilesChanged: 0, journalFinalized: null }) as never,
    // A real (but minimal) yield, never an instant no-op: `logEvents`' own
    // wait-for-landing busy-loops on `sleep`, and the log sink flushes its
    // file write on a macrotask — an `async () => {}` that never yields the
    // event loop would starve that flush and force every event to wait out
    // its full 5s bound (Issue #709: the whole point is that these run fast).
    sleep: (ms) => new Promise((r) => setTimeout(r, ms > 0 ? 1 : 0)),
    now: () => Date.now(),
    prPollMaxAttempts: 3,
    prPollIntervalMs: 1,
    gatePollMaxAttempts: 3,
    gatePollIntervalMs: 1,
    readWorktreeHead: (_worktreePath) => (world.worktreeExists || world.developerPushed ? world.worktreeHead : null),
    readUnpushedWorkDetail: (_worktreePath) => ({
      dirtyFiles: [...world.worktreeDirty],
      aheadCount: world.worktreeAhead
    }),
    // --- developer publication (agent-confinement-v1/1) ---
    readWorktreeBranch: (_worktreePath) => world.worktreeBranchName ?? world.branch,
    gitWorktreeChangedPaths: (_worktreePath, _base) => [...world.worktreeChangedPaths],
    readMergedDefaultCommit: () => null,
    // This fake world never models diff CONTENT, only changed-path lists —
    // the O1/O2 after-turn credential scan then simply has nothing to read
    // from the worktree side in a harness-driven test, the same fidelity
    // level every other content-shaped (not path-shaped) git read already
    // has here.
    gitWorktreeDiffText: (_worktreePath, _base) => world.worktreeDiffText,
    buildVendoredCliIfMissing: () => {},
    commitWorktree: (_worktreePath, header) => {
      const commitSha = world.nextCommitSha
      world.commits.push({ header, sha: commitSha })
      // The commit clears the uncommitted work and advances the worktree head;
      // the branch now sits one commit ahead of the remote, awaiting the push.
      world.worktreeDirty = []
      world.worktreeHead = commitSha
      world.worktreeAhead = world.worktreeAhead + 1
      return { ok: true, sha: commitSha }
    },
    validatePrBodyForCreate: async () => [],
    pushTaskBranch: (input) => {
      if (world.pushRefusal !== null) return { ok: false, refusal: world.pushRefusal, hook: true }
      world.pushes.push({ sha: input.sha })
      // The push lands: the remote head is now the pushed sha, the branch is no
      // longer ahead, and the branch resolves on the remote. O3 (#1046): a real
      // push advances the branch beyond the default tip, so it no longer sits at
      // that commit-free ref — `resolveHead` returns the pushed sha, not base.
      world.head = input.sha
      world.worktreeAhead = 0
      world.remoteBranchExists = true
      world.branchAtBaseTip = false
      return { ok: true }
    },
    openTaskPullRequest: (input) => {
      world.prOpens.push({ title: input.title, body: input.body })
      world.prOpened = true
      return world.prNumber
    },
    // --- dev-tools (O2–O5): the driver-run server's seams, forge faked, gates
    // real inside the captured `context` ---
    startDevTools: async ({ context }) => {
      // No real agent (hence no bridge) runs in-process — capture the
      // gate-backed context so a test drives the agent's tool calls directly.
      world.devToolContext = context
      return { bridge: { command: 'fake-dev-bridge', args: [] }, close: async () => {} }
    },
    updatePrBody: async ({ body }) => {
      world.prBodyUpdates.push(body)
      world.prBody = body
    },
    refreshPrEvidence: async () => {
      world.evidenceRefreshes += 1
      return { head: world.head, checksPassed: world.runChecksPassed, evidence: 'fake-evidence-block' }
    },
    readPrView: async () => ({
      prNumber: world.prOpened ? world.prNumber : null,
      state: world.prOpened ? 'OPEN' : null,
      head: world.head,
      checks: null,
      reviews: null,
      body: world.prBody,
      failedChecks: []
    }),
    runWorktreeChecks: async () => {
      world.runChecksCalls += 1
      return { passed: world.runChecksPassed, output: 'fake-check-all-output' }
    },
    fetchPrBody: (_pr) => world.prBody,
    fetchDeveloperStop: (_issue) =>
      (world.dispatchCountByRole.developer ?? 0) === 0 || world.developerStop === null
        ? null
        : { body: world.developerStop, identity: 'new-stop-1' },
    fetchMergeableState: (_pr) => world.mergeable,
    fetchConflictingFiles: (_head, _base) => [...world.conflictingFiles],
    gitCommitsTouchingDriverPaths: (_a, _b) => [],
    pullDefaultBranch: () => ({ ok: true }),
    reexecSelf: (args) => {
      world.reexecCalls.push([...args])
      return 0
    },
    exitProcess: ((code: number) => {
      world.exitCalls.push(code)
      throw new InProcessExit(code)
    }) as never,
    runEvidenceReport: async (_pr, _cwd, _branch) => {
      world.evidenceReportCalls += 1
      if (world.blockEvidenceUntilReviewerStarts) {
        let i = 0
        while (!world.reviewerDispatchStarted && i < 200) {
          await new Promise((r) => setTimeout(r, 1))
          i++
        }
        if (!world.reviewerDispatchStarted) world.evidenceReportTimedOut = true
      }
      return world.evidenceOutcome
    },
    terminateInFlightLaunchesOnShutdown: (_task) => {
      world.terminateCalls.push(_task)
    },
    sweepTasksAtStart: async (task) => {
      world.sweepCalls.push(task)
    },
    postMarkedComment: (kind, ref, marker, body) => {
      world.postedComments.push({ kind, ref, marker, body })
      return `https://github.com/example/repo/${kind}/${ref}#issuecomment-${world.postedComments.length}`
    },
    postPauseComment: (_task, _round, _head, prNumber, reason, detail, invocation) => {
      // Render the REAL marked body (sanitize → marker → renderPauseComment →
      // markedCommentBody) — the same pure pipeline production `postPauseComment`
      // runs before its `gh` post. Only the network post and the control-store
      // idempotency record are skipped, so a test asserting on the posted pause
      // comment's marker/detail/shape reads exactly what the forge would receive.
      const publicDetail = detail === undefined ? undefined : sanitizePublicPauseDetail(detail)
      const marker = pauseMarker(reason)
      const body = markedCommentBody(marker, renderPauseComment(prNumber, reason, publicDetail, invocation))
      world.postedComments.push({ kind: 'pr', ref: String(prNumber), marker, body })
      return { posted: true, url: 'https://example/pause', attempts: 1 } as never
    },
    postIssuePauseComment: (task, branch, _round, reason, detail, invocation, rulingOrdinal) => {
      const publicDetail = detail === undefined ? undefined : sanitizePublicPauseDetail(detail)
      const marker = pauseMarker(reason)
      const body = markedCommentBody(
        marker,
        renderNoPushStopComment(task, branch, reason, publicDetail, invocation, rulingOrdinal)
      )
      world.postedComments.push({ kind: 'issue', ref: String(task), marker, body })
      return { posted: true, url: 'https://example/issue-pause', attempts: 1 } as never
    },
    writeDeferredFindingsIssue: (input) => {
      // Record the call (O1/O3) and return a STABLE number, so a second
      // publication of the same world resolves the same Issue (O2) — the real
      // find-by-marker idempotency is unit-tested against `forge-write.ts`.
      world.deferredIssueWrites.push({ prNumber: input.prNumber, entries: input.entries })
      return { issue: world.deferredIssueNumber }
    },
    publishRound: (_root, input) => {
      world.publishedRounds.push(input.round)
      if (input.deferredIssue) world.publishedDeferredIssues.push(input.deferredIssue)
      // Record the same three comments the real publishRound posts, in order,
      // so a test asserting the published sequence still sees it. The real
      // publishRound's own posted-comment re-fetch + manifest re-binding
      // self-check is process/forge behaviour — a test whose subject is THAT
      // keeps a real process (see the reason lines in dev-review-loop.test.ts).
      world.postedComments.push({ kind: 'pr', ref: String(input.prNumber), marker: 'reviewer-verdict', body: '' })
      world.postedComments.push({ kind: 'pr', ref: String(input.prNumber), marker: 'security-verdict', body: '' })
      world.postedComments.push({ kind: 'pr', ref: String(input.prNumber), marker: 'summary', body: '' })
    }
  }
}

/**
 * agent-confinement-v1 — deps whose Developer dispatch dirties the worktree
 * (sets `worktreeDirty`/`worktreeChangedPaths`) but NEVER calls a driver-run
 * publishing tool, then returns. The driver no longer commits, pushes or opens
 * on the Developer's behalf, so the work stays unpublished — the driver detects
 * it and re-asks the session to call `publish_changes` (O4). Pair with
 * `makeWorld({ worktreeExists: true })`.
 */
export function developerLeavesWorkDeps(
  world: LoopWorld,
  opts: {
    changedPaths?: string[]
    /** When true, the Developer "commits" itself (advances the worktree head) — the head-check violation. */
    developerCommits?: boolean
  } = {}
): Partial<LoopDeps> {
  const base = makeInProcessDeps(world)
  let devSeq = 0
  return {
    ...base,
    dispatchRole: async (role, agent, prompt, dOpts) => {
      if (role !== 'developer') return base.dispatchRole!(role, agent, prompt, dOpts)
      const round = dOpts.round ?? 1
      devSeq += 1
      world.dispatchCountByRole.developer = (world.dispatchCountByRole.developer ?? 0) + 1
      const changed = opts.changedPaths ?? ['apps/cli/src/lib/x.ts']
      world.worktreeDirty = [...changed]
      world.worktreeChangedPaths = [...changed]
      if (opts.developerCommits) world.worktreeHead = sha('z')
      world.dispatches.push({ role, round, resumeId: 'dev-session-1', prompt })
      return handle('dev-session-1', `eff-dev-${devSeq}`, fakeDeveloperTurnOutput(world, round, prompt))
    }
  }
}

/**
 * O4/O5: a Developer that publishes through the driver-run tools, the way a
 * real agent does — its dispatch calls the gate-backed `DevToolContext` the
 * driver captured into `world.devToolContext` this turn (every gate real, the
 * forge faked by `makeInProcessDeps`). `publish_changes` commits+pushes the
 * dirty work; `open_pull_request` opens the PR when none is open; a body-only
 * turn (`bodyOnly`) instead calls `update_pull_request_body` + `refresh_evidence`.
 */
export function developerPublishesViaToolsDeps(
  world: LoopWorld,
  opts: {
    changedPaths?: string[]
    header?: string
    body?: string
    /** A body-only turn: publish a new body through the tools, touch no code. */
    bodyOnly?: boolean
  } = {}
): Partial<LoopDeps> {
  const base = makeInProcessDeps(world)
  let devSeq = 0
  return {
    ...base,
    dispatchRole: async (role, agent, prompt, dOpts) => {
      if (role !== 'developer') return base.dispatchRole!(role, agent, prompt, dOpts)
      const round = dOpts.round ?? 1
      devSeq += 1
      world.dispatchCountByRole.developer = (world.dispatchCountByRole.developer ?? 0) + 1
      const ctx = world.devToolContext
      if (ctx) {
        if (opts.bodyOnly) {
          const updated = await ctx.updatePullRequestBody(
            opts.body ?? '## Decisions\n\nNone.\n\n## Scope\n\n**Tier:** 1\n'
          )
          if (!updated.ok) throw new Error(`update_pull_request_body refused: ${updated.error.output}`)
          const refreshed = await ctx.refreshEvidence()
          if (!refreshed.ok) throw new Error(`refresh_evidence refused: ${refreshed.error.output}`)
        } else {
          const changed = opts.changedPaths ?? ['apps/cli/src/lib/x.ts']
          world.worktreeDirty = [...changed]
          world.worktreeChangedPaths = [...changed]
          const published = await ctx.publishChanges(opts.header ?? 'Feat(cli): publish via the driver-run tools')
          // Open the PR only when the publish actually landed — a gate refusal
          // (e.g. a Surface violation) leaves nothing to open.
          if (published.ok && !world.prOpened) {
            await ctx.openPullRequest(
              world.issueTitle,
              opts.body ?? '## Decisions\n\nNone.\n\n## Scope\n\n**Tier:** 1\n'
            )
          }
        }
      }
      world.dispatches.push({ role, round, resumeId: 'dev-session-1', prompt })
      return handle('dev-session-1', `eff-dev-${devSeq}`, fakeDeveloperTurnOutput(world, round, prompt))
    }
  }
}

/**
 * agent-confinement-v1: a Developer that calls `publish_changes` TWICE in one
 * turn, each time on a fresh change with its own commit sha. The second publish
 * only lands if the driver advanced the recorded pre-turn head after the first
 * push (else `checkPublicationPreconditions` sees the first commit as a moved
 * head and refuses) — so a test asserting two commits and two pushes proves a
 * Developer may publish more than once per turn.
 */
export function developerPublishesTwiceViaToolsDeps(world: LoopWorld): Partial<LoopDeps> {
  const base = makeInProcessDeps(world)
  let devSeq = 0
  return {
    ...base,
    dispatchRole: async (role, agent, prompt, dOpts) => {
      if (role !== 'developer') return base.dispatchRole!(role, agent, prompt, dOpts)
      const round = dOpts.round ?? 1
      devSeq += 1
      world.dispatchCountByRole.developer = (world.dispatchCountByRole.developer ?? 0) + 1
      const ctx = world.devToolContext
      if (ctx) {
        // First publish: a commit+push of the first change.
        world.worktreeDirty = ['apps/cli/src/lib/x.ts']
        world.worktreeChangedPaths = ['apps/cli/src/lib/x.ts']
        world.nextCommitSha = sha('c')
        const first = await ctx.publishChanges('Feat(cli): first publish of the turn')
        // A SECOND publish in the SAME turn: a fresh change on top of the first,
        // with its own commit sha so the push genuinely advances the head.
        world.worktreeDirty = ['apps/cli/src/lib/y.ts']
        world.worktreeChangedPaths = ['apps/cli/src/lib/x.ts', 'apps/cli/src/lib/y.ts']
        world.nextCommitSha = sha('d')
        const second = await ctx.publishChanges('Feat(cli): second publish of the turn')
        if (first.ok && second.ok && !world.prOpened) {
          await ctx.openPullRequest(world.issueTitle, '## Decisions\n\nNone.\n\n## Scope\n\n**Tier:** 1\n')
        }
      }
      world.dispatches.push({ role, round, resumeId: 'dev-session-1', prompt })
      return handle('dev-session-1', `eff-dev-${devSeq}`, fakeDeveloperTurnOutput(world, round, prompt))
    }
  }
}

/** Thrown by the fake `exitProcess` so a test can observe "the driver would hand off here" without killing the test process. */
export class InProcessExit extends Error {
  constructor(public readonly code: number) {
    super(`in-process exitProcess(${code})`)
  }
}

/**
 * The environment keys that must name THIS run's own isolated world rather
 * than the outer (possibly dispatched) process's real identity: the runtime
 * dir (drives both the loop's own files and the log sink's destination), and
 * the per-run identity keys that would otherwise leak from a real dispatched
 * session into the loop's own resolution.
 *
 * `withWorldEnv` SETS the three in `WORLD_ENV_SET_KEYS` to this world's own
 * isolated values and CLEARS the rest for the duration of the call. `AEG_REPO`
 * is set (Issue #833) rather than cleared: pinned to `FIXTURE_REPO`, it gives
 * the log sink a deterministic repo segment and keeps the trust-anchor read off
 * any real repository, alongside the isolated `$HOME` (see `withWorldEnv`).
 */
const OWNED_ENV_KEYS = [
  'VINAYA_RUNTIME_DIR',
  'VINAYA_TASK',
  'VINAYA_ROUND',
  'VINAYA_RUN',
  'VINAYA_RUN_ID',
  'AEG_REPO',
  'GITHUB_REPOSITORY',
  // What the log path reads to decide where a line goes and whose it is: a
  // CI runner sets `GITHUB_ACTIONS`, a dispatched session sets the rest. Left
  // in place, the same test resolves a different log destination on a CI
  // runner than on a laptop, and passes on one while failing on the other.
  'GITHUB_ACTIONS',
  'VINAYA_HOST',
  'VINAYA_ROLE',
  'VINAYA_ATTEMPT',
  'VINAYA_PARENT_EVENT'
] as const

/** The `OWNED_ENV_KEYS` `withWorldEnv` SETS to this world's own values; every other owned key is cleared. */
const WORLD_ENV_SET_KEYS = new Set<string>(['VINAYA_RUNTIME_DIR', 'VINAYA_TASK', 'AEG_REPO'])

/**
 * Run `devReviewLoop` in-process against `world`. Defaults to a `--task`
 * start on the world's own task. `overrides` replaces individual fakes for a
 * scenario the world's own fields do not model (a forge read that fails once,
 * a post that throws); every other dependency stays the world-backed fake.
 *
 * The isolated world's runtime dir, task, repo identity, `$HOME` and working
 * directory are all pointed at this run for the duration of the call and
 * restored unconditionally in `finally` — see `withWorldEnv` for how that
 * isolation is composed (Issue #833) and why a working directory alone was not
 * enough to keep the loop's events off the configured server.
 */
export async function runLoopInProcess(
  world: LoopWorld,
  input: LoopInput = { task: world.task, agent: 'claude' },
  overrides: Partial<LoopDeps> = {}
): Promise<LoopResult> {
  return withWorldEnv(world, () => devReviewLoop(input, { ...makeInProcessDeps(world), ...overrides }))
}

/**
 * issue-711 O4 — the SAME in-process world driving `runDriverLoop` (the
 * watching driver) instead of a single `devReviewLoop` pass: every resume
 * attempt the watcher makes goes back through `makeInProcessDeps(world)`
 * merged with `overrides`, exactly like `runLoopInProcess`. `watchOverrides`
 * defaults `fetchPrState` to `world.prState` and both poll intervals to
 * near-zero (the same "the retry COUNT is under test, never the wall-clock
 * gap" reasoning `makeInProcessDeps`'s own doc comment states for
 * `prPollIntervalMs`/`gatePollIntervalMs`) — a fixture overriding `sleep`
 * itself (to mutate `world` mid-wait, simulating an external ruling/cancel/
 * merge arriving while this driver watches) still goes through those fast
 * defaults for every OTHER `DriverWatchDeps` field it doesn't itself set.
 */
export async function runDriverLoopInProcess(
  world: LoopWorld,
  input: LoopInput = { task: world.task, agent: 'claude' },
  overrides: Partial<LoopDeps> = {},
  watchOverrides: Partial<DriverWatchDeps> = {}
): Promise<DriverResult> {
  const loopDeps: Partial<LoopDeps> = { ...makeInProcessDeps(world), ...overrides }
  return withWorldEnv(world, () =>
    runDriverLoop(input, loopDeps, {
      fetchPrState: (_pr) => world.prState,
      // The same open-pull-request read the loop itself is given — how a
      // pause recorded before any pull request finds the one opened since.
      findOpenPrForBranch: (branch) => loopDeps.findOpenPrForBranch!(branch),
      // Same world-backed fake `makeInProcessDeps` gives `LoopDeps` — a
      // fixture that mutates `world.rulingOrdinal` mid-watch (simulating
      // a Principal ruling posted while this driver waits) needs the
      // WATCHER's own ruling read to see it too, never the real `gh`.
      fetchNewestRulingOrdinal: (_pr) => world.rulingOrdinal,
      watchPollIntervalMs: 1,
      infrastructureBackoffMs: 1,
      // Never the real `gh api rate_limit` — no reset reported, so the wait is the fixed fallback.
      readRateLimitReset: async () => null,
      ...watchOverrides
    })
  )
}

/**
 * Runs `fn` with this world's runtime directory, task, repo identity, `$HOME`
 * and working directory in place, then restores all of them. `runLoopInProcess`
 * uses it; so does a test driving another loop entry point
 * (`cancelDevReviewLoop`) in-process.
 *
 * Isolation has two halves, both this world's own (Issue #833):
 *
 *  - **Working directory** — `world.repoRoot` is the world's own
 *    `isolatedConfigFixture` cwd, a non-git dir holding a `vinaya.config.json`
 *    that DECLARES a `logs.folder`. That declaration is what stops an
 *    unattended `devReviewLoop` from resolving the DEFAULT BRANCH's `logs.url`
 *    server over the trust anchor: `resolveTrustAnchorLogsDestination` refuses a
 *    local folder the default branch does not declare and falls back to the
 *    default folder, never the server (`apps/cli/specs/log.md` § The
 *    destination). A working directory alone never closed this — an unattended
 *    caller with NO local `logs` setting still honours whatever the default
 *    branch declares, so before this the harness delivered fake round events to
 *    the real server under the checked-out task's own Issue number.
 *  - **Identity/`$HOME`** — `AEG_REPO` is pinned to `FIXTURE_REPO` and `$HOME`
 *    to `world.home` (the fixture's own), so the log sink's repo segment, its
 *    default folder and its retry queue all resolve under this world's own
 *    tree, never the real machine's `~/.vinaya`. `VINAYA_RUNTIME_DIR` is the
 *    fixture's own runtime dir, so the declared folder and the default folder an
 *    unattended caller falls back to are the same `<runtimeDir>/logs` place
 *    `outboxLines` reads. The remaining owned keys are cleared for the same
 *    reason a spawned fixture's env strips them.
 *
 * All of it is restored unconditionally in `finally` (Issue #709 Traps to
 * avoid: an in-process test that mutates `process.env`/cwd and does not restore
 * leaks into every later test).
 */
export async function withWorldEnv<T>(world: LoopWorld, fn: () => Promise<T> | T): Promise<T> {
  const saved: Record<string, string | undefined> = {}
  for (const key of OWNED_ENV_KEYS) saved[key] = process.env[key]
  const savedHome = process.env.HOME
  const savedCwd = process.cwd()
  process.env.VINAYA_RUNTIME_DIR = world.runtimeDir
  process.env.VINAYA_TASK = String(world.task)
  process.env.AEG_REPO = FIXTURE_REPO
  process.env.HOME = world.home
  for (const key of OWNED_ENV_KEYS) {
    if (!WORLD_ENV_SET_KEYS.has(key)) delete process.env[key]
  }
  process.chdir(world.repoRoot)
  // `loopsRoot()`/`runtimeDirForThisRepo()` memoizes its runtime-dir
  // resolution process-wide; drop it so the driver log for THIS run resolves
  // under THIS world's `VINAYA_RUNTIME_DIR` rather than a prior run's
  // (already-cleaned) temp dir. Reset again in `finally` so a later
  // subprocess-based test in the same file never reads a stale in-process
  // resolution.
  resetRuntimeDirCache()
  // The trust-anchor config is memoized process-wide the same way, and decides
  // something this harness reads back directly: whether an unattended `log()`
  // delivers to a configured log server or to this world's own folder. One
  // `bun:test` process runs many files, so a file that reached an unattended
  // `log()` from THIS repository's checkout first (`forge-write.test.ts`, live)
  // leaves the answer "a `logs.url` server is configured" cached, and every
  // fixture world after it writes its journal to that destination instead of
  // the folder `outboxLines` reads — the events vanish for no reason but which
  // file ran before this one. Dropped here and again in `finally`, exactly as
  // the runtime-dir memo is, so a world's own config is what decides its
  // destination whatever ran first.
  resetTrustAnchorConfigMemo()
  // The bare default sink's own `context()` resolution (repo/doctrine/
  // destination) is memoized for its whole process life too, with no
  // per-repository key the way the trust-anchor memo above has — a direct
  // caller of the module-level `log()` (`pause-resume.ts`'s
  // `writeEscalationRecord`/`resolveEscalation`, among others) would
  // otherwise have its SECOND isolated world silently reuse the first
  // world's already-torn-down destination. Same "reset on entry and again
  // in `finally`" shape as the two resets above.
  resetDefaultLogSinkContext()
  try {
    return await fn()
  } finally {
    resetRuntimeDirCache()
    resetTrustAnchorConfigMemo()
    resetDefaultLogSinkContext()
    process.chdir(savedCwd)
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    for (const key of OWNED_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

/**
 * The log ndjson lines this run emitted, from `<runtimeDir>/logs/<repo>/
 * <task>.ndjson`. The `<repo>` segment is normally `unresolved` (the non-git
 * cwd `runLoopInProcess` sets), but `resolveRepo`'s module-level cache is
 * process-wide and does NOT clear on the env/cwd this harness controls: a
 * prior test in the same runner process that resolved a real repo (a CI
 * runner sets `GITHUB_REPOSITORY`/`AEG_REPO`) leaves that segment cached, so
 * `log()` writes under `logs/<owner>-<repo>/` instead. Found live in CI: the
 * hardcoded `unresolved` path read empty there while the file sat under the
 * real repo segment. So this searches every segment under `logs/` for THIS
 * world's own `<task>.ndjson` (the runtime dir is a per-world temp, so only
 * this run's file is ever present).
 */
export function outboxLines(world: LoopWorld): Array<Record<string, unknown>> {
  const logsRoot = join(world.runtimeDir, 'logs')
  if (!existsSync(logsRoot)) return []
  const target = `${world.task}.ndjson`
  const found: string[] = []
  for (const seg of readdirSync(logsRoot)) {
    const candidate = join(logsRoot, seg, target)
    if (existsSync(candidate)) found.push(candidate)
  }
  if (found.length === 0) return []
  return found
    .flatMap((p) => readFileSync(p, 'utf8').trim().split('\n'))
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

// --- on-disk path helpers, rooted at the world's own runtime dir ----------
// The driver writes its real artifacts under `world.runtimeDir`; these mirror
// the spawned-fixture helpers (`taskRunDir`/`roundDir`/`controlDir`/
// `developerDir`) so a converted assertion reads the identical layout.

export function taskRunDir(world: LoopWorld): string {
  return join(world.runtimeDir, 'tasks-execution', String(world.task))
}
export function controlDir(world: LoopWorld): string {
  return join(taskRunDir(world), 'control')
}
export function roundDir(world: LoopWorld, round: number): string {
  return join(taskRunDir(world), 'rounds', String(round))
}
export function developerDir(world: LoopWorld, round: number): string {
  return join(roundDir(world, round), 'developer')
}

/** The comment bodies posted this run, in post order — the in-process analogue of the spawned fixture's `postedCommentFiles`. */
/**
 * Seeds an accepted `completed` turn result for `round`, as the driver's own
 * controller records one — for an attach that gates on a round's confidence
 * without dispatching the Developer in this process.
 */
export function seedAcceptedTurnResult(
  world: LoopWorld,
  round: number,
  fields: { confidence?: number; explanation?: string; addressedFindingIds?: string[] } = {}
): void {
  const dir = developerDir(world, round)
  mkdirSync(dir, { recursive: true })
  const attempt = readdirSync(dir).filter((n) => /^turn-result-\d+\.json$/.test(n)).length + 1
  const raw = completedTurnOutput(fields).raw as { turnResult: unknown }
  writeFileSync(
    join(dir, `turn-result-${String(attempt).padStart(3, '0')}.json`),
    JSON.stringify({
      version: 1,
      runId: 'seeded',
      round,
      attempt,
      head: null,
      outcome: 'accepted',
      result: raw.turnResult,
      failures: [],
      recordedAt: new Date(0).toISOString()
    })
  )
}

export function postedCommentBodies(world: LoopWorld): string[] {
  return world.postedComments.map((c) => c.body)
}

export { sha }
