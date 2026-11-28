import { fixtureDir } from '@harness/kernel/conformance/unit/test-temp-fixture'
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  acquireOwnership,
  type ControlStoreDeps,
  defaultControlStoreDeps,
  type EscalationRecord,
  readCurrentOwnership,
  readResolution,
  type ResolutionRecord,
  StaleEpochWriteError
} from '@harness/kernel/connectors/checkpoint/control-store/index'
import { createRunControl, type RunControl, type SpawnedProcessLike } from '@atta/executor-agent-spawn'
import { loadProcess } from '@harness/kernel/dev-process-socket/loader/load-process'
import type { ActionRegistry, ProcessAction } from '@harness/kernel/loops/runtimes/atta-engine/run-process'
import {
  escalationIdFor,
  readDriverLock,
  ReplayedResolutionError,
  resolveEscalation,
  writeEscalationRecord,
  writePauseState,
  type PauseState
} from '../loops/dev-review/standalone/dev-review-loop/pause-resume'
import { loopLogPathFor } from '@harness/kernel/log/client/loop-log'
import { ACTION_BINDINGS, classifyGateResult, dispatchReviewers, type TaskInput } from '../executing/actions'
import {
  parseResumeArgs,
  recordedRunFlow,
  recordRunFlow,
  resumeFlow,
  freshRunFlow,
  recordedCheckpointModel,
  resumeEngine,
  runEngine,
  type Agent,
  type EngineArgs,
  type EngineRunOptions
} from '../bin/run-engine'
import {
  claimResume,
  liveResumeDeps,
  resumeModel,
  rulingPollMs,
  watchForRuling,
  type ResumeDeps,
  type RulingWatch
} from '../bin/run-lifecycle'
import { recordedHandoff } from './handoff-fakes'

const loaded = loadProcess(resolve(import.meta.dir, '..'), { flow: 'v1' })
const repoRoot = resolve(import.meta.dir, '../../../..')
const TASK = 7
const PR = 70
const BRANCH = 'task/issue-7'

// A stub login keeps the real role launcher from copying an operator's Codex credential into a test run.
const stubHome = fixtureDir('resume-codex-home-')
writeFileSync(join(stubHome, 'auth.json'), '{}\n')
process.env.CODEX_HOME = stubHome

const AGENTS = ['claude', 'codex'] as const

const ROLE_STEP: Record<string, string> = {
  developer: 'develop',
  'code-reviewer': 'code-review',
  'security-reviewer': 'security-review'
}

/** The role a launch is for: Claude names its role's generated settings, Codex its home. */
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

interface Scenario {
  args?: Partial<EngineArgs>
  agent?: Agent
  actions?: Record<string, ProcessAction>
  control?: RunControl
  revision?: string
  watch?: RulingWatch
}

function stubRun(scenario: Scenario = {}, runtimeDir = fixtureDir('resume-')) {
  const agent = scenario.agent ?? 'claude'
  const spawns: string[] = []
  const actionRuns: Record<string, number> = {}
  const actions: ActionRegistry = Object.fromEntries(
    Object.keys(ACTION_BINDINGS).map((name) => [
      name,
      async (context) => {
        actionRuns[context.nodeId] = (actionRuns[context.nodeId] ?? 0) + 1
        const replaced = scenario.actions?.[name]
        if (replaced) return replaced(context)
        if (name === 'vinaya.classify-gate-result') return classifyGateResult(context)
        if (name === 'vinaya.dispatch-reviewers') return dispatchReviewers()
        return { exitCode: 0 }
      }
    ])
  )
  const handoff = recordedHandoff()
  const options: EngineRunOptions = {
    args: { task: TASK, agent, dryRun: false, ...scenario.args },
    process: loaded,
    repoRoot,
    runtimeDir,
    loopId: 'resume-test',
    taskInput: { branch: BRANCH } as TaskInput,
    // A checkpoint resume and a held verdict both ask whether the pull request conflicts; the answer is stubbed so no
    // test reaches the forge. A test that needs a conflict sets this to answer true.
    heldPullRequestConflicts: async () => false,
    // These runs wire no input versions, so the escalation record's write fails; its retries go without waiting.
    handoffDeps: { ...handoff.deps, sleepSync: () => {} },
    actions,
    sink: { log: () => {}, drain: async () => {} },
    startHost: async () => ({ close: async () => {} }),
    devToolsContext: {} as never,
    control: scenario.control,
    out: () => {},
    revision: scenario.revision ?? 'rev-a',
    lifecycle: { killGraceMs: 200, handleSignals: false, ...(scenario.watch ? { watch: scenario.watch } : {}) },
    spawnFn: (_command, args, spawnOptions) => {
      const role = roleOfLaunch(agent, args, spawnOptions?.env)
      spawns.push(ROLE_STEP[role] as string)
      return stubAgent(AGENT_LINES[role] ?? [])
    }
  }
  const driverLog = (): string => {
    const path = loopLogPathFor(null, TASK, runtimeDir)
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  }
  return { options, spawns, actionRuns, runtimeDir, driverLog, handoff }
}

