/**
 * The layer-`G` re-cut: derives the neutral cases of the developer
 * capability, code reviewer, security reviewer, source-citation and
 * whole-loop suites from their committed layer-`P` cases, field by field.
 * Nothing is written
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
 *    source a delivered document pinned by the SHA-256 of its content,
 *    granting the read of each way its documents are delivered.
 *  - A developer case also becomes a whole-loop `loop` case: its `change`
 *    case's fields and task statement unchanged, granting what the
 *    developer, both reviewers and the publication need. The suite's entry
 *    marks, beside its cases, the ones each live variant applies to.
 *
 * A development case's task statement is the one `generic-task-statements.json`
 * holds for its id. A held-out case's is generated here from the case's own
 * fields; a held-out run writes only the derived files and prints only case
 * counts, ids and digests, never case content. Either statement of a
 * developer case, and of its loop case, ends with the case's Interface block
 * (`interfaceItems`) when it has one.
 *
 *     bun apps/cli/tests/eval/recut-generic-cases.ts development
 *     bun apps/cli/tests/eval/recut-generic-cases.ts held-out --approve-developer <sha256> --approve-reviewer <sha256> --approve-source-citation <sha256>
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import ts from 'typescript'
import { findBannedTerms, INTERFACE_ITEM_KINDS, interfaceCodeSpan } from '../../src/lib/dev-review-eval/banned-terms'
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
  loadHeldOutCases as loadSourceCitationHeldOut,
  CASES_PATH as SOURCE_CITATION_CASES_PATH,
  HELD_OUT_PATH as SOURCE_CITATION_HELD_OUT_PATH,
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
  sourceCitation: 'source-delivery-neutral.l5@1',
  wholeLoop: 'whole-loop.l6@1'
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
  sourceCitation: {
    development: join(import.meta.dir, 'source-citation-generic-cases.json'),
    heldOut: join(import.meta.dir, 'source-citation-generic-held-out.json')
  },
  wholeLoop: {
    development: join(import.meta.dir, 'whole-loop-generic-cases.json'),
    heldOut: join(import.meta.dir, 'whole-loop-generic-held-out.json')
  }
} as const

/** Which past tasks drew a reviewer-requested revision, as read from their review rounds. */
export const REVISION_FACTS_PATH = join(import.meta.dir, 'whole-loop-revision-facts.json')

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

/** A reviewer reads the change, with its files and with shell commands, and never writes it. */
export const REVIEWER_CAPABILITIES: readonly string[] = ['read_file', 'run_commands']

/** A loop runs the developer, both reviewers and the publication, so it grants each one's capabilities. */
export const LOOP_CAPABILITIES: readonly string[] = [...new Set([...DEVELOPER_CAPABILITIES, ...REVIEWER_CAPABILITIES])]

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

/**
 * Runs one git command. `quietExit` names an exit status that means "nothing
 * found" rather than a failure, such as `git grep`'s `1`: it returns empty output.
 */
export type Git = (
  args: readonly string[],
  options?: { env?: Record<string, string>; input?: string; quietExit?: number }
) => Uint8Array

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
  if (options.quietExit !== undefined && run.status === options.quietExit && run.stdout.length === 0)
    return new Uint8Array()
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

/**
 * The whole-loop case of a developer case: its `change` case taken through
 * review to a decision, every field kept and the loop's capabilities granted.
 */
export function deriveLoopCase(git: Git, c: DeveloperCapabilityCase, taskStatement: string) {
  const { case: change, undeliverable } = deriveDeveloperCase(git, c, taskStatement)
  return { case: { ...change, kind: 'loop', grantedCapabilities: [...LOOP_CAPABILITIES] }, undeliverable }
}

/** The live variants of the whole-loop suite, each marked beside the cases it applies to. */
export const LOOP_VARIANTS = ['source-requiring', 'reviewer-requested-revision'] as const
export type LoopVariant = (typeof LOOP_VARIANTS)[number]

export interface RevisionFacts {
  schemaVersion: 1
  readAt: string
  source: string
  /** Every case id whose review rounds were read. */
  read: string[]
  /** The rounds of each case whose review asked for a revision. */
  revisionRounds: Record<string, number[]>
}

export function loadRevisionFacts(read = (path: string) => readFileSync(path, 'utf8')): RevisionFacts {
  const facts = JSON.parse(read(REVISION_FACTS_PATH)) as RevisionFacts
  if (facts.schemaVersion !== 1) throw new RecutRefused('the revision facts file has an unknown schema version')
  return facts
}

/**
 * The ids of the cases each live variant applies to, sorted: a case requires
 * sources when it delivers a document, and drew a reviewer-requested revision
 * when at least one of its review rounds asked for one. A case whose rounds
 * were never read refuses the re-cut, so no case goes unmarked by omission.
 */
export function loopVariants(
  cases: readonly { id: string; deliveredDocuments: readonly unknown[] }[],
  facts: RevisionFacts
): Record<LoopVariant, string[]> {
  const unread = cases.filter((c) => !facts.read.includes(c.id)).map((c) => c.id)
  if (unread.length > 0) throw new RecutRefused(`no revision facts for ${unread.join(', ')}`)
  const marked = (applies: (c: (typeof cases)[number]) => boolean) =>
    cases
      .filter(applies)
      .map((c) => c.id)
      .sort()
  return {
    'source-requiring': marked((c) => c.deliveredDocuments.length > 0),
    'reviewer-requested-revision': marked((c) => (facts.revisionRounds[c.id] ?? []).length > 0)
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
    grantedCapabilities: answerCapabilities(c)
  }
}

/**
 * What an answer case grants to reach its documents: `read_file` when one is
 * injected into the worktree, `read_document` when one is fetched through the
 * retrieval tool, and nothing when it delivers none.
 */
export function answerCapabilities(c: Pick<SourceCitationCase, 'sources'>): string[] {
  const modes = new Set(c.sources.map((s) => s.deliveryMode))
  return [...(modes.has('injected') ? ['read_file'] : []), ...(modes.has('retrieval_tool') ? ['read_document'] : [])]
}

// ── Interface blocks ────────────────────────────────────────────────────────
//
// A withheld test can fail a correct solution that only names things
// differently, so a developer case's statement ends with what its
// fail-to-pass tests import from the reference change, the literals both
// they and the reference solution use, and the values and keys their
// assertions expect that the reference writes or builds and the tests never
// pass in themselves. Each source file is read by its pinned
// blob, or at the base revision, and parsed with the TypeScript compiler API;
// an item the base revision already holds is left out.

/** The kinds an Interface item is labelled with, in the order the block lists them. */
export const INTERFACE_KINDS = INTERFACE_ITEM_KINDS
export type InterfaceKind = (typeof INTERFACE_KINDS)[number]

export interface InterfaceItem {
  kind: InterfaceKind
  text: string
}

