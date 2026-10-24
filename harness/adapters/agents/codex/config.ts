import { join } from 'node:path'
import type { RoleGrants } from '../manifest'
import {
  normalizedCapabilities,
  preToolUseScript,
  RESUME_SESSION_PLACEHOLDER,
  resolveGrantValues,
  shellTokens,
  type GeneratedAgentConfig,
  type GeneratorPaths,
  type HookPolicy
} from '../policy'

const quote = (value: string): string => JSON.stringify(value)

export function generateCodexConfig(grants: RoleGrants, paths: GeneratorPaths): GeneratedAgentConfig {
  const hookPath = join(paths.generatedDir, 'hooks', 'pre-tool-use.mjs')
  const domainLines = grants.network_domains.map((domain) => `${quote(domain)} = "allow"`)
  const writableRoots = resolveGrantValues(grants.writable_roots, paths.variables)
  const writable = writableRoots.map(quote).join(', ')
  const mcpTools = Object.values(grants.tools.mcp).flat()
  const shellEnabled = grants.tools.codex.exec_command === 'allow' || grants.tools.codex.write_stdin === 'allow'
  const hookTools = {
    Bash: grants.tools.codex.exec_command,
    apply_patch: grants.tools.codex.apply_patch,
    update_plan: grants.tools.codex.update_plan,
    view_image: grants.tools.codex.view_image,
    web_fetch: grants.tools.codex.web_fetch,
    spawn_agent: grants.tools.codex.spawn_agent,
    send_input: grants.tools.codex.send_input,
    resume_agent: grants.tools.codex.resume_agent,
    wait_agent: grants.tools.codex.wait_agent,
    close_agent: grants.tools.codex.close_agent
  }
  const multiAgentEnabled = [
    grants.tools.codex.spawn_agent,
    grants.tools.codex.send_input,
    grants.tools.codex.resume_agent,
    grants.tools.codex.wait_agent,
    grants.tools.codex.close_agent
  ].some((decision) => decision === 'allow')
  const hookPolicy: HookPolicy = {
    tools: hookTools,
    shellAllow: grants.shell.allow,
    shellDeny: grants.shell.deny,
    shellDefaultAllow: grants.shell.default === 'allow',
    writableRoots,
    guards: grants.hooks
  }
  const configToml = [
    ...(grants.vendor.codex.model === 'process-supplied' ? [] : [`model = ${quote(grants.vendor.codex.model)}`]),
    `sandbox_mode = ${quote(grants.sandbox.codex)}`,
    `web_search = ${quote(grants.tools.codex.web_search === 'allow' ? 'live' : 'disabled')}`,
    '',
    '[features]',
    `shell_tool = ${shellEnabled}`,
    `multi_agent = ${multiAgentEnabled}`,
    'hooks = true',
    '',
    '[tools]',
    `web_search = ${grants.tools.codex.web_search === 'allow'}`,
    `view_image = ${grants.tools.codex.view_image === 'allow'}`,
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
    `command = ${quote(paths.mcpCommand ?? 'vinaya-dev-bridge')}`,
    'args = []',
    'tool_timeout_sec = 120',
    `enabled_tools = ${JSON.stringify(mcpTools)}`,
    'default_tools_approval_mode = "approve"',
    '',
    '[[hooks.PreToolUse]]',
    'matcher = "^(Bash|apply_patch|update_plan|view_image|web_fetch|spawn_agent|send_input|resume_agent|wait_agent|close_agent)$"',
    '',
    '[[hooks.PreToolUse.hooks]]',
    'type = "command"',
    `command = ${quote(`node ${JSON.stringify(hookPath)}`)}`,
    'timeout = 30',
    ''
  ].join('\n')
  const execpolicy = [
    ...grants.shell.allow.map(
      (rule) =>
        `prefix_rule(pattern = ${JSON.stringify(shellTokens(rule))}, decision = "allow", justification = "role grants allow")`
    ),
    // A rule with a flag anywhere after its prefix (`...`) is not a prefix; only the hook enforces it.
    ...grants.shell.deny
      .filter((rule) => !shellTokens(rule).includes('...'))
      .map(
        (rule) =>
          `prefix_rule(pattern = ${JSON.stringify(shellTokens(rule))}, decision = "forbidden", justification = "role grants deny")`
      ),
    ''
  ].join('\n')
  const launch = [
    'codex',
    'exec',
    '--dangerously-bypass-hook-trust',
    // A reviewer reads a staged copy that is not a git repository; Codex refuses such a directory without this.
    '--skip-git-repo-check',
    '--config',
    'approval_policy="never"',
    // JSONL events on stdout: the executor frames stdout as one JSON record per line, and Codex's plain
    // final message is not that. The structured final message is the last `agent_message` item
    // (`structuredResult` recovers it), as the CLI's own Codex dispatch reads it.
    '--json',
    '--output-schema',
    paths.outputSchemaPath,
    ...(grants.vendor.codex.model === 'process-supplied' ? [] : ['--model', grants.vendor.codex.model]),
    '-'
  ]
  return {
    vendor: 'codex',
    launch,
    // `codex exec resume <id> …` continues that thread, as the CLI's own Codex dispatch resumes its Developer.
    resumeLaunch: [launch[0] as string, launch[1] as string, 'resume', RESUME_SESSION_PLACEHOLDER, ...launch.slice(2)],
    env: { CODEX_HOME: paths.generatedDir },
    files: {
      'config.toml': configToml,
      'rules/role.rules': execpolicy,
      'hooks/pre-tool-use.mjs': preToolUseScript(hookPolicy),
      'effective-capabilities.json': JSON.stringify(normalizedCapabilities(grants, 'codex'), null, 2) + '\n'
    },
    executableFiles: ['hooks/pre-tool-use.mjs']
  }
}
