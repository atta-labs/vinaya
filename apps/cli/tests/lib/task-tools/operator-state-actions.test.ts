import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireOwnership,
  defaultControlStoreDeps,
  OPERATOR_STATUS_FOLLOW,
  type PauseReason,
  TASK_TOOL_NAMES,
  writeEscalation
} from '@attalabs/aeg-core'
import { escalationIdFor } from '../../../src/lib/dev-review-loop/pause-resume.js'
import { MAX_INFRASTRUCTURE_RETRIES } from '../../../src/lib/dev-review-loop/round-assess.js'
import { taskPrReadHandler } from '../../../src/lib/task-tools/pr-read.js'
import { appendRoleLine, loopLogPathFor } from '../../../src/lib/loop-log.js'
import { deriveLoopState, type TaskLoopState } from '../../../src/lib/task-status.js'
import { describeTaskLoopState, readTaskLoopStateObserved } from '../../../src/lib/task-tools/read.js'
import { createTaskResumeHandler, type TaskResumeDeps } from '../../../src/lib/task-tools/resume.js'
import {
  createTaskStartHandler,
  defaultHeldAgent,
  defaultPauseDisposition,
  INFRASTRUCTURE_RETRY_BOUND
} from '../../../src/lib/task-tools/start.js'
import type { CallerContext } from '../../../src/lib/task-tools/server.js'

/**
 * The conformance test between the Operator's doctrine and the Operator's
 * tools: for every run state `task_status` can report, the doctrine's
 * state-to-action table names one action, and that action is one the tools
 * actually carry out in that state.
 *
 * This exists because the two drifted apart in production and left a real
 * state with NOTHING that worked. The doctrine said `task_start` was for a
 * task never dispatched and `task_resume` continued "a paused or exited run";
 * `task_resume` in fact refuses any run with no pause record. So a driver
 * ended by a signal mid developer dispatch — exited, no pause written — had
 * no tool the doctrine named, and the Operator correctly stopped and asked.
 *
 * Nothing here is hand-made: each state is built as real files under a
 * temporary runtime directory and then READ BACK through `deriveLoopState`,
 * the same derivation `task_status` reports from, so a fixture that has
 * stopped producing the state it claims fails before any conformance
 * assertion runs. The one exception is `not_started`, which `deriveLoopState`
 * never returns — `buildRow` (`task-status.ts`) sets it from the forge, with
 * no outbox read at all, when a task's brief is not frozen yet.
 */

const CALLER: CallerContext = { caller: { id: 'operator-1' } }
/**
 * Deliberately far outside any Issue number this repository will ever issue.
 * `deriveLoopState` calls `findRecordedControllerRun(task)` with no injectable
 * root (`task-status.ts`), so that one read always goes to this machine's REAL
 * control store however isolated the rest of the fixture is: a live recorded
 * controller run for the number used here would make every fixture derive as
 * `running` and the state assertions fail for a reason that has nothing to do
 * with the doctrine. A number the forge cannot have issued can have no such
 * record.
 */
const TASK = 99000772
const DOCTRINE = join(import.meta.dir, '../../../../../aeg-root/roles/operator.md')

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-operator-states-'))
  tempDirs.push(dir)
  return dir
}

/**
 * The runtime directory's task area, written out by hand rather than imported
 * from `run-paths.ts`. Two reasons, and the second is load-bearing: these
 * fixtures assert against a literal layout rather than against the function
 * under test, and `depth: 'one'` selection counts DIRECT importers — a test
 * file that imports `run-paths.ts` joins the pre-push selection for every
 * change to it, and `test-selector.test.ts` pins a ceiling on exactly that
 * set. Nothing here needs the function, so nothing here pays for it.
 */
function tasksExecutionDir(root: string): string {
  return join(root, 'tasks-execution')
}

function taskDir(root: string, task: number): string {
  return join(tasksExecutionDir(root), String(task))
}

function writeControlFile(root: string, task: number, name: string, body: unknown): void {
  const dir = join(taskDir(root, task), 'control')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), JSON.stringify(body), 'utf8')
}

/**
 * A `task_start` claim as its own store writes it — one file per request
 * identity, in the unscoped control folder. `startedAt` decides which side of
 * the start handler's own stale-claim window the claim falls on, so a fresh one
 * reads as a start coming up and an old one as a start that never did.
 */
