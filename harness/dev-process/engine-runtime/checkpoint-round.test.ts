import { afterAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RoleBinaryConfig, SpawnFn, SpawnedProcessLike } from '@atta/executor-agent-spawn'
import type { RunnableConfig } from '@langchain/core/runnables'
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph'
import { loadProcess } from '../loader/load-process'
import {
  type ExecutionRoundMirror,
  decodeExecutionRound,
  encodeExecutionRound,
  mirrorExecutionRoundOnCommit,
  readAgentProvenance,
  readEffectiveResumedState,
  readExecutionRound
} from './checkpoint-round'
import { type ProcessRunOptions, resumeProcessRun, startProcessRun } from './run-process'
import { type CheckpointCommit, CheckpointCorruptError, SqliteCheckpointer } from './sqlite-checkpointer'

// A sample Flow whose `advance` step ends a round: it records the round it leaves the run in, inside its own result,
// and loops back to the agent step once. `prepare` records the round the run starts in.
const FLOW = `schema_version: "2.0"
id: round-flow
display_name: Rounds
description: Rounds.
experimental: true
benchmarked: false
defaults:
  model: process-supplied
agents:
  - role: worker
steps:
  - { id: prepare, type: mechanical, action: sample.prepare }
  - id: work
    type: agent
    role: worker
    prompt_template: "Work on {{question}}."
    permission: worker/grants.yaml
    working_directory: "."
    max_turns: 5
  - id: advance
    type: mechanical
    action: sample.advance
    decision: { examine: work, if_true: work, if_false: finish, max_revisions: 3 }
  - { id: finish, type: mechanical, action: sample.finish }
`

const scratchDirs: string[] = []
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'checkpoint-round-'))
  scratchDirs.push(dir)
  return dir
}

function fakeAgentProcess(): SpawnedProcessLike {
  const closeListeners: Array<(code: number | null) => void> = []
  let stdoutListener: ((chunk: string) => void) | undefined
  return {
    stdin: {
      write: () => {},
      end: () => {
        setTimeout(() => {
          stdoutListener?.('{"type":"result","session_id":"s1"}\n')
          for (const listener of closeListeners) listener(0)
        }, 0)
      }
    },
    stdout: {
      on: (_event, listener) => {
        stdoutListener = listener as (chunk: string) => void
      }
    },
    stderr: { on: () => {} },
    on: ((event: string, listener: (code: number | null) => void) => {
      if (event === 'close') closeListeners.push(listener)
    }) as SpawnedProcessLike['on'],
    kill: () => {
      for (const listener of closeListeners) listener(null)
    }
  }
}

/** One driver process's view of the sample run: its in-memory round, restored only from what it is given. */
function driver(
  folder: string,
  checkpointer: SqliteCheckpointer,
  hooks: { afterAdvance?: () => void; beforeFinish?: () => void } = {},
  // The run's decisions, shared by every driver process of one run: the first `advance` revises, the second finishes.
  revise: boolean[] = [true, false]
) {
  const calls: Record<string, number> = {}
  const count = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1
  }
  const memory = { round: 1 }
  const role: RoleBinaryConfig = {
    command: 'worker-agent',
    buildArgs: () => ['--run'],
    allowedPermissions: ['worker/grants.yaml']
  }
  const spawnFn: SpawnFn = () => fakeAgentProcess()
  const options: ProcessRunOptions = {
    process: loadProcess(folder),
    question: 'the sample',
    bindings: {
      actions: {
        'sample.prepare': () => {
          count('prepare')
          return { exitCode: 0, stderr: encodeExecutionRound({ round: memory.round, advancedBy: 'prepare' }) }
        },
        'sample.advance': () => {
          count('advance')
          memory.round += 1
          const stderr = encodeExecutionRound({ round: memory.round, advancedBy: 'advance' })
          hooks.afterAdvance?.()
          return { exitCode: 0, stderr }
        },
        'sample.finish': () => {
          count('finish')
          hooks.beforeFinish?.()
          return { exitCode: 0 }
        }
      },
      decisions: { advance: () => revise.shift() ?? false },
      roles: { worker: role }
    },
    checkpointer,
    workingDirectoryRoot: folder,
    spawnFn
  }
  return { options, calls, memory }
}

