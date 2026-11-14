// The syscall-trace reader's own tests: hand-written `strace -f -yy -e trace=%file,getdents64` output, the shapes
// a Bun test and the child processes it starts leave, and the shipped recorder that builds a record entry from them.
// They import only the public entrypoint.
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import {
  gitPathArguments,
  isGitContentRead,
  bunLockIdentity,
  changedLockPackages,
  foldersOf,
  indexRecordedTest,
  installedPackageName,
  isConventionName,
  lockKeyPackageName,
  nameStems,
  newFolderOf,
  readsOfTrace,
  recordReach,
  stableJson,
  startsThread,
  type TraceOptions,
  exitStatusOutcome,
  type NativeGroup,
  plainLaunch,
  readProbeLog,
  recordCommand,
  recordedTestOf,
  coverageOfLcov,
  fileCoverage,
  isReadRecord,
  lineSpans,
  READ_RECORD_SCHEMA,
  READ_RECORD_VERSION,
  type ReadRecord,
  type RecordedTest,
  selectTests
} from '../src/index.js'
import { fixture, type Scenario, scenarioInput, viewOf } from './fixture-repos.js'

const ROOT = '/work/repo'

/** A path resolver over a table of symbolic links, as the recorder's `realpath` is over the disk. */
const links = (table: Record<string, string>) => (absolute: string) => {
  for (const [from, to] of Object.entries(table))
    if (absolute === from || absolute.startsWith(`${from}/`)) return posix.join(to, absolute.slice(from.length))
  return absolute
}

const options = (over: Partial<TraceOptions> = {}): TraceOptions => ({
  repoRoot: ROOT,
  startCwd: `${ROOT}/apps/cli`,
  realpath: links({ [`${ROOT}/node_modules/@fx/core`]: `${ROOT}/packages/core` }),
  packageDirs: ['packages/core', 'apps/cli'],
  dependencyInput: 'bun.lock',
  ...over
})

const trace = (...lines: string[]) => `${lines.join('\n')}\n`

