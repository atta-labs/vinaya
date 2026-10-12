/**
 * The contamination test, the admission gate it guards, and what happens after
 * a trial: attributing every object it created, and grading in a separate
 * copy. The rules are the evaluation program's §11 "Repository isolation"
 * (`apps/cli/specs/dev-review-evaluation-program.md`); this module's own
 * specification is `apps/cli/specs/evals.md`, "Trial staging".
 *
 * The test compares complete sets, never a sample: every object in the
 * clone's database, loose and packed and from any foreign source, against the
 * frozen manifest; every ref; every reflog; every local configuration entry;
 * every file of a snapshot against the base commit's tree. It collects every
 * finding rather than stopping at the first, so a refusal names all of them.
 *
 * A task's hidden fail-to-pass tests and its reference solution are inputs to
 * the test only so it can prove they are invisible: they are never written
 * into the trial's directory, and `prepareGradingCopy` applies them in a
 * directory of its own, after the trial, once every object the trial created
 * is attributed to it.
 */

import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import {
  AGENT_STATE_DIRS,
  type CloneStaging,
  git,
  gitObjectId,
  isInside,
  lstatExists,
  type ObjectFormat,
  runGit,
  type SnapshotStaging,
  type Staging,
  StagingError,
  safeRelativePath,
  writeSnapshot
} from './staging'

// ── Findings ────────────────────────────────────────────────────────────────

export type ContaminationCode =
  | 'linked_worktree'
  | 'object_set_mismatch'
  | 'stray_object_file'
  | 'integrity_check_failed'
  | 'unreachable_object'
  | 'foreign_ref'
  | 'task_branch_moved'
  | 'head_not_task_branch'
  | 'pseudo_ref'
  | 'reflog_not_empty'
  | 'alternates'
  | 'promisor'
  | 'graft'
  | 'shallow'
  | 'remote_configured'
  | 'config_include'
  | 'unexpected_config'
  | 'git_metadata_present'
  | 'snapshot_mismatch'
  | 'prior_agent_state'
  | 'hidden_input_visible'

export interface ContaminationFinding {
  code: ContaminationCode
  /** What the finding is about: a ref, a path, a configuration key, a state directory. */
  subject: string
  detail: string
  /** The complete list of offending object ids, when the finding is about objects. */
  objects?: string[]
}

export interface ContaminationReport {
  trialId: string
  clean: boolean
  findings: ContaminationFinding[]
}

/**
 * What a task keeps from the agent: its hidden fail-to-pass tests and its
 * reference solution, each a map from a path relative to the repository root
 * to the file's bytes.
 */
export interface HiddenInputs {
  failToPassTests: Readonly<Record<string, string | Uint8Array>>
  referenceSolution: Readonly<Record<string, string | Uint8Array>>
}

// ── Observing an object store ───────────────────────────────────────────────

/** Where an observed object lives. `foreign` is one git sees but the clone's own store does not hold. */
export type ObjectLocation =
  | { kind: 'loose'; path: string }
  | { kind: 'pack'; pack: string; path: string }
  | { kind: 'foreign' }

interface ObservedStore {
  objects: Map<string, ObjectLocation>
  stray: string[]
  alternates: string[]
  promisorPacks: string[]
}

/**
 * Every object a clone's database holds: loose objects read from the
 * directory, packed ones read from every pack index with `git show-index`,
 * and — through `git cat-file --batch-all-objects`, which also reads
 * alternates — any that the clone's own files do not account for.
 */
