import { beforeAll, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  checkIssueObjectives,
  parseIssueDocumentation,
  parseIssueParts,
  parseIssueStopConditions,
  parseIssueTestPlan
} from '@attalabs/aeg-core'
import type { NeutralCase } from '../../src/lib/dev-review-eval/neutral-case'
import { renderCase } from '../../src/lib/dev-review-eval/vinaya-renderer'
import {
  BACKEND_FLOWS,
  CURRENT_TREE_CLI,
  cloneIsolation,
  type ForgeComment,
  type ForgePullRequest,
  loadSandboxCases,
  productionWholeLoopDeps,
  runWholeLoopTrial,
  type TaskRunHandle,
  type TaskRunRequest,
  targetSandbox,
  trialIssueBody,
  WHOLE_LOOP_ADAPTERS,
  WHOLE_LOOP_BACKENDS,
  WHOLE_LOOP_GRADER_IDS,
  type WholeLoopDeps,
  type WholeLoopForge,
  type WholeLoopOptions
} from '../../src/lib/dev-review-eval/whole-loop'
import { fixtureDir } from '../lib/test-temp-fixture'

const SANDBOX = 'example-owner/whole-loop-sandbox'
const LOGIN = 'trial-bot'

function sh(cwd: string, args: string[]): string {
  const run = spawnSync('git', ['-c', 'user.name=Trial', '-c', 'user.email=trial@example.com', ...args], {
    cwd,
    encoding: 'utf8'
  })
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`)
  return run.stdout.trim()
}

/** A repository with two commits on `main`: the base a case starts from, and a later one. */
function sandboxRepository(): { bare: string; base: string; later: string } {
  const root = fixtureDir('whole-loop-sandbox')
  const source = join(root, 'source')
  mkdirSync(join(source, 'apps/cli/src/lib'), { recursive: true })
  sh(root, ['init', '-q', '-b', 'main', source])
  writeFileSync(join(source, 'apps/cli/src/lib/existing.ts'), 'export const one = 1\n')
  sh(source, ['add', '-A'])
  sh(source, ['commit', '-q', '-m', 'base'])
  const base = sh(source, ['rev-parse', 'HEAD'])
  writeFileSync(join(source, 'apps/cli/src/lib/existing.ts'), 'export const one = 2\n')
  sh(source, ['commit', '-q', '-am', 'later'])
  const later = sh(source, ['rev-parse', 'HEAD'])
  const bare = join(root, 'sandbox.git')
  sh(root, ['clone', '-q', '--bare', source, bare])
  sh(bare, ['branch', 'upstream-main', later])
  return { bare, base, later }
}

interface FakePullRequest {
  number: number
  branch: string
  head: string
  body: string
  state: string
  comments: ForgeComment[]
  rollup: ForgePullRequest['statusCheckRollup']
}

/** The forge, over a local bare repository: every write is logged with the repository it names. */
class FakeForge implements WholeLoopForge {
  writes: { op: string; repo: string }[] = []
  visibility = 'PRIVATE'
  permission = 'ADMIN'
  open = { issues: [] as number[], pullRequests: [] as number[] }
  holdsBase = true
  issues = new Map<number, { body: string; comments: ForgeComment[]; state: string }>()
  pullRequests: FakePullRequest[] = []
  private next = 1

  constructor(readonly bare: string) {}

  private write(op: string, repo: string) {
    this.writes.push({ op, repo })
  }

  repository(repo: string) {
    return repo === SANDBOX
      ? { nameWithOwner: SANDBOX, visibility: this.visibility, viewerPermission: this.permission }
      : null
  }
  login() {
    return LOGIN
  }
  openItems() {
    return this.open
  }
  commitExists() {
    return this.holdsBase
  }
  moveMain(repo: string, commit: string) {
    this.write('move-main', repo)
    sh(this.bare, ['update-ref', 'refs/heads/main', commit])
  }
  createIssue(repo: string, _title: string, body: string) {
    this.write('create-issue', repo)
    const number = this.next++
    this.issues.set(number, { body, comments: [], state: 'OPEN' })
    return number
  }
  issueComments(_repo: string, issue: number) {
    return [...(this.issues.get(issue)?.comments ?? [])]
  }
  pullRequestFor(_repo: string, branch: string): ForgePullRequest | null {
    const pr = this.pullRequests.filter((p) => p.branch === branch).at(-1)
    if (pr === undefined) return null
    return {
      number: pr.number,
      state: pr.state,
      headRefOid: pr.head,
      statusCheckRollup: pr.rollup,
      reviews: [],
      body: pr.body,
      comments: [...pr.comments]
    }
  }
  closePullRequest(repo: string, number: number) {
    this.write('close-pull-request', repo)
    const pr = this.pullRequests.find((p) => p.number === number)
    if (pr) pr.state = 'CLOSED'
  }
  closeIssue(repo: string, issue: number) {
    this.write('close-issue', repo)
    const found = this.issues.get(issue)
    if (found) found.state = 'CLOSED'
  }

  // The writes the task run makes.
  openPullRequest(repo: string, branch: string, head: string, body: string) {
    this.write('open-pull-request', repo)
    const pr: FakePullRequest = {
      number: this.next++,
      branch,
      head,
      body,
      state: 'OPEN',
      comments: [],
      rollup: [{ name: 'vinaya-checks', status: 'COMPLETED', conclusion: 'SUCCESS' }]
    }
    this.pullRequests.push(pr)
    return pr
  }
  comment(repo: string, target: { comments: ForgeComment[] }, body: string) {
    this.write('comment', repo)
    target.comments.push({
      body,
      url: `https://forge.example/${repo}/comment/${this.next++}`,
      author: { login: LOGIN }
    })
  }
}

