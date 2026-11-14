import { describe, expect, it } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  indexRecordedTest,
  READ_RECORD_SCHEMA,
  type ReadRecord,
  type RecordedTest,
  readsOfTrace,
  recordReach,
  repositoryFolder,
  type TraceOptions
} from '@attalabs/test-selection'
import { RECORD_FILE } from '../test-suites/read-records.js'
import { absoluteOf, globPrefix, PROBE_LOG_ENV } from './listing-probe.js'
import {
  mergeShardRecords,
  PROBE_FILE,
  parseShard,
  probedLaunch,
  readProbeLog,
  readShardOutputs,
  resolvesModules,
  SHARD_FILE,
  STRACE_ARGS,
  type Shard,
  type ShardManifest,
  scannedFolders,
  scanSources,
  shardTests,
  withProbeFirst
} from './record-reads.js'

const TESTS = [
  'apps/cli/tests/b.test.ts',
  'apps/cli/tests/a.test.ts',
  'harness/kernel/tests/c.test.ts',
  'harness/kernel/tests/d.test.ts',
  'packages/x/tests/e.test.ts',
  'packages/x/tests/f.test.ts',
  'scripts/test-suites/g.test.ts'
]

const entry = (test: string): RecordedTest => ({
  reads: [test, `${test.split('/')[0]}/package.json`].sort(),
  listed: ['.'],
  // A record taken with the listing probe carries `scanned`, one taken before it does not: the merge keeps both.
  ...(test.startsWith('apps/') ? { scanned: test.endsWith('a.test.ts') ? ['.'] : [] } : {}),
  ...(test.endsWith('c.test.ts') ? { fallback: 'git-read' as const } : {}),
  ...(test.endsWith('e.test.ts') ? { branchesOnPlatform: true } : {})
})

/** The record an unsharded run writes: every passing test, keys sorted. `f` did not pass, so it has no entry. */
const UNRECORDED = ['packages/x/tests/f.test.ts']
const fullRecord = (commit = 'abc123'): ReadRecord => {
  const tests: Record<string, RecordedTest> = {}
  for (const test of [...TESTS].sort()) if (!UNRECORDED.includes(test)) tests[test] = entry(test)
  return { schema: READ_RECORD_SCHEMA, schemaVersion: 1, commit, platform: 'linux', tests }
}

/** What one shard writes: its partial record and manifest, built the way `recordReads` builds them. */
const shardOutput = (shard: Shard, commit = 'abc123'): { shard: ShardManifest; record: ReadRecord } => {
  const slice = shardTests(TESTS, shard)
  const tests: Record<string, RecordedTest> = {}
  for (const test of slice) if (!UNRECORDED.includes(test)) tests[test] = entry(test)
  return {
    shard: { ...shard, commit, tests: slice, unrecorded: slice.filter((t) => UNRECORDED.includes(t)) },
    record: { schema: READ_RECORD_SCHEMA, schemaVersion: 1, commit, platform: 'linux', tests }
  }
}

const allShards = (count: number) => Array.from({ length: count }, (_, at) => shardOutput({ index: at + 1, count }))

describe('parseShard', () => {
  it('reads <i>/<n> with 1 <= i <= n and refuses anything else', () => {
    expect(parseShard('1/8')).toEqual({ index: 1, count: 8 })
    expect(parseShard('8/8')).toEqual({ index: 8, count: 8 })
    for (const bad of ['0/8', '9/8', '1/0', '1', 'a/b', '1/8/2', '-1/8']) expect(parseShard(bad)).toBeNull()
  })
})

describe('shardTests', () => {
  for (const count of [1, 2, 3, 7, 8, 10]) {
    it(`puts every test in exactly one of ${count} shard(s), with sizes within one of each other`, () => {
      const slices = Array.from({ length: count }, (_, at) => shardTests(TESTS, { index: at + 1, count }))
      const seen = slices.flat()
      expect(seen.sort()).toEqual([...TESTS].sort())
      expect(new Set(seen).size).toBe(TESTS.length)
      const sizes = slices.map((s) => s.length)
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1)
    })
  }

  it('does not depend on the order the tests arrive in', () => {
    const shard = { index: 2, count: 3 }
    expect(shardTests([...TESTS].reverse(), shard)).toEqual(shardTests(TESTS, shard))
  })
})

