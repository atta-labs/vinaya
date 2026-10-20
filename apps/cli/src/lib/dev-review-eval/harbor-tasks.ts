/**
 * The Harbor task converter: turns every case of the four layer-`G` role
 * suites into one Harbor task folder, `<out>/<suite>/<case id>/`, so each
 * suite folder is one Harbor dataset that `harbor run` evaluates with the
 * `vinaya` agent (`vinaya_harbor_agent.py`).
 *
 * A folder holds:
 *
 *  - `task.toml` — the Harbor version, the suite, the Vinaya renderer version
 *    and the network policy of each phase;
 *  - `instruction.md` — the case's neutral task statement;
 *  - `environment/` — the image: the case repository at `/app` at its real
 *    base commit, with every evaluation case file and every held-out file left
 *    out of its working tree and object store, and `case.json`, the neutral
 *    case with what the run needs from the layer-`P` case of the same id;
 *    with `--archive`, also the Vinaya CLI archive, which the image unpacks at
 *    `/opt/vinaya` and installs the workspace dependencies of at build;
 *  - `tests/` — the verifier: `test.sh`, the bundled `grade.js`, the grading
 *    spec and the hidden test files;
 *  - `solution/` — the oracle: `solve.sh`, the bundled `oracle.js` and the
 *    reference outcome.
 *
 * Hidden tests and the reference outcome are written only under `tests/` and
 * `solution/`, which the role never sees. The folders are derived, byte for
 * byte, from committed files, and are written only under `--out`, never into
 * the repository. Held-out cases convert only with an approval naming a
 * pinned held-out digest, and the converter then prints only case ids and
 * counts.
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  type DeveloperCapabilityCase,
  loadCaseFile as loadDeveloperCaseFile,
  loadHeldOutCases as loadDeveloperHeldOut
} from '../../../tests/eval/developer-capability-suite'
import {
  DERIVED_FILE_DIGESTS,
  DerivedFileRefused,
  developmentCases,
  type GenericSuiteKey,
  heldOutCases,
  type ReadBytes,
  referenceEntry
} from '../../../tests/eval/generic-suites'
import { GENERIC_SUITE_IDS, SEEDED_COMMIT_IDENTITY, STATEMENTS_PATH } from '../../../tests/eval/recut-generic-cases'
import {
  loadDevelopment as loadReviewerDevelopment,
  loadHeldOut as loadReviewerHeldOut,
  type ReviewCase
} from '../../../tests/eval/reviewer-quality-suite'
import {
  loadCaseFile as loadCitationCaseFile,
  type SourceCitationCase
} from '../../../tests/eval/source-citation-suite'
import type { ReviewerRole } from '../review-result'
import type { Quarantine } from './contracts'
import type { GradingSpec, OracleSpec } from './harbor-grade'
import { checkedQuarantine, HarborResultsRefused, QUARANTINE_METADATA } from './harbor-results'
import type { HarborCaseFile, HarborCounterpart } from './harbor-trial'
import type { NeutralCase } from './neutral-case'
import type { StepOneRunSuite } from './step-one'
import { renderCase, VINAYA_RENDERER_VERSION } from './vinaya-renderer'

/** The Harbor release the task folders are written for. */
export const HARBOR_VERSION = '0.24.0'

/** The images and the Claude Code release every task image is built from. */
export const BUN_IMAGE = 'oven/bun:1.4.2'
export const NODE_IMAGE = 'node:22-bookworm'
export const CLAUDE_CODE_PACKAGE = '@anthropic-ai/claude-code@2.1.300'

/**
 * The directory of its own that holds the `claude` link, first on `PATH`: a
 * test that drops every `PATH` directory holding `claude`, `codex` or `gemini`
 * still finds `bun` and `node` in `/usr/local/bin`.
 */
export const CLAUDE_BIN_DIRECTORY = '/opt/claude/bin'

/** The image's non-root user, which the role, the verifier and the oracle run as, and its home. */
export const TASK_USER = 'tester'
export const TASK_USER_ID = 1001
export const TASK_USER_HOME = `/home/${TASK_USER}`

/**
 * The only host the agent phase reaches: the Anthropic API that Claude Code's
 * subscription inference calls. The token is given, so no login host is
 * needed, and Claude Code's other traffic is switched off.
 */
export const AGENT_ALLOWED_HOSTS = ['api.anthropic.com'] as const

/** The repository root, which the converter reads cases, blobs and the archive from. */
export const REPOSITORY_ROOT = join(import.meta.dir, '../../../../..')

/**
 * The paths no task image and no Vinaya archive holds: every evaluation case
 * file, among them the files carrying hidden tests and reference patches, and
 * every held-out file anywhere, as a non-cone sparse-checkout pattern list (a
 * cone pattern cannot leave out a file pattern) and as git pathspecs.
 */
