/**
 * The in-container entry of a layer-`G` Harbor trial. The `vinaya` Harbor
 * agent (`vinaya_harbor_agent.py`) runs it inside the task container, from
 * the Vinaya CLI unpacked at `/opt/vinaya`, on the one case the container
 * holds. It renders the case with the Vinaya renderer and runs the case
 * kind's live path in container mode, in the case repository at `/app`, on
 * the requested backend: a `change` case's Developer with the driver-run tool
 * host and its fake forge and a `review` case's reviewer, each through
 * `dispatchRole` on `standalone` or as the role's one-step Flow on the Atta
 * Engine runtime on `engine`, and an `answer` case's read-only turn. It writes
 * the agent part of the Vinaya trial record, naming its backend, the run's
 * usage and the role's agent stream to Harbor's agent log directory; the
 * task's verifier measures and grades the rest. The trial stops its role at
 * its own time limit (`--timeout-sec`), which the task sets below Harbor's
 * agent limit, so it still records what the role left; the stream is written
 * as it arrives and the usage even when the run throws.
 *
 * The case file holds the neutral case and only what the run needs from the
 * layer-`P` case of the same id. The neutral case carries fields only grading
 * reads — a review case's planted defects and adjudication, a change case's
 * hidden test names — so the run reads the file once and removes it before
 * the role starts.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DeveloperCapabilityCase } from '../../../tests/eval/developer-capability-suite'
import type { PatchRecord, ReviewCase } from '../../../tests/eval/reviewer-quality-suite'
import type { SourceCitationCase } from '../../../tests/eval/source-citation-suite'
import type { ReviewerRole } from '../review-result'
import type { NeutralCase } from './neutral-case'
import {
  type LoadedDevelopment,
  PRODUCTION_VINAYA_PROCESS_STEPS,
  type StepOneAdapter,
  type StepOneBackend,
  type StepOneCommandContext,
  type StepOneRunSuite,
  STEP_ONE_SUITE_LAYERS,
  type StepOneUsage,
  trialUsage,
  type VinayaProcessSteps,
  vinayaProcess
} from './step-one'
import { renderCase } from './vinaya-renderer'

/** What a layer-`P` case of the same id gives a container run, by the neutral case's kind. */
export type HarborCounterpart =
  | { kind: 'change'; id: string; pullRequest: number }
  | { kind: 'review'; id: string; role: ReviewerRole; baseCommit: string; patch: PatchRecord }
  | { kind: 'answer'; case: SourceCitationCase }

/** The case file the converter writes to `environment/case.json`, at `/case/case.json` in the container. */
export interface HarborCaseFile {
  schemaVersion: 1
  /** The layer-`G` suite, by its step-one name. */
  suite: StepOneRunSuite
  case: NeutralCase
  counterpart: HarborCounterpart
}

/**
 * The backends a Harbor trial runs a `change` or `review` case's role step on:
 * `standalone` dispatches the role as the standalone loop does; `engine` runs
 * it as a one-step Flow on the Atta Engine runtime. An `answer` case runs on
 * `standalone` only.
 */
export const HARBOR_TRIAL_BACKENDS = ['standalone', 'engine'] as const satisfies readonly StepOneBackend[]

/** The subscription-authenticated adapters a Harbor trial runs. */
export const HARBOR_TRIAL_ADAPTERS = ['claude-code', 'codex'] as const satisfies readonly StepOneAdapter[]

export interface HarborTrialOptions {
  casePath: string
  /** The case repository the role works in: `/app` in the container. */
  tree: string
  recordPath: string
  usagePath: string
  backend: string
  adapter: string
  /** The exact model id; an alias is not resolved. */
  model: string
  /** The trial's own time limit: when it is reached the role is stopped, and the run records what it has. */
  timeoutMs: number
  /** Where the role's agent stream is appended as it arrives; absent, `STREAM_FILE` beside the record. */
  streamPath?: string
  /**
   * Stops the role at the time limit. The command entry passes
   * `stopDescendants`; absent, the limit only marks the trial timed out.
   */
  stopRole?: () => void
}

/**
 * The role's agent stream in Harbor's agent log directory, one line as each
 * arrives: what is left of a trial stopped before it records anything.
 */
export const STREAM_FILE = 'vinaya-trial.txt'

/** The usage file's content: the run's `StepOneUsage`, and whether the trial reached its time limit. */
export type HarborTrialUsage = StepOneUsage & { timedOut: boolean }

/** A refused option is `refused`; any other failure is a run the Vinaya process could not record. */
export type HarborTrialOutcome =
  | { ok: true; timedOut?: true }
  | { ok: false; reason: string; refused?: true; timedOut?: true }

/** How long a stopped role has to exit after `SIGTERM` before it is sent `SIGKILL`. */
export const STOP_GRACE_MS = 10_000

/**
 * A process's fields from Linux's `/proc/<pid>/stat` after its command name,
 * which may hold spaces and parentheses: the state first, then the parent's
 * process id; its start time is the twentieth. `null` once it is gone.
 */
