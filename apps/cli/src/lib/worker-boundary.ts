/**
 * Wires an unattended `dispatchRole` launch (`dispatch.ts`, O1) to the
 * OS-level confinement `apps/cli/specs/isolation.md` specifies and
 * `apps/cli/scripts/isolation-probe.ts` proves (task 1) — the
 * surface that file's own "What this task does not change" section named
 * as a later task's job. This module (task 3) is that later task.
 *
 * Deliberately does NOT import `apps/cli/scripts/isolation-probe.ts`: that
 * directory is a dev-only script tree, excluded from the published package
 * (`apps/cli/package.json`'s `files` array ships `dist` only, never
 * `scripts`) — importing it from `src/lib` would resolve fine in this
 * monorepo checkout but throw at runtime for anyone running the published
 * `vinaya` binary. The small pieces of that probe's own logic a real
 * launcher also needs (host detection, Seatbelt string-literal escaping) are
 * re-implemented here, deliberately, rather than shared — the same posture
 * `dispatch.ts` already takes for `backgroundShapeDetectorSource`/
 * `wholeSuiteTestCommandDetectorSource` (embedded verbatim rather than
 * imported, for a different but analogous packaging reason).
 *
 * The probe's OWN profile (`isolation-probe.sb`) is also too narrow to reuse
 * as-is: it denies `process-exec` down to the single interpreter binary the
 * disposable probe itself needs to re-invoke, and denies ALL outbound
 * network — correct for a probe that never needs to run a toolchain or
 * reach a network endpoint, wrong for a real Worker/Reviewer, which must
 * run its own declared toolchain (git, its build/test/lint commands) and
 * reach the model runtime endpoint to keep functioning as an agent
 * (`isolation.md` §1, Worker row). `buildWorkerSandboxProfile` below is the
 * wider, still-explicit allowlist a real launch needs, built on the exact
 * same default-deny-plus-named-allowlist principle.
 */

import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Role } from '@attalabs/aeg-core'

/** The same allowlist discipline `apps/cli/src/checks/runner.ts`'s `buildCheckEnv` already applies to a custom check's child — named here again, deliberately, rather than imported: `checks/runner.ts` sits outside this task's surface (`apps/cli/src/checks` is explicitly named `out:` in the dispatched brief), and this list is small enough that naming it twice costs less than reaching across that boundary. `apps/cli/specs/isolation.md` §2 documents this precedent as the pattern this module extends to the Worker/Reviewer dispatch path. */
export const WORKER_ENV_ALLOWLIST_KEYS = [
  'PATH',
  'LANG',
  'HOME',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'TMPDIR',
  // Account names, not secrets — any process running as this user resolves
  // them. Claude Code's own Keychain lookup needs both, and without them
  // `claude -p` prints "Not logged in" even where a login exists.
  'USER',
  'LOGNAME'
] as const

/**
 * The subscription logins a dispatched vendor CLI can authenticate from
 * inside the boundary, and the only routes this module stages. No agent
 * ever authenticates with an API key: no API-key environment variable is
 * read, allowlisted into a confined child, or named as a fallback anywhere
 * on the dispatch path.
 *
 * - `claude` — the OAuth session credential in the Claude config directory
 *   (`resolveOAuthConfigSourceDir`), or, where Claude Code keeps it in the
 *   macOS Keychain and writes no file, that Keychain entry — either way
 *   staged as a scoped copy (`stageOAuthCredential`).
 * - `codex` — the cached ChatGPT session (`auth.json` under `CODEX_HOME`,
 *   or the macOS credential-store item), read by the trusted controller
 *   (`resolveCodexAccessToken`) and replayed into a task-scoped
 *   `CODEX_HOME` via `codex login --with-access-token`. `CODEX_ACCESS_TOKEN`
 *   is that login's own stdin bootstrap value, never an API key and never
 *   set on the confined child's environment — doing so breaks the staged
 *   session's bearer auth outright (`isolation.md` §3).
 * - `gemini` — no subscription login exists in Vinaya yet, so a dispatch
 *   refuses rather than reaching for a key (`dispatch.ts`).
 */
export const SUBSCRIPTION_LOGIN_AGENTS = ['claude', 'codex'] as const

/** True when `agent` has a subscription login this module can stage — the negative case is the Gemini refusal `dispatch.ts` raises before any spawn. */
export function hasSubscriptionLogin(agent: string): boolean {
  return (SUBSCRIPTION_LOGIN_AGENTS as readonly string[]).includes(agent)
}

const CODEX_AUTH_FILE_NAME = 'auth.json'
const CODEX_KEYCHAIN_SERVICE = 'Codex Auth'

/** The macOS Keychain service name Claude Code keeps its subscription login under — the entry `claude` itself reads and writes, in place of `.credentials.json`, on a Mac. */
export const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials'

function accessTokenFromCodexAuth(raw: string | null): string | null {
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as { tokens?: { access_token?: unknown } }
    return typeof parsed.tokens?.access_token === 'string' && parsed.tokens.access_token.length > 0
      ? parsed.tokens.access_token
      : null
  } catch {
    return null
  }
}

function codexKeychainAccount(codexHome: string): string {
  let canonical = codexHome
  try {
    canonical = realpathSync(codexHome)
  } catch {
    // Codex uses the unresolved path when CODEX_HOME does not exist yet.
  }
  return `cli|${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`
}

/** Trusted-controller-only read of Codex's macOS credential-store session. */
function readRealCodexKeychainCredential(codexHome: string): string | null {
  if (process.platform !== 'darwin') return null
  try {
    return execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', CODEX_KEYCHAIN_SERVICE, '-a', codexKeychainAccount(codexHome), '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000, maxBuffer: 1024 * 1024 }
    ).trim()
  } catch {
    return null
  }
}

/**
 * Trusted-controller-only read of Claude Code's macOS Keychain login, run
 * OUTSIDE the sandbox (the profile denies the Keychain on purpose). `null` on
 * any failure — non-darwin host, entry absent, `security` missing, timeout —
 * and never throws. The returned text is a credential: callers stage it to a
 * 0600 file and never log it or put it on argv.
 */
export function readRealClaudeKeychainCredential(): string | null {
  if (process.platform !== 'darwin') return null
  try {
    const out = execFileSync('/usr/bin/security', ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
      maxBuffer: 1024 * 1024
    }).trim()
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

/**
 * The text to stage as `.credentials.json` from a Keychain payload: only the
 * `claudeAiOauth` object — the subscription login Claude reads from that
 * file — never the unrelated MCP server tokens the same Keychain item also
 * carries. `null` when the payload is not JSON or carries no such object.
 */
function claudeLoginFromKeychainPayload(raw: string | null): string | null {
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as { claudeAiOauth?: unknown }
    const login = parsed.claudeAiOauth
    if (typeof login !== 'object' || login === null) return null
    return JSON.stringify({ claudeAiOauth: login })
  } catch {
    return null
  }
}

export function resolveCodexAccessToken(
  sourceEnv: Readonly<Record<string, string | undefined>>,
  realHome: string,
  readFile: (path: string) => string | null = readRealOAuthCredentialFile,
  readKeychain: (codexHome: string) => string | null = readRealCodexKeychainCredential
): string | null {
  if (sourceEnv.CODEX_ACCESS_TOKEN) return sourceEnv.CODEX_ACCESS_TOKEN
  const codexHome = sourceEnv.CODEX_HOME ?? join(realHome, '.codex')
  return (
    accessTokenFromCodexAuth(readFile(join(codexHome, CODEX_AUTH_FILE_NAME))) ??
    accessTokenFromCodexAuth(readKeychain(codexHome))
  )
}

/** The one filename this run's machine-state floor is written under, in either staging path. */
export const CODEX_POLICY_RULES_FILE = 'vinaya-machine-state.rules'

/**
 * Round 2 review (Reviewer MAJOR / Security HIGH, F1): the
 * machine-state execpolicy floor must ride EVERY Codex dispatch, the way a
 * Claude dispatch's `permissions.deny` rides `--settings` on every run — not
 * only inside the worker-isolation boundary. `resolveWorkerBoundaryLaunch`
 * stages a run-scoped `CODEX_HOME` (with the rules) only when that boundary
 * runs (`opts.unattended && requireIsolation`); this stages the equivalent for
 * a Codex dispatch that runs WITHOUT it — an attended start (an unattended
 * Codex start requires the boundary and refuses where it is unavailable) — so the child discovers the same floor either way.
 *
 * `targetDir` becomes a home that symlinks every entry of the operator's real
 * `~/.codex` (its `auth.json`, `config.toml`, plugins, sessions — so
 * authentication, configuration and `exec resume` behave exactly as an
 * unstaged run against `~/.codex` would) EXCEPT `rules`, which becomes a real
 * directory carrying the operator's own rules (symlinked through) plus this
 * run's machine-state floor. Most-restrictive-wins in Codex's own layering, so
 * a forbidding rule here only ever tightens.
 *
 * Returns `null` when the operator has no `~/.codex/auth.json` to re-home from
 * — a keychain-only login is keyed by the home PATH and cannot be re-pointed,
 * so the caller leaves `CODEX_HOME` alone and logs the floor as unstaged rather
 * than breaking authentication. Never writes the operator's real `~/.codex`;
 * it only reads it and symlinks into `targetDir`.
 *
 * Verified live against `codex-cli 0.152.1`: a SYMLINKED `auth.json`
 * authenticates identically to a real one (both reach the API with the token,
 * failing only on the token's own validity), and a `.rules` file under
 * `<CODEX_HOME>/rules/` is loaded at startup (a malformed one errors before the
 * turn). The full authenticated multi-turn `exec resume` cannot be proven from
 * a host with no operator login — the same disclosed limit
 * `runRealCodexLoginWithAccessToken` already carries; a run-scoped `CODEX_HOME`
 * with `exec resume` is the shape `resolveWorkerBoundaryLaunch` already ships.
 */
export function stageCodexPolicyHome(input: {
  targetDir: string
  realHome: string
  execpolicyRules: string
}): { codexHome: string } | null {
  const operatorHome = join(input.realHome, '.codex')
  if (!existsSync(join(operatorHome, CODEX_AUTH_FILE_NAME))) return null
  try {
    mkdirSync(input.targetDir, { recursive: true, mode: 0o700 })
    // Idempotent across a resumed turn that reuses the same run-scoped path:
    // clear any prior contents before re-symlinking.
    for (const entry of readdirSync(input.targetDir)) {
      rmSync(join(input.targetDir, entry), { recursive: true, force: true })
    }
    for (const entry of readdirSync(operatorHome)) {
      if (entry === 'rules') continue
      symlinkSync(join(operatorHome, entry), join(input.targetDir, entry))
    }
    const scopedRules = join(input.targetDir, 'rules')
    mkdirSync(scopedRules, { recursive: true, mode: 0o700 })
    const operatorRules = join(operatorHome, 'rules')
    if (existsSync(operatorRules)) {
      for (const entry of readdirSync(operatorRules)) {
        if (entry === CODEX_POLICY_RULES_FILE) continue
        symlinkSync(join(operatorRules, entry), join(scopedRules, entry))
      }
    }
    writeFileSync(join(scopedRules, CODEX_POLICY_RULES_FILE), input.execpolicyRules, { mode: 0o600 })
    return { codexHome: input.targetDir }
  } catch {
    return null
  }
}

export type CodexAuthPreflightResult = { ok: true } | { ok: false; reason: string }

/**
 * Round 5 review, BLOCKER: a bare `CODEX_ACCESS_TOKEN`
 * environment variable is not itself a session Codex's real CLI accepts —
 * live-verified against `codex-cli 0.152.1` on this authoring host (`codex
 * --help` documents no such env-var auth path at all): the vendor CLI only
 * ever authenticates from `auth.json` inside its `CODEX_HOME`, written by
 * its own `login` subcommand. `codex login --with-access-token` (confirmed
 * live via `codex login --help` on this host: "Read the access token from
 * stdin") is that subcommand's own supported non-interactive bootstrap path
 * — it reads the token from stdin and writes a real `auth.json` (deriving
 * `account_id`/`refresh_token` itself) into whatever `CODEX_HOME` it is
 * pointed at, never the operator's real one here, since `codexHome` is
 * always the scratch directory this module already staged. The actual
 * token round-trip (a real ChatGPT session authenticating through this
 * exact call) is NOT independently live-verified by this change — a
 * dispatched Developer session is denied read access to the operator's real
 * `~/.codex/auth.json` by this same isolation boundary (confirmed live:
 * the read was refused), so this call's real-world behavior can only be
 * proven by a live canary or the Principal's own privileged host, not by
 * this dispatch — disclosed rather than silently assumed, the same posture
 * this file already takes for `codex`/`gemini`'s unverified env var names.
 */
function runRealCodexLoginWithAccessToken(input: {
  binaryPath: string
  codexHome: string
  accessToken: string
}): { ok: true } | { ok: false; reason: string } {
  try {
    execFileSync(input.binaryPath, ['login', '--with-access-token'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 45_000,
      maxBuffer: 4 * 1024 * 1024,
      input: input.accessToken,
      env: {
        PATH: process.env.PATH,
        CODEX_HOME: input.codexHome
      }
    })
    return { ok: true }
  } catch (error) {
    const e = error as { killed?: boolean; signal?: string; status?: number | null }
    if (e.killed || e.signal === 'SIGTERM') {
      return { ok: false, reason: 'codex login --with-access-token timed out after 45 seconds' }
    }
    return { ok: false, reason: `codex login --with-access-token failed (exit ${e.status ?? 'unknown'})` }
  }
}

