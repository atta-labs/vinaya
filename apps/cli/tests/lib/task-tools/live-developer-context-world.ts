import { defaultControlStoreDeps, type IssueSurface } from '@attalabs/aeg-core'
import { authenticateWorkerInvocation, ProtectedPathError, requestEffect, scopeTarget } from '../../../src/lib/broker'
import type { DispatchTeeRecoveryDeps } from '../../../src/lib/dispatch'
import type { LiveDeveloperContextLoopDeps } from '../../../src/lib/task-tools/live-developer-context'

export const BRANCH = 'task/t/8'
export const BASE = 'base-0'
export const OWN = 'apps/cli/src/own.ts'
export const OUTSIDE = 'docs/outside.md'
export const WORKFLOW = '.github/workflows/ci.yml'
export const SURFACE: IssueSurface = { in: ['apps/cli/**'], out: [] }

export type PushInput = Parameters<LiveDeveloperContextLoopDeps['pushTaskBranch']>[0]
export type PushResult = ReturnType<LiveDeveloperContextLoopDeps['pushTaskBranch']>

/** What the fake forge and worktree hold, and what the context did to them. */
export type World = {
  head: string
  remote: string | null
  dirty: string[]
  branch: string
  changed: string[]
  surface: IssueSurface | null
  pr: { number: number } | null
  prBody: string
  commits: string[]
  pushes: PushInput[]
  pushResults: PushResult[]
  opened: Array<{ title: string; body: string }>
  bodyWrites: string[]
  rangeBases: Array<string | null>
  view: Awaited<ReturnType<LiveDeveloperContextLoopDeps['readPrView']>>
  push?: (input: PushInput) => PushResult
}

export function makeWorld(overrides: Partial<World> = {}): World {
  return {
    head: 'head-0',
    remote: 'head-0',
    dirty: [OWN],
    branch: BRANCH,
    changed: [OWN],
    surface: SURFACE,
    pr: null,
    prBody: '',
    commits: [],
    pushes: [],
    pushResults: [],
    opened: [],
    bodyWrites: [],
    rangeBases: [],
    view: { prNumber: null, state: null, head: null, checks: null, reviews: null, body: null, failedChecks: [] },
    ...overrides
  }
}

export function fakeDeps(world: World): LiveDeveloperContextLoopDeps {
  const deps = {
    findOpenPrForBranch: () => world.pr,
    fetchIssueTitle: () => 'Task title',
    resolveHead: () => {
      if (world.remote === null) throw new Error('no head on origin')
      return world.remote
    },
    readMergedDefaultCommit: () => null,
    gitWorktreeChangedPaths: (_worktree: string, base: string) => {
      world.rangeBases.push(base)
      return world.changed
    },
    readUnpushedWorkDetail: () => ({
      dirtyFiles: world.dirty,
      aheadCount: world.head !== world.remote ? 1 : 0
    }),
    readWorktreeHead: () => world.head,
    gitMergeBase: async () => BASE,
    readDefaultBranchTip: () => null,
    gitIsAncestor: () => true,
    resolveTaskSurface: () => world.surface,
    readWorktreeBranch: () => world.branch,
    buildVendoredCliIfMissing: () => {},
    gitWorktreeDiffText: () => '',
    commitWorktree: (_worktree: string, header: string) => {
      world.commits.push(header)
      world.head = `commit-${world.commits.length}`
      world.dirty = []
      return { ok: true as const, sha: world.head }
    },
    classifyAgainstDefaultTip: () => null,
    rebaseOntoDefaultTip: () => {
      throw new Error('no rebase expected')
    },
    pushTaskBranch: (input: PushInput) => {
      world.pushes.push(input)
      const result = world.push?.(input) ?? world.pushResults.shift() ?? { ok: true as const }
      if (result.ok) world.remote = input.sha
      return result
    },
    pushTaskBranchWithLease: () => {
      throw new Error('no lease push expected')
    },
    restoreWorktreeHead: () => true,
    validatePrBodyForCreate: async () => [],
    openTaskPullRequest: (input: { title: string; body: string }) => {
      world.opened.push({ title: input.title, body: input.body })
      world.pr = { number: 7 }
      world.prBody = input.body
      return 7
    },
    fetchPrBody: () => world.prBody,
    updatePrBody: async (input: { body: string }) => {
      world.prBody = input.body
      world.bodyWrites.push(input.body)
    },
    refreshPrEvidence: async () => ({ head: world.head, checksPassed: true, evidence: 'evidence' }),
    readPrView: async () => world.view,
    runWorktreeChecks: async () => ({ passed: true, output: '' })
  }
  return deps as unknown as LiveDeveloperContextLoopDeps
}

const WORKER_DEPS: DispatchTeeRecoveryDeps = {
  env: {},
  listLaunchRecordPaths: () => ['launch-0.json'],
  readFile: () => JSON.stringify({ runId: 'run-live', role: 'developer', agent: 'claude', task: 8 })
}

/**
 * The push the standalone loop makes: the Broker's `branch-push` over the touched paths and the Surface,
 * with the Broker's own protected-path refusal returned as the push's refusal.
 */
export function brokerPush(controlRoot: () => string): (input: PushInput) => PushResult {
  const worker = authenticateWorkerInvocation(
    { VINAYA_ROLE: 'developer', VINAYA_TASK: '8', VINAYA_RUN_ID: 'run-live' },
    WORKER_DEPS
  )
  return (input) => {
    try {
      requestEffect(defaultControlStoreDeps(controlRoot), worker, {
        operation: 'branch-push',
        target: scopeTarget(input.task, `refs/heads/${input.branch}`),
        inputVersion: input.round,
        touchedPaths: input.touchedPaths,
        surfaceCoversPath: (path) =>
          input.surface?.in.some((glob) => path.startsWith(glob.replace('/**', '/'))) ?? false,
        key: `branch-push-${input.sha}`,
        payload: input.sha,
        poster: () => input.sha,
        reconcile: () => ({ outcome: 'absent' })
      })
      return { ok: true }
    } catch (err) {
      if (err instanceof ProtectedPathError) return { ok: false, refusal: err.message, hook: false }
      throw err
    }
  }
}
