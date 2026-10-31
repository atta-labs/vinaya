import { fixtureDir } from '../../../../apps/cli/tests/lib/test-temp-fixture'
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { SpawnedProcessLike } from '@atta/executor-agent-spawn'
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph'
import { loadProcess } from '../../../../harness/dev-process/loader/load-process'
import type { ActionRegistry, ProcessAction } from '../../../../harness/dev-process/engine-runtime/run-process'
import {
  CHECKPOINT_FORMAT_VERSION,
  ENGINE_RUNTIME_VERSION,
  SqliteCheckpointer,
  type CheckpointProvenance
} from '../../../../harness/dev-process/engine-runtime/sqlite-checkpointer'
import { ACTION_BINDINGS, classifyGateResult, dispatchReviewers, type TaskInput } from '../../executing/actions'
import { checkpointPath, runDirectory, runEngine, type Agent, type EngineRunOptions } from '../../bin/run-engine'
import { runIdentityOfTask } from '../../bin/run-lifecycle'
import { recordedHandoff } from '../../tests/handoff-fakes'

// The checkpoint a run halted at its missing-source pause left, written by the Engine runtime of the default-branch
// commit this proof was frozen at, committed as rows and rebuilt here through the same checkpointer the runtime uses.
// Every later move of the process must resume it: the refused step runs again, the next step follows, and no step the
// checkpoint records as completed runs a second time. Its writer commit must stay in the history of every head.

const processDir = resolve(import.meta.dir, '../..')
const repoRoot = resolve(processDir, '../..')
const FIXTURE = join(import.meta.dir, 'fixtures/pre-move-checkpoint.json')
const AGENTS = ['claude', 'codex'] as const
const TASK = 7
const BRANCH = 'task/issue-7'

// A stub login keeps the real role launcher from copying an operator's Codex credential into a test run.
const stubHome = fixtureDir('pre-move-codex-home-')
writeFileSync(join(stubHome, 'auth.json'), '{}\n')
process.env.CODEX_HOME = stubHome

/** The one command that writes the fixture, run from the process folder. */
export const WRITER_COMMAND =
  'VINAYA_WRITE_PRE_MOVE_CHECKPOINT=1 bun test evals/structure-proof/pre-move-checkpoint.test.ts'

/** The steps the halted run completed before the pause, and the refused step it paused on. */
const COMPLETED_BEFORE_PAUSE = ['prepare-run', 'reconcile-external-state'] as const
const REFUSED_STEP = 'prepare-sources'

interface CheckpointRowJson {
  checkpointNs: string
  checkpointId: string
  parentId: string | null
  checkpoint: Checkpoint
  metadata: CheckpointMetadata
  pendingWrites: Array<[string, string, unknown]>
}

interface FixtureRun {
  agent: Agent
  threadId: string
  provenance: CheckpointProvenance
  flow: string
  /** Oldest first, the order the runtime wrote them in. */
  rows: CheckpointRowJson[]
}

export interface PreMoveFixture {
  /** The command that wrote this fixture, run from `processes/vinaya`. */
  writerCommand: string
  /** The default-branch commit the writing tree started from; never a task-branch commit. */
  writerCommit: string
  /** The process the checkpoint was written under. */
  process: { id: string; version: string; flowKey: string; digest: string }
  task: number
  runs: FixtureRun[]
}

// --- a stub-agent Engine run ------------------------------------------------------

const ROLE_STEP: Record<string, string> = {
  developer: 'develop',
  'code-reviewer': 'code-review',
  'security-reviewer': 'security-review'
}

function roleOfLaunch(agent: Agent, args: string[], env: Record<string, string | undefined> | undefined): string {
  const dir =
    agent === 'claude'
      ? (args[args.indexOf('--settings') + 1] ?? '').split('/').at(-2)
      : (env?.CODEX_HOME ?? '').split('/').at(-1)
  return dir ?? ''
}

