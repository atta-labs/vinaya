/**
 * What a test file read when it ran: the record a selection decides by, and
 * the reader of the syscall trace that produces it.
 *
 * A record names, per test file, the repository paths the test's process tree
 * opened or probed (a lookup that failed included), the folders it listed, and
 * which of those its own code listed (`scanned`). A changed path selects the
 * test when it is among those reads, or when it was added or deleted in a
 * listed folder that its code listed, beside a name it read that the new name
 * can shadow, or under a name the loader reads by convention (a record without
 * `scanned`: in any listed folder). The record holds no fact of one
 * repository: the caller supplies the workspace package folders and the name of
 * the input the installed dependencies derive from.
 */
import { posix } from 'node:path'

/** The schema name of a stored record. */
export const READ_RECORD_SCHEMA = 'vinaya.read-record'

/** Why a recorded test is decided by static selection instead of its record. */
export type RecordFallback = 'git-read' | 'truncated-path'

/** One test file's recorded reads. */
export type RecordedTest = {
  /** Repository-relative files opened or probed. An entry ending in `/` is a folder: it matches every path beneath it. */
  reads: string[]
  /** Repository-relative folders listed (`.` is the root), by the test's code or by the module resolver alike. */
  listed: string[]
  /**
   * Repository-relative folders the test's own code listed (`.` is the root); an entry ending in `/` was listed
   * recursively and covers every folder beneath it (`./` covers the whole repository). Absent in a record taken
   * without the listing probe: an added or deleted path then reaches the test through any folder in `listed`.
   */
  scanned?: string[]
  /** Set when the test read under `.git/`: the record cannot say what the repository's history changes, so static selection decides. */
  fallback?: RecordFallback
  /** For a `git-read` fallback: the commands that read repository content under `.git/` with no path to name. */
  gitReaders?: string[]
  /** Set when a source file the test read branches on `process.platform`: a record taken on Linux says nothing about another platform. */
  branchesOnPlatform?: boolean
}

/** A commit's record: one entry per test file that ran to success while it was recorded. */
export type ReadRecord = {
  schema: typeof READ_RECORD_SCHEMA
  schemaVersion: 1
  /** The exact commit the record was taken at. */
  commit: string
  /** The platform the tests ran on. */
  platform: string
  tests: Record<string, RecordedTest>
}

export function isReadRecord(value: unknown): value is ReadRecord {
  const v = value as Partial<ReadRecord> | null
  return (
    typeof v === 'object' &&
    v !== null &&
    v.schema === READ_RECORD_SCHEMA &&
    v.schemaVersion === 1 &&
    typeof v.commit === 'string' &&
    typeof v.platform === 'string' &&
    typeof v.tests === 'object' &&
    v.tests !== null &&
    Object.values(v.tests).every(
      (t) =>
        Array.isArray((t as RecordedTest).reads) &&
        Array.isArray((t as RecordedTest).listed) &&
        ((t as RecordedTest).scanned === undefined || Array.isArray((t as RecordedTest).scanned))
    )
  )
}

/** A path's change, as a record sees it. */
export type PathChange = { path: string; status: 'added' | 'deleted' | 'modified' }

/** A test's record indexed for lookups. */
export type RecordIndex = {
  exact: ReadonlySet<string>
  folders: readonly string[]
  listed: ReadonlySet<string>
  /** The folders the test's own code listed, and (trailing `/`, `./` for the root) those it listed recursively; `null` for a record without `scanned`. */
  scanned: ReadonlySet<string> | null
  /** Per folder, the names the test read in it: a file or folder it opened or probed there, or one it read beneath. */
  names: ReadonlyMap<string, ReadonlySet<string>>
  test: RecordedTest
}

export function indexRecordedTest(test: RecordedTest): RecordIndex {
  const names = new Map<string, Set<string>>()
  for (const read of test.reads) {
    const segments = read.replace(/\/+$/, '').split('/')
    for (let at = 0; at < segments.length; at++) {
      const folder = at === 0 ? '.' : segments.slice(0, at).join('/')
      const held = names.get(folder) ?? new Set<string>()
      held.add(segments[at] as string)
      names.set(folder, held)
    }
  }
  return {
    exact: new Set(test.reads.filter((r) => !r.endsWith('/'))),
    folders: test.reads.filter((r) => r.endsWith('/')),
    listed: new Set(test.listed),
    scanned: test.scanned === undefined ? null : new Set(test.scanned),
    names,
    test
  }
}

