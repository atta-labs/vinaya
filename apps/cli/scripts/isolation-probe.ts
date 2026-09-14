#!/usr/bin/env bun
/**
 * Disposable local probe for apps/cli/specs/isolation.md (worker-isolation-v1
 * task 1, #549, O2) — proves the chosen mechanism (Apple Seatbelt,
 * `sandbox-exec` + isolation-probe.sb) actually enforces the six negatives
 * the contract requires of a Worker/Reviewer boundary, and that the SAME
 * six checks succeed outside it. Never wired into `dispatchRole` — this
 * script is the proof, not the launcher (see isolation.md "What this task
 * does not change").
 *
 * Two ways to invoke it:
 *   bun scripts/isolation-probe.ts            — orchestrate: run confined
 *                                                 and bare, print a report,
 *                                                 exit 0 only if every
 *                                                 negative/positive holds.
 *   bun scripts/isolation-probe.ts --report    — run the six checks in THIS
 *                                                 process and print their
 *                                                 JSON result. This is the
 *                                                 mode the orchestrator
 *                                                 re-invokes itself with,
 *                                                 both bare and under
 *                                                 sandbox-exec.
 */
import { spawnSync } from 'node:child_process'
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir, homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const PROBE_CHECK_NAMES = [
  'environment',
  'home',
  'keychain',
  'credentialHelper',
  'socket',
  'parentProcess'
] as const

export type ProbeCheckName = (typeof PROBE_CHECK_NAMES)[number]

/** `true`/`false` is a real access result; `null` means the resource this
 * check probes does not exist on this host at all (no login keychain, no
 * ssh-agent socket, no osxkeychain helper installed) — neither a pass nor
 * a fail, since there was nothing to grant or deny access to. */
export type ProbeOutcome = boolean | null

export type ProbeResults = Record<ProbeCheckName, ProbeOutcome>

const REAL_HOME_ENV = 'VINAYA_PROBE_REAL_HOME'
const SECRET_ENV = 'VINAYA_PROBE_SECRET'
const MARKER_BASENAME = '.vinaya-isolation-probe-marker'

/** Resolves the OS-level git credential helper's on-disk path, or `null`
 * if this host has none installed (checks/registry.ts's own env-declared
 * `GITHUB_TOKEN`/`GH_TOKEN` rows are a different, already-scoped path —
 * this is the interactive `git credential fill` helper a bare shell would
 * use). */
function resolveCredentialHelperPath(): string | null {
  const execPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' })
  if (execPath.status !== 0) return null
  const candidate = join(execPath.stdout.trim(), 'git-credential-osxkeychain')
  try {
    accessSync(candidate, constants.F_OK)
    return candidate
  } catch {
    return null
  }
}

/** Resolves an already-canonicalized (`realpath`'d) `SSH_AUTH_SOCK`, or
 * `null` if none is set — Seatbelt's `unix-socket` filter matches the
 * resolved path, never a symlinked convenience alias (macOS's own
 * `/var/run` resolves to `/private/var/run`). */
function resolveSshSocketPath(): string | null {
  const raw = process.env.SSH_AUTH_SOCK
  if (!raw) return null
  const resolved = spawnSync('/bin/realpath', [raw], { encoding: 'utf8' })
  if (resolved.status !== 0) return null
  return resolved.stdout.trim()
}

/** Runs the six checks in THIS process. Called both by `--report` mode
 * (re-invoked, bare or under sandbox-exec) and directly by anything that
 * wants an in-process read (a future consumer wiring this into a test
 * fixture without a subprocess round-trip). */
