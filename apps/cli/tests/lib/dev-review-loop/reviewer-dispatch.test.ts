import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_REVIEW_POLICY,
  defaultControlStoreDeps,
  readManifest,
  type ReviewInputManifest
} from '@attalabs/aeg-core'
import type { DispatchHandle } from '../../../src/lib/dispatch'
import {
  AGENT_CONFIG_GLOBS,
  buildManifestRecord,
  buildReviewerPromptPieces,
  buildRoundDeferralContext,
  buildVerdictFromReport,
  capSecurityScanOutput,
  controlStoreRootFor,
  decideSecurityScan,
  driverAuthoredPromptText,
  lintReviewerPrompt,
  makeChangedLinePredicate,
  makeInSurfacePredicate,
  parseChangedLines,
  parseFindingLocation,
  persistManifestRecord,
  renderReviewerDispatchPrompt,
  renderReviewerPrompt,
  ReviewerReportParseFailure,
  roleDoctrinePieces,
  SECURITY_SCAN_OUTPUT_MAX_CHARS,
  securityScanPieces,
  touchesAgentConfig
} from '../../../src/lib/dev-review-loop/reviewer-dispatch'
import type {
  ReviewerPromptFacts,
  ReviewerPromptPiece,
  SecurityScanOutcome
} from '../../../src/lib/dev-review-loop/reviewer-dispatch'

// --- objective-id coverage at the driver (review-validity-v1 task 4, #478, O4) ---

