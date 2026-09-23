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
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/** The same allowlist discipline `apps/cli/src/checks/runner.ts`'s `buildCheckEnv` already applies to a custom check's child — named here again, deliberately, rather than imported: `checks/runner.ts` sits outside this task's surface (`apps/cli/src/checks` is explicitly named `out:` in the dispatched brief), and this list is small enough that naming it twice costs less than reaching across that boundary. `apps/cli/specs/isolation.md` §2 documents this precedent as the pattern this module extends to the Worker/Reviewer dispatch path. */
export const WORKER_ENV_ALLOWLIST_KEYS = [
  'PATH',
  'LANG',
  'HOME',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'TMPDIR'
] as const

/**
 * O1/O2 (round 2 review, BLOCKER): the model-runtime credential a real
 * vendor CLI needs to keep answering at all once dispatched inside the
 * boundary — `isolation.md` §3's own pre-existing "runtime authentication
 * path" contract, unimplemented by this task until this finding. Verified
 * live on this authoring host, not guessed (`claude --help`): Claude's own
 * `--bare` flag documents that "Anthropic auth is strictly
 * `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings` (OAuth and keychain
 * are never read)" — confirming `ANTHROPIC_API_KEY` is a real, first-class
 * auth path, independent of the OAuth session file (`~/.claude/.credentials.json`
 * on this host) the sandbox profile denies. `--bare` itself is NOT threaded
 * through here — its own doc also says it skips "hooks", which would
 * silently disable the pre-existing PreToolUse background-deny mechanism
 * (`writeDispatchSettings`) this task's own brief named a trap ("Preserve
 * and test the incoming PreToolUse rule rather than duplicate it") — so a
 * confined Claude dispatch still tries OAuth/keychain first and falls
 * through to `ANTHROPIC_API_KEY` only because the sandbox denies the former;
 * this is a real but slightly less certain guarantee than `--bare` would
 * give, disclosed here rather than silently assumed.
 *
 * `codex`/`gemini` entries are NOT verified live — this host has neither
 * binary installed (confirmed: `which codex`/`which gemini` both fail) — so
 * their env var names follow each vendor's own well-documented public
 * convention (`OPENAI_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`) rather
 * than a live-confirmed reading of `--help`: disclosed as unverified rather
 * than invented, the same posture a prior task in this repo's history set
 * for an unverifiable Codex figure (marked explicitly unverified rather
 * than guessed).
 * Keyed by the plain vendor string (never `dispatch.ts`'s own `AgentVendor`
 * type) to avoid a circular import — `dispatch.ts` already imports FROM this
 * module.
 */
export const RUNTIME_CREDENTIAL_ENV_KEYS: Readonly<Record<string, readonly string[]>> = {
  claude: ['ANTHROPIC_API_KEY'],
  codex: ['CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY']
}

const CODEX_AUTH_FILE_NAME = 'auth.json'
const CODEX_KEYCHAIN_SERVICE = 'Codex Auth'

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
 * own Traps section) — so a confined `claude` session that authenticates by
 * subscription rather than `ANTHROPIC_API_KEY` needs a scoped COPY staged
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
  deps: Pick<WorkerBoundaryDeps, 'readOAuthCredentialFile'> = {}
): { configDir: string } | null {
  const sourceConfigDir = resolveOAuthConfigSourceDir(sourceEnv, realHome)
  const readFile = deps.readOAuthCredentialFile ?? readRealOAuthCredentialFile
  const contents = readFile(join(sourceConfigDir, OAUTH_CREDENTIAL_FILE_NAME))
  if (contents === null) return null
  const stagedConfigDir = join(scratchTmpDir, 'claude-config')
  mkdirSync(stagedConfigDir, { recursive: true })
  writeFileSync(join(stagedConfigDir, OAUTH_CREDENTIAL_FILE_NAME), contents, { mode: 0o600 })
  return { configDir: stagedConfigDir }
}

/**
 * Builds a confined child's environment from an explicit allowlist —
 * `sourceEnv`'s own `WORKER_ENV_ALLOWLIST_KEYS` values plus `extraAllowlistKeys`
 * (the dispatched vendor's own `RUNTIME_CREDENTIAL_ENV_KEYS`, named by the
 * caller — this function stays vendor-agnostic), plus every entry in
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
 */
