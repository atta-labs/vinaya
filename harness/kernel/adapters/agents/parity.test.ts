import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
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
import { type RoleCapabilities, type RoleContract, READ_ONLY_COMMANDS, resolveRoleGrants } from './manifest'
import { evaluateShellGuards } from '../../isolation/shell-eval'

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

  test('every shell bypass spelling is denied by both generated hooks for the guard itself', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shell-eval-grants-'))
    const grantsPath = join(directory, 'grants.yaml')
    const outputSchemaPath = join(directory, 'output.schema.json')
    writeFileSync(grantsPath, JSON.stringify(WRITER))
    writeFileSync(outputSchemaPath, '{}')
    const rows = evaluateShellGuards(grantsPath, outputSchemaPath)
    const attacks = rows.filter((row) => row.guard !== 'ordinary')
    expect(attacks.length).toBeGreaterThanOrEqual(100)
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
  }, 60_000)

  test('accounts for all eight known gaps', () => {
    expect(GAP_TABLE.map((gap) => gap.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(GAP_TABLE.every((gap) => gap.status === 'closed' || gap.status === 'stated')).toBe(true)
  })
})
