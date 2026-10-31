/**
 * Two forge-reading gates against a fake `gh` that answers with GitHub's own
 * rate-limit wording. `single-plan-pr` must refuse rather than pass on an
 * empty pull-request list, naming the budget and its reset; a dependency
 * whose Issue cannot be read must be reported as unread, never as unmerged.
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { checkDispatchReadiness, type DispatchGateInput } from '@attalabs/aeg-core'
import { clearEdgeCache, dependsOnFactFromEdge, edgeFromIssueJson, resolveEdge } from '../../src/checks/edge-resolve'
import { spawnBudgetedAsync, stripVinayaEnv } from '../lib/process-fixture'

const REPO_ROOT = join(import.meta.dir, '../../../..')
const SINGLE_PLAN_BIN = join(REPO_ROOT, 'apps/cli/src/checks/bin/check-single-plan-pr.ts')
const DISPATCH_BIN = join(REPO_ROOT, 'apps/cli/src/checks/bin/check-dispatch-readiness.ts')

const GRAPHQL_RATE_LIMIT = 'GraphQL: API rate limit exceeded for user ID 1234567.'
const REST_RATE_LIMIT =
  'HTTP 403: API rate limit exceeded for user ID 1234567. (https://api.github.com/repos/atta-labs/vinaya/pulls)'
// 2026-10-18T14:05:00Z for GraphQL, 15:30 UTC for REST — distinct, so the test proves which budget was read.
const GRAPHQL_RESET = Date.UTC(2026, 9, 18, 14, 5, 0) / 1000
const CORE_RESET = Date.UTC(2026, 9, 18, 15, 30, 0) / 1000
const RATE_LIMIT_REPLY = JSON.stringify({
  resources: {
    core: { limit: 5000, remaining: 0, reset: CORE_RESET, used: 5000 },
    graphql: { limit: 5000, remaining: 0, reset: GRAPHQL_RESET, used: 5000 }
  }
})

// The default branch's `vinaya.config.json` as `gh --jq .content` prints it, so the Principal read resolves.
const PRINCIPALS_CONFIG_B64 = Buffer.from(JSON.stringify({ principals: ['fixture-principal'] })).toString('base64')

const TASK_ISSUE = 4242
const RATE_LIMITED_DEP = 77
const MISSING_DEP = 78

let dirs: string[] = []

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
  clearEdgeCache()
})

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

/** One `case "$*"` arm per call: a glob pattern, then what `gh` prints and its exit code. */
type FakeCall = { pattern: string; stdout?: string; stderr?: string; exit: number }

function quote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

function fakeGh(calls: FakeCall[]): string {
  const binDir = tempDir('rate-limit-fake-gh-')
  const arms = calls
    .map((c) => {
      const out = c.stdout === undefined ? '' : `printf '%s' ${quote(c.stdout)}; `
      const err = c.stderr === undefined ? '' : `printf '%s\\n' ${quote(c.stderr)} >&2; `
      return `  ${c.pattern}) ${out}${err}exit ${c.exit} ;;`
    })
    .join('\n')
  writeFileSync(
    join(binDir, 'gh'),
    `#!/bin/sh\ncase "$*" in\n${arms}\n  *) echo "unhandled fake gh call: $*" >&2; exit 1 ;;\nesac\n`
  )
  chmodSync(join(binDir, 'gh'), 0o755)
  return binDir
}

/** The parent's environment minus every `VINAYA_*` and `GIT_*` variable a running driver or hook may export, plus `gh` on `PATH`. */
function childEnv(binDir: string, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(stripVinayaEnv())) {
    if (v !== undefined && !k.startsWith('GIT_')) env[k] = v
  }
  return { ...env, PATH: `${binDir}:${process.env.PATH}`, ...extra }
}

async function runBin(
  bin: string,
  cwd: string,
  env: Record<string, string>
): Promise<{ exitCode: number; errors: Array<{ check: string; message: string; agent_recovery_prompt: string }> }> {
  const { status: exitCode, stderr } = await spawnBudgetedAsync(['bun', bin], { cwd, env })
  const errors = stderr
    .split('\n')
    .filter((l) => l.trimStart().startsWith('{'))
    .map((l) => JSON.parse(l))
  return { exitCode, errors }
}

