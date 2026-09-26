import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OPERATOR_STATUS_FOLLOW, TASK_TOOL_NAMES } from '@attalabs/aeg-core'
import { appendRoleLine, loopLogPathFor } from '../../../src/lib/loop-log.js'
import { deriveLoopState, type TaskLoopState } from '../../../src/lib/task-status.js'
import { describeTaskLoopState, readTaskLoopStateObserved } from '../../../src/lib/task-tools/read.js'
import { createTaskResumeHandler, type TaskResumeDeps } from '../../../src/lib/task-tools/resume.js'
import { createTaskStartHandler } from '../../../src/lib/task-tools/start.js'
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
const TASK = 772
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

function taskDir(root: string, task: number): string {
  return join(root, 'tasks-execution', String(task))
}

function writeControlFile(root: string, task: number, name: string, body: unknown): void {
  const dir = join(taskDir(root, task), 'control')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), JSON.stringify(body), 'utf8')
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

function writePause(root: string, task: number, round: number): void {
  writeControlFile(root, task, 'pause-state.json', {
    task,
    round,
    head: 'abc123',
    branch: `task/issue-${task}`,
    prNumber: 900,
    reason: 'escalation',
    pausedAt: '2026-09-26T00:00:00.000Z'
  })
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
    isPidAlive: () => false,
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
 * `task_resume`'s own state precondition, driven against the real runtime
 * directory. A refusal naming "nothing to resume" is this tool saying the
 * state is not its own — the exact answer that left the exited state
 * stranded when the doctrine still pointed at it.
 */
async function taskResumeAccepts(root: string): Promise<{ ok: boolean; message: string }> {
  const deps: Partial<TaskResumeDeps> & Pick<TaskResumeDeps, 'runtimeDir'> = { runtimeDir: () => root }
  const handler = createTaskResumeHandler({
    ...({
      resolveIssueForRef: () => TASK,
      fetchRulings: () => [],
      fetchNewestRulingAuthor: () => null,
      fetchNewestRulingOrdinal: () => 0,
      store: { claim: (r: unknown) => ({ claimed: true, record: r }), update: () => {}, release: () => {} },
      isPidAlive: () => false,
      launch: async () => ({ status: 'confirmed', pid: 1 }),
      now: () => '2026-09-26T00:00:00.000Z',
      log: () => {}
    } as unknown as TaskResumeDeps),
    ...deps
  })
  const result = await handler({ task: { issue: TASK } }, CALLER)
  if (result.ok) return { ok: true, message: 'resumed' }
  return { ok: !/nothing to resume/.test(result.error.message), message: result.error.message }
}

/**
 * Does the tool the doctrine names accept this state?
 *
 * `task_status` and `task_pr_read` are the two reads in the table. The status
 * read is driven for real below. `task_pr_read` reads the task's own pull
 * request and nothing about the run — an assertion the test makes mechanically
 * rather than by assumption (see "reads no loop state", below) — so there is
 * no run state it can refuse.
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
      const observed = readTaskLoopStateObserved(root, TASK)
      return { ok: describeTaskLoopState(observed.value).length > 0, message: describeTaskLoopState(observed.value) }
    }
    case 'task_pr_read':
      return { ok: true, message: 'a pull-request read, independent of run state' }
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

  it('names, for every state, an action the tools accept in that state', async () => {
    for (const row of readDoctrineTable()) {
      const { root, state } = realStateFor(row.state as TaskLoopState['kind'])
      expect(state.kind).toBe(row.state as TaskLoopState['kind'])
      const outcome = await toolAccepts(row.action, root, state)
      expect(`${row.state} → ${row.action}: ${outcome.ok ? 'accepted' : outcome.message}`).toBe(
        `${row.state} → ${row.action}: accepted`
      )
    }
  })

  it('refuses `task_start` for exactly the states the doctrine gives to another tool, naming that tool', async () => {
    for (const row of readDoctrineTable()) {
      const { root, state } = realStateFor(row.state as TaskLoopState['kind'])
      const outcome = await taskStartAccepts(root, state)
      if (row.action === 'task_start') {
        expect(`${row.state}: ${outcome.message}`).toBe(`${row.state}: launched`)
        continue
      }
      // A row `task_start` does not own is either refused — and then the
      // refusal must hand the Operator the tool the doctrine names, never a
      // dead end — or simply not this tool's business to refuse.
      if (!outcome.ok) expect(outcome.message).toContain(row.action)
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

  it('reads no loop state in `task_pr_read`, which is why every row may name it', () => {
    const source = readFileSync(join(import.meta.dir, '../../../src/lib/task-tools/pr-read.ts'), 'utf8')
    for (const reader of ['deriveLoopState', 'readPauseState', 'readDriverLock', 'newestPublishedRound']) {
      expect(source).not.toContain(reader)
    }
  })
})
