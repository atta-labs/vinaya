import { describe, expect, it } from 'bun:test'
import {
  type DeveloperDevToolDeps,
  createDeveloperDevToolContext
} from '../../../src/lib/task-tools/developer-dev-tools-context.js'
import type { PublicationCheckInput } from '../../../src/lib/dev-review-loop/developer-publication.js'

/**
 * The production gate-backed `DevToolContext` (O3): each tool runs the gates in
 * the driver and returns a structured success or a structured refusal, and no
 * method ever throws (a refusal never pauses the loop). Here the injected side
 * effects are fakes — the documented seam — while the gates the factory runs
 * (`validateCommitHeader`, `checkPublicationPreconditions`, the body gate) are
 * the real ones.
 */

const PASSING_PRECHECK: PublicationCheckInput = {
  worktreeBranch: 'task/issue-1040',
  expectedBranch: 'task/issue-1040',
  worktreeHead: null,
  recordedHead: null,
  base: 'b'.repeat(40),
  expectedBase: 'b'.repeat(40),
  changedPaths: ['apps/cli/src/x.ts'],
  surface: null
}

function deps(overrides: Partial<DeveloperDevToolDeps> = {}): DeveloperDevToolDeps {
  return {
    readPublicationCheckInput: () => PASSING_PRECHECK,
    commitAndPush: async () => ({ ok: true, result: { pushedHead: 'deadbeef' } }),
    validatePrBody: () => ({ ok: true }),
    openPullRequest: async () => ({ ok: true, result: { prNumber: 1051 } }),
    updatePullRequestBody: async () => ({ ok: true, result: { prNumber: 1051 } }),
    refreshEvidence: async () => ({ ok: true, result: { head: 'deadbeef', checksPassed: true, evidence: 'ok' } }),
    readPullRequest: async () => ({
      ok: true,
      result: {
        prNumber: 1051,
        state: 'OPEN',
        head: 'deadbeef',
        checks: null,
        reviews: null,
        body: 'b',
        failedChecks: []
      }
    }),
    runChecks: async () => ({ ok: true, result: { passed: true, output: 'all green' } }),
    ...overrides
  }
}

describe('publishChanges gates', () => {
  it('refuses a malformed commit header before any commit', async () => {
    let committed = false
    const ctx = createDeveloperDevToolContext(
      deps({
        commitAndPush: async () => {
          committed = true
          return { ok: true, result: { pushedHead: 'x' } }
        }
      })
    )
    const res = await ctx.publishChanges('not a conventional header')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.check).toBe('commit-header')
    expect(committed).toBe(false)
  })
  it('refuses when a publication precondition fails, before any commit', async () => {
    let committed = false
    const ctx = createDeveloperDevToolContext(
      deps({
        readPublicationCheckInput: () => ({ ...PASSING_PRECHECK, worktreeBranch: 'some-other-branch' }),
        commitAndPush: async () => {
          committed = true
          return { ok: true, result: { pushedHead: 'x' } }
        }
      })
    )
    const res = await ctx.publishChanges('Fix(cli): a valid header')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.check).toBe('publication-preconditions')
    expect(committed).toBe(false)
  })
  it('commits and pushes when the header and preconditions pass', async () => {
    const ctx = createDeveloperDevToolContext(deps())
    const res = await ctx.publishChanges('Fix(cli): a valid header')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.result.pushedHead).toBe('deadbeef')
  })
  it('returns the commit/push refusal (pre-push/protected-path) verbatim', async () => {
    const ctx = createDeveloperDevToolContext(
      deps({
        commitAndPush: async () => ({
          ok: false,
          error: { check: 'pre-push-hook', output: 'hook said no', fix: 'fix it' }
        })
      })
    )
    const res = await ctx.publishChanges('Fix(cli): a valid header')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.check).toBe('pre-push-hook')
  })
  it('never throws — a rejected commit closure becomes a refusal', async () => {
    const ctx = createDeveloperDevToolContext(
      deps({
        commitAndPush: async () => {
          throw new Error('git exploded')
        }
      })
    )
    const res = await ctx.publishChanges('Fix(cli): a valid header')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.check).toBe('publish_changes')
      expect(res.error.output).toContain('git exploded')
    }
  })
})

describe('PR-body gate', () => {
  it('validates the exact title submitted to open_pull_request', async () => {
    const seen: Array<string | undefined> = []
    const ctx = createDeveloperDevToolContext(
      deps({
        validatePrBody: (_body, title) => {
          seen.push(title)
          return { ok: true }
        }
      })
    )
    await ctx.openPullRequest('invalid submitted title', 'good body')
    await ctx.updatePullRequestBody('good body')
    expect(seen).toEqual(['invalid submitted title', undefined])
  })

  it('open_pull_request refuses a body the gate rejects, before opening', async () => {
    let opened = false
    const ctx = createDeveloperDevToolContext(
      deps({
        validatePrBody: () => ({ ok: false, reason: 'missing Closes #N' }),
        openPullRequest: async () => {
          opened = true
          return { ok: true, result: { prNumber: 1 } }
        }
      })
    )
    const res = await ctx.openPullRequest('title', 'bad body')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.check).toBe('pr-body-gate')
    expect(opened).toBe(false)
  })
  it('update_pull_request_body refuses a body the gate rejects, before writing', async () => {
    const ctx = createDeveloperDevToolContext(deps({ validatePrBody: () => ({ ok: false, reason: 'bad' }) }))
    const res = await ctx.updatePullRequestBody('bad body')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.check).toBe('pr-body-gate')
  })
  it('passes a valid body through to open/update', async () => {
    const ctx = createDeveloperDevToolContext(deps())
    expect((await ctx.openPullRequest('t', 'good')).ok).toBe(true)
    expect((await ctx.updatePullRequestBody('good')).ok).toBe(true)
  })
})

describe('read-only tools pass through', () => {
  it('refreshEvidence, readPullRequest and runChecks delegate to their closures', async () => {
    const ctx = createDeveloperDevToolContext(deps())
    const ev = await ctx.refreshEvidence()
    expect(ev.ok && ev.result.checksPassed).toBe(true)
    const pr = await ctx.readPullRequest()
    expect(pr.ok && pr.result.prNumber).toBe(1051)
    const checks = await ctx.runChecks()
    expect(checks.ok && checks.result.passed).toBe(true)
  })
  it('a rejected runChecks closure becomes a refusal, not a throw', async () => {
    const ctx = createDeveloperDevToolContext(
      deps({
        runChecks: async () => {
          throw new Error('check runner died')
        }
      })
    )
    const res = await ctx.runChecks()
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.check).toBe('run_checks')
  })
})
