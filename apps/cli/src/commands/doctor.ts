// `vinaya doctor` — diagnose the full installation. Reads the records `init`
// wrote (see lib/artifacts.ts, lib/ops.ts) and reports drift against them.
//
// Contract: doctor NEVER mutates. Every code path in this file is
// read-only — no fs write, no `gh` write, no forge mutation. It exists
// precisely because a doctor that "fixes" silently destroys the support
// story; `vinaya upgrade` is the only sanctioned path back to a clean state.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { CheckSpec } from '../checks/contract.js'
import { coreCheckRegistry } from '../checks/registry.js'
import { bareKeyRejectedDiagnostic, overriddenReplacesCoreDiagnostic, resolveChecks } from '../checks/resolver.js'
import { DOC_OWNERS_PATH } from '@attalabs/aeg-core'
import {
  buildInitOps,
  CONFIG_PATH,
  DOCTRINE_POINTER_PATH,
  type HookDir,
  type InitContext,
  TRACKED_HOOK_DIR
} from '../lib/artifacts.js'
import { detectVendoredVinaya } from '../lib/self-host.js'
import {
  GLOBAL_CONFIG_PATH,
  globalChecksIgnoredWarning,
  type ManagedManifest,
  readRepoCiSetup,
  type VinayaConfig,
  VinayaConfigSchema,
  lintEnvDeclarations
} from '../lib/config.js'
import {
  branchProtectionConfigured,
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
import { markerLines, renderBlock, resolveManagedBlockPath } from '../lib/ops.js'
import { packageRoot } from '../lib/package-root.js'

export type DoctorDeps = {
  detectRepo: () => Promise<RepoInfo | null>
  ghAuthStatus: () => Promise<GhAuthStatus>
  branchProtectionConfigured: (owner: string, repo: string) => Promise<boolean | null>
  hookDirFor: (repoRoot: string) => HookDir
  readHooksPath: (repoRoot: string) => Promise<string | null>
  nodeVersion: () => string
  bunVersion: () => string | null
  packageVersion: () => string
}

function readVersion(): string {
  const pkg = JSON.parse(readFileSync(join(packageRoot(import.meta.url), 'package.json'), 'utf-8'))
  return pkg.version
}

function realDeps(): DoctorDeps {
  return {
    detectRepo: detectGitRepo,
    ghAuthStatus,
    branchProtectionConfigured,
    hookDirFor: resolveHookDir,
    readHooksPath: readCoreHooksPath,
    nodeVersion: () => process.version,
    bunVersion: () => (typeof Bun === 'undefined' ? null : Bun.version),
    packageVersion: readVersion
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
      const owned = ownedFiles.has(op.path)

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
  return info(
    'branch-protection',
    'main branch protection could not be determined (no gh auth, no remote, or a permission gap).'
  )
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

function printReport(findings: Finding[], healthy: boolean): void {
  process.stdout.write('vinaya doctor\n\n')
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
      ciSetup: readRepoCiSetup(repo.repoRoot)
    }
    const install = diagnoseInstall(repo.repoRoot, ctx, manifest)
    findings.push(...install.findings)
    hasDrift = install.hasDrift
    findings.push(...(await diagnoseHookRouting(repo.repoRoot, hookDir, deps.readHooksPath)))
    findings.push(...diagnoseCustomChecks(repo.repoRoot, configRead.config))
  }

  findings.push(...diagnoseEnvDeclarations(repo.repoRoot, configRead.kind === 'ok' ? configRead.config : null))
  findings.push(...diagnoseCheckClassification(configRead.kind === 'ok' ? configRead.config : null))
  findings.push(...diagnoseGlobalConfigChecks())
  findings.push(...(await diagnoseEnvironment(deps, hasDrift)))
  findings.push(await diagnoseBranchProtection(deps, repo.owner, repo.repo))
  findings.push(...diagnoseTestCi(repo.repoRoot))

  const healthy = findings.every((f) => f.severity === 'ok' || f.severity === 'info')

  if (jsonOutput) {
    printJson({ healthy, findings })
  } else {
    printReport(findings, healthy)
  }

  return healthy ? 0 : 1
}

export async function doctorCommand(args: string[]): Promise<void> {
  process.exit(await runDoctor(args, realDeps()))
}
