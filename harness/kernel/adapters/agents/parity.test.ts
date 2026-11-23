import { describe, expect, test } from 'bun:test'
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateClaudeSettings } from './claude-code/settings'
import { generateCodexConfig } from './codex/config'
import { claudeShellRule } from './claude-code/capabilities'
import {
  claudeEffective,
  claudeOffered,
  codexEffective,
  embeddedHookPolicy,
  generatedFile,
  offeredBeyondGrants
} from './fixtures/generated-capabilities'
import { type RoleCapabilities, type RoleContract, READ_ONLY_COMMANDS, resolveRoleGrants, withEffort } from './manifest'
import type { GeneratedAgentConfig } from '../../isolation/policy'
import { evaluateShellGuards } from '../../isolation/shell-eval'
import { ORDINARY_COMMANDS, SHELL_ATTACKS } from '../../isolation/shell-attacks'

// Every case here builds its grants from a contract it defines inline; a process proves its own grants files
// through these adapters in its own tests.

/** A contract that reads and runs no command: Claude reads with Read, Codex with its reading-only shell. */
const READER: RoleContract = {
  role: 'developer',
  models: { claude: 'process-supplied', codex: 'process-supplied' },
  capabilities: {
    read_files: 'allow',
    run_commands: 'deny',
    write_files: 'deny',
    network: ['example.com'],
    web_fetch: 'deny',
    web_search: 'deny',
    subagents: 'deny',
    plan_tool: 'allow',
    view_image: 'allow'
  },
  mcp_tools: { tools: ['read_source'] },
  hooks: { background_shell: true, force_push: true, no_verify: true, default_branch_commit: true, write_scope: true },
  sandbox: 'enabled'
}

/** A contract whose shell runs anything not denied and that writes its worktree and scratch directory. */
const WRITER: RoleContract = {
  ...READER,
  capabilities: {
    ...READER.capabilities,
    run_commands: { default: 'allow', allow: [], deny: ['git push', 'gh'] },
    write_files: ['${WORKTREE}', '${SCRATCH}'],
    subagents: 'allow'
  }
}

export const GAP_TABLE = [
  {
    id: 1,
    status: 'closed',
    reason:
      'every shell allow and deny is emitted as a Codex execpolicy prefix_rule and the hook denies commands outside the allowlist of a role whose shell default is not allow'
  },
  {
    id: 2,
    status: 'stated',
    reason:
      'generated Codex PreToolUse runs with the documented one-off trust bypass; hook errors fail open and hosted WebSearch is not hookable, so web_search, execpolicy, and sandbox remain the hard floor until the live probe proves firing'
  },
  { id: 3, status: 'closed', reason: 'explicit vendor WebSearch decisions generate disabled search on both adapters' },
  { id: 4, status: 'closed', reason: 'one per-role network domain list drives both generated allowlists' },
  { id: 5, status: 'closed', reason: 'Claude autoAllowBashIfSandboxed is false' },
  { id: 6, status: 'closed', reason: 'Claude receives one mcp__server__tool allow per catalog grant' },
  { id: 7, status: 'closed', reason: 'Claude launch limits settings sources so project Stop hooks are not loaded' },
  {
    id: 8,
    status: 'closed',
    reason: 'reviewer Codex sandboxes are read-only; attended unsandboxed runs remain outside scope'
  }
] as const
describe('the capability contract gives both vendors the same effective permissions', () => {
  const base: RoleContract = {
    role: 'developer',
    models: { claude: 'process-supplied', codex: 'process-supplied' },
    capabilities: {
      read_files: 'deny',
      run_commands: 'deny',
      write_files: 'deny',
      network: ['github.com'],
      web_fetch: 'deny',
      web_search: 'deny',
      subagents: 'deny',
      plan_tool: 'deny',
      view_image: 'deny'
    },
    mcp_tools: { vinaya_dev_tools: ['read_source'] },
    hooks: {
      background_shell: true,
      force_push: true,
      no_verify: true,
      default_branch_commit: true,
      write_scope: true
    },
    sandbox: 'enabled'
  }
  const paths = {
    generatedDir: '/tmp/generated/contract',
    outputSchemaPath: '/x.json',
    outputSchema: {},
    variables: { WORKTREE: '/repo' }
  }
  const runs = [
    'deny',
    { allow: ['Bash(make:*)'], deny: ['Bash(git push:*)'] },
    { default: 'allow', allow: [], deny: [] }
  ] as const
  const writes = ['deny', ['${WORKTREE}']] as const
  for (const read_files of ['allow', 'deny'] as const)
    for (const run_commands of runs)
      for (const write_files of writes)
        for (const toggle of ['allow', 'deny'] as const) {
          const capabilities = {
            ...base.capabilities,
            read_files,
            run_commands: run_commands as RoleCapabilities['run_commands'],
            write_files: write_files as RoleCapabilities['write_files'],
            web_fetch: toggle,
            web_search: toggle,
            subagents: toggle,
            plan_tool: toggle,
            // Claude reads images with Read, so the image capability follows reading on both.
            view_image: read_files
          }
          // Codex reads through its shell: a role that may run commands can read on both vendors.
          if (run_commands !== 'deny' && read_files === 'deny') continue
          test(`read ${read_files}, run ${JSON.stringify(run_commands)}, write ${JSON.stringify(write_files)}, others ${toggle}`, () => {
            const grants = resolveRoleGrants({ ...base, capabilities })
            const claude = claudeEffective(generateClaudeSettings(grants, paths))
            const codex = codexEffective(generateCodexConfig(grants, paths))
            expect(codex).toEqual(claude)
            expect(claude.read_files).toBe(read_files)
            expect(claude.run_commands).toBe(run_commands === 'deny' ? 'deny' : 'allow')
            expect(claude.write_files).toBe(write_files === 'deny' ? 'deny' : 'allow')
          })
        }
})

