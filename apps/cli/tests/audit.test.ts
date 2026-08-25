import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findDeadBranchPushes } from '@attalabs/aeg-core'
import type { AuditDeps } from '../src/commands/audit.js'
import { runAudit } from '../src/commands/audit.js'

function auditDeps(overrides: Partial<AuditDeps> = {}): AuditDeps {
  return {
    detectRepo: async () => ({ repoRoot: '/tmp/does-not-matter', owner: 'acme', repo: 'widget' }),
    ...overrides
  }
}

describe('vinaya audit — pre-flight', () => {
  it('refuses when not a git repository', async () => {
    const exit = await runAudit([], auditDeps({ detectRepo: async () => null }))
    expect(exit).toBe(1)
  })

  it('refuses when no GitHub owner/repo can be resolved from `origin`', async () => {
    const exit = await runAudit(
      [],
      auditDeps({ detectRepo: async () => ({ repoRoot: '/tmp/does-not-matter', owner: '', repo: '' }) })
    )
    expect(exit).toBe(1)
  })
})

// rings.ring2_asyncAudits is additive, never disabling (Issue #45's
// 2026-08-25 Amendment): `false`/absent is a no-op — every pre-existing
// `vinaya init` starter config reads `false` here, so dead-branch-push's
// real work must keep running unconditionally. `true` is the new opt-in
// accelerator that skips it.
//
// Deliberately scoped to dead-branch-push only (security review finding,
// HIGH, fixed here): direct-main-push-detection is a real pass/fail that
// catches a branch-protection bypass, so it is NEVER gated by this flag —
// reading its on/off switch from ordinary, PR-reachable config would let the
// exact actor it exists to catch silently blind it in the same push.
describe('vinaya audit — rings.ring2_asyncAudits', () => {
  let cwd: string
  let originalCwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'vinaya-audit-ring2-test-'))
    originalCwd = process.cwd()
    process.chdir(cwd)
  })
  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(cwd, { recursive: true, force: true })
  })

  function writeConfig(config: unknown): void {
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify(config), 'utf8')
  }

  it('`true` skips dead-branch-push, but direct-main-push-detection still runs for real', async () => {
    writeConfig({ rings: { ring1_forgeWriteInterception: false, ring2_asyncAudits: true } })
    let detectRepoCalled = false
    let directPushChecked = false
    const exit = await runAudit(
      ['--sha=abc123'],
      auditDeps({
        detectRepo: async () => {
          detectRepoCalled = true
          return { repoRoot: cwd, owner: 'acme', repo: 'widget' }
        },
        fetchAssociatedMergedPrs: () => {
          directPushChecked = true
          return [42]
        }
      })
    )
    expect(exit).toBe(0)
    expect(detectRepoCalled).toBe(true)
    expect(directPushChecked).toBe(true)
  })

  it('`true` with `--only=dead-branches` — dead-branch-push is the only work requested, and it is skipped', async () => {
    writeConfig({ rings: { ring1_forgeWriteInterception: false, ring2_asyncAudits: true } })
    const exit = await runAudit(
      ['--only=dead-branches', '--sha=abc123'],
      auditDeps({ detectRepo: async () => ({ repoRoot: cwd, owner: 'acme', repo: 'widget' }) })
    )
    expect(exit).toBe(0)
  })

  it('`true` with `--only=direct-push` — unaffected by the flag, runs for real', async () => {
    writeConfig({ rings: { ring1_forgeWriteInterception: false, ring2_asyncAudits: true } })
    let calls = 0
    const exit = await runAudit(
      ['--only=direct-push', '--sha=abc123'],
      auditDeps({
        detectRepo: async () => ({ repoRoot: cwd, owner: 'acme', repo: 'widget' }),
        fetchAssociatedMergedPrs: () => {
          calls++
          return [42]
        }
      })
    )
    expect(exit).toBe(0)
    expect(calls).toBe(1)
  })

  it('`false` is a no-op — dead-branch-push still runs (fails pre-flight the same as before the flag existed)', async () => {
    writeConfig({ rings: { ring1_forgeWriteInterception: false, ring2_asyncAudits: false } })
    const exit = await runAudit([], auditDeps({ detectRepo: async () => null }))
    expect(exit).toBe(1)
  })
})

describe('vinaya audit — direct-main-push bounded poll (#870)', () => {
  it('finds the association on a later attempt and returns legitimate without exhausting the ceiling', async () => {
    let calls = 0
    const exit = await runAudit(
      ['--only=direct-push', '--sha=abc123'],
      auditDeps({
        fetchAssociatedMergedPrs: () => {
          calls++
          return calls < 3 ? [] : [42]
        },
        pollAttempts: 6,
        pollDelayMs: 1,
        sleep: async () => {}
      })
    )
    expect(exit).toBe(0)
    expect(calls).toBe(3)
  })

  it('still returns direct-push after the ceiling when genuinely no association ever appears', async () => {
    let calls = 0
    let incidentOpened = 0
    const exit = await runAudit(
      ['--only=direct-push', '--sha=def456'],
      auditDeps({
        fetchAssociatedMergedPrs: () => {
          calls++
          return []
        },
        pollAttempts: 3,
        pollDelayMs: 1,
        sleep: async () => {},
        openDirectPushIncident: () => {
          incidentOpened++
        }
      })
    )
    expect(exit).toBe(1)
    expect(calls).toBe(3)
    expect(incidentOpened).toBe(1)
  })
})

describe('vinaya audit — dead-branch-push detection parity', () => {
  it('flags a branch whose tip commit lands after its own PR already resolved, via the same pure findDeadBranchPushes @attalabs/aeg-core exports to packages/aeg-core/bin/dead-branch-audit.ts', () => {
    const findings = findDeadBranchPushes([
      {
        branch: 'task/scratch/1',
        prNumber: 1,
        prState: 'MERGED',
        resolvedAt: '2026-01-01T00:00:00Z',
        latestCommitAt: '2026-01-02T00:00:00Z'
      },
      {
        branch: 'task/scratch/2',
        prNumber: 2,
        prState: 'CLOSED',
        resolvedAt: '2026-01-02T00:00:00Z',
        latestCommitAt: '2026-01-01T00:00:00Z'
      }
    ])
    expect(findings).toEqual([
      {
        branch: 'task/scratch/1',
        prNumber: 1,
        prState: 'MERGED',
        resolvedAt: '2026-01-01T00:00:00Z',
        latestCommitAt: '2026-01-02T00:00:00Z'
      }
    ])
  })
})