export const SPARSE_CHECKOUT_PATTERNS = ['/*', '!/apps/cli/tests/eval/*.json', '!*held-out*.json'] as const
export const EXCLUDED_PATHSPECS = [
  ':(exclude,glob)apps/cli/tests/eval/*.json',
  ':(exclude,glob)**/*held-out*.json'
] as const

/** Whether a repository path is one no task image and no Vinaya archive holds. */
export function isExcludedPath(path: string): boolean {
  const name = path.split('/').at(-1) ?? ''
  return /^apps\/cli\/tests\/eval\/[^/]+\.json$/.test(path) || /held-out.*\.json$/.test(name)
}

/** The suites converted, in order, by their key in the layer-`G` suite table. */
export const HARBOR_SUITE_KEYS: readonly GenericSuiteKey[] = [
  'developer',
  'codeReviewer',
  'securityReviewer',
  'sourceCitation'
]

/** A suite's name, as its Harbor dataset folder and step one name it. */
export const suiteName = (key: GenericSuiteKey) => GENERIC_SUITE_IDS[key].split('@')[0] as StepOneRunSuite

/** The reviewer of each review suite. */
const REVIEWER_OF: Partial<Record<GenericSuiteKey, ReviewerRole>> = {
  codeReviewer: 'code-reviewer',
  securityReviewer: 'security-reviewer'
}

export class HarborTasksRefused extends Error {}

// ── Deterministic output ────────────────────────────────────────────────────

/** One file of a task folder: its bytes and its mode. */
export interface TaskFile {
  content: string | Uint8Array
  mode: 0o644 | 0o755
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])])
    )
  }
  return value
}

/** JSON with every object's keys sorted, two-space indented, ending in a newline. */
export const stableJson = (value: unknown) => `${JSON.stringify(sortKeys(value), null, 2)}\n`

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

const tomlString = (value: string) => JSON.stringify(value)

/** Writes a task folder's files in path order, each with its fixed mode. */
export function writeTaskFolder(directory: string, files: ReadonlyMap<string, TaskFile>): void {
  rmSync(directory, { recursive: true, force: true })
  for (const path of [...files.keys()].sort()) {
    const file = files.get(path) as TaskFile
    const target = join(directory, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.content)
    chmodSync(target, file.mode)
  }
}

// ── Repository reads ────────────────────────────────────────────────────────

function repositoryGit(args: readonly string[]): Buffer {
  const run = spawnSync('git', [...args], { cwd: REPOSITORY_ROOT, maxBuffer: 1024 * 1024 * 1024 })
  if (run.status !== 0) throw new Error(`git ${args[0]} failed: ${run.stderr?.toString('utf8').trim()}`)
  return run.stdout
}

const blob = (id: string) => repositoryGit(['cat-file', 'blob', id])

/**
 * The mode each of `paths` is written with, from its git file mode at
 * `commit`: `0o755` for an executable file (`100755`), `0o644` otherwise.
 */
export function gitFileModes(commit: string, paths: readonly string[]): Map<string, TaskFile['mode']> {
  const modes = new Map<string, TaskFile['mode']>(paths.map((path) => [path, 0o644]))
  if (paths.length === 0) return modes
  const listing = repositoryGit(['ls-tree', '-z', commit, '--', ...paths]).toString('utf8')
  for (const entry of listing.split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t')
    const path = entry.slice(tab + 1)
    if (modes.has(path) && entry.startsWith('100755 ')) modes.set(path, 0o755)
  }
  return modes
}

/**
 * Writes the Vinaya CLI at the evaluated commit, `HEAD`, as a tar archive,
 * leaving out every evaluation case file and every held-out file: the run in
 * the container reads its case only from the case file.
 */
export function writeArchive(path: string): void {
  repositoryGit(['archive', '--format=tar', `--output=${path}`, 'HEAD', '--', '.', ...EXCLUDED_PATHSPECS])
}

// ── The bundled grade and oracle script ─────────────────────────────────────

const RENDERER_SOURCES_READ =
  "MAPPING_SOURCE_PATHS.map((path) => [path, readFileSync(join(REPOSITORY_ROOT, path), 'utf8')])"
const RENDERER_VERSION_COMPUTED =
  'export const VINAYA_RENDERER_VERSION = rendererVersionOf(MAPPING_TABLES, MAPPING_LOGIC, MAPPING_SOURCES)'

/**
 * The renderer's source as the bundle carries it: the version computed in
 * this process from the mapping sources becomes a literal, and the mapping
 * sources are not read, so the bundle never reads a repository file and its
 * records are never refused as stale.
 */
