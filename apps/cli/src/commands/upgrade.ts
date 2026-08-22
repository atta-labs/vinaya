// `vinaya upgrade` — regenerate vinaya-owned artifacts to the installed
// package's current generators. The only sanctioned migration path: the
// same detect → plan → render diff → confirm → apply engine `init` uses, but
// inverted in intent — where init never touches an already-owned file,
// upgrade's whole job is bringing an owned-but-stale artifact current.
//
// Adopter-owned content is NEVER touched: `vinaya.config.json`'s semantic
// fields (rings/checks/briefSchema) are the adopter's own and are preserved
// verbatim; only the `managed` ownership manifest inside it is regenerated.
// A file/block vinaya does not own (foreign content, or never installed) is
// left exactly alone — upgrade regenerates what init already owns, it does
// not perform a fresh install.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOC_OWNERS_PATH } from '@attalabs/aeg-core'
import { buildInitOps, CONFIG_PATH, type HookDir, type InitContext, TRACKED_HOOK_DIR } from '../lib/artifacts.js'
import { detectVendoredVinaya } from '../lib/self-host.js'
import { MANAGED_MANIFEST_VERSION, type ManagedManifest, readRepoCiSetup, VinayaConfigSchema } from '../lib/config.js'
import {
  activeRawHooks,
  detectGitRepo,
  foreignRawHooks,
  hookDirFromManifest,
  readCoreHooksPath,
  type RepoInfo,
  resolveHookDir,
  setCoreHooksPath
} from '../lib/detect.js'
import {
  appendBlock,
  blockStripLeavesEmpty,
  createHost,
  indent,
  markerLines,
  type CommentStyle,
  type CreateFileOp,
  type ManagedBlockOp,
  type Op,
  renderBlock,
  resolveManagedBlockPath,
  stripBlockFromContent,
  writeFileWithDirs
} from '../lib/ops.js'
import { closeStdin, promptYesNo } from '../lib/prompt.js'

export type UpgradeDeps = {
  detectRepo: () => Promise<RepoInfo | null>
  hookDirFor: (repoRoot: string) => HookDir
  readHooksPath: (repoRoot: string) => Promise<string | null>
  setHooksPath: (repoRoot: string, dir: string) => Promise<void>
  confirm: (question: string) => Promise<boolean>
}

function realDeps(): UpgradeDeps {
  return {
    detectRepo: detectGitRepo,
    hookDirFor: resolveHookDir,
    readHooksPath: readCoreHooksPath,
    setHooksPath: setCoreHooksPath,
    confirm: async (q) => {
      const yes = await promptYesNo(q, false)
      closeStdin()
      return yes
    }
  }
}

type Flags = { dryRun: boolean; yes: boolean }
function flags(args: string[]): Flags {
  return { dryRun: args.includes('--dry-run'), yes: args.includes('--yes') }
}

// ---------------------------------------------------------------------------
// vinaya.config.json — read repoRoot-scoped (never the cwd-walking loader),
// same reasoning as init.ts/eject.ts/doctor.ts.
// ---------------------------------------------------------------------------
type ConfigRead =
  | { kind: 'missing' }
  | { kind: 'invalid'; error: string }
  | { kind: 'not-initialized' }
  | { kind: 'ok'; manifest: ManagedManifest }

function readManifest(repoRoot: string): ConfigRead {
  const p = join(repoRoot, CONFIG_PATH)
  if (!existsSync(p)) return { kind: 'missing' }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(p, 'utf-8'))
  } catch (err) {
    return { kind: 'invalid', error: `invalid JSON: ${(err as Error).message}` }
  }
  const parsed = VinayaConfigSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      kind: 'invalid',
      error: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    }
  }
  if (!parsed.data.managed) return { kind: 'not-initialized' }
  return { kind: 'ok', manifest: parsed.data.managed }
}

