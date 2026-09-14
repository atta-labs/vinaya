// `vinaya doctor` — diagnose the full installation. Reads the records `init`
// wrote (see lib/artifacts.ts, lib/ops.ts) and reports drift against them.
//
// Contract: doctor NEVER mutates. Every code path in this file is
// read-only — no fs write, no `gh` write, no forge mutation. It exists
// precisely because a doctor that "fixes" silently destroys the support
// story; `vinaya upgrade` is the only sanctioned path back to a clean state.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { CheckSpec } from '../checks/contract.js'
import { coreCheckRegistry } from '../checks/registry.js'
import { bareKeyRejectedDiagnostic, overriddenReplacesCoreDiagnostic, resolveChecks } from '../checks/resolver.js'
import {
  classifyDocOwnersManifest,
  deriveBuiltinCrossCuttingDefaults,
  deriveWorkspacePackageDomains,
  DOC_OWNERS_PATH,
  globToRegex,
  hardenedMeteringDeps,
  isCodeFile,
  isUrlPointer,
  type MeteringCapability,
  parseDocOwners,
  parsePnpmWorkspaceYaml,
  parseRegistry,
  pointerToPath,
  resolveMeteringCapability
} from '@attalabs/aeg-core'
import {
  buildInitOps,
  CHECKS_FOLDER_PLACEHOLDER_PATH,
  CONFIG_PATH,
  DOCTRINE_POINTER_PATH,
  type HookDir,
  type InitContext,
  ROLES_FOLDER_PLACEHOLDER_PATH,
  starterConfig,
  TRACKED_HOOK_DIR
} from '../lib/artifacts.js'
import { CLAUDE_COMMAND_PATH } from '../lib/claude-command-emitter.js'
import { CLAUDE_SETTINGS_PATH } from '../lib/claude-stop-hook-emitter.js'
import { GEMINI_COMMAND_PATH } from '../lib/gemini-command-emitter.js'
import { type DoctrineSource, resolveDoctrineRootInfo } from './doctrine.js'
import { detectVendoredVinaya } from '../lib/self-host.js'
import {
  type BriefSection,
  GLOBAL_CONFIG_PATH,
  globalChecksIgnoredWarning,
  isDefaultedAgentVendorPath,
  type ManagedManifest,
  readRepoCiSetup,
  resolveAgentVendors,
  type VinayaConfig,
  VinayaConfigSchema,
  lintEnvDeclarations
} from '../lib/config.js'
import {
  branchProtectionConfigured,
  type BranchProtectionState,
  detectGitRepo,
  ghAuthStatus,
  type GhAuthStatus,
  foreignRawHooks,
  hookDirFromManifest,
  readCoreHooksPath,
  type RepoInfo,
  resolveHookDir
} from '../lib/detect.js'
import { printJson } from '../lib/envelope.js'
import { checksMissingEnvDeclaration, envDeclarationWarning } from '../lib/env-lint.js'
import { PROJECTS_REGISTRY_PATH } from '../lib/registry-write.js'
import { markerLines, renderBlock, resolveManagedBlockPath } from '../lib/ops.js'
import { packageRoot } from '../lib/package-root.js'

export type DoctorDeps = {
  detectRepo: () => Promise<RepoInfo | null>
  ghAuthStatus: () => Promise<GhAuthStatus>
  branchProtectionConfigured: (owner: string, repo: string) => Promise<BranchProtectionState>
  hookDirFor: (repoRoot: string) => HookDir
  readHooksPath: (repoRoot: string) => Promise<string | null>
  nodeVersion: () => string
  bunVersion: () => string | null
  packageVersion: () => string
  meteringCapability: () => MeteringCapability
}

function readVersion(): string {
  const pkg = JSON.parse(readFileSync(join(packageRoot(import.meta.url), 'package.json'), 'utf-8'))
  return pkg.version
}

