/**
 * Trial staging: every trial gets a workspace of its own before any model
 * process starts — an isolated, non-local clone holding only the base
 * commit's history and one task branch, or, for a role that needs no git
 * metadata, a snapshot of the base commit's tree with none. Never a linked
 * worktree of the operator's repository, which shares its object database and
 * refs. The rules are the evaluation program's §11 "Repository isolation"
 * (`apps/cli/specs/dev-review-evaluation-program.md`); this module's own
 * specification is `apps/cli/specs/evals.md`, "Trial staging".
 *
 * Before staging touches the workspace, the controller freezes the
 * allowed-object manifest from its declared starter input, the base commit,
 * read from the source repository and not from the clone it will judge.
 * `contamination.ts` compares the staged workspace with that manifest.
 *
 * Every git process runs with a fixed environment: no system or global
 * configuration, no inherited `GIT_*` variable, and no home directory. The
 * operator's own home and vendor state are never read.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { devNull } from 'node:os'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

// ── Git ─────────────────────────────────────────────────────────────────────

export interface GitResult {
  status: number
  stdout: Buffer
  stderr: string
}

/** Why staging refused. */
export type StagingRefusalCode =
  | 'bad_request'
  | 'not_a_repository'
  | 'unknown_commit'
  | 'git_failed'
  | 'overlapping_roots'
  | 'bad_hidden_path'
  | 'unattributed_objects'

export class StagingError extends Error {
  constructor(
    readonly code: StagingRefusalCode,
    detail: string
  ) {
    super(detail)
  }
}

/**
 * The environment every harness git process runs with: no system, global or
 * XDG configuration and no home, so no operator setting (an alternate, a hook
 * path, a credential helper) reaches a staged repository, and nothing of the
 * operator's own home is read.
 */
const GIT_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: devNull,
  XDG_CONFIG_HOME: devNull,
  LANG: 'C',
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: devNull,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0'
}

/** Runs git in `cwd`; never throws on a non-zero exit. */
export function runGit(cwd: string, args: readonly string[], input?: Buffer | string): GitResult {
  const result = spawnSync('git', args, {
    cwd,
    env: GIT_ENV,
    input,
    maxBuffer: 1024 * 1024 * 1024
  })
  if (result.error) throw new StagingError('git_failed', `git ${args[0]}: ${result.error.message}`)
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr.toString('utf8') }
}

/** Runs git in `cwd` and returns stdout, or throws a `git_failed` refusal. */
export function git(cwd: string, args: readonly string[], input?: Buffer | string): string {
  const result = runGit(cwd, args, input)
  if (result.status !== 0) {
    throw new StagingError('git_failed', `git ${args.join(' ')} exited ${result.status}: ${result.stderr.trim()}`)
  }
  return result.stdout.toString('utf8')
}

/** The hash a git object of `type` with `content` has, in `format`. */
export function gitObjectId(format: ObjectFormat, type: 'blob', content: Uint8Array): string {
  return createHash(format).update(`${type} ${content.byteLength}\0`).update(content).digest('hex')
}

export type ObjectFormat = 'sha1' | 'sha256'

function objectFormat(repo: string): ObjectFormat {
  const format = git(repo, ['rev-parse', '--show-object-format']).trim()
  if (format !== 'sha1' && format !== 'sha256') throw new StagingError('git_failed', `unknown object format ${format}`)
  return format
}

// ── The allowed-object manifest ─────────────────────────────────────────────

/**
 * The objects a clone may hold before its trial: every object reachable from
 * the base commit, and nothing else. Frozen — computed once from the source
 * repository before staging, never extended by what a trial later creates.
 */
export interface AllowedObjectManifest {
  kind: 'objects'
  baseCommit: string
  objectFormat: ObjectFormat
  /** Every allowed object id, sorted. */
  objects: readonly string[]
  /** SHA-256 over the sorted ids, one per line. */
  digest: string
}

