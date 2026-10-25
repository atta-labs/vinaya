import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createRunControl,
  type RoleBinaryConfig,
  type SpawnFn,
  type SpawnedProcessLike
} from '@atta/executor-agent-spawn'
import { emptyCheckpoint } from '@langchain/langgraph'
import { loadProcess } from '../loader/load-process'
import { resumeProcessRun, startProcessRun, type ProcessRunOptions } from './run-process'
import {
  CHECKPOINT_FORMAT_VERSION,
  CheckpointCorruptError,
  type CheckpointProvenance,
  checkpointRefusal,
  ENGINE_RUNTIME_VERSION,
  SqliteCheckpointer
} from './sqlite-checkpointer'

/** The versions every checkpoint this runtime writes records. */
const CURRENT = { formatVersion: CHECKPOINT_FORMAT_VERSION, runtimeVersion: ENGINE_RUNTIME_VERSION }

const FLOW = `schema_version: "2.0"
id: sample-flow
display_name: Sample
description: Sample flow.
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
  - id: check
    type: mechanical
    action: sample.check
    decision: { examine: work, if_true: work, if_false: finish, max_revisions: 2 }
  - { id: finish, type: mechanical, action: sample.finish }
`

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'sqlite-checkpointer-'))
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

function sampleRun() {
  const folder = scratch()
  mkdirSync(join(folder, 'worker'))
  writeFileSync(join(folder, 'worker', 'grants.yaml'), 'role: worker\n')
  writeFileSync(join(folder, 'flow.yaml'), FLOW)
  writeFileSync(join(folder, 'process.yaml'), 'id: sample\nversion: "1"\nflow: flow.yaml\nroles:\n  - worker\n')
  const calls: Record<string, number> = {}
  const control = createRunControl()
  const step = (name: string) => () => {
    calls[name] = (calls[name] ?? 0) + 1
    return { exitCode: 0 }
  }
  const role: RoleBinaryConfig = {
    command: 'worker-agent',
    buildArgs: () => ['--run'],
    allowedPermissions: ['worker/grants.yaml']
  }
  const checks = [1, 0]
  const spawnFn: SpawnFn = () => {
    calls.work = (calls.work ?? 0) + 1
    return fakeAgentProcess()
  }
  const options = (saver: SqliteCheckpointer, halted: boolean): ProcessRunOptions => ({
    process: loadProcess(folder),
    question: 'the sample',
    bindings: {
      actions: {
        'sample.prepare': () => {
          calls.prepare = (calls.prepare ?? 0) + 1
          if (halted) control.halt('stop')
          return { exitCode: 0 }
        },
        'sample.check': step('check'),
        'sample.finish': step('finish')
      },
      decisions: { check: () => (checks.shift() ?? 0) !== 0 },
      roles: { worker: role }
    },
    checkpointer: saver,
    workingDirectoryRoot: folder,
    spawnFn,
    ...(halted ? { control } : {})
  })
  return { calls, options }
}

