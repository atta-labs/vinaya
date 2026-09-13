import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkBriefSections,
  checkConsumerTests,
  objectivesOf,
  parseIssueParts,
  parseIssueStopConditions,
  parseIssueSurface,
  parseIssueTestPlan,
  readTierFromPrBody
} from './index'
import {
  type BriefFacts,
  extractBoundaryFilePaths,
  extractSourceRevision,
  parseRationaleFields,
  renderBrief
} from './brief-render'

const FIXTURE_REVISION = 'a'.repeat(40)

const TEMPLATE = readFileSync(join(import.meta.dirname, '../../../aeg-root/templates/brief-template.md'), 'utf8')

const ISSUE_BODY = `
[review-convergence-v1] 42 — a fixture task for the renderer

**Tier:** 1
**Project:** aeg-core

## Planner's rationale

**Boundary** — Do the thing in \`packages/aeg-core/src/fixture.ts\`. Keep it small.

**Sizing** — Passes all four tests.

**Project(s) + blast radius** — \`Project: aeg-core\`. No shared-package fan-out.

**Dependency rationale** — \`Depends-on: —\` — nothing this task needs already exists elsewhere.

**Traps to avoid** — (1) Do NOT skip the test. (2) Do NOT touch unrelated files.

**Suggested agent-class** — low — a single small pure function.

**Stop-and-escalate** — If the fixture ever needs a second file, STOP and escalate severity: execution.

**Docs to keep coherent** — no-doc-surface.
`

function baseFacts(overrides: Partial<BriefFacts> = {}): BriefFacts {
  return {
    trancheSlug: 'review-convergence-v1',
    taskId: '42',
    title: 'a fixture task for the renderer',
    issue: 42,
    projects: ['aeg-core'],
    dependsOn: [],
    conflictsWith: [],
    rationale: parseRationaleFields(ISSUE_BODY),
    objectives: [{ id: 'O1', text: 'A fixture objective for the renderer.' }],
    surface: { in: ['packages/aeg-core/src'], out: [] },
    parts: [{ n: 1, objectiveIds: [1], text: 'Do the thing in the fixture package.' }],
    testPlan: {
      kind: 'commands',
      lines: ['bunx turbo test --affected --force → summary line ends "0 fail"'],
      principal: []
    },
    stopConditions: ['If the fixture ever needs a second file, STOP and escalate severity: execution.'],
    dispatchReady: true,
    dispatchBlockers: [],
    surfaceFiles: [
      { path: 'packages/aeg-core/src/fixture.ts', sha256: 'a'.repeat(64), packageName: '@attalabs/aeg-core' }
    ],
    consumersOf: () => [],
    docOwnersContent: null,
    sourceRevision: FIXTURE_REVISION,
    ...overrides
  }
}

describe('parseRationaleFields', () => {
  it('reads all five fields this renderer needs from the bold-inline serialization', () => {
    const fields = parseRationaleFields(ISSUE_BODY)
    expect(fields.boundary).toMatch(/Do the thing/)
    expect(fields.dependencyRationale).toMatch(/Depends-on/)
    expect(fields.trapsToAvoid).toMatch(/Do NOT skip the test/)
    expect(fields.suggestedAgentClass).toMatch(/low/)
    expect(fields.stopAndEscalate).toMatch(/STOP and escalate/)
  })

  it('a field absent from the body is absent from the result, not an empty string', () => {
    const fields = parseRationaleFields('nothing rationale-shaped here')
    expect(fields.boundary).toBeUndefined()
  })
})