/**
 * Names the loader reads by convention in a folder it resolves from, without a lookup the trace would show: adding
 * one can change what an unchanged import resolves to (a `package.json` with `main`, a nested `tsconfig.json` with
 * `paths`) or what the process loads.
 */
export function isConventionName(name: string): boolean {
  return (
    name === 'package.json' ||
    name === 'tsconfig.json' ||
    name === 'jsconfig.json' ||
    name === 'bunfig.toml' ||
    name.startsWith('.env')
  )
}

/** Every dot-delimited stem of a name: `x.config.ts` has `x`, `x.config` and `x.config.ts`; a leading dot stays on the first. */
export function nameStems(name: string): string[] {
  const lead = name.startsWith('.') ? '.' : ''
  const parts = name.slice(lead.length).split('.')
  return parts.map((_, at) => `${lead}${parts.slice(0, at + 1).join('.')}`)
}

/** Whether `folder` is among `scanned`, or beneath a folder `scanned` holds as recursively listed. */
function scannedCovers(scanned: ReadonlySet<string>, folder: string): boolean {
  if (scanned.has(folder) || scanned.has('./')) return true
  for (let at = folder; at !== '.'; at = posix.dirname(at)) if (scanned.has(`${at}/`)) return true
  return false
}

// ── Installed dependencies ─────────────────────────────────────────────────

/**
 * A read under the installed dependencies is recorded per package, as the input they derive from joined to the
 * package's name with `#` (`bun.lock#zod`). A change to that input then reaches only the tests that read a package
 * whose entry changed. A read naming no package — the dependency folder itself, which the module resolver opens on
 * every bare import, or a dot-folder such as `.bin` or `.cache` — records nothing: what the test loads from the
 * folder is its per-package reads, so the folder read would only make every test read the whole input.
 */
export const DEPENDENCY_PACKAGE_SEPARATOR = '#'

/** The recorded read for one installed package of `input`. */
export const dependencyRead = (input: string, name: string): string => `${input}${DEPENDENCY_PACKAGE_SEPARATOR}${name}`

/** The change that reaches every package of `input`: the input could not be compared package by package. */
export const anyDependencyRead = (input: string): string => dependencyRead(input, '*')

/** The package an installed path belongs to: the name after the last dependency folder, scoped or not. */
export function installedPackageName(path: string, depFolder = 'node_modules'): string | null {
  const segments = path.split('/')
  const at = segments.lastIndexOf(depFolder)
  if (at < 0) return null
  const first = segments[at + 1]
  if (!first || first.startsWith('.')) return null
  if (!first.startsWith('@')) return first
  const second = segments[at + 2]
  return second ? `${first}/${second}` : null
}

/**
 * Why `change` reaches the recorded test, or `null`: the path is among its
 * reads (`exact` says the read names the very file, not a folder holding it),
 * or it was added or deleted in a folder the test listed.
 *
 * With `scanned`, an added or deleted path reaches the test through the
 * nearest folder above it that the test listed — the path's own folder, or,
 * when the run did not list that, the nearest listed folder above it and the
 * first name below that the path adds or removes — only when that folder (or a
 * folder above it listed recursively) is among `scanned`, when the name is one
 * the loader reads by convention (`package.json`, `tsconfig.json`,
 * `jsconfig.json`, `bunfig.toml`, a `.env` name), or when the test read a
 * name there sharing a dot-delimited stem with it: the module resolver decides
 * from its cached folder listing, so `./foo` can resolve to an added
 * `foo.tsx` or `foo/` with no lookup of it in the trace. Without `scanned`,
 * any listed folder holding the path is enough.
 */