function sampleFolder(): string {
  const folder = scratch()
  mkdirSync(join(folder, 'worker'))
  writeFileSync(join(folder, 'worker', 'grants.yaml'), 'role: worker\n')
  writeFileSync(join(folder, 'flow.yaml'), FLOW)
  writeFileSync(join(folder, 'process.yaml'), 'id: sample\nversion: "1"\nflow: flow.yaml\nroles:\n  - worker\n')
  return folder
}

/** A saver that stops saving full checkpoints once `crashed` is set, as a process that died before its next save. */
class CrashingSaver extends SqliteCheckpointer {
  crashed = false
  override async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata) {
    if (this.crashed) return config
    return super.put(config, checkpoint, metadata)
  }
}

describe('the execution round record', () => {
  test('encodes and decodes, and refuses what is not a round', () => {
    const text = encodeExecutionRound({ round: 3, advancedBy: 'advance' })
    expect(decodeExecutionRound(text)).toEqual({ round: 3, advancedBy: 'advance' })
    expect(decodeExecutionRound('[]')).toBeNull()
    expect(decodeExecutionRound('{"executionRound":{"round":0,"advancedBy":"x"}}')).toBeNull()
    expect(() => encodeExecutionRound({ round: 0, advancedBy: 'x' })).toThrow()
  })

  test('the highest recorded round is the one the run is in', () => {
    const mechanical = (stderr: string) => ({
      nodeId: 'n',
      kind: 'mechanical' as const,
      action: 'a',
      command: 'c',
      exitCode: 0,
      stdout: '',
      stderr,
      durationMs: 0
    })
    expect(readExecutionRound({ results: {} })).toBeNull()
    expect(
      readExecutionRound({
        results: {
          prepare: mechanical(encodeExecutionRound({ round: 2, advancedBy: 'prepare' })),
          advance: mechanical(encodeExecutionRound({ round: 4, advancedBy: 'advance' })),
          other: mechanical('not a round')
        }
      })
    ).toEqual({ round: 4, advancedBy: 'advance' })
  })
})