/**
 * The block a statement ends with: ` Interface: <kind> <code span>; …` and a
 * full stop; empty for no item. Each text is fenced by more backticks than it
 * holds in a row (`interfaceCodeSpan`), so a text holding a backtick is named
 * whole.
 */
export function interfaceBlock(items: readonly InterfaceItem[]): string {
  if (items.length === 0) return ''
  return ` Interface: ${items.map((item) => `${item.kind} ${interfaceCodeSpan(item.text)}`).join('; ')}.`
}

/** The statement with its Interface block appended, or unchanged when the case has no item. */
export function withInterface(statement: string, items: readonly InterfaceItem[]): string {
  return `${statement}${interfaceBlock(items)}`
}

const utf8 = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8')

/** Collapses a declaration written across lines onto one, as a statement holds it. */
const oneLine = (source: string) => source.replace(/\s+/g, ' ').trim()

const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/

const parse = (path: string, source: string) => ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)

const hasExport = (node: ts.Node) =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)

/** Every node of a file, depth first. */
function eachNode(file: ts.SourceFile, visit: (node: ts.Node) => void): void {
  const walk = (node: ts.Node) => {
    visit(node)
    ts.forEachChild(node, walk)
  }
  walk(file)
}

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed })

/**
 * A type as written, on one line. A type the source writes on one line is
 * kept byte for byte; one written across lines is printed by the compiler's
 * printer in single-line mode, which keeps every token and writes the member
 * separators a line break stood for, so the text stays valid TypeScript.
 */
function typeText(file: ts.SourceFile, type: ts.TypeNode): string {
  const written = type.getText(file)
  if (!/[\r\n]/.test(written)) return written
  const singleLine = (node: ts.Node) => {
    ts.setEmitFlags(node, ts.EmitFlags.SingleLine)
    ts.forEachChild(node, singleLine)
  }
  singleLine(type)
  return oneLine(printer.printNode(ts.EmitHint.Unspecified, type, file))
}

/**
 * A parameter list as written, without its default values, which belong to
 * the body: a parameter with a default is written optional, with its type
 * only when the source annotates it, never the type the default implies.
 */
function parameterList(file: ts.SourceFile, parameters: readonly ts.ParameterDeclaration[]): string {
  const one = (p: ts.ParameterDeclaration) =>
    `${p.dotDotDotToken === undefined ? '' : '...'}${p.name.getText(file)}${
      p.questionToken !== undefined || p.initializer !== undefined ? '?' : ''
    }${p.type === undefined ? '' : `: ${typeText(file, p.type)}`}`
  return `(${parameters.map(one).join(', ')})`
}

const typeParameterList = (file: ts.SourceFile, params: ts.NodeArray<ts.TypeParameterDeclaration> | undefined) =>
  params === undefined ? '' : `<${params.map((p) => p.getText(file)).join(', ')}>`

/** A function's signature as written: its parameters and, when written, its return annotation. */
function signature(file: ts.SourceFile, fn: ts.SignatureDeclarationBase): string {
  return `${typeParameterList(file, fn.typeParameters)}${parameterList(file, fn.parameters)}${
    fn.type === undefined ? '' : `: ${typeText(file, fn.type)}`
  }`
}

/** A type alias names its members when it is a union of literals, and only its kind otherwise. */
function literalMembers(file: ts.SourceFile, type: ts.TypeNode): string | null {
  const members = ts.isUnionTypeNode(type) ? type.types : [type]
  return members.every((m) => ts.isLiteralTypeNode(m)) ? members.map((m) => m.getText(file)).join(' | ') : null
}

/** The declared signature of the top-level declaration `name` in `statement`, never a type the compiler infers. */
function declarationText(file: ts.SourceFile, statement: ts.Statement, name: string): string | null {
  if (ts.isFunctionDeclaration(statement) && statement.name?.text === name)
    return `function ${name}${signature(file, statement)}`
  if (ts.isClassDeclaration(statement) && statement.name?.text === name) {
    const heritage = (statement.heritageClauses ?? []).map((h) => ` ${h.getText(file)}`).join('')
    const ctor = statement.members.find(ts.isConstructorDeclaration)
    return `class ${name}${typeParameterList(file, statement.typeParameters)}${heritage}${
      ctor === undefined ? '' : ` { constructor${parameterList(file, ctor.parameters)} }`
    }`
  }
  if (ts.isInterfaceDeclaration(statement) && statement.name.text === name)
    return `interface ${name}${typeParameterList(file, statement.typeParameters)}`
  if (ts.isTypeAliasDeclaration(statement) && statement.name.text === name) {
    const members = literalMembers(file, statement.type)
    return `type ${name}${typeParameterList(file, statement.typeParameters)}${members === null ? '' : ` = ${members}`}`
  }
  if (ts.isEnumDeclaration(statement) && statement.name.text === name)
    return `enum ${name} { ${statement.members.map((m) => m.name.getText(file)).join(', ')} }`
  if (ts.isVariableStatement(statement)) {
    const keyword = statement.declarationList.flags & ts.NodeFlags.Const ? 'const' : 'let'
    for (const d of statement.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || d.name.text !== name) continue
      if (d.type !== undefined) return `${keyword} ${name}: ${typeText(file, d.type)}`
      const init = d.initializer
      if (init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)))
        return `${keyword} ${name}${signature(file, init)}`
      return `${keyword} ${name}`
    }
  }
  return null
}

/** Each blob's text, by the git that read it, so the cases that share a file read it once. */
const blobTexts = new WeakMap<Git, Map<string, string>>()

function blobReader(git: Git): (blob: string) => string {
  const known = blobTexts.get(git) ?? new Map<string, string>()
  blobTexts.set(git, known)
  return (blob) => {
    let source = known.get(blob)
    if (source === undefined) {
      source = utf8(git(['cat-file', 'blob', blob]))
      known.set(blob, source)
    }
    return source
  }
}

/** Every file of a commit's tree, by its path, with its blob. */
function treeOf(git: Git, commit: string): Map<string, string> {
  const tree = new Map<string, string>()
  for (const entry of utf8(git(['ls-tree', '-r', '-z', commit])).split('\0')) {
    const tab = entry.indexOf('\t')
    if (tab < 0) continue
    const [, type, blob] = entry.slice(0, tab).split(' ')
    if (type === 'blob' && blob !== undefined) tree.set(entry.slice(tab + 1), blob)
  }
  return tree
}

/** One revision's files: whether it holds a path, and that file's text. */
interface Revision {
  has: (path: string) => boolean
  read: (path: string) => string | null
}