/** Halts the run from inside an action, then lets the action succeed. */
const haltThen = (control: RunControl, reason: string): { exitCode: number } => {
  control.halt(reason)
  return { exitCode: 0 }
}

// --- a fake forge ----------------------------------------------------------------

const resolutionOf = (decision: 'resume' | 'cancel'): ResolutionRecord => ({
  version: 1,
  kind: 'resolution',
  task: TASK,
  escalationId: 'e',
  decision,
  authenticatedBy: 'someone',
  authenticatedFrom: 'elsewhere',
  consumedAt: '2026-01-01T00:00:00.000Z'
})

/** The forge a resume reads: the Principal's rulings are the ordinal, and every resolution claim is recorded. */
function fakeForge(over: Partial<ResumeDeps> = {}) {
  const forge = {
    /** Rulings posted so far; the newest one's ordinal. */
    ordinal: 0,
    claims: [] as Array<{ expectedPr: number | null; decision: string; by: string; from: string }>,
    /** What the control store holds for the pause's resolution. */
    resolution: null as ResolutionRecord | null,
    /** Set to refuse every claim as already consumed. */
    consumed: null as ResolutionRecord | null,
    escalation: { rulingOrdinal: 0 } as EscalationRecord | null,
    driver: null as { pid: number; startedAt: string } | null,
    body: `Closes #${TASK}`,
    bound: [] as number[],
    openPr: PR as number | null,
    /** The pull request's own state, and every pull request whose state was read. */
    prState: 'OPEN' as 'OPEN' | 'MERGED' | 'CLOSED',
    prStateReads: [] as number[],
    post: () => {
      forge.ordinal += 1
    }
  }
  const deps: ResumeDeps = {
    ...liveResumeDeps,
    // Every pause here is an Engine run's own; the cross-runner refusal is the routing suite's.
    crossRunnerRefusal: () => null,
    readEscalationRecord: () => forge.escalation,
    readResolution: () => forge.resolution,
    resolveEscalation: (_task, escalationId, expectedPr, decision, by, from) => {
      forge.claims.push({ expectedPr, decision, by, from })
      if (forge.consumed) throw new ReplayedResolutionError(TASK, escalationId, forge.consumed)
      return { escalation: {} as EscalationRecord, resolution: resolutionOf(decision), epoch: 1 }
    },
    bindPauseToPullRequest: (root, held, pr) => {
      forge.bound.push(pr)
      return liveResumeDeps.bindPauseToPullRequest(root, held, pr)
    },
    fetchPrBody: () => forge.body,
    findOpenPrForBranch: () => (forge.openPr === null ? null : { number: forge.openPr, branch: BRANCH }),
    fetchRulings: () => (forge.ordinal > 0 ? ['Go ahead.'] : []),
    fetchIssueRulings: () => (forge.ordinal > 0 ? ['Go ahead.'] : []),
    fetchNewestRulingOrdinal: () => forge.ordinal,
    fetchNewestIssueRulingOrdinal: () => forge.ordinal,
    fetchNewestRulingAuthor: () => (forge.ordinal > 0 ? 'principal' : null),
    fetchNewestIssueRulingAuthor: () => (forge.ordinal > 0 ? 'principal' : null),
    fetchPrState: (pr) => {
      forge.prStateReads.push(pr)
      return forge.prState
    },
    liveDriver: () => forge.driver,
    infrastructureRetries: () => 0,
    ...over
  }
  return { forge, deps }
}

const heldPause = (over: Partial<PauseState> = {}): PauseState => ({
  task: TASK,
  round: 1,
  head: 'abc',
  branch: BRANCH,
  prNumber: PR,
  reason: 'escalation',
  pausedAt: '2026-01-01T00:00:00.000Z',
  agent: 'claude',
  escalationId: 'esc-1',
  ...over
})

/** A watch whose sleep runs `onPoll` with the poll number, so a test posts a ruling between two reads. */
function watching(deps: ResumeDeps, onPoll: (poll: number) => void = () => {}): RulingWatch & { polls: () => number } {
  let polls = 0
  return {
    deps,
    pollMs: 1,
    sleep: async () => {
      polls += 1
      onPoll(polls)
    },
    polls: () => polls
  }
}

