import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireOwnership,
  consumeResolutionOnce,
  defaultControlStoreDeps,
  type EscalationInput,
  listStartedEffectKeys,
  markEffectUncertain,
  readEffect,
  StaleEpochWriteError,
  writeEffect,
  writeEscalation
} from '@attalabs/aeg-core'
import type { CallerContext } from '../../../src/lib/task-tools/server.js'
import { createTaskCancelHandler } from '../../../src/lib/task-tools/cancel.js'
import { writePauseState } from '../../../src/lib/dev-review-loop/pause-resume.js'

/**
 * `task_cancel` (task-operator-v1 4, O2) driven in-process against a real,
 * temp-directory-backed outbox/control-store, with `cancelDevReviewLoop`
 * itself INJECTED (a fake standing in for the already-tested real one —
 * `dev-review-loop.test.ts` owns proving the real continuation's own
 * termination/fencing behavior; this suite proves the HANDLER's own
 * translation: outcome classification, idempotent replay, and the forged/
 * stale/wrong-target refusals it detects before ever calling the
 * continuation at all).
 */

const CALLER: CallerContext = { caller: { id: 'operator-1' } }
const NO_CALLER: CallerContext = { caller: null }
const ISSUE = 558
const PR = 900
const ESCALATION_ID = `${ISSUE}-1-headsha1`

/**
 * issue-657, O5 — every real subprocess this file spawns overrides `HOME`
 * to a fresh temp dir, but `run-paths.ts`'s own runtime-dir resolution
 * checks `VINAYA_RUNTIME_DIR` FIRST, before `HOME` ever matters — a value
 * inherited from the calling shell's own environment (set when this suite
 * runs inside a real dispatched session's own orchestration) silently
 * redirects the spawned subprocess to the operator's REAL, non-isolated
 * `~/.vinaya`, where every test in this file shares the SAME hardcoded
 * `ISSUE` (`558`): two tests, or two runs of the same test, then collide on
 * the identical real control-store record (found live: a leftover
 * `consumed resolution` for task `558` made a fresh, isolated-looking test
 * fail with a stale replay it never itself produced). Stripped here,
 * unconditionally, the same fix `dev-review-loop.test.ts` already applies
 * to its own spawned driver's env.
 *
 * `AEG_REPO` is deliberately NOT stripped here, unlike that file's own
 * helper: these subprocesses run with `cwd: repoRoot` — the real worktree,
 * not a deliberately non-git tempdir — so an inherited `AEG_REPO` is a
 * legitimate short-circuit for real repo-identity resolution, not a leak;
 * removing it forces a slower, network-dependent fallback path this test
 * never meant to exercise (found live: doing so made one of this file's own
 * tests intermittently time out on this host).
 */
function hermeticSpawnEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home }
  delete env.VINAYA_RUNTIME_DIR
  return env
}

let sandbox: string
let outbox: string
let controlStoreDeps: ReturnType<typeof defaultControlStoreDeps>

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'vinaya-task-cancel-'))
  outbox = join(sandbox, 'outbox')
  mkdirSync(outbox, { recursive: true })
  controlStoreDeps = defaultControlStoreDeps(() => join(outbox, 'tasks-execution'))
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

function writePause() {
  writePauseState(outbox, {
    task: ISSUE,
    round: 1,
    head: 'headsha1',
    branch: 'task/x/1',
    prNumber: PR,
    reason: 'escalation',
    pausedAt: '2026-01-01T00:00:00.000Z',
    escalationId: ESCALATION_ID
  })
}

function writeEscalationFixture(overrides: Partial<EscalationInput> = {}) {
  const acquired = acquireOwnership(controlStoreDeps, ISSUE, 'test-fixture')
  if (!acquired.acquired) throw new Error('fixture: could not acquire epoch')
  return writeEscalation(controlStoreDeps, ISSUE, acquired.epoch, {
    escalationId: ESCALATION_ID,
    round: 1,
    head: 'headsha1',
    branch: 'task/x/1',
    pr: PR,
    runId: 'run-1',
    pid: 12345,
    host: 'test-host',
    agent: 'claude',
    reason: 'escalation',
    attemptedRecovery: 'none',
    requestedDecision: 'resume or cancel',
    recipient: 'principal',
    briefHash: null,
    objectivesVersion: null,
    rulingOrdinal: 0,
    policyDigest: 'digest',
    recordedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  })
}

