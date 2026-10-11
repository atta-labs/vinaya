import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPinnedFileImportersCovered } from '@attalabs/aeg-core'
import { readPinnedFileImporters, readSurfaceForcedSet, renderSurfaceForcedSet } from '../../src/lib/forge-write'
import { spawnSyncBudgeted, stripVinayaEnv } from './process-fixture'

const CLI_ENTRY = join(import.meta.dir, '..', '..', 'src', 'index.ts')

// ---------------------------------------------------------------------------
// `vinaya issue surface` and the importer rule read one listing through one
// function. Every case runs against a fixture git tree built here, so the
// report and the gate are compared on the same importers, never on this
// repository's own imports.
// ---------------------------------------------------------------------------

describe('issue surface — the report and the gate agree on every importer', () => {
  let fixture: string

  const write = (path: string, content: string) => {
    const full = join(fixture, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'vinaya-issue-surface-'))
    execFileSync('git', ['init', '-q'], { cwd: fixture })
    write('packages/core/src/gate.ts', 'export const gate = 1\n')
    // Reached by the `in:` glob.
    write('packages/core/src/index.ts', "export { gate } from './gate'\n")
    // Named in the Boundary's `Out:` clause in the disclaimed case.
    write('apps/cli/src/commands/issue.ts', "import { gate } from '../../../../packages/core/src/gate'\n")
    // The inventory test in another directory — the importer one covered sibling used to silence.
    write('apps/cli/tests/lib/gate.test.ts', "import { gate } from '../../../../packages/core/src/gate.ts'\n")
    write('apps/cli/tests/ci-shards/shard-1.txt', 'tests/lib/gate.test.ts\n')
    execFileSync('git', ['add', '-A'], { cwd: fixture })
    execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qm', 'fixture'], { cwd: fixture })
  })

  afterEach(() => {
    rmSync(fixture, { recursive: true, force: true })
  })

  /** The fixture's tracked files, exactly as `beforeEach` committed them. */
  const tracked = () => [
    'apps/cli/src/commands/issue.ts',
    'apps/cli/tests/ci-shards/shard-1.txt',
    'apps/cli/tests/lib/gate.test.ts',
    'packages/core/src/gate.ts',
    'packages/core/src/index.ts'
  ]

  const body = (inGlobs: string, boundaryOut: string, pinned = '`packages/core/src/gate.ts`') =>
    [
      "## Planner's rationale",
      '',
      `**Boundary** — In: the gate. Pinned files: ${pinned}. Out: ${boundaryOut}.`,
      '',
      '## Objectives',
      '',
      'O1. The gate refuses the body.',
      '',
      '## Surface',
      '',
      `in: ${inGlobs}`,
      'out: apps/cli/tests/lib',
      '',
      '## Parts',
      '',
      'Part 1 (O1) — the gate refuses the body.'
    ].join('\n')

  const UNDECIDED = body('packages/core/src', 'every caller under `apps/cli/src/commands`')

  it('reports each importer reached, disclaimed or uncovered, naming the glob for the uncovered one', () => {
    const set = readSurfaceForcedSet(UNDECIDED, fixture, tracked())
    expect(set?.importers).toEqual([
      {
        file: 'packages/core/src/gate.ts',
        importers: [
          { importer: 'apps/cli/src/commands/issue.ts', state: 'disclaimed', by: 'apps/cli/src/commands' },
          { importer: 'apps/cli/tests/lib/gate.test.ts', state: 'uncovered', fix: 'apps/cli/tests/lib' },
          { importer: 'packages/core/src/index.ts', state: 'reached', by: 'packages/core/src' }
        ]
      }
    ])
    const text = renderSurfaceForcedSet(set as NonNullable<typeof set>)
    expect(text).toContain('reached     packages/core/src/index.ts (in: packages/core/src)')
    expect(text).toContain('disclaimed  apps/cli/src/commands/issue.ts (Boundary Out: apps/cli/src/commands)')
    expect(text).toContain('uncovered   apps/cli/tests/lib/gate.test.ts (add apps/cli/tests/lib to in:')
    expect(text).toContain('1 forced file(s) undecided')
  })

  it('the gate refuses exactly the importer the report calls uncovered', () => {
    const result = checkPinnedFileImportersCovered(UNDECIDED, readPinnedFileImporters(UNDECIDED, fixture))
    expect(result.status).toBe('fail')
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('`apps/cli/tests/lib/gate.test.ts` (add `apps/cli/tests/lib` to `in:`)')
    expect(result.errors[0]).not.toContain('`apps/cli/src/commands/issue.ts`')
    expect(result.errors[0]).not.toContain('`packages/core/src/index.ts`')
  })

  it('the gate accepts once the importer is reached by an `in:` glob, and the report agrees', () => {
    const reached = body('packages/core/src, apps/cli/tests/lib', 'every caller under `apps/cli/src/commands`')
    expect(checkPinnedFileImportersCovered(reached, readPinnedFileImporters(reached, fixture)).status).toBe('pass')
    const text = renderSurfaceForcedSet(readSurfaceForcedSet(reached, fixture, tracked()) as never)
    expect(text).toContain('Every forced file is reached or disclaimed.')
  })

  it("the gate accepts once the importer is named in the Boundary's `Out:` clause — never by a Surface `out:` glob", () => {
    const disclaimed = body(
      'packages/core/src',
      'every caller under `apps/cli/src/commands` and the inventory test `apps/cli/tests/lib/gate.test.ts`'
    )
    expect(checkPinnedFileImportersCovered(disclaimed, readPinnedFileImporters(disclaimed, fixture)).status).toBe(
      'pass'
    )
    expect(
      readSurfaceForcedSet(disclaimed, fixture, tracked())
        ?.importers.flatMap((f) => f.importers)
        .every((d) => d.state !== 'uncovered')
    ).toBe(true)
  })

  it('reports the CI shard list when a pinned test file is new', () => {
    const set = readSurfaceForcedSet(
      body('packages/core/src, apps/cli/tests/lib', 'nothing', '`apps/cli/tests/lib/fresh.test.ts`'),
      fixture,
      tracked()
    )
    expect(set?.ciShards).toEqual({
      newFiles: ['apps/cli/tests/lib/fresh.test.ts'],
      companion: { path: 'apps/cli/tests/ci-shards/shard-1.txt', reached: false },
      fix: 'apps/cli/tests/ci-shards'
    })
  })

  it('the command prints the report and exits 0, writes nothing, and exits 2 on a body that does not parse', () => {
    const bodyFile = join(fixture, 'draft.md')
    writeFileSync(bodyFile, UNDECIDED)
    const ok = spawnSyncBudgeted('bun', [CLI_ENTRY, 'issue', 'surface', '--body-file', bodyFile], {
      cwd: fixture,
      encoding: 'utf8',
      env: stripVinayaEnv()
    })
    expect(ok.status).toBe(0)
    expect(ok.stdout).toContain('uncovered   apps/cli/tests/lib/gate.test.ts')
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: fixture, encoding: 'utf8' }).trim()).toBe(
      '?? draft.md'
    )

    writeFileSync(bodyFile, '**Boundary** — Pinned files: `packages/core/src/gate.ts`.\n')
    const bad = spawnSyncBudgeted('bun', [CLI_ENTRY, 'issue', 'surface', '--body-file', bodyFile], {
      cwd: fixture,
      encoding: 'utf8',
      env: stripVinayaEnv()
    })
    expect(bad.status).toBe(2)
    expect(bad.stderr).toContain('does not parse')
  })
})

