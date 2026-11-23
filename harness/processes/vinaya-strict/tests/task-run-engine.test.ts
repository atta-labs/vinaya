import { describe, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { programFile } from '../tools/programs.js'
import {
  engineStartRefusalForStart,
  flowForFlags,
  parseFlags,
  runnerForFlags
} from '../../../../apps/cli/src/commands/task-run.js'
import { resolveTaskRunner, VinayaConfigSchema } from '../integration/config/compose.js'
import { runTask, type RunTaskDeps } from '../loops/dev-review/run-control/task-run.js'
import {
  defaultEngineRunnerDeps,
  engineContinuationArgv,
  engineRunnerScriptPath,
  engineStartRefusal,
  findBunOnPath,
  runTaskEngine
} from '../loops/dev-review/run-control/task-run-engine.js'
import { spawnBudgetedAsync, stripVinayaEnv } from '../../../kernel/conformance/unit/process-fixture.js'

/** A Bun the stand-in lookup finds, so no test depends on a real Bun on the PATH. */
const BUN = '/usr/local/bin/bun'

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
    runnerConfig: () => ({ runner: 'standalone' }),
    ...overrides
  }
}

describe('task runner selection', () => {
  it('defaults to the Atta Engine and accepts each configured runner', () => {
    expect(resolveTaskRunner(undefined, VinayaConfigSchema.parse({}))).toBe('atta-engine')
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

  it('refuses an invalid configured runner through the real command, even with an override', async () => {
    const root = mkdtempSync(join(tmpdir(), 'runner-config-'))
    try {
      writeFileSync(join(root, 'vinaya.config.json'), JSON.stringify({ runner: 'other', logs: false }))
      for (const extra of [[], ['--runner', 'standalone'], ['--runner', 'atta-engine']]) {
        const result = await spawnBudgetedAsync(
          [
            process.execPath,
            join(import.meta.dir, '../../../../apps/cli/src/index.ts'),
            'task',
            'run',
            '--issue',
            '42',
            '--agent',
            'codex',
            ...extra
          ],
          { cwd: root, env: { ...stripVinayaEnv(), HOME: root } }
        )
        expect(result.status).toBe(2)
        expect(result.stderr).toContain('runner')
        expect(result.stderr).not.toContain('falling back')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses invalid config before direct runTask preparation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'runner-config-'))
    const cwd = process.cwd()
    let preparations = 0
    try {
      writeFileSync(join(root, 'vinaya.config.json'), JSON.stringify({ runner: 'other', logs: false }))
      process.chdir(root)
      await expect(
        runTask(
          { issue: 42, agent: 'codex' },
          fixture({
            runnerConfig: undefined,
            prepareIssueTask: async () => {
              preparations++
              throw new Error('unexpected preparation')
            }
          })
        )
      ).rejects.toThrow('runner')
      expect(preparations).toBe(0)
    } finally {
      process.chdir(cwd)
      rmSync(root, { recursive: true, force: true })
    }
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
          scriptPath: () => '/workspace/harness/processes/vinaya-strict/bin/run-engine.ts',
          exists: () => true,
          spawn: async (argv, options) => {
            calls.push({ argv, options })
            return 17
          },
          findBun: () => BUN
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
          '/workspace/harness/processes/vinaya-strict/bin/run-engine.ts',
          '--task',
          '42',
          '--agent',
          'codex',
          '--model',
          'resolved-model',
          '--effort',
          'medium'
        ],
        options: { stdio: 'inherit' }
      }
    ])
    expect(result).toMatchObject({ exitCode: 17, task: 42, branch: 'task/sample/2' })
  })

  it("starts the Engine runner at the program table's file for its row: the source file in a checkout", () => {
    expect(engineRunnerScriptPath()).toBe(programFile('run-engine'))
    expect(engineRunnerScriptPath()).toBe(join(import.meta.dir, '..', 'bin', 'run-engine.ts'))
    expect(defaultEngineRunnerDeps.scriptPath()).toBe(engineRunnerScriptPath())
    const continuation = engineContinuationArgv({ issue: 9, pr: null, agent: 'claude' })
    expect(continuation[0]).toBe(programFile('run-engine'))
  })

  it('in an installed package the runner path is the built program the package carries', () => {
    const pkg = mkdtempSync(join(tmpdir(), 'runner-install-'))
    try {
      writeFileSync(join(pkg, 'package.json'), '{}')
      mkdirSync(join(pkg, 'dist', 'programs'), { recursive: true })
      writeFileSync(join(pkg, 'dist', 'programs', 'run-engine.js'), '')
      expect(programFile('run-engine', pkg, false)).toBe(join(pkg, 'dist', 'programs', 'run-engine.js'))
    } finally {
      rmSync(pkg, { recursive: true, force: true })
    }
  })

  it('passes the chosen flow to the Engine script as --flow', async () => {
    const calls: string[][] = []
    await runTask(
      { issue: 42, agent: 'claude', runner: 'atta-engine', flow: 'v2' },
      fixture({
        engine: {
          scriptPath: () => '/s/run-engine.ts',
          exists: () => true,
          spawn: async (argv) => {
            calls.push(argv)
            return 0
          },
          findBun: () => BUN
        },
        devReviewLoop: async () => {
          throw new Error('unexpected standalone call')
        }
      })
    )
    expect(calls[0]?.slice(-2)).toEqual(['--flow', 'v2'])
  })

  it('starts the Engine with the effort --effort names, else medium', async () => {
    const run = async (effort?: 'xhigh') => {
      const calls: string[][] = []
      await runTask(
        { issue: 42, agent: 'claude', runner: 'atta-engine', ...(effort ? { effort } : {}) },
        fixture({
          engine: {
            scriptPath: () => '/s/run-engine.ts',
            exists: () => true,
            spawn: async (argv) => {
              calls.push(argv)
              return 0
            },
            findBun: () => BUN
          },
          devReviewLoop: async () => {
            throw new Error('unexpected standalone call')
          }
        })
      )
      return calls[0] as string[]
    }
    const named = await run('xhigh')
    expect(named.slice(named.indexOf('--effort'), named.indexOf('--effort') + 2)).toEqual(['--effort', 'xhigh'])
    const unnamed = await run()
    expect(unnamed.slice(unnamed.indexOf('--effort'), unnamed.indexOf('--effort') + 2)).toEqual(['--effort', 'medium'])
  })

  it('carries a held effort onto the continuation of a halted Engine run', () => {
    const continuation = engineContinuationArgv({ issue: 9, pr: 70, agent: 'codex', effort: 'high' })
    expect(continuation.slice(-2)).toEqual(['--effort', 'high'])
    expect(engineContinuationArgv({ issue: 9, pr: null, agent: 'codex' })).not.toContain('--effort')
  })

  it('--flow parses, refuses an empty key, and refuses a flow other than v1 on the standalone runner', () => {
    expect(flowForFlags(parseFlags(['--flow', 'v2']), 'atta-engine')).toBe('v2')
    expect(flowForFlags(parseFlags([]), 'standalone')).toBeUndefined()
    expect(flowForFlags(parseFlags(['--flow', 'v1']), 'standalone')).toBe('v1')
    expect(() => flowForFlags(parseFlags(['--flow']), 'atta-engine')).toThrow('--flow requires a flow key')
    expect(() => flowForFlags(parseFlags(['--flow', 'v2']), 'standalone')).toThrow('atta-engine runner only')
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
          },
          findBun: () => BUN
        }
      })
    )
    expect(calls).toEqual([['bun', '/runner.ts', '--task', '42', '--agent', 'claude', '--effort', 'medium']])
  })

  it('runs a repository that names no runner, started with no --runner, on the Atta Engine', async () => {
    const calls: string[][] = []
    const recorded: string[] = []
    await runTask(
      { issue: 42, agent: 'claude' },
      fixture({
        runnerConfig: () => null,
        recordRunner: (_issue, runner) => void recorded.push(runner),
        engine: {
          scriptPath: () => '/runner.ts',
          exists: () => true,
          spawn: async (argv) => {
            calls.push(argv)
            return 0
          },
          findBun: () => BUN
        },
        devReviewLoop: async () => {
          throw new Error('unexpected standalone call')
        }
      })
    )
    expect(calls).toHaveLength(1)
    expect(recorded).toEqual(['atta-engine'])
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

  it('propagates a spawn failure without silently switching runners', async () => {
    await expect(
      runTaskEngine(
        { task: 42, agent: 'claude' },
        {
          spawn: async () => {
            throw new Error('spawn refused')
          }
        }
      )
    ).rejects.toThrow('spawn refused')
  })
})