export function inlineRendererVersion(source: string, version: string = VINAYA_RENDERER_VERSION): string {
  for (const expected of [RENDERER_SOURCES_READ, RENDERER_VERSION_COMPUTED]) {
    if (!source.includes(expected)) throw new Error(`the renderer no longer contains: ${expected}`)
  }
  return source
    .replace(RENDERER_SOURCES_READ, '[]')
    .replace(RENDERER_VERSION_COMPUTED, `export const VINAYA_RENDERER_VERSION = ${JSON.stringify(version)}`)
}

/** Bundles `harbor-grade.ts` into one script that runs under Bun with no repository beside it. */
export async function bundleGradeScript(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, 'harbor-grade.ts')],
    target: 'bun',
    format: 'esm',
    plugins: [
      {
        name: 'inline-vinaya-renderer-version',
        setup(build) {
          build.onLoad({ filter: /[\\/]dev-review-eval[\\/]vinaya-renderer\.ts$/ }, ({ path }) => ({
            contents: inlineRendererVersion(readFileSync(path, 'utf8')),
            loader: 'ts'
          }))
        }
      }
    ]
  })
  const [output] = built.outputs
  if (!built.success || output === undefined) {
    throw new Error(`the grade script did not bundle: ${built.logs.map(String).join('; ')}`)
  }
  return output.text()
}

// ── Task folder contents ────────────────────────────────────────────────────

/** The repository a case is cloned from at image build. */
export type RepositoryUrl = (repository: string) => string
export const GITHUB_REPOSITORY_URL: RepositoryUrl = (repository) => `https://github.com/${repository}.git`

/**
 * The clone script: a partial clone of the base commit with its full commit
 * history and no blob fetched up front, checked out through a non-cone sparse checkout that leaves
 * the excluded paths out, so their blobs are never fetched; then the install
 * command `PREPARE_INSTALL` names, when it names one, while the remote still
 * exists; then the remote removed, so no blob can be fetched later. A review case whose head commit the repository holds fetches it too,
 * and checks it out once so its blobs are present for the review step; the
 * script always ends with `HEAD` at the base commit.
 */
export const PREPARE_REPOSITORY_SCRIPT = `#!/bin/sh
# The case repository at its base commit, with every evaluation case file and
# every held-out file absent from its working tree and its object store.
# Usage: prepare-repository.sh <repository url> <tree> <base commit> [<head commit>]
set -eu
url=$1
tree=$2
base=$3
head=\${4:-}
install=\${PREPARE_INSTALL:-}
git init --quiet --initial-branch=task "$tree"
cd "$tree"
git remote add origin "$url"
git config core.sparseCheckout true
git config core.sparseCheckoutCone false
mkdir -p .git/info
printf '%s\\n' ${SPARSE_CHECKOUT_PATTERNS.map(shellQuote).join(' ')} > .git/info/sparse-checkout
git fetch --quiet --filter=blob:none origin "$base"
if [ -n "$head" ]; then
  git fetch --quiet --depth 1 --filter=blob:none origin "$head"
  git checkout --quiet --detach "$head"
fi
git checkout --quiet -B task "$base"
test "$(git rev-parse HEAD)" = "$base"
if [ -n "$install" ]; then
  $install
fi
git remote remove origin
rm -f .git/FETCH_HEAD
`

/**
 * The review step: commits the change under review as `HEAD` — the head
 * commit itself when the clone fetched it, otherwise the case's inline patch
 * applied to the base with `git apply --unidiff-zero` and committed with the
 * fixed seeded identity, which reproduces the head commit's id.
 */
export const COMMIT_REVIEW_SCRIPT = `#!/bin/sh
# Commits the change under review as HEAD and refuses any other head.
# Usage: commit-review.sh <tree> <case file> <head commit> <commit message>
set -eu
tree=$1
case_file=$2
head=$3
message=$4
export GIT_NO_LAZY_FETCH=1
cd "$tree"
if git cat-file -e "$head^{commit}" 2>/dev/null; then
  git checkout --quiet -B task "$head"
else
  git update-index -q --refresh >/dev/null || true
  node -e 'process.stdout.write(require(process.argv[1]).counterpart.patch.unified)' "$case_file" \\
    | git apply --index --unidiff-zero -
  written=$(git write-tree --missing-ok)
  commit=$(GIT_AUTHOR_NAME=${shellQuote(SEEDED_COMMIT_IDENTITY.name)} GIT_AUTHOR_EMAIL=${shellQuote(SEEDED_COMMIT_IDENTITY.email)} \\
    GIT_AUTHOR_DATE=${shellQuote(SEEDED_COMMIT_IDENTITY.date)} GIT_COMMITTER_NAME=${shellQuote(SEEDED_COMMIT_IDENTITY.name)} \\
    GIT_COMMITTER_EMAIL=${shellQuote(SEEDED_COMMIT_IDENTITY.email)} GIT_COMMITTER_DATE=${shellQuote(SEEDED_COMMIT_IDENTITY.date)} \\
    git commit-tree "$written" -p HEAD -m "$message")
  git update-ref refs/heads/task "$commit"
fi
test "$(git rev-parse HEAD)" = "$head"
`

