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
import { resetRuntimeDirCache } from '../../src/lib/run-paths.js'
import type { DispatchHandle } from '../../src/lib/dispatch.js'
import {
  pauseMarker,
  renderNoPushStopComment,
  renderPauseComment,
  sanitizePublicPauseDetail
} from '../../src/lib/dev-review-loop/pause-resume.js'
import { markedCommentBody } from '../../src/lib/forge-write.js'
import { objectivesOf, objectivesVersion, renderObjectives } from '@attalabs/aeg-core'

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
  report: 'CONFIG_SCAN: clean\nSECRETS: none found\n',
  objectives: 'O1|MET|done.\n',
  sessionId: 'sec-session-1'
}

/** One posted comment, recorded by a forge-write fake in place of a real `gh` post. */
export type PostedComment = { kind: 'issue' | 'pr'; ref: string; marker: string; body: string }

/** One dispatch the fake `dispatchRole` recorded — role and round, so a test can assert the sequence of dispatches. */
export type DispatchRecord = { role: string; round: number; resumeId: string | null }

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
  /** The developer's local worktree head; defaults to `head` (nothing unpushed). */
  worktreeHead: string
  gate: 'green' | 'red' | 'pending'
  failingCheckRuns: { id: number; name: string; conclusion: string }[]
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  conflictingFiles: string[]
  frozenBrief: string
  objectivesText: string
  sourceRevision: string
  rulings: string[]
  rulingOrdinal: number
  rulingAuthor: string | null
  developerStop: string | null
  /** The PR body `checkPremiseAtHead` reads each round; the default carries only `Closes #<task>` (no `Premise:` block, so the reassert is dormant). */
  prBody: string
  shortstat: string
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
  // --- recorded side effects, for assertions ---
  postedComments: PostedComment[]
  dispatches: DispatchRecord[]
  /** How many times each role was dispatched, cumulative across rounds. */
  dispatchCountByRole: Record<string, number>
  publishedRounds: number[]
  evidenceReportCalls: number
  reexecCalls: string[][]
  exitCalls: number[]
  sweepCalls: number[]
  terminateCalls: number[]
  // --- infra ---
  runtimeDir: string
  repoRoot: string
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
  const runtimeDir = tempDir('vinaya-drl-inproc-rt-')
  const repoRoot = tempDir('vinaya-drl-inproc-repo-')
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
    worktreeHead: sha('a'),
    gate: 'green',
    failingCheckRuns: [],
    mergeable: 'MERGEABLE',
    conflictingFiles: [],
    frozenBrief:
      '<!-- aeg:brief:v1 -->\nBrief hash: deadbeef\nDo the thing.\n\n## Objectives\n\nO1. Do the thing.\n\n## Planner rationale\n\nOut of scope for facts.\n',
    objectivesText: 'O1. Do the thing.',
    sourceRevision: '(none — pre-task-4 frozen brief)',
    rulings: [],
    rulingOrdinal: 0,
    rulingAuthor: null,
    developerStop: null,
    prBody: `Closes #${task}`,
    shortstat: ' 2 files changed, 10 insertions(+), 3 deletions(-)',
    roleOutcomes: {},
    evidenceOutcome: { ok: true, gatesFailed: false },
    blockEvidenceUntilReviewerStarts: false,
    reviewerDispatchStarted: false,
    evidenceReportTimedOut: false,
    postedComments: [],
    dispatches: [],
    dispatchCountByRole: {},
    publishedRounds: [],
    evidenceReportCalls: 0,
    reexecCalls: [],
    exitCalls: [],
    sweepCalls: [],
    terminateCalls: [],
    runtimeDir,
    repoRoot,
    logPath,
    cleanup: cleanupWorlds,
    ...overrides
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

function handle(resumeId: string | null, effectId: string): DispatchHandle {
  return {
    exitCode: 0,
    durationMs: 1,
    usage: { input: 10, output: 5 },
    resumeId,
    timedOut: false,
    effectId
  }
}

