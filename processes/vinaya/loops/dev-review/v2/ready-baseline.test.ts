import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CORPUS_REL, REFRESH_COMMAND } from '../../../../../apps/cli/scripts/refresh-loop-baseline'
import { fixtureDir } from '../../../../../apps/cli/tests/lib/test-temp-fixture'
import { checkReadyBaseline } from './ready-baseline'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..')
const digest = (text: string) => createHash('sha256').update(text).digest('hex')

function root(entries: unknown, files: Record<string, string> = {}): string {
  const dir = fixtureDir('ready-baseline-')
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  mkdirSync(dirname(join(dir, CORPUS_REL)), { recursive: true })
  writeFileSync(
    join(dir, CORPUS_REL),
    JSON.stringify({ baseline: { commit: 'x', branch: 'main', loopSurface: entries } })
  )
  return dir
}

describe('the read-only loop-baseline guard', () => {
  test("this repository's recorded baseline matches its loop files", () => {
    expect(checkReadyBaseline(REPO_ROOT)).toEqual({ ok: true })
  })

  test('a repository without the scenario corpus has no contract to judge', () => {
    expect(checkReadyBaseline(fixtureDir('ready-baseline-none-'))).toEqual({ ok: true })
  })

  test('a changed or missing recorded file refuses, naming the refresh command, and changes nothing', () => {
    const dir = root(
      [
        { path: 'a.ts', sha256: digest('a') },
        { path: 'b.ts', sha256: digest('b') }
      ],
      { 'a.ts': 'a changed', 'b.ts': 'b' }
    )
    const before = readFileSync(join(dir, CORPUS_REL), 'utf8')
    const changed = checkReadyBaseline(dir)
    expect(changed.ok).toBe(false)
    if (!changed.ok) {
      expect(changed.problems).toEqual(['a.ts changed'])
      expect(changed.reason).toContain(REFRESH_COMMAND)
      expect(changed.reason).toContain('no test or Test Plan command ran')
    }
    rmSync(join(dir, 'b.ts'))
    const missing = checkReadyBaseline(dir)
    expect(missing.ok === false && missing.problems).toEqual(['a.ts changed', 'b.ts is missing'])
    // Read-only: the corpus is never refreshed by the guard.
    expect(readFileSync(join(dir, CORPUS_REL), 'utf8')).toBe(before)
  })

  test.each([
    ['a digest of the wrong shape', [{ path: 'a.ts', sha256: 'abc' }]],
    ['a record with no path', [{ sha256: digest('a') }]],
    ['no list at all', null],
    ['an empty list', []]
  ])('a malformed record refuses: %s', (_name, entries) => {
    expect(checkReadyBaseline(root(entries, { 'a.ts': 'a' })).ok).toBe(false)
  })

  test('an unreadable corpus refuses', () => {
    const dir = fixtureDir('ready-baseline-bad-')
    mkdirSync(dirname(join(dir, CORPUS_REL)), { recursive: true })
    writeFileSync(join(dir, CORPUS_REL), '{ not json')
    expect(checkReadyBaseline(dir).ok).toBe(false)
  })
})