/** The verifier: measures and grades the trial with the bundled script, and always leaves a reward. */
export const TEST_SCRIPT = `#!/bin/sh
# Measures the trial in the container and grades it with the generic graders.
set -u
mkdir -p /logs/verifier
bun /tests/grade.js grade --tests /tests --app /app --agent /logs/agent --out /logs/verifier
if [ ! -s /logs/verifier/reward.txt ]; then
  printf 0 > /logs/verifier/reward.txt
fi
exit 0
`

/**
 * The workspace install a case image runs in `/app`. Only a `change` case
 * installs: its verifier runs the hidden tests with vitest from
 * `/app/node_modules` and has no network. A `review` or `answer` case runs no
 * hidden test and its role runs no repository code, so its image installs
 * nothing.
 */
export const CHANGE_CASE_INSTALL = 'bun install --frozen-lockfile'

/** Where a task image unpacks the Vinaya CLI archive and installs its workspace dependencies. */
export const VINAYA_HOME = '/opt/vinaya'
/** The Vinaya CLI archive's file name in a task's `environment/` folder. */
export const ARCHIVE_FILE = 'vinaya.tar'
/**
 * Where a task image records the SHA-256 of the archive it installed. The
 * `vinaya` agent's install step refuses an archive whose digest differs, and
 * refuses an image with no such file, one converted without `--archive`.
 */
export const ARCHIVE_DIGEST_PATH = '/harbor/vinaya-archive.sha256'

/**
 * The image-build step that installs the Vinaya CLI: unpacks the archive at
 * `/opt/vinaya`, installs its workspace dependencies with the frozen lockfile
 * while the build still has the public network, and records the archive's
 * digest. The agent's install step, which Harbor times, then runs no network step.
 */
export function vinayaInstallStep(): string {
  const archive = `/harbor/${ARCHIVE_FILE}`
  return [
    `mkdir -p ${VINAYA_HOME}`,
    `tar -xf ${archive} -C ${VINAYA_HOME}`,
    `(cd ${VINAYA_HOME} && ${CHANGE_CASE_INSTALL})`,
    `sha256sum ${archive} | cut -d ' ' -f 1 > ${ARCHIVE_DIGEST_PATH}`,
    `rm ${archive}`
  ].join(' && ')
}

/**
 * The image-build step that installs Claude Code: the global install's
 * `/usr/local/bin/claude` removed, and `claude` linked in a directory of its
 * own to the installed package's `bin/claude.exe`.
 */
export function claudeInstallStep(): string {
  const packageName = CLAUDE_CODE_PACKAGE.slice(0, CLAUDE_CODE_PACKAGE.lastIndexOf('@'))
  return [
    `npm install --global ${CLAUDE_CODE_PACKAGE}`,
    'rm /usr/local/bin/claude',
    `mkdir -p ${CLAUDE_BIN_DIRECTORY}`,
    `ln -s "$(npm root --global)/${packageName}/bin/claude.exe" ${CLAUDE_BIN_DIRECTORY}/claude`
  ].join(' && ')
}

/** The image-build step that installs `gh` from the Debian package. */
export const GH_INSTALL_STEP =
  'apt-get update && apt-get install --yes --no-install-recommends gh && rm -rf /var/lib/apt/lists/* && gh --version'

/**
 * The last root step of every image: the directories the role, the verifier
 * and the oracle write — the case repository, the case file's directory and
 * Harbor's log directories, and the Vinaya CLI when the image holds it —
 * owned by the non-root user, and `/app` trusted by git for any user.
 */
export function taskUserStep(withArchive: boolean): string {
  const owned = ['/app', '/case', '/logs', ...(withArchive ? [VINAYA_HOME] : [])]
  return [
    'mkdir -p /logs/agent /logs/verifier',
    `chown -R ${TASK_USER}:${TASK_USER} ${owned.join(' ')}`,
    'git config --system --add safe.directory /app'
  ].join(' && ')
}

