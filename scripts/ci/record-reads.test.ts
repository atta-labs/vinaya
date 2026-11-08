import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  READ_RECORD_SCHEMA,
  type ReadRecord,
  type RecordedTest
} from '../../harness/kernel/gates/ring0-hooks/pre-push/verification/index.js'
import { RECORD_FILE } from '../test-suites/read-records.js'
import {
  mergeShardRecords,
  parseShard,
  readShardOutputs,
  SHARD_FILE,
  type Shard,
  type ShardManifest,
  shardTests
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
})
