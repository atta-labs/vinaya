/**
 * The verifier and the oracle of a layer-`G` Harbor trial. The converter
 * (`harbor-tasks.ts`) bundles this module into every task folder twice, as
 * `tests/grade.js` and `solution/oracle.js`, with the Vinaya renderer version
 * written in as a literal, so neither script reads a repository file.
 *
 * A trial's Vinaya trial record has two parts. The agent part is what the
 * Vinaya run in the container recorded (`harbor-trial.ts`): the pull request,
 * the reviews, the turn result, the receipts, the trace and the effects. The
 * measured part is what the verifier measures in the container itself, never
 * read from the agent: the tree's change against the base commit and the
 * hidden tests' results. `gradeTrial` merges the two with the harness's own
 * rendering of the case, extracts the neutral outcomes with the Vinaya
 * renderer and grades them with the generic graders alone: reward `1` exactly
 * when every generic grader passes, `0` otherwise.
 */

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  outcomeKey,
  outcomesOf,
  runTests,
  type TestOutcomes,
  testDigest
} from '../../../tests/eval/developer-capability-suite'
import { type FixtureEntry, referenceRecord } from '../../../tests/eval/vinaya-trial-records'
import { stripVinayaEnv } from '../../../tests/lib/process-fixture'
import { GENERIC_GRADERS } from './generic-graders'
import { canonicalJson, type NeutralCase, validateNeutralCase } from './neutral-case'
import type { TestResult } from './neutral-outcomes'
import { git } from './staging'
import { extractOutcomes, renderCase, VINAYA_RENDERER_VERSION, type VinayaTrialRecord } from './vinaya-renderer'

/** The agent part's file in Harbor's agent log directory, `/logs/agent` in the container. */
export const AGENT_RECORD_FILE = 'vinaya-trial-record.json'

/** The Vinaya run's usage (`StepOneUsage`), beside the agent part. */
export const AGENT_USAGE_FILE = 'vinaya-usage.json'

/** The longest the hidden test files of one trial may run. */
export const HIDDEN_TEST_BUDGET_MS = 1_200_000

/** The hidden-test runners' standard output, kept in Harbor's verifier log directory, `/logs/verifier`. */
export const HIDDEN_TEST_STDOUT_FILE = 'hidden-tests-stdout.txt'

/** The hidden-test runners' standard error, beside their standard output. */
export const HIDDEN_TEST_STDERR_FILE = 'hidden-tests-stderr.txt'

/** Receives one hidden-test runner's output once it exits, with the test file it ran. */
export type RunnerOutputSink = (file: string, output: { stdout: string; stderr: string }) => void

/**
 * A sink that keeps each runner's output, headed by its test file, in the two
 * files of `directory`, emptied first, and prints the standard output and the
 * standard error with `print`; the verifier prints to its own standard output,
 * which Harbor writes to `test-stdout.txt`.
 */
export function runnerOutputLog(
  directory: string,
  print: (text: string) => void = (text) => process.stdout.write(text)
): RunnerOutputSink {
  mkdirSync(directory, { recursive: true })
  const stdoutPath = join(directory, HIDDEN_TEST_STDOUT_FILE)
  const stderrPath = join(directory, HIDDEN_TEST_STDERR_FILE)
  writeFileSync(stdoutPath, '')
  writeFileSync(stderrPath, '')
  const block = (file: string, text: string) => `== ${file}\n${text}${text === '' || text.endsWith('\n') ? '' : '\n'}`
  return (file, { stdout, stderr }) => {
    appendFileSync(stdoutPath, block(file, stdout))
    appendFileSync(stderrPath, block(file, stderr))
    print(block(`${file} (stdout)`, stdout))
    print(block(`${file} (stderr)`, stderr))
  }
}

/** What the verifier reads from the task's `tests/` folder besides the hidden test files under `tests/hidden/`. */
export interface GradingSpec {
  schemaVersion: 1
  suite: string
  case: NeutralCase
  /**
   * The repository-relative test files the verifier writes into the tree from
   * `tests/hidden/<path>` and runs: the hidden test files at the reference
   * commit and the pinned pass-to-pass files at the base commit, as the host
   * grading copy holds them. Empty for a case with no hidden tests.
   */
  testFiles: string[]
}