describe('buildVerdictFromReport — objective-id coverage, the same rule `review post` already applies', () => {
  let workDir: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'vinaya-build-verdict-'))
  })
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  const MANIFEST: ReviewInputManifest = {
    headSha: 'a'.repeat(40),
    baseSha: 'e'.repeat(40),
    briefHash: 'b'.repeat(64),
    objectivesVersion: 'c'.repeat(64),
    rulingOrdinal: 0,
    policyDigest: 'd'.repeat(64)
  }

  const HANDLE: DispatchHandle = {
    exitCode: 0,
    durationMs: 100,
    usage: { input: 10, output: 5 },
    resumeId: 'session-1',
    timedOut: false
  }

  const RESOLVED_OBJECTIVES = [
    { id: 'O1', text: 'Do the first thing.' },
    { id: 'O2', text: 'Do the second thing.' }
  ]

  function writeArtifacts(objectivesLines: string): void {
    writeFileSync(join(workDir, 'findings.txt'), '')
    writeFileSync(join(workDir, 'objectives.txt'), objectivesLines)
    writeFileSync(
      join(workDir, 'report.txt'),
      'BRIEF_CONFORMANCE: clean\nSPEC_CONFORMANCE: clean\nSCOPE: small\nTESTS: honest\nDOCS: n/a'
    )
  }

  it('accepts an objectives.txt covering every resolved id exactly', () => {
    writeArtifacts('O1|MET|done\nO2|MET|done')
    const result = buildVerdictFromReport(
      'reviewer',
      workDir,
      'claude',
      478,
      HANDLE,
      MANIFEST,
      DEFAULT_REVIEW_POLICY,
      RESOLVED_OBJECTIVES
    )
    expect(result.observation.verdict).toBe('APPROVE')
    expect(result.observation.objectives).toEqual([
      { id: 'O1', met: true },
      { id: 'O2', met: true }
    ])
  })

  it('refuses (ReviewerReportParseFailure) when objectives.txt is missing one resolved id', () => {
    writeArtifacts('O1|MET|done')
    expect(() =>
      buildVerdictFromReport(
        'reviewer',
        workDir,
        'claude',
        478,
        HANDLE,
        MANIFEST,
        DEFAULT_REVIEW_POLICY,
        RESOLVED_OBJECTIVES
      )
    ).toThrow(ReviewerReportParseFailure)
    try {
      buildVerdictFromReport(
        'reviewer',
        workDir,
        'claude',
        478,
        HANDLE,
        MANIFEST,
        DEFAULT_REVIEW_POLICY,
        RESOLVED_OBJECTIVES
      )
      throw new Error('expected a throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewerReportParseFailure)
      expect((err as Error).message).toContain('missing O2')
    }
  })

  it('refuses when objectives.txt carries an extra id not on the resolved list', () => {
    writeArtifacts('O1|MET|done\nO2|MET|done\nO3|MET|done')
    expect(() =>
      buildVerdictFromReport(
        'reviewer',
        workDir,
        'claude',
        478,
        HANDLE,
        MANIFEST,
        DEFAULT_REVIEW_POLICY,
        RESOLVED_OBJECTIVES
      )
    ).toThrow(ReviewerReportParseFailure)
  })

  it('skips the coverage check entirely when the task carries no objectives at all', () => {
    writeFileSync(join(workDir, 'findings.txt'), '')
    writeFileSync(
      join(workDir, 'report.txt'),
      'BRIEF_CONFORMANCE: clean\nSPEC_CONFORMANCE: clean\nSCOPE: small\nTESTS: honest\nDOCS: n/a'
    )
    const result = buildVerdictFromReport(
      'reviewer',
      workDir,
      'claude',
      478,
      HANDLE,
      MANIFEST,
      DEFAULT_REVIEW_POLICY,
      []
    )
    expect(result.observation.verdict).toBe('APPROVE')
    expect(result.observation.objectives).toEqual([])
  })

  it('never runs the coverage check for an ESCALATE report', () => {
    writeFileSync(join(workDir, 'report.txt'), 'ESCALATE: strategy\nSUMMARY: found a design gap')
    const result = buildVerdictFromReport(
      'reviewer',
      workDir,
      'claude',
      478,
      HANDLE,
      MANIFEST,
      DEFAULT_REVIEW_POLICY,
      RESOLVED_OBJECTIVES
    )
    expect(result.observation.verdict).toBe('ESCALATE')
  })

  // --- prose never decides a round --------------------------------------------

  it('a NOT MET citing only "PR body:Decisions" is reclassified MET (prose note) — the round publishes', () => {
    writeArtifacts('O1|NOT MET|PR body:Decisions\nO2|MET|done')
    const result = buildVerdictFromReport(
      'reviewer',
      workDir,
      'claude',
      478,
      HANDLE,
      MANIFEST,
      DEFAULT_REVIEW_POLICY,
      RESOLVED_OBJECTIVES
    )
    // Reclassified MET — the round-level observation `assessRound` reads
    // shows no NOT MET at all, so this round is never `changes_requested`
    // for it.
    expect(result.observation.objectives).toEqual([
      { id: 'O1', met: true },
      { id: 'O2', met: true }
    ])
    expect(result.observation.verdict).toBe('APPROVE')
    // The rendered verdict comment carries the annotation, so a reader still
    // sees that this was a reclassification, not a Developer/reviewer claim.
    expect(result.rendered).toMatch(/O1: MET — PR body:Decisions \(prose note\)/)
  })

  it('a NOT MET citing a role file (aeg-root/roles/…) is reclassified MET (prose note) too', () => {
    writeArtifacts('O1|NOT MET|aeg-root/roles/developer.md\nO2|MET|done')
    const result = buildVerdictFromReport(
      'reviewer',
      workDir,
      'claude',
      478,
      HANDLE,
      MANIFEST,
      DEFAULT_REVIEW_POLICY,
      RESOLVED_OBJECTIVES
    )
    expect(result.observation.objectives).toEqual([
      { id: 'O1', met: true },
      { id: 'O2', met: true }
    ])
    expect(result.observation.verdict).toBe('APPROVE')
  })

  it('a NOT MET citing a real source file (Traps to avoid: never downgrade a real location) is left NOT MET — never reclassified', () => {
    writeArtifacts('O1|NOT MET|apps/cli/src/commands/pr-report.ts:42 never calls the new function\nO2|MET|done')
    const result = buildVerdictFromReport(
      'reviewer',
      workDir,
      'claude',
      478,
      HANDLE,
      MANIFEST,
      DEFAULT_REVIEW_POLICY,
      RESOLVED_OBJECTIVES
    )
    // `assessRound` (`@attalabs/aeg-core`) is what actually turns this
    // `met: false` into a `changes_requested` round outcome — out of this
    // function's own scope. What THIS function must never do is erase the
    // fact that O1 is unmet just because it cites a real file.
    expect(result.observation.objectives).toEqual([
      { id: 'O1', met: false },
      { id: 'O2', met: true }
    ])
    expect(result.rendered).toMatch(/O1: NOT MET/)
    expect(result.rendered).not.toMatch(/prose note/)
  })
})

