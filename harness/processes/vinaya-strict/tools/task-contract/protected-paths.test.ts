import { describe, expect, test } from 'vitest'
import { normalizeTouchedPath } from '@attalabs/harness/tools/host/touched-path'
import { isProtectedAdminPath, PROTECTED_ADMIN_PATHS } from './protected-paths'
import { DOCTRINE_REPO_PATHS } from '../doctrine/doctrine-map'

describe('normalizeTouchedPath', () => {
  test.each([
    ['./.github/x', '.github/x'],
    ['/aeg-root/x', 'aeg-root/x'],
    ['foo/../.github/workflows/ci.yml', '.github/workflows/ci.yml'],
    ['../.github/x', '.github/x'],
    ['../../aeg-root/x', 'aeg-root/x'],
    ['.github\\workflows\\ci.yml', '.github/workflows/ci.yml']
  ])('%s -> %s', (input, expected) => {
    expect(normalizeTouchedPath(input)).toBe(expected)
  })
})

describe('isProtectedAdminPath', () => {
  test('lists the four protected prefixes', () => {
    expect([...PROTECTED_ADMIN_PATHS]).toEqual([
      'vinaya.config.json',
      '.vinaya/doc-owners',
      '.github/',
      ...DOCTRINE_REPO_PATHS
    ])
  })

  test.each([
    'vinaya.config.json',
    '.vinaya/doc-owners',
    '.github/workflows/ci.yml',
    'harness/processes/vinaya-strict/doctrine/enforcement.md',
    './.github/x',
    '/harness/processes/vinaya-strict/doctrine/enforcement.md',
    'foo/../.github/x',
    '../../harness/processes/vinaya-strict/doctrine/enforcement.md'
  ])('%s is protected', (path) => {
    expect(isProtectedAdminPath(path)).toBe(true)
  })

  test.each([
    'apps/cli/src/index.ts',
    'docs/.github/x',
    'foo/harness/processes/vinaya-strict/doctrine/enforcement.md',
    'README.md'
  ])('%s is not protected', (path) => {
    expect(isProtectedAdminPath(path)).toBe(false)
  })
})
