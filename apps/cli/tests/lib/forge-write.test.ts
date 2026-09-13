import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHECK_SCHEMA_VERSION, type CheckError } from '../../src/checks/contract'
import { collectTaskIssueErrors, runIssueChecks, type TaskIssueValidationDeps } from '../../src/lib/forge-write'

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
