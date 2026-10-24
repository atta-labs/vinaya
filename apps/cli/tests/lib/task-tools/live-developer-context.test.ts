import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { failedCheckLogsOnHead } from '../../../src/lib/dev-review-loop'
import {
  attributeDriverToolCalls,
  commitAndPushPrompt,
  createLiveDeveloperContext,
  createLivePublicationState,
  defaultPushTaskBranch,
  type LiveDeveloperContextParams,
  mergeInProgress,
  publishDeveloperTurn,
  pushedCommitRangeBase
} from '../../../src/lib/task-tools/live-developer-context'
import {
  BASE,
  BRANCH,
  brokerPush,
  fakeDeps,
  makeWorld,
  OUTSIDE,
  OWN,
  WORKFLOW,
  type World
} from './live-developer-context-world'

const HEADER = 'Fix(cli): Share live context'

let runtimeRoot: string
beforeEach(() => {
  runtimeRoot = mkdtempSync(join(tmpdir(), 'live-developer-context-'))
})
afterEach(() => {
  rmSync(runtimeRoot, { recursive: true, force: true })
})

function paramsFor(
  world: World,
  state = createLivePublicationState(BASE),
  deps = fakeDeps(world)
): LiveDeveloperContextParams {
  return {
    d: deps,
    task: 8,
    branch: BRANCH,
    repo: null,
    worktree: '/worktree',
    runtimeRoot,
    loopLogPath: join(runtimeRoot, 'driver.log'),
    state,
    agent: 'claude',
    round: () => 1,
    helpers: {
      ownChangesRangeBase: (_worktree, base) => base,
      defaultGitWorktreeUntrackedPaths: () => [],
      worktreeCheckEnv: (input) => ({ BRANCH: input.branch })
    }
  }
}

const PR_BODY = '## Report\n\nbody'

describe('publication preconditions on the shared live context', () => {
  test('a worktree on another branch is refused before any commit or push', async () => {
    const world = makeWorld({ branch: 'wrong' })
    const state = createLivePublicationState(BASE)
    state.turnPreHead = world.head
    const result = await createLiveDeveloperContext(paramsFor(world, state)).publishChanges(HEADER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.output).toContain('not the task branch')
    expect(world.commits).toEqual([])
    expect(world.pushes).toEqual([])
  })

  test('a head that moved off the recorded pre-turn head is refused', async () => {
    const world = makeWorld({ head: 'moved' })
    const state = createLivePublicationState(BASE)
    state.turnPreHead = 'head-0'
    const result = await createLiveDeveloperContext(paramsFor(world, state)).publishChanges(HEADER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.output).toContain('head moved')
    expect(world.commits).toEqual([])
    expect(world.pushes).toEqual([])
  })

  test('the same head against the recorded head publishes, and a repeat publish makes no second commit', async () => {
    const world = makeWorld()
    const state = createLivePublicationState(BASE)
    state.turnPreHead = world.head
    const context = createLiveDeveloperContext(paramsFor(world, state))
    const first = await context.publishChanges(HEADER)
    expect(first).toMatchObject({ ok: true, result: { pushedHead: 'commit-1' } })
    // A second call in the same turn finds a clean worktree at the remote's head: it commits and pushes nothing.
    const second = await context.publishChanges(HEADER)
    expect(second).toMatchObject({ ok: true, result: { pushedHead: 'commit-1' } })
    expect(world.commits).toEqual([HEADER])
    expect(world.pushes).toHaveLength(1)
    expect(state.turnPreHead).toBe('commit-1')
  })

  test('a path beyond the Surface is recorded in the pull request body, never refused', async () => {
    const world = makeWorld({ changed: [OWN, OUTSIDE] })
    const state = createLivePublicationState(BASE)
    state.turnPreHead = world.head
    const context = createLiveDeveloperContext(paramsFor(world, state))
    const published = await context.publishChanges(HEADER)
    expect(published.ok).toBe(true)
    expect(world.pushes).toHaveLength(1)
    const opened = await context.openPullRequest('[t] 8 — Title', PR_BODY)
    expect(opened).toEqual({ ok: true, result: { prNumber: 7 } })
    expect(world.opened).toHaveLength(1)
    const body = world.opened[0]?.body ?? ''
    expect(body).toContain('AEG:BEYOND-SURFACE')
    expect(body).toContain(OUTSIDE)
    expect(body).not.toContain(OWN)
  })

  test('a push that moves the branch rewrites the open pull request body with the beyond-Surface record', async () => {
    const world = makeWorld({ changed: [OWN, OUTSIDE], pr: { number: 7 }, prBody: PR_BODY })
    const state = createLivePublicationState(BASE)
    state.turnPreHead = world.head
    const result = await createLiveDeveloperContext(paramsFor(world, state)).publishChanges(HEADER)
    expect(result.ok).toBe(true)
    expect(world.bodyWrites).toHaveLength(1)
    expect(world.bodyWrites[0]).toContain(OUTSIDE)
  })
})