export function recordReach(
  index: RecordIndex,
  change: PathChange
): { detail: string; exact: boolean; via: string } | null {
  if (index.exact.has(change.path))
    return { detail: `the recorded run read ${change.path}`, exact: true, via: change.path }
  const wildcard = change.path.endsWith(`${DEPENDENCY_PACKAGE_SEPARATOR}*`) ? change.path.slice(0, -1) : null
  if (wildcard)
    for (const read of index.exact)
      if (read.startsWith(wildcard))
        return { detail: `the recorded run read the installed package ${read}`, exact: true, via: read }
  const folder = index.folders.find((f) => change.path.startsWith(f))
  if (folder) return { detail: `the recorded run read under ${folder}`, exact: false, via: folder }
  if (change.status === 'modified') return null
  const what = change.status === 'added' ? 'an added' : 'a deleted'
  if (index.scanned === null) {
    const dir = posix.dirname(change.path)
    return index.listed.has(dir)
      ? { detail: `${what} path sits in ${dir}, which the recorded run listed`, exact: false, via: dir }
      : null
  }
  // The nearest folder above the path that the run listed, and the name below it the change adds or removes there.
  let dir = posix.dirname(change.path)
  let name = posix.basename(change.path)
  let walked = false
  while (!index.listed.has(dir)) {
    if (dir === '.') return null
    walked = true
    name = posix.basename(dir)
    dir = posix.dirname(dir)
  }
  const at = !walked ? `${what} path sits in ${dir}` : `${what} path adds or removes ${name} in ${dir}`
  if (scannedCovers(index.scanned, dir))
    return { detail: `${at}, which the recorded run's own code listed`, exact: false, via: dir }
  if (isConventionName(name))
    return { detail: `${at}, where the loader reads ${name} by convention`, exact: false, via: dir }
  const stems = new Set(nameStems(name))
  for (const read of index.names.get(dir) ?? [])
    if (nameStems(read).some((stem) => stems.has(stem)))
      return {
        detail: `${at}, beside ${dir === '.' ? read : `${dir}/${read}`}, which the recorded run read and ${name} can shadow`,
        exact: false,
        via: dir
      }
  return null
}

// ── The syscall trace ──────────────────────────────────────────────────────

export type TraceReads = {
  /** Repository-relative files and (trailing `/`) folders. */
  reads: Set<string>
  /** Repository-relative folders listed. */
  listed: Set<string>
  /**
   * The listed folders the trace alone counts as the test's own code listing: every folder listed by a process image
   * the listing probe did not run in (a child such as git, find or a nested `bun`), by one the probe logged as wholly
   * scanned, or by a thread whose process the trace never named.
   */
  processScanned: Set<string>
  /** Whether repository content under `.git/` (an object or the index) was read by a command whose paths are unknown. */
  git: boolean
  /** The commands that made `git` true, as their argument lists, for the record to name. */
  gitReaders: Set<string>
  /** Whether a path argument was cut short by the tracer, so a read went unrecorded. */
  truncated: boolean
}

export type TraceOptions = {
  /** Absolute repository root, realpath'd. */
  repoRoot: string
  /** The working directory the traced command started in, absolute. */
  startCwd: string
  /** Absolute path to its realpath; a path that does not exist resolves through its deepest existing parent. */
  realpath: (absolute: string) => string
  /** Repository-relative workspace package folders: a read under one's `dist/` is recorded as its source folder. */
  packageDirs: readonly string[]
  /** The source folder of a package, repository-relative with a trailing `/`. */
  sourceFolder?: (packageDir: string) => string
  /** What a read under third-party installed dependencies is recorded as (the input they derive from), or `null` to drop it. */
  dependencyInput: string | null
  /** The folder installed dependencies live in. */
  dependencyFolder?: string
  /** What the listing probe logged in this run; without it no process counts as probed. */
  probe?: ProbeTrace
}

/** The listing probe's log as the trace reader uses it: which processes it ran in and which it wholly scanned. */
export type ProbeTrace = {
  /** The absolute path of the probe's log file: a process image that opened it is one the probe ran in. */
  log: string
  /** The process ids that wrote a start line. */
  starts: ReadonlySet<string>
  /** The process ids the probe logged as wholly scanned. */
  wholly: ReadonlySet<string>
}

