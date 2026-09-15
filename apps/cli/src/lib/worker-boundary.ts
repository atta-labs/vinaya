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
  codex: ['OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY']
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
    '  ))',
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
  /** The role's own confined workspace — the target worktree (developer/operator) or the reviewer's own scratch copy (`reviewer-isolation.ts`). Read-only when `bootstrapWritableSubpaths` is given (see that field's own doc); otherwise read+write, the steady-state case. */
  allowedDir: string
  /** `GLOBAL_VINAYA_HOME` (`config.ts`) — NOT exposed to the confined role at all except through `vinayaHomeWritableSubdirs` (round 4 review, HIGH: this directory previously sat in `readOnlyDirs` wholesale, letting a confined Worker read `config.json` plus every other repo's and task's state under it — removed, not narrowed, since nothing inside the sandbox needs to read it: `loadConfig()`'s own global-fallback branch runs only in the TRUSTED, unsandboxed controller, never inside a dispatched child). */
  vinayaHomeDir: string
  /**
   * Subpaths, relative to `vinayaHomeDir`, a Worker's own later `vinaya`
   * subcommand genuinely needs to READ and WRITE — its own log queue and
   * its per-dispatch resume records. Scoping these to exactly THIS
   * dispatch's own repo is the CALLER's job (round 4 review, BLOCKER: a
   * bare top-level directory name previously granted read+write over the
   * ENTIRE log-queue/resume-record tree, spanning every repo and every task
   * ever dispatched on the machine — a confined Worker could forge another
   * task's audit-log line, or steal another task's live vendor `resumeId`
   * and resume its session directly, since the vendor binary sits in this
   * same profile's own exec-allow list). This module stays a generic,
   * reusable confinement primitive with no hardcoded opinion about
   * `GLOBAL_VINAYA_HOME`'s own internal layout — the caller (`dispatch.ts`)
   * derives the repo-scoped subpath from the SAME naming convention it
   * already uses to locate its own files. Never `config.json`, never a bare
   * top-level directory name.
   */
  vinayaHomeWritableSubdirs: readonly string[]
  /**
   * Round 4 review, BLOCKER fix: subpaths, relative to `vinayaHomeDir`, a
   * confined dispatch must be able to READ but never write — today, exactly
   * `writeDispatchSettings`'s own `dispatch-settings` directory
   * (`dispatch.ts`), which the TRUSTED controller writes BEFORE resolving
   * this launch and which the confined child then loads via its own
   * `--settings <path>` flag. Found live: `vinayaHomeDir` itself carries no
   * grant at all (the round-4 HIGH fix, above) and `dispatch-settings` was
   * never a member of `vinayaHomeWritableSubdirs` either, so a confined
   * Claude dispatch could not read the settings file it was handed on its
   * own argv — the PreToolUse background-deny hook this task's own brief
   * named a trap to preserve never actually loaded inside the boundary.
   * Read-only, not read+write, deliberately: nothing inside the sandbox
   * ever needs to rewrite this file, and granting write here would reopen
   * the same persistent-tampering class of gap the round-2 CRITICAL fix
   * closed for `vinaya.config.json` — a confined process could otherwise
   * overwrite its own settings file to strip the hook for every later
   * dispatch that reuses this shared, unscoped directory.
   */
  vinayaHomeReadOnlySubdirs?: readonly string[]
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

    /** Resolves a subpath of an already-realpath'd parent — realpath'd itself when it already exists (closing the same symlink-alias gap every other path here closes), or left as a plain `join()` when it does not yet exist (`.worktrees` on a fresh clone, a log/resume subdirectory on a fresh machine): the PARENT is already canonical, so a not-yet-existing child's constructed path is exact, and Seatbelt subpath rules need no existing target to compile. */
    const resolveExistingOrJoined = (parentReal: string, rel: string): string => {
      const joined = join(parentReal, rel)
      try {
        return realpathSync(joined)
      } catch {
        return joined
      }
    }

    const bootstrapWriteDirs = (opts.bootstrapWritableSubpaths ?? []).map((rel) =>
      resolveExistingOrJoined(allowedDirReal, rel)
    )
    const vinayaWritableDirs = vinayaHomeDirReal
      ? opts.vinayaHomeWritableSubdirs.map((rel) => resolveExistingOrJoined(vinayaHomeDirReal as string, rel))
      : []
    const vinayaReadOnlyDirs = vinayaHomeDirReal
      ? (opts.vinayaHomeReadOnlySubdirs ?? []).map((rel) => resolveExistingOrJoined(vinayaHomeDirReal as string, rel))
      : []

    // Round 4 review, HIGH: `vinayaHomeDirReal` is NEVER added here — only
    // its caller-scoped `vinayaWritableDirs`/`vinayaReadOnlyDirs` (below) are
    // exposed. This previously granted blanket `file-read*` over the whole
    // `vinayaHomeDir`, letting a confined role read `config.json` plus every
    // other repo's/task's state; nothing inside the sandbox needs that (the
    // controller's own global-config fallback runs unsandboxed, before any
    // child is ever spawned).
    const readOnlyDirs = Array.from(
      new Set([...(opts.bootstrapWritableSubpaths ? [allowedDirReal] : []), ...vinayaReadOnlyDirs])
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
        vinayaWritableDirs.map((d) => {
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
      readOnlyDirs,
      readWriteDirs,
      metadataOnlyDirs: vinayaWritableParents,
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
