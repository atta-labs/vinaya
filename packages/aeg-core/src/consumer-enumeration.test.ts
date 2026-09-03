import { describe, expect, it } from 'vitest'
import { buildConsumersOf, deriveWorkspaceMemberDirs, type PackageManifest } from './consumer-enumeration'

const listDirs = (dir: string): string[] => {
  if (dir === 'apps') return ['cli']
  if (dir === 'packages') return ['aeg-core', 'aeg-forge-state', 'sources']
  return []
}

describe('deriveWorkspaceMemberDirs', () => {
  it('resolves every workspace glob, apps/* and packages/* alike (round-2 ruling item 3)', () => {
    const members = deriveWorkspaceMemberDirs(['apps/*', 'packages/*'], listDirs)
    expect(members).toEqual(['apps/cli', 'packages/aeg-core', 'packages/aeg-forge-state', 'packages/sources'])
  })

  it('excludes a negated entry', () => {
    const members = deriveWorkspaceMemberDirs(['packages/*', '!packages/sources'], listDirs)
    expect(members).not.toContain('packages/sources')
    expect(members).toContain('packages/aeg-core')
  })
})

describe('buildConsumersOf', () => {
  const manifests: Record<string, PackageManifest> = {
    'apps/cli': { devDependencies: { '@attalabs/aeg-core': 'workspace:*' } },
    'packages/aeg-core': {},
    'packages/aeg-forge-state': {},
    'packages/sources': { dependencies: { '@attalabs/aeg-core': '0.23.0' } }
  }
  const readManifest = (dir: string): PackageManifest | null => manifests[dir] ?? null

  it('includes apps/cli as a real consumer, not only sibling packages/* members', () => {
    const consumersOf = buildConsumersOf(['apps/*', 'packages/*'], listDirs, readManifest)
    const consumers = consumersOf('aeg-core')
    expect(consumers).toContain('apps/cli')
    expect(consumers).toContain('packages/sources')
    expect(consumers).not.toContain('packages/aeg-forge-state')
  })

  it('excludes the package itself', () => {
    const consumersOf = buildConsumersOf(['apps/*', 'packages/*'], listDirs, readManifest)
    expect(consumersOf('aeg-core')).not.toContain('packages/aeg-core')
  })
})
