// The layer-G re-cut: each layer-P field maps to its neutral field, a
// reviewer case only the Vinaya process can state keeps no G form, a held-out
// statement is generated free of process terms, and re-running the re-cut on
// unchanged inputs reproduces every derived file byte for byte. Held-out
// files are compared by digest only, so no assertion can print their content.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'
import { findBannedTerms } from '../../src/lib/dev-review-eval/banned-terms'
import { validateNeutralCase } from '../../src/lib/dev-review-eval/neutral-case'
import { loadCaseFile as loadDeveloperCaseFile } from './developer-capability-suite'
import {
  DERIVED_FILES,
  DEVELOPER_CAPABILITIES,
  deriveDeveloperCase,
  deriveReviewerCase,
  deriveSourceCitationCase,
  generatedDeveloperStatement,
  generatedReviewerStatement,
  generatedSourceCitationStatement,
  GENERIC_SUITE_IDS,
  LAYER_P_ONLY_DEFECT_KINDS,
  main,
  recutDevelopment,
  recutHeldOut,
  repositoryGit,
  seededHead,
  STATEMENTS_PATH,
  surfaceEntryPaths
} from './recut-generic-cases'
import { loadDevelopment as loadReviewerDevelopment, type ReviewCase } from './reviewer-quality-suite'
import {
  HeldOutRefused,
  loadCaseFile as loadSourceCitationCaseFile,
  type SourceCitationCase
} from './source-citation-suite'

const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const developerFile = loadDeveloperCaseFile()
const developerCases = developerFile.cases
const reviewerCases = [
  ...loadReviewerDevelopment('code-reviewer').cases,
  ...loadReviewerDevelopment('security-reviewer').cases
]
const citationFile = loadSourceCitationCaseFile()
const approvals = {
  developer: developerFile.splits.heldOut.digest,
  reviewer: loadReviewerDevelopment('code-reviewer').split.heldOutDigest,
  sourceCitation: citationFile.splits.heldOut.digest
}
const statements = JSON.parse(readFileSync(STATEMENTS_PATH, 'utf8')) as Record<string, string>
const caseById = <T extends { id: string }>(cases: readonly T[], id: string) => cases.find((c) => c.id === id) as T

describe('the development task statements', () => {
  it('name every development case that has a G form, each free of process terms and verbatim in the derived case', () => {
    const gForm = [
      ...developerCases.map((c) => c.id),
      ...reviewerCases
        .filter((c) => c.expected === null || !LAYER_P_ONLY_DEFECT_KINDS.includes(c.expected.kind))
        .map((c) => c.id),
      ...citationFile.cases.map((c) => c.id)
    ]
    expect(Object.keys(statements).sort()).toEqual([...gForm].sort())
    for (const [id, statement] of Object.entries(statements)) {
      expect({ id, banned: findBannedTerms(statement) }).toEqual({ id, banned: [] })
    }
    const derived = recutDevelopment().files.flatMap(
      (f) => (JSON.parse(f.text) as { suites: { cases: { id: string; taskStatement: string }[] }[] }).suites
    )
    for (const c of derived.flatMap((s) => s.cases)) expect(c.taskStatement).toBe(statements[c.id] as string)
  })
})

