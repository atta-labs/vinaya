import { describe, expect, test } from 'bun:test'
import { installCheckRegistry, installedCheckRegistry } from './registry'
import type { CheckSpec } from './contract'

describe('check registry installation', () => {
  test('refuses an uninstalled registry and names the installer', () => {
    expect(() => installedCheckRegistry()).toThrow('installCheckRegistry')
  })
  test('returns the list supplied by the composition root', () => {
    const checks: CheckSpec[] = [{ name: 'example', run: 'example', scope: 'full' }]
    installCheckRegistry(checks)
    expect(installedCheckRegistry()).toBe(checks)
    const replacement: CheckSpec[] = []
    installCheckRegistry(replacement)
    expect(installedCheckRegistry()).toBe(replacement)
  })
})