describe('a Claude launch offers only the built-ins its capabilities allow', () => {
  const contract = (
    capabilities: Partial<RoleCapabilities>,
    mcp_tools: Record<string, string[]> = {}
  ): RoleContract => ({
    role: 'developer',
    models: { claude: 'process-supplied', codex: 'process-supplied' },
    capabilities: {
      read_files: 'deny',
      run_commands: 'deny',
      write_files: 'deny',
      network: [],
      web_fetch: 'deny',
      web_search: 'deny',
      subagents: 'deny',
      plan_tool: 'deny',
      view_image: 'deny',
      ...capabilities
    },
    mcp_tools,
    hooks: {
      background_shell: true,
      force_push: true,
      no_verify: true,
      default_branch_commit: true,
      write_scope: true
    },
    sandbox: 'enabled'
  })
  const paths = { generatedDir: '/tmp/generated/offered', outputSchemaPath: '/x.json', outputSchema: {}, variables: {} }

  test('an empty set is --tools "", never the flag left out', () => {
    const claude = generateClaudeSettings(resolveRoleGrants(contract({})), paths)
    const at = claude.launch.indexOf('--tools')
    expect(at).toBeGreaterThan(0)
    expect(claude.launch[at + 1]).toBe('')
    expect(claudeOffered(claude)).toEqual([])
  })

  test('a capability set denying run_commands offers no Bash on Claude and only the read-only shell on Codex', () => {
    const grants = resolveRoleGrants(contract({ read_files: 'allow' }, { vinaya_dev_tools: ['fetch_documentation'] }))
    const claude = generateClaudeSettings(grants, paths)
    const codex = generateCodexConfig(grants, paths)
    expect(claudeOffered(claude)).not.toContain('Bash')
    expect(claudeOffered(claude)).toContain('Read')
    expect(claudeEffective(claude).run_commands).toBe('deny')
    expect(codexEffective(codex).read_files).toBe('allow')
    expect(codexEffective(codex).run_commands).toBe('deny')
    const policy = embeddedHookPolicy(codex) as unknown as { shellAllow: string[]; shellDefaultAllow?: boolean }
    expect(policy.shellAllow).toEqual(READ_ONLY_COMMANDS.map(claudeShellRule))
    expect(policy.shellDefaultAllow).not.toBe(true)
    expect(generatedFile(codex, 'config.toml')).toContain('sandbox_mode = "read-only"')
  })

  test('a launch offering a built-in its capabilities do not allow fails the check', () => {
    const grants = resolveRoleGrants(READER)
    const claude = generateClaudeSettings(grants, paths)
    const at = claude.launch.indexOf('--tools')
    const widened = {
      ...claude,
      launch: claude.launch.map((arg, i) => (i === at + 1 ? `${arg},Bash,DesignSync` : arg))
    }
    expect(offeredBeyondGrants(widened, grants)).toEqual(['Bash', 'DesignSync'])
    const unflagged = { ...claude, launch: claude.launch.filter((_, i) => i !== at && i !== at + 1) }
    expect(() => claudeOffered(unflagged)).toThrow(/default built-in set/)
  })
})