describe('the developer mapping', () => {
  it('writes each Surface entry as the paths it covers', () => {
    expect(surfaceEntryPaths('apps/cli/src/**')).toBe('apps/cli/src')
    expect(surfaceEntryPaths('apps/cli/src/*')).toBe('apps/cli/src')
    expect(surfaceEntryPaths('apps/cli/src')).toBe('apps/cli/src')
    expect(surfaceEntryPaths('apps/cli/specs/log-sync.md')).toBe('apps/cli/specs/log-sync.md')
    expect(surfaceEntryPaths('*')).toBe('*')
  })

  it('drops the issue, pull request and brief, maps in: to in and out: to excluded, and keeps the tests and solution', () => {
    const p = caseById(developerCases, 'pr-1060')
    const { case: g, undeliverable } = deriveDeveloperCase(repositoryGit, p, statements[p.id] as string)
    expect(Object.keys(g)).not.toContain('issue')
    expect(Object.keys(g)).not.toContain('pullRequest')
    expect(Object.keys(g)).not.toContain('brief')
    expect(g.baseRevision).toBe(p.baseCommit)
    expect(g.authorizedScope).toEqual({ in: p.scope.in, excluded: p.scope.out, protected: [] })
    expect(g.referenceSolution).toEqual({ patchDigest: p.referenceSolution.digest })
    expect(g.grantedCapabilities).toEqual([...DEVELOPER_CAPABILITIES])
    const failToPass = Object.values(p.failToPass).flat().length
    expect(g.hiddenTests.filter((t) => t.expectation === 'fail-to-pass').length).toBe(failToPass)
    expect(g.hiddenTests.filter((t) => t.expectation === 'pass-to-pass').length).toBe(
      p.passToPass.reduce((n, entry) => n + entry.digests.length / 12, 0)
    )
    // A required source becomes a delivered document pinned by its content at the base commit.
    const content = repositoryGit(['cat-file', 'blob', `${p.baseCommit}:apps/cli/specs/log-sync.md`])
    expect(g.deliveredDocuments).toEqual([
      { id: 'apps/cli/specs/log-sync.md', contentDigest: sha256(content), relevant: true }
    ])
    expect(undeliverable).toBe(0)
    expect(validateNeutralCase(g).ok).toBe(true)
  })

  it('delivers no document for a source whose content the corpus cannot pin, and counts it', () => {
    const p = developerCases.find((c) => c.requiredSources.some((s) => s.startsWith('https://')))
    if (p === undefined) throw new Error('expected a development case with a web source')
    const { case: g, undeliverable } = deriveDeveloperCase(repositoryGit, p, 'Make the change.')
    expect(undeliverable).toBe(p.requiredSources.filter((s) => s.startsWith('https://')).length)
    expect(g.deliveredDocuments.map((d) => d.id)).toEqual(p.requiredSources.filter((s) => !s.startsWith('https://')))
  })

  it('generates a held-out statement from the case fields, free of process terms', () => {
    for (const p of developerCases) {
      const statement = generatedDeveloperStatement(p)
      expect({ id: p.id, banned: findBannedTerms(statement) }).toEqual({ id: p.id, banned: [] })
      expect(statement).toContain(`${Object.keys(p.failToPass).length} file`)
    }
    // A scope naming a process term is left out of the statement, never written into it.
    const named = { ...caseById(developerCases, 'pr-1060'), scope: { in: ['aeg-root/roles/developer.md'], out: [] } }
    expect(findBannedTerms(generatedDeveloperStatement(named))).toEqual([])
  })
})

