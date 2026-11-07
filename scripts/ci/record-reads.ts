#!/usr/bin/env bun
/**
 * The read recorder: on a push to the default branch, runs every scheduled test
 * file as its own process on Linux under
 * `strace -f -yy -e trace=%file,getdents64` (child processes included) and
 * stores, per test file, the repository paths it opened or probed and the
 * folders it listed (`harness/kernel/gates/ring0-hooks/pre-push/verification/recorded-reads.ts`
 * turns the trace into repository-relative real paths).
 *
 * The record is the selection's input for later changes
 * (`scripts/test-suites/read-records.ts` fetches it by commit). A test file that
 * does not pass while it is recorded gets no record, so its selection stays
 * static. The recorder is outside the required `Vinaya CI` aggregate: a failure
 * here never blocks a merge.
 *
 *   bun scripts/ci/record-reads.ts --out <dir> [--commit <sha>] [--concurrency <n>] [--only <test,test>] [--expect <test>=<path>] [--summary <file>]
 */
import { execFileSync } from 'node:child_process'
import {
  createReadStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import {
  createTraceReader,
  DEFAULT_CONFIGURATION,
  diskTree,
  discoverWorkspaceDirs,
  groupNativeTests,
  indexRecordedTest,
  type NativeGroup,
  READ_RECORD_SCHEMA,
  type ReadRecord,
  type RecordedTest,
  recordReach,
  type TraceOptions
} from '../../harness/kernel/gates/ring0-hooks/pre-push/verification/index.js'
import { readTestInventory, type TestIdentity } from '../test-suites/inventory-check.js'
import { GROUP_TIME_LIMIT_MS, groupOutcomeOf, runnerCommand } from '../test-suites/schedule.js'
import { RECORD_FILE } from '../test-suites/read-records.js'

/** The syscall filter the trace is taken with. */
export const STRACE_ARGS = ['-f', '-yy', '-qq', '-s', '4096', '-e', 'trace=%file,getdents64'] as const

/** The input installed third-party dependencies derive from. */
const DEPENDENCY_INPUT = 'bun.lock'

const PLATFORM_BRANCH = /process\.platform/

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** A path resolved through symbolic links; a path that does not exist resolves through its deepest existing parent. */
export function realpathOrParent(absolute: string): string {
  let rest = ''
  let current = absolute
  for (;;) {
    try {
      const real = realpathSync(current)
      return rest === '' ? real : `${real}/${rest}`
    } catch {
      const parent = dirname(current)
      if (parent === current) return absolute
      rest =
        rest === ''
          ? current.slice(parent.length).replace(/^\/+/, '')
          : `${current.slice(parent.length).replace(/^\/+/, '')}/${rest}`
      current = parent
    }
  }
}

/** Whether any source file the test read branches on `process.platform`. */
function branchesOnPlatform(repoRoot: string, reads: Iterable<string>): boolean {
  for (const read of reads) {
    if (read.endsWith('/')) continue
    try {
      const path = join(repoRoot, read)
      const stat = statSync(path)
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue
      if (PLATFORM_BRANCH.test(readFileSync(path, 'utf8'))) return true
    } catch {}
  }
  return false
}

export type RecordedRun = { test: string; recorded: RecordedTest | null; reason: string; ms: number }

/** Runs one test file under the tracer and returns its record, or none with the reason. */
async function recordTest(
  repoRoot: string,
  group: NativeGroup,
  test: string,
  trace: TraceOptions,
  scratch: string,
  index: number
): Promise<RecordedRun> {
  const started = performance.now()
  const report = join(scratch, `${index}.${group.runner === 'bun' ? 'xml' : 'json'}`)
  const traceFile = join(scratch, `${index}.trace`)
  const command = ['strace', ...STRACE_ARGS, '-o', traceFile, '--', ...runnerCommand(group, report)]
  const cwd = join(repoRoot, group.cwd)
  const child = Bun.spawn(command, { cwd, stdout: 'ignore', stderr: 'ignore', env: process.env })
  const timer = setTimeout(() => child.kill('SIGKILL'), GROUP_TIME_LIMIT_MS)
  const status = await child.exited
  clearTimeout(timer)
  const ms = Math.round(performance.now() - started)
  let text: string | null = null
  try {
    text = readFileSync(report, 'utf8')
  } catch {}
  const roots = [...new Set([repoRoot, realpathSync(repoRoot)])]
  const outcome = groupOutcomeOf(
    group,
    { status, signal: typeof child.signalCode === 'string' ? child.signalCode : null, report: text },
    repoRoot,
    roots
  )
  let traceBytes = 0
  try {
    traceBytes = statSync(traceFile).size
  } catch {}
  if (traceBytes === 0) {
    rmSync(traceFile, { force: true })
    return {
      test,
      recorded: null,
      reason: 'TRACER FAILURE: strace left no trace (ptrace denied or strace missing)',
      ms
    }
  }
  if (!(status === 0 && outcome.trusted && outcome.confirmed.includes(test))) {
    rmSync(traceFile, { force: true })
    return { test, recorded: null, reason: 'the test did not pass while recorded', ms }
  }
  const reader = createTraceReader({ ...trace, startCwd: realpathSync(cwd) })
  const lines = createInterface({
    input: createReadStream(traceFile, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY
  })
  for await (const line of lines) reader.feed(line)
  rmSync(traceFile, { force: true })
  const { reads, listed, git: touchedGit, truncated } = reader.result()
  const recorded: RecordedTest = {
    reads: [...reads].sort(),
    listed: [...listed].sort(),
    ...(touchedGit ? { fallback: 'git-read' as const } : truncated ? { fallback: 'truncated-path' as const } : {}),
    ...(branchesOnPlatform(repoRoot, reads) ? { branchesOnPlatform: true } : {})
  }
  return { test, recorded, reason: 'recorded', ms }
}

export type RecordSummary = { tests: number; recorded: number; unrecorded: string[]; wallMs: number }

/** Records every test (or `only`) of the commit checked out at `repoRoot`. */
export async function recordReads(options: {
  repoRoot: string
  commit: string
  concurrency: number
  only?: readonly string[]
  log?: (line: string) => void
}): Promise<{ record: ReadRecord; summary: RecordSummary }> {
  const { repoRoot, commit } = options
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  const started = performance.now()
  const view = readTestInventory(repoRoot, { head: commit }).head
  const real = realpathSync(repoRoot)
  const packageDirs = discoverWorkspaceDirs(diskTree(real)).map((dir) =>
    dir.startsWith(`${real}/`) ? dir.slice(real.length + 1) : dir
  )
  const trace: TraceOptions = {
    repoRoot: real,
    startCwd: real,
    realpath: realpathOrParent,
    packageDirs,
    dependencyInput: DEPENDENCY_INPUT
  }
  const wanted = options.only ? new Set(options.only) : null
  const tests: TestIdentity[] = view.tests.filter((t) => wanted === null || wanted.has(t.id))
  const scratch = mkdtempSync(join(tmpdir(), 'vinaya-record-'))
  const results: RecordedRun[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const at = next++
      const identity = tests[at]
      if (!identity) return
      const grouping = groupNativeTests({
        tests: [{ ...identity, configuration: DEFAULT_CONFIGURATION }],
        universe: view.tests
      })
      const group = grouping.groups[0]
      if (!group || grouping.problems.length > 0) {
        results.push({ test: identity.id, recorded: null, reason: 'the test cannot be started on its own', ms: 0 })
        continue
      }
      const run = await recordTest(repoRoot, group, identity.id, trace, scratch, at)
      log(`vinaya record-reads: ${run.test} — ${run.reason} [${run.ms} ms]`)
      results.push(run)
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, () => worker()))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  const recordedTests: Record<string, RecordedTest> = {}
  for (const run of results.sort((a, b) => (a.test < b.test ? -1 : 1)))
    if (run.recorded) recordedTests[run.test] = run.recorded
  const record: ReadRecord = {
    schema: READ_RECORD_SCHEMA,
    schemaVersion: 1,
    commit,
    platform: process.platform,
    tests: recordedTests
  }
  return {
    record,
    summary: {
      tests: tests.length,
      recorded: Object.keys(recordedTests).length,
      unrecorded: results
        .filter((r) => !r.recorded)
        .map((r) => r.test)
        .sort(),
      wallMs: Math.round(performance.now() - started)
    }
  }
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag)
  return at >= 0 ? argv[at + 1] : undefined
}