function writeStartClaim(root: string, task: number, startedAt: string, pid?: number): void {
  const dir = join(tasksExecutionDir(root), 'unscoped', 'control')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'start-request-a1b2c3d4e5f60718.json'),
    JSON.stringify({
      requestId: 'a1b2c3d4e5f60718',
      caller: 'principal-1',
      target: { issue: task },
      startedAt,
      ...(pid === undefined ? {} : { pid })
    }),
    'utf8'
  )
}

function writeDriverLock(root: string, task: number, pid: number): void {
  mkdirSync(taskDir(root, task), { recursive: true })
  writeFileSync(
    join(taskDir(root, task), 'driver.pid.json'),
    JSON.stringify({ pid, startedAt: '2026-09-26T00:00:00.000Z' }),
    'utf8'
  )
}

function deadPid(): number {
  const r = spawnSync('true', [])
  if (typeof r.pid !== 'number') throw new Error('spawnSync did not report a pid')
  return r.pid
}

/** The same two-verdict-effects-plus-`loop_state` shape the control store writes for a published round. */
function writePublishedRound(root: string, task: number, round: number): void {
  writeControlFile(root, task, 'loop-state.json', {
    version: 1,
    kind: 'loop_state',
    task,
    round,
    phase: 'publish',
    pauseReason: null,
    budgets: { mechanicalRetries: 0, reviewRounds: round, infrastructureRetries: 0 },
    heldResult: null,
    deliveredFindings: null,
    recordedAt: '2026-09-26T00:00:00.000Z'
  })
  const effectDir = join(taskDir(root, task), 'control', 'effect')
  mkdirSync(effectDir, { recursive: true })
  for (const role of ['reviewer', 'security'] as const) {
    const key = `${round}-${role}-verdict`
    writeFileSync(
      join(effectDir, `${key}.json`),
      JSON.stringify({
        version: 1,
        kind: 'effect',
        task,
        key,
        operation: 'pr-comment',
        target: 'pr:900',
        inputVersion: round,
        payloadDigest: 'digest',
        status: 'verified',
        url: 'https://example.test/comment',
        recordedAt: '2026-09-26T00:00:00.000Z'
      }),
      'utf8'
    )
  }
}

/**
 * A pause, plus the escalation record its continuation authenticates against.
 * Both, not just the first: `task_resume` refuses a pause whose escalation
 * has no durable record, so a pause-only fixture could never show the paused
 * row's own action working — it would only ever show it refusing.
 */
function writePause(root: string, task: number, round: number, reason: PauseReason = 'escalation'): void {
  const escalationId = escalationIdFor(task, round, 'abc123')
  writeControlFile(root, task, 'pause-state.json', {
    task,
    round,
    head: 'abc123',
    branch: `task/issue-${task}`,
    prNumber: 900,
    reason,
    pausedAt: '2026-09-26T00:00:00.000Z',
    escalationId
  })
  const deps = defaultControlStoreDeps(() => tasksExecutionDir(root))
  const acquired = acquireOwnership(deps, task, 'conformance-fixture')
  if (!acquired.acquired) throw new Error('fixture: could not acquire the epoch')
  writeEscalation(deps, task, acquired.epoch, {
    escalationId,
    round,
    head: 'abc123',
    branch: `task/issue-${task}`,
    pr: 900,
    runId: 'run-1',
    pid: 12345,
    host: 'conformance-host',
    agent: 'claude',
    reason,
    attemptedRecovery: 'none',
    requestedDecision: 'resume or cancel',
    recipient: 'principal',
    briefHash: null,
    objectivesVersion: null,
    rulingOrdinal: 0,
    policyDigest: 'digest',
    recordedAt: '2026-09-26T00:00:00.000Z'
  })
}

/** The loop's own recorded retry budget — what decides whether an `infrastructure` pause is still inside the bound the loop resumes it without a ruling within. */
function writeRecordedRetries(root: string, task: number, infrastructureRetries: number): void {
  writeControlFile(root, task, 'loop-state.json', {
    version: 1,
    kind: 'loop_state',
    task,
    round: 2,
    phase: 'pause',
    pauseReason: 'infrastructure',
    budgets: { mechanicalRetries: 0, reviewRounds: 1, infrastructureRetries },
    heldResult: null,
    deliveredFindings: null,
    recordedAt: '2026-09-26T00:00:00.000Z'
  })
}

