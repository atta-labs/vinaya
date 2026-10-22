import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

export const ROLE_NAMES = ['developer', 'code-reviewer', 'security-reviewer'] as const
export type RoleName = (typeof ROLE_NAMES)[number]
export type Decision = 'allow' | 'deny'

/** Complete built-in catalog exposed by the pinned Claude tools reference. */
export const CLAUDE_BUILTINS = [
  'Agent',
  'Artifact',
  'AskUserQuestion',
  'Bash',
  'CronCreate',
  'CronDelete',
  'CronList',
  'Edit',
  'EndConversation',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'Glob',
  'Grep',
  'KillShell',
  'ListAgents',
  'ListMcpResourcesTool',
  'LSP',
  'Monitor',
  'NotebookEdit',
  'PowerShell',
  'PushNotification',
  'Read',
  'ReadMcpResourceTool',
  'RemoteTrigger',
  'ReportFindings',
  'ScheduleWakeup',
  'SendFeedback',
  'SendMessage',
  'SendUserFile',
  'ShareOnboardingGuide',
  'Skill',
  'SubagentHandback',
  'Task',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'TodoWrite',
  'ToolSearch',
  'WaitForMcpServers',
  'WebFetch',
  'WebSearch',
  'Workflow',
  'Write'
] as const

/** Complete local built-in catalog exposed by the pinned Codex configuration and hook references. */
export const CODEX_BUILTINS = [
  'exec_command',
  'write_stdin',
  'apply_patch',
  'update_plan',
  'view_image',
  'web_search',
  'web_fetch',
  'spawn_agent',
  'send_input',
  'resume_agent',
  'wait_agent',
  'close_agent'
] as const

export type ClaudeBuiltin = (typeof CLAUDE_BUILTINS)[number]
export type CodexBuiltin = (typeof CODEX_BUILTINS)[number]

export interface RoleGrants {
  role: RoleName
  vendor: { claude: { model: string }; codex: { model: string } }
  tools: {
    claude: Record<ClaudeBuiltin, Decision>
    codex: Record<CodexBuiltin, Decision>
    mcp: Record<string, string[]>
  }
  /** `default: allow` lets a command no allow rule names run; only `deny` and the hook guards refuse. Absent: it is refused. */
  shell: { allow: string[]; deny: string[]; default?: Decision }
  writable_roots: string[]
  network_domains: string[]
  hooks: Record<'background_shell' | 'force_push' | 'no_verify' | 'default_branch_commit' | 'write_scope', boolean>
  sandbox: { claude: 'enabled'; codex: 'workspace-write' | 'read-only' }
}

function exactCatalog(kind: string, actual: Record<string, unknown>, expected: readonly string[]): void {
  const missing = expected.filter((name) => !(name in actual))
  const extra = Object.keys(actual).filter((name) => !expected.includes(name))
  if (missing.length || extra.length)
    throw new Error(`${kind} built-in catalog mismatch; missing=[${missing}] extra=[${extra}]`)
  for (const [name, decision] of Object.entries(actual)) {
    if (decision !== 'allow' && decision !== 'deny') throw new Error(`${kind}.${name} must be allow or deny`)
  }
}

export function loadRoleGrants(path: string): RoleGrants {
  const grants = parse(readFileSync(path, 'utf8')) as RoleGrants
  exactCatalog('claude', grants.tools.claude, CLAUDE_BUILTINS)
  exactCatalog('codex', grants.tools.codex, CODEX_BUILTINS)
  if (grants.tools.codex.exec_command !== grants.tools.codex.write_stdin) {
    throw new Error('Codex exec_command and write_stdin share the Bash hook/shell surface and must have one decision')
  }
  return grants
}

export function mcpRule(server: string, tool: string): string {
  return `mcp__${server}__${tool}`
}
