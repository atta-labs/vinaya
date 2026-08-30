import { describe, expect, it } from 'bun:test'
import {
  evaluateChangesetCoverage,
  isChangesetFile,
  isShippedPath,
  type FixedGroupMember
} from '../../src/checks/changeset-coverage-logic'

const AEG_CORE: FixedGroupMember = {
  name: '@attalabs/aeg-core',
  dir: 'packages/aeg-core',
  files: ['src', '!src/**/*.test.ts']
}

const VINAYA: FixedGroupMember = {
  name: '@attalabs/vinaya',
  dir: 'apps/cli',
  files: ['dist', 'templates', 'README.md']
}

const FIXED_GROUP = [AEG_CORE, VINAYA]

describe('changeset-coverage-logic — isShippedPath', () => {
  it('a bare directory entry matches anything nested under it', () => {
    expect(isShippedPath(AEG_CORE, 'packages/aeg-core/src/index.ts')).toBe(true)
    expect(isShippedPath(AEG_CORE, 'packages/aeg-core/src/nested/deep.ts')).toBe(true)
  })

  it('a negated glob excludes a TOP-LEVEL src test file (no directory between src/ and the filename) — real fixed-group shape', () => {
    expect(isShippedPath(AEG_CORE, 'packages/aeg-core/src/milestone-validation.test.ts')).toBe(false)
  })

  it('a negated glob excludes a NESTED test file too', () => {
    expect(isShippedPath(AEG_CORE, 'packages/aeg-core/src/nested/deep.test.ts')).toBe(false)
  })

  it('a path outside the member dir never matches', () => {
    expect(isShippedPath(AEG_CORE, 'packages/aeg-types/src/index.ts')).toBe(false)
  })

  it('a path under the member dir but outside every files entry never matches', () => {
    expect(isShippedPath(AEG_CORE, 'packages/aeg-core/tests/index.test.ts')).toBe(false)
  })

  it('a bare filename entry matches only itself, not a same-prefixed sibling', () => {
    expect(isShippedPath(VINAYA, 'apps/cli/README.md')).toBe(true)
    expect(isShippedPath(VINAYA, 'apps/cli/README.dev.md')).toBe(false)
  })
})

describe('changeset-coverage-logic — isChangesetFile', () => {
  it('a changeset markdown entry counts', () => {
    expect(isChangesetFile('.changeset/some-change.md')).toBe(true)
  })

  it('README.md is excluded by name, per the predicate', () => {
    expect(isChangesetFile('.changeset/README.md')).toBe(false)
  })

  it('config.json is not a changeset entry', () => {
    expect(isChangesetFile('.changeset/config.json')).toBe(false)
  })

  it('a same-named file outside .changeset/ does not count', () => {
    expect(isChangesetFile('docs/.changeset/fake.md')).toBe(false)
  })
})

describe('changeset-coverage-logic — evaluateChangesetCoverage', () => {
  it('a shipped-path hit with no changeset is a finding naming the shipped paths', () => {
    const result = evaluateChangesetCoverage(
      FIXED_GROUP,
      ['packages/aeg-core/src/index.ts', 'packages/aeg-core/src/index.test.ts'],
      false
    )
    expect(result).toEqual({ status: 'finding', shippedPathsHit: ['packages/aeg-core/src/index.ts'] })
  })

  it('a shipped-path hit WITH a changeset in the same diff passes', () => {
    const result = evaluateChangesetCoverage(
      FIXED_GROUP,
      ['packages/aeg-core/src/index.ts', '.changeset/a-change.md'],
      false
    )
    expect(result).toEqual({ status: 'pass' })
  })

  it('a diff that touches no shipped path passes, changeset or not — a real test-only PR shape', () => {
    const result = evaluateChangesetCoverage(
      FIXED_GROUP,
      ['apps/cli/tests/checks/some.test.ts', 'packages/aeg-core/src/milestone-validation.test.ts'],
      false
    )
    expect(result).toEqual({ status: 'pass' })
  })

  it('the Changesets-release branch is exempt even with a shipped hit and no changeset', () => {
    const result = evaluateChangesetCoverage(FIXED_GROUP, ['packages/aeg-core/src/index.ts'], true)
    expect(result).toEqual({ status: 'pass' })
  })

  it('an empty changed-files diff passes trivially', () => {
    expect(evaluateChangesetCoverage(FIXED_GROUP, [], false)).toEqual({ status: 'pass' })
  })

  it('a hit across two different fixed-group members is named in full', () => {
    const result = evaluateChangesetCoverage(
      FIXED_GROUP,
      ['packages/aeg-core/src/index.ts', 'apps/cli/README.md'],
      false
    )
    expect(result.status).toBe('finding')
    expect((result as { shippedPathsHit: string[] }).shippedPathsHit.sort()).toEqual(
      ['apps/cli/README.md', 'packages/aeg-core/src/index.ts'].sort()
    )
  })
})