function stubAgent(lines: string[]): SpawnedProcessLike {
  const closeListeners: Array<(code: number | null) => void> = []
  let stdout: ((chunk: string) => void) | undefined
  return {
    stdin: {
      write: () => {},
      end: () => {
        setTimeout(() => {
          for (const line of lines) stdout?.(`${line}\n`)
          for (const listener of closeListeners) listener(0)
        }, 0)
      }
    },
    stdout: { on: (_event, listener) => (stdout = listener as (chunk: string) => void) },
    stderr: { on: () => {} },
    on: ((event: string, listener: (code: number | null) => void) => {
      if (event === 'close') closeListeners.push(listener)
    }) as SpawnedProcessLike['on'],
    kill: () => {
      setTimeout(() => {
        for (const listener of closeListeners) listener(null)
      }, 0)
    }
  } as SpawnedProcessLike
}

const review = (role: string) =>
  JSON.stringify({
    reviewResult: {
      schemaVersion: 1,
      role,
      status: 'completed',
      headSha: 'abc',
      manifestDigest: 'd',
      summary: 'fine',
      findings: [],
      objectiveResults: []
    }
  })
const AGENT_LINES: Record<string, string[]> = {
  developer: ['{"type":"result"}'],
  'code-reviewer': [review('code-reviewer')],
  'security-reviewer': [review('security-reviewer')]
}

function stubRun(agent: Agent, runtimeDir: string, revision: string, replaced: Record<string, ProcessAction> = {}) {
  const loaded = loadProcess(processDir)
  const spawns: string[] = []
  const actionRuns: Record<string, number> = {}
  const actions: ActionRegistry = Object.fromEntries(
    Object.keys(ACTION_BINDINGS).map((name) => [
      name,
      async (context) => {
        actionRuns[context.nodeId] = (actionRuns[context.nodeId] ?? 0) + 1
        const action = replaced[name]
        if (action) return action(context)
        if (name === 'vinaya.classify-gate-result') return classifyGateResult(context)
        if (name === 'vinaya.dispatch-reviewers') return dispatchReviewers()
        return { exitCode: 0 }
      }
    ])
  )
  const handoff = recordedHandoff()
  const options: EngineRunOptions = {
    args: { task: TASK, agent, dryRun: false },
    process: loaded,
    repoRoot,
    runtimeDir,
    loopId: 'pre-move-checkpoint',
    taskInput: { branch: BRANCH } as TaskInput,
    heldPullRequestConflicts: async () => false,
    handoffDeps: { ...handoff.deps, sleepSync: () => {} },
    actions,
    sink: { log: () => {}, drain: async () => {} },
    startHost: async () => ({ close: async () => {} }),
    devToolsContext: {} as never,
    out: () => {},
    revision,
    lifecycle: { killGraceMs: 200, handleSignals: false },
    spawnFn: (_command, args, spawnOptions) => {
      const role = roleOfLaunch(agent, args, spawnOptions?.env)
      spawns.push(ROLE_STEP[role] as string)
      return stubAgent(AGENT_LINES[role] ?? [])
    }
  }
  return { options, spawns, actionRuns, loaded }
}

// --- the rows, out of and back into the checkpointer -------------------------------

/** Every checkpoint of the thread, oldest first, read through the checkpointer's own `list`. */
async function exportRows(saver: SqliteCheckpointer, threadId: string): Promise<CheckpointRowJson[]> {
  const rows: CheckpointRowJson[] = []
  for await (const tuple of saver.list({ configurable: { thread_id: threadId } })) {
    const configurable = tuple.config.configurable ?? {}
    const { pending_sends: _sends, ...checkpoint } = tuple.checkpoint
    rows.push({
      checkpointNs: (configurable.checkpoint_ns as string | undefined) ?? '',
      checkpointId: tuple.checkpoint.id,
      parentId: (tuple.parentConfig?.configurable?.checkpoint_id as string | undefined) ?? null,
      checkpoint: checkpoint as Checkpoint,
      metadata: tuple.metadata as CheckpointMetadata,
      pendingWrites: (tuple.pendingWrites ?? []) as Array<[string, string, unknown]>
    })
  }
  return JSON.parse(JSON.stringify(rows.reverse())) as CheckpointRowJson[]
}

