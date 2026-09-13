import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BriefSection } from '../src/lib/config'
import {
  ForgeArgError,
  extractLabels,
  extractTitle,
  locateBody,
  readSharedPackages,
  resolveShippableArgs,
  runBodyChecks,
  runIssueChecks,
  validateForgeWrite,
  validateIssueContent
} from '../src/lib/forge-write'

const FORGE_FIXTURES = join(import.meta.dir, 'fixtures', 'forge')
const validPr = readFileSync(join(FORGE_FIXTURES, 'pr-valid.md'), 'utf8')
const noTierPr = readFileSync(join(FORGE_FIXTURES, 'pr-no-tier.md'), 'utf8')
const noRationaleIssue = readFileSync(join(FORGE_FIXTURES, 'issue-no-rationale.md'), 'utf8')
const validIssue = readFileSync(join(FORGE_FIXTURES, 'issue-valid.md'), 'utf8')
const blastRadiusViolationIssue = readFileSync(join(FORGE_FIXTURES, 'issue-blast-radius-violation.md'), 'utf8')
const briefContentIssue = readFileSync(join(FORGE_FIXTURES, 'issue-brief-content.md'), 'utf8')
const noDocPathIssue = readFileSync(join(FORGE_FIXTURES, 'issue-no-doc-path.md'), 'utf8')

const PR_SECTIONS: BriefSection[] = [
  { builtin: 'tier' },
  { builtin: 'testPlan' },
  { builtin: 'testPlanExclusivity' },
  { builtin: 'principalPlaceholder' },
  { builtin: 'surfaceMap' },
  { builtin: 'docUpdateList' },
  { builtin: 'worktreeStep0' },
  { builtin: 'stopConditions' },
  { builtin: 'autonomyClause' },
  { builtin: 'project' },
  { builtin: 'for' },
  { builtin: 'closesN' },
  { builtin: 'premiseCoverage' }
]

const base = {
  title: null,
  changedFiles: [] as string[],
  retryCommand: 'vinaya pr create --validate-only …'
}

describe('validateForgeWrite — brief-schema gate', () => {
  it('passes a fully-formed PR body against the full built-in section set', () => {
    const errors = validateForgeWrite({ ...base, body: validPr, sections: PR_SECTIONS })
    expect(errors).toEqual([])
  })

  it('refuses a PR body missing only Tier with exactly one finding', () => {
    const errors = validateForgeWrite({ ...base, body: noTierPr, sections: PR_SECTIONS })
    expect(errors.length).toBe(1)
    const [e] = errors
    expect(e?.check).toBe('brief-schema')
    expect(e?.schema).toBe(1)
    // The recovery prompt names the corrective command, and is NOT the diagnosis restated.
    expect(e?.agent_recovery_prompt).toContain('vinaya pr create')
    expect(e?.agent_recovery_prompt).not.toBe(e?.message)
  })

  it('emits one finding per missing rationale field for a task Issue', () => {
    const errors = validateForgeWrite({
      ...base,
      body: noRationaleIssue,
      sections: [{ builtin: 'issueRationale' }],
      retryCommand: 'vinaya issue create --validate-only …'
    })
    expect(errors.length).toBe(8)
    for (const e of errors) {
      expect(e.check).toBe('brief-schema')
      expect(e.agent_recovery_prompt).toContain('vinaya issue create')
    }
  })

  it('passes a task Issue carrying the full eight-field rationale', () => {
    const errors = validateForgeWrite({
      ...base,
      body: validIssue,
      sections: [{ builtin: 'issueRationale' }]
    })
    expect(errors).toEqual([])
  })

  it('refuses a body lacking an adopter-defined custom heading section', () => {
    const errors = validateForgeWrite({
      ...base,
      body: validPr,
      sections: [{ heading: 'Rollback Plan' }]
    })
    expect(errors.length).toBe(1)
    expect(errors[0]?.message).toContain('Rollback Plan')
    expect(errors[0]?.agent_recovery_prompt).toContain('Rollback Plan')
  })

  it('passes a body that carries the custom heading', () => {
    const withHeading = `${validPr}\n\n## Rollback Plan\n\nRevert the branch.\n`
    const errors = validateForgeWrite({ ...base, body: withHeading, sections: [{ heading: 'Rollback Plan' }] })
    expect(errors).toEqual([])
  })

  it('validates title grammar when a title is present', () => {
    const good = validateForgeWrite({ ...base, body: validPr, sections: [], title: 'Feat: valid title' })
    expect(good).toEqual([])
    const bad = validateForgeWrite({ ...base, body: validPr, sections: [], title: 'not a valid title' })
    expect(bad.length).toBe(1)
    expect(bad[0]?.check).toBe('forge-title')
  })

  it('premiseCoverage passes trivially when no files changed, fails when a surface is unpinned', () => {
    const empty = validateForgeWrite({ ...base, body: validPr, sections: [{ builtin: 'premiseCoverage' }] })
    expect(empty).toEqual([])
    const unpinned = validateForgeWrite({
      ...base,
      body: validPr,
      sections: [{ builtin: 'premiseCoverage' }],
      changedFiles: ['src/thing.ts']
    })
    expect(unpinned.length).toBe(1)
  })
})

