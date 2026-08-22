// The change-set spine.
//
// One model of typed, owned operations that BOTH `init` and `eject` consume.
// `init` applies each op forward and records what it did into the `managed`
// manifest (see lib/config.ts); `eject` reads those same records and applies
// each op's inverse. init and eject share this file precisely so ownership is
// recorded once, by the same code that will later reverse it — the failure the
// task exists to prevent is init recording ownership too loosely for eject to
// undo cleanly.
//
// Non-destructive by contract: every mutation is classified against the
// current on-disk state BEFORE anything is written (`planInstall`), the full
// classification is rendered as a diff the caller shows and confirms, and only
// then is anything applied. A file vinaya did not create is never overwritten
// (refuse-if-foreign); an adopter hook vinaya did not author is never
// clobbered (append a marker-delimited managed block instead); an existing
// label is never modified, and no label is ever auto-deleted.

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { ManagedBlockRecord, ManagedManifest } from './config.js'
import { MANAGED_MANIFEST_VERSION } from './config.js'

/** Comment syntax of the host file a managed block lives in. */
export type CommentStyle = 'hash' | 'html'

export type CreateFileOp = {
  kind: 'create-file'
  /** repo-root-relative, forward-slashed */
  path: string
  content: string
  /** POSIX mode, e.g. 0o755 for an executable hook. */
  mode?: number
  /** diff-grouping label, purely presentational */
  group: string
}

export type ManagedBlockOp = {
  kind: 'managed-block'
  path: string
  /** stable id for this block within the host file, e.g. `pre-commit` */
  marker: string
  /** the lines between the markers (no markers, no trailing newline) */
  body: string
  comment: CommentStyle
  /** shebang etc. used only when vinaya must CREATE the host file fresh */
  hostPreamble?: string
  mode?: number
  group: string
}

export type CreateLabelOp = {
  kind: 'create-label'
  name: string
  color: string
  description: string
  group: string
}

export type PrintOp = { kind: 'print'; message: string; group: string }

export type Op = CreateFileOp | ManagedBlockOp | CreateLabelOp | PrintOp

/**
 * The managed-block marker namespace — **not a forge label**, so the `vinaya/`
 * label grammar (#614) deliberately does not apply. These bytes are written
 * into an adopter's git-hook and workflow files and are matched literally by
 * `eject` to strip the block again, so changing them would orphan every block
 * already installed in the field. A label-namespace audit will match this line;
 * it is a false positive by construction.
 */
const MARKER_NS = 'vinaya:managed'

function markerLines(marker: string, comment: CommentStyle): { begin: string; end: string } {
  const [open, close] = comment === 'hash' ? ['#', ''] : ['<!--', ' -->']
  return {
    begin: `${open} >>> ${MARKER_NS}:${marker} >>>${close}`,
    end: `${open} <<< ${MARKER_NS}:${marker} <<<${close}`
  }
}

/** The full managed region as it appears in a host file. */
function renderBlock(op: ManagedBlockOp): string {
  const { begin, end } = markerLines(op.marker, op.comment)
  return `${begin}\n${op.body}\n${end}`
}

function abs(repoRoot: string, relPath: string): string {
  return join(repoRoot, relPath)
}

/**
 * A raw git hook's real on-disk path — resolved through `git rev-parse
 * --git-common-dir` rather than a literal `join(repoRoot, '.git/hooks/…')`.
 * Hooks are never per-worktree: every linked worktree shares the main
 * checkout's hooks directory, and in a linked worktree `<repoRoot>/.git` is a
 * FILE (a gitdir pointer), not a directory, so the naive join resolves
 * nothing. The single source of truth for every managed-block (hook) path —
 * `doctor.ts` (reads), `upgrade.ts` (reads + writes), and this file's own
 * `appendBlock`/`createHost`/`planInstall` (init's writes) all call this
 * instead of each re-deriving the rule, so it can't drift between them again.
 * `.husky/*` paths are untouched: husky's directory is a real, git-tracked
 * directory present in every worktree checkout, so the naive join is already
 * correct there — this only special-cases the `.git/`-prefixed form.
 */
export function resolveManagedBlockPath(repoRoot: string, opPath: string): string {
  if (!opPath.startsWith('.git/')) return join(repoRoot, opPath)
  return join(gitCommonDir(repoRoot), opPath.slice('.git/'.length))
}