describe('buildManifestRecord / persistManifestRecord — the parent-built store record (#555, O1)', () => {
  const manifest: ReviewInputManifest = {
    headSha: 'a'.repeat(40),
    baseSha: 'f'.repeat(40),
    briefHash: 'b'.repeat(64),
    objectivesVersion: 'c'.repeat(64),
    rulingOrdinal: 2,
    policyDigest: 'd'.repeat(64)
  }
  const identity = {
    repository: 'atta-labs/vinaya',
    pr: 601,
    branch: 'task/control-store-v1/5',
    round: 3,
    recordedAt: '2026-09-14T00:00:00.000Z'
  }

  it('assembles the record from the binding manifest plus repository and work identity', () => {
    expect(buildManifestRecord(manifest, identity)).toEqual({
      round: 3,
      repository: 'atta-labs/vinaya',
      pr: 601,
      branch: 'task/control-store-v1/5',
      baseSha: 'f'.repeat(40),
      headSha: 'a'.repeat(40),
      briefHash: 'b'.repeat(64),
      objectivesVersion: 'c'.repeat(64),
      rulingOrdinal: 2,
      policyDigest: 'd'.repeat(64),
      recordedAt: '2026-09-14T00:00:00.000Z'
    })
  })

  it('persists to the control store under the outbox root and reads back byte-for-byte', () => {
    const outbox = mkdtempSync(join(tmpdir(), 'vinaya-manifest-persist-'))
    try {
      const written = persistManifestRecord(outbox, 555, manifest, identity)
      expect(written).not.toBeNull()
      const read = readManifest(
        defaultControlStoreDeps(() => controlStoreRootFor(outbox)),
        555,
        3
      )
      expect(read).toEqual({ status: 'ok', value: written })
    } finally {
      rmSync(outbox, { recursive: true, force: true })
    }
  })
})

// --- the banned-framing lint reads driver text only (#736, O1/O2) ----------

describe('renderReviewerPrompt — the banned-framing lint checks only the text the driver writes', () => {
  const MANIFEST: ReviewInputManifest = {
    headSha: 'a'.repeat(40),
    baseSha: 'e'.repeat(40),
    briefHash: 'b'.repeat(64),
    objectivesVersion: 'c'.repeat(64),
    rulingOrdinal: 2,
    policyDigest: 'd'.repeat(64)
  }

  const FACTS: ReviewerPromptFacts = {
    objectives: 'O1. Do the thing.',
    resolvedObjectives: [{ id: 'O1', text: 'Do the thing.' }],
    rulings: [],
    ciConclusion: 'green',
    revision: 'f'.repeat(40),
    manifest: MANIFEST
  }

  // Every phrase in the module's own BANNED_FRAMING list, as a Principal
  // might actually write them in a ruling.
  const RULING_WITH_EVERY_BANNED_PHRASE =
    'The developer says the fix is done; according to the developer CI is green. ' +
    'In my opinion that is not enough — I think the PR body says otherwise, and the diff clearly contradicts it.'

  it('renders a ruling carrying every banned phrase, verbatim, instead of ending the round', () => {
    const prompt = renderReviewerDispatchPrompt(
      'reviewer',
      { ...FACTS, rulings: [RULING_WITH_EVERY_BANNED_PHRASE] },
      '/tmp/work'
    )
    expect(prompt).toContain(`1. ${RULING_WITH_EVERY_BANNED_PHRASE}`)
  })

  it("renders an Issue's objectives and a brief revision carrying banned words, rather than refusing them", () => {
    const prompt = renderReviewerDispatchPrompt(
      'security',
      { ...FACTS, objectives: 'O1. The config scan clearly names every key.', revision: 'clearly-a-tag' },
      '/tmp/work'
    )
    expect(prompt).toContain('O1. The config scan clearly names every key.')
    expect(prompt).toContain('BRIEF REVISION: clearly-a-tag')
  })

  it('holds every interpolated fact out of the text the lint reads', () => {
    const pieces = buildReviewerPromptPieces({
      ...FACTS,
      objectives: 'O1. I think this is clearly fine.',
      rulings: [RULING_WITH_EVERY_BANNED_PHRASE]
    })
    const driverText = driverAuthoredPromptText(pieces)
    expect(lintReviewerPrompt(driverText)).toEqual([])
    expect(driverText).not.toContain('clearly')
    expect(driverText).not.toContain(RULING_WITH_EVERY_BANNED_PHRASE)
    expect(driverText).not.toContain(MANIFEST.headSha)
  })

  it("still refuses a banned word in the renderer's own fixed text", () => {
    const regressed: ReviewerPromptPiece[] = [
      { driver: 'OBJECTIVES (the developer says):\n' },
      { fact: 'O1. Do the thing.' },
      { driver: '\n\nHEAD: ' },
      { fact: MANIFEST.headSha }
    ]
    expect(lintReviewerPrompt(driverAuthoredPromptText(regressed))).toEqual([
      'banned framing matched: \\bthe developer says\\b'
    ])
  })

  it('never lets two fixed strings either side of a held-out fact read as one banned phrase', () => {
    const split: ReviewerPromptPiece[] = [{ driver: 'the developer ' }, { fact: 'O1' }, { driver: 'says' }]
    expect(lintReviewerPrompt(driverAuthoredPromptText(split))).toEqual([])
  })

  it('renders the same prompt text it always did — labels, blank lines and ruling numbering unchanged', () => {
    expect(renderReviewerPrompt({ ...FACTS, rulings: ['First ruling.', 'Second ruling.'] })).toBe(
      [
        'OBJECTIVES:',
        'O1. Do the thing.',
        '',
        'RULINGS ON THIS PR:',
        '1. First ruling.',
        '2. Second ruling.',
        '',
        `HEAD: ${'a'.repeat(40)}`,
        'CI: green',
        `BRIEF REVISION: ${'f'.repeat(40)}`
      ].join('\n')
    )
  })

  it("keeps the driver's own fallbacks for a task with no objectives and no rulings", () => {
    const rendered = renderReviewerPrompt({ ...FACTS, objectives: '   ', resolvedObjectives: [] })
    expect(rendered).toContain('OBJECTIVES:\n(none found on the Issue)')
    expect(rendered).toContain('RULINGS ON THIS PR:\n(none)')
  })
})