/** Rewrite ONLY the `managed.version` field, preserving every other
 * top-level key (rings/checks/briefSchema — adopter-owned) and the recorded
 * files/blocks/labels arrays (ownership doesn't change from a content
 * regeneration) exactly as they were. */
function writeManifestVersion(repoRoot: string, manifest: ManagedManifest): void {
  const configAbs = join(repoRoot, CONFIG_PATH)
  const seed = JSON.parse(readFileSync(configAbs, 'utf-8'))
  const updated: ManagedManifest = { ...manifest, version: MANAGED_MANIFEST_VERSION }
  writeFileSync(configAbs, `${JSON.stringify({ ...seed, managed: updated }, null, 2)}\n`, 'utf-8')
}

// ---------------------------------------------------------------------------
// Hook routing — where this upgrade regenerates hooks, and what that implies.
//
// A `.git/hooks` install is the atta-labs/attalabs#927 defect: git never
// versions `.git/`, so the manifest survives every clone while the hooks do
// not — the installing machine has ring 0, everyone who clones has none,
// silently. Upgrade is the sanctioned migration path, so it is where a legacy
// install moves to the tracked `.vinaya/hooks` layout: tracked copies land
// first, the legacy blocks are stripped, `core.hooksPath` is armed, and the
// manifest's block paths are rewritten.
//
// The migration REFUSES (keeps `.git/hooks`, `doctor` keeps warning) whenever
// arming `core.hooksPath` would silently disable something vinaya does not
// own: an adopter's own lines in a hook host, a host at a manifest path with
// no vinaya block, or any other active raw hook in `.git/hooks`. Same
// refuse-if-foreign ethos as init — never trade the adopter's hooks for ours.
// The already-migrated branch carries the SAME arm guard: the manifest saying
// "tracked" records the migrating machine's situation, not this machine's,
// and raw hooks never travel with a clone — so arming here still refuses
// while `foreignRawHooks` is non-empty (reviewer finding, PR #24 round 1).
// ---------------------------------------------------------------------------
type HookStrip = { path: string; marker: string; comment: CommentStyle; present: boolean; removesHost: boolean }

export type HookRouting = {
  /** the hook dir this upgrade's ops regenerate into */
  target: HookDir
  /** legacy `.git/hooks` vinaya blocks to strip once tracked copies exist */
  strips: HookStrip[]
  /** set `core.hooksPath .vinaya/hooks` as part of apply */
  arm: boolean
  /** manifest block paths are rewritten `.git/hooks/` → `.vinaya/hooks/` */
  migratesManifest: boolean
  /** why a wanted migration was refused — printed, and doctor keeps warning */
  blockedReason: string | null
}

function stripFor(repoRoot: string, path: string, marker: string, comment: CommentStyle): HookStrip {
  const abs = resolveManagedBlockPath(repoRoot, path)
  if (!existsSync(abs)) return { path, marker, comment, present: false, removesHost: false }
  const stripped = stripBlockFromContent(readFileSync(abs, 'utf-8'), marker, comment)
  if (stripped === null) return { path, marker, comment, present: false, removesHost: false }
  return { path, marker, comment, present: true, removesHost: blockStripLeavesEmpty(stripped) }
}

