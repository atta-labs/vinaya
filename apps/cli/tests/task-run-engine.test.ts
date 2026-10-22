import { describe, expect, it } from 'bun:test'
import { parseFlags, runnerForFlags } from '../src/commands/task-run.js'
import { resolveTaskRunner, VinayaConfigSchema } from '../src/lib/config.js'
import { runTask, type RunTaskDeps } from '../src/lib/task-run.js'
import { ENGINE_FALLBACK_NOTICE, runTaskEngine } from '../src/lib/task-run-engine.js'

function fixture(overrides: Partial<RunTaskDeps> = {}): RunTaskDeps {
  return {
    prepareTask: async () => ({ issue: 42 }) as Awaited<ReturnType<RunTaskDeps['prepareTask']>>,
    prepareIssueTask: async () => ({ issue: 42 }) as Awaited<ReturnType<RunTaskDeps['prepareIssueTask']>>,
    assembleAndRenderBrief: async () => {
      throw new Error('unexpected render')
    },
    assembleAndRenderBriefForIssue: async () => {
      throw new Error('unexpected render')
    },
    developerBranchFor: () => 'task/issue-42',
    findOpenPrForBranch: () => null,
    isDriverAlive: () => false,
    hasPauseState: () => false,
    resolveModelForDispatch: () => 'resolved-model',
    devReviewLoop: async () => ({ task: 42, prNumber: 7, finalDecision: { type: 'publish' } }),
    resolveRepo: async () => null,
    assignIssue: () => {},
    runnerConfig: () => null,
    ...overrides
  }
}

describe('task runner selection', () => {
  it('defaults to standalone and accepts each configured runner', () => {
    expect(resolveTaskRunner(undefined, VinayaConfigSchema.parse({}))).toBe('standalone')
    for (const runner of ['standalone', 'atta-engine'] as const) {
      expect(resolveTaskRunner(undefined, VinayaConfigSchema.parse({ runner }))).toBe(runner)
    }
  })

  it('refuses an unknown runner at the config boundary, naming the key', () => {
    const result = VinayaConfigSchema.safeParse({ runner: 'other' })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['runner'])
    expect(() => resolveTaskRunner('other', null)).toThrow('runner')
  })

  it('parses a one-run flag override and refuses a missing flag value', () => {
    const parsed = parseFlags(['--runner', 'atta-engine'])
    expect(parsed.unknown).toEqual([])
    expect(runnerForFlags(parsed)).toBe('atta-engine')
    expect(resolveTaskRunner('standalone', { runner: 'atta-engine' })).toBe('standalone')
    expect(() => runnerForFlags(parseFlags(['--runner']))).toThrow('--runner')
    expect(() => runnerForFlags(parseFlags(['--runner', 'invalid']))).toThrow('runner')
  })

  it('starts the script with the resolved issue, agent and model and inherits output', async () => {
    const calls: unknown[] = []
    const result = await runTask(
      { tranche: 'sample', n: 2, agent: 'codex', runner: 'atta-engine' },
      fixture({
        developerBranchFor: (task) => {
          expect(task).toBe(42)
          return 'task/sample/2'
        },
        engine: {
          scriptPath: () => '/workspace/processes/vinaya/bin/run-engine.ts',
          exists: () => true,
          spawn: async (argv, options) => {
            calls.push({ argv, options })
            return 17
          },
          notice: () => {
            throw new Error('unexpected fallback')
          }
        },
        devReviewLoop: async () => {
          throw new Error('unexpected standalone call')
        }
      })
    )
    expect(calls).toEqual([
      {
        argv: [
          'bun',
          '/workspace/processes/vinaya/bin/run-engine.ts',
          '--task',
          '42',
          '--agent',
          'codex',
          '--model',
          'resolved-model'
        ],
        options: { stdio: 'inherit' }
      }
    ])
    expect(result).toMatchObject({ exitCode: 17, task: 42, branch: 'task/sample/2' })
  })

  it('selects Engine from config and omits an unresolved model', async () => {
    const calls: string[][] = []
    await runTask(
      { issue: 42, agent: 'claude' },
      fixture({
        runnerConfig: () => ({ runner: 'atta-engine' }),
        resolveModelForDispatch: () => undefined,
        engine: {
          scriptPath: () => '/runner.ts',
          exists: () => true,
          spawn: async (argv) => {
            calls.push(argv)
            return 0
          }
        }
      })
    )
    expect(calls).toEqual([['bun', '/runner.ts', '--task', '42', '--agent', 'claude']])
  })

  it('lets the invocation select standalone over configured Engine', async () => {
    let standalone = 0
    await runTask(
      { issue: 42, agent: 'claude', runner: 'standalone' },
      fixture({
        runnerConfig: () => ({ runner: 'atta-engine' }),
        engine: {
          exists: () => {
            throw new Error('unexpected Engine lookup')
          }
        },
        devReviewLoop: async () => {
          standalone++
          return { task: 42, prNumber: 7, finalDecision: { type: 'publish' } }
        }
      })
    )
    expect(standalone).toBe(1)
  })

  it('prints exactly one fallback line and calls standalone once when the script is absent', async () => {
    const notices: string[] = []
    const standalone: unknown[] = []
    const result = await runTask(
      { issue: 42, agent: 'claude', runner: 'atta-engine' },
      fixture({
        engine: {
          exists: () => false,
          notice: (line) => notices.push(line),
          spawn: async () => {
            throw new Error('unexpected spawn')
          }
        },
        devReviewLoop: async (input) => {
          standalone.push(input)
          return { task: 42, prNumber: 7, finalDecision: { type: 'publish' } }
        }
      })
    )
    expect(notices).toEqual([ENGINE_FALLBACK_NOTICE])
    expect(notices[0]).toContain('standalone')
    expect(notices[0]?.split('\n')).toHaveLength(1)
    expect(standalone).toEqual([{ task: 42, agent: 'claude', model: 'resolved-model' }])
    expect(result.prNumber).toBe(7)
  })

  it('propagates a spawn failure without silently switching runners', async () => {
    await expect(
      runTaskEngine(
        { task: 42, agent: 'claude' },
        {
          exists: () => true,
          spawn: async () => {
            throw new Error('spawn refused')
          }
        }
      )
    ).rejects.toThrow('spawn refused')
  })
})
