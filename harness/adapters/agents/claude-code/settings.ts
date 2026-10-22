import { join } from 'node:path'
import { mcpRule, type RoleGrants } from '../manifest'
import {
  normalizedCapabilities,
  preToolUseScript,
  resolveGrantValues,
  type GeneratedAgentConfig,
  type GeneratorPaths,
  type HookPolicy
} from '../policy'

export function generateClaudeSettings(grants: RoleGrants, paths: GeneratorPaths): GeneratedAgentConfig {
  const builtinAllow = Object.entries(grants.tools.claude)
    .filter(([name, decision]) => name !== 'Bash' && decision === 'allow')
    .map(([name]) => name)
  const builtinDeny = Object.entries(grants.tools.claude)
    .filter(([, decision]) => decision === 'deny')
    .map(([name]) => name)
  const mcpAllow = Object.entries(grants.tools.mcp).flatMap(([server, tools]) =>
    tools.map((tool) => mcpRule(server, tool))
  )
  const hookPath = join(paths.generatedDir, 'hooks', 'pre-tool-use.mjs')
  const writableRoots = resolveGrantValues(grants.writable_roots, paths.variables)
  const settingsPath = join(paths.generatedDir, 'role-settings.json')
  const mcpPath = join(paths.generatedDir, 'role-mcp.json')
  const shellDefaultAllow = grants.shell.default === 'allow'
  const hookPolicy: HookPolicy = {
    tools: grants.tools.claude,
    shellAllow: grants.shell.allow,
    shellDeny: grants.shell.deny,
    shellDefaultAllow: shellDefaultAllow,
    writableRoots,
    guards: grants.hooks
  }
  const settings = {
    ...(grants.vendor.claude.model === 'process-supplied' ? {} : { model: grants.vendor.claude.model }),
    permissions: {
      // Bash exposure is not a bare allow unless the role's grants say the
      // shell's default is allow; otherwise only the explicit command rules
      // below authorize shell commands. The deny rules hold either way.
      allow: [...builtinAllow, ...(shellDefaultAllow ? ['Bash'] : []), ...grants.shell.allow, ...mcpAllow],
      deny: [...builtinDeny, ...grants.shell.deny]
    },
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      network: {
        allowedDomains: grants.network_domains,
        strictAllowlist: true,
        // The host opt-in turns off only the sandbox's Unix-socket seccomp filter.
        ...(paths.allowUnixSockets === true ? { allowAllUnixSockets: true } : {})
      },
      filesystem: { allowWrite: writableRoots }
    },
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash|Write|Edit|NotebookEdit|Agent|Task',
          hooks: [{ type: 'command', command: `node ${JSON.stringify(hookPath)}`, timeout: 30 }]
        }
      ]
    }
  }
  const mcp = {
    mcpServers: {
      vinaya_dev_tools: { type: 'stdio', command: paths.mcpCommand ?? 'vinaya-dev-bridge', args: [] }
    }
  }
  return {
    vendor: 'claude-code',
    launch: [
      'claude',
      '-p',
      '--settings',
      settingsPath,
      '--setting-sources',
      'user',
      '--strict-mcp-config',
      '--mcp-config',
      mcpPath,
      '--json-schema',
      JSON.stringify(paths.outputSchema),
      ...(grants.vendor.claude.model === 'process-supplied' ? [] : ['--model', grants.vendor.claude.model])
    ],
    env: {},
    files: {
      'role-settings.json': JSON.stringify(settings, null, 2) + '\n',
      'role-mcp.json': JSON.stringify(mcp, null, 2) + '\n',
      'hooks/pre-tool-use.mjs': preToolUseScript(hookPolicy),
      'effective-capabilities.json': JSON.stringify(normalizedCapabilities(grants, 'claude'), null, 2) + '\n'
    },
    executableFiles: ['hooks/pre-tool-use.mjs']
  }
}