describe('mergeShardRecords', () => {
  for (const count of [1, 3, 8]) {
    it(`merges ${count} shard(s) into the record an unsharded run writes`, () => {
      const merged = mergeShardRecords(allShards(count).reverse())
      expect(merged.record).toEqual(fullRecord())
      expect(JSON.stringify(merged.record)).toBe(JSON.stringify(fullRecord()))
      expect(merged.attempted).toEqual([...TESTS].sort())
      expect(merged.unrecorded).toEqual(UNRECORDED)
    })
  }

  it('refuses a missing shard', () => {
    expect(() => mergeShardRecords(allShards(3).slice(1))).toThrow('expected shards 1..3 exactly once')
  })

  it('refuses a shard given twice', () => {
    const parts = allShards(2)
    expect(() => mergeShardRecords([...parts, parts[0] as (typeof parts)[number]])).toThrow('exactly once')
  })

  it('refuses shards of different counts', () => {
    expect(() => mergeShardRecords([shardOutput({ index: 1, count: 2 }), shardOutput({ index: 2, count: 3 })])).toThrow(
      'exactly once'
    )
  })

  it('refuses shards recorded at different commits', () => {
    expect(() =>
      mergeShardRecords([shardOutput({ index: 1, count: 2 }), shardOutput({ index: 2, count: 2 }, 'def456')])
    ).toThrow('another commit')
  })

  it('refuses a test attempted by two shards', () => {
    const [one, two] = allShards(2) as [ReturnType<typeof shardOutput>, ReturnType<typeof shardOutput>]
    two.shard.tests.push(one.shard.tests[0] as string)
    expect(() => mergeShardRecords([one, two])).toThrow('recorded by two shards')
  })

  it('refuses nothing to merge', () => {
    expect(() => mergeShardRecords([])).toThrow('no shard output')
  })
})

describe('readShardOutputs', () => {
  it('reads each shard folder the merge job downloads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-record-shards-'))
    try {
      for (const part of allShards(3)) {
        const folder = join(dir, `read-record-part-${part.shard.index}`)
        mkdirSync(folder)
        writeFileSync(join(folder, SHARD_FILE), JSON.stringify(part.shard))
        writeFileSync(join(folder, RECORD_FILE), JSON.stringify(part.record))
      }
      expect(mergeShardRecords(readShardOutputs(dir)).record).toEqual(fullRecord())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a folder whose record is not a read record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-record-shards-'))
    try {
      const folder = join(dir, 'read-record-part-1')
      mkdirSync(folder)
      writeFileSync(join(folder, SHARD_FILE), JSON.stringify(shardOutput({ index: 1, count: 1 }).shard))
      writeFileSync(join(folder, RECORD_FILE), JSON.stringify({ schema: 'something-else' }))
      expect(() => readShardOutputs(dir)).toThrow('is not a read record')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('carries each test’s scanned folders through the merge, and leaves them out where a shard recorded none', () => {
    const merged = mergeShardRecords(allShards(3)).record.tests
    expect(merged['apps/cli/tests/a.test.ts']?.scanned).toEqual(['.'])
    expect(merged['apps/cli/tests/b.test.ts']?.scanned).toEqual([])
    expect(merged['harness/kernel/tests/d.test.ts']?.scanned).toBeUndefined()
  })
})

// ── The listing probe ───────────────────────────────────────────────────────

const FIXTURES = join(import.meta.dir, 'fixtures', 'listing-probe')
const TARGET = join(realpathSync(FIXTURES), 'target')

/** A scratch folder outside the repository holding a copy of the probe, as the recorder makes one. */
const probeScratch = (): { dir: string; probe: string; log: string } => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vinaya-listing-probe-')))
  const probe = join(dir, PROBE_FILE)
  copyFileSync(join(import.meta.dir, PROBE_FILE), probe)
  return { dir, probe, log: join(dir, 'probe.jsonl') }
}

