import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_REVIEW_POLICY, objectivesVersion } from '@attalabs/aeg-core'
import type { SpawnedProcessLike } from '@atta/executor-agent-spawn'
import { loadProcess } from '../../../harness/dev-process/loader/load-process'
import type { ActionRegistry } from '../../../harness/dev-process/engine-runtime/run-process'
import { defaultRebaseOntoDefaultTip, publishingInstructionLine } from '../../../apps/cli/src/lib/dev-review-loop'
import { renderConflictPrompt } from '../../../apps/cli/src/lib/dev-review-loop/gate-reading'
import { pauseMarker, readPauseState } from '../../../apps/cli/src/lib/dev-review-loop/pause-resume'
import { cleanupAllReviewerIsolationArtifacts } from '../../../apps/cli/src/lib/dev-review-loop/reviewer-isolation'
import { turnResultInstruction } from '../../../apps/cli/src/lib/dev-review-loop/turn-result'
import { engineLiveDevToolsContext, liveTaskInput, runEngine, type Agent, type EngineForge } from '../bin/run-engine'
import { createActions } from '../executing/actions'
import type { DeveloperPromptFacts } from '../executing/developer-prompt'
import { liveHandoffDeps, type HandoffDeps } from '../executing/handoff'
import { keepLogLocal, SCENARIO_ENV_KEYS, useRuntimeDir } from './round-fakes'
import {
  fakeDeps,
  makeWorld,
  OWN,
  SURFACE,
  WORKFLOW
} from '../../../apps/cli/tests/lib/task-tools/live-developer-context-world'

// The forge gates of the Engine Flow — mergeability, the forge's CI and the premise re-check — each driven end to
// end on the real runner, Flow and bound actions: a real git repository and worktree, a stand-in check command that
// passes, a fake forge and vendor-shaped stub agents. The gate-reading functions the steps call are the forge's
// fakes here; every decision stays the actions'. The rebase onto the default tip runs the real git rebase through the
// Engine's shared Developer context. Each case runs once with the Claude stub agent and once with the Codex stub agent.

const PROCESS = loadProcess(resolve(import.meta.dir, '..'))
const AGENTS: readonly Agent[] = ['claude', 'codex']
const TASK = 7
const BRANCH = 'task/issue-7'
const PR = 70
const ROLES = ['developer', 'code-reviewer', 'security-reviewer'] as const
type Role = (typeof ROLES)[number]
type Conclusion = 'green' | 'red' | 'pending'
type Mergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'

interface Forge {
  /** The CI conclusions read in turn, for any head; the last repeats. */
  ci: Conclusion[]
  /** The mergeable states read in turn; the last repeats. */
  mergeable: Mergeable[]
  conflictFiles: string[]
  prBody: string
  /** The workflow runs whose failed jobs a rerun reruns; a rerun turns the CI read green when `rerunTurnsGreen`. */
  failedRunIds: number[]
  rerunTurnsGreen: boolean
}

interface World {
  worktree: string
  remote: string
  prOpen: boolean
  commit: () => string
}

interface Observed {
  outcome: string
  pauseReason: string | null
  spawns: Record<Role, number>
  developerPrompts: string[]
  ciReads: string[]
  mergeableReads: number
  reruns: number[]
  sleeps: number
  markers: string[]
  published: number
  steps: Array<{ node: string; exitCode: number; stdout: string }>
}

const turn = (addressed: string[] = []) => ({
  turnResult: {
    schemaVersion: 1,
    status: 'completed',
    summary: 'Done.',
    confidence: 95,
    confidenceExplanation: 'Stub result.',
    addressedFindingIds: addressed,
    sourceUses: [],
    reportedChecks: null
  }
})