describe('issue surface — a pinned module imported only through a package name', () => {
  let fixture: string

  const write = (path: string, content: string) => {
    const full = join(fixture, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'vinaya-issue-surface-pkg-'))
    execFileSync('git', ['init', '-q'], { cwd: fixture })
    write('packages/core/package.json', JSON.stringify({ name: '@fx/core', main: './src/index.ts' }))
    write('packages/core/src/gate.ts', 'export const gate = 1\n')
    write('packages/core/src/other.ts', 'export const other = 2\n')
    write('packages/core/src/index.ts', "export { gate } from './gate'\nexport { other } from './other'\n")
    write('apps/cli/src/checks/uses-gate.ts', "import { gate } from '@fx/core'\n")
    write('apps/cli/src/checks/uses-other.ts', "import { other } from '@fx/core'\n")
    execFileSync('git', ['add', '-A'], { cwd: fixture })
    execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qm', 'fixture'], { cwd: fixture })
  })

  afterEach(() => {
    rmSync(fixture, { recursive: true, force: true })
  })

  const body = (inGlobs: string) =>
    [
      "## Planner's rationale",
      '',
      '**Boundary** — In: the gate. Pinned files: `packages/core/src/gate.ts`. Out: nothing else.',
      '',
      '## Objectives',
      '',
      'O1. The gate refuses the body.',
      '',
      '## Surface',
      '',
      `in: ${inGlobs}`,
      'out: apps/log-server',
      '',
      '## Parts',
      '',
      'Part 1 (O1) — the gate refuses the body.'
    ].join('\n')

  const tracked = () => [
    'apps/cli/src/checks/uses-gate.ts',
    'apps/cli/src/checks/uses-other.ts',
    'packages/core/package.json',
    'packages/core/src/gate.ts',
    'packages/core/src/index.ts',
    'packages/core/src/other.ts'
  ]

  it('reports the package-name importer as uncovered and the gate refuses it; the non-importer is absent', () => {
    const undecided = body('packages/core/src')
    const set = readSurfaceForcedSet(undecided, fixture, tracked())
    expect(set?.importers).toEqual([
      {
        file: 'packages/core/src/gate.ts',
        importers: [
          { importer: 'apps/cli/src/checks/uses-gate.ts', state: 'uncovered', fix: 'apps/cli/src/checks' },
          { importer: 'packages/core/src/index.ts', state: 'reached', by: 'packages/core/src' }
        ]
      }
    ])
    const result = checkPinnedFileImportersCovered(undecided, readPinnedFileImporters(undecided, fixture))
    expect(result.status).toBe('fail')
    expect(result.errors[0]).toContain('`apps/cli/src/checks/uses-gate.ts` (add `apps/cli/src/checks` to `in:`)')
    expect(result.errors[0]).not.toContain('uses-other.ts')
  })

  it('the gate accepts once the package-name importer is reached, and the report agrees', () => {
    const reached = body('packages/core/src, apps/cli/src/checks')
    expect(checkPinnedFileImportersCovered(reached, readPinnedFileImporters(reached, fixture)).status).toBe('pass')
    const text = renderSurfaceForcedSet(readSurfaceForcedSet(reached, fixture, tracked()) as never)
    expect(text).toContain('Every forced file is reached or disclaimed.')
  })
})