/** A consumed Principal decision, in the shape `readResolution` parses — what a pause looks like once it has already been ruled on. */
function writeResolution(root: string, task: number, round: number, decision: 'resume' | 'cancel'): void {
  const escalationId = escalationIdFor(task, round, 'abc123')
  const dir = join(taskDir(root, task), 'control', 'resolution')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${escalationId}.json`),
    JSON.stringify({
      version: 1,
      kind: 'resolution',
      task,
      escalationId,
      decision,
      authenticatedBy: 'principal-1',
      authenticatedFrom: '900-9',
      consumedAt: '2026-09-26T00:00:00.000Z'
    }),
    'utf8'
  )
}

/**
 * One real runtime directory per state kind. The map is keyed by
 * `TaskLoopState['kind']`, so a kind added to that union fails TYPECHECK here
 * until it has a fixture — the drift guard on the code side, before any
 * assertion about the doctrine runs.
 *
 * `not_started` writes nothing: its producer is `buildRow`'s own constant for
 * a task whose brief is not frozen, and nothing on disk can make
 * `deriveLoopState` return it — `expected` below records that.
 */
const FIXTURES: Record<TaskLoopState['kind'], { build: (root: string) => void; derivable: boolean }> = {
  not_started: { build: () => {}, derivable: false },
  no_driver: { build: () => {}, derivable: true },
  running: { build: (root) => writeDriverLock(root, TASK, process.pid), derivable: true },
  // A start this machine accepted, read on either side of the start handler's
  // own stale-claim window: fresh (a driver still coming up), and past it with
  // the process it launched gone (a start that never came up).
  starting: { build: (root) => writeStartClaim(root, TASK, new Date().toISOString()), derivable: true },
  start_did_not_come_up: {
    // Past the stale grace and inside the reporting window, measured off the
    // real clock: a fixed past date would age out of that window and read as
    // the absence a claim that old is no longer evidence against.
    build: (root) => writeStartClaim(root, TASK, new Date(Date.now() - 2 * 60_000).toISOString(), deadPid()),
    derivable: true
  },
  paused: { build: (root) => writePause(root, TASK, 2), derivable: true },
  published: { build: (root) => writePublishedRound(root, TASK, 3), derivable: true },
  exited: {
    build: (root) => {
      writeDriverLock(root, TASK, deadPid())
      appendRoleLine(
        loopLogPathFor(null, TASK, root),
        'dev-review-loop',
        'driver_exited: reason=signal last_decision=dispatch_developer'
      )
    },
    derivable: true
  }
}

/** Builds the state's fixture and returns the state the SHARED derivation reads back — never the kind the fixture claimed. */
function realStateFor(kind: TaskLoopState['kind']): { root: string; state: TaskLoopState } {
  const root = tempDir()
  const fixture = FIXTURES[kind]
  fixture.build(root)
  const state = fixture.derivable ? deriveLoopState(root, TASK, { repo: null, loopsRoot: root }) : { kind }
  return { root, state: state as TaskLoopState }
}

// --- the doctrine's own table, parsed ---------------------------------------

type DoctrineRow = { state: string; action: string }

/**
 * Reads the state-to-action table out of `aeg-root/roles/operator.md` — the
 * file `vinaya doctrine --role operator` actually serves, never a copy of it
 * kept here, which is exactly the duplication that would let the two drift.
 */
function readDoctrineTable(): DoctrineRow[] {
  const lines = readFileSync(DOCTRINE, 'utf8').split('\n')
  const header = lines.findIndex((line) => line.startsWith('| `task_status` reports |'))
  if (header === -1) throw new Error(`${DOCTRINE} carries no state-to-action table`)
  const rows: DoctrineRow[] = []
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) break
    const cells = line.split('|').slice(1, -1)
    const state = (cells[0] ?? '').replaceAll('*', '').trim().toLowerCase().replaceAll(' ', '_')
    const actions = [...(cells[1] ?? '').matchAll(/`([a-z_]+)`/g)].map((m) => m[1] as string)
    if (actions.length !== 1) {
      throw new Error(`the doctrine's row for "${state}" names ${actions.length} actions — it must name exactly one`)
    }
    rows.push({ state, action: actions[0] as string })
  }
  return rows
}