/**
 * The git common directory — the main checkout's `.git`, shared by every
 * linked worktree. Falls back to `<repoRoot>/.git` when `git` cannot answer,
 * which is exactly what a literal join would have produced, so a git failure
 * degrades to the old behavior rather than to nothing.
 *
 * Extracted so `resolveManagedBlockPath` (which builds a hook's path) and
 * `containedManagedBlockAbs` (which decides whether that path is in bounds)
 * derive from ONE answer. Two callers each shelling out separately could
 * disagree — one falling back while the other succeeded — and a containment
 * check that disagrees with the resolver it guards is worse than no check.
 */
function gitCommonDir(repoRoot: string): string {
  try {
    const commonDir = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8'
    }).trim()
    if (commonDir === '') return join(repoRoot, '.git')
    return isAbsolute(commonDir) ? commonDir : join(repoRoot, commonDir)
  } catch {
    return join(repoRoot, '.git')
  }
}

/**
 * Resolve `relPath` under `repoRoot` and return the absolute path ONLY if it
 * stays inside the repo — never the repo root itself, never anything above it.
 * Returns null for any escape (`..`, absolute path). This is the runtime half
 * of the eject-safety guarantee (the schema refinement in config.ts is the
 * parse-layer half): no fs mutation is ever performed on a path this rejects,
 * so a malicious/hand-edited manifest can never drive a delete outside the repo.
 */
export function containedAbs(repoRoot: string, relPath: string): string | null {
  const root = resolve(repoRoot)
  const target = resolve(root, relPath)
  if (target === root) return null
  return target === root || target.startsWith(root + sep) ? target : null
}

/**
 * The containment guarantee for a MANAGED BLOCK path, which `containedAbs`
 * cannot express (Issue #68).
 *
 * `containedAbs` resolves a path and requires it to stay inside `repoRoot`.
 * That is exactly right for the whole files vinaya owns. It is wrong for a
 * `.git/hooks/*` block in a LINKED WORKTREE: hooks are never per-worktree, so
 * the hook's real home is the main checkout's shared hooks directory
 * (`git rev-parse --git-common-dir`), which is legitimately OUTSIDE the
 * worktree's `repoRoot`. `containedAbs` therefore rejected the very path
 * `eject` needed to strip — correctly by its own logic — and an "ejected"
 * install silently left an active commit-time execution surface behind.
 *
 * So the rule is re-based, not relaxed: a `.git/`-prefixed block must resolve
 * inside the git common dir's own `hooks/` subtree. That is strictly TIGHTER
 * than the old rule in the ordinary non-worktree case, where `<repoRoot>/.git`
 * IS the common dir: `.git/config` and `.git/objects/…` were previously
 * "contained" and are now refused, since no managed block has any business
 * outside `hooks/`. The hooks directory itself is refused too, mirroring
 * `containedAbs`'s refusal of the repo root.
 *
 * `.husky/*` is untouched and still goes through `containedAbs`: husky's
 * directory is a real, git-tracked directory present in every worktree
 * checkout, so the naive join was already correct there.
 *
 * Returns `null` for any escape, and no fs mutation is ever performed on a
 * path this rejects — the same guarantee `containedAbs` carries, re-stated
 * for the paths it could not reason about.
 */
export function containedManagedBlockAbs(repoRoot: string, relPath: string): string | null {
  if (!relPath.startsWith('.git/')) return containedAbs(repoRoot, relPath)
  const hooksRoot = resolve(join(gitCommonDir(repoRoot), 'hooks'))
  const target = resolve(resolveManagedBlockPath(repoRoot, relPath))
  if (target === hooksRoot) return null
  return target.startsWith(hooksRoot + sep) ? target : null
}

/** Only ever called with a managed-block (hook) path — see `planInstall`. */
function fileContains(repoRoot: string, relPath: string, needle: string): boolean {
  const p = resolveManagedBlockPath(repoRoot, relPath)
  if (!existsSync(p)) return false
  return readFileSync(p, 'utf-8').includes(needle)
}

// ---------------------------------------------------------------------------
// Plan (classify every op against current disk state — no writes)
// ---------------------------------------------------------------------------

export type FileAction = 'create' | 'skip-owned' | 'refuse-foreign'
export type BlockAction = 'create-host' | 'append' | 'skip-present'

export type PlanEntry =
  | { kind: 'create-file'; op: CreateFileOp; action: FileAction }
  | { kind: 'managed-block'; op: ManagedBlockOp; action: BlockAction }
  | { kind: 'create-label'; op: CreateLabelOp }
  | { kind: 'print'; op: PrintOp }

export type InstallPlan = {
  entries: PlanEntry[]
  /** true when at least one create-file op would clobber foreign content */
  hasRefusals: boolean
}

/**
 * Classify each op. `ownedFiles` is the set of paths a prior vinaya install
 * already owns (from an existing manifest) — on a fresh repo it is empty, so
 * any pre-existing file at a vinaya path is foreign and refused.
 */