describe('the pushed commit range', () => {
  test('is the remote head when the branch has one, else the recorded base', () => {
    expect(pushedCommitRangeBase('remote', 'base')).toBe('remote')
    expect(pushedCommitRangeBase(null, 'base')).toBe('base')
  })

  test('authorizes exactly the commits after the remote head', async () => {
    const world = makeWorld({ remote: 'remote-1', head: 'remote-1', changed: [OWN] })
    const state = createLivePublicationState(BASE)
    state.turnPreHead = world.head
    await createLiveDeveloperContext(paramsFor(world, state)).publishChanges(HEADER)
    // The changed paths the push is authorized for are measured from the remote head, not the older base.
    expect(world.rangeBases.every((base) => base === 'remote-1')).toBe(true)
    expect(world.pushes).toHaveLength(1)
    expect(world.pushes[0]?.touchedPaths).toEqual([OWN])
    expect(world.pushes[0]?.sha).toBe('commit-1')
  })

  test('falls back to the recorded base for a branch with no remote head', async () => {
    const world = makeWorld({ remote: null })
    const state = createLivePublicationState(BASE)
    state.turnPreHead = world.head
    await createLiveDeveloperContext(paramsFor(world, state)).publishChanges(HEADER)
    expect(world.rangeBases.every((base) => base === BASE)).toBe(true)
    expect(world.pushes).toHaveLength(1)
  })
})

describe('write attribution', () => {
  test('wraps exactly the calls that write driver-owned records', async () => {
    const attributed: string[] = []
    const calls: string[] = []
    const record = <T>(name: string, result: T): T => {
      calls.push(name)
      return result
    }
    const inner = {
      publishChanges: async () => record('publish_changes', { ok: true as const, result: { pushedHead: 'h' } }),
      openPullRequest: async () => record('open_pull_request', { ok: true as const, result: { prNumber: 1 } }),
      updatePullRequestBody: async () =>
        record('update_pull_request_body', { ok: true as const, result: { prNumber: 1 } }),
      refreshEvidence: async () =>
        record('refresh_evidence', { ok: true as const, result: { head: 'h', checksPassed: true, evidence: '' } }),
      readPullRequest: async () => record('read_pull_request', { ok: true as const, result: {} as never }),
      runChecks: async () => record('run_checks', { ok: true as const, result: { passed: true, output: '' } }),
      fetchDocumentation: async () => record('fetch_documentation', { ok: true as const, result: {} as never })
    }
    const context = attributeDriverToolCalls(inner, async (call) => {
      attributed.push(calls.length === 0 ? 'before' : (calls[calls.length - 1] ?? ''))
      const result = await call()
      attributed.push(calls[calls.length - 1] ?? '')
      return result
    })
    await context.publishChanges('x')
    await context.openPullRequest('t', 'b')
    await context.updatePullRequestBody('b')
    await context.refreshEvidence()
    await context.fetchDocumentation({ url: 'https://example.com' })
    const wrapped = attributed.length
    await context.readPullRequest()
    await context.runChecks()
    expect(attributed).toHaveLength(wrapped)
    expect(calls).toEqual([
      'publish_changes',
      'open_pull_request',
      'update_pull_request_body',
      'refresh_evidence',
      'fetch_documentation',
      'read_pull_request',
      'run_checks'
    ])
    // Five calls each passed through the attribution (one entry before the call, one after).
    expect(wrapped).toBe(10)
  })
})