/**
 * Round 7 review, BLOCKER: a bare `hooks.json` file dropped at `CODEX_HOME`
 * root is never loaded by the real Codex CLI — live-verified on this
 * authoring host (`codex-cli 0.152.1`): every real hooks.json this host
 * carries lives inside an INSTALLED PLUGIN's own directory (e.g. a
 * marketplace-installed `figma` plugin's `hooks.json`, found via `find
 * ~/.codex -iname hooks.json`), never at `CODEX_HOME` root directly, and
 * `codex doctor`'s own config report names no mechanism that would discover
 * one there. Codex's real, documented, non-interactive path is `codex
 * plugin marketplace add <local-dir>` (confirmed live: `codex plugin
 * marketplace add --help` names `codex plugin marketplace add
 * ./path/to/marketplace` as its own worked example) followed by `codex
 * plugin add <plugin>@<marketplace>` — both plain local filesystem/config
 * operations needing no ChatGPT/API credential at all, so both are
 * live-verified end to end on this host: a scratch marketplace built to
 * this exact shape (`buildCodexHooksMarketplace`, below) installed
 * successfully into a scratch `CODEX_HOME` with `codex plugin list --json`
 * confirming `"installed": true, "enabled": true` and the hooks.json
 * content genuinely copied into
 * `<CODEX_HOME>/plugins/cache/<marketplace>/<plugin>/<version>/hooks.json`.
 * `--dangerously-bypass-hook-trust` (already passed at every Codex launch
 * site, `dispatch.ts`) is what then lets an ENABLED plugin's hooks actually
 * fire without an interactive trust prompt — installation and trust are the
 * two separate gates this closes; only a live, authenticated turn can prove
 * a hook actually FIRES mid-session, which remains outside what this
 * dispatched session can reach (the same disclosed limit every other
 * end-to-end Codex claim in this file already carries).
 */
const CODEX_HOOKS_MARKETPLACE_NAME = 'vinaya-dispatch'
const CODEX_HOOKS_PLUGIN_NAME = 'vinaya-documentation-gate'

/**
 * Writes the marketplace + plugin manifests `runRealCodexPluginInstall`
 * installs from — the exact shape live-verified against this host's real
 * `codex plugin marketplace add`/`codex plugin add` (schema errors from
 * real, wrong first attempts: the manifest must live at
 * `<root>/.agents/plugins/marketplace.json`, never `<root>/marketplace.json`;
 * `policy.authentication` accepts only `ON_INSTALL`/`ON_USE`, never `NONE`).
 * `hooksJsonContent` is `dispatch.ts`'s own `writeCodexDispatchHooks`
 * output, unmodified — this function only relocates it into the shape
 * Codex's plugin system actually discovers.
 */
function buildCodexHooksMarketplace(marketplaceDir: string, hooksJsonContent: string): void {
  const pluginRelDir = `./plugins/${CODEX_HOOKS_PLUGIN_NAME}`
  const pluginDir = join(marketplaceDir, 'plugins', CODEX_HOOKS_PLUGIN_NAME)
  mkdirSync(join(marketplaceDir, '.agents', 'plugins'), { recursive: true, mode: 0o700 })
  mkdirSync(join(pluginDir, '.codex-plugin'), { recursive: true, mode: 0o700 })
  writeFileSync(
    join(marketplaceDir, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify(
      {
        name: CODEX_HOOKS_MARKETPLACE_NAME,
        interface: { displayName: 'Vinaya dispatch' },
        plugins: [
          {
            name: CODEX_HOOKS_PLUGIN_NAME,
            source: { source: 'local', path: pluginRelDir },
            policy: { installation: 'AVAILABLE', authentication: 'ON_USE' },
            category: 'Developer Tools'
          }
        ]
      },
      null,
      2
    ),
    { mode: 0o600 }
  )
  writeFileSync(
    join(pluginDir, '.codex-plugin', 'plugin.json'),
    JSON.stringify(
      {
        name: CODEX_HOOKS_PLUGIN_NAME,
        version: '0.0.1',
        description: "Mechanizes this dispatch's Documentation read-gate for Codex.",
        interface: {
          displayName: 'Vinaya documentation gate',
          shortDescription: 'Documentation read-gate hooks',
          category: 'Developer Tools'
        }
      },
      null,
      2
    ),
    { mode: 0o600 }
  )
  writeFileSync(join(pluginDir, 'hooks.json'), hooksJsonContent, { mode: 0o600 })
}

function runRealCodexPluginInstall(input: {
  binaryPath: string
  codexHome: string
  marketplaceDir: string
}): { ok: true } | { ok: false; reason: string } {
  const env = { PATH: process.env.PATH, CODEX_HOME: input.codexHome }
  try {
    execFileSync(input.binaryPath, ['plugin', 'marketplace', 'add', input.marketplaceDir, '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
      env
    })
    execFileSync(
      input.binaryPath,
      ['plugin', 'add', `${CODEX_HOOKS_PLUGIN_NAME}@${CODEX_HOOKS_MARKETPLACE_NAME}`, '--json'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20_000,
        maxBuffer: 4 * 1024 * 1024,
        env
      }
    )
    return { ok: true }
  } catch (error) {
    const e = error as { status?: number | null; stderr?: Buffer | string }
    const stderrText = e.stderr ? (typeof e.stderr === 'string' ? e.stderr : e.stderr.toString('utf8')).trim() : ''
    return {
      ok: false,
      reason: `codex plugin install failed (exit ${e.status ?? 'unknown'})${stderrText ? `: ${stderrText}` : ''}`
    }
  }
}

/**
 * Proves usability with a fixed, read-only, ephemeral vendor request outside
 * the adopter repository. A revoked or expired session refuses before the
 * developer loop, and the hard timeout keeps the preflight bounded.
 */
function runRealCodexAuthPreflight(input: {
  binaryPath: string
  codexHome: string
  cwd: string
  realHome: string
}): CodexAuthPreflightResult {
  try {
    execFileSync(
      input.binaryPath,
      [
        'exec',
        '--ephemeral',
        '--sandbox',
        'read-only',
        '--ignore-user-config',
        '--ignore-rules',
        '--skip-git-repo-check',
        '--json',
        'Respond exactly OK without using tools.'
      ],
      {
        cwd: input.cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 45_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          LANG: process.env.LANG,
          HOME: input.realHome,
          TMPDIR: input.cwd,
          CODEX_HOME: input.codexHome
        }
      }
    )
    return { ok: true }
  } catch (error) {
    const e = error as { killed?: boolean; signal?: string; status?: number | null }
    if (e.killed || e.signal === 'SIGTERM') return { ok: false, reason: 'timed out after 45 seconds' }
    return { ok: false, reason: `Codex rejected the staged ChatGPT session (exit ${e.status ?? 'unknown'})` }
  }
}

/**
 * O1: the file name Claude's own `CLAUDE_CONFIG_DIR` (default
 * `<realHome>/.claude`, verified live via `strings` on this authoring
 * host's installed `claude` binary — no `--help`-documented flag exists for
 * it, so it is confirmed the same way a prior task in this file already
 * disclosed `codex`/`gemini`'s env-var names as convention rather than
 * `--help` text: read directly off the vendor's own shipped artifact) holds
 * an OAuth-authenticated session's credential. `isolation.md` §1's HOME deny
 * rule denies this path unconditionally (it is a subpath of the real
 * `HOME`) — exactly the boundary this task must NOT widen (per this task's
 * own Traps section) — so a confined `claude` session, which authenticates
 * by subscription and nothing else, needs a scoped COPY staged
 * somewhere the profile already grants access to, never a new grant onto
 * this real path.
 */
const OAUTH_CREDENTIAL_FILE_NAME = '.credentials.json'

/** Real read — `null` on any failure (file absent, unreadable, or any other I/O error), never throws. The one case this function exists to make injectable: a test can assert staging behavior without a real OAuth session on the test host. */
function readRealOAuthCredentialFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Resolves the real, unconfined directory holding a dispatched vendor's
 * OAuth session credential — `sourceEnv.CLAUDE_CONFIG_DIR` when the parent
 * process itself already overrides it, else `<realHome>/.claude`, Claude's
 * own documented default. Exported so a caller/test can name the exact
 * source path this module will look for `.credentials.json` under, without
 * duplicating the same two-branch default logic.
 */
export function resolveOAuthConfigSourceDir(
  sourceEnv: Readonly<Record<string, string | undefined>>,
  realHome: string
): string {
  return sourceEnv.CLAUDE_CONFIG_DIR ?? join(realHome, '.claude')
}

/**
 * O1: stages a scoped COPY of the OAuth session credential — never the real
 * file, never a grant onto the real file's real location — into
 * `scratchTmpDir` (a directory `resolveWorkerBoundaryLaunch` already grants
 * full read+write, so staging here needs no new profile grant at all). The
 * confined child is then launched with `CLAUDE_CONFIG_DIR` repointed at the
 * returned `configDir`, so it authenticates against the staged copy instead
 * of ever reading the real path. `null` when the source file does not
 * exist — an API-key-only host, or a genuinely unauthenticated one; either
 * way this function's job is only "stage what's there," never to decide
 * whether a missing credential should refuse the dispatch (that is O2,
 * `dispatchRole`'s own pre-spawn check).
 */
export function stageOAuthCredential(
  sourceEnv: Readonly<Record<string, string | undefined>>,
  realHome: string,
  scratchTmpDir: string,
  deps: Pick<WorkerBoundaryDeps, 'readOAuthCredentialFile' | 'readClaudeKeychainCredential'> = {}
): { configDir: string } | null {
  const sourceConfigDir = resolveOAuthConfigSourceDir(sourceEnv, realHome)
  const readFile = deps.readOAuthCredentialFile ?? readRealOAuthCredentialFile
  const readKeychain = deps.readClaudeKeychainCredential ?? readRealClaudeKeychainCredential
  // The file wins where a host has one (a Linux host signs in that way);
  // the Keychain is the route on a Mac, where Claude Code writes no file.
  const contents =
    readFile(join(sourceConfigDir, OAUTH_CREDENTIAL_FILE_NAME)) ?? claudeLoginFromKeychainPayload(readKeychain())
  if (contents === null) return null
  const stagedConfigDir = join(scratchTmpDir, 'claude-config')
  mkdirSync(stagedConfigDir, { recursive: true })
  writeFileSync(join(stagedConfigDir, OAUTH_CREDENTIAL_FILE_NAME), contents, { mode: 0o600 })
  return { configDir: stagedConfigDir }
}

/**
 * Builds a confined child's environment from an explicit allowlist —
 * `sourceEnv`'s own `WORKER_ENV_ALLOWLIST_KEYS` values, plus every entry in
 * `attribution` (dispatch's own `VINAYA_RUN_ID`/`VINAYA_ROLE`/`VINAYA_TASK`/
 * `VINAYA_ROUND` — the "scoped broker channel" a worker needs to
 * authenticate itself to `broker.ts`'s `authenticateWorkerInvocation`, see
 * that module's own doc) — NEVER `{ ...sourceEnv }`. This is the same
 * discipline `buildCheckEnv` already applies; `isolation.md` §1's Broker row
 * states the requirement generally: "every value the Broker hands through is
 * named, not spread." A value in `attribution` always wins over the same key
 * read from `sourceEnv`'s allowlist (there is no overlap today —
 * `VINAYA_*` names are not in `WORKER_ENV_ALLOWLIST_KEYS` — but a future
 * caller should not have to reason about which side wins).
 *
 * There is deliberately no per-vendor passthrough parameter: the allowlist
 * is the whole list. The only keys this ever carried were API keys, and no
 * agent authenticates with one — a subscription login reaches the confined
 * child as a staged file the profile grants (`stageOAuthCredential`, the
 * task-scoped `CODEX_HOME`), never as a credential value on its
 * environment.
 */
export function buildWorkerEnv(
  sourceEnv: Readonly<Record<string, string | undefined>>,
  attribution: Readonly<Record<string, string | undefined>>
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const key of WORKER_ENV_ALLOWLIST_KEYS) {
    if (sourceEnv[key] !== undefined) env[key] = sourceEnv[key]
  }
  return { ...env, ...attribution }
}

// --- host detection (O3) ----------------------------------------------------

export type WorkerBoundaryHostInfo = {
  platform: string
  sandboxExecExecutable: boolean
}

/** Real detection — `isolation.md` §3's own supported-host statement: Darwin, with `/usr/bin/sandbox-exec` present and executable. Never cached: a caller that wants a stable answer across one dispatch reads it once and threads the result, exactly as `isSandboxSupported` (`isolation-probe.ts`) is re-invoked fresh by its own tests rather than memoized. */
function detectRealHost(): WorkerBoundaryHostInfo {
  const platform = process.platform
  let sandboxExecExecutable = false
  if (platform === 'darwin') {
    try {
      accessSync('/usr/bin/sandbox-exec', fsConstants.X_OK)
      sandboxExecExecutable = true
    } catch {
      sandboxExecExecutable = false
    }
  }
  return { platform, sandboxExecExecutable }
}

