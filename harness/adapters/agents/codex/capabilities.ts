import type { CodexBuiltin, RoleCapabilities } from '../manifest'

/**
 * Codex's mapping table: which built-ins each capability turns on. A built-in
 * no allowed capability names is denied. Codex has no file-reading tool; it
 * reads through its shell, so `read_files` and `run_commands` both turn the
 * shell on (see `codexShellRules` for what the shell may then run).
 */
export const CODEX_CAPABILITY_TOOLS = {
  read_files: ['exec_command', 'write_stdin'],
  run_commands: ['exec_command', 'write_stdin'],
  write_files: ['apply_patch'],
  plan_tool: ['update_plan'],
  subagents: ['spawn_agent', 'resume_agent', 'wait_agent', 'close_agent'],
  web_fetch: ['web_fetch'],
  web_search: ['web_search'],
  view_image: ['view_image']
} as const satisfies Record<string, readonly CodexBuiltin[]>

/**
 * The commands a Codex role may run when it may read files but not run
 * commands: reading commands only. No sed: its `w` and GNU `e` commands write files and run commands from
 * inside the script, where no rule can see them; head, tail and cat cover line ranges. The read-only sandbox (no `write_files`)
 * keeps even these from writing.
 */
export const CODEX_READ_ONLY_COMMANDS = [
  'cat',
  'head',
  'tail',
  'rg',
  'grep',
  'ls',
  'find',
  'wc',
  'git diff',
  'git log',
  'git show',
  'git status'
] as const

/**
 * Command prefixes (see `RoleCapabilities.run_commands`) refused outright in that reading-only shell, as execpolicy rules and hook
 * denies: commands that change a repository, reach the forge, install or run
 * code, or change the host. They are the floor beneath the allowlist, should
 * the hook fail open.
 */
export const CODEX_READ_ONLY_FORBIDDEN = [
  'git push',
  'git commit',
  'git add',
  'gh',
  'bun install',
  'bun test',
  'bun run',
  'npx',
  'security',
  'launchctl',
  'defaults',
  'systemsetup',
  'networksetup',
  'pmset',
  'dscl',
  'crontab',
  'chsh',
  'git config --global',
  'git config --system',
  'sudo',
  // Write-capable forms of the reading commands above. `…` before a flag means the flag anywhere after the
  // prefix; only the hook can see that, so these have no execpolicy rule. The read-only sandbox refuses
  // the write even if a form is missed here.
  'git -c',
  'find ... -exec',
  'find ... -execdir',
  'find ... -ok',
  'find ... -okdir',
  'find ... -delete',
  'find ... -fprint',
  'find ... -fprint0',
  'find ... -fprintf',
  'find ... -fls',
  'git diff ... --output',
  'git diff ... --ext-diff',
  'git diff ... --textconv',
  'git log ... --output',
  'git log ... --ext-diff',
  'git log ... --textconv',
  'git show ... --output',
  'git show ... --ext-diff',
  'git show ... --textconv',
  'rg ... --pre'
] as const

/** Each Codex built-in's decision for a capability set. */
export function codexToolDecisions(
  capabilities: RoleCapabilities,
  catalog: readonly CodexBuiltin[]
): Record<CodexBuiltin, 'allow' | 'deny'> {
  const on = new Set<CodexBuiltin>()
  const add = (tools: readonly CodexBuiltin[]) => {
    for (const tool of tools) on.add(tool)
  }
  if (capabilities.read_files === 'allow') add(CODEX_CAPABILITY_TOOLS.read_files)
  if (capabilities.run_commands !== 'deny') add(CODEX_CAPABILITY_TOOLS.run_commands)
  if (capabilities.write_files !== 'deny') add(CODEX_CAPABILITY_TOOLS.write_files)
  if (capabilities.plan_tool === 'allow') add(CODEX_CAPABILITY_TOOLS.plan_tool)
  if (capabilities.subagents === 'allow') add(CODEX_CAPABILITY_TOOLS.subagents)
  if (capabilities.web_fetch === 'allow') add(CODEX_CAPABILITY_TOOLS.web_fetch)
  if (capabilities.web_search === 'allow') add(CODEX_CAPABILITY_TOOLS.web_search)
  if (capabilities.view_image === 'allow') add(CODEX_CAPABILITY_TOOLS.view_image)
  return Object.fromEntries(catalog.map((tool) => [tool, on.has(tool) ? 'allow' : 'deny'])) as Record<
    CodexBuiltin,
    'allow' | 'deny'
  >
}

/** The Codex sandbox a capability set asks for: workspace-write only when the role may write files. */
export function codexSandbox(capabilities: RoleCapabilities): 'workspace-write' | 'read-only' {
  return capabilities.write_files === 'deny' ? 'read-only' : 'workspace-write'
}