export function planHookRouting(
  repoRoot: string,
  manifest: ManagedManifest,
  recorded: HookDir,
  hooksPathValue: string | null
): HookRouting {
  const none: HookRouting = { target: recorded, strips: [], arm: false, migratesManifest: false, blockedReason: null }
  if (recorded === '.husky') return none

  if (recorded === TRACKED_HOOK_DIR) {
    // Already migrated. Two per-machine residues can remain: an unarmed
    // `core.hooksPath` (e.g. a fresh clone, or a machine that merged the
    // migration commit without running it), and stale legacy blocks still
    // sitting in this machine's `.git/hooks` from before the migration.
    const strips = manifest.blocks
      .filter((b) => b.path.startsWith(`${TRACKED_HOOK_DIR}/`))
      .map((b) => stripFor(repoRoot, `.git/hooks/${b.marker}`, b.marker, b.comment))
      .filter((s) => s.present)
    if (hooksPathValue === TRACKED_HOOK_DIR) return { ...none, strips }
    // Arming is subject to the SAME refuse-if-foreign guard as the migration
    // branch below — the manifest saying "tracked" was another machine's
    // situation, not this one's. A teammate whose `.git/hooks` holds their
    // own active hooks (raw hooks never travel with a clone, so the machine
    // that migrated could not see them) must not have them silently disabled
    // by pulling the migration commit and running upgrade. `foreignRawHooks`
    // already excludes vinaya's own stale legacy hosts — the sweep above
    // removes exactly those, so they cannot block the arm they make way for.
    const foreign = foreignRawHooks(repoRoot)
    if (foreign.length > 0) {
      return {
        ...none,
        strips,
        blockedReason:
          `${foreign.map((f) => `.git/hooks/${f}`).join(', ')} ` +
          `${foreign.length === 1 ? 'is an active raw hook' : 'are active raw hooks'} vinaya does not manage, and ` +
          `arming core.hooksPath would silently disable ${foreign.length === 1 ? 'it' : 'them'} — move ` +
          `${foreign.length === 1 ? 'it' : 'them'} into ${TRACKED_HOOK_DIR}/ (and commit) or remove ` +
          `${foreign.length === 1 ? 'it' : 'them'}, then re-run \`vinaya upgrade\``
      }
    }
    return { ...none, strips, arm: true }
  }

  // recorded === '.git/hooks' — attempt the migration.
  const legacy = manifest.blocks.filter((b) => b.path.startsWith('.git/hooks/'))
  const blocked: string[] = []
  for (const b of legacy) {
    const abs = resolveManagedBlockPath(repoRoot, b.path)
    if (!existsSync(abs)) continue // nothing on disk (fresh-clone shape) — nothing arming could disable
    const stripped = stripBlockFromContent(readFileSync(abs, 'utf-8'), b.marker, b.comment)
    if (stripped === null) blocked.push(`${b.path} exists without vinaya's managed block`)
    else if (!blockStripLeavesEmpty(stripped))
      blocked.push(`${b.path} carries your own lines alongside the managed block`)
  }
  const legacyNames = new Set(legacy.map((b) => b.path.slice('.git/hooks/'.length)))
  for (const f of activeRawHooks(repoRoot)) {
    if (!legacyNames.has(f)) blocked.push(`.git/hooks/${f} is an active raw hook vinaya does not manage`)
  }
  if (blocked.length > 0) return { ...none, blockedReason: blocked.join('; ') }

  return {
    target: TRACKED_HOOK_DIR,
    strips: legacy.map((b) => stripFor(repoRoot, b.path, b.marker, b.comment)).filter((s) => s.present),
    arm: hooksPathValue !== TRACKED_HOOK_DIR,
    migratesManifest: true,
    blockedReason: null
  }
}