describe('the syscall trace reader', () => {
  it('records the files a process opened or probed, failed lookups included, as repository-relative paths', () => {
    const result = readsOfTrace(
      trace(
        `100 openat(AT_FDCWD</work/repo/apps/cli>, "/work/repo/apps/cli/tests/a.test.ts", O_RDONLY|O_CLOEXEC) = 3</work/repo/apps/cli/tests/a.test.ts>`,
        `100 newfstatat(AT_FDCWD</work/repo/apps/cli>, "tests/data/missing.json", 0x7ffd, 0) = -1 ENOENT (No such file or directory)`,
        `100 access("../../vinaya.config.json", R_OK) = 0`,
        `100 readlink("/work/repo/apps/cli/tests", 0x7ffd, 4096) = -1 EINVAL (Invalid argument)`,
        `100 openat(AT_FDCWD</work/repo/apps/cli>, "/etc/hosts", O_RDONLY) = 4</etc/hosts>`
      ),
      options()
    )
    expect([...result.reads].sort()).toEqual([
      'apps/cli/tests',
      'apps/cli/tests/a.test.ts',
      'apps/cli/tests/data/missing.json',
      'vinaya.config.json'
    ])
    expect(result.git).toBe(false)
  })

  it('records the folders listed', () => {
    const result = readsOfTrace(
      trace(
        `7 openat(AT_FDCWD</work/repo>, "packages/core/src", O_RDONLY|O_DIRECTORY) = 5</work/repo/packages/core/src>`,
        '7 getdents64(5</work/repo/packages/core/src>, 0x55 /* 4 entries */, 32768) = 120',
        '7 getdents64(5</work/repo/packages/core/src>, 0x55 /* 0 entries */, 32768) = 0'
      ),
      options()
    )
    expect([...result.listed]).toEqual(['packages/core/src'])
    expect(result.reads.has('packages/core/src')).toBe(true)
  })

  it('resolves a workspace symlink to its package folder, for a read that failed and one that did not', () => {
    const result = readsOfTrace(
      trace(
        `1 openat(AT_FDCWD</work/repo/apps/cli>, "/work/repo/node_modules/@fx/core/src/add.ts", O_RDONLY) = 3</work/repo/packages/core/src/add.ts>`,
        `1 stat("/work/repo/node_modules/@fx/core/src/absent.ts", 0x7ffd) = -1 ENOENT (No such file or directory)`
      ),
      options()
    )
    expect([...result.reads].sort()).toEqual(['packages/core/src/absent.ts', 'packages/core/src/add.ts'])
  })

  it("follows a child process's working directory, including a child of a child, and each process keeps its own", () => {
    const result = readsOfTrace(
      trace(
        '10 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|SIGCHLD) = 11',
        `[pid    11] chdir("/work/repo/packages/core") = 0`,
        '[pid    11] clone(child_stack=NULL, flags=SIGCHLD) = 12',
        `[pid    12] openat(AT_FDCWD, "src/add.ts", O_RDONLY) = 3</work/repo/packages/core/src/add.ts>`,
        `[pid    12] stat("package.json", 0x7ffd) = 0`,
        `10 stat("package.json", 0x7ffd) = 0`
      ),
      options()
    )
    expect([...result.reads].sort()).toEqual([
      'apps/cli/package.json',
      'packages/core',
      'packages/core/package.json',
      'packages/core/src/add.ts'
    ])
  })

  it('reads an unfinished call and its resumed half', () => {
    const result = readsOfTrace(
      trace(
        `20 openat(AT_FDCWD</work/repo>, "packages/core/src/mul.ts", O_RDONLY <unfinished ...>`,
        `21 stat("package.json", 0x7ffd) = 0`,
        '20 <... openat resumed>) = 3</work/repo/packages/core/src/mul.ts>'
      ),
      options()
    )
    expect(result.reads.has('packages/core/src/mul.ts')).toBe(true)
    expect(result.reads.has('apps/cli/package.json')).toBe(true)
  })

  it('records a read under a package build output as that package source folder', () => {
    const result = readsOfTrace(
      trace(
        `1 openat(AT_FDCWD</work/repo>, "packages/core/dist/index.js", O_RDONLY) = 3</work/repo/packages/core/dist/index.js>`,
        `1 stat("dist/index.js", 0x7ffd) = 0`
      ),
      options()
    )
    expect([...result.reads].sort()).toEqual(['apps/cli/src/', 'packages/core/src/'])
  })

  it('records a read under installed third-party dependencies as the input they derive from, per package', () => {
    const result = readsOfTrace(
      trace(
        `1 openat(AT_FDCWD</work/repo>, "node_modules/typescript/lib/typescript.js", O_RDONLY) = 3</work/repo/node_modules/.bun/typescript@5/node_modules/typescript/lib/typescript.js>`
      ),
      options()
    )
    expect([...result.reads]).toEqual(['bun.lock#typescript'])
    const scoped = readsOfTrace(
      trace(
        '1 openat(AT_FDCWD</work/repo>, "/work/repo/node_modules/@sanity/client/dist/index.js", O_RDONLY) = 3',
        '1 openat(AT_FDCWD</work/repo>, "/work/repo/node_modules/a/node_modules/b/index.js", O_RDONLY) = 4',
        '1 getdents64(5</work/repo/node_modules>, 0x1, 32768) = 0',
        '1 stat("/work/repo/node_modules/.bin/tsc", 0x7) = 0'
      ),
      options()
    )
    expect([...scoped.reads].sort()).toEqual(['bun.lock#@sanity/client', 'bun.lock#b'])
    expect([
      ...readsOfTrace(`1 stat("/work/repo/node_modules/x", 0x7) = 0\n`, options({ dependencyInput: null })).reads
    ]).toEqual([])
  })

  it('records nothing for the dependency folder the module resolver opens, and keeps a real read of the lockfile', () => {
    // The shape Bun's resolver leaves on every bare import: the folder itself, opened as a directory.
    const resolver = readsOfTrace(
      trace(
        '1 openat(AT_FDCWD</work/repo>, "/work/repo/node_modules/", O_RDONLY|O_LARGEFILE|O_CLOEXEC|O_DIRECTORY) = 13</work/repo/node_modules>',
        '1 openat(AT_FDCWD</work/repo>, "/work/repo/apps/cli/node_modules/", O_RDONLY|O_DIRECTORY) = 11</work/repo/apps/cli/node_modules>'
      ),
      options()
    )
    expect([...resolver.reads]).toEqual([])
    const lockReader = readsOfTrace(
      trace('1 openat(AT_FDCWD</work/repo>, "/work/repo/bun.lock", O_RDONLY|O_CLOEXEC) = 3</work/repo/bun.lock>'),
      options()
    )
    expect([...lockReader.reads]).toEqual(['bun.lock'])
  })

  it('marks a read of repository content under .git/ for static fallback', () => {
    const object = readsOfTrace(
      trace(
        `1 openat(AT_FDCWD</work/repo>, ".git/objects/pack/pack-1.idx", O_RDONLY) = 3</work/repo/.git/objects/pack/pack-1.idx>`
      ),
      options()
    )
    expect(object.git).toBe(true)
    expect(object.reads.has('.git/objects/pack/pack-1.idx')).toBe(false)
    expect(readsOfTrace(trace('1 stat("/work/repo/.git/index", 0x7) = 0'), options()).git).toBe(true)
  })

  it('does not mark the reads git makes to find the repository', () => {
    // The shape every git command leaves: HEAD, config, refs, and an access of the objects folder.
    const result = readsOfTrace(
      trace(
        `1 openat(AT_FDCWD</work/repo>, ".git/HEAD", O_RDONLY) = 3</work/repo/.git/HEAD>`,
        '1 stat("/work/repo/.git/config", 0x7) = 0',
        '1 openat(AT_FDCWD</work/repo>, "/work/repo/.git/refs/heads/main", O_RDONLY) = 4</work/repo/.git/refs/heads/main>',
        '1 access("/work/repo/.git/objects", X_OK) = 0',
        '1 stat("/work/repo/.git/objects/info/alternates", 0x7) = -1 ENOENT (No such file or directory)'
      ),
      options()
    )
    expect(result.git).toBe(false)
    expect([...result.reads].filter((r) => r.startsWith('.git/'))).toEqual([])
  })

  it('records the path a git command reads through a <rev>:<path> argument instead of marking it', () => {
    const show = readsOfTrace(
      trace(
        '7 execve("/usr/bin/git", ["git", "-C", "/work/repo", "show", "HEAD:vinaya.config.json"], 0x7ffe /* 12 vars */) = 0',
        `7 openat(AT_FDCWD</work/repo>, "/work/repo/.git/objects/pack/pack-1.idx", O_RDONLY) = 3</work/repo/.git/objects/pack/pack-1.idx>`
      ),
      options()
    )
    expect(show.git).toBe(false)
    expect(show.reads.has('vinaya.config.json')).toBe(true)
    const log = readsOfTrace(
      trace(
        '8 execve("/usr/bin/git", ["git", "log", "--oneline"], 0x7ffe /* 12 vars */) = 0',
        `8 openat(AT_FDCWD</work/repo>, "/work/repo/.git/objects/pack/pack-1.idx", O_RDONLY) = 3</work/repo/.git/objects/pack/pack-1.idx>`
      ),
      options()
    )
    expect(log.git).toBe(true)
  })

  it('follows an execve the tracer printed in two halves, and names the command behind a fallback', () => {
    const split = readsOfTrace(
      trace(
        '9 execve("/usr/bin/git", ["git", "show", "HEAD:a.json"], 0x7ffe /* 4 vars */ <unfinished ...>',
        '9 <... execve resumed>)                = 0',
        `9 openat(AT_FDCWD</work/repo>, "/work/repo/.git/objects/pack/pack-1.idx", O_RDONLY) = 3</work/repo/.git/objects/pack/pack-1.idx>`
      ),
      options()
    )
    expect(split.git).toBe(false)
    expect(split.reads.has('a.json')).toBe(true)
    const log = readsOfTrace(
      trace(
        '8 execve("/usr/bin/git", ["git", "log", "--oneline"], 0x7ffe /* 12 vars */ <unfinished ...>',
        '8 <... execve resumed>)                = 0',
        '8 stat("/work/repo/.git/index", 0x7) = 0'
      ),
      options()
    )
    expect(log.git).toBe(true)
    expect([...log.gitReaders]).toEqual(['git log --oneline'])
  })

  it('reads the paths of a git command only from <rev>:<path> arguments it can name', () => {
    expect(gitPathArguments('"/usr/bin/git", ["git", "show", "HEAD:a/b.json"], 0x1 /* 3 vars */')).toEqual(['a/b.json'])
    expect(gitPathArguments('"/usr/bin/git", ["git", "rev-parse", "HEAD"], 0x1')).toEqual([])
    expect(gitPathArguments('"/usr/bin/git", ["git", "show", "HEAD"], 0x1')).toBeNull()
    expect(gitPathArguments('"/usr/bin/git", ["git", "show", "HEAD:./a.json"], 0x1')).toBeNull()
    expect(gitPathArguments('"/usr/bin/git", ["git", "cat-file", "--batch"], 0x1')).toBeNull()
    expect(gitPathArguments('"/usr/bin/git", ["git", "show", "HEAD:a"...], 0x1')).toBeNull()
    expect(gitPathArguments('"/usr/bin/node", ["node", "show", "HEAD:a"], 0x1')).toBeNull()
    expect(isGitContentRead('.git/objects')).toBe(false)
    expect(isGitContentRead('.git/objects/ab/cdef')).toBe(true)
  })

  it('decodes escaped and non-ASCII names, and ignores a truncated string', () => {
    const result = readsOfTrace(
      trace(
        `1 stat("/work/repo/a b\\"c.ts", 0x7) = -1 ENOENT (No such file or directory)`,
        `1 stat("/work/repo/caf\\303\\251.ts", 0x7) = 0`,
        `1 stat("/work/repo/very/long/pa"..., 0x7) = -1 ENOENT (No such file or directory)`
      ),
      options()
    )
    expect([...result.reads].sort()).toEqual(['a b"c.ts', 'café.ts'])
  })

  it('a directory-relative call resolves against the descriptor path -yy printed', () => {
    const result = readsOfTrace(
      trace(`1 openat(6</work/repo/packages/core/src>, "add.ts", O_RDONLY) = 7</work/repo/packages/core/src/add.ts>`),
      options()
    )
    expect([...result.reads]).toEqual(['packages/core/src/add.ts'])
  })
})