describe('extractBoundaryFilePaths (task 5, Issue #447, O3)', () => {
  it('extracts every backtick-wrapped, path-shaped token, deduplicated in order', () => {
    const text =
      "In: `apps/cli/src/lib/dispatch-task.ts` and `apps/cli/src/lib/brief-assembly.ts`'s result type, " +
      'plus `packages/aeg-core/src/brief-render.ts` again.'
    expect(extractBoundaryFilePaths(text)).toEqual([
      'apps/cli/src/lib/dispatch-task.ts',
      'apps/cli/src/lib/brief-assembly.ts',
      'packages/aeg-core/src/brief-render.ts'
    ])
  })

  it('ignores a glob example (contains `*`) — Surface globs are never file-level entries', () => {
    expect(extractBoundaryFilePaths('an Issue declaring `apps/cli/**` rendered a brief')).toEqual([])
  })

  it('ignores a multi-word command example (contains a space)', () => {
    expect(extractBoundaryFilePaths('prescribing `git push -u origin HEAD` as the push step')).toEqual([])
  })

  it('ignores a backticked token with no recognizable extension', () => {
    expect(extractBoundaryFilePaths('the renderer discards `n` instead of returning it')).toEqual([])
  })

  it('extracts a bare filename with no directory prefix, elided from a shared list', () => {
    const text = 'the Step 0 line — `aeg-root/aeg-manual-flow.md`, `process.md`, `roles/developer.md`'
    expect(extractBoundaryFilePaths(text)).toEqual(['aeg-root/aeg-manual-flow.md', 'process.md', 'roles/developer.md'])
  })
})

