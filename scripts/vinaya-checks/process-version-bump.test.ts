import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  compareSemVer,
  definitionChangedBeyondVersion,
  governedFiles,
  parseProcessDefinition,
  parseSemVer
} from './process-version-bump'

const CHECK = 'atta-labs/process-version-bump'
const DIR = 'processes/vinaya'

const definition = (version: string | null, roles = ['executing/developer', 'executing/code-reviewer']) =>
  [
    'id: vinaya',
    'name: Vinaya',
    ...(version === null ? [] : [`version: ${version}`]),
    'flow: executing/dev-review.flow.yaml',
    'roles:',
    ...roles.map((r) => `  - ${r}`),
    ''
  ].join('\n')

describe('semantic versions', () => {
  test('parses and orders versions', () => {
    const v = (s: string) => parseSemVer(s) ?? (null as never)
    expect(compareSemVer(v('0.2.0'), v('0.1.0'))).toBeGreaterThan(0)
    expect(compareSemVer(v('0.1.0'), v('0.1.0'))).toBe(0)
    expect(compareSemVer(v('0.0.9'), v('0.1.0'))).toBeLessThan(0)
    expect(compareSemVer(v('1.0.0'), v('0.99.99'))).toBeGreaterThan(0)
    expect(compareSemVer(v('1.0.0'), v('1.0.0-rc.1'))).toBeGreaterThan(0)
    expect(compareSemVer(v('1.0.0-rc.2'), v('1.0.0-rc.1'))).toBeGreaterThan(0)
    expect(compareSemVer(v('1.0.0-rc.10'), v('1.0.0-rc.9'))).toBeGreaterThan(0)
    expect(parseSemVer('0.1')).toBeNull()
    expect(parseSemVer('v0.1.0')).toBeNull()
    expect(parseSemVer('01.0.0')).toBeNull()
  })
})

describe('governed files', () => {
  test('come from the flow and roles the process definition names', () => {
    const files = governedFiles(
      parseProcessDefinition(definition('0.1.0', ['executing/developer', 'x/new-role']), 'head')
    )
    expect([...files].sort()).toEqual(
      [
        `${DIR}/executing/actions.ts`,
        `${DIR}/executing/dev-review.flow.yaml`,
        `${DIR}/executing/developer/doctrine.md`,
        `${DIR}/executing/developer/grants.yaml`,
        `${DIR}/executing/developer/output.schema.json`,
        `${DIR}/x/new-role/doctrine.md`,
        `${DIR}/x/new-role/grants.yaml`,
        `${DIR}/x/new-role/output.schema.json`
      ].sort()
    )
  })

  test('a process definition change limited to its version line is not governed', () => {
    expect(definitionChangedBeyondVersion(definition('0.1.0'), definition('0.2.0'))).toBe(false)
    expect(definitionChangedBeyondVersion(definition('0.1.0'), definition('0.1.0', ['executing/developer']))).toBe(true)
  })
})