describe('a record answers for a change', () => {
  const index = indexRecordedTest({ reads: ['a/b.ts', 'src/'], listed: ['a'] })

  it('by the file read, a folder read, or an added or deleted path in a listed folder', () => {
    expect(recordReach(index, { path: 'a/b.ts', status: 'modified' })?.exact).toBe(true)
    expect(recordReach(index, { path: 'src/deep/x.ts', status: 'modified' })?.exact).toBe(false)
    expect(recordReach(index, { path: 'a/new.ts', status: 'added' })?.detail).toContain('listed')
    expect(recordReach(index, { path: 'a/old.ts', status: 'deleted' })).not.toBeNull()
    expect(recordReach(index, { path: 'a/other.ts', status: 'modified' })).toBeNull()
    expect(recordReach(index, { path: 'z.ts', status: 'added' })).toBeNull()
  })

  it('a record without scanned keeps every test that listed the folder, as before', () => {
    const loaded = indexRecordedTest({ reads: ['int/mod.ts'], listed: ['int'] })
    expect(recordReach(loaded, { path: 'int/unrelated.ts', status: 'added' })?.detail).toBe(
      'an added path sits in int, which the recorded run listed'
    )
    expect(recordReach(loaded, { path: 'int/new/deep.ts', status: 'added' })).toBeNull()
  })
})