describe('the reviewer mapping', () => {
  it('keeps every case whose defect kind only the Vinaya process states layer P only', () => {
    for (const c of reviewerCases) {
      const g = deriveReviewerCase(repositoryGit, c, 'Review this change.')
      const pOnly = c.expected !== null && LAYER_P_ONLY_DEFECT_KINDS.includes(c.expected.kind)
      expect({ id: c.id, gForm: g !== null }).toEqual({ id: c.id, gForm: !pOnly })
    }
    expect(reviewerCases.some((c) => c.expected?.kind === 'beyond-surface')).toBe(true)
    expect(reviewerCases.some((c) => c.expected?.kind === 'objective-unmet')).toBe(true)
  })

  it('makes a severity blocking, critical exactly for a seeded critical or high security defect, and drops the objectives', () => {
    for (const c of reviewerCases) {
      const g = deriveReviewerCase(repositoryGit, c, 'Review this change.')
      if (g === null) continue
      expect(Object.keys(g)).not.toContain('objectives')
      expect(g.baseRevision).toBe(c.baseCommit)
      expect(g.changeUnderReview.patchDigest).toBe(c.patch.digest)
      expect(g.authorizedScope).toEqual({ in: [c.patch.file], excluded: [], protected: [] })
      if (c.expected === null) {
        expect(g.plantedDefects).toEqual([])
        expect(g.adjudication.clean).toBe(true)
        continue
      }
      const critical = c.role === 'security-reviewer' && ['CRITICAL', 'HIGH'].includes(c.expected.severity)
      expect({ id: c.id, defects: g.plantedDefects }).toEqual({
        id: c.id,
        defects: [{ file: c.expected.file, kind: c.expected.kind, blocking: true, critical, justified: false }]
      })
      expect(validateNeutralCase(g).ok).toBe(true)
    }
    const code = caseById(reviewerCases, 'code-logic') as ReviewCase
    const asSecurityMedium: ReviewCase = {
      ...code,
      role: 'security-reviewer',
      expected: { ...(code.expected as NonNullable<ReviewCase['expected']>), severity: 'MEDIUM' }
    }
    const medium = deriveReviewerCase(repositoryGit, asSecurityMedium, 'Review this change.')
    expect(medium?.plantedDefects[0]).toMatchObject({ blocking: false, critical: false })
  })

  it('pins a seeded change by the reproducible commit that applies its patch to its base', () => {
    const seeded = caseById(reviewerCases, 'code-logic')
    if (seeded.patch.source !== 'inline') throw new Error('expected an inline seeded patch')
    const head = seededHead(repositoryGit, seeded.baseCommit, seeded.patch.unified, seeded.id)
    expect(head).toMatch(/^[0-9a-f]{40}$/)
    expect(seededHead(repositoryGit, seeded.baseCommit, seeded.patch.unified, seeded.id)).toBe(head)
    expect(deriveReviewerCase(repositoryGit, seeded, 'Review this change.')?.changeUnderReview.head).toBe(head)
    // The commit is made in a scratch object directory: the repository does not gain it.
    expect(() => repositoryGit(['cat-file', '-e', head])).toThrow()
  })

  it('generates a held-out statement free of process terms, naming the file only when it is free of them', () => {
    for (const c of reviewerCases) expect(findBannedTerms(generatedReviewerStatement(c))).toEqual([])
    const named = {
      ...caseById(reviewerCases, 'code-logic'),
      patch: { ...caseById(reviewerCases, 'code-logic').patch, file: 'aeg-root/roles/reviewer.md' }
    }
    expect(generatedReviewerStatement(named as ReviewCase)).toBe(
      'Review this change for defects against the base revision.'
    )
  })
})

describe('the source-citation mapping', () => {
  it('derives an answer case with an empty scope, each source pinned by its content, read_document only for retrieval', () => {
    for (const p of citationFile.cases) {
      const g = deriveSourceCitationCase(citationFile.repositoryCommit, p, statements[p.id] as string)
      expect(g.kind).toBe('answer')
      expect(g.baseRevision).toBe(citationFile.repositoryCommit)
      expect(g.authorizedScope).toEqual({ in: [], excluded: [], protected: [] })
      expect(g.deliveredDocuments).toEqual(
        p.sources.map((s) => ({ id: s.sourceId, contentDigest: sha256(s.content), relevant: s.relevant }))
      )
      const retrieval = p.sources.some((s) => s.deliveryMode === 'retrieval_tool')
      expect({ id: p.id, granted: g.grantedCapabilities }).toEqual({
        id: p.id,
        granted: retrieval ? ['read_document'] : []
      })
      expect(validateNeutralCase(g).ok).toBe(true)
    }
    expect(citationFile.cases.some((p) => p.sources.every((s) => s.deliveryMode === 'injected'))).toBe(true)
  })
})