describe('validateForgeWrite — milestoneShape builtin', () => {
  it('passes a well-formed milestone body', () => {
    const body = ['Ship the milestone model.', '', 'Release: 1.0.0'].join('\n')
    const errors = validateForgeWrite({ ...base, body, sections: [{ builtin: 'milestoneShape' }] })
    expect(errors).toEqual([])
  })

  it('refuses a milestone body with no goal', () => {
    const body = 'Release: 1.0.0'
    const errors = validateForgeWrite({ ...base, body, sections: [{ builtin: 'milestoneShape' }] })
    expect(errors.length).toBe(1)
    expect(errors[0]?.message).toContain('goal')
  })

  it('refuses a milestone body with a malformed Release:', () => {
    const body = 'The goal.\n\nRelease: soon'
    const errors = validateForgeWrite({ ...base, body, sections: [{ builtin: 'milestoneShape' }] })
    expect(errors.length).toBe(1)
    expect(errors[0]?.message).toContain('Release')
  })
})

// The Issue-only content checks `packages/aeg-core/bin/open-issue.ts` gates
// task Issues on, plus `checkSurfaceExcludesBoundDoc` (task-run-v1 9) —
// wired into `apps/cli`'s real validation path. `validateIssueContent` is
// pure over its inputs; `sharedPackages`/`projectPaths`/`docOwnersContent`
// are supplied directly here rather than resolved from disk (that
// resolution is exercised end-to-end by `tests/commands/issue.test.ts`'s
// "content gate" suite instead).
describe('validateIssueContent — the content checks', () => {
  const cmd = 'vinaya issue create --validate-only …'

  it('refuses a rationale naming a shared domain no declared project owns', () => {
    const errors = validateIssueContent({
      body: blastRadiusViolationIssue,
      labels: ['vinaya/tranche:demo'],
      sharedPackages: ['packages/ui'],
      projectPaths: [{ name: 'vinaya', path: '.' }],
      retryCommand: cmd,
      issueNumber: null,
      resolvesToFile: () => true,
      docOwnersContent: null,
      milestoneSiblings: null,
      subjectRef: ''
    })
    expect(errors.length).toBe(1)
    expect(errors[0]?.check).toBe('issue-content')
    expect(errors[0]?.message).toContain('blast radius')
    expect(errors[0]?.agent_recovery_prompt).toContain('vinaya issue create')
  })

  it('passes the same body once a `blast-radius-ack:` line acknowledges the domain', () => {
    const withAck = `${blastRadiusViolationIssue}\n\n**blast-radius-ack:** single lens is enough here.\n`
    const errors = validateIssueContent({
      body: withAck,
      labels: ['vinaya/tranche:demo'],
      sharedPackages: ['packages/ui'],
      projectPaths: [{ name: 'vinaya', path: '.' }],
      retryCommand: cmd,
      issueNumber: null,
      resolvesToFile: () => true,
      docOwnersContent: null,
      milestoneSiblings: null,
      subjectRef: ''
    })
    expect(errors).toEqual([])
  })

  it('refuses an Issue body carrying a brief-shaped section', () => {
    const errors = validateIssueContent({
      body: briefContentIssue,
      labels: ['vinaya/tranche:demo'],
      sharedPackages: [],
      projectPaths: [],
      retryCommand: cmd,
      issueNumber: null,
      resolvesToFile: () => true,
      docOwnersContent: null,
      milestoneSiblings: null,
      subjectRef: ''
    })
    expect(errors.length).toBe(1)
    expect(errors[0]?.check).toBe('issue-content')
    expect(errors[0]?.message).toContain('Technical surface map')
  })

  it('refuses a rationale naming no concrete doc/skill path', () => {
    const errors = validateIssueContent({
      body: noDocPathIssue,
      labels: ['vinaya/tranche:demo'],
      sharedPackages: [],
      projectPaths: [],
      retryCommand: cmd,
      issueNumber: null,
      resolvesToFile: () => true,
      docOwnersContent: null,
      milestoneSiblings: null,
      subjectRef: ''
    })
    expect(errors.length).toBe(1)
    expect(errors[0]?.check).toBe('issue-content')
    expect(errors[0]?.message).toContain('docs read')
  })

  it('passes a fully-formed task Issue against all three checks', () => {
    const errors = validateIssueContent({
      body: validIssue,
      labels: ['vinaya/tranche:demo'],
      sharedPackages: [],
      projectPaths: [],
      retryCommand: cmd,
      issueNumber: null,
      resolvesToFile: () => true,
      docOwnersContent: null,
      milestoneSiblings: null,
      subjectRef: ''
    })
    expect(errors).toEqual([])
  })

  it('refuses a Surface `out:` excluding a doc-owners-bound document its `in:` covers', () => {
    const body =
      '## Surface\n\nin: apps/cli/src/lib\nout: apps/cli/specs\n\n**Docs to keep coherent** — no-doc-surface.\n'
    const errors = validateIssueContent({
      body,
      labels: ['vinaya/tranche:demo'],
      sharedPackages: [],
      projectPaths: [],
      retryCommand: cmd,
      issueNumber: null,
      resolvesToFile: () => true,
      docOwnersContent: 'apps/cli/src/lib/**  apps/cli/specs/surface.md\n',
      milestoneSiblings: null,
      subjectRef: ''
    })
    expect(errors.length).toBe(1)
    expect(errors[0]?.check).toBe('issue-content')
    expect(errors[0]?.message).toContain('apps/cli/specs/surface.md')
  })

  it('passes the same Surface once the bound document is moved inside `in:`', () => {
    const body =
      '## Surface\n\nin: apps/cli/src/lib, apps/cli/specs\nout: —\n\n**Docs to keep coherent** — no-doc-surface.\n'
    const errors = validateIssueContent({
      body,
      labels: ['vinaya/tranche:demo'],
      sharedPackages: [],
      projectPaths: [],
      retryCommand: cmd,
      issueNumber: null,
      resolvesToFile: () => true,
      docOwnersContent: 'apps/cli/src/lib/**  apps/cli/specs/surface.md\n',
      milestoneSiblings: null,
      subjectRef: ''
    })
    expect(errors).toEqual([])
  })
})

