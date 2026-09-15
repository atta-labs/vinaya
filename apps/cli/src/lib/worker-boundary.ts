/**
 * Wires an unattended `dispatchRole` launch (`dispatch.ts`, O1) to the
 * OS-level confinement `apps/cli/specs/isolation.md` specifies and
 * `apps/cli/scripts/isolation-probe.ts` proves (task 1, `#549`) — the
 * surface that file's own "What this task does not change" section named
 * as a later task's job. This module (task 3, `#560`) is that later task.
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
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

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
}

export const REAL_WORKER_BOUNDARY_DEPS: WorkerBoundaryDeps = { detectHost: detectRealHost }

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
 * 2. **Network-outbound is allowed**, not denied — a real Worker must reach
 *    the model runtime endpoint to keep functioning as an agent
 *    (`isolation.md` §1, Worker row's own "Permitted operations"), and
 *    typically its own package registry. The SSH-agent socket is still
 *    denied specifically (a later, more specific rule than the general
 *    allow — Seatbelt profiles apply the LAST matching rule), matching the
 *    probe's own documented posture for check 5.
 * 3. **`HOME` is not replaced with a synthetic directory.** The real launch
 *    sets the child's `HOME` env value to the genuine home path (so any tool
 *    that constructs a `$HOME/.something` path resolves predictably) while
 *    the PROFILE still denies file access to that real home path except for
 *    the caller's own named `readWriteDirs` (the target worktree/scratch
 *    dir, and `GLOBAL_VINAYA_HOME` — a Worker's own later `vinaya`
 *    subcommands need to read config and write outbox/resume records there).
 *    The env value and the filesystem permission are independent: Seatbelt
 *    enforces the latter regardless of what `$HOME` merely says.
 */
export function buildWorkerSandboxProfile(opts: {
  realHome: string
  readWriteDirs: readonly string[]
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
    ";; Process-exec: the confined role's own worktree, the runtime interpreter's",
    ';; install dir, and whatever standard toolchain directories were resolved as',
    ";; present on this host — see this function's own doc comment, item 1.",
    sbSubpathAllows('file-read*', readAllowDirs),
    sbSubpathAllows('process-exec', opts.execAllowDirs),
    '',
    ';; HOME confinement: deny the real HOME entirely, then carve out only the',
    ';; directories this role actually needs to read/write (its own worktree,',
    ';; and GLOBAL_VINAYA_HOME for its own later `vinaya` subcommands).',
    `(deny file-read* file-write*\n    (subpath ${sbLiteral(opts.realHome)}))`,
    sbSubpathAllows('file-read* file-write*', opts.readWriteDirs),
    '',
    ';; Filesystem write confinement, PART 2: close every OTHER writable path',
    ';; the baseline would otherwise leave open (/tmp, /var, anywhere else a',
    ';; bare process can write) — "read/write inside its own worktree" is the',
    ';; ceiling, not one of several open paths.',
    '(deny file-write*',
    '  (require-all',
    opts.readWriteDirs.map((d) => `    (require-not (subpath ${sbLiteral(d)}))`).join('\n'),
    '  ))',
    '',
    ';; Network: allowed — a real Worker must reach the model runtime endpoint',
    ';; (isolation.md §1, Worker row) — except the ssh-agent socket, denied by',
    ';; this LATER, more specific rule (Seatbelt applies the last match).',
    '(allow network-outbound)',
    `(deny network-outbound\n  (remote unix-socket (path-literal ${sbLiteral(opts.sshSockCanon)})))`,
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

export type WorkerBoundaryLaunch = { command: string; args: string[]; cleanup: () => void }

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
  /** The role's own confined workspace — the target worktree (developer/operator) or the reviewer's own scratch copy (`reviewer-isolation.ts`). */
  allowedDir: string
  /** `GLOBAL_VINAYA_HOME` (`config.ts`) — carved out read/write alongside `allowedDir` so a Worker's own later `vinaya` subcommands (config reads, outbox/resume writes) keep working confined. */
  vinayaHomeDir: string
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
    const runtimeDir = dirname(realpathSync(opts.binaryPath))
    const scratchTmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'vinaya-worker-boundary-')))

    let vinayaHomeDirReal: string | null = null
    try {
      vinayaHomeDirReal = realpathSync(opts.vinayaHomeDir)
    } catch {
      // GLOBAL_VINAYA_HOME may not exist yet on a fresh machine — the profile
      // simply carves out nothing for it; a Worker's own later `vinaya`
      // subcommand that needs to CREATE it for the first time would fail
      // confined, which is a real, disclosed narrowing, not a silent one.
      vinayaHomeDirReal = null
    }

    const readWriteDirs = Array.from(
      new Set([allowedDirReal, scratchTmpDir, ...(vinayaHomeDirReal ? [vinayaHomeDirReal] : [])])
    )

    const gitExecPath = resolveGitExecPath()
    const systemBinDirs = CANDIDATE_SYSTEM_BIN_DIRS.filter((d) => existsSync(d)).map((d) => realpathSync(d))
    const execAllowDirs = Array.from(
      new Set([allowedDirReal, runtimeDir, ...(gitExecPath ? [gitExecPath] : []), ...systemBinDirs])
    )

    const credentialHelperDenyLiterals = gitExecPath
      ? ['git-credential-osxkeychain', 'git-credential-manager', 'git-credential-manager-core'].map((name) =>
          join(gitExecPath, name)
        )
      : []

    const profile = buildWorkerSandboxProfile({
      realHome,
      readWriteDirs,
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
        args: ['-f', profilePath, opts.binaryPath, ...opts.args],
        cleanup
      }
    }
  } catch (error) {
    return { ok: false, reason: `worker boundary profile could not be built: ${(error as Error).message}` }
  }
}