/** Syscalls whose first or second string argument is a path the process looked at. */
const PATH_CALLS = new Set([
  'open',
  'openat',
  'openat2',
  'creat',
  'stat',
  'lstat',
  'newfstatat',
  'fstatat64',
  'statx',
  'access',
  'faccessat',
  'faccessat2',
  'readlink',
  'readlinkat',
  'execve',
  'execveat',
  'chdir',
  'statfs',
  'getxattr',
  'lgetxattr'
])
/** Calls whose path is relative to a directory fd (or the working directory) given as the first argument. */
const AT_CALLS = new Set([
  'openat',
  'openat2',
  'newfstatat',
  'fstatat64',
  'statx',
  'faccessat',
  'faccessat2',
  'readlinkat',
  'execveat'
])
const CLONE_CALLS = new Set(['clone', 'clone3', 'fork', 'vfork'])

/**
 * Whether a path under `.git/` is a read of repository content: an object or the index. Git touches the rest on every
 * command to find the repository — `.git` itself, `HEAD`, `config`, the refs, and an `access` of the objects folder —
 * and those name no tracked file's content.
 */
export function isGitContentRead(rel: string): boolean {
  if (rel === '.git/index') return true
  return rel.startsWith('.git/objects/') && !rel.startsWith('.git/objects/info/')
}

/** An `execve` call's argument list, decoded; `null` when it was printed cut short or cannot be read. */
export function execArguments(args: string): string[] | null {
  const program = leadingString(args)
  if (!program || program.truncated) return null
  let rest = program.rest.replace(/^\s*,\s*\[/, '')
  if (rest === program.rest) return null
  const argv: string[] = []
  for (;;) {
    const arg = leadingString(rest)
    if (!arg) break
    if (arg.truncated) return null
    argv.push(arg.value)
    rest = arg.rest.replace(/^\s*,\s*/, '')
  }
  return rest.startsWith(']') ? argv : null
}

/** Git subcommands whose object reads are exactly the `<rev>:<path>` arguments they name. */
const GIT_PATH_READERS = new Set(['show', 'cat-file', 'rev-parse'])

/**
 * The repository paths a git command reads through its objects, from an `execve` call's arguments: `git show
 * HEAD:vinaya.config.json` reads `vinaya.config.json`. `null` when the call is not git, is one whose object reads
 * name no path (`git show HEAD`, `git log`), or was printed cut short.
 */
export function gitPathArguments(args: string): string[] | null {
  const program = leadingString(args)
  if (!program || program.truncated || !/(?:^|\/)git$/.test(program.value)) return null
  const argv = execArguments(args)
  if (argv === null) return null
  let i = 1
  while (i < argv.length && (argv[i] as string).startsWith('-')) i += argv[i] === '-C' || argv[i] === '-c' ? 2 : 1
  const sub = argv[i]
  if (sub === undefined || !GIT_PATH_READERS.has(sub)) return null
  const paths: string[] = []
  for (const arg of argv.slice(i + 1)) {
    if (arg.startsWith('-')) continue
    const at = arg.indexOf(':')
    const path = at > 0 ? arg.slice(at + 1) : ''
    if (path !== '' && !path.startsWith('./') && !path.startsWith('../') && !path.startsWith('/')) paths.push(path)
    else if (sub !== 'rev-parse') return null
  }
  return sub === 'rev-parse' || paths.length > 0 ? paths : null
}

/**
 * A listed folder as the record names it, or `null` when the record keeps no listing for it: the absolute path
 * resolved through symbolic links (unless `resolved`) and made repository-relative; a path outside the repository,
 * under `.git/` or under installed dependencies names none.
 */
export function repositoryFolder(absolute: string, options: TraceOptions, resolved = false): string | null {
  const real = resolved ? absolute : options.realpath(absolute)
  const root = options.repoRoot
  const rel = real === root ? '.' : real.startsWith(`${root}/`) ? real.slice(root.length + 1) : null
  if (rel === null || rel === '.git' || rel.startsWith('.git/')) return null
  const depFolder = options.dependencyFolder ?? 'node_modules'
  if (
    rel === depFolder ||
    rel.startsWith(`${depFolder}/`) ||
    rel.includes(`/${depFolder}/`) ||
    rel.endsWith(`/${depFolder}`)
  )
    return null
  return rel
}

/** Whether a `clone`/`clone3` call's printed flags start a thread of the calling process rather than a new process. */
export const startsThread = (args: string): boolean => /\bCLONE_THREAD\b/.test(args)

const LINE = /^(?:\[pid\s+(\d+)\]\s+|(\d+)\s+)?/
const RESUMED = /^<\.\.\. (\w+) resumed>/

/** A quoted strace string at the start of `text`, decoded, and what follows it. */
function leadingString(text: string): { value: string; rest: string; truncated: boolean } | null {
  if (text[0] !== '"') return null
  const bytes: number[] = []
  let i = 1
  while (i < text.length) {
    const c = text[i] as string
    if (c === '"') break
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'))
      i++
      continue
    }
    const n = text[i + 1] as string
    const simple: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 }
    if (n !== undefined && n in simple) {
      bytes.push(simple[n] as number)
      i += 2
    } else if (n === 'x') {
      bytes.push(Number.parseInt(text.slice(i + 2, i + 4), 16))
      i += 4
    } else {
      const octal = /^[0-7]{1,3}/.exec(text.slice(i + 1))
      if (octal) {
        bytes.push(Number.parseInt(octal[0], 8))
        i += 1 + octal[0].length
      } else i += 2
    }
  }
  if (i >= text.length) return null
  const rest = text.slice(i + 1)
  const truncated = rest.startsWith('...')
  return { value: Buffer.from(bytes).toString('utf8'), rest: truncated ? rest.slice(3) : rest, truncated }
}