/** The two facts the verifier measures in the container. */
export type MeasuredPart = Pick<VinayaTrialRecord, 'measuredChange' | 'hiddenTests'>

/** The reference outcome the oracle records, kept in the task's `solution/` folder. */
export interface OracleSpec {
  schemaVersion: 1
  suite: string
  case: NeutralCase
  reference: FixtureEntry['reference']
}

export interface TrialGrade {
  reward: 0 | 1
  /** Why the reward is `0` without a grader verdict: no agent record, or one that cannot be extracted. */
  reason: string | null
  verdicts: Record<string, { verdict: string; reason?: string }>
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** The kinds of case that produce a change, and so carry the measured part. */
const producing = (c: NeutralCase) => c.kind === 'change' || c.kind === 'loop'

/** A record split into what the agent's run records and what the verifier measures. */
export function splitRecord(record: VinayaTrialRecord): { agent: VinayaTrialRecord; measured: MeasuredPart } {
  return {
    agent: { ...record, measuredChange: null, hiddenTests: null },
    measured: { measuredChange: record.measuredChange ?? null, hiddenTests: record.hiddenTests ?? null }
  }
}

/** The tree's committed change against the base, measured exactly as the container run measures its own commit. */
export function measureChange(tree: string, base: string): NonNullable<VinayaTrialRecord['measuredChange']> {
  const head = git(tree, ['rev-parse', 'HEAD']).trim()
  return {
    base,
    head,
    patchDigest: sha256(git(tree, ['diff', '--binary', base, head])),
    changedPaths: git(tree, ['diff', '--name-only', base, head]).split('\n').filter(Boolean)
  }
}

/** Each hidden test of the case with its result in the run, named as the case names it; a test that did not run is `not-run`. */
export function neutralTestResults(c: NeutralCase, outcomes: TestOutcomes): TestResult[] {
  if (!producing(c)) return []
  const tests = (c as Extract<NeutralCase, { kind: 'change' | 'loop' }>).hiddenTests
  return tests.map((test) => {
    // A pass-to-pass test is named by its name digest already, a fail-to-pass test by its name.
    const name = test.expectation === 'fail-to-pass' ? testDigest(test.name) : test.name
    const outcome = outcomes[outcomeKey(test.path, name)]
    const result = outcome === undefined ? 'not-run' : outcome === 'skip' ? 'skipped' : outcome
    return { path: test.path, name: test.name, result }
  })
}

/**
 * A runner launch with vitest under Node: a package whose `test` script names
 * vitest runs `node node_modules/vitest/vitest.mjs`, never vitest under the Bun
 * runtime, which loads no tests. Any other runner launches as it is.
 */
export function underNode(command: readonly string[]): string[] {
  const [runner, ...rest] = command
  if (runner === undefined || !/(^|\/)node_modules\/\.bin\/vitest$/.test(runner)) return [...command]
  return ['node', join(dirname(dirname(runner)), 'vitest', 'vitest.mjs'), ...rest]
}

/**
 * Whether a file of `testFiles` is a test file a runner is handed, by its
 * path: `.test.`, `_test_`, `.spec.` or `_spec_`. Every other file — a shard
 * list, a helper, a fixture — is only written into the tree, where the tests
 * read it.
 */
export function isTestFile(path: string): boolean {
  return ['.test.', '_test_', '.spec.', '_spec_'].some((marker) => path.includes(marker))
}

/**
 * Runs the case's hidden tests on the tree's head: writes each file from
 * `testsDirectory/hidden/<path>` into the tree, then runs each test file in a
 * runner of its own, with its package's own runner as the host grading copy
 * does, within what is left of the budget, and maps the joined results as the
 * host maps them. One runner per file keeps one file's state, and a runner
 * that loads no file, from deciding another file's results. Each runner's
 * output goes to `output` when given.
 */
export async function runHiddenTests(
  tree: string,
  testsDirectory: string,
  spec: GradingSpec,
  budgetMs = HIDDEN_TEST_BUDGET_MS,
  output?: RunnerOutputSink
): Promise<NonNullable<VinayaTrialRecord['hiddenTests']>> {
  for (const path of spec.testFiles) {
    const target = join(tree, path)
    mkdirSync(dirname(target), { recursive: true })
    // A link the role left at the path is replaced, never written through.
    rmSync(target, { force: true })
    writeFileSync(target, readFileSync(join(testsDirectory, 'hidden', path)))
  }
  const deadline = Date.now() + budgetMs
  const results: Awaited<ReturnType<typeof runTests>> = []
  for (const path of spec.testFiles.filter(isTestFile)) {
    const left = deadline - Date.now()
    if (left <= 0) throw new Error(`the hidden tests ran past their ${budgetMs} ms budget`)
    results.push(
      ...(await runTests(
        tree,
        [path],
        left,
        (command) => ({
          command: underNode(command),
          env: stripVinayaEnv()
        }),
        undefined,
        output === undefined ? undefined : ({ stdout, stderr }) => output(path, { stdout, stderr })
      ))
    )
  }
  return {
    revision: git(tree, ['rev-parse', 'HEAD']).trim(),
    results: neutralTestResults(spec.case, outcomesOf(results))
  }
}

/** The measured part of a trial: a producing case's change and hidden-test results; nothing for any other kind. */
export async function measureTrial(
  tree: string,
  testsDirectory: string,
  spec: GradingSpec,
  output?: RunnerOutputSink
): Promise<MeasuredPart> {
  if (!producing(spec.case)) return { measuredChange: null, hiddenTests: null }
  const measuredChange = measureChange(tree, spec.case.baseRevision)
  return {
    measuredChange,
    hiddenTests: await runHiddenTests(tree, testsDirectory, spec, HIDDEN_TEST_BUDGET_MS, output)
  }
}

/**
 * Grades one trial: the agent part merged with the measured part, its
 * renderer version stated by the harness and its process input the harness's
 * own rendering of the case, which the agent part must equal. A missing or
 * unusable agent part, or a record the renderer cannot extract, rewards `0`
 * with its reason; otherwise the reward is `1` exactly when every generic
 * grader passes.
 */
export async function gradeTrial(spec: GradingSpec, agent: unknown, measured: MeasuredPart): Promise<TrialGrade> {
  const refused = (reason: string): TrialGrade => ({ reward: 0, reason, verdicts: {} })
  const validated = validateNeutralCase(spec.case)
  if (!validated.ok) return refused(`the case is invalid at ${validated.refusal.path}`)
  const rendered = renderCase(validated.value)
  if (!rendered.ok)
    return refused(`the Vinaya renderer refused the case: ${rendered.refusal.code} at ${rendered.refusal.field}`)
  if (agent === null || agent === undefined) return refused('no agent record: the Vinaya run recorded no trial')
  if (typeof agent !== 'object' || Array.isArray(agent)) return refused('the agent record is not an object')
  const recorded = agent as VinayaTrialRecord
  if (canonicalJson(recorded.input ?? null) !== canonicalJson(rendered.input)) {
    return refused('the agent record ran on another process input than the harness renders for this case')
  }
  const record: VinayaTrialRecord = {
    ...recorded,
    rendererVersion: VINAYA_RENDERER_VERSION,
    input: rendered.input,
    measuredChange: measured.measuredChange,
    hiddenTests: measured.hiddenTests
  }
  const extracted = extractOutcomes(record)
  if (!extracted.ok) {
    const { code, field, detail } = extracted.refusal
    return refused(`the trial record could not be extracted: ${code} at ${field}: ${detail}`)
  }
  const verdicts: TrialGrade['verdicts'] = {}
  for (const grader of GENERIC_GRADERS) {
    const verdict = await grader.grade({ case: validated.value, outcomes: extracted.outcomes })
    verdicts[grader.identity.id] =
      verdict.verdict === 'pass' ? { verdict: 'pass' } : { verdict: verdict.verdict, reason: verdict.reason }
  }
  const reward = Object.values(verdicts).every((v) => v.verdict === 'pass') ? 1 : 0
  return { reward, reason: null, verdicts }
}

/** Writes the reward and every verdict where Harbor's verifier reads them. */
export function writeGrade(outDirectory: string, grade: TrialGrade): void {
  mkdirSync(outDirectory, { recursive: true })
  writeFileSync(join(outDirectory, 'reward.txt'), String(grade.reward))
  writeFileSync(join(outDirectory, 'grades.json'), `${JSON.stringify(grade, null, 2)}\n`)
}

/** The agent part at `agentDirectory`, or `null` when the run wrote none. */
export function readAgentRecord(agentDirectory: string): unknown {
  const path = join(agentDirectory, AGENT_RECORD_FILE)
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

/**
 * The agent part the oracle records for the reference outcome, bound to the
 * tree's head: for a producing case, the pull request's head, base and diff
 * digest are the commit `solution/solve.sh` just made, its body the
 * beyond-Surface record of that commit's changed paths; for any other kind the
 * reference findings or answer.
 */
export function oracleAgentPart(tree: string, spec: OracleSpec): VinayaTrialRecord {
  const rendered = renderCase(spec.case)
  if (!rendered.ok) throw new Error(`the Vinaya renderer refused the case: ${rendered.refusal.code}`)
  if (!producing(spec.case)) return splitRecord(referenceRecord(spec, rendered.input)).agent
  const measured = measureChange(tree, spec.case.baseRevision)
  const record = referenceRecord(
    { case: spec.case, reference: { ...spec.reference, head: measured.head, changedPaths: measured.changedPaths } },
    rendered.input
  )
  if (record.pullRequest) record.pullRequest = { ...record.pullRequest, diffDigest: measured.patchDigest }
  return splitRecord(record).agent
}

const flag = (argv: readonly string[], name: string): string => {
  const index = argv.indexOf(`--${name}`)
  const value = index === -1 ? undefined : argv[index + 1]
  if (value === undefined) throw new Error(`--${name} is required`)
  return value
}

/**
 * The bundled scripts' entry: `grade` measures and grades a trial, writing a
 * reward whatever goes wrong; `oracle` writes the reference outcome's agent
 * part; `version` prints the renderer version the bundle carries.
 */
export async function harborGradeCommand(argv: readonly string[]): Promise<number> {
  const [command] = argv
  if (command === 'version') {
    process.stdout.write(`${VINAYA_RENDERER_VERSION}\n`)
    return 0
  }
  if (command === 'oracle') {
    const solution = flag(argv, 'solution')
    const spec = JSON.parse(readFileSync(join(solution, 'reference.json'), 'utf8')) as OracleSpec
    const agentDirectory = flag(argv, 'agent')
    mkdirSync(agentDirectory, { recursive: true })
    const part = oracleAgentPart(flag(argv, 'app'), spec)
    writeFileSync(join(agentDirectory, AGENT_RECORD_FILE), `${JSON.stringify(part, null, 2)}\n`)
    return 0
  }
  if (command === 'grade') {
    const out = flag(argv, 'out')
    let grade: TrialGrade
    try {
      const tests = flag(argv, 'tests')
      const spec = JSON.parse(readFileSync(join(tests, 'grading.json'), 'utf8')) as GradingSpec
      const agent = readAgentRecord(flag(argv, 'agent'))
      const measured = await measureTrial(flag(argv, 'app'), tests, spec, runnerOutputLog(out))
      grade = await gradeTrial(spec, agent, measured)
    } catch (error) {
      grade = {
        reward: 0,
        reason: `the verifier failed: ${error instanceof Error ? error.message : String(error)}`,
        verdicts: {}
      }
    }
    writeGrade(out, grade)
    return 0
  }
  throw new Error(
    'usage: grade.js grade --tests <dir> --app <dir> --agent <dir> --out <dir> | oracle --solution <dir> --app <dir> --agent <dir> | version'
  )
}

if (import.meta.main) {
  harborGradeCommand(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    })
}