function harness(
  overrides: {
    rulings?: string[]
    newestRulingOrdinal?: number
    hostname?: string
    cancelResult?: { escalationId: string; fencedEffectKeys: string[] }
    cancelError?: Error
  } = {}
) {
  const calls: Array<{ cancelPr: number; agent: string }> = []
  const events: Array<{ operation: string; target: string; result: string; error_class: string | null }> = []
  const handler = createTaskCancelHandler({
    runtimeDir: () => outbox,
    resolveIssueForRef: () => ISSUE,
    fetchRulings: () => overrides.rulings ?? ['LGTM, cancel.'],
    fetchNewestRulingOrdinal: () => overrides.newestRulingOrdinal ?? 1,
    hostname: () => overrides.hostname ?? 'test-host',
    cancelDevReviewLoop: async (input) => {
      calls.push(input)
      if (overrides.cancelError) throw overrides.cancelError
      return {
        task: ISSUE,
        escalationId: overrides.cancelResult?.escalationId ?? ESCALATION_ID,
        fencedEffectKeys: overrides.cancelResult?.fencedEffectKeys ?? []
      }
    },
    log: (e) => {
      if (e.kind === 'operation')
        events.push({ operation: e.operation, target: e.target ?? '', result: e.result, error_class: e.error_class })
    }
  })
  return { handler, calls, events }
}

