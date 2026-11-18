/**
 * The read recorder: runs each test file of a repository's inventory as its own process on Linux under
 * `strace -f -yy -e trace=%file,getdents64,chdir,fchdir,clone,clone3,fork,vfork` (child processes included) and stores,
 * per test file, the repository paths it opened or probed and the folders it listed (`recorded-reads.ts` turns the
 * trace into repository-relative real paths), how many times its own process opened each and which a child process
 * opened, and, for a Bun run, the line coverage Bun's own lcov report gives per source file. The record it writes
 * (`read-record.json`, schema version 2) is what `selectTests` takes as `records`.
 *
 * A trace cannot tell a folder the test's code listed from one Bun's module resolver listed to find a module. So each
 * Bun run also loads the listing probe (`listing-probe.ts`), copied into the recorder's scratch folder and put first
 * in the `[test] preload` list of the run's own Bun configuration; it logs the folders the code listed. Each test's
 * `scanned` folders are those, plus every folder listed by a process the probe did not run in or logged as wholly
 * scanned, plus the folders a read source's literal module lookup or mock can resolve into, plus every listed folder
 * of a test whose read source looks a module up with no literal specifier (`scannedFolders`).
 *
 * What decides which tests run and which count as passed is injected (`RecorderSetup`): the inventory, the runner
 * launch, the run-outcome check, the per-run time limit and the dependency input. The defaults serve a repository with
 * no inventory program of its own: the workspace-manifest inventory (`workspaceInventory`), a plain `bun test <file>`
 * or `vitest run <file>` in the suite's folder, and an exit status of 0 confirming the one file. A test file that does
 * not pass while it is recorded gets no record, so its selection stays static.
 *
 * The work splits into shards: `--shard <i>/<n>` records only the i-th of n disjoint slices of the sorted test list
 * (`shardTests`) and writes, next to the partial `read-record.json`, a `shard.json` naming the slice and every test it
 * attempted. `--merge <dir>` reads every shard's output under `<dir>`, refuses an incomplete or overlapping set, and
 * writes the one `read-record.json` an unsharded run would have written (`mergeShardRecords`).
 *
 * Node's own modules only: the recorder runs from the built `dist/` under Node as well as from its source under Bun.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, posix } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { PROBE_LOG_ENV } from './listing-probe-paths.js'
import { DEFAULT_CONFIGURATION, groupNativeTests, type NativeGroup } from './native.js'
import {
  coverageOfLcov,
  createTraceReader,
  type FileCoverage,
  indexRecordedTest,
  isReadRecord,
  READ_RECORD_SCHEMA,
  READ_RECORD_VERSION,
  type ReadRecord,
  type RecordedTest,
  recordReach,
  repositoryFolder,
  type TraceOptions,
  type TraceReads
} from './recorded-reads.js'
import { discoverWorkspaceDirs, diskTree, gitRepository } from './selector.js'
import type { TestIdentity } from './types.js'
import { workspaceInventory } from './workspace-inventory.js'

/** The file the recorder writes the read record to, in its output folder. */
export const RECORD_FILE = 'read-record.json'

/**
 * The syscall filter the trace is taken with. No `status=successful` filter: it would drop the failed lookups a record
 * keeps as reads; the trace reader tells a successful open from its printed result instead.
 */
export const STRACE_ARGS = [
  '-f',
  '-yy',
  '-qq',
  '-s',
  '4096',
  '-e',
  'trace=%file,getdents64,chdir,fchdir,clone,clone3,fork,vfork'
] as const

/** The file Bun's lcov coverage reporter writes in the folder `--coverage-dir` names. */
export const LCOV_FILE = 'lcov.info'

/**
 * A Bun test command that also writes Bun's line coverage, as lcov, to `dir`: the flags go right after the `test`
 * command word (at the end when there is none). The lcov reporter alone, so no coverage threshold fails the run.
 */