describe('the run effort reaches each vendor launch', () => {
  const paths = { generatedDir: '/tmp/generated/effort', outputSchemaPath: '/x.json', outputSchema: {}, variables: {} }
  const grants = resolveRoleGrants(READER)

  test('a Claude launch carries --effort on a first launch and a resume', () => {
    const claude = generateClaudeSettings(withEffort(grants, 'medium'), paths)
    for (const argv of [claude.launch, claude.resumeLaunch ?? []]) {
      const at = argv.indexOf('--effort')
      expect(at).toBeGreaterThan(0)
      expect(argv[at + 1]).toBe('medium')
    }
  })

  test('a Codex launch carries -c model_reasoning_effort before the final - on a first launch and a resume', () => {
    const codex = generateCodexConfig(withEffort(grants, 'medium'), paths)
    for (const argv of [codex.launch, codex.resumeLaunch ?? []]) {
      const at = argv.indexOf('model_reasoning_effort="medium"')
      expect(at).toBeGreaterThan(0)
      expect(argv[at - 1]).toBe('-c')
      expect(argv[argv.length - 1]).toBe('-')
      expect(at).toBeLessThan(argv.length - 1)
    }
    expect(generatedFile(codex, 'config.toml')).not.toContain('model_reasoning_effort')
  })

  test('a launch built with no effort carries none', () => {
    expect(generateClaudeSettings(grants, paths).launch).not.toContain('--effort')
    expect(generateCodexConfig(grants, paths).launch.join(' ')).not.toContain('model_reasoning_effort')
  })
})