// --- the reviewer prompt carries its role doctrine (role-reach-v1 task 1) ----

describe('renderReviewerDispatchPrompt — carries the role doctrine as a fact', () => {
  const MANIFEST: ReviewInputManifest = {
    headSha: 'a'.repeat(40),
    baseSha: 'e'.repeat(40),
    briefHash: 'b'.repeat(64),
    objectivesVersion: 'c'.repeat(64),
    rulingOrdinal: 2,
    policyDigest: 'd'.repeat(64)
  }
  const FACTS: ReviewerPromptFacts = {
    objectives: 'O1. Do the thing.',
    resolvedObjectives: [{ id: 'O1', text: 'Do the thing.' }],
    rulings: [],
    ciConclusion: 'green',
    revision: 'f'.repeat(40),
    manifest: MANIFEST
  }
  const REVIEWER_DOCTRINE =
    'You judge one open pull request against the brief it came from.\n\n## What you check\n\n1. Does the code match the brief?\n2. Honest tests.'

  it('injects the resolved short version and "What you check" list into a reviewer prompt (O1)', () => {
    const prompt = renderReviewerDispatchPrompt('reviewer', FACTS, '/tmp/work', REVIEWER_DOCTRINE)
    expect(prompt).toContain('YOUR ROLE DOCTRINE')
    expect(prompt).toContain('for the code-reviewer role')
    expect(prompt).toContain('You judge one open pull request against the brief it came from.')
    expect(prompt).toContain('## What you check')
    expect(prompt).toContain('1. Does the code match the brief?')
    // The doctrine sits before the dispatch's own output instructions.
    expect(prompt.indexOf('YOUR ROLE DOCTRINE')).toBeLessThan(prompt.indexOf('Write your findings to'))
  })

  it('labels the block for the security reviewer when the role is security (O1)', () => {
    const prompt = renderReviewerDispatchPrompt(
      'security',
      FACTS,
      '/tmp/work',
      'You ask one question a correctness review does not.\n\n## What you check\n\n1. Secret / credential leakage.'
    )
    expect(prompt).toContain('for the security reviewer role')
    expect(prompt).toContain('1. Secret / credential leakage.')
  })

  it('injects no doctrine block when the doctrine is null — the pre-task shape, unchanged', () => {
    const withNull = renderReviewerDispatchPrompt('reviewer', FACTS, '/tmp/work', null)
    const withOmitted = renderReviewerDispatchPrompt('reviewer', FACTS, '/tmp/work')
    expect(withNull).not.toContain('YOUR ROLE DOCTRINE')
    expect(withNull).toBe(withOmitted)
  })

  // O3: an adopter override (or even a core body) whose own wording matches a
  // banned phrase must render, not crash every round. The short versions today
  // literally say a reviewer posts comments and "writes nothing to disk".
  const DOCTRINE_WITH_BANNED_PHRASES =
    'You judge the PR. The developer says it is done, and clearly it works.\n\n' +
    '## What you check\n\n1. In my opinion, check that the PR body says what the brief asked.'

  it('renders a role doctrine carrying banned phrases, verbatim, instead of ending the round (O3)', () => {
    const render = () => renderReviewerDispatchPrompt('reviewer', FACTS, '/tmp/work', DOCTRINE_WITH_BANNED_PHRASES)
    expect(render).not.toThrow()
    const prompt = render()
    expect(prompt).toContain('The developer says it is done, and clearly it works.')
    expect(prompt).toContain('In my opinion, check that the PR body says what the brief asked.')
  })

  it('holds the injected doctrine out of the text the banned-framing lint reads (O3)', () => {
    const pieces = [
      ...buildReviewerPromptPieces(FACTS),
      ...roleDoctrinePieces('reviewer', DOCTRINE_WITH_BANNED_PHRASES)
    ]
    const driverText = driverAuthoredPromptText(pieces)
    expect(lintReviewerPrompt(driverText)).toEqual([])
    expect(driverText).not.toContain('clearly')
    expect(driverText).not.toContain('In my opinion')
    expect(driverText).not.toContain('The developer says')
  })

  it('carries one precedence sentence: the dispatch output instructions win over the doctrine wording (O4)', () => {
    const prompt = renderReviewerDispatchPrompt('reviewer', FACTS, '/tmp/work', REVIEWER_DOCTRINE)
    expect(prompt).toContain('the dispatch instructions below take precedence')
    expect(prompt).toContain('writing nothing to disk')
    // The precedence sentence sits between the doctrine and the file-writing instructions.
    const doctrineAt = prompt.indexOf('YOUR ROLE DOCTRINE')
    const precedenceAt = prompt.indexOf('take precedence')
    const findingsAt = prompt.indexOf('Write your findings to')
    expect(doctrineAt).toBeLessThan(precedenceAt)
    expect(precedenceAt).toBeLessThan(findingsAt)
  })

  it('the precedence sentence is driver text the lint reads, and carries no banned phrase (O4)', () => {
    const pieces = roleDoctrinePieces('security', 'A short version.\n\n## What you check\n\n1. Secrets.')
    const driverText = driverAuthoredPromptText(pieces)
    expect(driverText).toContain('take precedence')
    expect(lintReviewerPrompt(driverText)).toEqual([])
  })
})