export type WorkerBoundaryDeps = {
  detectHost: () => WorkerBoundaryHostInfo
  /**
   * O1: reads the OAuth session credential file at an already-resolved
   * source path (`resolveOAuthConfigSourceDir(...)/.credentials.json`),
   * returning its contents or `null` when absent/unreadable — never throws.
   * Injectable so `stageOAuthCredential`'s behavior is provable without a
   * real OAuth session on the test host, the same posture `detectHost`
   * already takes for the Darwin/`sandbox-exec` check above. Optional —
   * every existing caller/test that only ever exercised `detectHost` (from
   * before this task) keeps compiling unchanged; an omitted entry falls
   * back to the real file read.
   */
  readOAuthCredentialFile?: (path: string) => string | null
  /** Reads Claude Code's Keychain login (`readRealClaudeKeychainCredential`); `null` when absent. Injectable so staging is provable without a real Keychain entry. */
  readClaudeKeychainCredential?: () => string | null
  readCodexKeychainCredential?: (codexHome: string) => string | null
  runCodexLoginWithAccessToken?: (input: {
    binaryPath: string
    codexHome: string
    accessToken: string
  }) => { ok: true } | { ok: false; reason: string }
  runCodexAuthPreflight?: (input: {
    binaryPath: string
    codexHome: string
    cwd: string
    realHome: string
  }) => CodexAuthPreflightResult
  runCodexPluginInstall?: (input: {
    binaryPath: string
    codexHome: string
    marketplaceDir: string
  }) => { ok: true } | { ok: false; reason: string }
  /**
   * O1: the active Apple developer directory `xcode-select -p` reports
   * (`/Library/Developer/CommandLineTools` on a Command-Line-Tools host,
   * `/Applications/Xcode.app/Contents/Developer` with full Xcode), or `null`
   * when `xcode-select` is absent/failing, off darwin, or names a path that
   * does not exist. Resolved at launch, never hardcoded. Injectable so a
   * Linux test host can assert the profile's read+exec grant on it without a
   * real Mac, the same posture `detectHost` already takes.
   */
  resolveDeveloperDir?: () => string | null
  /**
   * Ruling 986-1: the real install `bin/` of the `node` the
   * task-tools MCP server's registration starts (`resolveRealNodeExecDir`),
   * or `null` when `node` is absent/unresolvable. Resolved fresh at launch
   * and `realpath`'d, never hardcoded — a confined session that could not
   * exec `node` crashed starting the MCP server. Injectable so a single test
   * host can assert the profile's read+exec grant on BOTH a Homebrew-style
   * (`/opt/homebrew/Cellar/node/<v>/bin`) and an nvm-style
   * (`~/.nvm/versions/node/<v>/bin`) install directory, the same posture
   * `resolveDeveloperDir` already takes.
   */
  resolveNodeExecDir?: () => string | null
}

export const REAL_WORKER_BOUNDARY_DEPS: WorkerBoundaryDeps = {
  detectHost: detectRealHost,
  readOAuthCredentialFile: readRealOAuthCredentialFile,
  readClaudeKeychainCredential: readRealClaudeKeychainCredential,
  readCodexKeychainCredential: readRealCodexKeychainCredential,
  runCodexLoginWithAccessToken: runRealCodexLoginWithAccessToken,
  runCodexAuthPreflight: runRealCodexAuthPreflight,
  runCodexPluginInstall: runRealCodexPluginInstall,
  resolveDeveloperDir: resolveRealDeveloperDir,
  resolveNodeExecDir: resolveRealNodeExecDir
}

/** `true` only on a host `isolation.md` §3 actually names as supported — Darwin, `sandbox-exec` present. Injectable (`deps`) so a test can assert `dispatchRole`'s fail-closed wiring without needing a real macOS host — see `apps/cli/tests/lib/dispatch/worker-boundary.test.ts`. */
export function isWorkerBoundaryAvailable(deps: WorkerBoundaryDeps = REAL_WORKER_BOUNDARY_DEPS): boolean {
  const host = deps.detectHost()
  return host.platform === 'darwin' && host.sandboxExecExecutable
}

// --- the profile (O1, O2) ---------------------------------------------------

/** Escapes a value for a Seatbelt profile's own string-literal syntax — identical rule to `isolation-probe.ts`'s `escapeSbString`, re-implemented per this module's own header doc. */
function escapeSbString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function sbLiteral(value: string): string {
  return `"${escapeSbString(value)}"`
}

function sbSubpathAllows(operations: string, dirs: readonly string[]): string {
  if (dirs.length === 0) return ''
  const rules = dirs.map((d) => `(subpath ${sbLiteral(d)})`).join('\n    ')
  return `(allow ${operations}\n    ${rules})`
}

/** `sbSubpathAllows`'s own `(deny ...)` counterpart — O3's agent-configuration carve-out (below) is the one caller: a `(subpath ...)` DENY placed after `readWriteDirs`'s own allow wins for exactly these paths, Seatbelt's own later-rule-wins-for-the-same-operation ordering, the same way `writableFiles`/the Keychain denial already rely on it. */
function sbSubpathDenies(operations: string, dirs: readonly string[]): string {
  if (dirs.length === 0) return ''
  const rules = dirs.map((d) => `(subpath ${sbLiteral(d)})`).join('\n    ')
  return `(deny ${operations}\n    ${rules})`
}

/**
 * `(literal ...)`, never `(subpath ...)` — round 4 review, BLOCKER fix: a
 * directory a confined role must be able to TRAVERSE INTO (so the kernel
 * can look up/create a specific already-known child path beneath it) but
 * never list or read the contents of. `subpath` is recursive by
 * construction (it would grant full read of every sibling entry
 * underneath); `literal` matches only the exact given path — verified live
 * on this host: with only this rule on a directory's own literal path, a
 * confined child can `fs.mkdirSync`/`fs.writeFileSync` a NAMED child path
 * beneath it (Node's own recursive `mkdirSync` needs no more), but `ls` on
 * that directory and reading a DIFFERENT, sibling child's file both still
 * fail with a real permission denial, not just "not found" — see
 * `resolveWorkerBoundaryLaunch`'s own doc comment on `vinayaWritableDirs`
 * for why this exists.
 */
function sbLiteralMetadataAllows(dirs: readonly string[]): string {
  if (dirs.length === 0) return ''
  const rules = dirs.map((d) => `(literal ${sbLiteral(d)})`).join('\n    ')
  return `(allow file-read-metadata\n    ${rules})`
}

/** `(literal ...)`, never `(subpath ...)` — round 5 review, CRITICAL fix: grants full read+write on exact file paths only, never their containing directory, so a directory shared with sibling tasks'/roles' own files (`outboxPathFor`/`resumeRecordPathFor`'s own naming convention) never exposes those siblings. See `writableFiles`'s own doc comment on `buildWorkerSandboxProfile`. */
function sbLiteralAllows(operations: string, files: readonly string[]): string {
  if (files.length === 0) return ''
  const rules = files.map((f) => `(literal ${sbLiteral(f)})`).join('\n    ')
  return `(allow ${operations}\n    ${rules})`
}

/**
 * Renders the real launch's Seatbelt profile — same `(deny default)` plus
 * `(import "system.sb")` baseline the probe's own fixture uses
 * (`isolation.md` §3, item 2), widened in exactly three places a real
 * Worker/Reviewer genuinely needs beyond the probe's own narrower proof:
 *
 * 1. **Process-exec** is allowed under `execAllowDirs` (the target worktree,
 *    the runtime interpreter's own install dir, and whatever standard
 *    toolchain directories the caller resolved as actually present on this
 *    host — `git --exec-path`, `/usr/bin`, `/bin`, etc.) rather than a
 *    single literal binary. A real Worker needs to run its own declared
 *    toolchain (git, its build/test/lint commands); the probe never does.
 *    This does NOT reopen the credential-helper gap the probe's own narrow
 *    allowlist closed: a copy of a credential helper executed from inside
 *    an allowed directory can still exec, but the ACTUAL secret it would
 *    fetch lives behind `securityd`/`trustd` over mach IPC, and the
 *    `mach-lookup` denial below blocks that regardless of which binary (or
 *    which copy of one) attempts the call — the same "closes the route at
 *    the OS level, not by naming binaries" reasoning `isolation.md` §3 item
 *    3 already applies to the Keychain check. `credentialHelperDenyLiterals`
 *    additionally names any concretely-resolved helper binary (e.g.
 *    `git --exec-path`'s own `git-credential-osxkeychain`) for defense in
 *    depth, layered on top of, never instead of, the mach-lookup denial.
 * 2. **Network-outbound is allowed only on ports 80/443**, not denied
 *    outright and not left wide open either — a real Worker must reach the
 *    model runtime endpoint to keep functioning as an agent (`isolation.md`
 *    §1, Worker row's own "Permitted operations"), and typically its own
 *    package registry, both of which are plain HTTP(S). The SSH-agent
 *    socket is denied specifically regardless (a unix-socket rule, disjoint
 *    from the tcp port rules), matching the probe's own documented posture
 *    for check 5. **What this does and does not close (round 3 security
 *    review, HIGH):** a staged subscription credential (the scoped
 *    `CLAUDE_CONFIG_DIR` copy, the task-scoped `CODEX_HOME`) is reachable
 *    by any subprocess a
 *    dispatched agent runs, and Seatbelt confinement has no concept of
 *    "which process in the tree may use this socket" — only which
 *    destinations the WHOLE tree may reach. Restricting to 80/443 closes
 *    every non-HTTP(S) exfiltration channel (a raw TCP beacon on an
 *    arbitrary port, DNS tunneling over a raw UDP socket, relaying over a
 *    non-standard port) but does NOT and cannot close an HTTPS POST to an
 *    attacker-controlled host on port 443 — that is indistinguishable, at
 *    this layer, from the legitimate model-runtime call the confined
 *    process must be allowed to make. Closing that specific gap needs a
 *    destination check ABOVE the port number (a hostname or IP allowlist),
 *    and this task verified LIVE that Seatbelt's own `remote` filter cannot
 *    express one on this host: `(remote tcp "example.com:443")` and
 *    `(remote ip "<literal IP>:443")` both fail to compile with
 *    `sandbox-exec: host must be * or localhost in network address` — the
 *    grammar accepts only the wildcard or the loopback name, never an
 *    arbitrary hostname or IP literal. This is the concrete, verified
 *    reason Apple's own recommendation (item 1's `secure-deployment`
 *    citation) is an EGRESS PROXY, not a sandbox-profile allowlist: a proxy
 *    is the only place that can actually inspect and gate the destination,
 *    and building one remains the deliberately deferred, separate,
 *    task-sized item already named above — this finding does not change
 *    that scoping, it replaces "not verified live" with a live-verified
 *    negative result.
 * 3. **`HOME` is not replaced with a synthetic directory.** The real launch
 *    sets the child's `HOME` env value to the genuine home path (so any tool
 *    that constructs a `$HOME/.something` path resolves predictably) while
 *    the PROFILE still denies file access to that real home path except for
 *    the caller's own named `readOnlyDirs`/`readWriteDirs`. The env value
 *    and the filesystem permission are independent: Seatbelt enforces the
 *    latter regardless of what `$HOME` merely says.
 *
 * `readOnlyDirs` (round 2 review, CRITICAL/MAJOR) is a directory the confined
 * role must be able to READ but never write: today, only a round-1
 * Developer's own repo root (it needs to read doctrine/code before its own
 * `git worktree add` has even run, but must never be able to rewrite
 * `vinaya.config.json` — the trusted Controller's own `loadConfig()`
 * re-reads that file live, uncached, on every later dispatch).
 * `GLOBAL_VINAYA_HOME` is deliberately NOT a member of this list (round 4
 * review, HIGH: it previously was, granting blanket `file-read*` over
 * `config.json` plus every other task's and repo's state under it) — nothing
 * inside the sandbox needs to read it wholesale; the controller's own
 * global-config fallback in `loadConfig()` runs unsandboxed, before any
 * child is ever spawned. `readWriteDirs` stays the narrower, per-purpose
 * write surface: the confined role's own EXCLUSIVE workspace (a
 * post-bootstrap worktree, a Reviewer's own scratch copy) or specific named
 * subpaths a bootstrap dispatch's own tooling needs to write (`.git`,
 * `.worktrees` — never the whole repo), plus the scratch tmp dir and
 * `GLOBAL_VINAYA_HOME`'s own caller-scoped, repo-specific log/resume
 * subpaths (round 4 review, BLOCKER: scoped to THIS dispatch's own repo,
 * never a bare top-level name — see
 * `WorkerBoundaryLaunchOpts.vinayaHomeWritableSubdirs`'s own doc comment;
 * never `config.json`).
 */