function statFields(pid: number | string, procRoot: string): string[] | null {
  try {
    const stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  } catch {
    return null
  }
}

/** Each live process below `root`, read from Linux's `/proc`; none where there is no `/proc`. */
export function descendantsOf(root: number, procRoot = '/proc'): number[] {
  if (!existsSync(procRoot)) return []
  const children = new Map<number, number[]>()
  for (const entry of readdirSync(procRoot)) {
    if (!/^\d+$/.test(entry)) continue
    const parent = Number(statFields(entry, procRoot)?.[1])
    if (!Number.isInteger(parent)) continue
    children.set(parent, [...(children.get(parent) ?? []), Number(entry)])
  }
  const found: number[] = []
  const pending = [root]
  while (pending.length > 0) {
    for (const child of children.get(pending.pop() as number) ?? []) {
      found.push(child)
      pending.push(child)
    }
  }
  return found
}

/**
 * Stops the role: sends `SIGTERM` to every process below this one, and
 * `SIGKILL` after `STOP_GRACE_MS` to those of them still running. The
 * standalone dispatch takes no time limit of its own, so the trial stops its
 * agent this way. A process is sent `SIGKILL` only while its start time is
 * the one it had when it was sent `SIGTERM`, so a process the run starts
 * afterwards to record the trial is never stopped, even on a reused id.
 */
export function stopDescendants(procRoot = '/proc'): void {
  const stopped = descendantsOf(process.pid, procRoot).map((pid) => ({ pid, start: statFields(pid, procRoot)?.[19] }))
  const signal = (pid: number, name: NodeJS.Signals) => {
    try {
      process.kill(pid, name)
    } catch {
      // Already gone.
    }
  }
  for (const { pid } of stopped) signal(pid, 'SIGTERM')
  setTimeout(() => {
    for (const { pid, start } of stopped) {
      if (start !== undefined && statFields(pid, procRoot)?.[19] === start) signal(pid, 'SIGKILL')
    }
  }, STOP_GRACE_MS).unref()
}

/** The development inputs one container trial runs on: its case and its layer-`P` counterpart alone. */
export function loadedFor(file: HarborCaseFile): LoadedDevelopment {
  const counterpart = file.counterpart
  const loaded: LoadedDevelopment = {
    suites: [{ suite: file.suite, taskIds: [file.case.id] }],
    developerCases: [],
    reviewerCases: [],
    neutralCases: { [file.suite]: [file.case] },
    sourceCitationCases: []
  }
  // A container run reads only these fields of each counterpart; no hidden
  // test, reference solution or expected finding reaches the container.
  if (counterpart.kind === 'change') {
    loaded.developerCases = [
      { id: counterpart.id, pullRequest: counterpart.pullRequest } as unknown as DeveloperCapabilityCase
    ]
  } else if (counterpart.kind === 'review') {
    loaded.reviewerCases = [
      {
        id: counterpart.id,
        role: counterpart.role,
        baseCommit: counterpart.baseCommit,
        patch: counterpart.patch,
        expected: null,
        objectives: []
      } as unknown as ReviewCase
    ]
  } else {
    loaded.sourceCitationCases = [counterpart.case]
  }
  return loaded
}

/**
 * Runs one Harbor trial of the case at `casePath`. A refused option, case or
 * render returns the refusal before any role starts; a run the Vinaya process
 * records as unavailable returns its reason. The usage file is written for
 * every run that started.
 */