/** Writes a run's rows into a new checkpoint file through the checkpointer's own `put` and `putWrites`. */
async function rebuildCheckpoint(run: FixtureRun, path: string): Promise<void> {
  const saver = new SqliteCheckpointer({
    path,
    revision: run.provenance.revision,
    model: run.provenance.model,
    formatVersion: run.provenance.formatVersion ?? undefined,
    runtimeVersion: run.provenance.runtimeVersion ?? undefined,
    agent: run.agent,
    flow: run.flow
  })
  try {
    for (const row of run.rows) {
      const parent = {
        configurable: {
          thread_id: run.threadId,
          checkpoint_ns: row.checkpointNs,
          ...(row.parentId ? { checkpoint_id: row.parentId } : {})
        }
      }
      // The saver stores no pending sends of its own; it reads them back from the parent's writes.
      await saver.put(parent, { ...row.checkpoint, pending_sends: [] }, row.metadata)
      const byTask = new Map<string, Array<[string, unknown]>>()
      for (const [taskId, channel, value] of row.pendingWrites) {
        byTask.set(taskId, [...(byTask.get(taskId) ?? []), [channel, value]])
      }
      for (const [taskId, writes] of byTask) {
        await saver.putWrites(
          {
            configurable: { thread_id: run.threadId, checkpoint_ns: row.checkpointNs, checkpoint_id: row.checkpointId }
          },
          writes,
          taskId
        )
      }
    }
  } finally {
    saver.close()
  }
}

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** Why the fixture's writer commit cannot stand behind it on this head, or null when it can. */
export function writerCommitRefusal(writerCommit: string, isAncestor: (commit: string) => boolean): string | null {
  if (!/^[0-9a-f]{40}$/.test(writerCommit)) return `the writer commit "${writerCommit}" is not a full commit id`
  if (!isAncestor(writerCommit))
    return `the writer commit ${writerCommit} is not an ancestor of the current head: record the default-branch commit the writing tree started from`
  return null
}

const isAncestorOfHead = (commit: string): boolean => {
  try {
    git('merge-base', '--is-ancestor', commit, 'HEAD')
    return true
  } catch {
    return false
  }
}

