import type { ClaudeBuiltin, RoleCapabilities } from '../manifest'

/**
 * Claude Code's mapping table: which built-ins each capability turns on. A
 * built-in no allowed capability names is denied.
 */
export const CLAUDE_CAPABILITY_TOOLS = {
  read_files: ['Read', 'Grep', 'Glob', 'LSP', 'Skill'],
  run_commands: ['Bash', 'KillShell', 'Monitor'],
  write_files: ['Edit', 'Write', 'NotebookEdit'],
  plan_tool: ['TodoWrite', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate'],
  subagents: ['Agent', 'Task', 'TaskOutput', 'TaskStop', 'Workflow'],
  web_fetch: ['WebFetch'],
  web_search: ['WebSearch'],
  // Claude reads images with Read; no separate built-in.
  view_image: [],
  // ToolSearch loads the schemas of deferred MCP tools, so a role with MCP tools needs it.
  mcp_tools: ['ToolSearch']
} as const satisfies Record<string, readonly ClaudeBuiltin[]>

/** Each Claude built-in's decision for a capability set. */
export function claudeToolDecisions(
  capabilities: RoleCapabilities,
  hasMcpTools: boolean,
  catalog: readonly ClaudeBuiltin[]
): Record<ClaudeBuiltin, 'allow' | 'deny'> {
  const on = new Set<ClaudeBuiltin>()
  const add = (tools: readonly ClaudeBuiltin[]) => {
    for (const tool of tools) on.add(tool)
  }
  if (capabilities.read_files === 'allow') add(CLAUDE_CAPABILITY_TOOLS.read_files)
  if (capabilities.run_commands !== 'deny') add(CLAUDE_CAPABILITY_TOOLS.run_commands)
  if (capabilities.write_files !== 'deny') add(CLAUDE_CAPABILITY_TOOLS.write_files)
  if (capabilities.plan_tool === 'allow') add(CLAUDE_CAPABILITY_TOOLS.plan_tool)
  if (capabilities.subagents === 'allow') add(CLAUDE_CAPABILITY_TOOLS.subagents)
  if (capabilities.web_fetch === 'allow') add(CLAUDE_CAPABILITY_TOOLS.web_fetch)
  if (capabilities.web_search === 'allow') add(CLAUDE_CAPABILITY_TOOLS.web_search)
  if (hasMcpTools) add(CLAUDE_CAPABILITY_TOOLS.mcp_tools)
  return Object.fromEntries(catalog.map((tool) => [tool, on.has(tool) ? 'allow' : 'deny'])) as Record<
    ClaudeBuiltin,
    'allow' | 'deny'
  >
}

/**
 * A vendor-neutral command rule in Claude's permission syntax: a plain prefix
 * becomes `Bash(<prefix>:*)`; a prefix ending in `*` (a longer first word
 * too) becomes `Bash(<prefix>*)`. The hook and the Codex execpolicy read the
 * prefix back out of this form (`shellTokens`).
 */
export function claudeShellRule(prefix: string): string {
  return prefix.endsWith('*') ? `Bash(${prefix})` : `Bash(${prefix}:*)`
}
