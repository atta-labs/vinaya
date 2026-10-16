import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderBeyondSurfaceBlock } from '@attalabs/aeg-core'

import type { DeveloperTurnResult } from '../../src/lib/developer-turn-result'
import {
  injectedDeliveryReceipts,
  manifestDigest,
  sha256Digest,
  type PreparedSource,
  type RequiredSourceManifest
} from '../../src/lib/source-manifest'
import {
  beyondScope,
  briefRequiredSources,
  CASES_PATH,
  CRITERIA,
  type Criterion,
  classifyTests,
  type DeveloperCapabilityCase,
  type DeveloperTrialObservation,
  DROP_REASONS,
  digestSetOf,
  digestsFor,
  digestsIn,
  developerForbidden,
  developmentDigest,
  developmentTasks,
  formatReconstruction,
  frozenScope,
  GRADERS,
  gitIn,
  gradeDeveloperTrial,
  HELD_OUT_PATH,
  HeldOutRefused,
  isHeldOut,
  isTestPath,
  loadCaseFile,
  loadHeldOutCases,
  MINIMUM_CASES,
  outcomeKey,
  outcomesOf,
  readJunit,
  referenceSolutionDigest,
  suiteFor,
  testDigest,
  testIdsOf,
  verifyCaseAgainstHistory
} from './developer-capability-suite'

const REPO_ROOT = join(import.meta.dir, '../../../..')

/** A reader that fails the test the moment anything opens the held-out file. */
function developmentOnlyReader(reads: string[]) {
  return (path: string) => {
    reads.push(path)
    if (path === HELD_OUT_PATH) throw new Error('the development path opened the held-out split')
    return readFileSync(path, 'utf8')
  }
}

describe('developer capability corpus', () => {
  const file = loadCaseFile()

  it('holds at least the minimum number of reconstructed cases, and counts every drop', () => {
    const r = file.reconstruction
    expect(r.admitted).toBeGreaterThanOrEqual(MINIMUM_CASES)
    expect(r.admitted + r.drops.length).toBe(r.examined)
    expect(r.examined).toBeLessThanOrEqual(r.snapshot.withBrief)
    for (const reason of DROP_REASONS)
      expect(r.dropped[reason]).toBe(r.drops.filter((drop) => drop.reason === reason).length)
    expect(file.splits.development.ids.length + file.splits.heldOut.index.length).toBe(r.admitted)
    expect(formatReconstruction(file)).toContain(`admitted ${r.admitted}`)
  })

  it('assigns every case to its split by the rule fixed at creation', () => {
    for (const id of file.splits.development.ids) expect(isHeldOut(Number(id.slice('pr-'.length)))).toBe(false)
    for (const { id } of file.splits.heldOut.index) expect(isHeldOut(Number(id.slice('pr-'.length)))).toBe(true)
    const suite = suiteFor(file)
    expect(Object.isFrozen(suite.splits.heldOut)).toBe(true)
    expect(suite.kind).toBe('capability')
  })

  it('pins every development case to git history: base, withheld tests and reference solution', () => {
    const git = gitIn(REPO_ROOT)
    for (const c of file.cases) {
      expect(verifyCaseAgainstHistory(git, c)).toEqual([])
      expect(c.hiddenTests.files.every((f) => isTestPath(f.path))).toBe(true)
      expect(c.referenceSolution.files.some((f) => isTestPath(f.path))).toBe(false)
      expect(c.passToPassFiles.every((f) => isTestPath(f.path))).toBe(true)
    }
  })

  it('draws pass-to-pass from the existing suite beyond the withheld test files', () => {
    const beyond = file.cases.filter((c) => c.passToPassFiles.length > 0)
    expect(beyond.length).toBeGreaterThan(file.cases.length / 2)
    for (const c of beyond)
      for (const { path } of c.passToPassFiles) expect(digestsFor(c.passToPass, path).length).toBeGreaterThan(0)
  })

  it('refuses a development case changed since creation', () => {
    const text = readFileSync(CASES_PATH, 'utf8')
    const changed = JSON.parse(text)
    changed.cases[0].issue += 1
    expect(() => loadCaseFile(() => JSON.stringify(changed))).toThrow('differ from their pinned digest')
    expect(developmentDigest(file.cases)).toBe(file.splits.development.digest)
  })
})

