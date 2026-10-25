/**
 * Runs one command inside one agent's real sandbox, configured exactly as
 * the driver configures a confined Developer dispatch — every setting comes
 * from the driver's own exports (`resolveClaudeConfinement`,
 * `resolveCodexConfinement`, `stageCodexPolicyHome`, `addCodexWritableDirs`,
 * `buildCodexExecpolicyRules`), never rebuilt here, so the suite judges the
 * boundary the driver actually ships.
 *
 * - Claude: Claude Code's sandbox is Anthropic's sandbox runtime; the suite
 *   launches it as `bunx @anthropic-ai/sandbox-runtime` (pinned below, no new
 *   dependency) with the `sandbox` block the driver writes into a confined
 *   dispatch's settings file, plus the PATH the driver gives the child.
 * - Codex: `codex sandbox`, with `CODEX_HOME` pointed at the run-scoped home
 *   `stageCodexPolicyHome` stages (the confinement config.toml and the
 *   machine-state rules) and the extra writable roots the driver grants
 *   (scratch directory and git common dir), passed as `--config
 *   sandbox_workspace_write.writable_roots=…` the way a resumed dispatch
 *   receives them. `codex sandbox` needs no login; the staged home's
 *   `auth.json` is a placeholder copied from a throwaway operator home.
 *   Unlike `codex exec`, `codex sandbox` ignores the staged config's
 *   `sandbox_mode` and runs read-only unless that key also arrives as a
 *   `--config` override (codex-rs `cli/src/debug_sandbox.rs`), so the
 *   staged config's own value is passed that way too.
 *
 * Each agent gets its own fresh linked worktree of `HEAD` under
 * `.worktrees/`, as a dispatched Developer does: the driver creates it, the
 * Developer's first command (`bun install`) runs inside the sandbox.
 *
 * Each session also holds a task's controller-owned required-source store —
 * a manifest and a receipts file, written by the suite as the driver writes
 * them — under a throwaway runtime directory in the home directory, where
 * the default runtime directory lives. Claude's settings name it in
 * `denyWrite`, as the driver's do for a Developer; Codex is given no grant
 * for it. The suite proves neither sandbox can create, change or delete a
 * file there.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  addCodexWritableDirs,
  buildCodexExecpolicyRules,
  codexSpawnEnvExtras,
  confinedTurboCacheDir
} from '../../src/lib/dispatch.js'
import {
  CLAUDE_SANDBOX_ALLOWED_DOMAINS,
  claudeRunsCommandUnsandboxed,
  type ConfinementRequest,
  resolveBunInstallCacheDir,
  resolveClaudeConfinement,
  resolveCodexConfinement,
  resolveGitCommonDir,
  stageCodexPolicyHome
} from '../../src/lib/worker-boundary.js'
import { sourceManifestPath, sourceReceiptsPath, sourceStoreDir } from '../../src/lib/source-manifest.js'
import { grantVariables } from '../../../../harness/adapters/agents/variables.js'
import { createRoleLaunchers, sandboxProbePlanFor } from '../../../../processes/vinaya/executing/actions.js'
import { spawnBudgetedAsync, stripVinayaEnv } from '../lib/process-fixture.js'
import { isSuiteInput, REPO_ROOT } from './command-sources.js'

export const AGENTS = ['claude', 'codex'] as const
export type Agent = (typeof AGENTS)[number]

/** The generated canary a credential probe plants in the host environment: never a real secret, proof of a leak if a role sees it. */
export const ENGINE_PROBE_CANARY = 'VINAYA-CANARY-6f1a9c2e-not-a-real-secret'

/** Pinned so a runtime release never changes the suite's verdict silently — bump deliberately, then re-run. */
export const SANDBOX_RUNTIME_PACKAGE = '@anthropic-ai/sandbox-runtime@0.0.78'
export const CODEX_PACKAGE = '@openai/codex@0.160.0'

/** Ten minutes: `bun run typecheck` on a cold worktree is the slowest command in the list. */
export const COMMAND_BUDGET_MS = 600_000

export type CommandResult = { exitCode: number; output: string }

