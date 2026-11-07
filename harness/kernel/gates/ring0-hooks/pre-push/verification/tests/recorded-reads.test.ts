// The syscall-trace reader's own tests: hand-written `strace -f -yy -e trace=%file,getdents64` output, the shapes
// a Bun test and the child processes it starts leave. They import only the public entrypoint.
import { describe, expect, it } from 'bun:test'
import { posix } from 'node:path'
import { indexRecordedTest, readsOfTrace, recordReach, type TraceOptions } from '../index.js'

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

  it('records a read under installed third-party dependencies as the input they derive from', () => {
    const result = readsOfTrace(
      trace(
        `1 openat(AT_FDCWD</work/repo>, "node_modules/typescript/lib/typescript.js", O_RDONLY) = 3</work/repo/node_modules/.bun/typescript@5/node_modules/typescript/lib/typescript.js>`
      ),
      options()
    )
    expect([...result.reads]).toEqual(['bun.lock'])
    expect([
      ...readsOfTrace(`1 stat("/work/repo/node_modules/x", 0x7) = 0\n`, options({ dependencyInput: null })).reads
    ]).toEqual([])
  })

  it('marks a read under .git/ for static fallback', () => {
    const result = readsOfTrace(
      trace(`1 openat(AT_FDCWD</work/repo>, ".git/HEAD", O_RDONLY) = 3</work/repo/.git/HEAD>`),
      options()
    )
    expect(result.git).toBe(true)
    expect(result.reads.has('.git/HEAD')).toBe(false)
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
})
