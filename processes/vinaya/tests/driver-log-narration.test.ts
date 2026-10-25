import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRunControl, type SpawnedProcessLike } from '@atta/executor-agent-spawn'
import { loopLogPathFor, narrateDriverEvent } from '../../../apps/cli/src/lib/loop-log'
import { loadProcess } from '../../../harness/dev-process/loader/load-process'
import type { ActionRegistry } from '../../../harness/dev-process/engine-runtime/run-process'
import {
  classifyDeveloperOutput,
  classifyGateResult,
  classifyReviewerOutputs,
  dispatchReviewers,
  type TaskInput
} from '../executing/actions'
import { narratingLog, runEngine, type EngineRunOptions } from '../bin/run-engine'
import { recordedHandoff } from './handoff-fakes'
import { confidentTurn, PASSING_FORGE_GATES } from './round-fakes'

const loaded = loadProcess(resolve(import.meta.dir, '..'))
const repoRoot = resolve(import.meta.dir, '../../..')
const CLI_ENTRY = join(repoRoot, 'apps', 'cli', 'src', 'index.ts')
const TASK = 7

// --- the scripted round: what each fake agent prints, the same on both runners ----------------

const review = (role: string) => ({
  reviewResult: {
    schemaVersion: 1,
    role,
    status: 'completed',
    headSha: 'abc',
    manifestDigest: 'd',
    summary: 'fine',
    findings: [],
    objectiveResults: []
  }
})

const assistant = (content: unknown[]) => JSON.stringify({ type: 'assistant', message: { content } })
const finished = (output: unknown) => JSON.stringify({ type: 'result', session_id: 's', structured_output: output })

/** Each turn's Claude stream records, by the role the standalone dispatch gives the turn. */
const SCRIPT: Record<'developer' | 'code-reviewer' | 'security', string[]> = {
  developer: [
    '{"type":"system","subtype":"init","session_id":"s"}',
    assistant([
      { type: 'text', text: 'Reading the brief.' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git status' } }
    ]),
    assistant([{ type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'narrateDriverEvent' } }]),
    finished(confidentTurn)
  ],
  'code-reviewer': [
    '{"type":"system","subtype":"init","session_id":"s"}',
    assistant([{ type: 'text', text: 'Reviewing the diff against the objectives.' }]),
    finished(review('code-reviewer'))
  ],
  security: [
    '{"type":"system","subtype":"init","session_id":"s"}',
    assistant([{ type: 'text', text: 'Checking the surface for secrets.' }]),
    finished(review('security-reviewer'))
  ]
}

/** The standalone role name of the Engine launch generated under `generated/<dir>`. */
const ROLE_OF_LAUNCH: Record<string, keyof typeof SCRIPT> = {
  developer: 'developer',
  'code-reviewer': 'code-reviewer',
  'security-reviewer': 'security'
}

const withoutTimestamp = (line: string): string => line.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z {2}/, '')

const linesOf = (path: string): string[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map(withoutTimestamp)

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

async function waitFor(check: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await sleep(10)
  }
  return check()
}

// --- the standalone side: the CLI's own dispatch of each turn, on a fake `claude` -------------

function pathWithoutRealVendors(): string {
  return (process.env.PATH ?? '')
    .split(':')
    .filter(Boolean)
    .filter((dir) => !['claude', 'codex'].some((vendor) => existsSync(join(dir, vendor))))
    .join(':')
}

function withoutVinayaEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  for (const key of Object.keys(out)) if (key.startsWith('VINAYA_') || key.startsWith('AEG_')) delete out[key]
  delete out.GITHUB_ACTIONS
  return out
}

/**
 * The lines the standalone dispatch writes about its own launch, not about the agent's stream: the permission
 * policy it generates, its start, and the session it records. The Engine's executor launches the agent instead, so
 * these have no Engine counterpart; every other line of the standalone log is compared.
 */