describe('task_cancel handler', () => {
  it('refuses malformed input with a validation error', async () => {
    const { handler, calls } = harness()
    const result = await handler({}, CALLER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('validation')
    expect(calls).toHaveLength(0)
  })

  it('refuses with an authority error when the invocation context carries no caller', async () => {
    const { handler } = harness()
    const result = await handler({ task: { issue: ISSUE }, reason: 'no longer needed' }, NO_CALLER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('authority')
  })

  it('refuses when no pause with a PR is recorded', async () => {
    const { handler, calls } = harness()
    const result = await handler({ task: { issue: ISSUE }, reason: 'no longer needed' }, CALLER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('precondition')
    expect(calls).toHaveLength(0)
  })

  it('rejects a forged decision — no Principal ruling posted yet', async () => {
    writePause()
    const { handler, calls } = harness({ rulings: [] })
    const result = await handler({ task: { issue: ISSUE }, reason: 'no longer needed' }, CALLER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('authority')
    expect(calls).toHaveLength(0)
  })

  it('rejects a stale ruling — its ordinal has not advanced past the one this escalation was already raised under', async () => {
    writePause()
    writeEscalationFixture({ host: 'test-host', rulingOrdinal: 1 })
    const { handler, calls } = harness({ newestRulingOrdinal: 1 })
    const result = await handler({ task: { issue: ISSUE }, reason: 'no longer needed' }, CALLER)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('authority')
      expect(result.error.message).toContain('no newer than the ruling this escalation was already raised under')
    }
    expect(calls).toHaveLength(0)
  })

  it('confirms a local cancel with nothing fenced', async () => {
    writePause()
    writeEscalationFixture({ host: 'test-host' })
    const { handler, calls, events } = harness({ hostname: 'test-host' })
    const result = await handler({ task: { issue: ISSUE }, reason: 'superseded' }, CALLER)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.result.outcome).toBe('confirmed')
    expect(result.result.pr).toBe(PR)
    expect(calls).toEqual([{ cancelPr: PR, agent: 'claude' }])
    expect(events).toEqual([{ operation: 'task_cancel', target: `task:${ISSUE}`, result: 'ok', error_class: null }])
  })

  it('reports pending when the run was dispatched on a different host', async () => {
    writePause()
    writeEscalationFixture({ host: 'a-different-host' })
    const { handler } = harness({ hostname: 'this-host' })
    const result = await handler({ task: { issue: ISSUE }, reason: 'superseded' }, CALLER)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.result.outcome).toBe('pending')
  })

  it('reports uncertain when an in-flight effect had to be fenced', async () => {
    writePause()
    writeEscalationFixture({ host: 'test-host' })
    const { handler } = harness({
      hostname: 'test-host',
      cancelResult: { escalationId: ESCALATION_ID, fencedEffectKeys: ['effect-1'] }
    })
    const result = await handler({ task: { issue: ISSUE }, reason: 'superseded' }, CALLER)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.result.outcome).toBe('uncertain')
    expect(result.result.fencedEffectKeys).toEqual(['effect-1'])
  })

  it('reports the same truthful outcome again on a replayed cancel — never an error', async () => {
    writePause()
    writeEscalationFixture({ host: 'test-host' })
    const { ReplayedResolutionError } = await import('../../../src/lib/dev-review-loop/pause-resume.js')
    const err = new ReplayedResolutionError(ISSUE, ESCALATION_ID, {
      version: 1,
      kind: 'resolution',
      task: ISSUE,
      escalationId: ESCALATION_ID,
      decision: 'cancel',
      authenticatedBy: 'principal-1',
      authenticatedFrom: `${PR}-1`,
      consumedAt: '2026-01-01T00:00:00.000Z'
    })
    const { handler } = harness({ hostname: 'test-host', cancelError: err })
    const result = await handler({ task: { issue: ISSUE }, reason: 'superseded' }, CALLER)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.result.outcome).toBe('confirmed')
    expect(result.result.authenticatedBy).toBe('principal-1')
  })

  it('refuses a cancel against an escalation already resolved as resume', async () => {
    writePause()
    writeEscalationFixture({ host: 'test-host' })
    const { ReplayedResolutionError } = await import('../../../src/lib/dev-review-loop/pause-resume.js')
    const err = new ReplayedResolutionError(ISSUE, ESCALATION_ID, {
      version: 1,
      kind: 'resolution',
      task: ISSUE,
      escalationId: ESCALATION_ID,
      decision: 'resume',
      authenticatedBy: 'principal-1',
      authenticatedFrom: `${PR}-1`,
      consumedAt: '2026-01-01T00:00:00.000Z'
    })
    const { handler } = harness({ hostname: 'test-host', cancelError: err })
    const result = await handler({ task: { issue: ISSUE }, reason: 'superseded' }, CALLER)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('precondition')
      expect(result.error.message).toContain('resume')
    }
  })

  it('fences a late in-flight effect on cancel — a write under the old epoch is refused after', async () => {
    // Exercises the SAME control-store primitives `cancelDevReviewLoop`'s own
    // `resolveEscalation` + `fenceStartedEffectsAsUncertain` compose, against
    // this suite's own sandboxed `controlStoreDeps` (those two convenience
    // wrappers hardcode the real machine control store — see `resume.ts`'s
    // header on why this handler never calls them directly either), proving
    // O3's "cancel and fence a late result" end to end: a write still
    // `'started'` when cancellation runs is fenced to `'uncertain'`, and any
    // later attempt to complete it under the pre-cancel epoch is refused.
    const acquiredBefore = acquireOwnership(controlStoreDeps, ISSUE, 'developer-in-flight')
    if (!acquiredBefore.acquired) throw new Error('fixture: could not acquire epoch')
    const staleEpoch = acquiredBefore.epoch
    writeEffect(controlStoreDeps, ISSUE, staleEpoch, 'late-pr-comment', {
      operation: 'pr-comment',
      target: `pr:${PR}`,
      inputVersion: 1,
      payloadDigest: 'digest-1',
      status: 'started',
      recordedAt: '2026-01-01T00:00:00.000Z'
    })

    // The cancel itself: a fresh epoch, the resolution consumed exactly once,
    // then every still-`'started'` effect fenced under THAT epoch.
    const cancelAcquire = acquireOwnership(controlStoreDeps, ISSUE, 'cancel')
    if (!cancelAcquire.acquired) throw new Error('fixture: could not acquire cancel epoch')
    const consumed = consumeResolutionOnce(controlStoreDeps, ISSUE, cancelAcquire.epoch, {
      escalationId: ESCALATION_ID,
      decision: 'cancel',
      authenticatedBy: 'principal-1',
      authenticatedFrom: `${PR}-1`,
      consumedAt: '2026-01-01T00:01:00.000Z'
    })
    expect(consumed.outcome).toBe('consumed')
    const fenced = listStartedEffectKeys(controlStoreDeps, ISSUE).map(
      (key) => markEffectUncertain(controlStoreDeps, ISSUE, cancelAcquire.epoch, key)?.key
    )
    expect(fenced).toEqual(['late-pr-comment'])
    expect(readEffect(controlStoreDeps, ISSUE, 'late-pr-comment')).toMatchObject({
      status: 'ok',
      value: { status: 'uncertain' }
    })

    // The late result: the in-flight write from BEFORE the cancel finally
    // tries to confirm itself, still holding the now-superseded `staleEpoch`.
    expect(() =>
      writeEffect(controlStoreDeps, ISSUE, staleEpoch, 'late-pr-comment', {
        operation: 'pr-comment',
        target: `pr:${PR}`,
        inputVersion: 1,
        payloadDigest: 'digest-1',
        status: 'verified',
        url: 'https://github.com/example/pr/comment/1',
        recordedAt: '2026-01-01T00:02:00.000Z'
      })
    ).toThrow(StaleEpochWriteError)
  })

  it('surfaces a stale/wrong-target refusal as a precondition error', async () => {
    writePause()
    writeEscalationFixture({ host: 'test-host' })
    const { StaleEscalationError } = await import('../../../src/lib/dev-review-loop/pause-resume.js')
    const err = new StaleEscalationError(ISSUE, ESCALATION_ID, 'no escalation record was ever written for it')
    const { handler } = harness({ hostname: 'test-host', cancelError: err })
    const result = await handler({ task: { issue: ISSUE }, reason: 'superseded' }, CALLER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('precondition')
  })
})

