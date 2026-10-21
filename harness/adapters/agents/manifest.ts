import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

export const ROLE_NAMES = ['developer', 'code-reviewer', 'security-reviewer'] as const
export type RoleName = (typeof ROLE_NAMES)[number]

export interface RoleGrants {
  role: RoleName
  vendor: { claude: { model: string }; codex: { model: string } }
  tools: { builtins: Record<string, 'allow' | 'deny'>; mcp: Record<string, string[]> }
  shell: { allow: string[]; deny: string[] }
  writable_roots: string[]
  network_domains: string[]
  hooks: Record<'background_shell' | 'force_push' | 'no_verify' | 'default_branch_commit' | 'write_scope', boolean>
  sandbox: { claude: 'enabled'; codex: 'workspace-write' | 'read-only' }
}

export function loadRoleGrants(path: string): RoleGrants {
  return parse(readFileSync(path, 'utf8')) as RoleGrants
}

export function mcpRule(server: string, tool: string): string {
  return `mcp__${server}__${tool}`
}
