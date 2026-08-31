import { describe, expect, it } from 'vitest'
import { parseEnforcementRegistry } from './registry-parse'
import { applyScaffoldPlan, computeScaffoldPlan, PLACEHOLDER } from './registry-scaffold'

/** A minimal, real three-ring `enforcement.md` shape — enough for
 * `parseEnforcementRegistry`/`findTable` to recognize each table, with one
 * genuine existing row per ring to anchor an insertion after. */
function fixtureContent(): string {
  return [
    '# Enforcement',
    '',
    '## Ring 0 — Hooks',
    '',
    '| Action | Summary | Category | Description | Gate | What must be true before the action is allowed | Audience | implementation |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    '| `git commit` | Ever pushed broken code? | hook | Refuses a bad commit. | **pre-commit** | Checks pass. | repo-own | `packages/aeg-core/bin/verify-task.ts` |',
    '',
    '## Ring 1 — Branch Rules',
    '',
    '| CI check | Summary | Category | Description | Re-verifies | Audience | implementation |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    '| Closes linkage | Ever merged without closing? | ci | Re-checks Closes #N. | The PR closes its Issue. | product | `packages/aeg-core/bin/verify-coherence.ts` |',
    '',
    '## Ring 2 — Audits',
    '',
    '| Mechanism | Summary | Category | Description | Runs | Catches | Audience | implementation |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    '| Post-merge archivist | Ever wanted a record? | event | Records what shipped. | On every merge. | Missing provenance. | repo-own | `packages/aeg-core/bin/archive-task.ts` |',
    ''
  ].join('\n')
}

