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

const data = (baseline: Record<string, number>, globs: string[] = []): GuardData => ({
  allowlist: globs.map((glob) => ({ glob, reason: 'test' })),
  baseline
})

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
    const list = data({}, ['docs/adr/**', '**/CHANGELOG.md', 'bun.lock']).allowlist
    expect(allowlisted('docs/adr/0001-x.md', list)).toBe(true)
    expect(allowlisted('apps/cli/CHANGELOG.md', list)).toBe(true)
    expect(allowlisted('bun.lock', list)).toBe(true)
    expect(allowlisted('apps/cli/src/x.ts', list)).toBe(false)
  })
})

describe('parseGuardData', () => {
  test('accepts the committed data file', () => {
    const parsed = parseGuardData(readFileSync(join(import.meta.dir, '..', '..', DATA_FILE), 'utf8'))
    expect(parsed.allowlist.length).toBeGreaterThan(0)
    for (const entry of parsed.allowlist) expect(entry.reason.trim()).not.toBe('')
  })

  test('refuses a malformed data file', () => {
    expect(() => parseGuardData('{')).toThrow()
    expect(() => parseGuardData('{"allowlist": [{"glob": "x"}], "baseline": {}}')).toThrow()
    expect(() => parseGuardData('{"allowlist": [], "baseline": {"a": -1}}')).toThrow()
  })
})

describe('checkRepository over a fixture repository', () => {
  const files = {
    'src/a.ts': 'const AEG_REPO = loadAegDocs()\n',
    'src/clean.ts': 'export {}\n',
    'aeg-named.md': 'no token inside\n'
  }
  const baseline = { 'src/a.ts': 2, 'aeg-named.md': 1 }

  test('passes at its baseline, counting paths and content', () => {
    const outcome = checkRepository(fixtureRepo(files), data(baseline))
    expect(outcome.excess).toEqual([])
    expect(outcome.lowered).toEqual([])
    expect(outcome.counted).toBe(3)
  })

  test('fails when a file gains a token, naming its count and its allowed count', () => {
    const root = fixtureRepo(files)
    write(root, 'src/a.ts', 'const AEG_REPO = loadAegDocs(aeg)\n')
    expect(checkRepository(root, data(baseline)).excess).toEqual([{ file: 'src/a.ts', count: 3, allowed: 2 }])
  })

  test('fails on a new tracked file carrying the token', () => {
    const root = fixtureRepo({ ...files, 'src/new.ts': 'aegThing\n' })
    expect(checkRepository(root, data(baseline)).excess).toEqual([{ file: 'src/new.ts', count: 1, allowed: 0 }])
  })

  test('passes and reports the lower number when a file loses a token', () => {
    const root = fixtureRepo(files)
    write(root, 'src/a.ts', 'const REPO = loadAegDocs()\n')
    const outcome = checkRepository(root, data(baseline))
    expect(outcome.excess).toEqual([])
    expect(outcome.lowered).toEqual([{ file: 'src/a.ts', count: 1, allowed: 2 }])
  })

  test('reports a baseline row whose file is gone as fallen to zero', () => {
    const root = fixtureRepo(files)
    git(root, ['rm', '-q', 'src/a.ts'])
    expect(checkRepository(root, data(baseline)).lowered).toEqual([{ file: 'src/a.ts', count: 0, allowed: 2 }])
  })

  test('never counts a file under an allowlist glob', () => {
    const root = fixtureRepo({ ...files, 'docs/adr/0001.md': 'aeg aeg aeg\n', 'bun.lock': 'sha512-xAEgy\n' })
    const outcome = checkRepository(root, data(baseline, ['docs/adr/**', 'bun.lock']))
    expect(outcome.excess).toEqual([])
    expect(outcome.counted).toBe(3)
  })

  test("never counts the guard's own name in a registration", () => {
    const root = fixtureRepo({ ...files, 'config.json': '{ "atta-labs/no-aeg-token": {} }\n' })
    expect(checkRepository(root, data(baseline)).excess).toEqual([])
  })

  test('skips binary content but still counts a binary file path', () => {
    const blob = new Uint8Array([0, 97, 101, 103, 0])
    const root = fixtureRepo({ ...files, 'img/plain.bin': blob, 'img/aeg.bin': blob })
    expect(checkRepository(root, data({ ...baseline, 'img/aeg.bin': 1 })).excess).toEqual([])
  })

  test('never reads an untracked file', () => {
    const root = fixtureRepo(files)
    write(root, 'scratch/aeg-notes.md', 'aeg aeg\n')
    expect(checkRepository(root, data(baseline)).excess).toEqual([])
  })
})

describe('the script', () => {
  function run(root: string) {
    return spawnSync('bun', [SCRIPT], { cwd: root, encoding: 'utf8' })
  }

  test('exits 0 at the baseline and prints the line to record when a count falls', () => {
    const root = fixtureRepo({
      'src/a.ts': 'loadAegDocs()\n',
      [DATA_FILE]: JSON.stringify(data({ 'src/a.ts': 2 }, ['scripts/vinaya-checks/no-aeg-token*']))
    })
    const result = run(root)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('src/a.ts fell from 2 to 1')
  })

  test('exits 1 with one JSON finding per file over its allowed count', () => {
    const root = fixtureRepo({
      'src/a.ts': 'aeg aeg\n',
      [DATA_FILE]: JSON.stringify(data({ 'src/a.ts': 1 }, ['scripts/vinaya-checks/no-aeg-token*']))
    })
    const result = run(root)
    expect(result.status).toBe(1)
    const findings = result.stderr
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      schema: 1,
      check: 'atta-labs/no-aeg-token',
      severity: 'error',
      file: 'src/a.ts'
    })
    expect(findings[0].message).toContain('2 time(s)')
    expect(findings[0].message).toContain('allowed count is 1')
  })
})