function dockerfile(
  c: NeutralCase,
  url: string,
  head: string | null,
  reviewMessage: string | null,
  withArchive: boolean
): string {
  const install = c.kind === 'change' ? `PREPARE_INSTALL=${shellQuote(CHANGE_CASE_INSTALL)} ` : ''
  const lines = [
    '# A layer-G Harbor task image, written by harbor-tasks.ts: the case repository at /app.',
    `FROM ${BUN_IMAGE} AS bun`,
    `FROM ${NODE_IMAGE}`,
    'COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun',
    `RUN ${GH_INSTALL_STEP}`,
    `RUN ${claudeInstallStep()}`,
    `ENV PATH=${CLAUDE_BIN_DIRECTORY}:$PATH`,
    'RUN claude --version && bun --version && node --version',
    'ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
    `RUN useradd -m -u ${TASK_USER_ID} ${TASK_USER}`,
    ...(withArchive ? [`COPY ${ARCHIVE_FILE} /harbor/${ARCHIVE_FILE}`, `RUN ${vinayaInstallStep()}`] : []),
    'COPY prepare-repository.sh /harbor/prepare-repository.sh',
    `RUN ${install}sh /harbor/prepare-repository.sh ${[url, '/app', c.baseRevision, ...(head === null ? [] : [head])].map(shellQuote).join(' ')}`,
    'COPY case.json /case/case.json'
  ]
  if (c.kind === 'review' && reviewMessage !== null) {
    lines.push(
      'COPY commit-review.sh /harbor/commit-review.sh',
      `RUN sh /harbor/commit-review.sh ${['/app', '/case/case.json', c.changeUnderReview.head, reviewMessage].map(shellQuote).join(' ')}`
    )
  }
  // Every step that needs root is above; the role, the verifier and the oracle run as the non-root user.
  lines.push(
    `RUN ${taskUserStep(withArchive)}`,
    `ENV HOME=${TASK_USER_HOME}`,
    `USER ${TASK_USER}`,
    'ENV GIT_NO_LAZY_FETCH=1',
    'WORKDIR /app'
  )
  return `${lines.join('\n')}\n`
}

function taskToml(suite: string, c: NeutralCase, quarantine: Quarantine | null): string {
  return [
    'schema_version = "1.4"',
    '',
    '[metadata]',
    `case_id = ${tomlString(c.id)}`,
    `case_kind = ${tomlString(c.kind)}`,
    `harbor_version = ${tomlString(HARBOR_VERSION)}`,
    // A quarantined case keeps its folder; the results reader counts its trial apart.
    ...(quarantine === null
      ? []
      : [
          `${QUARANTINE_METADATA.adjudicationDigest} = ${tomlString(quarantine.adjudicationDigest)}`,
          `${QUARANTINE_METADATA.cause} = ${tomlString(quarantine.cause)}`,
          `${QUARANTINE_METADATA.reason} = ${tomlString(quarantine.reason)}`,
          `${QUARANTINE_METADATA.reasonVersion} = ${quarantine.reasonVersion}`
        ]),
    `suite = ${tomlString(suite)}`,
    `vinaya_renderer_version = ${tomlString(VINAYA_RENDERER_VERSION)}`,
    '',
    '[verifier]',
    'timeout_sec = 1800.0',
    // The verifier measures the tree the role left, so it runs in the agent's container.
    'environment_mode = "shared"',
    'network_mode = "no-network"',
    '',
    '[agent]',
    'timeout_sec = 3600.0',
    'network_mode = "allowlist"',
    `allowed_hosts = [${AGENT_ALLOWED_HOSTS.map(tomlString).join(', ')}]`,
    '',
    '[environment]',
    'build_timeout_sec = 1800.0',
    'network_mode = "public"',
    '',
    '[environment.env]',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"',
    ''
  ].join('\n')
}

/** What converting one case needs besides the case: its layer-`P` counterpart and its statement. */
export interface CaseSources {
  key: GenericSuiteKey
  case: NeutralCase
  statement: string
  developer?: DeveloperCapabilityCase
  reviewer?: ReviewCase
  citation?: SourceCitationCase
  /** The case's quarantine in the Harbor quarantine record, when it has one. */
  quarantine?: Quarantine
}

/** The layer-`P` part of the case file, holding only what the container run reads. */
function counterpartOf(sources: CaseSources): HarborCounterpart {
  const c = sources.case
  if (c.kind === 'change' && sources.developer !== undefined)
    return { kind: 'change', id: sources.developer.id, pullRequest: sources.developer.pullRequest }
  if (c.kind === 'review' && sources.reviewer !== undefined) {
    const { id, role, baseCommit, patch } = sources.reviewer
    return { kind: 'review', id, role, baseCommit, patch }
  }
  if (c.kind === 'answer' && sources.citation !== undefined) return { kind: 'answer', case: sources.citation }
  throw new HarborTasksRefused(`${c.id} has no layer-P counterpart of its kind ${c.kind}`)
}

