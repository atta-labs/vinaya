import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEV_TOOLS_TOOL_TIMEOUT_SEC } from '@attalabs/aeg-types/dev-tools'
import { CLAUDE_CAPABILITY_TOOLS, claudeShellRule, claudeToolDecisions } from './claude-code/capabilities'
import { credentialDenyRead, credentialReadRules, generateClaudeSettings } from './claude-code/settings'
import {
  CODEX_CAPABILITY_TOOLS,
  CODEX_READ_ONLY_COMMANDS,
  CODEX_READ_ONLY_FORBIDDEN,
  codexSandbox,
  codexToolDecisions
} from './codex/capabilities'
import { CREDENTIAL_ENV_EXCLUDES, generateCodexConfig } from './codex/config'
import {
  CLAUDE_BUILTINS,
  CODEX_BUILTINS,
  loadRoleGrants,
  type RoleCapabilities,
  type RoleContract,
  resolveRoleGrants
} from './manifest'
import type { GeneratedAgentConfig } from './policy'

const NONE: RoleCapabilities = {
  read_files: 'deny',
  run_commands: 'deny',
  write_files: 'deny',
  network: [],
  web_fetch: 'deny',
  web_search: 'deny',
  subagents: 'deny',
  plan_tool: 'deny',
  view_image: 'deny'
}
const embeddedPolicy = (config: GeneratedAgentConfig): string =>
  /^const policy = (.+)$/m.exec(config.files['hooks/pre-tool-use.mjs'] as string)?.[1] ?? ''
const allowed = (decisions: Record<string, string>) =>
  Object.entries(decisions)
    .filter(([, d]) => d === 'allow')
    .map(([t]) => t)
    .sort()

describe('Claude mapping table', () => {
  test('no capability allows no built-in', () => {
    expect(allowed(claudeToolDecisions(NONE, false, CLAUDE_BUILTINS))).toEqual([])
  })
  const cases: Array<[string, Partial<RoleCapabilities>, readonly string[]]> = [
    ['read_files', { read_files: 'allow' }, CLAUDE_CAPABILITY_TOOLS.read_files],
    ['run_commands', { run_commands: { allow: [], deny: [] } }, CLAUDE_CAPABILITY_TOOLS.run_commands],
    ['write_files', { write_files: ['/w'] }, CLAUDE_CAPABILITY_TOOLS.write_files],
    ['plan_tool', { plan_tool: 'allow' }, CLAUDE_CAPABILITY_TOOLS.plan_tool],
    ['subagents', { subagents: 'allow' }, CLAUDE_CAPABILITY_TOOLS.subagents],
    ['web_fetch', { web_fetch: 'allow' }, ['WebFetch']],
    ['web_search', { web_search: 'allow' }, ['WebSearch']],
    ['view_image', { view_image: 'allow' }, []]
  ]
  for (const [name, caps, tools] of cases)
    test(`${name} allows exactly ${tools.join(', ') || 'nothing (Read covers images)'}`, () => {
      expect(allowed(claudeToolDecisions({ ...NONE, ...caps }, false, CLAUDE_BUILTINS))).toEqual([...tools].sort())
    })
  test('MCP tools allow ToolSearch, which loads their deferred schemas', () => {
    expect(allowed(claudeToolDecisions(NONE, true, CLAUDE_BUILTINS))).toEqual(['ToolSearch'])
  })
  test('every mapped name is a real Claude built-in', () => {
    for (const tools of Object.values(CLAUDE_CAPABILITY_TOOLS))
      for (const tool of tools) expect(CLAUDE_BUILTINS).toContain(tool)
  })
})

