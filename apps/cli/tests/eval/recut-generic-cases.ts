/**
 * The layer-`G` re-cut: derives the neutral cases of the developer
 * capability, code reviewer, security reviewer and source-citation suites
 * from their committed layer-`P` cases, field by field. Nothing is written
 * by hand: re-running the script on unchanged inputs reproduces every derived
 * file byte for byte.
 *
 *  - A developer case drops its issue, pull request and brief; its scope's
 *    `in:` becomes the authorized scope's `in` and its `out:` the scope's
 *    `excluded`, each entry written as the paths the Surface entry covers; its
 *    required sources become delivered documents pinned by their content at
 *    the base commit; its base commit, reference solution and hidden tests are
 *    kept.
 *  - A reviewer case becomes a `review` case: its expected defect a planted
 *    one, blocking by its severity's rank and critical exactly when it is a
 *    seeded critical or high security defect; its objectives are dropped. A
 *    case whose defect kind only the Vinaya process can state stays layer `P`.
 *  - A source-citation case becomes an `answer` case: no change, every
 *    source a delivered document pinned by the SHA-256 of its content.
 *
 * A development case's task statement is the one `generic-task-statements.json`
 * holds for its id. A held-out case's is generated here from the case's own
 * fields; a held-out run writes only the derived files and prints only case
 * counts, ids and digests, never case content.
 *
 *     bun apps/cli/tests/eval/recut-generic-cases.ts development
 *     bun apps/cli/tests/eval/recut-generic-cases.ts held-out --approve-developer <sha256> --approve-reviewer <sha256>
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findBannedTerms } from '../../src/lib/dev-review-eval/banned-terms'
import { canonicalJson } from '../../src/lib/dev-review-eval/neutral-case'
import { renderCase } from '../../src/lib/dev-review-eval/vinaya-renderer'
import { REVIEWER_SEVERITIES, type ReviewerRole } from '../../src/lib/review-result'
import {
  type DeveloperCapabilityCase,
  digestsIn,
  loadCaseFile as loadDeveloperCaseFile,
  loadHeldOutCases as loadDeveloperHeldOut,
  CASES_PATH as DEVELOPER_CASES_PATH
} from './developer-capability-suite'
import {
  CASES as REVIEWER_CASES_PATHS,
  type DefectKind,
  loadDevelopment as loadReviewerDevelopment,
  loadHeldOut as loadReviewerHeldOut,
  type ReviewCase
} from './reviewer-quality-suite'
import {
  loadCaseFile as loadSourceCitationCaseFile,
  CASES_PATH as SOURCE_CITATION_CASES_PATH,
  type SourceCitationCase
} from './source-citation-suite'
import { stripVinayaEnv } from '../lib/process-fixture'

const REPO_ROOT = join(import.meta.dir, '../../../..')

/** Longest one git or formatter call may run before it is killed. */
const SPAWN_BUDGET_MS = 120_000

/** The repository every committed case is cut from. */
export const REPOSITORY = 'atta-labs/vinaya'

export const STATEMENTS_PATH = join(import.meta.dir, 'generic-task-statements.json')

/** The layer-`G` suites the re-cut fills, by their registry name and version. */
export const GENERIC_SUITE_IDS = {
  developer: 'developer-capability-neutral.l5@1',
  codeReviewer: 'code-reviewer-quality-neutral.l5@1',
  securityReviewer: 'security-reviewer-quality-neutral.l5@1',
  sourceCitation: 'source-delivery-neutral.l5@1'
} as const

/** Each derived file, by the split it holds. */
export const DERIVED_FILES = {
  developer: {
    development: join(import.meta.dir, 'developer-capability-generic-cases.json'),
    heldOut: join(import.meta.dir, 'developer-capability-generic-held-out.json')
  },
  reviewer: {
    development: join(import.meta.dir, 'reviewer-quality-generic-cases.json'),
    heldOut: join(import.meta.dir, 'reviewer-quality-generic-held-out.json')
  },
  sourceCitation: { development: join(import.meta.dir, 'source-citation-generic-cases.json') }
} as const

