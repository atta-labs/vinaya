import { describe, expect, it } from 'bun:test'
import { RELEASE_PLAN, type ReleaseDeps, runRelease } from './release'

/** A fully-passing baseline — each test overrides exactly the one seam it wants to fail. */
function makeDeps(overrides: Partial<ReleaseDeps> = {}): ReleaseDeps {
  const calls: string[][] = []
  return {
    currentBranch: () => 'main',
    defaultBranch: () => 'main',
    fetchOrigin: () => true,
    treeIsClean: () => true,
    headSha: () => 'abc123',
    defaultBranchSha: () => 'abc123',
    headSubject: () => 'Chore(release): Version packages',
    npmWhoami: () => true,
    runStreamed: (cmd, args) => {
      calls.push([cmd, ...args])
    },
    tagsAtHead: () => [
      '@attalabs/vinaya@0.24.0',
      '@attalabs/aeg-core@0.15.0',
      '@attalabs/aeg-types@0.15.0',
      '@attalabs/aeg-forge-state@0.15.0',
      '@attalabs/vinaya-sources@0.15.0'
    ],
    npmViewVersion: (pkg) => (pkg === '@attalabs/vinaya' ? '0.23.0' : '0.15.0'),
    log: () => {},
    ...overrides
  }
}

describe('vinaya release — preconditions', () => {
  it('refuses when the default branch cannot be determined', () => {
    const result = runRelease({ dryRun: false, allowAnyCommit: false }, makeDeps({ defaultBranch: () => null }))
    expect(result.ok).toBe(false)
    expect((result as { message: string }).message).toContain("could not determine this repo's default branch")
  })

  it('refuses when HEAD is not on the default branch, naming the branch', () => {
    const result = runRelease(
      { dryRun: false, allowAnyCommit: false },
      makeDeps({ currentBranch: () => 'fix/vinaya-release' })
    )
    expect(result.ok).toBe(false)
    expect((result as { message: string }).message).toContain('not the default branch `main`')
  })

  it('refuses on a dirty tree', () => {
    const result = runRelease({ dryRun: false, allowAnyCommit: false }, makeDeps({ treeIsClean: () => false }))
    expect(result.ok).toBe(false)
    expect((result as { message: string }).message).toContain('working tree is dirty')
  })

  it('refuses when `git fetch origin` fails', () => {
    const result = runRelease({ dryRun: false, allowAnyCommit: false }, makeDeps({ fetchOrigin: () => false }))
    expect(result.ok).toBe(false)
    expect((result as { message: string }).message).toContain('git fetch origin` failed')
  })

  it('refuses when HEAD does not equal origin/<default>', () => {
    const result = runRelease(
      { dryRun: false, allowAnyCommit: false },
      makeDeps({ headSha: () => 'abc123', defaultBranchSha: () => 'def456' })
    )
    expect(result.ok).toBe(false)
    expect((result as { message: string }).message).toContain('git pull --ff-only')
  })

  it('refuses when HEAD is not a Version Packages commit', () => {
    const result = runRelease(
      { dryRun: false, allowAnyCommit: false },
      makeDeps({ headSubject: () => 'Fix(cli): something else' })
    )
    expect(result.ok).toBe(false)
    expect((result as { message: string }).message).toContain('not a Version Packages commit')
  })

  it('--allow-any-commit skips the Version Packages commit check', () => {
    const result = runRelease(
      { dryRun: false, allowAnyCommit: true },
      makeDeps({ headSubject: () => 'Fix(cli): something else' })
    )
    expect(result.ok).toBe(true)
  })

  it('refuses when `npm whoami` fails', () => {
    const result = runRelease({ dryRun: false, allowAnyCommit: false }, makeDeps({ npmWhoami: () => false }))
    expect(result.ok).toBe(false)
    expect((result as { message: string }).message).toContain('npm whoami` failed')
  })
})

