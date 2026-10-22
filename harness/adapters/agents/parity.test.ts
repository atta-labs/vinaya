import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateClaudeSettings } from './claude-code/settings'
import { generateCodexConfig } from './codex/config'
import { CLAUDE_BUILTINS, CODEX_BUILTINS, loadRoleGrants, mcpRule, ROLE_NAMES, type Decision } from './manifest'
import { resolveGrantValues, type GeneratedAgentConfig } from './policy'
import { evaluateShellGuards } from './shell-eval'

const processRoot = join(import.meta.dir, '../../../processes/vinaya/executing')

function generatedFile(config: GeneratedAgentConfig, path: string): string {
  const value = config.files[path]
  if (value === undefined) throw new Error(`missing generated file ${path}`)
  return value
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

function embeddedHookPolicy(config: GeneratedAgentConfig): { tools: Record<string, Decision> } {
  const script = generatedFile(config, 'hooks/pre-tool-use.mjs')
  const match = script.match(/^const policy = (.+)$/m)
  if (!match) throw new Error('generated hook has no embedded policy')
  return JSON.parse(match[1]!)
}

function claudeEffective(config: GeneratedAgentConfig): Record<string, Decision> {
  const settings = JSON.parse(generatedFile(config, 'role-settings.json'))
  const allow = new Set<string>(settings.permissions.allow)
  const deny = new Set<string>(settings.permissions.deny)
  return {
    shell: deny.has('Bash') ? 'deny' : [...allow].some((rule) => rule.startsWith('Bash(')) ? 'allow' : 'deny',
    write: allow.has('Write') && allow.has('Edit') ? 'allow' : 'deny',
    plan: allow.has('TodoWrite') ? 'allow' : 'deny',
    view_image: allow.has('Read') ? 'allow' : 'deny',
    web_fetch: allow.has('WebFetch') ? 'allow' : 'deny',
    web_search: allow.has('WebSearch') && !deny.has('WebSearch') ? 'allow' : 'deny',
    spawn_agent: allow.has('Agent') ? 'allow' : 'deny',
    send_input: allow.has('SendMessage') ? 'allow' : 'deny',
    resume_agent: allow.has('Agent') ? 'allow' : 'deny',
    wait_agent: allow.has('TaskOutput') ? 'allow' : 'deny',
    close_agent: allow.has('TaskStop') ? 'allow' : 'deny'
  }
}

function codexEffective(config: GeneratedAgentConfig): Record<string, Decision> {
  const toml = generatedFile(config, 'config.toml')
  const tools = embeddedHookPolicy(config).tools
  const decision = (name: string): Decision => {
    const value = tools[name]
    if (value === undefined) throw new Error(`missing hook decision for ${name}`)
    return value
  }
  return {
    shell: /shell_tool = true/.test(toml) ? 'allow' : 'deny',
    write: decision('apply_patch'),
    plan: decision('update_plan'),
    view_image: /view_image = true/.test(toml) ? 'allow' : 'deny',
    web_fetch: decision('web_fetch'),
    web_search: /web_search = "live"/.test(toml) && /web_search = true/.test(toml) ? 'allow' : 'deny',
    spawn_agent: decision('spawn_agent'),
    send_input: decision('send_input'),
    resume_agent: decision('resume_agent'),
    wait_agent: decision('wait_agent'),
    close_agent: decision('close_agent')
  }
}

function claudeBuiltins(config: GeneratedAgentConfig): Record<string, Decision> {
  const settings = JSON.parse(generatedFile(config, 'role-settings.json'))
  const allow = new Set<string>(settings.permissions.allow)
  const deny = new Set<string>(settings.permissions.deny)
  return Object.fromEntries(
    CLAUDE_BUILTINS.map((name) => [
      name,
      name === 'Bash'
        ? deny.has('Bash')
          ? 'deny'
          : [...allow].some((rule) => rule.startsWith('Bash('))
            ? 'allow'
            : 'deny'
        : allow.has(name) && !deny.has(name)
          ? 'allow'
          : 'deny'
    ])
  )
}

function codexBuiltins(config: GeneratedAgentConfig): Record<string, Decision> {
  const toml = generatedFile(config, 'config.toml')
  const hook = embeddedHookPolicy(config).tools
  const fromHook = (name: string): Decision => hook[name] ?? 'deny'
  return Object.fromEntries(
    CODEX_BUILTINS.map((name) => {
      if (name === 'exec_command' || name === 'write_stdin')
        return [name, /shell_tool = true/.test(toml) ? 'allow' : 'deny']
      if (name === 'view_image') return [name, /view_image = true/.test(toml) ? 'allow' : 'deny']
      if (name === 'web_search')
        return [name, /web_search = "live"/.test(toml) && /web_search = true/.test(toml) ? 'allow' : 'deny']
      if (
        ['spawn_agent', 'send_input', 'resume_agent', 'wait_agent', 'close_agent'].includes(name) &&
        !/multi_agent = true/.test(toml)
      )
        return [name, 'deny']
      return [name, fromHook(name)]
    })
  )
}

describe('role-grant vendor parity', () => {
  for (const role of ROLE_NAMES)
    test(role, () => {
      const grants = loadRoleGrants(join(processRoot, role, 'grants.yaml'))
      const schema = JSON.parse(readFileSync(join(processRoot, role, 'output.schema.json'), 'utf8'))
      const paths = {
        generatedDir: `/tmp/generated/${role}`,
        outputSchemaPath: join(processRoot, role, 'output.schema.json'),
        outputSchema: schema,
        variables: { WORKTREE: '/repo', SCRATCH: '/scratch', BUN_INSTALL_CACHE: '/bun', GIT_COMMON_DIR: '/git' }
      }
      const claude = generateClaudeSettings(grants, paths)
      const codex = generateCodexConfig(grants, paths)
      expect(codexEffective(codex)).toEqual(claudeEffective(claude))
      expect(claudeBuiltins(claude)).toEqual(grants.tools.claude)
      expect(codexBuiltins(codex)).toEqual(grants.tools.codex)

      const claudeSettings = JSON.parse(generatedFile(claude, 'role-settings.json'))
      // A bare Bash allow is only for a role whose grants make the shell's default allow.
      expect(claudeSettings.permissions.allow.includes('Bash')).toBe(grants.shell.default === 'allow')
      expect(claudeSettings.sandbox.network.allowedDomains).toEqual(grants.network_domains)
      expect(claudeSettings.sandbox.autoAllowBashIfSandboxed).toBe(false)
      expect(generatedFile(claude, 'hooks/pre-tool-use.mjs')).toContain('permissionDecision')
      expect(generatedFile(codex, 'hooks/pre-tool-use.mjs')).toContain('permissionDecision')
      expect(codex.launch).toContain('--dangerously-bypass-hook-trust')
      expect(generatedFile(codex, 'config.toml')).toContain(
        'matcher = "^(Bash|apply_patch|update_plan|view_image|web_fetch|spawn_agent|send_input|resume_agent|wait_agent|close_agent)$"'
      )
      expect(generatedFile(codex, 'config.toml')).toContain(`sandbox_mode = "${grants.sandbox.codex}"`)
      expect(claudeSettings.permissions.allow.filter((rule: string) => rule.startsWith('Bash('))).toEqual(
        grants.shell.allow
      )
      expect(claudeSettings.permissions.deny.filter((rule: string) => rule.startsWith('Bash('))).toEqual(
        [...(grants.tools.claude.Bash === 'deny' ? ['Bash'] : []), ...grants.shell.deny].filter((rule) =>
          rule.startsWith('Bash(')
        )
      )
      const policyLines = generatedFile(codex, 'rules/role.rules')
        .split('\n')
        .filter((line) => line.startsWith('prefix_rule('))
      expect(policyLines).toHaveLength(grants.shell.allow.length + grants.shell.deny.length)
      for (const rule of grants.shell.allow)
        expect(generatedFile(codex, 'rules/role.rules')).toContain(
          `pattern = ${JSON.stringify(
            rule
              .replace(/^Bash\(/, '')
              .replace(/(?::\*|\*)\)$/, '')
              .split(/\s+/)
          )}, decision = "allow"`
        )
      for (const rule of grants.shell.deny)
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
    const grants = loadRoleGrants(join(processRoot, 'developer/grants.yaml'))
    const schema = JSON.parse(readFileSync(join(processRoot, 'developer/output.schema.json'), 'utf8'))
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
    const grants = loadRoleGrants(join(processRoot, 'developer/grants.yaml'))
    const schema = JSON.parse(readFileSync(join(processRoot, 'developer/output.schema.json'), 'utf8'))
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

    const reviewer = loadRoleGrants(join(processRoot, 'code-reviewer/grants.yaml'))
    const reviewerConfig = generateCodexConfig(reviewer, paths)
    for (const tool of ['spawn_agent', 'send_input', 'resume_agent', 'wait_agent', 'close_agent']) {
      expect(invoke(reviewerConfig, { tool_name: tool, tool_input: {} })).toContain('"permissionDecision":"deny"')
    }
  })

  test('the Linux Unix-socket opt-in reaches the generated Claude sandbox only when asked for', () => {
    const grants = loadRoleGrants(join(processRoot, 'developer/grants.yaml'))
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
    const grants = loadRoleGrants(join(processRoot, 'developer/grants.yaml'))
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
    const rows = evaluateShellGuards()
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
    const grants = loadRoleGrants(join(processRoot, 'developer/grants.yaml'))
    const outputSchema = JSON.parse(readFileSync(join(processRoot, 'developer/output.schema.json'), 'utf8'))
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
      for (const [path, content] of Object.entries(config.files))
        if (path !== 'hooks/pre-tool-use.mjs') expect(content, `${config.vendor} ${path}`).not.toMatch(credential)
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
    const grants = loadRoleGrants(join(processRoot, 'developer/grants.yaml'))
    const outputSchemaPath = join(processRoot, 'developer/output.schema.json')
    const outputSchema = JSON.parse(readFileSync(outputSchemaPath, 'utf8'))
    const paths = { generatedDir: '/tmp/generated/developer', outputSchemaPath, outputSchema }
    const claude = generateClaudeSettings(grants, paths)
    const codex = generateCodexConfig(grants, paths)
    expect(claude.launch[claude.launch.indexOf('--json-schema') + 1]).toBe(JSON.stringify(outputSchema))
    expect(codex.launch[codex.launch.indexOf('--output-schema') + 1]).toBe(outputSchemaPath)
  })

  test('accounts for all eight known gaps', () => {
    expect(GAP_TABLE.map((gap) => gap.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(GAP_TABLE.every((gap) => gap.status === 'closed' || gap.status === 'stated')).toBe(true)
  })
})
