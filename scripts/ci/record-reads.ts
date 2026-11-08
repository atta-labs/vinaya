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
 * The work splits into shards: `--shard <i>/<n>` records only the i-th of n
 * disjoint slices of the sorted test list (`shardTests`) and writes, next to
 * the partial `read-record.json`, a `shard.json` naming the slice and every test
 * it attempted. `--merge <dir>` reads every shard's output under `<dir>`, refuses
 * an incomplete or overlapping set, and writes the one `read-record.json` an
 * unsharded run would have written (`mergeShardRecords`).
 *
 *   bun scripts/ci/record-reads.ts --out <dir> [--commit <sha>] [--concurrency <n>] [--shard <i>/<n>] [--only <test,test>] [--expect <test>=<path>] [--summary <file>]
 *   bun scripts/ci/record-reads.ts --merge <dir> --out <dir> [--commit <sha>] [--summary <file>]
 */
import { execFileSync } from 'node:child_process'
import {
  createReadStream,
  mkdirSync,
  readdirSync,
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
  isReadRecord,
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

/** The file a shard writes beside its partial record, naming the slice it recorded. */
export const SHARD_FILE = 'shard.json'

/** One slice of the test list: the `index`-th (1-based) of `count`. */
export type Shard = { index: number; count: number }

/** What a shard writes beside its partial record: its slice and every test it attempted. */
export type ShardManifest = Shard & { commit: string; tests: string[]; unrecorded: string[] }

/** Parses `<i>/<n>` with 1 <= i <= n; anything else is null. */
export function parseShard(text: string): Shard | null {
  const match = /^(\d+)\/(\d+)$/.exec(text.trim())
  if (!match) return null
  const index = Number(match[1])
  const count = Number(match[2])
  return Number.isInteger(index) && Number.isInteger(count) && index >= 1 && index <= count ? { index, count } : null
}

/**
 * The tests one shard records: the sorted list dealt round-robin, so every test
 * lands in exactly one shard and each folder's tests spread across all shards.
 */
export function shardTests(tests: readonly string[], shard: Shard): string[] {
  return [...tests].sort().filter((_, at) => at % shard.count === shard.index - 1)
}

/**
 * Combines every shard's partial record into the record an unsharded run writes.
 * Throws when the set is not exactly shards 1..n of one count, the commits or
 * platforms differ, or one test was attempted by two shards.
 */
export function mergeShardRecords(parts: readonly { shard: ShardManifest; record: ReadRecord }[]): {
  record: ReadRecord
  attempted: string[]
  unrecorded: string[]
} {
  const first = parts[0]
  if (!first) throw new Error('no shard output to merge')
  const { count } = first.shard
  const indices = parts.map((p) => p.shard.index).sort((a, b) => a - b)
  const expected = Array.from({ length: count }, (_, at) => at + 1)
  if (parts.some((p) => p.shard.count !== count) || indices.join(',') !== expected.join(','))
    throw new Error(`expected shards 1..${count} exactly once, got ${indices.join(',')}`)
  const attempted = new Set<string>()
  const tests: Record<string, RecordedTest> = {}
  const unrecorded: string[] = []
  for (const { shard, record } of parts) {
    if (record.commit !== first.record.commit || shard.commit !== first.record.commit)
      throw new Error(`shard ${shard.index} was recorded at another commit (${record.commit})`)
    if (record.platform !== first.record.platform)
      throw new Error(`shard ${shard.index} was recorded on ${record.platform}, not ${first.record.platform}`)
    for (const test of shard.tests) {
      if (attempted.has(test)) throw new Error(`${test} was recorded by two shards`)
      attempted.add(test)
    }
    for (const [test, recorded] of Object.entries(record.tests)) {
      if (!shard.tests.includes(test)) throw new Error(`shard ${shard.index} recorded ${test} outside its slice`)
      tests[test] = recorded
    }
    unrecorded.push(...shard.unrecorded)
  }
  const sorted: Record<string, RecordedTest> = {}
  for (const test of Object.keys(tests).sort()) sorted[test] = tests[test] as RecordedTest
  return {
    record: {
      schema: READ_RECORD_SCHEMA,
      schemaVersion: 1,
      commit: first.record.commit,
      platform: first.record.platform,
      tests: sorted
    },
    attempted: [...attempted].sort(),
    unrecorded: unrecorded.sort()
  }
}

/** Reads every shard output (a folder holding `shard.json` and `read-record.json`) directly under `dir`. */
export function readShardOutputs(dir: string): { shard: ShardManifest; record: ReadRecord }[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const shard = JSON.parse(readFileSync(join(dir, entry.name, SHARD_FILE), 'utf8')) as ShardManifest
      const record: unknown = JSON.parse(readFileSync(join(dir, entry.name, RECORD_FILE), 'utf8'))
      if (!isReadRecord(record)) throw new Error(`${entry.name}/${RECORD_FILE} is not a read record`)
      return { shard, record }
    })
}

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

