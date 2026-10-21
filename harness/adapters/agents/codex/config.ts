import type { RoleGrants } from '../manifest'

const quote = (value: string) => JSON.stringify(value)
const tokens = (rule: string) =>
  rule
    .replace(/^Bash\(/, '')
    .replace(/(?::\*|\*)\)$/, '')
    .trim()
    .split(/\s+/)

export function generateCodexConfig(grants: RoleGrants, outputSchemaPath: string) {
  const domainLines = grants.network_domains.map((domain) => `${quote(domain)} = "allow"`)
  const writable = grants.writable_roots.map(quote).join(', ')
  const mcpTools = Object.values(grants.tools.mcp).flat()
  const configToml = [
    `model = ${quote(grants.vendor.codex.model)}`,
    `sandbox_mode = ${quote(grants.sandbox.codex)}`,
    `web_search = ${quote(grants.tools.builtins.WebSearch === 'allow' ? 'live' : 'disabled')}`,
    '',
    '[sandbox_workspace_write]',
    `writable_roots = [${writable}]`,
    'network_access = true',
    '',
    '[features.network_proxy]',
    'enabled = true',
    '',
    '[features.network_proxy.domains]',
    ...domainLines,
    '',
    '[mcp_servers.vinaya_dev_tools]',
    'enabled = true',
    'tool_timeout_sec = 120',
    `enabled_tools = ${JSON.stringify(mcpTools)}`,
    'default_tools_approval_mode = "approve"',
    '',
    '[[hooks.PreToolUse]]',
    'matcher = "^(shell|apply_patch)$"',
    '',
    '[[hooks.PreToolUse.hooks]]',
    'type = "command"',
    'command = "bun $VINAYA_HOOKS_DIR/pre-tool-use.ts"',
    'timeout = 30',
    ''
  ].join('\n')
  const execpolicy =
    grants.shell.deny
      .map(
        (rule) =>
          `prefix_rule(pattern = ${JSON.stringify(tokens(rule))}, decision = "forbidden", justification = "role grants deny")`
      )
      .join('\n') + '\n'
  return {
    configToml,
    execpolicy,
    launch: [
      'codex',
      'exec',
      '--config',
      'approval_policy="never"',
      '--output-schema',
      outputSchemaPath,
      '--model',
      grants.vendor.codex.model,
      '-'
    ]
  }
}
