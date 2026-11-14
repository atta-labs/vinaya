#!/usr/bin/env bun
/**
 * The read recorder: on a push to the default branch, runs every scheduled test
 * file as its own process on Linux under
 * `strace -f -yy -e trace=%file,getdents64,clone,clone3,fork,vfork` (child
 * processes included) and stores, per test file, the repository paths it opened
 * or probed and the folders it listed (`packages/test-selection/src/recorded-reads.ts`
 * turns the trace into repository-relative real paths).
 *
 * A trace cannot tell a folder the test's code listed from one Bun's module
 * resolver listed to find a module. So each Bun run also loads the listing
 * probe (`scripts/ci/listing-probe.ts`), copied into the recorder's scratch
 * folder and put first in the `[test] preload` list of the run's own Bun
 * configuration; it logs the folders the code listed. Each test's `scanned`
 * folders are those, plus every folder listed by a process the probe did not
 * run in or logged as wholly scanned, plus the folders a read source's literal
 * module lookup or mock can resolve into, plus every listed folder of a test
 * whose read source looks a module up with no literal specifier (`scannedFolders`).
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
  copyFileSync,
  createReadStream,
  existsSync,
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
import { dirname, join, posix } from 'node:path'
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
  repositoryFolder,
  type TraceOptions
} from '@attalabs/test-selection'
import { PROBE_LOG_ENV } from './listing-probe.js'
import { readTestInventory, type TestIdentity } from '../test-suites/inventory-check.js'
import { GROUP_TIME_LIMIT_MS, groupOutcomeOf, runnerLaunch } from '../test-suites/schedule.js'
import { RECORD_FILE } from '../test-suites/read-records.js'

/** The syscall filter the trace is taken with. */
export const STRACE_ARGS = [
  '-f',
  '-yy',
  '-qq',
  '-s',
  '4096',
  '-e',
  'trace=%file,getdents64,clone,clone3,fork,vfork'
] as const

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

/**
 * Source text that resolves modules from the resolver's folder listings with no specifier the scan can read: Bun's
 * file-system router. A test whose code holds one counts every folder it listed as scanned. Bun's own resolve and
 * resolveSync and the `dlopen` of `bun:ffi` are not here: the listing probe wraps them, and their first call logs the
 * process wholly scanned, so a source that only mentions them counts nothing.
 */
const RESOLVES_EVERYWHERE = [/\bFileSystemRouter\b/]
/**
 * The resolve and mock forms the probe cannot wrap, each looked up from the resolver's folder listing and opening
 * nothing the trace shows: the module meta object's resolve (and its resolveSync), the resolve of a require function
 * (the module meta object's own require and a `createRequire` result included), and a test-runner module mock with its
 * Jest- and Vitest-style aliases. Each occurrence counts the folders its specifier can resolve into (`lookupFolders`).
 */