describe('vinaya release --dry-run', () => {
  it('stops after preconditions and prints the plan without running anything', () => {
    const ran: string[][] = []
    const deps = makeDeps({
      runStreamed: (cmd, args) => {
        ran.push([cmd, ...args])
      }
    })
    const result = runRelease({ dryRun: true, allowAnyCommit: false }, deps)
    expect(result.ok).toBe(true)
    expect(result).toMatchObject({ dryRun: true, plan: RELEASE_PLAN })
    expect(ran).toEqual([])
  })
})

describe('vinaya release — happy path', () => {
  it('runs the four commands in order, then reports every published version', () => {
    const ran: string[][] = []
    const deps = makeDeps({
      runStreamed: (cmd, args) => {
        ran.push([cmd, ...args])
      }
    })
    const result = runRelease({ dryRun: false, allowAnyCommit: false }, deps)
    expect(result.ok).toBe(true)
    if (!result.ok || result.dryRun) throw new Error('expected a completed, non-dry-run outcome')

    expect(ran).toEqual([
      ['bun', 'install', '--frozen-lockfile'],
      ['bun', 'run', 'build'],
      ['bun', 'run', 'changeset:publish'],
      ['git', 'push', 'origin', '--tags']
    ])

    expect(result.published).toHaveLength(5)
    const vinaya = result.published.find((p) => p.pkg === '@attalabs/vinaya')
    expect(vinaya).toMatchObject({ version: '0.24.0', registryVersion: '0.23.0', lagExpected: true })
    const core = result.published.find((p) => p.pkg === '@attalabs/aeg-core')
    expect(core).toMatchObject({ version: '0.15.0', registryVersion: '0.15.0', lagExpected: false })
  })

  it('stops before the plan runs if a later precondition fails, even after fetch succeeds', () => {
    const ran: string[][] = []
    const deps = makeDeps({
      npmWhoami: () => false,
      runStreamed: (cmd, args) => {
        ran.push([cmd, ...args])
      }
    })
    const result = runRelease({ dryRun: false, allowAnyCommit: false }, deps)
    expect(result.ok).toBe(false)
    expect(ran).toEqual([])
  })
})

describe('vinaya release — partial failure after publish', () => {
  it('a failing `git push` (stubbed) reports ran steps, the failed step, and the exact hand-recovery command', () => {
    const ran: string[][] = []
    const deps = makeDeps({
      runStreamed: (cmd, args) => {
        ran.push([cmd, ...args])
        if (cmd === 'git' && args[0] === 'push') throw new Error('stubbed git: push rejected (non-fast-forward)')
      }
    })
    const result = runRelease({ dryRun: false, allowAnyCommit: false }, deps)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')

    // Every step before the push ran; the push itself is what's left.
    expect(ran).toEqual([
      ['bun', 'install', '--frozen-lockfile'],
      ['bun', 'run', 'build'],
      ['bun', 'run', 'changeset:publish'],
      ['git', 'push', 'origin', '--tags']
    ])

    expect(result.ranSteps).toEqual([
      ['bun', 'install', '--frozen-lockfile'],
      ['bun', 'run', 'build'],
      ['bun', 'run', 'changeset:publish']
    ])
    expect(result.failedStep).toEqual(['git', 'push', 'origin', '--tags'])
    expect(result.recoveryCommand).toBe('git push origin --tags')
    expect(result.message).toContain('packages are on the registry')
    expect(result.message).toContain('stubbed git: push rejected (non-fast-forward)')
    expect(result.message).toContain('git push origin --tags')
  })

  it('a failing `bun run build` (before publish) carries no recovery command — nothing irreversible happened', () => {
    const deps = makeDeps({
      runStreamed: (cmd, args) => {
        if (cmd === 'bun' && args[0] === 'run' && args[1] === 'build') throw new Error('stubbed bun: build failed')
      }
    })
    const result = runRelease({ dryRun: false, allowAnyCommit: false }, deps)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')

    expect(result.ranSteps).toBeUndefined()
    expect(result.failedStep).toBeUndefined()
    expect(result.recoveryCommand).toBeUndefined()
    expect(result.message).toContain('stubbed bun: build failed')
    expect(result.message).not.toContain('registry')
  })
})