describe('renderBrief', () => {
  it('renders a brief that checkBriefSections accepts with zero errors', () => {
    // A doc-only surface takes the `unit-tests-only` §9 path — the shape
    // `checkTestPlan` accepts today. A runtime-file surface renders §9 as a
    // fenced command list instead, which only `checkTestPlan` post-Part-3
    // (this same task) accepts — see this task's own §9 self-render proof in
    // the PR's round-1 comment for that path exercised end-to-end.
    const facts = baseFacts({
      surface: { in: ['aeg-root'], out: [] },
      surfaceFiles: [{ path: 'aeg-root/roles/developer.md', sha256: 'a'.repeat(64), packageName: null }]
    })
    const result = renderBrief(facts, TEMPLATE)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { errors } = checkBriefSections(result.brief, readTierFromPrBody, {
      requireClosesN: true,
      consumersOf: () => []
    })
    expect(errors).toEqual([])
  })

  it('refuses and names the missing field when a rationale field is absent', () => {
    const result = renderBrief(baseFacts({ rationale: {} }), '')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.missing).toContain('Boundary')
    expect(result.missing).toContain('Dependency rationale')
    expect(result.missing).toContain('Traps to avoid')
    expect(result.missing).toContain('Suggested agent-class')
    expect(result.missing).toContain('Stop-and-escalate')
  })

  it('refuses and names the blockers when the dispatch gate is not clear', () => {
    const result = renderBrief(
      baseFacts({ dispatchReady: false, dispatchBlockers: ['dispatch-gate depends-on: blocked'] }),
      ''
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.missing).toContain('dispatch-gate depends-on: blocked')
  })

  it('refuses when an at/above-cutover Issue has no `## Objectives` section', () => {
    const result = renderBrief(baseFacts({ objectives: [], issue: 404 }), '')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.missing.join(' ')).toMatch(/Objectives/)
  })

  it('does NOT refuse a below-cutover Issue with no `## Objectives` section — grandfathered, same as checkIssueObjectives', () => {
    const result = renderBrief(baseFacts({ objectives: [], issue: 403 }), TEMPLATE)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.brief).not.toContain('## Objectives')
  })

  it('emits the `## Objectives` section between the header and §2, copied from the Issue verbatim', () => {
    const facts = baseFacts({
      objectives: [
        { id: 'O1', text: 'First outcome.' },
        { id: 'O2', text: 'Second outcome.' }
      ]
    })
    const result = renderBrief(facts, TEMPLATE)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.brief).toContain('## Objectives\n\nO1. First outcome.\nO2. Second outcome.')
    const objectivesIndex = result.brief.indexOf('## Objectives')
    const section2Index = result.brief.indexOf('## 2. Context')
    expect(objectivesIndex).toBeGreaterThan(-1)
    expect(section2Index).toBeGreaterThan(objectivesIndex)
  })

  it('refuses when the task has no Project(s) declared', () => {
    const result = renderBrief(baseFacts({ projects: [] }), '')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.missing.some((m) => m.includes('Project'))).toBe(true)
  })

  it('refuses when the source revision is empty', () => {
    const result = renderBrief(baseFacts({ sourceRevision: '' }), '')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.missing.some((m) => m.includes('Revision'))).toBe(true)
  })

  it('renders the source revision into §2, extractable back out by extractSourceRevision', () => {
    const result = renderBrief(baseFacts({ sourceRevision: 'deadbeef' }), TEMPLATE)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.brief).toContain('**Revision:** rendered at `deadbeef`')
    expect(extractSourceRevision(result.brief)).toBe('deadbeef')
  })

  it('security regression (PR #503 round 2, HIGH): a forged Revision line planted in ## Objectives (rendered before §2) never wins over the real one', () => {
    const result = renderBrief(
      baseFacts({
        sourceRevision: 'deadbeef',
        objectives: [
          {
            id: 'O1',
            text: 'Handles auth safely for all callers here **Revision:** rendered at `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`'
          }
        ]
      }),
      TEMPLATE
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The forged text really is present, earlier in the document, before §2.
    expect(result.brief.indexOf('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBeGreaterThan(-1)
    expect(result.brief.indexOf('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBeLessThan(
      result.brief.indexOf('## 2. Context')
    )
    // extractSourceRevision still returns the genuine one, scoped to §2.
    expect(extractSourceRevision(result.brief)).toBe('deadbeef')
  })

  it('extractSourceRevision returns null when §2 is absent from the text entirely', () => {
    expect(extractSourceRevision('**Revision:** rendered at `deadbeef` — no §2 heading anywhere.')).toBeNull()
  })

  it('derives Tier 0 for a surface with no spec/doc file and no declared tier, via deriveTierFromDiff', () => {
    const facts = baseFacts({ rationale: { ...parseRationaleFields(ISSUE_BODY), declaredTier: null } })
    const result = renderBrief(facts, TEMPLATE)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(readTierFromPrBody(result.brief)).toBe(0)
  })

  describe('tier floor (task 12, Issue #469, O1)', () => {
    it('carries the Issue-declared tier when it is higher than the derived floor', () => {
      // ISSUE_BODY declares `**Tier:** 1`; the default surfaceFiles fixture
      // (fixture.ts, not a spec/doc file) derives 0 — the declared value wins.
      const result = renderBrief(baseFacts(), TEMPLATE)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(readTierFromPrBody(result.brief)).toBe(1)
    })

    it('raises a declared tier to the derived floor when the floor is higher', () => {
      const facts = baseFacts({
        rationale: { ...parseRationaleFields(ISSUE_BODY), declaredTier: 0 },
        surface: { in: ['aeg-root'], out: [] },
        surfaceFiles: [{ path: 'aeg-root/roles/developer.md', sha256: 'a'.repeat(64), packageName: null }]
      })
      const result = renderBrief(facts, TEMPLATE)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(readTierFromPrBody(result.brief)).toBe(1)
    })

    it('never lowers a declared Tier 3 — the derivation cannot reach 3 at all', () => {
      const facts = baseFacts({ rationale: { ...parseRationaleFields(ISSUE_BODY), declaredTier: 3 } })
      const result = renderBrief(facts, TEMPLATE)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(readTierFromPrBody(result.brief)).toBe(3)
    })

    it('falls back to the derived floor alone when the Issue declares no Tier field', () => {
      const facts = baseFacts({
        rationale: { ...parseRationaleFields(ISSUE_BODY), declaredTier: null },
        surface: { in: ['aeg-root'], out: [] },
        surfaceFiles: [{ path: 'aeg-root/roles/developer.md', sha256: 'a'.repeat(64), packageName: null }]
      })
      const result = renderBrief(facts, TEMPLATE)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(readTierFromPrBody(result.brief)).toBe(1)
    })
  })

  describe('surface-filtered surface map (task 12, Issue #469, O2, O3)', () => {
    it('excludes a Boundary-named file the Issue Surface out: glob covers, even though in: would otherwise admit it', () => {
      const facts = baseFacts({
        surface: { in: ['packages/aeg-core'], out: ['packages/aeg-core/bin'] },
        surfaceFiles: [
          { path: 'packages/aeg-core/src/fixture.ts', sha256: 'a'.repeat(64), packageName: '@attalabs/aeg-core' },
          { path: 'packages/aeg-core/bin/open-pr.ts', sha256: 'b'.repeat(64), packageName: '@attalabs/aeg-core' }
        ]
      })
      const result = renderBrief(facts, TEMPLATE)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.brief).toContain('packages/aeg-core/src/fixture.ts')
      expect(result.brief).not.toContain('packages/aeg-core/bin/open-pr.ts')
    })

    it('excludes a Boundary-named file no in: glob covers at all', () => {
      const facts = baseFacts({
        surface: { in: ['packages/aeg-core/src'], out: [] },
        surfaceFiles: [
          { path: 'packages/aeg-core/src/fixture.ts', sha256: 'a'.repeat(64), packageName: '@attalabs/aeg-core' },
          { path: 'apps/cli/src/lib/unrelated-file.ts', sha256: 'b'.repeat(64), packageName: '@attalabs/aeg-cli' }
        ]
      })
      const result = renderBrief(facts, TEMPLATE)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.brief).toContain('packages/aeg-core/src/fixture.ts')
      expect(result.brief).not.toContain('apps/cli/src/lib/unrelated-file.ts')
    })

    it('refuses rather than rendering an empty surface map when Surface admits none of the Boundary-named files', () => {
      const facts = baseFacts({
        surface: { in: ['aeg-root'], out: [] },
        surfaceFiles: [
          { path: 'packages/aeg-core/src/fixture.ts', sha256: 'a'.repeat(64), packageName: '@attalabs/aeg-core' }
        ]
      })
      const result = renderBrief(facts, TEMPLATE)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.missing.some((m) => /Surface map/.test(m))).toBe(true)
    })

    it('does not refuse when the Boundary legitimately named zero files (an administrative-only task)', () => {
      const facts = baseFacts({ surface: { in: ['aeg-root'], out: [] }, surfaceFiles: [] })
      const result = renderBrief(facts, TEMPLATE)
      expect(result.ok).toBe(true)
    })
  })

  describe('a narrowed Boundary lists Surface in: directories under Modify, never just the file the rationale named (task 8, #506, O7)', () => {
    it('a one-file Boundary with a three-directory Surface renders three directory entries under Modify', () => {
      const facts = baseFacts({
        surface: { in: ['packages/aeg-core/src', 'apps/cli/src/lib', 'apps/cli/src/commands'], out: [] },
        surfaceFiles: [
          { path: 'packages/aeg-core/src/fixture.ts', sha256: 'a'.repeat(64), packageName: '@attalabs/aeg-core' }
        ]
      })
      const result = renderBrief(facts, TEMPLATE)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const modifyBlock = /\*\*Modify:\*\*\n([\s\S]*?)\n\n/.exec(result.brief)?.[1] ?? ''
      const modifyLines = modifyBlock
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      expect(modifyLines).toEqual(['- packages/aeg-core/src', '- apps/cli/src/lib', '- apps/cli/src/commands'])
      // The one named file is not what a developer reads as the scope — it
      // still appears in Premise pins (proof-of-revision), never as the
      // Modify bullet on its own.
      expect(modifyBlock).not.toContain('fixture.ts')

      // Directory-shaped Modify entries are still a brief checkBriefSections
      // accepts — the narrowing fallback does not break mechanical validation.
      const { errors } = checkBriefSections(result.brief, readTierFromPrBody, {
        requireClosesN: true,
        consumersOf: () => []
      })
      expect(errors).toEqual([])
    })

    it('a Boundary naming as many (or more) files than there are Surface in: directories keeps the file list under Modify, unchanged', () => {
      const facts = baseFacts({
        surface: { in: ['packages/aeg-core/src'], out: [] },
        surfaceFiles: [
          { path: 'packages/aeg-core/src/fixture.ts', sha256: 'a'.repeat(64), packageName: '@attalabs/aeg-core' }
        ]
      })
      const result = renderBrief(facts, TEMPLATE)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const modifyBlock = /\*\*Modify:\*\*\n([\s\S]*?)\n\n/.exec(result.brief)?.[1] ?? ''
      expect(modifyBlock.trim()).toBe('- packages/aeg-core/src/fixture.ts')
    })

    it('matching counts still narrow when both Boundary files land in the SAME in: directory, leaving the other uncovered (#526 round 2 MINOR)', () => {
      const facts = baseFacts({
        surface: { in: ['packages/aeg-core/src', 'apps/cli/src/lib'], out: [] },
        surfaceFiles: [
          { path: 'packages/aeg-core/src/a.ts', sha256: 'a'.repeat(64), packageName: '@attalabs/aeg-core' },
          { path: 'packages/aeg-core/src/b.ts', sha256: 'b'.repeat(64), packageName: '@attalabs/aeg-core' }
        ]
      })
      const result = renderBrief(facts, TEMPLATE)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const modifyBlock = /\*\*Modify:\*\*\n([\s\S]*?)\n\n/.exec(result.brief)?.[1] ?? ''
      const modifyLines = modifyBlock
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      // A bare count comparison (2 files, 2 dirs) would have kept the file
      // list — `apps/cli/src/lib` would never appear anywhere in Modify.
      expect(modifyLines).toEqual(['- packages/aeg-core/src', '- apps/cli/src/lib'])
    })

    it('an in: entry carrying a glob suffix renders as a clean directory path, not the raw glob (#526 round 2 MINOR)', () => {
      const facts = baseFacts({
        surface: { in: ['packages/aeg-core/src/**', 'apps/cli/src/lib/*'], out: [] },
        surfaceFiles: [
          { path: 'packages/aeg-core/src/fixture.ts', sha256: 'a'.repeat(64), packageName: '@attalabs/aeg-core' }
        ]
      })
      const result = renderBrief(facts, TEMPLATE)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const modifyBlock = /\*\*Modify:\*\*\n([\s\S]*?)\n\n/.exec(result.brief)?.[1] ?? ''
      const modifyLines = modifyBlock
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      expect(modifyLines).toEqual(['- packages/aeg-core/src', '- apps/cli/src/lib'])
    })
  })

  it('declares Test Plan: unit-tests-only when the Issue Test plan section is the sentinel', () => {
    const result = renderBrief(baseFacts({ testPlan: { kind: 'unit-tests-only' } }), '')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.brief).toMatch(/Test Plan:\*\* unit-tests-only|Test Plan: unit-tests-only/)
  })

  it('§9 is copied verbatim from the Issue Test plan section, never re-derived from the surface file list', () => {
    const result = renderBrief(baseFacts(), TEMPLATE)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.brief).toContain('bunx turbo test --affected --force → summary line ends "0 fail"')
    expect(result.brief).not.toContain('rm -rf apps/cli/dist')
  })

  it('§9 emits a `[principal]` box when the Issue Test plan names one', () => {
    const result = renderBrief(
      baseFacts({
        testPlan: { kind: 'commands', lines: ['bun test → 0 fail'], principal: ['Verify in a real browser.'] }
      }),
      TEMPLATE
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.brief).toContain('- [ ] **[principal]** Verify in a real browser.')
  })

  it('§9 widens its fence rather than let embedded backticks in Issue-sourced lines break out of it (security review finding)', () => {
    // The Issue's own `## Test plan` can be fenced with MORE than three
    // backticks, so a literal triple-backtick line survives inside
    // `extractFencedBlocks`'s content as ordinary text — splicing it
    // between a *fixed* three-backtick fence here would close the section
    // early and spill the rest as unfenced prose.
    const result = renderBrief(
      baseFacts({
        testPlan: {
          kind: 'commands',
          lines: ['bun test → 0 fail', '```', 'echo injected, now unfenced', '```'],
          principal: []
        }
      }),
      ''
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const section9 = result.brief.slice(result.brief.indexOf('## 9. Test Plan'))
    const lines = section9.split('\n')
    // Exactly two lines at the WIDENED four-backtick length (the real
    // open/close fence) — the Issue's own embedded three-backtick lines
    // must survive as plain content, never mistaken for the closer.
    const widenedFenceLines = lines.filter((l) => l === '````')
    const embeddedTripleBacktickLines = lines.filter((l) => l === '```')
    expect(widenedFenceLines).toHaveLength(2)
    expect(embeddedTripleBacktickLines).toHaveLength(2)
    expect(section9).toContain('echo injected, now unfenced')
  })

  it('refuses and names Test plan when the Issue Test plan section is unparseable', () => {
    const result = renderBrief(baseFacts({ testPlan: { kind: 'commands', lines: [], principal: [] } }), '')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.missing.join(' ')).toMatch(/Test plan/)
  })

  it('refuses and names Surface/Parts/Stop conditions when each is the absent-section sentinel', () => {
    const result = renderBrief(baseFacts({ surface: { in: [], out: [] }, parts: [], stopConditions: [] }), '')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.missing.some((m) => m.startsWith('Surface'))).toBe(true)
    expect(result.missing.some((m) => m.startsWith('Parts'))).toBe(true)
    expect(result.missing.some((m) => m.startsWith('Stop conditions'))).toBe(true)
  })

  it('§4 Out of surface is rendered from the Issue Surface out: list, never a placeholder', () => {
    const result = renderBrief(
      baseFacts({ surface: { in: ['packages/aeg-core/src'], out: ['packages/aeg-core/tests'] } }),
      ''
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.brief).toContain('**Out of surface:** packages/aeg-core/tests')
    expect(result.brief).not.toContain('named explicitly by the Planner')
  })

  it('§6 renders one numbered Part per IssuePart, its citation reconstructed verbatim', () => {
    const result = renderBrief(
      baseFacts({
        parts: [
          { n: 1, objectiveIds: [1], text: 'the parsers.' },
          { n: 2, objectiveIds: [1, 2], text: 'the render.' }
        ]
      }),
      ''
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.brief).toContain('1. **Part 1 (O1):** the parsers.')
    expect(result.brief).toContain('2. **Part 2 (O1, O2):** the render.')
  })

  it('§10 renders the Issue Stop conditions bullets plus the rationale Stop-and-escalate field', () => {
    const result = renderBrief(baseFacts({ stopConditions: ['A premise pin mismatches.'] }), '')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.brief).toContain('- A premise pin mismatches.')
    expect(result.brief).toContain('If the fixture ever needs a second file, STOP and escalate severity: execution.')
  })

  it('emits a consumer-tests sentinel when a touched package has an uncovered consumer', () => {
    const result = renderBrief(baseFacts({ consumersOf: () => ['apps/cli'] }), '')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.brief).toMatch(/consumer-tests: none —/)
  })

  // task 17, O6 — a directory-only §4 (Modify lists Surface directories, not
  // files, because the Boundary named fewer files than `## Surface` `in:`
  // declares) must never produce a brief `checkConsumerTests` itself rejects
  // (#478's frozen brief: exactly this shape refused on `pr create`).
  it('a covered consumer names its covering test DIRECTORY, not a file, when the Boundary narrows the Surface — and the rendered §4 passes checkConsumerTests', () => {
    const result = renderBrief(
      baseFacts({
        surface: { in: ['packages/aeg-core/src', 'packages/aeg-core/bin', 'apps/cli/tests'], out: [] },
        consumersOf: () => ['apps/cli'],
        surfaceFiles: [
          { path: 'packages/aeg-core/src/fixture.ts', sha256: 'a'.repeat(64), packageName: '@attalabs/aeg-core' },
          { path: 'apps/cli/tests/checks/fixture.test.ts', sha256: 'b'.repeat(64), packageName: null }
        ]
      }),
      ''
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const section4 = /## 4\. Technical surface map[\s\S]*?(?=\n## 5\.)/.exec(result.brief)?.[0] ?? ''
    const modifyBlock = /\*\*Modify:\*\*\n([\s\S]*?)\n\n/.exec(section4)?.[1] ?? ''
    // boundaryNarrowsSurface: `packages/aeg-core/bin` has no covering file,
    // so the Modify LIST ITSELF names directories, never the covering file
    // (which can still legitimately appear elsewhere in §4, e.g. Premise
    // pins for an already-existing file — the explicit consumer-tests line
    // below is what makes coverage independently, robustly visible rather
    // than relying on that incidental side channel).
    expect(modifyBlock).toContain('packages/aeg-core/bin')
    expect(modifyBlock).not.toContain('apps/cli/tests/checks/fixture.test.ts')
    expect(section4).toMatch(/consumer-tests: apps\/cli\/tests \(covers @attalabs\/aeg-core\)/)
    expect(section4).not.toMatch(/consumer-tests: none —/)

    const validated = checkConsumerTests(result.brief, (pkg) => (pkg === 'aeg-core' ? ['apps/cli'] : []))
    expect(validated.status).toBe('pass')
  })

  // Round 2 review, BLOCKER: the covering file can be a COLOCATED test
  // (`packages/sources/src/foo.test.ts`, the layout `packages/sources` and
  // `packages/aeg-core` already use in this repo) with no `tests`/`specs`
  // ancestor to name — the prior fallback named the file's bare containing
  // directory, which neither of `checkConsumerTests`'s two accepted forms
  // (a real `.test.<ext>` file, or a `tests`/`specs`-segment directory)
  // matches, reopening the exact "renderer produces what its own validator
  // rejects" bug this whole objective exists to close.
  it('a covered consumer with a COLOCATED covering test (no tests/specs ancestor) names the file itself, and the rendered §4 passes checkConsumerTests', () => {
    const result = renderBrief(
      baseFacts({
        surface: { in: ['packages/aeg-core/src', 'packages/aeg-core/bin', 'packages/sources/src'], out: [] },
        consumersOf: () => ['packages/sources'],
        surfaceFiles: [
          { path: 'packages/aeg-core/src/fixture.ts', sha256: 'a'.repeat(64), packageName: '@attalabs/aeg-core' },
          { path: 'packages/sources/src/fixture.test.ts', sha256: 'b'.repeat(64), packageName: null }
        ]
      }),
      ''
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const section4 = /## 4\. Technical surface map[\s\S]*?(?=\n## 5\.)/.exec(result.brief)?.[0] ?? ''
    expect(section4).toMatch(/consumer-tests: packages\/sources\/src\/fixture\.test\.ts \(covers @attalabs\/aeg-core\)/)
    expect(section4).not.toMatch(/consumer-tests: none —/)

    const validated = checkConsumerTests(result.brief, (pkg) => (pkg === 'aeg-core' ? ['packages/sources'] : []))
    expect(validated.status).toBe('pass')
  })

  // O4 (#579): a shared package named ONLY as a bare Surface `in:` directory
  // — no individual file pinned anywhere under it — must still trigger the
  // consumer-tests rule. Before this fix the trigger read `facts.surfaceFiles`'
  // per-file `packageName` alone, which stays empty here, so the renderer
  // emitted no consumer-tests line at all: exactly this Issue's own live
  // write, before its Boundary named `packages/sources/src/file-adapter.test.ts`
  // by path. Reproduced with that path removed.
  it('a shared package named only as a bare Surface `in:` directory still triggers consumer-tests, with a test file under only one of its two consumers', () => {
    const result = renderBrief(
      baseFacts({
        surface: { in: ['packages/sources/src', 'apps/cli/tests'], out: [] },
        consumersOf: (pkg) => (pkg === 'sources' ? ['apps/cli', 'apps/other'] : []),
        surfaceFiles: [{ path: 'apps/cli/tests/lib/fixture.test.ts', sha256: 'c'.repeat(64), packageName: null }]
      }),
      ''
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const section4 = /## 4\. Technical surface map[\s\S]*?(?=\n## 5\.)/.exec(result.brief)?.[0] ?? ''
    expect(section4).toContain('packages/sources/src')
    expect(section4).toMatch(/consumer-tests: apps\/cli\/tests \(covers @attalabs\/sources\)/)
    expect(section4).toMatch(
      /consumer-tests: none — no consumer test path named yet for @attalabs\/sources \(apps\/other\)/
    )

    const validated = checkConsumerTests(result.brief, (pkg) => (pkg === 'sources' ? ['apps/cli', 'apps/other'] : []))
    expect(validated.status).toBe('pass')
  })

  it("§5 Step 0 creates the worktree branch with --no-track and configures push.autoSetupRemote, so a plain `git push` reaches the task's own ref (task 5, Issue #447, O2)", () => {
    const result = renderBrief(baseFacts(), TEMPLATE)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Without `--no-track`, `git worktree add -b <branch> origin/main` tracks
    // `origin/main` itself — a plain `git push` then fails with git's
    // upstream-name-mismatch error, which suggests `git push origin HEAD:main`
    // (live evidence: reproduced dispatching this exact task).
    expect(result.brief).toContain(
      'git worktree add .worktrees/task/review-convergence-v1/42 -b task/review-convergence-v1/42 --no-track origin/main'
    )
    expect(result.brief).toContain('git config push.autoSetupRemote true')
  })

  it('§6/§8 no longer instruct running the affected suite per Part — the pre-push hook already does (O10)', () => {
    const result = renderBrief(baseFacts(), TEMPLATE)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.brief).not.toContain('Run `bunx turbo test --affected` before committing this Part')
    expect(result.brief).toContain(
      'The pre-push hook runs the affected suite on your one push and refuses it on failure'
    )
    expect(result.brief).toContain(
      'The pre-push hook already ran the affected suite on your one push and refused it on failure'
    )
  })
})