describe('the check run against a git branch', () => {
  const roots: string[] = []
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })

  // A repository whose `main` holds a process at version 0.1.0, checked out on
  // a `feature` branch cut from it.
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), 'process-version-bump-test-'))
    roots.push(root)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
    const write = (file: string, body: string) => {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      writeFileSync(join(root, file), body)
    }
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 't@t.t')
    git('config', 'user.name', 't')
    git('config', 'commit.gpgsign', 'false')
    write(`${DIR}/process.yaml`, definition('0.1.0'))
    write(`${DIR}/executing/dev-review.flow.yaml`, 'steps: []\n')
    write(`${DIR}/executing/actions.ts`, 'export const actions = {}\n')
    for (const role of ['developer', 'code-reviewer']) {
      write(`${DIR}/executing/${role}/doctrine.md`, '# doctrine\n')
      write(`${DIR}/executing/${role}/grants.yaml`, 'grants: []\n')
      write(`${DIR}/executing/${role}/output.schema.json`, '{}\n')
      write(`${DIR}/executing/${role}/README.md`, '# readme\n')
    }
    write(`${DIR}/tests/a.test.ts`, 'export {}\n')
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    git('checkout', '-q', '-b', 'feature')
    const commit = (files: Record<string, string>) => {
      for (const [file, body] of Object.entries(files)) write(file, body)
      git('add', '.')
      git('commit', '-q', '-m', 'change')
    }
    const run = (env: Record<string, string> = { BASE_SHA: 'main' }) => {
      const result = Bun.spawnSync(['bun', join(import.meta.dir, 'process-version-bump.ts')], {
        cwd: root,
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
        stderr: 'pipe',
        stdout: 'pipe'
      })
      const stderr = result.stderr.toString().trim()
      return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        findings: stderr ? stderr.split('\n').map((l) => JSON.parse(l)) : []
      }
    }
    return { git, commit, run }
  }

  test('accept: a role grants file changes and the version rises', () => {
    const f = fixture()
    f.commit({
      [`${DIR}/executing/developer/grants.yaml`]: 'grants: [read]\n',
      [`${DIR}/process.yaml`]: definition('0.2.0')
    })
    const result = f.run()
    expect(result.findings).toEqual([])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('from 0.1.0 to 0.2.0')
  })

  test('reject: the flow file changes and the version stays', () => {
    const f = fixture()
    f.commit({ [`${DIR}/executing/dev-review.flow.yaml`]: 'steps: [one]\n' })
    const result = f.run()
    expect(result.exitCode).toBe(1)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({
      schema: 1,
      check: CHECK,
      severity: 'error',
      file: `${DIR}/executing/dev-review.flow.yaml`
    })
    expect(result.findings[0].message).toContain('base 0.1.0, head 0.1.0')
  })

  test('reject: the action bindings change and the version is lowered', () => {
    const f = fixture()
    f.commit({
      [`${DIR}/executing/actions.ts`]: 'export const actions = { a: 1 }\n',
      [`${DIR}/process.yaml`]: definition('0.0.9')
    })
    const result = f.run()
    expect(result.exitCode).toBe(1)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({ severity: 'error', file: `${DIR}/executing/actions.ts` })
    expect(result.findings[0].message).toContain('base 0.1.0, head 0.0.9')
  })

  test('reject: a role added to the process definition without a version rise names the definition', () => {
    const f = fixture()
    f.commit({
      [`${DIR}/process.yaml`]: definition('0.1.0', ['executing/developer', 'executing/code-reviewer', 'x/new']),
      [`${DIR}/x/new/doctrine.md`]: '# new\n'
    })
    const result = f.run()
    expect(result.exitCode).toBe(1)
    expect(result.findings.map((x) => x.file).sort()).toEqual([`${DIR}/process.yaml`, `${DIR}/x/new/doctrine.md`])
  })

  test('skip: only a role README and a process test change', () => {
    const f = fixture()
    f.commit({
      [`${DIR}/executing/developer/README.md`]: '# changed\n',
      [`${DIR}/tests/a.test.ts`]: 'export const changed = 1\n'
    })
    const result = f.run()
    expect(result.findings).toEqual([])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('skipped')
  })

  test('skip: only the version line of the process definition changes', () => {
    const f = fixture()
    f.commit({ [`${DIR}/process.yaml`]: definition('0.0.1') })
    const result = f.run()
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('skipped')
  })

  test('error: the process definition at the head has no version', () => {
    const f = fixture()
    f.commit({
      [`${DIR}/executing/dev-review.flow.yaml`]: 'steps: [one]\n',
      [`${DIR}/process.yaml`]: definition(null)
    })
    const result = f.run()
    expect(result.exitCode).toBe(1)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({ check: CHECK, severity: 'error', file: `${DIR}/process.yaml` })
    expect(result.findings[0].message).toContain('at the head has no version')
  })

  test('error: a version that is not a semantic version', () => {
    const f = fixture()
    f.commit({ [`${DIR}/process.yaml`]: definition('2') })
    const result = f.run()
    expect(result.exitCode).toBe(1)
    expect(result.findings[0]).toMatchObject({ severity: 'error' })
    expect(result.findings[0].message).toContain('not a semantic version')
  })

  test('error: no base can be resolved', () => {
    const f = fixture()
    f.git('branch', '-q', '-D', 'main')
    f.commit({ [`${DIR}/executing/dev-review.flow.yaml`]: 'steps: [one]\n' })
    const result = f.run({ BASE_SHA: 'no-such-ref' })
    expect(result.exitCode).toBe(1)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({ check: CHECK, severity: 'error' })
    expect(result.findings[0].message).toContain('Could not resolve a base')
  })
})
