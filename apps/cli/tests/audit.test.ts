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

// rings.ring2_asyncAudits means what it says (issue-545, O2): `true`/absent
// RUNS the async audits, so dead-branch-push's real work runs. `false` is
// the opt-OUT that skips it.
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

  it('`false` skips dead-branch-push, but direct-main-push-detection still runs for real', async () => {
    writeConfig({ rings: { ring1_forgeWriteInterception: true, ring2_asyncAudits: false } })
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

  it('`false` — a genuine direct-push violation still fails and still opens the incident (the strongest proof: not just that the check runs, but that its real verdict survives)', async () => {
    writeConfig({ rings: { ring1_forgeWriteInterception: true, ring2_asyncAudits: false } })
    let incidentOpened = 0
    const exit = await runAudit(
      ['--sha=abc123'],
      auditDeps({
        detectRepo: async () => ({ repoRoot: cwd, owner: 'acme', repo: 'widget' }),
        fetchAssociatedMergedPrs: () => [],
        pollAttempts: 2,
        pollDelayMs: 1,
        sleep: async () => {},
        openDirectPushIncident: () => {
          incidentOpened++
        }
      })
    )
    expect(exit).toBe(1)
    expect(incidentOpened).toBe(1)
  })

  it('`false` with `--only=dead-branches` — dead-branch-push is the only work requested, and it is skipped', async () => {
    writeConfig({ rings: { ring1_forgeWriteInterception: true, ring2_asyncAudits: false } })
    const exit = await runAudit(
      ['--only=dead-branches', '--sha=abc123'],
      auditDeps({ detectRepo: async () => ({ repoRoot: cwd, owner: 'acme', repo: 'widget' }) })
    )
    expect(exit).toBe(0)
  })

  it('`false` with `--only=direct-push` — unaffected by the flag, runs for real', async () => {
    writeConfig({ rings: { ring1_forgeWriteInterception: true, ring2_asyncAudits: false } })
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

  it('`true` is a no-op — dead-branch-push still runs (fails pre-flight the same as before the flag existed)', async () => {
    writeConfig({ rings: { ring1_forgeWriteInterception: true, ring2_asyncAudits: true } })
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

// The default full run (no `--only`, ring2 off) exercises `runDeadBranchAudit`
// for real — its own internals (`listTaskBranches`, `mostRecentPr`,
// `commentDate`, …) shell out to `git`/`gh` directly and are NOT reachable
// through `AuditDeps`. Running it from a directory with no `origin` remote is
// a real, deterministic exercise of `shSoft`'s own catch (it never throws;
// `git ls-remote` fails immediately, locally, the moment it finds no
// `origin` to resolve, and `listTaskBranches` sees an empty string back) —
// which in turn drives `runDeadBranchAudit` down its normal, no-findings
// success return, not its own outer catch. No network, no `gh` auth, no hang.
describe('vinaya audit — default full run (dead-branch + direct-push together)', () => {
  let cwd: string
  let originalCwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'vinaya-audit-full-run-test-'))
    originalCwd = process.cwd()
    process.chdir(cwd)
  })
  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(cwd, { recursive: true, force: true })
  })

  it('runs both audits by default; dead-branch soft-fails outside a git remote, direct-push legitimate → exit 0', async () => {
    const exit = await runAudit(
      ['--sha=cafefeed'],
      auditDeps({
        detectRepo: async () => ({ repoRoot: cwd, owner: 'acme', repo: 'widget' }),
        fetchAssociatedMergedPrs: () => [42]
      })
    )
    expect(exit).toBe(0)
  })

  it('runs both audits by default; direct-push fails → exit 1, incident opened once', async () => {
    let incidentOpened = 0
    const exit = await runAudit(
      ['--sha=deadbeef'],
      auditDeps({
        detectRepo: async () => ({ repoRoot: cwd, owner: 'acme', repo: 'widget' }),
        fetchAssociatedMergedPrs: () => [],
        pollAttempts: 1,
        pollDelayMs: 1,
        sleep: async () => {},
        openDirectPushIncident: () => {
          incidentOpened++
        }
      })
    )
    expect(exit).toBe(1)
    expect(incidentOpened).toBe(1)
  })
})

describe('vinaya audit — `--json` output mode', () => {
  // §10 stop condition: "a test that cannot assert anything meaningful ...
  // leave it uncovered with a comment." The `skipped`/`reason` payload text
  // for this branch is only observable via the JSON stdout body — `AuditDeps`
  // has no injectable writer — so this only asserts the exit code, not that
  // payload, per §6 Part 2's "never on console output."
  it('with `--only=dead-branches` and ring2 opted out (no subprocess reachable at all) → exit 0', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'vinaya-audit-json-test-'))
    const originalCwd = process.cwd()
    process.chdir(cwd)
    try {
      writeFileSync(
        join(cwd, 'vinaya.config.json'),
        JSON.stringify({ rings: { ring1_forgeWriteInterception: true, ring2_asyncAudits: false } }),
        'utf8'
      )
      const exit = await runAudit(
        ['--json', '--only=dead-branches', '--sha=cafefeed'],
        auditDeps({ detectRepo: async () => ({ repoRoot: cwd, owner: 'acme', repo: 'widget' }) })
      )
      expect(exit).toBe(0)
    } finally {
      process.chdir(originalCwd)
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('with `--only=direct-push` and a violation → exit 1, incident opened once (dead-branch untouched)', async () => {
    let incidentOpened = 0
    const exit = await runAudit(
      ['--json', '--only=direct-push', '--sha=cafebabe'],
      auditDeps({
        fetchAssociatedMergedPrs: () => [],
        pollAttempts: 1,
        pollDelayMs: 1,
        sleep: async () => {},
        openDirectPushIncident: () => {
          incidentOpened++
        }
      })
    )
    expect(exit).toBe(1)
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