/** Where a module specifier imported from `importer` points: a repository path, or `null` outside it. */
function resolveModule(
  specifier: string,
  importer: string,
  revision: Revision,
  workspace: ReadonlyMap<string, string>
): string | null {
  const target = specifier.startsWith('.')
    ? posix.normalize(posix.join(posix.dirname(importer), specifier))
    : (workspace.get(specifier) ?? null)
  if (target === null) return null
  const stem = target.replace(/\.[cm]?[jt]sx?$/, '')
  return [target, `${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`].find(revision.has) ?? null
}

/** Each workspace package's entry points at the base revision, by the specifier that imports them. */
function workspaceEntries(paths: Iterable<string>, base: Revision): Map<string, string> {
  const entries = new Map<string, string>()
  for (const path of paths) {
    const segments = path.split('/')
    if (segments.length !== 3 || !['packages', 'apps'].includes(segments[0] as string)) continue
    if (segments[2] !== 'package.json') continue
    const manifest = base.read(path)
    if (manifest === null) continue
    const { name, exports } = JSON.parse(manifest) as { name?: unknown; exports?: unknown }
    if (typeof name !== 'string' || exports === null || typeof exports !== 'object') continue
    const dir = posix.dirname(path)
    for (const [subpath, entry] of Object.entries(exports as Record<string, unknown>)) {
      if (typeof entry !== 'string') continue
      entries.set(subpath === '.' ? name : `${name}/${subpath.slice(2)}`, posix.join(dir, entry))
    }
  }
  return entries
}

const hasDefault = (node: ts.Node) =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)

/** The name a top-level statement declares and exports, when it exports one; a default export's is `default`. */
function exportedNames(statement: ts.Statement): string[] {
  if (!hasExport(statement)) return []
  if (hasDefault(statement)) return ['default']
  if (ts.isVariableStatement(statement))
    return statement.declarationList.declarations.flatMap((d) => (ts.isIdentifier(d.name) ? [d.name.text] : []))
  const named = statement as ts.Statement & { name?: ts.Node }
  return named.name !== undefined && ts.isIdentifier(named.name) ? [named.name.text] : []
}

/**
 * The declared signature of the export `name` of the module at `path`,
 * following `export … from` to the module that declares it; `null` when the
 * module does not export it.
 */
function exportOf(
  revision: Revision,
  parsed: (path: string) => ts.SourceFile | null,
  workspace: ReadonlyMap<string, string>,
  path: string,
  name: string,
  seen = new Set<string>()
): string | null {
  const file = parsed(path)
  if (file === null || seen.has(path)) return null
  seen.add(path)
  const local = (declared: string) => {
    for (const statement of file.statements) {
      const text = declarationText(file, statement, declared)
      if (text !== null) return text
    }
    return null
  }
  const from = (statement: ts.ExportDeclaration) =>
    statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
      ? resolveModule(statement.moduleSpecifier.text, path, revision, workspace)
      : null
  const starred: string[] = []
  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause
      if (clause === undefined) {
        const module = from(statement)
        if (module !== null) starred.push(module)
        continue
      }
      if (!ts.isNamedExports(clause)) continue
      const element = clause.elements.find((e) => e.name.getText(file) === name)
      if (element === undefined) continue
      const original = (element.propertyName ?? element.name).getText(file)
      if (statement.moduleSpecifier === undefined) return local(original)
      const module = from(statement)
      return module === null ? null : exportOf(revision, parsed, workspace, module, original, seen)
    }
    if (name === 'default' && ts.isExportAssignment(statement) && !statement.isExportEquals) {
      // `export default <name>` names a local declaration; any other expression is written by its kind alone.
      const declared = ts.isIdentifier(statement.expression) ? local(statement.expression.text) : null
      return `default ${declared ?? 'value'}`
    }
    if (!exportedNames(statement).includes(name)) continue
    if (name !== 'default') return declarationText(file, statement, name)
    const named = (statement as ts.Statement & { name?: ts.Identifier }).name
    const declared = named === undefined ? null : declarationText(file, statement, named.text)
    return `default ${declared ?? (ts.isClassDeclaration(statement) ? 'class' : 'function')}`
  }
  for (const module of starred) {
    const text = exportOf(revision, parsed, workspace, module, name, seen)
    if (text !== null) return text
  }
  return null
}

/** The modules a test file imports, each with the names it takes from it. */
function importsOf(file: ts.SourceFile): { specifier: string; names: string[] }[] {
  const imports: { specifier: string; names: string[] }[] = []
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const bindings = statement.importClause?.namedBindings
    // A default import takes the module's `default` export.
    const names: string[] = statement.importClause?.name === undefined ? [] : ['default']
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) names.push((element.propertyName ?? element.name).getText(file))
    } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
      // A namespace import takes the names its accesses read.
      const alias = bindings.name.text
      eachNode(file, (node) => {
        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === alias)
          names.push(node.name.text)
      })
    }
    imports.push({ specifier: statement.moduleSpecifier.text, names })
  }
  // A dynamic import is a module the test needs, named by the bindings it destructures.
  eachNode(file, (node) => {
    if (!ts.isCallExpression(node) || node.expression.kind !== ts.SyntaxKind.ImportKeyword) return
    const [argument] = node.arguments
    if (argument === undefined || !ts.isStringLiteralLike(argument)) return
    const declaration = ts.isAwaitExpression(node.parent) ? node.parent.parent : node.parent
    const names =
      declaration !== undefined && ts.isVariableDeclaration(declaration) && ts.isObjectBindingPattern(declaration.name)
        ? declaration.name.elements.map((e) => (e.propertyName ?? e.name).getText(file))
        : []
    imports.push({ specifier: argument.text, names })
  })
  return imports
}

/** Whether a call is `expect(...)`, `expect.<matcher>(...)` or a matcher chained onto one. */
function isAssertion(call: ts.CallExpression): boolean {
  let callee: ts.Expression = call.expression
  for (;;) {
    if (ts.isIdentifier(callee)) return callee.text === 'expect'
    if (ts.isPropertyAccessExpression(callee)) callee = callee.expression
    else if (ts.isCallExpression(callee)) callee = callee.expression
    else return false
  }
}

const isEnvObject = (node: ts.Expression) => {
  const written = node.getText()
  return written === 'env' || written.endsWith('.env')
}

/**
 * A string an assertion expects that is no numeric value: it holds a letter,
 * and no line break, since a statement is written on one line. A backtick is
 * allowed: the block fences each text with more backticks than it holds.
 */
const assertable = (value: string) => /\p{L}/u.test(value) && !/[\r\n]/.test(value)

/** The names that open a test or a group of tests, whose first argument is a title. */
const TEST_CALLS = new Set(['it', 'test', 'describe'])

/** Whether a call opens a test or a group: `it(...)`, `describe.skip(...)`, `it.each(table)(...)`. */
function isTestCall(call: ts.CallExpression): boolean {
  let callee: ts.Expression = call.expression
  for (;;) {
    if (ts.isIdentifier(callee)) return TEST_CALLS.has(callee.text)
    if (ts.isPropertyAccessExpression(callee)) callee = callee.expression
    else if (ts.isCallExpression(callee)) callee = callee.expression
    else return false
  }
}

