import { describe, expect, it } from 'bun:test'
import {
  type DeveloperDevToolDeps,
  createDeveloperDevToolContext
} from '@harness/workflow/loops/dev-review/actions/developer-dev-tools-context.js'
import type { PublicationCheckInput } from '@harness/workflow/loops/dev-review/standalone/dev-review-loop/developer-publication.js'
import { devToolError } from '@harness/kernel/tools/dev-tools-server.js'
import { EVIDENCE_PLACEHOLDER_TEXT } from '@harness/workflow/checks/evidence-fresh-logic.js'
import { REGION_PREFIX_CURRENT } from '@harness/workflow/tools/legacy-markers.js'

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
    if (!res.ok)
      expect(res.error).toMatchObject({
        check: 'commit-header',
        errorClass: 'policy_refusal',
        retryDisposition: 'same_attempt',
        effectState: 'not_started'
      })
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
    if (!res.ok)
      expect(res.error).toMatchObject({
        check: 'publication-preconditions',
        errorClass: 'policy_refusal',
        retryDisposition: 'same_attempt',
        effectState: 'not_started'
      })
    expect(committed).toBe(false)
  })
  it('publishes after a mid-turn merge of the default branch', async () => {
    const old = 'b'.repeat(40)
    const ctx = createDeveloperDevToolContext(
      deps({
        readPublicationCheckInput: () => ({
          ...PASSING_PRECHECK,
          worktreeHead: 'm'.repeat(40),
          recordedHead: 'a'.repeat(40),
          base: 'n'.repeat(40),
          expectedBase: old,
          parentMerge: {
            expectedBaseIsAncestorOfBase: true,
            baseIsOnDefaultBranch: true,
            recordedHeadIsAncestorOfHead: true,
            baseIsAncestorOfHead: true
          }
        })
      })
    )
    const res = await ctx.publishChanges('Fix(cli): a valid header')
    expect(res.ok).toBe(true)
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
          error: devToolError(
            'policy_refusal',
            'same_attempt',
            'not_committed',
            'pre-push-hook',
            'hook said no',
            'fix it'
          )
        })
      })
    )
    const res = await ctx.publishChanges('Fix(cli): a valid header')
    expect(res.ok).toBe(false)
    if (!res.ok)
      expect(res.error).toMatchObject({
        check: 'pre-push-hook',
        errorClass: 'policy_refusal',
        retryDisposition: 'same_attempt',
        effectState: 'not_committed'
      })
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
      expect(res.error).toMatchObject({
        check: 'publish_changes',
        errorClass: 'internal',
        retryDisposition: 'new_attempt',
        effectState: 'uncertain'
      })
      expect(res.error.output).toContain('git exploded')
    }
  })
  it('classifies a publication-precondition read exception before effects start', async () => {
    const ctx = createDeveloperDevToolContext(
      deps({
        readPublicationCheckInput: () => {
          throw new Error('worktree facts unavailable')
        }
      })
    )
    const res = await ctx.publishChanges('Fix(cli): a valid header')
    expect(res.ok).toBe(false)
    if (!res.ok)
      expect(res.error).toMatchObject({
        check: 'publish_changes',
        errorClass: 'internal',
        retryDisposition: 'new_attempt',
        effectState: 'not_started'
      })
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
    if (!res.ok)
      expect(res.error).toMatchObject({
        check: 'pr-body-gate',
        errorClass: 'policy_refusal',
        retryDisposition: 'same_attempt',
        effectState: 'not_started'
      })
    expect(opened).toBe(false)
  })
  it('update_pull_request_body refuses a body the gate rejects, before writing', async () => {
    const ctx = createDeveloperDevToolContext(deps({ validatePrBody: () => ({ ok: false, reason: 'bad' }) }))
    const res = await ctx.updatePullRequestBody('bad body')
    expect(res.ok).toBe(false)
    if (!res.ok)
      expect(res.error).toMatchObject({
        check: 'pr-body-gate',
        errorClass: 'policy_refusal',
        retryDisposition: 'same_attempt',
        effectState: 'not_started'
      })
  })
  it('classifies an unconfirmed remote PR creation as uncertain', async () => {
    const ctx = createDeveloperDevToolContext(
      deps({
        openPullRequest: async () => {
          throw new Error('forge response was lost')
        }
      })
    )
    const res = await ctx.openPullRequest('title', 'good body')
    expect(res.ok).toBe(false)
    if (!res.ok)
      expect(res.error).toMatchObject({
        check: 'open_pull_request',
        errorClass: 'internal',
        retryDisposition: 'new_attempt',
        effectState: 'uncertain'
      })
  })
  it('classifies a PR-body gate exception before the remote effect starts', async () => {
    const ctx = createDeveloperDevToolContext(
      deps({
        validatePrBody: () => {
          throw new Error('body gate unavailable')
        }
      })
    )
    const res = await ctx.openPullRequest('title', 'good body')
    expect(res.ok).toBe(false)
    if (!res.ok)
      expect(res.error).toMatchObject({
        check: 'open_pull_request',
        errorClass: 'internal',
        retryDisposition: 'new_attempt',
        effectState: 'not_started'
      })
  })
  it('passes a valid body through to open/update, with the Evidence section added', async () => {
    const ctx = createDeveloperDevToolContext(deps())
    expect((await ctx.openPullRequest('t', 'good')).ok).toBe(true)
    expect((await ctx.updatePullRequestBody('good')).ok).toBe(true)
  })

  describe('the Evidence section', () => {
    const START = `<!-- ${REGION_PREFIX_CURRENT}:EVIDENCE:START -->`
    const END = `<!-- ${REGION_PREFIX_CURRENT}:EVIDENCE:END -->`
    const PLACEHOLDER_BLOCK = `${START}\n${EVIDENCE_PLACEHOLDER_TEXT}\n${END}`
    const WRITTEN_BLOCK = `${START}\nHead: abc1234\n\n#### C1: bun test\n${END}`
    const bare = 'Closes #1\n\n## Scope\n\nscope\n'
    const withSection = `Closes #1\n\n## Evidence\n\n${PLACEHOLDER_BLOCK}\n\n## Scope\n\nscope\n`

    it('open_pull_request hands the gate and the forge the body with the section added', async () => {
      const gated: string[] = []
      const opened: string[] = []
      const ctx = createDeveloperDevToolContext(
        deps({
          validatePrBody: (body) => {
            gated.push(body)
            return { ok: true }
          },
          openPullRequest: async (_title, body) => {
            opened.push(body)
            return { ok: true, result: { prNumber: 1 } }
          }
        })
      )
      expect((await ctx.openPullRequest('t', bare)).ok).toBe(true)
      expect(gated).toEqual([withSection])
      expect(opened).toEqual([withSection])
    })

    it('open_pull_request passes a body with a real pair through byte for byte', async () => {
      const own = `Closes #1\n\n## Evidence\n\n${WRITTEN_BLOCK}\n\n## Scope\n\nscope\n`
      const opened: string[] = []
      const ctx = createDeveloperDevToolContext(
        deps({
          openPullRequest: async (_title, body) => {
            opened.push(body)
            return { ok: true, result: { prNumber: 1 } }
          }
        })
      )
      await ctx.openPullRequest('t', own)
      expect(opened).toEqual([own])
    })

    it('update_pull_request_body adds the placeholder section when the live body has no pair', async () => {
      const gated: string[] = []
      const written: string[] = []
      const ctx = createDeveloperDevToolContext(
        deps({
          validatePrBody: (body) => {
            gated.push(body)
            return { ok: true }
          },
          updatePullRequestBody: async (body) => {
            written.push(body)
            return { ok: true, result: { prNumber: 1 } }
          }
        })
      )
      await ctx.updatePullRequestBody(bare)
      expect(gated).toEqual([withSection])
      expect(written).toEqual([withSection])
    })

    it('update_pull_request_body keeps the live pair block instead of the placeholder', async () => {
      const written: string[] = []
      const live = `Closes #1\n\n## Evidence\n\n${WRITTEN_BLOCK}\n\n## Scope\n\nold\n`
      const ctx = createDeveloperDevToolContext(
        deps({
          readPullRequest: async () => ({
            ok: true,
            result: { prNumber: 1, state: 'OPEN', head: 'h', checks: null, reviews: null, body: live, failedChecks: [] }
          }),
          updatePullRequestBody: async (body) => {
            written.push(body)
            return { ok: true, result: { prNumber: 1 } }
          }
        })
      )
      await ctx.updatePullRequestBody(bare)
      expect(written).toEqual([`Closes #1\n\n## Evidence\n\n${WRITTEN_BLOCK}\n\n## Scope\n\nscope\n`])
    })

    it('update_pull_request_body still adds the placeholder when reading the live body throws', async () => {
      const written: string[] = []
      const ctx = createDeveloperDevToolContext(
        deps({
          readPullRequest: async () => {
            throw new Error('forge down')
          },
          updatePullRequestBody: async (body) => {
            written.push(body)
            return { ok: true, result: { prNumber: 1 } }
          }
        })
      )
      await ctx.updatePullRequestBody(bare)
      expect(written).toEqual([withSection])
    })
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