// plan-brief-v1 task 1, Issue #426, O2/O3: the real fixture Issue, run
// through the four parsers exactly as `apps/cli/src/commands/brief.ts`
// does, must render with zero bracketed placeholders and pass every check
// `verify-brief`/`brief-shape` run — no hand edit needed to be dispatchable.
describe('renderBrief — end-to-end from a real Issue body (#426 fixture)', () => {
  const ISSUE_426_BODY = readFileSync(join(import.meta.dirname, '../tests/fixtures/issue-426-body.md'), 'utf8')

  function factsFromIssue426(): BriefFacts {
    const surface = parseIssueSurface(ISSUE_426_BODY)
    const parts = parseIssueParts(ISSUE_426_BODY)
    const testPlan = parseIssueTestPlan(ISSUE_426_BODY)
    const stopConditions = parseIssueStopConditions(ISSUE_426_BODY)
    if (!surface.ok || !parts.ok || !testPlan.ok || !stopConditions.ok) {
      throw new Error('fixture issue-426-body.md must parse cleanly under every one of the four parsers')
    }
    return baseFacts({
      trancheSlug: 'plan-brief-v1',
      taskId: '1',
      title: 'The Issue carries every judgment section of the brief; brief render refuses on a gap',
      issue: 426,
      projects: ['aeg-core', 'cli', 'sources'],
      rationale: parseRationaleFields(ISSUE_426_BODY),
      objectives: (() => {
        const parsed = objectivesOf(ISSUE_426_BODY)
        return parsed.ok ? parsed.objectives : []
      })(),
      surface: surface.value,
      parts: parts.value,
      testPlan: testPlan.value,
      stopConditions: stopConditions.value
    })
  }

  it('renders with zero `[named explicitly`/`[NEEDS CLARIFICATION` bracketed placeholders', () => {
    const result = renderBrief(factsFromIssue426(), TEMPLATE)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.brief).not.toContain('[named explicitly')
    expect(result.brief).not.toContain('[NEEDS CLARIFICATION')
  })

  it('the rendered brief passes every check `checkBriefSections` runs', () => {
    const result = renderBrief(factsFromIssue426(), TEMPLATE)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { errors } = checkBriefSections(result.brief, readTierFromPrBody, {
      requireClosesN: true,
      consumersOf: () => []
    })
    expect(errors).toEqual([])
  })

  it('removing `## Parts` from the fixture makes renderBrief refuse, naming Parts', () => {
    const withoutParts = ISSUE_426_BODY.replace(/## Parts[\s\S]*?(?=\n## Test plan)/, '')
    const parts = parseIssueParts(withoutParts)
    expect(parts.ok).toBe(false)
    const facts = factsFromIssue426()
    const result = renderBrief({ ...facts, parts: [] }, TEMPLATE)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.missing.some((m) => m.startsWith('Parts'))).toBe(true)
  })
})