describe('sqlite checkpointer', () => {
  test('a run halted in one saver resumes on a new saver over the same file, each completed step run once', async () => {
    const file = join(scratch(), 'run', 'checkpoints.sqlite')
    const { calls, options } = sampleRun()
    const first = new SqliteCheckpointer({ path: file, revision: 'rev-1', model: 'model-a' })
    const paused = await startProcessRun(options(first, true))
    expect(paused.reason).toBe('paused')
    first.close()

    const second = new SqliteCheckpointer({ path: file, revision: 'rev-1', model: 'model-a' })
    const resumed = await resumeProcessRun(options(second, false), paused.identity)
    second.close()
    expect(resumed.reason).toBe('completed')
    expect(calls).toEqual({ prepare: 1, work: 2, check: 2, finish: 1 })
  })

  test('every checkpoint records the revision, model and versions it was written under, and the latest reads back', async () => {
    const file = join(scratch(), 'checkpoints.sqlite')
    const config = { configurable: { thread_id: 't1', checkpoint_ns: '' } }
    const older = new SqliteCheckpointer({ path: file, revision: 'rev-old', model: 'model-a' })
    const first = { ...emptyCheckpoint(), id: '00000000-0000-0000-0000-000000000001' }
    const written = await older.put(config, first, { source: 'loop', step: 0, writes: {}, parents: {} })
    older.close()

    const newer = new SqliteCheckpointer({ path: file, revision: 'rev-new' })
    const second = { ...emptyCheckpoint(), id: '00000000-0000-0000-0000-000000000002' }
    await newer.put(written, second, { source: 'loop', step: 1, writes: {}, parents: {} })

    expect(newer.provenanceOf('t1', first.id)).toEqual({ revision: 'rev-old', model: 'model-a', ...CURRENT })
    expect(newer.provenanceOf('t1', second.id)).toEqual({ revision: 'rev-new', model: '', ...CURRENT })
    expect(newer.latestProvenance('t1')).toEqual({ revision: 'rev-new', model: '', ...CURRENT })
    expect(newer.latestProvenance('other')).toBeUndefined()
    const latest = await newer.getTuple(config)
    expect(latest?.checkpoint.id).toBe(second.id)
    expect(latest?.parentConfig?.configurable?.checkpoint_id).toBe(first.id)
    newer.close()
  })

  test('a run records the revision and model of its saver on its latest checkpoint', async () => {
    const file = join(scratch(), 'checkpoints.sqlite')
    const { options } = sampleRun()
    const saver = new SqliteCheckpointer({ path: file, revision: 'rev-run', model: 'model-run' })
    const outcome = await startProcessRun(options(saver, false))
    expect(outcome.reason).toBe('completed')
    expect(saver.latestProvenance(outcome.identity.threadId)).toEqual({
      revision: 'rev-run',
      model: 'model-run',
      ...CURRENT
    })
    saver.close()
  })

  test('a file written before the versions were recorded opens, and its rows record neither', async () => {
    const file = join(scratch(), 'checkpoints.sqlite')
    const legacy = new Database(file, { create: true })
    legacy.exec(`CREATE TABLE checkpoints (thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL, parent_id TEXT, type TEXT NOT NULL, checkpoint BLOB NOT NULL,
      metadata BLOB NOT NULL, revision TEXT NOT NULL, model TEXT NOT NULL,
      PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id))`)
    legacy
      .query('INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('t1', '', 'c1', null, 'json', '{}', '{}', 'rev-old', '')
    legacy.close()
    const saver = new SqliteCheckpointer({ path: file, revision: 'rev-new' })
    const recorded = saver.latestProvenance('t1')
    expect(recorded).toEqual({ revision: 'rev-old', model: '', formatVersion: null, runtimeVersion: null })
    expect(checkpointRefusal(recorded as CheckpointProvenance)?.code).toBe('checkpoint_version_unrecorded')
    saver.close()
  })

  test('a file that is not a checkpoint file, or a row whose state cannot be read, is reported as corrupt', async () => {
    const garbage = join(scratch(), 'checkpoints.sqlite')
    writeFileSync(garbage, 'this is not a database, it only has its name\n'.repeat(200))
    expect(() => new SqliteCheckpointer({ path: garbage, revision: 'r' })).toThrow(CheckpointCorruptError)

    const file = join(scratch(), 'checkpoints.sqlite')
    const saver = new SqliteCheckpointer({ path: file, revision: 'r' })
    const config = { configurable: { thread_id: 't1', checkpoint_ns: '' } }
    await saver.put(config, { ...emptyCheckpoint(), id: 'c1' }, { source: 'loop', step: 0, writes: {}, parents: {} })
    saver.close()
    const raw = new Database(file)
    raw.query("UPDATE checkpoints SET checkpoint = X'00FF00FF'").run()
    raw.close()
    const reopened = new SqliteCheckpointer({ path: file, revision: 'r' })
    await expect(reopened.getTuple(config)).rejects.toBeInstanceOf(CheckpointCorruptError)
    reopened.close()
  })

  test('only an unrecorded or other format, or a runtime outside the caret range, refuses; a moved revision never does', () => {
    expect(checkpointRefusal(CURRENT)).toBeNull()
    expect(
      checkpointRefusal({ formatVersion: CHECKPOINT_FORMAT_VERSION + 1, runtimeVersion: ENGINE_RUNTIME_VERSION })?.code
    ).toBe('checkpoint_format_incompatible')
    expect(checkpointRefusal({ formatVersion: null, runtimeVersion: ENGINE_RUNTIME_VERSION })?.code).toBe(
      'checkpoint_format_incompatible'
    )
    const running = { formatVersion: 1, runtimeVersion: '@atta/engine@0.2.3 @atta/executor-agent-spawn@1.4.0' }
    const at = (runtimeVersion: string | null) => checkpointRefusal({ formatVersion: 1, runtimeVersion }, running)?.code
    expect(at('@atta/engine@0.2.1 @atta/executor-agent-spawn@1.0.9')).toBeUndefined()
    expect(at('@atta/engine@0.1.9 @atta/executor-agent-spawn@1.4.0')).toBe('runtime_version_incompatible')
    expect(at('@atta/engine@0.2.3 @atta/executor-agent-spawn@2.0.0')).toBe('runtime_version_incompatible')
    expect(at('@atta/engine@0.2.3')).toBe('runtime_version_incompatible')
    expect(at('not a runtime')).toBe('runtime_version_incompatible')
    expect(at(null)).toBe('runtime_version_incompatible')
    expect(
      checkpointRefusal(
        { formatVersion: 1, runtimeVersion: '@atta/engine@0.0.1' },
        { formatVersion: 1, runtimeVersion: '@atta/engine@0.0.2' }
      )?.code
    ).toBe('runtime_version_incompatible')
    expect(ENGINE_RUNTIME_VERSION).toMatch(/^@atta\/engine@\d+\.\d+\.\d+ @atta\/executor-agent-spawn@\d+\.\d+\.\d+$/)
  })
})
