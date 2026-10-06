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
 * `vinaya` binary. Confinement itself is each vendor's own sandbox
 * (`resolveClaudeConfinement`/`resolveCodexConfinement` below); no hand-built
 * profile is written here.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Role } from '@attalabs/aeg-core'
import { devToolsSocketRoot } from './task-tools/dev-tools-registration.js'
import { documentationReceiptsPath } from './task-tools/fetch-documentation.js'

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
 * only inside the worker-isolation boundary. the Codex confinement
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
 * with `exec resume` is the shape the Codex confinement already ships.
 *
 * **O1–O3, O7 (task 4):** when the caller names `sandboxConfigToml`, `auth.json`
 * and `config.toml` are excluded from the generic symlink-through loop above
 * and handled differently instead:
 *
 * - `auth.json` is COPIED (a real `readFileSync`/`writeFileSync`, never
 *   `symlinkSync`), not symlinked — O7: a symlinked credential
 *   lets anything this task-scoped session writes back to `auth.json` (a
 *   token refresh, say) land in the OPERATOR's own real `~/.codex/auth.json`;
 *   a copy is independent, and the installed Codex rejects
 *   `codex login --with-access-token` for a subscription session token
 *   outright ("agent identity JWT payload is not valid JSON" —
 *   `runRealCodexLoginWithAccessToken`'s own disclosed limit), so a copy is
 *   also the only working route to a confined, authenticated session today.
 * - `config.toml` is this run's OWN generated content (`sandboxConfigToml` —
 *   `buildCodexSandboxConfigToml`, below) instead of the operator's real
 *   file (symlinked through, pre-O1): a resumed `codex exec resume` accepts
 *   no `--sandbox` flag at all, so `sandbox_mode`/`sandbox_workspace_write.
 *   network_access`/`features.network_proxy` must come from the CODEX_HOME
 *   this call stages, read identically by a fresh start and a resumed one —
 *   symlinking the operator's own config.toml through would leave both
 *   reading whatever (or nothing) the operator happens to have configured,
 *   never this task's own policy.
 *
 * Omitted (every pre-O1 caller — an attended Codex dispatch, which this task
 * does not confine): both files are symlinked through exactly as before,
 * byte-for-byte the pre-existing behavior.
 */