/** Whether an assertion's chain holds `.not`, so its matcher checks that a value is absent. */
function isNegated(call: ts.CallExpression): boolean {
  let callee: ts.Expression = call.expression
  for (;;) {
    if (ts.isPropertyAccessExpression(callee)) {
      if (callee.name.text === 'not') return true
      callee = callee.expression
    } else if (ts.isCallExpression(callee)) callee = callee.expression
    else return false
  }
}

/**
 * The side of a test a node is on: `expected`, inside what a matcher compares
 * the actual value with; `input`, anything the test passes to the code under
 * test or computes the actual value from; `neutral`, a test title, a module
 * specifier, an assertion's message, or what a negated matcher checks is
 * absent.
 */
type TestSide = 'expected' | 'input' | 'neutral'

/** Strips the wrappers a table or an expected value may be written in: parentheses, `as const`, `satisfies`. */
function unwrapped(node: ts.Expression): ts.Expression {
  let at = node
  while (ts.isParenthesizedExpression(at) || ts.isAsExpression(at) || ts.isSatisfiesExpression(at)) at = at.expression
  return at
}

/**
 * Which side of a test each node is on. An assertion's matcher arguments are
 * expected, and so is a constant every use of which is expected, and a column
 * of a parameter table — rows a `for … of`, `.forEach`, `.map` or `.each`
 * destructures — every use of which inside the loop is expected. A value that
 * is used anywhere else is an input.
 */