/**
 * Every file of one case's task folder. The bundled script is written twice,
 * as the verifier's `grade.js` and the oracle's `oracle.js`.
 */
export function taskFiles(
  sources: CaseSources,
  script: string,
  url: RepositoryUrl,
  archive: Uint8Array | null = null
): Map<string, TaskFile> {
  const c = sources.case
  const suite = GENERIC_SUITE_IDS[sources.key]
  const files = new Map<string, TaskFile>()
  const add = (path: string, content: string | Uint8Array, mode: TaskFile['mode'] = 0o644) =>
    files.set(path, { content, mode })
  const caseFile: HarborCaseFile = {
    schemaVersion: 1,
    suite: suiteName(sources.key),
    case: c,
    counterpart: counterpartOf(sources)
  }
  // A git-sourced change under review is fetched by its head commit; an inline one is applied to the base.
  const reviewHead = sources.reviewer?.patch.source === 'git' ? sources.reviewer.patch.changedCommit : null
  if (reviewHead !== null && c.kind === 'review' && reviewHead !== c.changeUnderReview.head)
    throw new HarborTasksRefused(`${c.id}: the layer-P change under review is not the neutral case's`)

  add('task.toml', taskToml(suite, c, sources.quarantine ?? null))
  add('instruction.md', `${sources.statement}\n`)
  add('environment/Dockerfile', dockerfile(c, url(c.repository), reviewHead, `Seeded change ${c.id}`, archive !== null))
  if (archive !== null) add(`environment/${ARCHIVE_FILE}`, archive)
  add('environment/prepare-repository.sh', PREPARE_REPOSITORY_SCRIPT, 0o755)
  add('environment/case.json', stableJson(caseFile))
  if (c.kind === 'review') add('environment/commit-review.sh', COMMIT_REVIEW_SCRIPT, 0o755)

  const developer = sources.developer
  const testFiles =
    c.kind === 'change' && developer !== undefined
      ? [...new Set([...developer.hiddenTests.files, ...developer.passToPassFiles].map((file) => file.path))].sort()
      : []
  const grading: GradingSpec = { schemaVersion: 1, suite, case: c, testFiles }
  add('tests/test.sh', TEST_SCRIPT, 0o755)
  add('tests/grade.js', script)
  add('tests/grading.json', stableJson(grading))
  if (developer !== undefined) {
    // A path both lists hold is the hidden test file at the reference commit, as the grading copy writes it last.
    const pinned = new Map<string, string>()
    for (const file of developer.passToPassFiles) pinned.set(file.path, file.blob)
    for (const file of developer.hiddenTests.files) pinned.set(file.path, file.blob)
    for (const [path, id] of pinned) add(`tests/hidden/${path}`, blob(id))
  }

  const entry = referenceEntry(sources.key, c, developer)
  const oracle: OracleSpec = { schemaVersion: 1, suite, case: c, reference: entry.reference }
  add('solution/reference.json', stableJson(oracle))
  add('solution/oracle.js', script)
  const solve = [
    '#!/bin/sh',
    '# Records the reference outcome: the reference change committed, then its agent part.',
    'set -eu'
  ]
  if (c.kind === 'change' && developer !== undefined) {
    // Each file keeps its git file mode at the reference commit, so an executable script stays executable.
    const modes = gitFileModes(
      developer.referenceCommit,
      developer.referenceSolution.files.map((file) => file.path)
    )
    for (const file of developer.referenceSolution.files)
      add(`solution/files/${file.path}`, blob(file.blob), modes.get(file.path))
    solve.push('cd /app')
    if (developer.referenceSolution.files.length > 0) solve.push('cp -R /solution/files/. /app/')
    for (const path of developer.referenceSolution.deleted) solve.push(`rm -f -- ${shellQuote(path)}`)
    solve.push(
      'git -c core.hooksPath=/dev/null add -A',
      "git -c core.hooksPath=/dev/null -c user.name='Vinaya Evaluation' -c user.email=eval@invalid.local commit --quiet --no-verify -m 'Reference change'"
    )
  }
  solve.push('bun /solution/oracle.js oracle --solution /solution --app /app --agent /logs/agent', '')
  add('solution/solve.sh', solve.join('\n'), 0o755)
  return files
}

// ── Quarantine ──────────────────────────────────────────────────────────────

/**
 * The committed Harbor quarantine record: by suite, the cases whose task
 * folders are still written but whose trials the results reader counts apart,
 * each a `Quarantine` with a current adjudication digest.
 */
