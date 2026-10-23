import { describe, expect, test } from 'bun:test'
import {
  commitAndPushPrompt,
  createEngineLiveDeveloperContext,
  createLiveDeveloperContext,
  publishDeveloperTurn,
  pushedCommitRangeBase
} from '../../../src/lib/task-tools/live-developer-context'

const success = <T>(result: T) => Promise.resolve({ ok: true as const, result })

describe('the shared live Developer context', () => {
  test('applies publication preconditions before the pushed commit range', async () => {
    let pushed = false
    const context = createLiveDeveloperContext({
      readPublicationCheckInput: () => ({
        worktreeBranch: 'wrong',
        expectedBranch: 'task/t/8',
        worktreeHead: 'head',
        recordedHead: 'head',
        base: 'base',
        expectedBase: 'base',
        changedPaths: ['outside/file.ts'],
        surface: { in: ['apps/cli/**'], out: [] }
      }),
      commitAndPush: async () => {
        pushed = true
        return success({ pushedHead: 'head' })
      },
      validatePrBody: () => ({ ok: true }),
      openPullRequest: () => success({ prNumber: 1 }),
      updatePullRequestBody: () => success({ prNumber: 1 }),
      refreshEvidence: () => success({ head: 'head', checksPassed: true, evidence: '' }),
      readPullRequest: () =>
        success({
          prNumber: null,
          state: null,
          head: null,
          checks: null,
          reviews: null,
          body: null,
          failedChecks: []
        }),
      runChecks: () => success({ passed: true, output: '' })
    })
    const result = await context.publishChanges('Fix(cli): Share live context')
    expect(result.ok).toBe(false)
    expect(pushed).toBe(false)
    expect(pushedCommitRangeBase('remote', 'base')).toBe('remote')
    expect(pushedCommitRangeBase(null, 'base')).toBe('base')
  })

  test('clean open pull requests publish nothing and refused pushes remain in the prompt', () => {
    const result = publishDeveloperTurn({
      worktreePath: process.cwd(),
      branch: 'task/t/8',
      turnPreStop: null,
      findOpenPullRequest: () => ({ number: 8 }),
      readUnpushedWork: () => ({ dirtyFiles: [], aheadCount: 0 }),
      fetchDeveloperStop: () => null,
      noPushDetail: () => 'none',
      refusal: () => {
        throw new Error('must not refuse')
      }
    })
    expect(result).toEqual({ kind: 'nothing' })
    expect(commitAndPushPrompt('lint failed', 'Publish through the tools.')).toContain('lint failed')
  })

  test('the Engine refuses an out-of-Surface protected path inside write attribution', async () => {
    let pushed = false
    let attributed = false
    const context = createEngineLiveDeveloperContext({
      branch: 'task/t/8',
      task: 8,
      recordedHead: 'head',
      surface: { in: ['apps/cli/**'], out: [] },
      git: (...args) => {
        if (args[0] === 'merge-base') return 'base'
        if (args.includes('--abbrev-ref')) return 'task/t/8'
        if (args[0] === 'rev-parse') return 'head'
        if (args[0] === 'push') pushed = true
        return ''
      },
      forge: () => '',
      changedPaths: () => [],
      protectedChangedPaths: () => ['.github/workflows/unscoped.yml'],
      driverToolCall: async (call) => {
        attributed = true
        return call()
      },
      findOpenPullRequest: () => null,
      readPullRequestView: () =>
        success({
          prNumber: null,
          state: null,
          head: null,
          checks: null,
          reviews: null,
          body: null,
          failedChecks: []
        }),
      findCredentialPatterns: () => [],
      validatePullRequestBody: async () => ({ ok: true }),
      refreshEvidence: () => success({ head: 'head', checksPassed: true, evidence: '' }),
      runChecks: () => success({ passed: true, output: '' }),
      fetchDocumentation: async () => ({ ok: false, error: {} as never })
    })
    const result = await context.publishChanges('Fix(cli): Protect engine publication')
    expect(result.ok).toBe(false)
    expect(attributed).toBe(true)
    expect(pushed).toBe(false)
    if (!result.ok) expect(result.error.output).toContain('protected administrative policy path')
  })
})