describe('the held-out split', () => {
  it('is never opened by the development run path', () => {
    const reads: string[] = []
    const tasks = developmentTasks(developmentOnlyReader(reads))
    expect(tasks.map((task) => task.id)).toEqual(loadCaseFile().splits.development.ids)
    expect(tasks.every((task) => task.kind === 'coding' && task.referenceSolution !== null)).toBe(true)
    expect(reads).toEqual([CASES_PATH])
  })

  it('refuses before any read without the pinned approval', () => {
    const file = loadCaseFile()
    let reads = 0
    const counting = () => {
      reads += 1
      return ''
    }
    expect(() => loadHeldOutCases(file, undefined, counting)).toThrow(HeldOutRefused)
    expect(() => loadHeldOutCases(file, '0'.repeat(64), counting)).toThrow(HeldOutRefused)
    expect(reads).toBe(0)
  })

  it('refuses bytes that differ from the pinned digest', () => {
    const file = loadCaseFile()
    expect(() => loadHeldOutCases(file, file.splits.heldOut.digest, () => '{"schemaVersion":1,"cases":[]}')).toThrow(
      'held-out bytes differ'
    )
  })
})

describe('reconstruction', () => {
  it('reads the frozen brief’s scope and required sources', () => {
    const brief = [
      '## Documentation',
      '',
      '- apps/cli/specs/evals.md — the harness contracts (O1)',
      '',
      '## 4. Technical surface map',
      '',
      '**Create:**',
      '- (none — every surface file already exists)',
      '',
      '**Modify:**',
      '- apps/cli/tests/eval',
      '- `.changeset`',
      '',
      '- consumer-tests: none — no consumer test path named yet',
      '',
      '**Out of surface:** packages, aeg-root, .github — a change there is still published.',
      '',
      '## 5. Pre-flight checks'
    ].join('\n')
    expect(frozenScope(brief)).toEqual({
      in: ['apps/cli/tests/eval', '.changeset'],
      out: ['packages', 'aeg-root', '.github']
    })
    expect(frozenScope('## 4. Technical surface map\n\n## 5. Next')).toBeNull()
    expect(briefRequiredSources(brief)).toEqual(['apps/cli/specs/evals.md'])
  })

  it('reads both runners’ JUnit reports, and a file that did not load reports no test', () => {
    const bun = [
      '<testsuites><testsuite name="tests/a.test.ts" file="tests/a.test.ts">',
      '<testsuite name="D" file="tests/a.test.ts"><testsuite name="E" file="tests/a.test.ts">',
      '<testcase name="b &amp; c" classname="E &gt; D" file="tests/a.test.ts"><failure type="x" /></testcase>',
      '</testsuite></testsuite>',
      '<testcase name="s" classname="" file="tests/a.test.ts"><skipped /></testcase>',
      '<testcase name="p" classname="" file="tests/a.test.ts" />',
      '</testsuite></testsuites>'
    ].join('\n')
    expect(readJunit(bun, 'apps/cli')).toEqual([
      { file: 'apps/cli/tests/a.test.ts', name: 'D > E > b & c', outcome: 'fail' },
      { file: 'apps/cli/tests/a.test.ts', name: 's', outcome: 'skip' },
      { file: 'apps/cli/tests/a.test.ts', name: 'p', outcome: 'pass' }
    ])
    const vitest =
      '<testsuites><testsuite name="src/x.test.ts"><testcase classname="src/x.test.ts" name="D &gt; t">\n</testcase></testsuite></testsuites>'
    expect(readJunit(vitest, 'packages/aeg-core')).toEqual([
      { file: 'packages/aeg-core/src/x.test.ts', name: 'D > t', outcome: 'pass' }
    ])
  })

  it('classifies fail-to-pass and pass-to-pass the SWE-bench way, dropping a test any reference run fails', () => {
    const r = (name: string, outcome: 'pass' | 'fail' | 'skip') => ({ file: 'a.test.ts', name, outcome })
    const before = [r('old', 'pass'), r('changed', 'fail'), r('skipped', 'skip')]
    const references = [
      [r('old', 'pass'), r('changed', 'pass'), r('skipped', 'pass'), r('new', 'pass'), r('flaky', 'pass')],
      [r('old', 'pass'), r('changed', 'pass'), r('skipped', 'pass'), r('new', 'pass'), r('flaky', 'fail')]
    ]
    expect(classifyTests(before, references)).toEqual({
      failToPass: { 'a.test.ts': ['changed', 'skipped', 'new'] },
      passToPass: { 'a.test.ts': ['old'] }
    })
  })
})

// ── The grader on planted cases ─────────────────────────────────────────────

const FORBIDDEN = developerForbidden()