async function main(argv: readonly string[]): Promise<number> {
  const out = argValue(argv, '--out')
  if (!out) {
    process.stderr.write(
      'usage: record-reads.ts --out <dir> [--commit <sha>] [--concurrency <n>] [--only <test,test>] [--summary <file>]\n'
    )
    return 2
  }
  if (process.platform !== 'linux') {
    process.stderr.write('vinaya record-reads: the recorder runs on Linux only (strace)\n')
    return 2
  }
  const repoRoot = git(process.cwd(), ['rev-parse', '--show-toplevel'])
  const commit = git(repoRoot, ['rev-parse', argValue(argv, '--commit') ?? 'HEAD'])
  const only = argValue(argv, '--only')
  const { record, summary } = await recordReads({
    repoRoot,
    commit,
    concurrency: Number(argValue(argv, '--concurrency') ?? 3),
    ...(only ? { only: only.split(',') } : {})
  })
  // A proof the tracer sees what a child process read: `--expect <test>=<path>` fails unless the test's record reaches it.
  const missing = argv.flatMap((arg, at) => {
    if (arg !== '--expect') return []
    const [test, path] = String(argv[at + 1]).split('=') as [string, string]
    const entry = record.tests[test]
    return entry && recordReach(indexRecordedTest(entry), { path, status: 'modified' })
      ? []
      : [`${test} did not read ${path}`]
  })
  if (missing.length > 0) {
    for (const line of missing) process.stderr.write(`vinaya record-reads: ${line}\n`)
    return 1
  }
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, RECORD_FILE), `${JSON.stringify(record)}\n`)
  const line = `vinaya record-reads: ${summary.recorded} of ${summary.tests} test file(s) recorded at ${commit.slice(0, 12)} in ${(summary.wallMs / 60_000).toFixed(1)} min wall time`
  process.stderr.write(`${line}\n`)
  const summaryFile = argValue(argv, '--summary')
  if (summaryFile)
    writeFileSync(
      summaryFile,
      `### Read record ${commit.slice(0, 12)}\n\n${line}\n\n${summary.unrecorded.length === 0 ? 'Every test file recorded.' : `Without a record (static selection decides them): ${summary.unrecorded.length}\n\n${summary.unrecorded.map((t) => `- ${t}`).join('\n')}`}\n`,
      { flag: 'a' }
    )
  return 0
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