// --- the deferral rules the loop's classifier applies (convergence-v1 task 1, #853) ---

describe('deferral helpers (O2/O3)', () => {
  it('parseFindingLocation splits file:line, tolerates a bare file and a file:line:col', () => {
    expect(parseFindingLocation('a/b.ts:42')).toEqual({ file: 'a/b.ts', line: 42 })
    expect(parseFindingLocation('a/b.ts')).toEqual({ file: 'a/b.ts', line: null })
    expect(parseFindingLocation('a/b.ts:42:7')).toEqual({ file: 'a/b.ts', line: 42 })
  })

  it('parseChangedLines reads --unified=0 hunks into per-file new-side line sets', () => {
    const diff = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -10,0 +11,2 @@',
      '+added one',
      '+added two',
      'diff --git a/y.ts b/y.ts',
      '--- a/y.ts',
      '+++ b/y.ts',
      '@@ -5 +5 @@',
      '-old',
      '+new'
    ].join('\n')
    const changed = parseChangedLines(diff)
    expect([...(changed.get('x.ts') ?? [])].sort((a, b) => a - b)).toEqual([11, 12])
    expect([...(changed.get('y.ts') ?? [])]).toEqual([5])
    expect(changed.has('z.ts')).toBe(false)
  })

  it('makeChangedLinePredicate: file-level on a changed file counts as changed; an unchanged line does not', () => {
    const changed = new Map([['x.ts', new Set([11, 12])]])
    const pred = makeChangedLinePredicate(changed)
    expect(pred('x.ts:11')).toBe(true)
    expect(pred('x.ts:99')).toBe(false)
    expect(pred('x.ts')).toBe(true) // file-level on a changed file
    expect(pred('other.ts:1')).toBe(false) // file never changed
  })

  it('makeInSurfacePredicate uses globCoversPath over the finding file', () => {
    const pred = makeInSurfacePredicate(['packages/aeg-core/src', 'apps/cli/src/lib'])
    expect(pred('packages/aeg-core/src/x.ts:1')).toBe(true)
    expect(pred('apps/log-server/y.ts:1')).toBe(false)
  })

  it('buildRoundDeferralContext: round 1 leaves changedLine inactive; a surface activates inSurface any round', () => {
    const ctx1 = buildRoundDeferralContext({
      round: 1,
      previousRoundHead: null,
      head: 'h1',
      surface: { in: ['packages/aeg-core/src'], out: [] },
      unifiedDiff: () => 'diff'
    })
    expect(ctx1.changedLine).toBeUndefined()
    expect(ctx1.inSurface?.('packages/aeg-core/src/a.ts:1')).toBe(true)

    const ctx2 = buildRoundDeferralContext({
      round: 2,
      previousRoundHead: 'h1',
      head: 'h2',
      surface: null,
      unifiedDiff: (_from, _to) => '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n+one\n'
    })
    expect(ctx2.inSurface).toBeUndefined()
    expect(ctx2.changedLine?.('x.ts:1')).toBe(true)
    expect(ctx2.changedLine?.('x.ts:99')).toBe(false)
  })

  it('buildRoundDeferralContext leaves changedLine inactive when the head did not move or the diff is unreadable', () => {
    expect(
      buildRoundDeferralContext({ round: 2, previousRoundHead: 'h', head: 'h', surface: null, unifiedDiff: () => 'x' })
        .changedLine
    ).toBeUndefined()
    expect(
      buildRoundDeferralContext({
        round: 2,
        previousRoundHead: 'h1',
        head: 'h2',
        surface: null,
        unifiedDiff: () => null
      }).changedLine
    ).toBeUndefined()
  })
})