/** A directory-fd argument: `AT_FDCWD`, `AT_FDCWD</cwd>`, `3</dir>` or a bare number; the path it names when `-yy` printed one. */
function leadingDirectory(text: string): { dir: string | 'cwd' | null; rest: string } | null {
  const m = /^(AT_FDCWD|-?\d+)(?:<([^>]*)>)?\s*,\s*/s.exec(text)
  if (!m) return null
  const rest = text.slice(m[0].length)
  if (m[1] === 'AT_FDCWD') return { dir: m[2] ? m[2] : 'cwd', rest }
  return { dir: m[2] ? m[2] : null, rest }
}

/**
 * The paths a `strace -f -yy -e trace=%file,getdents64` trace shows the traced
 * process tree reading, as repository-relative paths.
 *
 * Each process keeps its own working directory (`chdir`; a child starts in its
 * parent's). A path is made absolute against its directory argument or its
 * process's working directory, then resolved through symbolic links — the
 * resolved path `-yy` prints for a successful open is used as is, and a lookup
 * that failed resolves through its deepest existing parent — so a workspace
 * symlink lands on its package folder. Paths outside the repository are
 * dropped; a read under a package's `dist/` becomes its source folder, and a
 * read under third-party installed dependencies becomes the input they derive
 * from.
 */
export function readsOfTrace(trace: string, options: TraceOptions): TraceReads {
  const reader = createTraceReader(options)
  for (const line of trace.split('\n')) reader.feed(line)
  return reader.result()
}