for (const agent of AGENTS) {
  describe(`a halted Engine run on ${agent}`, () => {
    test('a refused step runs again on resume; a step that completed normally does not', async () => {
      const { forge, deps } = fakeForge()
      let refused = false
      const watch = watching(deps, (poll) => {
        if (poll === 1) forge.post()
      })
      const first = stubRun({
        agent,
        watch,
        actions: {
          'vinaya.prepare-sources': () => {
            if (refused) return { exitCode: 0 }
            refused = true
            const detail = 'a required source could not be read'
            first.options.taskInput.handoff?.pause({ reason: 'missing_source', detail })
            return { exitCode: 1, stdout: detail, refused: true }
          }
        }
      })
      const result = await runEngine(first.options)
      expect(result.exitCode).toBe(0)
      expect(forge.claims).toHaveLength(1)
      // The refusal was not recorded, so the resume ran it again before the Developer was dispatched.
      expect(first.actionRuns['prepare-sources']).toBe(2)
      expect(first.actionRuns['prepare-run']).toBe(1)
      expect(first.actionRuns['reconcile-external-state']).toBe(1)
      expect(first.spawns).toEqual(['develop', 'code-review', 'security-review'])
    })

    test('a ruling posted to the forge resumes the run once, from its checkpoint', async () => {
      const { forge, deps } = fakeForge()
      let failed = false
      const watch = watching(deps, (poll) => {
        // The first poll finds no ruling; the Principal posts one before the second.
        if (poll === 1) expect(first.spawns).toEqual(['develop'])
        if (poll === 1) forge.post()
      })
      const first = stubRun({
        agent,
        watch,
        actions: {
          'harness.run-gates': () => {
            if (failed) return { exitCode: 0 }
            failed = true
            throw new Error('the gate runner broke')
          }
        }
      })
      const result = await runEngine(first.options)
      expect(result.exitCode).toBe(0)
      expect(first.handoff.calls.filter((call) => call.startsWith('comment:'))).toHaveLength(1)
      // One claim, as a resume of the pause, authenticated by the ruling's author; the Developer did not run again.
      expect(forge.claims).toEqual([{ expectedPr: null, decision: 'resume', by: 'principal', from: `issue-${TASK}-1` }])
      expect(first.spawns).toEqual(['develop', 'code-review', 'security-review'])
      expect(first.actionRuns['prepare-run']).toBe(1)
      expect(first.driverLog()).toContain('resuming the run from its checkpoint')
      expect(readDriverLock(first.runtimeDir, TASK)).toBeNull()
    })

    test('a poll that finds no ruling resumes nothing, and the watch ends when it is stopped', async () => {
      const { forge, deps } = fakeForge()
      const stop = new AbortController()
      const runtimeDir = fixtureDir('resume-watch-')
      writePauseState(runtimeDir, heldPause())
      const watch = watching(deps, (poll) => {
        if (poll === 3) stop.abort()
      })
      const result = await watchForRuling(runtimeDir, TASK, watch, stop.signal)
      expect(result).toEqual({ kind: 'stopped' })
      expect(watch.polls()).toBe(3)
      expect(forge.claims).toEqual([])
    })

    test('a ruling at the pause’s own ordinal is not new: only a later one resumes', async () => {
      const { forge, deps } = fakeForge()
      forge.ordinal = 2
      forge.escalation = { rulingOrdinal: 2 } as EscalationRecord
      const stop = new AbortController()
      const runtimeDir = fixtureDir('resume-watch-')
      writePauseState(runtimeDir, heldPause())
      const watch = watching(deps, (poll) => {
        if (poll === 1) forge.post()
      })
      const result = await watchForRuling(runtimeDir, TASK, watch, stop.signal)
      expect(result).toEqual({ kind: 'ruled', escalationId: 'esc-1' })
      expect(forge.claims).toEqual([{ expectedPr: PR, decision: 'resume', by: 'principal', from: `${PR}-3` }])
      // The ruling posted at the first sleep is found on the next forge read, which the watch spaced one sleep out.
      expect(watch.polls()).toBe(2)
    })

    test('a cancel ends the watch with no resume', async () => {
      const { forge, deps } = fakeForge()
      const runtimeDir = fixtureDir('resume-watch-')
      writePauseState(runtimeDir, heldPause())
      const watch = watching(deps, () => {
        forge.resolution = resolutionOf('cancel')
      })
      const result = await watchForRuling(runtimeDir, TASK, watch, new AbortController().signal)
      expect(result).toEqual({ kind: 'cancelled' })
      expect(forge.claims).toEqual([])
    })

    test('a pull request merged or closed while the run is halted ends the watch, and no resolution is claimed', async () => {
      for (const [state, ended] of [
        ['MERGED', 'merged'],
        ['CLOSED', 'closed']
      ] as const) {
        const { forge, deps } = fakeForge()
        const runtimeDir = fixtureDir('resume-watch-')
        writePauseState(runtimeDir, heldPause())
        const watch = watching(deps, (poll) => {
          if (poll === 2) forge.prState = state
        })
        const result = await watchForRuling(runtimeDir, TASK, watch, new AbortController().signal)
        expect(result).toEqual({ kind: 'ended', state: ended, pr: PR })
        expect(watch.polls()).toBe(2)
        expect(forge.prStateReads.every((pr) => pr === PR)).toBe(true)
        expect(forge.claims).toEqual([])
      }
    })

    test('a pause bound to its pull request after it was raised is watched on that pull request', async () => {
      const { forge, deps } = fakeForge()
      const runtimeDir = fixtureDir('resume-watch-')
      writePauseState(runtimeDir, heldPause({ prNumber: null }))
      const watch = watching(deps, (poll) => {
        if (poll === 1) writePauseState(runtimeDir, heldPause({ prNumber: PR }))
        if (poll === 2) forge.prState = 'MERGED'
      })
      const result = await watchForRuling(runtimeDir, TASK, watch, new AbortController().signal)
      expect(result).toEqual({ kind: 'ended', state: 'merged', pr: PR })
      // No pull request was read before the pause named one; the forge is read once, after the spaced wait.
      expect(forge.prStateReads).toEqual([PR])
      expect(forge.claims).toEqual([])
    })

    test('a halted run whose pull request is merged ends its process and releases its driver lock', async () => {
      const { forge, deps } = fakeForge()
      const watch = watching(deps, (poll) => {
        if (poll === 1) forge.prState = 'MERGED'
      })
      const first = stubRun({
        agent,
        watch,
        actions: {
          // The reconcile step finds the pull request the pause then belongs to.
          'vinaya.reconcile-external-state': () => ({ exitCode: 0, stdout: JSON.stringify({ number: PR }) }),
          'harness.run-gates': () => {
            throw new Error('the gate runner broke')
          }
        }
      })
      const ends: Array<{ state: 'merged' | 'closed'; task: number; pr: number }> = []
      first.options.lifecycle = { ...first.options.lifecycle, recordChangeEnded: (ended) => void ends.push(ended) }
      await runEngine(first.options)
      expect(forge.claims).toEqual([])
      expect(forge.prStateReads).toContain(PR)
      expect(first.spawns).toEqual(['develop'])
      expect(first.driverLog()).toContain('the pull request was merged while the run was halted; ending')
      // The paused run's own watch recorded the merge, once, for the pull request the pause belongs to.
      expect(ends).toEqual([{ state: 'merged', task: TASK, pr: PR }])
      expect(readDriverLock(first.runtimeDir, TASK)).toBeNull()
    })

    test('a resolution another process claimed first ends the watch without a second resume', async () => {
      const { forge, deps } = fakeForge()
      forge.consumed = resolutionOf('resume')
      const runtimeDir = fixtureDir('resume-watch-')
      writePauseState(runtimeDir, heldPause())
      const watch = watching(deps, () => forge.post())
      const result = await watchForRuling(runtimeDir, TASK, watch, new AbortController().signal)
      expect(result).toEqual({ kind: 'consumed' })
      expect(forge.claims).toHaveLength(1)
    })

    test('a failed forge read is tried again on the next poll', async () => {
      const { forge, deps } = fakeForge()
      let reads = 0
      const flaky: ResumeDeps = {
        ...deps,
        fetchNewestRulingOrdinal: () => {
          reads += 1
          if (reads === 2) throw new Error('gh: HTTP 502')
          return forge.ordinal
        }
      }
      const runtimeDir = fixtureDir('resume-watch-')
      writePauseState(runtimeDir, heldPause())
      const lines: string[] = []
      const watch = watching(flaky, (poll) => {
        if (poll === 2) forge.post()
      })
      const result = await watchForRuling(runtimeDir, TASK, watch, new AbortController().signal, (l) => lines.push(l))
      expect(result.kind).toBe('ruled')
      expect(lines.some((l) => l.includes('HTTP 502'))).toBe(true)
    })

    test('resuming after the code revision moved continues at the next step and records the move', async () => {
      const control = createRunControl()
      const first = stubRun({
        agent,
        control,
        revision: 'rev-old',
        actions: { 'harness.run-gates': () => haltThen(control, 'stop') }
      })
      await runEngine(first.options)
      writePauseState(first.runtimeDir, heldPause({ agent }))
      const { forge, deps } = fakeForge()
      forge.post()
      let second: ReturnType<typeof stubRun> | undefined
      const result = await resumeEngine({
        args: { resume: PR, agent },
        runtimeDir: first.runtimeDir,
        deps,
        run: async (args) => {
          second = stubRun({ agent, args, revision: 'rev-new' }, first.runtimeDir)
          return runEngine(second.options)
        }
      })
      expect(result.exitCode).toBe(0)
      const moved = (second as NonNullable<typeof second>)
        .driverLog()
        .split('\n')
        .filter((line) => line.includes('rev-old'))
      expect(moved).toHaveLength(1)
      expect(moved[0]).toContain('resuming at the next step on revision rev-new')
      expect((second as NonNullable<typeof second>).spawns).toEqual(['code-review', 'security-review'])
    })

    test('resumes with the model --model names, else the one the checkpoint recorded', async () => {
      const control = createRunControl()
      const first = stubRun({
        agent,
        control,
        args: { model: 'model-recorded' },
        actions: { 'harness.run-gates': () => haltThen(control, 'stop') }
      })
      await runEngine(first.options)
      expect(recordedCheckpointModel(first.runtimeDir, TASK)).toBe('model-recorded')
      const seen: Array<string | undefined> = []
      for (const [explicit, expected] of [
        [undefined, 'model-recorded'],
        ['model-explicit', 'model-explicit']
      ] as const) {
        writePauseState(first.runtimeDir, heldPause({ agent, escalationId: `esc-${expected}` }))
        const { forge, deps } = fakeForge()
        forge.post()
        await resumeEngine({
          args: { resume: PR, agent, ...(explicit ? { model: explicit } : {}) },
          runtimeDir: first.runtimeDir,
          deps,
          // The resume is only asked what it would run with; the run itself is not repeated.
          run: async (args) => {
            seen.push(args.model)
            return { outcome: null, exitCode: 0, tracePath: '' }
          }
        })
        expect(seen.at(-1)).toBe(expected)
      }
    })
  })
}