describe('buildVerdictFromReport — deferral context (O2/O3/O4)', () => {
  let workDir: string
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'vinaya-defer-verdict-'))
  })
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  const MANIFEST: ReviewInputManifest = {
    headSha: 'a'.repeat(40),
    baseSha: 'e'.repeat(40),
    briefHash: 'b'.repeat(64),
    objectivesVersion: null,
    rulingOrdinal: 0,
    policyDigest: 'd'.repeat(64)
  }
  const HANDLE: DispatchHandle = {
    exitCode: 0,
    durationMs: 100,
    usage: { input: 10, output: 5 },
    resumeId: 'session-1',
    timedOut: false
  }
  const MAJOR_POLICY = {
    codeReviewThreshold: 'MAJOR',
    securityThreshold: 'HIGH',
    maxRounds: 3,
    maxTaskMinutes: 180
  } as const

  function writeReviewer(): void {
    writeFileSync(
      join(workDir, 'findings.txt'),
      'MAJOR|packages/aeg-core/src/x.ts:99|perf regression on unchanged code'
    )
    writeFileSync(
      join(workDir, 'report.txt'),
      'BRIEF_CONFORMANCE: clean\nSPEC_CONFORMANCE: clean\nSCOPE: small\nTESTS: honest\nDOCS: n/a\nFINDING_IDS: F1'
    )
  }

  it('an unchanged-line MAJOR is deferred: verdict APPROVE, recorded on the observation, absent from the comment', () => {
    writeReviewer()
    const result = buildVerdictFromReport('reviewer', workDir, 'claude', 853, HANDLE, MANIFEST, MAJOR_POLICY, [], {
      changedLine: () => false
    })
    expect(result.observation.verdict).toBe('APPROVE')
    expect(result.observation.findings).toHaveLength(1)
    expect(result.observation.findings[0]).toMatchObject({
      severity: 'MAJOR',
      location: 'packages/aeg-core/src/x.ts:99',
      policyTreatment: 'non_blocking',
      deferred: 'unchanged-line'
    })
    // the deferred finding never reaches the published comment's FINDINGS
    // block, so a contextless merge gate reading it sees the clean APPROVE too
    expect(result.rendered).not.toContain('x.ts:99')
  })

  it('the same finding on a changed line blocks: verdict REQUEST CHANGES, present in the comment', () => {
    writeReviewer()
    const result = buildVerdictFromReport('reviewer', workDir, 'claude', 853, HANDLE, MANIFEST, MAJOR_POLICY, [], {
      changedLine: () => true
    })
    expect(result.observation.verdict).toBe('REQUEST CHANGES')
    expect(result.observation.findings[0]).toMatchObject({ policyTreatment: 'blocking' })
    expect(result.observation.findings[0]?.deferred).toBeUndefined()
    expect(result.rendered).toContain('x.ts:99')
  })

  it('with no context (round 1), the finding blocks as before', () => {
    writeReviewer()
    const result = buildVerdictFromReport('reviewer', workDir, 'claude', 853, HANDLE, MANIFEST, MAJOR_POLICY, [])
    expect(result.observation.verdict).toBe('REQUEST CHANGES')
  })
})