describe('the execution round as checkpoint authority', () => {
  test('a restarted driver reads the round the checkpoint holds, not its own in-memory start', async () => {
    const folder = sampleFolder()
    const path = join(scratch(), 'checkpoints.sqlite')
    const first = new SqliteCheckpointer({ path, revision: 'r' })
    const revise = [true, false]
    // The first driver dies inside the round-ending step, before its result is written.
    const one = driver(
      folder,
      first,
      {
        afterAdvance: () => {
          throw new Error('driver died')
        }
      },
      []
    )
    const failed = await startProcessRun(one.options)
    expect(failed.reason).toBe('failed')
    first.close()
    // The step died before its result was written, so nothing advanced.
    expect((await readEffectiveResumedState(path, failed.identity.threadId)).results.advance).toBeUndefined()

    const second = new SqliteCheckpointer({ path, revision: 'r' })
    const two = driver(folder, second, {}, revise)
    const state = await readEffectiveResumedState(path, failed.identity.threadId)
    two.memory.round = readExecutionRound(state)?.round ?? two.memory.round
    expect(two.memory.round).toBe(1)
    const done = await resumeProcessRun(two.options, failed.identity)
    expect(done.reason).toBe('completed')
    second.close()
    // One revision then a finish: rounds 1 -> 2 -> 3, each advanced once.
    const final = await readEffectiveResumedState(path, failed.identity.threadId)
    expect(readExecutionRound(final)).toEqual({ round: 3, advancedBy: 'advance' })
    expect(two.calls.advance).toBe(2)
  })

  test('a crash after the step pending writes and before the next full checkpoint resumes at the advanced round', async () => {
    const folder = sampleFolder()
    const path = join(scratch(), 'checkpoints.sqlite')
    const first = new CrashingSaver({ path, revision: 'r' })
    const revise = [true, false]
    const one = driver(
      folder,
      first,
      {
        // From here on no full checkpoint is saved: only the step's own pending writes reach the file.
        afterAdvance: () => {
          first.crashed = true
        }
      },
      revise
    )
    one.options.spawnFn = (() => {
      if (first.crashed) throw new Error('driver died before the next dispatch')
      return fakeAgentProcess()
    }) as SpawnFn
    const failed = await startProcessRun(one.options)
    expect(failed.reason).toBe('failed')
    first.close()

    // The last full checkpoint predates the round-ending step; its pending writes hold the advanced round.
    const db = new Database(path, { readonly: true })
    const fullResults = db.query('SELECT COUNT(*) AS n FROM writes WHERE channel = ?').get('results') as { n: number }
    db.close()
    expect(fullResults.n).toBeGreaterThan(0)
    const state = await readEffectiveResumedState(path, failed.identity.threadId)
    expect(readExecutionRound(state)).toEqual({ round: 2, advancedBy: 'advance' })

    const second = new SqliteCheckpointer({ path, revision: 'r' })
    const two = driver(folder, second, {}, revise)
    two.memory.round = readExecutionRound(state)?.round ?? 1
    const done = await resumeProcessRun(two.options, failed.identity)
    second.close()
    expect(done.reason).toBe('completed')
    // The committed round-ending step is not run again: the resumed driver advances once more, 2 -> 3.
    expect(two.calls.advance).toBe(1)
    expect(readExecutionRound(await readEffectiveResumedState(path, failed.identity.threadId))?.round).toBe(3)
  })
})

describe('the control-store mirror', () => {
  test('is written after each committed write that moves the round, keyed by thread and checkpoint', async () => {
    const folder = sampleFolder()
    const path = join(scratch(), 'checkpoints.sqlite')
    const mirrors: ExecutionRoundMirror[] = []
    const saver = new SqliteCheckpointer({
      path,
      revision: 'r',
      onCommit: mirrorExecutionRoundOnCommit({ repository: 'owner/repo', task: 7 }, (mirror) => mirrors.push(mirror))
    })
    const run = driver(folder, saver)
    const done = await startProcessRun(run.options)
    expect(done.reason).toBe('completed')
    saver.close()
    expect(mirrors.map((mirror) => mirror.round)).toEqual([1, 2, 3])
    for (const mirror of mirrors) {
      expect(mirror).toMatchObject({ repository: 'owner/repo', task: 7, threadId: done.identity.threadId })
      expect(mirror.checkpointId.length).toBeGreaterThan(0)
    }
  })

  test('a mirror failure after the commit pauses the run before its next step, and the resume does not re-run the committed step', async () => {
    const folder = sampleFolder()
    const path = join(scratch(), 'checkpoints.sqlite')
    const mirrors: ExecutionRoundMirror[] = []
    const failing = new SqliteCheckpointer({
      path,
      revision: 'r',
      onCommit: mirrorExecutionRoundOnCommit({ repository: 'owner/repo', task: 7 }, (mirror) => {
        if (mirror.round === 2) throw new Error('disk full')
        mirrors.push(mirror)
      })
    })
    const spawned: string[] = []
    const revise = [true, false]
    const one = driver(folder, failing, {}, revise)
    one.options.spawnFn = ((command: string) => {
      spawned.push(command)
      return fakeAgentProcess()
    }) as SpawnFn
    const failed = await startProcessRun(one.options)
    failing.close()
    expect(failed.reason).toBe('failed')
    if (failed.reason === 'failed') expect(failed.error).toContain('disk full')
    // No dispatch ran past the failed write: one agent turn (round 1), then the barrier stopped the revision.
    expect(spawned).toEqual(['worker-agent'])
    expect(one.calls.advance).toBe(1)

    const second = new SqliteCheckpointer({
      path,
      revision: 'r',
      onCommit: mirrorExecutionRoundOnCommit({ repository: 'owner/repo', task: 7 }, (mirror) => mirrors.push(mirror))
    })
    const two = driver(folder, second, {}, revise)
    const state = await readEffectiveResumedState(path, failed.identity.threadId)
    two.memory.round = readExecutionRound(state)?.round ?? 1
    expect(two.memory.round).toBe(2)
    const done = await resumeProcessRun(two.options, failed.identity)
    second.close()
    expect(done.reason).toBe('completed')
    expect(two.calls.advance).toBe(1)
    expect(mirrors.at(-1)?.round).toBe(3)
  })

  test('a commit with no round is never mirrored', () => {
    const mirrors: ExecutionRoundMirror[] = []
    const onCommit = mirrorExecutionRoundOnCommit({ repository: 'o/r', task: 1 }, (mirror) => mirrors.push(mirror))
    const commit: CheckpointCommit = { threadId: 't', checkpointNs: '', checkpointId: 'c', kind: 'writes', results: {} }
    onCommit(commit)
    expect(mirrors).toEqual([])
  })
})

