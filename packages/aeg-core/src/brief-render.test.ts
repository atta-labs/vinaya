import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkBriefSections, readTierFromPrBody } from './index'
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

  it('refuses when the Issue has no `## Objectives` section', () => {
    const result = renderBrief(baseFacts({ objectives: [] }), '')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.missing.join(' ')).toMatch(/Objectives/)
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

  it('declares Test Plan: unit-tests-only when every surface file is a doc file', () => {
    const result = renderBrief(
      baseFacts({ surfaceFiles: [{ path: 'aeg-root/roles/developer.md', sha256: 'b'.repeat(64), packageName: null }] }),
      ''
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.brief).toMatch(/Test Plan:\*\* unit-tests-only|Test Plan: unit-tests-only/)
  })

  it('the §9 fallback command is `bunx turbo test --affected --force`, never `rm -rf apps/cli/dist`-prefixed (Principal ruling, PR open-1)', () => {
    // A runtime, non-test surface file (baseFacts' default `fixture.ts`)
    // takes the fenced-list branch with no per-test-file line, so it falls
    // through to the one generic command — the line `evidence-fresh`
    // attests against the body's own §9 list, never re-runs.
    const result = renderBrief(baseFacts(), TEMPLATE)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.brief).toContain('bunx turbo test --affected --force → summary line ends "0 fail"')
    expect(result.brief).not.toContain('rm -rf apps/cli/dist')
  })

  it('emits a consumer-tests sentinel when a touched package has an uncovered consumer', () => {
    const result = renderBrief(baseFacts({ consumersOf: () => ['apps/cli'] }), '')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.brief).toMatch(/consumer-tests: none —/)
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
