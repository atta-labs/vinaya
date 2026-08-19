import { describe, expect, it } from 'vitest'
import {
  CROSS_CUTTING_CANDIDATES,
  deriveBuiltinCrossCuttingDefaults,
  deriveWorkspacePackageDomains
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