describe('buildVerdictFromReport — the security SECRETS: line follows the same rule as review post', () => {
  let workDir: string
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'rd-secrets-'))
    writeFileSync(join(workDir, 'findings.txt'), '')
  })
  afterEach(() => rmSync(workDir, { recursive: true, force: true }))

  const MANIFEST: ReviewInputManifest = {
    headSha: 'a'.repeat(40),
    baseSha: 'e'.repeat(40),
    briefHash: 'b'.repeat(64),
    objectivesVersion: 'c'.repeat(64),
    rulingOrdinal: 0,
    policyDigest: 'd'.repeat(64)
  }
  const HANDLE: DispatchHandle = {
    exitCode: 0,
    durationMs: 100,
    usage: { input: 10, output: 5 },
    resumeId: 'session-1',
    timedOut: false
  }

  it('refuses a bare "none found" that cites no secret-scan check result', () => {
    writeFileSync(join(workDir, 'report.txt'), 'CONFIG_SCAN: clean\nSECRETS: none found')
    expect(() =>
      buildVerdictFromReport('security', workDir, 'claude', 764, HANDLE, MANIFEST, DEFAULT_REVIEW_POLICY, [])
    ).toThrow(/atta-labs\/secret-scan/)
  })

  it('accepts a "none found" that cites the required check', () => {
    writeFileSync(join(workDir, 'report.txt'), 'CONFIG_SCAN: clean\nSECRETS: none found — atta-labs/secret-scan passed')
    const result = buildVerdictFromReport(
      'security',
      workDir,
      'claude',
      764,
      HANDLE,
      MANIFEST,
      DEFAULT_REVIEW_POLICY,
      []
    )
    expect(result.rendered).toContain('SECRETS: none found — atta-labs/secret-scan passed')
  })
})

// --- the agent-configuration security scan (role-reach-v1 task 5) -----------

describe('touchesAgentConfig — applicability from the fixed path list (O1)', () => {
  it('is true for a change under any agent-config glob', () => {
    expect(touchesAgentConfig(['.claude/settings.json'])).toBe(true)
    expect(touchesAgentConfig(['.mcp.json'])).toBe(true)
    expect(touchesAgentConfig(['.agents/skills/x/skill.md'])).toBe(true)
    expect(touchesAgentConfig(['src/foo.ts', '.mcp.json'])).toBe(true)
  })

  it('is false for a change that touches no agent configuration', () => {
    expect(touchesAgentConfig([])).toBe(false)
    expect(touchesAgentConfig(['src/foo.ts', 'README.md'])).toBe(false)
    // A sibling path that merely shares a prefix is not agent config.
    expect(touchesAgentConfig(['claude/notes.md', 'mcp.json.bak'])).toBe(false)
  })

  it('exposes the fixed glob list', () => {
    expect([...AGENT_CONFIG_GLOBS]).toEqual(['.claude/**', '.mcp.json', '.agents/**'])
  })
})

describe('decideSecurityScan — the four outcomes (O1/O3)', () => {
  const ran = () => ({ ok: true as const, output: 'scanner: 0 findings' })
  const neverRun = () => {
    throw new Error('runScan must not be called')
  }

  it('is not_configured when no command is set — ahead of applicability', () => {
    const out = decideSecurityScan({
      command: null,
      changedPaths: ['.mcp.json'],
      candidateDir: '/tmp/candidate',
      runScan: neverRun
    })
    expect(out).toEqual({ kind: 'not_configured' })
  })

  it('is not_applicable when the change touches no agent config, without running the scanner', () => {
    const out = decideSecurityScan({
      command: ['scan'],
      changedPaths: ['src/foo.ts'],
      candidateDir: '/tmp/candidate',
      runScan: neverRun
    })
    expect(out).toEqual({ kind: 'not_applicable' })
  })

  it('is failed (never a pause) when a configured, in-scope scan has no candidate copy to scan', () => {
    const out = decideSecurityScan({
      command: ['scan'],
      changedPaths: ['.mcp.json'],
      candidateDir: null,
      runScan: neverRun
    })
    expect(out).toEqual({ kind: 'failed', reason: 'no head-verified candidate copy to scan' })
  })

  it('runs the scanner and returns its (capped) output when configured and in scope', () => {
    const calls: Array<{ command: readonly string[]; cwd: string }> = []
    const out = decideSecurityScan({
      command: ['npx', '--yes', 'ecc-agentshield@1.6.0', 'scan'],
      changedPaths: ['.claude/hooks/x.ts'],
      candidateDir: '/tmp/candidate',
      runScan: (command, cwd) => {
        calls.push({ command, cwd })
        return ran()
      }
    })
    expect(out).toEqual({ kind: 'ran', output: 'scanner: 0 findings' })
    expect(calls).toEqual([{ command: ['npx', '--yes', 'ecc-agentshield@1.6.0', 'scan'], cwd: '/tmp/candidate' }])
  })

  it('is failed when the runner reports it could not run', () => {
    const out = decideSecurityScan({
      command: ['scan'],
      changedPaths: ['.mcp.json'],
      candidateDir: '/tmp/candidate',
      runScan: () => ({ ok: false, reason: 'scanner timed out after 120000ms' })
    })
    expect(out).toEqual({ kind: 'failed', reason: 'scanner timed out after 120000ms' })
  })

  it('caps a ran scan output to the prompt ceiling', () => {
    const huge = 'x'.repeat(SECURITY_SCAN_OUTPUT_MAX_CHARS + 5000)
    const out = decideSecurityScan({
      command: ['scan'],
      changedPaths: ['.mcp.json'],
      candidateDir: '/tmp/candidate',
      runScan: () => ({ ok: true, output: huge })
    })
    expect(out.kind).toBe('ran')
    if (out.kind === 'ran') {
      expect(out.output.length).toBeLessThan(huge.length)
      expect(out.output).toContain('earlier characters truncated')
    }
  })
})