export function stageCodexPolicyHome(input: {
  targetDir: string
  realHome: string
  execpolicyRules: string
  sandboxConfigToml?: string
}): { codexHome: string } | null {
  const operatorHome = join(input.realHome, '.codex')
  const operatorAuthPath = join(operatorHome, CODEX_AUTH_FILE_NAME)
  if (!existsSync(operatorAuthPath)) return null
  try {
    mkdirSync(input.targetDir, { recursive: true, mode: 0o700 })
    // Idempotent across a resumed turn that reuses the same run-scoped path:
    // clear any prior contents before re-staging.
    for (const entry of readdirSync(input.targetDir)) {
      rmSync(join(input.targetDir, entry), { recursive: true, force: true })
    }
    if (input.sandboxConfigToml !== undefined) {
      // O4: a confined run's own CODEX_HOME holds ONLY these two files plus
      // the `rules` directory below — no OTHER entry of the operator's real
      // `~/.codex` (an installed plugin, a cached session, `instructions.md`)
      // is symlinked into it, so nothing this run writes under `targetDir`
      // can ever reach back into the operator's own `~/.codex` through a
      // shared inode. `auth.json` is a real COPY (O7's own reasoning, above);
      // `config.toml` is this run's own generated content, never the
      // operator's file.
      writeFileSync(join(input.targetDir, CODEX_AUTH_FILE_NAME), readFileSync(operatorAuthPath), { mode: 0o600 })
      writeFileSync(join(input.targetDir, 'config.toml'), input.sandboxConfigToml, { mode: 0o600 })
    } else {
      // Pre-O1, attended-only path (this task does not confine it, Boundary):
      // every operator `~/.codex` entry symlinked through unchanged,
      // `auth.json`/`config.toml` included — byte-for-byte the behavior
      // every caller before O1 already got.
      for (const entry of readdirSync(operatorHome)) {
        if (entry === 'rules') continue
        symlinkSync(join(operatorHome, entry), join(input.targetDir, entry))
      }
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

/**
 * Refreshes the login copy in an already-staged Codex home when the operator's
 * own `~/.codex/auth.json` is newer than the copy, so a re-login by the
 * operator reaches the next dispatch of a task whose home was staged earlier.
 * Only modification times are compared; the file is copied as bytes and never
 * parsed. The copy is written to a sibling file and renamed over the staged
 * one, so the staged home never shares an inode with the operator's file or
 * with another home, and nothing is ever written back to the operator's home.
 * Returns `true` when the copy was replaced.
 */
export function refreshStagedCodexLogin(input: { realHome: string; codexHome: string }): boolean {
  const operatorAuthPath = join(input.realHome, '.codex', CODEX_AUTH_FILE_NAME)
  const stagedAuthPath = join(input.codexHome, CODEX_AUTH_FILE_NAME)
  const tempPath = `${stagedAuthPath}.refresh-${process.pid}`
  try {
    if (statSync(operatorAuthPath).mtimeMs <= statSync(stagedAuthPath).mtimeMs) return false
    writeFileSync(tempPath, readFileSync(operatorAuthPath), { mode: 0o600 })
    renameSync(tempPath, stagedAuthPath)
    return true
  } catch {
    // The staged copy stays as it was; the next dispatch compares again. The
    // sibling is removed so no second copy of the login outlives the attempt.
    try {
      rmSync(tempPath, { force: true })
    } catch {}
    return false
  }
}

/**
 * The reuse decision for a task's persistent Codex home: when `codexHome`
 * already carries a staged login, refreshes that copy against the operator's
 * own login (`refreshStagedCodexLogin`) and returns `codexHome` for reuse;
 * `null` when nothing is staged there yet and a fresh stage is due.
 */
export function reuseStagedCodexHome(input: { realHome: string; codexHome: string }): string | null {
  if (!existsSync(join(input.codexHome, CODEX_AUTH_FILE_NAME))) return null
  refreshStagedCodexLogin(input)
  return input.codexHome
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
export function buildCodexHooksMarketplace(marketplaceDir: string, hooksJsonContent: string): void {
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
 * `scratchTmpDir` (a directory the confinement already grants
 * full read+write, so staging here needs no new grant at all). The
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

export type WorkerBoundaryDeps = {
  /**
   * O1: reads the OAuth session credential file at an already-resolved
   * source path (`resolveOAuthConfigSourceDir(...)/.credentials.json`),
   * returning its contents or `null` when absent/unreadable — never throws.
   * Injectable so `stageOAuthCredential`'s behavior is provable without a
   * real OAuth session on the test host. Optional — an omitted entry falls
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
}

export const REAL_WORKER_BOUNDARY_DEPS: WorkerBoundaryDeps = {
  readOAuthCredentialFile: readRealOAuthCredentialFile,
  readClaudeKeychainCredential: readRealClaudeKeychainCredential,
  readCodexKeychainCredential: readRealCodexKeychainCredential,
  runCodexLoginWithAccessToken: runRealCodexLoginWithAccessToken,
  runCodexAuthPreflight: runRealCodexAuthPreflight,
  runCodexPluginInstall: runRealCodexPluginInstall
}

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
 * same best-effort posture every other optional grant in this module takes.
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
 * O2: both vendor adapters' confined child can already read+exec
 * `developerDir` (Claude's native sandbox leaves reads open everywhere
 * except the named credential files) — but that alone does not make a bare `git` invocation
 * USE the real binary there: PATH
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
 * for Claude, the Codex sandbox configuration for Codex.
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
 * Resolved fresh, from INSIDE `worktreeDir`, best-effort — `null` on any
 * failure (no `git`, or `worktreeDir` not actually a worktree yet), which
 * simply contributes nothing extra to the grant rather than widening it on a
 * guess.
 *
 * Round 3 Principal ruling: exported so `dispatch.ts` can thread the SAME
 * resolved grant into Codex's `sandbox_workspace_write.writable_roots`
 * (`addCodexWritableDirs`) that Claude's own `buildClaudeSandboxSettings`
 * already uses — one resolver, both vendors — in place of the narrower,
 * Codex-only `codexGitMetadataWritableDirs` this replaces.
 */
export function resolveGitCommonDir(worktreeDir: string): string | null {
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

/**
 * Principal ruling (round 4): a live Mac probe found `bun install
 * --frozen-lockfile` failing under BOTH agents' sandboxes with "bun is
 * unable to write files to tempdir: EPERM" — `bun install` writes its
 * package cache under the operator's real home (`bun pm cache`), a path
 * neither `buildClaudeSandboxSettings`'s `allowWrite` nor
 * `addCodexWritableDirs`'s roots ever named. Resolved live, so this never grants a guessed path on a host where the
 * cache actually lives somewhere `bun pm cache` itself would report
 * differently (`BUN_INSTALL`, a non-default XDG layout). Falls back to
 * bun's own documented default (`~/.bun/install/cache`) only when the
 * command itself is unavailable — never `null`: every writable-root caller
 * here needs a path to add, not an absence to skip.
 */
export function resolveBunInstallCacheDir(): string {
  try {
    const out = execFileSync('bun', ['pm', 'cache'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (out.length > 0) return realpathSync(out)
  } catch {
    // Falls through to the documented default below.
  }
  const fallback = join(homedir(), '.bun', 'install', 'cache')
  try {
    return realpathSync(fallback)
  } catch {
    return fallback
  }
}

// --- O1/O2/O5: the provider-neutral confinement interface -------------------

/**
 * Linux hosts: Claude Code's own sandbox needs `bubblewrap` (`bwrap`) to
 * build its mount/pid namespace and `socat` to bridge its outbound network
 * proxy into it — confirmed live against the installed binary (2.1.197,
 * `grep -a` over its own strings: `"bubblewrap (bwrap) not installed"`,
 * `sta(){let{seccompConfig:t,bwrapPath:n,socatPath:r}=e??{}...`). Named here,
 * once, so `resolveClaudeConfinement` can name missing requirements and
 * `dispatchRole` can refuse before spawning an unattended worker. Vinaya
 * never installs either tool on the operator's behalf.
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
 * O3: the fixed set of network destinations this list ever names — GitHub
 * (what the Developer's own `git fetch`/`gh pr`/`issue` read calls reach,
 * though O2 now also excludes those from the sandbox outright rather than
 * relying on this allowlist for them), the package registry the repository
 * installs from (`bun install`), and the agent vendor's own API host
 * (`api.anthropic.com`) — named here even though Claude Code's own MAIN
 * process reaches the model runtime unconfined (it is not inside its own
 * sandbox, only the tools it dispatches are, `apps/cli/specs/isolation.md`
 * §4): a Bash-tool-spawned subprocess that itself shells out to the model
 * API (a nested `claude -p` call, a hand-rolled health check) stays confined
 * and needs this entry to succeed rather than fail closed.
 */
export const CLAUDE_SANDBOX_ALLOWED_DOMAINS: readonly string[] = [
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'registry.npmjs.org',
  'api.anthropic.com'
]

/**
 * O5: the official agent-vendor DOCUMENTATION hosts a confined Codex
 * Developer may read, named one by one — never a broad "any documentation"
 * allowance (the brief's own Trap). A live Codex `task run` found its web
 * search COMPLETED but it could not read the page's content, and a `curl` to
 * `developers.openai.com` was refused ("domain is not on the allowlist"):
 * `web_search = "live"` lets Codex FIND a page, but READING its content is a
 * sandboxed-command network fetch, gated by `[features.network_proxy.domains]`
 * (`buildCodexSandboxConfigToml`), so the host must be named there too. These
 * are the vendors' own documentation hosts this repo already cites — OpenAI's
 * (`developers.openai.com`, `platform.openai.com`) and Anthropic's/Claude's
 * (`docs.anthropic.com`, `code.claude.com`) — a fixed, driver-known list, not
 * a per-task value: a Developer reading its agent's own documented behaviour
 * reaches exactly these, so the driver can name them in advance rather than
 * escalating for a host list it cannot predict (§10). Codex only: a Claude
 * Developer reads documentation through its UNCONFINED main process's own
 * fetch, never a sandboxed-command network call, so this list rides Codex's
 * network proxy alone.
 */
export const DOCUMENTATION_HOSTS: readonly string[] = [
  'developers.openai.com',
  'platform.openai.com',
  'docs.anthropic.com',
  'code.claude.com'
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
    readonly excludedCommands: readonly string[]
    readonly network: {
      readonly allowedDomains: string[]
      /** Set only by `buildClaudeSandboxSettings`'s Linux host opt-in (`linuxUnixSocketFilterOptIn`); absent everywhere else. */
      readonly allowAllUnixSockets?: true
    }
    readonly filesystem: {
      readonly denyRead: string[]
      readonly allowRead: string[]
      readonly allowWrite: string[]
    }
    readonly credentials: {
      readonly files: ReadonlyArray<{ readonly path: string; readonly mode: 'deny' }>
    }
  }
  readonly permissionsDeny: readonly string[]
}

/**
 * O4: `gh *` and `git push *` are GONE from this list. A Developer no
 * longer holds any forge WRITE: it publishes, opens its PR and reads it only
 * through the driver-run dev-tools (`task-tools/dev-tools-host.ts`), which run
 * the credentialed forge operations in the driver, outside the sandbox. With
 * `gh` no longer excluded, a bare `gh` read (`gh issue view`, `gh pr view`)
 * now runs INSIDE the sandbox, where the forge-token file is denied, and fails
 * — the conformance suite lists those as Claude known failures on each
 * platform the CI job reports them.
 *
 * No Bash command may run outside the sandbox. Even a plain `git fetch` can
 * execute a worker-controlled upload-pack program, so excluding it would let
 * a worker reach another task's driver socket with the controller's OS UID.
 */
export const CLAUDE_SANDBOX_EXCLUDED_COMMANDS: readonly string[] = []

/**
 * O2: how Claude Code itself decides whether a Bash line runs OUTSIDE the
 * sandbox — a line runs outside only when the WHOLE line, on its own, matches
 * one of `CLAUDE_SANDBOX_EXCLUDED_COMMANDS`. Any shell operator that chains it
 * to something else — a `cd …&&` prefix, a `; echo` suffix, a pipe, a
 * background `&`, a backtick/`$(…)` substitution — keeps the whole line
 * sandboxed, exactly as `code.claude.com/docs/en/sandboxing` states (`git -C
 * <dir> push *` and a `cd …&&` prefix "stay sandboxed regardless").
 *
 * This is a whole-line glob match against the patterns, NOT a shell-text
 * parser that splits a compound line and runs part of it outside (the brief's
 * own Trap): the presence of any chaining operator alone disqualifies the
 * line, and otherwise the line must start with an excluded command's plain
 * form. The conformance suite uses it to launch a Developer's commands the
 * way Claude Code does.
 */
export function claudeRunsCommandUnsandboxed(command: string): boolean {
  const line = command.trim()
  // Any operator that could introduce or chain a second command keeps the
  // whole line inside the sandbox.
  if (/[\n;&|`]|\$\(/.test(line)) return false
  return CLAUDE_SANDBOX_EXCLUDED_COMMANDS.some((pattern) => {
    const prefix = pattern.replace(/\s*\*$/, '')
    return line === prefix || line.startsWith(`${prefix} `)
  })
}

/**
 * O1: at least the five credential locations the brief names, denied
 * through Claude Code's own `sandbox.credentials.files` setting rather than
 * a blanket `filesystem.denyRead` over the whole real home (O1's own
 * replacement) — `~/.ssh` and `~/.aws` (the two example paths
 * `code.claude.com/docs/en/sandboxing` itself uses for "Protect
 * credentials"), `~/.config/gh/hosts.yml` (the `gh` CLI's own token store,
 * the same file the docs' own "Mask credential files" example names),
 * `~/.codex/auth.json` (Codex's own cached ChatGPT session, confirmed
 * elsewhere in this module as the one file `stageCodexPolicyHome` ever
 * COPIES rather than symlinks, for exactly this reason) and
 * `~/.claude/.credentials.json` (`OAUTH_CREDENTIAL_FILE_NAME`, Claude's own
 * OAuth session file this module stages a scoped COPY of via
 * `stageOAuthCredential` rather than ever granting read on the real path).
 */
function claudeCredentialDenyFiles(realHome: string): ReadonlyArray<{ path: string; mode: 'deny' }> {
  return [
    join(realHome, '.ssh'),
    join(realHome, '.aws'),
    join(realHome, '.config', 'gh', 'hosts.yml'),
    join(realHome, '.codex', CODEX_AUTH_FILE_NAME),
    join(realHome, '.claude', OAUTH_CREDENTIAL_FILE_NAME)
  ].map((path) => ({ path, mode: 'deny' as const }))
}

/**
 * O1/O2/O3: Claude Code's own `sandbox` settings block, following its
 * documented default rather than widening or narrowing it by hand:
 *
 * - **Reads** are left at Claude Code's own default — "read access to the
 *   entire computer, except certain denied directories" (confirmed live
 *   against `code.claude.com/docs/en/sandboxing`, "How sandboxing works") —
 *   except the dedicated driver-tool socket root, which `denyRead` hides
 *   even when Unix-socket seccomp is unavailable. `allowRead` stays empty.
 * - **Writes** are granted on the worktree, this dispatch's own scratch
 *   directory, and — round 4 Principal ruling, below — bun's own resolved
 *   install cache (`resolveBunInstallCacheDir`), never a fourth path and
 *   never the real `HOME`. `filesystem.allowWrite` no longer also names the worktree's own git
 *   common dir: for a LINKED worktree (every Developer/Reviewer worktree
 *   this module confines), Claude Code's sandbox already "allows writes to
 *   the main repository's shared `.git` directory so commands such as `git
 *   commit` can update refs and the index" on its own (same page, "Git
 *   worktrees") — the hand-made `resolveGitCommonDir` grant this function
 *   used to add was redundant with that documented default, not a widening
 *   of it (O1's own trap).
 * - **Named credentials** are denied through `credentials.files` in `deny`
 *   mode (`claudeCredentialDenyFiles`) — the one mechanism O1 names, in
 *   place of the blanket real-home `denyRead`/mirrored `permissionsDeny`
 *   this function used to build.
 * - **No Bash command is excluded.** `git fetch` and `git pull` remain inside
 *   the sandbox because Git can execute a worker-chosen program while fetching.
 *   `allowUnsandboxedCommands` stays `false`.
 * - **The domain allowlist is `CLAUDE_SANDBOX_ALLOWED_DOMAINS`, always** —
 *   never `request.allowedHosts` (O3): one fixed list this module owns,
 *   never assembled per task. `network.strictAllowlist` is NOT part of this
 *   function's own return value (see below) even though a real dispatch
 *   still carries it.
 *
 * `filesystem.denyRead` names only the driver-tool socket root and
 * `allowRead` is empty; other reads stay at Claude Code's documented
 * default described above. The
 * `network` carries `allowedDomains` alone, with no `strictAllowlist`. Both
 * are shape constraints, not behavior changes: `dispatch.ts`'s
 * `writeDispatchSettings` is the ONE place a real dispatch's settings file
 * gets assembled, and it folds `network.strictAllowlist: true` in there,
 * after this function returns — so every real dispatch still refuses a host
 * outside the allowlist rather than prompting for it in a non-interactive
 * run, exactly as before. Keeping it out of THIS function's own return
 * value, rather than merging it in here, is what lets this function's
 * output match the vendor-literal `network`/`filesystem` key set another
 * task's sandbox-conformance suite (`apps/cli/tests/sandbox-conformance/`,
 * not this task's own Technical Surface) already asserts by exact equality —
 * that suite was added on `main` after this branch's own base, so this
 * branch merges `main` in (rather than carrying an independent copy of the
 * same path, which would make the PR's own merge commit conflict) and edits
 * its `KNOWN_FAILURES` list directly once this function's own shape change
 * makes a listed Claude-on-Linux denial stop reproducing.
 *
 * All paths are `realpath`'d before being written into the settings file —
 * the same "every substituted path must be canonicalized" discipline
 * `isolation.md` §3 already states for the confinement: an unresolved symlinked alias (this host's
 * own `/tmp` → `/private/tmp`, the doc's own standing example) would
 * otherwise make the sandbox's own resolved-path check disagree with the
 * literal string this settings file names.
 */
export function buildClaudeSandboxSettings(
  request: ConfinementRequest,
  options: { readonly allowAllUnixSockets?: boolean } = {}
): ClaudeSandboxSettings {
  // The denied parent must exist before any Claude Bash sandbox starts. A
  // missing denyRead path can be skipped by the runtime at command launch;
  // creating it only when a later Developer starts its host leaves a race.
  mkdirSync(devToolsSocketRoot(), { recursive: true, mode: 0o700 })
  chmodSync(devToolsSocketRoot(), 0o700)
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
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      excludedCommands: CLAUDE_SANDBOX_EXCLUDED_COMMANDS,
      network: {
        allowedDomains: [...CLAUDE_SANDBOX_ALLOWED_DOMAINS],
        // The host opt-in turns off only the Unix-socket seccomp filter; the
        // driver-tool socket root stays hidden by `denyRead` below.
        ...(options.allowAllUnixSockets === true ? { allowAllUnixSockets: true as const } : {})
      },
      filesystem: {
        denyRead: [devToolsSocketRoot()],
        allowRead: [],
        allowWrite: [worktreeDir, scratchDir, resolveBunInstallCacheDir()]
      },
      credentials: { files: claudeCredentialDenyFiles(realHome) }
    },
    permissionsDeny: []
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
      /** `true` only on Linux with the host opt-in set: `settings` carries `allowAllUnixSockets`, and the caller says so in the run's output. */
      readonly unixSocketFilterOff: boolean
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
  /** `linuxUnixSocketFilterOptIn`'s answer for this host. Omitted reads as `false`. */
  readonly unixSocketFilterOptIn?: boolean
}

/** Real platform/tool/developer-dir facts — `process.platform`, a fresh `checkLinuxSandboxTools()` read, and a fresh `resolveRealDeveloperDir()` read. A caller wanting a stable answer across one dispatch reads it once and threads the result. */
export function realConfinementPlatformDeps(): ConfinementPlatformDeps {
  return {
    platform: process.platform,
    linuxTools: checkLinuxSandboxTools(),
    developerDir: resolveRealDeveloperDir(),
    unixSocketFilterOptIn: linuxUnixSocketFilterOptIn()
  }
}

/**
 * O1/O2/O5 — the Claude half of the provider-neutral confinement interface:
 * takes a role, its task worktree, its scratch directory and the hosts it
 * may reach (`ConfinementRequest`), and returns the vendor configuration for
 * that dispatch (`ConfinementResolution`) — `dispatch.ts` calls this once for
 * every unattended Claude dispatch rather than branching on platform itself
 * to decide how to confine it.
 *
 * Always confined on macOS — Claude Code's own sandbox there "needs nothing
 * installed" (it ships with the OS, Seatbelt-backed). On Linux, confined
 * only when both `LINUX_CLAUDE_SANDBOX_TOOLS` are present; otherwise returns
 * `confined: false` with a warning naming the missing tool(s). The caller
 * refuses that outcome before spawning an unattended worker, because a
 * same-UID unconfined worker could reach another task's driver-run dev-tools
 * socket. The resolver itself never installs anything or starts the vendor.
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
      settings: buildClaudeSandboxSettings(request),
      scratchDir: request.scratchDir,
      pathOverride,
      unixSocketFilterOff: false
    }
  }
  if (deps.platform === 'linux') {
    if (deps.linuxTools.available) {
      const unixSocketFilterOff = deps.unixSocketFilterOptIn === true
      return {
        ok: true,
        confined: true,
        settings: buildClaudeSandboxSettings(request, { allowAllUnixSockets: unixSocketFilterOff }),
        scratchDir: request.scratchDir,
        pathOverride,
        unixSocketFilterOff
      }
    }
    return {
      ok: true,
      confined: false,
      warning:
        `Claude Code's own sandbox needs ${LINUX_CLAUDE_SANDBOX_TOOLS.join(' and ')} on Linux; missing: ` +
        `${deps.linuxTools.missing.join(', ')}.`,
      missingTools: deps.linuxTools.missing
    }
  }
  return {
    ok: true,
    confined: false,
    warning: `Claude Code's own sandbox names no mechanism for platform '${deps.platform}'.`,
    missingTools: []
  }
}

// --- The Linux host opt-in and the pre-spawn sandbox probe ------------------

/**
 * The host-level switch that lets Claude Code run on a Linux host whose
 * kernel refuses the sandbox's Unix-socket seccomp step. Read from the
 * driver's own process environment, never from repository configuration, so
 * one host's trade-off never reaches another machine through a commit.
 */
export const LINUX_SANDBOX_ALLOW_UNIX_SOCKETS_ENV = 'VINAYA_LINUX_SANDBOX_ALLOW_UNIX_SOCKETS'

/**
 * Every env file Bun could load into `process.env` from the working directory
 * on its own, so a committed one could otherwise set the opt-in: `.env`,
 * `.env.local`, and the per-mode pair for each mode Bun picks from `NODE_ENV`
 * (including `development`, its choice when `NODE_ENV` is unset, and `test`
 * under its test runner), plus any other `.env*` file the directory holds.
 * Wider than what one run loads, never narrower.
 */
function bunAutoloadedEnvFiles(env: NodeJS.ProcessEnv, listed: readonly string[]): string[] {
  const modes = new Set(['development', 'production', 'test', ...(env.NODE_ENV ? [env.NODE_ENV] : [])])
  const named = ['.env', '.env.local', ...[...modes].flatMap((mode) => [`.env.${mode}`, `.env.${mode}.local`])]
  return [...new Set([...named, ...listed.filter((name) => /^\.env(\..+)?$/.test(name))])]
}

export type UnixSocketOptInDeps = {
  readonly env: NodeJS.ProcessEnv
  readonly platform: NodeJS.Platform
  readonly cwd: string
  /** The file's text, or `null` when it does not exist or cannot be read. */
  readonly readFile: (path: string) => string | null
  /** The directory's entry names, `[]` when it cannot be listed. Omitted lists the real directory. */
  readonly listDir?: (dir: string) => string[]
}

function listDirOrEmpty(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * `true` only on Linux, only when the variable is exactly `1`, and only when
 * no env file Bun would load from the working directory names it — a
 * repository's own `.env` never turns the filter off. Never `true` on macOS.
 */
export function linuxUnixSocketFilterOptIn(
  deps: UnixSocketOptInDeps = {
    env: process.env,
    platform: process.platform,
    cwd: process.cwd(),
    readFile: readFileOrNull
  }
): boolean {
  if (deps.platform !== 'linux') return false
  if (deps.env[LINUX_SANDBOX_ALLOW_UNIX_SOCKETS_ENV] !== '1') return false
  const assignment = new RegExp(`^\\s*(?:export\\s+)?${LINUX_SANDBOX_ALLOW_UNIX_SOCKETS_ENV}\\s*=`, 'm')
  const files = bunAutoloadedEnvFiles(deps.env, (deps.listDir ?? listDirOrEmpty)(deps.cwd))
  return !files.some((file) => assignment.test(deps.readFile(join(deps.cwd, file)) ?? ''))
}

/** What a sandboxed probe command prints; the probe passes only when the sandbox's own output carries it. */
export const SANDBOX_PROBE_MARKER = 'vinaya-sandbox-probe-ok'

/** The one Bash command the Claude probe asks for, and the only one its permission rules allow. */
export const CLAUDE_SANDBOX_PROBE_COMMAND = `echo ${SANDBOX_PROBE_MARKER}`

export const CLAUDE_SANDBOX_PROBE_PROMPT =
  `Run exactly this Bash command once, with no changes: ${CLAUDE_SANDBOX_PROBE_COMMAND}\n` +
  'Do not run anything else. Then reply with the single word: done.'

/** Long enough for one model turn on a slow host; the probe refuses the dispatch past it. */
export const SANDBOX_PROBE_TIMEOUT_MS = 120_000

export type SandboxProbeRun = {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

export type SandboxProbeRunner = (input: {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly stdin: string
  readonly timeoutMs: number
}) => Promise<SandboxProbeRun>

export type SandboxProbeResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly error: string
      /** Set when the Claude probe's turn ran no command, so the failure is not the sandbox's own. */
      readonly noCommandRan?: true
    }

/** Keeps a quoted sandbox error to a readable size in a refusal line. */
function quoteProbeOutput(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > 2000 ? `${trimmed.slice(0, 2000)}…` : trimmed
}

/**
 * The Claude probe's argv: print mode with the dispatch's own settings file
 * (so the sandbox block is byte-for-byte the dispatch's), only the Bash tool,
 * no MCP server, the cheapest model, and a turn cap.
 */
export function claudeSandboxProbeArgs(settingsPath: string): string[] {
  return [
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--model',
    'haiku',
    '--max-turns',
    '3',
    '--tools',
    'Bash',
    '--allowedTools',
    `Bash(${CLAUDE_SANDBOX_PROBE_COMMAND})`,
    '--strict-mcp-config',
    '--settings',
    settingsPath
  ]
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) =>
      part !== null && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : ''
    )
    .join('\n')
}

/**
 * Judges the Claude probe from the Bash tool's own result in the stream, never
 * from what the model says: the probe passes only when a tool result that is
 * not an error carries the marker. A failure quotes the tool result — the
 * sandbox's own error — or, with no tool result at all, Claude's own output.
 */
export function readClaudeSandboxProbe(run: SandboxProbeRun): SandboxProbeResult {
  const toolResults: Array<{ text: string; isError: boolean }> = []
  let finalResult = ''
  for (const line of run.stdout.split('\n')) {
    if (line.trim() === '') continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event === null || typeof event !== 'object') continue
    const record = event as { type?: unknown; result?: unknown; message?: { content?: unknown } }
    if (record.type === 'result' && typeof record.result === 'string') finalResult = record.result
    if (record.type !== 'user' || !Array.isArray(record.message?.content)) continue
    for (const part of record.message.content as unknown[]) {
      if (part === null || typeof part !== 'object') continue
      const block = part as { type?: unknown; content?: unknown; is_error?: unknown }
      if (block.type !== 'tool_result') continue
      toolResults.push({ text: toolResultText(block.content), isError: block.is_error === true })
    }
  }
  if (toolResults.some((r) => !r.isError && r.text.includes(SANDBOX_PROBE_MARKER))) return { ok: true }
  if (run.timedOut) return { ok: false, error: `the probe did not finish within ${SANDBOX_PROBE_TIMEOUT_MS / 1000}s` }
  const sandboxOutput = toolResults.find((r) => r.text.trim() !== '')?.text
  if (sandboxOutput !== undefined) return { ok: false, error: quoteProbeOutput(sandboxOutput) }
  // No Bash tool result at all: the model declined, or Claude Code itself
  // failed (login, outage, unknown model) before any command reached the
  // sandbox. That is not the sandbox's error, so the refusal says the sandbox
  // could not be confirmed, and the caller may try once more.
  const said = quoteProbeOutput(finalResult || run.stderr) || `claude exited ${run.exitCode ?? 'without a status'}`
  return {
    ok: false,
    noCommandRan: true,
    error: `Claude ran no Bash command, so the sandbox could not be confirmed to run one: ${said}`
  }
}

/**
 * The Codex probe's argv up to the command: `codex sandbox` ignores the staged
 * config's `sandbox_mode` unless it also arrives as an override, so the
 * staged value is passed that way, as the conformance suite does. `null` when
 * the config names no mode.
 */
export function codexSandboxProbeArgs(configToml: string): string[] | null {
  const mode = configToml.match(/^sandbox_mode = ("[^"]+")$/m)?.[1]
  return mode === undefined ? null : ['sandbox', '--config', `sandbox_mode=${mode}`]
}

/** The Codex probe passes when the sandboxed command exits 0 and prints the marker; otherwise it quotes the sandbox's own stderr. */
export function readCodexSandboxProbe(run: SandboxProbeRun): SandboxProbeResult {
  if (run.exitCode === 0 && run.stdout.includes(SANDBOX_PROBE_MARKER)) return { ok: true }
  if (run.timedOut) return { ok: false, error: `the probe did not finish within ${SANDBOX_PROBE_TIMEOUT_MS / 1000}s` }
  return {
    ok: false,
    error:
      quoteProbeOutput(run.stderr || run.stdout) ||
      `codex sandbox exited ${run.exitCode ?? 'without a status'} without printing the probe marker`
  }
}

/** Spawns the probe asynchronously, kills it at its budget, and never throws. */
export const runRealSandboxProbe: SandboxProbeRunner = (input) =>
  new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(input.command, [...input.args], {
        cwd: input.cwd,
        env: input.env,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (err) {
      resolve({ exitCode: null, stdout: '', stderr: (err as Error).message, timedOut: false })
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, input.timeoutMs)
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (err) => {
      stderr += err.message
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code, stdout, stderr, timedOut })
    })
    child.stdin?.on('error', () => {
      // a child that exits before reading its prompt is judged by its output.
    })
    child.stdin?.end(input.stdin)
  })

export type SandboxProbePlan =
  | {
      readonly agent: 'claude'
      readonly binaryPath: string
      readonly cwd: string
      readonly env: NodeJS.ProcessEnv
      /** The dispatch's own settings file, carrying its `sandbox` block. */
      readonly settingsPath: string
    }
  | {
      readonly agent: 'codex'
      readonly binaryPath: string
      readonly cwd: string
      /** Carries the dispatch's staged `CODEX_HOME`. */
      readonly env: NodeJS.ProcessEnv
      /** The staged `config.toml` the dispatch's `CODEX_HOME` holds. */
      readonly configToml: string
      /** Adds the dispatch's own extra writable roots to the probe's argv, as the dispatch receives them. */
      readonly withWritableDirs: (args: readonly string[]) => string[]
    }

/**
 * Runs one trivial command through the agent's real sandbox, configured as
 * the dispatch is, and judges it from the sandbox's own output. Linux only:
 * on any other platform nothing runs and the result is `ok`. Claude Code has
 * no command that runs one line in its sandbox without a model turn, so the
 * Claude probe is one short print-mode turn asked to run the marker command;
 * Codex has `codex sandbox`, so its probe starts no model at all.
 */
export async function probeAgentSandbox(
  plan: SandboxProbePlan,
  deps: { readonly platform: NodeJS.Platform; readonly run: SandboxProbeRunner } = {
    platform: process.platform,
    run: runRealSandboxProbe
  }
): Promise<SandboxProbeResult> {
  if (deps.platform !== 'linux') return { ok: true }
  if (plan.agent === 'claude') {
    const runOnce = async (): Promise<SandboxProbeResult> =>
      readClaudeSandboxProbe(
        await deps.run({
          command: plan.binaryPath,
          args: claudeSandboxProbeArgs(plan.settingsPath),
          cwd: plan.cwd,
          env: plan.env,
          stdin: CLAUDE_SANDBOX_PROBE_PROMPT,
          timeoutMs: SANDBOX_PROBE_TIMEOUT_MS
        })
      )
    const first = await runOnce()
    // A turn that ran no command says nothing about the sandbox; one more
    // turn rules out a passing model or service hiccup before refusing.
    return !first.ok && first.noCommandRan === true ? runOnce() : first
  }
  const baseArgs = codexSandboxProbeArgs(plan.configToml)
  if (baseArgs === null) {
    return { ok: false, error: 'the staged Codex config names no sandbox_mode, so its sandbox cannot be probed' }
  }
  const run = await deps.run({
    command: plan.binaryPath,
    args: [...plan.withWritableDirs(baseArgs), '--', 'echo', SANDBOX_PROBE_MARKER],
    cwd: plan.cwd,
    env: plan.env,
    stdin: '',
    timeoutMs: SANDBOX_PROBE_TIMEOUT_MS
  })
  return readCodexSandboxProbe(run)
}

// --- O1/O2/O4/O5 (task 4): Codex's half of the provider-neutral confinement
// interface ----------------------------------------------------------------

/**
 * Codex's own `workspace-write` sandbox on Linux is bubblewrap-backed, the
 * same primitive Claude Code's shipped sandbox drives internally (§4a) —
 * confirmed against the real installed CLI's own help text ("Codex uses the
 * first `bwrap` executable it finds on PATH") and `doctor` output (a Linux
 * helper path under `codex-linux-sandbox`). Unlike Claude's own Linux
 * mechanism, Codex's documented network proxy is self-contained (the Codex
 * binary runs its own local proxy process) — it names no second bridging
 * tool the way Claude's `socat` egress bridge does, so this list is `bwrap`
 * alone, never `LINUX_CLAUDE_SANDBOX_TOOLS`'s pair.
 */
export const LINUX_CODEX_SANDBOX_TOOLS = ['bwrap'] as const

/** `LINUX_CODEX_SANDBOX_TOOLS`'s own availability check — same shape as `checkLinuxSandboxTools`, over the narrower Codex tool list, so the two mechanisms' availability can differ (a host missing only `socat` fails Claude's check but passes this one). */
export function checkLinuxCodexSandboxTools(
  deps: LinuxSandboxToolDeps = REAL_LINUX_SANDBOX_TOOL_DEPS
): LinuxSandboxToolCheck {
  const missing = LINUX_CODEX_SANDBOX_TOOLS.filter((tool) => !deps.commandExists(tool))
  return { available: missing.length === 0, missing }
}

/** Escapes a value for a TOML basic string (`"..."`) — the two characters that would otherwise terminate the literal early or splice an escape sequence into it. */
function escapeTomlString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function tomlString(value: string): string {
  return `"${escapeTomlString(value)}"`
}

/**
 * O1–O3: the config.toml content `stageCodexPolicyHome` writes into a
 * confined Codex dispatch's own staged `CODEX_HOME`, read identically by a
 * fresh `codex exec` and a resumed `codex exec resume` (O3) — the latter
 * accepts no `--sandbox` flag at all (confirmed live via `codex exec resume
 * --help` against the real installed CLI, 0.152.1/0.160.0), so this file is
 * the only place that can set its sandbox mode.
 *
 * Confirmed live against the real installed `codex-cli` (0.152.1 and
 * 0.160.0, `@openai/codex` on npm), and cross-checked against the vendor's
 * own published documentation (`developers.openai.com/codex/config-reference`,
 * `.../config-advanced`):
 *
 * - `sandbox_mode = "workspace-write"` — the top-level config key `-s,
 *   --sandbox` sets per-invocation; this is its config.toml equivalent, the
 *   only route a resumed run has to it.
 * - `[sandbox_workspace_write] network_access = true` — confirmed as the
 *   ONLY network-related field `SandboxWorkspaceWrite` carries (the other
 *   three are `writable_roots`/`exclude_tmpdir_env_var`/`exclude_slash_tmp`,
 *   none of them network-shaped) by enumerating the struct's own serialized
 *   field names directly off the installed binary. The task's own worktree
 *   is the implicit, always-writable "primary workspace" (`codex exec
 *   --help`'s own `--add-dir` wording: "Additional directories that should
 *   be writable ALONGSIDE the primary workspace") — `writable_roots` is
 *   deliberately omitted here; `addCodexWritableDirs` (`dispatch.ts`) is the
 *   existing, already fresh/resumed-safe mechanism for the EXTRA roots a
 *   given dispatch needs (the scratch directory, a reviewer's own work
 *   directory), and duplicating that list here would risk a resumed run's
 *   own `--config sandbox_workspace_write.writable_roots=…` override (a
 *   plain key assignment, not a merge) silently replacing — not
 *   extending — whatever this file names.
 * - `.git` read-only: per the vendor's own documentation ("In workspace-write
 *   mode, some environments keep `.git/` and `.codex/` read-only even when
 *   the rest of the workspace is writable") — Codex's own protection, not
 *   something this config requests or could turn off; O1's own framing
 *   ("as Codex protects it") names this as a fact to rely on, not a setting.
 * - `[features.network_proxy] enabled = true` plus `[features.network_proxy.
 *   domains]` as a `map<string, "allow"|"deny">` — confirmed live: `codex
 *   exec --strict-config` accepts exactly this shape (neither a bare
 *   `allowed_domains` array under `sandbox_workspace_write` nor a top-level
 *   `[network]`/`[network_proxy]` table exists in the installed schema —
 *   both were tried live and rejected with "unknown configuration field").
 *   O5: a request to a host with no entry here is refused by the proxy
 *   (never allowed by a missing-entry default) — a domain list limits WHERE
 *   traffic goes, never WHAT is sent to an allowed host (`isolation.md` O5).
 *   `request.allowedHosts` (GitHub, the npm registry) PLUS the official
 *   vendor documentation hosts (`DOCUMENTATION_HOSTS`) appear here, each
 *   mapped to `"allow"` — this function never writes a `"deny"` entry, since
 *   nothing this task dispatches needs one named explicitly to stay refused
 *   by default.
 * - `web_search = "live"` (O9) — a TOP-LEVEL key, confirmed live and
 *   cross-checked against the vendor's own `config-reference` page as
 *   independent of every setting above: "These search-domain filters are
 *   separate from sandboxed-command network domain rules and do not
 *   restrict connectors or MCP servers." It lets a confined Codex Developer
 *   FIND an official documentation page; READING that page's content is a
 *   sandboxed-command network fetch, so O5 ALSO names the vendors' own
 *   documentation hosts (`DOCUMENTATION_HOSTS`) in
 *   `[features.network_proxy.domains]` above — a live Codex run found web
 *   search alone completed but the page read was refused as "domain is not
 *   on the allowlist". Named one by one, never a broad documentation
 *   allowance (the brief's Trap).
 */
export function buildCodexSandboxConfigToml(request: ConfinementRequest): string {
  // O5: the sandboxed-command network allowlist is `request.allowedHosts`
  // (GitHub, the npm registry) PLUS the official vendor documentation hosts
  // (`DOCUMENTATION_HOSTS`), so a confined Codex Developer can READ a
  // documentation page its web search found, not merely find it. De-duped so
  // a host already in `allowedHosts` is never written twice.
  const hosts = [...new Set([...request.allowedHosts, ...DOCUMENTATION_HOSTS])]
  const domainLines = hosts.map((host) => `${tomlString(host)} = "allow"`)
  return [
    'sandbox_mode = "workspace-write"',
    'web_search = "live"',
    '',
    '[sandbox_workspace_write]',
    'network_access = true',
    '',
    '[features.network_proxy]',
    'enabled = true',
    '',
    '[features.network_proxy.domains]',
    ...domainLines,
    ''
  ].join('\n')
}

export type CodexConfinementResolution =
  | { readonly ok: true; readonly configToml: string }
  | {
      readonly ok: false
      /** Names the missing capability (O4) — `bwrap` on Linux, or the platform itself when neither mechanism this module knows applies. */
      readonly reason: string
    }

/**
 * Real platform/tool facts for Codex's own mechanism — mirrors
 * `realConfinementPlatformDeps`, over `checkLinuxCodexSandboxTools` rather
 * than Claude's tool list, so the two never share one (possibly stale)
 * cached answer. `developerDir` is always `null` here: `resolveCodexConfinement`
 * never reads it (Codex's own `buildCodexSandboxConfigToml` carries no PATH
 * override — that is `dispatch.ts`'s Claude-only `resolveGitFirstPath`
 * concern) — the field exists only so Codex can share `ConfinementPlatformDeps`
 * with Claude's own resolver rather than needing a second, near-identical type.
 */
export function realCodexConfinementPlatformDeps(): ConfinementPlatformDeps {
  return { platform: process.platform, linuxTools: checkLinuxCodexSandboxTools(), developerDir: null }
}

/**
 * O1/O2/O4 — the Codex half of the provider-neutral confinement interface:
 * the SAME `ConfinementRequest` shape `resolveClaudeConfinement` takes,
 * resolved through Codex's own mechanism instead. Unlike Claude's own
 * resolution, this NEVER degrades to an unconfined run — O4 requires an
 * unattended Codex dispatch to refuse before starting, naming the missing
 * capability, when its sandbox or network proxy is unavailable, since Codex
 * carries no per-dispatch machine-state floor outside this boundary the way
 * `stageCodexPolicyHome`'s own non-boundary branch gives Claude's settings
 * file (`isolation.md` §4's own framing for why an unattended Codex start
 * has always refused, never degraded, on an unsupported host).
 *
 * Always available on macOS — Codex's own sandbox there is Seatbelt-backed
 * and "needs nothing installed," the same posture Claude's shipped sandbox
 * takes on the same platform. On Linux, available only when `bwrap`
 * resolves on `PATH` (`checkLinuxCodexSandboxTools`); the caller
 * (`dispatchRole`) turns an `ok: false` here into a pre-spawn refusal,
 * before any Codex process starts.
 */
export function resolveCodexConfinement(
  request: ConfinementRequest,
  deps: ConfinementPlatformDeps = realCodexConfinementPlatformDeps()
): CodexConfinementResolution {
  if (deps.platform === 'darwin') {
    return { ok: true, configToml: buildCodexSandboxConfigToml(request) }
  }
  if (deps.platform === 'linux') {
    if (deps.linuxTools.available) {
      return { ok: true, configToml: buildCodexSandboxConfigToml(request) }
    }
    return {
      ok: false,
      reason:
        `Codex's own sandbox and network proxy need ${LINUX_CODEX_SANDBOX_TOOLS.join(' and ')} on Linux; missing: ` +
        `${deps.linuxTools.missing.join(', ')}`
    }
  }
  return {
    ok: false,
    reason: `Codex's own sandbox and network proxy name no mechanism for platform '${deps.platform}'`
  }
}

// --- O1/O2: after-turn verification, outside the agent ---------------------
//
// `isolation.md` §4a/§4b's own disclosed gaps (neither vendor's shipped
// sandbox scopes READS the way the retired Seatbelt profile did, and egress
// is destination-allowlisted, never content-inspected) are never closed by
// anything below. This section is the driver's OWN check, run from the
// trusted Controller after a dispatch returns, never during it — detection
// of a persisted change or a recognizable credential value, not a third
// confinement mechanism. `isolation.md`'s own new section states this
// distinction and what it cannot see; the functions here are its mechanism.

/** One path this task's after-turn check hashes — `'dir'` walks the whole tree; `'file'` hashes the one file. */
export type ProtectedPathEntry = { path: string; kind: 'file' | 'dir' }

/** `null` when `path` does not exist or cannot be read — never throws. The hash of an absent path and the hash of a path that genuinely holds nothing are both `null`, which is fine: a path that goes from absent to present, or back, still compares unequal against the hash of real content. */
function hashFileContent(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

/**
 * Deterministic hash of a directory's whole tree: every entry's path
 * (relative to `dir`, forward-slash-joined, sorted so traversal order never
 * changes the digest), folded together with its own content hash — a
 * regular file's bytes, or a symlink's literal target text, NEVER the
 * target's own content. A symlink is read as its link text, not followed:
 * replacing a protected file with a symlink into an unprotected path must
 * register as the change it is, not silently re-hash whatever the link
 * happens to resolve to. `null` when `dir` does not exist (a store that has
 * not written anything yet is a legitimate starting state, not a read
 * failure to report as one).
 */
function hashDirectoryTree(dir: string): string | null {
  if (!existsSync(dir)) return null
  const digest = createHash('sha256')
  const walk = (current: string, rel: string): void => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const abs = join(current, entry.name)
      const relPath = rel.length > 0 ? `${rel}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) {
        let target = ''
        try {
          target = execFileSync('readlink', [abs], { encoding: 'utf8' }).trim()
        } catch {
          target = '<unreadable-symlink>'
        }
        digest.update(`L ${relPath} ${target}\n`)
      } else if (entry.isDirectory()) {
        walk(abs, relPath)
      } else if (entry.isFile()) {
        digest.update(`F ${relPath} ${hashFileContent(abs) ?? '<unreadable-file>'}\n`)
      }
    }
  }
  walk(dir, '')
  return digest.digest('hex')
}

function hashProtectedPath(entry: ProtectedPathEntry): string | null {
  return entry.kind === 'dir' ? hashDirectoryTree(entry.path) : hashFileContent(entry.path)
}

/** The "before" half of O1's check — one hash per entry, taken fresh from disk, never from a cached copy (Traps to avoid). */
export function snapshotProtectedPaths(entries: readonly ProtectedPathEntry[]): Record<string, string | null> {
  const snapshot: Record<string, string | null> = {}
  for (const entry of entries) snapshot[entry.path] = hashProtectedPath(entry)
  return snapshot
}

/** The "after" half — re-hashes every entry fresh and returns exactly the paths whose hash no longer matches `before`, in `entries` order. Empty when nothing changed. */
export function changedProtectedPaths(
  entries: readonly ProtectedPathEntry[],
  before: Readonly<Record<string, string | null>>
): string[] {
  const changed: string[] = []
  for (const entry of entries) {
    const after = hashProtectedPath(entry)
    if (after !== (before[entry.path] ?? null)) changed.push(entry.path)
  }
  return changed
}

/**
 * One turn's after-turn protected-path check, with writes attributed by
 * driver tool-call boundary. `driverToolCall` wraps each call the driver's own
 * tools serve during the turn (commit and push, open pull request, refresh
 * evidence, …): right before the call runs, any change to a
 * `driverWrittenPaths` entry since its last baseline is recorded as the
 * worker's — it happened between tool calls — and right after the call
 * returns, those entries are re-hashed as the new baseline, so the records
 * the tool itself wrote are the driver's. `changedPaths` reports every path
 * the worker changed: the ones recorded at a tool-call start plus whatever
 * still differs from the latest baseline now.
 *
 * Only `driverWrittenPaths` are ever re-baselined, and only at a tool-call
 * return — never on a timer, never at turn end. A turn with no tool calls (a
 * reviewer's) compares against the one snapshot taken before it started,
 * exactly as `snapshotProtectedPaths`/`changedProtectedPaths` do. While one
 * tool call is still in flight another may start; a write made in that
 * overlap cannot be told apart from the in-flight call's own, so it is
 * attributed to the driver, and the baseline is re-taken only once no call
 * is in flight.
 */
export type TurnWriteAttribution = {
  driverToolCall: <T>(call: () => Promise<T>) => Promise<T>
  changedPaths: () => string[]
}

export function startTurnWriteAttribution(
  entries: readonly ProtectedPathEntry[],
  driverWrittenPaths: readonly string[]
): TurnWriteAttribution {
  const baseline = snapshotProtectedPaths(entries)
  const driverEntries = entries.filter((entry) => driverWrittenPaths.includes(entry.path))
  const workerChanged = new Set<string>()
  let inFlight = 0
  return {
    driverToolCall: async (call) => {
      if (inFlight === 0) {
        for (const path of changedProtectedPaths(driverEntries, baseline)) workerChanged.add(path)
      }
      inFlight += 1
      try {
        return await call()
      } finally {
        inFlight -= 1
        if (inFlight === 0) Object.assign(baseline, snapshotProtectedPaths(driverEntries))
      }
    },
    changedPaths: () => {
      const changedNow = new Set(changedProtectedPaths(entries, baseline))
      return entries.map((entry) => entry.path).filter((path) => workerChanged.has(path) || changedNow.has(path))
    }
  }
}

/** The task's control store — the one protected entry the driver's own tools write during a turn (effect and ownership records), so the one `startTurnWriteAttribution` re-baselines after each tool call. */
export function taskControlDir(runtimeDir: string, task: number): string {
  return join(runtimeDir, 'tasks-execution', String(task), 'control')
}

/** `statSync`-based, not name-based — a sessions-area entry is a `.json` file for one role+agent or a `-config` directory for the same; asking the filesystem is simpler than parsing the name and cannot drift from it. `'file'` on any stat failure (an entry that vanished between listing and stat is reported as a file that is now simply absent, never a crash). */
function entryKind(path: string): 'file' | 'dir' {
  try {
    return statSync(path).isDirectory() ? 'dir' : 'file'
  } catch {
    return 'file'
  }
}

/** The directory name `rounds/<n>` holds for each role — `developer` is literal; a reviewer/security round directory is named `reviewer-work`/`security-work`, with a `-retry<k>` suffix for a later attempt (`reviewerWorkDir`, `dev-review-loop/reviewer-dispatch.ts`) — so a prefix match, not an exact one, is what "belongs to this role" means for those two. */
function roundEntryBelongsToRole(name: string, role: Role): boolean {
  if (role === 'developer') return name === 'developer'
  const prefix = role === 'code-reviewer' ? 'reviewer-work' : 'security-work'
  return name === prefix || name.startsWith(`${prefix}-retry`)
}

/** Every role this file's sessions area ever names in a filename — the three worker roles a turn can actually be dispatched as. `code-reviewer` itself contains a `-`, so matching against this list (longest/most-specific first) is what makes the split unambiguous; splitting on the first `-` alone (round 2 review, BLOCKER) misreads `code-reviewer-<agent>.json` as role `code`. */
const SESSION_ENTRY_ROLES: readonly Role[] = ['code-reviewer', 'developer', 'security']

/** The sessions-area filename `<role>-<agent>.json`/`<role>-<agent>-config` names its role as one of `SESSION_ENTRY_ROLES`, matched by prefix — never a bare first-`-` split, which breaks on `code-reviewer`'s own hyphen. Falls back to the first segment for a name this task's roles never produce, so an unrecognized file is still a plausible string here, never a crash. */
function sessionEntryRole(name: string): string {
  for (const role of SESSION_ENTRY_ROLES) {
    if (name === role || name.startsWith(`${role}-`)) return role
  }
  return name.split('-')[0] ?? name
}

/**
 * O1: the paths this task's after-turn check calls "other roles' folders" —
 * every OTHER role's session record/staged config directory and every OTHER
 * role's round work directory, for every round this task has on disk, minus
 * two deliberate exceptions:
 *
 * - This role's own entries are never in the list at all — this IS the
 *   dispatch whose turn is ending, and it is expected to write there.
 * - `code-reviewer` and `security` dispatch CONCURRENTLY, in one
 *   `Promise.all` (`dev-review-loop.ts`), for the SAME round — so a
 *   reviewer's own check must not protect its sibling's SAME-round folder,
 *   which may still be mid-write when this dispatch's own turn ends. Every
 *   OTHER round's sibling folder stays protected; only `round`'s is excused,
 *   and only for the sibling, never for a THIRD role (there is none here).
 */
function otherRolesProtectedPaths(input: {
  runtimeDir: string
  task: number
  round: number
  role: Role
}): ProtectedPathEntry[] {
  const entries: ProtectedPathEntry[] = []
  const concurrentSibling: Role | null =
    input.role === 'code-reviewer' ? 'security' : input.role === 'security' ? 'code-reviewer' : null

  const sessionsDir = join(input.runtimeDir, 'tasks-execution', String(input.task), 'sessions')
  if (existsSync(sessionsDir)) {
    for (const name of readdirSync(sessionsDir)) {
      const role = sessionEntryRole(name)
      if (role === input.role) continue
      if (concurrentSibling !== null && role === concurrentSibling) continue
      const path = join(sessionsDir, name)
      entries.push({ path, kind: entryKind(path) })
    }
  }

  const roundsDir = join(input.runtimeDir, 'tasks-execution', String(input.task), 'rounds')
  if (existsSync(roundsDir)) {
    for (const roundName of readdirSync(roundsDir)) {
      const roundNum = Number(roundName)
      if (!Number.isInteger(roundNum)) continue
      const roundDir = join(roundsDir, roundName)
      for (const name of readdirSync(roundDir)) {
        if (roundEntryBelongsToRole(name, input.role)) continue
        if (concurrentSibling !== null && roundNum === input.round && roundEntryBelongsToRole(name, concurrentSibling))
          continue
        const path = join(roundDir, name)
        entries.push({ path, kind: entryKind(path) })
      }
    }
  }
  return entries
}

/** The per-run required-sources manifest the Documentation read-gate's Stop hook reads (`writeDispatchSettings`'s `documentation-sources-<runId>.json`) — written once, by the trusted Controller, before dispatch, and never legitimately rewritten during a turn. Its sibling `documentation-log-<runId>.jsonl` is deliberately NOT protected here: the hook itself appends to it as the direct, legitimate effect of the dispatched session's own successful fetch, so hashing it as "must not change" would refuse the very thing the gate exists to observe. */
const SOURCE_RECEIPT_FILE_PATTERN = /^documentation-sources-.*\.json$/

function sourceReceiptPaths(hooksDir: string): ProtectedPathEntry[] {
  const entries: ProtectedPathEntry[] = []
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, name.name)
      if (name.isDirectory()) walk(abs)
      else if (name.isFile() && SOURCE_RECEIPT_FILE_PATTERN.test(name.name)) entries.push({ path: abs, kind: 'file' })
    }
  }
  walk(hooksDir)
  return entries
}

/**
 * The concrete, per-turn protected-path list O1 names: the control store
 * (effect records live inside it — `effectDir`/`effectPath`,
 * `packages/aeg-core/src/control-store/local.ts` — so one entry covers
 * both), the source receipts and the driver's documentation read receipts,
 * every other role's folder (scoped per
 * `otherRolesProtectedPaths`'s own doc comment), and the policy
 * configuration file. The dispatched role's own worktree and scratch
 * directory are never named here — they are what this turn is expected to
 * change.
 *
 * `vinayaConfigPath: null` (the caller's `configPath()` found neither a
 * repo-local nor a global config) drops ONLY the one config-file entry —
 * every other entry here reads straight off `runtimeDir`/`task`/`role` and
 * owes nothing to the config file's own existence, so an unreadable config
 * must never fail the WHOLE per-turn check open (round 2 review, MINOR).
 */
export function protectedPathsForTurn(input: {
  runtimeDir: string
  task: number
  round: number
  role: Role
  vinayaConfigPath: string | null
}): ProtectedPathEntry[] {
  const taskDir = join(input.runtimeDir, 'tasks-execution', String(input.task))
  const entries: ProtectedPathEntry[] = [
    { path: taskControlDir(input.runtimeDir, input.task), kind: 'dir' },
    ...sourceReceiptPaths(join(taskDir, 'hooks')),
    // Listed whether or not it exists yet: the driver's `fetch_documentation`
    // tool creates it mid-turn, and that write is attributed to the driver by
    // tool-call boundary (`startTurnWriteAttribution`), never to the worker.
    { path: documentationReceiptsPath(join(taskDir, 'hooks')), kind: 'file' },
    ...otherRolesProtectedPaths(input)
  ]
  if (input.vinayaConfigPath !== null) entries.push({ path: input.vinayaConfigPath, kind: 'file' })
  return entries
}

// --- O2: credential recognition, never the value itself --------------------

/** One recognizable credential SHAPE — a real vendor/format-specific prefix or structure, never a generic field name (`access_token`, `password`), which this codebase's own tests and fixtures use constantly for values that are not secrets at all). */
type CredentialPattern = { name: string; pattern: RegExp }

/** Deliberately narrow: every pattern here matches a specific, real credential FORMAT (a vendor's own documented token prefix, a PEM key header, a three-part JWT), never a variable or field name — scanning for `/password|secret|token/i` would flag this very file's own doc comments and this task's own test fixtures, which talk ABOUT credentials constantly without ever holding one. `isolation.md`'s own new section names this list as what the check recognizes, and that it recognizes nothing outside it. */
export const RECOGNIZED_CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
  { name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'GitHub fine-grained token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: 'AWS access key ID', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9-]{20,}\b/ },
  { name: 'OpenAI API key', pattern: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'PEM private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/ },
  { name: 'JSON Web Token', pattern: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ }
] as const

/** Where a recognized credential pattern appeared (O2's own label, never the match), and which pattern recognized it. */
export type CredentialFinding = { pattern: string; location: string }

/**
 * Scans `text` for a recognized credential shape (`RECOGNIZED_CREDENTIAL_PATTERNS`)
 * and reports, for each pattern that matches at least once, the pattern's
 * own name and the caller-supplied `location` label — NEVER the matched
 * substring, and never the surrounding text either, so a refusal built from
 * this can name where a credential appeared without ever printing it.
 */
export function findCredentialPatterns(text: string, location: string): CredentialFinding[] {
  const findings: CredentialFinding[] = []
  for (const { name, pattern } of RECOGNIZED_CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) findings.push({ pattern: name, location })
  }
  return findings
}

/**
 * O4: the lines a unified diff ADDED — the content the turn actually
 * wrote into the worktree, for the after-turn credential scan. A hunk's `+`
 * lines, with their leading `+` stripped; NEVER a context line (unchanged, a
 * leading space), a removed line (`-`), or a file/hunk header (`+++ `, `--- `,
 * `@@`, `diff `, `index `). Scanning the WHOLE diff instead would re-scan
 * context the turn merely moved past — including an existing credential-shaped
 * test fixture a hunk happens to sit beside — which is not what this turn
 * wrote. The `+++ ` file header is explicitly excluded even though it starts
 * with `+`: it is git's own framing, never added content.
 */
export function addedDiffLines(diff: string): string {
  const added: string[] = []
  let inHunk = false
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) inHunk = false
    else if (line.startsWith('@@ ') || line.startsWith('--- untracked: ')) inHunk = true
    else if (inHunk && line.startsWith('+')) added.push(line.slice(1))
  }
  return added.join('\n')
}