function observeObjectStore(staging: CloneStaging): ObservedStore {
  const objectsDir = join(staging.gitDir, 'objects')
  const hexLength = staging.manifest.objectFormat === 'sha1' ? 40 : 64
  const rest = new RegExp(`^[0-9a-f]{${hexLength - 2}}$`)
  const store: ObservedStore = { objects: new Map(), stray: [], alternates: [], promisorPacks: [] }
  const indexes: string[] = []
  const packs = new Set<string>()

  for (const entry of readdirSync(objectsDir, { withFileTypes: true })) {
    const path = join(objectsDir, entry.name)
    if (entry.isDirectory() && /^[0-9a-f]{2}$/.test(entry.name)) {
      for (const file of readdirSync(path)) {
        if (rest.test(file)) store.objects.set(entry.name + file, { kind: 'loose', path: join(path, file) })
        else store.stray.push(join(path, file))
      }
    } else if (entry.isDirectory() && entry.name === 'pack') {
      for (const file of readdirSync(path)) {
        const match = /^(pack-[0-9a-f]+)\.(pack|idx|rev|promisor)$/.exec(file)
        if (match === null) store.stray.push(join(path, file))
        else if (match[2] === 'promisor') store.promisorPacks.push(join(path, file))
        else if (match[2] === 'idx') indexes.push(join(path, file))
        else if (match[2] === 'pack') packs.add(join(path, file))
      }
    } else if (entry.isDirectory() && entry.name === 'info') {
      for (const file of readdirSync(path)) {
        if (file === 'alternates' || file === 'http-alternates') store.alternates.push(join(path, file))
        else store.stray.push(join(path, file))
      }
    } else {
      store.stray.push(path)
    }
  }

  for (const index of indexes) {
    const pack = index.replace(/\.idx$/, '.pack')
    if (!packs.delete(pack)) {
      store.stray.push(index)
      continue
    }
    const listing = git(staging.workspace, ['show-index'], readFileSync(index))
    for (const line of listing.split('\n')) {
      const id = line.split(' ')[1]
      if (id) store.objects.set(id, { kind: 'pack', pack: pack.slice(pack.lastIndexOf('/') + 1), path: pack })
    }
  }
  store.stray.push(...packs)

  const seen = git(staging.workspace, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)', '--unordered'])
  for (const id of seen.split('\n')) {
    if (id !== '' && !store.objects.has(id)) store.objects.set(id, { kind: 'foreign' })
  }
  return store
}

function difference(a: Iterable<string>, b: ReadonlySet<string> | Map<string, unknown>): string[] {
  const out: string[] = []
  for (const id of a) if (!b.has(id)) out.push(id)
  return out.sort()
}

// ── The contamination test ──────────────────────────────────────────────────

/**
 * Tests a staged trial before any model process starts. Clean only when no
 * finding is raised; every finding is collected.
 */
export function testContamination(staging: Staging, hidden: HiddenInputs): ContaminationReport {
  const findings: ContaminationFinding[] = []
  try {
    if (staging.kind === 'clone') findings.push(...cloneFindings(staging))
    else findings.push(...snapshotFindings(staging))
  } catch (error) {
    // A repository git cannot read is refused, never admitted.
    if (!(error instanceof StagingError)) throw error
    findings.push({ code: 'integrity_check_failed', subject: 'git', detail: error.message })
  }
  findings.push(...agentStateFindings(staging))
  findings.push(...hiddenInputFindings(staging, hidden))
  return { trialId: staging.trialId, clean: findings.length === 0, findings }
}

export type Admission<T> =
  | { ok: true; value: T; report: ContaminationReport }
  | { ok: false; refusal: ContaminationReport }

/**
 * The admission gate: runs the contamination test and calls `start` — the
 * only way a trial's model process is launched — when, and only when, it is
 * clean. A contaminated trial is refused and `start` is never called.
 */
export function admitTrial<T>(staging: Staging, hidden: HiddenInputs, start: (staging: Staging) => T): Admission<T> {
  const report = testContamination(staging, hidden)
  if (!report.clean) return { ok: false, refusal: report }
  return { ok: true, value: start(staging), report }
}