/** One entry of a snapshot's tree, as the base commit records it. */
export interface SnapshotEntry {
  path: string
  /** `100644`, `100755`, `120000` (symlink) or `160000` (gitlink). */
  mode: string
  id: string
}

/** The files a snapshot may hold before its trial: the base commit's tree exactly. */
export interface SnapshotManifest {
  kind: 'snapshot'
  baseCommit: string
  objectFormat: ObjectFormat
  entries: readonly SnapshotEntry[]
  /** SHA-256 over the sorted `mode id path` lines. */
  digest: string
}

function sha256Lines(lines: readonly string[]): string {
  return createHash('sha256')
    .update(lines.map((line) => `${line}\n`).join(''))
    .digest('hex')
}

function resolveCommit(source: string, commit: string): string {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit)) {
    throw new StagingError(
      'bad_request',
      `base commit must be a full lowercase object id, got ${JSON.stringify(commit)}`
    )
  }
  const result = runGit(source, ['cat-file', '-t', commit])
  if (result.status !== 0 || result.stdout.toString('utf8').trim() !== 'commit') {
    throw new StagingError('unknown_commit', `${commit} is not a commit in ${source}`)
  }
  return commit
}

function assertRepository(source: string): void {
  const result = runGit(source, ['rev-parse', '--git-dir'])
  if (result.status !== 0) throw new StagingError('not_a_repository', `${source} is not a git repository`)
}

/** Every object reachable from `baseCommit` in `source`, frozen. */
export function freezeObjectManifest(source: string, baseCommit: string): Readonly<AllowedObjectManifest> {
  assertRepository(source)
  resolveCommit(source, baseCommit)
  const ids = git(source, ['rev-list', '--objects', '--no-object-names', baseCommit])
    .split('\n')
    .filter((line) => line !== '')
  const objects = [...new Set(ids)].sort()
  return deepFreeze({
    kind: 'objects',
    baseCommit,
    objectFormat: objectFormat(source),
    objects,
    digest: sha256Lines(objects)
  })
}

/** The base commit's tree, every entry recursively, frozen. */
export function freezeSnapshotManifest(source: string, baseCommit: string): Readonly<SnapshotManifest> {
  assertRepository(source)
  resolveCommit(source, baseCommit)
  const entries = readTree(source, baseCommit)
  return deepFreeze({
    kind: 'snapshot',
    baseCommit,
    objectFormat: objectFormat(source),
    entries,
    digest: sha256Lines(entries.map((e) => `${e.mode} ${e.id} ${e.path}`))
  })
}

function readTree(repo: string, commit: string): SnapshotEntry[] {
  const out: SnapshotEntry[] = []
  for (const record of git(repo, ['ls-tree', '-r', '-z', '--full-tree', commit]).split('\0')) {
    if (record === '') continue
    const tab = record.indexOf('\t')
    const [mode, , id] = record.slice(0, tab).split(' ')
    out.push({ path: record.slice(tab + 1), mode: mode as string, id: id as string })
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const inner of Object.values(value)) deepFreeze(inner)
  }
  return value
}

// ── Staging ─────────────────────────────────────────────────────────────────

/** A directory staging created, with the identity it had when created. */
export interface FreshDirectory {
  path: string
  dev: number
  ino: number
}

/**
 * The per-trial agent state locations. Each is created empty by staging, for
 * this trial alone; the contamination test checks each is still that directory
 * and still empty.
 */
export const AGENT_STATE_DIRS = ['vendorHome', 'sessionStore', 'transcripts', 'toolState', 'cache', 'tmp'] as const
export type AgentStateDir = (typeof AGENT_STATE_DIRS)[number]

export interface StagingRequest {
  trialId: string
  /** The repository the base commit is read from. It is only ever read. */
  sourceRepository: string
  baseCommit: string
  /** Where the trial's own directory is created. */
  parentDirectory: string
  /** `clone` for a role that needs git; `snapshot` for one that needs none. */
  mode: 'clone' | 'snapshot'
  /** The one branch a clone holds. Ignored for a snapshot. */
  taskBranch?: string
}