describe('the Broker refuses a protected path the Surface does not name', () => {
  const push = brokerPush(() => runtimeRoot)

  test('a workflow file outside the Surface leaves the work committed and unpushed', async () => {
    const world = makeWorld({ changed: [OWN, WORKFLOW] })
    world.push = push
    const state = createLivePublicationState(BASE)
    state.turnPreHead = world.head
    const result = await createLiveDeveloperContext(paramsFor(world, state)).publishChanges(HEADER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.output).toContain('protected administrative policy path')
    expect(world.commits).toEqual([HEADER])
    expect(world.remote).toBe('head-0')
  })

  test('the same file inside the Surface is pushed', async () => {
    const world = makeWorld({ changed: [WORKFLOW], surface: { in: ['.github/**'], out: [] } })
    world.push = push
    const state = createLivePublicationState(BASE)
    state.turnPreHead = world.head
    const result = await createLiveDeveloperContext(paramsFor(world, state)).publishChanges(HEADER)
    expect(result).toMatchObject({ ok: true, result: { pushedHead: 'commit-1' } })
    expect(world.remote).toBe('commit-1')
  })
})

describe('a refused push', () => {
  test('leaves the work committed and unpushed, and the refusal is quoted in the next prompt', async () => {
    const world = makeWorld()
    world.pushResults.push({ ok: false, refusal: '(fail) tests/a.test.ts > breaks', hook: true })
    const state = createLivePublicationState(BASE)
    state.turnPreHead = world.head
    const context = createLiveDeveloperContext(paramsFor(world, state))
    const refused = await context.publishChanges(HEADER)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.output).toContain('(fail) tests/a.test.ts > breaks')
    // Committed, not pushed.
    expect(world.commits).toEqual([HEADER])
    expect(world.remote).toBe('head-0')
    expect(world.head).toBe('commit-1')
    expect(state.lastPushRefusal).toBe('(fail) tests/a.test.ts > breaks')
    expect(state.turnPublicationAttempted).toBe(true)
    expect(state.turnPublicationRefusal).toContain('pre-push-hook')
    const prompt = commitAndPushPrompt(state.lastPushRefusal, 'Publish through the tools.')
    expect(prompt).toContain('(fail) tests/a.test.ts > breaks')
    expect(prompt).toContain('refused by the pre-push hook')

    // The retry pushes the committed work: no second commit, and the refusal is cleared.
    const retried = await context.publishChanges(HEADER)
    expect(retried).toMatchObject({ ok: true, result: { pushedHead: 'commit-1' } })
    expect(world.commits).toEqual([HEADER])
    expect(world.pushes).toHaveLength(2)
    expect(state.lastPushRefusal).toBeNull()
    expect(state.turnPublicationRefusal).toBeNull()
  })

  test('a refusal that is not the pre-push hook is raised as a failure, not quoted as a hook refusal', async () => {
    const world = makeWorld()
    world.pushResults.push({ ok: false, refusal: 'no developer launch record', hook: false })
    const state = createLivePublicationState(BASE)
    state.turnPreHead = world.head
    const result = await createLiveDeveloperContext(paramsFor(world, state)).publishChanges(HEADER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.output).toContain('outside the pre-push hook')
    expect(state.lastPushRefusal).toBeNull()
  })
})