/**
 * Security review, round 3, HIGH: every test above injects a fake
 * `cancelDevReviewLoop`, so none of them ever exercised the REAL function's
 * own error-wrapping — which used to lose `ReplayedResolutionError`'s
 * identity (`new Error(...)` instead of rethrowing the same instance),
 * breaking `task_cancel`'s `instanceof` translation the instant it was
 * wired to the real default dependency. `cancelDevReviewLoop`'s own
 * control-store reads default to this machine's real `~/.vinaya/` (`config.ts`'s
 * `GLOBAL_VINAYA_HOME` is a module-level constant frozen at first import —
 * `dev-review-loop.test.ts`'s own header explains why an in-process fixture
 * can never isolate it), so proving the real function's behavior needs a
 * real subprocess with its own scratch `HOME`, the same pattern that file
 * already uses. This fixture calls `cancelDevReviewLoop` itself directly
 * (never through the CLI, which never inspects `instanceof`) so a
 * regression in the error identity is caught here even though the CLI's own
 * existing replay test (message-substring only) could not have caught it.
 */

/**
 * `log()`'s own default `resolveRepo` (unlike `cancelDeps.resolveRepo`
 * above, which only affects `cancelDevReviewLoop`'s own repo lookups) reads
 * the REAL git remote of whatever `cwd` the fixture script runs in — this
 * repo's own real `owner-repo` directory, never `unresolved` — so a test
 * asserting on the outbox layout searches for the file by name instead of
 * assuming a fixed directory.
 */
function findOutboxFile(root: string, name: string): string {
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) stack.push(full)
      else if (entry === name) return full
    }
  }
  throw new Error(`no file named ${name} found under ${root}`)
}