describe('an added or deleted path, with the folders the test’s own code listed', () => {
  // The resolver listed `int` to load `int/mod.ts`; the test's code listed nothing there.
  const loaded = indexRecordedTest({
    reads: ['int/mod.ts', 'int/widget/index.ts'],
    listed: ['int', 'int/widget'],
    scanned: []
  })
  // The test's code listed `int` itself.
  const scanner = indexRecordedTest({ reads: ['int/mod.ts'], listed: ['int'], scanned: ['int'] })

  it('keeps a test whose code listed the folder, and drops one that only loaded a module from it', () => {
    expect(recordReach(scanner, { path: 'int/unrelated.ts', status: 'added' })?.detail).toBe(
      "an added path sits in int, which the recorded run's own code listed"
    )
    expect(recordReach(scanner, { path: 'int/old.ts', status: 'deleted' })?.detail).toContain('own code listed')
    expect(recordReach(loaded, { path: 'int/unrelated.ts', status: 'added' })).toBeNull()
    expect(recordReach(loaded, { path: 'int/old.ts', status: 'deleted' })).toBeNull()
  })

  it('keeps a test whose read name the added path shadows, by any dot-delimited stem, file or folder', () => {
    expect(recordReach(loaded, { path: 'int/mod.tsx', status: 'added' })?.detail).toBe(
      'an added path sits in int, beside int/mod.ts, which the recorded run read and mod.tsx can shadow'
    )
    expect(recordReach(loaded, { path: 'int/mod.d.ts', status: 'added' })).not.toBeNull()
    expect(recordReach(loaded, { path: 'int/widget.tsx', status: 'added' })).not.toBeNull()
    // A new folder `int/mod/` holds an index the specifier `./mod` can now resolve to.
    expect(recordReach(loaded, { path: 'int/mod/index.ts', status: 'added' })?.detail).toBe(
      'an added path adds or removes mod in int, beside int/mod.ts, which the recorded run read and mod can shadow'
    )
    expect(recordReach(loaded, { path: 'int/modest.ts', status: 'added' })).toBeNull()
    // A failed lookup of a name that does not exist yet is a read too.
    const probed = indexRecordedTest({ reads: ['int/later.config'], listed: ['int'], scanned: [] })
    expect(recordReach(probed, { path: 'int/later.config.ts', status: 'added' })).not.toBeNull()
  })

  it('keeps every listing test for a name the loader reads by convention', () => {
    for (const name of ['package.json', 'tsconfig.json', 'jsconfig.json', 'bunfig.toml', '.env', '.env.local'])
      expect(recordReach(loaded, { path: `int/${name}`, status: 'added' })?.detail).toContain('by convention')
    expect(recordReach(loaded, { path: 'int/widget/package.json', status: 'added' })?.detail).toBe(
      'an added path sits in int/widget, where the loader reads package.json by convention'
    )
    // A nested folder the run did not list: the rule applies at `int`, to the new folder `nested`.
    expect(recordReach(loaded, { path: 'int/nested/tsconfig.json', status: 'added' })).toBeNull()
    expect(recordReach(loaded, { path: 'elsewhere/package.json', status: 'added' })).toBeNull()
  })

  it('a folder listed recursively covers the folders beneath it, and the root’s covers everything', () => {
    const recursive = indexRecordedTest({ reads: [], listed: ['src', 'src/a', 'src/a/b'], scanned: ['src/'] })
    expect(recordReach(recursive, { path: 'src/a/b/x.ts', status: 'added' })?.detail).toContain('own code listed')
    expect(recordReach(recursive, { path: 'src/a/new/x.ts', status: 'added' })?.detail).toBe(
      "an added path adds or removes new in src/a, which the recorded run's own code listed"
    )
    const everything = indexRecordedTest({ reads: [], listed: ['.', 'lib'], scanned: ['./'] })
    expect(recordReach(everything, { path: 'lib/x.ts', status: 'deleted' })).not.toBeNull()
    expect(recordReach(everything, { path: 'other/x.ts', status: 'added' })).not.toBeNull()
  })

  it('past an unlisted folder, keeps a test only when a folder between the path and the listed one is new', () => {
    // The test's code listed the root; `.changeset` exists on both sides, so the root's listing is unchanged.
    const root = indexRecordedTest({ reads: [], listed: ['.'], scanned: ['.'] })
    expect(recordReach(root, { path: '.changeset/one.md', status: 'added', newFolder: null })).toBeNull()
    expect(recordReach(root, { path: 'a/b/c.ts', status: 'deleted', newFolder: null })).toBeNull()
    // A new top-level folder adds a name to the root's listing.
    expect(recordReach(root, { path: 'fresh/x.ts', status: 'added', newFolder: 'fresh' })?.detail).toBe(
      "an added path adds or removes fresh in ., which the recorded run's own code listed"
    )
    // Deleting a folder's last file removes it from the head.
    expect(recordReach(root, { path: 'gone/x.ts', status: 'deleted', newFolder: 'gone' })?.detail).toBe(
      "a deleted path adds or removes gone in ., which the recorded run's own code listed"
    )
    // A new folder deeper on the path still lies between the path and the listed root.
    expect(recordReach(root, { path: 'a/new/x.ts', status: 'added', newFolder: 'a/new' })).not.toBeNull()
    // A change without the fact keeps the walk as before.
    expect(recordReach(root, { path: '.changeset/one.md', status: 'added' })).not.toBeNull()
    // The same rule holds for a convention name and a shadowed stem past an unlisted folder.
    expect(recordReach(loaded, { path: 'int/nested/package.json', status: 'added', newFolder: null })).toBeNull()
    expect(recordReach(loaded, { path: 'int/mod/index.ts', status: 'added', newFolder: null })).toBeNull()
    expect(recordReach(loaded, { path: 'int/mod/index.ts', status: 'added', newFolder: 'int/mod' })).not.toBeNull()
    // The listed folder itself, or one above it, absent on the other side keeps today's walk.
    const deep = indexRecordedTest({ reads: [], listed: ['x/y'], scanned: ['x/y'] })
    expect(recordReach(deep, { path: 'x/y/z/f.ts', status: 'added', newFolder: 'x' })).not.toBeNull()
    expect(recordReach(deep, { path: 'x/y/z/f.ts', status: 'added', newFolder: 'x/y' })).not.toBeNull()
    expect(recordReach(deep, { path: 'x/y/z/f.ts', status: 'added', newFolder: null })).toBeNull()
  })

  it('deleting the whole tree a test listed still reaches it, whichever folder on it is gone', () => {
    // The test listed and scanned `x/y`; the change deletes every file under `x/y`, so its listing call now fails.
    const deep = indexRecordedTest({ reads: [], listed: ['x/y'], scanned: ['x/y'] })
    const head = foldersOf(['other/keep.ts'])
    const deletedTree = ['x/y/z/f.ts', 'x/y/z/g/h.ts'].map((path) => ({
      path,
      status: 'deleted' as const,
      newFolder: newFolderOf(path, head)
    }))
    expect(deletedTree.map((c) => c.newFolder)).toEqual(['x', 'x'])
    for (const change of deletedTree)
      expect(recordReach(deep, change)?.detail).toBe(
        "a deleted path adds or removes z in x/y, which the recorded run's own code listed"
      )
    // `x` survives at the head, so the shallowest absent folder is the listed folder itself.
    const keepsX = foldersOf(['x/other.ts'])
    expect(newFolderOf('x/y/z/f.ts', keepsX)).toBe('x/y')
    expect(recordReach(deep, { path: 'x/y/z/f.ts', status: 'deleted', newFolder: 'x/y' })).not.toBeNull()
  })

  it('a path in a listed folder reaches the test as before, whatever its new folder', () => {
    expect(recordReach(scanner, { path: 'int/unrelated.ts', status: 'added', newFolder: null })?.detail).toBe(
      "an added path sits in int, which the recorded run's own code listed"
    )
    expect(recordReach(scanner, { path: 'int/old.ts', status: 'deleted', newFolder: 'int' })).not.toBeNull()
    const root = indexRecordedTest({ reads: [], listed: ['.'], scanned: ['.'] })
    expect(recordReach(root, { path: 'top.ts', status: 'added', newFolder: null })).not.toBeNull()
  })

  it('names the shallowest folder on a path that the other side lacks', () => {
    const folders = foldersOf(['.changeset/a.md', 'a/b/c.ts', 'top.ts'])
    expect([...folders].sort()).toEqual(['.', '.changeset', 'a', 'a/b'])
    expect(newFolderOf('.changeset/new.md', folders)).toBeNull()
    expect(newFolderOf('top2.ts', folders)).toBeNull()
    expect(newFolderOf('fresh/x.ts', folders)).toBe('fresh')
    expect(newFolderOf('a/b/new/deeper/x.ts', folders)).toBe('a/b/new')
  })

  it('a modified path reaches the test only through its reads, scanned or not', () => {
    expect(recordReach(scanner, { path: 'int/mod.ts', status: 'modified' })?.exact).toBe(true)
    expect(recordReach(scanner, { path: 'int/unrelated.ts', status: 'modified' })).toBeNull()
  })

  it('names the stems of a name, a leading dot kept on the first', () => {
    expect(nameStems('x.config.ts')).toEqual(['x', 'x.config', 'x.config.ts'])
    expect(nameStems('.env.local')).toEqual(['.env', '.env.local'])
    expect(nameStems('mod')).toEqual(['mod'])
    expect(isConventionName('.envrc')).toBe(true)
    expect(isConventionName('package.jsonc')).toBe(false)
  })
})

