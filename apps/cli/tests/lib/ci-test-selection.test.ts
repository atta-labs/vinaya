import { describe, expect, it } from 'bun:test'
import { type CiFacts, decideCiSelection, isSelectablePath, shardFilesToRun } from '../../src/lib/ci-test-selection'

const ROOT = '/repo'

function facts(overrides: Partial<CiFacts> = {}): CiFacts {
  return {
    baseResolves: true,
    gitDiff: ['apps/cli/src/lib/widget.ts'],
    selectionChanged: ['apps/cli/src/lib/widget.ts'],
    select: () => [`${ROOT}/apps/cli/tests/widget.test.ts`],
    ...overrides
  }
}

describe('which changed paths the selector can judge', () => {
  it('accepts the portal, changesets and TypeScript sources under apps/ and packages/', () => {
    for (const path of [
      'apps/vinaya-portal/app/page.tsx',
      'apps/vinaya-portal/README.md',
      'apps/vinaya-portal/public/logo.svg',
      '.changeset/quiet-fox.md',
      'apps/cli/src/lib/widget.ts',
      'apps/cli/tests/widget.test.ts',
      'packages/aeg-core/src/brief.ts',
      'packages/sources/src/view.tsx'
    ]) {
      expect(isSelectablePath(path), path).toBe(true)
    }
  })

  it('refuses every other kind of path', () => {
    for (const path of [
      '.github/workflows/ci.yml',
      'aeg-root/enforcement.md',
      'apps/cli/specs/self-hosting.md',
      'apps/cli/package.json',
      'apps/cli/tests/fixtures/repo/src/index.ts',
      'packages/aeg-core/src/fixtures/brief.ts',
      'apps/cli/tests/lib/test-env-preload.ts',
      'apps/cli/tests/ci-shards/shard-1.txt',
      'bunfig.toml',
      'tsconfig.json',
      'vinaya.config.json',
      'scripts/build.ts',
      'apps/cli/scripts/bundle-doctrine.ts',
      'apps/cli/scripts/bundle-doctrine.test.ts',
      'packages/aeg-core/bin/verify-dispatch.ts',
      'apps/cli/vitest.config.ts',
      'packages/aeg-core/vitest.config.ts',
      'apps/cli/index.ts',
      'apps/cli/tsconfig.json',
      'apps/cli/src/lib/tool.py'
    ]) {
      expect(isSelectablePath(path), path).toBe(false)
    }
  })
})

describe('a pull request falls back to everything', () => {
  it('when the base commit does not resolve, without running the selection', () => {
    let ran = false
    const decision = decideCiSelection(
      facts({
        baseResolves: false,
        select: () => {
          ran = true
          return []
        }
      })
    )
    expect(decision).toEqual({ scope: 'all', reason: 'the base commit does not resolve' })
    expect(ran).toBe(false)
  })

  it('when any changed path is one the selector cannot judge', () => {
    const decision = decideCiSelection(
      facts({ gitDiff: ['apps/cli/src/lib/widget.ts', 'apps/cli/specs/self-hosting.md'] })
    )
    expect(decision.scope).toBe('all')
    expect(decision.scope === 'all' && decision.reason).toContain('apps/cli/specs/self-hosting.md')
  })

  it('when the selection saw no changed file while git diff lists some', () => {
    expect(decideCiSelection(facts({ selectionChanged: [] })).scope).toBe('all')
  })

  it('when the selection throws', () => {
    const decision = decideCiSelection(
      facts({
        select: () => {
          throw new Error('graph build failed')
        }
      })
    )
    expect(decision).toEqual({ scope: 'all', reason: 'the selection failed: graph build failed' })
  })

  it('and a run-everything decision keeps the whole shard list in its order', () => {
    const shard = ['tests/b.test.ts', 'tests/a.test.ts']
    expect(shardFilesToRun(ROOT, shard, { scope: 'all', reason: 'x' })).toEqual(shard)
  })
})

describe('a pull request the selector can judge', () => {
  it('runs only the shard entries the selection picked, compared on one path form', () => {
    const decision = decideCiSelection(
      facts({
        select: () => [`${ROOT}/apps/cli/tests/a.test.ts`, `${ROOT}/apps/vinaya-portal/tests/page.test.ts`]
      })
    )
    expect(decision.scope).toBe('selected')
    expect(shardFilesToRun(ROOT, ['tests/b.test.ts', 'tests/a.test.ts'], decision)).toEqual(['tests/a.test.ts'])
  })

  it('runs nothing in a shard none of whose files were selected', () => {
    const decision = decideCiSelection(facts({ select: () => [] }))
    expect(decision).toEqual({ scope: 'selected', selected: [] })
    expect(shardFilesToRun(ROOT, ['tests/a.test.ts'], decision)).toEqual([])
  })

  it('narrows a diff that only touches the portal and a changeset', () => {
    const decision = decideCiSelection(
      facts({
        gitDiff: ['apps/vinaya-portal/app/page.tsx', '.changeset/quiet-fox.md'],
        selectionChanged: ['apps/vinaya-portal/app/page.tsx', '.changeset/quiet-fox.md']
      })
    )
    expect(decision.scope).toBe('selected')
  })

  it('narrows an empty diff with an empty selection', () => {
    expect(decideCiSelection(facts({ gitDiff: [], selectionChanged: [], select: () => [] }))).toEqual({
      scope: 'selected',
      selected: []
    })
  })
})