export function buildWorkerSandboxProfile(opts: {
  realHome: string
  readOnlyDirs: readonly string[]
  readWriteDirs: readonly string[]
  /**
   * Round 4 review, BLOCKER fix: the immediate parent of a NESTED
   * `readWriteDirs` entry (e.g. a caller-named, repo-scoped log-queue
   * subdirectory, two levels below `GLOBAL_VINAYA_HOME`) — granted
   * `file-read-metadata` only (`(literal
   * ...)`, never `(subpath ...)`), enough for the kernel to resolve/create
   * the already-known child path beneath it without granting recursive read
   * of whatever ELSE lives there (see `sbLiteralMetadataAllows`'s own doc
   * comment). Optional — a caller whose `readWriteDirs` are all one level
   * below an already-`readOnlyDirs`/`realHome`-adjacent ancestor needs none.
   */
  metadataOnlyDirs?: readonly string[]
  /**
   * Round 5 review, CRITICAL fix: exact file paths — never their containing
   * directory — granted `file-read*`/`file-write*` via `(literal ...)`.
   * `dispatch.ts`'s own outbox line and resume record for THIS dispatch
   * both live in a directory shared by every OTHER task's and role's own
   * outbox line / resume record for the same repo (`outboxPathFor`'s and
   * `resumeRecordPathFor`'s own naming convention, neither of which this
   * task's `## Surface` permits restructuring). Granting that directory
   * itself (the pre-round-5 approach, `readWriteDirs`) therefore handed a
   * confined role read+write over every sibling task's audit-log line and
   * every sibling role's live vendor `resumeId` — verified live on this
   * host to include another concurrently-running review's own resume
   * record. A `(literal ...)` rule matches only the named path, the same
   * "resolve/create a specific already-known child without granting
   * recursive access to whatever else lives beside it" property
   * `metadataOnlyDirs` already proves live for directory children — placed
   * AFTER the "close every other writable path" rule below so this later,
   * more specific allow wins for exactly these paths (Seatbelt evaluates
   * same-operation rules in profile order); their parent directory still
   * needs only `metadataOnlyDirs`' own traversal grant, passed by the
   * caller alongside this list.
   */
  writableFiles?: readonly string[]
  /**
   * O3: absolute directories to keep WRITE-DENIED even though they sit
   * inside `readWriteDirs` (the confined role's own worktree) — an agent's
   * own configuration directories (`.codex/`, `.agents/`) when the task's
   * Surface does not name them, so a dispatched Codex session cannot
   * rewrite its own MCP registration or plugin/skill configuration unless
   * the brief's own work is exactly that. Still READABLE (only `file-write*`
   * is denied, never `file-read*`) — the caller (`resolveWorkerBoundaryLaunch`)
   * passes an empty list when the Surface covers them, so no extra rule is
   * added at all and the broad `readWriteDirs` grant applies unmodified.
   * Rendered via `sbSubpathDenies`, placed AFTER `readWriteDirs`'s own
   * allow so this later, more specific deny wins for exactly these paths —
   * the identical "later same-operation rule wins" ordering `writableFiles`
   * (above) already relies on for its own, narrower carve-out.
   */
  protectedSubpaths?: readonly string[]
  execAllowDirs: readonly string[]
  runtimeDir: string
  sshSockCanon: string
  credentialHelperDenyLiterals: readonly string[]
}): string {
  const readAllowDirs = Array.from(new Set([opts.runtimeDir, ...opts.execAllowDirs]))
  const denyHelperRules = opts.credentialHelperDenyLiterals
    .map((p) => `(deny process-exec (literal ${sbLiteral(p)}))`)
    .join('\n')

  return [
    '(version 1)',
    ';; Generated by apps/cli/src/lib/worker-boundary.ts — never hand-edited, never checked in with placeholders.',
    '(deny default)',
    '(import "system.sb")',
    '',
    ';; file-read-metadata, UNCONDITIONALLY (round 2 review, MAJOR — a Node.js-',
    ';; hosted confined process crashes at startup before running any code).',
    ';; A real `node` binary walks from its own script path up through EVERY',
    ";; ancestor directory to the filesystem root, `lstat`'ing each one (module",
    ';; resolution and its own `realpath` of the entry script) — live-reproduced',
    ';; on this host: with no rule naming any ancestor of `allowedDir`/`runtimeDir`',
    ";; (e.g. `/private`, a `subpath`-only ancestor of macOS's own tmp layout),",
    ';; `node <script>` fails immediately with `EPERM: operation not permitted,',
    "; lstat '/private'` — before the confined role, whatever it is, ever runs a",
    ";; line of its own code. This never reproduced against `bun` (this profile's",
    ';; own prior live tests all pass a `bun`-hosted `binaryPath`, masking the',
    ';; gap) but would hit any Node-hosted vendor CLI — `codex`/`gemini` are',
    ';; commonly shipped as `node`-shebang npm packages, unlike `claude`, which',
    ';; is a native Mach-O binary on this host and unaffected either way.',
    ';; `file-read-metadata` is a SEPARATE Seatbelt operation from `file-read*`',
    '; (content) — granting it exposes only existence/size/permissions/mtime,',
    ';; never file CONTENTS; verified live that the real HOME/Keychain/OAuth-',
    ';; credential `file-read*` denies below are completely unaffected by this',
    ';; rule (a confined read of a real credential file still fails `EPERM`',
    ';; with this rule present). Scoping this to only the specific ancestor',
    ";; directories each dispatch's own `allowedDir`/`execAllowDirs`/`vinayaHomeDir`",
    ';; actually need would require enumerating every possible ancestor of an',
    ';; unpredictable, host-varying allowlist (a git/bun/homebrew install path,',
    ";; the vendor binary's own real location) — intractable and no more secure",
    ';; than this single blanket metadata-only allow, since metadata alone lets',
    ';; a confined process learn only that SOME path exists, not what it holds.',
    '(allow file-read-metadata)',
    '',
    ";; Process-exec: the confined role's own worktree, the runtime interpreter's",
    ';; install dir, and whatever standard toolchain directories were resolved as',
    ";; present on this host — see this function's own doc comment, item 1.",
    sbSubpathAllows('file-read*', readAllowDirs),
    sbSubpathAllows('process-exec', opts.execAllowDirs),
    '',
    ';; process-fork (round 3 review, F1 live-enforcement testing): a SEPARATE',
    ';; Seatbelt operation from process-exec, denied by `(deny default)` like',
    ";; everything else unless named — found live, by this task's own new",
    ';; live `sandbox-exec` test, only once a real confined shell actually',
    ';; tried a subshell/pipeline: every prior test here asserted profile TEXT',
    ';; only, so a confined role that could exec its own toolchain still could',
    ';; not fork to run ANY of it (`bash: fork: Operation not permitted`) —',
    ';; the single most basic thing "run its own declared toolchain" (item 1',
    ";; above) requires, silently broken since this profile's first version.",
    ';; No filter exists for it (fork has no path/target argument the way',
    ';; exec and file operations do) — it is an unconditional allow, scoped',
    ";; by every OTHER rule in this profile exactly as the exec'd/forked",
    ';; child itself is.',
    '(allow process-fork)',
    '',
    ';; HOME confinement: deny the real HOME entirely, then carve out',
    ';; read-only access to directories this role must READ but never write,',
    ';; and read+write for directories it actually owns or has a named write',
    ";; target inside (see this function's own doc comment on the two lists).",
    `(deny file-read* file-write*\n    (subpath ${sbLiteral(opts.realHome)}))`,
    sbLiteralMetadataAllows(opts.metadataOnlyDirs ?? []),
    sbSubpathAllows('file-read*', opts.readOnlyDirs),
    sbSubpathAllows('file-read* file-write*', opts.readWriteDirs),
    '',
    ';; Filesystem write confinement, PART 2: close every OTHER writable path',
    ';; the baseline would otherwise leave open (/tmp, /var, anywhere else a',
    ';; bare process can write, AND readOnlyDirs above) — "read/write inside',
    ';; its own worktree" is the ceiling, not one of several open paths.',
    '(deny file-write*',
    '  (require-all',
    opts.readWriteDirs.map((d) => `    (require-not (subpath ${sbLiteral(d)}))`).join('\n'),
    (opts.writableFiles ?? []).map((f) => `    (require-not (literal ${sbLiteral(f)}))`).join('\n'),
    '  ))',
    '',
    ';; Round 5 review, CRITICAL fix: exact-file write grants — see this',
    ";; function's own doc comment on `writableFiles`. Placed after the",
    "; 'close every other writable path' rule above so this more specific,",
    ';; later rule wins for exactly these paths, matching the ordering',
    ';; `sbLiteralMetadataAllows` already relies on for directory children.',
    sbLiteralAllows('file-read* file-write*', opts.writableFiles ?? []),
    '',
    ";; O3: an agent's own configuration paths stay write-denied even though",
    ";; they sit inside `readWriteDirs` above, unless the caller's own",
    ";; `protectedSubpaths` list is empty (the task's Surface covers them) —",
    ";; see `protectedSubpaths`'s own doc comment. Still readable; only",
    ';; `file-write*` is named. Placed after every write-grant rule above so',
    ';; this later, more specific deny wins for exactly these paths.',
    sbSubpathDenies('file-write*', opts.protectedSubpaths ?? []),
    '',
    ';; Network (round 3 security review, HIGH): denied by default, allowed',
    ';; ONLY on ports 80/443 — a real Worker must reach the model runtime',
    ';; endpoint to keep functioning as an agent (isolation.md §1, Worker',
    ';; row), and typically its own package registry, both plain HTTP(S).',
    ';; The ssh-agent socket is denied too (a unix-socket rule, independent',
    ';; of the tcp port rules above it). This closes every non-HTTP(S)',
    ';; exfiltration channel (a raw-socket beacon, DNS tunneling over a raw',
    ";; UDP socket, SSH relay, any other port) but — see this function's own",
    ';; doc comment, item 2 — CANNOT close an HTTPS POST to an',
    ';; attacker-controlled host on port 443: this task verified LIVE that',
    ";; Seatbelt's `remote` filter accepts only `*`/`localhost` as the host",
    ';; component (`sandbox-exec: host must be * or localhost in network',
    ';; address` on an attempted hostname or IP literal), so no allowlist of',
    ';; specific destinations can be expressed at this layer at all. Closing',
    ";; that gap needs an egress-scoping proxy (Apple's own recommendation,",
    ";; item 1's citation) — deliberately deferred, a separate, larger,",
    ';; task-sized item, not silently built or silently skipped here.',
    '(deny network-outbound)',
    '(allow network-outbound (remote tcp "*:443"))',
    '(allow network-outbound (remote tcp "*:80"))',
    `(deny network-outbound\n  (remote unix-socket (path-literal ${sbLiteral(opts.sshSockCanon)})))`,
    '',
    ';; DNS resolution (round 4 review, BLOCKER): a hostname lookup never opens',
    ';; a raw UDP/TCP socket itself — it goes through mDNSResponder over a',
    ';; local unix-socket connection plus mach IPC. Verified LIVE on this host:',
    ';; with only the two tcp port rules above and no route to the resolver, a',
    ';; confined `curl https://example.com` fails at `getaddrinfo` with',
    ';; `Could not resolve host` before it ever reaches the network-outbound',
    ';; rule — no confined dispatch could resolve any model-runtime hostname.',
    ';; Adding this restores resolution without widening the tcp allowlist:',
    ';; the resolver process itself performs the actual DNS query on the',
    ";; caller's behalf; the confined child only talks to it locally.",
    '(allow network-outbound',
    '  (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
    '(allow mach-lookup',
    '  (global-name "com.apple.dnssd")',
    '  (global-name "com.apple.mDNSResponder")',
    '  (global-name "com.apple.mDNSResponderUnix"))',
    '',
    ';; Keychain: file access AND the mach-lookup route Keychain Services',
    ";; itself talks to securityd/trustd through — see this function's own doc",
    ';; comment, item 1, for why this alone (not the process-exec allowlist)',
    ';; is what actually closes the credential-helper route.',
    `(deny file-read* file-write*\n    (subpath ${sbLiteral(join(opts.realHome, 'Library', 'Keychains'))})\n    (subpath "/Library/Keychains")\n    (subpath "/System/Library/Keychains"))`,
    '(deny mach-lookup',
    '  (global-name "com.apple.securityd")',
    '  (global-name "com.apple.securityd.xpc")',
    '  (global-name "com.apple.security.agent")',
    '  (global-name "com.apple.trustd")',
    '  (global-name "com.apple.SecurityServer"))',
    denyHelperRules,
    '',
    ';; Parent process: deny signaling or introspecting any OTHER process —',
    ';; `(target others)` is load-bearing, not cosmetic (isolation.md §3, item 6):',
    ";; an unscoped `(deny process-info*)` also blocks the confined runtime's own",
    ';; self-introspection at startup.',
    '(deny signal)',
    '(deny process-info* (target others))',
    ''
  ].join('\n')
}

// --- resolving a real launch (O1) -------------------------------------------

/**
 * `tmpDir` (round 2 security review, HIGH): the confined child's own
 * `TMPDIR`/`TMP`/`TEMP` must be repointed at this exact path — the ONE
 * directory this profile grants read+write beyond `allowedDir` for a
 * scratch temp use (`scratchTmpDir`, below). `buildWorkerEnv`'s own
 * `WORKER_ENV_ALLOWLIST_KEYS` passes `TMPDIR` through from the parent
 * unmodified, which still names the real host temp base — a path this
 * profile never grants, so a confined `mkdir -p "$TMPDIR/x"` (a pattern
 * common across `bun install`/`npm`/most POSIX toolchains) failed with a
 * real permission denial, live-reproduced on this host. The caller
 * (`dispatch.ts`) must override `TMPDIR`/`TMP`/`TEMP` to this value in the
 * env it actually spawns with — this type only carries the value out;
 * `resolveWorkerBoundaryLaunch` has no env-construction role of its own.
 */
/**
 * `oauthConfigDir` (O1): non-`null` only when `stageOAuthCredential`
 * was requested AND a real OAuth session credential was found to stage —
 * the caller (`dispatch.ts`) sets the confined child's `CLAUDE_CONFIG_DIR`
 * to this value so it authenticates against the staged copy, never the real
 * `<realHome>/.claude`. `null` either when staging was never requested, or
 * when it was and nothing was there to stage (an API-key-only or
 * unauthenticated host) — `dispatchRole`'s own O2 pre-spawn check is what
 * turns a `null` here, combined with no vendor API key either, into a
 * refusal; this type only reports what was found.
 */