// --- does the named tool accept this state? ---------------------------------

const GRANTED: readonly string[] = [...TASK_TOOL_NAMES, OPERATOR_STATUS_FOLLOW]

async function taskStartAccepts(root: string, state: TaskLoopState): Promise<{ ok: boolean; message: string }> {
  const launches: unknown[] = []
  const handler = createTaskStartHandler({
    repoRoot: () => root,
    store: (() => {
      const map = new Map<string, { requestId: string; caller: string; target: never; startedAt: string }>()
      return {
        claim: (record) => {
          const existing = map.get(record.requestId)
          if (existing) return { claimed: false, record: existing as never }
          map.set(record.requestId, record as never)
          return { claimed: true, record }
        },
        update: () => {},
        release: (id: string) => {
          map.delete(id)
        }
      }
    })(),
    agent: () => 'claude',
    resolveIssue: () => TASK,
    issueFacts: () => ({ kind: 'issue', open: true, tranche: null }),
    isRunAlive: () => false,
    loopState: () => state,
    // The REAL disposition reader, over the fixture's own records — so the
    // gate's paused branch is exercised against the same files the
    // continuation reads, never a hand-written answer.
    pauseDisposition: (issue) => defaultPauseDisposition(issue, root),
    heldAgent: (issue) => defaultHeldAgent(issue, root),
    isPidAlive: () => false,
    processSnapshot: () => null,
    launch: async (target) => {
      launches.push(target)
      return { status: 'confirmed', pid: 1 }
    },
    now: () => '2026-09-26T00:00:00.000Z'
  })
  const result = await handler({ tranche: 'unattended-run-v1', id: '17' }, CALLER)
  return result.ok ? { ok: launches.length === 1, message: 'launched' } : { ok: false, message: result.error.message }
}

/**
 * `task_resume` driven for real against the fixture's own runtime directory.
 *
 * Acceptance here means the tool LAUNCHED a continuation — `ok`, with an
 * outcome that names a started run. It deliberately does NOT mean "the
 * refusal did not contain one particular phrase": an earlier version of this
 * probe scored any message without "nothing to resume" as acceptance, so a
 * real `precondition`/`authority` refusal counted as the action working, and
 * the paused row — the one row this tool owns — asserted nothing at all.
 *
 * A Principal ruling is supplied through the injected forge reads, because
 * that is what the paused row's action IS: authenticating a pause against a
 * ruling. Withholding it would test the absence of a ruling, not the action.
 */
async function taskResumeAccepts(root: string): Promise<{ ok: boolean; message: string }> {
  const deps: Partial<TaskResumeDeps> & Pick<TaskResumeDeps, 'runtimeDir'> = { runtimeDir: () => root }
  const launches: unknown[] = []
  const handler = createTaskResumeHandler({
    ...({
      resolveIssueForRef: () => TASK,
      fetchRulings: () => ['RULING: resume.'],
      fetchNewestRulingAuthor: () => 'principal-1',
      fetchNewestRulingOrdinal: () => 9,
      store: { claim: (r: unknown) => ({ claimed: true, record: r }), update: () => {}, release: () => {} },
      isPidAlive: () => false,
      launch: async (target: unknown) => {
        launches.push(target)
        return { status: 'confirmed', pid: 1 }
      },
      now: () => '2026-09-26T00:00:00.000Z',
      log: () => {}
    } as unknown as TaskResumeDeps),
    ...deps
  })
  const result = await handler({ task: { issue: TASK } }, CALLER)
  if (!result.ok) return { ok: false, message: `refused (${result.error.kind}): ${result.error.message}` }
  const outcome = (result.result as { outcome?: string }).outcome ?? 'unknown'
  return outcome === 'started' && launches.length === 1
    ? { ok: true, message: 'resumed' }
    : { ok: false, message: `answered '${outcome}' and launched ${launches.length} continuation(s)` }
}