describe('the agent in checkpoint provenance', () => {
  test('is recorded on every checkpoint and read back', async () => {
    const folder = sampleFolder()
    const path = join(scratch(), 'checkpoints.sqlite')
    const saver = new SqliteCheckpointer({ path, revision: 'r', model: 'm', agent: 'codex' })
    const done = await startProcessRun(driver(folder, saver).options)
    expect(saver.latestAgent(done.identity.threadId)).toBe('codex')
    saver.close()
    expect(readAgentProvenance(path, done.identity.threadId)).toMatchObject({
      revision: 'r',
      model: 'm',
      agent: 'codex'
    })
    expect(readAgentProvenance(path, 'no-such-thread')).toBeNull()
    expect(readAgentProvenance(join(scratch(), 'missing.sqlite'), 'thread')).toBeNull()
  })

  test('a checkpoint written before the agent was recorded reads agent null, and the read changes nothing', () => {
    const path = join(scratch(), 'legacy.sqlite')
    const db = new Database(path, { create: true })
    db.exec(`CREATE TABLE checkpoints (
      thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL, checkpoint_id TEXT NOT NULL, parent_id TEXT,
      type TEXT NOT NULL, checkpoint BLOB NOT NULL, metadata BLOB NOT NULL, revision TEXT NOT NULL, model TEXT NOT NULL,
      format_version INTEGER, runtime_version TEXT,
      PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id))`)
    db.query(
      `INSERT INTO checkpoints VALUES ('thread', '', 'c1', NULL, 'json', X'7B7D', X'7B7D', 'r', '', 1, 'engine@0.0.1')`
    ).run()
    db.close()
    const before = statSync(path).mtimeMs
    expect(readAgentProvenance(path, 'thread')).toEqual({
      revision: 'r',
      model: '',
      formatVersion: 1,
      runtimeVersion: 'engine@0.0.1',
      agent: null
    })
    const after = new Database(path, { readonly: true })
    const columns = after.query<{ name: string }, []>('PRAGMA table_info(checkpoints)').all()
    after.close()
    expect(columns.map((column) => column.name)).not.toContain('agent')
    expect(statSync(path).mtimeMs).toBe(before)
  })
})

describe('reading provenance from a file that is not a checkpoint file', () => {
  test('raises the typed corrupt error', () => {
    const path = join(scratch(), 'garbage.sqlite')
    writeFileSync(path, 'this is not a database file, not even close to one')
    expect(() => readAgentProvenance(path, 'thread')).toThrow(CheckpointCorruptError)
  })
})
