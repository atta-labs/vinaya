import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { generateCodexConfig } from '../../../../harness/adapters/agents/codex/config'
import { loadRoleGrants, ROLE_NAMES } from '../../../../harness/adapters/agents/manifest'
import { readEffects } from '@attalabs/aeg-core'
import { createTestTempRun, makeFixtureDir, sweepAbandoned } from '../../../../apps/cli/src/lib/test-temp'
import { fixtureDir } from '../../../../apps/cli/tests/lib/test-temp-fixture'
import { checkpointFile, createWorld, expectCleanRun, leg, TASK, threadOf } from './engine-recovery-world'
import {
  readEffectiveResumedState,
  readExecutionRound
} from '../../../../harness/dev-process/engine-runtime/checkpoint-round'
import { loopLogPathFor } from '../../../../apps/cli/src/lib/loop-log'
import {
  cleanupWorlds,
  makeInProcessDeps,
  makeWorld,
  runLoopInProcess
} from '../../../../apps/cli/tests/lib/dev-review-loop-harness'
import { ALL_RUNNERS, ENGINE_RUNNERS } from './runners'

// Recovery cases that cross launch, checkpoint, broker and test-storage boundaries.

const EXECUTING = join(import.meta.dir, '../../executing')

describe.each(ENGINE_RUNNERS)('%s', (runner) => {
  // A Codex role whose dev-tools bridge cannot start must fail its own start, not run without publish or checks.
  for (const role of ROLE_NAMES)
    test(`a Codex ${role} launch requires its dev-tools server`, () => {
      const generated = generateCodexConfig(loadRoleGrants(join(EXECUTING, role, 'grants.yaml')), {
        generatedDir: `/gen/${role}`,
        outputSchemaPath: `/schema/${role}.json`,
        outputSchema: JSON.parse(readFileSync(join(EXECUTING, role, 'output.schema.json'), 'utf8')),
        mcpCommand: '/bridge',
        variables: { WORKTREE: '/wt', SCRATCH: '/scratch', BUN_INSTALL_CACHE: '/bun', GIT_COMMON_DIR: '/git' }
      })
      const settings = Bun.TOML.parse(generated.files['config.toml'] as string)
      expect(settings).toHaveProperty('mcp_servers.vinaya_dev_tools.required', true)
    })

  test('a Developer launch that ended before binding its session dispatches fresh', async () => {
    const world = createWorld()
    const first = await leg(runner, world, { round: 1, at: 'developer-turn-before-push' })
    expect(first.stopped).toBe(true)
    expect(first.result.exitCode).toBe(2)
    expect(world.remoteWrites).toEqual([])
    world.priorLaunch = {
      status: 'ok',
      record: {
        runId: 'unbound-attempt',
        role: 'developer',
        agent: 'claude',
        repo: { owner: 'owner', repo: 'repo' },
        task: TASK,
        pr: null,
        round: 1,
        attempt: 1,
        effectId: 'unbound-developer',
        dispatcherPid: 1000,
        childPid: null,
        childStartedAt: null,
        childCommand: null,
        host: hostname(),
        startedAt: '2026-01-01T00:00:00Z',
        status: 'launched',
        resumeId: null,
        boundAt: null,
        finishedAt: null,
        failureReason: null
      }
    }
    const before = world.launches.length
    const second = await leg(runner, world)
    expect(second.result.exitCode).toBe(0)
    expect(readFileSync(loopLogPathFor(null, TASK, world.runtimeDir), 'utf8')).toContain('launch_ended_unbound:')
    const launch = world.launches.slice(before).find(({ role }) => role === 'developer')
    expect(launch).toBeDefined()
    expect(launch?.args).not.toContain('--resume')
    await expectCleanRun(world)
  })
  test('a crash after an effect and before its acknowledgement repeats no effect', async () => {
    const world = createWorld()
    const first = await leg(runner, world, { round: 2, at: 'push-before-acknowledgement' })
    expect(first.stopped).toBe(true)
    expect(first.result.exitCode).toBe(2)
    const effects = readEffects(world.store, TASK).flatMap((record) => (record.status === 'ok' ? [record.value] : []))
    const pending = effects.find((effect) => effect.status === 'started')
    expect(pending).toMatchObject({ operation: 'branch-push', inputVersion: 2, status: 'started' })
    if (pending === undefined) throw new Error('no interrupted push recorded')
    const sha = world.head
    expect(world.remoteWrites.filter((head) => head === sha)).toHaveLength(1)
    const state = await readEffectiveResumedState(checkpointFile(world), threadOf())
    expect(readExecutionRound(state)?.round).toBe(pending.inputVersion)
    const second = await leg(runner, world)
    expect(second.result.exitCode).toBe(0)
    expect(readFileSync(loopLogPathFor(null, TASK, world.runtimeDir), 'utf8')).toContain(
      `effect ${pending.key} was issued at input version 2 and never acknowledged`
    )
    expect(world.refusals).toEqual([])
    expect(world.remoteWrites.filter((head) => head === sha)).toHaveLength(1)
    const acknowledged = readEffects(world.store, TASK).find(
      (record) => record.status === 'ok' && record.value.key === pending.key
    )
    expect(acknowledged).toMatchObject({
      status: 'ok',
      value: { status: 'verified', inputVersion: pending.inputVersion }
    })
    await expectCleanRun(world)
  })
})