type RunShape = 'passing' | 'stopped'

/** What one fake run does: the Developer's commit and push, the pull request, both reviews and the loop's markers. */
function fakeTaskRun(forge: FakeForge, shape: RunShape, flow: string, seen: TaskRunRequest[]) {
  return (request: TaskRunRequest): TaskRunHandle => {
    seen.push(request)
    const repo = request.env.GH_REPO as string
    const issue = Number(request.argv[request.argv.indexOf('--issue') + 1])
    const branch = `task/issue-${issue}`
    const issueRecord = forge.issues.get(issue)
    if (issueRecord === undefined) throw new Error('the run started on no trial Issue')
    const briefHash = 'b'.repeat(64)
    forge.comment(repo, issueRecord, `Brief hash: ${briefHash}\n${issueRecord.body}`)

    const clone = request.cwd
    const base = sh(clone, ['rev-parse', 'main'])
    sh(clone, ['checkout', '-q', '-b', branch])
    writeFileSync(join(clone, 'apps/cli/src/lib/existing.ts'), 'export const one = 3\n')
    sh(clone, ['commit', '-q', '-am', 'Feat(cli): The trial change'])
    const head = sh(clone, ['rev-parse', 'HEAD'])
    sh(clone, ['push', '-q', 'origin', branch])

    const evidence =
      flow === 'v2'
        ? '<!-- AEG:EVIDENCE:START -->\nNo local tests ran.\n<!-- AEG:EVIDENCE:END -->'
        : '<!-- AEG:EVIDENCE:START -->\nbun test passed\n<!-- AEG:EVIDENCE:END -->'
    const pr = forge.openPullRequest(
      repo,
      branch,
      head,
      `Closes #${issue}\n\n<!-- AEG:BEYOND-SURFACE:START -->\n<!-- AEG:BEYOND-SURFACE:END -->\n\n${evidence}\n`
    )
    forge.comment(repo, pr, '<!-- aeg:developer:round-1 -->')
    const binding = `Judged head: ${head}\nJudged base: ${base}\nBrief hash: ${briefHash}`
    if (shape === 'passing') {
      forge.comment(repo, pr, `VERDICT: APPROVE\n${binding}`)
      forge.comment(repo, pr, `VERDICT: PASS\n${binding}`)
      forge.comment(repo, pr, `<!-- aeg:loop:published head=${head} confidence=1:90 -->`)
    } else {
      forge.comment(
        repo,
        pr,
        `VERDICT: REQUEST CHANGES\n${binding}\n\nFINDINGS\n- BLOCKER|apps/cli/src/lib/existing.ts:1|wrong`
      )
      forge.comment(repo, pr, `VERDICT: PASS\n${binding}`)
      forge.comment(repo, pr, '<!-- aeg:loop:paused:max_rounds -->')
    }

    const logs = join(request.env.VINAYA_RUNTIME_DIR as string, 'logs', 'sandbox')
    mkdirSync(logs, { recursive: true })
    const usage = JSON.stringify({ kind: 'dispatch', event: 'outcome_received', usage: { input: 100, output: 20 } })
    writeFileSync(join(logs, `${issue}.ndjson`), `${usage}\n${usage}\n`)

    let stop: (code: number) => void = () => {}
    const exited =
      shape === 'passing' ? Promise.resolve(0) : new Promise<number>((done) => (stop = (code) => done(code)))
    return {
      exited,
      async stop() {
        stop(143)
        await exited
      }
    }
  }
}