/** The defect kinds only the Vinaya process can state: a change beyond its Surface, an objective left unmet. */
export const LAYER_P_ONLY_DEFECT_KINDS: readonly DefectKind[] = ['beyond-surface', 'objective-unmet']

/** The capabilities the developer capability suite's Developer holds: its built-ins and its seven tools. */
export const DEVELOPER_CAPABILITIES: readonly string[] = [
  'read_file',
  'write_file',
  'run_commands',
  'read_document',
  'run_checks',
  'publish_change',
  'open_change_request',
  'update_change_request',
  'refresh_evidence',
  'read_change_request'
]

/** A reviewer reads the change and runs only commands that cannot write; it never writes anything. */
export const REVIEWER_CAPABILITIES: readonly string[] = ['read_file', 'read_commands']

/**
 * The fixed author and committer of a seeded change's head commit, so the
 * commit that applies a seeded patch to its base has one reproducible id.
 */
export const SEEDED_COMMIT_IDENTITY = {
  name: 'Vinaya Evaluation',
  email: 'eval@invalid.local',
  date: '2026-01-01T00:00:00Z'
} as const

const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')

// ── Git ─────────────────────────────────────────────────────────────────────

export type Git = (args: readonly string[], options?: { env?: Record<string, string>; input?: string }) => Uint8Array

/** Git in the repository the cases are cut from; refuses when the command fails. */
export const repositoryGit: Git = (args, options = {}) => {
  const run = spawnSync('git', [...args], {
    cwd: REPO_ROOT,
    env: { ...stripVinayaEnv({ PATH: process.env.PATH ?? '/usr/bin:/bin' }), HOME: tmpdir(), ...options.env },
    input: options.input,
    maxBuffer: 256 * 1024 * 1024,
    timeout: SPAWN_BUDGET_MS,
    killSignal: 'SIGKILL'
  })
  if (run.status !== 0) throw new RecutRefused(`git ${args[0]} failed`)
  return run.stdout
}

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8').trim()

/** The bytes of `path` at `commit`, or `null` when the commit has no such file. */
function fileAt(git: Git, commit: string, path: string): Uint8Array | null {
  try {
    return git(['cat-file', 'blob', `${commit}:${path}`])
  } catch {
    return null
  }
}

/**
 * The commit that applies a seeded patch to its base, made in a scratch
 * object directory so the repository's own objects stay as they were. Its
 * tree is the base's with the patch applied, its one parent the base, and its
 * author, committer and dates `SEEDED_COMMIT_IDENTITY`.
 */