/**
 * Does the tool the doctrine names accept this state?
 *
 * Every branch drives the REAL handler and asserts something that state could
 * make fail: `task_start` must launch, `task_resume` must answer `started`
 * having launched exactly one continuation, `task_status` must read back this
 * row's own state, and `task_pr_read` must answer rather than refuse. None of
 * them scores acceptance on a string that is true whatever happens.
 */
async function toolAccepts(
  action: string,
  root: string,
  state: TaskLoopState
): Promise<{ ok: boolean; message: string }> {
  switch (action) {
    case 'task_start':
      return await taskStartAccepts(root, state)
    case 'task_resume':
      return await taskResumeAccepts(root)
    case 'task_status': {
      // Binding, not merely non-empty: the read must answer with THIS row's
      // own state. A non-empty string is true of every kind, so scoring on
      // length asserted nothing a regression could break.
      const observed = readTaskLoopStateObserved(root, TASK)
      const rendered = describeTaskLoopState(observed.value)
      return observed.value.kind === state.kind
        ? { ok: true, message: rendered }
        : { ok: false, message: `read back '${observed.value.kind}' (${rendered}), not '${state.kind}'` }
    }
    case 'task_pr_read': {
      // The REAL handler, over an injected forge — not a hardcoded `true`.
      // It reads the task's own pull request and nothing about the run, so
      // it answers in every state; driving it is what would catch the day
      // that stops being true.
      const result = taskPrReadHandler(
        { task: { issue: TASK } },
        {
          resolveTask: () => ({ issue: TASK, pr: 900 }),
          fetchChecks: () => ({ head: 'abc123', checks: [] }),
          fetchComments: () => [],
          principalAllowlist: () => ['principal-1']
        }
      )
      return result.ok
        ? { ok: true, message: 'read the pull request' }
        : { ok: false, message: `refused (${result.error.kind}): ${result.error.message}` }
    }
    default:
      throw new Error(`the doctrine names "${action}", which this test has no way to drive`)
  }
}