let repository: ReturnType<typeof sandboxRepository>
let developmentCase: NeutralCase

beforeAll(async () => {
  repository = sandboxRepository()
  const [first] = await loadSandboxCases('development', undefined, SANDBOX)
  if (first === undefined) throw new Error('no development case')
  developmentCase = {
    ...first,
    baseRevision: repository.base,
    authorizedScope: { in: ['apps/cli/src/lib'], excluded: [], protected: [] }
  } as NeutralCase
})

function harness(input: { shape?: RunShape; flow?: string; loadCases?: WholeLoopDeps['loadCases'] } = {}) {
  const forge = new FakeForge(repository.bare)
  sh(repository.bare, ['update-ref', 'refs/heads/main', repository.later])
  // Each harness is a fresh forge whose Issue numbers start again, so an earlier test's trial branch goes.
  for (const ref of sh(repository.bare, ['for-each-ref', '--format=%(refname)', 'refs/heads/task']).split('\n')) {
    if (ref !== '') sh(repository.bare, ['update-ref', '-d', ref])
  }
  const started: TaskRunRequest[] = []
  const logged: string[] = []
  const hiddenRuns: string[] = []
  const deps: WholeLoopDeps = {
    forge,
    remoteUrl: (repo) => {
      if (repo !== SANDBOX) throw new Error(`no remote for ${repo}`)
      return `file://${repository.bare}`
    },
    freezeRecordSandbox: () => SANDBOX,
    loadCases: input.loadCases ?? (async () => [developmentCase]),
    startTaskRun: fakeTaskRun(forge, input.shape ?? 'passing', input.flow ?? 'v1', started),
    runHiddenTests: async (request) => {
      hiddenRuns.push(request.head)
      const loop = request.neutralCase as Extract<NeutralCase, { kind: 'loop' }>
      return loop.hiddenTests.map((t) => ({ path: t.path, name: t.name, result: 'pass' as const }))
    },
    workRoot: () => fixtureDir('whole-loop-trial'),
    now: () => Date.now(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    log: (line) => logged.push(line)
  }
  return { forge, deps, started, logged, hiddenRuns }
}

function options(overrides: Partial<WholeLoopOptions> = {}): WholeLoopOptions {
  return {
    caseId: developmentCase.id,
    split: 'development',
    backend: 'standalone',
    flow: 'v1',
    adapter: 'claude-code',
    attempt: 1,
    sandbox: SANDBOX,
    resultPath: join(fixtureDir('whole-loop-result'), 'result.json'),
    pollMs: 5,
    checksSettleMs: 0,
    ...overrides
  }
}

const COMBINATIONS = WHOLE_LOOP_BACKENDS.flatMap((backend) =>
  BACKEND_FLOWS[backend].flatMap((flow) => WHOLE_LOOP_ADAPTERS.map((adapter) => ({ backend, flow, adapter })))
)

describe('a whole-loop trial, end to end against a fake forge, repository and task run', () => {
  it('covers each backend with each flow it accepts, and each adapter', () =>
    expect(COMBINATIONS.map((c) => `${c.backend}/${c.flow}/${c.adapter}`)).toEqual([
      'standalone/v1/claude-code',
      'standalone/v1/codex',
      'engine/v1/claude-code',
      'engine/v1/codex',
      'engine/v2/claude-code',
      'engine/v2/codex'
    ]))

  for (const { backend, flow, adapter } of COMBINATIONS) {
    it(`grades a passing run on ${backend} ${flow} ${adapter}`, async () => {
      const { forge, deps, started, hiddenRuns } = harness({ flow })
      const opts = options({ backend, flow, adapter })
      const outcome = await runWholeLoopTrial(opts, deps)
      if (!outcome.ok) throw new Error(outcome.refusal.detail)
      const result = outcome.result
      expect(Object.keys(result.verdicts)).toEqual([...WHOLE_LOOP_GRADER_IDS])
      for (const id of WHOLE_LOOP_GRADER_IDS) expect(result.verdicts[id]).toEqual({ verdict: 'pass' })
      expect(result).toMatchObject({
        caseId: developmentCase.id,
        split: 'development',
        backend,
        flow,
        adapter,
        attempt: 1,
        passed: true,
        end: { kind: 'ready-for-merge' },
        readyGate: flow === 'v2' ? 'no-local-tests' : 'local-tests',
        rounds: 1,
        tokens: { input: 200, output: 40 },
        sandbox: { repository: SANDBOX }
      })
      expect(result.wallTimeMs).toBeGreaterThanOrEqual(0)
      expect(JSON.parse(readFileSync(opts.resultPath, 'utf8'))).toEqual(result)

      const [run] = started
      expect(started).toHaveLength(1)
      expect(run?.cli).toBe(resolve(import.meta.dir, '../../src/index.ts'))
      expect(run?.cli).toBe(CURRENT_TREE_CLI)
      expect(run?.argv).toEqual([
        'task',
        'run',
        '--issue',
        String(result.sandbox.issue),
        '--agent',
        adapter === 'claude-code' ? 'claude' : 'codex',
        '--runner',
        backend === 'engine' ? 'atta-engine' : 'standalone',
        '--flow',
        flow
      ])
      // The hidden tests ran on the final head.
      const pr = forge.pullRequests.at(-1) as FakePullRequest
      expect(hiddenRuns).toEqual([pr.head])
      // The trial's pull request and Issue are closed, unmerged.
      expect(pr.state).toBe('CLOSED')
      expect(forge.issues.get(result.sandbox.issue)?.state).toBe('CLOSED')
    })

    it(`grades a run that stops before ready-for-merge on ${backend} ${flow} ${adapter}`, async () => {
      const { forge, deps } = harness({ shape: 'stopped', flow })
      const outcome = await runWholeLoopTrial(options({ backend, flow, adapter }), deps)
      if (!outcome.ok) throw new Error(outcome.refusal.detail)
      const result = outcome.result
      expect(result.end).toEqual({ kind: 'paused', reason: 'max_rounds' })
      expect(result.passed).toBe(false)
      expect(result.readyGate).toBe('not-reached')
      expect(result.verdicts['generic-decision-bound'].verdict).toBe('fail')
      expect(result.verdicts['generic-decision-bound'].reason).toContain('O-decision is absent')
      expect(result.verdicts['generic-change-bound']).toEqual({ verdict: 'pass' })
      expect(forge.pullRequests.at(-1)?.state).toBe('CLOSED')
      expect([...forge.issues.values()].every((i) => i.state === 'CLOSED')).toBe(true)
    })
  }
})

describe('each grader reads the forge and clone facts it judges', () => {
  it('fails only the hidden-tests grader when a hidden test fails on the final head', async () => {
    const { deps } = harness()
    deps.runHiddenTests = async (request) => {
      const loop = request.neutralCase as Extract<NeutralCase, { kind: 'loop' }>
      return loop.hiddenTests.map((t) => ({ path: t.path, name: t.name, result: 'fail' as const }))
    }
    const outcome = await runWholeLoopTrial(options(), deps)
    if (!outcome.ok) throw new Error(outcome.refusal.detail)
    const failing = Object.entries(outcome.result.verdicts).filter(([, v]) => v.verdict !== 'pass')
    expect(failing.map(([id]) => id)).toEqual(['generic-hidden-tests'])
  })

  it('records the hidden tests as unobserved, never passing, when the grading copy cannot run', async () => {
    const { deps } = harness()
    deps.runHiddenTests = async () => {
      throw new Error('no grading sandbox')
    }
    const outcome = await runWholeLoopTrial(options(), deps)
    if (!outcome.ok) throw new Error(outcome.refusal.detail)
    expect(outcome.result.verdicts['generic-hidden-tests']).toEqual({
      verdict: 'fail',
      reason: 'O-tests is unavailable'
    })
  })

  it('fails the decision when a required check on the head failed', async () => {
    const { forge, deps } = harness()
    const start = deps.startTaskRun
    deps.startTaskRun = (request) => {
      const handle = start(request)
      for (const pr of forge.pullRequests)
        pr.rollup = [{ name: 'vinaya-checks', status: 'COMPLETED', conclusion: 'FAILURE' }]
      return handle
    }
    const outcome = await runWholeLoopTrial(options(), deps)
    if (!outcome.ok) throw new Error(outcome.refusal.detail)
    expect(outcome.result.verdicts['generic-decision-bound'].reason).toContain('required check vinaya-checks is fail')
    expect(outcome.result.passed).toBe(false)
  })
})

describe('nothing a trial does writes to atta-labs/vinaya', () => {
  it('starts the task run in the clone with AEG_REPO and GH_REPO naming the sandbox, and a fresh runtime directory', async () => {
    const { deps, started } = harness()
    const outcome = await runWholeLoopTrial(options(), deps)
    expect(outcome.ok).toBe(true)
    const [run] = started
    expect(run?.env.AEG_REPO).toBe(SANDBOX)
    expect(run?.env.GH_REPO).toBe(SANDBOX)
    expect(run?.env.VINAYA_LOG_FOLDER_ONLY).toBe('1')
    expect(dirname(run?.env.VINAYA_RUNTIME_DIR as string)).toBe(dirname(run?.cwd as string))
    expect(run?.cwd.endsWith('/clone')).toBe(true)
  })

  it('names the sandbox in every forge write the runner and the task run it starts make', async () => {
    for (const shape of ['passing', 'stopped'] as const) {
      const { forge, deps } = harness({ shape })
      await runWholeLoopTrial(options(), deps)
      expect(forge.writes.length).toBeGreaterThan(5)
      expect(forge.writes.filter((w) => w.repo !== SANDBOX)).toEqual([])
      expect(new Set(forge.writes.map((w) => w.op))).toEqual(
        new Set(['move-main', 'create-issue', 'comment', 'open-pull-request', 'close-pull-request', 'close-issue'])
      )
    }
  })

  it('refuses a run whose target repository is atta-labs/vinaya, writing nothing', async () => {
    for (const sandbox of ['atta-labs/vinaya', 'Atta-Labs/Vinaya']) {
      const { forge, deps, started } = harness()
      const outcome = await runWholeLoopTrial(options({ sandbox }), deps)
      expect(outcome).toMatchObject({ ok: false, refusal: { code: 'protected_repository' } })
      expect(forge.writes).toEqual([])
      expect(started).toEqual([])
    }
  })
})

describe('the runner refuses to start, writing nothing', () => {
  const refusals: [string, (forge: FakeForge) => Partial<WholeLoopOptions>, string][] = [
    ['a sandbox the freeze record does not name', () => ({ sandbox: 'example-owner/another' }), 'wrong_sandbox'],
    [
      'a public sandbox',
      (forge) => {
        forge.visibility = 'PUBLIC'
        return {}
      },
      'sandbox_public'
    ],
    [
      'a login that cannot write to the sandbox',
      (forge) => {
        forge.permission = 'READ'
        return {}
      },
      'no_write_login'
    ],
    [
      'an open Issue from an earlier trial',
      (forge) => {
        forge.open = { issues: [7], pullRequests: [] }
        return {}
      },
      'open_trial'
    ],
    [
      'an open pull request from an earlier trial',
      (forge) => {
        forge.open = { issues: [], pullRequests: [8] }
        return {}
      },
      'open_trial'
    ],
    ['v2 on the standalone backend', () => ({ backend: 'standalone', flow: 'v2' }), 'bad_option'],
    [
      'a sandbox without the base commit',
      (forge) => {
        forge.holdsBase = false
        return {}
      },
      'base_commit_missing'
    ]
  ]
  for (const [name, arrange, code] of refusals) {
    it(`refuses ${name}`, async () => {
      const { forge, deps, started } = harness()
      const outcome = await runWholeLoopTrial(options(arrange(forge)), deps)
      expect(outcome).toMatchObject({ ok: false, refusal: { code } })
      expect(forge.writes).toEqual([])
      expect(started).toEqual([])
    })
  }

  it('names the standalone v1-only rule in the v2 refusal', async () => {
    const { deps } = harness()
    const outcome = await runWholeLoopTrial(options({ backend: 'standalone', flow: 'v2' }), deps)
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { detail: expect.stringContaining('standalone backend runs v1') }
    })
  })
})