describe('the trace reader attributes each listing to its process', () => {
  const probe = { log: '/scratch/0.probe.jsonl', starts: new Set(['10']), wholly: new Set<string>() }
  const open = (pid: string) =>
    `${pid} openat(AT_FDCWD</work/repo>, "/scratch/0.probe.jsonl", O_WRONLY|O_CREAT|O_APPEND, 0666) = 5</scratch/0.probe.jsonl>`

  it('folds a thread into the process that started it, its flags stitched from the unfinished half', () => {
    const result = readsOfTrace(
      trace(
        open('10'),
        '10 clone3({flags=CLONE_VM|CLONE_FS|CLONE_THREAD|CLONE_SIGHAND, exit_signal=0} <unfinished ...>',
        '11 getdents64(4</work/repo/int>, 0x1 /* 3 entries */, 32768) = 96',
        '10 <... clone3 resumed> => {parent_tid=[11]}, 88) = 11',
        '11 getdents64(4</work/repo/lib>, 0x1 /* 3 entries */, 32768) = 96'
      ),
      options({ probe })
    )
    expect([...result.listed].sort()).toEqual(['int', 'lib'])
    expect([...result.processScanned]).toEqual([])
  })

  it('counts the listings of a child process, a re-executed image, a thread of no known process, or a run without the probe', () => {
    const result = readsOfTrace(
      trace(
        open('10'),
        '10 clone(child_stack=NULL, flags=CLONE_CHILD_SETTID|SIGCHLD) = 12',
        '12 getdents64(4</work/repo/child>, 0x1, 32768) = 96',
        '10 execve("/usr/bin/find", ["find", "."], 0x1 /* 2 vars */) = 0',
        '10 getdents64(4</work/repo/after-exec>, 0x1, 32768) = 96',
        '13 getdents64(4</work/repo/unknown>, 0x1, 32768) = 96'
      ),
      options({ probe })
    )
    expect([...result.processScanned].sort()).toEqual(['after-exec', 'child', 'unknown'])
    const unprobed = readsOfTrace(trace('10 getdents64(4</work/repo/int>, 0x1, 32768) = 96'), options())
    expect([...unprobed.processScanned]).toEqual(['int'])
    expect(startsThread('{flags=CLONE_VM|CLONE_THREAD}')).toBe(true)
    expect(startsThread('child_stack=NULL, flags=SIGCHLD')).toBe(false)
  })
})

