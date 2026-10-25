import { join } from 'node:path'
import { DEV_TOOLS_TOOL_TIMEOUT_SEC } from '@attalabs/aeg-types/dev-tools'
import { mcpRule, type RoleGrants } from '../manifest'
import {
  normalizedCapabilities,
  preToolUseScript,
  RESUME_SESSION_PLACEHOLDER,
  resolveGrantValues,
  type GeneratedAgentConfig,
  type GeneratorPaths,
  type HookPolicy,
  scratchCacheEnv
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
  // The shell's rules matter only when the role has Claude's shell; a role that only reads gets none (Bash is denied).
  const hasShell = grants.tools.claude.Bash === 'allow'
  const shellAllow = hasShell ? grants.shell.allow : []
  const shellDeny = hasShell ? grants.shell.deny : []
  const hookPolicy: HookPolicy = {
    tools: grants.tools.claude,
    shellAllow,
    shellDeny,
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
      allow: [...builtinAllow, ...(shellDefaultAllow ? ['Bash'] : []), ...shellAllow, ...mcpAllow],
      deny: [...builtinDeny, ...shellDeny]
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
      vinaya_dev_tools: {
        type: 'stdio',
        command: paths.mcpCommand ?? 'vinaya-dev-bridge',
        args: [],
        timeout: DEV_TOOLS_TOOL_TIMEOUT_SEC * 1000
      }
    }
  }
  const launch = [
    'claude',
    '-p',
    // One JSON event per line, as the executor frames stdout and as the CLI's own Claude dispatch reads
    // it: the final `result` event carries the structured output and the session id.
    '--verbose',
    '--output-format',
    'stream-json',
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
  ]
  return {
    vendor: 'claude-code',
    launch,
    // `claude -p --resume <id>` continues that session, as the CLI's own Claude dispatch resumes its Developer.
    resumeLaunch: [
      launch[0] as string,
      launch[1] as string,
      '--resume',
      RESUME_SESSION_PLACEHOLDER,
      ...launch.slice(2)
    ],
    env: scratchCacheEnv(writableRoots, paths.variables),
    files: {
      'role-settings.json': JSON.stringify(settings, null, 2) + '\n',
      'role-mcp.json': JSON.stringify(mcp, null, 2) + '\n',
      'hooks/pre-tool-use.mjs': preToolUseScript(hookPolicy),
      'effective-capabilities.json': JSON.stringify(normalizedCapabilities(grants, 'claude'), null, 2) + '\n'
    },
    executableFiles: ['hooks/pre-tool-use.mjs']
  }
}
