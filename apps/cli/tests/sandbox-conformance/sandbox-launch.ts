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
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { spawnBudgetedAsync, stripVinayaEnv } from '../lib/process-fixture.js'
import { isSuiteInput, REPO_ROOT } from './command-sources.js'

export const AGENTS = ['claude', 'codex'] as const
export type Agent = (typeof AGENTS)[number]

/** Pinned so a runtime release never changes the suite's verdict silently — bump deliberately, then re-run. */
export const SANDBOX_RUNTIME_PACKAGE = '@anthropic-ai/sandbox-runtime@0.0.78'
export const CODEX_PACKAGE = '@openai/codex@0.160.0'

/** Ten minutes: `bun run typecheck` on a cold worktree is the slowest command in the list. */
export const COMMAND_BUDGET_MS = 600_000

export type CommandResult = { exitCode: number; output: string }

export type SandboxSession = {
  readonly agent: Agent
  readonly worktreeDir: string
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

function request(agent: Agent, worktreeDir: string, scratchDir: string): ConfinementRequest {
  return { role: 'developer', agent, worktreeDir, scratchDir, allowedHosts: CLAUDE_SANDBOX_ALLOWED_DOMAINS }
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
  const resolution = resolveClaudeConfinement(request('claude', worktreeDir, scratchDir))
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
  if (shipped !== JSON.stringify([['allowedDomains'], ['allowRead', 'allowWrite', 'denyRead'], ['files']])) {
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
        denyWrite: []
      }
    })
  )
  return {
    agent: 'claude',
    worktreeDir,
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
    }
  }
}

function codexSession(): SandboxSession {
  const worktreeDir = createWorktree('codex')
  const scratchDir = realpathSync(mkdtempSync(join(tmpdir(), 'vinaya-codex-sandbox-')))
  const stageRoot = mkdtempSync(join(tmpdir(), 'vinaya-conformance-codex-'))
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
    }
  }
}

export function openSandboxSession(agent: Agent): SandboxSession {
  return agent === 'claude' ? claudeSession() : codexSession()
}
