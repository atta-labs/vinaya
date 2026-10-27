import { continuationFlow, recordRunFlow, runFlowPath } from '../../bin/run-engine'
import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type EffectRecord, readExecutionRoundMirror, writeExecutionRoundMirror } from '@attalabs/aeg-core'
import { clearDriverLock } from '../../../../apps/cli/src/lib/dev-review-loop/pause-resume'
import { controlStoreRootFor } from '../../../../apps/cli/src/lib/dev-review-loop/reviewer-dispatch'
import {
  encodeExecutionRound,
  readAgentProvenance,
  readEffectiveResumedState,
  readExecutionRound
} from '../../../../harness/dev-process/engine-runtime/checkpoint-round'
import { SqliteCheckpointer } from '../../../../harness/dev-process/engine-runtime/sqlite-checkpointer'
import { restoreExecutionRound } from '../../bin/run-lifecycle'
import {
  checkpointFile,
  createWorld,
  expectCleanRun,
  type Interrupt,
  leg,
  scratch,
  TASK,
  threadOf
} from './engine-recovery-world'
import { ENGINE_RUNNERS } from './runners'

describe.each(ENGINE_RUNNERS)('%s', (runner) => {
  test('an uninterrupted run publishes round 3 with every round ended once', async () => {
    const world = createWorld()
    const run = await leg(runner, world)
    expect(run.result.exitCode).toBe(0)
    await expectCleanRun(world)
  })

  const points: Interrupt[] = [
    { round: 2, at: 'developer-turn-before-handoff' },
    { round: 2, at: 'after-handoff' },
    { round: 2, at: 'push-before-acknowledgement' },
    { round: 3, at: 'after-round-marker' }
  ]
  for (const interrupt of points)
    test(`a driver restart ${interrupt.at} in round ${interrupt.round} resumes with no replayed input version`, async () => {
      const world = createWorld()
      const first = await leg(runner, world, interrupt)
      expect(first.stopped).toBe(true)
      expect(first.result.exitCode).toBe(2)
      const second = await leg(runner, world)
      expect(second.result.exitCode).toBe(0)
      await expectCleanRun(world)
    })

  test('a crash between each pair of persistence writes leaves no double increment and no repeated effect', async () => {
    // Checkpoint commit, then mirror write: the mirror cannot be written, so the run stops before its next step.
    const blocked = createWorld()
    const mirrorDir = join(controlStoreRootFor(blocked.runtimeDir), String(TASK), 'control')
    mkdirSync(mirrorDir, { recursive: true })
    writeFileSync(join(mirrorDir, 'execution-round'), 'not a folder')
    const failed = await leg(runner, blocked)
    expect(failed.result.exitCode).not.toBe(0)
    // Round 1 recorded at prepare-run could not be mirrored: nothing past it was dispatched.
    expect(blocked.remoteWrites).toEqual([])
    rmSync(join(mirrorDir, 'execution-round'))
    // The failed driver's lock names a process that, restarted for real, would be dead.
    clearDriverLock(blocked.runtimeDir, TASK)
    expect((await leg(runner, blocked)).result.exitCode).toBe(0)
    await expectCleanRun(blocked)

    // Mirror write, then effect record: the driver dies after the round moved and was mirrored, before the next push.
    const beforeEffect = createWorld()
    expect((await leg(runner, beforeEffect, { round: 2, at: 'developer-turn-before-push' })).stopped).toBe(true)
    const mirrored = readExecutionRoundMirror(beforeEffect.store, TASK, threadOf())
    expect(mirrored.status === 'ok' && mirrored.value.round).toBe(2)
    expect((await leg(runner, beforeEffect)).result.exitCode).toBe(0)
    await expectCleanRun(beforeEffect)

    // Effect record, then its acknowledgement: covered by the push interruption above; here the mirror is also
    // stale (ahead of the checkpoint), and the checkpoint wins.
    const stale = createWorld()
    expect((await leg(runner, stale, { round: 2, at: 'push-before-acknowledgement' })).stopped).toBe(true)
    const recorded = readExecutionRoundMirror(stale.store, TASK, threadOf())
    if (recorded.status !== 'ok') throw new Error('no mirror after the first leg')
    writeExecutionRoundMirror(stale.store, TASK, { ...recorded.value, round: 1, checkpointId: 'stale' })
    expect((await leg(runner, stale)).result.exitCode).toBe(0)
    await expectCleanRun(stale)
  })

  test('a crash after pending writes and before the next full checkpoint resumes at the right round', async () => {
    const world = createWorld()
    expect((await leg(runner, world, { round: 2, at: 'after-handoff' })).stopped).toBe(true)
    // The round-ending step's writes are stored under the checkpoint before it; drop every full checkpoint saved
    // after that, as a driver killed before its next (non-blocking) save would have left the file.
    const db = new Database(checkpointFile(world))
    const handoffCheckpoint = db
      .query<{ checkpoint_id: string }, [string]>(
        `SELECT checkpoint_id FROM writes WHERE thread_id = ? AND channel = 'results'
         ORDER BY checkpoint_id DESC LIMIT 1`
      )
      .get(threadOf())
    if (handoffCheckpoint === null) throw new Error('no stored step writes')
    db.query('DELETE FROM checkpoints WHERE thread_id = ? AND checkpoint_id > ?').run(
      threadOf(),
      handoffCheckpoint.checkpoint_id
    )
    db.close()
    const state = await readEffectiveResumedState(checkpointFile(world), threadOf())
    expect(readExecutionRound(state)?.round).toBe(3)
    expect((await leg(runner, world)).result.exitCode).toBe(0)
    await expectCleanRun(world)
  })

  test('the agent the run started with is recorded in its checkpoint provenance and read back', async () => {
    const world = createWorld()
    await leg(runner, world, { round: 1, at: 'after-handoff' })
    expect(readAgentProvenance(checkpointFile(world), threadOf())?.agent).toBe('claude')
  })

  test('a checkpoint written before the agent was recorded reads agent null', async () => {
    const world = createWorld()
    await leg(runner, world, { round: 1, at: 'after-handoff' })
    const db = new Database(checkpointFile(world))
    db.query('UPDATE checkpoints SET agent = NULL').run()
    db.close()
    expect(readAgentProvenance(checkpointFile(world), threadOf())?.agent).toBeNull()
  })

  // The refusal of these resumes is the Engine dispatch path's, built on `readAgentProvenance` above.
})