describe('--resume <pr>', () => {
  const claimFor = (agent: Agent | undefined, setup: (f: ReturnType<typeof fakeForge>) => void = () => {}) => {
    const runtimeDir = fixtureDir('resume-claim-')
    const fake = fakeForge()
    writePauseState(runtimeDir, heldPause())
    setup(fake)
    return { runtimeDir, ...fake, claim: () => claimResume(runtimeDir, { pr: PR, agent }, fake.deps) }
  }

  test('takes the task from the pull request’s Closes line, and claims the ruling once', () => {
    const run = claimFor('claude', ({ forge }) => forge.post())
    const claim = run.claim()
    expect(claim).toMatchObject({ task: TASK, agent: 'claude', escalationId: 'esc-1', attached: false })
    expect(run.forge.claims).toEqual([{ expectedPr: PR, decision: 'resume', by: 'principal', from: `${PR}-1` }])
  })

  test('refuses a pull request body with no Closes line', () => {
    const run = claimFor('claude', ({ forge }) => (forge.body = 'no reference'))
    expect(run.claim).toThrow('carries no `Closes #N` reference')
    expect(run.forge.claims).toEqual([])
  })

  test('refuses when no pause is held for the task, or it names another pull request', () => {
    const none = fakeForge()
    expect(() => claimResume(fixtureDir('resume-claim-'), { pr: PR }, none.deps)).toThrow('no held pause state')
    const other = claimFor('claude', ({ forge }) => (forge.body = 'Closes #7'))
    writePauseState(other.runtimeDir, heldPause({ prNumber: 99 }))
    expect(other.claim).toThrow('names PR #99, not PR #70')
  })

  test('refuses when the held pause’s agent differs from the requested one', () => {
    const run = claimFor('codex', ({ forge }) => forge.post())
    expect(run.claim).toThrow('paused on claude')
    expect(run.claim).toThrow('task switch --issue')
    expect(run.forge.claims).toEqual([])
  })

  test('takes the held pause’s agent when none is asked for', () => {
    const run = claimFor(undefined, ({ forge }) => forge.post())
    expect(run.claim().agent).toBe('claude')
  })

  test('refuses with no Principal ruling posted, and consumes nothing', () => {
    const run = claimFor('claude')
    expect(run.claim).toThrow('no Principal ruling comment')
    expect(run.forge.claims).toEqual([])
  })

  test('refuses a pause that has no escalation record to bind a ruling to', () => {
    const run = claimFor('claude', ({ forge }) => {
      forge.post()
      forge.escalation = null
    })
    expect(run.claim).toThrow('is stale')
  })

  test('refuses while a live driver holds the task', () => {
    const run = claimFor('claude', ({ forge }) => {
      forge.post()
      forge.driver = { pid: 4242, startedAt: '2026-01-01T00:00:00.000Z' }
    })
    expect(run.claim).toThrow('a driver is already running (pid 4242')
    expect(run.forge.claims).toEqual([])
  })

  test('attaches when the resolution was already consumed as a resume, instead of refusing', () => {
    const run = claimFor('claude', ({ forge }) => {
      forge.post()
      forge.consumed = resolutionOf('resume')
    })
    expect(run.claim()).toMatchObject({ task: TASK, attached: true })
  })

  test('refuses a resolution already consumed as a cancel', () => {
    const run = claimFor('claude', ({ forge }) => {
      forge.post()
      forge.consumed = resolutionOf('cancel')
    })
    expect(run.claim).toThrow('already has a consumed resolution')
  })

  test('an infrastructure pause within its retry allowance resumes with no ruling', () => {
    const run = claimFor('claude', ({ forge }) => (forge.escalation = null))
    writePauseState(run.runtimeDir, heldPause({ reason: 'infrastructure', infrastructureRetries: 0 }))
    expect(run.claim()).toMatchObject({ attached: false })
    expect(run.forge.claims[0]).toMatchObject({ by: 'driver-self', from: `${PR}-infrastructure-retry` })
  })

  test('a pause raised before any pull request existed is bound to the open one on its branch', () => {
    const run = claimFor('claude', ({ forge }) => forge.post())
    writePauseState(run.runtimeDir, heldPause({ prNumber: null }))
    expect(run.claim()).toMatchObject({ task: TASK })
    expect(run.forge.bound).toEqual([PR])
    // Its ruling is read where its comment was posted, so the claim names no pull request.
    expect(run.forge.claims[0]?.expectedPr).toBeNull()
  })

  test('arguments: a pull request number, optional agent and model', () => {
    expect(parseResumeArgs(['--resume', '70'])).toEqual({ resume: 70 })
    expect(parseResumeArgs(['--resume', '70', '--agent', 'codex', '--model', 'm'])).toEqual({
      resume: 70,
      agent: 'codex',
      model: 'm'
    })
    expect(() => parseResumeArgs(['--resume', 'x'])).toThrow('pull request number')
    expect(() => parseResumeArgs(['--agent', 'claude'])).toThrow('Usage')
    expect(() => parseResumeArgs(['--resume', '70', '--task', '7'])).toThrow('Unknown argument')
  })
})