export type SandboxSession = {
  readonly agent: Agent
  readonly worktreeDir: string
  /** The task's controller-owned required-source store, holding a manifest and a receipts file the worker must not touch. */
  readonly sourceStore: string
  run(command: string, env: Record<string, string>): Promise<CommandResult>
  /** The same command in the same worktree with no sandbox around it — the control that tells a sandbox denial from a command that fails anywhere. */
  runOutside(command: string, env: Record<string, string>): Promise<CommandResult>
  dispose(): void
}

function git(args: string[], cwd: string = REPO_ROOT): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** The branch the code under test lives on — the pull request's head in CI, the checkout's own branch locally. `''` on a detached checkout with no CI head. */
export function sourceBranch(): string {
  const fromCi = process.env.GITHUB_HEAD_REF
  if (fromCi) return fromCi
  try {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
    return branch === 'HEAD' ? '' : branch
  } catch {
    return ''
  }
}

/**
 * Why the live runs are skipped, or `null` when they run. They are skipped
 * only on a pull request whose diff against the merge base with the default
 * branch touches none of `SUITE_INPUTS`. Any other event (a push to the
 * default branch above all), a missing event, or a diff that cannot be
 * computed runs everything: the suite never skips for want of an answer.
 */
export function conformanceSkipReason(
  env: Record<string, string | undefined> = process.env,
  changedFiles: () => string[] = changedFilesAgainstDefaultBranch
): string | null {
  const event = env.GITHUB_EVENT_NAME
  if (event !== 'pull_request' && event !== 'pull_request_target') return null
  let changed: string[]
  try {
    changed = changedFiles()
  } catch {
    return null
  }
  if (changed.some(isSuiteInput)) return null
  return `no file the suite depends on changed in this pull request (${changed.length} changed)`
}

/** Files changed since the merge base with `origin/main` — never against main's tip, so a rebased branch is judged by its own changes. Throws when the diff cannot be computed. */
function changedFilesAgainstDefaultBranch(): string[] {
  const base = git(['merge-base', 'origin/main', 'HEAD'])
  return git(['diff', '--name-only', base, 'HEAD'])
    .split('\n')
    .filter((f) => f !== '')
}

function createWorktree(agent: Agent): string {
  const dir = join(REPO_ROOT, '.worktrees', `sandbox-conformance-${agent}-${process.pid}-${Date.now()}`)
  git(['worktree', 'add', '--detach', dir, 'HEAD'])
  return realpathSync(dir)
}

