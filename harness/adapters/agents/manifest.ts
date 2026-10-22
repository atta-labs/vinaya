import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { claudeShellRule, claudeToolDecisions } from './claude-code/capabilities'
import {
  CODEX_READ_ONLY_COMMANDS,
  CODEX_READ_ONLY_FORBIDDEN,
  codexSandbox,
  codexToolDecisions
} from './codex/capabilities'

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

/** A role's vendor-neutral capability contract: what the role may do, never which vendor tool does it. */
export interface RoleCapabilities {
  read_files: Decision
  /**
   * Shell commands, or none at all. Rules are plain command prefixes ("git push", "gh"); a trailing `*`
   * also matches a longer first word ("sudo*"); `prefix ... -flag` matches the flag anywhere after the
   * prefix. `default: allow` lets a command no allow rule names run.
   */
  run_commands: 'deny' | { default?: Decision; allow: string[]; deny: string[] }
  /** The roots the role may write under (`${...}` placeholders allowed), or none. */
  write_files: 'deny' | string[]
  /** The network domains the role's sandbox may reach. */
  network: string[]
  web_fetch: Decision
  web_search: Decision
  subagents: Decision
  plan_tool: Decision
  view_image: Decision
}

/** A role's grants file as written: the capability contract plus the few fields that are not capabilities. */
export interface RoleContract {
  role: RoleName
  /**
   * The model per vendor. This is the one vendor-keyed field: a model id names
   * one vendor's model and has no neutral form. `process-supplied` leaves the
   * choice to the run.
   */
  models: { claude: string; codex: string }
  capabilities: RoleCapabilities
  /** MCP tools by server; the same names on every vendor. */
  mcp_tools: Record<string, string[]>
  hooks: Record<'background_shell' | 'force_push' | 'no_verify' | 'default_branch_commit' | 'write_scope', boolean>
  /** The vendor's own sandbox is always on; how strict follows from the capabilities. */
  sandbox: 'enabled'
}

/**
 * The resolved grants the adapters generate from: each vendor's built-in
 * table, derived from a `RoleContract` through the adapters' mapping tables
 * (`claude-code/capabilities.ts`, `codex/capabilities.ts`). Never written by hand.
 */
export interface RoleGrants {
  role: RoleName
  vendor: { claude: { model: string }; codex: { model: string } }
  tools: {
    claude: Record<ClaudeBuiltin, Decision>
    codex: Record<CodexBuiltin, Decision>
    mcp: Record<string, string[]>
  }
  /** `default: allow` lets a command no allow rule names run; only `deny` and the hook guards refuse. Absent: it is refused. */
  /** The command rules rendered once in Claude's `Bash(…)` form; the hook and Codex read the prefix back (`shellTokens`). */
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

const DECISIONS = new Set(['allow', 'deny'])
const CAPABILITY_DECISIONS = ['read_files', 'web_fetch', 'web_search', 'subagents', 'plan_tool', 'view_image'] as const

/** Reads and checks a role's capability contract. */
export function loadRoleContract(path: string): RoleContract {
  const contract = parse(readFileSync(path, 'utf8')) as RoleContract
  if ('tools' in (contract as object) || 'vendor' in (contract as object))
    throw new Error(`${path}: grants name capabilities, not vendor tools (no "tools" or "vendor" key)`)
  const caps = contract.capabilities
  if (!caps) throw new Error(`${path}: missing capabilities`)
  for (const key of CAPABILITY_DECISIONS)
    if (!DECISIONS.has(caps[key])) throw new Error(`${path}: capabilities.${key} must be allow or deny`)
  if (
    caps.run_commands !== 'deny' &&
    (!Array.isArray(caps.run_commands?.allow) || !Array.isArray(caps.run_commands?.deny))
  )
    throw new Error(`${path}: capabilities.run_commands must be deny or { allow: [...], deny: [...] }`)
  if (caps.write_files !== 'deny' && !Array.isArray(caps.write_files))
    throw new Error(`${path}: capabilities.write_files must be deny or a list of roots`)
  if (!Array.isArray(caps.network)) throw new Error(`${path}: capabilities.network must be a list of domains`)
  return contract
}

/** The vendor built-in tables and shell rules a contract resolves to, through each adapter's mapping table. */
export function resolveRoleGrants(contract: RoleContract): RoleGrants {
  const caps = contract.capabilities
  const run = caps.run_commands
  // A role that may read but not run commands still needs Codex's shell to read: reading commands only.
  const shell =
    run === 'deny'
      ? caps.read_files === 'allow'
        ? { allow: CODEX_READ_ONLY_COMMANDS.map(claudeShellRule), deny: CODEX_READ_ONLY_FORBIDDEN.map(claudeShellRule) }
        : { allow: [], deny: [] }
      : {
          allow: run.allow.map(claudeShellRule),
          deny: run.deny.map(claudeShellRule),
          ...(run.default ? { default: run.default } : {})
        }
  const grants: RoleGrants = {
    role: contract.role,
    vendor: { claude: { model: contract.models.claude }, codex: { model: contract.models.codex } },
    tools: {
      claude: claudeToolDecisions(caps, Object.keys(contract.mcp_tools).length > 0, CLAUDE_BUILTINS),
      codex: codexToolDecisions(caps, CODEX_BUILTINS),
      mcp: contract.mcp_tools
    },
    shell,
    writable_roots: caps.write_files === 'deny' ? [] : caps.write_files,
    network_domains: caps.network,
    hooks: contract.hooks,
    sandbox: { claude: 'enabled', codex: codexSandbox(caps) }
  }
  exactCatalog('claude', grants.tools.claude, CLAUDE_BUILTINS)
  exactCatalog('codex', grants.tools.codex, CODEX_BUILTINS)
  return grants
}

/** A role's grants file, resolved for the adapters. */
export function loadRoleGrants(path: string): RoleGrants {
  return resolveRoleGrants(loadRoleContract(path))
}

export function mcpRule(server: string, tool: string): string {
  return `mcp__${server}__${tool}`
}

/** A role's grants with every `process-supplied` model replaced by `model`; an absent model leaves them unchanged. */
export function withModel(grants: RoleGrants, model: string | undefined): RoleGrants {
  if (model === undefined) return grants
  const pick = (current: string) => (current === 'process-supplied' ? model : current)
  return {
    ...grants,
    vendor: {
      ...grants.vendor,
      claude: { ...grants.vendor.claude, model: pick(grants.vendor.claude.model) },
      codex: { ...grants.vendor.codex, model: pick(grants.vendor.codex.model) }
    }
  }
}