function stubChild(
  agent: Agent,
  launch: (prompt: string) => { output: unknown; act?: () => void }
): SpawnedProcessLike {
  const closeListeners: Array<(code: number | null) => void> = []
  let stdout: ((chunk: string) => void) | undefined
  let prompt = ''
  return {
    stdin: {
      write: (chunk: string) => {
        prompt += chunk
      },
      end: () => {
        setTimeout(() => {
          const { output, act } = launch(prompt)
          act?.()
          const lines =
            agent === 'claude'
              ? [
                  { type: 'system', session_id: 's' },
                  { type: 'result', session_id: 's', structured_output: output }
                ]
              : [
                  { type: 'thread.started', thread_id: 's' },
                  { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(output) } },
                  { type: 'turn.completed' }
                ]
          for (const line of lines) stdout?.(`${JSON.stringify(line)}\n`)
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
      for (const listener of closeListeners) listener(null)
    }
  } as SpawnedProcessLike
}

function roleOf(agent: Agent, args: readonly string[], env: Record<string, string | undefined> | undefined): Role {
  const marker =
    agent === 'claude' ? (args[args.indexOf('--settings') + 1] ?? '') : `${env?.CODEX_HOME ?? ''}/role-settings.json`
  const role = ROLES.find((name) => marker.includes(`/generated/${name}/`))
  if (role === undefined) throw new Error(`unrecognized ${agent} launch: ${marker}`)
  return role
}

function review(role: Role, prompt: string) {
  const binding = /headSha (\S+), and manifestDigest (\S+)\./.exec(prompt)
  return {
    reviewResult: {
      schemaVersion: 1,
      role,
      status: 'completed',
      headSha: binding?.[1] ?? 'unbound',
      manifestDigest: binding?.[2] ?? 'unbound',
      summary: 'Stub review.',
      findings: [],
      objectiveResults: [{ id: 'O1', status: 'MET', evidence: 'sample.ts implements the behavior.' }]
    }
  }
}

const savedEnv: Record<string, string | undefined> = {}
const roots: string[] = []
beforeAll(() => {
  for (const key of ['CODEX_HOME', ...SCENARIO_ENV_KEYS]) savedEnv[key] = process.env[key]
  const home = mkdtempSync(join(tmpdir(), 'forge-gates-codex-'))
  writeFileSync(join(home, 'auth.json'), '{}\n')
  process.env.CODEX_HOME = home
  keepLogLocal()
})
afterAll(() => {
  for (const root of roots) {
    cleanupAllReviewerIsolationArtifacts(join(root, 'runtime'), TASK)
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    } catch {}
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  useRuntimeDir(null)
})

const gitIn =
  (cwd: string) =>
  (...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()

/**
 * One Engine run over `forge`. The Developer publishes a new head on each turn unless `developerPushes` says it does
 * not on that attempt; both reviewers approve.
 */
async function run(
  agent: Agent,
  forge: Forge,
  developerPushes: (attempt: number) => boolean = () => true
): Promise<Observed> {
  const root = mkdtempSync(join(tmpdir(), 'forge-gates-'))
  roots.push(root)
  const runtimeDir = join(root, 'runtime')
  mkdirSync(runtimeDir)
  useRuntimeDir(runtimeDir)
  const repo = join(root, 'repo')
  mkdirSync(repo)
  const git = gitIn(repo)
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'sample.ts'), 'export const value = 1\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  const worktree = join(repo, '.worktrees', BRANCH)
  git('worktree', 'add', '-q', '-b', BRANCH, worktree)
  let commits = 0
  const world: World = {
    worktree,
    remote: git('rev-parse', 'HEAD'),
    prOpen: false,
    commit: () => {
      commits += 1
      writeFileSync(join(worktree, 'sample.ts'), `export const value = ${commits + 1}\n`)
      git('-C', worktree, 'commit', '-q', '-am', `change ${commits}`)
      world.remote = git('-C', worktree, 'rev-parse', 'HEAD')
      return world.remote
    }
  }
  const gateCli = join(root, 'gate.ts')
  writeFileSync(gateCli, `console.log('checks passed'); process.exit(0)\n`)
  const brief = `# Frozen brief\n\n## Objectives\n\nO1. Do the thing.\n\n## Documentation\n\n- docs/x.md\n\n**Revision:** ${world.remote}\n`
  const objectives = [{ id: 'O1', text: 'Do the thing.' }]
  const observed: Observed = {
    outcome: '',
    pauseReason: null,
    spawns: { developer: 0, 'code-reviewer': 0, 'security-reviewer': 0 },
    developerPrompts: [],
    ciReads: [],
    mergeableReads: 0,
    reruns: [],
    sleeps: 0,
    markers: [],
    published: 0,
    steps: []
  }
  const next = <T>(queue: T[]): T => (queue.length > 1 ? (queue.shift() as T) : (queue[0] as T))
  let reran = false
  const engineForge: Partial<EngineForge> = {
    checkTaskDispatchReadiness: () => ({ ready: true, output: 'ready' }),
    createTaskWorktree: () => worktree,
    findOpenPrForBranch: () => (world.prOpen ? { number: PR, branch: BRANCH } : null),
    fetchFrozenBrief: () => brief,
    resolveIssueObjectives: () => ({
      objectives,
      text: 'O1. Do the thing.',
      version: objectivesVersion(objectives),
      edit: null
    }),
    fetchNewestRulingOrdinal: () => 0,
    fetchNewestIssueRulingOrdinal: () => 0,
    fetchSourceRevision: () => 'revision',
    fetchCiConclusion: (head) => {
      observed.ciReads.push(head)
      return reran && forge.rerunTurnsGreen ? 'green' : next(forge.ci)
    },
    fetchFailingCheckRuns: () => [{ name: 'unit', id: 9, startedAt: null }],
    fetchFailedCheckWorkflowRunIds: () => forge.failedRunIds,
    rerunFailedWorkflowJobs: (runId) => {
      observed.reruns.push(runId)
      reran = true
    },
    fetchMergeableState: () => {
      observed.mergeableReads += 1
      return next(forge.mergeable)
    },
    fetchConflictingFiles: () => forge.conflictFiles,
    postMarkedComment: (_kind, _ref, marker) => {
      observed.markers.push(marker)
      return 'https://example.invalid/comment'
    },
    fetchIssueRulingsAfterBrief: () => [],
    fetchRulings: () => [],
    fetchLoopHistory: () => ({
      rounds: [],
      totalWallMs: 0,
      totalFilesChanged: 0,
      summaryUrl: null,
      reviewGate: 'unknown',
      journalFinalized: null
    }),
    resolveHead: () => world.remote,
    resolveDeveloperDoctrineText: () => Promise.resolve('Execute the frozen brief.'),
    prBody: () => forge.prBody,
    pullRequestView: () => ({ number: PR, body: forge.prBody, headRefOid: world.remote, state: 'OPEN' }),
    publishRound: () => {
      observed.published += 1
    }
  }
  const task = await liveTaskInput({ task: TASK, agent, dryRun: false }, repo, runtimeDir, 'forge-gates', {
    fetchLabels: () => [],
    fetchTitle: () => 'A test task',
    policy: () => DEFAULT_REVIEW_POLICY,
    forge: engineForge,
    repository: 'attalabs/forge-gates'
  })
  task.cliEntry = gateCli
  task.gatePoll = {
    gatePollMaxAttempts: 4,
    gatePollIntervalMs: 0,
    sleep: async () => {
      observed.sleeps += 1
    }
  }
  task.bound = {
    ...task.bound,
    localGateControl: () => ({ control: 'local-gate', active: true, detail: '', remedy: '' }),
    probeAgentSandbox: async () => ({ ok: true })
  }
  const actions: ActionRegistry = Object.fromEntries(
    Object.entries(createActions(task)).map(([name, action]) => [
      name,
      async (context: Parameters<typeof action>[0]) => {
        const result = await action(context)
        observed.steps.push({ node: context.nodeId, exitCode: result.exitCode, stdout: result.stdout ?? '' })
        return result
      }
    ])
  )
  const handoffDeps: HandoffDeps = {
    ...liveHandoffDeps(() => {}),
    postPauseComment: (_task, _round, _head, _pr, reason) => {
      observed.markers.push(pauseMarker(reason))
      return { attempts: 1, posted: true }
    },
    postIssuePauseComment: (_task, _branch, _round, reason) => {
      observed.markers.push(pauseMarker(reason))
      return { attempts: 1, posted: true }
    }
  }
  const facts = (): DeveloperPromptFacts => ({
    brief,
    objectives: { objectives, version: objectivesVersion(objectives) },
    rulings: [],
    rulingOrdinal: 0,
    policy: DEFAULT_REVIEW_POLICY,
    baseSha: world.remote,
    headSha: world.remote,
    sources: { block: null, evidence: [] },
    round: task.reviewRound(),
    doctrine: 'Execute the frozen brief.',
    issueRulings: [],
    keptWork: null,
    resume: { task: TASK, branch: BRANCH, worktree, remoteHead: world.remote },
    heldReview: null
  })
  const result = await runEngine({
    args: { task: TASK, agent, dryRun: false },
    process: PROCESS,
    repoRoot: repo,
    runtimeDir,
    loopId: 'forge-gates',
    taskInput: task,
    handoffDeps,
    actions,
    sink: { log: () => {}, drain: async () => {} },
    startHost: async () => ({ close: async () => {} }),
    devToolsContext: {} as never,
    out: () => {},
    developerFacts: async () => facts(),
    spawnFn: (_command, args, options) => {
      const role = roleOf(agent, args, options?.env)
      observed.spawns[role] += 1
      const attempt = observed.spawns[role]
      return stubChild(agent, (prompt) => {
        if (role !== 'developer') return { output: review(role, prompt) }
        observed.developerPrompts.push(prompt)
        world.prOpen = true
        return { output: turn(), act: developerPushes(attempt) ? () => world.commit() : undefined }
      })
    }
  })
  const trace = JSON.parse(readFileSync(result.tracePath, 'utf8')) as { outcome: string }
  observed.outcome = trace.outcome
  observed.pauseReason = readPauseState(runtimeDir, TASK)?.reason ?? null
  return observed
}

const stepsNamed = (observed: Observed, node: string) => observed.steps.filter((step) => step.node === node)

for (const agent of AGENTS) {
  describe(`the forge CI step (${agent})`, () => {
    test('a green CI read goes on to the reviewers and publishes', async () => {
      const observed = await run(agent, {
        ci: ['green'],
        mergeable: ['MERGEABLE'],
        conflictFiles: [],
        prBody: `Closes #${TASK}`,
        failedRunIds: [],
        rerunTurnsGreen: false
      })
      expect(observed.outcome).toBe('completed')
      expect(observed.published).toBe(1)
      expect(observed.spawns).toEqual({ developer: 1, 'code-reviewer': 1, 'security-reviewer': 1 })
      expect(JSON.parse(stepsNamed(observed, 'read-forge-ci')[0]!.stdout)).toMatchObject({ conclusion: 'green' })
      // The round marker precedes the reviewers, as the standalone loop posts it.
      expect(observed.markers).toEqual(['<!-- aeg:developer:round-1 -->'])
    })

    test('a pending CI read is waited on until it resolves green', async () => {
      const observed = await run(agent, {
        ci: ['pending', 'pending', 'green'],
        mergeable: ['MERGEABLE'],
        conflictFiles: [],
        prBody: `Closes #${TASK}`,
        failedRunIds: [],
        rerunTurnsGreen: false
      })
      expect(observed.outcome).toBe('completed')
      // Three reads for one head, the poll's sleep between each pending read.
      expect(observed.ciReads.slice(0, 3)).toEqual([observed.ciReads[0]!, observed.ciReads[0]!, observed.ciReads[0]!])
      expect(observed.sleeps).toBe(2)
      expect(observed.spawns.developer).toBe(1)
    })

    test('a red CI read is a gate observation that sends the Developer back with the failing checks', async () => {
      const observed = await run(agent, {
        ci: ['red', 'green'],
        mergeable: ['MERGEABLE'],
        conflictFiles: [],
        prBody: `Closes #${TASK}`,
        failedRunIds: [],
        rerunTurnsGreen: false
      })
      expect(observed.outcome).toBe('completed')
      expect(observed.spawns).toEqual({ developer: 2, 'code-reviewer': 1, 'security-reviewer': 1 })
      expect(stepsNamed(observed, 'assess-gate')[0]?.exitCode).toBe(1)
      const second = observed.developerPrompts[1]!
      expect(second).toContain(
        'CI is red on the last head. Failing check-run(s): unit (run 9). Fix the failing check(s).'
      )
      expect(second).not.toContain('# Frozen brief')
      // A Developer that published a new head is never rerun: the new head is read afresh.
      expect(observed.reruns).toEqual([])
    })

    test('an unchanged red head has its failed jobs rerun once, and a green rerun goes on to review', async () => {
      const observed = await run(
        agent,
        {
          ci: ['red'],
          mergeable: ['MERGEABLE'],
          conflictFiles: [],
          prBody: `Closes #${TASK}`,
          failedRunIds: [41, 42],
          rerunTurnsGreen: true
        },
        (attempt) => attempt === 1
      )
      expect(observed.reruns).toEqual([41, 42])
      expect(observed.outcome).toBe('completed')
      expect(observed.spawns).toEqual({ developer: 2, 'code-reviewer': 1, 'security-reviewer': 1 })
    })

    test('an unchanged red head is rerun only once: a second stall on it is the repeat_failure stop', async () => {
      const observed = await run(
        agent,
        {
          ci: ['red'],
          mergeable: ['MERGEABLE'],
          conflictFiles: [],
          prBody: `Closes #${TASK}`,
          failedRunIds: [41],
          rerunTurnsGreen: false
        },
        (attempt) => attempt === 1
      )
      expect(observed.reruns).toEqual([41])
      expect(observed.outcome).toBe('paused')
      expect(observed.pauseReason).toBe('repeat_failure')
      expect(observed.spawns['code-reviewer']).toBe(0)
      expect(observed.spawns['security-reviewer']).toBe(0)
    })
  })

  describe(`the mergeability step (${agent})`, () => {
    test('a conflicting head goes back to the Developer with the conflicting files, never to the reviewers', async () => {
      const observed = await run(agent, {
        ci: ['green'],
        mergeable: ['UNKNOWN', 'CONFLICTING', 'MERGEABLE'],
        conflictFiles: ['sample.ts'],
        prBody: `Closes #${TASK}`,
        failedRunIds: [],
        rerunTurnsGreen: false
      })
      expect(observed.outcome).toBe('completed')
      expect(observed.spawns).toEqual({ developer: 2, 'code-reviewer': 1, 'security-reviewer': 1 })
      // The conflicting head was never read for CI: mergeability comes first.
      expect(stepsNamed(observed, 'read-forge-ci')).toHaveLength(1)
      expect(stepsNamed(observed, 'check-mergeability').map((step) => step.exitCode)).toEqual([1, 0])
      // The Developer prompt after the conflict carries only the delta: the conflict text naming the files,
      // then the turn-result instruction, never the brief or its Documentation section.
      const second = observed.developerPrompts[1]!
      const conflict = renderConflictPrompt(['sample.ts'], publishingInstructionLine())
      expect(second).toContain(conflict)
      expect(second).toContain('- sample.ts')
      expect(second.indexOf(conflict)).toBeLessThan(second.lastIndexOf(turnResultInstruction(1)))
      expect(second).not.toContain('# Frozen brief')
      expect(second).not.toContain('## Documentation')
    })

    test('a conflict the Developer never resolves pauses repeat_failure with no reviewer dispatched', async () => {
      const observed = await run(
        agent,
        {
          ci: ['green'],
          mergeable: ['CONFLICTING'],
          conflictFiles: ['sample.ts'],
          prBody: `Closes #${TASK}`,
          failedRunIds: [],
          rerunTurnsGreen: false
        },
        (attempt) => attempt === 1
      )
      expect(observed.outcome).toBe('paused')
      expect(observed.pauseReason).toBe('repeat_failure')
      expect(observed.spawns['code-reviewer']).toBe(0)
      expect(observed.spawns['security-reviewer']).toBe(0)
      expect(observed.ciReads).toEqual([])
      expect(observed.markers).toEqual([pauseMarker('repeat_failure')])
    })
  })

  describe(`the premise step (${agent})`, () => {
    test('a stale Premise pin at the head pauses through the handoff before any reviewer', async () => {
      const observed = await run(agent, {
        ci: ['green'],
        mergeable: ['MERGEABLE'],
        conflictFiles: [],
        prBody: `**Premise:**\n- definitely-absent-pinned-file.ts contains: OLD_SYMBOL\n\nCloses #${TASK}`,
        failedRunIds: [],
        rerunTurnsGreen: false
      })
      expect(observed.outcome).toBe('paused')
      expect(observed.pauseReason).toBe('escalation')
      expect(observed.spawns).toEqual({ developer: 1, 'code-reviewer': 0, 'security-reviewer': 0 })
      expect(JSON.parse(stepsNamed(observed, 'check-premise')[0]!.stdout)).toMatchObject({ premise: 'stale' })
      expect(stepsNamed(observed, 'assess-gate')).toEqual([])
      expect(observed.published).toBe(0)
    })

    test('a body with no Premise block is dormant', async () => {
      const observed = await run(agent, {
        ci: ['green'],
        mergeable: ['MERGEABLE'],
        conflictFiles: [],
        prBody: `Closes #${TASK}`,
        failedRunIds: [],
        rerunTurnsGreen: false
      })
      expect(JSON.parse(stepsNamed(observed, 'check-premise')[0]!.stdout)).toEqual({ premise: 'dormant' })
    })
  })

  describe(`the rebase onto the default tip, through the Engine's shared Developer context (${agent})`, () => {
    /** A repository whose default branch moved a protected path after the task branched, and the task's own commit. */
    function drifted(conflicting: boolean) {
      const root = mkdtempSync(join(tmpdir(), 'forge-gates-rebase-'))
      roots.push(root)
      const git = gitIn(root)
      git('init', '-q', '-b', 'main')
      mkdirSync(join(root, 'apps/cli/src'), { recursive: true })
      mkdirSync(join(root, '.github/workflows'), { recursive: true })
      writeFileSync(join(root, 'apps/cli/src/own.ts'), 'export const own = 1\n')
      writeFileSync(join(root, WORKFLOW), 'name: ci\n')
      git('add', '-A')
      git('commit', '-q', '-m', 'base')
      git('checkout', '-q', '-b', 'task/t/8')
      writeFileSync(join(root, 'apps/cli/src/own.ts'), 'export const own = 2\n')
      git('commit', '-q', '-am', 'the task change')
      const taskHead = git('rev-parse', 'HEAD')
      git('checkout', '-q', 'main')
      writeFileSync(join(root, WORKFLOW), 'name: ci moved\n')
      if (conflicting) writeFileSync(join(root, 'apps/cli/src/own.ts'), 'export const own = 3\n')
      git('commit', '-q', '-am', 'the default branch moves')
      const tip = git('rev-parse', 'HEAD')
      git('checkout', '-q', 'task/t/8')
      return { root, git, taskHead, tip }
    }

    function context(repo: ReturnType<typeof drifted>) {
      const world = makeWorld({ head: repo.taskHead, remote: 'remote-0', dirty: [], changed: [OWN, WORKFLOW] })
      const leases: Array<{ sha: string; expectedRemoteHead: string; touchedPaths: readonly string[] }> = []
      const live = engineLiveDevToolsContext({
        branch: 'task/t/8',
        worktreePath: repo.root,
        task: 8,
        runtimeDir: mkdtempSync(join(tmpdir(), 'forge-gates-rebase-runtime-')),
        agent,
        repo: null,
        round: () => 1,
        deps: {
          ...fakeDeps(world),
          readWorktreeHead: () => repo.git('rev-parse', 'HEAD'),
          readUnpushedWorkDetail: () => ({ dirtyFiles: [], aheadCount: 1 }),
          resolveTaskSurface: () => SURFACE,
          readDefaultBranchTip: () => repo.tip,
          // The default branch moved the workflow; the task never touched it.
          classifyAgainstDefaultTip: () => ({ sameAsTip: [], mainDrift: [WORKFLOW] }),
          rebaseOntoDefaultTip: defaultRebaseOntoDefaultTip,
          // The publication range shows the workflow the default branch moved; the rebased range, the task's own file.
          gitWorktreeChangedPaths: (_worktree: string, base: string) => (base === repo.tip ? [OWN] : [OWN, WORKFLOW]),
          pushTaskBranchWithLease: (input: {
            sha: string
            expectedRemoteHead: string
            touchedPaths: readonly string[]
          }) => {
            leases.push(input)
            return { ok: true as const }
          }
        } as never
      })
      return { live, world, leases }
    }

    test('a publication blocked only by main drift rebases onto the tip and pushes with lease', async () => {
      const repo = drifted(false)
      const { live, world, leases } = context(repo)
      await live.beginTurn()
      const published = await live.context.publishChanges('Fix(cli): The task change')
      const rebased = repo.git('rev-parse', 'HEAD')
      expect(published).toMatchObject({ ok: true, result: { pushedHead: rebased } })
      expect(rebased).not.toBe(repo.taskHead)
      expect(repo.git('merge-base', '--is-ancestor', repo.tip, 'HEAD')).toBe('')
      expect(leases).toEqual([expect.objectContaining({ sha: rebased, expectedRemoteHead: 'remote-0' })])
      expect(leases[0]!.touchedPaths).toEqual([OWN])
      // No plain push: the lease push is the one publication.
      expect(world.pushes).toEqual([])
    })

    test('a rebase that conflicts goes back to the Developer with its files, and nothing is pushed', async () => {
      const repo = drifted(true)
      const { live, world, leases } = context(repo)
      await live.beginTurn()
      const published = await live.context.publishChanges('Fix(cli): The task change')
      expect(published.ok).toBe(false)
      if (!published.ok) {
        expect(published.error.errorClass).toBe('conflict')
        expect(published.error.output).toContain(`git merge --no-commit ${repo.tip}`)
        expect(published.error.output).toContain(`- ${OWN}`)
      }
      // The head is checked back where it was, with no rebase in progress, and the refusal is quoted next turn.
      expect(repo.git('rev-parse', 'HEAD')).toBe(repo.taskHead)
      expect(repo.git('status', '--porcelain')).toBe('')
      expect(live.state.lastPushRefusal).toContain(OWN)
      expect(leases).toEqual([])
      expect(world.pushes).toEqual([])
    })
  })
}