export type RecordSummary = {
  tests: number
  attempted: string[]
  recorded: number
  unrecorded: string[]
  wallMs: number
}

/** Records every test (or `only`) of the commit checked out at `repoRoot`. */
export async function recordReads(options: {
  repoRoot: string
  commit: string
  concurrency: number
  only?: readonly string[]
  shard?: Shard
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
  const onlyWanted = options.only ? new Set(options.only) : null
  const candidates = view.tests.filter((t) => onlyWanted === null || onlyWanted.has(t.id))
  const wanted = options.shard
    ? new Set(
        shardTests(
          candidates.map((t) => t.id),
          options.shard
        )
      )
    : null
  const tests: TestIdentity[] = candidates.filter((t) => wanted === null || wanted.has(t.id))
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
      attempted: tests.map((t) => t.id).sort(),
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

function writeSummary(file: string | undefined, title: string, line: string, unrecorded: readonly string[]): void {
  if (!file) return
  writeFileSync(
    file,
    `### ${title}\n\n${line}\n\n${unrecorded.length === 0 ? 'Every test file recorded.' : `Without a record (static selection decides them): ${unrecorded.length}\n\n${unrecorded.map((t) => `- ${t}`).join('\n')}`}\n`,
    { flag: 'a' }
  )
}

/** `--merge <dir>`: combines every shard's output into the commit's one record. */
function mergeMain(argv: readonly string[], partsDir: string, out: string): number {
  const repoRoot = git(process.cwd(), ['rev-parse', '--show-toplevel'])
  const commit = git(repoRoot, ['rev-parse', argValue(argv, '--commit') ?? 'HEAD'])
  let merged: ReturnType<typeof mergeShardRecords>
  try {
    merged = mergeShardRecords(readShardOutputs(partsDir))
  } catch (error) {
    process.stderr.write(`vinaya record-reads: ${(error as Error).message}\n`)
    return 1
  }
  if (merged.record.commit !== commit) {
    process.stderr.write(`vinaya record-reads: the shards recorded ${merged.record.commit}, not ${commit}\n`)
    return 1
  }
  // Every scheduled test file was attempted by one shard: a lost slice would leave tests silently unrecorded.
  const scheduled = readTestInventory(repoRoot, { head: commit })
    .head.tests.map((t) => t.id)
    .sort()
  if (scheduled.join('\n') !== merged.attempted.join('\n')) {
    process.stderr.write(
      `vinaya record-reads: the shards attempted ${merged.attempted.length} test file(s), the commit schedules ${scheduled.length}\n`
    )
    return 1
  }
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, RECORD_FILE), `${JSON.stringify(merged.record)}\n`)
  const line = `vinaya record-reads: ${Object.keys(merged.record.tests).length} of ${merged.attempted.length} test file(s) recorded at ${commit.slice(0, 12)}, merged from every shard`
  process.stderr.write(`${line}\n`)
  writeSummary(argValue(argv, '--summary'), `Read record ${commit.slice(0, 12)}`, line, merged.unrecorded)
  return 0
}

async function main(argv: readonly string[]): Promise<number> {
  const out = argValue(argv, '--out')
  if (!out) {
    process.stderr.write(
      'usage: record-reads.ts --out <dir> [--commit <sha>] [--concurrency <n>] [--shard <i>/<n>] [--only <test,test>] [--summary <file>]\n' +
        '       record-reads.ts --merge <dir> --out <dir> [--commit <sha>] [--summary <file>]\n'
    )
    return 2
  }
  const partsDir = argValue(argv, '--merge')
  if (partsDir) return mergeMain(argv, partsDir, out)
  const shardText = argValue(argv, '--shard')
  const shard = shardText === undefined ? undefined : parseShard(shardText)
  if (shard === null) {
    process.stderr.write(`vinaya record-reads: --shard takes <i>/<n> with 1 <= i <= n, not ${shardText}\n`)
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
    ...(only ? { only: only.split(',') } : {}),
    ...(shard ? { shard } : {})
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
  if (shard) {
    const manifest: ShardManifest = { ...shard, commit, tests: summary.attempted, unrecorded: summary.unrecorded }
    writeFileSync(join(out, SHARD_FILE), `${JSON.stringify(manifest)}\n`)
  }
  const slice = shard ? ` (shard ${shard.index} of ${shard.count})` : ''
  const line = `vinaya record-reads: ${summary.recorded} of ${summary.tests} test file(s) recorded at ${commit.slice(0, 12)}${slice} in ${(summary.wallMs / 60_000).toFixed(1)} min wall time`
  process.stderr.write(`${line}\n`)
  writeSummary(argValue(argv, '--summary'), `Read record ${commit.slice(0, 12)}${slice}`, line, summary.unrecorded)
  return 0
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