type ProbeLine = { pid: number; start?: true; list?: string; recursive?: boolean; whole?: string }
const logLines = (log: string): ProbeLine[] => {
  try {
    return readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ProbeLine)
  } catch {
    return []
  }
}

/** Runs a fixture with Bun, with the probe preloaded or without it, and returns what it printed. */
const runFixture = (args: string[], probe: { probe: string; log: string } | null): string => {
  const env: Record<string, string | undefined> = { ...process.env, [PROBE_LOG_ENV]: probe?.log }
  if (!probe) delete env[PROBE_LOG_ENV]
  const run = Bun.spawnSync([process.execPath, ...(probe ? ['--preload', probe.probe] : []), ...args], {
    cwd: FIXTURES,
    env,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  if (run.exitCode !== 0) throw new Error(`${args.join(' ')} failed: ${run.stderr.toString()}`)
  return run.stdout.toString()
}

describe('the listing probe', () => {
  const FORMS = [
    'named',
    'namespace',
    'default',
    'require',
    'createRequire',
    'computed',
    'package',
    'promisesMember',
    'promisesImport',
    'opendir',
    'glob',
    'recursive',
    'url',
    'chdir'
  ]

  for (const form of FORMS) {
    it(`logs a listing made through the ${form} form, as its absolute folder, and changes nothing the fixture prints`, () => {
      const scratch = probeScratch()
      try {
        const probed = runFixture(['lists.ts', form], scratch)
        expect(probed).toBe(runFixture(['lists.ts', form], null))
        const lines = logLines(scratch.log)
        expect(lines[0]?.start).toBe(true)
        expect(lines.some((line) => line.list === TARGET && line.recursive === (form === 'recursive'))).toBe(true)
        expect(lines.every((line) => line.pid === lines[0]?.pid)).toBe(true)
      } finally {
        rmSync(scratch.dir, { recursive: true, force: true })
      }
    })
  }

  it('logs nothing for a fixture that only imports a module from the folder, and changes nothing it prints', () => {
    const scratch = probeScratch()
    try {
      expect(runFixture(['imports.ts'], scratch)).toBe(runFixture(['imports.ts'], null))
      expect(logLines(scratch.log).map((line) => Object.keys(line).sort())).toEqual([['pid', 'start']])
    } finally {
      rmSync(scratch.dir, { recursive: true, force: true })
    }
  })

  it('marks a process that starts a worker thread wholly scanned', () => {
    const scratch = probeScratch()
    try {
      expect(runFixture(['starts-worker.ts'], scratch)).toBe(runFixture(['starts-worker.ts'], null))
      expect(logLines(scratch.log).filter((line) => line.whole)).toEqual([
        { pid: logLines(scratch.log)[0]?.pid as number, whole: 'worker_threads.Worker' }
      ])
    } finally {
      rmSync(scratch.dir, { recursive: true, force: true })
    }
  })

  it('runs first when it heads the run configuration’s preload list, and the shell keeps its helpers', () => {
    const scratch = probeScratch()
    const project = join(scratch.dir, 'project')
    mkdirSync(project)
    try {
      writeFileSync(
        join(project, 'lists-at-load.ts'),
        "import { readdirSync } from 'node:fs'\nreaddirSync(import.meta.dir)\n"
      )
      writeFileSync(
        join(project, 'shell.test.ts'),
        [
          "import { $ } from 'bun'",
          "import { expect, it } from 'bun:test'",
          "it('shell', async () => {",
          "  expect($.escape('a b')).toContain('a')",
          "  expect((await $`echo hi`.text()).trim()).toBe('hi')",
          '})'
        ].join('\n')
      )
      writeFileSync(join(project, 'bunfig.toml'), '[test]\npreload = "./lists-at-load.ts"\n')
      const launch = probedLaunch(
        { command: ['bun', 'test', './shell.test.ts'], env: {} },
        { cwd: project, report: join(scratch.dir, '0.xml'), probe: scratch.probe, log: scratch.log }
      )
      expect(readFileSync(join(scratch.dir, '0.xml.bunfig.toml'), 'utf8')).toContain(
        `preload = [${JSON.stringify(scratch.probe)}, "./lists-at-load.ts"]`
      )
      const run = Bun.spawnSync([process.execPath, ...launch.command.slice(1)], {
        cwd: project,
        env: { ...process.env, ...launch.env },
        stdout: 'pipe',
        stderr: 'pipe'
      })
      expect(run.exitCode).toBe(0)
      const lines = logLines(scratch.log)
      expect(lines[0]?.start).toBe(true)
      expect(lines.findIndex((line) => line.list === project)).toBeGreaterThan(0)
      expect(lines.some((line) => line.whole === 'Bun.$')).toBe(true)
    } finally {
      rmSync(scratch.dir, { recursive: true, force: true })
    }
  })

  it('resolves a URL, a file: string or a relative path to an absolute folder', () => {
    expect(absoluteOf(new URL('file:///work/repo/a/'))).toBe('/work/repo/a')
    expect(absoluteOf('file:///work/repo/b')).toBe('/work/repo/b')
    expect(absoluteOf('c/d', '/work/repo')).toBe('/work/repo/c/d')
    expect(absoluteOf(Buffer.from('/work/repo/e'))).toBe('/work/repo/e')
    expect(absoluteOf(3)).toBeNull()
  })

  it('takes a glob’s static prefix against its cwd, and a wildcard segment with more after it reaches beneath', () => {
    expect(globPrefix('src/*.ts', '/r')).toEqual({ folder: '/r/src', recursive: false })
    expect(globPrefix('src/*/index.ts', '/r')).toEqual({ folder: '/r/src', recursive: true })
    expect(globPrefix('src/**', '/r')).toEqual({ folder: '/r/src', recursive: true })
    expect(globPrefix('*.json', '/r')).toEqual({ folder: '/r', recursive: false })
    expect(globPrefix('/abs/x/{a,b}.ts', '/r')).toEqual({ folder: '/abs/x', recursive: false })
    expect(globPrefix('lib/a.ts', '/r')).toEqual({ folder: '/r/lib', recursive: false })
  })
})

describe('the run configuration', () => {
  const P = '/scratch/listing-probe.ts'
  it('puts the probe first in a [test] preload string or list, single- or multi-line', () => {
    expect(withProbeFirst('[test]\npreload = "./a.ts"\n', P)).toBe(`[test]\npreload = ["${P}", "./a.ts"]\n`)
    expect(withProbeFirst("[test]\npreload = ['./a.ts'] # one\n", P)).toBe(
      `[test]\npreload = ["${P}", './a.ts'] # one\n`
    )
    expect(withProbeFirst('[test]\npreload = ["./a.ts", "./b.ts"]\n', P)).toBe(
      `[test]\npreload = ["${P}", "./a.ts", "./b.ts"]\n`
    )
    expect(withProbeFirst('[test]\npreload = [\n  "./a.ts",\n]\n', P)).toBe(
      `[test]\npreload = ["${P}", \n  "./a.ts",\n]\n`
    )
    expect(withProbeFirst('[test]\npreload = []\n', P)).toBe(`[test]\npreload = ["${P}"]\n`)
  })

  it('adds a list to a [test] table without one, or a table to a configuration without one, and leaves other tables', () => {
    const reporter = '[test.reporter]\njunit = "r.xml"\n'
    expect(withProbeFirst(`[test]\ntimeout = 5\n${reporter}`, P)).toBe(
      `[test]\npreload = ["${P}"]\ntimeout = 5\n${reporter}`
    )
    expect(withProbeFirst(reporter, P)).toBe(`${reporter}[test]\npreload = ["${P}"]\n`)
    expect(withProbeFirst('[run]\npreload = "./x.ts"\n', P)).toBe(
      `[run]\npreload = "./x.ts"\n[test]\npreload = ["${P}"]\n`
    )
    expect(withProbeFirst('', P)).toBe(`[test]\npreload = ["${P}"]\n`)
  })

  it('rewrites the configuration the launch names, or writes one from the folder’s own and passes it', () => {
    const scratch = probeScratch()
    try {
      const given = join(scratch.dir, '1.xml.bunfig.toml')
      writeFileSync(given, '[test]\npreload = "./p.ts"\n')
      const rewritten = probedLaunch(
        { command: ['bun', `--config=${given}`, 'test', 'a.test.ts'], env: { A: '1' } },
        { cwd: scratch.dir, report: join(scratch.dir, '1.xml'), probe: P, log: scratch.log }
      )
      expect(rewritten.command).toEqual(['bun', `--config=${given}`, 'test', 'a.test.ts'])
      expect(rewritten.env).toEqual({ A: '1', [PROBE_LOG_ENV]: scratch.log })
      expect(readFileSync(given, 'utf8')).toBe(`[test]\npreload = ["${P}", "./p.ts"]\n`)

      const folder = join(scratch.dir, 'folder')
      mkdirSync(folder)
      writeFileSync(join(folder, 'bunfig.toml'), '[test]\ntimeout = 9\n')
      const written = probedLaunch(
        { command: ['bun', 'test', 'b.test.ts'], env: {} },
        { cwd: folder, report: join(scratch.dir, '2.xml'), probe: P, log: scratch.log }
      )
      expect(written.command).toEqual([
        'bun',
        `--config=${join(scratch.dir, '2.xml.bunfig.toml')}`,
        'test',
        'b.test.ts'
      ])
      expect(readFileSync(join(scratch.dir, '2.xml.bunfig.toml'), 'utf8')).toBe(
        `[test]\npreload = ["${P}"]\ntimeout = 9\n`
      )
      expect(readFileSync(join(folder, 'bunfig.toml'), 'utf8')).toBe('[test]\ntimeout = 9\n')
    } finally {
      rmSync(scratch.dir, { recursive: true, force: true })
    }
  })

  it('traces the calls that start threads and processes, so each listing is attributed to its process', () => {
    expect(STRACE_ARGS.join(' ')).toContain('trace=%file,getdents64,clone,clone3,fork,vfork')
  })
})

// ── Scanned folders ─────────────────────────────────────────────────────────

describe('scanned folders', () => {
  const ROOT = '/work/repo'
  const options: TraceOptions = {
    repoRoot: ROOT,
    startCwd: ROOT,
    realpath: (absolute) => absolute,
    packageDirs: [],
    dependencyInput: 'bun.lock'
  }
  const folderOf = (absolute: string) => repositoryFolder(absolute, options)

  it('yield, from a captured trace and probe log, the folders each process’s code listed', () => {
    const probe = readProbeLog(readFileSync(join(FIXTURES, 'captured.probe.jsonl'), 'utf8'))
    expect([...probe.starts].sort()).toEqual(['100', '400', '600', '800'])
    expect([...probe.wholly]).toEqual(['400'])
    const result = readsOfTrace(readFileSync(join(FIXTURES, 'captured.trace'), 'utf8'), {
      ...options,
      probe: { log: '/scratch/3.probe.jsonl', starts: probe.starts, wholly: probe.wholly }
    })
    expect([...result.listed].sort()).toEqual([
      'bin',
      'docs',
      'fixtures/data',
      'fixtures/tree',
      'fixtures/tree/deep',
      'harness/x',
      'lib/cache',
      'lib/modules',
      'packages/core/src',
      'scripts',
      'tmp-unknown'
    ])
    // Not scanned: `lib/modules` (the probed test process's resolver, from a thread whose start arrived late) and
    // `lib/cache` (a probed child's resolver, before it re-executed). Scanned: git's listing (no probe), a nested
    // `bun` without the probe, a process the probe marked whole, a thread of no known process, the re-executed
    // `find`, a reused process id that never opened the log, and what the probe logged.
    expect([...result.processScanned].sort()).toEqual([
      'bin',
      'docs',
      'harness/x',
      'packages/core/src',
      'scripts',
      'tmp-unknown'
    ])
    expect(
      scannedFolders({ listed: result.listed, processScanned: result.processScanned, probe, resolves: false, folderOf })
    ).toEqual([
      'bin',
      'docs',
      'fixtures/data',
      'fixtures/tree/',
      'harness/x',
      'packages/core/src',
      'scripts',
      'tmp-unknown'
    ])
  })

  it('count every listing when no probe ran', () => {
    const result = readsOfTrace(readFileSync(join(FIXTURES, 'captured.trace'), 'utf8'), options)
    expect([...result.processScanned].sort()).toEqual([...result.listed].sort())
  })

  it('count every listing of a test whose source resolves a specifier or mocks a module', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'vinaya-scan-sources-')))
    try {
      mkdirSync(join(repo, 'tests'))
      writeFileSync(join(repo, 'tests', 'plain.test.ts'), "import { a } from './a'\n")
      writeFileSync(join(repo, 'tests', 'resolves.ts'), "export const where = require.resolve('./a')\n")
      writeFileSync(
        join(repo, 'tests', 'mocks.test.ts'),
        "import { mock } from 'bun:test'\nmock.module('./widget', () => ({ Widget: () => null }))\n"
      )
      writeFileSync(join(repo, 'notes.md'), 'require.resolve is mentioned here only\n')
      expect(scanSources(repo, ['tests/plain.test.ts', 'notes.md'])).toEqual({
        branchesOnPlatform: false,
        resolves: false
      })
      expect(scanSources(repo, ['tests/plain.test.ts', 'tests/resolves.ts']).resolves).toBe(true)
      const probe = readProbeLog('{"pid":1,"start":true}\n')
      const scanned = scannedFolders({ listed: ['tests', '.'], processScanned: [], probe, resolves: true, folderOf })
      expect(scanned).toEqual(['.', 'tests'])

      // A module mock by an extensionless relative specifier opens nothing; an added `.tsx` the specifier now finds
      // still selects the test, because its listings all count as scanned.
      const mocks = scanSources(repo, ['tests/mocks.test.ts'])
      expect(mocks.resolves).toBe(true)
      const index = indexRecordedTest({
        reads: ['tests/mocks.test.ts'],
        listed: ['tests'],
        scanned: scannedFolders({ listed: ['tests'], processScanned: [], probe, resolves: mocks.resolves, folderOf })
      })
      expect(recordReach(index, { path: 'tests/widget.tsx', status: 'added' })?.detail).toContain('own code listed')
      const unscanned = indexRecordedTest({ reads: ['tests/mocks.test.ts'], listed: ['tests'], scanned: [] })
      expect(recordReach(unscanned, { path: 'tests/widget.tsx', status: 'added' })).toBeNull()
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('find a resolve through any require function, and not a path or promise resolve', () => {
    for (const text of [
      'import.meta.resolve("./a")',
      'import.meta.resolveSync("./a")',
      'import.meta.require.resolve("./a")',
      'const req = createRequire(import.meta.url)\nreq.resolve("x")',
      'const r = module.createRequire(here); r .resolve("x")',
      'createRequire(import.meta.url).resolve("x")',
      'Bun.resolveSync("./a", dir)',
      'await Bun.resolve("./a", dir)',
      'jest.mock("./a")',
      'vi.doMock("./a")',
      'new Bun.FileSystemRouter({ dir })',
      'import { dlopen } from "bun:ffi"'
    ])
      expect(resolvesModules(text)).toBe(true)
    for (const text of [
      'path.resolve(a, b)',
      'await Promise.resolve(1)',
      'const req = createRequire(import.meta.url)\nreq("x")',
      'mockModule()'
    ])
      expect(resolvesModules(text)).toBe(false)
  })
})
