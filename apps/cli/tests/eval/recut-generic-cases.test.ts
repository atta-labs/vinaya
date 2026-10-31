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
import { type DeveloperCapabilityCase, loadCaseFile as loadDeveloperCaseFile } from './developer-capability-suite'
import {
  answerCapabilities,
  DERIVED_FILES,
  DEVELOPER_CAPABILITIES,
  deriveDeveloperCase,
  deriveLoopCase,
  deriveReviewerCase,
  deriveSourceCitationCase,
  generatedDeveloperStatement,
  generatedReviewerStatement,
  generatedSourceCitationStatement,
  GENERIC_SUITE_IDS,
  type Git,
  interfaceBlock,
  interfaceItems,
  LAYER_P_ONLY_DEFECT_KINDS,
  LOOP_CAPABILITIES,
  loadRevisionFacts,
  loopVariants,
  main,
  RecutRefused,
  REVIEWER_CAPABILITIES,
  recutDevelopment,
  recutHeldOut,
  repositoryGit,
  seededHead,
  STATEMENTS_PATH,
  surfaceEntryPaths,
  withInterface
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

/**
 * Longest a test that derives a whole split may run: it reads every pinned
 * blob of the split's cases through git and searches each case's base, which
 * exceeds the default per-test budget on a slow or loaded host.
 */
const RECUT_BUDGET_MS = 300_000

/**
 * The held-out files the current derivation writes differently from their
 * committed bytes — the Interface blocks and the injected-source grant — and
 * that only the held-out re-cut, run under the three approvals, may rewrite.
 */
const HELD_OUT_AWAITING_RECUT: readonly string[] = [
  DERIVED_FILES.developer.heldOut,
  DERIVED_FILES.sourceCitation.heldOut,
  DERIVED_FILES.wholeLoop.heldOut
]

describe('the development task statements', () => {
  it(
    'name every development case that has a G form, each free of process terms and verbatim in the derived case',
    () => {
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
      // A developer case and its loop case end the statement with the case's Interface block; any other is verbatim.
      const developerIds = new Set(developerCases.map((c) => c.id))
      const blocks = new Map(developerCases.map((c) => [c.id, interfaceBlock(interfaceItems(repositoryGit, c))]))
      for (const c of derived.flatMap((s) => s.cases)) {
        const block = developerIds.has(c.id) ? (blocks.get(c.id) as string) : ''
        expect({ id: c.id, statement: c.taskStatement }).toEqual({
          id: c.id,
          statement: `${statements[c.id] as string}${block}`
        })
        expect({ id: c.id, lineBreak: /[\r\n]/.test(c.taskStatement) }).toEqual({ id: c.id, lineBreak: false })
      }
    },
    RECUT_BUDGET_MS
  )
})

/** A git that serves a fixture case's blobs and base tree, and searches the base tree as `git grep -F -o -h` does. */
function fixtureGit(blobs: Record<string, string>, baseTree: Record<string, string>): Git {
  return (args, options = {}) => {
    if (args[0] === 'cat-file' && args[1] === 'blob') {
      const source = blobs[args[2] as string]
      if (source === undefined) throw new RecutRefused('git cat-file failed')
      return Buffer.from(source)
    }
    if (args[0] === 'ls-tree')
      return Buffer.from(
        Object.entries(baseTree)
          .map(([path, blob]) => `100644 blob ${blob}\t${path}\0`)
          .join('')
      )
    if (args[0] === 'grep') {
      const patterns = args.flatMap((arg, i) => (args[i - 1] === '-e' ? [arg] : []))
      const skipped = args.filter((arg) => arg.startsWith(':(exclude)')).map((arg) => arg.slice(':(exclude)'.length))
      const searched = Object.entries(baseTree)
        .filter(([path]) => !skipped.includes(path))
        .map(([, blob]) => blobs[blob] as string)
      const found = patterns.filter((p) => searched.some((source) => source.includes(p)))
      if (found.length === 0) {
        if (options.quietExit === 1) return new Uint8Array()
        throw new RecutRefused('git grep failed')
      }
      return Buffer.from(found.map((p) => `${p}\n`).join(''))
    }
    throw new Error(`the fixture serves no git ${args[0]}`)
  }
}

const FIXTURE_TEST = `import { expect, it } from 'bun:test'
import describeWidget from './describe'
import { helper } from './new-helper'
import { makeWidget, oldThing, start } from './widget'

it('builds a widget the case names', () => {
  process.env.WIDGET_COLOR = 'red'
  process.env.WIDGET_THEME = 'dark'
  const deps = { load: makeWidget, render: () => '' }
  expect(describeWidget(makeWidget('y'))).toBeDefined()
  const widget = makeWidget('x')
  expect(widget.mode).toBe('fast')
  expect(widget.label.length).toBe(1)
  expect(oldThing('ab')).toBe(2)
  expect(start(['--widget-size'])).toContain('widget is ready')
  expect(start([])).not.toBe('1024')
  expect(helper()).toBeDefined()
  events.on('widget-ready', () => {})
})
`

const FIXTURE_WIDGET_BASE = `export function oldThing(a: string): number {
  return a.length
}

export interface WidgetDeps {
  load: (
    name: string
  ) => Widget
}
`

const FIXTURE_WIDGET = `import { EventEmitter } from 'node:events'

export function oldThing(a: string): number {
  return a.length
}

export interface Widget {
  mode: 'fast' | 'slow'
  label: string
}

export interface WidgetDeps {
  load: (
    name: string
  ) => Widget
}

export interface WidgetOptions {
  render: (input: {
    name: string
    size: number
  }) => string
}

export function makeWidget(name: string, size = 10): Widget {
  const secret = computeInternals(name, size)
  return { mode: secret > 3 ? 'fast' : 'slow', label: name }
}

function computeInternals(name: string, size: number): number {
  return name.length * size
}

export function unimportedHelper(): void {}

export const events = new EventEmitter()

export function start(argv: string[]): string {
  if (process.env.WIDGET_COLOR === undefined) return 'no color'
  const { WIDGET_THEME } = process.env
  if (argv.includes('--widget-size')) events.emit('widget-ready')
  return 'widget is ready: 1024'
}
`

const fixtureCase = {
  id: 'fixture-widget',
  baseCommit: 'b'.repeat(40),
  referenceCommit: 'r'.repeat(40),
  hiddenTests: { files: [{ path: 'src/widget.test.ts', blob: 'test-blob' }], deleted: [] },
  referenceSolution: {
    commit: 'r'.repeat(40),
    files: [
      { path: 'src/widget.ts', blob: 'widget-blob' },
      { path: 'src/new-helper.ts', blob: 'helper-blob' },
      { path: 'src/describe.ts', blob: 'describe-blob' }
    ],
    deleted: [],
    digest: 'f'.repeat(64)
  },
  failToPass: { 'src/widget.test.ts': ['builds a widget the case names'] }
} as unknown as DeveloperCapabilityCase

const fixture = fixtureGit(
  {
    'test-blob': FIXTURE_TEST,
    'widget-blob': FIXTURE_WIDGET,
    'helper-blob': "export function helper(): string {\n  return 'helped'\n}\n",
    'describe-blob': 'export default function describeWidget(w: Widget): string {\n  return w.label\n}\n',
    'base-widget-blob': FIXTURE_WIDGET_BASE,
    'base-readme-blob': 'The default mode is fast.\n',
    'base-test-blob': "it('says widget is ready', () => {})\n"
  },
  {
    'src/widget.ts': 'base-widget-blob',
    'README.md': 'base-readme-blob',
    'src/widget.test.ts': 'base-test-blob'
  }
)

const EXPECTATION_TEST = `import { expect, it } from 'bun:test'
import { report, ReportSchema } from './report'

const CASES: [string, string][] = [
  ['alpha-input', 'alpha is ready'],
  ['beta-input', 'beta is ready']
]

it('reports', () => {
  for (const [name, line] of CASES) expect(report(name).line).toBe(line)
  expect(report('gamma')).toEqual({ status: 'report-done', counts: { totalWidgets: 3 }, tags: ['tag-new'] })
  expect(report('delta').summary).toBe('Found 3 widgets in delta')
  expect(report('echo').note).toBe('use \`widget\` now')
  expect(report('foxtrot').echo).toBe('foxtrot')
  expect(report('golf').detail).not.toBe('never-said')
  expect(report('hotel').items.some((i) => i.code === 'code-picked')).toBe(true)
  expect(report('india').legacy).toBe('Old 2 things')
  expect(ReportSchema.parse({ schemaOnlyKey: 'x' })).toBeDefined()
})
`

const EXPECTATION_REPORT = `import { z } from 'zod'

export const ReportSchema = z.object({ schemaOnlyKey: z.string() })

export function report(name: string) {
  return {
    line: \`\${name.split('-')[0]} is ready\`,
    status: 'report-done',
    counts: { totalWidgets: 3 },
    tags: ['tag-new'],
    summary: 'Found ' + 3 + ' widgets in ' + name,
    note: 'use \`widget\` now',
    echo: name,
    detail: '',
    items: [{ code: 'code-picked' }]
  }
}
`

const EXPECTATION_OLD = `export const legacy = (n: number) => \`Old \${n} things\`
`

const expectationCase = {
  ...fixtureCase,
  id: 'fixture-report',
  hiddenTests: { files: [{ path: 'src/report.test.ts', blob: 'report-test-blob' }], deleted: [] },
  referenceSolution: {
    ...fixtureCase.referenceSolution,
    files: [
      { path: 'src/report.ts', blob: 'report-blob' },
      { path: 'src/old.ts', blob: 'old-blob' }
    ]
  },
  failToPass: { 'src/report.test.ts': ['reports'] }
} as unknown as DeveloperCapabilityCase

const expectationFixture = fixtureGit(
  {
    'report-test-blob': EXPECTATION_TEST,
    'report-blob': EXPECTATION_REPORT,
    'old-blob': EXPECTATION_OLD,
    'base-readme-blob': 'status counts tags line summary note echo detail items code legacy\n'
  },
  { 'src/old.ts': 'old-blob', 'README.md': 'base-readme-blob' }
)

describe('the Interface block', () => {
  it('names what the fail-to-pass tests import and assert from the reference change, less what the base holds', () => {
    const items = interfaceItems(fixture, fixtureCase)
    expect(items).toEqual([
      // A default import names the module's default export.
      { kind: 'export', text: 'src/describe.ts: default function describeWidget(w: Widget): string' },
      { kind: 'export', text: 'src/new-helper.ts: function helper(): string' },
      { kind: 'export', text: 'src/widget.ts: function makeWidget(name: string, size?): Widget' },
      { kind: 'export', text: 'src/widget.ts: function start(argv: string[]): string' },
      { kind: 'file', text: 'src/describe.ts' },
      { kind: 'file', text: 'src/new-helper.ts' },
      { kind: 'env', text: 'WIDGET_COLOR' },
      // Read by destructuring `process.env`.
      { kind: 'env', text: 'WIDGET_THEME' },
      { kind: 'flag', text: '--widget-size' },
      { kind: 'event', text: 'widget-ready' },
      { kind: 'field', text: 'Widget.label: string' },
      { kind: 'field', text: "Widget.mode: 'fast' | 'slow'" },
      // A type written across lines is named on one line, its member separators kept; `WidgetDeps.load`, which
      // the base declares identically across lines, is left out.
      { kind: 'field', text: 'WidgetOptions.render: (input: { name: string; size: number; }) => string' },
      // Held at the base only by the fail-to-pass test's own base copy, which the base check skips.
      { kind: 'string', text: 'widget is ready' }
    ])
    const statement = withInterface('Make the widget.', items)
    expect(statement.startsWith('Make the widget. Interface: export `src/describe.ts: ')).toBe(true)
    expect(statement.endsWith('; string `widget is ready`.')).toBe(true)
    expect(findBannedTerms(statement)).toEqual([])
    // No function body, unimported helper, test name, numeric expected value or export the base already has.
    for (const left of ['computeInternals', 'secret', 'unimportedHelper', 'builds a widget', '1024', 'oldThing'])
      expect({ left, named: statement.includes(left) }).toEqual({ left, named: false })
    // A string the base already holds is left out: the README names the mode `fast`.
    expect(items.some((item) => item.kind === 'string' && item.text === 'fast')).toBe(false)
    expect(items.some((item) => item.text.startsWith('WidgetDeps.'))).toBe(false)
  })

  it('names the expected side of each assertion: nested values, table columns, template-built and backtick text, and keys', () => {
    const items = interfaceItems(expectationFixture, expectationCase)
    expect(items).toEqual([
      { kind: 'export', text: 'src/report.ts: const ReportSchema' },
      { kind: 'export', text: 'src/report.ts: function report(name: string)' },
      { kind: 'file', text: 'src/report.ts' },
      // A schema key the test passes in, and a key of a nested expected object; the other keys the README holds.
      { kind: 'key', text: 'schemaOnlyKey' },
      { kind: 'key', text: 'totalWidgets' },
      // Built by a `+` concatenation, and, below, by a template literal from the expected column of a table.
      { kind: 'string', text: 'Found 3 widgets in delta' },
      { kind: 'string', text: 'alpha is ready' },
      { kind: 'string', text: 'beta is ready' },
      // Compared with the actual value inside `expect(...)`.
      { kind: 'string', text: 'code-picked' },
      // Inside an expected object, and an expected array inside it.
      { kind: 'string', text: 'report-done' },
      { kind: 'string', text: 'tag-new' },
      { kind: 'string', text: 'use `widget` now' }
    ])
    // An input the test passes to the code — a table's input column, a value echoed back — is never named; nor
    // is what a negated matcher checks is absent, nor text the base copy of a changed file builds too.
    const statement = withInterface('Make the report.', items)
    for (const left of ['alpha-input', 'foxtrot', 'never-said', 'Old 2 things'])
      expect({ left, named: statement.includes(left) }).toEqual({ left, named: false })
    // A text holding a backtick is fenced by a longer run, and the block still parses as one.
    expect(statement.endsWith('; string ``use `widget` now``.')).toBe(true)
    expect(findBannedTerms(statement)).toEqual([])
  })

  it('refuses the re-cut when the base search fails for any reason but finding nothing', () => {
    const failing: Git = (args, options) => {
      if (args[0] === 'grep') throw new RecutRefused('git grep failed')
      return fixture(args, options)
    }
    expect(() => interfaceItems(failing, fixtureCase)).toThrow(RecutRefused)
  })

  it('keeps a statement with no item byte for byte, and writes the block on its single line', () => {
    expect(withInterface('Make the change.', [])).toBe('Make the change.')
    expect(
      interfaceBlock([
        { kind: 'env', text: 'A' },
        { kind: 'flag', text: '--b' }
      ])
    ).toBe(' Interface: env `A`; flag `--b`.')
    // A text holding backticks is fenced by one more than its longest run, padded when it starts or ends with one.
    expect(
      interfaceBlock([
        { kind: 'string', text: 'run `a` or ``b``' },
        { kind: 'string', text: '`edge`' }
      ])
    ).toBe(' Interface: string ``` run `a` or ``b`` ```; string `` `edge` ``.')
  })

  it('names the error the pr-1091 tests import from the module they import it from', () => {
    const derived = JSON.parse(readFileSync(DERIVED_FILES.developer.development, 'utf8')) as {
      suites: { cases: { id: string; taskStatement: string }[] }[]
    }
    const statement = derived.suites[0]?.cases.find((c) => c.id === 'pr-1091')?.taskStatement ?? ''
    expect(statement.startsWith(statements['pr-1091'] as string)).toBe(true)
    expect(statement).toContain('export `apps/cli/src/lib/task-sweep.ts: class IssueNotFoundError')
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

describe('the whole-loop mapping', () => {
  it("keeps the developer case's base, statement, scope, documents, tests and solution, and grants the loop's capabilities", () => {
    for (const p of developerCases) {
      const statement = statements[p.id] as string
      const { case: change } = deriveDeveloperCase(repositoryGit, p, statement)
      const { case: loop } = deriveLoopCase(repositoryGit, p, statement)
      expect(loop.kind).toBe('loop')
      expect(loop.taskStatement).toBe(statement)
      expect({ ...loop, kind: change.kind, grantedCapabilities: change.grantedCapabilities }).toEqual(change)
      expect({ id: p.id, valid: validateNeutralCase(loop).ok }).toEqual({ id: p.id, valid: true })
    }
  })

  it('grants what the developer, both reviewers and the publication need', () => {
    for (const capability of [...DEVELOPER_CAPABILITIES, ...REVIEWER_CAPABILITIES]) {
      expect(LOOP_CAPABILITIES).toContain(capability)
    }
    expect(LOOP_CAPABILITIES).toContain('publish_change')
    expect(LOOP_CAPABILITIES).toContain('open_change_request')
    expect(new Set(LOOP_CAPABILITIES).size).toBe(LOOP_CAPABILITIES.length)
  })

  it('copies a held-out case its generated developer statement unchanged', () => {
    const p = developerCases[0] as (typeof developerCases)[number]
    const statement = generatedDeveloperStatement(p)
    expect(deriveLoopCase(repositoryGit, p, statement).case.taskStatement).toBe(
      deriveDeveloperCase(repositoryGit, p, statement).case.taskStatement
    )
  })

  it('marks each live variant by its rule, and refuses a case whose review rounds were never read', () => {
    const facts = loadRevisionFacts()
    const cases = [
      { id: 'pr-1002', deliveredDocuments: [{}] },
      { id: 'pr-1312', deliveredDocuments: [] },
      { id: 'pr-1299', deliveredDocuments: [] }
    ]
    expect(loopVariants(cases, facts)).toEqual({
      'source-requiring': ['pr-1002'],
      'reviewer-requested-revision': ['pr-1002', 'pr-1299']
    })
    expect(() => loopVariants([{ id: 'never-read', deliveredDocuments: [] }], facts)).toThrow(RecutRefused)
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
  it('derives an answer case with an empty scope, each source pinned by its content, read_file for an injected source and read_document for retrieval', () => {
    for (const p of citationFile.cases) {
      const g = deriveSourceCitationCase(citationFile.repositoryCommit, p, statements[p.id] as string)
      expect(g.kind).toBe('answer')
      expect(g.baseRevision).toBe(citationFile.repositoryCommit)
      expect(g.authorizedScope).toEqual({ in: [], excluded: [], protected: [] })
      expect(g.deliveredDocuments).toEqual(
        p.sources.map((s) => ({ id: s.sourceId, contentDigest: sha256(s.content), relevant: s.relevant }))
      )
      const injected = p.sources.some((s) => s.deliveryMode === 'injected')
      const retrieval = p.sources.some((s) => s.deliveryMode === 'retrieval_tool')
      expect({ id: p.id, granted: g.grantedCapabilities }).toEqual({
        id: p.id,
        granted: [...(injected ? ['read_file'] : []), ...(retrieval ? ['read_document'] : [])]
      })
      expect(validateNeutralCase(g).ok).toBe(true)
    }
    // The case whose one document is injected into the worktree grants the read of that file.
    const undelivered = caseById(citationFile.cases, 'dev-undelivered-source')
    expect(undelivered.sources.map((s) => s.deliveryMode)).toEqual(['injected'])
    expect(deriveSourceCitationCase(citationFile.repositoryCommit, undelivered, '').grantedCapabilities).toEqual([
      'read_file'
    ])
    expect(answerCapabilities({ sources: [] })).toEqual([])
    const both = [{ deliveryMode: 'retrieval_tool' }, { deliveryMode: 'injected' }] as SourceCitationCase['sources']
    expect(answerCapabilities({ sources: both })).toEqual(['read_file', 'read_document'])
  })
})

describe('re-running the re-cut', () => {
  it(
    'reproduces every development file byte for byte',
    () => {
      const recut = recutDevelopment()
      expect(recut.files.map((f) => f.path)).toEqual([
        DERIVED_FILES.developer.development,
        DERIVED_FILES.reviewer.development,
        DERIVED_FILES.sourceCitation.development,
        DERIVED_FILES.wholeLoop.development
      ])
      for (const file of recut.files) {
        expect({ file: file.path, sha256: sha256(file.text) }).toEqual({
          file: file.path,
          sha256: sha256(readFileSync(file.path))
        })
      }
      expect(Object.keys(recut.summary)).toEqual(['files'])
      expect(JSON.stringify(recut.summary)).not.toMatch(/Interface:|`/)
    },
    RECUT_BUDGET_MS
  )

  it('reads no held-out case, and derives no Interface block for one, before the developer approval opens them', () => {
    const calls: string[] = []
    const spy: Git = (args, options) => {
      calls.push(args[0] as string)
      return repositoryGit(args, options)
    }
    expect(() => recutHeldOut({ ...approvals, developer: 'f'.repeat(64) }, spy)).toThrow()
    expect(calls).toEqual([])
  })

  it(
    'reproduces every held-out file byte for byte, compared by digest only, but those awaiting their approved re-cut',
    () => {
      const recut = recutHeldOut(approvals)
      expect(recut.files.map((f) => f.path)).toEqual([
        DERIVED_FILES.developer.heldOut,
        DERIVED_FILES.reviewer.heldOut,
        DERIVED_FILES.sourceCitation.heldOut,
        DERIVED_FILES.wholeLoop.heldOut
      ])
      for (const file of recut.files) {
        const committed = sha256(readFileSync(file.path))
        // A file awaiting its re-cut still holds the bytes it was pinned with, and the current derivation no longer
        // writes them; once the re-cut is run and committed, the file leaves the list and is reproduced again.
        const awaiting = HELD_OUT_AWAITING_RECUT.includes(file.path)
        expect({ file: file.path, awaiting, reproduced: sha256(file.text) === committed }).toEqual({
          file: file.path,
          awaiting,
          reproduced: !awaiting
        })
      }
      // Its summary carries counts, ids and digests only: no Interface block, nor any part of one.
      expect(Object.keys(recut.summary).sort()).toEqual(['files', 'heldOutIds'])
      expect(JSON.stringify(recut.summary)).not.toMatch(/Interface:|`/)
      for (const entry of recut.summary.files) {
        expect(Object.keys(entry).sort()).toEqual(['cases', 'file', 'layerPOnly', 'sha256', 'undeliverableSources'])
      }
      // The source-citation file holds one answer case per pinned held-out index entry, listed by id alone.
      const ids = recut.summary.heldOutIds?.[GENERIC_SUITE_IDS.sourceCitation]
      expect(ids).toEqual(citationFile.splits.heldOut.index.map((entry) => entry.id))
      expect(recut.summary.files.at(-2)?.cases).toEqual({ [GENERIC_SUITE_IDS.sourceCitation]: ids?.length ?? 0 })
      // The whole-loop file holds one loop case per developer held-out index entry, cut under the developer approval.
      const loopIds = recut.summary.heldOutIds?.[GENERIC_SUITE_IDS.wholeLoop]
      expect(loopIds).toEqual(developerFile.splits.heldOut.index.map((entry) => entry.id))
      expect(recut.summary.files.at(-1)?.cases).toEqual({ [GENERIC_SUITE_IDS.wholeLoop]: loopIds?.length ?? 0 })
    },
    RECUT_BUDGET_MS
  )

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
