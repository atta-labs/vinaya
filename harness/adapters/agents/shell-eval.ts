import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateClaudeSettings } from './claude-code/settings'
import { generateCodexConfig } from './codex/config'
import { loadRoleGrants } from './manifest'
import type { GeneratedAgentConfig } from './policy'
import { ORDINARY_COMMANDS, SHELL_ATTACKS, type ShellGuard } from './shell-attacks'

const processRoot = join(import.meta.dir, '../../../processes/vinaya/executing')

export interface ShellDecisionRow {
  guard: ShellGuard | 'ordinary'
  command: string
  claude: 'deny' | 'allow'
  codex: 'deny' | 'allow'
  claudeReason: string
  codexReason: string
}

function probeRepository(branch: 'task' | 'main'): string {
  const directory = mkdtempSync(join(tmpdir(), `vinaya-shell-eval-${branch}-`))
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', '-C', directory, ...args])
    if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
  }
  git('init', '-b', 'main')
  git('config', 'user.email', 'probe@example.invalid')
  git('config', 'user.name', 'Probe')
  writeFileSync(join(directory, 'tracked'), 'x')
  git('add', 'tracked')
  git('commit', '-m', 'initial')
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  if (branch === 'task') git('checkout', '-b', 'task')
  return directory
}

/** Runs each command through the generated Claude hook and the generated Codex hook. */
export function evaluateShellGuards(): ShellDecisionRow[] {
  const grants = loadRoleGrants(join(processRoot, 'developer/grants.yaml'))
  const outputSchema = JSON.parse(readFileSync(join(processRoot, 'developer/output.schema.json'), 'utf8'))
  const hooks = new Map<string, string>()
  const repositories = { task: probeRepository('task'), main: probeRepository('main') }
  const hookFor = (vendor: 'claude' | 'codex', branch: 'task' | 'main'): string => {
    const key = `${vendor}-${branch}`
    const existing = hooks.get(key)
    if (existing) return existing
    const workspace = repositories[branch]
    const paths = {
      generatedDir: workspace,
      outputSchemaPath: 'output.schema.json',
      outputSchema,
      variables: {
        WORKTREE: workspace,
        SCRATCH: join(workspace, 'scratch'),
        BUN_INSTALL_CACHE: '/bun',
        GIT_COMMON_DIR: join(workspace, '.git')
      }
    }
    const config: GeneratedAgentConfig =
      vendor === 'claude' ? generateClaudeSettings(grants, paths) : generateCodexConfig(grants, paths)
    const path = join(workspace, `${vendor}-pre-tool-use.mjs`)
    mkdirSync(workspace, { recursive: true })
    writeFileSync(path, config.files['hooks/pre-tool-use.mjs'] ?? '')
    hooks.set(key, path)
    return path
  }
  const decide = (vendor: 'claude' | 'codex', branch: 'task' | 'main', command: string) => {
    const output = Bun.spawnSync(['node', hookFor(vendor, branch)], {
      cwd: repositories[branch],
      stdin: Buffer.from(JSON.stringify({ tool_name: 'Bash', tool_input: { command } }))
    }).stdout.toString()
    const reason = /"permissionDecisionReason":"([^"]*)"/.exec(output)?.[1] ?? ''
    return { decision: output.includes('"permissionDecision":"deny"') ? ('deny' as const) : ('allow' as const), reason }
  }
  const row = (guard: ShellGuard | 'ordinary', branch: 'task' | 'main', command: string): ShellDecisionRow => {
    const claude = decide('claude', branch, command)
    const codex = decide('codex', branch, command)
    return {
      guard,
      command,
      claude: claude.decision,
      codex: codex.decision,
      claudeReason: claude.reason,
      codexReason: codex.reason
    }
  }
  return [
    ...SHELL_ATTACKS.map(({ guard, branch, command }) => row(guard, branch, command)),
    ...ORDINARY_COMMANDS.map((command) => row('ordinary', 'task', command))
  ]
}