describe('a clean worktree with an open pull request', () => {
  test('publishes nothing', async () => {
    const world = makeWorld({ dirty: [], pr: { number: 7 }, prBody: PR_BODY })
    const state = createLivePublicationState(BASE)
    state.turnPreHead = world.head
    const result = await createLiveDeveloperContext(paramsFor(world, state)).publishChanges(HEADER)
    expect(result).toMatchObject({ ok: true, result: { pushedHead: 'head-0' } })
    expect(world.commits).toEqual([])
    expect(world.pushes).toEqual([])
    expect(world.opened).toEqual([])
    const turn = publishDeveloperTurn({
      worktreePath: process.cwd(),
      branch: BRANCH,
      turnPreStop: null,
      findOpenPullRequest: () => world.pr,
      readUnpushedWork: () => ({ dirtyFiles: [], aheadCount: 0 }),
      fetchDeveloperStop: () => null,
      noPushDetail: () => 'none',
      refusal: () => {
        throw new Error('must not refuse')
      }
    })
    expect(turn).toEqual({ kind: 'nothing' })
  })

  test('a restart with the pull request open attaches without a second commit, push or open', async () => {
    const world = makeWorld({ dirty: [], pr: { number: 7 }, prBody: PR_BODY })
    // A fresh process: new publication state, a new context, the pull request already open.
    const state = createLivePublicationState(null)
    state.turnPreHead = world.head
    const context = createLiveDeveloperContext(paramsFor(world, state))
    const published = await context.publishChanges(HEADER)
    expect(published.ok).toBe(true)
    const opened = await context.openPullRequest('[t] 8 — Title', PR_BODY)
    expect(opened.ok).toBe(false)
    if (!opened.ok) {
      expect(opened.error.check).toBe('pr-exists')
      expect(opened.error.output).toContain('already open')
    }
    expect(world.commits).toEqual([])
    expect(world.pushes).toEqual([])
    expect(world.opened).toEqual([])
  })

  test('a second open of the same pull request is refused, so the invariant holds without a restart', async () => {
    const world = makeWorld()
    const state = createLivePublicationState(BASE)
    state.turnPreHead = world.head
    const context = createLiveDeveloperContext(paramsFor(world, state))
    await context.publishChanges(HEADER)
    expect((await context.openPullRequest('[t] 8 — Title', PR_BODY)).ok).toBe(true)
    const again = await context.openPullRequest('[t] 8 — Title', PR_BODY)
    expect(again.ok).toBe(false)
    expect(world.opened).toHaveLength(1)
  })
})

describe('invariants asserted on the shared context', () => {
  // INV-032: a pull request already open for the branch is never opened a second time.
  test('INV-032: the duplicate open is refused naming the open pull request', async () => {
    const world = makeWorld({ pr: { number: 7 }, prBody: PR_BODY })
    const result = await createLiveDeveloperContext(paramsFor(world)).openPullRequest('[t] 8 — Title', PR_BODY)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.output).toContain('pull request 7 is already open')
    expect(world.opened).toEqual([])
  })

  // INV-035: publishing again in one turn, and retrying a refused push, never makes a second commit.
  test('INV-035: a repeated publish and a retried push make one commit', async () => {
    const world = makeWorld()
    world.pushResults.push({ ok: false, refusal: 'hook says no', hook: true })
    const state = createLivePublicationState(BASE)
    state.turnPreHead = world.head
    const context = createLiveDeveloperContext(paramsFor(world, state))
    await context.publishChanges(HEADER)
    await context.publishChanges(HEADER)
    await context.publishChanges(HEADER)
    expect(world.commits).toHaveLength(1)
  })

  // INV-121: refresh_evidence regenerates the body for the head and records the beyond-Surface block afterwards.
  test('INV-121: refresh_evidence refreshes the open pull request and rewrites the beyond-Surface record', async () => {
    const world = makeWorld({ pr: { number: 7 }, prBody: PR_BODY, changed: [OUTSIDE] })
    const result = await createLiveDeveloperContext(paramsFor(world)).refreshEvidence()
    expect(result).toEqual({ ok: true, result: { head: 'head-0', checksPassed: true, evidence: 'evidence' } })
    expect(world.bodyWrites).toHaveLength(1)
    expect(world.bodyWrites[0]).toContain(OUTSIDE)
  })

  test('INV-121: refresh_evidence with no open pull request is refused, writing nothing', async () => {
    const world = makeWorld()
    const result = await createLiveDeveloperContext(paramsFor(world)).refreshEvidence()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.check).toBe('no-open-pr')
    expect(world.bodyWrites).toEqual([])
  })
})

