import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHECK_SCHEMA_VERSION, type CheckError } from '../../src/checks/contract'
import { sha256Hex } from '../../src/lib/effects'
import {
  collectTaskIssueErrors,
  reconcileGhComment,
  runIssueChecks,
  type TaskIssueValidationDeps,
  validateForgeWrite,
  validateIssueContent
} from '../../src/lib/forge-write'

const CLI_ROOT = join(import.meta.dir, '..', '..')
const REPO_ROOT = join(CLI_ROOT, '..', '..')
const INDEX = join(CLI_ROOT, 'src', 'index.ts')
const FAKE_PRINCIPAL_OWED_CHECK = join(CLI_ROOT, 'tests', 'fixtures', 'forge', 'fake-principal-owed-check.cjs')

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
// Round-3 review finding (MEDIUM) — a `gh` fetch failure inside the O5
// sibling-overlap lookup used to call `refuse()` directly, discarding every
// finding `collectTaskIssueErrors` had already pushed into its union (the
// schema group's own findings, computed just before this lookup runs) —
// recreating the exact stop-at-first-group cost O1 exists to remove, one
// layer down inside the content group. The fetch failure must fold into the
// SAME union instead.
// ---------------------------------------------------------------------------

describe('a gh fetch failure inside the content group folds into the union instead of discarding prior findings', () => {
  let cwd: string
  let originalCwd: string
  let originalPath: string | undefined

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'vinaya-sibling-fetch-failure-'))
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify({ briefSchema: { issue: { sections: [] } } }), 'utf8')

    // A fake `gh` that fails `issue list` (the O5 sibling-overlap query) but
    // answers nothing else — the point is this ONE lookup failing, not a
    // general forge outage.
    const gh = join(cwd, 'gh')
    writeFileSync(
      gh,
      `#!/bin/sh
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  echo "gh: network unreachable" >&2
  exit 1
fi
exit 1
`
    )
    execFileSync('chmod', ['+x', gh])

    originalPath = process.env.PATH
    process.env.PATH = `${cwd}:${process.env.PATH ?? ''}`
    originalCwd = process.cwd()
    process.chdir(cwd)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    process.env.PATH = originalPath
    rmSync(cwd, { recursive: true, force: true })
  })

  it("keeps the schema group's own findings when the sibling-overlap fetch fails, refusing once with both", async () => {
    const deps: TaskIssueValidationDeps = {
      computeRenderedBriefErrors: async () => [],
      runIssueChecks: async () => []
    }

    const errors = await collectTaskIssueErrors(
      // `no-doc-surface` sentinel keeps `checkRationaleNamesDocs` quiet — this
      // fixture means to name exactly one content-group defect via the
      // fetch failure itself, not a second, unrelated one.
      '**Docs to keep coherent** — no-doc-surface.',
      'not a valid title', // trips the schema group's title-grammar check
      [],
      'vinaya issue create --validate-only …',
      null,
      // `--milestone` given explicitly short-circuits milestone RESOLUTION
      // (no `gh` call needed to resolve one) straight to the sibling-overlap
      // fetch, which the fake `gh` above fails.
      { kind: 'create', ghArgs: ['--milestone', 'v1'] },
      deps
    )

    expect(errors.length).toBe(2)
    const checks = errors.map((e) => e.check).sort()
    expect(checks).toEqual(['forge-fetch', 'forge-title'])
  })
})

// ---------------------------------------------------------------------------
// Round-3 review finding (MINOR) — the O2 audit below exercises
// `validateForgeWrite`'s and `validateIssueContent`'s real output, but the
// rendered-brief-shape group's real (non-injected) output was only ever
// proven compliant by a hand-built fixture. This drives the REAL render
// path (`collectTaskIssueErrors`'s default deps, no injection) against a
// body missing `## Stop conditions` — a genuine render gap — so the
// `brief-render` finding this produces carries `nameTheFix`'s ACTUAL
// wrapping, not a stand-in.
// ---------------------------------------------------------------------------

