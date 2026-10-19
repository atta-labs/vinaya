import { describe, expect, test } from 'vitest'
import { isProtectedAdminPath, normalizeTouchedPath, PROTECTED_ADMIN_PATHS } from './protected-paths'

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
    expect([...PROTECTED_ADMIN_PATHS]).toEqual(['vinaya.config.json', '.vinaya/doc-owners', '.github/', 'aeg-root/'])
  })

  test.each([
    'vinaya.config.json',
    '.vinaya/doc-owners',
    '.github/workflows/ci.yml',
    'aeg-root/enforcement.md',
    './.github/x',
    '/aeg-root/x',
    'foo/../.github/x',
    '../../aeg-root/x'
  ])('%s is protected', (path) => {
    expect(isProtectedAdminPath(path)).toBe(true)
  })

  test.each(['apps/cli/src/index.ts', 'docs/.github/x', 'foo/aeg-root/x', 'README.md'])(
    '%s is not protected',
    (path) => {
      expect(isProtectedAdminPath(path)).toBe(false)
    }
  )
})