describe('read_pull_request', () => {
  test('returns the job-log tail of each failed check', async () => {
    const world = makeWorld({ pr: { number: 7 } })
    const failedChecks = failedCheckLogsOnHead(
      'head-0',
      () => [
        { name: 'unit', id: 41 },
        { name: 'workflow ci', id: 99, detail: 'workflow ci run 99 ended failure' }
      ],
      (id) => (id === 41 ? 'expected 1, received 2' : null)
    )
    world.view = {
      prNumber: 7,
      state: 'OPEN',
      head: 'head-0',
      checks: [],
      reviews: [],
      body: PR_BODY,
      failedChecks
    }
    const result = await createLiveDeveloperContext(paramsFor(world)).readPullRequest()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The workflow-level failure has no job log; the job's own tail reaches the Developer.
    expect(result.result.failedChecks).toEqual([{ check: 'unit', runId: 41, logTail: 'expected 1, received 2' }])
  })
})

describe('the unpublished-turn prompt', () => {
  test('quotes the refusal and tells the Developer to fix its cause', () => {
    const prompt = commitAndPushPrompt('lint failed', 'Publish through the tools.')
    expect(prompt).toContain('lint failed')
    expect(prompt).toContain('Fix the cause of that refusal')
    expect(commitAndPushPrompt(null, 'Publish through the tools.')).not.toContain('refused by the pre-push hook')
  })
})

describe('the Broker-governed push', () => {
  // INV-037: with no launch record to authenticate against, the push is refused and nothing is pushed.
  test('INV-037: a push with no developer launch record is refused before git runs', () => {
    let pushed = false
    const result = defaultPushTaskBranch(
      {
        task: 987_654_321,
        branch: BRANCH,
        sha: 'commit-1',
        touchedPaths: [OWN],
        surface: null,
        round: 1,
        agent: 'claude',
        repo: null,
        worktreePath: '/nonexistent'
      },
      () => {
        pushed = true
      }
    )
    expect(result).toMatchObject({ ok: false, hook: false })
    if (!result.ok) expect(result.refusal).toContain('no developer launch record for task 987654321')
    expect(pushed).toBe(false)
  })
})

describe('mergeInProgress', () => {
  test('a default-branch merge resolved to the branch side still reads as in progress, and committing concludes it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-merge-probe-'))
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' })
    git('init', '-q', '-b', 'main')
    writeFileSync(join(dir, 'probe.md'), 'base\n')
    git('add', '-A')
    git('commit', '-qm', 'base')
    git('checkout', '-qb', 'task')
    writeFileSync(join(dir, 'probe.md'), 'ours\n')
    git('commit', '-qam', 'ours')
    git('checkout', '-q', 'main')
    writeFileSync(join(dir, 'probe.md'), 'theirs\n')
    git('commit', '-qam', 'theirs')
    git('checkout', '-q', 'task')
    expect(() => git('merge', '--no-commit', 'main')).toThrow()
    writeFileSync(join(dir, 'probe.md'), 'ours\n')
    git('add', '-A')
    expect(git('status', '--porcelain').trim()).toBe('')
    expect(mergeInProgress(dir)).toBe(true)
    git('commit', '-qm', 'merge main')
    expect(mergeInProgress(dir)).toBe(false)
    expect(git('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ')).toHaveLength(3)
    rmSync(dir, { recursive: true, force: true })
  })
})
