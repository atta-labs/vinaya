import { mcpRule, type RoleGrants } from '../manifest'

const hookCommand = (guard: string) => `bun "$VINAYA_HOOKS_DIR/${guard}.ts"`

export function generateClaudeSettings(grants: RoleGrants, outputSchemaPath: string) {
  const builtinAllow = Object.entries(grants.tools.builtins)
    .filter(([, v]) => v === 'allow')
    .map(([k]) => k)
  const builtinDeny = Object.entries(grants.tools.builtins)
    .filter(([, v]) => v === 'deny')
    .map(([k]) => k)
  const mcpAllow = Object.entries(grants.tools.mcp).flatMap(([server, tools]) =>
    tools.map((tool) => mcpRule(server, tool))
  )
  const hooks = Object.entries(grants.hooks)
    .filter(([, enabled]) => enabled)
    .map(([guard]) => ({
      matcher: 'Bash|Write|Edit',
      hooks: [{ type: 'command', command: hookCommand(guard.replaceAll('_', '-')) }]
    }))
  return {
    settings: {
      model: grants.vendor.claude.model,
      permissions: {
        allow: [...builtinAllow, ...grants.shell.allow, ...mcpAllow],
        deny: [...builtinDeny, ...grants.shell.deny]
      },
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: false,
        allowUnsandboxedCommands: false,
        network: { allowedDomains: grants.network_domains, strictAllowlist: true },
        filesystem: { allowWrite: grants.writable_roots }
      },
      hooks: { PreToolUse: hooks }
    },
    launch: [
      'claude',
      '-p',
      '--settings',
      'role-settings.json',
      '--setting-sources',
      'user',
      '--strict-mcp-config',
      '--mcp-config',
      'role-mcp.json',
      '--json-schema',
      outputSchemaPath,
      '--model',
      grants.vendor.claude.model
    ]
  }
}