export type WorkerBoundaryLaunch = {
  command: string
  args: string[]
  cleanup: () => void
  tmpDir: string
  oauthConfigDir: string | null
  codexHomeDir: string | null
  codexAccessToken: string | null
  /** O2: `resolveGitFirstPath`'s own result for this launch's host — the caller (`dispatch.ts`) overrides the confined child's `PATH` env with this value, so a bare `git` resolves the real binary ahead of the `/usr/bin/git` shim. `sourceEnv.PATH` unchanged when there is no developer dir to prepend. */
  pathOverride: string | undefined
}

export type WorkerBoundaryResolution = { ok: true; launch: WorkerBoundaryLaunch } | { ok: false; reason: string }

/** Standard toolchain directories checked for presence on this host — never assumed. Only an existing directory is added to the profile's own `execAllowDirs`/read-allow list. */
const CANDIDATE_SYSTEM_BIN_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/opt/homebrew/bin']

/**
 * O1: the active Apple developer directory behind macOS's Command Line Tools
 * shims. `/usr/bin/git` (and every other `/usr/bin` developer-tool stub) is a
 * thin `xcrun` shim that dlopen's `/Library/Developer/CommandLineTools/usr/lib/libxcrun.dylib`
 * and re-execs the real tool from UNDER this directory — so a confined role
 * granted `/usr/bin` exec but not this directory crashes before `git` ever
 * runs with "xcrun: error: unable to load libxcrun (… file system sandbox
 * blocked open())". Resolved fresh from `xcode-select -p` at every launch
 * (never one hardcoded path — a host may point it at full Xcode or at the
 * Command Line Tools), `realpath`'d, and returned only when it actually
 * exists. `null` off darwin, or when `xcode-select` is absent, errors, or
 * names a missing path — the profile then simply grants nothing extra, the
 * same best-effort posture `resolveGitExecPath` below already takes. Granted
 * read AND exec (never write) by `resolveWorkerBoundaryLaunch` placing it in
 * `execAllowDirs`, which both the exec-allow and the read-allow rules draw
 * from.
 */