interface StagingBase {
  trialId: string
  /** The repository the trial was staged from; only ever read. */
  sourceRepository: string
  baseCommit: string
  /** The trial's own directory: every path below lives inside it. */
  root: FreshDirectory
  /** The agent-visible repository or snapshot. */
  workspace: string
  agentState: Record<AgentStateDir, FreshDirectory>
  /** Epoch milliseconds at which staging finished. */
  frozenAt: number
}

export interface CloneStaging extends StagingBase {
  kind: 'clone'
  taskBranch: string
  gitDir: string
  manifest: Readonly<AllowedObjectManifest>
  /** The pack files the clone held when staging finished, by base name. */
  stagedPacks: readonly string[]
}

export interface SnapshotStaging extends StagingBase {
  kind: 'snapshot'
  manifest: Readonly<SnapshotManifest>
}

export type Staging = CloneStaging | SnapshotStaging

const TRIAL_ID = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/

function freshDirectory(path: string): FreshDirectory {
  mkdirSync(path)
  const stat = statSync(path)
  return { path, dev: stat.dev, ino: stat.ino }
}

/**
 * Stages one trial. The manifest is frozen from the source repository first;
 * then the trial's directory, its workspace and its empty agent state are
 * created. Nothing in the source repository is written.
 */
export function stageTrial(request: StagingRequest): Staging {
  if (!TRIAL_ID.test(request.trialId)) {
    throw new StagingError('bad_request', `trial id must be a stable lowercase identifier, got ${request.trialId}`)
  }
  const source = resolve(request.sourceRepository)
  const manifest =
    request.mode === 'clone'
      ? freezeObjectManifest(source, request.baseCommit)
      : freezeSnapshotManifest(source, request.baseCommit)

  const rootPath = mkdtempSync(join(realpathSync(request.parentDirectory), `trial-${request.trialId}-`))
  const root = (() => {
    const stat = statSync(rootPath)
    return { path: rootPath, dev: stat.dev, ino: stat.ino }
  })()
  if (isInside(rootPath, realpathSync(source)) || isInside(realpathSync(source), rootPath)) {
    rmSync(rootPath, { recursive: true, force: true })
    throw new StagingError(
      'overlapping_roots',
      'the trial directory and the source repository must not contain each other'
    )
  }
  try {
    const workspace = join(rootPath, 'workspace')
    const stateRoot = join(rootPath, 'agent')
    mkdirSync(stateRoot)
    const agentState = {} as Record<AgentStateDir, FreshDirectory>
    for (const key of AGENT_STATE_DIRS) agentState[key] = freshDirectory(join(stateRoot, key))

    if (manifest.kind === 'objects') {
      const taskBranch = request.taskBranch ?? ''
      if (runGit(source, ['check-ref-format', '--branch', taskBranch]).status !== 0 || taskBranch === '') {
        throw new StagingError('bad_request', `task branch ${JSON.stringify(taskBranch)} is not a valid branch name`)
      }
      cloneBase(source, request.baseCommit, taskBranch, workspace)
      const gitDir = join(workspace, '.git')
      return {
        kind: 'clone',
        trialId: request.trialId,
        sourceRepository: source,
        baseCommit: request.baseCommit,
        root,
        workspace,
        agentState,
        taskBranch,
        gitDir,
        manifest,
        stagedPacks: packNames(gitDir),
        frozenAt: Date.now()
      }
    }
    writeSnapshot(source, manifest, workspace)
    return {
      kind: 'snapshot',
      trialId: request.trialId,
      sourceRepository: source,
      baseCommit: request.baseCommit,
      root,
      workspace,
      agentState,
      manifest,
      frozenAt: Date.now()
    }
  } catch (error) {
    rmSync(rootPath, { recursive: true, force: true })
    throw error
  }
}