/** Any absolute or machine-specific path the serialized fixture would carry. */
function machinePaths(text: string, roots: string[]): string[] {
  const found = roots.filter((root) => root.length > 1 && text.includes(root))
  for (const pattern of [/\/Users\/[^"/]+/, /\/home\/[^"/]+/, /\/private\/(?:tmp|var)\//, /[A-Z]:\\\\/]) {
    const match = pattern.exec(text)
    if (match) found.push(match[0])
  }
  return found
}

// --- the writer ------------------------------------------------------------------------

/** Runs the halted run on each agent and writes the fixture. Only `WRITER_COMMAND` reaches this. */
async function writeFixture(): Promise<void> {
  const writerCommit = git('merge-base', 'HEAD', 'origin/main')
  const runs: FixtureRun[] = []
  let processIdentity: PreMoveFixture['process'] | undefined
  for (const agent of AGENTS) {
    const runtimeDir = fixtureDir('pre-move-write-')
    let refused = false
    const run = stubRun(agent, runtimeDir, writerCommit, {
      'vinaya.prepare-sources': () => {
        if (refused) return { exitCode: 0 }
        refused = true
        const detail = 'a required source could not be read'
        run.options.taskInput.handoff?.pause({ reason: 'missing_source', detail })
        return { exitCode: 1, stdout: detail, refused: true }
      }
    })
    await runEngine(run.options)
    expect(run.spawns).toEqual([])
    processIdentity = {
      id: run.loaded.identity.id,
      version: run.loaded.identity.version,
      flowKey: run.loaded.flowKey,
      digest: run.loaded.digest
    }
    const threadId = runIdentityOfTask(TASK).threadId
    const saver = new SqliteCheckpointer({ path: checkpointPath(runDirectory(runtimeDir, TASK)), revision: 'unknown' })
    try {
      runs.push({
        agent,
        threadId,
        provenance: saver.latestProvenance(threadId) as CheckpointProvenance,
        flow: run.loaded.flowKey,
        rows: await exportRows(saver, threadId)
      })
    } finally {
      saver.close()
    }
  }
  const fixture: PreMoveFixture = {
    writerCommand: WRITER_COMMAND,
    writerCommit,
    process: processIdentity as PreMoveFixture['process'],
    task: TASK,
    runs
  }
  writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`)
}

// --- the proof -------------------------------------------------------------------------

const writing = process.env.VINAYA_WRITE_PRE_MOVE_CHECKPOINT === '1'

if (writing) {
  test('writes the pre-move checkpoint fixture', writeFixture, 60_000)
} else {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as PreMoveFixture

  describe('the pre-move checkpoint fixture', () => {
    test('names the command that wrote it, and a writer commit in the history of this head', () => {
      expect(fixture.writerCommand).toBe(WRITER_COMMAND)
      expect(writerCommitRefusal(fixture.writerCommit, isAncestorOfHead)).toBeNull()
      expect(fixture.runs.map((run) => run.provenance.revision)).toEqual(AGENTS.map(() => fixture.writerCommit))
    })

    test('a writer commit that is not an ancestor of the head is refused', () => {
      const branchOnly = 'f'.repeat(40)
      expect(writerCommitRefusal(branchOnly, isAncestorOfHead)).toContain('is not an ancestor of the current head')
      expect(writerCommitRefusal('main', () => true)).toContain('is not a full commit id')
      expect(writerCommitRefusal(fixture.writerCommit, () => false)).toContain('is not an ancestor')
    })

    test('records the process and the Engine runtime it was written under, and no machine path', () => {
      const current = loadProcess(processDir)
      expect(fixture.process.id).toBe(current.identity.id)
      expect(fixture.process.flowKey).toBe(current.flowKey)
      for (const run of fixture.runs) {
        expect(run.provenance.formatVersion).toBe(CHECKPOINT_FORMAT_VERSION)
        expect(typeof run.provenance.runtimeVersion).toBe('string')
      }
      expect(machinePaths(readFileSync(FIXTURE, 'utf8'), [repoRoot, process.env.HOME ?? ''])).toEqual([])
    })
  })

  for (const agent of AGENTS) {
    describe(`the pre-move checkpoint on ${agent}`, () => {
      const recorded = fixture.runs.find((run) => run.agent === agent) as FixtureRun

      test('its rows rebuild through the runtime’s checkpointer and read back unchanged', async () => {
        const path = join(fixtureDir('pre-move-rebuild-'), 'checkpoints.sqlite')
        await rebuildCheckpoint(recorded, path)
        const saver = new SqliteCheckpointer({ path, revision: 'unknown' })
        try {
          expect(await exportRows(saver, recorded.threadId)).toEqual(recorded.rows)
          expect(saver.latestProvenance(recorded.threadId)).toEqual(recorded.provenance)
          expect(saver.latestAgent(recorded.threadId)).toBe(agent)
        } finally {
          saver.close()
        }
      })

      test('resumed with the current tree, the run continues at its next step and runs no completed step again', async () => {
        const runtimeDir = fixtureDir('pre-move-resume-')
        const runDir = runDirectory(runtimeDir, fixture.task)
        await rebuildCheckpoint(recorded, checkpointPath(runDir))
        expect(existsSync(checkpointPath(runDir))).toBe(true)
        const head = git('rev-parse', 'HEAD')
        const resumed = stubRun(agent, runtimeDir, head)
        const result = await runEngine(resumed.options)
        expect(result.exitCode).toBe(0)
        expect(result.outcome?.reason).toBe('completed')
        // The refused step was not recorded, so it runs again; what completed before the pause does not.
        expect(resumed.actionRuns[REFUSED_STEP]).toBe(1)
        for (const step of COMPLETED_BEFORE_PAUSE) expect(resumed.actionRuns[step]).toBeUndefined()
        expect(resumed.spawns).toEqual(['develop', 'code-review', 'security-review'])
      }, 60_000)
    })
  }
}