const LOOKUPS = [
  /\bimport\.meta\.resolve(?:Sync)?\b/g,
  /\brequire\.resolve\b/g,
  /\bcreateRequire\s*\([^)]*\)\s*\.resolve\b/g,
  /\bmock\.module\b/g,
  /\b(?:jest|vi)\.(?:mock|doMock|unstable_mockModule|importMock|importActual|requireMock|requireActual)\b/g
]
/** A name bound to a `createRequire` result, whose own resolve is then searched for. */
const REQUIRE_BINDING = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$]*\.)?createRequire\s*\(/g
/** A call's first argument when it is one string literal: quoted, or a template without substitutions; no escapes. */
const LITERAL_ARGUMENT = /^\s*\(\s*(?:'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`\\$]*)`)\s*(?:,|\))/
const MODULE_SOURCE = /\.(?:[cm]?[jt]sx?)$/

/**
 * The module specifiers a source looks up or mocks through a form the probe cannot wrap (`LOOKUPS`, or a
 * `createRequire` result's resolve): each occurrence's specifier when its argument is one string literal. `every` is
 * true when one is not — a computed specifier, or a mention that is not a call — or when the source uses Bun's
 * file-system router: then no specifier says where the lookup lists.
 */
export function moduleLookups(text: string): { every: boolean; specifiers: string[] } {
  if (RESOLVES_EVERYWHERE.some((pattern) => pattern.test(text))) return { every: true, specifiers: [] }
  const patterns = [...LOOKUPS]
  for (const binding of text.matchAll(REQUIRE_BINDING))
    patterns.push(new RegExp(`(?<![\\w$])${(binding[1] as string).replace(/\$/g, '\\$')}\\s*\\.\\s*resolve\\b`, 'g'))
  const specifiers: string[] = []
  for (const pattern of patterns)
    for (const match of text.matchAll(pattern)) {
      const literal = LITERAL_ARGUMENT.exec(text.slice((match.index as number) + match[0].length))
      if (!literal) return { every: true, specifiers: [] }
      specifiers.push((literal[1] ?? literal[2] ?? literal[3]) as string)
    }
  return { every: false, specifiers }
}

/** A workspace package name to its repository-relative folder, read from each workspace folder's `package.json`. */
export function workspacePackages(repoRoot: string, packageDirs: readonly string[]): Map<string, string> {
  const packages = new Map<string, string>()
  for (const dir of packageDirs)
    try {
      const { name } = JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8')) as { name?: unknown }
      if (typeof name === 'string' && name !== '' && !packages.has(name)) packages.set(name, dir)
    } catch {}
  return packages
}

/** A repository-relative path, normalized, as `.` for the root, or null outside the repository. */
const inRepository = (path: string): string | null => {
  const normal = posix.normalize(path).replace(/\/+$/, '')
  if (normal === '' || normal === '.') return '.'
  return normal === '..' || normal.startsWith('../') || normal.startsWith('/') ? null : normal
}

/**
 * The folder `path`, from `base`, names: the path itself when it names a folder (it ends in `.`, `..` or `/`), else the
 * folder holding it.
 */
const folderNamed = (base: string, path: string): string => {
  const joined = posix.join(base, path)
  return /(?:^|\/)\.{1,2}$/.test(path) || path.endsWith('/') ? joined : posix.dirname(joined)
}

/**
 * The repository-relative folders a literal specifier, looked up from the source file `source`, can resolve into; null
 * when the scan cannot say (an absolute path, a URL, a package-internal `#` import), so every listed folder counts.
 * A relative specifier: the folder holding the path it names, from the source's folder. A bare one: the repository
 * root (the root `tsconfig.json`'s `baseUrl` of `.` can map it to a repository path), and, when its package name is a
 * workspace package's, the folder of its subpath inside that package's folder.
 */
export function lookupFolders(
  specifier: string,
  source: string,
  packages: ReadonlyMap<string, string>
): string[] | null {
  if (specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../')) {
    const folder = inRepository(folderNamed(posix.dirname(source), specifier))
    return folder === null ? [] : [folder]
  }
  if (specifier === '' || specifier.startsWith('/') || specifier.startsWith('#') || /^file:/i.test(specifier))
    return null
  const segments = specifier.split('/')
  const size = specifier.startsWith('@') ? 2 : 1
  const dir = packages.get(segments.slice(0, size).join('/'))
  if (dir === undefined) return ['.']
  const subpath = segments.slice(size).join('/')
  const folder = inRepository(subpath === '' ? dir : folderNamed(dir, subpath))
  return folder === null || folder === '.' ? ['.'] : ['.', folder]
}

/**
 * What the source files a test read say about its record: whether any branches on `process.platform`; whether any
 * module source looks a module up in a way that counts every listed folder (`resolves`); and the folders its literal
 * lookups can resolve into (`resolved`, repository-relative: `moduleLookups`, `lookupFolders`).
 */
export function scanSources(
  repoRoot: string,
  reads: Iterable<string>,
  packages: ReadonlyMap<string, string> = new Map()
): { branchesOnPlatform: boolean; resolves: boolean; resolved: string[] } {
  let branchesOnPlatform = false
  let resolves = false
  const resolved = new Set<string>()
  for (const read of reads) {
    if (branchesOnPlatform && resolves) break
    if (read.endsWith('/')) continue
    try {
      const path = join(repoRoot, read)
      const stat = statSync(path)
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue
      const text = readFileSync(path, 'utf8')
      branchesOnPlatform ||= PLATFORM_BRANCH.test(text)
      if (resolves || !MODULE_SOURCE.test(read)) continue
      const lookups = moduleLookups(text)
      if (lookups.every) resolves = true
      for (const specifier of lookups.specifiers) {
        const folders = lookupFolders(specifier, read, packages)
        if (folders === null) resolves = true
        else for (const folder of folders) resolved.add(folder)
      }
    } catch {}
  }
  return { branchesOnPlatform, resolves, resolved: [...resolved].sort() }
}

/** One folder the listing probe logged: its absolute path and whether the call covered the folders beneath it. */
export type ProbeListing = { folder: string; recursive: boolean }

/** The listing probe's log, read: the process ids that started it, those it logged wholly scanned, and every listing. */
export type ProbeLog = { starts: Set<string>; wholly: Set<string>; listings: ProbeListing[] }

/** Reads the probe's JSON lines; a line it cannot read is skipped. */
export function readProbeLog(text: string): ProbeLog {
  const log: ProbeLog = { starts: new Set(), wholly: new Set(), listings: [] }
  for (const line of text.split('\n')) {
    let entry: { pid?: unknown; start?: unknown; list?: unknown; recursive?: unknown; whole?: unknown }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof entry !== 'object' || entry === null || typeof entry.pid !== 'number') continue
    const pid = String(entry.pid)
    if (entry.start === true) log.starts.add(pid)
    if (typeof entry.whole === 'string') log.wholly.add(pid)
    if (typeof entry.list === 'string') log.listings.push({ folder: entry.list, recursive: entry.recursive === true })
  }
  return log
}

/**
 * A test's `scanned` folders: every folder the probe logged (a recursive listing as `<folder>/`, the root's as `./`),
 * mapped through `folderOf`; every folder the trace counts by process (`processScanned`: a process the probe did not
 * run in, one it logged wholly scanned, a thread of an unknown process); every folder its source's literal module
 * lookups can resolve into (`resolved`, already repository folders); and, when its source looks a module up where no
 * literal says where, every folder it listed.
 */
export function scannedFolders(input: {
  listed: Iterable<string>
  processScanned: Iterable<string>
  probe: ProbeLog
  resolves: boolean
  resolved?: Iterable<string>
  folderOf: (absolute: string) => string | null
}): string[] {
  const scanned = new Set<string>(input.processScanned)
  for (const folder of input.resolved ?? []) scanned.add(folder)
  if (input.resolves) for (const folder of input.listed) scanned.add(folder)
  for (const { folder, recursive } of input.probe.listings) {
    const rel = input.folderOf(folder)
    if (rel !== null) scanned.add(recursive ? `${rel}/` : rel)
  }
  return [...scanned].sort()
}

/**
 * A Bun configuration with `probe` first in its `[test] preload` list: put before a preload string or array the
 * `[test]` table names, or a list of its own when the table names none (or there is no table).
 */
export function withProbeFirst(source: string, probe: string): string {
  const quoted = JSON.stringify(probe)
  const lines = source.split('\n')
  let table = ''
  let testAt = -1
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at] as string
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line)
    if (header) {
      table = (header[1] as string).trim()
      if (table === 'test') testAt = at
      continue
    }
    if (table !== 'test') continue
    const key = /^(\s*preload\s*=\s*)(.*)$/.exec(line)
    if (!key) continue
    const [, lead, value] = key as unknown as [string, string, string]
    if (value.startsWith('[')) {
      const rest = value.slice(1)
      lines[at] = /^\s*\]/.test(rest) ? `${lead}[${quoted}${rest.trimStart()}` : `${lead}[${quoted}, ${rest}`
    } else {
      const single = /^("(?:[^"\\]|\\.)*"|'[^']*')(.*)$/.exec(value)
      if (!single) throw new Error(`cannot read the [test] preload value ${value}`)
      lines[at] = `${lead}[${quoted}, ${single[1]}]${single[2]}`
    }
    return lines.join('\n')
  }
  if (testAt >= 0) {
    lines.splice(testAt + 1, 0, `preload = [${quoted}]`)
    return lines.join('\n')
  }
  return `${source}${source === '' || source.endsWith('\n') ? '' : '\n'}[test]\npreload = [${quoted}]\n`
}