function testSides(file: ts.SourceFile): (node: ts.Node) => TestSide {
  const declarations = new Map<string, ts.VariableDeclaration[]>()
  eachNode(file, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined)
      declarations.set(node.name.text, [...(declarations.get(node.name.text) ?? []), node])
  })
  // Every use of a name: an identifier that is neither a declared name nor a property name.
  const uses = new Map<string, ts.Identifier[]>()
  eachNode(file, (node) => {
    if (!ts.isIdentifier(node)) return
    const parent = node.parent
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return
    if (ts.isBindingElement(parent) && parent.propertyName === node) return
    if (ts.isPropertyAssignment(parent) && parent.name === node) return
    if (
      (ts.isVariableDeclaration(parent) || ts.isBindingElement(parent) || ts.isParameter(parent)) &&
      parent.name === node
    )
      return
    uses.set(node.text, [...(uses.get(node.text) ?? []), node])
  })

  // Each table cell, with the uses of the binding that destructures its column, inside the loop's body.
  const cells = new Map<ts.Node, { name: string; body: ts.Node }>()
  const tableRows = (expression: ts.Expression): readonly ts.Expression[] | null => {
    const at = unwrapped(expression)
    if (ts.isArrayLiteralExpression(at)) return at.elements
    if (!ts.isIdentifier(at)) return null
    const [only, ...more] = declarations.get(at.text) ?? []
    if (only === undefined || more.length > 0 || only.initializer === undefined) return null
    const initializer = unwrapped(only.initializer)
    return ts.isArrayLiteralExpression(initializer) ? initializer.elements : null
  }
  // Binds one value — a whole row, or one cell of it — to the name or pattern that destructures it.
  const bind = (value: ts.Expression, binding: ts.BindingName, body: ts.Node): void => {
    const at = unwrapped(value)
    if (ts.isIdentifier(binding)) cells.set(value, { name: binding.text, body })
    else if (ts.isArrayBindingPattern(binding) && ts.isArrayLiteralExpression(at)) {
      binding.elements.forEach((element, index) => {
        const cell = at.elements[index]
        if (cell !== undefined && ts.isBindingElement(element) && element.dotDotDotToken === undefined)
          bind(cell, element.name, body)
      })
    } else if (ts.isObjectBindingPattern(binding) && ts.isObjectLiteralExpression(at)) {
      for (const element of binding.elements) {
        const key = (element.propertyName ?? element.name).getText(file)
        const cell = at.properties.find(
          (p): p is ts.PropertyAssignment =>
            ts.isPropertyAssignment(p) && p.name.getText(file).replace(/^['"]|['"]$/g, '') === key
        )
        if (cell !== undefined) bind(cell.initializer, element.name, body)
      }
    }
  }
  // Binds each row to its loop's binding; `spread` binds each cell of a row to its own parameter, as `.each` calls.
  const columns = (
    rows: readonly ts.Expression[],
    bindings: readonly ts.ParameterDeclaration[] | readonly [ts.BindingName],
    body: ts.Node,
    spread = false
  ) => {
    for (const row of rows) {
      if (!spread) {
        const [binding] = bindings
        if (binding !== undefined) bind(row, ts.isParameter(binding) ? binding.name : binding, body)
        continue
      }
      const at = unwrapped(row)
      if (!ts.isArrayLiteralExpression(at)) continue
      bindings.forEach((binding, index) => {
        const cell = at.elements[index]
        if (cell !== undefined && ts.isParameter(binding)) bind(cell, binding.name, body)
      })
    }
  }
  eachNode(file, (node) => {
    if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
      const [declaration] = node.initializer.declarations
      const rows = tableRows(node.expression)
      if (declaration !== undefined && rows !== null) columns(rows, [declaration.name], node.statement)
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression
      // `rows.forEach(([a, b]) => …)` and `rows.map(…)`; `it.each(rows)(title, (a, b) => …)`.
      if (ts.isPropertyAccessExpression(callee) && ['forEach', 'map'].includes(callee.name.text)) {
        const [callback] = node.arguments
        const rows = tableRows(callee.expression)
        if (
          rows !== null &&
          callback !== undefined &&
          (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
        )
          columns(rows, callback.parameters.slice(0, 1), callback.body)
      } else if (
        ts.isCallExpression(callee) &&
        ts.isPropertyAccessExpression(callee.expression) &&
        callee.expression.name.text === 'each' &&
        isTestCall(callee)
      ) {
        const [table] = callee.arguments
        const callback = node.arguments[1]
        const rows = table === undefined ? null : tableRows(table)
        if (
          rows !== null &&
          callback !== undefined &&
          (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
        ) {
          // `.each` spreads an array row across the parameters, and passes any other row whole.
          const spread = rows.every((r) => ts.isArrayLiteralExpression(unwrapped(r)))
          columns(rows, spread ? callback.parameters : callback.parameters.slice(0, 1), callback.body, spread)
        }
      }
    }
  })

  const declared = new Map<ts.VariableDeclaration, TestSide>()
  const columnSides = new Map<ts.Node, TestSide>()
  // A value is expected when at least one use is expected and none is an input.
  const sideOfUses = (found: readonly ts.Node[]): TestSide => {
    const sides = found.map(side)
    if (sides.includes('input')) return 'input'
    return sides.includes('expected') ? 'expected' : 'neutral'
  }
  function side(node: ts.Node): TestSide {
    for (let at: ts.Node = node; !ts.isSourceFile(at); at = at.parent) {
      const cell = cells.get(at)
      if (cell !== undefined) {
        if (!columnSides.has(at)) {
          columnSides.set(at, 'neutral')
          const inBody = (uses.get(cell.name) ?? []).filter((u) => u.pos >= cell.body.pos && u.end <= cell.body.end)
          columnSides.set(at, sideOfUses(inBody))
        }
        return columnSides.get(at) as TestSide
      }
      const parent = at.parent
      if (ts.isImportDeclaration(parent)) return 'neutral'
      if (ts.isVariableDeclaration(parent) && parent.initializer === at && ts.isIdentifier(parent.name)) {
        if (!declared.has(parent)) {
          declared.set(parent, 'neutral')
          const name = parent.name.text
          const own = (uses.get(name) ?? []).filter(
            (u) => (declarations.get(name) ?? []).length === 1 || u.pos > parent.pos
          )
          declared.set(parent, sideOfUses(own))
        }
        return declared.get(parent) as TestSide
      }
      if (!ts.isCallExpression(parent) || !parent.arguments.includes(at as ts.Expression)) continue
      if (isAssertion(parent)) {
        if (!ts.isIdentifier(parent.expression)) return isNegated(parent) ? 'neutral' : 'expected'
        if (parent.arguments[0] !== at) return 'neutral'
        // Inside the actual value, a literal the code's output is compared with is expected: `c.code === 'x'`.
        const compared = node.parent
        return ts.isBinaryExpression(compared) &&
          [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(
            compared.operatorToken.kind
          ) &&
          ts.isStringLiteralLike(node)
          ? 'expected'
          : 'input'
      }
      if (isTestCall(parent) && parent.arguments[0] === at) return 'neutral'
    }
    return 'input'
  }
  return side
}

/** What the fail-to-pass tests check. */
interface Expectations {
  /**
   * Each string, or literal piece of a template, on the expected side of an
   * assertion, unless the same test file also uses it as an input.
   */
  strings: Set<string>
  /** Each key of an expected object, and each property an assertion reads from its actual value. */
  keys: Set<string>
}

function expectationsOf(tests: readonly ts.SourceFile[]): Expectations {
  const found: Expectations = { strings: new Set(), keys: new Set() }
  for (const file of tests) {
    const side = testSides(file)
    const strings = new Set<string>()
    const inputs = new Set<string>()
    const literal = (node: ts.Node, value: string) => {
      const at = side(node)
      if (at === 'expected' && assertable(value.trim())) strings.add(value.trim())
      else if (at === 'input') inputs.add(value.trim())
    }
    eachNode(file, (node) => {
      if (ts.isStringLiteralLike(node)) {
        if (!ts.isImportDeclaration(node.parent) && !ts.isExternalModuleReference(node.parent)) literal(node, node.text)
      } else if (ts.isTemplateExpression(node)) {
        literal(node, node.head.text)
        for (const span of node.templateSpans) literal(node, span.literal.text)
      } else if (
        (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
        ts.isObjectLiteralExpression(node.parent) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        side(node) === 'expected'
      ) {
        found.keys.add(node.name.text)
      } else if (ts.isCallExpression(node) && isAssertion(node) && ts.isIdentifier(node.expression)) {
        // The properties an assertion reads from the value it checks: `expect(result.mode)`.
        const [actual] = node.arguments
        if (actual === undefined) return
        const read = (at: ts.Node): void => {
          if (ts.isPropertyAccessExpression(at)) found.keys.add(at.name.text)
          if (!ts.isFunctionLike(at)) ts.forEachChild(at, read)
        }
        read(actual)
      }
    })
    for (const value of strings) if (!inputs.has(value)) found.strings.add(value)
  }
  return found
}

/** Most characters of a template's outer pieces a match may start or end inside, so its pattern stays small. */
const TEMPLATE_PIECE_LIMIT = 120

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** An alternation of every suffix (or prefix) of `piece`, longest first, the empty one included. */
function partsOf(piece: string, end: 'suffix' | 'prefix'): string {
  const kept = end === 'suffix' ? piece.slice(-TEMPLATE_PIECE_LIMIT) : piece.slice(0, TEMPLATE_PIECE_LIMIT)
  const options: string[] = []
  for (let n = kept.length; n > 0; n--) options.push(escapeRegExp(end === 'suffix' ? kept.slice(-n) : kept.slice(0, n)))
  return `(?:${[...options, ''].join('|')})`
}

/**
 * The literal pieces of each text a file builds: a template literal with
 * substitutions, or a `+` concatenation holding a string literal, each
 * substitution standing between two pieces.
 */
function templatesIn(file: ts.SourceFile): string[][] {
  const templates: string[][] = []
  eachNode(file, (node) => {
    if (ts.isTemplateExpression(node)) {
      templates.push([node.head.text, ...node.templateSpans.map((s) => s.literal.text)])
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      !(ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken)
    ) {
      const operands: ts.Expression[] = []
      const flatten = (e: ts.Expression): void => {
        const at = unwrapped(e)
        if (ts.isBinaryExpression(at) && at.operatorToken.kind === ts.SyntaxKind.PlusToken) {
          flatten(at.left)
          flatten(at.right)
        } else operands.push(at)
      }
      flatten(node)
      if (!operands.some(ts.isStringLiteralLike)) return
      const pieces = ['']
      for (const operand of operands) {
        if (ts.isStringLiteralLike(operand)) pieces[pieces.length - 1] += operand.text
        else pieces.push('')
      }
      if (pieces.length > 1) templates.push(pieces)
    }
  })
  return templates
}

/**
 * Whether a value is text some template builds: some run of its pieces, the
 * first entered at any point and the last left at any point, with anything
 * in each substitution between them, spells the value, and the pieces it
 * matched hold a letter and at least half of its characters.
 */
function builtBy(templates: readonly string[][]): (value: string) => boolean {
  // One run of pieces: its outer pieces, the pieces it must hold whole, and its pattern, compiled on first use.
  const windows: { first: string; last: string; middle: string[]; pattern: () => RegExp }[] = []
  for (const pieces of templates) {
    for (let first = 0; first < pieces.length - 1; first++) {
      for (let last = first + 1; last < pieces.length; last++) {
        const middle = pieces.slice(first + 1, last)
        let compiled: RegExp | undefined
        const pattern = () => {
          compiled ??= new RegExp(
            `^${partsOf(pieces[first] as string, 'suffix')}${middle
              .map((p) => `([\\s\\S]*?)${escapeRegExp(p)}`)
              .join('')}([\\s\\S]*?)${partsOf(pieces[last] as string, 'prefix')}$`,
            'd'
          )
          return compiled
        }
        windows.push({ first: pieces[first] as string, last: pieces[last] as string, middle, pattern })
      }
    }
  }
  const enough = (literal: string, value: string) => /\p{L}/u.test(literal) && literal.length * 2 >= value.length
  return (value) =>
    windows.some(({ first, last, middle, pattern }) => {
      if (middle.length === 0) {
        // One substitution between the two pieces: the longest end of the first the value opens with, then the
        // longest start of the last it closes with in what is left — what the pattern would match, found directly.
        const head = first.slice(-TEMPLATE_PIECE_LIMIT)
        let a = Math.min(head.length, value.length)
        while (a > 0 && !value.startsWith(head.slice(-a))) a--
        const tail = last.slice(0, TEMPLATE_PIECE_LIMIT)
        let b = Math.min(tail.length, value.length - a)
        while (b > 0 && !value.endsWith(tail.slice(0, b))) b--
        return enough(value.slice(0, a) + value.slice(value.length - b), value)
      }
      if (!middle.every((piece) => value.includes(piece))) return false
      const match = pattern().exec(value)
      if (match === null) return false
      let literal = value
      const groups = (match.indices ?? []).slice(1).filter((g): g is [number, number] => g !== undefined)
      for (const [from, to] of [...groups].sort((a, b) => b[0] - a[0]))
        literal = literal.slice(0, from) + literal.slice(to)
      return enough(literal, value)
    })
}

/** A command-line flag a string literal names: its leading `--name`, before any `=` value. */
function flagIn(value: string): string | null {
  const [token] = value.split(/[=\s]/)
  return token !== undefined && /^--[a-z][a-z0-9-]*$/.test(token) ? token : null
}

/** What one parsed test file contributes: its identifiers, property names and string literal pieces. */
function testTokens(file: ts.SourceFile, into: Set<string>): void {
  eachNode(file, (node) => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) into.add(node.text)
    else if (ts.isStringLiteralLike(node)) {
      into.add(node.text)
      for (const piece of node.text.split(/\s+/)) {
        into.add(piece)
        const flag = flagIn(piece)
        if (flag !== null) into.add(flag)
      }
    }
  })
}

/**
 * The name of the interface, class or object type alias a field is a direct
 * member of; a field of a nested type is written in its parent field's type.
 */
function ownerOf(node: ts.Node): string | null {
  const parent = node.parent
  if ((ts.isInterfaceDeclaration(parent) || ts.isClassDeclaration(parent)) && parent.name !== undefined)
    return parent.name.text
  if (ts.isTypeLiteralNode(parent) && ts.isTypeAliasDeclaration(parent.parent)) return parent.parent.name.text
  return null
}

/**
 * A field's value type as written, followed by its type's literal union or
 * enum members when the same file declares that type.
 */
function fieldType(file: ts.SourceFile, type: ts.TypeNode): string {
  const written = typeText(file, type)
  if (!ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName)) return written
  const name = type.typeName.text
  for (const statement of file.statements) {
    if (ts.isTypeAliasDeclaration(statement) && statement.name.text === name) {
      const members = literalMembers(file, statement.type)
      return members === null ? written : `${written} = ${members}`
    }
    if (ts.isEnumDeclaration(statement) && statement.name.text === name)
      return `${written} = ${statement.members.map((m) => `${name}.${m.name.getText(file)}`).join(' | ')}`
  }
  return written
}

/** One field a named type declares: the item text it is named by, and its written form when that is one line. */
interface DeclaredField {
  name: string
  text: string
  /** `name: type` as the source writes it, for the base search; `null` when the type spans lines. */
  probe: string | null
}

/** Every field a direct member of a named interface, class or object type alias declares in `file`. */
function declaredFields(file: ts.SourceFile): DeclaredField[] {
  const fields: DeclaredField[] = []
  eachNode(file, (node) => {
    if (!(ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) || node.type === undefined) return
    if (!ts.isIdentifier(node.name) && !ts.isStringLiteral(node.name)) return
    // A field of an anonymous type — a cast, a local parameter — belongs to the code, not its interface.
    const owner = ownerOf(node)
    if (owner === null) return
    const name = node.name.text
    const written = node.type.getText(file)
    fields.push({
      name,
      text: `${owner}.${name}: ${oneLine(fieldType(file, node.type))}`,
      probe: /[\r\n]/.test(written) ? null : `${name}: ${written}`
    })
  })
  return fields
}

/** Most `-e` patterns one `git grep` is given, so its argument list stays well inside the system's limit. */
const GREP_PATTERNS_PER_CALL = 200

/**
 * The literals some tracked file of `commit`, other than the `skipped` paths,
 * contains, found by fixed-string `git grep -F -o` calls. A literal the
 * search printed only inside a longer match it also printed is found too.
 * Only exit status `1`, nothing found, is read as no match; any other failure
 * refuses the re-cut.
 */
function baseMatches(git: Git, commit: string, literals: readonly string[], skipped: readonly string[]): Set<string> {
  const found = new Set<string>()
  for (let at = 0; at < literals.length; at += GREP_PATTERNS_PER_CALL) {
    const batch = literals.slice(at, at + GREP_PATTERNS_PER_CALL)
    const output = utf8(
      git(
        [
          'grep',
          '-F',
          '-o',
          '-h',
          '--no-color',
          ...batch.flatMap((l) => ['-e', l]),
          commit,
          '--',
          '.',
          ...skipped.map((path) => `:(exclude)${path}`)
        ],
        { quietExit: 1 }
      )
    )
    // With `-h`, each printed line is one match alone.
    const matched = [...new Set(output.split('\n').filter(Boolean))]
    for (const l of batch) if (matched.some((m) => m.includes(l))) found.add(l)
  }
  return found
}

/**
 * A case's Interface items: each export its fail-to-pass tests import from
 * the reference change with its declared signature, each new file they
 * import, each environment variable, flag, event and field both they and the
 * reference solution contain, and each expected string the reference writes
 * or builds and expected or read key it names, that the tests do not pass in
 * themselves — less every item the base revision already holds. Items are
 * listed by kind, then by text.
 */
export function interfaceItems(git: Git, c: DeveloperCapabilityCase): InterfaceItem[] {
  // A case's items depend only on its pinned blobs and base, so each is derived once per git that reads them.
  const known = derivedItems.get(git) ?? new Map<string, InterfaceItem[]>()
  derivedItems.set(git, known)
  const key = canonicalJson([c.id, c.baseCommit, c.referenceSolution, c.hiddenTests, c.failToPass])
  let items = known.get(key)
  if (items === undefined) {
    items = deriveInterfaceItems(git, c)
    known.set(key, items)
  }
  return items.map((item) => ({ ...item }))
}

/** Each case's derived items, by the git that read them. */
const derivedItems = new WeakMap<Git, Map<string, InterfaceItem[]>>()

function deriveInterfaceItems(git: Git, c: DeveloperCapabilityCase): InterfaceItem[] {
  const memo = <T>(compute: (path: string) => T) => {
    const cache = new Map<string, T>()
    return (path: string) => {
      if (!cache.has(path)) cache.set(path, compute(path))
      return cache.get(path) as T
    }
  }
  const blobText = blobReader(git)
  const baseTree = treeOf(git, c.baseCommit)
  const base: Revision = {
    has: (path) => baseTree.has(path),
    read: (path) => {
      const blob = baseTree.get(path)
      return blob === undefined ? null : blobText(blob)
    }
  }
  const referenceBlobs = new Map(c.referenceSolution.files.map((f) => [f.path, f.blob]))
  const deleted = new Set(c.referenceSolution.deleted)
  const referenceBlob = (path: string) =>
    deleted.has(path) ? undefined : (referenceBlobs.get(path) ?? baseTree.get(path))
  const reference: Revision = {
    has: (path) => referenceBlob(path) !== undefined,
    read: (path) => {
      const blob = referenceBlob(path)
      return blob === undefined ? null : blobText(blob)
    }
  }
  const parser = (revision: Revision) =>
    memo((path) => {
      const source = revision.read(path)
      return source === null ? null : parse(path, source)
    })
  const testBlobs = new Map(c.hiddenTests.files.map((f) => [f.path, f.blob]))
  const failToPass = Object.keys(c.failToPass).filter((path) => testBlobs.has(path) && CODE_FILE.test(path))
  const tests = failToPass.map((path) => parse(path, blobText(testBlobs.get(path) as string)))
  const workspace = workspaceEntries(baseTree.keys(), base)

  const items = new Map<string, InterfaceItem>()
  const add = (kind: InterfaceKind, text: string) => {
    items.set(`${kind}\0${text}`, { kind, text })
  }

  // Exports and new files, from each test's imports.
  const referenceParsed = parser(reference)
  const baseParsed = parser(base)
  for (const test of tests) {
    for (const { specifier, names } of importsOf(test)) {
      const path = resolveModule(specifier, test.fileName, reference, workspace)
      if (path === null || testBlobs.has(path)) continue
      if (referenceBlobs.has(path) && !base.has(path)) add('file', path)
      for (const name of new Set(names)) {
        const declared = exportOf(reference, referenceParsed, workspace, path, name)
        if (declared === null || exportOf(base, baseParsed, workspace, path, name) === declared) continue
        add('export', `${path}: ${oneLine(declared)}`)
      }
    }
  }

  // Literals both the tests and the reference solution contain.
  const tokens = new Set<string>()
  for (const test of tests) testTokens(test, tokens)
  const referenceFiles = c.referenceSolution.files.flatMap((f) => {
    const source = reference.read(f.path)
    return source === null ? [] : [{ path: f.path, source }]
  })
  // Each literal with the text the base search looks for: a field as the source writes it, without its owner,
  // or `null` for a field whose type spans lines, which only the structural check below can find.
  const literals: (InterfaceItem & { probe: string | null })[] = []
  const literal = (kind: InterfaceKind, text: string, probe: string | null = text) =>
    literals.push({ kind, text, probe })
  for (const { path, source } of referenceFiles.filter((f) => CODE_FILE.test(f.path))) {
    const file = parse(path, source)
    for (const field of declaredFields(file)) if (tokens.has(field.name)) literal('field', field.text, field.probe)
    eachNode(file, (node) => {
      if (ts.isPropertyAccessExpression(node) && isEnvObject(node.expression)) {
        literal('env', node.name.text)
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer !== undefined &&
        isEnvObject(node.initializer)
      ) {
        // `const { NAME } = process.env` reads each name it destructures.
        for (const element of node.name.elements) {
          const read = element.propertyName ?? element.name
          if (ts.isIdentifier(read) || ts.isStringLiteral(read)) literal('env', read.text)
        }
      } else if (
        ts.isElementAccessExpression(node) &&
        isEnvObject(node.expression) &&
        ts.isStringLiteralLike(node.argumentExpression)
      ) {
        literal('env', node.argumentExpression.text)
      } else if (ts.isStringLiteralLike(node)) {
        const flag = flagIn(node.text)
        if (flag !== null) literal('flag', flag)
      } else if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ['on', 'emit', 'once'].includes(node.expression.name.text)
      ) {
        const [event] = node.arguments
        if (event !== undefined && ts.isStringLiteralLike(event)) literal('event', event.text)
      }
    })
  }
  // What the tests check: an expected string the reference writes, or builds from a template, and an expected
  // or read key the reference names — never a value the tests themselves pass to the code under test.
  const expected = expectationsOf(tests)
  const referenceCode = referenceFiles.filter((f) => CODE_FILE.test(f.path)).map((f) => parse(f.path, f.source))
  const builtByReference = builtBy(referenceCode.flatMap(templatesIn))
  const templated = new Set<string>()
  for (const value of expected.strings) {
    if (referenceFiles.some((f) => f.source.includes(value))) literal('string', value)
    else if (builtByReference(value)) {
      templated.add(value)
      literal('string', value)
    }
  }
  const referenceNames = new Set<string>()
  const referenceKeys = new Set<string>()
  const fieldNames = new Set(referenceCode.flatMap((file) => declaredFields(file).map((field) => field.name)))
  for (const file of referenceCode) {
    eachNode(file, (node) => {
      if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) referenceNames.add(node.text)
      // An object literal's keys, a schema's among them: `{ name: … }`, `z.object({ name: … })`.
      if (
        (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isMethodDeclaration(node)) &&
        ts.isObjectLiteralExpression(node.parent) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
      )
        referenceKeys.add(node.name.text)
    })
  }
  const imported = new Set(tests.flatMap((test) => importsOf(test).flatMap((i) => i.names)))
  const keys = new Set([...expected.keys, ...[...referenceKeys].filter((key) => tokens.has(key))])
  for (const key of keys) {
    if (!referenceNames.has(key) || fieldNames.has(key) || imported.has(key) || !/\p{L}/u.test(key)) continue
    literal('key', key)
  }

  // A literal any base file outside the fail-to-pass tests already holds is left out. The
  // base copies of the files the reference solution changes are read already: a field any
  // of them declares with the same owner, name and type is held, compared as parsed so a
  // type written across lines is found too, and every other literal none of their texts
  // holds is looked for by a fixed-string search of the base revision.
  const candidates = literals.filter(
    ({ kind, text }) => kind === 'field' || kind === 'string' || kind === 'key' || tokens.has(text)
  )
  const changedAtBase = c.referenceSolution.files.flatMap((f) => {
    const source = failToPass.includes(f.path) ? null : base.read(f.path)
    return source === null ? [] : [{ path: f.path, source }]
  })
  const baseCode = changedAtBase.filter((f) => CODE_FILE.test(f.path)).map((f) => parse(f.path, f.source))
  const baseFields = new Set(baseCode.flatMap((file) => declaredFields(file).map((field) => field.text)))
  // A string the reference builds from a template is held when the base copy of a changed file builds it too.
  const builtByBase = builtBy(baseCode.flatMap(templatesIn))
  const held = (probe: string) => changedAtBase.some((f) => f.source.includes(probe))
  const unseen = [...new Set(candidates.flatMap((l) => (l.probe === null || held(l.probe) ? [] : [l.probe])))]
  const searched = baseMatches(git, c.baseCommit, unseen, failToPass)
  for (const { kind, text, probe } of candidates) {
    if (kind === 'field' && baseFields.has(text)) continue
    if (kind === 'string' && templated.has(text) && builtByBase(text)) continue
    if (probe !== null && (held(probe) || searched.has(probe))) continue
    add(kind, text)
  }

  const order = (item: InterfaceItem) => INTERFACE_KINDS.indexOf(item.kind)
  return [...items.values()].sort((a, b) => order(a) - order(b) || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0))
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