describe('computeScaffoldPlan', () => {
  it('hook-glob-sourced class: a .husky candidate gets a ring-0 stub with no registry lookup', () => {
    const rows = parseEnforcementRegistry(fixtureContent())
    const plan = computeScaffoldPlan(rows, ['.husky/pre-push'])
    expect(plan.stubs).toHaveLength(1)
    expect(plan.stubs[0]?.ring).toBe('ring0')
    expect(plan.stubs[0]?.checkName).toBeUndefined()
    expect(plan.stubs[0]?.cells).toContain(PLACEHOLDER)
    expect(plan.skipped).toHaveLength(0)
  })

  it('.claude/hooks/*.sh is the second hook-glob class, same ring-0 treatment', () => {
    const rows = parseEnforcementRegistry(fixtureContent())
    const plan = computeScaffoldPlan(rows, ['.claude/hooks/check-forge-gates.sh'])
    expect(plan.stubs).toHaveLength(1)
    expect(plan.stubs[0]?.ring).toBe('ring0')
  })

  it('registry-backed class: an aeg-core bin resolving via GATE_AUDIENCE to a ring-0 check gets a ring-0 stub naming the check', () => {
    const rows = parseEnforcementRegistry(fixtureContent())
    // `check-branch-topology` -> `branch-topology`, ring 0 (GATE_AUDIENCE).
    const plan = computeScaffoldPlan(rows, ['packages/aeg-core/bin/check-branch-topology.ts'])
    expect(plan.stubs).toHaveLength(1)
    expect(plan.stubs[0]?.ring).toBe('ring0')
    expect(plan.stubs[0]?.checkName).toBe('branch-topology')
    expect(plan.stubs[0]?.cells[0]).toBe('branch-topology')
  })

  it('registry-backed class: a ring-1 check (test-plan, requiresOpenPr) gets a ring-1 stub', () => {
    const rows = parseEnforcementRegistry(fixtureContent())
    // `verify-test-plan` -> `test-plan`, ring 1 (GATE_AUDIENCE).
    const plan = computeScaffoldPlan(rows, ['packages/aeg-core/bin/verify-test-plan.ts'])
    expect(plan.stubs).toHaveLength(1)
    expect(plan.stubs[0]?.ring).toBe('ring1')
    expect(plan.stubs[0]?.checkName).toBe('test-plan')
  })

  it('the no-guess class: an aeg-core bin with no registry entry gets NO stub, and is reported skipped', () => {
    const rows = parseEnforcementRegistry(fixtureContent())
    const plan = computeScaffoldPlan(rows, ['packages/aeg-core/bin/some-brand-new-tool.ts'])
    expect(plan.stubs).toHaveLength(0)
    expect(plan.skipped).toHaveLength(1)
    expect(plan.skipped[0]?.path).toBe('packages/aeg-core/bin/some-brand-new-tool.ts')
  })

  it('an internal (non-shipped) aeg-core gate — e.g. verify-task — also gets no stub', () => {
    const rows = parseEnforcementRegistry(fixtureContent())
    const plan = computeScaffoldPlan(rows, ['packages/aeg-core/bin/verify-task.ts'])
    // Already documented in the fixture's own Ring 0 row — not even a candidate.
    expect(plan.stubs).toHaveLength(0)
    expect(plan.skipped).toHaveLength(0)
  })

  it('a candidate already named by an existing row produces no stub (never touches or duplicates it)', () => {
    const rows = parseEnforcementRegistry(fixtureContent())
    const plan = computeScaffoldPlan(rows, ['packages/aeg-core/bin/verify-coherence.ts'])
    expect(plan.stubs).toHaveLength(0)
    expect(plan.skipped).toHaveLength(0)
  })

  it('apps/cli-backed class (Issue #307): a registered check bin resolving via CLI_CHECK_RING to ring-0 gets a ring-0 stub naming the check', () => {
    const rows = parseEnforcementRegistry(fixtureContent())
    // `check-brief-shape` -> `brief-shape`, ring 0 (CLI_CHECK_RING).
    const plan = computeScaffoldPlan(rows, ['apps/cli/src/checks/bin/check-brief-shape.ts'])
    expect(plan.stubs).toHaveLength(1)
    expect(plan.stubs[0]?.ring).toBe('ring0')
    expect(plan.stubs[0]?.checkName).toBe('brief-shape')
    expect(plan.stubs[0]?.cells[0]).toBe('brief-shape')
    expect(plan.stubs[0]?.cells[7]).toBe('`apps/cli/src/checks/bin/check-brief-shape.ts`')
  })

  it('apps/cli-backed class: a ring-1 check (closes-n, requiresOpenPr) gets a ring-1 stub', () => {
    const rows = parseEnforcementRegistry(fixtureContent())
    // `check-closes-n` -> `closes-n`, ring 1 (CLI_CHECK_RING).
    const plan = computeScaffoldPlan(rows, ['apps/cli/src/checks/bin/check-closes-n.ts'])
    expect(plan.stubs).toHaveLength(1)
    expect(plan.stubs[0]?.ring).toBe('ring1')
    expect(plan.stubs[0]?.checkName).toBe('closes-n')
  })

  it('an apps/cli bin with no CLI_CHECK_RING entry gets NO stub, and is reported skipped — the same no-guess discipline as the aeg-core-bin class', () => {
    const rows = parseEnforcementRegistry(fixtureContent())
    const plan = computeScaffoldPlan(rows, ['apps/cli/src/checks/bin/check-some-brand-new-tool.ts'])
    expect(plan.stubs).toHaveLength(0)
    expect(plan.skipped).toHaveLength(1)
    expect(plan.skipped[0]?.path).toBe('apps/cli/src/checks/bin/check-some-brand-new-tool.ts')
  })

  it('an apps/cli bin whose name does not follow the check-<name> convention gets NO stub rather than a guessed name', () => {
    const rows = parseEnforcementRegistry(fixtureContent())
    const plan = computeScaffoldPlan(rows, ['apps/cli/src/checks/bin/not-a-check-prefixed-file.ts'])
    expect(plan.stubs).toHaveLength(0)
    expect(plan.skipped).toHaveLength(1)
  })

  it('only mechanical cells are filled; every other cell is the exact placeholder marker', () => {
    const rows = parseEnforcementRegistry(fixtureContent())
    const plan = computeScaffoldPlan(rows, ['packages/aeg-core/bin/check-branch-topology.ts'])
    const cells = plan.stubs[0]?.cells ?? []
    // ring0 shape: [action, summary, category, description, gate, what-must-be-true, audience, implementation]
    expect(cells[0]).toBe('branch-topology')
    expect(cells[1]).toBe(PLACEHOLDER)
    expect(cells[2]).toBe('hook')
    expect(cells[3]).toBe(PLACEHOLDER)
    expect(cells[4]).toContain('branch-topology')
    expect(cells[5]).toBe(PLACEHOLDER)
    expect(cells[6]).toBe('product')
    expect(cells[7]).toBe('`packages/aeg-core/bin/check-branch-topology.ts`')
  })
})