/**
 * A Bun run's launch with the listing probe first in its `[test] preload` list and its log named: the configuration
 * the runner launch wrote beside the report is rewritten, or, when it wrote none, one is written there from the test
 * folder's own Bun configuration and passed with `--config=`.
 */
export function probedLaunch(
  launch: { command: string[]; env: Record<string, string> },
  options: { cwd: string; report: string; probe: string; log: string }
): { command: string[]; env: Record<string, string> } {
  let command = launch.command
  const given = command.find((arg) => arg.startsWith('--config='))
  if (given) {
    const config = given.slice('--config='.length)
    writeFileSync(config, withProbeFirst(readFileSync(config, 'utf8'), options.probe))
  } else {
    const config = `${options.report}.bunfig.toml`
    const own = join(options.cwd, 'bunfig.toml')
    writeFileSync(config, withProbeFirst(existsSync(own) ? readFileSync(own, 'utf8') : '', options.probe))
    command = [command[0] as string, `--config=${config}`, ...command.slice(1)]
  }
  return { command, env: { ...launch.env, [PROBE_LOG_ENV]: options.log } }
}

/** The probe's file name in the recorder's scratch folder. */
export const PROBE_FILE = 'listing-probe.ts'

export type RecordedRun = { test: string; recorded: RecordedTest | null; reason: string; ms: number }