export function seededHead(git: Git, base: string, patch: string, caseId: string): string {
  const scratch = mkdtempSync(join(tmpdir(), 'recut-seeded-'))
  try {
    const objects = text(git(['rev-parse', '--path-format=absolute', '--git-path', 'objects']))
    const env = {
      GIT_INDEX_FILE: join(scratch, 'index'),
      GIT_OBJECT_DIRECTORY: join(scratch, 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: objects,
      GIT_AUTHOR_NAME: SEEDED_COMMIT_IDENTITY.name,
      GIT_AUTHOR_EMAIL: SEEDED_COMMIT_IDENTITY.email,
      GIT_AUTHOR_DATE: SEEDED_COMMIT_IDENTITY.date,
      GIT_COMMITTER_NAME: SEEDED_COMMIT_IDENTITY.name,
      GIT_COMMITTER_EMAIL: SEEDED_COMMIT_IDENTITY.email,
      GIT_COMMITTER_DATE: SEEDED_COMMIT_IDENTITY.date
    }
    mkdirSync(env.GIT_OBJECT_DIRECTORY)
    git(['read-tree', base], { env })
    git(['apply', '--cached', '--unidiff-zero', '-'], { env, input: patch })
    const tree = text(git(['write-tree'], { env }))
    return text(git(['commit-tree', tree, '-p', base, '-m', `Seeded change ${caseId}`], { env }))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

// ── Mapping ─────────────────────────────────────────────────────────────────

export class RecutRefused extends Error {}

/**
 * The paths a Surface entry covers, written as a neutral glob: a Surface
 * entry covers its path and everything below it, so a trailing `/**` or `/*`
 * is dropped; a file path and the root glob `*` are kept as written.
 */
export function surfaceEntryPaths(entry: string): string {
  return entry === '*' ? entry : entry.replace(/\/\*\*?$/, '')
}

/** A delivered document needs its content pinned, so only a source with content at the base commit is one. */
function deliveredDocuments(git: Git, c: DeveloperCapabilityCase) {
  const documents: { id: string; contentDigest: string; relevant: boolean }[] = []
  let undeliverable = 0
  for (const source of c.requiredSources) {
    const content = /^https?:\/\//.test(source) ? null : fileAt(git, c.baseCommit, source)
    if (content === null) undeliverable++
    else documents.push({ id: source, contentDigest: sha256(content), relevant: true })
  }
  return { documents, undeliverable }
}

/** The withheld tests: each fail-to-pass test by name, each pass-to-pass test by its name digest. */
function hiddenTests(c: DeveloperCapabilityCase) {
  return [
    ...Object.entries(c.failToPass).flatMap(([path, names]) =>
      names.map((name) => ({ path, name, expectation: 'fail-to-pass' as const }))
    ),
    ...c.passToPass.flatMap(({ file, digests }) =>
      digestsIn(digests).map((name) => ({ path: file, name, expectation: 'pass-to-pass' as const }))
    )
  ]
}

export function deriveDeveloperCase(git: Git, c: DeveloperCapabilityCase, taskStatement: string) {
  const { documents, undeliverable } = deliveredDocuments(git, c)
  return {
    case: {
      id: c.id,
      layer: 'G',
      kind: 'change',
      repository: REPOSITORY,
      baseRevision: c.baseCommit,
      taskStatement,
      authorizedScope: {
        in: c.scope.in.map(surfaceEntryPaths),
        excluded: c.scope.out.map(surfaceEntryPaths),
        protected: []
      },
      deliveredDocuments: documents,
      grantedCapabilities: [...DEVELOPER_CAPABILITIES],
      hiddenTests: hiddenTests(c),
      referenceSolution: { patchDigest: c.referenceSolution.digest }
    },
    undeliverable
  }
}

/** A severity blocks when it is among its role's two most severe ranks. */
const blocks = (role: ReviewerRole, severity: string) => {
  const rank = REVIEWER_SEVERITIES[role].indexOf(severity)
  return rank >= 0 && rank < 2
}

/** The review case of a reviewer case, or `null` when its defect kind only the Vinaya process can state. */
export function deriveReviewerCase(git: Git, c: ReviewCase, taskStatement: string) {
  if (c.expected !== null && LAYER_P_ONLY_DEFECT_KINDS.includes(c.expected.kind)) return null
  if (c.patch.source === 'git' && c.patch.parentCommit !== c.baseCommit) {
    throw new RecutRefused(`${c.id}: the change under review does not start from the case's base`)
  }
  const head = c.patch.source === 'git' ? c.patch.changedCommit : seededHead(git, c.baseCommit, c.patch.unified, c.id)
  const expected = c.expected
  return {
    id: c.id,
    layer: 'G',
    kind: 'review',
    repository: REPOSITORY,
    baseRevision: c.baseCommit,
    taskStatement,
    authorizedScope: { in: [c.patch.file], excluded: [], protected: [] },
    deliveredDocuments: [],
    grantedCapabilities: [...REVIEWER_CAPABILITIES],
    plantedDefects:
      expected === null
        ? []
        : [
            {
              file: expected.file,
              kind: expected.kind,
              blocking: blocks(c.role, expected.severity),
              critical: c.role === 'security-reviewer' && ['CRITICAL', 'HIGH'].includes(expected.severity),
              justified: expected.justified === true
            }
          ],
    changeUnderReview: { base: c.baseCommit, head, patchDigest: c.patch.digest },
    adjudication:
      c.set === 'clean' && c.adjudication !== undefined
        ? { clean: true, adjudicators: [c.adjudication.first.reviewer, c.adjudication.second.reviewer] }
        : { clean: false, adjudicators: [] }
  }
}

export function deriveSourceCitationCase(repositoryCommit: string, c: SourceCitationCase, taskStatement: string) {
  return {
    id: c.id,
    layer: 'G',
    kind: 'answer',
    repository: REPOSITORY,
    baseRevision: repositoryCommit,
    taskStatement,
    authorizedScope: { in: [], excluded: [], protected: [] },
    deliveredDocuments: c.sources.map((s) => ({
      id: s.sourceId,
      contentDigest: sha256(s.content),
      relevant: s.relevant
    })),
    grantedCapabilities: c.sources.some((s) => s.deliveryMode === 'retrieval_tool') ? ['read_document'] : []
  }
}

// ── Held-out task statements ────────────────────────────────────────────────

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The first statement free of banned terms, so a generated one never names a process term. */
function firstAllowed(...statements: string[]): string {
  return statements.find((s) => findBannedTerms(s).length === 0) ?? (statements.at(-1) as string)
}

/** A held-out developer case's statement, from its withheld tests and its scope. */
export function generatedDeveloperStatement(c: DeveloperCapabilityCase): string {
  const files = Object.keys(c.failToPass).length
  const tests = Object.values(c.failToPass).reduce((n, names) => n + names.length, 0)
  const core = `Make the change the withheld tests expect: ${plural(tests, 'test')} in ${plural(files, 'file')} that fail at the base revision must pass, and every existing test must keep passing.`
  return firstAllowed(
    `${core} Change only ${c.scope.in.map(surfaceEntryPaths).join(', ')} and what is under them.`,
    core
  )
}

/** A held-out reviewer case's statement, from the file its change touches. */
export function generatedReviewerStatement(c: ReviewCase): string {
  const kind = c.role === 'security-reviewer' ? 'security defects' : 'defects'
  return firstAllowed(
    `Review this change to ${c.patch.file} for ${kind} against the base revision.`,
    `Review this change for ${kind} against the base revision.`
  )
}

// ── The derived files ───────────────────────────────────────────────────────

/** A derived file: its path and its exact bytes. */
export interface DerivedFile {
  path: string
  text: string
}

export interface FileSummary {
  file: string
  sha256: string
  cases: Record<string, number>
  layerPOnly: number
  undeliverableSources: number
}

export interface Recut {
  files: DerivedFile[]
  summary: { files: FileSummary[]; heldOutIds?: Record<string, string[]> }
}

/** Formats JSON as the repository's formatter, which its commit hook runs, would leave it. */
export function formatJson(path: string, value: unknown): string {
  const biome = join(REPO_ROOT, 'node_modules', '.bin', 'biome')
  const run = spawnSync(biome, ['format', `--stdin-file-path=${path}`], {
    cwd: REPO_ROOT,
    env: stripVinayaEnv(process.env),
    input: `${JSON.stringify(value, null, 2)}\n`,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: SPAWN_BUDGET_MS,
    killSignal: 'SIGKILL'
  })
  if (run.status !== 0) throw new RecutRefused(`biome could not format ${path}`)
  return run.stdout
}

const relative = (path: string) => path.slice(REPO_ROOT.length + 1)
const fileDigest = (path: string) => sha256(readFileSync(path))

/**
 * Refuses a derived case that is not a valid, renderable neutral case,
 * naming it by id and digest only, so a held-out case's content never
 * reaches the output.
 */
function checkRenderable(cases: readonly { id: string }[]): void {
  const refused = cases.filter((c) => !renderCase(c).ok).map((c) => `${c.id} (sha256:${sha256(canonicalJson(c))})`)
  if (refused.length > 0) throw new RecutRefused(`derived cases refused: ${refused.join(', ')}`)
}

function derivedFile(
  path: string,
  split: 'development' | 'held-out',
  derivedFrom: string[],
  suites: { suite: string; cases: { id: string }[]; layerPOnly: string[] }[],
  undeliverableSources: number
): { file: DerivedFile; summary: FileSummary } {
  for (const { cases } of suites) checkRenderable(cases)
  const value = {
    schemaVersion: 1,
    split,
    derivedFrom: derivedFrom.map((source) => ({ file: relative(source), sha256: fileDigest(source) })),
    suites
  }
  const text = formatJson(path, value)
  return {
    file: { path, text },
    summary: {
      file: relative(path),
      sha256: sha256(text),
      cases: Object.fromEntries(suites.map((s) => [s.suite, s.cases.length])),
      layerPOnly: suites.reduce((n, s) => n + s.layerPOnly.length, 0),
      undeliverableSources
    }
  }
}

/** The development statements, keyed by case id; a missing one refuses the re-cut. */
export function loadStatements(read = (path: string) => readFileSync(path, 'utf8')) {
  const statements = JSON.parse(read(STATEMENTS_PATH)) as Record<string, string>
  return (id: string): string => {
    const statement = statements[id]
    if (typeof statement !== 'string') throw new RecutRefused(`no task statement for development case ${id}`)
    return statement
  }
}

type ReviewerSplit = { role: ReviewerRole; suite: string; cases: ReviewCase[] }

function reviewerSuites(git: Git, splits: readonly ReviewerSplit[], statementOf: (c: ReviewCase) => string) {
  return splits.map(({ suite, cases }) => {
    const derived: { id: string }[] = []
    const layerPOnly: string[] = []
    for (const c of cases) {
      const g = deriveReviewerCase(git, c, statementOf(c))
      if (g === null) layerPOnly.push(c.id)
      else derived.push(g)
    }
    return { suite, cases: derived, layerPOnly }
  })
}

/** Derives the development files. Opens no held-out file. */
export function recutDevelopment(git: Git = repositoryGit): Recut {
  const statementFor = loadStatements()
  const developerFile = loadDeveloperCaseFile()
  let undeliverable = 0
  const developerCases = developerFile.cases.map((c) => {
    const derived = deriveDeveloperCase(git, c, statementFor(c.id))
    undeliverable += derived.undeliverable
    return derived.case
  })
  const developer = derivedFile(
    DERIVED_FILES.developer.development,
    'development',
    [DEVELOPER_CASES_PATH, STATEMENTS_PATH],
    [{ suite: GENERIC_SUITE_IDS.developer, cases: developerCases, layerPOnly: [] }],
    undeliverable
  )
  const reviewers = derivedFile(
    DERIVED_FILES.reviewer.development,
    'development',
    [REVIEWER_CASES_PATHS['code-reviewer'], REVIEWER_CASES_PATHS['security-reviewer'], STATEMENTS_PATH],
    reviewerSuites(
      git,
      [
        {
          role: 'code-reviewer',
          suite: GENERIC_SUITE_IDS.codeReviewer,
          cases: loadReviewerDevelopment('code-reviewer').cases
        },
        {
          role: 'security-reviewer',
          suite: GENERIC_SUITE_IDS.securityReviewer,
          cases: loadReviewerDevelopment('security-reviewer').cases
        }
      ],
      (c) => (c.expected !== null && LAYER_P_ONLY_DEFECT_KINDS.includes(c.expected.kind) ? '' : statementFor(c.id))
    ),
    0
  )
  const citationFile = loadSourceCitationCaseFile()
  const citation = derivedFile(
    DERIVED_FILES.sourceCitation.development,
    'development',
    [SOURCE_CITATION_CASES_PATH, STATEMENTS_PATH],
    [
      {
        suite: GENERIC_SUITE_IDS.sourceCitation,
        cases: citationFile.cases.map((c) =>
          deriveSourceCitationCase(citationFile.repositoryCommit, c, statementFor(c.id))
        ),
        layerPOnly: []
      }
    ],
    0
  )
  return {
    files: [developer.file, reviewers.file, citation.file],
    summary: { files: [developer.summary, reviewers.summary, citation.summary] }
  }
}

/**
 * Derives the held-out files, inside the sealed run: each case is read by
 * field and its statement generated from its own fields, and only counts, ids
 * and digests leave the run. Each approval is the pinned digest of its
 * layer-`P` held-out file.
 */
export function recutHeldOut(approvals: { developer: string; reviewer: string }, git: Git = repositoryGit): Recut {
  const developerFile = loadDeveloperCaseFile()
  const developerHeld = loadDeveloperHeldOut(developerFile, approvals.developer)
  let undeliverable = 0
  const developerCases = developerHeld.map((c) => {
    const derived = deriveDeveloperCase(git, c, generatedDeveloperStatement(c))
    undeliverable += derived.undeliverable
    return derived.case
  })
  const developer = derivedFile(
    DERIVED_FILES.developer.heldOut,
    'held-out',
    [join(import.meta.dir, developerFile.splits.heldOut.file)],
    [{ suite: GENERIC_SUITE_IDS.developer, cases: developerCases, layerPOnly: [] }],
    undeliverable
  )
  const reviewerSuitesHeld = reviewerSuites(
    git,
    [
      {
        role: 'code-reviewer',
        suite: GENERIC_SUITE_IDS.codeReviewer,
        cases: loadReviewerHeldOut('code-reviewer', approvals.reviewer)
      },
      {
        role: 'security-reviewer',
        suite: GENERIC_SUITE_IDS.securityReviewer,
        cases: loadReviewerHeldOut('security-reviewer', approvals.reviewer)
      }
    ],
    generatedReviewerStatement
  )
  const reviewers = derivedFile(
    DERIVED_FILES.reviewer.heldOut,
    'held-out',
    [join(import.meta.dir, 'reviewer-quality-held-out.json')],
    reviewerSuitesHeld,
    0
  )
  return {
    files: [developer.file, reviewers.file],
    summary: {
      files: [developer.summary, reviewers.summary],
      heldOutIds: {
        [GENERIC_SUITE_IDS.developer]: developerCases.map((c) => c.id),
        ...Object.fromEntries(reviewerSuitesHeld.map((s) => [s.suite, s.cases.map((c) => c.id)]))
      }
    }
  }
}

function flag(argv: readonly string[], name: string): string {
  const value = argv[argv.indexOf(`--${name}`) + 1]
  if (!argv.includes(`--${name}`) || value === undefined) throw new RecutRefused(`--${name} <sha256> is required`)
  return value
}

export function main(argv: readonly string[]): number {
  const mode = argv[0]
  if (mode !== 'development' && mode !== 'held-out') {
    process.stderr.write(
      'usage: recut-generic-cases.ts development | held-out --approve-developer <sha256> --approve-reviewer <sha256>\n'
    )
    return 2
  }
  try {
    const recut =
      mode === 'development'
        ? recutDevelopment()
        : recutHeldOut({ developer: flag(argv, 'approve-developer'), reviewer: flag(argv, 'approve-reviewer') })
    for (const file of recut.files) writeFileSync(file.path, file.text)
    process.stdout.write(`${JSON.stringify(recut.summary, null, 2)}\n`)
    return 0
  } catch (error) {
    // A refusal names cases by id and digest only; any other error is reported by its kind alone,
    // since its message could carry held-out content.
    const message = error instanceof RecutRefused ? error.message : `the re-cut failed (${(error as Error).name})`
    process.stderr.write(`${message}\n`)
    return 1
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