function resolveRealDeveloperDir(): string | null {
  if (process.platform !== 'darwin') return null
  try {
    const out = execFileSync('xcode-select', ['-p'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return out.length > 0 && existsSync(out) ? realpathSync(out) : null
  } catch {
    return null
  }
}

/**
 * O2: `<developerDir>/usr/bin` — the directory `resolveRealDeveloperDir`'s
 * own doc comment names as where the REAL `git` (and every other `/usr/bin`
 * developer-tool stub's real target) actually lives on the declared
 * supported host. `null` when there is no developer dir to derive one from.
 */
function developerBinDir(developerDir: string | null): string | null {
  return developerDir ? join(developerDir, 'usr', 'bin') : null
}

/**
 * O2: both vendor adapters' confined child is already granted read+exec on
 * `developerDir` (Claude via `buildClaudeSandboxSettings`'s `filesystem.allowRead`,
 * Codex via `resolveWorkerBoundaryLaunch`'s `execAllowDirs`) — but a grant
 * alone does not make a bare `git` invocation USE the real binary there: PATH
 * order decides which `git` a plain exec resolves, and the real host's
 * ambient PATH still lists `/usr/bin` (the `xcrun` shim) ahead of it. The
 * shim itself still execs fine under either grant, but on first use it
 * `dlopen`s `libxcrun.dylib` and writes an `xcrun` cache under the user's
 * real temp folder — a write outside the worktree/scratch directory either
 * confinement grants, found live on 2026-10-01 and again on 2026-10-03 (this
 * task's own Boundary). Prepending `developerBinDir(developerDir)` to
 * `sourceEnv.PATH` makes a bare `git` resolve the real binary FIRST, so the
 * shim is never reached at all. `undefined`/unchanged when there is nothing
 * to prepend (off darwin, or `xcode-select` unresolved) — the same
 * best-effort posture every other optional grant in this module already
 * takes for a missing `git`/`bun`/developer dir.
 */
export function resolveGitFirstPath(
  sourceEnv: Readonly<Record<string, string | undefined>>,
  developerDir: string | null
): string | undefined {
  const bin = developerBinDir(developerDir)
  if (!bin) return sourceEnv.PATH
  return sourceEnv.PATH ? `${bin}:${sourceEnv.PATH}` : bin
}

/**
 * O2: the two git-configuration paths every confined role must be able to
 * READ, never write, so a plain `git` command inside the worktree still
 * resolves the operator's own identity, aliases and `[include]` directives —
 * `~/.gitconfig` (the file both adapters' own HOME-deny rule previously
 * denied outright) and `~/.config/git` (the XDG config directory, holding a
 * second `config`/`attributes`/`ignore`). Read-only: nothing inside a
 * confined dispatch is trusted to rewrite the operator's own git
 * configuration. Named as two exact paths, never the whole real `HOME` —
 * the same narrow, named-grant discipline every other carve-out in this
 * module already applies to the real home.
 */
export function gitConfigReadOnlyPaths(realHome: string): readonly string[] {
  return [join(realHome, '.gitconfig'), join(realHome, '.config', 'git')]
}

/** O3: the subpaths, relative to a task's own worktree, Claude's own configuration lives at — the Developer's `.mcp.json` registration and its own `.claude/` directory (commands, hooks, settings). */
export const CLAUDE_OWN_CONFIG_SUBPATHS = ['.claude', '.mcp.json'] as const

/** O3: the subpaths, relative to a task's own worktree, Codex's own configuration lives at — its `.codex/` directory and the `.agents/` tree this repo's own skill/plugin emitters write into. */
export const CODEX_OWN_CONFIG_SUBPATHS = ['.codex', '.agents'] as const

/** `CLAUDE_OWN_CONFIG_SUBPATHS`/`CODEX_OWN_CONFIG_SUBPATHS` for the named agent, or `[]` for a vendor with no agent-native configuration path of its own (`gemini` today). */
export function agentOwnConfigSubpaths(agent: string): readonly string[] {
  if (agent === 'claude') return CLAUDE_OWN_CONFIG_SUBPATHS
  if (agent === 'codex') return CODEX_OWN_CONFIG_SUBPATHS
  return []
}

/**
 * O3: the ABSOLUTE paths, inside `worktreeDir`, a confined dispatch's own
 * write grant must keep DENIED — this agent's own configuration subpaths,
 * UNLESS `surfaceCovered` says the task's own Surface `in:` globs already
 * name them as this task's own work, in which case `[]` (nothing extra
 * denied; the worktree's own blanket grant applies unmodified). The one
 * function both adapters' dispatch wiring calls to resolve the same caller
 * input (`DispatchOpts.agentConfigSurfaceCovered`) into the shape each
 * adapter's own write-gating mechanism takes — `WriteAccessScope.protectedSubpaths`
 * for Claude, `WorkerBoundaryLaunchOpts.protectedSubpaths` for Codex.
 */
export function agentConfigProtectedSubpaths(worktreeDir: string, agent: string, surfaceCovered: boolean): string[] {
  if (surfaceCovered) return []
  return agentOwnConfigSubpaths(agent).map((rel) => join(worktreeDir, rel))
}

/**
 * Principal ruling 1, failure 2: a linked worktree's `.git` is a FILE
 * pointing at this real directory (`<repo>/.git/worktrees/<branch>`), not a
 * directory of its own — every git operation inside the worktree (`status`,
 * `diff`, `log`, the branch-creation push's own `branch -u`) opens it, so a
 * confinement that grants only `worktreeDir` leaves git reporting "fatal:
 * not a git repository" the moment it needs to read or lock anything there.
 * Resolved fresh, from INSIDE `worktreeDir`, the same best-effort way
 * `resolveGitExecPath` below resolves its own binary — `null` on any
 * failure (no `git`, or `worktreeDir` not actually a worktree yet), which
 * simply contributes nothing extra to the grant rather than widening it on a
 * guess.
 */
function resolveGitCommonDir(worktreeDir: string): string | null {
  try {
    const out = execFileSync('git', ['-C', worktreeDir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    return out.length > 0 ? realpathSync(out) : null
  } catch {
    return null
  }
}

/** Best-effort, `null` on any failure — a host with no `git` at all, or whose `git --exec-path` cannot be resolved, simply contributes nothing extra to the allowlist (git itself would then also fail to exec inside the confinement, which is a dispatch-time toolchain problem, never a reason to widen the profile). */
function resolveGitExecPath(): string | null {
  try {
    const out = execFileSync('git', ['--exec-path'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return out.length > 0 ? realpathSync(out) : null
  } catch {
    return null
  }
}

/**
 * Round 5 review, BLOCKER (round 6 fix): a confined role must be able to
 * exec `bun` itself for `bun install`/`bun test` (O1's own build/test-
 * subprocess requirement) and for `writeDispatchSettings`'s
 * `bun "${scriptPath}"` PreToolUse hook command. The round-5 approach
 * (`dirname(process.execPath)`) assumed the dispatcher process is itself
 * bun-hosted — true only for this repo's own source invocation
 * (`bun apps/cli/src/index.ts`). The published, declared-supported entry
 * point (`apps/cli/scripts/build.ts`'s `--target=node` build, shipped with
 * a `#!/usr/bin/env node` shebang, `engines.node >=22.13`) runs under Node,
 * where `process.execPath` is Node's own binary and never contains `bun`
 * at all — silently granting exec over the wrong directory while the real
 * `bun` install (typically under `realHome`, denied elsewhere in this
 * file) stayed unreachable. Resolved the same "never assumed, verified
 * live" way `resolveGitExecPath` above already resolves `git`: a `which`
 * lookup, independent of which runtime hosts the dispatcher process.
 */
function resolveBunExecDir(): string | null {
  try {
    const out = execFileSync('which', ['bun'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return out.length > 0 ? dirname(realpathSync(out)) : null
  } catch {
    return null
  }
}

/**
 * Ruling 986-1: the `node` the task-tools MCP server's own
 * registration starts (`taskToolsServerInvocation`'s `node <bin>` self-host
 * form, and `npx`'s own node too — `adapters.ts`). A confined Claude/Codex
 * session that launches that server used to fail with `EPERM … posix_spawn
 * 'node'`: the `node` on its PATH resolves, through symlinks, to a real
 * binary OUTSIDE every granted directory — Homebrew links
 * `/opt/homebrew/bin/node` into `/opt/homebrew/Cellar/node/<version>/bin/node`
 * (the Cellar `bin/` is NOT in `CANDIDATE_SYSTEM_BIN_DIRS`, so the `/opt/
 * homebrew/bin` grant does not reach it), and nvm puts it under
 * `~/.nvm/versions/node/<version>/bin/node` (inside the otherwise-denied real
 * HOME). Resolved the same "never assumed, verified live via `which`, then
 * `realpath`'d" way `resolveBunExecDir`/`resolveGitExecPath` above resolve
 * their own binaries, so the symlink is followed to the real install `bin/`
 * on either host layout. Granted read AND exec (never write) by
 * `resolveWorkerBoundaryLaunch` placing the result in `execAllowDirs`. `null`
 * on a host with no `node` at all — nothing extra is granted, exactly like a
 * missing `git`/`bun`.
 */
function resolveRealNodeExecDir(): string | null {
  try {
    const out = execFileSync('which', ['node'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return out.length > 0 ? dirname(realpathSync(out)) : null
  } catch {
    return null
  }
}

/** Read-only directories containing the selected macOS executable's dynamic-library closure. */
function resolveRuntimeLibraryDirs(binaryPath: string): string[] {
  if (process.platform !== 'darwin') return []
  const dirs = new Set<string>()
  const siblingLib = join(dirname(dirname(binaryPath)), 'lib')
  if (existsSync(siblingLib)) dirs.add(realpathSync(siblingLib))
  const queue = [binaryPath]
  const seen = new Set<string>()
  while (queue.length > 0 && seen.size < 256) {
    const current = queue.shift()
    if (!current || seen.has(current)) continue
    seen.add(current)
    try {
      const output = execFileSync('/usr/bin/otool', ['-L', current], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
      for (const line of output.split('\n').slice(1)) {
        const dependency = line.trim().split(/\s+/, 1)[0]
        if (!dependency || dependency.startsWith('/usr/lib/') || dependency.startsWith('/System/')) continue
        const dylib = dependency.startsWith('@rpath/') ? join(siblingLib, basename(dependency)) : dependency
        if (!dylib.startsWith('/') || !existsSync(dylib)) continue
        dirs.add(realpathSync(dirname(dylib)))
        const homebrewFormula = dylib.match(/^\/opt\/homebrew\/opt\/([^/]+)\//)?.[1]
        if (homebrewFormula) {
          const formulaConfig = join('/opt/homebrew/etc', homebrewFormula)
          if (existsSync(formulaConfig)) dirs.add(realpathSync(formulaConfig))
        }
        queue.push(realpathSync(dylib))
      }
    } catch {
      // A non-Mach-O dependency contributes no further paths.
    }
  }
  return [...dirs]
}

function resolveSshSockCanon(): string {
  const raw = process.env.SSH_AUTH_SOCK
  if (!raw) return '/nonexistent/vinaya-worker-boundary-no-ssh-sock'
  try {
    return realpathSync(raw)
  } catch {
    return raw
  }
}

export type WorkerBoundaryLaunchOpts = {
  binaryPath: string
  args: readonly string[]
  /** The role's own confined workspace — the target worktree (developer/operator) or the reviewer's own scratch copy (`reviewer-isolation.ts`). Read-only when `bootstrapWritableSubpaths` is given (see that field's own doc); otherwise read+write, the steady-state case. */
  allowedDir: string
  /**
   * ABSOLUTE directory paths a confined role's own later `vinaya`
   * subcommand genuinely needs to READ and WRITE — today, a reviewer's own
   * per-attempt work directory.
   *
   * Absolute, not relative to a single machine-wide root: the directory a
   * task's run writes under is configurable (`runtimeDir`,
   * `apps/cli/src/lib/run-paths.ts`) and can sit anywhere on disk, while
   * the telemetry outbox stays under the Vinaya home — two roots, so one
   * base to resolve against can no longer express both. The caller still
   * owns the scoping (round 4 review, BLOCKER: a bare top-level directory
   * name once granted read+write over every repo's and task's records on
   * the machine, letting a confined Worker forge another task's audit-log
   * line or steal another task's live vendor session id, since the vendor
   * binary sits in this same profile's own exec-allow list). This module
   * stays a generic confinement primitive with no opinion about any
   * directory's internal layout. Never `config.json`, never a whole
   * top-level directory.
   */
  extraWritableDirs: readonly string[]
  /**
   * Round 5 review, CRITICAL fix: ABSOLUTE, exact FILE paths a confined
   * role's own later `vinaya` subcommand genuinely needs to READ and WRITE
   * — today its telemetry outbox line, its own session record, and the
   * documentation-gate log.
   *
   * Exact files, never their containing directory. The round-4 fix scoped
   * those grants to the directory holding them, but that directory was
   * shared by every OTHER task's and role's own records, so a confined
   * Worker could still read a sibling task's audit log or steal a sibling
   * role's live vendor `resumeId` and resume that session directly. Naming
   * the exact file closes that — see `writableFiles` on
   * `buildWorkerSandboxProfile`, which renders these as `(literal ...)`.
   * Use `extraWritableDirs` above for the genuinely directory-scoped case
   * (a reviewer's own work directory); this field is for a single file.
   */
  extraWritableFiles?: readonly string[]
  /**
   * Round 4 review, BLOCKER fix: ABSOLUTE directories a confined dispatch
   * must be able to READ but never write — today, exactly
   * `writeDispatchSettings`'s own output, this task's own `hooks/` directory
   * (`dispatch.ts`), which the TRUSTED controller writes BEFORE resolving
   * this launch and which the confined child then loads via its own
   * `--settings <path>` flag. Found live: no directory carries a grant
   * unless the caller names it here or in `extraWritableDirs`, and the hooks
   * directory was named in neither, so a confined Claude dispatch could not
   * read the settings file it was handed on its own argv — the PreToolUse
   * background-deny hook this task's own brief named a trap to preserve
   * never actually loaded inside the boundary.
   * Read-only, not read+write, deliberately: nothing inside the sandbox
   * ever needs to rewrite this file, and granting write here would reopen
   * the same persistent-tampering class of gap the round-2 CRITICAL fix
   * closed for `vinaya.config.json` — a confined process could otherwise
   * overwrite its own settings file to strip the hook for every later
   * dispatch that reuses this shared, unscoped directory.
   */
  extraReadOnlyDirs?: readonly string[]
  /**
   * O3: ABSOLUTE directories, inside `allowedDir`, to keep write-DENIED even
   * though `allowedDir` itself is otherwise granted read+write — an agent's
   * own configuration directories (Codex's `.codex/`, `.agents/`) when the
   * task's Surface does not name them (the caller resolves that check;
   * this module stays a generic confinement primitive with no opinion of
   * its own about Surface or any directory's internal layout, the same
   * posture `extraWritableDirs`'s own doc comment already states). Omitted
   * or empty (every pre-O3 caller) grants `allowedDir` fully, unmodified —
   * the steady-state case. See `buildWorkerSandboxProfile`'s own
   * `protectedSubpaths` for the rendered Seatbelt rule.
   */
  protectedSubpaths?: readonly string[]
  /**
   * Round-1 Developer bootstrap only (round 2 review, CRITICAL): when given
   * (as directory names relative to `allowedDir`, e.g. `['.git', '.worktrees']`),
   * `allowedDir` itself becomes READ-ONLY and these specific subpaths become
   * the only writable ones inside it — the shared repo checkout a
   * not-yet-worktreed Developer dispatch is confined to must never be
   * rewritable wholesale (it carries `vinaya.config.json`, read live and
   * uncached by the trusted Controller's own `loadConfig()` on every later
   * dispatch, and `aeg-root/roles/*.md` doctrine every future dispatch
   * reads), only the two paths its own `git worktree add` genuinely writes.
   * Omitted (default) grants `allowedDir` full read+write — the steady-state
   * case, where the confined role owns the whole directory outright.
   */
  bootstrapWritableSubpaths?: readonly string[]
  /**
   * O1: when `true`, this resolution attempts
   * `stageOAuthCredential` — reading the real, unconfined
   * `resolveOAuthConfigSourceDir(process.env, realHome)/.credentials.json`
   * and, if it exists, staging a scoped COPY into `scratchTmpDir` (already
   * granted read+write; no new profile grant). The caller decides when this
   * applies — `dispatch.ts` sets it only for `agent === 'claude'`, the one
   * vendor this module knows how to stage a credential for today; this
   * module has no vendor-branching of its own beyond that one shape.
   * `false`/omitted: no staging attempted, `oauthConfigDir` on the resolved
   * launch is always `null`.
   */
  stageOAuthCredential?: boolean
  stageCodexCredential?: boolean
  /**
   * O2: the PERSISTENT, per-task directory this dispatch stages its
   * subscription login and vendor session store into — `claude-config/` for
   * Claude's `CLAUDE_CONFIG_DIR`, `codex-home/` for Codex's `CODEX_HOME`.
   *
   * Unlike `scratchTmpDir` (a fresh `mkdtemp` per dispatch, removed by
   * `cleanup()`), this directory belongs to the TASK, not to one dispatch:
   * the caller (`dispatch.ts`) resolves the SAME path for every dispatch of
   * the same task/role/agent, under the task's own runtime folder — never the
   * real `~/.claude` — so a round-2 resume finds the round-1 session store it
   * continues (closing the "No conversation found with session ID" failure a
   * per-dispatch scratch dir caused by being removed after round 1), and the
   * loop's own end removes it (`dev-review-loop.ts`). It is granted read+write
   * in the profile (the confined child writes its session store here
   * throughout the run) and, crucially, is NOT removed by `cleanup()`.
   *
   * Omitted (every pre-O2 caller and test): all staging falls back to
   * `scratchTmpDir`, the original per-dispatch behavior, unchanged.
   */
  stagedConfigDir?: string
  codexHooksPath?: string | null
  /**
   * The execpolicy `.rules` text (`dispatch.ts`'s
   * `buildCodexExecpolicyRules`) that denies this run's machine-state
   * commands — written verbatim into the staged `CODEX_HOME/rules/`, where
   * Codex discovers it at startup, never the operator's own `~/.codex`.
   * `null`/omitted for `claude`/`gemini` or a role that carries no floor.
   */
  codexExecpolicyRules?: string | null
}

/**
 * Resolves the sandbox-exec-wrapped command for a real dispatch, or a
 * refusal — never a silent unconfined fallback (`isolation.md` §3's own
 * "Refusal conditions"). The caller (`dispatchRole`) is the one place that
 * decides whether a refusal here means the dispatch itself refuses (an
 * unattended start, O3) or is otherwise unreachable — this function only
 * ever answers "can the boundary be established," never "should this
 * dispatch proceed without one."
 */
export function resolveWorkerBoundaryLaunch(
  opts: WorkerBoundaryLaunchOpts,
  deps: WorkerBoundaryDeps = REAL_WORKER_BOUNDARY_DEPS
): WorkerBoundaryResolution {
  if (!isWorkerBoundaryAvailable(deps)) {
    const host = deps.detectHost()
    return {
      ok: false,
      reason:
        `worker boundary unavailable on this host (platform: ${host.platform}, sandbox-exec: ${host.sandboxExecExecutable ? 'present' : 'absent'}) — ` +
        'apps/cli/specs/isolation.md names macOS (Darwin) with /usr/bin/sandbox-exec as the only currently supported mechanism'
    }
  }

  try {
    const realHome = realpathSync(homedir())
    const allowedDirReal = realpathSync(opts.allowedDir)
    // Security review (round 2), HIGH: this MUST be the same resolved value
    // used both to derive `runtimeDir`'s exec-allow grant below AND as the
    // actual `sandbox-exec` exec target — Seatbelt's `process-exec` rule
    // matches the LITERAL path handed to it, before any symlink resolution
    // of its own, live-reproduced: the official macOS installer's own
    // layout (`~/.local/bin/claude` symlinked to
    // `~/.local/share/claude/versions/<version>`, the exact shape
    // `dispatch.ts`'s own `which claude` resolution returns) put the
    // profile's exec-allow rule on the REALPATH'd target directory while
    // the un-realpath'd symlink path was still what got exec'd — denied
    // outright (`execvp() ... Operation not permitted`) before the vendor
    // process ever started, defeating O1 even with a correctly staged
    // credential. Resolving once, here, and using this SAME value for both
    // purposes closes the gap structurally rather than by naming the
    // installer's specific symlink shape.
    const resolvedBinaryPath = realpathSync(opts.binaryPath)
    const runtimeDir = dirname(resolvedBinaryPath)
    const scratchTmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'vinaya-worker-boundary-')))

    // O2: where the subscription login and vendor session store are staged.
    // The PERSISTENT per-task directory when the caller named one (so a
    // round-2 resume finds the round-1 session it continues), else the
    // ephemeral `scratchTmpDir` — the original per-dispatch behavior, which
    // `cleanup()` still removes. Created 0700 and `realpath`'d so the profile
    // grant and the child's own `CLAUDE_CONFIG_DIR`/`CODEX_HOME` resolve to
    // the identical canonical path (the "every substituted path must be
    // canonicalized" discipline §3 states). When separate from
    // `scratchTmpDir`, it is granted read+write below (via
    // `vinayaWritableDirs`) and deliberately left out of `cleanup()`.
    let stagedConfigBase = scratchTmpDir
    if (opts.stagedConfigDir) {
      mkdirSync(opts.stagedConfigDir, { recursive: true, mode: 0o700 })
      stagedConfigBase = realpathSync(opts.stagedConfigDir)
    }

    // O1: staged into `stagedConfigBase` — a directory already granted
    // read+write below (`readWriteDirs`) — so this never widens the profile
    // beyond what the staging grant already covers. Resolved here, before
    // `readWriteDirs`/`execAllowDirs` are built, purely so the staged path
    // can be reported on the returned launch; it needs no profile entry of
    // its own.
    const oauthConfigDir = opts.stageOAuthCredential
      ? (stageOAuthCredential(process.env, realHome, stagedConfigBase, deps)?.configDir ?? null)
      : null
    const codexAccessToken = opts.stageCodexCredential
      ? resolveCodexAccessToken(
          process.env,
          realHome,
          deps.readOAuthCredentialFile ?? readRealOAuthCredentialFile,
          deps.readCodexKeychainCredential ?? readRealCodexKeychainCredential
        )
      : null
    let codexHomeDir: string | null = null
    if (opts.stageCodexCredential && codexAccessToken) {
      codexHomeDir = join(stagedConfigBase, 'codex-home')

      // O2: when the PERSISTENT per-task home already carries a staged
      // session (a prior round's `codex login` wrote `auth.json`), reuse it
      // rather than re-running the login/preflight/plugin-install chain. That
      // reuse is the whole point of a per-task home surviving between rounds,
      // and the only SAFE way to reuse it: `codex plugin add` is not
      // idempotent against an already-installed plugin, so a blind re-run on
      // round 2 would fail the dispatch. A fresh home (round 1, or the
      // ephemeral `scratchTmpDir` fallback when no `stagedConfigDir` was
      // named) runs the full setup below exactly as before.
      const alreadyStaged = opts.stagedConfigDir !== undefined && existsSync(join(codexHomeDir, CODEX_AUTH_FILE_NAME))
      if (!alreadyStaged) {
        mkdirSync(codexHomeDir, { recursive: true, mode: 0o700 })

        // Round 5 review, BLOCKER: a bare `CODEX_ACCESS_TOKEN`
        // env var is not a session the real Codex CLI accepts — this call is
        // the fix: `codex login --with-access-token` reads the token from
        // stdin and writes a real `auth.json` (its own `account_id`/
        // `refresh_token` derivation) into the SCOPED `codexHomeDir`, never
        // the operator's real `CODEX_HOME`. See `runRealCodexLoginWithAccessToken`'s
        // own doc comment for what is and is not live-verified here.
        const login = (deps.runCodexLoginWithAccessToken ?? runRealCodexLoginWithAccessToken)({
          binaryPath: resolvedBinaryPath,
          codexHome: codexHomeDir,
          accessToken: codexAccessToken
        })
        if (!login.ok) {
          rmSync(scratchTmpDir, { recursive: true, force: true })
          throw new Error(`Codex subscription login failed: ${login.reason}`)
        }

        // Round 5 review, BLOCKER: this preflight must probe the
        // SAME scoped `codexHomeDir` the confined worker will actually run
        // against — probing the operator's real, unscoped `CODEX_HOME` (the
        // prior shape) always reported the session usable even when the
        // isolated worker's own brokered credential could not authenticate.
        const authPreflight = (deps.runCodexAuthPreflight ?? runRealCodexAuthPreflight)({
          binaryPath: resolvedBinaryPath,
          codexHome: codexHomeDir,
          cwd: scratchTmpDir,
          realHome
        })
        if (!authPreflight.ok) {
          rmSync(scratchTmpDir, { recursive: true, force: true })
          throw new Error(`Codex subscription authentication preflight failed: ${authPreflight.reason}`)
        }

        writeFileSync(
          join(codexHomeDir, 'config.toml'),
          [
            '[shell_environment_policy]',
            'inherit = "all"',
            'ignore_default_excludes = false',
            '',
            '[shell_environment_policy.filters]',
            '# Codex itself receives this brokered session; its repository commands never do.',
            '"CODEX_ACCESS_TOKEN" = "exclude"',
            ''
          ].join('\n'),
          { mode: 0o600 }
        )
        if (opts.codexExecpolicyRules) {
          // The machine-state deny floor for this Codex run. Unlike
          // the hooks above — which the real Codex CLI only discovers inside an
          // installed plugin's directory — execpolicy `.rules` files ARE
          // discovered from `<CODEX_HOME>/rules/*.rules` directly (live-verified
          // against `codex-cli 0.152.1`), so a plain write into the staged home
          // is all Codex needs. A write fault throws here, is caught by this
          // function's own outer `try`, and returns a boundary refusal — so an
          // unattended dispatch that cannot establish this policy fails closed,
          // never launches unprotected.
          const rulesDir = join(codexHomeDir, 'rules')
          mkdirSync(rulesDir, { recursive: true, mode: 0o700 })
          writeFileSync(join(rulesDir, CODEX_POLICY_RULES_FILE), opts.codexExecpolicyRules, { mode: 0o600 })
        }
        if (opts.codexHooksPath) {
          // Round 7 review, BLOCKER: see `buildCodexHooksMarketplace`'s own
          // doc comment for why this is a plugin install, never a bare file
          // write — a bare `hooks.json` at `CODEX_HOME` root is never
          // discovered by the real Codex CLI. O2: the marketplace lives under
          // `stagedConfigBase` (not the ephemeral `scratchTmpDir`) so a
          // persistent per-task home's own plugin registry keeps pointing at
          // a directory that survives the dispatch that installed it.
          const hooksContent = readFileSync(opts.codexHooksPath, 'utf8')
          const marketplaceDir = join(stagedConfigBase, 'codex-hooks-marketplace')
          buildCodexHooksMarketplace(marketplaceDir, hooksContent)
          const install = (deps.runCodexPluginInstall ?? runRealCodexPluginInstall)({
            binaryPath: resolvedBinaryPath,
            codexHome: codexHomeDir,
            marketplaceDir
          })
          if (!install.ok) {
            rmSync(scratchTmpDir, { recursive: true, force: true })
            throw new Error(`Codex documentation-gate hook install failed: ${install.reason}`)
          }
        }
      }
    }

    /** Resolves a subpath of an already-realpath'd parent — realpath'd itself when it already exists (closing the same symlink-alias gap every other path here closes), or left as a plain `join()` when it does not yet exist (`.worktrees` on a fresh clone): the PARENT is already canonical, so a not-yet-existing child's constructed path is exact, and Seatbelt subpath rules need no existing target to compile. */
    const resolveExistingOrJoined = (parentReal: string, rel: string): string => {
      const joined = join(parentReal, rel)
      try {
        return realpathSync(joined)
      } catch {
        return joined
      }
    }

    /**
     * Canonicalises an already-absolute caller-supplied path, INCLUDING one
     * that does not exist yet.
     *
     * Round 2 review, MAJOR: returning a non-existent path verbatim is a
     * regression. The `vinayaHomeDir` this replaced was realpath'd once, so
     * every path derived from it came out canonical whether or not the leaf
     * existed. Seatbelt matches the path the kernel resolves, not the one the
     * profile spells — and the documentation-log file `dispatch.ts` names in
     * `extraWritableFiles` NEVER exists at resolution time. With a
     * `runtimeDir` that traverses a symlink — the reference's own documented
     * example `/var/lib/vinaya/runs`, on macOS, where `/var` is a symlink to
     * `/private/var`, and macOS is the only host with a boundary at all —
     * its `(literal ...)` grant would never match, and the PostToolUse
     * documentation-gate append would be silently denied inside an otherwise
     * read-only hooks directory.
     *
     * Walks up to the nearest ancestor that DOES exist, canonicalises that,
     * and re-joins the remainder: the existing part is resolved exactly as
     * the kernel would, and the not-yet-created tail is exact by
     * construction.
     */
    const canonical = (abs: string): string => {
      const tail: string[] = []
      let cursor = abs
      for (;;) {
        try {
          return tail.length === 0 ? realpathSync(cursor) : join(realpathSync(cursor), ...tail)
        } catch {
          const parent = dirname(cursor)
          // Reached the filesystem root without finding anything that
          // exists — nothing to canonicalise against, so the caller's own
          // absolute path is already the best answer available.
          if (parent === cursor) return abs
          tail.unshift(basename(cursor))
          cursor = parent
        }
      }
    }

    const bootstrapWriteDirs = (opts.bootstrapWritableSubpaths ?? []).map((rel) =>
      resolveExistingOrJoined(allowedDirReal, rel)
    )
    const vinayaWritableDirs = [
      ...opts.extraWritableDirs.map(canonical),
      // O2: the persistent per-task staged config dir is granted read+write
      // exactly like a reviewer's own work dir — the confined child reads its
      // staged login and writes its vendor session store here throughout the
      // run. Its parent (the task's own `sessions/` folder) gets only the
      // metadata-traversal grant every `vinayaWritableDirs` parent gets
      // (`vinayaWritableParents`, below), never recursive read of its sibling
      // roles' session records. Already `realpath`'d above, so it is included
      // directly rather than re-run through `canonical`. Omitted entirely
      // when no `stagedConfigDir` was named (staging fell back to
      // `scratchTmpDir`, which is granted on its own below and removed by
      // `cleanup()`).
      ...(opts.stagedConfigDir ? [stagedConfigBase] : [])
    ]
    const vinayaWritableFiles = (opts.extraWritableFiles ?? []).map(canonical)
    const vinayaReadOnlyDirs = (opts.extraReadOnlyDirs ?? []).map(canonical)
    // A dynamically-linked runtime must read its own direct libraries after
    // it passes process-exec. Keep this to otool-reported directories plus
    // the conventional sibling `lib/`, never a package-manager root.
    const runtimeReadOnlyDirs = resolveRuntimeLibraryDirs(resolvedBinaryPath)

    // Round 4 review, HIGH: no machine-wide root is ever added here — only
    // the caller's own narrowly-scoped `vinayaWritableDirs`/
    // `vinayaReadOnlyDirs` (below). A blanket `file-read*` over the Vinaya
    // home once let a confined role read `config.json` plus every other
    // repo's and task's state; nothing inside the sandbox needs that (the
    // controller's own global-config fallback runs unsandboxed, before any
    // child is ever spawned). Taking absolute paths rather than a root plus
    // subpaths keeps that true now that a task's run files and the
    // telemetry outbox live under two different roots.
    // O2: read-only, named exactly — never the whole real `HOME` this
    // profile otherwise denies outright. `gitConfigReadOnlyPaths` names the
    // file/dir by relative suffix; resolved the same "realpath when it
    // already exists, else leave the join exact" way `.worktrees` already
    // is, above, since `~/.config/git` may not exist on every host.
    const gitConfigPaths = gitConfigReadOnlyPaths(realHome).map((p) =>
      resolveExistingOrJoined(realHome, p.slice(realHome.length + 1))
    )
    // Principal ruling 1, failure 2: a linked worktree's `.git` resolves
    // into the main repository's git common dir — granted read+write (never
    // read-only) because git itself writes there (the index lock, `HEAD`,
    // `ORIG_HEAD`) on an ordinary `status`/`commit`, not only on an explicit
    // worktree operation. `null` (a host with no `git`, or `allowedDirReal`
    // not actually a worktree — the reviewer's own scratch copy case) adds
    // nothing, same best-effort posture every other optional grant here
    // takes.
    const gitCommonDir = resolveGitCommonDir(allowedDirReal)
    const readOnlyDirs = Array.from(
      new Set([
        ...(opts.bootstrapWritableSubpaths ? [allowedDirReal] : []),
        ...vinayaReadOnlyDirs,
        ...runtimeReadOnlyDirs,
        ...gitConfigPaths
      ])
    )
    const readWriteDirs = Array.from(
      new Set([
        ...(opts.bootstrapWritableSubpaths ? bootstrapWriteDirs : [allowedDirReal]),
        scratchTmpDir,
        ...vinayaWritableDirs,
        ...(gitCommonDir ? [gitCommonDir] : [])
      ])
    )

    // Round 4 review, BLOCKER fix: a `vinayaHomeWritableSubdirs` entry
    // scoped to THIS dispatch's own repo (e.g. one repo's own log-queue
    // subdirectory) sits TWO levels below `vinayaHomeDir`, and
    // `vinayaHomeDir` itself carries no grant at all any more (the HIGH
    // fix, above) — verified live on this host: without SOMETHING on the
    // immediate parent (the log-queue/resume-record directory itself), even
    // `writeLaunchRecord`'s own `mkdirSync(dirname(path), {recursive:true})`
    // targeting the exact, already-granted child path is denied outright,
    // regardless of whether that child pre-exists. `file-read-metadata` on
    // the parent's own `(literal ...)` (never `(subpath ...)`, see
    // `sbLiteralMetadataAllows`'s own doc comment) is the minimum that
    // satisfies the kernel's lookup/create step without granting recursive
    // read of whatever ELSE lives beside this dispatch's own child.
    const vinayaWritableParents = Array.from(
      new Set(
        [...vinayaWritableDirs, ...vinayaWritableFiles].map((d) => {
          const parent = dirname(d)
          try {
            return realpathSync(parent)
          } catch {
            return parent
          }
        })
      )
    )

    const gitExecPath = resolveGitExecPath()
    const bunExecDir = resolveBunExecDir()
    // O1: the active Apple developer directory behind the `/usr/bin` git/clang
    // shims — placed in `execAllowDirs`, which grants BOTH exec (its own rule)
    // and read (via `readAllowDirs`, derived from this list), never write. See
    // `resolveRealDeveloperDir`'s doc comment for the libxcrun crash this
    // closes. `null` off darwin or on a host without it: nothing extra is
    // granted, exactly like a missing `git`/`bun`.
    const developerDir = (deps.resolveDeveloperDir ?? resolveRealDeveloperDir)()
    // Ruling 986-1: the real install `bin/` of the `node` the
    // task-tools MCP server's registration starts — granted BOTH exec (its own
    // rule) and read (via `readAllowDirs`, derived from this list), never write,
    // so a confined session can actually spawn that server. `null` on a host
    // without `node`: nothing extra is granted, exactly like a missing
    // `git`/`bun`/developer dir. See `resolveRealNodeExecDir`'s doc comment.
    const nodeExecDir = (deps.resolveNodeExecDir ?? resolveRealNodeExecDir)()
    const systemBinDirs = CANDIDATE_SYSTEM_BIN_DIRS.filter((d) => existsSync(d)).map((d) => realpathSync(d))
    const execAllowDirs = Array.from(
      new Set([
        allowedDirReal,
        runtimeDir,
        ...(gitExecPath ? [gitExecPath] : []),
        ...(bunExecDir ? [bunExecDir] : []),
        ...(developerDir ? [developerDir] : []),
        ...(nodeExecDir ? [nodeExecDir] : []),
        ...systemBinDirs
      ])
    )

    const credentialHelperDenyLiterals = gitExecPath
      ? ['git-credential-osxkeychain', 'git-credential-manager', 'git-credential-manager-core'].map((name) =>
          join(gitExecPath, name)
        )
      : []

    const profile = buildWorkerSandboxProfile({
      realHome,
      readOnlyDirs,
      readWriteDirs,
      metadataOnlyDirs: vinayaWritableParents,
      writableFiles: vinayaWritableFiles,
      protectedSubpaths: (opts.protectedSubpaths ?? []).map(canonical),
      execAllowDirs,
      runtimeDir,
      sshSockCanon: resolveSshSockCanon(),
      credentialHelperDenyLiterals
    })

    const profileDir = mkdtempSync(join(tmpdir(), 'vinaya-worker-boundary-profile-'))
    const profilePath = join(profileDir, 'worker-boundary.sb')
    // Written here, alongside every other filesystem action this resolution
    // performs, so a failure (an unwritable tmp dir, say) surfaces as a
    // refusal through the same `catch` below rather than a half-built launch.
    writeFileSync(profilePath, profile)

    const cleanup = (): void => {
      rmSync(profileDir, { recursive: true, force: true })
      rmSync(scratchTmpDir, { recursive: true, force: true })
    }

    return {
      ok: true,
      launch: {
        command: '/usr/bin/sandbox-exec',
        args: ['-f', profilePath, resolvedBinaryPath, ...opts.args],
        cleanup,
        tmpDir: scratchTmpDir,
        oauthConfigDir,
        codexHomeDir,
        codexAccessToken,
        pathOverride: resolveGitFirstPath(process.env, developerDir)
      }
    }
  } catch (error) {
    return { ok: false, reason: `worker boundary profile could not be built: ${(error as Error).message}` }
  }
}

// --- O1/O2/O5: the provider-neutral confinement interface -------------------

/**
 * Linux hosts: Claude Code's own sandbox needs `bubblewrap` (`bwrap`) to
 * build its mount/pid namespace and `socat` to bridge its outbound network
 * proxy into it — confirmed live against the installed binary (2.1.197,
 * `grep -a` over its own strings: `"bubblewrap (bwrap) not installed"`,
 * `sta(){let{seccompConfig:t,bwrapPath:n,socatPath:r}=e??{}...`). Named here,
 * once, so `resolveClaudeConfinement`'s own refusal to set
 * `sandbox.enabled`/`failIfUnavailable` on a host that cannot satisfy them —
 * falling back to an unconfined run with a named warning instead (Principal
 * ruling, 2026-10-02: nobody is ever required to install anything) — and
 * `apps/cli/specs/self-hosting.md`'s own description of that same fallback
 * read the identical list, never a second one that could drift.
 */
export const LINUX_CLAUDE_SANDBOX_TOOLS = ['bwrap', 'socat'] as const

export type LinuxSandboxToolDeps = {
  /** `true` when `bin` resolves on `PATH` — the real implementation shells out to `which`; injectable so the missing-tool fallback is provable without uninstalling anything on the test host. */
  commandExists: (bin: string) => boolean
}

function realCommandExists(bin: string): boolean {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export const REAL_LINUX_SANDBOX_TOOL_DEPS: LinuxSandboxToolDeps = { commandExists: realCommandExists }

export type LinuxSandboxToolCheck = {
  readonly available: boolean
  readonly missing: readonly string[]
}

/** Which of `LINUX_CLAUDE_SANDBOX_TOOLS` this host is missing, if any — `available` is `true` only when neither is. Never installs anything; a missing tool is reported, not remedied (Principal ruling, 2026-10-02). */
export function checkLinuxSandboxTools(
  deps: LinuxSandboxToolDeps = REAL_LINUX_SANDBOX_TOOL_DEPS
): LinuxSandboxToolCheck {
  const missing = LINUX_CLAUDE_SANDBOX_TOOLS.filter((tool) => !deps.commandExists(tool))
  return { available: missing.length === 0, missing }
}

/**
 * O2: the two network destinations a confined Developer's own Bash-tool
 * subprocesses (`git fetch`, `gh pr`/`issue` read calls, `bun install`) need
 * to reach. Never the model-runtime endpoint itself — Claude Code's own MAIN
 * process reaches that unconfined; it is not inside its own sandbox, only
 * the tools it dispatches are (`apps/cli/specs/isolation.md` §4) — so the
 * model endpoint needs no entry here at all.
 */
export const CLAUDE_SANDBOX_ALLOWED_DOMAINS: readonly string[] = [
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'registry.npmjs.org'
]

export type ConfinementRequest = {
  readonly role: Role
  /** A plain string, never `AgentVendor` — that type lives in `dispatch.ts`, which imports this module, and importing it back here would cycle; `hasSubscriptionLogin` (above) already takes the same shape for the same reason. */
  readonly agent: string
  readonly worktreeDir: string
  readonly scratchDir: string
  readonly allowedHosts: readonly string[]
}

export type ClaudeSandboxSettings = {
  readonly sandbox: {
    readonly enabled: true
    readonly failIfUnavailable: true
    readonly allowUnsandboxedCommands: false
    readonly network: { readonly allowedDomains: string[] }
    readonly filesystem: {
      readonly allowWrite: string[]
      readonly allowRead: string[]
      readonly denyRead: string[]
    }
  }
  readonly permissionsDeny: readonly string[]
}

/**
 * O2: Claude Code's own `sandbox` settings block — `enabled`,
 * `failIfUnavailable` and `allowUnsandboxedCommands: false` exactly as the
 * brief specifies, and deliberately no `excludedCommands` key: an entry
 * there runs a command OUTSIDE the sandbox, which is the one thing a loaded
 * settings source must never be able to add back (O3's own trap).
 *
 * `filesystem.allowWrite` grants exactly the two directories a confined role
 * is trusted to write: its own worktree (a Developer's worktree, or a
 * Reviewer's candidate checkout) and this dispatch's own scratch
 * directory — never a third path, and never the real `HOME`.
 * `filesystem.denyRead`/`allowRead` together express "readable inside the
 * worktree and scratch directory, denied in the real home outside them":
 * `denyRead` names the real home broadly, and `allowRead` re-permits the two
 * granted directories, which on an ordinary checkout sit nested inside it.
 * Confirmed against the installed binary's own schema, whose `denyRead` doc
 * comment reads "Merged with paths from `Read(...)` deny permission rules" —
 * so `permissionsDeny`'s matching `Read(<home>/**)` entry (below) reaches the
 * SAME merged sandbox list from the permission layer, not a second,
 * independent restriction; `Write`/`Edit` mirror it for the same reason.
 *
 * `denyRead` ALSO names the real OS temp root (round 2 review, MAJOR —
 * worker-boundary.ts:1832 finding), not only the real home: `scratchDir`
 * is always a fresh `mkdtemp` under `os.tmpdir()` (`dispatch.ts`'s
 * `claudeScratchDir`), so that root is the ONE other directory, beside
 * home, every confined dispatch's own allowed paths are nested inside —
 * and, left unnamed, it would leave a SIBLING task's own scratch
 * directory (the exact sibling-exposure shape `isolation.md` §4's own
 * `vinayaHomeWritableFiles` discussion already closes for the outbox/
 * resume-record files) freely readable by this one. **This narrows, but
 * does not close, O2's full "outside the worktree and scratch directory"
 * wording**: a path outside BOTH the real home and the real temp root
 * (`/etc`, `/opt`, a second filesystem mount) is covered by neither
 * `denyRead` nor `permissionsDeny` here — closing that fully would mean
 * denying read from the filesystem root and re-allowing only the two
 * granted directories, and `allowManagedReadPathsOnly` (the installed
 * binary's own documented route to exactly that shape) is honored only
 * from MANAGED settings, never from a per-dispatch `--settings` file this
 * module writes — so a stronger close is not expressible here. Disclosed,
 * not silently assumed closed, the same posture `isolation.md` §4 already
 * takes for its own residual gaps.
 *
 * All paths are `realpath`'d before being written into the settings file —
 * the same "every substituted path must be canonicalized" discipline
 * `isolation.md` §3 already states for the hand-built Seatbelt profile this
 * mechanism replaces for Claude: an unresolved symlinked alias (this host's
 * own `/tmp` → `/private/tmp`, the doc's own standing example) would
 * otherwise make the sandbox's own resolved-path check disagree with the
 * literal string this settings file names.
 */
export function buildClaudeSandboxSettings(
  request: ConfinementRequest,
  developerDir: string | null = null
): ClaudeSandboxSettings {
  const real = (p: string): string => {
    try {
      return realpathSync(p)
    } catch {
      return p
    }
  }
  const worktreeDir = real(request.worktreeDir)
  const scratchDir = real(request.scratchDir)
  const realHome = real(homedir())
  const realTmpRoot = real(tmpdir())
  const denyRoots = realTmpRoot === realHome ? [realHome] : [realHome, realTmpRoot]
  // O2: read-only carve-outs re-permitting exactly the git-config paths and
  // the active Apple developer directory (never write) despite `denyRead`
  // naming the whole real home above — the same "named, narrow carve-out
  // inside a broader deny" shape `worktreeDir`/`scratchDir` already use on
  // this same list. The developer dir needs read here (not only exec) so a
  // confined Bash subprocess can actually load the real `git` binary and its
  // adjacent `libxcrun.dylib` once `resolveGitFirstPath` points PATH at it.
  const gitConfigPaths = gitConfigReadOnlyPaths(realHome).map(real)
  const extraAllowRead = [...gitConfigPaths, ...(developerDir ? [real(developerDir)] : [])]
  // Principal ruling 1, failure 2: a linked worktree's `.git` resolves into
  // the main repository's git common dir — granted read AND write (git
  // itself writes the index lock/`HEAD`/`ORIG_HEAD` there on an ordinary
  // `status`/`commit`, not only on an explicit worktree operation), the
  // same way `worktreeDir`/`scratchDir` already are, rather than folded
  // into the read-only `extraAllowRead` carve-out above. `null` (no `git`,
  // or `worktreeDir` not actually a worktree) adds nothing.
  const gitCommonDir = resolveGitCommonDir(worktreeDir)
  const extraReadWrite = gitCommonDir ? [real(gitCommonDir)] : []
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [...request.allowedHosts] },
      filesystem: {
        allowWrite: [worktreeDir, scratchDir, ...extraReadWrite],
        allowRead: [worktreeDir, scratchDir, ...extraAllowRead, ...extraReadWrite],
        denyRead: denyRoots
      }
    },
    permissionsDeny: denyRoots.flatMap((root) => [`Read(${root}/**)`, `Write(${root}/**)`, `Edit(${root}/**)`])
  }
}

export type ConfinementResolution =
  | {
      readonly ok: true
      readonly confined: true
      readonly settings: ClaudeSandboxSettings
      readonly scratchDir: string
      /** O2: `resolveGitFirstPath`'s own result — the caller overrides the confined child's `PATH` env with this value. `sourceEnv.PATH` unchanged off darwin or with no developer dir resolved. */
      readonly pathOverride: string | undefined
    }
  | {
      readonly ok: true
      readonly confined: false
      readonly warning: string
      /** The missing tool name(s), for a caller that wants to log the fact structurally rather than parse `warning`'s own prose — empty on a platform with no named mechanism at all (nothing to name). */
      readonly missingTools: readonly string[]
    }

export type ConfinementPlatformDeps = {
  readonly platform: NodeJS.Platform
  readonly linuxTools: LinuxSandboxToolCheck
  /** O2: the active Apple developer directory (`resolveRealDeveloperDir`) — injectable so a non-Mac test host can assert the PATH-prepend/read-grant behavior without a real `xcode-select`. `null` off darwin or when unresolved, exactly like every other optional grant in this module. */
  readonly developerDir: string | null
}

/** Real platform/tool/developer-dir facts — `process.platform`, a fresh `checkLinuxSandboxTools()` read, and a fresh `resolveRealDeveloperDir()` read. A caller wanting a stable answer across one dispatch reads it once and threads the result, the same posture `detectRealHost` already documents for the Seatbelt path. */
export function realConfinementPlatformDeps(): ConfinementPlatformDeps {
  return { platform: process.platform, linuxTools: checkLinuxSandboxTools(), developerDir: resolveRealDeveloperDir() }
}

/**
 * O1/O2/O5 — the Claude half of the provider-neutral confinement interface:
 * takes a role, its task worktree, its scratch directory and the hosts it
 * may reach (`ConfinementRequest`), and returns the vendor configuration for
 * that dispatch (`ConfinementResolution`) — `dispatch.ts` calls this once for
 * every unattended Claude dispatch rather than branching on platform itself
 * to decide whether to build a Seatbelt profile the way it did before this
 * task.
 *
 * Always confined on macOS — Claude Code's own sandbox there "needs nothing
 * installed" (it ships with the OS, Seatbelt-backed). On Linux, confined
 * only when both `LINUX_CLAUDE_SANDBOX_TOOLS` are present; otherwise returns
 * the unconfined fallback carrying a `warning` naming the missing tool(s),
 * rather than setting `failIfUnavailable: true` on a host that cannot
 * satisfy it — which would make `claude` itself exit with "Sandbox required
 * but unavailable" instead of merely running unconfined (see
 * `LINUX_CLAUDE_SANDBOX_TOOLS`'s own doc comment). Never refuses the
 * dispatch, and never installs anything (Principal ruling, 2026-10-02): the
 * one degraded outcome this function reports is `confined: false`, always
 * paired with a `warning` the caller surfaces in the run's own output and
 * the Vinaya Log.
 */
export function resolveClaudeConfinement(
  request: ConfinementRequest,
  deps: ConfinementPlatformDeps = realConfinementPlatformDeps()
): ConfinementResolution {
  const pathOverride = resolveGitFirstPath(process.env, deps.developerDir)
  if (deps.platform === 'darwin') {
    return {
      ok: true,
      confined: true,
      settings: buildClaudeSandboxSettings(request, deps.developerDir),
      scratchDir: request.scratchDir,
      pathOverride
    }
  }
  if (deps.platform === 'linux') {
    if (deps.linuxTools.available) {
      return {
        ok: true,
        confined: true,
        settings: buildClaudeSandboxSettings(request, deps.developerDir),
        scratchDir: request.scratchDir,
        pathOverride
      }
    }
    return {
      ok: true,
      confined: false,
      warning:
        `Claude Code's own sandbox needs ${LINUX_CLAUDE_SANDBOX_TOOLS.join(' and ')} on Linux; missing: ` +
        `${deps.linuxTools.missing.join(', ')} — running this dispatch unconfined rather than requiring an ` +
        'install (Principal ruling, 2026-10-02).',
      missingTools: deps.linuxTools.missing
    }
  }
  return {
    ok: true,
    confined: false,
    warning: `Claude Code's own sandbox names no mechanism for platform '${deps.platform}' — running this dispatch unconfined.`,
    missingTools: []
  }
}
