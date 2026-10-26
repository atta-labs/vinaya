import { fixtureDir } from '../../../apps/cli/tests/lib/test-temp-fixture'
import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRunControl, type SpawnedProcessLike } from '@atta/executor-agent-spawn'
import { loopLogPathFor, narrateDriverEvent } from '../../../apps/cli/src/lib/loop-log'
import {
  cleanupWorlds,
  makeInProcessDeps,
  makeWorld,
  runLoopInProcess,
  taskRunDir
} from '../../../apps/cli/tests/lib/dev-review-loop-harness'
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
import { records, replay, TASK as REPLAY_TASK, type Step } from './replay-world'
import { confidentTurn, PASSING_FORGE_GATES } from './round-fakes'

// The loop harness's worlds live in the OS temp dir; they are removed once this file's tests have run.
afterAll(cleanupWorlds)

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

// --- the standalone side: the standalone loop, each turn launched by the CLI's own dispatch on a fake `claude` -----

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
 * Runs one turn through the standalone dispatch (`vinaya dispatch <role> --role-log-path`) on a fake `claude` that
 * prints `records`, so the role's lines reach `roleLogPath` exactly as the standalone dispatch writes them.
 */
function standaloneDispatch(
  role: string,
  records: readonly Record<string, unknown>[],
  roleLogPath: string,
  env: NodeJS.ProcessEnv
): void {
  const root = fixtureDir(`narration-${role}-`)
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  for (const dir of [home, bin]) mkdirSync(dir, { recursive: true })
  const stream = join(root, 'stream.jsonl')
  writeFileSync(stream, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\ncat > /dev/null\ncat '${stream}'\nexit 0\n`)
  chmodSync(join(bin, 'claude'), 0o755)
  const promptFile = join(root, 'prompt.txt')
  writeFileSync(promptFile, 'The scripted turn.\n')
  execFileSync(
    'bun',
    [CLI_ENTRY, 'dispatch', role, '--agent', 'claude', '--prompt-file', promptFile, '--role-log-path', roleLogPath],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...withoutVinayaEnv(env), HOME: home, PATH: `${bin}:${pathWithoutRealVendors()}` },
      timeout: 60_000
    }
  )
}

/** The replay world's recorded stream for each standalone role's turn. */
const STEP_OF_DISPATCH: Record<string, Step> = {
  developer: 'develop',
  'code-reviewer': 'code-review',
  security: 'security-review'
}

/**
 * The standalone loop's driver log for one green round: the loop itself (`runLoopInProcess`), its forge faked by the
 * loop harness, each turn launched by the real standalone dispatch printing the replay world's recorded stream.
 */
async function standaloneRound(): Promise<string[]> {
  const world = makeWorld()
  const fakes = makeInProcessDeps(world)
  const outer = { ...process.env }
  await runLoopInProcess(world, undefined, {
    dispatchRole: async (role, agent, prompt, opts) => {
      const step = STEP_OF_DISPATCH[role]
      if (step && opts.roleLogPath) standaloneDispatch(role, records('claude', step), opts.roleLogPath, outer)
      // The turn's outcome is the harness's own: a completed turn, then two clean reviews.
      return fakes.dispatchRole!(role, agent, prompt, opts)
    }
  })
  return linesOf(join(taskRunDir(world), 'output', 'driver.log'))
}

/**
 * The lines the standalone dispatch writes about its own launch, not about the agent's stream: the permission
 * policy it generates, its start, and the session it records. The Engine's executor launches the agent instead.
 */
const STANDALONE_LAUNCH_LINE =
  /^> (?:Developer|Code review|Security) {3}(?:permission policy v\d+ written to |started$|resumable — session recorded )/

/**
 * The standalone driver's own progress lines, written with `appendDriverLine` rather than narrated from a Log event:
 * the Engine runner writes its own milestone lines in their place.
 */
const STANDALONE_DRIVER_LINE =
  /^(?:# Loop {3}(?:Developer starting round \d+ with claude|Reviewers starting round \d+)|> Loop {3}(?:security_scan|review_bound): .*)$/

/** A round's measured length, the one value in a narrated line that is a clock reading. */
const withoutDuration = (line: string): string => line.replace(/ after \d+m \d+s:/, ' after <duration>:')

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
    runtimeDir: fixtureDir('narration-engine-'),
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
  test('one scripted round on the standalone loop and on the Engine runner writes the same driver-log lines', async () => {
    const standalone = await standaloneRound()
    const engineRun = await replay({ vendor: 'claude' })
    expect(engineRun.trace.outcome).toBe('completed')
    const engine = linesOf(loopLogPathFor(null, REPLAY_TASK, engineRun.runtimeDir))

    // The Engine's file is the standalone's, line for line, timestamps and the round's clock reading removed, with
    // each difference named here: nothing else is dropped from either file.
    const fromStandalone = standalone
      .filter((line) => !STANDALONE_LAUNCH_LINE.test(line) && !STANDALONE_DRIVER_LINE.test(line))
      .map((line) => (line === '# Loop   run started' ? '# Engine Runner   run started' : line))
    const engineMilestones = [
      // The Engine's first line names the flow the run runs; the standalone loop runs only the default.
      `engine runner: task ${REPLAY_TASK}, flow v1`,
      `no checkpoint; starting fresh on branch task/issue-${REPLAY_TASK}`,
      'driver exited (finished, publish); driver lock cleared'
    ]
    // The standalone writes `driver_exited` to the Log without narrating it; the Engine narrates every event.
    const engineOnlyNarration = ['+ Loop   The driver finished.']
    const expected = [
      engineMilestones[0],
      fromStandalone[0],
      engineMilestones[1],
      ...fromStandalone.slice(1),
      ...engineOnlyNarration,
      engineMilestones[2]
    ].map((line) => withoutDuration(line ?? ''))
    expect(engine.map(withoutDuration)).toEqual(expected)
    // The comparison covers each turn and each narrated event.
    expect(expected).toContain('> Developer   Running ')
    expect(expected).toContain('> Security   Reading ')
    expect(expected).toContain('+ Loop   Round 1 verdicts: The code reviewer approved; the security reviewer approved.')
    // The launch lines the standalone's filter removed are exactly the three each of its three turns wrote.
    expect(standalone.filter((line) => STANDALONE_LAUNCH_LINE.test(line))).toHaveLength(9)
  }, 200_000)

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
    const path = join(fixtureDir('narration-sink-'), 'driver.log')
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

  test('narrates a conflict re-entry with no earlier events, as the standalone watching driver does', () => {
    const contexts: number[] = []
    const log = narratingLog(
      () => {},
      join(tmpdir(), 'unused.log'),
      TASK,
      (_path, _event, earlier) => void contexts.push(earlier.length)
    )
    log({ event: 'round_started' })
    log({ event: 'conflict_reentry' })
    log({ event: 'round_started' })
    expect(contexts).toEqual([0, 0, 2])
  })

  test("a round's end states the confidence its gate read recorded, as the standalone's narration does", () => {
    const path = join(fixtureDir('narration-sink-'), 'driver.log')
    const log = narratingLog(() => {}, path, TASK)
    const base = { kind: 'dev_review_loop', payload: {}, loop_id: 'l', task: TASK, round: 1 }
    log({ ...base, event: 'round_started' })
    log({ ...base, event: 'gate_result_read', green: true, confidence_value: 90 })
    log({ ...base, event: 'round_ended', outcome: 'green' })
    const expectedPath = join(fixtureDir('narration-expected-'), 'driver.log')
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
