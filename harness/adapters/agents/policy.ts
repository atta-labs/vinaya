import type { Decision, RoleGrants } from './manifest'

export interface GeneratedAgentConfig {
  vendor: 'claude-code' | 'codex'
  launch: string[]
  env: Record<string, string>
  files: Record<string, string>
  executableFiles: string[]
}

export interface GeneratorPaths {
  generatedDir: string
  outputSchemaPath: string
  outputSchema: Record<string, unknown>
  mcpCommand?: string
  variables?: Record<string, string>
  currentBranch?: string
  defaultBranch?: string
}

export function resolveGrantValues(values: string[], variables: Record<string, string> = {}): string[] {
  return values.map((value) =>
    value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => variables[name] ?? `\${${name}}`)
  )
}

export interface HookPolicy {
  tools: Record<string, Decision>
  shellAllow: string[]
  shellDeny: string[]
  writableRoots: string[]
  guards: RoleGrants['hooks']
}

export function shellTokens(rule: string): string[] {
  return rule
    .replace(/^Bash\(/, '')
    .replace(/(?::\*|\*)\)$/, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * One dependency-free handler works for both vendors: both documented hook
 * protocols use the same PreToolUse deny object. The policy is embedded in
 * the generated file, so no ambient directory or ungenerated script exists.
 */
export function preToolUseScript(policy: HookPolicy): string {
  return `#!/usr/bin/env node
import { resolve, sep } from 'node:path'

const policy = ${JSON.stringify(policy)}
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
const tool = input.tool_name || input.toolName || ''
const args = input.tool_input || input.toolInput || {}
const command = String(args.command || '')
const deny = (reason) => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason
  } }))
  process.exit(0)
}
const tokens = (rule) => rule.replace(/^Bash\\(/, '').replace(/(?::\\*|\\*)\\)$/, '').trim().split(/\\s+/)
const starts = (line, prefix) => {
  const words = line.trim().split(/\\s+/)
  return prefix.every((word, index) => words[index] === word)
}
const expand = (root) => root.replace(/\\$\\{([A-Z0-9_]+)\\}/g, (_, name) => process.env[name] || '')
const inside = (path, root) => {
  const candidate = resolve(path)
  const boundary = resolve(expand(root))
  return boundary.length > 0 && (candidate === boundary || candidate.startsWith(boundary + sep))
}

if (policy.tools[tool] === 'deny') deny(tool + ' is denied by the role manifest')
if (tool === 'Bash') {
  if (policy.guards.background_shell && /(^|[^&])&(?!&)|\\bbg\\b/.test(command)) deny('background shell is denied')
  if (policy.guards.force_push && /git(?:\\s+-\\S+)*\\s+push\\b[^\\n]*(--force(?:-with-lease)?|-f\\b)/.test(command)) deny('force push is denied')
  if (policy.guards.no_verify && /git\\s+(?:commit|push)\\b[^\\n]*(--no-verify|-n\\b)/.test(command)) deny('verification bypass is denied')
  if (policy.guards.default_branch_commit && /git\\s+commit\\b/.test(command) && process.env.VINAYA_CURRENT_BRANCH === process.env.VINAYA_DEFAULT_BRANCH) deny('commit on the default branch is denied')
  if (policy.shellDeny.some((rule) => starts(command, tokens(rule)))) deny('command matches a shell deny rule')
  if (!policy.shellAllow.some((rule) => starts(command, tokens(rule)))) deny('command is outside the shell allowlist')
}
if (policy.guards.write_scope && ['Write', 'Edit', 'NotebookEdit', 'apply_patch'].includes(tool)) {
  const paths = [args.file_path, args.path, args.notebook_path].filter(Boolean).map(String)
  if (paths.length === 0 || paths.some((path) => !policy.writableRoots.some((root) => inside(path, root)))) deny('write is outside the writable roots')
}
`
}

export function normalizedCapabilities(grants: RoleGrants, vendor: 'claude' | 'codex'): Record<string, Decision> {
  if (vendor === 'claude')
    return {
      shell: grants.tools.claude.Bash,
      write: grants.tools.claude.Write === 'allow' && grants.tools.claude.Edit === 'allow' ? 'allow' : 'deny',
      plan: grants.tools.claude.TodoWrite,
      view_image: grants.tools.claude.Read,
      web_fetch: grants.tools.claude.WebFetch,
      web_search: grants.tools.claude.WebSearch
    }
  return {
    shell: grants.tools.codex.exec_command,
    write: grants.tools.codex.apply_patch,
    plan: grants.tools.codex.update_plan,
    view_image: grants.tools.codex.view_image,
    web_fetch: grants.tools.codex.web_fetch,
    web_search: grants.tools.codex.web_search
  }
}
