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
  buildManifestRecord,
  buildReviewerPromptPieces,
  buildVerdictFromReport,
  controlStoreRootFor,
  driverAuthoredPromptText,
  lintReviewerPrompt,
  persistManifestRecord,
  renderReviewerDispatchPrompt,
  renderReviewerPrompt,
  ReviewerReportParseFailure
} from '../../../src/lib/dev-review-loop/reviewer-dispatch'
import type { ReviewerPromptFacts, ReviewerPromptPiece } from '../../../src/lib/dev-review-loop/reviewer-dispatch'

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