describe('installed packages', () => {
  it('names the package an installed path belongs to, scoped or not, nested or not', () => {
    expect(installedPackageName('node_modules/zod/index.js')).toBe('zod')
    expect(installedPackageName('node_modules/@sanity/client/dist/x.js')).toBe('@sanity/client')
    expect(installedPackageName('node_modules/a/node_modules/@s/b/x.js')).toBe('@s/b')
    expect(installedPackageName('apps/cli/node_modules/zod/x.js')).toBe('zod')
    expect(installedPackageName('node_modules')).toBeNull()
    expect(installedPackageName('node_modules/.bin/tsc')).toBeNull()
    expect(installedPackageName('node_modules/@sanity')).toBeNull()
  })

  it('names the package a lockfile key installs', () => {
    expect(lockKeyPackageName('zod')).toBe('zod')
    expect(lockKeyPackageName('@sanity/client')).toBe('@sanity/client')
    expect(lockKeyPackageName('a/b')).toBe('b')
    expect(lockKeyPackageName('a/@s/b')).toBe('@s/b')
    expect(lockKeyPackageName('@s/a/@t/b')).toBe('@t/b')
  })

  const lock = (packages: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    bunLockIdentity({ lockfileVersion: 1, workspaces: { '': { name: 'root' } }, packages, ...extra })
  const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b)

  it('lists the packages whose lockfile entry changed, was added or was removed', () => {
    const before = lock({
      zod: ['zod@3.0.0', '', {}, 'sha-a'],
      'a/b': ['b@1.0.0', '', {}, 'sha-b'],
      gone: ['gone@1', '', {}, 'x']
    })
    const after = lock({
      zod: ['zod@3.0.0', '', {}, 'sha-a'],
      'a/b': ['b@1.1.0', '', {}, 'sha-c'],
      added: ['added@1', '', {}, 'y']
    })
    expect(changedLockPackages(before, after, same)).toEqual(['added', 'b', 'gone'])
    expect(changedLockPackages(before, before, same)).toEqual([])
  })

  it('a workspace range alone changes no package, and an override answers that every package may have changed', () => {
    const packages = { zod: ['zod@3.0.0', '', {}, 'sha-a'] }
    const before = lock(packages)
    const ranged = bunLockIdentity({
      lockfileVersion: 1,
      workspaces: { '': { name: 'root', dependencies: { zod: '^3' } } },
      packages
    })
    expect(changedLockPackages(before, ranged, same)).toEqual([])
    expect(changedLockPackages(before, lock(packages, { overrides: { zod: '3.1.0' } }), same)).toBeNull()
    expect(changedLockPackages(before, { packages: 'x' }, same)).toBeNull()
  })

  it('a change of every package reaches any per-package read, and a named package only its own', () => {
    const index = indexRecordedTest({ reads: ['bun.lock#zod'], listed: [] })
    expect(recordReach(index, { path: 'bun.lock#*', status: 'modified' })).not.toBeNull()
    expect(recordReach(index, { path: 'bun.lock#zod', status: 'modified' })).not.toBeNull()
    expect(recordReach(index, { path: 'bun.lock#react', status: 'modified' })).toBeNull()
    expect(recordReach(index, { path: 'bun.lock', status: 'modified' })).toBeNull()
    expect(
      recordReach(indexRecordedTest({ reads: ['bun.lock'], listed: [] }), { path: 'bun.lock', status: 'modified' })
    ).not.toBeNull()
  })
})

describe('the shipped recorder', () => {
  // Copies of the repository recorder's captured trace and probe log, under this package's own fixtures.
  const FIXTURES = join(import.meta.dir, 'fixtures')
  const repo: TraceOptions = {
    repoRoot: ROOT,
    startCwd: ROOT,
    realpath: (absolute) => absolute,
    packageDirs: [],
    dependencyInput: 'bun.lock'
  }

  it('builds, from a captured trace and probe log, the record entry the repository recorder built before it shipped', () => {
    const probe = readProbeLog(readFileSync(join(FIXTURES, 'captured.probe.jsonl'), 'utf8'))
    const result = readsOfTrace(readFileSync(join(FIXTURES, 'captured.trace'), 'utf8'), {
      ...repo,
      probe: { log: '/scratch/3.probe.jsonl', starts: probe.starts, wholly: probe.wholly }
    })
    // The version-1 fields as before, then the open counts version 2 adds.
    expect(JSON.stringify(recordedTestOf({ result, probe, trace: repo, sourceRoot: ROOT, packages: new Map() }))).toBe(
      '{"reads":["bun.lock#zod","fixtures/data","lib/modules"],"listed":["bin","docs","fixtures/data","fixtures/tree","fixtures/tree/deep","harness/x","lib/cache","lib/modules","packages/core/src","scripts","tmp-unknown"],"scanned":["bin","docs","fixtures/data","fixtures/tree/","harness/x","packages/core/src","scripts","tmp-unknown"],"opens":{"fixtures/data":1,"lib/modules":1},"childOpens":[]}'
    )
  })

  it('refuses a host that is not Linux with one message, before reading anything', async () => {
    const written: string[] = []
    const status = await recordCommand(['--out', '/nonexistent/record'], {
      name: 'test-selection-record',
      platform: 'darwin',
      write: (text) => written.push(text)
    })
    expect(status).toBe(2)
    expect(written).toEqual(['test-selection-record: the recorder runs on Linux only (strace)\n'])
  })

  it('launches a plain runner in the suite’s folder, and confirms the one file by its exit status alone', () => {
    const group: NativeGroup = {
      id: 'web@default',
      suite: 'web',
      owner: 'web',
      kind: 'workspace',
      runner: 'vitest',
      cwd: 'packages/web',
      preload: null,
      environment: {},
      configuration: 'default',
      scope: 'files',
      reason: null,
      tests: ['packages/web/tests/view.spec.ts'],
      args: ['tests/view.spec.ts'],
      exclude: ['tests/view.spec.tsx']
    }
    const vitest = plainLaunch(group, '/scratch/0.json', '/nowhere/packages/web')
    expect(vitest.command).toEqual(['vitest', 'run', '--exclude', 'tests/view.spec.tsx', 'tests/view.spec.ts'])
    const bun = plainLaunch(
      { ...group, runner: 'bun', args: ['./tests/a.test.ts'], exclude: [] },
      '/x/0.xml',
      '/nowhere'
    )
    expect(bun).toEqual({ command: ['bun', 'test', './tests/a.test.ts'], env: {} })
    const confirmed = (status: number | null, signal: string | null = null) =>
      exitStatusOutcome(group, { status, signal, report: null }, ROOT, [ROOT]).confirmed
    expect(confirmed(0)).toEqual(group.tests)
    expect(confirmed(1)).toEqual([])
    expect(confirmed(null, 'SIGKILL')).toEqual([])
  })
})