export const HARBOR_QUARANTINE_PATH = join(REPOSITORY_ROOT, 'apps/cli/tests/eval/harbor-quarantine.json')

/** The Harbor quarantine record by suite name, every entry validated; a stale or repeated entry is refused. */
export function loadHarborQuarantine(path: string = HARBOR_QUARANTINE_PATH): Map<string, Quarantine[]> {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion?: unknown; suites?: unknown }
  if (raw.schemaVersion !== 1 || typeof raw.suites !== 'object' || raw.suites === null || Array.isArray(raw.suites))
    throw new HarborTasksRefused(`${path} is not a schema-version-1 quarantine record`)
  const bySuite = new Map<string, Quarantine[]>()
  for (const [suite, entries] of Object.entries(raw.suites as Record<string, unknown>)) {
    if (!Array.isArray(entries)) throw new HarborTasksRefused(`${path}: ${suite} does not list quarantines`)
    const quarantines: Quarantine[] = []
    for (const [i, entry] of entries.entries()) {
      try {
        quarantines.push(checkedQuarantine(entry, `${suite} quarantine ${i}`))
      } catch (error) {
        if (error instanceof HarborResultsRefused) throw new HarborTasksRefused(`${path}: ${error.message}`)
        throw error
      }
    }
    const ids = quarantines.map((q) => q.taskId)
    if (new Set(ids).size !== ids.length) throw new HarborTasksRefused(`${path}: ${suite} quarantines a case twice`)
    bySuite.set(suite, quarantines)
  }
  return bySuite
}

// ── Conversion ──────────────────────────────────────────────────────────────

export interface ConvertOptions {
  out: string
  /** Held-out approvals; with none the development split is converted. */
  heldOutApprovals?: readonly string[]
  archive?: string
  repositoryUrl?: RepositoryUrl
  /** The Harbor quarantine record; the committed one by default. */
  quarantine?: string
  /** Reads the derived case files; a test injects one that records every path. */
  read?: ReadBytes
  /** Standard output and standard error. */
  print?: (line: string) => void
  warn?: (line: string) => void
}

export interface ConvertedSuite {
  suite: string
  split: 'development' | 'held-out'
  cases: number
  converted: string[]
  refused: { id: string; refusal: string }[]
}

/** The held-out digest each family of suites opens with. */
const HELD_OUT_FAMILY: Partial<Record<GenericSuiteKey, string>> = {
  developer: DERIVED_FILE_DIGESTS.developer.heldOut,
  codeReviewer: DERIVED_FILE_DIGESTS.reviewer.heldOut,
  securityReviewer: DERIVED_FILE_DIGESTS.reviewer.heldOut
}

function statementsOf(): Record<string, string> {
  return JSON.parse(readFileSync(STATEMENTS_PATH, 'utf8')) as Record<string, string>
}

/** The layer-`P` counterparts a split converts with, by suite. */
function counterparts(split: 'development' | 'held-out', keys: readonly GenericSuiteKey[]) {
  const developer: DeveloperCapabilityCase[] = []
  const reviewer: ReviewCase[] = []
  let citation: SourceCitationCase[] = []
  if (keys.includes('developer')) {
    const file = loadDeveloperCaseFile()
    developer.push(...(split === 'development' ? file.cases : loadDeveloperHeldOut(file, file.splits.heldOut.digest)))
  }
  for (const key of keys) {
    const role = REVIEWER_OF[key]
    if (role === undefined) continue
    const file = loadReviewerDevelopment(role)
    reviewer.push(...(split === 'development' ? file.cases : loadReviewerHeldOut(role, file.split.heldOutDigest)))
  }
  if (keys.includes('sourceCitation') && split === 'development') citation = loadCitationCaseFile().cases
  return { developer, reviewer, citation }
}

/**
 * Converts every development case of the four suites, or, given held-out
 * approvals, every held-out case of the suites they open. An approval that
 * names no pinned held-out digest is refused before any held-out file is
 * opened. A case the renderer refuses gets no folder and is listed on
 * standard error; a held-out case is listed by id alone.
 */