export function withCoverage(command: readonly string[], dir: string): string[] {
  const flags = ['--coverage', '--coverage-reporter=lcov', `--coverage-dir=${dir}`]
  const at = command.indexOf('test')
  return at < 0 ? [...command, ...flags] : [...command.slice(0, at + 1), ...flags, ...command.slice(at + 1)]
}

/**
 * The coverage a Bun run's lcov report holds, per repository-relative source file: each `SF:` path is taken from the
 * folder the run started in (`runFolder`, absolute) and resolved through symbolic links; a file outside the
 * repository, under `.git/` or under installed dependencies is dropped. No report (`null`) is a run that covered no
 * source file.
 */
export function coverageOfRun(
  lcov: string | null,
  runFolder: string,
  trace: TraceOptions
): Record<string, FileCoverage> {
  if (lcov === null) return {}
  return coverageOfLcov(lcov, (sf) => {
    const rel = repositoryFolder(posix.resolve(runFolder, sf), trace)
    return rel === null || rel === '.' ? null : rel
  })
}

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
  const version = first.record.schemaVersion
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
    if (record.schemaVersion !== version)
      throw new Error(`shard ${shard.index} wrote a version-${record.schemaVersion} record, not version ${version}`)
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
      schemaVersion: version,
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

const PLATFORM_BRANCH = /process\.platform/

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
 * root (a root `tsconfig.json`'s `baseUrl` of `.` can map it to a repository path), and, when its package name is a
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

/** The probe's file name, in the package's `src/` and in the recorder's scratch folder. */
export const PROBE_FILE = 'listing-probe.ts'
/** The one module the probe imports, copied beside it. */
const PROBE_PATHS_FILE = 'listing-probe-paths.ts'

/**
 * The folder holding the probe's source: this module's own folder when it runs from `src/`, or the shipped `src/`
 * beside `dist/` when it runs from the build.
 */
function probeSourceFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const folder of [here, join(here, '..', 'src')]) if (existsSync(join(folder, PROBE_FILE))) return folder
  throw new Error(`the listing probe's source (${PROBE_FILE}) is not beside ${here} nor in ../src`)
}

/**
 * Copies the listing probe, with the module it imports, into `dir` and returns the copy's path: a run preloads the
 * copy, so no record holds the probe's own file or folder as a read.
 */
export function copyListingProbe(dir: string): string {
  const source = probeSourceFolder()
  for (const file of [PROBE_FILE, PROBE_PATHS_FILE]) copyFileSync(join(source, file), join(dir, file))
  return join(dir, PROBE_FILE)
}

/**
 * One test's record from what its traced run left: the trace reader's result, the probe's log, the scan of the
 * sources it read under `sourceRoot` (`scanSources`) and, for a Bun run, its coverage (`coverageOfRun`; left out for a
 * Vitest run, whose coverage is unknown). Every field in the order the record file writes it.
 */