// Every runner's heavy fixtures use the same storage contract. A separate process leaves its real ownership
// marker behind on failure; the next process's startup sweep must reclaim only that abandoned run.
describe.each(ALL_RUNNERS)('%s test storage', () => {
  test('quota exhaustion during a test run is reported and the run recovers', async () => {
    for (const code of ['ENOSPC', 'EDQUOT']) {
      const root = fixtureDir('cross-cutting-storage-')
      const modulePath = resolve(import.meta.dir, '../../../../apps/cli/src/lib/test-temp.ts')
      const source = `
        import { mkdirSync, writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        import { createTestTempRun, makeFixtureDir } from ${JSON.stringify(modulePath)};
        const run = createTestTempRun('repo', ${JSON.stringify(root)});
        try {
          makeFixtureDir(run, 'partial-', { mkdir(dir) {
            mkdirSync(dir);
            writeFileSync(join(dir, 'partial-data'), 'unfinished fixture');
            throw Object.assign(new Error('${code}: injected storage exhaustion'), { code: '${code}' });
          }});
          process.exitCode = 0;
        } catch (error) {
          console.log(JSON.stringify({ dir: run.dir, token: run.marker.owner.runToken, error: error.message }));
          process.exitCode = 1;
        }
      `
      const failed = Bun.spawnSync([process.execPath, '--eval', source], { env: process.env })
      expect(failed.exitCode).toBe(1)
      const result = JSON.parse(failed.stdout.toString().trim()) as { dir: string; token: string; error: string }
      expect(result.error).toContain(code)
      expect(result.error).toContain(result.dir)
      expect(result.error).toContain('VINAYA_TEST_TMP')
      expect(result.error).toContain('disk path with room')
      expect(existsSync(result.dir)).toBe(true)
      const live = createTestTempRun('repo', root)
      const blocked = await sweepAbandoned('repo', {
        root,
        stop: async () => {
          throw new Error('injected cleanup failure')
        }
      })
      expect(blocked.failed).toEqual([{ dir: result.dir, error: expect.stringContaining('injected cleanup failure') }])
      expect(existsSync(result.dir)).toBe(true)
      const stopped: string[] = []
      const recovered = await sweepAbandoned('repo', {
        root,
        stop: async (token) => {
          expect(existsSync(result.dir)).toBe(true)
          stopped.push(token)
          return { backend: 'registry', terminated: [], killed: [], alreadyGone: [] }
        }
      })
      expect(stopped).toEqual([result.token])
      expect(recovered).toEqual({ removed: [result.dir], kept: [live.dir], failed: [] })
      expect(existsSync(result.dir)).toBe(false)
      expect(existsSync(makeFixtureDir(live, 'next-run-'))).toBe(true)
    }
  })
})

describe.each(['standalone'] as const)('%s launch recovery', () => {
  afterAll(cleanupWorlds)
  test('a Developer launch that ended before binding its session dispatches fresh', async () => {
    const world = makeWorld({ developerPushed: true, gate: 'red' })
    const sessions = join(world.runtimeDir, 'tasks-execution', String(world.task), 'sessions')
    mkdirSync(sessions, { recursive: true })
    writeFileSync(
      join(sessions, 'developer-claude.json'),
      JSON.stringify({
        runId: 'unbound-attempt',
        role: 'developer',
        agent: 'claude',
        repo: { owner: 'owner', repo: 'repo' },
        task: world.task,
        pr: null,
        round: 1,
        attempt: 1,
        effectId: 'unbound-developer',
        dispatcherPid: 0,
        childPid: null,
        childStartedAt: null,
        childCommand: null,
        host: hostname(),
        startedAt: '2026-01-01T00:00:00Z',
        status: 'interrupted',
        resumeId: null,
        boundAt: null,
        finishedAt: '2026-01-01T00:00:01Z',
        failureReason: 'unbound'
      })
    )
    const base = makeInProcessDeps(world)
    const resumes: Array<string | undefined> = []
    const result = await runLoopInProcess(world, undefined, {
      dispatchRole: async (role, agent, prompt, opts) => {
        if (role === 'developer') {
          resumes.push(opts.resumeId)
          world.gate = 'green'
        }
        return base.dispatchRole!(role, agent, prompt, opts)
      }
    })
    expect(result.finalDecision.type).toBe('publish')
    expect(resumes).toEqual([undefined])
    expect(readFileSync(loopLogPathFor(null, world.task, world.runtimeDir), 'utf8')).toContain('launch_ended_unbound:')
  })
})