describe('the real (non-injected) rendered-brief-shape group also names its own fix', () => {
  let cwd: string
  let originalCwd: string
  let originalAegRepo: string | undefined

  const RATIONALE = [
    "## Task Issue — Planner's rationale",
    '',
    '**Boundary** — In: nothing real. Out: nothing.',
    '',
    '**Sizing** — n/a, test fixture.',
    '',
    '**Project(s) + blast radius** — `Project: cli`. No shared-primitive fan-out.',
    '',
    '**Dependency rationale** — `Depends-on: —`; `Conflicts-with: —`.',
    '',
    '**Traps to avoid** — n/a.',
    '',
    '**Suggested agent-class** — fast — test fixture.',
    '',
    '**Stop-and-escalate** — n/a.',
    '',
    '**Docs to keep coherent** — no-doc-surface.'
  ].join('\n')

  // Deliberately missing `## Stop conditions` — a section the brief renderer
  // requires past its own cutover — so rendering this body genuinely fails
  // (`rendered.ok === false`), producing a real `brief-render` finding.
  const bodyMissingStopConditions = [
    '**Project:** cli',
    '',
    '## Objectives',
    '',
    'O1. The fixture exercises the real render path.',
    '',
    '## Surface',
    '',
    'in: aeg-root',
    'out: —',
    '',
    '## Parts',
    '',
    'Part 1 (O1) — the only part, citing the only objective.',
    '',
    '## Test plan',
    '',
    'Test Plan: unit-tests-only',
    '',
    RATIONALE
  ].join('\n')

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'vinaya-real-render-'))
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify({ briefSchema: { issue: { sections: [] } } }), 'utf8')
    execFileSync('git', ['init', '-q'], { cwd })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd })
    mkdirSync(join(cwd, 'aeg-root', 'templates'), { recursive: true })
    cpSync(
      join(REPO_ROOT, 'aeg-root', 'templates', 'brief-template.md'),
      join(cwd, 'aeg-root', 'templates', 'brief-template.md')
    )
    execFileSync('git', ['add', '.'], { cwd })
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd })

    originalAegRepo = process.env.AEG_REPO
    process.env.AEG_REPO = 'test-owner/test-repo'
    originalCwd = process.cwd()
    process.chdir(cwd)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    process.env.AEG_REPO = originalAegRepo
    rmSync(cwd, { recursive: true, force: true })
  })

  it('a real render-gap finding quotes the gap and states the fix, not just the rule', async () => {
    // No `deps` override — `computeRenderedBriefErrors` runs the REAL
    // `validateRenderedBriefForIssue`, exercising its own `nameTheFix` calls.
    const errors = await collectTaskIssueErrors(
      bodyMissingStopConditions,
      'Feat: a well-formed title',
      [],
      'vinaya issue create --validate-only …',
      null
    )

    const renderFindings = errors.filter((e) => e.check === 'brief-render' || e.check === 'brief-shape')
    expect(renderFindings.length).toBeGreaterThan(0)
    for (const e of renderFindings) expect(recoveryNamesItsFix(e)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// O2 (Issue #588) — an unmerged `Depends-on` or an open `Conflicts-with` PR
// is a fact about the forge right now, not a defect in the Issue being
// edited: the write gate's rendered-brief validation folds it in as
// `severity: 'warning'` and does not refuse the edit for it alone.
// `task run`/`dispatchTask` (`dispatch-task.test.ts`) is untouched by this —
// it never reads the new classification field and keeps refusing on the
// same render gap exactly as before.
// ---------------------------------------------------------------------------

describe('an unmerged Depends-on folds into the write gate as informational, never a refusal (O2, Issue #588)', () => {
  let tmpDir: string
  let localDir: string
  let originalCwd: string
  let originalAegRepo: string | undefined
  let originalPath: string | undefined

  const RATIONALE_WITH_OPEN_DEPENDENCY = [
    "## Task Issue — Planner's rationale",
    '',
    // issue-657, O3 — the render now refuses when the Surface resolves to a
    // tracked file but the Boundary names none of them; this fixture's own
    // `## Surface` `in: aeg-root` resolves to the fixture's own committed
    // `aeg-root/templates/brief-template.md`, so the Boundary must name a
    // real file to keep this fixture isolating the ONE dependency-not-merged
    // blocker, not a premise-pins one.
    "**Boundary** — In: `aeg-root/templates/brief-template.md`, the fixture's own committed doctrine file. Out: nothing.",
    '',
    '**Sizing** — n/a, test fixture.',
    '',
    '**Project(s) + blast radius** — `Project: cli`. No shared-primitive fan-out.',
    '',
    '**Dependency rationale** — `Depends-on: #999`; `Conflicts-with: —`.',
    '',
    '**Traps to avoid** — n/a.',
    '',
    '**Suggested agent-class** — fast — test fixture.',
    '',
    '**Stop-and-escalate** — n/a.',
    '',
    '**Docs to keep coherent** — no-doc-surface.'
  ].join('\n')

  // A COMPLETE body (every section `renderBrief` requires, unlike
  // `bodyMissingStopConditions` above) — the fixture means to isolate the ONE
  // dependency-not-merged blocker as the render's only gap, not conflate it
  // with a genuine shape defect.
  const bodyWithOpenDependency = [
    '**Project:** cli',
    '',
    '## Objectives',
    '',
    'O1. The fixture exercises the real render path against a real, open (not-merged) dependency edge.',
    '',
    '## Documentation',
    '',
    'None — no externally-normative source governs this task.',
    '',
    '## Surface',
    '',
    'in: aeg-root',
    'out: —',
    '',
    '## Parts',
    '',
    'Part 1 (O1) — the only part, citing the only objective.',
    '',
    '## Test plan',
    '',
    'Test Plan: unit-tests-only',
    '',
    '## Stop conditions',
    '',
    '- n/a.',
    '',
    RATIONALE_WITH_OPEN_DEPENDENCY
  ].join('\n')

  beforeEach(() => {
    // A clone, not a bare `git init` — `assembleAndRenderBriefForIssue` first
    // asserts HEAD equals the remote default branch tip
    // (`checkStaleAgainstRemote`), which needs a resolvable `origin`; the
    // clone's local file-path remote resolves it with no live network call,
    // same fixture shape `brief-assembly.test.ts`'s own
    // `assembleAndRenderBriefForIssue` describe block already uses.
    tmpDir = mkdtempSync(join(tmpdir(), 'vinaya-open-dependency-'))
    const remoteDir = join(tmpDir, 'remote')
    localDir = join(tmpDir, 'local')
    mkdirSync(remoteDir, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: remoteDir })
    execFileSync('git', ['config', 'user.email', 'a@example.com'], { cwd: remoteDir })
    execFileSync('git', ['config', 'user.name', 'A'], { cwd: remoteDir })
    mkdirSync(join(remoteDir, 'aeg-root', 'templates'), { recursive: true })
    cpSync(
      join(REPO_ROOT, 'aeg-root', 'templates', 'brief-template.md'),
      join(remoteDir, 'aeg-root', 'templates', 'brief-template.md')
    )
    writeFileSync(
      join(remoteDir, 'vinaya.config.json'),
      JSON.stringify({ briefSchema: { issue: { sections: [] } } }),
      'utf8'
    )
    execFileSync('git', ['add', '.'], { cwd: remoteDir })
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: remoteDir })
    execFileSync('git', ['clone', '-q', remoteDir, localDir], { cwd: tmpDir })
    execFileSync('git', ['config', 'user.email', 'a@example.com'], { cwd: localDir })
    execFileSync('git', ['config', 'user.name', 'A'], { cwd: localDir })

    // A fake `gh` answering Issue #999's own state — open, closed by no
    // merged pull request — the live "not merged yet" fact this fixture
    // means to exercise for real, never a stand-in string.
    const gh = join(localDir, 'gh')
    writeFileSync(
      gh,
      `#!/bin/sh
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  echo '{"state":"OPEN","stateReason":null,"closedByPullRequestsReferences":[]}'
  exit 0
fi
exit 1
`
    )
    execFileSync('chmod', ['+x', gh])

    originalAegRepo = process.env.AEG_REPO
    process.env.AEG_REPO = 'test-owner/test-repo'
    originalPath = process.env.PATH
    process.env.PATH = `${localDir}:${process.env.PATH ?? ''}`
    originalCwd = process.cwd()
    process.chdir(localDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    process.env.AEG_REPO = originalAegRepo
    process.env.PATH = originalPath
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('is reported with `severity: "warning"`, naming the dependency, and blocks nothing', async () => {
    const errors = await collectTaskIssueErrors(
      bodyWithOpenDependency,
      'Feat: a well-formed title',
      [],
      'vinaya issue edit …',
      null
    )

    const dependencyFinding = errors.find((e) => e.message.includes('depends on') && e.message.includes('#999'))
    expect(dependencyFinding).toBeDefined()
    expect(dependencyFinding?.severity).toBe('warning')

    // The fixture names exactly one live fact (the open dependency) — every
    // finding this run produces must be that same warning, never a refusal.
    const blocking = errors.filter((e) => e.severity !== 'warning')
    expect(blocking).toEqual([])
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

// ---------------------------------------------------------------------------
// `reconcileGhComment` (security review, round 2, HIGH) — the `gh`-backed
// `EffectReconciler` `apps/cli/src/lib/effects.ts`'s `EffectExecutor` calls
// on recovery. A fake `gh` answers `{issue,pr} view --json comments` with a
// fixed comment list; the trust-anchor `vinaya.config.json` fetch is left
// unanswered (exits 1), so `loadTrustAnchorConfig` falls back to the real
// `PRINCIPAL_ALLOWLIST` default (`['daniboomerang']`) — the same fallback
// every other principal-gated path in this file already exercises.
// ---------------------------------------------------------------------------

describe('reconcileGhComment (security review, round 2, HIGH: principal-authored match only)', () => {
  let cwd: string
  let originalPath: string | undefined
  let commentsFile: string

  function writeComments(comments: { body: string; url?: string; author?: { login: string } }[]): void {
    writeFileSync(commentsFile, JSON.stringify({ comments }), 'utf8')
  }

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'vinaya-reconcile-gh-comment-'))
    commentsFile = join(cwd, 'comments.json')
    writeComments([])

    const gh = join(cwd, 'gh')
    writeFileSync(
      gh,
      `#!/bin/sh
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "comments" ]; then
  cat "${commentsFile}"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "comments" ]; then
  cat "${commentsFile}"
  exit 0
fi
echo "gh: not found" >&2
exit 1
`
    )
    execFileSync('chmod', ['+x', gh])

    originalPath = process.env.PATH
    process.env.PATH = `${cwd}:${process.env.PATH ?? ''}`
  })

  afterEach(() => {
    process.env.PATH = originalPath
    rmSync(cwd, { recursive: true, force: true })
  })

  const identity = { operation: 'pr-comment', target: 'pr:1', inputVersion: 1, payloadDigest: sha256Hex('the body') }

  it('confirms a digest match authored by an allowlisted principal', () => {
    writeComments([{ body: 'the body', url: 'https://example.com/c/1', author: { login: 'daniboomerang' } }])
    const result = reconcileGhComment('pr', '1')(identity)
    expect(result).toEqual({ outcome: 'confirmed', url: 'https://example.com/c/1' })
  })

  it('does NOT confirm a byte-identical body authored by a non-principal — a spoofed comment is not evidence the real post landed', () => {
    writeComments([{ body: 'the body', url: 'https://example.com/c/1', author: { login: 'some-other-commenter' } }])
    const result = reconcileGhComment('pr', '1')(identity)
    expect(result).toEqual({ outcome: 'absent' })
  })

  it('does NOT confirm a digest match with no author at all', () => {
    writeComments([{ body: 'the body', url: 'https://example.com/c/1' }])
    const result = reconcileGhComment('pr', '1')(identity)
    expect(result).toEqual({ outcome: 'absent' })
  })

  it('reports absent when a successful read carries no matching principal-authored body', () => {
    writeComments([{ body: 'a different body', author: { login: 'daniboomerang' } }])
    const result = reconcileGhComment('pr', '1')(identity)
    expect(result).toEqual({ outcome: 'absent' })
  })

  it('reports ambiguous, never absent, when gh itself fails', () => {
    const gh = join(cwd, 'gh')
    writeFileSync(gh, `#!/bin/sh\necho "gh: network unreachable" >&2\nexit 1\n`)
    execFileSync('chmod', ['+x', gh])
    const result = reconcileGhComment('pr', '1')(identity)
    expect(result.outcome).toBe('ambiguous')
  })

  it('reports ambiguous, never absent, when the JSON does not parse', () => {
    writeFileSync(commentsFile, 'not json', 'utf8')
    const result = reconcileGhComment('issue', '552')(identity)
    expect(result.outcome).toBe('ambiguous')
  })
})

// ---------------------------------------------------------------------------
// task driver-lifecycle-v1/5 — `runBodyChecks` excludes a `principalOwed`
// check's failure from the body-write refusal decision ONLY when every error
// it reported is `pending: true`, matching `isRunFailed`'s
// (`commands/check.ts`) own rule exactly. `refuse()` calls `process.exit(1)`
// directly (see the comment above the O1 describe block in
// `tests/forge-write.test.ts`), so the refusal path is exercised as a real
// subprocess — `vinaya pr edit <n> --validate-only` — never in-process. A
// fake `gh` answers the one `gh pr view` call `pr edit` makes; a
// config-registered fixture check (`fake-principal-owed-check.cjs`) stands in
// for `test-plan`'s real pending/structural distinction, driven by a marker
// in the body so the three outcomes (pending-only, structural, mixed) are
// each independently reproducible without a live PR.
// ---------------------------------------------------------------------------

describe("runBodyChecks — a principalOwed check's pending-only failure never refuses (O1/O2)", () => {
  let cwd: string
  let bodyPath: string

  function bodyWithCase(marker: string): string {
    return ['**Project:** cli', '', '## Fixture case', '', marker, ''].join('\n')
  }

  function writeVinayaConfig(): void {
    writeFileSync(
      join(cwd, 'vinaya.config.json'),
      JSON.stringify({
        briefSchema: { pr: { sections: [] } },
        checks: {
          'fixture/principal-owed': {
            run: 'node',
            args: [FAKE_PRINCIPAL_OWED_CHECK],
            scope: 'full',
            validates: 'body',
            principalOwed: true,
            env: { PR_BODY: { optional: true } }
          }
        }
      }),
      'utf8'
    )
  }

  function writeFakeGh(): void {
    const gh = join(cwd, 'gh')
    writeFileSync(
      gh,
      `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  echo '{"headRefName":"fix/fixture","files":[]}'
  exit 0
fi
exit 1
`
    )
    execFileSync('chmod', ['+x', gh])
  }

  function runPrEdit(): { status: number; stderr: string } {
    try {
      execFileSync('bun', [INDEX, 'pr', 'edit', 'one', '--validate-only', '--body-file', bodyPath], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${cwd}:${process.env.PATH ?? ''}` },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      return { status: 0, stderr: '' }
    } catch (e) {
      const err = e as { status?: number; stderr?: string }
      return { status: err.status ?? 1, stderr: String(err.stderr ?? '') }
    }
  }

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'vinaya-body-checks-principal-owed-'))
    writeVinayaConfig()
    writeFakeGh()
    bodyPath = join(cwd, 'pr-body.md')
  })

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('does not refuse when the only failure is a principalOwed check reporting all-pending errors (O1)', () => {
    writeFileSync(bodyPath, bodyWithCase('CASE_PENDING_ONLY'), 'utf8')
    const r = runPrEdit()
    expect(r.status).toBe(0)
  })

  it('still refuses a structural failure on the same principalOwed check — no pending errors at all (O2)', () => {
    writeFileSync(bodyPath, bodyWithCase('CASE_STRUCTURAL'), 'utf8')
    const r = runPrEdit()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('"check":"fixture/principal-owed"')
  })

  it('still refuses when the same principalOwed check reports a mix of pending and non-pending errors (O2)', () => {
    writeFileSync(bodyPath, bodyWithCase('CASE_MIXED'), 'utf8')
    const r = runPrEdit()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('"check":"fixture/principal-owed"')
  })
})