/** Exported so `#313`'s per-call-site hardening proof can invoke this exact wiring, not a reimplementation of it. */
export function realDeps(): DoctorDeps {
  return {
    detectRepo: detectGitRepo,
    ghAuthStatus,
    branchProtectionConfigured,
    hookDirFor: resolveHookDir,
    readHooksPath: readCoreHooksPath,
    nodeVersion: () => process.version,
    bunVersion: () => (typeof Bun === 'undefined' ? null : Bun.version),
    packageVersion: readVersion,
    meteringCapability: () => resolveMeteringCapability(hardenedMeteringDeps())
  }
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------
export type Severity = 'ok' | 'info' | 'warn' | 'error'
export type Finding = { check: string; severity: Severity; message: string }

const ok = (check: string, message: string): Finding => ({ check, severity: 'ok', message })
const info = (check: string, message: string): Finding => ({ check, severity: 'info', message })
const warn = (check: string, message: string): Finding => ({ check, severity: 'warn', message })
const error = (check: string, message: string): Finding => ({ check, severity: 'error', message })

// ---------------------------------------------------------------------------
// vinaya.config.json — read without the cwd-walking loadConfig(), same reason
// init.ts/eject.ts avoid it: doctor must diagnose <repoRoot>'s own file, never
// an ancestor repo's config.
// ---------------------------------------------------------------------------
type ConfigRead = { kind: 'missing' } | { kind: 'invalid'; error: string } | { kind: 'ok'; config: VinayaConfig }

function readConfig(repoRoot: string): ConfigRead {
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
  return { kind: 'ok', config: parsed.data }
}

function labelForPath(path: string): string {
  if (path === CONFIG_PATH) return 'config'
  if (path === DOCTRINE_POINTER_PATH) return 'doctrine-pointer'
  if (path.startsWith('.agents/skills/')) return 'agent-skills'
  if (path === CLAUDE_COMMAND_PATH) return 'claude-command'
  if (path === CLAUDE_SETTINGS_PATH) return 'claude-stop-hook'
  if (path === GEMINI_COMMAND_PATH) return 'gemini-command'
  if (path === CHECKS_FOLDER_PLACEHOLDER_PATH || path === ROLES_FOLDER_PLACEHOLDER_PATH) return 'scaffold-folders'
  return 'workflows'
}

// ---------------------------------------------------------------------------
// Checks 1/2/3/4 — hooks, workflows, config, VINAYA.md — one pass over the
// SAME op list `vinaya init` builds (lib/artifacts.ts), classified against
// disk + the manifest instead of applied.
// ---------------------------------------------------------------------------
function diagnoseInstall(
  repoRoot: string,
  ctx: InitContext,
  manifest: ManagedManifest
): { findings: Finding[]; hasDrift: boolean } {
  const findings: Finding[] = []
  let hasDrift = false
  const ownedFiles = new Set(manifest.files)
  const blockKey = (path: string, marker: string) => `${path}::${marker}`
  const ownedBlocks = new Set(manifest.blocks.map((b) => blockKey(b.path, b.marker)))

  for (const op of buildInitOps(ctx)) {
    if (op.kind === 'create-file') {
      const check = labelForPath(op.path)
      const abs = join(repoRoot, op.path)
      const exists = existsSync(abs)
      const owned = ownedFiles.has(op.path) || isDefaultedAgentVendorPath(op.path, manifest)

      if (!exists) {
        findings.push(
          owned
            ? error(check, `${op.path} is recorded as vinaya-managed but missing on disk — run \`vinaya upgrade\`.`)
            : error(check, `${op.path} is not installed — run \`vinaya init\`.`)
        )
        continue
      }

      const content = readFileSync(abs, 'utf-8')
      if (!owned) {
        findings.push(
          content === op.content
            ? warn(check, `${op.path} has vinaya's own content but isn't recorded in the manifest.`)
            : info(check, `${op.path} exists but is foreign content — not vinaya-managed, left untouched.`)
        )
        continue
      }

      if (op.path === CONFIG_PATH || op.path === DOC_OWNERS_PATH) {
        // vinaya.config.json's semantic content (rings/checks/briefSchema)
        // and .vinaya/doc-owners' bindings are BOTH adopter-owned from day
        // one — doctor never diffs either byte-for-byte. Found live: without
        // this exemption, any real binding added after install reads as
        // "drift" from the pristine empty starter, and doctor's own warning
        // recommends `vinaya upgrade` — which (before this fix) would
        // silently regenerate the file back to empty, destroying the
        // binding. Same fix shape, same reasoning, as CONFIG_PATH.
        findings.push(ok(check, `${op.path} present and vinaya-managed.`))
        continue
      }

      if (content === op.content) {
        findings.push(ok(check, `${op.path} matches the installed package's generated content.`))
      } else {
        hasDrift = true
        findings.push(
          warn(check, `${op.path} has drifted from the installed package's generated content — run \`vinaya upgrade\`.`)
        )
      }
    } else if (op.kind === 'managed-block') {
      const check = 'hooks'
      const abs = resolveManagedBlockPath(repoRoot, op.path)
      const owned = ownedBlocks.has(blockKey(op.path, op.marker))

      if (!existsSync(abs)) {
        findings.push(
          owned
            ? error(
                check,
                `${op.path} is missing — likely a fresh clone (raw git hooks aren't tracked by git). Run \`vinaya upgrade\` to restore it.`
              )
            : info(check, `${op.path} is not installed.`)
        )
        continue
      }

      const content = readFileSync(abs, 'utf-8')
      const { begin, end } = markerLines(op.marker, op.comment)
      const hasMarkers = content.includes(begin) && content.includes(end)

      if (!hasMarkers) {
        findings.push(
          owned
            ? error(check, `${op.path}'s vinaya-managed block is missing or corrupted — run \`vinaya upgrade\`.`)
            : info(check, `${op.path} exists with no vinaya-managed block.`)
        )
        continue
      }

      if (!owned) {
        findings.push(warn(check, `${op.path} has a vinaya-managed block that isn't recorded in the manifest.`))
      } else if (content.includes(renderBlock(op))) {
        findings.push(ok(check, `${op.path}'s managed block matches the installed package's generator.`))
      } else {
        hasDrift = true
        findings.push(
          warn(
            check,
            `${op.path}'s managed block has drifted from the installed package's generator — run \`vinaya upgrade\`.`
          )
        )
      }

      if (op.mode !== undefined && (statSync(abs).mode & 0o111) === 0) {
        findings.push(error(check, `${op.path} is not executable.`))
      }
    }
  }

  return { findings, hasDrift }
}

// ---------------------------------------------------------------------------
// Hook routing — does ring 0 actually FIRE in this working copy?
// `diagnoseInstall` above answers "are the hook files present and current";
// this answers the orthogonal question of whether git is wired to run them.
// A tracked-hooks install is exactly where the two diverge: the files survive
// every clone (they are committed), but `core.hooksPath` is per-clone git
// config that git cannot version — a fresh clone has current hook files and
// zero enforcement until the one arming command is run. Legacy `.git/hooks`
// installs get the inverse warning: wired here, absent everywhere else.
// ---------------------------------------------------------------------------
async function diagnoseHookRouting(
  repoRoot: string,
  hookDir: HookDir,
  readHooksPath: (repoRoot: string) => Promise<string | null>
): Promise<Finding[]> {
  if (hookDir === TRACKED_HOOK_DIR) {
    const value = await readHooksPath(repoRoot)
    if (value === TRACKED_HOOK_DIR) {
      return [ok('hooks', `core.hooksPath routes git at the tracked ${TRACKED_HOOK_DIR} directory — ring 0 is armed.`)]
    }
    // Never hand the user an arming command that would silently disable
    // their own hooks: arming makes git ignore `.git/hooks` entirely, and
    // this machine may hold active raw hooks the migrating machine could not
    // see (raw hooks never travel with a clone). Same `foreignRawHooks` list
    // `upgrade`'s arm guard refuses on, so the two surfaces cannot disagree.
    const foreign = foreignRawHooks(repoRoot)
    if (foreign.length > 0) {
      return [
        error(
          'hooks',
          `ring 0 is INERT in this working copy — hooks are tracked at ${TRACKED_HOOK_DIR} but core.hooksPath is ` +
            `${value ? `set to '${value}'` : 'not set'}, AND arming it would silently disable ` +
            `${foreign.map((f) => `.git/hooks/${f}`).join(', ')} (active raw hook${foreign.length === 1 ? '' : 's'} ` +
            'vinaya does not manage — git runs ONLY the core.hooksPath directory once it is set). Move ' +
            `${foreign.length === 1 ? 'it' : 'them'} into ${TRACKED_HOOK_DIR}/ (and commit) or remove ` +
            `${foreign.length === 1 ? 'it' : 'them'} first, then run \`git config core.hooksPath ${TRACKED_HOOK_DIR}\`.`
        )
      ]
    }
    return [
      error(
        'hooks',
        `ring 0 is INERT in this working copy — hooks are tracked at ${TRACKED_HOOK_DIR} but core.hooksPath is ` +
          `${value ? `set to '${value}'` : 'not set'} (git config is never cloned). ` +
          `Run \`git config core.hooksPath ${TRACKED_HOOK_DIR}\` once per clone (or \`vinaya upgrade\`) to arm them.`
      )
    ]
  }
  if (hookDir === '.git/hooks') {
    return [
      warn(
        'hooks',
        `this repo's ring 0 is installed at .git/hooks, which git does not track — teammates, fresh clones ` +
          'and their worktrees have no hooks until they run `vinaya init` or `vinaya upgrade`. ' +
          `Run \`vinaya upgrade\` to migrate hooks to the tracked ${TRACKED_HOOK_DIR} directory.`
      )
    ]
  }
  // `.husky` — the adopter's own hook manager owns per-clone wiring (its
  // `prepare` script); vinaya has nothing to diagnose beyond file presence.
  return []
}

// ---------------------------------------------------------------------------
// Check 7 — custom checks: every `checks` entry's `run` path exists.
// Registration shape itself is already enforced by the schema parse that
// produced `config` (loud failure surfaces at the top level, see runDoctor).
// ---------------------------------------------------------------------------
function diagnoseCustomChecks(repoRoot: string, config: VinayaConfig): Finding[] {
  const findings: Finding[] = []
  for (const [name, entry] of Object.entries(config.checks ?? {})) {
    const scriptAbs = join(repoRoot, entry.run)
    findings.push(
      existsSync(scriptAbs)
        ? ok('checks', `custom check '${name}' → ${entry.run}`)
        : error('checks', `custom check '${name}' points at a missing script: ${entry.run}`)
    )
  }
  return findings
}

// ---------------------------------------------------------------------------
// doc-owners health — repo-wide, not diff-scoped. C5 (`evaluateC5`,
// packages/aeg-core/src/doc-owners.ts:234) only ever tests a binding's glob
// against the CURRENT PR'S changed files; a binding whose glob matches zero
// files ANYWHERE in the repo (the code it names was deleted or renamed
// wholesale) never fires on any diff, ever again, and is structurally
// indistinguishable to C5 from a healthy binding nothing happened to touch.
// This walks every tracked file once per `doctor` run instead, so a dead
// binding surfaces even though no diff would ever trigger it. Mirrors the
// dangling-pointer check `evaluateC5` already does (lines 278-284), but
// unconditionally — not gated on the glob having fired first.
//
// Scope, precisely: this answers ONLY "does this glob match anything that
// exists right now" against a single repo snapshot. It does NOT reason about
// diff history or which globs are technically alive but practically never
// touched by a typical PR — that is a different, harder question this
// diagnostic deliberately does not attempt.
// ---------------------------------------------------------------------------
function listTrackedFiles(repoRoot: string): string[] {
  try {
    return execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf-8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function diagnoseDocOwnersHealth(repoRoot: string): Finding[] {
  const path = join(repoRoot, DOC_OWNERS_PATH)
  const content = existsSync(path) ? readFileSync(path, 'utf-8') : null
  const state = classifyDocOwnersManifest(content)
  if (state === 'absent' || state === 'empty') return []

  // `parseDocOwners`'s own malformed-line `errors` are C5's job on the
  // `vinaya check`/`vinaya pr report` path today — surfacing a second copy
  // here would be scope creep this diagnostic doesn't take on.
  const { bindings } = parseDocOwners(content as string)
  if (bindings.length === 0) return []

  // `isCodeFile` is load-bearing here, not optional: `evaluateC5` only ever
  // tests a binding's glob against `changed.filter(isCodeFile)`, so a binding
  // whose glob matches only non-code files is exactly as unfireable, from
  // C5's point of view, as one matching nothing at all. Skipping this filter
  // would report "healthy" on a binding just as dead as the one Issue #77
  // measured.
  const codeFiles = listTrackedFiles(repoRoot).filter(isCodeFile)

  const findings: Finding[] = []
  for (const b of bindings) {
    let flagged = false

    const re = globToRegex(b.glob)
    if (!codeFiles.some((f) => re.test(f))) {
      flagged = true
      findings.push(
        warn(
          'doc-owners',
          `${DOC_OWNERS_PATH}:${b.lineNum} binds glob '${b.glob}', which matches none of the ${codeFiles.length} ` +
            'tracked code file(s) in this repo — the code it names may have been deleted, renamed, or never ' +
            "existed. Repoint the binding to the code's new location, or remove it."
        )
      )
    }

    // Independent of the glob-match check above — a binding can be flagged
    // for either reason, both, or neither.
    if (!isUrlPointer(b.pointer)) {
      const pointerPath = join(repoRoot, pointerToPath(b.pointer))
      if (!existsSync(pointerPath)) {
        flagged = true
        findings.push(
          warn(
            'doc-owners',
            `${DOC_OWNERS_PATH}:${b.lineNum} points to ${b.pointer}, which does not exist on disk. Repoint the ` +
              'binding, or add the missing doc.'
          )
        )
      }
    }

    if (!flagged) {
      findings.push(ok('doc-owners', `${DOC_OWNERS_PATH}:${b.lineNum} — '${b.glob}' → ${b.pointer} is live.`))
    }
  }

  return findings
}

// ---------------------------------------------------------------------------
// blast-radius diagnostic — permanent, unconditioned on install state:
// `checkBlastRadiusScope` (`@attalabs/aeg-core`'s `issue-validation.ts`, run
// from `packages/aeg-core/bin/open-issue.ts`) now derives its `packages/*`
// collision domains live from `package.json` `workspaces` and ships a
// built-in cross-cutting default set (lockfile/monorepo-config/CI/git-hooks
// presence-checks) — see `blast-radius-domains.ts`. The legacy static
// `.aeg/packages` file is additive, not required, and this diagnostic is what
// tells an adopter that: an absent file gets an `info` confirming the check
// is live and not dormant; a present file gets a `warn` naming it deprecated
// and listing exactly which of its entries (if any) aren't already covered by
// derivation + defaults + `vinaya.config.json`'s `blastRadius.extraDomains` —
// the adopter's migration checklist before deleting it.
// ---------------------------------------------------------------------------
const LEGACY_AEG_PACKAGES_PATH = '.aeg/packages'

/**
 * Same shape as `open-issue.ts`'s `readWorkspaces` — repeated here rather
 * than shared because doctor's repoRoot is a diagnosed target, not
 * `aeg-core`'s own checkout. Reads BOTH `package.json`'s `workspaces` array
 * and `pnpm-workspace.yaml`'s `packages:` list: pnpm does not honor a
 * `workspaces` key in `package.json` at all, so a pnpm adopter's real
 * workspace glob lives only in the YAML file.
 */
function readWorkspacesForDoctor(repoRoot: string): string[] {
  const fromPackageJson = (): string[] => {
    try {
      const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as { workspaces?: unknown }
      return Array.isArray(pkg.workspaces) ? pkg.workspaces.filter((w): w is string => typeof w === 'string') : []
    } catch {
      return []
    }
  }
  const fromPnpmWorkspaceYaml = (): string[] => {
    try {
      return parsePnpmWorkspaceYaml(readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf-8'))
    } catch {
      return []
    }
  }
  return [...fromPackageJson(), ...fromPnpmWorkspaceYaml()]
}

function listChildDirsForDoctor(dir: string, repoRoot: string): string[] {
  try {
    return readdirSync(join(repoRoot, dir), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

function diagnoseBlastRadiusDeprecation(repoRoot: string, config: VinayaConfig | null): Finding[] {
  const derived = deriveWorkspacePackageDomains(readWorkspacesForDoctor(repoRoot), (dir) =>
    listChildDirsForDoctor(dir, repoRoot)
  )
  const defaults = deriveBuiltinCrossCuttingDefaults((p) => existsSync(join(repoRoot, p)))
  const covered = new Set([...derived, ...defaults])
  const configExtra = new Set(config?.blastRadius?.extraDomains ?? [])

  const legacyPath = join(repoRoot, LEGACY_AEG_PACKAGES_PATH)
  if (!existsSync(legacyPath)) {
    return [
      info(
        'blast-radius',
        `checkBlastRadiusScope is active via live derivation (${derived.length} packages/* domain(s)) + built-in defaults (${defaults.length} present) — no ${LEGACY_AEG_PACKAGES_PATH}, and the check is not dormant.`
      )
    ]
  }

  const legacyEntries = readFileSync(legacyPath, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
  const uncovered = legacyEntries.filter((e) => !covered.has(e) && !configExtra.has(e))

  const migrationNote =
    uncovered.length === 0
      ? 'every entry is already covered by live derivation, the built-in defaults, or vinaya.config.json blastRadius.extraDomains — the file can be deleted.'
      : `migrate ${uncovered.length} entr${uncovered.length === 1 ? 'y' : 'ies'} not yet covered before deleting it: ${uncovered.join(', ')}.`

  return [
    warn(
      'blast-radius',
      `${LEGACY_AEG_PACKAGES_PATH} is deprecated — checkBlastRadiusScope now derives packages/* domains live and ships built-in cross-cutting defaults. Declare anything beyond those in vinaya.config.json's blastRadius.extraDomains instead. ${migrationNote}`
    )
  ]
}

// ---------------------------------------------------------------------------
// brief-schema divergence — REPORT, never mutate (#70).
//
// `briefSchema` is adopter-owned, so `upgrade` correctly never rewrites it.
// Before this diagnostic, nothing else looked at it either, and the two
// facts got conflated: ownership means vinaya must not OVERWRITE the key, not
// that vinaya cannot REPORT on it. A builtin deleted to work around a vinaya
// defect therefore stayed deleted and stayed invisible — no command surfaced
// it, no later upgrade repaired it. Found live on `siot-david-marino/poc-executor`,
// where `closesN` was dropped to get an upgrade PR open at all, merged in that
// state, and left `closes-n` silently unenforced on every task branch.
//
// `info` severity, deliberately: an adopter running without a builtin is
// exercising legitimate configuration and must not be failed into a shape they
// rejected. The goal is to make the divergence visible once, not to restore the
// default. `briefSchema.ack` is how a considered choice goes quiet while an
// accidental one keeps surfacing.
//
// Only ABSENCE relative to `starterConfig()` is reported. Extra sections — a
// second builtin, or an adopter's own heading/field/phrase matcher — are
// additions, not weakenings, and naming them would be exactly the nagging this
// is built to avoid. Custom matcher forms are ignored entirely: they carry no
// `builtin` key, so they can neither satisfy nor contradict a shipped default.
// ---------------------------------------------------------------------------
const BRIEF_KIND_LABEL: Record<'pr' | 'issue', string> = {
  pr: 'PR bodies',
  issue: 'task Issue bodies'
}

/** The `builtin` names in a section list, in declaration order. Non-builtin matcher forms yield nothing. */
function builtinsIn(sections: BriefSection[] | undefined): string[] {
  return (sections ?? []).flatMap((s) => ('builtin' in s ? [s.builtin] : []))
}

export function diagnoseBriefSchemaDrift(config: VinayaConfig | null): Finding[] {
  // A missing/invalid config is already an `error` finding from the caller;
  // re-reporting every builtin as absent there would bury it in noise.
  if (!config) return []

  const shipped = starterConfig().briefSchema
  const acked = new Set<string>(config.briefSchema?.ack ?? [])
  const findings: Finding[] = []

  for (const kind of ['pr', 'issue'] as const) {
    const expected = builtinsIn(shipped?.[kind]?.sections)
    if (expected.length === 0) continue

    // `undefined` sections and `[]` sections are the same weakening here —
    // an absent `briefSchema.pr` block means `forge-write.ts` validates a PR
    // body against an empty section set, which is the gate being off, not the
    // gate being adopter-shaped. Both paths land on the same missing list.
    const present = new Set(builtinsIn(config.briefSchema?.[kind]?.sections))
    const missing = expected.filter((b) => !present.has(b) && !acked.has(b))
    if (missing.length === 0) continue

    findings.push(
      info(
        'brief-schema',
        `briefSchema.${kind} is missing ${missing.length} builtin${missing.length === 1 ? '' : 's'} the shipped default declares for ${BRIEF_KIND_LABEL[kind]}: ${missing.join(', ')}. ` +
          'This is adopter-owned config — `vinaya upgrade` will never restore it, and nothing else reports it. ' +
          'If the omission is deliberate, list those names in `briefSchema.ack` to silence this; if it was a workaround for a vinaya defect, check whether that defect is fixed and the builtin can come back.'
      )
    )
  }

  return findings
}

// ---------------------------------------------------------------------------
// env-loss diagnostics — permanent (not warn-phase-only like `vinaya
// check`'s equivalent print): a check reading `process.env`/`Bun.env`/
// `Deno.env` directly with no `env` declaration, across BOTH the core
// registry and this repo's own `vinaya.config.json` custom checks. Shares
// the exact same grep heuristic `vinaya check` uses (`lib/env-lint.ts`) so
// the two surfaces can't drift apart. `info` severity — this never fails
// `vinaya doctor`'s exit code, matching the "not a wall of noise" scope:
// the heuristic only fires on checks that genuinely have no declaration,
// which core checks won't after task 2's audit.
// ---------------------------------------------------------------------------
function diagnoseEnvDeclarations(repoRoot: string, config: VinayaConfig | null): Finding[] {
  // The RESOLVED set, not the pre-flip `[...core, ...custom]` concat: after
  // the execution flip an overriding entry's core counterpart never runs, so
  // linting it would diagnose a spec that cannot execute (review finding,
  // PR #120). Paths are re-rooted for config-sourced specs only — a core
  // spec's `run` is already absolute.
  const resolved = resolveChecks(coreCheckRegistry(), config?.checks).resolved
  const specs: CheckSpec[] = resolved.map((entry) =>
    entry.source === 'config' ? { ...entry.spec, run: join(repoRoot, entry.spec.run) } : entry.spec
  )
  const missing = checksMissingEnvDeclaration(specs)
  const findings = missing.map((name) => info('env', envDeclarationWarning(name)))

  // Load-time lint over literal-string `env` forms (a stray `"true"`/
  // `"false"`, a high-entropy literal that reads like a leaked secret) —
  // `warn`, not `info`: unlike the missing-declaration case above, this
  // flags a declaration that IS present but looks like a mistake.
  for (const message of lintEnvDeclarations(config?.checks)) {
    findings.push(warn('env', message))
  }

  return findings
}

// ---------------------------------------------------------------------------
// checks-classification diagnostics — the resolver's own two classes: an
// `overridden` core ID (the config entry REPLACES the core check) and a
// bare, un-namespaced key matching no core ID (REJECTED — `vinaya check`
// refuses the whole run).
//
// These began as `vinaya check`'s grace-period warnings ahead of the
// execution flip. The flip removed them from check output — where a refused
// run now prints a refusal instead — and they live on HERE, permanently.
// That persistence is load-bearing, not vestigial: a rejected config runs
// nothing, so this is the only surface left that explains why, and the
// bare-key class is `error` rather than `warn` because it is now fatal to
// every `vinaya check` invocation. Reuses the resolver's own message
// strings (`checks/resolver.js`) so the diagnostic can never describe a
// classification the resolver no longer makes — the same discipline the env
// diagnostic keeps between this file and `check.ts` via `lib/env-lint.ts`.
// ---------------------------------------------------------------------------
function diagnoseCheckClassification(config: VinayaConfig | null): Finding[] {
  const classification = resolveChecks(coreCheckRegistry(), config?.checks)
  const findings: Finding[] = []
  for (const entry of classification.resolved) {
    if (entry.state === 'overridden') findings.push(warn('checks', overriddenReplacesCoreDiagnostic(entry.name)))
  }
  for (const failure of classification.failures) {
    findings.push(error('checks', bareKeyRejectedDiagnostic(failure.key)))
  }
  return findings
}

// `readConfig(repoRoot)` above reads `<repoRoot>/vinaya.config.json` directly
// and never touches the global path, so doctor cannot observe "the global
// config declared `checks`" from its own config read. Read
// `GLOBAL_CONFIG_PATH` separately here — a parse failure is `info`, not
// `error`: doctor is diagnosing the LOCAL repo, and a broken global file is
// a softer signal than a broken local one.
function diagnoseGlobalConfigChecks(): Finding[] {
  if (!existsSync(GLOBAL_CONFIG_PATH)) return []
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, 'utf-8'))
  } catch (err) {
    return [info('checks', `${GLOBAL_CONFIG_PATH} is invalid JSON — ${(err as Error).message}`)]
  }
  const parsed = VinayaConfigSchema.safeParse(raw)
  if (!parsed.success) return []
  if (!parsed.data.checks || Object.keys(parsed.data.checks).length === 0) return []
  return [warn('checks', globalChecksIgnoredWarning(GLOBAL_CONFIG_PATH))]
}

// ---------------------------------------------------------------------------
// Token-metering capability probe — surfaces only the incapable verdict, at
// `info`: the expected default is `capable`, which is not a fact worth a
// line. Reuses `resolveMeteringCapability` from `@attalabs/aeg-core` rather
// than re-deriving "can this host meter itself" from `process.env` directly
// — declaring capability by host identity is the exact false positive the
// probe exists to remove.
// ---------------------------------------------------------------------------
function diagnoseTokenMetering(deps: DoctorDeps): Finding[] {
  const capability = deps.meteringCapability()
  if (capability.capable) return []
  return [
    info(
      'tokens',
      `Token-metering capability probe: incapable (${capability.reason}) — ${capability.detail} Real per-turn ` +
        'token figures cannot currently be collected via `vinaya tokens`. Report them by whatever means your ' +
        'host offers, or supply them directly with `vinaya tokens --in <n> --out <n>`.'
    )
  ]
}

// ---------------------------------------------------------------------------
// Check 5 — environment (gh auth + scope, Node/Bun, package-vs-artifact skew)
// ---------------------------------------------------------------------------
async function diagnoseEnvironment(deps: DoctorDeps, hasDrift: boolean): Promise<Finding[]> {
  const findings: Finding[] = []
  const auth = await deps.ghAuthStatus()
  const detail = auth.detail.replace(/\s*\n+\s*/g, '; ')
  findings.push(
    auth.authenticated ? info('environment', `gh: authenticated (${detail})`) : warn('environment', `gh: ${detail}`)
  )
  findings.push(info('environment', `node: ${deps.nodeVersion()}`))
  const bun = deps.bunVersion()
  if (bun) findings.push(info('environment', `bun: ${bun}`))

  const version = deps.packageVersion()
  findings.push(
    hasDrift
      ? warn(
          'environment',
          `vinaya@${version} — installed artifacts have drifted from this version's generator. Run \`vinaya upgrade\`.`
        )
      : info('environment', `vinaya@${version} — installed artifacts match this version's generator.`)
  )
  return findings
}

// ---------------------------------------------------------------------------
// Check 6 — branch protection, report-only, never applied.
// ---------------------------------------------------------------------------
async function diagnoseBranchProtection(deps: DoctorDeps, owner: string, repo: string): Promise<Finding> {
  const configured = await deps.branchProtectionConfigured(owner, repo)
  if (configured === true) return info('branch-protection', 'main branch protection is configured.')
  if (configured === false) {
    return info(
      'branch-protection',
      "main branch protection is not configured — vinaya never applies it; see `vinaya init`'s printed recommendation."
    )
  }
  if (configured === 'plan-required') {
    return info(
      'branch-protection',
      'main branch protection could not be checked — GitHub reports this repository needs a paid plan ' +
        '(GitHub Pro, or make the repo public) to query branch protection on a private repo.'
    )
  }
  return info(
    'branch-protection',
    'main branch protection could not be determined (no gh auth, no remote, or a permission gap).'
  )
}

// ---------------------------------------------------------------------------
// Check 9 — CODEOWNERS coverage of .github/workflows/**, report-only, local
// file read only — never applied, and never a fallback identity: the SAME
// class of mistake `principals`' hardcoded default already made once
// (review-gate.ts's own module comment) would be worse here, since a wrong
// login written into a committed, GitHub-visible file is harder to miss and
// undo than an internal fallback. This only reports whether the ADOPTER'S
// own coverage line exists, never suggests or writes one.
// ---------------------------------------------------------------------------
/**
 * True only when `pattern` IS the workflows directory itself (however the
 * trailing glob/slash is spelled) — never merely a path that mentions it.
 * `/.github/workflows/deploy.yml` names one file inside the directory and
 * must NOT count: found live (code review, PR #168) — a bare substring
 * check (`line.includes('.github/workflows/')`) reported full coverage for
 * exactly that narrower pattern, a false positive on this diagnostic's own
 * reason for existing (protecting `vinaya-review.yml`, not one file in it).
 */
function coversWorkflowsDir(pattern: string): boolean {
  const bare = pattern.replace(/\*+$/, '').replace(/\/+$/, '')
  return bare === '.github/workflows' || bare === '/.github/workflows'
}

function diagnoseCodeowners(repoRoot: string): Finding {
  const path = join(repoRoot, '.github', 'CODEOWNERS')
  if (!existsSync(path)) {
    return info(
      'codeowners',
      "no .github/CODEOWNERS — vinaya's workflow files have no required-review protection; see `vinaya init`'s printed recommendation."
    )
  }
  let body: string
  try {
    body = readFileSync(path, 'utf-8')
  } catch (err) {
    // Present but unreadable (permissions, a broken symlink) — degrade to a
    // finding, same pattern diagnoseCustomChecks/diagnoseTestCi already use
    // for a bad file, never let one bad file abort the whole doctor run.
    return warn('codeowners', `.github/CODEOWNERS exists but could not be read: ${(err as Error).message}`)
  }
  const covered = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .some((line) => coversWorkflowsDir(line.split(/\s+/)[0] ?? ''))
  return covered
    ? info('codeowners', '.github/CODEOWNERS covers .github/workflows/**.')
    : warn(
        'codeowners',
        '.github/CODEOWNERS exists but has no entry covering .github/workflows/** — workflow file edits can merge unreviewed.'
      )
}

// ---------------------------------------------------------------------------
// vinaya-on-PATH — report-only, `info` not `warn` (same reasoning as
// principals below — see that comment for why `healthy`/exit-code stay
// unaffected). Every agent-native entry point `init` scaffolds
// (`.claude/commands/vinaya.md`, `.gemini/commands/vinaya.toml`,
// `.agents/skills/vinaya-*/SKILL.md`) invokes a bare `vinaya doctrine`, and
// `vinaya init` never installs itself anywhere — see `PRINCIPALS_NOTE`'s
// sibling note in lib/artifacts.ts (printed once, at install time) for why
// the invocation shape stays bare rather than switching to a pinned `npx`
// (claude-command-emitter.ts's `allowed-tools` permission-matcher needs the
// short literal prefix). This is that note's permanent, doctor-side
// counterpart — only meaningful when at least one such vendor was actually
// selected at init.
//
// A pure PATH scan, never a subprocess spawn: `vinaya doctor` never mutates
// AND never blocks — an `execFileSync('vinaya', …)` here would hang this
// diagnostic on whatever a real `vinaya` binary does on its own (network,
// stdin), for a question ("does a file named vinaya sit in a PATH dir")
// answerable by `existsSync` alone.
// ---------------------------------------------------------------------------
function diagnoseVinayaOnPath(agents: ReadonlySet<string>): Finding[] {
  if (agents.size === 0) return []
  const names = process.platform === 'win32' ? ['vinaya.cmd', 'vinaya.exe', 'vinaya.bat'] : ['vinaya']
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const onPath = dirs.some((dir) => names.some((name) => existsSync(join(dir, name))))
  return [
    onPath
      ? ok('vinaya-on-path', '`vinaya` resolves on PATH — agent-native commands will work.')
      : info(
          'vinaya-on-path',
          '`vinaya` is not resolvable on PATH — `/vinaya <role>` and the .agents/skills/vinaya-*/SKILL.md files ' +
            'installed here will fail "command not found" on first use. Run `npm install -g @attalabs/vinaya`.'
        )
  ]
}

// ---------------------------------------------------------------------------
// principals — report-only. `info`, matching CODEOWNERS/branch-protection
// above, not `warn`: an unset `principals` is a real, high-consequence gap
// (review-gate silently trusts nobody's verdicts on this repo —
// `resolvePrincipalAllowlist` in lib/config.ts falls back to the hardcoded
// `PRINCIPAL_ALLOWLIST`, this monorepo's own maintainer, whenever the field
// is absent, and `vinaya init` never sets it itself — see `PRINCIPALS_NOTE`,
// lib/artifacts.ts, for why not), but `warn`/`error` flip `healthy` to false
// and doctor's exit code to 1 for EVERY existing adopter that hasn't set
// this, whether or not review-gate applies to them — the same blast-radius
// reasoning CODEOWNERS/branch-protection already made this way. Found live:
// a first-time adopter's PR had two clean human verdicts land and both
// silently ignored, with nothing in `init`'s output warning this was
// coming — `doctor` is the only other surface that can catch it before it
// happens again.
// ---------------------------------------------------------------------------
function diagnosePrincipals(config: VinayaConfig): Finding {
  if (config.principals && config.principals.length > 0) {
    return info('principals', `review-gate trusts ${config.principals.length} declared principal(s).`)
  }
  return info(
    'principals',
    'vinaya.config.json has no "principals" — review-gate and the waiver-label actor check both fall back to a ' +
      "hardcoded placeholder allowlist that will not include anyone on this repo. Every reviewer's verdict is " +
      'silently ignored (DANGLING) until you add `"principals": ["<your-github-login>", ...]` to vinaya.config.json.'
  )
}

// ---------------------------------------------------------------------------
// Projects coherence — `.vinaya/projects.md` (the registry) and
// `vinaya.config.json`'s `projects` array are two independent, coexisting
// homes for the same declared fact (task 15/#44) — `init product` writes
// both, but either can drift: hand-edited, one file reverted, or written by
// an older package version that only knew one of the two. `info` severity,
// always: an adopter who keeps only the registry (the common case — no
// shipped surface in THIS repo reads `projects` yet) is not broken, and
// neither is one who only ever populates the config side. This purely
// reports the drift; it never picks a side or writes anything.
//
// The Issue's original text also named a third shape — a `project:<name>`
// label with no config entry — inherited from before `init product` stopped
// creating that label (#72: the label is retired outright, replaced by the
// registry row as the non-config source of truth). No label exists to check
// against any more, so that third shape has no live analogue here; the two
// shapes below (registry-only, config-only) are what remain.
// ---------------------------------------------------------------------------
function diagnoseProjectsCoherence(repoRoot: string, config: VinayaConfig | null): Finding[] {
  const registryAbs = join(repoRoot, PROJECTS_REGISTRY_PATH)
  const registryNames = existsSync(registryAbs)
    ? new Set(parseRegistry(readFileSync(registryAbs, 'utf-8')).map((p) => p.name))
    : new Set<string>()
  const configNames = new Set((config?.projects ?? []).map((p) => p.name))

  if (registryNames.size === 0 && configNames.size === 0) return []

  const registryOnly = [...registryNames].filter((n) => !configNames.has(n)).sort()
  const configOnly = [...configNames].filter((n) => !registryNames.has(n)).sort()

  const findings: Finding[] = []
  if (registryOnly.length > 0) {
    findings.push(
      info(
        'projects',
        `${PROJECTS_REGISTRY_PATH} declares ${registryOnly.join(', ')} with no matching vinaya.config.json "projects" entry.`
      )
    )
  }
  if (configOnly.length > 0) {
    findings.push(
      info(
        'projects',
        `vinaya.config.json "projects" declares ${configOnly.join(', ')} with no matching ${PROJECTS_REGISTRY_PATH} row.`
      )
    )
  }
  return findings
}

// ---------------------------------------------------------------------------
// Check 8 — test CI, report-only, a heuristic. Vinaya requires a Test Plan on
// every PR and enforces it as a blocking gate but never checks whether
// anything actually runs the adopter's tests — this names that asymmetry.
// Narrow by design: a short literal-substring list, not a fuzzy matcher, and
// silent whenever there's nothing to check against (no package.json, no
// `scripts.test`) — inventing an opinion about a test runner this repo can't
// see is worse than staying silent (a Python/Rust/Go repo may have neither).
// Scans EVERY file under .github/workflows/, not only the four vinaya-
// generated ones — a hand-written CI workflow (this repo's own `ci.yml`) is
// exactly where the real invocation lives, and scanning only the generated
// four would false-positive against vinaya's own repo. Report-only like
// `diagnoseBranchProtection`: vinaya cannot know the adopter's test command
// and will not generate one (a wrong guess written into CI is worse than
// silence).
// ---------------------------------------------------------------------------
const TEST_INVOCATION_SUBSTRINGS = ['npm test', 'npm run test', 'bun test', 'bunx turbo test']

function diagnoseTestCi(repoRoot: string): Finding[] {
  let pkg: unknown
  try {
    pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'))
  } catch {
    return []
  }
  const testScript = (pkg as { scripts?: Record<string, unknown> })?.scripts?.test
  if (typeof testScript !== 'string' || testScript.trim() === '') return []

  const workflowsDir = join(repoRoot, '.github/workflows')
  const files = existsSync(workflowsDir)
    ? readdirSync(workflowsDir).filter((name) => statSync(join(workflowsDir, name)).isFile())
    : []

  const invoked = files.some((name) => {
    const content = readFileSync(join(workflowsDir, name), 'utf-8')
    return TEST_INVOCATION_SUBSTRINGS.some((s) => content.includes(s))
  })
  if (invoked) return []

  return [
    warn(
      'test-ci',
      "no workflow under .github/workflows/ appears to invoke this repo's `package.json` test script — " +
        'vinaya requires a Test Plan on every PR and enforces it as a blocking gate, but nothing here verifies that tests actually run.'
    )
  ]
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------
function symbolFor(severity: Severity): string {
  switch (severity) {
    case 'ok':
      return '✓'
    case 'info':
      return '·'
    case 'warn':
      return '⚠'
    case 'error':
      return '✗'
  }
}

function printReport(
  findings: Finding[],
  healthy: boolean,
  doctrineInfo: { root: string; source: DoctrineSource } | null
): void {
  process.stdout.write('vinaya doctor\n\n')
  if (doctrineInfo) {
    process.stdout.write(`doctrine: ${doctrineInfo.root} (${doctrineInfo.source})\n\n`)
  }
  for (const f of findings) {
    process.stdout.write(`${symbolFor(f.severity)} [${f.check}] ${f.message}\n`)
  }
  process.stdout.write(
    `\n${healthy ? 'Healthy — no findings.' : 'Findings above. vinaya doctor never mutates — nothing was changed.'}\n`
  )
}

// ---------------------------------------------------------------------------
// vinaya doctor
// ---------------------------------------------------------------------------
export async function runDoctor(args: string[], deps: DoctorDeps): Promise<number> {
  const jsonOutput = args.includes('--json')

  const repo = await deps.detectRepo()
  if (!repo) {
    console.error('Error: not a git repository. Run `vinaya doctor` from inside your repo.')
    return 1
  }

  const doctrineInfo = resolveDoctrineRootInfo(undefined, repo.repoRoot)

  const configRead = readConfig(repo.repoRoot)
  const findings: Finding[] = []
  let hasDrift = false

  if (configRead.kind === 'invalid') {
    findings.push(error('config', `vinaya.config.json is invalid — ${configRead.error}`))
  } else if (configRead.kind === 'missing' || !configRead.config.managed) {
    findings.push(error('install', 'vinaya is not initialized in this repo — run `vinaya init`.'))
  } else {
    const manifest = configRead.config.managed
    const hookDir = hookDirFromManifest(manifest, deps.hookDirFor(repo.repoRoot))
    const ctx: InitContext = {
      owner: repo.owner,
      repo: repo.repo,
      hookDir,
      selfHost: detectVendoredVinaya(repo.repoRoot),
      ciSetup: readRepoCiSetup(repo.repoRoot),
      // Read back, never re-derived: a vendor the adopter deliberately
      // excluded via `--agents` must not be reported as "not installed".
      agents: resolveAgentVendors(manifest)
    }
    const install = diagnoseInstall(repo.repoRoot, ctx, manifest)
    findings.push(...install.findings)
    hasDrift = install.hasDrift
    findings.push(...(await diagnoseHookRouting(repo.repoRoot, hookDir, deps.readHooksPath)))
    findings.push(...diagnoseCustomChecks(repo.repoRoot, configRead.config))
    findings.push(...diagnoseDocOwnersHealth(repo.repoRoot))
    findings.push(diagnosePrincipals(configRead.config))
    findings.push(...diagnoseVinayaOnPath(ctx.agents))
  }

  findings.push(...diagnoseProjectsCoherence(repo.repoRoot, configRead.kind === 'ok' ? configRead.config : null))
  findings.push(...diagnoseBlastRadiusDeprecation(repo.repoRoot, configRead.kind === 'ok' ? configRead.config : null))
  findings.push(...diagnoseBriefSchemaDrift(configRead.kind === 'ok' ? configRead.config : null))
  findings.push(...diagnoseEnvDeclarations(repo.repoRoot, configRead.kind === 'ok' ? configRead.config : null))
  findings.push(...diagnoseCheckClassification(configRead.kind === 'ok' ? configRead.config : null))
  findings.push(...diagnoseGlobalConfigChecks())
  findings.push(...diagnoseTokenMetering(deps))
  findings.push(...(await diagnoseEnvironment(deps, hasDrift)))
  findings.push(await diagnoseBranchProtection(deps, repo.owner, repo.repo))
  findings.push(diagnoseCodeowners(repo.repoRoot))
  findings.push(...diagnoseTestCi(repo.repoRoot))

  const healthy = findings.every((f) => f.severity === 'ok' || f.severity === 'info')

  if (jsonOutput) {
    printJson({ healthy, findings, doctrineInfo })
  } else {
    printReport(findings, healthy, doctrineInfo)
  }

  return healthy ? 0 : 1
}

export async function doctorCommand(args: string[]): Promise<void> {
  process.exit(await runDoctor(args, realDeps()))
}

import type { SurfaceExemption } from '../lib/surface-exemption'

export const SURFACE_EXEMPTIONS: Record<string, SurfaceExemption> = {
  doctor: { date: '2026-09-05', callsToday: 17, retiresVia: 'sharedCommandShell' }
}