/**
 * A complete `LoopDeps` whose every fake reads from and writes to `world`.
 * Poll intervals are near-zero (`assessRound`'s retry COUNT is the behaviour
 * under test, never the wall-clock gap between polls — Issue #709's profile).
 */
export function makeInProcessDeps(world: LoopWorld): Partial<LoopDeps> {
  let dispatchSeq = 0
  return {
    dispatchRole: async (role, _agent, _prompt, opts): Promise<DispatchHandle> => {
      const round = opts.round ?? 1
      world.dispatchCountByRole[role] = (world.dispatchCountByRole[role] ?? 0) + 1
      if (role === 'developer') {
        world.developerPushed = true
        const sessionId = world.roleOutcomes[round]?.developer?.sessionId ?? 'dev-session-1'
        world.dispatches.push({ role, round, resumeId: sessionId })
        return handle(sessionId, `eff-dev-${++dispatchSeq}`)
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
      world.dispatches.push({ role, round, resumeId: outcome.sessionId })
      return handle(outcome.sessionId, `eff-${reviewRole}-${++dispatchSeq}`)
    },
    resolveHead: (_branch) => {
      if (!world.developerPushed) throw new Error('resolveHead: branch has no head on origin yet (in-process fake)')
      return world.head
    },
    fetchCiConclusion: (_head) => world.gate,
    fetchFailingCheckRuns: (_head) => world.failingCheckRuns.map((c) => ({ ...c })) as never,
    fetchRulings: (_pr) => [...world.rulings],
    fetchNewestRulingOrdinal: (_pr) => world.rulingOrdinal,
    fetchNewestRulingAuthor: (_pr) => world.rulingAuthor,
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
    findOpenPrForBranch: (branch) => (world.developerPushed ? { number: world.prNumber, branch } : null),
    readResumeRecord: () => null,
    runtimeDir: () => world.runtimeDir,
    repoRoot: () => world.repoRoot,
    gitRevParseOriginMain: () => world.base,
    gitMergeBase: async (_head) => world.mergeBase,
    gitFetch: () => {},
    gitDiffShortstat: (_base, _head) => world.shortstat,
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
    readWorktreeHead: (_worktreePath) => (world.developerPushed ? world.worktreeHead : null),
    readUnpushedWorkDetail: (_worktreePath) => ({ dirtyFiles: [], aheadCount: 0 }),
    fetchPrBody: (_pr) => world.prBody,
    fetchDeveloperStop: (_issue) => (world.developerStop === null ? null : (world.developerStop as never)),
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
    postPauseComment: (_task, _round, _head, prNumber, reason, detail) => {
      // Render the REAL marked body (sanitize → marker → renderPauseComment →
      // markedCommentBody) — the same pure pipeline production `postPauseComment`
      // runs before its `gh` post. Only the network post and the control-store
      // idempotency record are skipped, so a test asserting on the posted pause
      // comment's marker/detail/shape reads exactly what the forge would receive.
      const publicDetail = detail === undefined ? undefined : sanitizePublicPauseDetail(detail)
      const marker = pauseMarker(reason)
      const body = markedCommentBody(marker, renderPauseComment(prNumber, reason, publicDetail))
      world.postedComments.push({ kind: 'pr', ref: String(prNumber), marker, body })
      return { posted: true, url: 'https://example/pause', attempts: 1 } as never
    },
    postIssuePauseComment: (task, _round, reason, detail) => {
      const publicDetail = detail === undefined ? undefined : sanitizePublicPauseDetail(detail)
      const marker = pauseMarker(reason)
      const body = markedCommentBody(marker, renderNoPushStopComment(task, reason, publicDetail))
      world.postedComments.push({ kind: 'issue', ref: String(task), marker, body })
      return { posted: true, url: 'https://example/issue-pause', attempts: 1 } as never
    },
    publishRound: (_root, input) => {
      world.publishedRounds.push(input.round)
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
 */
const OWNED_ENV_KEYS = [
  'VINAYA_RUNTIME_DIR',
  'VINAYA_TASK',
  'VINAYA_ROUND',
  'VINAYA_RUN',
  'VINAYA_RUN_ID',
  'AEG_REPO',
  'GITHUB_REPOSITORY'
] as const

/**
 * Run `devReviewLoop` in-process against `world`. Defaults to a `--task`
 * start on the world's own task. `overrides` replaces individual fakes for a
 * scenario the world's own fields do not model (a forge read that fails once,
 * a post that throws); every other dependency stays the world-backed fake.
 *
 * Two pieces of ambient process state are pointed at this run's isolated
 * world for the duration of the call, then restored unconditionally in
 * `finally` (Issue #709 Traps to avoid: an in-process test that mutates
 * `process.env`/cwd and does not restore leaks into every later test):
 *
 *  - `VINAYA_RUNTIME_DIR`/`VINAYA_TASK` — so the module-level log sink writes
 *    where `logEvents` polls; the other per-run identity keys are cleared for
 *    the same reason a spawned fixture's env stripped them.
 *  - the working directory is switched to `world.repoRoot`, a NON-git temp
 *    dir. This is what the spawned fixtures got for free from their own
 *    scratch `cwd`: with no `git remote`, `trustAnchorRepo()` resolves `null`
 *    and the trust-anchor read (`principalAllowlist`/`reviewPolicy`) skips its
 *    real `gh api …/vinaya.config.json` call entirely, falling back to
 *    built-in defaults — and `resolveRepo` reads `unresolved`, the same repo
 *    segment those fixtures' own `$HOME/.vinaya/runtime/unresolved/…` paths
 *    hardcode. Without this the loop makes a real network `gh` call per run.
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
  return withWorldEnv(world, () =>
    runDriverLoop(
      input,
      { ...makeInProcessDeps(world), ...overrides },
      {
        fetchPrState: (_pr) => world.prState,
        // Same world-backed fake `makeInProcessDeps` gives `LoopDeps` — a
        // fixture that mutates `world.rulingOrdinal` mid-watch (simulating
        // a Principal ruling posted while this driver waits) needs the
        // WATCHER's own ruling read to see it too, never the real `gh`.
        fetchNewestRulingOrdinal: (_pr) => world.rulingOrdinal,
        watchPollIntervalMs: 1,
        infrastructureBackoffMs: 1,
        ...watchOverrides
      }
    )
  )
}

/**
 * Runs `fn` with this world's runtime directory, task and working directory
 * in place, then restores all of them. `runLoopInProcess` uses it; so does a
 * test driving another loop entry point (`cancelDevReviewLoop`) in-process.
 */
export async function withWorldEnv<T>(world: LoopWorld, fn: () => Promise<T> | T): Promise<T> {
  const saved: Record<string, string | undefined> = {}
  for (const key of OWNED_ENV_KEYS) saved[key] = process.env[key]
  const savedCwd = process.cwd()
  process.env.VINAYA_RUNTIME_DIR = world.runtimeDir
  process.env.VINAYA_TASK = String(world.task)
  delete process.env.VINAYA_ROUND
  delete process.env.VINAYA_RUN
  delete process.env.VINAYA_RUN_ID
  delete process.env.AEG_REPO
  delete process.env.GITHUB_REPOSITORY
  process.chdir(world.repoRoot)
  // `loopsRoot()`/`runtimeDirForThisRepo()` memoizes its runtime-dir
  // resolution process-wide; drop it so the driver log for THIS run resolves
  // under THIS world's `VINAYA_RUNTIME_DIR` rather than a prior run's
  // (already-cleaned) temp dir. Reset again in `finally` so a later
  // subprocess-based test in the same file never reads a stale in-process
  // resolution.
  resetRuntimeDirCache()
  try {
    return await fn()
  } finally {
    resetRuntimeDirCache()
    process.chdir(savedCwd)
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
export function postedCommentBodies(world: LoopWorld): string[] {
  return world.postedComments.map((c) => c.body)
}

export { sha }