/** The migrated manifest: block paths rewritten `.git/hooks/` → `.vinaya/hooks/`. */
export function translateHookPaths(manifest: ManagedManifest): ManagedManifest {
  return {
    ...manifest,
    blocks: manifest.blocks.map((b) =>
      b.path.startsWith('.git/hooks/') ? { ...b, path: `${TRACKED_HOOK_DIR}/${b.path.slice('.git/hooks/'.length)}` } : b
    )
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------
type FileAction = 'current' | 'regenerate' | 'recreate' | 'refuse-foreign' | 'not-installed' | 'keep'
type BlockAction = 'current' | 'regenerate-block' | 'recreate-append' | 'recreate-host' | 'not-installed'

type UpgradeEntry =
  | {
      kind: 'create-file'
      op: CreateFileOp
      action: FileAction
      /** set only when a regenerated `.github/workflows/*.yml` file's top-level
       * trigger key is changing — see `extractWorkflowTrigger`. */
      triggerChange?: { from: string; to: string }
    }
  | { kind: 'managed-block'; op: ManagedBlockOp; action: BlockAction }

// ---------------------------------------------------------------------------
// Workflow trigger-type migration detection.
//
// Every generated workflow in this repo emits its trigger the same
// block-style shape: `on:` on its own line, then the trigger key indented
// two spaces on the next line (`  pull_request:`, `  pull_request_target:`,
// `  issue_comment:`, `  push:`). Extracting that key from both the on-disk
// content and the freshly-generated content lets `planUpgrade` notice when a
// regenerated workflow's trigger TYPE is about to change — the exact
// situation that leaves the resulting upgrade PR unable to satisfy its own
// required review-gate check (see `renderUpgradeDiff`'s warning block).
// ---------------------------------------------------------------------------
function extractWorkflowTrigger(content: string): string | null {
  const match = content.match(/^on:\r?\n {2}([A-Za-z0-9_]+):/m)
  return match?.[1] ?? null
}

export type UpgradePlan = {
  entries: UpgradeEntry[]
  routing: HookRouting
  /** null when the manifest is already at the package's current version. */
  versionMigration: { from: number; to: number } | null
  hasChanges: boolean
}

export function planUpgrade(ops: Op[], repoRoot: string, manifest: ManagedManifest, routing: HookRouting): UpgradePlan {
  const entries: UpgradeEntry[] = []
  let hasChanges = routing.arm || routing.migratesManifest || routing.strips.some((s) => s.present)
  const ownedFiles = new Set(manifest.files)
  const blockKey = (path: string, marker: string) => `${path}::${marker}`
  const ownedBlocks = new Set(manifest.blocks.map((b) => blockKey(b.path, b.marker)))

  for (const op of ops) {
    if (op.kind === 'create-file') {
      const abs = join(repoRoot, op.path)
      const exists = existsSync(abs)
      const owned = ownedFiles.has(op.path)
      let action: FileAction
      let triggerChange: { from: string; to: string } | undefined
      if (op.path === CONFIG_PATH || op.path === DOC_OWNERS_PATH) {
        // CONFIG_PATH: semantic content (rings/checks/briefSchema) is
        // adopter-owned; only the `managed` sub-object is regenerated,
        // separately below. DOC_OWNERS_PATH: real bindings are adopter-owned
        // the same way — without this exemption, upgrade would classify any
        // added binding as drift from the pristine empty starter and
        // silently regenerate the file back to empty, destroying it (found
        // live, doctor.ts carries the matching fix).
        action = 'keep'
      } else if (!owned) {
        action = exists ? 'refuse-foreign' : 'not-installed'
      } else if (!exists) {
        action = 'recreate'
        hasChanges = true
      } else {
        const diskContent = readFileSync(abs, 'utf-8')
        if (diskContent !== op.content) {
          action = 'regenerate'
          hasChanges = true
          if (op.path.startsWith('.github/workflows/')) {
            const from = extractWorkflowTrigger(diskContent)
            const to = extractWorkflowTrigger(op.content)
            if (from && to && from !== to) triggerChange = { from, to }
          }
        } else {
          action = 'current'
        }
      }
      entries.push({ kind: 'create-file', op, action, ...(triggerChange ? { triggerChange } : {}) })
    } else if (op.kind === 'managed-block') {
      const abs = resolveManagedBlockPath(repoRoot, op.path)
      const owned = ownedBlocks.has(blockKey(op.path, op.marker))
      let action: BlockAction
      if (!owned) {
        action = 'not-installed'
      } else if (!existsSync(abs)) {
        action = 'recreate-host'
        hasChanges = true
      } else {
        const content = readFileSync(abs, 'utf-8')
        const { begin, end } = markerLines(op.marker, op.comment)
        if (!(content.includes(begin) && content.includes(end))) {
          action = 'recreate-append'
          hasChanges = true
        } else if (!content.includes(renderBlock(op))) {
          action = 'regenerate-block'
          hasChanges = true
        } else {
          action = 'current'
        }
      }
      entries.push({ kind: 'managed-block', op, action })
    }
    // create-label / print ops are outside upgrade's surface: labels are
    // already create-if-absent idempotent, branch protection is print-only.
  }

  const versionMigration =
    manifest.version === MANAGED_MANIFEST_VERSION ? null : { from: manifest.version, to: MANAGED_MANIFEST_VERSION }
  return { entries, routing, versionMigration, hasChanges: hasChanges || versionMigration !== null }
}

// ---------------------------------------------------------------------------
// Diff rendering
// ---------------------------------------------------------------------------
export function renderUpgradeDiff(plan: UpgradePlan): string {
  const lines: string[] = []

  if (plan.versionMigration) {
    lines.push('── Manifest ─────────────────────────────')
    lines.push(`  ~ migrate manifest version ${plan.versionMigration.from} → ${plan.versionMigration.to}`)
    lines.push('')
  }

  const r = plan.routing
  if (r.blockedReason || r.arm || r.migratesManifest || r.strips.length > 0) {
    lines.push('── Hook location ─────────────────────────────')
    if (r.blockedReason) {
      if (r.target === TRACKED_HOOK_DIR) {
        lines.push(`  ✖ NOT armed core.hooksPath left unset — ${r.blockedReason}`)
        lines.push('              (ring 0 stays inert in this working copy; `vinaya doctor` keeps reporting this)')
      } else {
        lines.push(`  · keep      hooks at .git/hooks — migration to ${TRACKED_HOOK_DIR} skipped: ${r.blockedReason}`)
        lines.push(
          '              (git never tracks .git/hooks, so fresh clones have no ring-0 hooks; `vinaya doctor` keeps reporting this)'
        )
      }
    }
    if (r.migratesManifest) {
      lines.push(
        `  ~ migrate   hooks to the tracked ${TRACKED_HOOK_DIR}/ directory (commit them — they travel with the repo)`
      )
    }
    for (const s of r.strips) {
      lines.push(
        `  - strip     vinaya-managed block from ${s.path} (legacy untracked location` +
          `${s.removesHost ? '; vinaya-created host is deleted' : '; your other lines are kept'})`
      )
    }
    if (r.arm) {
      lines.push(
        `  ~ arm       git config core.hooksPath ${TRACKED_HOOK_DIR} (shared config — this clone and all its linked worktrees)`
      )
    }
    lines.push('')
  }

  for (const e of plan.entries) {
    if (e.kind === 'create-file') {
      switch (e.action) {
        case 'regenerate':
          lines.push(`  ~ regenerate ${e.op.path}`)
          lines.push(indent(e.op.content))
          if (e.triggerChange) {
            lines.push('')
            lines.push(
              `  ⚠ TRIGGER CHANGE: ${e.op.path} is moving from \`${e.triggerChange.from}\` to ` +
                `\`${e.triggerChange.to}\`.`
            )
            lines.push(
              "     GitHub evaluates a `pull_request` trigger from the pull request branch's own copy of the " +
                'workflow file, but a `pull_request_target` trigger from the copy on the BASE branch — never ' +
                "the pull request branch's. The pull request that carries this exact change matches NEITHER: " +
                'as `pull_request` it no longer matches (the pull request branch now declares ' +
                '`pull_request_target`), and as `pull_request_target` the base branch still declares the old ' +
                'trigger until this pull request merges. No workflow run fires under either event, so this ' +
                "file's required check-run never appears for this pull request — not failing, not pending, " +
                'simply absent — and a ruleset or branch-protection rule that requires it will block this pull ' +
                'request from merging through the normal flow.'
            )
            lines.push(
              '     To get this pull request merged: temporarily add a ruleset bypass actor (or, under classic ' +
                'branch protection, a temporary admin override) for the merge, then remove it once this pull ' +
                'request is in.'
            )
          }
          break
        case 'recreate':
          lines.push(`  + recreate   ${e.op.path} (recorded as owned but missing on disk)`)
          lines.push(indent(e.op.content))
          break
        case 'current':
          lines.push(`  = current    ${e.op.path}`)
          break
        case 'keep':
          lines.push(`  = keep       ${e.op.path} (adopter-owned content; only the ownership manifest is regenerated)`)
          break
        case 'refuse-foreign':
          lines.push(`  ✖ REFUSE    ${e.op.path} — foreign content at a vinaya path not owned by vinaya; not touched`)
          break
        case 'not-installed':
          lines.push(`  · skip      ${e.op.path} (not installed — that's \`vinaya init\`'s job, not upgrade's)`)
          break
      }
    } else {
      switch (e.action) {
        case 'regenerate-block':
          lines.push(`  ~ regenerate managed block in ${e.op.path}`)
          lines.push(indent(renderBlock(e.op)))
          break
        case 'recreate-append':
          lines.push(`  + restore    managed block in ${e.op.path} (your other lines untouched)`)
          lines.push(indent(renderBlock(e.op)))
          break
        case 'recreate-host':
          lines.push(`  + recreate   ${e.op.path} (recorded as owned but missing on disk — e.g. a fresh clone)`)
          lines.push(indent(`${e.op.hostPreamble ?? ''}${renderBlock(e.op)}`))
          break
        case 'current':
          lines.push(`  = current    ${e.op.path}`)
          break
        case 'not-installed':
          lines.push(`  · skip      ${e.op.path} (not installed — that's \`vinaya init\`'s job, not upgrade's)`)
          break
      }
    }
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------
function regenerateBlock(repoRoot: string, op: ManagedBlockOp): void {
  const abs = resolveManagedBlockPath(repoRoot, op.path)
  const content = readFileSync(abs, 'utf-8')
  const stripped = stripBlockFromContent(content, op.marker, op.comment)
  if (stripped !== null) {
    writeFileSync(abs, stripped.endsWith('\n') ? stripped : `${stripped}\n`, 'utf-8')
  }
  appendBlock(repoRoot, op)
}

export function applyUpgrade(plan: UpgradePlan, repoRoot: string): void {
  for (const e of plan.entries) {
    if (e.kind === 'create-file') {
      if (e.action === 'regenerate' || e.action === 'recreate') {
        writeFileWithDirs(join(repoRoot, e.op.path), e.op.content, e.op.mode)
      }
    } else {
      if (e.action === 'recreate-host') createHost(repoRoot, e.op)
      else if (e.action === 'recreate-append') appendBlock(repoRoot, e.op)
      else if (e.action === 'regenerate-block') regenerateBlock(repoRoot, e.op)
    }
  }

  // Legacy `.git/hooks` strips run AFTER the tracked copies above are on
  // disk, so there is no instant with neither location holding the hooks.
  // Resolved through `resolveManagedBlockPath` (linked-worktree `.git` is a
  // gitdir-pointer file, not a directory) like every other hook touch here.
  for (const s of plan.routing.strips) {
    if (!s.present) continue
    const abs = resolveManagedBlockPath(repoRoot, s.path)
    if (!existsSync(abs)) continue
    const stripped = stripBlockFromContent(readFileSync(abs, 'utf-8'), s.marker, s.comment)
    if (stripped === null) continue
    if (blockStripLeavesEmpty(stripped)) rmSync(abs, { force: true })
    else writeFileSync(abs, stripped.endsWith('\n') ? stripped : `${stripped}\n`, 'utf-8')
  }
}

// ---------------------------------------------------------------------------
// vinaya upgrade
// ---------------------------------------------------------------------------
export async function runUpgrade(args: string[], deps: UpgradeDeps): Promise<number> {
  const { dryRun, yes } = flags(args)

  const repo = await deps.detectRepo()
  if (!repo) {
    console.error('Error: not a git repository. Run `vinaya upgrade` from inside your repo.')
    return 1
  }

  const read = readManifest(repo.repoRoot)
  if (read.kind === 'missing' || read.kind === 'not-initialized') {
    console.error('Error: vinaya is not initialized in this repo. Run `vinaya init` first.')
    return 1
  }
  if (read.kind === 'invalid') {
    console.error(`Error: vinaya.config.json is invalid — ${read.error}`)
    console.error('Fix it before upgrading (upgrade never guesses at a corrupt manifest).')
    return 1
  }

  const { manifest } = read
  if (manifest.version > MANAGED_MANIFEST_VERSION) {
    console.error(
      `Error: this repo's vinaya manifest is version ${manifest.version}, newer than the installed vinaya ` +
        `package understands (version ${MANAGED_MANIFEST_VERSION}). Upgrade the vinaya package itself first, ` +
        'then re-run `vinaya upgrade`.'
    )
    return 1
  }

  const recorded = hookDirFromManifest(manifest, deps.hookDirFor(repo.repoRoot))
  const routing = planHookRouting(repo.repoRoot, manifest, recorded, await deps.readHooksPath(repo.repoRoot))
  // Plan (and later persist) against the MIGRATED manifest when hooks move:
  // ownership is keyed by path, so the tracked-path ops only classify as
  // owned once the recorded `.git/hooks/*` paths are rewritten.
  const planManifest = routing.migratesManifest ? translateHookPaths(manifest) : manifest
  const ctx: InitContext = {
    owner: repo.owner,
    repo: repo.repo,
    hookDir: routing.target,
    selfHost: detectVendoredVinaya(repo.repoRoot),
    ciSetup: readRepoCiSetup(repo.repoRoot)
  }
  const ops = buildInitOps(ctx)
  const plan = planUpgrade(ops, repo.repoRoot, planManifest, routing)

  if (!plan.hasChanges) {
    // A refused hook migration is not a "change", but silence here would
    // leave the adopter stuck on the untracked layout with no explanation —
    // say why, every run, until the blocker is resolved.
    if (routing.blockedReason) {
      process.stdout.write(
        routing.target === TRACKED_HOOK_DIR
          ? `Note: core.hooksPath NOT armed — ${routing.blockedReason}.\n` +
              '(ring 0 stays inert in this working copy; `vinaya doctor` keeps reporting this.)\n'
          : `Note: hooks stay at .git/hooks — migration to ${TRACKED_HOOK_DIR} skipped: ${routing.blockedReason}.\n` +
              '(git never tracks .git/hooks, so fresh clones have no ring-0 hooks; `vinaya doctor` keeps reporting this.)\n'
      )
    }
    process.stdout.write('vinaya upgrade — already current. Nothing to do.\n')
    return 0
  }

  process.stdout.write('vinaya upgrade — the full diff of every intended change:\n\n')
  process.stdout.write(`${renderUpgradeDiff(plan)}\n`)

  if (dryRun) {
    process.stdout.write('\n--dry-run: nothing was written.\n')
    return 0
  }

  if (!yes) {
    const ok = await deps.confirm('Regenerate these vinaya-owned artifacts?')
    if (!ok) {
      process.stdout.write('Aborted. Nothing was written.\n')
      return 0
    }
  }

  applyUpgrade(plan, repo.repoRoot)
  // Arm AFTER the tracked hooks are on disk — never route git at nothing.
  if (routing.arm) await deps.setHooksPath(repo.repoRoot, TRACKED_HOOK_DIR)
  writeManifestVersion(repo.repoRoot, planManifest)

  process.stdout.write('\nVinaya upgraded.\n')
  return 0
}

export async function upgradeCommand(args: string[]): Promise<void> {
  process.exit(await runUpgrade(args, realDeps()))
}