describe("the trial clone holds only the base commit's history", () => {
  function clone(): string {
    const dir = join(fixtureDir('whole-loop-clone'), 'clone')
    sh(dirname(dir), [
      'clone',
      '-q',
      '--single-branch',
      '--branch',
      'main',
      '--no-tags',
      `file://${repository.bare}`,
      dir
    ])
    return dir
  }

  it('accepts a single-branch clone of main at the base commit', () => {
    sh(repository.bare, ['update-ref', 'refs/heads/main', repository.base])
    expect(cloneIsolation(clone(), repository.base)).toBeNull()
  })

  it('refuses a clone to which an upstream-main branch is added', () => {
    sh(repository.bare, ['update-ref', 'refs/heads/main', repository.base])
    const dir = clone()
    sh(dir, ['fetch', '-q', 'origin', `${repository.later}:refs/heads/upstream-main`])
    expect(cloneIsolation(dir, repository.base)).toContain('refs/heads/upstream-main')
  })

  it("refuses a clone holding a commit outside the base commit's history, or missing the base commit", () => {
    sh(repository.bare, ['update-ref', 'refs/heads/main', repository.later])
    const dir = clone()
    expect(cloneIsolation(dir, repository.base)).toContain("outside the base commit's history")
    expect(cloneIsolation(dir, 'f'.repeat(40))).toContain('does not contain the base commit')
  })

  it('refuses the trial when the clone it makes after moving main does not hold the base commit', async () => {
    const { forge, deps, started } = harness()
    deps.loadCases = async () => [{ ...developmentCase, baseRevision: 'f'.repeat(40) } as NeutralCase]
    forge.moveMain = (repo) => {
      forge.writes.push({ op: 'move-main', repo })
    }
    const outcome = await runWholeLoopTrial(options(), deps)
    expect(outcome).toMatchObject({ ok: false, refusal: { code: 'clone_not_isolated' } })
    // The clone is made after `main` moves, so the move is the one write; no Issue, pull request or run follows.
    expect(forge.writes).toEqual([{ op: 'move-main', repo: SANDBOX }])
    expect(started).toEqual([])
  })
})