describe('restoring the execution round before dispatch', () => {
  const mechanical = (round: number) => ({
    nodeId: 'build-revision-handoff',
    kind: 'mechanical' as const,
    action: 'vinaya.build-revision-handoff',
    command: 'in-process',
    exitCode: 0,
    stdout: '',
    stderr: encodeExecutionRound({ round, advancedBy: 'build-revision-handoff' }),
    durationMs: 0
  })
  const resumed = (round: number) => ({
    checkpointId: 'cp-2',
    results: { 'build-revision-handoff': mechanical(round) }
  })
  const effect = (inputVersion: number, status: EffectRecord['status']) => ({
    status: 'ok' as const,
    value: {
      version: 1 as const,
      kind: 'effect' as const,
      task: TASK,
      key: `branch-push-${inputVersion}`,
      operation: 'branch-push',
      target: 't',
      inputVersion,
      payloadDigest: 'd',
      status,
      recordedAt: 'now'
    }
  })
  const mirror = (round: number, checkpointId = 'cp-2') => ({
    status: 'ok' as const,
    value: {
      version: 1 as const,
      kind: 'execution_round' as const,
      task: TASK,
      repository: 'o/r',
      threadId: 'thread',
      checkpointId,
      round,
      recordedAt: 'now'
    }
  })

  test('the checkpoint round wins over a disagreeing mirror, which is rewritten', () => {
    const restore = restoreExecutionRound({
      threadId: 'thread',
      resumed: resumed(3),
      mirror: mirror(5),
      effects: []
    })
    expect(restore).toMatchObject({ kind: 'restored', round: 3, rewriteMirror: true })
    if (restore.kind === 'restored') expect(restore.note).toContain('checkpoint holds round 3')
  })

  test('an agreeing mirror at the same checkpoint is left as it is', () => {
    expect(
      restoreExecutionRound({ threadId: 'thread', resumed: resumed(3), mirror: mirror(3), effects: [] })
    ).toMatchObject({ kind: 'restored', rewriteMirror: false, note: null })
  })

  test('an effect issued at a later input version refuses the resume', () => {
    const restore = restoreExecutionRound({
      threadId: 'thread',
      resumed: resumed(2),
      mirror: { status: 'absent' },
      effects: [effect(3, 'verified')]
    })
    expect(restore.kind).toBe('refused')
  })

  test('an unacknowledged effect is handed back with the input version it was issued with', () => {
    const restore = restoreExecutionRound({
      threadId: 'thread',
      resumed: resumed(3),
      mirror: { status: 'absent' },
      effects: [effect(2, 'started'), effect(3, 'verified'), { status: 'corrupt', reason: 'torn' }]
    })
    expect(restore.kind === 'restored' && restore.interrupted).toEqual([
      { key: 'branch-push-2', operation: 'branch-push', inputVersion: 2 }
    ])
  })

  test('a thread with no recorded round is left to the start-of-run rules', () => {
    expect(
      restoreExecutionRound({
        threadId: 'thread',
        resumed: { checkpointId: 'c', results: {} },
        mirror: { status: 'absent' },
        effects: []
      })
    ).toEqual({ kind: 'unrecorded' })
    expect(
      restoreExecutionRound({ threadId: 'thread', resumed: null, mirror: { status: 'absent' }, effects: [] })
    ).toEqual({ kind: 'unrecorded' })
  })

  test('a fresh saver records the agent it is given', () => {
    const dir = mkdtempSync(join(tmpdir(), 'round-recovery-saver-'))
    scratch.push(dir)
    const saver = new SqliteCheckpointer({ path: join(dir, 'c.sqlite'), revision: 'r', agent: 'codex' })
    expect(saver.latestAgent('none')).toBeUndefined()
    saver.close()
  })
})

