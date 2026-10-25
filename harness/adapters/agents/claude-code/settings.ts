import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
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

/**
 * The credential routes every role is denied, relative to the home directory: SSH keys, cloud and forge
 * tokens (the gh token store), the files a git `store` credential helper reads, the vendors' own logins, and
 * the system credential stores' files (the macOS Keychain directory, the Linux keyring).
 */
export const CREDENTIAL_HOME_ROUTES = [
  '.ssh',
  '.aws',
  '.config/gh',
  '.git-credentials',
  '.config/git/credentials',
  '.netrc',
  '.gnupg',
  '.codex/auth.json',
  '.claude/.credentials.json',
  'Library/Keychains',
  '.local/share/keyrings'
] as const

/**
 * The paths a role's sandbox may not read: each credential route under the real home directory, and the
 * directory holding the SSH agent's socket when the launching environment names one, so no role reaches the
 * agent even where Unix sockets are allowed (the Linux host opt-in).
 */
export function credentialDenyRead(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  // The launching environment's HOME is the home the role's commands see; the OS record answers without one.
  let home = env.HOME !== undefined && env.HOME !== '' ? env.HOME : homedir()
  try {
    home = realpathSync(home)
  } catch {
    // A home that cannot be resolved is named as given.
  }
  const agentSocket = env.SSH_AUTH_SOCK
  return [
    ...CREDENTIAL_HOME_ROUTES.map((route) => join(home, route)),
    ...(agentSocket !== undefined && agentSocket !== '' ? [dirname(agentSocket)] : [])
  ]
}

/** The Read tool's own deny rules for the same paths: the path itself and everything under it. */
export function credentialReadRules(denyRead: readonly string[]): string[] {
  return denyRead.flatMap((path) => [`Read(/${path})`, `Read(/${path}/**)`])
}

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
  const denyRead = credentialDenyRead()
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
      // The Read tool is held to the same credential denial as the sandboxed shell.
      deny: [...builtinDeny, ...shellDeny, ...credentialReadRules(denyRead)]
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
      filesystem: { allowWrite: writableRoots, denyRead }
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