describe('cancelDevReviewLoop — real subprocess, real control store (security review round 3)', () => {
  it('a replayed cancel throws an error still instanceof ReplayedResolutionError, not a generic Error', () => {
    const home = mkdtempSync(join(tmpdir(), 'vinaya-cancel-integration-'))
    const repoRoot = join(import.meta.dir, '..', '..', '..', '..', '..')
    const scriptPath = join(import.meta.dir, `.cancel-integration-fixture-${process.pid}-${Date.now()}.ts`)
    const script = `
import { acquireOwnership, defaultControlStoreDeps, writeEscalation } from '@attalabs/aeg-core'
import { writePauseState } from '../../../src/lib/dev-review-loop/pause-resume.js'
import { cancelDevReviewLoop, ReplayedResolutionError } from '../../../src/lib/dev-review-loop.js'
import { runtimeDir } from '../../../src/lib/dev-review-loop/reviewer-dispatch.js'
import { controlStoreRoot } from '../../../src/lib/effects.js'

const ISSUE = 558
const PR = 900
const ESCALATION_ID = \`\${ISSUE}-1-headsha1\`

writePauseState(runtimeDir(), {
  task: ISSUE,
  round: 1,
  head: 'headsha1',
  branch: 'task/x/1',
  prNumber: PR,
  reason: 'escalation',
  pausedAt: new Date().toISOString(),
  escalationId: ESCALATION_ID
})

const controlStoreDeps = defaultControlStoreDeps(controlStoreRoot)
const acquired = acquireOwnership(controlStoreDeps, ISSUE, 'fixture')
if (!acquired.acquired) throw new Error('fixture: could not acquire epoch')
writeEscalation(controlStoreDeps, ISSUE, acquired.epoch, {
  escalationId: ESCALATION_ID,
  round: 1,
  head: 'headsha1',
  branch: 'task/x/1',
  pr: PR,
  runId: 'run-1',
  pid: 12345,
  host: 'test-host',
  agent: 'claude',
  reason: 'escalation',
  attemptedRecovery: 'none',
  requestedDecision: 'resume or cancel',
  recipient: 'principal',
  briefHash: null,
  objectivesVersion: null,
  rulingOrdinal: 0,
  policyDigest: 'digest',
  recordedAt: new Date().toISOString()
})

const cancelDeps = {
  fetchPrBody: () => 'Closes #558',
  fetchRulings: () => ['LGTM, cancel.'],
  fetchNewestRulingOrdinal: () => 1,
  fetchNewestRulingAuthor: () => 'principal-1',
  resolveRepo: async () => null,
  terminateInFlightLaunchesOnShutdown: () => {},
  flushOutbox: async () => {}
}

await cancelDevReviewLoop({ cancelPr: PR, agent: 'claude' }, cancelDeps)
console.log('FIRST_OK')

try {
  await cancelDevReviewLoop({ cancelPr: PR, agent: 'claude' }, cancelDeps)
  console.log('SECOND_NO_THROW')
} catch (err) {
  console.log('SECOND_IS_REPLAYED:' + (err instanceof ReplayedResolutionError))
  console.log('SECOND_MESSAGE:' + err.message)
}
`
    writeFileSync(scriptPath, script)
    try {
      const output = execFileSync('bun', [scriptPath], {
        cwd: repoRoot,
        env: hermeticSpawnEnv(home),
        encoding: 'utf8'
      })
      expect(output).toContain('FIRST_OK')
      expect(output).toContain('SECOND_IS_REPLAYED:true')
      expect(output).toContain('SECOND_MESSAGE:devReviewLoop --cancel:')
      expect(output).not.toContain('SECOND_NO_THROW')
    } finally {
      rmSync(scriptPath, { force: true })
      rmSync(home, { recursive: true, force: true })
    }
    // issue-657, O5 — two full `bun` subprocesses, each a real control-store
    // round trip against a properly HOME-isolated (never VINAYA_RUNTIME_DIR-
    // redirected) directory: legitimately slower than bun's own default
    // per-test budget, borderline over it even before this fix (the prior
    // leak into the operator's already-warm real `~/.vinaya` masked this by
    // accident). Same accommodation `dev-review-loop.test.ts`'s own
    // real-subprocess tests already carry.
  }, 20000)

  it("restores process.env.VINAYA_TASK/VINAYA_RUN after returning, and never lets a later, unrelated task's own task_resume land in this run's outbox (round 2 security review, HIGH)", () => {
    // `cancelDevReviewLoop` is called IN-PROCESS from `task-tools/cancel.ts`
    // inside the shared, multi-task `vinaya task-tools serve` MCP server —
    // never as its own dedicated subprocess there. This fixture models
    // exactly that: one process, one cancel for ISSUE, then a REAL
    // `task_resume` call (via `createTaskResumeHandler`, the actual code
    // path `server.ts` dispatches through) for a COMPLETELY DIFFERENT task.
    // Round 2 review flagged an earlier version of this test for calling
    // `log()` directly with `VINAYA_TASK` set by the fixture itself — a
    // shape the real code path never took, since neither handler's own
    // `emitOperationEvent` scoped `VINAYA_TASK` at all before this task's
    // fix. Driving the real handler here means this test would have failed
    // against that unfixed code (the ambient sentinel would have leaked into
    // the 991 event) and now proves the fix.
    const home = mkdtempSync(join(tmpdir(), 'vinaya-cancel-env-restore-'))
    const repoRoot = join(import.meta.dir, '..', '..', '..', '..', '..')
    const scriptPath = join(import.meta.dir, `.cancel-env-restore-fixture-${process.pid}-${Date.now()}.ts`)
    const script = `
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { acquireOwnership, defaultControlStoreDeps, writeEscalation } from '@attalabs/aeg-core'
import { writePauseState } from '../../../src/lib/dev-review-loop/pause-resume.js'
import { cancelDevReviewLoop } from '../../../src/lib/dev-review-loop.js'
import { runtimeDir } from '../../../src/lib/dev-review-loop/reviewer-dispatch.js'
import { controlStoreRoot } from '../../../src/lib/effects.js'
import { log } from '../../../src/lib/log-sink.js'
import { createTaskResumeHandler } from '../../../src/lib/task-tools/resume.js'

const ISSUE = 558
const OTHER_ISSUE = 991
const PR = 900
const ESCALATION_ID = \`\${ISSUE}-1-headsha1\`

writePauseState(runtimeDir(), {
  task: ISSUE,
  round: 1,
  head: 'headsha1',
  branch: 'task/x/1',
  prNumber: PR,
  reason: 'escalation',
  pausedAt: new Date().toISOString(),
  escalationId: ESCALATION_ID
})

const controlStoreDeps = defaultControlStoreDeps(controlStoreRoot)
const acquired = acquireOwnership(controlStoreDeps, ISSUE, 'fixture')
if (!acquired.acquired) throw new Error('fixture: could not acquire epoch')
writeEscalation(controlStoreDeps, ISSUE, acquired.epoch, {
  escalationId: ESCALATION_ID,
  round: 1,
  head: 'headsha1',
  branch: 'task/x/1',
  pr: PR,
  runId: 'run-1',
  pid: 12345,
  host: 'test-host',
  agent: 'claude',
  reason: 'escalation',
  attemptedRecovery: 'none',
  requestedDecision: 'resume or cancel',
  recipient: 'principal',
  briefHash: null,
  objectivesVersion: null,
  rulingOrdinal: 0,
  policyDigest: 'digest',
  recordedAt: new Date().toISOString()
})

const cancelDeps = {
  fetchPrBody: () => 'Closes #558',
  fetchRulings: () => ['LGTM, cancel.'],
  fetchNewestRulingOrdinal: () => 1,
  fetchNewestRulingAuthor: () => 'principal-1',
  resolveRepo: async () => null,
  terminateInFlightLaunchesOnShutdown: () => {},
  flushOutbox: async () => {}
}

// A sentinel ambient value — never touched by this task's own work — proves
// the restore puts things back exactly as found, not merely "unset".
process.env.VINAYA_TASK = 'sentinel-task'
process.env.VINAYA_RUN = 'sentinel-run'

await cancelDevReviewLoop({ cancelPr: PR, agent: 'claude' }, cancelDeps)

console.log('TASK_AFTER:' + process.env.VINAYA_TASK)
console.log('RUN_AFTER:' + process.env.VINAYA_RUN)

// The REAL \`task_resume\` handler for a DIFFERENT task, driven right after
// \`cancelDevReviewLoop\` returns, in the SAME process — the actual code path
// \`task-tools/server.ts\` dispatches through, never a fixture that sets
// VINAYA_TASK itself. No pause state is recorded for OTHER_ISSUE, so the
// handler refuses fast ("nothing to resume") but still reaches its own
// \`emitOperationEvent\`, which must scope VINAYA_TASK to OTHER_ISSUE
// internally — nothing here reads or depends on whatever
// \`cancelDevReviewLoop\` left behind, and the ambient sentinel set above is
// never touched by this call.
const resumeHandler = createTaskResumeHandler({
  runtimeDir,
  resolveIssueForRef: () => OTHER_ISSUE,
  fetchRulings: () => [],
  fetchNewestRulingAuthor: () => null,
  fetchNewestRulingOrdinal: () => 0,
  store: { claim: () => ({ claimed: false, record: { escalationId: '', caller: '', pr: 0, startedAt: '' } }), release: () => {} },
  launch: () => {},
  now: () => new Date().toISOString(),
  log
})
const resumeOutcome = await resumeHandler({ task: { issue: OTHER_ISSUE } }, { caller: { id: 'other-caller' } })
console.log('RESUME_REFUSED:' + (resumeOutcome.ok === false))

function fileExistsUnder(root, name) {
  if (!existsSync(root)) return false
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) stack.push(full)
      else if (entry === name) return true
    }
  }
  return false
}

const outboxRootPath = \`\${process.env.HOME}/.vinaya/outbox\`
const deadline = Date.now() + 10000
while (Date.now() < deadline) {
  if (fileExistsUnder(outboxRootPath, \`\${OTHER_ISSUE}.ndjson\`)) break
  await new Promise((resolve) => setTimeout(resolve, 20))
}
console.log('DONE')
`
    writeFileSync(scriptPath, script)
    try {
      const output = execFileSync('bun', [scriptPath], {
        cwd: repoRoot,
        env: hermeticSpawnEnv(home),
        encoding: 'utf8'
      })
      expect(output).toContain('TASK_AFTER:sentinel-task')
      expect(output).toContain('RUN_AFTER:sentinel-run')
      expect(output).toContain('RESUME_REFUSED:true')
      expect(output).toContain('DONE')

      const outboxRoot = join(home, '.vinaya', 'outbox')
      const otherOutboxPath = findOutboxFile(outboxRoot, '991.ndjson')
      const cancelledOutboxPath = findOutboxFile(outboxRoot, '558.ndjson')
      const otherLines = readFileSync(otherOutboxPath, 'utf8').trim().split('\n').filter(Boolean)
      expect(otherLines).toHaveLength(1)
      const otherEvent = JSON.parse(otherLines[0] as string) as { subject: { issue: number }; operation: string }
      expect(otherEvent.subject.issue).toBe(991)
      expect(otherEvent.operation).toBe('task_resume')

      // The OTHER task's own operation event never lands in the cancelled
      // task's outbox — no fabricated cross-task history.
      const cancelledLines = readFileSync(cancelledOutboxPath, 'utf8').trim().split('\n').filter(Boolean)
      expect(cancelledLines.every((l) => (JSON.parse(l) as { subject: { issue: number } }).subject.issue === 558)).toBe(
        true
      )
    } finally {
      rmSync(scriptPath, { force: true })
      rmSync(home, { recursive: true, force: true })
    }
  }, 20000)
})