/** A repository whose `BASE_SHA...HEAD` diff touches a tranche plan file — the only diff the check reads the forge for. */
function planDiffRepo(): { dir: string; base: string } {
  const dir = tempDir('single-plan-pr-repo-')
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'core.hooksPath=/dev/null',
        ...args
      ],
      { cwd: dir, encoding: 'utf8', env: childEnv('', {}) }
    ).trim()
  git('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), 'fixture\n')
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  const base = git('rev-parse', 'HEAD')
  mkdirSync(join(dir, 'aeg-root', 'tranches'), { recursive: true })
  writeFileSync(join(dir, 'aeg-root', 'tranches', 'fixture-tranche.md'), '# fixture tranche\n')
  git('add', '.')
  git('commit', '-q', '-m', 'plan')
  return { dir, base }
}

describe('single-plan-pr: a rate-limited open pull request read fails, never passes', () => {
  it('names the GraphQL budget and its reset time', async () => {
    const { dir, base } = planDiffRepo()
    const binDir = fakeGh([
      { pattern: '"pr list "*', stderr: GRAPHQL_RATE_LIMIT, exit: 1 },
      { pattern: '"api rate_limit"', stdout: RATE_LIMIT_REPLY, exit: 0 }
    ])
    const result = await runBin(SINGLE_PLAN_BIN, dir, childEnv(binDir, { BASE_SHA: base }))
    expect(result.exitCode).not.toBe(0)
    expect(result.errors[0]?.check).toBe('single-plan-pr')
    expect(result.errors[0]?.message).toContain('GitHub rate limit (GraphQL), resets at 14:05 UTC')
  })

  it('names the REST budget and its own reset when the error is not a GraphQL one', async () => {
    const { dir, base } = planDiffRepo()
    const binDir = fakeGh([
      { pattern: '"pr list "*', stderr: REST_RATE_LIMIT, exit: 1 },
      { pattern: '"api rate_limit"', stdout: RATE_LIMIT_REPLY, exit: 0 }
    ])
    const result = await runBin(SINGLE_PLAN_BIN, dir, childEnv(binDir, { BASE_SHA: base }))
    expect(result.exitCode).not.toBe(0)
    expect(result.errors[0]?.message).toContain('GitHub rate limit (REST), resets at 15:30 UTC')
  })

  it('says "resets in a few minutes" when no reset is reported', async () => {
    const { dir, base } = planDiffRepo()
    const binDir = fakeGh([
      { pattern: '"pr list "*', stderr: 'GraphQL: You have exceeded a secondary rate limit.', exit: 1 },
      { pattern: '"api rate_limit"', stdout: RATE_LIMIT_REPLY, exit: 0 }
    ])
    const result = await runBin(SINGLE_PLAN_BIN, dir, childEnv(binDir, { BASE_SHA: base }))
    expect(result.exitCode).not.toBe(0)
    expect(result.errors[0]?.message).toContain('GitHub rate limit (GraphQL), resets in a few minutes')
  })

  it('a failed read that is not a rate limit still degrades to "no other open PRs known"', async () => {
    const { dir, base } = planDiffRepo()
    const binDir = fakeGh([{ pattern: '"pr list "*', stderr: 'error connecting to api.github.com', exit: 1 }])
    const result = await runBin(SINGLE_PLAN_BIN, dir, childEnv(binDir, { BASE_SHA: base }))
    expect(result.exitCode).toBe(0)
    expect(result.errors).toEqual([])
  })
})

function issueModeGh(depNumber: number, depReply: FakeCall): string {
  const body = `**Dependency rationale** — \`Depends-on: #${depNumber}\`, \`Conflicts-with: —\`.`
  return fakeGh([
    {
      pattern: `"issue view ${TASK_ISSUE} --json number,state,body,labels"`,
      stdout: JSON.stringify({ number: TASK_ISSUE, state: 'OPEN', body, labels: [] }),
      exit: 0
    },
    { ...depReply, pattern: `"issue view ${depNumber} "*` },
    { pattern: '"api rate_limit"', stdout: RATE_LIMIT_REPLY, exit: 0 },
    { pattern: '"api repos/"*"/contents/vinaya.config.json --jq .content"', stdout: PRINCIPALS_CONFIG_B64, exit: 0 }
  ])
}

