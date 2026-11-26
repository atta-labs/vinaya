import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadProcess } from '@harness/kernel/dev-process-socket/loader/load-process'
import {
  credentialDenyRead,
  credentialReadRules,
  generateClaudeSettings
} from '@harness/kernel/adapters/agents/claude-code/settings'
import { CREDENTIAL_ENV_EXCLUDES, generateCodexConfig } from '@harness/kernel/adapters/agents/codex/config'
import {
  claudeBuiltins,
  claudeEffective,
  claudeOffered,
  codexBuiltins,
  codexEffective,
  generatedFile,
  offeredBeyondGrants
} from '@harness/kernel/adapters/agents/fixtures/generated-capabilities'
import { CLAUDE_BUILTINS, loadRoleGrants, mcpRule } from '@harness/kernel/adapters/agents/manifest'
import { grantVariables } from '@harness/kernel/adapters/agents/variables'
import { resolveGrantValues, type GeneratedAgentConfig } from '@harness/kernel/isolation/policy'
import { evaluateShellGuards } from '@harness/kernel/isolation/shell-eval'

// Vinaya's own launched roles, run through the kernel's agent adapters: every role this process declares with a
// grants file and an output schema. The process folder is this file's own process, loaded as the harness loads it.
const vinaya = loadProcess(join(import.meta.dir, '../../..'))
const launched = Object.entries(vinaya.provided?.roles ?? {}).flatMap(([role, paths]) =>
  paths.grants !== undefined && paths.outputSchema !== undefined
    ? [{ role, grants: paths.grants, outputSchema: paths.outputSchema }]
    : []
)
const ROLES = launched.map(({ role }) => role)

function grantsPath(role: string): string {
  const found = launched.find((entry) => entry.role === role)
  if (!found) throw new Error(`Vinaya declares no launched role ${role}`)
  return found.grants
}

function schemaPath(role: string): string {
  const found = launched.find((entry) => entry.role === role)
  if (!found) throw new Error(`Vinaya declares no launched role ${role}`)
  return found.outputSchema
}

test('Vinaya launches its developer, both reviewers and the Plan reviewer, each with grants and an output schema', () => {
  expect(ROLES).toEqual(['developer', 'code-reviewer', 'security-reviewer', 'plan-reviewer'])
})

// ── The Plan reviewer: the evidence commands and nothing else ───────────────

describe('plan-reviewer: reads and searches by the listed commands, and refuses everything else on both vendors', () => {
  const grants = loadRoleGrants(grantsPath('plan-reviewer'))
  const workspace = mkdtempSync(join(tmpdir(), 'plan-reviewer-'))
  const paths = {
    generatedDir: workspace,
    outputSchemaPath: schemaPath('plan-reviewer'),
    outputSchema: JSON.parse(readFileSync(schemaPath('plan-reviewer'), 'utf8')),
    variables: { WORKTREE: workspace }
  }
  const configs: Record<'claude' | 'codex', GeneratedAgentConfig> = {
    claude: generateClaudeSettings(grants, paths),
    codex: generateCodexConfig(grants, paths)
  }
  const hookFor = (vendor: 'claude' | 'codex') => {
    const path = join(workspace, `${vendor}-hook.mjs`)
    writeFileSync(path, configs[vendor].files['hooks/pre-tool-use.mjs'] ?? '')
    return path
  }
  const hooks = { claude: hookFor('claude'), codex: hookFor('codex') }
  const decide = (vendor: 'claude' | 'codex', tool: string, input: Record<string, unknown>) => {
    const out = Bun.spawnSync(['node', hooks[vendor]], {
      cwd: workspace,
      stdin: Buffer.from(JSON.stringify({ tool_name: tool, tool_input: input }))
    }).stdout.toString()
    return out.includes('"permissionDecision":"deny"') ? 'deny' : 'allow'
  }

  test('no writable path, no network domain, no web tool, no subagent, no MCP tool', () => {
    const settings = JSON.parse(configs.claude.files['role-settings.json'] as string)
    expect(settings.sandbox.filesystem.allowWrite).toEqual([])
    expect(settings.sandbox.network.allowedDomains).toEqual([])
    for (const tool of ['Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'])
      expect(settings.permissions.deny).toContain(tool)
    expect(grants.tools.mcp).toEqual({})
    const toml = configs.codex.files['config.toml'] as string
    expect(toml).toContain('sandbox_mode = "read-only"')
    expect(JSON.parse(/writable_roots = (\[[^\n]*\])/.exec(toml)?.[1] ?? '[]')).toEqual([])
    expect(codexEffective(configs.codex).write_files).toBe('deny')
    expect(codexEffective(configs.codex).web_fetch).toBe('deny')
  })

  test('writing a file is refused on both vendors', () => {
    expect(decide('claude', 'Write', { file_path: join(workspace, 'x'), content: 'x' })).toBe('deny')
    expect(decide('claude', 'Edit', { file_path: join(workspace, 'x') })).toBe('deny')
    expect(
      decide('codex', 'apply_patch', {
        command: `*** Begin Patch\n*** Add File: ${join(workspace, 'x')}\n+x\n*** End Patch`
      })
    ).toBe('deny')
  })

  const OFF_LIST = [
    'bun test',
    'bun run build',
    'bun install',
    'npx tsc',
    'node script.js',
    'python3 -c 1',
    'curl https://example.com',
    'wget https://example.com',
    'gh pr view 1',
    'git push origin HEAD',
    'git commit -m x',
    'git checkout main',
    'touch file',
    'rm -rf x',
    'cat README.md',
    'find . -name x',
    'git show HEAD --output=/tmp/out',
    'git log -p --output /tmp/out',
    'git grep -O sh x',
    'rg --pre sh x',
    'rg --pre=sh x',
    'rg -z x',
    'rg --search-zip x',
    'rg --hostname-bin sh x',
    'rg --hostname-bin=sh x',
    'git grep -Osh x',
    'git grep --open-files-in-pager=sh x',
    'rg x > /tmp/out',
    'git show HEAD:a.ts | sh'
  ]
  for (const command of OFF_LIST)
    test(`refuses \`${command}\` on both vendors`, () => {
      expect(decide('claude', 'Bash', { command })).toBe('deny')
      expect(decide('codex', 'Bash', { command })).toBe('deny')
    })

  test('each listed evidence command runs on both vendors', () => {
    const listed = [
      'git show HEAD:src/a.ts',
      'git cat-file -p HEAD:src/a.ts',
      'git ls-tree -r HEAD',
      'git ls-files src',
      'git grep -n foo HEAD',
      'git log --oneline -5',
      'git diff HEAD~1 HEAD',
      'rg -n foo src',
      'grep -rn foo src',
      'ls -la'
    ]
    for (const vendor of ['claude', 'codex'] as const)
      expect(listed.filter((command) => decide(vendor, 'Bash', { command }) !== 'allow')).toEqual([])
  })
})