describe('whether the Engine runner can start', () => {
  const present = () => true
  const absent = () => false
  const bun = () => BUN
  const noBun = () => null

  it('answers nothing when the runner file and Bun are both there, and the cause when either is not', () => {
    expect(engineStartRefusal(undefined, '/runner.ts', present, bun)).toBeNull()
    const noFile = engineStartRefusal(undefined, '/runner.ts', absent, bun)
    expect(noFile).toContain('the Atta Engine runner cannot start')
    expect(noFile).toContain('runner file /runner.ts is absent')
    expect(noFile).toContain('`--runner standalone`')
    const bunMissing = engineStartRefusal(undefined, '/runner.ts', present, noBun)
    expect(bunMissing).toContain('Bun is not on the PATH')
    expect(bunMissing).toContain('`--runner standalone`')
    for (const text of [noFile, bunMissing]) expect(text).not.toMatch(/fall(s|ing)? back/)
  })

  it('says a flow other than v1 needs the Engine instead of naming the standalone runner', () => {
    const text = engineStartRefusal('v2', '/runner.ts', absent, bun)
    expect(text).toContain('flow v2 needs the Engine')
    expect(text).not.toContain('--runner standalone')
    expect(engineStartRefusal('v1', '/runner.ts', absent, bun)).toContain('`--runner standalone`')
  })

  it('finds a plain bun executable on the PATH, and none where there is only a directory or a plain file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bun-lookup-'))
    try {
      const empty = join(dir, 'empty')
      const notExecutable = join(dir, 'plain')
      const withBun = join(dir, 'with-bun')
      mkdirSync(join(empty, 'bun'), { recursive: true })
      mkdirSync(notExecutable)
      writeFileSync(join(notExecutable, 'bun'), '')
      mkdirSync(withBun)
      writeFileSync(join(withBun, 'bun'), '')
      chmodSync(join(withBun, 'bun'), 0o755)
      expect(findBunOnPath([empty, notExecutable].join(delimiter))).toBeNull()
      expect(findBunOnPath([empty, notExecutable, withBun].join(delimiter))).toBe(join(withBun, 'bun'))
      expect(findBunOnPath('')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  for (const [cause, engine, expected] of [
    ['its runner file is absent', { exists: () => false, findBun: () => BUN }, 'runner file /runner.ts is absent'],
    ['Bun is not on the PATH', { exists: () => true, findBun: () => null }, 'Bun is not on the PATH']
  ] as const) {
    it(`refuses a run when ${cause}: no Issue assigned, no runner recorded, no loop started`, async () => {
      const assigned: number[] = []
      const recorded: string[] = []
      let spawned = 0
      let loops = 0
      await expect(
        runTask(
          { issue: 42, agent: 'claude' },
          fixture({
            runnerConfig: () => null,
            assignIssue: (issue) => void assigned.push(issue),
            recordRunner: (_issue, runner) => void recorded.push(runner),
            engine: {
              scriptPath: () => '/runner.ts',
              ...engine,
              spawn: async () => {
                spawned++
                return 0
              }
            },
            devReviewLoop: async () => {
              loops++
              return { task: 42, prNumber: 7, finalDecision: { type: 'publish' } }
            }
          })
        )
      ).rejects.toThrow(expected)
      expect(assigned).toEqual([])
      expect(recorded).toEqual([])
      expect(spawned).toBe(0)
      expect(loops).toBe(0)
    })
  }

  it('refuses a flow other than v1 with the flow message when the Engine cannot start', async () => {
    let loops = 0
    await expect(
      runTask(
        { issue: 42, agent: 'claude', runner: 'atta-engine', flow: 'v2' },
        fixture({
          engine: { scriptPath: () => '/runner.ts', exists: () => false, findBun: () => BUN, spawn: async () => 0 },
          devReviewLoop: async () => {
            loops++
            return { task: 42, prNumber: 7, finalDecision: { type: 'publish' } }
          }
        })
      )
    ).rejects.toThrow('flow v2 needs the Engine')
    expect(loops).toBe(0)
  })

  it('makes no check for a --rollback start, which restarts on the standalone runner', async () => {
    let checks = 0
    let loops = 0
    await runTask(
      { issue: 42, agent: 'claude', rollback: true },
      fixture({
        runnerConfig: () => null,
        engine: {
          exists: () => {
            checks++
            return false
          },
          findBun: () => {
            checks++
            return null
          }
        },
        backendRollback: async (issue, wiring) => {
          await wiring.startStandalone(issue)
          return { action: 'terminated' } as unknown as Awaited<ReturnType<NonNullable<RunTaskDeps['backendRollback']>>>
        },
        devReviewLoop: async () => {
          loops++
          return { task: 42, prNumber: 7, finalDecision: { type: 'publish' } }
        }
      })
    )
    expect(checks).toBe(0)
    expect(loops).toBe(1)
  })

  it('the real command exits 3 with the refusal before preparing, also with --background, when Bun is not on the PATH', async () => {
    const root = mkdtempSync(join(tmpdir(), 'runner-no-bun-'))
    try {
      writeFileSync(join(root, 'vinaya.config.json'), JSON.stringify({ logs: false }))
      for (const extra of [[], ['--background']]) {
        const result = await spawnBudgetedAsync(
          [
            process.execPath,
            join(import.meta.dir, '../../../../apps/cli/src/index.ts'),
            'task',
            'run',
            '--issue',
            '42',
            '--agent',
            'codex',
            ...extra
          ],
          { cwd: root, env: { ...stripVinayaEnv(), HOME: root, PATH: root } }
        )
        expect(result.status).toBe(3)
        expect(result.stderr).toContain('the Atta Engine runner cannot start: Bun is not on the PATH')
        expect(result.stderr).toContain('`--runner standalone`')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("task run's own check refuses an Engine start that cannot start, and makes none for standalone or --rollback", () => {
    const missing = { script: '/runner.ts', exists: () => false, findBun: () => BUN }
    const noBunOnPath = { script: '/runner.ts', exists: () => true, findBun: () => null }
    const ready = { script: '/runner.ts', exists: () => true, findBun: () => BUN }
    expect(engineStartRefusalForStart({ runner: 'atta-engine' }, missing)).toContain('runner file /runner.ts is absent')
    expect(engineStartRefusalForStart({ runner: 'atta-engine' }, noBunOnPath)).toContain('Bun is not on the PATH')
    expect(engineStartRefusalForStart({ runner: 'atta-engine', flow: 'v2' }, missing)).toContain(
      'flow v2 needs the Engine'
    )
    expect(engineStartRefusalForStart({ runner: 'atta-engine' }, ready)).toBeNull()
    const untouched = {
      script: '/runner.ts',
      exists: () => {
        throw new Error('unexpected Engine check')
      },
      findBun: () => {
        throw new Error('unexpected Engine check')
      }
    }
    expect(engineStartRefusalForStart({ runner: 'standalone' }, untouched)).toBeNull()
    expect(engineStartRefusalForStart({ runner: 'atta-engine', rollback: true }, untouched)).toBeNull()
    // The same text runTask throws, so both callers print one message.
    expect(engineStartRefusalForStart({ runner: 'atta-engine' }, missing)).toBe(
      engineStartRefusal(
        undefined,
        '/runner.ts',
        () => false,
        () => BUN
      )
    )
  })
})