describe('the flow a resume runs with', () => {
  test('the recorded flow is continued; a named one only when it agrees or none was recorded', () => {
    expect(resumeFlow(undefined, 'v2')).toBe('v2')
    expect(resumeFlow('v2', 'v2')).toBe('v2')
    expect(resumeFlow('v2', undefined)).toBe('v2')
    expect(resumeFlow(undefined, undefined)).toBeUndefined()
    expect(() => resumeFlow('v1', 'v2')).toThrow('never switches to v1')
  })

  test('a fresh run never inherits a recorded flow: it takes the named one, else the default, with a note', () => {
    expect(freshRunFlow(undefined, 'v2').flow).toBeUndefined()
    expect(freshRunFlow(undefined, 'v2').note).toContain('pass --flow v2 to continue it')
    expect(freshRunFlow('v2', undefined)).toEqual({ flow: 'v2' })
    expect(freshRunFlow('v1', 'v2')).toEqual({ flow: 'v1' })
    expect(freshRunFlow(undefined, undefined)).toEqual({})
    expect(freshRunFlow(undefined, 'v1')).toEqual({})
  })

  test('a run records its flow under its run directory and a resume reads it back', () => {
    const runtimeDir = fixtureDir('resume-flow-')
    expect(recordedRunFlow(runtimeDir, 9)).toBeUndefined()
    recordRunFlow(runtimeDir, 9, 'v2')
    expect(recordedRunFlow(runtimeDir, 9)).toBe('v2')
  })

  test('--flow is a resume argument too', () => {
    expect(parseResumeArgs(['--resume', '70', '--flow', 'v2'])).toEqual({ resume: 70, flow: 'v2' })
    expect(() => parseResumeArgs(['--resume', '70', '--flow', ''])).toThrow('--flow takes a flow key')
  })
})