/** A held-out source-citation case's statement, from how many documents it delivers. */
export function generatedSourceCitationStatement(c: SourceCitationCase): string {
  const delivered = c.sources.length
  const core =
    delivered === 0
      ? 'Answer the request. No document is delivered with this task, so cite none.'
      : `Answer the request from the ${plural(delivered, 'document')} delivered with this task, and cite each delivered document your answer relies on. Cite no document that was not delivered.`
  return firstAllowed(core, 'Answer the request, citing only documents delivered with this task.')
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
  suites: { suite: string; cases: { id: string }[]; layerPOnly: string[]; variants?: Record<string, string[]> }[],
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
  const developerStatement = new Map(
    developerFile.cases.map((c) => [c.id, withInterface(statementFor(c.id), interfaceItems(git, c))])
  )
  const statementOf = (c: DeveloperCapabilityCase) => developerStatement.get(c.id) as string
  let undeliverable = 0
  const developerCases = developerFile.cases.map((c) => {
    const derived = deriveDeveloperCase(git, c, statementOf(c))
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
  const loopCases = developerFile.cases.map((c) => deriveLoopCase(git, c, statementOf(c)).case)
  const wholeLoop = derivedFile(
    DERIVED_FILES.wholeLoop.development,
    'development',
    [DEVELOPER_CASES_PATH, STATEMENTS_PATH, REVISION_FACTS_PATH],
    [
      {
        suite: GENERIC_SUITE_IDS.wholeLoop,
        cases: loopCases,
        layerPOnly: [],
        variants: loopVariants(loopCases, loadRevisionFacts())
      }
    ],
    undeliverable
  )
  return {
    files: [developer.file, reviewers.file, citation.file, wholeLoop.file],
    summary: { files: [developer.summary, reviewers.summary, citation.summary, wholeLoop.summary] }
  }
}

/**
 * Derives the held-out files, inside the sealed run: each case is read by
 * field and its statement generated from its own fields, and only counts, ids
 * and digests leave the run. Each approval is the pinned digest of its
 * layer-`P` held-out file; the whole-loop held-out cases are cut from the
 * developer held-out cases, under the developer approval.
 */
export function recutHeldOut(
  approvals: { developer: string; reviewer: string; sourceCitation: string },
  git: Git = repositoryGit
): Recut {
  const developerFile = loadDeveloperCaseFile()
  // Every approval is checked, by opening its held-out cases, before any case is derived, so a wrong one is
  // refused before the run spends any work.
  const developerHeld = loadDeveloperHeldOut(developerFile, approvals.developer)
  const codeReviewerHeld = loadReviewerHeldOut('code-reviewer', approvals.reviewer)
  const securityReviewerHeld = loadReviewerHeldOut('security-reviewer', approvals.reviewer)
  const citationFile = loadSourceCitationCaseFile()
  const citationHeld = loadSourceCitationHeldOut(citationFile, approvals.sourceCitation)
  // Derived only here, once the approval has opened the held-out cases, and never printed.
  const developerStatement = new Map(
    developerHeld.map((c) => [c.id, withInterface(generatedDeveloperStatement(c), interfaceItems(git, c))])
  )
  const statementOf = (c: DeveloperCapabilityCase) => developerStatement.get(c.id) as string
  let undeliverable = 0
  const developerCases = developerHeld.map((c) => {
    const derived = deriveDeveloperCase(git, c, statementOf(c))
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
        cases: codeReviewerHeld
      },
      {
        role: 'security-reviewer',
        suite: GENERIC_SUITE_IDS.securityReviewer,
        cases: securityReviewerHeld
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
  const citationCases = citationHeld.map((c) =>
    deriveSourceCitationCase(citationFile.repositoryCommit, c, generatedSourceCitationStatement(c))
  )
  const citation = derivedFile(
    DERIVED_FILES.sourceCitation.heldOut,
    'held-out',
    [SOURCE_CITATION_HELD_OUT_PATH],
    [{ suite: GENERIC_SUITE_IDS.sourceCitation, cases: citationCases, layerPOnly: [] }],
    0
  )
  const loopCases = developerHeld.map((c) => deriveLoopCase(git, c, statementOf(c)).case)
  const wholeLoop = derivedFile(
    DERIVED_FILES.wholeLoop.heldOut,
    'held-out',
    [join(import.meta.dir, developerFile.splits.heldOut.file), REVISION_FACTS_PATH],
    [
      {
        suite: GENERIC_SUITE_IDS.wholeLoop,
        cases: loopCases,
        layerPOnly: [],
        variants: loopVariants(loopCases, loadRevisionFacts())
      }
    ],
    undeliverable
  )
  return {
    files: [developer.file, reviewers.file, citation.file, wholeLoop.file],
    summary: {
      files: [developer.summary, reviewers.summary, citation.summary, wholeLoop.summary],
      heldOutIds: {
        [GENERIC_SUITE_IDS.developer]: developerCases.map((c) => c.id),
        ...Object.fromEntries(reviewerSuitesHeld.map((s) => [s.suite, s.cases.map((c) => c.id)])),
        [GENERIC_SUITE_IDS.sourceCitation]: citationCases.map((c) => c.id),
        [GENERIC_SUITE_IDS.wholeLoop]: loopCases.map((c) => c.id)
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
      'usage: recut-generic-cases.ts development | held-out --approve-developer <sha256> --approve-reviewer <sha256> --approve-source-citation <sha256>\n'
    )
    return 2
  }
  try {
    const recut =
      mode === 'development'
        ? recutDevelopment()
        : recutHeldOut({
            developer: flag(argv, 'approve-developer'),
            reviewer: flag(argv, 'approve-reviewer'),
            sourceCitation: flag(argv, 'approve-source-citation')
          })
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