describe('held-out cases', () => {
  it('never runs a held-out case without the held-out approval', async () => {
    const { forge, deps, started } = harness()
    const missing = await runWholeLoopTrial(options({ split: 'held-out' }), deps)
    expect(missing).toMatchObject({ ok: false, refusal: { code: 'held_out_unapproved' } })
    deps.loadCases = (split, approval, sandbox) => loadSandboxCases(split, approval, sandbox)
    const wrong = await runWholeLoopTrial(options({ split: 'held-out', heldOutApproval: '0'.repeat(64) }), deps)
    expect(wrong).toMatchObject({ ok: false, refusal: { code: 'held_out_unapproved' } })
    expect(forge.writes).toEqual([])
    expect(started).toEqual([])
  })

  it('prints a held-out case by its id alone, and writes no verdict reason', async () => {
    const { deps, logged } = harness({ shape: 'stopped' })
    const outcome = await runWholeLoopTrial(options({ split: 'held-out', heldOutApproval: 'approved' }), deps)
    if (!outcome.ok) throw new Error(outcome.refusal.detail)
    expect(outcome.result.verdicts['generic-decision-bound']).toEqual({ verdict: 'fail' })
    for (const verdict of Object.values(outcome.result.verdicts)) expect('reason' in verdict).toBe(false)
    const text = `${logged.join('\n')}\n${JSON.stringify(outcome.result)}`
    const loop = developmentCase as Extract<NeutralCase, { kind: 'loop' }>
    expect(text).toContain(developmentCase.id)
    expect(text).not.toContain(loop.taskStatement)
    for (const test of loop.hiddenTests) expect(text).not.toContain(test.name)
  })
})