export function buildWorkerEnv(
  sourceEnv: Readonly<Record<string, string | undefined>>,
  attribution: Readonly<Record<string, string | undefined>>,
  extraAllowlistKeys: readonly string[] = []
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const key of [...WORKER_ENV_ALLOWLIST_KEYS, ...extraAllowlistKeys]) {
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
  detectHost: detectRealHost,
  readOAuthCredentialFile: readRealOAuthCredentialFile,
  readCodexKeychainCredential: readRealCodexKeychainCredential,
  runCodexLoginWithAccessToken: runRealCodexLoginWithAccessToken,
  runCodexAuthPreflight: runRealCodexAuthPreflight,
  runCodexPluginInstall: runRealCodexPluginInstall
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
 *    review, HIGH):** a credential threaded into the confined env
 *    (`RUNTIME_CREDENTIAL_ENV_KEYS`) is inherited by any subprocess a
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
}

export type WorkerBoundaryResolution = { ok: true; launch: WorkerBoundaryLaunch } | { ok: false; reason: string }

/** Standard toolchain directories checked for presence on this host — never assumed. Only an existing directory is added to the profile's own `execAllowDirs`/read-allow list. */
const CANDIDATE_SYSTEM_BIN_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/opt/homebrew/bin']

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
 * a `#!/usr/bin/env node` shebang, `engines.node >=20`) runs under Node,
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
  codexHooksPath?: string | null
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

    // O1: staged into `scratchTmpDir` — a directory already
    // granted read+write below (`readWriteDirs`) — so this never widens the
    // profile beyond what the steady-state grant already covers. Resolved
    // here, before `readWriteDirs`/`execAllowDirs` are built, purely so the
    // staged path can be reported on the returned launch; it needs no
    // profile entry of its own.
    const oauthConfigDir = opts.stageOAuthCredential
      ? (stageOAuthCredential(process.env, realHome, scratchTmpDir, deps)?.configDir ?? null)
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
      codexHomeDir = join(scratchTmpDir, 'codex-home')
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
          // Security review (round 5), HIGH: `CODEX_API_KEY` is the sibling
          // credential `RUNTIME_CREDENTIAL_ENV_KEYS` names alongside
          // `CODEX_ACCESS_TOKEN` and `buildWorkerEnv` passes through from the
          // trusted controller's own env when set there — excluded here too,
          // for the same reason: Codex's own repository-spawned subprocesses
          // must never see it, only the Codex parent itself.
          '"CODEX_API_KEY" = "exclude"',
          ''
        ].join('\n'),
        { mode: 0o600 }
      )
      if (opts.codexHooksPath) {
        // Round 7 review, BLOCKER: see `buildCodexHooksMarketplace`'s own
        // doc comment for why this is a plugin install, never a bare file
        // write — a bare `hooks.json` at `CODEX_HOME` root is never
        // discovered by the real Codex CLI.
        const hooksContent = readFileSync(opts.codexHooksPath, 'utf8')
        const marketplaceDir = join(scratchTmpDir, 'codex-hooks-marketplace')
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
    const vinayaWritableDirs = opts.extraWritableDirs.map(canonical)
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
    const readOnlyDirs = Array.from(
      new Set([
        ...(opts.bootstrapWritableSubpaths ? [allowedDirReal] : []),
        ...vinayaReadOnlyDirs,
        ...runtimeReadOnlyDirs
      ])
    )
    const readWriteDirs = Array.from(
      new Set([
        ...(opts.bootstrapWritableSubpaths ? bootstrapWriteDirs : [allowedDirReal]),
        scratchTmpDir,
        ...vinayaWritableDirs
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
    const systemBinDirs = CANDIDATE_SYSTEM_BIN_DIRS.filter((d) => existsSync(d)).map((d) => realpathSync(d))
    const execAllowDirs = Array.from(
      new Set([
        allowedDirReal,
        runtimeDir,
        ...(gitExecPath ? [gitExecPath] : []),
        ...(bunExecDir ? [bunExecDir] : []),
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
        codexAccessToken
      }
    }
  } catch (error) {
    return { ok: false, reason: `worker boundary profile could not be built: ${(error as Error).message}` }
  }
}
