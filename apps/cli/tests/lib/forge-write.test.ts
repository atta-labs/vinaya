import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHECK_SCHEMA_VERSION, type CheckError } from '../../src/checks/contract'
import {
  collectTaskIssueErrors,
  runIssueChecks,
  type TaskIssueValidationDeps,
  validateForgeWrite,
  validateIssueContent
} from '../../src/lib/forge-write'

// ---------------------------------------------------------------------------
// O1 — the write gate runs every group over one body and refuses once with
// the union of findings, instead of stopping at the first group.
//
// `collectTaskIssueErrors` (`issue create`/`issue edit`'s own aggregation
// core) is the unit under test — real for the schema and content groups
// (both pure, no I/O), injected for the rendered-brief-shape and registry
// groups (both need live forge/filesystem/template state that a fixture-less
// unit test should not have to stand up — the CLI-level `pr create`/
// `issue create` suites already exercise those for real).
// ---------------------------------------------------------------------------

describe('collectTaskIssueErrors — one gate sequence, every group, one refusal (O1)', () => {
  let cwd: string
  let originalCwd: string

  beforeEach(() => {
    // Isolated from the real repo's own `vinaya.config.json` (whose
    // `briefSchema.issue.sections` requires far more than this fixture
    // means to exercise) — an empty section set here means the schema
    // group's ONLY possible finding is title grammar, which always runs
    // regardless of config. A real (if tiny) git repo, with a tracked file
    // under `apps/cli`, so `checkSurfaceGlobsResolve`'s `in: apps/cli` glob
    // resolves — this fixture means to name exactly one content-group
    // defect (the Surface-versus-Test-plan one), not a second, unrelated one.
    cwd = mkdtempSync(join(tmpdir(), 'vinaya-collect-task-issue-errors-'))
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify({ briefSchema: { issue: { sections: [] } } }), 'utf8')
    execFileSync('git', ['init', '-q'], { cwd })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd })
    mkdirSync(join(cwd, 'apps', 'cli'), { recursive: true })
    writeFileSync(join(cwd, 'apps', 'cli', 'dummy.ts'), '')
    execFileSync('git', ['add', '.'], { cwd })
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd })
    originalCwd = process.cwd()
    process.chdir(cwd)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(cwd, { recursive: true, force: true })
  })

  // Surface `out:` and a Test plan command line both name
  // `apps/cli/src/checks/foo.test.ts` — `apps/cli/src/checks` is excluded by
  // `out:`, so `checkObjectivesRespectBoundary` (the `issue-content` group)
  // refuses it. `Docs to keep coherent` carries the `no-doc-surface`
  // sentinel so the OTHER content check this body would otherwise also trip
  // (`checkRationaleNamesDocs`) stays quiet — this fixture means to name
  // exactly one content-group defect, not two.
  const surfaceVsTestPlanBody = [
    '## Surface',
    '',
    'in: apps/cli',
    'out: apps/cli/src/checks',
    '',
    '## Test plan',
    '',
    '```',
    'bun test apps/cli/src/checks/foo.test.ts → 0 fail',
    '```',
    '',
    '**Docs to keep coherent** — no-doc-surface.'
  ].join('\n')

  const fakeConsumerTestFinding: CheckError = {
    schema: CHECK_SCHEMA_VERSION,
    check: 'brief-shape',
    severity: 'error',
    message:
      'brief-validation consumer tests: §4 names a path under packages/aeg-core/, and apps/cli depends on @attalabs/aeg-core, but no test path under apps/cli is named in §4 — name one, or add `consumer-tests: none — <reason>`.',
    agent_recovery_prompt:
      'Refused for: `brief-validation consumer tests: §4 names a path under packages/aeg-core/, and apps/cli depends on @attalabs/aeg-core, but no test path under apps/cli is named in §4 — name one, or add `consumer-tests: none — <reason>`.` — Name a test path under apps/cli in §4, or add the `consumer-tests: none — <reason>` sentinel, then re-run `vinaya issue create --validate-only …`.'
  }

  it("a body failing title grammar, a Surface-versus-Test-plan rule, and the rendered brief's consumer-test rule is refused once with three findings", async () => {
    const deps: TaskIssueValidationDeps = {
      computeRenderedBriefErrors: async () => [fakeConsumerTestFinding],
      runIssueChecks: async () => []
    }

    const errors = await collectTaskIssueErrors(
      surfaceVsTestPlanBody,
      'not a valid title',
      [],
      'vinaya issue create --validate-only …',
      null,
      undefined,
      deps
    )

    expect(errors.length).toBe(3)
    expect(errors.map((e) => e.check).sort()).toEqual(['brief-shape', 'forge-title', 'issue-content'])
  })

  it('the same body with all three defects fixed passes in one run', async () => {
    const fixedBody = [
      '## Surface',
      '',
      'in: apps/cli',
      // No longer overlaps the Test plan's named path.
      'out: apps/cli/src/other',
      '',
      '## Test plan',
      '',
      '```',
      'bun test apps/cli/src/checks/foo.test.ts → 0 fail',
      '```',
      '',
      '**Docs to keep coherent** — no-doc-surface.'
    ].join('\n')

    const deps: TaskIssueValidationDeps = {
      computeRenderedBriefErrors: async () => [],
      runIssueChecks: async () => []
    }

    const errors = await collectTaskIssueErrors(
      fixedBody,
      'Feat: a well-formed title',
      [],
      'vinaya issue create --validate-only …',
      null,
      undefined,
      deps
    )

    expect(errors).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// O2 — every recovery prompt names its own fix, not its rule: it quotes the
// specific finding it refuses (never merely the check's static rule text)
// and states the edit that clears it.
// ---------------------------------------------------------------------------

/** True only when `finding`'s recovery prompt both quotes the finding it refuses AND states a concrete edit — never a bare restatement of the rule. */
function recoveryNamesItsFix(finding: CheckError): boolean {
  const quotesTheFinding = finding.agent_recovery_prompt.includes(finding.message)
  const isJustTheRuleRestated = finding.agent_recovery_prompt.trim() === finding.message.trim()
  const namesAnEdit = /\b(Add|Remove|Delete|Fix|Rewrite|Move|Widen|Narrow|Drop|Correct|Name)\b/.test(
    finding.agent_recovery_prompt
  )
  return quotesTheFinding && !isJustTheRuleRestated && namesAnEdit
}

describe('every brief-schema/issue-content recovery prompt names its own fix (O2)', () => {
  // A representative registry of gate messages: one fixture per builtin/
  // content-check family already exercised elsewhere in this test suite,
  // reused here rather than re-derived, so this audit tracks the real
  // registry of messages `forge-write.ts` emits.
  it('every finding from a title-grammar failure quotes the bad title and states the fix', () => {
    const errors = validateForgeWrite({
      body: 'irrelevant',
      title: 'not a valid title',
      sections: [],
      changedFiles: [],
      retryCommand: 'vinaya pr create --validate-only …'
    })
    expect(errors.length).toBeGreaterThan(0)
    for (const e of errors) expect(recoveryNamesItsFix(e)).toBe(true)
  })

  it('every finding from a missing built-in section quotes the diagnosis and states the fix', () => {
    const errors = validateForgeWrite({
      body: 'Nothing here.',
      title: null,
      sections: [{ builtin: 'tier' }, { builtin: 'testPlan' }, { builtin: 'surfaceMap' }],
      changedFiles: [],
      retryCommand: 'vinaya pr create --validate-only …'
    })
    expect(errors.length).toBe(3)
    for (const e of errors) expect(recoveryNamesItsFix(e)).toBe(true)
  })

  it('every finding from a missing rationale field quotes the field and states the fix', () => {
    const errors = validateForgeWrite({
      body: 'A task Issue body carrying none of the eight rationale fields.',
      title: null,
      sections: [{ builtin: 'issueRationale' }],
      changedFiles: [],
      retryCommand: 'vinaya issue create --validate-only …'
    })
    expect(errors.length).toBe(8)
    for (const e of errors) expect(recoveryNamesItsFix(e)).toBe(true)
  })

  it('every finding from a Surface-versus-Test-plan violation quotes the line and states the fix', () => {
    const body = [
      '## Surface',
      '',
      'in: apps/cli',
      'out: apps/cli/src/checks',
      '',
      '## Test plan',
      '',
      '```',
      'bun test apps/cli/src/checks/foo.test.ts → 0 fail',
      '```',
      '',
      '**Docs to keep coherent** — no-doc-surface.'
    ].join('\n')
    const errors = validateIssueContent({
      body,
      labels: [],
      sharedPackages: [],
      projectPaths: [],
      retryCommand: 'vinaya issue create --validate-only …',
      issueNumber: null,
      resolvesToFile: () => true,
      docOwnersContent: null,
      milestoneSiblings: null,
      subjectRef: ''
    })
    expect(errors.length).toBe(1)
    for (const e of errors) expect(recoveryNamesItsFix(e)).toBe(true)
  })

  it('a finding whose recovery prompt only restates the rule fails this same audit', () => {
    const ruleOnly: CheckError = {
      schema: CHECK_SCHEMA_VERSION,
      check: 'brief-schema',
      severity: 'error',
      message: 'brief-schema tier: no `Tier:` field found in the body header.',
      // Bare restatement of the rule — no quote of a specific finding beyond
      // the rule itself, no edit named.
      agent_recovery_prompt: 'brief-schema tier: no `Tier:` field found in the body header.'
    }
    expect(recoveryNamesItsFix(ruleOnly)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// `runIssueChecks` (O1) — returns findings instead of refusing, so
// `collectTaskIssueErrors` can fold its registry-check group into the same
// union every other group contributes to.
// ---------------------------------------------------------------------------

describe('runIssueChecks returns findings rather than refusing (O1)', () => {
  it("resolves an empty array for a subject every registered `validates: 'issue'` check passes", async () => {
    const errors = await runIssueChecks({
      body: "## Objectives\n\nO1. Something happens.\n\n## Planner's rationale\n\nsome rationale\n",
      labels: ['vinaya/tranche:demo-v1'],
      title: 'Feat: a well-formed title',
      issueNumber: null,
      currentMilestoneTitle: null,
      resolvedMilestoneTitle: null,
      retryCommand: 'vinaya issue create'
    })
    expect(errors).toEqual([])
  })
})