function cloneFindings(staging: CloneStaging): ContaminationFinding[] {
  const findings: ContaminationFinding[] = []
  const finding = (code: ContaminationCode, subject: string, detail: string, objects?: string[]) =>
    findings.push(objects ? { code, subject, detail, objects } : { code, subject, detail })
  const gitDir = staging.gitDir

  // Layout: a repository of its own, never a linked worktree.
  const dotGit = lstatSync(join(staging.workspace, '.git'), { throwIfNoEntry: false })
  if (!dotGit?.isDirectory()) {
    finding('linked_worktree', '.git', 'the workspace .git is not a directory of its own')
    return findings
  }
  for (const name of ['commondir', 'worktrees']) {
    if (lstatExists(join(gitDir, name))) finding('linked_worktree', name, `the git directory holds ${name}`)
  }
  if (findings.length > 0) return findings

  // Objects: the complete set, against the frozen manifest.
  const format = git(staging.workspace, ['rev-parse', '--show-object-format']).trim()
  if (format !== staging.manifest.objectFormat) {
    finding(
      'object_set_mismatch',
      'objectFormat',
      `the clone uses ${format}, the manifest ${staging.manifest.objectFormat}`
    )
  }
  const store = observeObjectStore(staging)
  const allowed = new Set(staging.manifest.objects)
  const extra = difference(store.objects.keys(), allowed)
  const missing = difference(allowed, store.objects)
  if (extra.length > 0) {
    finding('object_set_mismatch', 'objects', `${extra.length} object(s) outside the allowed-object manifest`, extra)
  }
  if (missing.length > 0) {
    finding('object_set_mismatch', 'objects', `${missing.length} manifest object(s) absent from the clone`, missing)
  }
  for (const path of store.stray)
    finding('stray_object_file', relative(gitDir, path), 'not a loose object or a complete pack')
  for (const path of store.alternates)
    finding('alternates', relative(gitDir, path), 'the clone borrows objects from another store')
  for (const path of store.promisorPacks)
    finding('promisor', relative(gitDir, path), 'a promisor pack: objects may be fetched lazily')

  // Integrity: a full check that lists unreachable objects reports none.
  const fsck = runGit(staging.workspace, [
    'fsck',
    '--full',
    '--unreachable',
    '--no-reflogs',
    '--no-dangling',
    '--no-progress'
  ])
  const unreachable: string[] = []
  const broken: string[] = []
  for (const line of fsck.stdout.toString('utf8').split('\n')) {
    if (line === '') continue
    if (line.startsWith('unreachable ')) unreachable.push(line.split(' ')[2] as string)
    else broken.push(line)
  }
  if (fsck.status !== 0 || broken.length > 0) {
    finding(
      'integrity_check_failed',
      'fsck',
      [...broken, fsck.stderr.trim()].filter((l) => l !== '').join('; ') || `exited ${fsck.status}`
    )
  }
  if (unreachable.length > 0) {
    finding('unreachable_object', 'fsck', `${unreachable.length} unreachable object(s)`, unreachable.sort())
  }

  // Refs: the task branch at the base commit, HEAD on it, nothing else.
  const taskRef = `refs/heads/${staging.taskBranch}`
  let taskRefSeen = false
  for (const line of git(staging.workspace, ['for-each-ref', '--format=%(refname) %(objectname)']).split('\n')) {
    if (line === '') continue
    const [ref, id] = line.split(' ') as [string, string]
    if (ref !== taskRef) {
      finding('foreign_ref', ref, `a ref other than ${taskRef}`)
      continue
    }
    taskRefSeen = true
    if (id !== staging.baseCommit)
      finding('task_branch_moved', ref, `points at ${id}, not the base commit ${staging.baseCommit}`)
  }
  if (!taskRefSeen) finding('task_branch_moved', taskRef, 'the task branch does not exist')
  const head = readFileSync(join(gitDir, 'HEAD'), 'utf8')
  if (head !== `ref: ${taskRef}\n`) finding('head_not_task_branch', 'HEAD', `HEAD is ${JSON.stringify(head.trim())}`)
  for (const entry of readdirSync(gitDir)) {
    if (entry !== 'HEAD' && /^[A-Z_]+$/.test(entry)) finding('pseudo_ref', entry, `the git directory holds ${entry}`)
  }

  // Reflogs: none holds an entry.
  for (const file of walkFiles(join(gitDir, 'logs'))) {
    if (statSync(file).size > 0) finding('reflog_not_empty', relative(gitDir, file), 'the reflog holds entries')
  }

  // Foreign object sources: grafts and a shallow boundary.
  if (lstatExists(join(gitDir, 'info', 'grafts'))) finding('graft', 'info/grafts', 'grafts rewrite the visible history')
  if (lstatExists(join(gitDir, 'shallow'))) finding('shallow', 'shallow', 'a shallow boundary hides history')

  // Configuration: only the entries a fresh repository needs.
  for (const { key, value } of localConfig(staging.workspace, gitDir)) {
    const code = configCode(key)
    if (code !== null) finding(code, key, `local configuration sets ${key}=${value}`)
  }
  return findings
}