export async function convertHarborTasks(options: ConvertOptions): Promise<ConvertedSuite[]> {
  const print = options.print ?? ((line: string) => process.stdout.write(`${line}\n`))
  const warn = options.warn ?? ((line: string) => process.stderr.write(`${line}\n`))
  const approvals = options.heldOutApprovals ?? []
  const pinned = new Set(Object.values(HELD_OUT_FAMILY))
  for (const approval of approvals) {
    if (!pinned.has(approval))
      throw new HarborTasksRefused('a held-out approval names no pinned held-out digest; no held-out file was opened')
  }
  const split = approvals.length === 0 ? 'development' : 'held-out'
  const keys = HARBOR_SUITE_KEYS.filter(
    (key) => split === 'development' || approvals.includes(HELD_OUT_FAMILY[key] as string)
  )
  // A quarantine naming a case its suite's development split does not hold is refused before any folder is written.
  const quarantines = loadHarborQuarantine(options.quarantine)
  for (const [suite, entries] of quarantines) {
    const key = HARBOR_SUITE_KEYS.find((k) => suiteName(k) === suite)
    if (key === undefined) throw new HarborTasksRefused(`the quarantine record names ${suite}, not a converted suite`)
    const held = new Set(developmentCases(key, options.read).map((c) => c.id))
    const stray = entries.find((q) => !held.has(q.taskId))
    if (stray !== undefined)
      throw new HarborTasksRefused(`the quarantine record names ${stray.taskId}, which ${suite} does not hold`)
  }
  const script = await bundleGradeScript()
  const statements = split === 'development' ? statementsOf() : {}
  const layerP = counterparts(split, keys)
  const url = options.repositoryUrl ?? GITHUB_REPOSITORY_URL
  // The archive is written first: every task image installs the Vinaya CLI from it at build.
  let archive: Uint8Array | null = null
  if (options.archive !== undefined) {
    mkdirSync(dirname(options.archive), { recursive: true })
    writeArchive(options.archive)
    archive = readFileSync(options.archive)
  }
  const results: ConvertedSuite[] = []
  for (const key of keys) {
    const suite = suiteName(key)
    const cases =
      split === 'development'
        ? developmentCases(key, options.read)
        : heldOutCases(key, HELD_OUT_FAMILY[key] as string, options.read)
    const result: ConvertedSuite = { suite, split, cases: cases.length, converted: [], refused: [] }
    for (const c of cases) {
      const rendered = renderCase(c)
      if (!rendered.ok) {
        const { code, field, detail } = rendered.refusal
        const refusal = split === 'development' ? `${code} at ${field}: ${detail}` : 'refused'
        result.refused.push({ id: c.id, refusal })
        warn(`${suite} ${c.id}: ${refusal}`)
        continue
      }
      const role = REVIEWER_OF[key]
      const sources: CaseSources = {
        key,
        case: c,
        statement: split === 'development' ? (statements[c.id] ?? '') : c.taskStatement,
        developer: layerP.developer.find((p) => p.id === c.id),
        reviewer: layerP.reviewer.find((p) => p.id === c.id && p.role === role),
        citation: layerP.citation.find((p) => p.id === c.id),
        quarantine: quarantines.get(suite)?.find((q) => q.taskId === c.id)
      }
      if (sources.statement === '') throw new HarborTasksRefused(`${c.id} has no task statement`)
      writeTaskFolder(join(options.out, suite, c.id), taskFiles(sources, script, url, archive))
      result.converted.push(c.id)
    }
    print(`${suite} (${split}): ${result.converted.length} of ${result.cases} converted`)
    if (split === 'held-out') print(`  ids: ${result.converted.join(', ')}`)
    results.push(result)
  }
  if (options.archive !== undefined) print(`Vinaya archive at HEAD: ${options.archive}`)
  return results
}

const flagValues = (argv: readonly string[], name: string): string[] =>
  argv.flatMap((arg, i) => (arg === `--${name}` && argv[i + 1] !== undefined ? [argv[i + 1] as string] : []))

export const HARBOR_TASKS_USAGE =
  'usage: harbor-tasks.ts --out <dir> [--archive <file.tar>] [--held-out-approval <sha256>]... [--repository-url <url>]'

/** The command entry: exit 0 when every case converted or was listed as refused, 2 on a refusal, 1 on an error. */
export async function harborTasksCommand(argv: readonly string[], read?: ReadBytes): Promise<number> {
  const [out] = flagValues(argv, 'out')
  if (out === undefined) {
    process.stderr.write(`${HARBOR_TASKS_USAGE}\n`)
    return 2
  }
  const [archive] = flagValues(argv, 'archive')
  const [repositoryUrl] = flagValues(argv, 'repository-url')
  try {
    await convertHarborTasks({
      out,
      heldOutApprovals: flagValues(argv, 'held-out-approval'),
      ...(archive === undefined ? {} : { archive }),
      ...(repositoryUrl === undefined ? {} : { repositoryUrl: () => repositoryUrl }),
      ...(read === undefined ? {} : { read })
    })
    return 0
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return error instanceof HarborTasksRefused || error instanceof DerivedFileRefused ? 2 : 1
  }
}

if (import.meta.main) {
  harborTasksCommand(process.argv.slice(2)).then((code) => process.exit(code))
}