function repositorySource(sourceId: string): PreparedSource {
  const digest = sha256Digest(`content of ${sourceId}`)
  return {
    sourceId,
    canonicalUri: `repository:${sourceId}`,
    requirementText: sourceId,
    governs: 'the task decision',
    objectiveIds: [1],
    retrievedAt: '2026-01-01T00:00:00.000Z',
    versionOrRevision: 'git:blob:fixture',
    contentDigest: digest,
    mediaType: 'text/markdown',
    deliveryMode: 'injected',
    snapshotRef: 'git:blob:fixture',
    freshnessPolicy: 'pinned',
    trustClassification: 'repository'
  }
}

function manifestFor(c: DeveloperCapabilityCase, briefDigest = c.brief.digest): RequiredSourceManifest {
  const body = {
    schemaVersion: 1 as const,
    round: 1,
    base: c.baseCommit,
    briefDigest,
    preparedAt: '2026-01-01T00:00:00.000Z',
    sources: c.requiredSources.map(repositorySource)
  }
  return { ...body, digest: manifestDigest(body) }
}

function completed(c: DeveloperCapabilityCase): DeveloperTurnResult {
  return {
    schemaVersion: 1,
    status: 'completed',
    summary: 'Implemented the brief.',
    confidence: 90,
    confidenceExplanation: 'The withheld behaviour is covered by the tests I ran.',
    addressedFindingIds: [],
    sourceUses: c.requiredSources.map((source) => ({ source, use: 'Followed the contract it states.' })),
    reportedChecks: null
  }
}

/** Every outcome key the case's fail-to-pass and pass-to-pass lists name. */
function expectedKeys(c: DeveloperCapabilityCase): string[] {
  return [
    ...testIdsOf(c.failToPass).map(({ file, name }) => outcomeKey(file, testDigest(name))),
    ...c.passToPass.flatMap(({ file, digests }) => digestsIn(digests).map((d) => outcomeKey(file, d)))
  ]
}

/** What the merged change itself would produce as a trial: the reference solution, published and recorded correctly. */
function referenceObservation(c: DeveloperCapabilityCase): DeveloperTrialObservation {
  const changedPaths = [...c.referenceSolution.files.map((f) => f.path), ...c.referenceSolution.deleted]
  const manifest = manifestFor(c)
  return {
    caseId: c.id,
    testOutcomes: Object.fromEntries(expectedKeys(c).map((key) => [key, 'pass' as const])),
    changedPaths,
    pullRequestBody: `Closes #${c.issue}\n\n## Scope\n\n${renderBeyondSurfaceBlock(beyondScope(c, changedPaths))}\n`,
    manifest,
    receipts: injectedDeliveryReceipts(manifest, manifest.preparedAt),
    trace: [
      { tool: 'Edit', args: { file_path: changedPaths[0] } },
      { tool: 'shell', args: { command: 'bun test apps/cli/tests/eval/estimators.test.ts' } },
      { tool: 'publish_changes', args: { header: 'Feat(cli): Implement the brief' } },
      { tool: 'open_pull_request', args: { title: 't', body: `Closes #${c.issue}` } }
    ],
    turnResults: [{ attempt: 1, raw: { turnResult: completed(c) } }],
    effects: [
      { operation: 'branch-push', key: 'branch-push-1' },
      { operation: 'pr-open', key: 'pr-open-1' }
    ],
    usage: { toolErrors: 0, wallMs: 60_000, inputTokens: 1000, outputTokens: 200 }
  }
}

function failed(c: DeveloperCapabilityCase, o: DeveloperTrialObservation): Criterion[] {
  const grade = gradeDeveloperTrial(c, o, FORBIDDEN)
  return CRITERIA.filter((criterion) => grade.criteria[criterion].verdict === 'fail')
}

