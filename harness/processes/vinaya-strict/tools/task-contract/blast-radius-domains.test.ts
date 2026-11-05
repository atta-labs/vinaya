import { describe, expect, it } from 'vitest'
import {
  CROSS_CUTTING_CANDIDATES,
  deriveBuiltinCrossCuttingDefaults,
  deriveWorkspacePackageDomains,
  parsePnpmWorkspaceYaml
} from './blast-radius-domains'

describe('deriveWorkspacePackageDomains', () => {
  it('resolves a trailing /* glob against the injected directory listing', () => {
    const workspaces = ['apps/*', 'packages/*']
    const listDirs = (dir: string): string[] => {
      if (dir === 'apps') return ['cli']
      if (dir === 'packages') return ['aeg-core', 'aeg-forge-state', 'aeg-types', 'sources', 'typescript-config']
      return []
    }
    expect(deriveWorkspacePackageDomains(workspaces, listDirs)).toEqual([
      'packages/aeg-core',
      'packages/aeg-forge-state',
      'packages/aeg-types',
      'packages/sources',
      'packages/typescript-config'
    ])
  })

  it('collapses a workspace member nested under packages/ to its top-level directory', () => {
    // attalabs' own shape: no glob at all, explicit member paths, several
    // nested three deep under one `packages/agents` directory.
    const workspaces = [
      'packages/agents/forensic-hiring-auditor',
      'packages/agents/vada-deliberation',
      'packages/agents/vada-fusion',
      'packages/agents/vada-fusion-native',
      'packages/auth'
    ]
    expect(deriveWorkspacePackageDomains(workspaces, () => [])).toEqual(['packages/agents', 'packages/auth'])
  })

  it('drops workspace members outside packages/ — an apps/* or root tool is not a shared-package domain', () => {
    const workspaces = ['apps/attalabs/web', 'tools/admin', 'packages/db']
    expect(deriveWorkspacePackageDomains(workspaces, () => [])).toEqual(['packages/db'])
  })

  it('drops a glob shape it does not understand rather than guessing', () => {
    expect(deriveWorkspacePackageDomains(['packages/*-legacy'], () => ['x'])).toEqual([])
  })

  it('exactly matches attalabs\' real static .aeg/packages "packages/*" section', () => {
    // attalabs' real `package.json` `workspaces` array (no globs — every
    // member listed explicitly), read 2026-08-19.
    const attalabsWorkspaces = [
      'apps/attalabs/mcp-server',
      'apps/attalabs/mobile',
      'apps/attalabs/web',
      'apps/herald-ai/mcp',
      'apps/herald-ai/mcp-server',
      'apps/herald-ai/mobile',
      'apps/herald-ai/web',
      'apps/vada-ai/mcp-server',
      'apps/vada-ai/mobile',
      'apps/vada-ai/web',
      'apps/vinaya-portal/web',
      'apps/vinaya-studio/web',
      'packages/adapter-langgraph',
      'packages/agents/forensic-hiring-auditor',
      'packages/agents/vada-deliberation',
      'packages/agents/vada-fusion',
      'packages/agents/vada-fusion-native',
      'packages/atta-agents',
      'packages/auth',
      'packages/cms',
      'packages/crypto',
      'packages/db',
      'packages/engine',
      'packages/identity',
      'packages/instrumentation',
      'packages/models',
      'packages/storage',
      'packages/typescript-config',
      'packages/ui',
      'tools/admin'
    ]
    // attalabs' real `.aeg/packages`, "shared packages" section, read
    // 2026-08-19 — the before/after proof this task's brief requires (§7).
    const staticFileDomains = [
      'packages/adapter-langgraph',
      'packages/agents',
      'packages/atta-agents',
      'packages/auth',
      'packages/cms',
      'packages/crypto',
      'packages/db',
      'packages/engine',
      'packages/identity',
      'packages/instrumentation',
      'packages/models',
      'packages/storage',
      'packages/typescript-config',
      'packages/ui'
    ]
    expect(deriveWorkspacePackageDomains(attalabsWorkspaces, () => [])).toEqual(staticFileDomains)
  })

  it('a negated literal entry excludes exactly that domain from a co-occurring glob match', () => {
    const workspaces = ['packages/*', '!packages/legacy']
    const listDirs = (dir: string): string[] => (dir === 'packages' ? ['foo', 'legacy'] : [])
    expect(deriveWorkspacePackageDomains(workspaces, listDirs)).toEqual(['packages/foo'])
  })

  it('a negated glob excludes every member it resolves to', () => {
    const workspaces = ['packages/*', '!packages/*']
    const listDirs = (dir: string): string[] => (dir === 'packages' ? ['foo', 'bar'] : [])
    expect(deriveWorkspacePackageDomains(workspaces, listDirs)).toEqual([])
  })

  it('excluding one nested member leaves the shared top-level directory domain intact', () => {
    const workspaces = [
      'packages/agents/vada-fusion',
      'packages/agents/vada-fusion-native',
      '!packages/agents/vada-fusion-native'
    ]
    expect(deriveWorkspacePackageDomains(workspaces, () => [])).toEqual(['packages/agents'])
  })

  it('excluding every member of a directory removes that directory as a domain entirely', () => {
    const workspaces = ['packages/agents/vada-fusion', '!packages/agents/vada-fusion']
    expect(deriveWorkspacePackageDomains(workspaces, () => [])).toEqual([])
  })

  it('no negation entries behaves exactly as before (regression guard)', () => {
    const workspaces = ['packages/foo', 'packages/bar']
    expect(deriveWorkspacePackageDomains(workspaces, () => [])).toEqual(['packages/bar', 'packages/foo'])
  })
})