describe('the trace reader counts opens by process', () => {
  const at = (cwd: string) => `AT_FDCWD<${cwd}>`
  const pkg = `${ROOT}/apps/cli`

  it('counts only opens whose result is a descriptor, a result on a resumed line included', () => {
    const result = readsOfTrace(
      trace(
        `10 openat(${at(pkg)}, "a.ts", O_RDONLY) = 3<${pkg}/a.ts>`,
        `10 openat(${at(pkg)}, "a.ts", O_RDONLY <unfinished ...>`,
        `10 <... openat resumed>) = 4<${pkg}/a.ts>`,
        `10 openat(${at(pkg)}, "b.ts", O_RDONLY <unfinished ...>`,
        '10 <... openat resumed>) = -1 ENOENT (No such file or directory)',
        `10 openat(${at(pkg)}, "c.ts", O_RDONLY) = -1 ENOENT (No such file or directory)`,
        `10 newfstatat(${at(pkg)}, "d.ts", {st_mode=S_IFREG|0644, ...}, 0) = 0`
      ),
      options()
    )
    expect([...result.opens]).toEqual([['apps/cli/a.ts', 2]])
    // Every lookup is still a read.
    expect([...result.reads].sort()).toEqual(['apps/cli/a.ts', 'apps/cli/b.ts', 'apps/cli/c.ts', 'apps/cli/d.ts'])
  })

  it('folds a thread’s opens into its process, a thread that started before its clone result arrived included', () => {
    const result = readsOfTrace(
      trace(
        '10 clone3({flags=CLONE_VM|CLONE_THREAD} <unfinished ...>',
        `11 openat(${at(pkg)}, "a.ts", O_RDONLY) = 3<${pkg}/a.ts>`,
        '10 <... clone3 resumed> => {parent_tid=[11]}, 88) = 11',
        `11 openat(${at(pkg)}, "a.ts", O_RDONLY) = 4<${pkg}/a.ts>`,
        '10 clone(child_stack=NULL, flags=SIGCHLD) = 20',
        `20 openat(${at(pkg)}, "a.ts", O_RDONLY) = 3<${pkg}/a.ts>`,
        `20 openat(${at(pkg)}, "b.ts", O_RDONLY) = 4<${pkg}/b.ts>`
      ),
      options()
    )
    expect([...result.opens]).toEqual([['apps/cli/a.ts', 2]])
    expect([...result.childOpens].sort()).toEqual(['apps/cli/a.ts', 'apps/cli/b.ts'])
  })

  it('counts per file, so a read standing for many files carries its most-opened file’s count, not their sum', () => {
    const nm = `${ROOT}/node_modules/zod`
    const dist = `${ROOT}/packages/core/dist`
    const once = readsOfTrace(
      trace(
        `10 openat(${at(pkg)}, "${nm}/index.js", O_RDONLY) = 3<${nm}/index.js>`,
        `10 openat(${at(pkg)}, "${nm}/lib/types.js", O_RDONLY) = 4<${nm}/lib/types.js>`,
        `10 openat(${at(pkg)}, "${dist}/a.js", O_RDONLY) = 5<${dist}/a.js>`,
        `10 openat(${at(pkg)}, "${dist}/b.js", O_RDONLY) = 6<${dist}/b.js>`
      ),
      options()
    )
    expect(Object.fromEntries(once.opens)).toEqual({ 'bun.lock#zod': 1, 'packages/core/src/': 1 })
    const twice = readsOfTrace(
      trace(
        `10 openat(${at(pkg)}, "${nm}/index.js", O_RDONLY) = 3<${nm}/index.js>`,
        `10 openat(${at(pkg)}, "${nm}/lib/types.js", O_RDONLY) = 4<${nm}/lib/types.js>`,
        `10 openat(${at(pkg)}, "${nm}/index.js", O_RDONLY) = 5<${nm}/index.js>`
      ),
      options()
    )
    expect(Object.fromEntries(twice.opens)).toEqual({ 'bun.lock#zod': 2 })
  })

  it('counts a thread of a process the trace never named as a child', () => {
    const result = readsOfTrace(
      trace(`10 openat(${at(pkg)}, "a.ts", O_RDONLY) = 3<${pkg}/a.ts>`, `77 open("b.ts", O_RDONLY) = 3<${pkg}/b.ts>`),
      options()
    )
    expect([...result.opens]).toEqual([['apps/cli/a.ts', 1]])
    expect([...result.childOpens]).toEqual(['apps/cli/b.ts'])
  })

  it('keeps one working folder per process: a thread’s chdir moves its process, an fchdir and a resumed chdir move too', () => {
    const result = readsOfTrace(
      trace(
        '10 clone3({flags=CLONE_VM|CLONE_FS|CLONE_THREAD}, 88) = 11',
        `11 chdir("${ROOT}/docs") = 0`,
        '10 open("from-thread.md", O_RDONLY) = -1 ENOENT (No such file or directory)',
        `10 fchdir(5<${ROOT}/scripts>) = 0`,
        '10 open("from-fchdir.ts", O_RDONLY) = -1 ENOENT (No such file or directory)',
        `10 chdir("${ROOT}/lib" <unfinished ...>`,
        '10 <... chdir resumed>) = 0',
        '10 open("from-resumed.ts", O_RDONLY) = -1 ENOENT (No such file or directory)',
        `10 chdir("${ROOT}/nowhere" <unfinished ...>`,
        '10 <... chdir resumed>) = -1 ENOENT (No such file or directory)',
        '10 clone(child_stack=NULL, flags=SIGCHLD) = 20',
        '20 open("from-child.ts", O_RDONLY) = -1 ENOENT (No such file or directory)'
      ),
      options()
    )
    expect([...result.reads]).toEqual(
      expect.arrayContaining([
        'docs/from-thread.md',
        'scripts/from-fchdir.ts',
        'lib/from-resumed.ts',
        'lib/from-child.ts'
      ])
    )
    expect(result.reads.has('nowhere/from-child.ts')).toBe(false)
  })
})