export function planInstall(ops: Op[], repoRoot: string, ownedFiles: Set<string> = new Set()): InstallPlan {
  const entries: PlanEntry[] = []
  let hasRefusals = false

  for (const op of ops) {
    switch (op.kind) {
      case 'create-file': {
        const exists = existsSync(abs(repoRoot, op.path))
        let action: FileAction
        if (!exists) action = 'create'
        else if (ownedFiles.has(op.path)) action = 'skip-owned'
        else {
          action = 'refuse-foreign'
          hasRefusals = true
        }
        entries.push({ kind: 'create-file', op, action })
        break
      }
      case 'managed-block': {
        const { begin } = markerLines(op.marker, op.comment)
        let action: BlockAction
        if (fileContains(repoRoot, op.path, begin)) action = 'skip-present'
        else if (existsSync(resolveManagedBlockPath(repoRoot, op.path))) action = 'append'
        else action = 'create-host'
        entries.push({ kind: 'managed-block', op, action })
        break
      }
      case 'create-label':
        entries.push({ kind: 'create-label', op })
        break
      case 'print':
        entries.push({ kind: 'print', op })
        break
    }
  }

  return { entries, hasRefusals }
}

// ---------------------------------------------------------------------------
// Diff rendering
// ---------------------------------------------------------------------------

function indent(text: string, pad = '    '): string {
  return text
    .split('\n')
    .map((l) => (l.length > 0 ? pad + l : l))
    .join('\n')
}

/** The COMPLETE diff of an install plan — every intended change, shown. */
export function renderInstallDiff(plan: InstallPlan): string {
  const lines: string[] = []
  const groups = new Map<string, PlanEntry[]>()
  for (const e of plan.entries) {
    const g = e.op.group
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)?.push(e)
  }

  for (const [group, es] of groups) {
    lines.push(`── ${group} ─────────────────────────────`)
    for (const e of es) {
      switch (e.kind) {
        case 'create-file':
          if (e.action === 'create') {
            lines.push(`  + create ${e.op.path}`)
            lines.push(indent(e.op.content))
          } else if (e.action === 'skip-owned') {
            lines.push(`  = keep   ${e.op.path} (already vinaya-managed)`)
          } else {
            lines.push(`  ✖ REFUSE ${e.op.path} — foreign content exists at this path; not overwritten`)
          }
          break
        case 'managed-block':
          if (e.action === 'skip-present') {
            lines.push(`  = keep   ${e.op.path} (vinaya block already present)`)
          } else if (e.action === 'append') {
            lines.push(`  ~ append managed block to ${e.op.path} (existing content untouched)`)
            lines.push(indent(renderBlock(e.op)))
          } else {
            lines.push(`  + create ${e.op.path} (with managed block)`)
            lines.push(indent(`${e.op.hostPreamble ?? ''}${renderBlock(e.op)}`))
          }
          break
        case 'create-label':
          lines.push(`  + label  ${e.op.name} (created only if absent; existing labels never modified)`)
          break
        case 'print':
          lines.push(`  ⓘ ${e.op.message.split('\n').join('\n    ')}`)
          break
      }
    }
    lines.push('')
  }

  if (plan.hasRefusals) {
    lines.push('One or more paths hold foreign content — those artifacts will be SKIPPED, not overwritten.')
    lines.push('Resolve them manually (or remove the conflicting file) and re-run to install the rest.')
    lines.push('')
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Apply (forward)
// ---------------------------------------------------------------------------

export interface LabelGateway {
  exists(name: string): Promise<boolean>
  create(name: string, color: string, description: string): Promise<void>
}

function writeFileWithDirs(target: string, content: string, mode?: number): void {
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf-8')
  if (mode !== undefined) chmodSync(target, mode)
}

function appendBlock(repoRoot: string, op: ManagedBlockOp): void {
  const target = resolveManagedBlockPath(repoRoot, op.path)
  const existing = readFileSync(target, 'utf-8')
  const sep = existing.endsWith('\n') ? '\n' : '\n\n'
  writeFileSync(target, `${existing}${sep}${renderBlock(op)}\n`, 'utf-8')
  if (op.mode !== undefined) chmodSync(target, op.mode)
}

function createHost(repoRoot: string, op: ManagedBlockOp): void {
  const target = resolveManagedBlockPath(repoRoot, op.path)
  writeFileWithDirs(target, `${op.hostPreamble ?? ''}${renderBlock(op)}\n`, op.mode)
}

/**
 * Apply every non-refused entry and return the ownership manifest. Refused
 * (foreign) create-file entries are skipped — never overwritten. Callers that
 * want a hard stop on any refusal must check `plan.hasRefusals` first.
 *
 * `onFilesRecorded` is invoked with the files+blocks manifest AFTER every file
 * and block is on disk but BEFORE any network-bound label creation. The caller
 * persists it there, so a label-create failure (rate limit, transient gh
 * error, a racing pre-existing label) can never leave written files with no
 * manifest recording them — the "orphan half-state" a mid-apply throw would
 * otherwise cause. Labels are report-only on eject, so a label created just
 * before a throw being unrecorded is harmless (it is never auto-deleted).
 */
export async function applyInstall(
  plan: InstallPlan,
  repoRoot: string,
  labels: LabelGateway,
  onFilesRecorded?: (m: ManagedManifest) => void
): Promise<ManagedManifest> {
  const files: string[] = []
  const blocks: ManagedBlockRecord[] = []
  const createdLabels: string[] = []

  // Pass 1: all filesystem writes (create-file, managed-block) + prints.
  for (const e of plan.entries) {
    switch (e.kind) {
      case 'create-file':
        if (e.action === 'create') {
          writeFileWithDirs(abs(repoRoot, e.op.path), e.op.content, e.op.mode)
          files.push(e.op.path)
        } else if (e.action === 'skip-owned') {
          // idempotent re-install: still ours, keep it in the manifest.
          files.push(e.op.path)
        }
        break
      case 'managed-block':
        if (e.action === 'append') appendBlock(repoRoot, e.op)
        else if (e.action === 'create-host') createHost(repoRoot, e.op)
        // Record the block even when already present (idempotent re-install):
        // it is ours, so eject must know to strip it.
        blocks.push({ path: e.op.path, marker: e.op.marker, comment: e.op.comment })
        break
      case 'print':
        process.stdout.write(`${e.op.message}\n`)
        break
    }
  }

  // Persist ownership of everything on disk BEFORE any network label call.
  const base: ManagedManifest = {
    version: MANAGED_MANIFEST_VERSION,
    files: dedupe(files),
    blocks: dedupeBlocks(blocks),
    labels: []
  }
  onFilesRecorded?.(base)

  // Pass 2: labels (network-bound, create-if-absent). A single label failure
  // (bad/missing remote, no push access, anything `gh` itself reports) must
  // never take down the whole command — every file/hook/config artifact has
  // already applied by this point. Warn with `gh`'s own stderr, verbatim, and
  // move on to the next label.
  for (const e of plan.entries) {
    if (e.kind !== 'create-label') continue
    try {
      if (!(await labels.exists(e.op.name))) {
        await labels.create(e.op.name, e.op.color, e.op.description)
        createdLabels.push(e.op.name)
      }
    } catch (err) {
      const reason = (err as { stderr?: string }).stderr?.trim() || (err as Error).message
      console.warn(`Warning: could not create label '${e.op.name}': ${reason}`)
    }
  }

  return { ...base, labels: dedupe(createdLabels) }
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)]
}