describe('the model a resume runs with', () => {
  test('an explicit model wins, then the recorded one, then the vendor’s default', () => {
    expect(resumeModel('explicit', 'recorded')).toBe('explicit')
    expect(resumeModel(undefined, 'recorded')).toBe('recorded')
    expect(resumeModel(undefined, '')).toBeUndefined()
    expect(resumeModel(undefined, undefined)).toBeUndefined()
  })
})

describe('the poll interval', () => {
  test('is the standalone watcher’s: thirty seconds, or its environment override', () => {
    expect(rulingPollMs({})).toBe(30_000)
    expect(rulingPollMs({ VINAYA_DEV_REVIEW_LOOP_WATCH_POLL_MS: '250' })).toBe(250)
    expect(rulingPollMs({ VINAYA_DEV_REVIEW_LOOP_WATCH_POLL_MS: 'soon' })).toBe(30_000)
  })
})

describe('the watch for a ruling spaces its forge reads', () => {
  const POLL = 30_000
  const CEILING = 300_000
  const HOUR = 3_600_000

  /** A fake clock the watch's sleep advances; the watch is stopped once `limit` has passed. */
  function clockedWatch(deps: ResumeDeps, limit: number, onSleep: (clock: number) => void = () => {}) {
    const stop = new AbortController()
    let clock = 0
    const watch: RulingWatch = {
      deps,
      pollMs: POLL,
      sleep: async (ms) => {
        clock += ms
        onSleep(clock)
        if (clock >= limit) stop.abort()
      }
    }
    return { watch, stop, clock: () => clock }
  }

  const start = () => {
    const runtimeDir = fixtureDir('resume-watch-')
    writePauseState(runtimeDir, heldPause())
    return runtimeDir
  }

  /** A forge whose ruling reads are timed on the clock the test's watch holds, and may fail. */
  function timedForge(fail?: (n: number) => Error | null) {
    const clock = { now: () => 0 }
    const times: number[] = []
    const { forge, deps } = fakeForge({
      fetchNewestRulingOrdinal: () => {
        times.push(clock.now())
        const error = fail?.(times.length)
        if (error) throw error
        return forge.ordinal
      }
    })
    return { forge, deps, times, clock }
  }

  const gapsOf = (times: number[]) => times.slice(1).map((t, i) => t - times[i]!)

  test('eight idle hours at the default interval make no more than 120 forge reads', async () => {
    const { deps, times, clock } = timedForge()
    const run = clockedWatch(deps, 8 * HOUR)
    clock.now = run.clock
    const result = await watchForRuling(start(), TASK, run.watch, run.stop.signal)
    expect(result).toEqual({ kind: 'stopped' })
    expect(times.length).toBeGreaterThan(50)
    expect(times.length).toBeLessThanOrEqual(120)
    expect(Math.max(...gapsOf(times))).toBe(CEILING)
  })

  for (const decision of ['cancel', 'resume'] as const) {
    test(`a ${decision} recorded on the host after hours of idling ends the watch within one interval`, async () => {
      const { forge, deps, clock } = timedForge()
      const run = clockedWatch(deps, 20 * HOUR, (now) => {
        if (now === 5 * HOUR) forge.resolution = resolutionOf(decision)
      })
      clock.now = run.clock
      const result = await watchForRuling(start(), TASK, run.watch, run.stop.signal)
      expect(result.kind).toBe(decision === 'cancel' ? 'cancelled' : 'consumed')
      expect(run.clock()).toBeLessThanOrEqual(5 * HOUR + POLL)
    })
  }

  test('failing forge reads never bring two reads closer than the reads before them', async () => {
    const { deps, times, clock } = timedForge(() => new Error('gh: HTTP 502'))
    const run = clockedWatch(deps, 3 * HOUR)
    clock.now = run.clock
    await watchForRuling(start(), TASK, run.watch, run.stop.signal)
    const gaps = gapsOf(times)
    expect(gaps.length).toBeGreaterThan(5)
    for (let i = 1; i < gaps.length; i += 1) expect(gaps[i]!).toBeGreaterThanOrEqual(gaps[i - 1]!)
    expect(gaps[0]!).toBeGreaterThanOrEqual(POLL)
  })

  test('a spent rate limit makes the watch wait the full ceiling before its next forge read', async () => {
    const { deps, times, clock } = timedForge((n) =>
      n === 1 ? new Error('gh: API rate limit already exceeded for user ID 1. (HTTP 403)') : null
    )
    const run = clockedWatch(deps, HOUR)
    clock.now = run.clock
    await watchForRuling(start(), TASK, run.watch, run.stop.signal)
    expect(times[1]! - times[0]!).toBe(CEILING)
  })

  test('a ruling posted at the longest wait is found on the next forge read and claimed once', async () => {
    const { forge, deps, times, clock } = timedForge()
    const run = clockedWatch(deps, 20 * HOUR, (now) => {
      if (now === 4 * HOUR) forge.post()
    })
    clock.now = run.clock
    const result = await watchForRuling(start(), TASK, run.watch, run.stop.signal)
    expect(result.kind).toBe('ruled')
    expect(forge.claims).toHaveLength(1)
    expect(times.at(-1)!).toBeGreaterThan(4 * HOUR)
    expect(times.at(-1)!).toBeLessThanOrEqual(4 * HOUR + CEILING)
  })

  test("the claim carries the author the accepting read returned, not an earlier read's", async () => {
    let reads = 0
    const { forge, deps } = fakeForge({
      fetchNewestRulingOrdinal: () => {
        reads += 1
        return forge.ordinal
      },
      fetchNewestRulingAuthor: () => `author-at-read-${reads}`
    })
    const run = clockedWatch(deps, 20 * HOUR, (now) => {
      if (now === 2 * HOUR) forge.post()
    })
    const result = await watchForRuling(start(), TASK, run.watch, run.stop.signal)
    expect(result.kind).toBe('ruled')
    expect(reads).toBeGreaterThan(2)
    expect(forge.claims).toHaveLength(1)
    expect(forge.claims[0]!.by).toBe(`author-at-read-${reads}`)
  })
})