describe('parsePnpmWorkspaceYaml', () => {
  it('parses the standard block-list form, quoted entries', () => {
    const yaml = `packages:\n  - 'packages/*'\n  - 'apps/*'\n`
    expect(parsePnpmWorkspaceYaml(yaml)).toEqual(['packages/*', 'apps/*'])
  })

  it('parses double-quoted and bare entries in the same block', () => {
    const yaml = `packages:\n  - "packages/*"\n  - apps/*\n`
    expect(parsePnpmWorkspaceYaml(yaml)).toEqual(['packages/*', 'apps/*'])
  })

  it('parses the inline array form', () => {
    const yaml = `packages: ['packages/*', 'apps/*', '!packages/legacy']\n`
    expect(parsePnpmWorkspaceYaml(yaml)).toEqual(['packages/*', 'apps/*', '!packages/legacy'])
  })

  it('strips a trailing # comment on a list-item line', () => {
    const yaml = `packages:\n  - 'packages/*' # everything shared\n  - 'apps/*'\n`
    expect(parsePnpmWorkspaceYaml(yaml)).toEqual(['packages/*', 'apps/*'])
  })

  it('stops the block at the next top-level key', () => {
    const yaml = `packages:\n  - 'packages/*'\ncatalogMode: strict\n`
    expect(parsePnpmWorkspaceYaml(yaml)).toEqual(['packages/*'])
  })

  it('preserves a negation entry verbatim, including the leading !', () => {
    const yaml = `packages:\n  - 'packages/*'\n  - '!packages/legacy'\n`
    expect(parsePnpmWorkspaceYaml(yaml)).toEqual(['packages/*', '!packages/legacy'])
  })

  it('returns [] when there is no packages: key at all', () => {
    expect(parsePnpmWorkspaceYaml('onlyBuiltDependencies:\n  - foo\n')).toEqual([])
  })

  it('returns [] on an empty file', () => {
    expect(parsePnpmWorkspaceYaml('')).toEqual([])
  })

  it('feeds directly into deriveWorkspacePackageDomains — the real pnpm-adopter path', () => {
    const yaml = `packages:\n  - 'packages/*'\n  - 'apps/*'\n`
    const listDirs = (dir: string): string[] => {
      if (dir === 'packages') return ['core', 'utils']
      if (dir === 'apps') return ['web']
      return []
    }
    expect(deriveWorkspacePackageDomains(parsePnpmWorkspaceYaml(yaml), listDirs)).toEqual([
      'packages/core',
      'packages/utils'
    ])
  })
})

describe('deriveBuiltinCrossCuttingDefaults', () => {
  it('includes only the candidates that exist, in CROSS_CUTTING_CANDIDATES order', () => {
    const present = new Set(['bun.lock', 'turbo.json', '.husky'])
    expect(deriveBuiltinCrossCuttingDefaults((p) => present.has(p))).toEqual(['bun.lock', 'turbo.json', '.husky'])
  })

  it('returns nothing when none of the candidates exist', () => {
    expect(deriveBuiltinCrossCuttingDefaults(() => false)).toEqual([])
  })

  it('checks all four lockfile names, not just one — a repo can carry any of them', () => {
    for (const lockfile of ['bun.lock', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) {
      expect(deriveBuiltinCrossCuttingDefaults((p) => p === lockfile)).toEqual([lockfile])
    }
  })

  it("exactly matches attalabs' real static .aeg/packages cross-cutting section", () => {
    // attalabs' real repo root, read 2026-08-19: bun.lock present, no other
    // lockfile; turbo.json/biome.json/tsconfig.json/.github/workflows/.husky
    // all present.
    const present = new Set(['bun.lock', 'turbo.json', 'biome.json', 'tsconfig.json', '.github/workflows', '.husky'])
    const staticFileDomains = ['bun.lock', 'turbo.json', 'biome.json', 'tsconfig.json', '.github/workflows', '.husky']
    expect(deriveBuiltinCrossCuttingDefaults((p) => present.has(p))).toEqual(staticFileDomains)
  })

  it('CROSS_CUTTING_CANDIDATES is the fixed superset every derived list filters', () => {
    expect(CROSS_CUTTING_CANDIDATES).toEqual([
      'bun.lock',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'turbo.json',
      'biome.json',
      'tsconfig.json',
      '.github/workflows',
      '.husky'
    ])
  })
})