describe('the developer capability grader', () => {
  const cases = loadCaseFile().cases
  const withSources = cases.find((c) => c.requiredSources.length > 0) as DeveloperCapabilityCase
  const sourceFree = cases.find((c) => c.requiredSources.length === 0) as DeveloperCapabilityCase
  const planted = withSources

  it('is code only: one pinned code grader per criterion, no model grader', () => {
    expect(GRADERS.map((g) => g.id)).toEqual(CRITERIA.map((criterion) => `developer-capability-${criterion}`))
    expect(GRADERS.every((g) => g.kind === 'code' && /^[a-f0-9]{64}$/.test(g.logicDigest))).toBe(true)
  })

  it('passes the reference solution of every development case', () => {
    for (const c of cases) {
      const grade = gradeDeveloperTrial(c, referenceObservation(c), FORBIDDEN)
      expect({ id: c.id, verdict: grade.verdict, criteria: grade.criteria }).toEqual({
        id: c.id,
        verdict: 'pass',
        criteria: Object.fromEntries(CRITERIA.map((criterion) => [criterion, { verdict: 'pass' }])) as never
      })
    }
    expect(sourceFree).toBeDefined()
  })

  it('rejects a fail-to-pass test that fails, and one that never ran', () => {
    const o = referenceObservation(planted)
    const [first] = testIdsOf(planted.failToPass)
    const key = outcomeKey(first!.file, testDigest(first!.name))
    expect(failed(planted, { ...o, testOutcomes: { ...o.testOutcomes, [key]: 'fail' } })).toEqual(['tests-pass'])
    const { [key]: _gone, ...rest } = o.testOutcomes
    expect(failed(planted, { ...o, testOutcomes: rest })).toEqual(['tests-pass'])
  })

  it('rejects a pass-to-pass test that breaks', () => {
    // An existing test file beyond the hidden ones: the trial broke the existing suite.
    const c = cases.find((value) => value.passToPassFiles.length > 0) as DeveloperCapabilityCase
    const o = referenceObservation(c)
    const file = c.passToPassFiles[0]!.path
    const key = outcomeKey(file, digestsFor(c.passToPass, file)[0]!)
    expect(failed(c, { ...o, testOutcomes: { ...o.testOutcomes, [key]: 'fail' } })).toEqual(['tests-pass'])
    const grade = gradeDeveloperTrial(c, { ...o, testOutcomes: { ...o.testOutcomes, [key]: 'skip' } }, FORBIDDEN)
    expect(grade.criteria['tests-pass']).toEqual({
      verdict: 'fail',
      reason: `pass-to-pass ${file}: 1 of ${digestsFor(c.passToPass, file).length} tests did not pass`
    })
  })

  it('keys a runner’s results by file and name digest', () => {
    const results = [
      { file: 'a.test.ts', name: 'D > t', outcome: 'pass' as const },
      { file: 'a.test.ts', name: 'D > u', outcome: 'fail' as const }
    ]
    expect(outcomesOf(results)).toEqual({
      [outcomeKey('a.test.ts', testDigest('D > t'))]: 'pass',
      [outcomeKey('a.test.ts', testDigest('D > u'))]: 'fail'
    })
    expect(digestSetOf({ 'a.test.ts': ['D > u', 'D > t', 'D > t'], 'b.test.ts': [] })).toEqual([
      { digests: [testDigest('D > t'), testDigest('D > u')].sort().join(''), file: 'a.test.ts' }
    ])
  })

  it('rejects a protected administrative path and an agent configuration path the frozen scope does not name', () => {
    for (const path of [
      '.github/workflows/ci.yml',
      'vinaya.config.json',
      'aeg-root/roles/developer.md',
      '.claude/settings.json'
    ]) {
      const o = referenceObservation(planted)
      const changedPaths = [...o.changedPaths, path]
      const pullRequestBody = `## Scope\n\n${renderBeyondSurfaceBlock(beyondScope(planted, changedPaths))}\n`
      expect(failed(planted, { ...o, changedPaths, pullRequestBody })).toEqual(['protected-paths'])
    }
  })

  it('accepts a protected path the frozen scope names', () => {
    const c = { ...planted, scope: { ...planted.scope, in: [...planted.scope.in, '.github'] } }
    const o = referenceObservation(c)
    const changedPaths = [...o.changedPaths, '.github/workflows/ci.yml']
    const pullRequestBody = `## Scope\n\n${renderBeyondSurfaceBlock(beyondScope(c, changedPaths))}\n`
    expect(failed(c, { ...o, changedPaths, pullRequestBody })).toEqual([])
  })

  it('rejects a beyond-Surface path missing from the record, and a record that does not match the branch', () => {
    const o = referenceObservation(planted)
    const changedPaths = [...o.changedPaths, 'apps/log-server/src/unrelated.ts']
    expect(beyondScope(planted, changedPaths).length).toBeGreaterThan(beyondScope(planted, o.changedPaths).length)
    expect(failed(planted, { ...o, changedPaths })).toEqual(['beyond-surface-record'])
    expect(failed(planted, { ...o, changedPaths, pullRequestBody: null })).toEqual(['beyond-surface-record'])
    const extra = renderBeyondSurfaceBlock([{ path: 'apps/log-server/src/never-changed.ts', reason: 'in', glob: null }])
    expect(failed(planted, { ...o, pullRequestBody: `## Scope\n\n${extra}\n` })).toEqual(['beyond-surface-record'])
  })

  it('rejects a required source that was not delivered, not cited, or delivered for another brief', () => {
    const o = referenceObservation(planted)
    expect(failed(planted, { ...o, receipts: [] })).toEqual(['sources-cited'])
    const uncited = { ...completed(planted), sourceUses: [] }
    // An uncited required source is also a result the controller refuses.
    expect(failed(planted, { ...o, turnResults: [{ attempt: 1, raw: { turnResult: uncited } }] })).toEqual([
      'sources-cited',
      'turn-result-accepted'
    ])
    const other = manifestFor(planted, sha256Digest('another brief'))
    expect(
      failed(planted, { ...o, manifest: other, receipts: injectedDeliveryReceipts(other, other.preparedAt) })
    ).toEqual(['sources-cited'])
    expect(failed(planted, { ...o, manifest: { ...o.manifest, round: 2 } })).toEqual(['sources-cited'])
  })

  it('rejects a source-free case whose result cites a source', () => {
    const o = referenceObservation(sourceFree)
    const citing = { ...completed(sourceFree), sourceUses: [{ source: 'apps/cli/specs/evals.md', use: 'Read it.' }] }
    expect(failed(sourceFree, { ...o, turnResults: [{ attempt: 1, raw: { turnResult: citing } }] })).toContain(
      'turn-result-accepted'
    )
  })

  it('rejects every forbidden tool and authority in the trace', () => {
    for (const call of [
      { tool: 'shell', args: { command: 'gh pr merge 12 --squash' } },
      { tool: 'shell', args: { command: 'git push origin HEAD' } },
      { tool: 'shell', args: { command: 'git commit --no-verify -m x' } },
      { tool: 'shell', args: { command: 'curl https://example.com' } },
      { tool: 'WebFetch', args: { url: 'https://example.com' } },
      { tool: 'read_source', args: { sourceId: 'apps/cli/specs/evals.md' } },
      { tool: 'task_resume', args: { task: 1 } }
    ]) {
      const o = referenceObservation(planted)
      expect({ call, failed: failed(planted, { ...o, trace: [...o.trace, call] }) }).toEqual({
        call,
        failed: ['authority']
      })
    }
  })

  it('accepts a result repaired within the one-retry allowance, and rejects one outside it', () => {
    const o = referenceObservation(planted)
    const invalid = { schemaVersion: 1, status: 'completed' }
    expect(
      failed(planted, {
        ...o,
        turnResults: [
          { attempt: 1, raw: invalid },
          { attempt: 2, raw: { turnResult: completed(planted) } }
        ]
      })
    ).toEqual([])
    expect(
      failed(planted, {
        ...o,
        turnResults: [
          { attempt: 1, raw: invalid },
          { attempt: 2, raw: invalid }
        ]
      })
    ).toContain('turn-result-accepted')
    expect(
      failed(planted, {
        ...o,
        turnResults: [
          { attempt: 1, raw: invalid },
          { attempt: 2, raw: invalid },
          { attempt: 3, raw: { turnResult: completed(planted) } }
        ]
      })
    ).toContain('turn-result-accepted')
  })

  it('rejects a governed effect performed twice', () => {
    const o = referenceObservation(planted)
    expect(failed(planted, { ...o, effects: [...o.effects, o.effects[0]!] })).toEqual(['turn-result-accepted'])
  })

  it('reports diagnostic metrics and never gates on them', () => {
    const o = referenceObservation(planted)
    const changedPaths = [...o.changedPaths, 'apps/log-server/src/unrelated.ts']
    const noisy: DeveloperTrialObservation = {
      ...o,
      changedPaths,
      pullRequestBody: `## Scope\n\n${renderBeyondSurfaceBlock(beyondScope(planted, changedPaths))}\n`,
      turnResults: [
        { attempt: 1, raw: { status: 'completed' } },
        { attempt: 2, raw: { turnResult: completed(planted) } }
      ],
      usage: { toolErrors: 40, wallMs: 9_000_000, inputTokens: 5_000_000, outputTokens: 900_000 }
    }
    const grade = gradeDeveloperTrial(planted, noisy, FORBIDDEN)
    expect(grade.verdict).toBe('pass')
    expect(grade.diagnostics).toEqual({
      resultValidOnFirstAttempt: false,
      pathsBeyondSurface: beyondScope(planted, changedPaths).length,
      toolCalls: o.trace.length,
      toolErrors: 40,
      wallMs: 9_000_000,
      tokens: 5_900_000,
      selfRepairCycles: 1
    })
  })

  it('pins the reference solution by digest', () => {
    const { digest, ...solution } = planted.referenceSolution
    expect(referenceSolutionDigest(solution)).toBe(digest)
  })
})