describe('a run-engine --resume start ends the person span an earlier process asked', () => {
  test('claimResume with the real resolver: one asked event, one whole person span, no handoff', async () => {
    const harness = await import('./standalone/lib/dev-review-loop-harness')
    const support = await import('./standalone/lib/person-span-support')
    const { claimResume } = await import('../bin/run-lifecycle')
    const { escalationIdFor } = await import('../loops/dev-review/standalone/dev-review-loop/pause-resume')
    const world = harness.makeWorld()
    try {
      const facts = support.escalationFactsFor(world)
      const escalationId = escalationIdFor(facts.task, facts.round, facts.head)
      const deps: ResumeDeps = {
        ...liveResumeDeps,
        crossRunnerRefusal: () => null,
        liveDriver: () => null,
        infrastructureRetries: () => 0,
        taskFromPrBody: () => facts.task,
        fetchPrBody: () => `Closes #${facts.task}`,
        readPauseState: () => ({
          task: facts.task,
          round: facts.round,
          head: facts.head,
          branch: facts.branch,
          prNumber: facts.pr,
          reason: 'escalation',
          pausedAt: '2026-01-01T00:00:00.000Z',
          agent: 'claude',
          escalationId
        }),
        fetchRulings: () => ['Go ahead.'],
        fetchIssueRulings: () => ['Go ahead.'],
        fetchNewestRulingOrdinal: () => 1,
        fetchNewestIssueRulingOrdinal: () => 1,
        fetchNewestRulingAuthor: () => 'principal-1',
        fetchNewestIssueRulingAuthor: () => 'principal-1'
      }
      const claim = await harness.withWorldEnv(world, async () => {
        support.raiseInAnotherProcess(facts)
        const claimed = claimResume(world.runtimeDir, { pr: world.prNumber }, deps)
        await (await import('@harness/kernel/log/run-recorder')).runRecorder().drain()
        return claimed
      })
      expect(claim.escalationId).toBe(escalationId)
      const seen = support.personRecordsOf(world)
      expect(seen.asked()).toHaveLength(1)
      expect(seen.spans()).toHaveLength(1)
      expect(seen.spans()[0]?.attributes).toMatchObject({
        'vinaya.person.answer': 'resume',
        'vinaya.person.answered_by': 'principal-1'
      })
      expect(seen.earlier()).toEqual([])
    } finally {
      harness.cleanupWorlds()
    }
  })
})