describe('Codex mapping table', () => {
  test('no capability allows no built-in, under a read-only sandbox', () => {
    expect(allowed(codexToolDecisions(NONE, CODEX_BUILTINS))).toEqual([])
    expect(codexSandbox(NONE)).toBe('read-only')
  })
  const cases: Array<[string, Partial<RoleCapabilities>, readonly string[]]> = [
    ['read_files', { read_files: 'allow' }, CODEX_CAPABILITY_TOOLS.read_files],
    ['run_commands', { run_commands: { allow: [], deny: [] } }, CODEX_CAPABILITY_TOOLS.run_commands],
    ['write_files', { write_files: ['/w'] }, CODEX_CAPABILITY_TOOLS.write_files],
    ['plan_tool', { plan_tool: 'allow' }, ['update_plan']],
    ['subagents', { subagents: 'allow' }, CODEX_CAPABILITY_TOOLS.subagents],
    ['web_fetch', { web_fetch: 'allow' }, ['web_fetch']],
    ['web_search', { web_search: 'allow' }, ['web_search']],
    ['view_image', { view_image: 'allow' }, ['view_image']]
  ]
  for (const [name, caps, tools] of cases)
    test(`${name} allows exactly ${tools.join(', ')}`, () => {
      expect(allowed(codexToolDecisions({ ...NONE, ...caps }, CODEX_BUILTINS))).toEqual([...tools].sort())
    })
  test('write_files picks the workspace-write sandbox with its roots; deny keeps it read-only', () => {
    expect(codexSandbox({ ...NONE, write_files: ['/w'] })).toBe('workspace-write')
    expect(codexSandbox({ ...NONE, write_files: 'deny' })).toBe('read-only')
  })
  test('send_input is never granted: no capability names it', () => {
    for (const tools of Object.values(CODEX_CAPABILITY_TOOLS)) expect(tools).not.toContain('send_input' as never)
  })
})

describe('a role that reads but does not run commands', () => {
  const contract: RoleContract = {
    role: 'code-reviewer',
    models: { claude: 'process-supplied', codex: 'process-supplied' },
    capabilities: { ...NONE, read_files: 'allow' },
    mcp_tools: {},
    hooks: {
      background_shell: true,
      force_push: true,
      no_verify: true,
      default_branch_commit: true,
      write_scope: true
    },
    sandbox: 'enabled'
  }
  test("gets Codex's reading-only commands and their forbidden floor, and no Claude shell", () => {
    const grants = resolveRoleGrants(contract)
    expect(grants.shell.allow).toEqual(CODEX_READ_ONLY_COMMANDS.map(claudeShellRule))
    expect(grants.shell.deny).toEqual(CODEX_READ_ONLY_FORBIDDEN.map(claudeShellRule))
    expect(grants.tools.claude.Bash).toBe('deny')
    expect(grants.sandbox.codex).toBe('read-only')
    expect(grants.writable_roots).toEqual([])
  })
})