// Regression for the code-review BLOCKER on PR #159: `readSharedPackages`'s
// `blastRadius.extraDomains` read must be scoped to the given repo root
// ONLY — never the cwd-walking, ancestor-resolving `loadConfig()`, which
// would fold a DIFFERENT repo's (or the adopter's machine-wide) config into
// this repo's blast-radius check. Same reason `doctor.ts`'s own
// `readConfig(repoRoot)` avoids it.
describe('readSharedPackages — config resolution is repo-root-scoped', () => {
  it("ignores an ANCESTOR directory's vinaya.config.json — never walks up", () => {
    const outer = mkdtempSync(join(tmpdir(), 'vinaya-outer-'))
    try {
      writeFileSync(
        join(outer, 'vinaya.config.json'),
        JSON.stringify({ blastRadius: { extraDomains: ['outer-only-domain'] } }),
        'utf8'
      )
      const inner = join(outer, 'repo')
      execFileSync('git', ['init', '--quiet', inner])
      // No vinaya.config.json inside `inner` — only the ancestor `outer` has one.
      const domains = readSharedPackages(inner)
      expect(domains).not.toContain('outer-only-domain')
    } finally {
      rmSync(outer, { recursive: true, force: true })
    }
  })

  it("still reads the repo-local vinaya.config.json's blastRadius.extraDomains", () => {
    const root = mkdtempSync(join(tmpdir(), 'vinaya-local-'))
    try {
      writeFileSync(
        join(root, 'vinaya.config.json'),
        JSON.stringify({ blastRadius: { extraDomains: ['migrations'] } }),
        'utf8'
      )
      const domains = readSharedPackages(root)
      expect(domains).toContain('migrations')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('same-bytes body plumbing', () => {
  it('reads an inline --body value without touching disk', () => {
    const r = locateBody(['--title', 't', '--body', 'hello'])
    expect(r?.body).toBe('hello')
    expect(r?.source.kind).toBe('inline')
  })

  it('reads a --body-file path once and records the slot', () => {
    const path = join(FORGE_FIXTURES, 'pr-valid.md')
    const r = locateBody(['--body-file', path])
    expect(r?.body).toBe(validPr)
    expect(r?.source).toEqual({ kind: 'file', argIndex: 1, inlineForm: false })
  })

  it('throws ForgeArgError on --body-file with no path', () => {
    expect(() => locateBody(['--body-file'])).toThrow(ForgeArgError)
  })

  it('returns null when no body flag is present', () => {
    expect(locateBody(['--title', 't'])).toBeNull()
  })

  it('materializes the buffered body and rewrites the file slot to the same bytes', () => {
    const path = join(FORGE_FIXTURES, 'pr-valid.md')
    const args = ['--body-file', path]
    const bodyResult = locateBody(args)
    const { finalArgs, cleanup } = resolveShippableArgs(args, bodyResult)
    try {
      const rewritten = finalArgs[1] as string
      expect(rewritten).not.toBe(path)
      expect(readFileSync(rewritten, 'utf8')).toBe(validPr)
    } finally {
      cleanup()
    }
  })

  it('leaves inline-body args untouched (no temp file)', () => {
    const args = ['--body', 'hello']
    const bodyResult = locateBody(args)
    const { finalArgs } = resolveShippableArgs(args, bodyResult)
    expect(finalArgs).toEqual(args)
  })
})

describe('arg extraction', () => {
  it('extracts a title from both flag forms', () => {
    expect(extractTitle(['--title', 'x'])).toBe('x')
    expect(extractTitle(['--title=y'])).toBe('y')
    expect(extractTitle(['--body', 'b'])).toBeNull()
  })

  it('collects comma-separated and repeated labels', () => {
    expect(extractLabels(['--label', 'a,b', '--label', 'c'])).toEqual(['a', 'b', 'c'])
    expect(extractLabels(['--label=vinaya/tranche:demo'])).toEqual(['vinaya/tranche:demo'])
  })
})

// The authoring-time gate must apply the SAME branch grammar the CI-time
// gate (`checks/bin/check-brief-shape.ts`) applies. Grading every branch as
// a task branch refuses a standalone `fix/*` PR for a `Closes #N` its branch
// cannot carry, while CI passes the identical body — the divergence
// `aeg-root/enforcement.md` rules out.
describe('validateForgeWrite — branch grammar', () => {
  // A body carrying ≥2 brief-shape markers, so it is graded as a brief and the
  // non-brief-shaped bypass below cannot be what makes these cases pass.
  const briefShapedNoCloses = [
    '**For:** Claude',
    '**Project:** demo',
    '**Tier:** 0',
    '',
    '## Technical surface map',
    '- a.ts',
    '',
    '## Documentation-update list',
    '- None',
    '',
    '## Stop conditions',
    'STOP if x.',
    '',
    '## Test plan',
    'Test Plan: unit-tests-only',
    '',
    '> **Autonomy:** Do not stop to ask clarifying questions. Choose the most reasonable option and continue.',
    '',
    '```',
    'git worktree add .worktrees/x -b x origin/main',
    '```'
  ].join('\n')

  const closesOnly: BriefSection[] = [{ builtin: 'closesN' }]

  it('requires Closes #N on a task branch', () => {
    const errors = validateForgeWrite({
      ...base,
      body: briefShapedNoCloses,
      sections: closesOnly,
      branch: 'task/some-tranche/2'
    })
    expect(errors.length).toBe(1)
    expect(errors[0]?.message).toContain('Closes #')
  })

  it('does NOT require Closes #N on a non-task branch — the regression this fixes', () => {
    const errors = validateForgeWrite({
      ...base,
      body: briefShapedNoCloses,
      sections: closesOnly,
      branch: 'chore/vinaya-upgrade-0.4.5'
    })
    expect(errors).toEqual([])
  })

  it('stays fail-closed when the branch is unresolvable (empty or omitted)', () => {
    // Outside a repo — behaviour must be byte-identical to pre-change, so an
    // unknown branch never silently relaxes a gate.
    const empty = validateForgeWrite({ ...base, body: briefShapedNoCloses, sections: closesOnly, branch: '' })
    const omitted = validateForgeWrite({ ...base, body: briefShapedNoCloses, sections: closesOnly })
    expect(empty.length).toBe(1)
    expect(omitted.length).toBe(1)
  })

  it("treats the literal 'HEAD' as unresolvable, not as a non-task branch", () => {
    // `git rev-parse --abbrev-ref HEAD` prints the literal string `HEAD`,
    // exit 0, when HEAD is detached. Read as an ordinary non-task branch it
    // takes the relaxed path and skips EVERY section — the fail-open this
    // grammar exists to prevent. `pr create` resolves so the sentinel never
    // arrives; this pins the runner's own half, so a future call site that
    // reintroduces it cannot silently relax the gate.
    //
    // Lossless by construction: git refuses to create a branch named `HEAD`
    // (`git check-ref-format --branch HEAD` fails), so mapping it to
    // unresolvable can never swallow a real branch.
    const asHead = validateForgeWrite({
      ...base,
      body: briefShapedNoCloses,
      sections: closesOnly,
      branch: 'HEAD'
    })
    expect(asHead.length).toBe(1)

    // And the total bypass must not be reachable via the sentinel either.
    const bypassAttempt = validateForgeWrite({
      ...base,
      body: '## Summary\nBump a dependency.',
      sections: PR_SECTIONS,
      branch: 'HEAD'
    })
    expect(bypassAttempt.length).toBeGreaterThan(0)
  })

  it('bypasses every section for a non-task branch whose body is not brief-shaped', () => {
    // The ordinary one-line dependency-bump PR: no brief, must not be forced
    // to grow one. Mirrors check-brief-shape.ts's identical bypass.
    const errors = validateForgeWrite({
      ...base,
      body: '## Summary\nBump a dependency.',
      sections: PR_SECTIONS,
      branch: 'chore/bump-dep'
    })
    expect(errors).toEqual([])
  })

  it('still grades a brief-shaped body on a non-task branch (bypass is not a blanket skip)', () => {
    // `fix/studio-tranche-href`'s failure mode: a standalone fix brief IS a
    // brief, so its sections are still enforced — only Closes #N is dropped.
    const errors = validateForgeWrite({
      ...base,
      body: briefShapedNoCloses,
      sections: [{ builtin: 'tier' }, { builtin: 'project' }, { builtin: 'docUpdateList' }],
      branch: 'fix/some-standalone-fix'
    })
    expect(errors).toEqual([])

    const missingDocList = validateForgeWrite({
      ...base,
      body: briefShapedNoCloses.replace('## Documentation-update list\n- None\n', ''),
      sections: [{ builtin: 'docUpdateList' }],
      branch: 'fix/some-standalone-fix'
    })
    expect(missingDocList.length).toBe(1)
  })

  it('grammar-checks the title regardless of branch', () => {
    // The title gate binds on every branch — it sits outside the bypass.
    const errors = validateForgeWrite({
      ...base,
      body: '## Summary\nBump a dependency.',
      sections: [],
      title: 'not a valid title',
      branch: 'chore/bump-dep'
    })
    expect(errors.length).toBe(1)
    expect(errors[0]?.check).toBe('forge-title')
  })
})

// rings.ring1_forgeWriteInterception means what it says (issue-545, O2):
// `true`/absent RUNS forge-write interception, so this must resolve the
// configured briefSchema sections. `false` is the opt-OUT that skips
// brief-schema validation entirely.
describe('resolveSections — rings.ring1_forgeWriteInterception', () => {
  let tmpDir: string
  let originalCwd: string
  let resolveSections: typeof import('../src/lib/forge-write.js').resolveSections

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vinaya-forge-ring1-test-'))
    originalCwd = process.cwd()
    process.chdir(tmpDir)
    resolveSections = (await import('../src/lib/forge-write.js')).resolveSections
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeConfig(config: unknown): void {
    writeFileSync(join(tmpDir, 'vinaya.config.json'), JSON.stringify(config), 'utf8')
  }

  it('no rings key at all resolves the configured briefSchema sections, unaffected', () => {
    writeConfig({ briefSchema: { pr: { sections: [{ builtin: 'tier' }] } } })
    expect(resolveSections('pr', 'vinaya pr create')).toEqual([{ builtin: 'tier' }])
  })

  it('`true` is a no-op — resolves the same sections as absent', () => {
    writeConfig({
      rings: { ring1_forgeWriteInterception: true, ring2_asyncAudits: true },
      briefSchema: { pr: { sections: [{ builtin: 'tier' }] } }
    })
    expect(resolveSections('pr', 'vinaya pr create')).toEqual([{ builtin: 'tier' }])
  })

  it('`false` is the opt-out — resolves an empty section set regardless of briefSchema', () => {
    writeConfig({
      rings: { ring1_forgeWriteInterception: false, ring2_asyncAudits: true },
      briefSchema: { pr: { sections: [{ builtin: 'tier' }] } }
    })
    expect(resolveSections('pr', 'vinaya pr create')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// task 17, O1/O2 — the registry-runner call every forge-write path shares.
// Only the pass path is exercised here (a body/Issue this process can grade
// clean) — the refusal path calls `refuse()` (`process.exit(1)`), which
// `tests/commands/pr.test.ts`'s subprocess-based suite already covers
// end to end (`runs the registry PR_BODY checks (task 12, #387)`).
// ---------------------------------------------------------------------------

describe('runBodyChecks — the ONE registry-runner call every forge-write path shares (O1)', () => {
  it("resolves without refusing on a body the registered `validates: 'body'` checks all pass, PR not yet created", async () => {
    await expect(runBodyChecks(validPr, 'fix/some-branch', undefined, 'vinaya pr create')).resolves.toBeUndefined()
  })

  describe('rings.ring1_forgeWriteInterception: false', () => {
    let tmpDir: string
    let originalCwd: string

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'vinaya-forge-body-checks-ring1-test-'))
      originalCwd = process.cwd()
      process.chdir(tmpDir)
      writeFileSync(
        join(tmpDir, 'vinaya.config.json'),
        JSON.stringify({ rings: { ring1_forgeWriteInterception: false, ring2_asyncAudits: true } }),
        'utf8'
      )
    })

    afterEach(() => {
      process.chdir(originalCwd)
      rmSync(tmpDir, { recursive: true, force: true })
    })

    it('resolves without refusing, even given a body no core check would pass', async () => {
      await expect(runBodyChecks('123', '', undefined, 'vinaya pr create')).resolves.toBeUndefined()
    })
  })
})

describe('runIssueChecks — the ONE registry-runner call every Issue write path shares (O2)', () => {
  // O1 (task 17, this task): returns the finding list instead of refusing
  // internally, so `collectTaskIssueErrors` can fold it into the same union
  // every other gate group contributes to. An empty array is the pass case.
  it("resolves an empty finding list for a subject every registered `validates: 'issue'` check passes", async () => {
    await expect(
      runIssueChecks({
        body: "## Objectives\n\nO1. Something happens.\n\n## Planner's rationale\n\nsome rationale\n",
        labels: ['vinaya/tranche:demo-v1'],
        title: 'Feat: a well-formed title',
        issueNumber: null,
        currentMilestoneTitle: null,
        resolvedMilestoneTitle: null,
        retryCommand: 'vinaya issue create'
      })
    ).resolves.toEqual([])
  })
})

describe('forge-write.ts — the registry runner is the ONLY validator path for validates:-tagged checks (O1/O2 audit)', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'src', 'lib', 'forge-write.ts'), 'utf8')

  it('calls `runChecks` in exactly two places — runBodyChecks and runIssueChecks — never a third, ad hoc invocation', () => {
    const matches = source.match(/\brunChecks\(/g) ?? []
    expect(matches.length).toBe(2)
  })

  it('every check `runBodyChecks`/`runIssueChecks` select is filtered by its registered `validates` field, not a hand-rolled name list', () => {
    expect(source).toContain("filter((s) => s.validates === 'body')")
    expect(source).toContain("filter((s) => s.validates === 'issue')")
  })
})