describe('role-grant vendor parity', () => {
  test('a role that can read on one vendor but not the other fails the parity check', () => {
    const grants = resolveRoleGrants(READER)
    const broken = {
      ...grants,
      tools: { ...grants.tools, codex: { ...grants.tools.codex, exec_command: 'deny', write_stdin: 'deny' } }
    } as typeof grants
    const paths = { generatedDir: '/tmp/generated/x', outputSchemaPath: '/x.json', outputSchema: {}, variables: {} }
    expect(codexEffective(generateCodexConfig(broken, paths))).not.toEqual(
      claudeEffective(generateClaudeSettings(broken, paths))
    )
  })

  test('detects generated artifact divergence rather than comparing manifest input', () => {
    const grants = resolveRoleGrants(WRITER)
    const paths = {
      generatedDir: '/tmp/generated/writer',
      outputSchemaPath: 'output.schema.json',
      outputSchema: {},
      variables: { WORKTREE: '/repo', SCRATCH: '/scratch' }
    }
    const claude = generateClaudeSettings(grants, paths)
    const codex = generateCodexConfig(grants, paths)
    expect(codexEffective(codex)).toEqual(claudeEffective(claude))
    codex.files['config.toml'] = generatedFile(codex, 'config.toml').replace('shell_tool = true', 'shell_tool = false')
    expect(codexEffective(codex)).not.toEqual(claudeEffective(claude))
  })

  test('generated hooks deny a write outside scope, a symlink escape and a background subagent', () => {
    const grants = resolveRoleGrants(WRITER)
    const workspace = mkdtempSync(join(tmpdir(), 'generated-hook-'))
    const paths = {
      generatedDir: workspace,
      outputSchemaPath: 'output.schema.json',
      outputSchema: {},
      variables: { WORKTREE: workspace, SCRATCH: join(workspace, 'scratch') }
    }
    const invoke = (config: GeneratedAgentConfig, input: unknown) => {
      const hook = join(workspace, `${config.vendor}-pre-tool-use.mjs`)
      writeFileSync(hook, generatedFile(config, 'hooks/pre-tool-use.mjs'))
      return Bun.spawnSync(['node', hook], {
        cwd: workspace,
        stdin: Buffer.from(JSON.stringify(input))
      }).stdout.toString()
    }
    const claude = generateClaudeSettings(grants, paths)
    const codex = generateCodexConfig(grants, paths)
    const deny = '"permissionDecision":"deny"'
    expect(invoke(claude, { tool_name: 'Write', tool_input: { file_path: join(tmpdir(), 'outside') } })).toContain(deny)
    expect(invoke(claude, { tool_name: 'Write', tool_input: { file_path: join(workspace, 'inside') } })).toBe('')
    for (const tool of ['Agent', 'Task', 'Workflow'])
      expect(invoke(claude, { tool_name: tool, tool_input: { description: 'sweep', prompt: 'edit files' } })).toContain(
        deny
      )
    const patch = (path: string) => `*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch`
    expect(invoke(codex, { tool_name: 'apply_patch', tool_input: { command: patch(join(workspace, 'in.txt')) } })).toBe(
      ''
    )
    expect(
      invoke(codex, { tool_name: 'apply_patch', tool_input: { command: patch(join(tmpdir(), 'out.txt')) } })
    ).toContain(deny)
    symlinkSync(mkdtempSync(join(tmpdir(), 'generated-hook-outside-')), join(workspace, 'escape-link'))
    expect(
      invoke(codex, {
        tool_name: 'apply_patch',
        tool_input: { command: patch(join(workspace, 'escape-link', 'x.txt')) }
      })
    ).toContain(deny)
  })

  test('a shell defaulting to allow runs ordinary commands and names the rule or guard behind each refusal', () => {
    const grants = resolveRoleGrants(WRITER)
    const workspace = mkdtempSync(join(tmpdir(), 'generated-shell-'))
    const paths = {
      generatedDir: workspace,
      outputSchemaPath: 'o.json',
      outputSchema: {},
      variables: { WORKTREE: workspace }
    }
    const decide = (config: GeneratedAgentConfig, command: string): string => {
      const hook = join(workspace, `${config.vendor}-hook.mjs`)
      writeFileSync(hook, generatedFile(config, 'hooks/pre-tool-use.mjs'))
      const out = Bun.spawnSync(['node', hook], {
        cwd: workspace,
        stdin: Buffer.from(JSON.stringify({ tool_name: 'Bash', tool_input: { command } }))
      }).stdout.toString()
      return out === '' ? 'allow' : String(JSON.parse(out).hookSpecificOutput.permissionDecisionReason)
    }
    for (const config of [generateClaudeSettings(grants, paths), generateCodexConfig(grants, paths)]) {
      for (const command of ['pwd', 'ls -la', 'git status'])
        expect(decide(config, command), `${config.vendor} ${command}`).toBe('allow')
      expect(decide(config, 'git push origin task-branch')).toBe('command matches a shell deny rule')
      expect(decide(config, 'gh pr list')).toBe('command matches a shell deny rule')
      expect(decide(config, 'git commit -n -m x')).toBe('verification bypass is denied')
      expect(decide(config, 'sleep 100 &')).toBe('background shell is denied')
      expect(decide(config, 'sh -c "pwd"')).toBe('shell command cannot be proven safe')
    }
    const listed = { ...grants, shell: { allow: grants.shell.allow, deny: grants.shell.deny } }
    for (const config of [generateClaudeSettings(listed, paths), generateCodexConfig(listed, paths)])
      expect(decide(config, 'pwd')).toBe('command is outside the shell allowlist')
  })

  test('the Unix-socket opt-in, the output schema hand-off and the MCP and connector switches', () => {
    const grants = resolveRoleGrants(WRITER)
    const outputSchema = { type: 'object' }
    const paths = { generatedDir: '/tmp/generated/writer', outputSchemaPath: '/s.json', outputSchema, variables: {} }
    const network = (allowUnixSockets?: boolean) =>
      JSON.parse(generatedFile(generateClaudeSettings(grants, { ...paths, allowUnixSockets }), 'role-settings.json'))
        .sandbox.network
    expect(network(true).allowAllUnixSockets).toBe(true)
    expect(network(false)).not.toHaveProperty('allowAllUnixSockets')
    expect(network()).not.toHaveProperty('allowAllUnixSockets')
    const claude = generateClaudeSettings(grants, paths)
    const codex = generateCodexConfig(grants, paths)
    expect(claude.launch[claude.launch.indexOf('--json-schema') + 1]).toBe(JSON.stringify(outputSchema))
    expect(codex.launch[codex.launch.indexOf('--output-schema') + 1]).toBe('/s.json')
    expect(claude.launch.indexOf('--strict-mcp-config')).toBeGreaterThan(-1)
    expect(claude.launch.indexOf('--strict-mcp-config')).toBeLessThan(claude.launch.indexOf('--mcp-config'))
    expect(claude.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false')
    const toml = generatedFile(codex, 'config.toml')
    const features = (Bun.TOML.parse(toml) as { features: Record<string, unknown> }).features
    for (const key of ['apps', 'plugins', 'remote_plugin']) expect(features[key]).toBe(false)
  })

  test('the shell bypass rows number at least 100 attacks and some ordinary commands', () => {
    expect(SHELL_ATTACKS.length).toBeGreaterThanOrEqual(100)
    expect(ORDINARY_COMMANDS.length).toBeGreaterThan(0)
  })

  // Each case runs the generated hooks for one eighth of the rows; together the cases cover every row once.
  const SHELL_PARTS = 8
  for (let part = 0; part < SHELL_PARTS; part++)
    test(`shell bypass spellings are denied by both generated hooks for the guard itself, part ${part + 1} of ${SHELL_PARTS}`, () => {
      checkShellRows(part)
    }, 60_000)

  function checkShellRows(part: number) {
    const directory = mkdtempSync(join(tmpdir(), 'shell-eval-grants-'))
    const grantsPath = join(directory, 'grants.yaml')
    const outputSchemaPath = join(directory, 'output.schema.json')
    writeFileSync(grantsPath, JSON.stringify(WRITER))
    writeFileSync(outputSchemaPath, '{}')
    const rows = evaluateShellGuards(grantsPath, outputSchemaPath, { part, parts: SHELL_PARTS })
    expect(rows.length).toBeGreaterThan(0)
    const attacks = rows.filter((row) => row.guard !== 'ordinary')
    for (const row of attacks) {
      expect(row.claude, `Claude should deny ${JSON.stringify(row.command)}`).toBe('deny')
      expect(row.codex, `Codex should deny ${JSON.stringify(row.command)}`).toBe('deny')
      for (const reason of [row.claudeReason, row.codexReason])
        expect(reason, `${JSON.stringify(row.command)} must be stopped by a guard, not an allowlist`).not.toMatch(
          /allowlist|shell deny rule/
        )
    }
    for (const row of rows.filter((candidate) => candidate.guard === 'ordinary')) {
      expect(row.claude, `Claude should allow ${JSON.stringify(row.command)}`).toBe('allow')
      expect(row.codex, `Codex should allow ${JSON.stringify(row.command)}`).toBe('allow')
    }
  }

  test('accounts for all eight known gaps', () => {
    expect(GAP_TABLE.map((gap) => gap.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(GAP_TABLE.every((gap) => gap.status === 'closed' || gap.status === 'stated')).toBe(true)
  })
})
