// task-run-v1 20, O3: `ci.yml` shards the apps/cli test suite across three
// jobs by an explicit, measured-balanced file list (`ci-shards/shard-{1,2,3}
// .txt`, one path per line, relative to `apps/cli/`) rather than a directory
// split (Trap: sharding by directory concentrates the suite's few genuinely
// slow files — `dispatch.test.ts`, `quickstart.test.ts`, `demo.test.ts` — in
// whichever directory happens to hold them, defeating the balance a shard
// exists to provide).
//
// Nothing on the CI side re-derives this list from disk — a test file added,
// removed, or renamed without a matching edit to a shard file would either
// silently stop running in CI (dropped) or run twice under one shard's own
// `bun test` invocation (duplicated, wasting the shard's own budget). This
// test is that re-derivation, run locally and in CI like any other test, so
// the gap surfaces as a failing assertion instead of a quietly incomplete
// suite.
import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const CLI_ROOT = join(import.meta.dir, '..')
const SHARD_DIR = join(import.meta.dir, 'ci-shards')
const SHARD_COUNT = 3

function allTestFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const abs = join(dir, entry)
    if (statSync(abs).isDirectory()) {
      out.push(...allTestFiles(abs))
    } else if (entry.endsWith('.test.ts')) {
      out.push(abs.slice(CLI_ROOT.length + 1))
    }
  }
  return out
}

function shardFiles(n: number): string[] {
  return readFileSync(join(SHARD_DIR, `shard-${n}.txt`), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

describe('CI shard file lists (task-run-v1 20, O3)', () => {
  it('every test file on disk appears in exactly one shard — none dropped, none duplicated', () => {
    const onDisk = new Set(allTestFiles(CLI_ROOT))
    const shards = Array.from({ length: SHARD_COUNT }, (_, i) => shardFiles(i + 1))
    const allSharded = shards.flat()

    const seen = new Map<string, number>()
    for (const f of allSharded) seen.set(f, (seen.get(f) ?? 0) + 1)
    const duplicated = [...seen.entries()].filter(([, count]) => count > 1).map(([f]) => f)
    expect(duplicated).toEqual([])

    const dropped = [...onDisk].filter((f) => !seen.has(f)).sort()
    expect(dropped).toEqual([])

    const phantom = allSharded.filter((f) => !onDisk.has(f)).sort()
    expect(phantom).toEqual([])
  })

  it('every shard file path resolves and is itself a *.test.ts file', () => {
    for (let n = 1; n <= SHARD_COUNT; n++) {
      for (const f of shardFiles(n)) {
        expect(f.endsWith('.test.ts')).toBe(true)
        expect(statSync(join(CLI_ROOT, f)).isFile()).toBe(true)
      }
    }
  })
})
