import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  allowlisted,
  checkRepository,
  countToken,
  DATA_FILE,
  type GuardData,
  isBinary,
  parseGuardData
} from './no-aeg-token'

const SCRIPT = join(import.meta.dir, 'no-aeg-token.ts')
const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function git(root: string, args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' })
}

/** A fixture repository whose given files are committed (tracked). */
function fixtureRepo(files: Record<string, string | Uint8Array>): string {
  const root = mkdtempSync(join(tmpdir(), 'no-token-guard-'))
  roots.push(root)
  git(root, ['init', '-q'])
  for (const [file, body] of Object.entries(files)) write(root, file, body)
  git(root, ['add', '-A'])
  git(root, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture'])
  return root
}

function write(root: string, file: string, body: string | Uint8Array): void {
  mkdirSync(dirname(join(root, file)), { recursive: true })
  writeFileSync(join(root, file), body)
}

const data = (globs: string[] = []): GuardData => ({
  allowlist: globs.map((glob) => ({ glob, reason: 'test' }))
})

/** The data file's text, with an empty baseline unless one is given. */
const dataFile = (globs: string[], baseline: Record<string, number> = {}): string =>
  JSON.stringify({ allowlist: globs.map((glob) => ({ glob, reason: 'test' })), baseline })

describe('countToken', () => {
  test('counts every case-insensitive occurrence, inside identifiers too', () => {
    expect(countToken('aeg AEG Aeg')).toBe(3)
    expect(countToken('const originalAegRepo = loadAegDocs(AEG_REPO)')).toBe(3)
    expect(countToken('packages/aeg-core')).toBe(1)
    expect(countToken('nothing here')).toBe(0)
  })

  test("never counts an occurrence inside the guard's own name", () => {
    expect(countToken('"atta-labs/no-aeg-token": { "run": "./scripts/vinaya-checks/no-aeg-token.ts" }')).toBe(0)
    expect(countToken('.changeset/no-aeg-token-guard.md')).toBe(0)
    expect(countToken('NO-AEG-TOKEN and aeg')).toBe(1)
  })
})

describe('isBinary', () => {
  test('a NUL byte marks a file binary', () => {
    expect(isBinary(new Uint8Array([97, 0, 98]))).toBe(true)
    expect(isBinary(new TextEncoder().encode('aeg'))).toBe(false)
  })
})

describe('allowlist', () => {
  test('matches globs against repository-relative paths', () => {
    const list = data(['docs/adr/**', '**/CHANGELOG.md', 'bun.lock']).allowlist
    expect(allowlisted('docs/adr/0001-x.md', list)).toBe(true)
    expect(allowlisted('apps/cli/CHANGELOG.md', list)).toBe(true)
    expect(allowlisted('bun.lock', list)).toBe(true)
    expect(allowlisted('apps/cli/src/x.ts', list)).toBe(false)
  })
})

describe('parseGuardData', () => {
  test('accepts the committed data file, whose baseline is empty and whose allowlist entries each carry a reason', () => {
    const text = readFileSync(join(import.meta.dir, '..', '..', DATA_FILE), 'utf8')
    expect((JSON.parse(text) as { baseline: unknown }).baseline).toEqual({})
    const parsed = parseGuardData(text)
    expect(parsed.allowlist.length).toBeGreaterThan(0)
    for (const entry of parsed.allowlist) expect(entry.reason.trim()).not.toBe('')
  })

  test('refuses a malformed data file', () => {
    expect(() => parseGuardData('{')).toThrow()
    expect(() => parseGuardData('{"allowlist": [{"glob": "x"}], "baseline": {}}')).toThrow()
    expect(() => parseGuardData('{"allowlist": []}')).toThrow()
  })

  test('refuses a baseline row, so a per-file count can never let the token back in', () => {
    expect(() => parseGuardData(dataFile([], { 'src/a.ts': 2 }))).toThrow('must stay empty')
    expect(() => parseGuardData(dataFile([], { 'src/a.ts': 0 }))).toThrow('must stay empty')
    expect(parseGuardData(dataFile(['docs/adr/**'])).allowlist).toEqual([{ glob: 'docs/adr/**', reason: 'test' }])
  })
})

describe('checkRepository over a fixture repository', () => {
  const clean = {
    'src/clean.ts': 'export {}\n',
    'docs/readme.md': 'the current names only\n'
  }

  test('passes a tree with no token outside the allowlist', () => {
    const outcome = checkRepository(fixtureRepo(clean), data())
    expect(outcome.excess).toEqual([])
    expect(outcome.counted).toBe(0)
  })

  test('fails any tracked file holding the token, naming its count of path and content occurrences', () => {
    const root = fixtureRepo({
      ...clean,
      'src/a.ts': 'const AEG_REPO = loadAegDocs()\n',
      'aeg-named.md': 'none inside\n'
    })
    const outcome = checkRepository(root, data())
    expect(outcome.excess).toEqual([
      { file: 'aeg-named.md', count: 1 },
      { file: 'src/a.ts', count: 2 }
    ])
    expect(outcome.counted).toBe(3)
  })

  test('a single occurrence anywhere outside the allowlist fails — there is no per-file allowance', () => {
    const root = fixtureRepo({ ...clean, 'docs/notes/old.md': 'once called Aeg\n' })
    expect(checkRepository(root, data()).excess).toEqual([{ file: 'docs/notes/old.md', count: 1 }])
  })

  test('never counts a file under an allowlist glob', () => {
    const root = fixtureRepo({ ...clean, 'docs/adr/0001.md': 'aeg aeg aeg\n', 'bun.lock': 'sha512-xAEgy\n' })
    const outcome = checkRepository(root, data(['docs/adr/**', 'bun.lock']))
    expect(outcome.excess).toEqual([])
    expect(outcome.counted).toBe(0)
  })

  test("never counts the guard's own name in a registration", () => {
    const root = fixtureRepo({ ...clean, 'config.json': '{ "atta-labs/no-aeg-token": {} }\n' })
    expect(checkRepository(root, data()).excess).toEqual([])
  })

  test('skips binary content but still counts a binary file path', () => {
    const blob = new Uint8Array([0, 97, 101, 103, 0])
    const root = fixtureRepo({ ...clean, 'img/plain.bin': blob, 'img/aeg.bin': blob })
    expect(checkRepository(root, data()).excess).toEqual([{ file: 'img/aeg.bin', count: 1 }])
  })

  test('never reads an untracked file', () => {
    const root = fixtureRepo(clean)
    write(root, 'scratch/aeg-notes.md', 'aeg aeg\n')
    expect(checkRepository(root, data()).excess).toEqual([])
  })
})

describe('the script', () => {
  const GUARD_FILES = 'scripts/vinaya-checks/no-aeg-token*'

  function run(root: string) {
    return spawnSync('bun', [SCRIPT], { cwd: root, encoding: 'utf8' })
  }

  function findings(stderr: string): Record<string, unknown>[] {
    return stderr
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  }

  test('exits 0 when no tracked file outside the allowlist holds the token', () => {
    const root = fixtureRepo({
      'src/a.ts': 'export {}\n',
      'docs/adr/0001.md': 'aeg\n',
      [DATA_FILE]: dataFile([GUARD_FILES, 'docs/adr/**'])
    })
    const result = run(root)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('no tracked file outside the allowlist holds the token')
  })

  test('exits 1 with one JSON finding per file holding the token outside the allowlist', () => {
    const root = fixtureRepo({
      'src/a.ts': 'aeg aeg\n',
      'src/b.ts': 'export {}\n',
      [DATA_FILE]: dataFile([GUARD_FILES])
    })
    const result = run(root)
    expect(result.status).toBe(1)
    const found = findings(result.stderr)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      schema: 1,
      check: 'atta-labs/no-aeg-token',
      severity: 'error',
      file: 'src/a.ts'
    })
    expect(found[0]?.message).toContain('2 time(s)')
    expect(found[0]?.message).toContain('outside the allowlist it may hold none')
  })

  test('exits 1, naming the data file, when its baseline holds a row — even one that would cover the file', () => {
    const root = fixtureRepo({
      'src/a.ts': 'loadAegDocs()\n',
      [DATA_FILE]: dataFile([GUARD_FILES], { 'src/a.ts': 1 })
    })
    const result = run(root)
    expect(result.status).toBe(1)
    const found = findings(result.stderr)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ check: 'atta-labs/no-aeg-token', severity: 'error', file: DATA_FILE })
    expect(found[0]?.message).toContain('must stay empty')
  })
})