describe('capSecurityScanOutput — bounds only an over-long scan (O2)', () => {
  it('returns short output unchanged', () => {
    expect(capSecurityScanOutput('clean')).toBe('clean')
  })
  it('keeps the tail and notes the drop for over-long output', () => {
    const capped = capSecurityScanOutput('a'.repeat(SECURITY_SCAN_OUTPUT_MAX_CHARS + 100))
    expect(capped).toContain('100 earlier characters truncated')
    expect(capped.endsWith('a'.repeat(50))).toBe(true)
  })
})

describe('securityScanPieces / renderReviewerDispatchPrompt — the scan reaches the security prompt only (O1/O3)', () => {
  const MANIFEST: ReviewInputManifest = {
    headSha: 'a'.repeat(40),
    baseSha: 'e'.repeat(40),
    briefHash: 'b'.repeat(64),
    objectivesVersion: 'c'.repeat(64),
    rulingOrdinal: 0,
    policyDigest: 'd'.repeat(64)
  }
  const FACTS: ReviewerPromptFacts = {
    objectives: 'O1. Do the thing.',
    resolvedObjectives: [{ id: 'O1', text: 'Do the thing.' }],
    rulings: [],
    ciConclusion: 'green',
    revision: 'f'.repeat(40),
    manifest: MANIFEST
  }

  it('contributes nothing when no scan was decided', () => {
    expect(securityScanPieces(undefined)).toEqual([])
  })

  it("renders the scanner's output for the security pass, as a fact piece", () => {
    const scan: SecurityScanOutcome = { kind: 'ran', output: 'agentshield: 1 finding — over-broad tool grant' }
    const prompt = renderReviewerDispatchPrompt('security', { ...FACTS, configScan: scan }, '/tmp/work')
    expect(prompt).toContain('AGENT-CONFIG SCAN')
    expect(prompt).toContain('agentshield: 1 finding — over-broad tool grant')
    // Driver-only text (the lint's subject) never carries the scanner's output.
    const pieces = [...buildReviewerPromptPieces({ ...FACTS, configScan: scan }), ...securityScanPieces(scan)]
    expect(driverAuthoredPromptText(pieces)).not.toContain('over-broad tool grant')
  })

  it('never shows the scan to the code-reviewer', () => {
    const scan: SecurityScanOutcome = { kind: 'ran', output: 'agentshield output' }
    const prompt = renderReviewerDispatchPrompt('reviewer', { ...FACTS, configScan: scan }, '/tmp/work')
    expect(prompt).not.toContain('AGENT-CONFIG SCAN')
    expect(prompt).not.toContain('agentshield output')
  })

  it('tells the security pass which non-ran reason it was', () => {
    const notConfigured = renderReviewerDispatchPrompt(
      'security',
      { ...FACTS, configScan: { kind: 'not_configured' } },
      '/tmp/work'
    )
    expect(notConfigured).toContain('no scanner is configured')

    const notApplicable = renderReviewerDispatchPrompt(
      'security',
      { ...FACTS, configScan: { kind: 'not_applicable' } },
      '/tmp/work'
    )
    expect(notApplicable).toContain('not applicable')

    const failed = renderReviewerDispatchPrompt(
      'security',
      { ...FACTS, configScan: { kind: 'failed', reason: 'scanner timed out after 120000ms' } },
      '/tmp/work'
    )
    expect(failed).toContain('could not run')
    expect(failed).toContain('scanner timed out after 120000ms')
  })

  it('an injected scan with a banned phrase in its output never ends the round', () => {
    const scan: SecurityScanOutcome = { kind: 'ran', output: 'the finding is clearly a leak — in my opinion' }
    // Would throw if the lint read the fact piece; it must not.
    const prompt = renderReviewerDispatchPrompt('security', { ...FACTS, configScan: scan }, '/tmp/work')
    expect(prompt).toContain('the finding is clearly a leak')
  })
})