/**
 * A non-local clone (the regular git transport, so no object file is shared
 * or hard-linked) of exactly the history leading to `baseCommit`, with no
 * tags and no templates; then the one task branch at the base commit, the
 * configured remote removed, and every reflog the clone wrote deleted.
 */
function cloneBase(source: string, baseCommit: string, taskBranch: string, workspace: string): void {
  git(dirname(workspace), [
    'clone',
    '--quiet',
    '--no-local',
    '--no-hardlinks',
    '--no-checkout',
    '--no-tags',
    '--template=',
    `--revision=${baseCommit}`,
    '--',
    source,
    workspace
  ])
  const ref = `refs/heads/${taskBranch}`
  git(workspace, ['update-ref', '--no-deref', ref, baseCommit, ''])
  git(workspace, ['symbolic-ref', 'HEAD', ref])
  git(workspace, ['remote', 'remove', 'origin'])
  git(workspace, ['read-tree', '--reset', '-u', 'HEAD'])
  rmSync(join(workspace, '.git', 'logs'), { recursive: true, force: true })
  const packed = join(workspace, '.git', 'packed-refs')
  if (
    lstatExists(packed) &&
    readFileSync(packed, 'utf8')
      .split('\n')
      .every((l) => l === '' || l.startsWith('#'))
  ) {
    rmSync(packed)
  }
}

/** The base commit's tree written byte for byte from its blobs: no filters, no git metadata. */
export function writeSnapshot(source: string, manifest: SnapshotManifest, workspace: string): void {
  mkdirSync(workspace)
  const blobs = manifest.entries.filter((e) => e.mode !== '160000')
  const contents = readBlobs(
    source,
    blobs.map((e) => e.id)
  )
  for (const entry of manifest.entries) {
    const target = join(workspace, entry.path)
    mkdirSync(dirname(target), { recursive: true })
    if (entry.mode === '160000') {
      mkdirSync(target, { recursive: true })
      continue
    }
    const content = contents.get(entry.id) as Buffer
    if (entry.mode === '120000') {
      symlinkSync(content.toString('utf8'), target)
      continue
    }
    writeFileSync(target, content)
    chmodSync(target, entry.mode === '100755' ? 0o755 : 0o644)
  }
}

/** Reads raw blob contents through one `cat-file --batch` process. */
function readBlobs(repo: string, ids: readonly string[]): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  const unique = [...new Set(ids)]
  if (unique.length === 0) return out
  const result = runGit(repo, ['cat-file', '--batch'], `${unique.join('\n')}\n`)
  if (result.status !== 0) throw new StagingError('git_failed', `cat-file --batch: ${result.stderr.trim()}`)
  const buf = result.stdout
  let at = 0
  while (at < buf.length) {
    const eol = buf.indexOf(0x0a, at)
    const [id, , size] = buf.subarray(at, eol).toString('utf8').split(' ')
    const length = Number(size)
    out.set(id as string, Buffer.from(buf.subarray(eol + 1, eol + 1 + length)))
    at = eol + 1 + length + 1
  }
  return out
}

// ── Shared helpers ──────────────────────────────────────────────────────────

/** True when `path` is `dir` or lies below it. */
export function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

export function lstatExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** The base names of the pack files in a git directory's object store. */
export function packNames(gitDir: string): string[] {
  const dir = join(gitDir, 'objects', 'pack')
  if (!lstatExists(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.pack'))
    .sort()
}

/**
 * A relative path to write a hidden input at: normalised, inside its root, and
 * never under `.git`.
 */
export function safeRelativePath(path: string): string {
  const normal = normalize(path)
  if (
    path === '' ||
    isAbsolute(path) ||
    normal.startsWith(`..${sep}`) ||
    normal === '..' ||
    normal.split(sep).includes('.git')
  ) {
    throw new StagingError(
      'bad_hidden_path',
      `hidden input path ${JSON.stringify(path)} must stay inside the copy and outside .git`
    )
  }
  return normal
}