describe('dispatch-readiness (Issue mode): a dependency that cannot be read is unread, not unmerged', () => {
  it('a rate-limited dependency read reports depends-on-read-failed', async () => {
    const binDir = issueModeGh(RATE_LIMITED_DEP, { pattern: '', stderr: GRAPHQL_RATE_LIMIT, exit: 1 })
    const result = await runBin(
      DISPATCH_BIN,
      REPO_ROOT,
      childEnv(binDir, {
        BRANCH: `task/issue-${TASK_ISSUE}`,
        AEG_REPO: 'atta-labs/vinaya-fixture',
        GITHUB_REPOSITORY: 'atta-labs/vinaya-fixture'
      })
    )
    expect(result.exitCode).toBe(1)
    const dep = result.errors.find((e) => e.message.includes(`#${RATE_LIMITED_DEP}`))
    expect(dep?.message).toContain('the forge could not be read for that dependency')
    expect(dep?.message).not.toContain('is not merged yet')
    expect(dep?.agent_recovery_prompt).toContain('transient read failure')
  })

  it('a dependency Issue that does not exist keeps the not-merged result', async () => {
    const binDir = issueModeGh(MISSING_DEP, {
      pattern: '',
      stderr: `GraphQL: Could not resolve to an issue or pull request with the number of ${MISSING_DEP}. (repository.issue)`,
      exit: 1
    })
    const result = await runBin(
      DISPATCH_BIN,
      REPO_ROOT,
      childEnv(binDir, {
        BRANCH: `task/issue-${TASK_ISSUE}`,
        AEG_REPO: 'atta-labs/vinaya-fixture',
        GITHUB_REPOSITORY: 'atta-labs/vinaya-fixture'
      })
    )
    expect(result.exitCode).toBe(1)
    const dep = result.errors.find((e) => e.message.includes(`#${MISSING_DEP}`))
    expect(dep?.message).toContain('is not merged yet')
    expect(dep?.message).not.toContain('could not be read')
  })
})

describe('resolveEdge: a rate-limited read keeps every field and adds only readFailed', () => {
  async function resolveWithGh(binDir: string, edge: string) {
    const savedPath = process.env.PATH
    process.env.PATH = `${binDir}:${savedPath}`
    try {
      clearEdgeCache()
      return await resolveEdge(edge, new Map(), new Map(), { owner: 'atta-labs', repo: 'vinaya-fixture' })
    } finally {
      process.env.PATH = savedPath
    }
  }

  it("equals today's failed-lookup values plus readFailed: true", async () => {
    const binDir = fakeGh([{ pattern: `"issue view ${RATE_LIMITED_DEP} "*`, stderr: GRAPHQL_RATE_LIMIT, exit: 1 }])
    const e = await resolveWithGh(binDir, `#${RATE_LIMITED_DEP}`)
    expect(e).toStrictEqual({ ...edgeFromIssueJson(RATE_LIMITED_DEP, null), readFailed: true })
    expect(e).toStrictEqual({
      issue: RATE_LIMITED_DEP,
      merged: false,
      open: false,
      issueState: null,
      stateReason: null,
      closedByActor: null,
      resolved: true,
      readFailed: true
    })
  })

  it('an Issue that does not exist is not a failed read', async () => {
    const binDir = fakeGh([
      {
        pattern: `"issue view ${MISSING_DEP} "*`,
        stderr: `GraphQL: Could not resolve to an issue or pull request with the number of ${MISSING_DEP}.`,
        exit: 1
      }
    ])
    const e = await resolveWithGh(binDir, `#${MISSING_DEP}`)
    expect(e).toStrictEqual(edgeFromIssueJson(MISSING_DEP, null))
    expect('readFailed' in e).toBe(false)
  })
})