const ALLOWED_CONFIG = new Set([
  'core.repositoryformatversion',
  'core.filemode',
  'core.bare',
  'core.logallrefupdates',
  'core.ignorecase',
  'core.precomposeunicode',
  'core.symlinks',
  'extensions.objectformat'
])

function configCode(key: string): ContaminationCode | null {
  if (ALLOWED_CONFIG.has(key)) return null
  if (key === 'extensions.partialclone' || key.endsWith('.promisor') || key.endsWith('.partialclonefilter'))
    return 'promisor'
  if (key.startsWith('remote.') || /^branch\..+\.(?:remote|pushremote|merge)$/.test(key)) return 'remote_configured'
  if (key.startsWith('include.') || key.startsWith('includeif.')) return 'config_include'
  return 'unexpected_config'
}

function localConfig(workspace: string, gitDir: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = []
  for (const entry of git(workspace, ['config', '--file', join(gitDir, 'config'), '--list', '-z']).split('\0')) {
    if (entry === '') continue
    const newline = entry.indexOf('\n')
    out.push(
      newline === -1 ? { key: entry, value: '' } : { key: entry.slice(0, newline), value: entry.slice(newline + 1) }
    )
  }
  return out
}

/** A snapshot holds the base commit's tree exactly, and no git metadata anywhere. */
function snapshotFindings(staging: SnapshotStaging): ContaminationFinding[] {
  const findings: ContaminationFinding[] = []
  const observed = observeSnapshot(staging.workspace, staging.manifest.objectFormat)
  for (const path of observed.gitMetadata) {
    findings.push({ code: 'git_metadata_present', subject: path, detail: 'a snapshot carries no git metadata' })
  }
  const expected = expectedSnapshot(staging)
  for (const [path, entry] of expected) {
    const seen = observed.entries.get(path)
    if (seen === undefined)
      findings.push({ code: 'snapshot_mismatch', subject: path, detail: 'missing from the snapshot' })
    else if (seen !== entry)
      findings.push({ code: 'snapshot_mismatch', subject: path, detail: `is ${seen}, the base tree has ${entry}` })
  }
  for (const path of observed.entries.keys()) {
    if (!expected.has(path)) findings.push({ code: 'snapshot_mismatch', subject: path, detail: 'not in the base tree' })
  }
  return findings
}

/** path → `mode id`; a gitlink, staged as an empty directory, is `160000` alone. */
function expectedSnapshot(staging: SnapshotStaging): Map<string, string> {
  return new Map(staging.manifest.entries.map((e) => [e.path, e.mode === '160000' ? e.mode : `${e.mode} ${e.id}`]))
}

interface ObservedSnapshot {
  /** path → `mode id`, in git's notation. */
  entries: Map<string, string>
  gitMetadata: string[]
}