describe('loaded cases target the sandbox', () => {
  it('sets every loaded case repository to the sandbox, though the committed cases name their own', async () => {
    const committed = JSON.parse(readFileSync(join(import.meta.dir, 'whole-loop-generic-cases.json'), 'utf8')) as {
      suites: { cases: { repository: string }[] }[]
    }
    expect(new Set(committed.suites.flatMap((s) => s.cases.map((c) => c.repository)))).toEqual(
      new Set(['atta-labs/vinaya'])
    )
    const loaded = await loadSandboxCases('development', undefined, SANDBOX)
    expect(loaded.length).toBeGreaterThan(0)
    for (const c of loaded) expect(c.repository).toBe(SANDBOX)
  })

  it('refuses a loaded case whose repository is not the sandbox, writing nothing', async () => {
    const { forge, deps } = harness({ loadCases: async () => [targetSandbox(developmentCase, 'atta-labs/vinaya')] })
    const outcome = await runWholeLoopTrial(options(), deps)
    expect(outcome).toMatchObject({ ok: false, refusal: { code: 'case_not_in_sandbox' } })
    expect(forge.writes).toEqual([])
  })

  it('reads the sandbox the committed freeze record names', () =>
    expect(productionWholeLoopDeps().freezeRecordSandbox()).toBe('atta-labs/vinaya-whole-loop-sandbox'))
})