describe('resolveEdge: Issue reads run side by side and a failed read is made once more', () => {
  const REPO = { owner: 'atta-labs', repo: 'vinaya-fixture' }
  const CONNECTION_RESET = 'Post "https://api.github.com/graphql": read tcp: connection reset by peer'
  const NOT_FOUND = 'GraphQL: Could not resolve to an issue or pull request with the number of'

  /** How one Issue answers: its first `failFirst` reads fail with `stderr`, every later read prints `stdout`. */
  type IssueReply = { failFirst?: number; stdout?: string; stderr?: string }

  /**
   * A fake `gh issue view` that counts each read per Issue number and waits
   * `delaySeconds` before answering it as `reply` says.
   */
  function countingGh(
    delaySeconds: number,
    nums: number[],
    reply: (n: number) => IssueReply
  ): { binDir: string; calls: (n: number) => number } {
    const binDir = tempDir('edge-read-fake-gh-')
    const callsDir = join(binDir, 'calls')
    mkdirSync(callsDir)
    const arms = nums.map((n) => {
      const r = reply(n)
      const fail = `printf '%s\\n' ${quote(r.stderr ?? 'failed')} >&2; exit 1`
      const ok = r.stdout === undefined ? fail : `printf '%s' ${quote(r.stdout)}; exit 0`
      return `  ${n}) if [ "$count" -le ${r.failFirst ?? 0} ]; then ${fail}; else ${ok}; fi ;;`
    })
    // `gh issue view <n> -R <repo> --json <fields>`: the Issue number is `$3`.
    const log = `${quote(callsDir)}/calls-$3`
    writeFileSync(
      join(binDir, 'gh'),
      `#!/bin/sh\nprintf 'x\\n' >> ${log}\ncount=$(wc -l < ${log})\nsleep ${delaySeconds}\ncase "$3" in\n${arms.join('\n')}\n  *) echo "unhandled fake gh call: $*" >&2; exit 1 ;;\nesac\n`
    )
    chmodSync(join(binDir, 'gh'), 0o755)
    const calls = (n: number): number => {
      const path = join(callsDir, `calls-${n}`)
      return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).length : 0
    }
    return { binDir, calls }
  }

  async function withGhOnPath<T>(binDir: string, fn: () => Promise<T>): Promise<T> {
    const savedPath = process.env.PATH
    process.env.PATH = `${binDir}:${savedPath}`
    try {
      return await fn()
    } finally {
      process.env.PATH = savedPath
    }
  }

  it('seventeen #NNN edges against a forge whose every read takes one second finish in under five seconds, each with its one-at-a-time verdict', async () => {
    const nums = Array.from({ length: 17 }, (_, i) => 900 + i)
    const jsonFor = (n: number) =>
      n % 3 === 0
        ? { state: 'CLOSED', stateReason: 'COMPLETED', closedByPullRequestsReferences: [{ number: n + 1000 }] }
        : n % 3 === 1
          ? { state: 'CLOSED', stateReason: 'NOT_PLANNED', closedByPullRequestsReferences: [] }
          : { state: 'OPEN', closedByPullRequestsReferences: [] }
    const gh = countingGh(1, nums, (n) => ({ stdout: JSON.stringify(jsonFor(n)) }))
    clearEdgeCache()
    const started = Date.now()
    const edges = await withGhOnPath(gh.binDir, () =>
      Promise.all(nums.map((n) => resolveEdge(`#${n}`, new Map(), new Map(), REPO)))
    )
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(5000)
    edges.forEach((edge, i) => {
      const n = nums[i] as number
      expect(edge).toStrictEqual(edgeFromIssueJson(n, jsonFor(n)))
      expect(gh.calls(n)).toBe(1)
    })
    expect(edges.filter((e) => e.merged)).toHaveLength(nums.filter((n) => n % 3 === 0).length)
  }, 15_000)

  it('a read that fails once is made again, and the second answer is the one resolved and cached', async () => {
    const json = { state: 'CLOSED', stateReason: 'COMPLETED', closedByPullRequestsReferences: [{ number: 5 }] }
    const gh = countingGh(0, [RATE_LIMITED_DEP], () => ({
      failFirst: 1,
      stderr: CONNECTION_RESET,
      stdout: JSON.stringify(json)
    }))
    clearEdgeCache()
    const first = await withGhOnPath(gh.binDir, () => resolveEdge(`#${RATE_LIMITED_DEP}`, new Map(), new Map(), REPO))
    expect(first).toStrictEqual(edgeFromIssueJson(RATE_LIMITED_DEP, json))
    expect(first.merged).toBe(true)
    expect(gh.calls(RATE_LIMITED_DEP)).toBe(2)
    const again = await withGhOnPath(gh.binDir, () => resolveEdge(`#${RATE_LIMITED_DEP}`, new Map(), new Map(), REPO))
    expect(again).toStrictEqual(first)
    expect(gh.calls(RATE_LIMITED_DEP)).toBe(2)
  })

  it('a read that fails twice stays a failed read, cached as one, and never passes', async () => {
    const gh = countingGh(0, [RATE_LIMITED_DEP], () => ({ failFirst: 99, stderr: CONNECTION_RESET }))
    clearEdgeCache()
    const edge = await withGhOnPath(gh.binDir, () => resolveEdge(`#${RATE_LIMITED_DEP}`, new Map(), new Map(), REPO))
    expect(edge).toStrictEqual({ ...edgeFromIssueJson(RATE_LIMITED_DEP, null), readFailed: true })
    expect(gh.calls(RATE_LIMITED_DEP)).toBe(2)
    const again = await withGhOnPath(gh.binDir, () => resolveEdge(`#${RATE_LIMITED_DEP}`, new Map(), new Map(), REPO))
    expect(again).toStrictEqual(edge)
    expect(gh.calls(RATE_LIMITED_DEP)).toBe(2)
    const classes = checkDispatchReadiness({
      trancheSlug: `issue-${TASK_ISSUE}`,
      task: {
        id: String(TASK_ISSUE),
        title: '',
        issue: TASK_ISSUE,
        projects: [],
        dependsOn: [`#${RATE_LIMITED_DEP}`],
        conflictsWith: [],
        rationaleMarkdown: ''
      },
      issue: { number: TASK_ISSUE, state: 'open' },
      issueRationalePass: true,
      dependsOn: [dependsOnFactFromEdge(`#${RATE_LIMITED_DEP}`, edge)],
      conflictsWith: [],
      priorTask: null,
      priorTrancheArchival: [],
      principalAllowlist: []
    }).blockerDetails.map((d) => d.class)
    expect(classes).toEqual(['depends-on-read-failed'])
  })

  it('a not-found answer is read once and never again', async () => {
    const gh = countingGh(0, [MISSING_DEP], (n) => ({ failFirst: 99, stderr: `${NOT_FOUND} ${n}.` }))
    clearEdgeCache()
    const edge = await withGhOnPath(gh.binDir, () => resolveEdge(`#${MISSING_DEP}`, new Map(), new Map(), REPO))
    expect(edge).toStrictEqual(edgeFromIssueJson(MISSING_DEP, null))
    expect(gh.calls(MISSING_DEP)).toBe(1)
  })
})

