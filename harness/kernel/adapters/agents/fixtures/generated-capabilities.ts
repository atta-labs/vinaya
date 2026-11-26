// Readers the parity tests use to derive, from a generated Claude or Codex configuration alone, what a role can
// effectively do on that vendor. The kernel's parity test applies them to grants it defines inline; a process
// applies them to its own grants files.
import type { GeneratedAgentConfig } from '@harness/kernel/isolation/policy'
import { claudeShellRule } from '../claude-code/capabilities'
import { CODEX_READ_ONLY_COMMANDS } from '../codex/capabilities'
import { CLAUDE_BUILTINS, CODEX_BUILTINS, type Decision, type RoleGrants } from '../manifest'

export function generatedFile(config: GeneratedAgentConfig, path: string): string {
  const value = config.files[path]
  if (value === undefined) throw new Error(`missing generated file ${path}`)
  return value
}

export function embeddedHookPolicy(config: GeneratedAgentConfig): { tools: Record<string, Decision> } {
  const script = generatedFile(config, 'hooks/pre-tool-use.mjs')
  const match = script.match(/^const policy = (.+)$/m)
  if (!match) throw new Error('generated hook has no embedded policy')
  return JSON.parse(match[1]!)
}

export function claudeEffective(config: GeneratedAgentConfig): Record<string, Decision> {
  const settings = JSON.parse(generatedFile(config, 'role-settings.json'))
  // A built-in the launch does not offer is unusable whatever the settings allow.
  const offered = new Set(claudeOffered(config))
  const allow = new Set<string>(
    (settings.permissions.allow as string[]).filter(
      (rule) => rule.startsWith('mcp__') || offered.has(rule.replace(/\(.*$/, ''))
    )
  )
  const deny = new Set<string>(settings.permissions.deny)
  return {
    // Claude reads files with Read (Grep and Glob alongside it).
    read_files: allow.has('Read') && !deny.has('Read') ? 'allow' : 'deny',
    run_commands: deny.has('Bash')
      ? 'deny'
      : [...allow].some((rule) => rule === 'Bash' || rule.startsWith('Bash('))
        ? 'allow'
        : 'deny',
    write_files:
      allow.has('Write') && allow.has('Edit') && settings.sandbox.filesystem.allowWrite.length > 0 ? 'allow' : 'deny',
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

export function codexEffective(config: GeneratedAgentConfig): Record<string, Decision> {
  const toml = generatedFile(config, 'config.toml')
  const tools = embeddedHookPolicy(config).tools
  const decision = (name: string): Decision => {
    const value = tools[name]
    if (value === undefined) throw new Error(`missing hook decision for ${name}`)
    return value
  }
  const shellTool = /shell_tool = true/.test(toml)
  const policy = embeddedHookPolicy(config) as unknown as { shellAllow: string[]; shellDefaultAllow?: boolean }
  const readingOnly = new Set<string>(CODEX_READ_ONLY_COMMANDS.map(claudeShellRule))
  const roots = JSON.parse(/writable_roots = (\[[^\n]*\])/.exec(toml)?.[1] ?? '[]') as string[]
  return {
    // Codex reads files only through its shell, under any sandbox.
    read_files: shellTool ? 'allow' : 'deny',
    // It runs commands when its shell may run more than the reading-only commands.
    run_commands:
      shellTool && (policy.shellDefaultAllow === true || policy.shellAllow.some((rule) => !readingOnly.has(rule)))
        ? 'allow'
        : 'deny',
    write_files:
      decision('apply_patch') === 'allow' && /sandbox_mode = "workspace-write"/.test(toml) && roots.length > 0
        ? 'allow'
        : 'deny',
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

/** The built-ins a Claude launch offers: the names its `--tools` flag lists. A launch without the flag offers the default set. */
export function claudeOffered(config: GeneratedAgentConfig): string[] {
  const at = config.launch.indexOf('--tools')
  if (at < 0) throw new Error('the Claude launch offers the default built-in set: it names no --tools')
  const value = config.launch[at + 1]
  if (value === undefined) throw new Error('--tools has no value')
  return value === '' ? [] : value.split(',')
}

/** The built-ins a Claude launch offers that its grants do not allow. */
export function offeredBeyondGrants(config: GeneratedAgentConfig, grants: RoleGrants): string[] {
  return claudeOffered(config).filter(
    (name) => (grants.tools.claude as Record<string, Decision | undefined>)[name] !== 'allow'
  )
}

export function claudeBuiltins(config: GeneratedAgentConfig): Record<string, Decision> {
  const settings = JSON.parse(generatedFile(config, 'role-settings.json'))
  const allow = new Set<string>(settings.permissions.allow)
  const deny = new Set<string>(settings.permissions.deny)
  const offered = new Set(claudeOffered(config))
  return Object.fromEntries(
    CLAUDE_BUILTINS.map((name) => [
      name,
      !offered.has(name)
        ? 'deny'
        : name === 'Bash'
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

export function codexBuiltins(config: GeneratedAgentConfig): Record<string, Decision> {
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