export function recordedTestOf(input: {
  result: TraceReads
  probe: ProbeLog
  trace: TraceOptions
  sourceRoot: string
  packages: ReadonlyMap<string, string>
  coverage?: Record<string, FileCoverage>
}): RecordedTest {
  const { probe, trace, packages } = input
  const { reads, listed, processScanned, git: touchedGit, gitReaders, truncated, opens, childOpens } = input.result
  const sources = scanSources(input.sourceRoot, reads, packages)
  return {
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
    ...(sources.branchesOnPlatform ? { branchesOnPlatform: true } : {}),
    opens: Object.fromEntries([...opens].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    childOpens: [...childOpens].sort(),
    ...(input.coverage ? { coverage: input.coverage } : {})
  }
}

// ── What the caller injects ─────────────────────────────────────────────────

/** The tests of the commit checked out at `repoRoot`, as the recorder starts them. */
export type RecorderInventory = (repoRoot: string, commit: string) => { tests: readonly TestIdentity[] }

/**
 * The command and environment that start one test's runner group in `cwd`. `report` is a path in the recorder's
 * scratch folder the launch may have the runner write its report to; a Bun launch may also name a configuration with
 * `--config=`, which the recorder rewrites to preload the probe.
 */
export type RecorderLaunch = (
  group: NativeGroup,
  report: string,
  cwd: string
) => { command: string[]; env: Record<string, string> }

/** How one traced run ended, and the text of the report the launch asked for, when the runner left one. */
export type RecorderRun = { status: number | null; signal: string | null; report: string | null }

/**
 * What one run proved: `confirmed` names the group's tests that passed. A test is recorded only when its run exited 0,
 * the outcome is `trusted`, and `confirmed` names it.
 */
export type RecorderOutcome = (
  group: NativeGroup,
  run: RecorderRun,
  repoRoot: string,
  roots: readonly string[]
) => { trusted: boolean; confirmed: readonly string[] }

/** What decides a record; each one left out takes its default. */
export type RecorderSetup = {
  /** The tests to record. Default: {@link workspaceTestInventory}. */
  inventory?: RecorderInventory
  /** How a test's runner starts. Default: {@link plainLaunch}. */
  launch?: RecorderLaunch
  /** Whether a run passed. Default: {@link exitStatusOutcome}. */
  outcome?: RecorderOutcome
  /** How long one traced run may take before it is killed. Default: {@link RECORDER_TIME_LIMIT_MS}. */
  timeLimitMs?: number
  /**
   * What a read under installed third-party dependencies is recorded as (`<input>#<package>`), or `null` to drop it.
   * Default: the repository root's lockfile ({@link lockfileInput}).
   */
  dependencyInput?: string | null
}

/** How long one traced run may take by default: 15 minutes. */
export const RECORDER_TIME_LIMIT_MS = 15 * 60_000

/** The commit's tests from its own package manifests, as the `test-selection` command builds them. */
export const workspaceTestInventory: RecorderInventory = (repoRoot, commit) =>
  workspaceInventory(gitRepository(repoRoot), commit).view

/** Every `node_modules/.bin` from `cwd` up to the file-system root, nearest first. */
function binFolders(cwd: string): string[] {
  const folders: string[] = []
  for (let folder = cwd; ; folder = dirname(folder)) {
    const bin = join(folder, 'node_modules', '.bin')
    if (existsSync(bin)) folders.push(bin)
    if (dirname(folder) === folder) return folders
  }
}

/**
 * A plain runner launch: `bun test <file>`, or `vitest run <file>` with the installed Vitest found through each
 * `node_modules/.bin` from the suite's folder up. It asks for no report.
 */
export const plainLaunch: RecorderLaunch = (group, _report, cwd) => {
  const none: Record<string, string> = {}
  if (group.runner === 'bun') return { command: ['bun', 'test', ...group.args], env: none }
  const path = [...binFolders(cwd), process.env.PATH ?? ''].filter(Boolean).join(delimiter)
  return {
    command: ['vitest', 'run', ...group.exclude.flatMap((file) => ['--exclude', file]), ...group.args],
    env: { PATH: path }
  }
}

/** A run confirms its one test when it exited 0 and no signal stopped it. */
export const exitStatusOutcome: RecorderOutcome = (group, run) => {
  const passed = run.status === 0 && run.signal === null
  return { trusted: passed, confirmed: passed ? group.tests : [] }
}

/**
 * Whether a traced run of `test` gets a record: it exited 0, and its outcome is trusted and confirms the test. A run
 * that exits 0 but whose outcome check finds its report missing or irregular gets none.
 */
export function passedWhileRecorded(
  status: number | null,
  outcome: { trusted: boolean; confirmed: readonly string[] },
  test: string
): boolean {
  return status === 0 && outcome.trusted && outcome.confirmed.includes(test)
}

/** The lockfiles {@link lockfileInput} looks for, in order. */
const LOCKFILES = ['bun.lock', 'bun.lockb', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']

/** The first lockfile the repository root holds, or `null` when it holds none. */
export function lockfileInput(repoRoot: string): string | null {
  return LOCKFILES.find((file) => existsSync(join(repoRoot, file))) ?? null
}

// ── Recording ───────────────────────────────────────────────────────────────

/**
 * One test's recording: its record or none, why, and how long it took. `output` is the end of what the run printed,
 * set only for a test that did not pass while recorded; it is logged, never written into the record.
 */
export type RecordedRun = { test: string; recorded: RecordedTest | null; reason: string; ms: number; output?: string }

/** The most output lines a failed run's tail keeps. */
export const OUTPUT_TAIL_LINES = 40
/** The most characters a failed run's tail keeps, from its end. */
export const OUTPUT_TAIL_CHARS = 4000

/**
 * The end of a run's output, held in memory only up to its limits: the newest {@link OUTPUT_TAIL_LINES} lines, then
 * their newest {@link OUTPUT_TAIL_CHARS} characters. Each source (0 standard output, 1 standard error) holds its own
 * unfinished line, itself cut to the character limit, so a run that prints one endless line costs no more.
 */
export function outputTail(): { write(chunk: string, source?: number): void; text(): string } {
  const lines: string[] = []
  const open: string[] = []
  return {
    write(chunk, source = 0) {
      const parts = `${open[source] ?? ''}${chunk}`.split('\n')
      open[source] = (parts.pop() as string).slice(-OUTPUT_TAIL_CHARS)
      for (const line of parts) {
        lines.push(line.slice(-OUTPUT_TAIL_CHARS))
        if (lines.length > OUTPUT_TAIL_LINES) lines.shift()
      }
    },
    text() {
      const all = [...lines, ...open.filter((line) => line !== '')]
      return all.slice(-OUTPUT_TAIL_LINES).join('\n').trimEnd().slice(-OUTPUT_TAIL_CHARS)
    }
  }
}

/** How long a run's output pipes may stay open after the run exited before its output is taken as it is. */
const OUTPUT_GRACE_MS = 1000

/**
 * Starts one traced run and resolves with how it ended and the end of its output; a run that cannot start ends with
 * neither. Both output streams are read as they come, so a full pipe never blocks the child.
 */
function traced(
  command: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeLimitMs: number }
): Promise<{ status: number | null; signal: string | null; output: string }> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let grace: ReturnType<typeof setTimeout> | undefined
    const tail = outputTail()
    const settle = (status: number | null, signal: string | null): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (grace !== undefined) clearTimeout(grace)
      resolve({ status, signal, output: tail.text() })
    }
    try {
      const child = spawn(command[0] as string, command.slice(1), {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => tail.write(chunk, 0))
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => tail.write(chunk, 1))
      timer = setTimeout(() => child.kill('SIGKILL'), options.timeLimitMs)
      child.on('error', () => settle(null, null))
      // The pipes close once the last output is read; a grandchild that keeps one open must not hold the run.
      child.on('exit', (status, signal) => {
        grace = setTimeout(() => settle(status, signal), OUTPUT_GRACE_MS)
        child.on('close', () => settle(status, signal))
      })
    } catch {
      settle(null, null)
    }
  })
}