describe('version 2 resumed Log', () => {
  test('the first resumed and phase events use the restored review round with an empty translator cache', async () => {
    const world = createWorld()
    const first = await leg('engine-v2', world, { round: 3, at: 'after-round-marker' })
    expect(first.stopped).toBe(true)
    const resumed = await leg('engine-v2', world)
    expect(resumed.result.exitCode).toBe(0)
    expect(resumed.events.find((event) => event.event === 'resumed')).toMatchObject({ round: 3 })
    const phases = resumed.events.filter((event) => event.event === 'phase_time')
    expect(phases.length).toBeGreaterThan(0)
    expect(phases.every((event) => event.round === 3)).toBe(true)
    expect(resumed.round()).toBe(3)
    await expectCleanRun(world)
  })
})

describe('checkpoint flow continuity', () => {
  test('task continuation takes v2 from its checkpoint and cannot overwrite it with v1', async () => {
    const world = createWorld()
    await leg('engine-v2', world, { round: 1, at: 'after-round-marker' })
    recordRunFlow(world.runtimeDir, TASK, 'v2')
    expect(continuationFlow(world.runtimeDir, TASK)).toBe('v2')
    expect(() => continuationFlow(world.runtimeDir, TASK, 'v1')).toThrow('never switches')
    expect(() => recordRunFlow(world.runtimeDir, TASK, 'v1')).toThrow('never switches')
    await expect(leg('engine-v1', world)).rejects.toThrow('never switches')
    writeFileSync(runFlowPath(world.runtimeDir, TASK), JSON.stringify({ schemaVersion: 1, flow: 'v1' }))
    expect(continuationFlow(world.runtimeDir, TASK)).toBe('v2')
  })
})

// Every role launch's tokens, read from the agent's own output as the standalone dispatch reads them: recorded on the
// task input for the verdict's Tokens line, and written to the Log as a `role_attempt` and a `usage` event.
const USAGE_OUTPUT = {
  claude: (input: number, output: number) => [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: `s-${input}`, model: 'claude-opus-test' }),
    JSON.stringify({
      type: 'result',
      usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 }
    })
  ],
  codex: (input: number, output: number) => [
    JSON.stringify({ type: 'thread.started', thread_id: `t-${input}` }),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: input, output_tokens: output, cached_input_tokens: 6 }
    })
  ]
} as const
const ROLE_TOKENS = { developer: [101, 11], 'code-reviewer': [202, 22], 'security-reviewer': [303, 33] } as const
const RECORDED_ROLE = { developer: 'developer', 'code-reviewer': 'reviewer', 'security-reviewer': 'security' } as const

describe.each(ENGINE_RUNNERS)('%s records token usage', (runner) => {
  for (const agent of ['claude', 'codex'] as const) {
    test(`every ${agent} Developer, Reviewer and Security launch reports its tokens`, async () => {
      // A stub Codex login of this test's own: another file's teardown may already have removed the shared one.
      const codexHome = mkdtempSync(join(tmpdir(), 'usage-codex-home-'))
      scratch.push(codexHome)
      writeFileSync(join(codexHome, 'auth.json'), '{}\n')
      process.env.CODEX_HOME = codexHome
      const world = createWorld({
        agent,
        agentOutput: Object.fromEntries(
          Object.entries(ROLE_TOKENS).map(([role, [input, output]]) => [role, [...USAGE_OUTPUT[agent](input, output)]])
        )
      })
      const run = await leg(runner, world)
      expect(run.result.exitCode).toBe(0)
      for (const [launchRole, [input, output]] of Object.entries(ROLE_TOKENS)) {
        const role = RECORDED_ROLE[launchRole as keyof typeof RECORDED_ROLE]
        expect(world.recordedUsage).toContainEqual({ role, usage: { input, output } })
        const attempts = run.events.filter(
          (event) =>
            event.kind === 'role_attempt' && event.actor === agent && String(event.effect_id).includes(`:${role}:`)
        )
        expect(attempts.length).toBeGreaterThan(0)
        for (const attempt of attempts) expect(attempt.usage).toEqual({ input, output })
        expect(run.events).toContainEqual(
          expect.objectContaining({
            kind: 'usage',
            event: 'observed',
            source: agent,
            semantics: 'cumulative',
            units: { input, output, cache: 6 },
            unknown_reason: null
          })
        )
      }
    })
  }
})