export async function runProbeChecks(): Promise<ProbeResults> {
  const results = {} as ProbeResults

  // 1. Environment — a value the caller holds but did not explicitly
  // forward must be absent, exactly like `buildCheckEnv`'s allowlist
  // (apps/cli/src/checks/runner.ts) already enforces for custom checks.
  results.environment = process.env[SECRET_ENV] !== undefined

  // 2. HOME — read a marker file the orchestrator drops in the REAL home
  // directory before dispatch; a confined child's own HOME env points
  // elsewhere, so the real path is passed explicitly for the probe only.
  const realHome = process.env[REAL_HOME_ENV]
  if (realHome) {
    try {
      readFileSync(join(realHome, MARKER_BASENAME), 'utf8')
      results.home = true
    } catch {
      results.home = false
    }
  } else {
    results.home = null
  }

  // 3. Keychain — direct file access to the login keychain database.
  const keychainPath = realHome ? join(realHome, 'Library', 'Keychains', 'login.keychain-db') : null
  if (keychainPath) {
    try {
      accessSync(keychainPath, constants.F_OK)
      try {
        accessSync(keychainPath, constants.R_OK)
        results.keychain = true
      } catch {
        results.keychain = false
      }
    } catch {
      results.keychain = null
    }
  } else {
    results.keychain = null
  }

  // 4. Credential helper — attempt to exec the OS-level helper directly.
  const credentialHelperPath = process.env.VINAYA_PROBE_CRED_HELPER || resolveCredentialHelperPath()
  if (credentialHelperPath) {
    const r = spawnSync(credentialHelperPath, ['get'], {
      input: 'protocol=https\nhost=github.com\n\n',
      timeout: 3000
    })
    const errCode = r.error ? (r.error as NodeJS.ErrnoException).code : undefined
    if (errCode === 'ENOENT') {
      // Helper binary named but not actually present on this host — nothing
      // to grant or deny access to.
      results.credentialHelper = null
    } else if (errCode === 'EPERM') {
      results.credentialHelper = false
    } else {
      results.credentialHelper = true
    }
  } else {
    results.credentialHelper = null
  }

  // 5. Socket — connect to the ssh-agent (or equivalent) unix socket.
  const sshSock = process.env.VINAYA_PROBE_SSH_SOCK || resolveSshSocketPath()
  results.socket = await resolveSocketCheck(sshSock)

  // 6. Parent process — signal-0 liveness probe against the parent pid.
  try {
    process.kill(process.ppid, 0)
    results.parentProcess = true
  } catch {
    results.parentProcess = false
  }

  return results
}

function resolveSocketCheck(sshSock: string | null): Promise<ProbeOutcome> {
  // `null` means the caller never resolved a socket path to test at all
  // (no ssh-agent on this host) — genuinely not applicable. Once a path
  // IS given, any connect failure counts as blocked: Seatbelt's own
  // `network-outbound`/`unix-socket` denial surfaces to Node/Bun as a
  // plain `ENOENT` rather than `EPERM` (observed live — Apple's sandbox
  // deliberately obscures a denied unix-socket connect as "not found"
  // rather than confirming the resource exists), so a genuine absence and
  // a sandboxed denial are indistinguishable from here — both correctly
  // read as "not accessible."
  if (sshSock === null) return Promise.resolve(null)
  return new Promise((resolve) => {
    const socket = connect(sshSock)
    const finish = (value: ProbeOutcome) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.on('connect', () => finish(true))
    socket.on('error', () => finish(false))
    setTimeout(() => finish(false), 1500)
  })
}

async function runReportMode(): Promise<void> {
  const results = await runProbeChecks()
  process.stdout.write(JSON.stringify(results))
}

/** Substitutes every `{{PLACEHOLDER}}` in the fixture profile with an
 * already-canonicalized absolute path, and writes the result to a fresh
 * temp file — never mutates the checked-in fixture. */
export function buildSandboxProfile(opts: {
  realHome: string
  allowedDir: string
  fakeHome: string
  credentialHelperPath: string
  sshSockCanon: string
}): string {
  const fixturePath = join(import.meta.dirname, 'isolation-probe.sb')
  const template = readFileSync(fixturePath, 'utf8')
  const rendered = template
    .replaceAll('{{REAL_HOME}}', opts.realHome)
    .replaceAll('{{ALLOWED_DIR}}', opts.allowedDir)
    .replaceAll('{{FAKE_HOME}}', opts.fakeHome)
    .replaceAll('{{CRED_HELPER_PATH}}', opts.credentialHelperPath)
    .replaceAll('{{SSH_SOCK_CANON}}', opts.sshSockCanon)
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-isolation-profile-'))
  const profilePath = join(dir, 'isolation-probe.sb')
  writeFileSync(profilePath, rendered)
  return profilePath
}

/** `true` only on a host this probe (and the contract it proves) actually
 * supports: Darwin, with `sandbox-exec` present. */
export function isSandboxSupported(): boolean {
  if (process.platform !== 'darwin') return false
  try {
    accessSync('/usr/bin/sandbox-exec', constants.X_OK)
    return true
  } catch {
    return false
  }
}

function selfInvocation(): { execPath: string; scriptPath: string } {
  return { execPath: process.execPath, scriptPath: join(import.meta.dirname, 'isolation-probe.ts') }
}

/** Runs the six checks inside the Seatbelt confinement — the negative
 * half of the probe. */