/** The same reader fed one trace line at a time, for a trace too large to hold as one string. */
export function createTraceReader(options: TraceOptions): { feed(line: string): void; result(): TraceReads } {
  const reads = new Set<string>()
  const listed = new Set<string>()
  let git = false
  let truncated = false
  const cwds = new Map<string, string>()
  const cwdOf = (pid: string) => cwds.get(pid) ?? options.startCwd
  const root = options.repoRoot
  const depFolder = options.dependencyFolder ?? 'node_modules'
  const sourceFolder = options.sourceFolder ?? ((dir: string) => `${dir}/src/`)
  const packageDirs = [...options.packageDirs].sort((a, b) => b.length - a.length)

  const relativeOf = (absolute: string): string | null => {
    if (absolute === root) return '.'
    return absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : null
  }
  /** The repository paths a git process reads through `<rev>:<path>` arguments, by process id. */
  const gitPathReads = new Map<string, readonly string[]>()
  /** Each process's program and arguments, from its last `execve`; an `execve` printed in two halves waits here. */
  const commands = new Map<string, string>()
  const pendingExec = new Map<string, string>()
  const gitReaders = new Set<string>()

  /**
   * A process image: one process from its start, or from its last successful `execve`, to the next. Every thread
   * (a `clone` with `CLONE_THREAD`) folds into the image of the process that started it, so a listing is attributed
   * by process, never by thread id. The first process the trace shows is the traced command; any other id seen
   * before the call that started it is provisional until that call's result names it, and one never named stays
   * a thread of an unknown process.
   */
  type Image = { pid: string; provisional: boolean; probed: boolean; listed: Set<string>; into?: Image }
  const images: Image[] = []
  const imageOf = new Map<string, Image>()
  const pendingClone = new Map<string, string>()
  const find = (image: Image): Image => {
    let at = image
    while (at.into) at = at.into
    return at
  }
  const newImage = (pid: string, provisional: boolean): Image => {
    const image: Image = { pid, provisional, probed: false, listed: new Set() }
    images.push(image)
    return image
  }
  const imageFor = (tid: string): Image => {
    const known = imageOf.get(tid)
    if (known) return find(known)
    const image = newImage(tid, images.length > 0)
    imageOf.set(tid, image)
    return image
  }
  const started = (parent: string, child: string, thread: boolean): void => {
    const owner = imageFor(parent)
    const early = imageOf.get(child)
    const seen = early ? find(early) : undefined
    if (thread) {
      if (seen?.provisional && seen !== owner) {
        for (const folder of seen.listed) owner.listed.add(folder)
        owner.probed ||= seen.probed
        seen.listed.clear()
        seen.into = owner
      }
      imageOf.set(child, owner)
    } else if (seen?.provisional) seen.provisional = false
    else imageOf.set(child, newImage(child, false))
  }
  const cloned = (pid: string, name: string, args: string, body: string): void => {
    const child = /=\s*(\d+)\s*$/.exec(body)?.[1]
    if (child === undefined || child === '0') return
    if (!cwds.has(child)) cwds.set(child, cwdOf(pid))
    started(pid, child, (name === 'clone' || name === 'clone3') && startsThread(args))
  }
  /** A successful `execve` replaces the whole process image; the process keeps its id. */
  const replaced = (tid: string): void => {
    const old = imageFor(tid)
    const image = newImage(old.pid, old.provisional)
    imageOf.set(tid, image)
    imageOf.set(old.pid, image)
  }
  const probeLog = options.probe?.log
  const opened = (path: string, pid: string): void => {
    if (probeLog !== undefined && path === probeLog) imageFor(pid).probed = true
  }

  const startProgram = (pid: string, args: string) => {
    replaced(pid)
    const paths = gitPathArguments(args)
    if (paths) gitPathReads.set(pid, paths)
    else gitPathReads.delete(pid)
    const argv = execArguments(args)
    commands.set(pid, argv ? argv.join(' ') : 'an unreadable command')
  }
  const record = (absolute: string, resolved: boolean, kind: 'read' | 'list', pid = '0') => {
    const real = resolved ? absolute : options.realpath(absolute)
    const rel = relativeOf(real)
    if (rel === null) return
    if (rel === '.git' || rel.startsWith('.git/')) {
      if (isGitContentRead(rel)) {
        const mapped = gitPathReads.get(pid)
        // The argument may name a file or a folder (a tree): both readings are kept.
        if (mapped) for (const path of mapped) reads.add(path).add(`${path.replace(/\/+$/, '')}/`)
        else {
          git = true
          gitReaders.add(commands.get(pid) ?? 'the test process')
        }
      }
      if (rel !== '.git') return
    }
    if (
      rel === depFolder ||
      rel.startsWith(`${depFolder}/`) ||
      rel.includes(`/${depFolder}/`) ||
      rel.endsWith(`/${depFolder}`)
    ) {
      if (options.dependencyInput !== null) {
        const name = installedPackageName(rel, depFolder)
        if (name) reads.add(dependencyRead(options.dependencyInput, name))
      }
      return
    }
    if (kind === 'list') {
      listed.add(rel)
      return
    }
    const pkg = packageDirs.find((d) => rel === `${d}/dist` || rel.startsWith(`${d}/dist/`))
    reads.add(pkg ? sourceFolder(pkg) : rel)
  }
  const absolute = (path: string, dir: string | 'cwd' | null, pid: string): string | null => {
    if (path.startsWith('/')) return posix.normalize(path)
    const base = dir === 'cwd' || dir === null ? (dir === null ? null : cwdOf(pid)) : dir
    return base === null ? null : posix.normalize(posix.join(base, path))
  }

  const feed = (raw: string): void => {
    const prefix = LINE.exec(raw)
    if (!prefix) return
    const pid = (prefix[1] ?? prefix[2] ?? '0') as string
    const body = raw.replace(/^(?:\[pid\s+\d+\]\s+|\d+\s+)/, '')
    if (body.trim() === '') return
    imageFor(pid)
    const resumed = RESUMED.exec(body)
    if (resumed) {
      if (resumed[1] === 'execve') {
        const args = pendingExec.get(pid)
        pendingExec.delete(pid)
        if (args !== undefined && /\)\s*=\s*0\s*$/.test(body)) startProgram(pid, args)
        return
      }
      if (CLONE_CALLS.has(resumed[1] as string)) {
        // The flags were on the unfinished half; the child's id is on this one.
        const args = pendingClone.get(pid) ?? ''
        pendingClone.delete(pid)
        cloned(pid, resumed[1] as string, args, body)
        return
      }
      // The arguments were on the unfinished half; the result's descriptor path still names a resolved file.
      const fd = /\)\s*=\s*\d+<([^>]+)>/.exec(body)
      if (fd && PATH_CALLS.has(resumed[1] as string)) {
        opened(fd[1] as string, pid)
        record(fd[1] as string, true, 'read', pid)
      }
      return
    }
    const call = /^(\w+)\((.*)$/s.exec(body)
    if (!call) return
    const name = call[1] as string
    const args = call[2] as string

    if (CLONE_CALLS.has(name)) {
      if (/<unfinished \.\.\.>\s*$/.test(body)) pendingClone.set(pid, args)
      else cloned(pid, name, args, body)
      return
    }
    if (name === 'getdents64' || name === 'getdents') {
      const fd = /^\d+<([^>]+)>/.exec(args)
      if (fd) {
        record(fd[1] as string, true, 'list', pid)
        const folder = repositoryFolder(fd[1] as string, options, true)
        if (folder !== null) imageFor(pid).listed.add(folder)
      }
      return
    }
    if (!PATH_CALLS.has(name)) return
    if (name === 'execve') {
      if (/<unfinished \.\.\.>\s*$/.test(body)) pendingExec.set(pid, args)
      else if (/\)\s*=\s*0\s*$/.test(body)) startProgram(pid, args)
    }

    let rest = args
    let dir: string | 'cwd' | null = 'cwd'
    if (AT_CALLS.has(name)) {
      const d = leadingDirectory(rest)
      if (!d) return
      dir = d.dir
      rest = d.rest
    }
    const str = leadingString(rest)
    if (str?.truncated) truncated = true
    if (!str || str.truncated) return
    const target = absolute(str.value, dir, pid)
    if (target === null) return
    // The resolved descriptor path of a successful open, else the path as the process spelled it.
    const done = /\)\s*=\s*\d+<([^>]+)>\s*$/.exec(body)
    const failed = /\)\s*=\s*-1\b/.test(body)
    const opens = name === 'open' || name === 'openat' || name === 'openat2' || name === 'creat'
    if (opens && !failed) {
      opened(target, pid)
      if (done) opened(done[1] as string, pid)
    }
    if (done && !failed && opens) record(done[1] as string, true, 'read', pid)
    else record(target, false, 'read', pid)
    if (name === 'chdir' && !failed && /\)\s*=\s*0\s*$/.test(body)) cwds.set(pid, options.realpath(target))
  }
  const result = (): TraceReads => {
    const processScanned = new Set<string>()
    const probe = options.probe
    for (const image of images) {
      if (image.into) continue
      // Probed: the image opened the probe's log and the log holds a start line from its process id. A re-executed
      // process, or a reused id, is a new image that opened nothing, so it does not count as probed.
      const probed =
        image.probed &&
        !image.provisional &&
        probe !== undefined &&
        probe.starts.has(image.pid) &&
        !probe.wholly.has(image.pid)
      if (!probed) for (const folder of image.listed) processScanned.add(folder)
    }
    return { reads, listed, processScanned, git, gitReaders, truncated }
  }
  return { feed, result }
}