describe('resolving an escalation while a newer claim takes the ownership number', () => {
  /**
   * A control store whose root, read once `when` first holds, lets another claimant take the task's next ownership
   * number before the read goes on: the claim under test then meets that newer number at its next store write.
   */
  async function racingStore(task: number, when: (base: ControlStoreDeps) => boolean) {
    const { controlStoreRoot } = await import('@harness/kernel/effects/effects')
    const base = defaultControlStoreDeps(controlStoreRoot)
    let raced = false
    const deps: ControlStoreDeps = {
      ...base,
      root: () => {
        if (!raced && when(base)) {
          raced = true
          acquireOwnership(base, task, 'another-claimant')
        }
        return base.root()
      }
    }
    return { deps, base, raced: () => raced }
  }

  type Pause = { task: number; pr: number | null; escalationId: string }

  /** Runs `body` in a world whose pause's escalation record is written, and returns what stderr received. */
  async function withEscalation<T>(body: (pause: Pause) => Promise<T>): Promise<{ result: T; stderr: string }> {
    const harness = await import('./standalone/lib/dev-review-loop-harness')
    const support = await import('./standalone/lib/person-span-support')
    const world = harness.makeWorld()
    const written: string[] = []
    const write = process.stderr.write
    try {
      return await harness.withWorldEnv(world, async () => {
        const facts = support.escalationFactsFor(world)
        writeEscalationRecord(facts)
        process.stderr.write = ((chunk: string | Uint8Array) => {
          written.push(String(chunk))
          return true
        }) as typeof process.stderr.write
        try {
          const result = await body({
            task: facts.task,
            pr: facts.pr,
            escalationId: escalationIdFor(facts.task, facts.round, facts.head)
          })
          return { result, stderr: written.join('') }
        } finally {
          process.stderr.write = write
        }
      })
    } finally {
      harness.cleanupWorlds()
    }
  }

  test('a resume whose transition is refused after its own resolution was recorded returns that resolution', async () => {
    const { result, stderr } = await withEscalation(async ({ task, pr, escalationId }) => {
      const store = await racingStore(task, (base) => readResolution(base, task, escalationId).status === 'ok')
      const resolved = resolveEscalation(task, escalationId, pr, 'resume', 'principal-1', `${pr}-1`, store.deps)
      return {
        resolved,
        raced: store.raced(),
        current: readCurrentOwnership(store.base, task),
        recorded: readResolution(store.base, task, escalationId),
        pr
      }
    })
    expect(result.raced).toBe(true)
    expect(result.current.record?.ownerId).toBe('another-claimant')
    expect(result.resolved.epoch).toBe(result.current.epoch - 1)
    expect(result.resolved.resolution).toMatchObject({
      decision: 'resume',
      authenticatedBy: 'principal-1',
      authenticatedFrom: `${result.pr}-1`
    })
    expect(result.recorded).toEqual({ status: 'ok', value: result.resolved.resolution })
    expect(stderr).toContain('is recorded, but its transition was refused')
    expect(stderr).toContain('control-store: refusing a write')
  })

  test('a claim refused as stale before its resolution is recorded throws, and records nothing', async () => {
    const { result } = await withEscalation(async ({ task, pr, escalationId }) => {
      const store = await racingStore(
        task,
        (base) => readCurrentOwnership(base, task).record?.ownerId.includes(':resolution:') === true
      )
      let thrown: unknown = null
      try {
        resolveEscalation(task, escalationId, pr, 'resume', 'principal-1', `${pr}-1`, store.deps)
      } catch (error) {
        thrown = error
      }
      return { thrown, raced: store.raced(), recorded: readResolution(store.base, task, escalationId).status }
    })
    expect(result.raced).toBe(true)
    expect(result.thrown).toBeInstanceOf(StaleEpochWriteError)
    expect(result.recorded).toBe('absent')
  })

  test('a cancel after a recorded resume is refused as a replayed resolution, with the message it always had', async () => {
    const { result } = await withEscalation(async ({ task, pr, escalationId }) => {
      const store = await racingStore(task, (base) => readResolution(base, task, escalationId).status === 'ok')
      const resumed = resolveEscalation(task, escalationId, pr, 'resume', 'principal-1', `${pr}-1`, store.deps)
      let thrown: unknown = null
      try {
        resolveEscalation(task, escalationId, pr, 'cancel', 'principal-1', `${pr}-cancel`, store.base)
      } catch (error) {
        thrown = error
      }
      return { thrown, existing: resumed.resolution, task, escalationId }
    })
    expect(result.thrown).toBeInstanceOf(ReplayedResolutionError)
    expect((result.thrown as Error).message).toBe(
      `resolution refused — task ${result.task}'s escalation '${result.escalationId}' already has a consumed resolution (decision: resume, by ${result.existing.authenticatedBy}, at ${result.existing.consumedAt}) — the resume already happened; replay refused`
    )
  })
})