describe('applyScaffoldPlan + round-trip', () => {
  it('inserts a stub row into the correct ring table, re-parseable, without disturbing existing rows', () => {
    const content = fixtureContent()
    const rows = parseEnforcementRegistry(content)
    const plan = computeScaffoldPlan(rows, ['packages/aeg-core/bin/check-branch-topology.ts'])
    const rewritten = applyScaffoldPlan(content, plan)

    const reparsed = parseEnforcementRegistry(rewritten)
    expect(reparsed).toHaveLength(rows.length + 1)

    const inserted = reparsed.find((r) => r.implementation === 'packages/aeg-core/bin/check-branch-topology.ts')
    expect(inserted).toBeDefined()
    expect(inserted?.ring).toBe('ring0')
    expect(inserted?.summary).toBe(PLACEHOLDER)

    // Every original row's implementation still resolves, byte-identically
    // present (existing-row preservation, including the #67-style hand
    // written rows this stands in for).
    for (const original of rows) {
      const stillThere = reparsed.find(
        (r) => r.implementation === original.implementation && r.action === original.action
      )
      expect(stillThere, `lost existing row for ${original.implementation}`).toBeDefined()
    }
  })

  it('is idempotent: computing a plan against the rewritten content finds nothing left to insert', () => {
    const content = fixtureContent()
    const rows = parseEnforcementRegistry(content)
    const candidateFiles = ['packages/aeg-core/bin/check-branch-topology.ts']

    const firstPlan = computeScaffoldPlan(rows, candidateFiles)
    const rewritten = applyScaffoldPlan(content, firstPlan)
    const reparsedRows = parseEnforcementRegistry(rewritten)

    const secondPlan = computeScaffoldPlan(reparsedRows, candidateFiles)
    expect(secondPlan.stubs).toHaveLength(0)

    // Running the writer again produces byte-identical content — nothing to
    // insert means applyScaffoldPlan is a no-op on an empty plan.
    const rewrittenAgain = applyScaffoldPlan(rewritten, secondPlan)
    expect(rewrittenAgain).toBe(rewritten)
  })

  it('inserts multiple stubs across different rings correctly, each anchored to its own table', () => {
    const content = fixtureContent()
    const rows = parseEnforcementRegistry(content)
    const plan = computeScaffoldPlan(rows, [
      'packages/aeg-core/bin/check-branch-topology.ts', // ring0
      'packages/aeg-core/bin/verify-test-plan.ts', // ring1
      '.husky/pre-push' // ring0
    ])
    expect(plan.stubs).toHaveLength(3)

    const rewritten = applyScaffoldPlan(content, plan)
    const reparsed = parseEnforcementRegistry(rewritten)
    expect(reparsed).toHaveLength(rows.length + 3)

    const ring0Count = reparsed.filter((r) => r.ring === 'ring0').length
    const ring1Count = reparsed.filter((r) => r.ring === 'ring1').length
    expect(ring0Count).toBe(rows.filter((r) => r.ring === 'ring0').length + 2)
    expect(ring1Count).toBe(rows.filter((r) => r.ring === 'ring1').length + 1)

    for (const original of rows) {
      expect(reparsed.some((r) => r.implementation === original.implementation)).toBe(true)
    }
  })

  it('returns content unchanged when the plan has no stubs', () => {
    const content = fixtureContent()
    const rewritten = applyScaffoldPlan(content, { stubs: [], skipped: [] })
    expect(rewritten).toBe(content)
  })
})

describe('checkG2 + scaffold integration: a stub-bearing table stays loud', () => {
  it('a freshly-scaffolded row still yields a G2 finding via the placeholder marker', async () => {
    const { checkG2 } = await import('./registry-checks')
    const content = fixtureContent()
    const rows = parseEnforcementRegistry(content)
    const candidateFiles = ['packages/aeg-core/bin/check-branch-topology.ts']
    const plan = computeScaffoldPlan(rows, candidateFiles)
    const rewritten = applyScaffoldPlan(content, plan)
    const reparsed = parseEnforcementRegistry(rewritten)

    const result = checkG2(reparsed, candidateFiles)
    // The orphan half is now silent (implementation is present) — the
    // placeholder half is what still reports it.
    expect(result.status).toBe('info')
    expect(result.findings.some((f) => f.reason.includes('placeholder'))).toBe(true)
  })
})
