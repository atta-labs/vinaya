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
 *
 * Each agent gets its own fresh linked worktree of `HEAD` under
 * `.worktrees/`, as a dispatched Developer does: the driver creates it, the
 * Developer's first command (`bun install`) runs inside the sandbox.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addCodexWritableDirs, buildCodexExecpolicyRules } from '../../src/lib/dispatch.js'
import {
  CLAUDE_SANDBOX_ALLOWED_DOMAINS,
  type ConfinementRequest,
  resolveClaudeConfinement,
  resolveCodexConfinement,
  resolveGitCommonDir,
  stageCodexPolicyHome
} from '../../src/lib/worker-boundary.js'
import { spawnBudgetedAsync, stripVinayaEnv } from '../lib/process-fixture.js'
import { REPO_ROOT } from './command-sources.js'

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

/** `{ tranche, n }` for a `task/<tranche>/<n>` branch, `null` otherwise. */
export function taskIdentity(branch: string): { tranche: string; n: string } | null {
  const m = branch.match(/^task\/([^/]+)\/(\d+)$/)
  return m?.[1] && m[2] ? { tranche: m[1], n: m[2] } : null
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

function claudeSession(): SandboxSession {
  const worktreeDir = createWorktree('claude')
  const scratchDir = realpathSync(mkdtempSync(join(tmpdir(), 'vinaya-claude-sandbox-')))
  const settingsDir = mkdtempSync(join(tmpdir(), 'vinaya-conformance-srt-'))
  const resolution = resolveClaudeConfinement(request('claude', worktreeDir, scratchDir))
  if (!resolution.confined) {
    throw new Error(`Claude's sandbox cannot run on this host: ${resolution.warning}`)
  }
  const { network, filesystem } = resolution.settings.sandbox
  const settingsPath = join(settingsDir, 'srt-settings.json')
  writeFileSync(
    settingsPath,
    JSON.stringify({
      network: { allowedDomains: network.allowedDomains, deniedDomains: [] },
      filesystem: {
        denyRead: filesystem.denyRead,
        allowRead: filesystem.allowRead,
        allowWrite: filesystem.allowWrite,
        denyWrite: []
      }
    })
  )
  return {
    agent: 'claude',
    worktreeDir,
    run: (command, env) =>
      runIn(
        [process.execPath, 'x', SANDBOX_RUNTIME_PACKAGE, '--settings', settingsPath, '-c', withAbsoluteBun(command)],
        worktreeDir,
        {
          ...stripVinayaEnv(),
          ...(resolution.pathOverride !== undefined ? { PATH: resolution.pathOverride } : {}),
          TMPDIR: scratchDir,
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
  const gitCommonDir = resolveGitCommonDir(worktreeDir)
  const sandboxArgs = addCodexWritableDirs(['sandbox'], [scratchDir, ...(gitCommonDir ? [gitCommonDir] : [])], true)
  return {
    agent: 'codex',
    worktreeDir,
    run: (command, env) =>
      runIn(
        [process.execPath, 'x', CODEX_PACKAGE, ...sandboxArgs, '--', 'bash', '-c', withAbsoluteBun(command)],
        worktreeDir,
        { ...stripVinayaEnv(), CODEX_HOME: staged.codexHome, TMPDIR: scratchDir, ...env },
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