function observeSnapshot(workspace: string, format: ObjectFormat): ObservedSnapshot {
  const out: ObservedSnapshot = { entries: new Map(), gitMetadata: [] }
  const visit = (dir: string) => {
    const names = readdirSync(dir)
    if (names.length === 0 && dir !== workspace) {
      // An empty directory is how a gitlink is staged.
      out.entries.set(relative(workspace, dir), '160000')
      return
    }
    for (const name of names) {
      const path = join(dir, name)
      const rel = relative(workspace, path)
      if (name === '.git') {
        out.gitMetadata.push(rel)
        continue
      }
      const stat = lstatSync(path)
      if (stat.isSymbolicLink())
        out.entries.set(rel, `120000 ${gitObjectId(format, 'blob', Buffer.from(readlinkSync(path)))}`)
      else if (stat.isDirectory()) visit(path)
      else
        out.entries.set(
          rel,
          `${stat.mode & 0o111 ? '100755' : '100644'} ${gitObjectId(format, 'blob', readFileSync(path))}`
        )
    }
  }
  visit(workspace)
  return out
}

/** Every agent state directory is the one staging created, and still empty. */
function agentStateFindings(staging: Staging): ContaminationFinding[] {
  const findings: ContaminationFinding[] = []
  const check = (subject: string, dir: { path: string; dev: number; ino: number }, mustBeEmpty: boolean) => {
    const stat = lstatSync(dir.path, { throwIfNoEntry: false })
    if (stat === undefined) findings.push({ code: 'prior_agent_state', subject, detail: `${dir.path} is missing` })
    else if (!stat.isDirectory())
      findings.push({ code: 'prior_agent_state', subject, detail: `${dir.path} is not a directory` })
    else if (stat.dev !== dir.dev || stat.ino !== dir.ino) {
      findings.push({ code: 'prior_agent_state', subject, detail: `${dir.path} is not the directory staging created` })
    } else if (mustBeEmpty) {
      const entries = readdirSync(dir.path)
      if (entries.length > 0) {
        findings.push({
          code: 'prior_agent_state',
          subject,
          detail: `${dir.path} holds ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`
        })
      }
    }
  }
  check('root', staging.root, false)
  for (const key of AGENT_STATE_DIRS) check(key, staging.agentState[key], true)
  return findings
}

interface HiddenFile {
  label: string
  bytes: Buffer
}

function hiddenFiles(hidden: HiddenInputs): HiddenFile[] {
  const out: HiddenFile[] = []
  for (const [kind, files] of [
    ['fail-to-pass test', hidden.failToPassTests],
    ['reference solution', hidden.referenceSolution]
  ] as const) {
    for (const [path, content] of Object.entries(files)) {
      const bytes = Buffer.from(content)
      // An empty file is indistinguishable from any other empty file.
      if (bytes.length > 0) out.push({ label: `${kind} ${path}`, bytes })
    }
  }
  return out
}

/**
 * No hidden input is in the agent-visible object database, in the frozen
 * manifest, or — byte for byte, under any name — anywhere in the trial's
 * directory.
 */
function hiddenInputFindings(staging: Staging, hidden: HiddenInputs): ContaminationFinding[] {
  const findings: ContaminationFinding[] = []
  const files = hiddenFiles(hidden)
  if (files.length === 0) return findings
  const format = staging.manifest.objectFormat
  if (staging.kind === 'clone') {
    const allowed = new Set(staging.manifest.objects)
    // When git cannot read the clone, the repository checks have already refused it.
    const listing = runGit(staging.workspace, [
      'cat-file',
      '--batch-all-objects',
      '--batch-check=%(objectname)',
      '--unordered'
    ])
    const present = new Set(listing.status === 0 ? listing.stdout.toString('utf8').split('\n') : [])
    for (const file of files) {
      const id = gitObjectId(format, 'blob', file.bytes)
      if (allowed.has(id))
        findings.push({
          code: 'hidden_input_visible',
          subject: file.label,
          detail: 'its blob is in the allowed-object manifest',
          objects: [id]
        })
      if (present.has(id))
        findings.push({
          code: 'hidden_input_visible',
          subject: file.label,
          detail: 'its blob is in the object database',
          objects: [id]
        })
    }
  } else {
    const allowed = new Set(staging.manifest.entries.map((e) => e.id))
    for (const file of files) {
      const id = gitObjectId(format, 'blob', file.bytes)
      if (allowed.has(id))
        findings.push({
          code: 'hidden_input_visible',
          subject: file.label,
          detail: 'its blob is in the base tree',
          objects: [id]
        })
    }
  }
  for (const { label, path } of filesMatching(staging.root.path, files)) {
    findings.push({
      code: 'hidden_input_visible',
      subject: label,
      detail: `its bytes are at ${relative(staging.root.path, path)}`
    })
  }
  return findings
}