describe('the record’s versions', () => {
  const base = { schema: 'vinaya.read-record', commit: 'c', platform: 'linux' }
  const v1Entry: RecordedTest = { reads: ['a.ts'], listed: ['.'], scanned: [] }
  const v2Entry: RecordedTest = {
    ...v1Entry,
    opens: { 'a.ts': 2 },
    childOpens: ['a.ts'],
    coverage: { 'a.ts': { instrumented: [[1, 4]], executed: [[1, 2]] } }
  }

  it('accepts a version-1 and a version-2 record, and refuses any other version', () => {
    expect(isReadRecord({ ...base, schemaVersion: 1, tests: { t: v1Entry } })).toBe(true)
    expect(isReadRecord({ ...base, schemaVersion: 2, tests: { t: v2Entry } })).toBe(true)
    // A version-2 entry may leave each new field out: a Vitest run has no coverage.
    expect(isReadRecord({ ...base, schemaVersion: 2, tests: { t: v1Entry } })).toBe(true)
    expect(READ_RECORD_VERSION).toBe(2)
    for (const version of [0, 3, '2', undefined])
      expect(isReadRecord({ ...base, schemaVersion: version, tests: { t: v1Entry } })).toBe(false)
  })

  it('refuses a version-2 entry whose open counts, child opens or coverage do not have their shapes', () => {
    const bad: Partial<Record<keyof RecordedTest, unknown>>[] = [
      { opens: { 'a.ts': 0 } },
      { opens: ['a.ts'] },
      { childOpens: 'a.ts' },
      { coverage: { 'a.ts': { instrumented: [[4, 1]], executed: [] } } },
      { coverage: { 'a.ts': { instrumented: [[1, 2]] } } },
      { coverage: [] }
    ]
    for (const fields of bad)
      expect(isReadRecord({ ...base, schemaVersion: 2, tests: { t: { ...v1Entry, ...fields } } })).toBe(false)
  })

  it('turns lcov line counts into ranges: every instrumented line, and runs of executed ones across uninstrumented lines', () => {
    expect(lineSpans([5, 1, 2, 3, 9, 3])).toEqual([
      [1, 3],
      [5, 5],
      [9, 9]
    ])
    const counts = new Map([
      [1, 1],
      [2, 3],
      [5, 1],
      [6, 0],
      [7, 2],
      [10, 1]
    ])
    expect(fileCoverage(counts)).toEqual({
      instrumented: [
        [1, 2],
        [5, 7],
        [10, 10]
      ],
      executed: [
        [1, 5],
        [7, 10]
      ]
    })
    const lcov = ['TN:', 'SF:src/a.ts', 'DA:1,1', 'DA:2,0', 'end_of_record', 'SF:src/a.ts', 'DA:2,1', 'end_of_record']
    expect(coverageOfLcov(lcov.join('\n'), (sf) => `pkg/${sf}`)).toEqual({
      'pkg/src/a.ts': { instrumented: [[1, 2]], executed: [[1, 2]] }
    })
  })

  // A version-1 record selects exactly as before version 2 existed, and the fields version 2 adds change no selection.
  const fx = fixture('workspaces-repo.json')
  const core = 'packages/core/src'
  const reading: Record<string, Partial<RecordedTest>> = {
    'packages/app/tests/add.test.ts': { reads: [`${core}/index.ts`, `${core}/add.ts`] },
    'packages/app/tests/tree.test.ts': { reads: [], listed: [core] },
    'packages/app/tests/opaque.test.ts': { reads: ['opaque/input.json', 'scratch/notes.txt'] }
  }
  const record = (version: 1 | 2): ReadRecord => {
    const tests: Record<string, RecordedTest> = {}
    for (const test of viewOf('head', fx.files, fx.inventory).tests.map((t) => t.id)) {
      const own = reading[test] ?? {}
      const reads = [...new Set([test, ...(own.reads ?? [])])]
      tests[test] = {
        reads,
        listed: own.listed ?? [],
        ...(version === 2
          ? {
              opens: Object.fromEntries(reads.map((r) => [r, 2])),
              childOpens: reads,
              coverage: { [`${core}/add.ts`]: { instrumented: [[1, 3]], executed: [] } }
            }
          : {})
      }
    }
    return { schema: READ_RECORD_SCHEMA, schemaVersion: version, commit: 'base', platform: 'linux', tests }
  }
  const select = (change: Record<string, string | null>, version: 1 | 2) => {
    const scenario: Scenario = { name: 'recorded', depth: 'transitive', change, required: [], fallbacks: [] }
    const plan = selectTests({
      ...scenarioInput(fx, scenario),
      records: { record: record(version), platform: 'linux' }
    })
    return { required: plan.required.map((t) => t.test), fallbacks: plan.fallbacks.map((f) => f.id) }
  }

  it('selects from a version-1 record as before, and from the same reads in version 2 alike', () => {
    expect(isReadRecord(record(1))).toBe(true)
    expect(isReadRecord(record(2))).toBe(true)
    const notes = { 'scratch/notes.txt': 'changed\n' }
    const added = { [`${core}/extra.ts`]: 'export const extra = 1\n' }
    expect(select(notes, 1)).toEqual({ required: ['packages/app/tests/opaque.test.ts'], fallbacks: [] })
    expect(select(added, 1).required).toEqual(['packages/app/tests/tree.test.ts'])
    for (const change of [notes, added]) expect(select(change, 2)).toEqual(select(change, 1))
  })
})