// ── Moved from the kernel's parity test ─────────────────────────────────────

describe('reviewers read on both vendors and write on neither', () => {
  for (const role of ['code-reviewer', 'security-reviewer'] as const)
    test(role, () => {
      const grants = loadRoleGrants(grantsPath(role))
      const schema = JSON.parse(readFileSync(schemaPath(role), 'utf8'))
      const paths = {
        generatedDir: `/tmp/generated/${role}`,
        outputSchemaPath: schemaPath(role),
        outputSchema: schema,
        variables: { WORKTREE: '/repo', SCRATCH: '/scratch', BUN_INSTALL_CACHE: '/bun', GIT_COMMON_DIR: '/git' }
      }
      const claude = generateClaudeSettings(grants, paths)
      const codex = generateCodexConfig(grants, paths)
      expect(claudeEffective(claude).read_files).toBe('allow')
      expect(codexEffective(codex).read_files).toBe('allow')
      // No write on either vendor: Claude has no Write/Edit and no writable path; Codex's sandbox is read-only,
      // with no writable root and no apply_patch.
      expect(claudeEffective(claude).write_files).toBe('deny')
      expect(JSON.parse(generatedFile(claude, 'role-settings.json')).sandbox.filesystem.allowWrite).toEqual([])
      const toml = generatedFile(codex, 'config.toml')
      expect(toml).toContain('sandbox_mode = "read-only"')
      expect(JSON.parse(/writable_roots = (\[[^\n]*\])/.exec(toml)?.[1] ?? '[]')).toEqual([])
      expect(codexEffective(codex).write_files).toBe('deny')
      // The review shell denies still bind the Codex reviewer.
      expect(generatedFile(codex, 'rules/role.rules')).toContain('pattern = ["git","push"], decision = "forbidden"')
    })

  test('a role that can read on one vendor but not the other fails the parity check', () => {
    const grants = loadRoleGrants(grantsPath('code-reviewer'))
    const broken = {
      ...grants,
      tools: { ...grants.tools, codex: { ...grants.tools.codex, exec_command: 'deny', write_stdin: 'deny' } }
    } as typeof grants
    const paths = { generatedDir: '/tmp/generated/x', outputSchemaPath: '/x.json', outputSchema: {}, variables: {} }
    expect(codexEffective(generateCodexConfig(broken, paths))).not.toEqual(
      claudeEffective(generateClaudeSettings(broken, paths))
    )
  })
})