function dedupeBlocks(bs: ManagedBlockRecord[]): ManagedBlockRecord[] {
  const seen = new Set<string>()
  const out: ManagedBlockRecord[] = []
  for (const b of bs) {
    const key = `${b.path}::${b.marker}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(b)
  }
  return out
}

// ---------------------------------------------------------------------------
// Eject (inverse) — driven purely by the recorded manifest
// ---------------------------------------------------------------------------

export type EjectAction =
  | { kind: 'delete-file'; path: string; present: boolean }
  | { kind: 'strip-block'; path: string; marker: string; comment: CommentStyle; present: boolean; removesHost: boolean }
  | { kind: 'report-label'; name: string }

export type EjectPlan = {
  actions: EjectAction[]
  /** recorded paths that resolve OUTSIDE the repo — a corrupt/hostile manifest;
   *  their presence makes the whole eject refuse (never a partial destructive run) */
  escapes: string[]
}

/** Does removing this managed block leave a file vinaya effectively created? */
export function blockStripLeavesEmpty(body: string): boolean {
  // Only whitespace and a lone shebang line remain → vinaya created the host.
  const rest = body
    .split('\n')
    .filter((l) => l.trim().length > 0 && !l.startsWith('#!'))
    .join('')
  return rest.length === 0
}

function stripBlockFromContent(content: string, marker: string, comment: CommentStyle): string | null {
  const { begin, end } = markerLines(marker, comment)
  const lines = content.split('\n')
  const startIdx = lines.findIndex((l) => l.trim() === begin)
  if (startIdx === -1) return null
  const endIdx = lines.findIndex((l, i) => i >= startIdx && l.trim() === end)
  if (endIdx === -1) return null
  // Also swallow one blank separator line immediately before the block.
  let from = startIdx
  if (from > 0 && lines[from - 1]?.trim() === '') from -= 1
  lines.splice(from, endIdx - from + 1)
  return lines.join('\n')
}

/**
 * Build the inverse plan from a recorded manifest. Files vinaya created are
 * deleted; managed blocks are stripped (host file kept unless vinaya created
 * it); labels are reported for manual removal, never deleted.
 */
export function planEject(manifest: ManagedManifest, repoRoot: string): EjectPlan {
  const actions: EjectAction[] = []
  const escapes: string[] = []

  for (const b of manifest.blocks) {
    const p = containedManagedBlockAbs(repoRoot, b.path)
    if (p === null) {
      escapes.push(b.path)
      continue
    }
    if (!existsSync(p)) {
      actions.push({
        kind: 'strip-block',
        path: b.path,
        marker: b.marker,
        comment: b.comment,
        present: false,
        removesHost: false
      })
      continue
    }
    const content = readFileSync(p, 'utf-8')
    const stripped = stripBlockFromContent(content, b.marker, b.comment)
    const removesHost = stripped !== null && blockStripLeavesEmpty(stripped)
    actions.push({
      kind: 'strip-block',
      path: b.path,
      marker: b.marker,
      comment: b.comment,
      present: stripped !== null,
      removesHost
    })
  }

  for (const f of manifest.files) {
    const p = containedAbs(repoRoot, f)
    if (p === null) {
      escapes.push(f)
      continue
    }
    actions.push({ kind: 'delete-file', path: f, present: existsSync(p) })
  }

  for (const name of manifest.labels) {
    actions.push({ kind: 'report-label', name })
  }

  return { actions, escapes }
}

export function renderEjectDiff(plan: EjectPlan): string {
  const lines: string[] = []
  for (const a of plan.actions) {
    if (a.kind === 'delete-file') {
      lines.push(a.present ? `  - delete ${a.path}` : `  · gone   ${a.path} (already removed)`)
    } else if (a.kind === 'strip-block') {
      if (!a.present) lines.push(`  · gone   ${a.path} (managed block already removed)`)
      else if (a.removesHost) lines.push(`  - delete ${a.path} (vinaya-created host; nothing else remains)`)
      else lines.push(`  ~ strip managed block from ${a.path} (your other lines are kept)`)
    } else {
      lines.push(
        `  ⓘ label  ${a.name} — remove manually if unused (a label may be in use elsewhere; never auto-deleted)`
      )
    }
  }
  return lines.join('\n')
}

/**
 * Apply the inverse plan. Labels are only reported (returned), never deleted.
 * Callers MUST refuse when `plan.escapes` is non-empty before calling this; as
 * a second guard, every fs mutation re-checks containment and skips any path
 * its containment function rejects, regardless of what the manifest claims.
 *
 * "Contained" is per-kind, and deliberately not one rule: a whole file must
 * stay inside `repoRoot` (`containedAbs`), while a `.git/hooks/*` managed
 * block must stay inside the git common dir's `hooks/` subtree
 * (`containedManagedBlockAbs`). The second is genuinely outside `repoRoot`
 * from a linked worktree — that is the point, since hooks are shared rather
 * than per-worktree — so this is not "a delete outside `repoRoot` is
 * impossible"; it is "every delete is inside the one directory its own kind
 * is allowed to touch".
 */
export function applyEject(plan: EjectPlan, repoRoot: string): { removedLabelsToReport: string[] } {
  for (const a of plan.actions) {
    if (a.kind === 'strip-block') {
      if (!a.present) continue
      const p = containedManagedBlockAbs(repoRoot, a.path)
      if (p === null) continue
      const content = readFileSync(p, 'utf-8')
      const stripped = stripBlockFromContent(content, a.marker, a.comment)
      if (stripped === null) continue
      if (blockStripLeavesEmpty(stripped)) rmSync(p, { force: true })
      else writeFileSync(p, stripped.endsWith('\n') ? stripped : `${stripped}\n`, 'utf-8')
    } else if (a.kind === 'delete-file') {
      const p = containedAbs(repoRoot, a.path)
      if (a.present && p !== null) rmSync(p, { force: true })
    }
  }
  return {
    removedLabelsToReport: plan.actions
      .filter((a) => a.kind === 'report-label')
      .map((a) => (a as { name: string }).name)
  }
}

export { markerLines, renderBlock, stripBlockFromContent, writeFileWithDirs, appendBlock, createHost, indent }