function removeWorktree(dir: string): void {
  try {
    git(['worktree', 'remove', '--force', dir])
  } catch {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The leading `bun` resolved to the running Bun's absolute path: a shell's PATH lookup cannot stat a binary inside a read-denied home even where executing it is allowed, and the agents' own shells resolve it — the question here is the sandbox, not the lookup. */
function withAbsoluteBun(command: string): string {
  return command.replace(/^bun(?=\s)/, JSON.stringify(process.execPath))
}

function request(
  agent: Agent,
  worktreeDir: string,
  scratchDir: string,
  controllerOwnedDirs: readonly string[] = []
): ConfinementRequest {
  return {
    role: 'developer',
    agent,
    worktreeDir,
    scratchDir,
    allowedHosts: CLAUDE_SANDBOX_ALLOWED_DOMAINS,
    ...(controllerOwnedDirs.length > 0 ? { controllerOwnedDirs } : {})
  }
}

/** A throwaway runtime directory in the home directory, holding task 1's source store with a manifest and a receipts file in it. */
function controllerSourceStore(): { runtimeDir: string; store: string } {
  const runtimeDir = realpathSync(mkdtempSync(join(homedir(), '.vinaya-conformance-runtime-')))
  const store = sourceStoreDir(runtimeDir, 1)
  mkdirSync(store, { recursive: true, mode: 0o700 })
  writeFileSync(sourceManifestPath(store), '{"schemaVersion":1,"sources":[]}\n', { mode: 0o600 })
  writeFileSync(sourceReceiptsPath(store), '{"sourceId":"https://example.com/a","decision":"counted"}\n', {
    mode: 0o600
  })
  return { runtimeDir, store }
}

async function runIn(
  argv: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  label: string
): Promise<CommandResult> {
  const r = await spawnBudgetedAsync(argv, { cwd, env }, COMMAND_BUDGET_MS, label)
  return { exitCode: r.status, output: `${r.stdout}${r.stderr}` }
}

function runOutsideSandbox(worktreeDir: string, command: string, env: Record<string, string>): Promise<CommandResult> {
  return runIn(
    ['bash', '-c', withAbsoluteBun(command)],
    worktreeDir,
    { ...stripVinayaEnv(), ...env },
    `outside: ${command}`
  )
}

// The Claude sandbox opens its proxy socket at TMPDIR/srt-mux-<pid>-<n>.sock,
// and a macOS socket path holds 104 bytes: the runner's system temp directory
// alone is 105, so the scratch directory goes under /tmp there.
function claudeScratchRoot(): string {
  return process.platform === 'darwin' ? '/tmp' : tmpdir()
}

function claudeSession(): SandboxSession {
  const worktreeDir = createWorktree('claude')
  const scratchDir = realpathSync(mkdtempSync(join(claudeScratchRoot(), 'vinaya-claude-sandbox-')))
  const settingsDir = mkdtempSync(join(tmpdir(), 'vinaya-conformance-srt-'))
  const { runtimeDir, store } = controllerSourceStore()
  const resolution = resolveClaudeConfinement(request('claude', worktreeDir, scratchDir, [store]))
  if (!resolution.confined) {
    throw new Error(`Claude's sandbox cannot run on this host: ${resolution.warning}`)
  }
  const { network, filesystem, credentials } = resolution.settings.sandbox
  // The settings file carries exactly what the driver ships. Fail if the driver grows a block this file would drop.
  const shipped = JSON.stringify([
    Object.keys(network).sort(),
    Object.keys(filesystem).sort(),
    Object.keys(credentials).sort()
  ])
  if (
    shipped !== JSON.stringify([['allowedDomains'], ['allowRead', 'allowWrite', 'denyRead', 'denyWrite'], ['files']])
  ) {
    throw new Error(`resolveClaudeConfinement emits settings the conformance file does not carry: ${shipped}`)
  }
  // O2: Claude Code enforces `sandbox.credentials.files` (deny) by denying
  // read on those paths; the raw sandbox runtime this suite drives has no
  // `credentials` concept of its own, so the suite translates them into
  // `filesystem.denyRead` — the same end the vendor reaches — so the gh token
  // store (`~/.config/gh/hosts.yml`) is really denied inside the sandbox.
  const credentialDenyRead = credentials.files.filter((f) => f.mode === 'deny').map((f) => f.path)
  const settingsPath = join(settingsDir, 'srt-settings.json')
  writeFileSync(
    settingsPath,
    JSON.stringify({
      network: { allowedDomains: network.allowedDomains, deniedDomains: [] },
      filesystem: {
        denyRead: [...filesystem.denyRead, ...credentialDenyRead],
        allowRead: filesystem.allowRead,
        allowWrite: filesystem.allowWrite,
        denyWrite: filesystem.denyWrite ?? []
      }
    })
  )
  return {
    agent: 'claude',
    worktreeDir,
    sourceStore: store,
    runOutside: (command, env) => runOutsideSandbox(worktreeDir, command, env),
    // Keep the same routing decision the driver uses. Its exclusion list is
    // empty, so bare and chained Bash commands both stay sandboxed.
    run: (command, env) =>
      claudeRunsCommandUnsandboxed(command)
        ? runOutsideSandbox(worktreeDir, command, env)
        : runIn(
            [
              process.execPath,
              'x',
              SANDBOX_RUNTIME_PACKAGE,
              '--settings',
              settingsPath,
              '-c',
              withAbsoluteBun(command)
            ],
            worktreeDir,
            {
              ...stripVinayaEnv(),
              ...(resolution.pathOverride !== undefined ? { PATH: resolution.pathOverride } : {}),
              TMPDIR: scratchDir,
              // O4: the same turbo cache redirect the driver ships for a
              // confined Claude child (`dispatch.ts`), so the suite judges
              // the real boundary — turbo writes inside the granted scratch,
              // never the repo-root `.turbo/`.
              TURBO_CACHE_DIR: confinedTurboCacheDir(scratchDir),
              ...env
            },
            `claude: ${command}`
          ),
    dispose: () => {
      removeWorktree(worktreeDir)
      rmSync(scratchDir, { recursive: true, force: true })
      rmSync(settingsDir, { recursive: true, force: true })
      rmSync(runtimeDir, { recursive: true, force: true })
    }
  }
}

function codexSession(): SandboxSession {
  const worktreeDir = createWorktree('codex')
  const scratchDir = realpathSync(mkdtempSync(join(tmpdir(), 'vinaya-codex-sandbox-')))
  const stageRoot = mkdtempSync(join(tmpdir(), 'vinaya-conformance-codex-'))
  const { runtimeDir, store } = controllerSourceStore()
  const resolution = resolveCodexConfinement(request('codex', worktreeDir, scratchDir))
  if (!resolution.ok) throw new Error(`Codex's sandbox cannot run on this host: ${resolution.reason}`)
  const operatorHome = join(stageRoot, 'operator-home')
  mkdirSync(join(operatorHome, '.codex'), { recursive: true })
  writeFileSync(join(operatorHome, '.codex', 'auth.json'), '{}\n')
  const staged = stageCodexPolicyHome({
    targetDir: join(stageRoot, 'codex-home'),
    realHome: operatorHome,
    execpolicyRules: buildCodexExecpolicyRules('developer') ?? '',
    sandboxConfigToml: resolution.configToml
  })
  if (staged === null) throw new Error('stageCodexPolicyHome staged no CODEX_HOME')
  const sandboxMode = resolution.configToml.match(/^sandbox_mode = ("[^"]+")$/m)?.[1]
  if (sandboxMode === undefined) throw new Error('the staged Codex config names no sandbox_mode')
  const gitCommonDir = resolveGitCommonDir(worktreeDir)
  // Round 5 Principal ruling: `bun install` writes its package cache under
  // the operator's real home (`resolveBunInstallCacheDir`), the same gap a
  // real Codex dispatch already closes (`dispatch.ts`'s own
  // `codexBunCacheDir`) — this harness rebuilds its own writable-roots list
  // rather than sharing that one, so it needs the same grant named here too.
  const bunCacheDir = resolveBunInstallCacheDir()
  const sandboxArgs = addCodexWritableDirs(
    ['sandbox', '--config', `sandbox_mode=${sandboxMode}`],
    [scratchDir, bunCacheDir, ...(gitCommonDir ? [gitCommonDir] : [])],
    true
  )
  // Round 5 Principal ruling: TMPDIR/TMP/TEMP now come from the SAME
  // `codexSpawnEnvExtras` a real Codex dispatch builds its own spawn env
  // from, rather than this harness's own hand-rolled `TMPDIR` alone (which
  // never set `TMP`/`TEMP`, a real drift this task closes).
  const envExtras = codexSpawnEnvExtras('codex', staged.codexHome, scratchDir).attribution
  return {
    agent: 'codex',
    worktreeDir,
    sourceStore: store,
    runOutside: (command, env) => runOutsideSandbox(worktreeDir, command, env),
    run: (command, env) =>
      runIn(
        [process.execPath, 'x', CODEX_PACKAGE, ...sandboxArgs, '--', 'bash', '-c', withAbsoluteBun(command)],
        worktreeDir,
        { ...stripVinayaEnv(), ...envExtras, ...env },
        `codex: ${command}`
      ),
    dispose: () => {
      removeWorktree(worktreeDir)
      rmSync(scratchDir, { recursive: true, force: true })
      rmSync(stageRoot, { recursive: true, force: true })
      rmSync(runtimeDir, { recursive: true, force: true })
    }
  }
}

export function openSandboxSession(agent: Agent): SandboxSession {
  return agent === 'claude' ? claudeSession() : codexSession()
}

/** The credential files a canary home holds — each written with the canary, never a real secret. */
const CANARY_HOME_FILES = [
  '.config/gh/hosts.yml',
  '.git-credentials',
  '.netrc',
  '.config/git/credentials',
  '.ssh/id_ed25519',
  '.codex/auth.json',
  '.claude/.credentials.json',
  '.aws/credentials',
  '.local/share/keyrings/login.keyring'
]

/**
 * A throwaway home whose credential files hold ONLY the canary — never the operator's real files. A probe that
 * reaches a route under this home surfaces the canary at worst, so a failed assertion can never print a real
 * credential. The directory becomes the live session's `HOME`, so the generated deny rules (resolved from
 * `HOME` at generation time) target it and the probes read it.
 */
function buildCanaryHome(parent: string): string {
  const home = realpathSync(mkdtempSync(join(parent, 'canary-home-')))
  for (const rel of CANARY_HOME_FILES) {
    const abs = join(home, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, `${ENGINE_PROBE_CANARY}\n`, { mode: 0o600 })
  }
  return home
}

/**
 * A real SSH agent for the canary home, holding one throwaway key whose comment is the canary, reachable at the
 * socket's default path under the home (`.ssh/agent.sock`). A role that reaches the agent — through an inherited
 * pointer or that guessable path — lists the canary, so the SSH-agent probe leg can fail. The socket itself sits
 * in a short directory (a Unix socket path has a length limit) that the home's path links to.
 */
function startCanaryAgent(home: string): { socket: string; stop: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vca-')))
  const socket = join(dir, 'a.sock')
  const started = execFileSync('ssh-agent', ['-a', socket, '-s'], { encoding: 'utf8' })
  const pid = started.match(/SSH_AGENT_PID=(\d+)/)?.[1]
  if (pid === undefined) throw new Error('ssh-agent started no agent for the canary home')
  const stop = (): void => {
    try {
      process.kill(Number(pid))
    } catch {
      // The agent already exited.
    }
    rmSync(dir, { recursive: true, force: true })
  }
  try {
    const key = join(dir, 'key')
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', ENGINE_PROBE_CANARY, '-f', key])
    execFileSync('ssh-add', ['-q', key], { env: { ...process.env, SSH_AUTH_SOCK: socket }, stdio: 'ignore' })
    symlinkSync(socket, join(home, '.ssh', 'agent.sock'))
  } catch (error) {
    stop()
    throw error
  }
  return { socket: join(home, '.ssh', 'agent.sock'), stop }
}

/**
 * A session that runs a command inside the launch shape the ENGINE generates for one role — Claude Code's
 * generated `role-settings.json`, or Codex's generated `config.toml` — never the standalone dispatch's
 * settings. `createRoleLaunchers` writes the same files a real Engine run launches that role from, and the
 * command runs through the SAME `sandboxProbePlanFor` env the Engine's own pre-spawn probe uses, so the
 * boundary judged is the one the Engine ships, with the allowlisted launch env it ships.
 *
 * HOME is a throwaway canary home: the generated deny rules target it, the probes read it, and the credential
 * variables a role must never inherit are injected into the source env so the launch-env allowlist is seen to
 * strip them. No API-key variable is ever placed in the probe environment.
 */
export function openEngineSandboxSession(agent: Agent, role = 'developer'): SandboxSession {
  const worktreeDir = createWorktree(agent)
  const vendor = agent === 'claude' ? 'claude-code' : 'codex'
  const runDir = realpathSync(mkdtempSync(join(tmpdir(), `engine-${agent}-run-`)))
  const generatedRoot = join(runDir, 'generated')
  const variables = grantVariables(worktreeDir, runDir, REPO_ROOT)
  const scratchDir = variables.SCRATCH as string
  const fixtureHome = buildCanaryHome(scratchDir)
  const agentRun = startCanaryAgent(fixtureHome)
  const { runtimeDir, store } = controllerSourceStore()
  // Generate the role settings with HOME and the agent pointer naming the canary home and its agent, so the
  // credential deny rules (`credentialDenyRead`, resolved from the env at generation time) name what the probes reach.
  const realHome = process.env.HOME
  const realAgent = process.env.SSH_AUTH_SOCK
  let launchers: ReturnType<typeof createRoleLaunchers>
  try {
    process.env.HOME = fixtureHome
    process.env.SSH_AUTH_SOCK = agentRun.socket
    launchers = createRoleLaunchers({ vendor, generatedRoot, variables })
  } finally {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    if (realAgent === undefined) delete process.env.SSH_AUTH_SOCK
    else process.env.SSH_AUTH_SOCK = realAgent
  }
  const roleDir = join(generatedRoot, role)
  // The credential variables a role must never inherit — forge tokens and the agent/bus socket pointers,
  // carrying the canary. No API-key variable is included (the brief's trap and O5). The launch-env allowlist
  // (`sandboxProbePlanFor`) passes only PATH/HOME/USER/LOGNAME, so none of these reach the role.
  const sourceEnv: Record<string, string> = {
    ...stripVinayaEnv(),
    HOME: fixtureHome,
    GH_TOKEN: ENGINE_PROBE_CANARY,
    GITHUB_TOKEN: ENGINE_PROBE_CANARY,
    SSH_AUTH_SOCK: agentRun.socket,
    // The bus pointer carries the canary, so a role that inherited it prints the canary.
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(fixtureHome, '.dbus', 'bus')},guid=${ENGINE_PROBE_CANARY}`
  }
  const dispose = (): void => {
    agentRun.stop()
    removeWorktree(worktreeDir)
    rmSync(runDir, { recursive: true, force: true })
    rmSync(runtimeDir, { recursive: true, force: true })
  }
  const base = {
    agent,
    worktreeDir,
    sourceStore: store,
    runOutside: (command: string, env: Record<string, string>) => runOutsideSandbox(worktreeDir, command, env),
    dispose
  }
  if (agent === 'claude') {
    // The sandbox runtime enforces the filesystem/network sandbox — the shell's boundary — from the generated
    // settings' own `sandbox` block, verbatim. The Read-tool `permissions.deny` rules are a Claude-Code layer
    // the runtime does not read; those are proved separately by the static deny-rule check over every role.
    const generated = JSON.parse(readFileSync(join(roleDir, 'role-settings.json'), 'utf8')) as {
      sandbox: {
        network: { allowedDomains: string[]; allowAllUnixSockets?: boolean }
        filesystem: { denyRead?: string[]; allowRead?: string[]; allowWrite: string[]; denyWrite?: string[] }
      }
    }
    const settingsPath = join(runDir, 'srt-settings.json')
    writeFileSync(
      settingsPath,
      JSON.stringify({
        network: {
          allowedDomains: generated.sandbox.network.allowedDomains,
          deniedDomains: [],
          // The host's Unix-socket opt-in ships with the generated settings, so the probes judge that shape too.
          ...(generated.sandbox.network.allowAllUnixSockets === true ? { allowAllUnixSockets: true } : {})
        },
        filesystem: {
          // The agent socket's directory can repeat a home route (the canary agent sits under `.ssh`); name each path once.
          denyRead: [...new Set(generated.sandbox.filesystem.denyRead ?? [])],
          allowRead: generated.sandbox.filesystem.allowRead ?? [],
          allowWrite: generated.sandbox.filesystem.allowWrite,
          denyWrite: generated.sandbox.filesystem.denyWrite ?? []
        }
      })
    )
    const plan = sandboxProbePlanFor('claude-code', launchers[role]!, roleDir, worktreeDir, sourceEnv)
    return {
      ...base,
      run: (command, env) =>
        runIn(
          [process.execPath, 'x', SANDBOX_RUNTIME_PACKAGE, '--settings', settingsPath, '-c', withAbsoluteBun(command)],
          worktreeDir,
          { ...plan.env, TMPDIR: scratchDir, ...env },
          `engine-claude[${role}]: ${command}`
        )
    }
  }
  // Codex launches from the generated CODEX_HOME; `codex sandbox` needs the staged mode as a `--config`
  // override and reads its writable roots from the generated config. The probe env is the allowlisted plan env.
  writeFileSync(join(roleDir, 'auth.json'), '{}\n')
  const plan = sandboxProbePlanFor('codex', launchers[role]!, roleDir, worktreeDir, sourceEnv)
  if (plan.agent !== 'codex') throw new Error('expected a Codex probe plan')
  const sandboxMode = plan.configToml.match(/^sandbox_mode = ("[^"]+")$/m)?.[1]
  if (sandboxMode === undefined) throw new Error('the Engine-generated Codex config names no sandbox_mode')
  const sandboxArgs = plan.withWritableDirs(['sandbox', '--config', `sandbox_mode=${sandboxMode}`])
  return {
    ...base,
    run: (command, env) =>
      runIn(
        [process.execPath, 'x', CODEX_PACKAGE, ...sandboxArgs, '--', 'bash', '-c', withAbsoluteBun(command)],
        worktreeDir,
        { ...plan.env, TMPDIR: scratchDir, ...env },
        `engine-codex[${role}]: ${command}`
      )
  }
}