describe('a Claude launch offers only the built-ins its capabilities allow', () => {
  const paths = { generatedDir: '/tmp/generated/offered', outputSchemaPath: '/x.json', outputSchema: {}, variables: {} }

  for (const role of ROLES)
    test(`${role}: --tools names exactly its allowed built-ins`, () => {
      const grants = loadRoleGrants(grantsPath(role))
      const claude = generateClaudeSettings(grants, paths)
      const allowedBuiltins = CLAUDE_BUILTINS.filter((name) => grants.tools.claude[name] === 'allow')
      expect(claudeOffered(claude)).toEqual([...allowedBuiltins])
      expect(offeredBeyondGrants(claude, grants)).toEqual([])
    })

  test('a launch offering a built-in its capabilities do not allow fails the check', () => {
    const grants = loadRoleGrants(grantsPath('code-reviewer'))
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
  for (const role of ROLES)
    test(role, () => {
      const grants = loadRoleGrants(grantsPath(role))
      const schema = JSON.parse(readFileSync(schemaPath(role), 'utf8'))
      const paths = {
        generatedDir: `/tmp/generated/${role}`,
        outputSchemaPath: schemaPath(role),
        outputSchema: schema,
        variables: { WORKTREE: '/repo', SCRATCH: '/scratch', BUN_INSTALL_CACHE: '/bun', GIT_COMMON_DIR: '/git' }
      }
      const claude = generateClaudeSettings(grants, paths)
      const codex = generateCodexConfig(grants, paths)
      expect(codexEffective(codex)).toEqual(claudeEffective(claude))
      expect(claudeBuiltins(claude)).toEqual(grants.tools.claude)
      expect(codexBuiltins(codex)).toEqual(grants.tools.codex)
      // Claude's launch names exactly the built-ins the role's capabilities allow.
      expect(claudeOffered(claude).sort()).toEqual(
        Object.entries(grants.tools.claude)
          .filter(([, decision]) => decision === 'allow')
          .map(([name]) => name)
          .sort()
      )
      expect(offeredBeyondGrants(claude, grants)).toEqual([])

      const claudeSettings = JSON.parse(generatedFile(claude, 'role-settings.json'))
      // A bare Bash allow is only for a role whose grants make the shell's default allow.
      expect(claudeSettings.permissions.allow.includes('Bash')).toBe(grants.shell.default === 'allow')
      expect(claudeSettings.sandbox.network.allowedDomains).toEqual(grants.network_domains)
      expect(claudeSettings.sandbox.autoAllowBashIfSandboxed).toBe(false)
      expect(generatedFile(claude, 'hooks/pre-tool-use.mjs')).toContain('permissionDecision')
      expect(generatedFile(codex, 'hooks/pre-tool-use.mjs')).toContain('permissionDecision')
      expect(codex.launch).toContain('--dangerously-bypass-hook-trust')
      expect(codex.launch).toContain('--json')
      expect(codex.launch).toContain('--skip-git-repo-check')
      expect(generatedFile(codex, 'config.toml')).toContain(
        'matcher = "^(Bash|apply_patch|update_plan|view_image|web_fetch|spawn_agent|send_input|resume_agent|wait_agent|close_agent)$"'
      )
      expect(generatedFile(codex, 'config.toml')).toContain(`sandbox_mode = "${grants.sandbox.codex}"`)
      // Claude gets the shell's allow rules only when it has the shell.
      expect(claudeSettings.permissions.allow.filter((rule: string) => rule.startsWith('Bash('))).toEqual(
        grants.tools.claude.Bash === 'allow' ? grants.shell.allow : []
      )
      // Claude gets the shell's deny rules only when it has the shell; otherwise Bash itself is denied.
      expect(claudeSettings.permissions.deny.filter((rule: string) => rule.startsWith('Bash('))).toEqual(
        grants.tools.claude.Bash === 'allow' ? grants.shell.deny : []
      )
      const policyLines = generatedFile(codex, 'rules/role.rules')
        .split('\n')
        .filter((line) => line.startsWith('prefix_rule('))
      // A flag-anywhere rule (\`...\`) is not a prefix, so only the hook enforces it.
      const prefixDenies = grants.shell.deny.filter((rule) => !rule.includes(' ... '))
      expect(policyLines).toHaveLength(grants.shell.allow.length + prefixDenies.length)
      for (const rule of grants.shell.allow)
        expect(generatedFile(codex, 'rules/role.rules')).toContain(
          `pattern = ${JSON.stringify(
            rule
              .replace(/^Bash\(/, '')
              .replace(/(?::\*|\*)\)$/, '')
              .split(/\s+/)
          )}, decision = "allow"`
        )
      for (const rule of prefixDenies)
        expect(generatedFile(codex, 'rules/role.rules')).toContain(
          `pattern = ${JSON.stringify(
            rule
              .replace(/^Bash\(/, '')
              .replace(/(?::\*|\*)\)$/, '')
              .split(/\s+/)
          )}, decision = "forbidden"`
        )
      const expectedMcp = Object.entries(grants.tools.mcp)
        .flatMap(([server, tools]) => tools.map((tool) => mcpRule(server, tool)))
        .sort()
      expect(claudeSettings.permissions.allow.filter((rule: string) => rule.startsWith('mcp__')).sort()).toEqual(
        expectedMcp
      )
      const enabledTools = /enabled_tools = (\[[^\n]+\])/.exec(generatedFile(codex, 'config.toml'))
      expect(JSON.parse(enabledTools?.[1] ?? '[]').sort()).toEqual(Object.values(grants.tools.mcp).flat().sort())
      const domains = [...generatedFile(codex, 'config.toml').matchAll(/^"([^"]+)" = "allow"$/gm)].map(
        (match) => match[1]
      )
      expect(domains).toEqual(grants.network_domains)
      const expectedRoots = resolveGrantValues(grants.writable_roots, paths.variables)
      expect(claudeSettings.sandbox.filesystem.allowWrite).toEqual(expectedRoots)
      const roots = /writable_roots = (\[[^\n]+\])/.exec(generatedFile(codex, 'config.toml'))
      expect(JSON.parse(roots?.[1] ?? '[]')).toEqual(expectedRoots)
      expect(JSON.parse(generatedFile(claude, 'effective-capabilities.json'))).toEqual(claudeEffective(claude))
      expect(JSON.parse(generatedFile(codex, 'effective-capabilities.json'))).toEqual(codexEffective(codex))
    })

  test('detects generated artifact divergence rather than comparing manifest input', () => {
    const grants = loadRoleGrants(grantsPath('developer'))
    const schema = JSON.parse(readFileSync(schemaPath('developer'), 'utf8'))
    const paths = {
      generatedDir: '/tmp/generated/developer',
      outputSchemaPath: 'output.schema.json',
      outputSchema: schema
    }
    const claude = generateClaudeSettings(grants, paths)
    const codex = generateCodexConfig(grants, paths)
    codex.files['config.toml'] = generatedFile(codex, 'config.toml').replace('shell_tool = true', 'shell_tool = false')
    expect(codexEffective(codex)).not.toEqual(claudeEffective(claude))
  })

  test('generated hook artifacts enforce shell and write guards', () => {
    const grants = loadRoleGrants(grantsPath('developer'))
    const schema = JSON.parse(readFileSync(schemaPath('developer'), 'utf8'))
    const workspace = mkdtempSync(join(tmpdir(), 'vinaya-generated-hook-'))
    const paths = {
      generatedDir: workspace,
      outputSchemaPath: 'output.schema.json',
      outputSchema: schema,
      variables: {
        WORKTREE: workspace,
        SCRATCH: join(workspace, 'scratch'),
        BUN_INSTALL_CACHE: '/bun',
        GIT_COMMON_DIR: '/git'
      }
    }
    const claude = generateClaudeSettings(grants, paths)
    const codex = generateCodexConfig(grants, paths)
    const invoke = (config: GeneratedAgentConfig, input: unknown) => {
      const hook = join(workspace, `${config.vendor}-pre-tool-use.mjs`)
      writeFileSync(hook, generatedFile(config, 'hooks/pre-tool-use.mjs'))
      return Bun.spawnSync(['node', hook], {
        cwd: (input as { cwd?: string }).cwd ?? workspace,
        stdin: Buffer.from(JSON.stringify(input))
      }).stdout.toString()
    }
    const shellGuardCases = [
      {
        name: 'write outside scope',
        input: { tool_name: 'Write', tool_input: { file_path: join(tmpdir(), 'outside') } },
        codexInput: {
          tool_name: 'apply_patch',
          tool_input: { command: `*** Begin Patch\n*** Add File: ${join(tmpdir(), 'outside.txt')}\n+no\n*** End Patch` }
        }
      }
    ]
    for (const guard of shellGuardCases) {
      expect(invoke(claude, guard.input), `Claude should deny ${guard.name}`).toContain('"permissionDecision":"deny"')
      expect(invoke(codex, guard.codexInput ?? guard.input), `Codex should deny ${guard.name}`).toContain(
        '"permissionDecision":"deny"'
      )
    }
    expect(invoke(claude, { tool_name: 'Agent', tool_input: { run_in_background: true } })).toContain(
      '"permissionDecision":"deny"'
    )
    // Claude Code launches a subagent asynchronously with no flag at all, and Workflow is always background.
    for (const tool of ['Agent', 'Task', 'Workflow']) {
      expect(invoke(claude, { tool_name: tool, tool_input: { description: 'sweep', prompt: 'edit files' } })).toContain(
        '"permissionDecision":"deny"'
      )
    }
    expect(invoke(claude, { tool_name: 'Bash', tool_input: { command: 'git status --short' } })).toBe('')
    expect(invoke(codex, { tool_name: 'Bash', tool_input: { command: 'git status --short' } })).toBe('')
    expect(invoke(claude, { tool_name: 'Bash', tool_input: { command: 'git commit -m "ordinary; message"' } })).toBe('')
    expect(invoke(codex, { tool_name: 'Bash', tool_input: { command: 'git commit -m "ordinary; message"' } })).toBe('')
    expect(invoke(claude, { tool_name: 'Write', tool_input: { file_path: join(workspace, 'inside') } })).toBe('')

    const insidePatch = `*** Begin Patch\n*** Add File: ${join(workspace, 'inside.txt')}\n+ok\n*** End Patch`
    const outsidePatch = `*** Begin Patch\n*** Add File: ${join(tmpdir(), 'outside.txt')}\n+no\n*** End Patch`
    expect(invoke(codex, { tool_name: 'apply_patch', tool_input: { command: insidePatch } })).toBe('')
    expect(invoke(codex, { tool_name: 'apply_patch', tool_input: { command: outsidePatch } })).toContain(
      '"permissionDecision":"deny"'
    )

    const outsideDir = mkdtempSync(join(tmpdir(), 'vinaya-hook-outside-'))
    symlinkSync(outsideDir, join(workspace, 'escape-link'))
    const symlinkPatch = `*** Begin Patch\n*** Add File: ${join(workspace, 'escape-link', 'escaped.txt')}\n+no\n*** End Patch`
    expect(invoke(codex, { tool_name: 'apply_patch', tool_input: { command: symlinkPatch } })).toContain(
      '"permissionDecision":"deny"'
    )
    expect(invoke(codex, { tool_name: 'send_input', tool_input: {} })).toContain('"permissionDecision":"deny"')
    expect(invoke(codex, { tool_name: 'spawn_agent', tool_input: {} })).toBe('')

    const reviewer = loadRoleGrants(grantsPath('code-reviewer'))
    const reviewerConfig = generateCodexConfig(reviewer, paths)
    for (const tool of ['spawn_agent', 'send_input', 'resume_agent', 'wait_agent', 'close_agent']) {
      expect(invoke(reviewerConfig, { tool_name: tool, tool_input: {} })).toContain('"permissionDecision":"deny"')
    }
  })

  test('the Linux Unix-socket opt-in reaches the generated Claude sandbox only when asked for', () => {
    const grants = loadRoleGrants(grantsPath('developer'))
    const base = { generatedDir: '/tmp/generated/developer', outputSchemaPath: 'output.schema.json', outputSchema: {} }
    const network = (allowUnixSockets?: boolean) =>
      JSON.parse(generatedFile(generateClaudeSettings(grants, { ...base, allowUnixSockets }), 'role-settings.json'))
        .sandbox.network
    expect(network(true).allowAllUnixSockets).toBe(true)
    expect(network(true).allowedDomains).toEqual(grants.network_domains)
    expect(network(false)).not.toHaveProperty('allowAllUnixSockets')
    expect(network()).not.toHaveProperty('allowAllUnixSockets')
  })

  test('the developer shell runs ordinary commands and refuses only the denied forms and the guards', () => {
    const grants = loadRoleGrants(grantsPath('developer'))
    const workspace = mkdtempSync(join(tmpdir(), 'vinaya-developer-shell-'))
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
      for (const command of ['pwd', 'ls -la', 'cat package.json', 'bun test', 'git status', 'grep -rn foo . | head'])
        expect(decide(config, command), `${config.vendor} ${command}`).toBe('allow')
      expect(decide(config, 'git push origin task-branch')).toBe('command matches a shell deny rule')
      expect(decide(config, 'gh pr list')).toBe('command matches a shell deny rule')
      expect(decide(config, 'rm -rf /tmp/x')).toBe('command matches a shell deny rule')
      expect(decide(config, 'git commit -n -m x')).toBe('verification bypass is denied')
      expect(decide(config, 'sleep 100 &')).toBe('background shell is denied')
      expect(decide(config, 'sh -c "pwd"')).toBe('shell command cannot be proven safe')
    }
    // A role without the default keeps its allowlist.
    const listed = { ...grants, shell: { allow: grants.shell.allow, deny: grants.shell.deny } }
    for (const config of [generateClaudeSettings(listed, paths), generateCodexConfig(listed, paths)])
      expect(decide(config, 'pwd')).toBe('command is outside the shell allowlist')
  })

  test('every shell bypass spelling is denied by both generated hooks for the guard itself', () => {
    const rows = evaluateShellGuards(grantsPath('developer'), schemaPath('developer'))
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

  test('developer boundary: no forge credential, git push and gh denied on both vendors', () => {
    const grants = loadRoleGrants(grantsPath('developer'))
    const outputSchema = JSON.parse(readFileSync(schemaPath('developer'), 'utf8'))
    const workspace = mkdtempSync(join(tmpdir(), 'vinaya-boundary-'))
    const paths = {
      generatedDir: workspace,
      outputSchemaPath: 'output.schema.json',
      outputSchema,
      variables: {
        WORKTREE: workspace,
        SCRATCH: join(workspace, 'scratch'),
        BUN_INSTALL_CACHE: '/bun',
        GIT_COMMON_DIR: join(workspace, '.git')
      }
    }
    const claude = generateClaudeSettings(grants, paths)
    const codex = generateCodexConfig(grants, paths)
    const credential =
      /(GH|GITHUB)_[A-Z_]*(TOKEN|KEY|SECRET|PAT)|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|GIT_ASKPASS|\.config\/gh/i
    for (const config of [claude, codex]) {
      expect(Object.keys(config.env).filter((name) => credential.test(name))).toEqual([])
      expect(Object.values(config.env).filter((value) => credential.test(value))).toEqual([])
      // A credential route may be named only to deny it: the sandbox's denyRead paths, the Read tool's deny
      // rules, and the variables Codex keeps out of the role's commands.
      const denials = [
        ...credentialDenyRead().map((path) => JSON.stringify(path)),
        ...credentialReadRules(credentialDenyRead()).map((rule) => JSON.stringify(rule)),
        ...CREDENTIAL_ENV_EXCLUDES.map((name) => `${JSON.stringify(name)} = "exclude"`)
      ]
      for (const [path, content] of Object.entries(config.files)) {
        if (path === 'hooks/pre-tool-use.mjs') continue
        const granted = denials.reduce((text, denial) => text.replaceAll(denial, ''), content)
        expect(granted, `${config.vendor} ${path}`).not.toMatch(credential)
      }
    }
    const settings = JSON.parse(generatedFile(claude, 'role-settings.json'))
    expect(settings.permissions.deny).toContain('Bash(git push:*)')
    expect(settings.permissions.deny).toContain('Bash(gh:*)')
    expect(settings.permissions.allow.filter((rule: string) => /git push|Bash\(gh/.test(rule))).toEqual([])
    const rules = generatedFile(codex, 'rules/role.rules')
    expect(rules).toContain('pattern = ["git","push"], decision = "forbidden"')
    expect(rules).toContain('pattern = ["gh"], decision = "forbidden"')
    expect(rules).not.toMatch(/pattern = \["(git","push|gh)"\], decision = "allow"/)

    for (const config of [claude, codex]) {
      const hook = join(workspace, `${config.vendor}-boundary-hook.mjs`)
      writeFileSync(hook, generatedFile(config, 'hooks/pre-tool-use.mjs'))
      for (const command of ['git push origin task/engine-harness-v1/3', 'git push', 'gh pr create', 'gh api user']) {
        const out = Bun.spawnSync(['node', hook], {
          cwd: workspace,
          stdin: Buffer.from(JSON.stringify({ tool_name: 'Bash', tool_input: { command } }))
        }).stdout.toString()
        expect(out, `${config.vendor} should deny ${command}`).toContain('"permissionDecision":"deny"')
      }
    }
  })

  test('Claude receives schema JSON while Codex receives the schema path', () => {
    const grants = loadRoleGrants(grantsPath('developer'))
    const outputSchemaPath = schemaPath('developer')
    const outputSchema = JSON.parse(readFileSync(outputSchemaPath, 'utf8'))
    const paths = { generatedDir: '/tmp/generated/developer', outputSchemaPath, outputSchema }
    const claude = generateClaudeSettings(grants, paths)
    const codex = generateCodexConfig(grants, paths)
    expect(claude.launch[claude.launch.indexOf('--json-schema') + 1]).toBe(JSON.stringify(outputSchema))
    expect(codex.launch[codex.launch.indexOf('--output-schema') + 1]).toBe(outputSchemaPath)
  })

  test('Codex turns off every account connector, and removing any switch is caught', () => {
    const grants = loadRoleGrants(grantsPath('developer'))
    const paths = {
      generatedDir: '/tmp/generated/developer',
      outputSchemaPath: '/s.json',
      outputSchema: {},
      variables: {}
    }
    const toml = generatedFile(generateCodexConfig(grants, paths), 'config.toml')
    const featuresOf = (text: string) => (Bun.TOML.parse(text) as { features: Record<string, unknown> }).features
    for (const key of ['apps', 'plugins', 'remote_plugin']) {
      expect(featuresOf(toml)[key]).toBe(false)
      // With the line removed Codex keeps its default (on), so the pin no longer holds.
      expect(toml).toContain(`${key} = false\n`)
      expect(featuresOf(toml.replace(`${key} = false\n`, ''))[key]).not.toBe(false)
    }
    expect(Object.keys((Bun.TOML.parse(toml) as { mcp_servers: object }).mcp_servers)).toEqual(['vinaya_dev_tools'])
  })

  test('Claude takes only the loop’s MCP config and switches its account connectors off', () => {
    const grants = loadRoleGrants(grantsPath('developer'))
    const paths = {
      generatedDir: '/tmp/generated/developer',
      outputSchemaPath: '/s.json',
      outputSchema: {},
      variables: {}
    }
    const claude = generateClaudeSettings(grants, paths)
    expect(claude.launch.indexOf('--strict-mcp-config')).toBeGreaterThan(-1)
    expect(claude.launch.indexOf('--strict-mcp-config')).toBeLessThan(claude.launch.indexOf('--mcp-config'))
    expect(Object.keys(JSON.parse(generatedFile(claude, 'role-mcp.json')).mcpServers)).toEqual(['vinaya_dev_tools'])
    expect(claude.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false')
  })
})

// ── Moved from the kernel test of a git command after cd ────────────────────

function repository(branch: 'main' | 'task'): string {
  const directory = mkdtempSync(join(tmpdir(), `vinaya-cd-${branch}-`))
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', '-C', directory, ...args])
    if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
  }
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'probe@example.invalid')
  git('config', 'user.name', 'Probe')
  writeFileSync(join(directory, 'tracked'), 'x')
  git('add', 'tracked')
  git('commit', '-q', '-m', 'initial')
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  if (branch === 'task') git('checkout', '-q', '-b', 'task')
  return directory
}

// A session started in the repository's main checkout changes into the task worktree before running git.
describe('a git command after `cd <worktree> &&` is judged in the worktree alone', () => {
  const main = repository('main')
  const task = repository('task')
  const grants = loadRoleGrants(grantsPath('developer'))
  const outputSchema = JSON.parse(readFileSync(schemaPath('developer'), 'utf8'))
  const paths = {
    generatedDir: task,
    outputSchemaPath: 'output.schema.json',
    outputSchema,
    variables: {
      WORKTREE: task,
      SCRATCH: join(task, 'scratch'),
      BUN_INSTALL_CACHE: '/bun',
      GIT_COMMON_DIR: join(task, '.git')
    }
  }
  for (const vendor of ['claude', 'codex'] as const) {
    const config = vendor === 'claude' ? generateClaudeSettings(grants, paths) : generateCodexConfig(grants, paths)
    const hook = join(task, `${vendor}-hook.mjs`)
    writeFileSync(hook, config.files['hooks/pre-tool-use.mjs'] ?? '')
    const decide = (command: string) =>
      Bun.spawnSync(['node', hook], {
        cwd: main,
        stdin: Buffer.from(JSON.stringify({ tool_name: 'Bash', cwd: main, tool_input: { command } }))
      }).stdout.toString()

    test(`${vendor}: \`cd <task> && git merge\` is not a default-branch operation`, () => {
      expect(decide(`cd ${task} && git merge --no-commit origin/main`)).not.toContain('on the default branch')
    })

    test(`${vendor}: \`cd <task>; git commit\` may still run on main, and is denied`, () => {
      expect(decide(`cd ${task}; git commit -m x`)).toContain('on the default branch')
    })
  }
})

describe('a role that writes its scratch directory keeps npm cache there', () => {
  const grants = loadRoleGrants(grantsPath('developer'))
  const paths = {
    generatedDir: '/gen',
    outputSchemaPath: 'x.json',
    outputSchema: {},
    variables: { WORKTREE: '/wt', SCRATCH: '/scratch', BUN_INSTALL_CACHE: '/bun', GIT_COMMON_DIR: '/git' }
  }
  test('both vendors launch the Developer with npm_config_cache in its scratch directory', () => {
    expect(generateClaudeSettings(grants, paths).env).toEqual({
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      npm_config_cache: '/scratch/npm-cache'
    })
    expect(generateCodexConfig(grants, paths).env.npm_config_cache).toBe('/scratch/npm-cache')
  })
  test('a reviewer, which writes nowhere, gets no cache setting', () => {
    const reviewer = loadRoleGrants(grantsPath('code-reviewer'))
    expect(generateClaudeSettings(reviewer, paths).env).toEqual({ ENABLE_CLAUDEAI_MCP_SERVERS: 'false' })
    expect(generateCodexConfig(reviewer, paths).env.npm_config_cache).toBeUndefined()
  })
})

// ── Moved from the kernel test of a read-only reviewer ──────────────────────

// A reviewer's shell is read-only twice over: by its sandbox (no writable path) and by its rules (reading
// commands only, their write-capable forms refused). These run the generated hooks, as the agents do.
const WRITE_FORMS = [
  'find . -name x -exec rm {} ;',
  'find . -execdir touch y ;',
  'find . -ok rm {} ;',
  'find . -delete',
  'find . -fprint /tmp/out',
  'find . -fprintf /tmp/out %p',
  'find . -fls /tmp/out',
  'git diff --output=/tmp/out',
  'git diff HEAD --output /tmp/out',
  'git diff --ext-diff',
  'git diff --textconv',
  'git log -p --output=/tmp/out',
  'git show HEAD --ext-diff',
  'git -c core.pager=touch status',
  'sed -n -i s/a/b/ file',
  'sed -n --in-place s/a/b/ file',
  'sed -n -Ei s/a/b/ file',
  'sed -n 1w/tmp/x file',
  "sed -n '1e touch y' file",
  'sed -n 1,20p file',
  'cat README.md > /tmp/x',
  'cat a >/tmp/x',
  'tail -n1 f >> /tmp/out',
  'grep -r x . > /tmp/out',
  '(cat a > b)',
  'cat a &> /tmp/out',
  'cat a 2> /tmp/err',
  "rg --pre 'sh -c touch' x",
  'git push origin HEAD',
  'gh pr comment 1 -b x',
  'touch file',
  'echo x > file'
]
const READS = [
  'cat README.md',
  'rg -n foo src',
  'git diff HEAD~1',
  'find . -name "*.ts"',
  'head -n 20 file',
  'ls -la',
  // Not a file write: a descriptor duplication, the null device, a quoted '>'.
  'rg -n foo src 2>&1',
  'cat a 2>/dev/null',
  "grep -n '>' file"
]

for (const role of ['code-reviewer', 'security-reviewer'] as const) {
  const grants = loadRoleGrants(grantsPath(role))
  const workspace = mkdtempSync(join(tmpdir(), `reviewer-${role}-`))
  const paths = {
    generatedDir: workspace,
    outputSchemaPath: schemaPath(role),
    outputSchema: JSON.parse(readFileSync(schemaPath(role), 'utf8')),
    variables: { WORKTREE: workspace }
  }
  const configs: Record<'claude' | 'codex', GeneratedAgentConfig> = {
    claude: generateClaudeSettings(grants, paths),
    codex: generateCodexConfig(grants, paths)
  }
  const hookPath = (vendor: 'claude' | 'codex') => {
    const path = join(workspace, `${vendor}-hook.mjs`)
    writeFileSync(path, configs[vendor].files['hooks/pre-tool-use.mjs'] ?? '')
    return path
  }
  const hooks = { claude: hookPath('claude'), codex: hookPath('codex') }
  const decide = (vendor: 'claude' | 'codex', tool: string, input: Record<string, unknown>) => {
    const out = Bun.spawnSync(['node', hooks[vendor]], {
      cwd: workspace,
      stdin: Buffer.from(JSON.stringify({ tool_name: tool, tool_input: input }))
    }).stdout.toString()
    return out.includes('"permissionDecision":"deny"') ? 'deny' : 'allow'
  }

  describe(`${role}: read-only by sandbox and by rules`, () => {
    test('no vendor sandbox has a writable path, and no write tool is granted', () => {
      const settings = JSON.parse(configs.claude.files['role-settings.json'] as string)
      expect(settings.sandbox.enabled).toBe(true)
      expect(settings.sandbox.filesystem.allowWrite).toEqual([])
      for (const tool of ['Write', 'Edit', 'NotebookEdit', 'Bash']) expect(settings.permissions.deny).toContain(tool)
      const toml = configs.codex.files['config.toml'] as string
      expect(toml).toContain('sandbox_mode = "read-only"')
      expect(toml).toContain('writable_roots = []')
      expect(grants.tools.codex.apply_patch).toBe('deny')
    })

    test('writing a file through the write tools is refused on both vendors', () => {
      expect(decide('claude', 'Write', { file_path: join(workspace, 'x'), content: 'x' })).toBe('deny')
      expect(decide('claude', 'Edit', { file_path: join(workspace, 'x') })).toBe('deny')
      expect(
        decide('codex', 'apply_patch', {
          command: `*** Begin Patch\n*** Add File: ${join(workspace, 'x')}\n+x\n*** End Patch`
        })
      ).toBe('deny')
    })

    for (const command of WRITE_FORMS)
      test(`refuses \`${command}\` on both vendors`, () => {
        expect(decide('claude', 'Bash', { command })).toBe('deny')
        expect(decide('codex', 'Bash', { command })).toBe('deny')
      })

    test("the Codex reviewer's reading commands still run", () => {
      expect(READS.filter((command) => decide('codex', 'Bash', { command }) !== 'allow')).toEqual([])
    })
  })
}

// ── Moved from the kernel test of grant variables ───────────────────────────

test('developer configs resolve the exact linked git dir only after worktree creation', () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'grant-linked-')))
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', [
    '-C',
    repo,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--allow-empty',
    '-qm',
    'init'
  ])
  const worktree = join(repo, 'task')
  const runDir = join(repo, 'run')
  const grants = loadRoleGrants(grantsPath('developer'))
  const paths = {
    outputSchema: {},
    generatedDir: runDir,
    outputSchemaPath: join(runDir, 'schema.json'),
    variables: grantVariables(worktree, runDir, repo)
  }
  const before = generateCodexConfig(grants, paths).files['config.toml']!
  expect(before).not.toContain('${GIT_DIR}')
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-qb', 'task', worktree])
  paths.variables = grantVariables(worktree, runDir, repo)
  const gitDir = realpathSync(
    execFileSync('git', ['-C', worktree, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim()
  )
  expect(paths.variables.GIT_DIR).toBe(gitDir)
  const config = generateCodexConfig(grants, paths).files['config.toml']!
  expect(JSON.parse(/writable_roots = (\[[^\n]*\])/.exec(config)![1]!)).toContain(gitDir)
  const claude = JSON.parse(generateClaudeSettings(grants, paths).files['role-settings.json']!)
  expect(claude.sandbox.filesystem.allowWrite).toContain(gitDir)
})