export async function runHarborTrial(
  options: HarborTrialOptions,
  steps: VinayaProcessSteps = PRODUCTION_VINAYA_PROCESS_STEPS
): Promise<HarborTrialOutcome> {
  if (!(HARBOR_TRIAL_BACKENDS as readonly string[]).includes(options.backend))
    return {
      ok: false,
      refused: true,
      reason: `backend ${options.backend} is not one of ${HARBOR_TRIAL_BACKENDS.join(', ')}`
    }
  if (!(HARBOR_TRIAL_ADAPTERS as readonly string[]).includes(options.adapter))
    return {
      ok: false,
      refused: true,
      reason: `adapter ${options.adapter} is not one of ${HARBOR_TRIAL_ADAPTERS.join(', ')}`
    }
  if (options.model.trim() === '') return { ok: false, refused: true, reason: 'the exact model id is required' }
  const file = JSON.parse(readFileSync(options.casePath, 'utf8')) as HarborCaseFile
  rmSync(options.casePath, { force: true })
  if (file.schemaVersion !== 1 || STEP_ONE_SUITE_LAYERS[file.suite] !== 'G')
    return { ok: false, reason: `the case file names no layer-G suite: ${String(file.suite)}` }
  const rendered = renderCase(file.case)
  if (!rendered.ok) {
    const { code, field, detail } = rendered.refusal
    return { ok: false, reason: `the Vinaya renderer refused the case: ${code} at ${field}: ${detail}` }
  }
  const adapter = options.adapter as StepOneAdapter
  const streamPath = options.streamPath ?? join(dirname(options.recordPath), STREAM_FILE)
  const context: StepOneCommandContext = {
    repository: options.tree,
    developerBriefs: new Map(),
    models: { [adapter]: options.model },
    timeoutMs: options.timeoutMs,
    loaded: loadedFor(file),
    container: {
      workingTree: options.tree,
      recordPath: options.recordPath,
      backend: options.backend as StepOneBackend,
      streamPath
    }
  }
  mkdirSync(dirname(options.recordPath), { recursive: true })
  mkdirSync(dirname(options.usagePath), { recursive: true })
  mkdirSync(dirname(streamPath), { recursive: true })
  writeFileSync(streamPath, '')
  let timedOut = false
  const writeUsage = (usage: StepOneUsage) =>
    writeFileSync(options.usagePath, `${JSON.stringify({ ...usage, timedOut } satisfies HarborTrialUsage, null, 2)}\n`)
  const limited = (outcome: HarborTrialOutcome): HarborTrialOutcome =>
    timedOut ? { ...outcome, timedOut: true } : outcome
  // The role is stopped at the trial's limit; the run then records what the role left.
  const deadline = setTimeout(() => {
    timedOut = true
    options.stopRole?.()
  }, options.timeoutMs)
  // The reviewer suite reads a change under review from its own repository
  // root, which in the container is the unpacked Vinaya CLI with no history;
  // `GIT_DIR` points those reads at the case repository. The harness's own git
  // processes start from a fixed environment without it.
  const priorGitDir = process.env.GIT_DIR
  process.env.GIT_DIR = join(options.tree, '.git')
  const started = Date.now()
  try {
    const ran = await vinayaProcess(steps)(
      {
        trial: { suite: file.suite, adapter, taskId: file.case.id, attempt: 1 },
        neutralCase: file.case,
        input: rendered.input
      },
      context
    )
    writeUsage(ran.usage)
    return limited(ran.ok ? { ok: true } : { ok: false, reason: ran.unavailableReason })
  } catch (error) {
    // A run that throws still leaves its usage, read from the stream it appended.
    const lines = readFileSync(streamPath, 'utf8').split('\n').filter(Boolean)
    writeUsage({ ...trialUsage(adapter, null, lines), wallTimeMs: Date.now() - started })
    return limited({
      ok: false,
      reason: `the Vinaya process run failed: ${error instanceof Error ? error.message : String(error)}`
    })
  } finally {
    clearTimeout(deadline)
    if (priorGitDir === undefined) delete process.env.GIT_DIR
    else process.env.GIT_DIR = priorGitDir
  }
}

const flag = (argv: readonly string[], name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}

export const HARBOR_TRIAL_USAGE =
  'usage: harbor-trial.ts --case <case.json> --tree <dir> --record <file> --usage <file> --backend standalone|engine --adapter claude-code|codex --model <exact model id> --timeout-sec <n> [--stream <file>]'

/** The command entry: exit 0 when the run recorded its trial, 1 when it is unavailable, 2 on a refused option. */
export async function harborTrialCommand(
  argv: readonly string[],
  steps: VinayaProcessSteps = PRODUCTION_VINAYA_PROCESS_STEPS
): Promise<number> {
  const required = ['case', 'tree', 'record', 'usage', 'backend', 'adapter', 'model', 'timeout-sec'] as const
  const values = Object.fromEntries(required.map((name) => [name, flag(argv, name)]))
  const missing = required.filter((name) => values[name] === undefined)
  if (missing.length > 0) {
    process.stderr.write(`${HARBOR_TRIAL_USAGE}\nmissing: ${missing.map((name) => `--${name}`).join(', ')}\n`)
    return 2
  }
  // An empty value is what the agent's run command passes when the task names no trial limit.
  const timeoutSec = Number(values['timeout-sec'] || Number.NaN)
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    process.stderr.write(`${HARBOR_TRIAL_USAGE}\n--timeout-sec is not a positive number\n`)
    return 2
  }
  const stream = flag(argv, 'stream')
  const outcome = await runHarborTrial(
    {
      casePath: values.case as string,
      tree: values.tree as string,
      recordPath: values.record as string,
      usagePath: values.usage as string,
      backend: values.backend as string,
      adapter: values.adapter as string,
      model: values.model as string,
      timeoutMs: timeoutSec * 1000,
      ...(stream === undefined ? {} : { streamPath: stream }),
      stopRole: stopDescendants
    },
    steps
  )
  if (outcome.timedOut === true)
    process.stderr.write(`the role reached the trial's ${timeoutSec} s limit and was stopped\n`)
  if (outcome.ok) return 0
  process.stderr.write(`${outcome.reason}\n`)
  return outcome.refused === true ? 2 : 1
}

if (import.meta.main) {
  harborTrialCommand(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    })
}