describe('re-running the re-cut', () => {
  it('reproduces every development file byte for byte', () => {
    for (const file of recutDevelopment().files) {
      expect({ file: file.path, sha256: sha256(file.text) }).toEqual({
        file: file.path,
        sha256: sha256(readFileSync(file.path))
      })
    }
  })

  it('reproduces every held-out file byte for byte, compared by digest only', () => {
    const recut = recutHeldOut(approvals)
    expect(recut.files.map((f) => f.path)).toEqual([
      DERIVED_FILES.developer.heldOut,
      DERIVED_FILES.reviewer.heldOut,
      DERIVED_FILES.sourceCitation.heldOut
    ])
    for (const file of recut.files) {
      expect({ file: file.path, sha256: sha256(file.text) }).toEqual({
        file: file.path,
        sha256: sha256(readFileSync(file.path))
      })
    }
    // Its summary carries counts, ids and digests only.
    expect(Object.keys(recut.summary).sort()).toEqual(['files', 'heldOutIds'])
    for (const entry of recut.summary.files) {
      expect(Object.keys(entry).sort()).toEqual(['cases', 'file', 'layerPOnly', 'sha256', 'undeliverableSources'])
    }
    // The source-citation file holds one answer case per pinned held-out index entry, listed by id alone.
    const ids = recut.summary.heldOutIds?.[GENERIC_SUITE_IDS.sourceCitation]
    expect(ids).toEqual(citationFile.splits.heldOut.index.map((entry) => entry.id))
    expect(recut.summary.files.at(-1)?.cases).toEqual({ [GENERIC_SUITE_IDS.sourceCitation]: ids?.length ?? 0 })
  })

  it('opens no source-citation held-out file for a wrong approval, and the run writes and prints no case content', () => {
    const wrong = { ...approvals, sourceCitation: 'f'.repeat(64) }
    expect(() => recutHeldOut(wrong)).toThrow(HeldOutRefused)
    const printed: string[] = []
    const write = process.stdout.write
    const err = process.stderr.write
    const capture = ((chunk: string) => printed.push(String(chunk)) > 0) as unknown as typeof process.stdout.write
    process.stdout.write = capture
    process.stderr.write = capture
    try {
      expect(
        main([
          'held-out',
          '--approve-developer',
          approvals.developer,
          '--approve-reviewer',
          approvals.reviewer,
          '--approve-source-citation',
          'f'.repeat(64)
        ])
      ).toBe(1)
    } finally {
      process.stdout.write = write
      process.stderr.write = err
    }
    expect(printed.join('')).not.toContain('"taskStatement"')
  })

  it('generates a held-out source-citation statement from a fixture case, free of process terms', () => {
    const fixture = {
      ...citationFile.cases[0],
      sources: [...(citationFile.cases[0]?.sources ?? []), ...(citationFile.cases[0]?.sources ?? [])].slice(0, 2)
    } as SourceCitationCase
    expect(generatedSourceCitationStatement(fixture)).toContain('2 documents')
    expect(findBannedTerms(generatedSourceCitationStatement(fixture))).toEqual([])
    expect(findBannedTerms(generatedSourceCitationStatement({ ...fixture, sources: [] }))).toEqual([])
  })

  it('refuses a held-out run without the pinned approvals, before opening any held-out file', () => {
    const write = process.stdout.write
    const err = process.stderr.write
    const printed: string[] = []
    const capture = ((chunk: string) => printed.push(String(chunk)) > 0) as unknown as typeof process.stdout.write
    process.stdout.write = capture
    process.stderr.write = capture
    try {
      expect(main(['held-out', '--approve-developer', 'f'.repeat(64), '--approve-reviewer', 'f'.repeat(64)])).toBe(1)
      expect(
        main(['held-out', '--approve-developer', approvals.developer, '--approve-reviewer', approvals.reviewer])
      ).toBe(1)
      expect(main(['held-out'])).toBe(1)
      expect(main(['other'])).toBe(2)
    } finally {
      process.stdout.write = write
      process.stderr.write = err
    }
    expect(printed.join('')).not.toContain('"taskStatement"')
  })
})