export function runConfined(): ProbeResults {
  const realHome = homedir()
  const markerPath = join(realHome, MARKER_BASENAME)
  writeFileSync(markerPath, 'vinaya-isolation-probe\n')

  const scratchDir = mkdtempSync(join(tmpdir(), 'vinaya-isolation-scratch-'))
  const fakeHome = join(scratchDir, 'fake-home')
  writeFileSync(join(scratchDir, '.keep'), '')

  const credentialHelperPath = resolveCredentialHelperPath() ?? '/nonexistent/git-credential-osxkeychain'
  const sshSockCanon = resolveSshSocketPath() ?? '/nonexistent/ssh-auth-sock'

  const { execPath, scriptPath: originalScriptPath } = selfInvocation()
  // The confined child's only readable filesystem is `scratchDir` (standing
  // in for a Worker's own worktree) — a self-contained copy of this script
  // (no local imports, only node: builtins) is placed there so the child
  // never needs to read the real repo tree at all.
  const scriptPath = join(scratchDir, 'isolation-probe.ts')
  writeFileSync(scriptPath, readFileSync(originalScriptPath, 'utf8'))
  const profilePath = buildSandboxProfile({
    realHome,
    allowedDir: scratchDir,
    fakeHome,
    credentialHelperPath,
    sshSockCanon
  })

  try {
    const result = spawnSync('/usr/bin/sandbox-exec', ['-f', profilePath, execPath, scriptPath, '--report'], {
      cwd: scratchDir,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: fakeHome,
        [REAL_HOME_ENV]: realHome,
        VINAYA_PROBE_CRED_HELPER: credentialHelperPath,
        VINAYA_PROBE_SSH_SOCK: process.env.SSH_AUTH_SOCK ?? ''
        // Deliberately no VINAYA_PROBE_SECRET — this IS check 1's assertion.
      }
    })
    if (result.status !== 0 || !result.stdout) {
      throw new Error(`confined probe process exited ${result.status} — stderr: ${result.stderr || '(empty)'}`)
    }
    return JSON.parse(result.stdout) as ProbeResults
  } finally {
    rmSync(markerPath, { force: true })
    rmSync(scratchDir, { recursive: true, force: true })
    rmSync(dirname(profilePath), { recursive: true, force: true })
  }
}

/** Runs the six checks with no confinement at all — the positive half of
 * the probe, proving each check actually detects access when it exists
 * rather than trivially reporting `false` everywhere. */
export function runBare(): ProbeResults {
  const realHome = homedir()
  const markerPath = join(realHome, MARKER_BASENAME)
  writeFileSync(markerPath, 'vinaya-isolation-probe\n')

  const { execPath, scriptPath } = selfInvocation()
  const credentialHelperPath = resolveCredentialHelperPath() ?? ''
  try {
    const result = spawnSync(execPath, [scriptPath, '--report'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        [REAL_HOME_ENV]: realHome,
        [SECRET_ENV]: 'vinaya-isolation-probe-secret',
        VINAYA_PROBE_CRED_HELPER: credentialHelperPath,
        VINAYA_PROBE_SSH_SOCK: process.env.SSH_AUTH_SOCK ?? ''
      }
    })
    if (result.status !== 0 || !result.stdout) {
      throw new Error(`bare probe process exited ${result.status} — stderr: ${result.stderr || '(empty)'}`)
    }
    return JSON.parse(result.stdout) as ProbeResults
  } finally {
    rmSync(markerPath, { force: true })
  }
}

function formatOutcome(outcome: ProbeOutcome): string {
  if (outcome === null) return 'n/a'
  return outcome ? 'ACCESSIBLE' : 'blocked'
}

async function main(): Promise<void> {
  if (process.argv.includes('--report')) {
    await runReportMode()
    return
  }

  if (!isSandboxSupported()) {
    console.error(
      'isolation-probe: sandbox-exec is not available on this host (Darwin + /usr/bin/sandbox-exec required)'
    )
    process.exit(1)
  }

  const confined = runConfined()
  const bare = runBare()

  console.log('check            confined   bare')
  let ok = true
  for (const name of PROBE_CHECK_NAMES) {
    const c = confined[name]
    const b = bare[name]
    const negativeOk = c === null || c === false
    const positiveOk = b === null || b === true
    if (!negativeOk || !positiveOk) ok = false
    console.log(`${name.padEnd(16)} ${formatOutcome(c).padEnd(10)} ${formatOutcome(b)}`)
  }

  if (!ok) {
    console.error('isolation-probe: FAILED — a confined check was accessible, or a bare check was blocked')
    process.exit(1)
  }
  console.log(
    'isolation-probe: PASSED — every applicable negative was blocked, every applicable positive was accessible'
  )
}

if (import.meta.main) {
  main()
}