describe('the trial Issue body passes the Issue grammar', () => {
  it('for every development case', async () => {
    const cases = await loadSandboxCases('development', undefined, SANDBOX)
    for (const c of cases) {
      const rendered = renderCase(c)
      if (!rendered.ok) throw new Error(`${c.id}: ${rendered.refusal.field}`)
      const body = trialIssueBody(rendered.input)
      const failures = [
        ['objectives', checkIssueObjectives(body, null, null).status === 'pass'],
        ['documentation', parseIssueDocumentation(body).ok],
        ['parts', parseIssueParts(body).ok],
        ['test plan', parseIssueTestPlan(body).ok],
        ['stop conditions', parseIssueStopConditions(body).ok]
      ].filter(([, ok]) => !ok)
      expect({ id: c.id, failures }).toEqual({ id: c.id, failures: [] })
      expect(body.startsWith(rendered.input.brief.split('\n')[0] as string)).toBe(true)
      expect(body).toContain('**Tier:** 1')
      expect(body).toContain('**Project:** cli')
      const documentation = parseIssueDocumentation(body)
      const required = rendered.input.sources.filter((s) => s.required).map((s) => s.sourceId)
      if (documentation.ok && documentation.value.kind === 'sources') {
        expect(documentation.value.sources.map((s) => s.source)).toEqual(required)
      } else {
        expect(required).toEqual([])
      }
    }
  })
})