const STANDALONE_LAUNCH_LINE = /^[>+x~#] \S+(?: \S+)? {3}(?:permission policy |started$|resumable — )/

/** Dispatches each scripted turn through `vinaya dispatch` and returns the driver log it wrote. */
function standaloneRound(): string {
  const root = mkdtempSync(join(tmpdir(), 'narration-standalone-'))
  const home = join(root, 'home')
  const cwd = join(root, 'cwd')
  const bin = join(root, 'bin')
  for (const dir of [home, cwd, bin]) mkdirSync(dir, { recursive: true })
  const logPath = join(root, 'driver.log')
  const promptFile = join(cwd, 'prompt.txt')
  writeFileSync(promptFile, 'The scripted turn.\n')
  for (const role of Object.keys(SCRIPT) as Array<keyof typeof SCRIPT>) {
    const stream = join(root, `${role}.jsonl`)
    writeFileSync(stream, `${SCRIPT[role].join('\n')}\n`)
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\ncat > /dev/null\ncat '${stream}'\nexit 0\n`)
    chmodSync(join(bin, 'claude'), 0o755)
    execFileSync(
      'bun',
      [CLI_ENTRY, 'dispatch', role, '--agent', 'claude', '--prompt-file', promptFile, '--role-log-path', logPath],
      {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...withoutVinayaEnv(process.env), HOME: home, PATH: `${bin}:${pathWithoutRealVendors()}` },
        timeout: 60_000
      }
    )
  }
  return logPath
}

// --- the Engine side: the runner on the same turns, its executor launching a fake agent ----------

/** A fake agent printing `lines`; it holds its exit until `holdUntil` resolves, so a test can look while it runs. */
function fakeAgent(lines: readonly string[], holdUntil: () => Promise<void>): SpawnedProcessLike {
  const stdout: Array<(chunk: string) => void> = []
  const close: Array<(code: number | null) => void> = []
  const print = (text: string) => {
    for (const listener of stdout) listener(text)
  }
  return {
    stdin: {
      write: () => {},
      end: () => {
        void (async () => {
          await sleep(0)
          // One record split across two chunks, as a pipe may deliver it.
          const [first = '', ...rest] = lines
          print(first.slice(0, 10))
          print(`${first.slice(10)}\n`)
          for (const line of rest.slice(0, -1)) print(`${line}\n`)
          await holdUntil()
          print(`${rest.at(-1) ?? ''}\n`)
          for (const listener of close) listener(0)
        })()
      }
    },
    stdout: { on: (_event, listener) => void stdout.push(listener as (chunk: string) => void) },
    stderr: { on: () => {} },
    on: ((event: string, listener: (code: number | null) => void) => {
      if (event === 'close') close.push(listener)
    }) as SpawnedProcessLike['on'],
    kill: () => {
      for (const listener of close) listener(null)
    }
  } as SpawnedProcessLike
}

const STUB_ACTIONS = [
  'vinaya.prepare-run',
  'vinaya.reconcile-external-state',
  'vinaya.prepare-sources',
  'vinaya.choose-start',
  'vinaya.validate-developer-output',
  'vinaya.classify-developer-output',
  'harness.run-gates',
  ...Object.keys(PASSING_FORGE_GATES),
  'vinaya.assess-gate',
  'vinaya.classify-gate-result',
  'vinaya.run-security-scan',
  'vinaya.dispatch-reviewers',
  'vinaya.validate-reviewer-outputs',
  'vinaya.classify-reviewer-outputs',
  'vinaya.assess-round',
  'vinaya.build-revision-handoff',
  'vinaya.run-live-checks',
  'vinaya.classify-live-result',
  'harness.publish'
]

function engineOptions(spawnFn: EngineRunOptions['spawnFn'], emitted: unknown[]): EngineRunOptions {
  const actions: ActionRegistry = Object.fromEntries(
    STUB_ACTIONS.map((name) => [
      name,
      async (context) => {
        if (name === 'vinaya.classify-gate-result') return classifyGateResult(context)
        if (name === 'vinaya.classify-developer-output') return classifyDeveloperOutput(context)
        if (name === 'vinaya.classify-reviewer-outputs') return classifyReviewerOutputs(context)
        if (name === 'vinaya.dispatch-reviewers') return dispatchReviewers()
        return { exitCode: 0 }
      }
    ])
  )
  return {
    args: { task: TASK, agent: 'claude', dryRun: false },
    process: loaded,
    repoRoot,
    runtimeDir: mkdtempSync(join(tmpdir(), 'narration-engine-')),
    loopId: 'loop-under-test',
    taskInput: {
      inputVersions: () => ({ briefHash: null, objectivesVersion: null, rulingOrdinal: 0, policyDigest: 'test' })
    } as unknown as TaskInput,
    handoffDeps: recordedHandoff().deps,
    actions,
    sink: { log: (event: unknown) => void emitted.push(event), drain: async () => {} },
    startHost: async () => ({ close: async () => {} }),
    devToolsContext: {} as never,
    control: createRunControl(),
    out: () => {},
    lifecycle: { handleSignals: false, setHeartbeat: () => () => {} },
    spawnFn
  }
}

/** The role a launch was generated for, read from its settings path as the runner's own wrappers read it. */
const launchRole = (args: readonly string[]): keyof typeof SCRIPT | undefined =>
  ROLE_OF_LAUNCH[(args[args.indexOf('--settings') + 1] ?? '').split('/').at(-2) ?? '']

describe('the Engine runner narrates a run into the driver log as the standalone loop does', () => {
  test('the same scripted Developer, code-review and security-review turns give the same driver-log lines on both runners', async () => {
    const standalone = linesOf(standaloneRound())

    const emitted: unknown[] = []
    const options = engineOptions((_command, args) => {
      const role = launchRole(args)
      return fakeAgent(role ? SCRIPT[role] : [], async () => {})
    }, emitted)
    const result = await runEngine(options)
    expect(result.exitCode).toBe(0)
    const engine = linesOf(loopLogPathFor(null, TASK, options.runtimeDir))

    // The turns' lines: each line labelled with one of the three roles, and the detail lines beneath it, in order.
    const turnLines = (lines: readonly string[]) =>
      lines.filter((line) => /^[>+x~#] (?:Developer|Code review|Security) {3}/.test(line) || line.startsWith('· '))
    const standaloneTurns = turnLines(standalone).filter((line) => !STANDALONE_LAUNCH_LINE.test(line))
    expect(standaloneTurns).toContain('· Reading the brief.')
    expect(standaloneTurns).toContain('> Security   Writing')
    expect(turnLines(engine)).toEqual(standaloneTurns)

    // Every Log event the run emitted is narrated with the standalone's own function and earlier-events context.
    const expectedPath = join(mkdtempSync(join(tmpdir(), 'narration-expected-')), 'driver.log')
    const earlier: unknown[] = []
    for (const event of emitted) {
      narrateDriverEvent(expectedPath, event, earlier, TASK)
      earlier.push(event)
    }
    const eventLines = linesOf(expectedPath)
    expect(eventLines.length).toBeGreaterThan(0)
    const loopLines = engine.filter((line) => /^[>+x~#] Loop {3}/.test(line))
    expect(loopLines).toEqual(eventLines)
  }, 120_000)

  test("agent lines appear in the driver log while the fake agent is still running, and the executor's reader still gets every byte", async () => {
    const seenWhileRunning: Record<string, boolean> = {}
    const emitted: unknown[] = []
    let logPath = ''
    const options = engineOptions((_command, args) => {
      const role = launchRole(args)
      return fakeAgent(role ? SCRIPT[role] : [], async () => {
        if (!role) return
        const words =
          role === 'developer' ? 'Reading the brief.' : (SCRIPT[role][1] ?? '').match(/"text":"([^"]+)"/)?.[1]
        seenWhileRunning[role] = await waitFor(
          () => existsSync(logPath) && readFileSync(logPath, 'utf8').includes(`· ${words}`)
        )
      })
    }, emitted)
    logPath = loopLogPathFor(null, TASK, options.runtimeDir)
    const result = await runEngine(options)
    expect(result.exitCode).toBe(0)
    expect(seenWhileRunning).toEqual({ developer: true, 'code-reviewer': true, security: true })
    // The agents' structured results still reached their steps: the run published on both clean verdicts.
    const trace = JSON.parse(readFileSync(result.tracePath, 'utf8')) as { verdicts: Record<string, { ok?: boolean }> }
    expect(trace.verdicts['code-review']?.ok).toBe(true)
    expect(trace.verdicts['security-review']?.ok).toBe(true)
  }, 60_000)
})

describe('the narrating Log sink', () => {
  test('narrates each event after it is emitted, with the events before it as context, once', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'narration-sink-')), 'driver.log')
    const calls: string[] = []
    const contexts: number[] = []
    const log = narratingLog(
      (event) => calls.push(`log:${(event as { event: string }).event}`),
      path,
      TASK,
      (_path, event, earlier) => {
        calls.push(`narrate:${(event as { event: string }).event}`)
        contexts.push(earlier.length)
      }
    )
    log({ event: 'round_started' })
    log({ event: 'round_ended' })
    expect(calls).toEqual(['log:round_started', 'narrate:round_started', 'log:round_ended', 'narrate:round_ended'])
    expect(contexts).toEqual([0, 1])
  })

  test("a round's end states the confidence its gate read recorded, as the standalone's narration does", () => {
    const path = join(mkdtempSync(join(tmpdir(), 'narration-sink-')), 'driver.log')
    const log = narratingLog(() => {}, path, TASK)
    const base = { kind: 'dev_review_loop', payload: {}, loop_id: 'l', task: TASK, round: 1 }
    log({ ...base, event: 'round_started' })
    log({ ...base, event: 'gate_result_read', green: true, confidence_value: 90 })
    log({ ...base, event: 'round_ended', outcome: 'green' })
    const expectedPath = join(mkdtempSync(join(tmpdir(), 'narration-expected-')), 'driver.log')
    const events = [
      { ...base, event: 'round_started' },
      { ...base, event: 'gate_result_read', green: true, confidence_value: 90 },
      { ...base, event: 'round_ended', outcome: 'green' }
    ]
    for (const [i, event] of events.entries()) narrateDriverEvent(expectedPath, event, events.slice(0, i), TASK)
    expect(linesOf(path)).toEqual(linesOf(expectedPath))
    expect(linesOf(path)).toHaveLength(3)
    expect(linesOf(path)[2]).toContain('Confidence: 90.')
  })

  test('a narration that throws is dropped, and the event still reaches the sink', () => {
    const emitted: unknown[] = []
    const log = narratingLog(
      (event) => emitted.push(event),
      join(tmpdir(), 'unused.log'),
      TASK,
      () => {
        throw new Error('narration broke')
      }
    )
    expect(() => log({ event: 'round_started' })).not.toThrow()
    expect(emitted).toEqual([{ event: 'round_started' }])
  })
})