describe("dependsOnFactFromEdge: the shared mapper carries readFailed into the gate's dependency fact", () => {
  const gateInput = (fact: ReturnType<typeof dependsOnFactFromEdge>): DispatchGateInput => ({
    trancheSlug: `issue-${TASK_ISSUE}`,
    task: {
      id: String(TASK_ISSUE),
      title: '',
      issue: TASK_ISSUE,
      projects: [],
      dependsOn: [fact.id],
      conflictsWith: [],
      rationaleMarkdown: ''
    },
    issue: { number: TASK_ISSUE, state: 'open' },
    issueRationalePass: true,
    dependsOn: [fact],
    conflictsWith: [],
    priorTask: null,
    priorTrancheArchival: [],
    principalAllowlist: []
  })

  it('a failed read becomes readFailed: true and the gate refuses with depends-on-read-failed', () => {
    const fact = dependsOnFactFromEdge('#77', edgeFromIssueJson(77, null, true))
    expect(fact).toStrictEqual({
      id: '#77',
      issue: 77,
      merged: false,
      resolved: true,
      issueState: null,
      stateReason: null,
      closedByActor: null,
      readFailed: true
    })
    const classes = checkDispatchReadiness(gateInput(fact)).blockerDetails.map((d) => d.class)
    expect(classes).toEqual(['depends-on-read-failed'])
  })

  it('a missing Issue maps exactly as before and the gate still says not merged', () => {
    const fact = dependsOnFactFromEdge('#78', edgeFromIssueJson(78, null))
    expect('readFailed' in fact).toBe(false)
    const classes = checkDispatchReadiness(gateInput(fact)).blockerDetails.map((d) => d.class)
    expect(classes).toEqual(['depends-on-not-merged'])
  })
})