type Injected = {
  launch: RecorderLaunch
  outcome: RecorderOutcome
  timeLimitMs: number
}

/** Runs one test file under the tracer and returns its record, or none with the reason. */
async function recordTest(
  repoRoot: string,
  group: NativeGroup,
  test: string,
  trace: TraceOptions,
  scratch: string,
  probeFile: string,
  index: number,
  packages: ReadonlyMap<string, string>,
  injected: Injected
): Promise<RecordedRun> {
  const started = performance.now()
  const report = join(scratch, `${index}.${group.runner === 'bun' ? 'xml' : 'json'}`)
  const traceFile = join(scratch, `${index}.trace`)
  const probeLog = join(scratch, `${index}.probe.jsonl`)
  const coverageDir = join(scratch, `${index}.coverage`)
  const cwd = join(repoRoot, group.cwd)
  // Runs go in parallel in one folder: each gets its own configuration naming its own report, never the folder's
  // shared report path, or a run ending first would write its report into a sibling's file. A Bun run's configuration
  // also loads the listing probe first; a Vitest run has none, so every folder it lists counts as scanned.
  const named = injected.launch(group, report, cwd)
  const launch = group.runner === 'bun' ? probedLaunch(named, { cwd, report, probe: probeFile, log: probeLog }) : named
  // A Bun run also writes its line coverage, as lcov, to a folder of its own in the scratch folder.
  const runCommand = group.runner === 'bun' ? withCoverage(launch.command, coverageDir) : launch.command
  const command = ['strace', ...STRACE_ARGS, '-o', traceFile, '--', ...runCommand]
  const { status, signal, output } = await traced(command, {
    cwd,
    env: { ...process.env, ...launch.env },
    timeLimitMs: injected.timeLimitMs
  })
  const ms = Math.round(performance.now() - started)
  let text: string | null = null
  try {
    text = readFileSync(report, 'utf8')
  } catch {}
  const roots = [...new Set([repoRoot, realpathSync(repoRoot)])]
  const outcome = injected.outcome(group, { status, signal, report: text }, repoRoot, roots)
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
  let lcov: string | null = null
  try {
    lcov = readFileSync(join(coverageDir, LCOV_FILE), 'utf8')
  } catch {}
  rmSync(coverageDir, { recursive: true, force: true })
  if (!passedWhileRecorded(status, outcome, test)) {
    rmSync(traceFile, { force: true })
    return {
      test,
      recorded: null,
      reason: 'the test did not pass while recorded',
      ms,
      ...(output === '' ? {} : { output })
    }
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
  const recorded = recordedTestOf({
    result: reader.result(),
    probe,
    trace,
    sourceRoot: repoRoot,
    packages,
    // A Bun run that left no lcov report covered no source file; a Vitest run's coverage stays unknown.
    ...(group.runner === 'bun' ? { coverage: coverageOfRun(lcov, realpathSync(cwd), trace) } : {})
  })
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
export async function recordReads(
  options: {
    repoRoot: string
    commit: string
    concurrency: number
    only?: readonly string[]
    shard?: Shard
    /** Where each test's line goes. Default: standard error. */
    log?: (line: string) => void
    /** The name each logged line starts with. Default: `test-selection-record`. */
    name?: string
  } & RecorderSetup
): Promise<{ record: ReadRecord; summary: RecordSummary }> {
  const { repoRoot, commit } = options
  const name = options.name ?? 'test-selection-record'
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  const injected: Injected = {
    launch: options.launch ?? plainLaunch,
    outcome: options.outcome ?? exitStatusOutcome,
    timeLimitMs: options.timeLimitMs ?? RECORDER_TIME_LIMIT_MS
  }
  const started = performance.now()
  const view = (options.inventory ?? workspaceTestInventory)(repoRoot, commit)
  const real = realpathSync(repoRoot)
  const packageDirs = discoverWorkspaceDirs(diskTree(real)).map((dir) =>
    dir.startsWith(`${real}/`) ? dir.slice(real.length + 1) : dir
  )
  const trace: TraceOptions = {
    repoRoot: real,
    startCwd: real,
    realpath: realpathOrParent,
    packageDirs,
    dependencyInput: options.dependencyInput === undefined ? lockfileInput(real) : options.dependencyInput
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
  const results: RecordedRun[] = []
  let next = 0
  try {
    // The probe runs from a copy outside the repository, so no record holds its file or folder as a read.
    const probeFile = copyListingProbe(scratch)
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
        const run = await recordTest(repoRoot, group, identity.id, trace, scratch, probeFile, at, packages, injected)
        log(`${name}: ${run.test} — ${run.reason} [${run.ms} ms]`)
        if (run.output !== undefined)
          log(`${name}: ${run.test} — the end of its output:\n${run.output.replace(/^/gm, '  ')}`)
        results.push(run)
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, () => worker()))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  const recordedTests: Record<string, RecordedTest> = {}
  for (const run of results.sort((a, b) => (a.test < b.test ? -1 : 1)))
    if (run.recorded) recordedTests[run.test] = run.recorded
  const record: ReadRecord = {
    schema: READ_RECORD_SCHEMA,
    schemaVersion: READ_RECORD_VERSION,
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

// ── The command ─────────────────────────────────────────────────────────────

/** How {@link recordCommand} names itself and where it reads its host from; every field but `name` has a default. */
export type RecordCommandOptions = RecorderSetup & {
  /** The name each message starts with. */
  name: string
  /** Custom usage lines for help and the missing-`--out` message. */
  usage?: string
  /** The host's platform. Default: `process.platform`. */
  platform?: NodeJS.Platform
  /** The folder the repository is found from. Default: the working folder. */
  cwd?: string
  /** Whether the tracer can be started. Default: `strace -V` exits 0. */
  hasTracer?: () => boolean
  /** Where messages go. Default: standard error. */
  write?: (text: string) => void
  /** Where help goes. Default: standard output. */
  writeHelp?: (text: string) => void
}

const formatRecordUsage = (name: string, suffix: string): string =>
  `usage: ${name} --out <dir> [--commit <sha>] [--concurrency <n>] [--shard <i>/<n>] [--only <test,test>] [--expect <test>=<path>] [--summary <file>]${suffix}\n` +
  `       ${name} --merge <dir> --out <dir> [--commit <sha>] [--summary <file>]${suffix}\n`

/** The command's usage lines, for a command named `name`. */
export const recordUsage = (name: string): string => formatRecordUsage(name, ' [--help]')

const RECORD_HELP_FLAGS = `  --out <dir>            Directory to write the read record to.
  --commit <sha>         Commit to record (default: HEAD).
  --concurrency <n>      Number of test files to trace at once (default: 3).
  --shard <i>/<n>        Record slice i of n.
  --merge <dir>          Directory containing shard outputs to merge.
  --only <test,test>     Comma-separated test files to record.
  --expect <test>=<path> Require the test's record to reach the path.
  --summary <file>       File to append the Markdown summary to.
  --help, -h            Print help.
`

const straceRuns = (): boolean => spawnSync('strace', ['-V'], { stdio: 'ignore' }).status === 0

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
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
function mergeMain(argv: readonly string[], partsDir: string, out: string, options: RecordCommandOptions): number {
  const say = (line: string): void => (options.write ?? ((t) => process.stderr.write(t)))(`${options.name}: ${line}\n`)
  const repoRoot = git(options.cwd ?? process.cwd(), ['rev-parse', '--show-toplevel'])
  const commit = git(repoRoot, ['rev-parse', argValue(argv, '--commit') ?? 'HEAD'])
  let merged: ReturnType<typeof mergeShardRecords>
  try {
    merged = mergeShardRecords(readShardOutputs(partsDir))
  } catch (error) {
    say((error as Error).message)
    return 1
  }
  if (merged.record.commit !== commit) {
    say(`the shards recorded ${merged.record.commit}, not ${commit}`)
    return 1
  }
  // Every test file of the commit was attempted by one shard: a lost slice would leave tests silently unrecorded.
  const scheduled = (options.inventory ?? workspaceTestInventory)(repoRoot, commit)
    .tests.map((t) => t.id)
    .sort()
  if (scheduled.join('\n') !== merged.attempted.join('\n')) {
    say(`the shards attempted ${merged.attempted.length} test file(s), the commit schedules ${scheduled.length}`)
    return 1
  }
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, RECORD_FILE), `${JSON.stringify(merged.record)}\n`)
  const line = `${Object.keys(merged.record.tests).length} of ${merged.attempted.length} test file(s) recorded at ${commit.slice(0, 12)}, merged from every shard`
  say(line)
  writeSummary(
    argValue(argv, '--summary'),
    `Read record ${commit.slice(0, 12)}`,
    `${options.name}: ${line}`,
    merged.unrecorded
  )
  return 0
}

/**
 * The record command: records the tests of the commit checked out around the working folder and writes
 * `<out>/read-record.json` (with `--shard`, also `<out>/shard.json`), or merges shard outputs with `--merge`. Exits 0
 * when it wrote a record; 2 for a usage error, a host that is not Linux or has no `strace`; 1 when a merge is refused
 * or an `--expect` read is missing.
 */
export async function recordCommand(argv: readonly string[], options: RecordCommandOptions): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    const writeHelp = options.writeHelp ?? ((text: string) => process.stdout.write(text))
    const usage = options.usage ?? recordUsage(options.name)
    writeHelp(`${usage.endsWith('\n') ? usage : `${usage}\n`}${RECORD_HELP_FLAGS}`)
    return 0
  }
  const write = options.write ?? ((text: string) => process.stderr.write(text))
  const say = (line: string): void => write(`${options.name}: ${line}\n`)
  const out = argValue(argv, '--out')
  if (!out) {
    write(options.usage ?? formatRecordUsage(options.name, ''))
    return 2
  }
  const partsDir = argValue(argv, '--merge')
  if (partsDir) return mergeMain(argv, partsDir, out, options)
  const shardText = argValue(argv, '--shard')
  const shard = shardText === undefined ? undefined : parseShard(shardText)
  if (shard === null) {
    say(`--shard takes <i>/<n> with 1 <= i <= n, not ${shardText}`)
    return 2
  }
  if ((options.platform ?? process.platform) !== 'linux') {
    say('the recorder runs on Linux only (strace)')
    return 2
  }
  if (!(options.hasTracer ?? straceRuns)()) {
    say('strace cannot be started: the recorder traces every test with it')
    return 2
  }
  const repoRoot = git(options.cwd ?? process.cwd(), ['rev-parse', '--show-toplevel'])
  const commit = git(repoRoot, ['rev-parse', argValue(argv, '--commit') ?? 'HEAD'])
  const only = argValue(argv, '--only')
  const { record, summary } = await recordReads({
    repoRoot,
    commit,
    concurrency: Number(argValue(argv, '--concurrency') ?? 3),
    name: options.name,
    log: (line) => write(`${line}\n`),
    ...(only ? { only: only.split(',') } : {}),
    ...(shard ? { shard } : {}),
    ...(options.inventory ? { inventory: options.inventory } : {}),
    ...(options.launch ? { launch: options.launch } : {}),
    ...(options.outcome ? { outcome: options.outcome } : {}),
    ...(options.timeLimitMs !== undefined ? { timeLimitMs: options.timeLimitMs } : {}),
    ...(options.dependencyInput !== undefined ? { dependencyInput: options.dependencyInput } : {})
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
    for (const line of missing) say(line)
    return 1
  }
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, RECORD_FILE), `${JSON.stringify(record)}\n`)
  if (shard) {
    const manifest: ShardManifest = { ...shard, commit, tests: summary.attempted, unrecorded: summary.unrecorded }
    writeFileSync(join(out, SHARD_FILE), `${JSON.stringify(manifest)}\n`)
  }
  const slice = shard ? ` (shard ${shard.index} of ${shard.count})` : ''
  const line = `${summary.recorded} of ${summary.tests} test file(s) recorded at ${commit.slice(0, 12)}${slice} in ${(summary.wallMs / 60_000).toFixed(1)} min wall time`
  say(line)
  writeSummary(
    argValue(argv, '--summary'),
    `Read record ${commit.slice(0, 12)}${slice}`,
    `${options.name}: ${line}`,
    summary.unrecorded
  )
  return 0
}