describe("the Operator's doctrine and the Operator's tools agree, state for state", () => {
  it('names an action for exactly the states `task_status` can report — no more, no fewer', () => {
    const rows = readDoctrineTable()
    expect(new Set(rows.map((r) => r.state))).toEqual(new Set(Object.keys(FIXTURES)))
    expect(rows).toHaveLength(Object.keys(FIXTURES).length)
  })

  it('names only tools the Operator is actually granted', () => {
    for (const row of readDoctrineTable()) expect(GRANTED).toContain(row.action)
  })

  /**
   * The property that actually keeps a state from being stranded: the action
   * the doctrine names is never a dead end. It either moves the run, or it
   * declines and hands over a tool that does.
   *
   * Plain acceptance is too strong to state over a whole row, and demanding
   * it is what pushed the paused row to name `task_resume` — a tool that
   * answers `already_resumed` without starting anything for a pause already
   * ruled on, and refuses for want of a ruling nobody posts on an automatic
   * hiccup. Both are "not a refusal", and neither is an action.
   */
  it('names, for every state, an action that is not a dead end', async () => {
    for (const row of readDoctrineTable()) {
      const { root, state } = realStateFor(row.state as TaskLoopState['kind'])
      expect(state.kind).toBe(row.state as TaskLoopState['kind'])
      const outcome = await toolAccepts(row.action, root, state)
      if (outcome.ok) continue
      const handedOver = [...TASK_TOOL_NAMES].filter((name) => name !== row.action && outcome.message.includes(name))
      expect(`${row.state} → ${row.action} declined, naming: ${handedOver.join(',') || '(nothing)'}`).not.toContain(
        '(nothing)'
      )
    }
  })

  it('refuses `task_start` for exactly the states the doctrine gives to another tool, naming that tool', async () => {
    for (const row of readDoctrineTable()) {
      const { root, state } = realStateFor(row.state as TaskLoopState['kind'])
      const outcome = await taskStartAccepts(root, state)
      // Either the named action moved the run, or it declined and handed
      // over a tool that does. A refusal naming nothing is the dead end this
      // whole table exists to rule out.
      if (outcome.ok) continue
      const handedOver = [...TASK_TOOL_NAMES].filter((name) => outcome.message.includes(name))
      expect(`${row.state} → ${row.action} declined, naming: ${handedOver.join(',') || '(nothing)'}`).not.toContain(
        '(nothing)'
      )
    }
  })

  /**
   * What `task_start` itself refuses, asserted against an explicit table
   * rather than against whatever the doctrine happens to name — so a row
   * quietly losing its gate cannot make this case vacuous. The fixtures are
   * the ones `FIXTURES` builds, so the paused entry here is the
   * awaiting-a-decision shape; the other pause shapes have their own cases
   * below.
   */
  it('refuses exactly the states another tool owns, naming that tool', async () => {
    const EXPECTED_REFUSAL: Partial<Record<TaskLoopState['kind'], string>> = {
      running: 'task_status',
      paused: 'task_resume'
    }
    for (const kind of Object.keys(FIXTURES) as TaskLoopState['kind'][]) {
      const { root, state } = realStateFor(kind)
      const outcome = await taskStartAccepts(root, state)
      const owner = EXPECTED_REFUSAL[kind]
      if (owner === undefined) {
        expect(`${kind}: ${outcome.message}`).toBe(`${kind}: launched`)
        continue
      }
      expect(`${kind}: ${outcome.ok ? 'launched' : 'refused'}`).toBe(`${kind}: refused`)
      expect(outcome.message).toContain(owner)
    }
  })

  it('re-attaches an exited run rather than refusing it — the state that had no working tool', async () => {
    const { root, state } = realStateFor('exited')
    expect(state).toEqual({ kind: 'exited', reason: 'signal', lastDecision: 'dispatch_developer' })
    // The tool the doctrine used to name for this state, driven against the
    // same real runtime directory: it refuses, for want of a pause record.
    const resume = await taskResumeAccepts(root)
    expect(resume.ok).toBe(false)
    expect(resume.message).toContain('nothing to resume')
    // The tool it names now: accepted.
    expect((await taskStartAccepts(root, state)).message).toBe('launched')
  })

  /**
   * The paused row is one table row over FOUR situations, and the table's
   * single named action is right for only one of them. This is where the
   * rest are held: whatever a pause is waiting for, some tool moves it, and
   * when `task_start` declines it names the tool that does.
   *
   * The stranding this closes was invisible before because the doctrine's
   * row said `task_resume` and nothing checked that `task_resume` would
   * actually launch: for a pause already ruled on it replays
   * `already_resumed` and launches nothing, and for a recoverable
   * infrastructure pause it refuses for want of a ruling nobody posts.
   */
  describe('every pause shape has a tool that moves it', () => {
    const shapes = [
      { name: 'awaiting a decision', reason: 'escalation' as const, resolution: null, mover: 'task_resume' },
      {
        name: 'already ruled resume',
        reason: 'escalation' as const,
        resolution: 'resume' as const,
        mover: 'task_start'
      },
      { name: 'recoverable infrastructure', reason: 'infrastructure' as const, resolution: null, mover: 'task_start' },
      {
        name: 'already ruled cancel',
        reason: 'escalation' as const,
        resolution: 'cancel' as const,
        mover: 'task_cancel'
      }
    ]

    for (const shape of shapes) {
      it(`a pause ${shape.name} is moved by \`${shape.mover}\``, async () => {
        const root = tempDir()
        writePause(root, TASK, 2, shape.reason)
        if (shape.resolution) writeResolution(root, TASK, 2, shape.resolution)
        const state = deriveLoopState(root, TASK, { repo: null, loopsRoot: root })
        expect(state.kind).toBe('paused')

        const start = await taskStartAccepts(root, state)
        if (shape.mover === 'task_start') {
          // No Principal act is owed, so the start path is the continuation.
          expect(`${shape.name}: ${start.message}`).toBe(`${shape.name}: launched`)
          return
        }
        // Declined here — and the refusal must hand over the tool that moves
        // it, never leave the Operator without one.
        expect(start.ok).toBe(false)
        expect(start.message).toContain(shape.mover)
        if (shape.mover === 'task_resume') {
          const resume = await taskResumeAccepts(root)
          expect(`${shape.name}: ${resume.ok ? 'resumed' : resume.message}`).toBe(`${shape.name}: resumed`)
        }
      })
    }

    it('holds a pause whose driver was killed, though it derives exited, not paused', async () => {
      // The production shape of a killed pause: `task run` composes the
      // watching driver, which retains its lock at EVERY pause reason, and
      // the signal handler leaves an exit trace. `deriveLoopState` answers
      // `exited` while the pause record still holds the run, so a gate that
      // asked for the disposition only under `paused` let this launch past
      // the ruling it is still waiting for.
      const root = tempDir()
      writePause(root, TASK, 2, 'escalation')
      writeDriverLock(root, TASK, deadPid())
      appendRoleLine(
        loopLogPathFor(null, TASK, root),
        'dev-review-loop',
        'driver_exited: reason=signal last_decision=dispatch_developer'
      )
      const state = deriveLoopState(root, TASK, { repo: null, loopsRoot: root })
      expect(state.kind).toBe('exited')
      expect(defaultPauseDisposition(TASK, root)).toBe('awaiting_ruling')

      const start = await taskStartAccepts(root, state)
      expect(start.ok).toBe(false)
      expect(start.message).toContain('task_resume')
      // And the tool it names does move it.
      const resume = await taskResumeAccepts(root)
      expect(`killed pause: ${resume.ok ? 'resumed' : resume.message}`).toBe('killed pause: resumed')
    })

    it('does not hold a run whose pause a later published round superseded', async () => {
      // A pause record is never cleared on resume, so reading it directly —
      // which the gate must, to see a killed pause at all — has to apply the
      // same supersede rule `deriveLoopState` does, or a task that paused,
      // resumed and published rounds ago would be refused forever.
      const root = tempDir()
      writePause(root, TASK, 2, 'escalation')
      writePublishedRound(root, TASK, 3)
      const state = deriveLoopState(root, TASK, { repo: null, loopsRoot: root })
      expect(state.kind).toBe('published')
      expect(defaultPauseDisposition(TASK, root)).toBe('none')
      expect((await taskStartAccepts(root, state)).message).toBe('launched')
    })

    it('refuses rather than guessing when a resolution record will not parse', async () => {
      // A resolution that cannot be read might be the `cancel` the gate
      // exists to protect, so it is never read as "no decision recorded".
      const root = tempDir()
      writePause(root, TASK, 2, 'escalation')
      const dir = join(taskDir(root, TASK), 'control', 'resolution')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${escalationIdFor(TASK, 2, 'abc123')}.json`), '{ not json', 'utf8')
      expect(defaultPauseDisposition(TASK, root)).toBe('unreadable')

      const state = deriveLoopState(root, TASK, { repo: null, loopsRoot: root })
      const start = await taskStartAccepts(root, state)
      expect(start.ok).toBe(false)
      expect(start.message).toContain('could not read')
    })

    it("pins its restated retry bound to the loop's own constant", () => {
      // The gate restates the bound rather than importing it, to keep the
      // loop's round-assessment module out of this one's import graph — the
      // pre-push selector walks that graph and three pinned change-sets went
      // past their time budget with the extra edge. This is what stops the
      // restated literal from drifting.
      expect(INFRASTRUCTURE_RETRY_BOUND).toBe(MAX_INFRASTRUCTURE_RETRIES)
    })

    it("holds an infrastructure pause once it is at the loop's own retry bound", async () => {
      // Inside the bound the loop continues this reason with no ruling, so
      // `task_start` is its mover. AT the bound it does not: it falls through
      // to a gate that refuses only when the pull request carries NO ruling
      // at all, with no ordinal-freshness check, so any older ruling still on
      // the pull request would authenticate a continuation past the bound.
      // A ruling is genuinely owed here, and saying so is what routes it to
      // the tool that authenticates one.
      const under = tempDir()
      writePause(under, TASK, 2, 'infrastructure')
      writeRecordedRetries(under, TASK, INFRASTRUCTURE_RETRY_BOUND - 1)
      expect(defaultPauseDisposition(TASK, under)).toBe('self_resuming')
      expect(
        (await taskStartAccepts(under, deriveLoopState(under, TASK, { repo: null, loopsRoot: under }))).message
      ).toBe('launched')

      const atBound = tempDir()
      writePause(atBound, TASK, 2, 'infrastructure')
      writeRecordedRetries(atBound, TASK, INFRASTRUCTURE_RETRY_BOUND)
      expect(defaultPauseDisposition(TASK, atBound)).toBe('awaiting_ruling')
      const refused = await taskStartAccepts(
        atBound,
        deriveLoopState(atBound, TASK, { repo: null, loopsRoot: atBound })
      )
      expect(refused.ok).toBe(false)
      expect(refused.message).toContain('task_resume')
    })

    it('counts the bound from the pause record too, and a control-store record that will not parse as past it', () => {
      // The same floor the loop applies: whichever count is higher wins, and
      // a `loop_state` record that will not parse is never read as a low one.
      const fromPauseRecord = tempDir()
      writePause(fromPauseRecord, TASK, 2, 'infrastructure')
      writeControlFile(fromPauseRecord, TASK, 'pause-state.json', {
        task: TASK,
        round: 2,
        head: 'abc123',
        branch: `task/issue-${TASK}`,
        prNumber: 900,
        reason: 'infrastructure',
        pausedAt: '2026-09-26T00:00:00.000Z',
        escalationId: escalationIdFor(TASK, 2, 'abc123'),
        infrastructureRetries: INFRASTRUCTURE_RETRY_BOUND
      })
      expect(defaultPauseDisposition(TASK, fromPauseRecord)).toBe('awaiting_ruling')

      const corruptBudget = tempDir()
      writePause(corruptBudget, TASK, 2, 'infrastructure')
      writeFileSync(join(taskDir(corruptBudget, TASK), 'control', 'loop-state.json'), '{ not json', 'utf8')
      expect(defaultPauseDisposition(TASK, corruptBudget)).toBe('awaiting_ruling')
    })

    it('holds a run whose pause record itself will not parse, rather than starting fresh past it', async () => {
      // `readPauseState` answers the same `null` for "no record" and "a
      // record that will not parse", and `writePauseState` is a plain
      // non-atomic write — so the kill this whole task is about can leave a
      // truncated record. Read as `none` it would not merely skip the
      // refusal: `runTask`'s own `hasPauseState` reads that identical null,
      // so the launch would be a FRESH dispatch rather than a resume.
      const root = tempDir()
      mkdirSync(join(taskDir(root, TASK), 'control'), { recursive: true })
      writeFileSync(join(taskDir(root, TASK), 'control', 'pause-state.json'), '{"task":990', 'utf8')
      expect(defaultPauseDisposition(TASK, root)).toBe('unreadable')

      const state = deriveLoopState(root, TASK, { repo: null, loopsRoot: root })
      const start = await taskStartAccepts(root, state)
      expect(start.ok).toBe(false)
      expect(start.message).toContain('could not read')
    })

    it('reads the disposition from the same records the continuation reads', () => {
      const awaiting = tempDir()
      writePause(awaiting, TASK, 2, 'escalation')
      expect(defaultPauseDisposition(TASK, awaiting)).toBe('awaiting_ruling')

      const selfResuming = tempDir()
      writePause(selfResuming, TASK, 2, 'infrastructure')
      expect(defaultPauseDisposition(TASK, selfResuming)).toBe('self_resuming')

      const ruled = tempDir()
      writePause(ruled, TASK, 2, 'escalation')
      writeResolution(ruled, TASK, 2, 'resume')
      expect(defaultPauseDisposition(TASK, ruled)).toBe('resolved_resume')

      const cancelled = tempDir()
      writePause(cancelled, TASK, 2, 'escalation')
      writeResolution(cancelled, TASK, 2, 'cancel')
      expect(defaultPauseDisposition(TASK, cancelled)).toBe('resolved_cancel')

      // No pause record at all — every non-paused state.
      expect(defaultPauseDisposition(TASK, tempDir())).toBe('none')
    })
  })

  it('reads no loop state in `task_pr_read`, which is why every row may name it', () => {
    const source = readFileSync(join(import.meta.dir, '../../../src/lib/task-tools/pr-read.ts'), 'utf8')
    for (const reader of ['deriveLoopState', 'readPauseState', 'readDriverLock', 'newestPublishedRound']) {
      expect(source).not.toContain(reader)
    }
  })
})