/** Runs one test file under the tracer and returns its record, or none with the reason. */
async function recordTest(
  repoRoot: string,
  group: NativeGroup,
  test: string,
  trace: TraceOptions,
  scratch: string,
  index: number,
  packages: ReadonlyMap<string, string>
): Promise<RecordedRun> {
  const started = performance.now()
  const report = join(scratch, `${index}.${group.runner === 'bun' ? 'xml' : 'json'}`)
  const traceFile = join(scratch, `${index}.trace`)
  const probeLog = join(scratch, `${index}.probe.jsonl`)
  const cwd = join(repoRoot, group.cwd)
  // Runs go in parallel in one folder: each gets its own configuration naming its own report, never the folder's
  // shared report path, or a run ending first would write its report into a sibling's file. A Bun run's configuration
  // also loads the listing probe first; a Vitest run has none, so every folder it lists counts as scanned.
  const named = runnerLaunch(group, report, cwd)
  const launch =
    group.runner === 'bun'
      ? probedLaunch(named, { cwd, report, probe: join(scratch, PROBE_FILE), log: probeLog })
      : named
  const command = ['strace', ...STRACE_ARGS, '-o', traceFile, '--', ...launch.command]
  const child = Bun.spawn(command, {
    cwd,
    stdout: 'ignore',
    stderr: 'ignore',
    env: { ...process.env, ...launch.env }
  })
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
  let probeText = ''
  try {
    probeText = readFileSync(probeLog, 'utf8')
  } catch {}
  rmSync(probeLog, { force: true })
  const probe = readProbeLog(probeText)
  const reader = createTraceReader({
    ...trace,
    startCwd: realpathSync(cwd),
    probe: { log: probeLog, starts: probe.starts, wholly: probe.wholly }
  })
  const lines = createInterface({
    input: createReadStream(traceFile, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY
  })
  for await (const line of lines) reader.feed(line)
  rmSync(traceFile, { force: true })
  const { reads, listed, processScanned, git: touchedGit, gitReaders, truncated } = reader.result()
  const sources = scanSources(repoRoot, reads, packages)
  const recorded: RecordedTest = {
    reads: [...reads].sort(),
    listed: [...listed].sort(),
    scanned: scannedFolders({
      listed,
      processScanned,
      probe,
      resolves: sources.resolves,
      // Through real paths, as the trace's folders are: a workspace symlink lands on its package folder.
      resolved: sources.resolved.flatMap((folder) => {
        const real = repositoryFolder(realpathOrParent(join(trace.repoRoot, folder)), trace, true)
        return real === null ? [] : [real]
      }),
      folderOf: (absolute) => repositoryFolder(absolute, trace)
    }),
    ...(touchedGit
      ? { fallback: 'git-read' as const, gitReaders: [...gitReaders].sort() }
      : truncated
        ? { fallback: 'truncated-path' as const }
        : {}),
    ...(sources.branchesOnPlatform ? { branchesOnPlatform: true } : {})
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
  const packages = workspacePackages(real, packageDirs)
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
  // Real path: the trace prints the probe log's resolved path, which the reader compares with the one named here.
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'vinaya-record-')))
  // The probe runs from a copy outside the repository, so no record holds its file or folder as a read.
  copyFileSync(join(import.meta.dir, PROBE_FILE), join(scratch, PROBE_FILE))
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
      const run = await recordTest(repoRoot, group, identity.id, trace, scratch, at, packages)
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