function filesMatching(root: string, files: readonly HiddenFile[]): Array<{ label: string; path: string }> {
  const bySize = new Map<number, HiddenFile[]>()
  for (const file of files) bySize.set(file.bytes.length, [...(bySize.get(file.bytes.length) ?? []), file])
  const out: Array<{ label: string; path: string }> = []
  for (const path of walkFiles(root)) {
    const candidates = bySize.get(statSync(path).size)
    if (candidates === undefined) continue
    const bytes = readFileSync(path)
    for (const file of candidates) if (bytes.equals(file.bytes)) out.push({ label: file.label, path })
  }
  return out
}

/** Every regular file below `dir`, symlinks not followed. */
function walkFiles(dir: string): string[] {
  const out: string[] = []
  if (!lstatExists(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(path))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

// ── After the trial: attribution ────────────────────────────────────────────

export type UnattributableReason = 'foreign_source' | 'in_staged_pack' | 'predates_trial' | 'hidden_input'

export interface CloneAttribution {
  kind: 'clone'
  trialId: string
  /** Every object outside the frozen manifest, sorted. */
  created: string[]
  /** The created objects reachable from the task branch but not from the base commit. */
  reachable: string[]
  /** The created objects no such walk reaches — written, then abandoned. */
  unreachable: string[]
  unattributable: Array<{ id: string; reason: UnattributableReason }>
  /** Manifest objects no longer in the clone. Reported; not an attribution failure. */
  missing: string[]
  attributable: boolean
}

export interface SnapshotAttribution {
  kind: 'snapshot'
  trialId: string
  /** Paths whose content differs from the base tree, or that it lacks. */
  created: string[]
  unattributable: Array<{ path: string; reason: 'hidden_input' }>
  attributable: boolean
}

export type Attribution = CloneAttribution | SnapshotAttribution

/**
 * After the trial: every object outside the frozen manifest must have been
 * created by this trial — written into the clone's own store after staging
 * froze it, in a loose object or a pack staging did not leave, and never a
 * hidden input. Objects are checked here, never admitted to the manifest.
 */
export function attributeTrialObjects(staging: Staging, hidden: HiddenInputs): Attribution {
  const hiddenIds = new Set(hiddenFiles(hidden).map((f) => gitObjectId(staging.manifest.objectFormat, 'blob', f.bytes)))
  if (staging.kind === 'snapshot') {
    const observed = observeSnapshot(staging.workspace, staging.manifest.objectFormat)
    const expected = expectedSnapshot(staging)
    const created = [...observed.entries]
      .filter(([path, entry]) => expected.get(path) !== entry)
      .map(([path]) => path)
      .sort()
    const unattributable = created
      .filter((path) => hiddenIds.has((observed.entries.get(path) as string).split(' ')[1] as string))
      .map((path) => ({ path, reason: 'hidden_input' as const }))
    return {
      kind: 'snapshot',
      trialId: staging.trialId,
      created,
      unattributable,
      attributable: unattributable.length === 0
    }
  }

  const store = observeObjectStore(staging)
  const allowed = new Set(staging.manifest.objects)
  const created = difference(store.objects.keys(), allowed)
  const missing = difference(allowed, store.objects)
  const walk = runGit(staging.workspace, [
    'rev-list',
    '--objects',
    '--no-object-names',
    `refs/heads/${staging.taskBranch}`,
    '--not',
    staging.baseCommit
  ])
  const fromBranch = new Set(walk.status === 0 ? walk.stdout.toString('utf8').split('\n') : [])
  // File times are kept to the second on some filesystems.
  const floor = Math.floor(staging.frozenAt / 1000) * 1000
  const stagedPacks = new Set(staging.stagedPacks)
  const unattributable: CloneAttribution['unattributable'] = []
  for (const id of created) {
    const location = store.objects.get(id) as ObjectLocation
    let reason: UnattributableReason | null = null
    if (hiddenIds.has(id)) reason = 'hidden_input'
    else if (location.kind === 'foreign') reason = 'foreign_source'
    else if (location.kind === 'pack' && stagedPacks.has(location.pack)) reason = 'in_staged_pack'
    else if (statSync(location.path).mtimeMs < floor) reason = 'predates_trial'
    if (reason !== null) unattributable.push({ id, reason })
  }
  return {
    kind: 'clone',
    trialId: staging.trialId,
    created,
    reachable: created.filter((id) => fromBranch.has(id)),
    unreachable: created.filter((id) => !fromBranch.has(id)),
    unattributable,
    missing,
    attributable: unattributable.length === 0
  }
}

// ── After the trial: the grading copy ───────────────────────────────────────

export interface GradingCopyRequest {
  staging: Staging
  /** The trial's attribution; a trial with an unattributable object is not graded. */
  attribution: Attribution
  hidden: HiddenInputs
  /** Where the grading copy is created; never inside the trial's directory. */
  parentDirectory: string
  /**
   * `fail-to-pass`: the trial's resulting state plus the hidden tests.
   * `reference-solution`: the base commit plus the reference solution and the
   * hidden tests, proving the task solvable.
   */
  apply: 'fail-to-pass' | 'reference-solution'
}

export interface GradingCopy {
  trialId: string
  apply: GradingCopyRequest['apply']
  path: string
  /** The hidden paths written, sorted. */
  written: string[]
}

/**
 * A separate grading copy, made after the trial: the hidden inputs are
 * written there and nowhere else. The trial's own clone is only read.
 */
export function prepareGradingCopy(request: GradingCopyRequest): GradingCopy {
  const { staging, attribution, hidden, apply } = request
  if (attribution.trialId !== staging.trialId) {
    throw new StagingError('bad_request', `attribution is for ${attribution.trialId}, not ${staging.trialId}`)
  }
  if (!attribution.attributable) {
    throw new StagingError(
      'unattributed_objects',
      `trial ${staging.trialId} holds objects it cannot be shown to have created`
    )
  }
  const parent = realpathSync(request.parentDirectory)
  if (isInside(parent, staging.root.path) || isInside(staging.root.path, parent)) {
    throw new StagingError('overlapping_roots', 'the grading copy must live outside the trial directory')
  }
  const files: Array<[string, string | Uint8Array]> = [
    ...(apply === 'reference-solution' ? Object.entries(hidden.referenceSolution) : []),
    ...Object.entries(hidden.failToPassTests)
  ]
  const targets = files.map(([path, content]) => [safeRelativePath(path), content] as const)

  const path = mkdtempSync(join(parent, `grading-${staging.trialId}-`))
  try {
    const copy = join(path, 'repository')
    if (staging.kind === 'clone') {
      const source = apply === 'fail-to-pass' ? staging.workspace : staging.sourceRepository
      const selector =
        apply === 'fail-to-pass'
          ? ['--single-branch', '--branch', staging.taskBranch]
          : [`--revision=${staging.baseCommit}`]
      git(path, [
        'clone',
        '--quiet',
        '--no-local',
        '--no-hardlinks',
        '--no-tags',
        '--template=',
        ...selector,
        '--',
        source,
        copy
      ])
      git(copy, ['remote', 'remove', 'origin'])
    } else if (apply === 'fail-to-pass') {
      cpSync(staging.workspace, copy, { recursive: true, verbatimSymlinks: true })
    } else {
      writeSnapshot(staging.sourceRepository, staging.manifest, copy)
    }
    for (const [rel, content] of targets) {
      const target = join(copy, rel)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
    }
    return { trialId: staging.trialId, apply, path: copy, written: targets.map(([rel]) => rel).sort() }
  } catch (error) {
    rmSync(path, { recursive: true, force: true })
    throw error
  }
}