describe('the developer before and after the capability contract', () => {
  const processRoot = join(import.meta.dir, '../../../processes/vinaya/executing')
  const before = JSON.parse(
    readFileSync(join(import.meta.dir, 'fixtures', 'developer-before-capability-contract.json'), 'utf8')
  ) as { claude: GeneratedAgentConfig; codex: GeneratedAgentConfig }
  const grants = loadRoleGrants(join(processRoot, 'developer', 'grants.yaml'))
  const paths = {
    generatedDir: '/gen/developer',
    outputSchemaPath: '/schema/developer.json',
    outputSchema: JSON.parse(readFileSync(join(processRoot, 'developer', 'output.schema.json'), 'utf8')),
    mcpCommand: '/bridge',
    variables: { WORKTREE: '/wt', SCRATCH: '/scratch', BUN_INSTALL_CACHE: '/bun', GIT_COMMON_DIR: '/git' }
  }
  const claude = generateClaudeSettings(grants, paths)
  const codex = generateCodexConfig(grants, paths)
  // Built-ins no capability maps, which the old grants allowed: denied now, by design.
  const NEWLY_DENIED = ['EndConversation', 'EnterWorktree', 'ExitWorktree']

  test('Codex: the same launch, environment, config, execpolicy and hook', () => {
    expect(codex.launch).toEqual(before.codex.launch)
    expect(codex.env).toEqual(before.codex.env)
    // Intended: the config now also keeps every credential-carrying variable out of the role's commands.
    const credentialEnv = [
      '[shell_environment_policy.filters]',
      ...CREDENTIAL_ENV_EXCLUDES.map((name) => `${JSON.stringify(name)} = "exclude"`),
      '',
      ''
    ].join('\n')
    expect(codex.files['config.toml']).toContain(credentialEnv)
    expect((codex.files['config.toml'] as string).replace(credentialEnv, '')).toBe(
      before.codex.files['config.toml'] as string
    )
    expect(codex.files['rules/role.rules']).toBe(before.codex.files['rules/role.rules'] as string)
    // The hook's code learned flag-anywhere rules; the policy it embeds is unchanged.
    expect(embeddedPolicy(codex)).toBe(embeddedPolicy(before.codex))
  })

  test('Claude: the same settings except the listed built-ins, now denied', () => {
    // Intended: Claude now prints JSON events (stream-json), so its session id and structured result are read.
    expect(claude.launch).toEqual([
      ...before.claude.launch.slice(0, 2),
      '--verbose',
      '--output-format',
      'stream-json',
      ...before.claude.launch.slice(2)
    ])
    const now = JSON.parse(claude.files['role-settings.json'] as string)
    const then = JSON.parse(before.claude.files['role-settings.json'] as string)
    expect(now.permissions.allow).toEqual(then.permissions.allow.filter((t: string) => !NEWLY_DENIED.includes(t)))
    // Intended: every credential route is denied to the sandboxed shell and to the Read tool.
    const denyRead = credentialDenyRead()
    expect(now.sandbox.filesystem.denyRead).toEqual(denyRead)
    const readRules = credentialReadRules(denyRead)
    expect(now.permissions.deny).toEqual(expect.arrayContaining(readRules))
    const deny = now.permissions.deny.filter((rule: string) => !readRules.includes(rule))
    expect([...deny].sort()).toEqual([...then.permissions.deny, ...NEWLY_DENIED].sort())
    const { denyRead: _denyRead, ...filesystem } = now.sandbox.filesystem
    expect({ ...now, permissions: null, sandbox: { ...now.sandbox, filesystem } }).toEqual({
      ...then,
      permissions: null
    })
    expect(claude.files['role-mcp.json']).toBe(before.claude.files['role-mcp.json'] as string)
    const policyNow = JSON.parse(embeddedPolicy(claude))
    const policyThen = JSON.parse(embeddedPolicy(before.claude))
    for (const tool of NEWLY_DENIED) policyThen.tools[tool] = 'deny'
    expect(policyNow).toEqual(policyThen)
  })

  test('both runners give the dev-tools server the shared per-call limit, so a long publish completes', () => {
    const toolTimeouts = [...(codex.files['config.toml'] as string).matchAll(/^tool_timeout_sec = (\d+)$/gm)]
    expect(toolTimeouts.map((m) => Number(m[1]))).toEqual([DEV_TOOLS_TOOL_TIMEOUT_SEC])
    const mcp = JSON.parse(claude.files['role-mcp.json'] as string)
    expect(mcp.mcpServers.vinaya_dev_tools.timeout).toBe(DEV_TOOLS_TOOL_TIMEOUT_SEC * 1000)
  })

  test('the effective capabilities are renamed, not changed', () => {
    for (const config of [claude, codex]) {
      const now = JSON.parse(config.files['effective-capabilities.json'] as string)
      expect([now.read_files, now.run_commands, now.write_files]).toEqual(['allow', 'allow', 'allow'])
    }
  })
})

describe('the capability probe', () => {
  test('still lists every built-in of each vendor for every role', () => {
    const run = Bun.spawnSync([process.execPath, join(import.meta.dir, 'probe.ts'), '--dry-run'])
    expect(run.exitCode).toBe(0)
    const lines = run.stdout
      .toString()
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { vendor: string; role: string; prompt: string })
    expect(lines).toHaveLength(6)
    for (const { vendor, prompt } of lines)
      for (const tool of vendor === 'claude-code' ? CLAUDE_BUILTINS : CODEX_BUILTINS)
        expect(prompt).toContain(`- ${tool}: invoke the ${tool} built-in`)
  })
})
