import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkBriefSections,
  objectivesOf,
  parseIssueParts,
  parseIssueStopConditions,
  parseIssueSurface,
  parseIssueTestPlan,
  readTierFromPrBody
} from './index'
import { type BriefFacts, parseRationaleFields, renderBrief } from './brief-render'

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

describe('renderBrief', () => {
  it('renders a brief that checkBriefSections accepts with zero errors', () => {
    // A doc-only surface takes the `unit-tests-only` §9 path — the shape
    // `checkTestPlan` accepts today. A runtime-file surface renders §9 as a
    // fenced command list instead, which only `checkTestPlan` post-Part-3
    // (this same task) accepts — see this task's own §9 self-render proof in
    // the PR's round-1 comment for that path exercised end-to-end.
    const facts = baseFacts({
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

  it('derives Tier 0 for a surface with no spec/doc file, via deriveTierFromDiff', () => {
    const result = renderBrief(baseFacts(), TEMPLATE)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(readTierFromPrBody(result.brief)).toBe(0)
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

  it('§5 Step 0 creates the worktree branch with --no-track and configures push.autoSetupRemote, so a plain `git push` reaches the task\'s own ref (task 5, Issue #447, O2)', () => {
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
