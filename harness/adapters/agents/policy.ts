import type { Decision, RoleGrants } from './manifest'

export interface GeneratedAgentConfig {
  vendor: 'claude-code' | 'codex'
  launch: string[]
  env: Record<string, string>
  files: Record<string, string>
  executableFiles: string[]
}

export interface GeneratorPaths {
  generatedDir: string
  outputSchemaPath: string
  outputSchema: Record<string, unknown>
  mcpCommand?: string
  variables?: Record<string, string>
}

export function resolveGrantValues(values: string[], variables: Record<string, string> = {}): string[] {
  return values.map((value) =>
    value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => variables[name] ?? `\${${name}}`)
  )
}

export interface HookPolicy {
  tools: Record<string, Decision>
  shellAllow: string[]
  shellDeny: string[]
  writableRoots: string[]
  guards: RoleGrants['hooks']
}

export function shellTokens(rule: string): string[] {
  return rule
    .replace(/^Bash\(/, '')
    .replace(/(?::\*|\*)\)$/, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Dependency-free handler shared by both vendors. It consumes their common
 * PreToolUse input/deny protocol and embeds the complete per-role policy.
 */
export function preToolUseScript(policy: HookPolicy): string {
  return `#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join, resolve, sep } from 'node:path'

const policy = ${JSON.stringify(policy)}
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
const tool = input.tool_name || input.toolName || ''
const args = input.tool_input || input.toolInput || {}
const command = String(args.command || '')
const cwd = resolve(String(input.cwd || process.cwd()))
const deny = (reason) => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason
  } }))
  process.exit(0)
}
const tokens = (rule) => rule.replace(/^Bash\\(/, '').replace(/(?::\\*|\\*)\\)$/, '').trim().split(/\\s+/)
const tokenize = (line) => {
  const statements = []
  let argv = []
  let word = ''
  let quote = null
  let escaped = false
  let started = false
  let background = false
  const pushWord = () => {
    if (started) argv.push(word)
    word = ''
    started = false
  }
  const pushStatement = () => {
    pushWord()
    if (argv.length) statements.push(argv)
    argv = []
  }
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (escaped) { word += char; escaped = false; started = true; continue }
    if (char === '\\\\' && quote !== "'") { escaped = true; started = true; continue }
    if (quote) {
      if (char === quote) quote = null
      else if (quote === '"' && (char === '\u0060' || (char === '$' && line[index + 1] === '('))) return null
      else word += char
      started = true
      continue
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue }
    if (char === '\u0060' || (char === '$' && line[index + 1] === '(')) return null
    if (char === '<' && line[index + 1] === '<') return null
    if (/\\s/.test(char)) {
      if (char === '\\n') pushStatement()
      else pushWord()
      continue
    }
    if (char === ';' || char === '|' || char === '&') {
      pushStatement()
      if (char === '&' && line[index + 1] !== '&') background = true
      if (line[index + 1] === char && (char === '|' || char === '&')) index += 1
      continue
    }
    word += char
    started = true
  }
  if (escaped || quote) return null
  pushStatement()
  if (statements.some((args) =>
    args[0] === 'eval' ||
    ((args[0] === 'sh' || args[0] === 'bash') && args[1] === '-c')
  )) return null
  return { statements, background }
}
const starts = (argv, prefix) => prefix.every((word, index) => argv[index] === word)
const commandBackgrounds = (parsed) => parsed.background || parsed.statements.some((argv) =>
  ['nohup', 'disown', 'setsid'].includes(argv[0])
)
const commandBypassesGitSafety = (parsed) => parsed.statements.some((argv) => {
  if (argv[0] !== 'git') return false
  if (argv[1] === 'push') return argv.slice(2).some((arg) =>
    arg === '-f' || arg === '--force' || arg === '--no-verify' ||
    arg === '--force-with-lease' || arg.startsWith('--force-with-lease=') ||
    (arg.startsWith('+') && arg.length > 1)
  )
  if (argv[1] === 'commit') return argv.slice(2).some((arg) =>
    arg === '--no-verify' || arg === '-n' || (/^-[A-Za-z]+$/.test(arg) && arg.slice(1).includes('n'))
  )
  return false
})
const git = (dir, argv) => {
  try { return execFileSync('git', ['-C', dir, ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() || null }
  catch { return null }
}
const commandTouchesDefaultBranch = (parsed) => {
  let dir = cwd
  for (const argv of parsed.statements) {
    if (argv[0] === 'cd' && argv.length === 2) { dir = resolve(dir, argv[1]); continue }
    if (argv[0] !== 'git' || !['commit', 'push'].includes(argv[1])) continue
    const current = git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    const remote = git(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
    const defaultBranch = remote?.startsWith('origin/') ? remote.slice('origin/'.length) : null
    if (current && defaultBranch && current === defaultBranch) return true
  }
  return false
}
const canonical = (raw) => {
  let cursor = resolve(cwd, raw)
  const tail = []
  while (!existsSync(cursor)) {
    const parent = dirname(cursor)
    if (parent === cursor) break
    tail.unshift(basename(cursor))
    cursor = parent
  }
  try { cursor = realpathSync(cursor) } catch {}
  return join(cursor, ...tail)
}
const inside = (path, root) => {
  const candidate = canonical(path)
  const boundary = canonical(root)
  return candidate === boundary || candidate.startsWith(boundary.endsWith(sep) ? boundary : boundary + sep)
}
const patchPaths = (patch) => {
  const found = []
  for (const line of String(patch).split(/\\r?\\n/)) {
    const match = /^\\*\\*\\* (?:Add|Update|Delete) File: (.+)$/.exec(line) || /^\\*\\*\\* Move to: (.+)$/.exec(line)
    if (match) found.push(match[1])
  }
  return found
}

if (policy.tools[tool] === 'deny') deny(tool + ' is denied by the role manifest')
if (tool === 'Bash') {
  const parsed = tokenize(command)
  if (!parsed) deny('shell command cannot be parsed safely')
  if (policy.guards.background_shell && (args.run_in_background === true || commandBackgrounds(parsed))) deny('background shell is denied')
  if (policy.guards.force_push && commandBypassesGitSafety(parsed)) deny('force push or verification bypass is denied')
  if (policy.guards.no_verify && commandBypassesGitSafety(parsed)) deny('force push or verification bypass is denied')
  if (policy.guards.default_branch_commit && commandTouchesDefaultBranch(parsed)) deny('commit or push on the default branch is denied')
  if (parsed.statements.some((argv) => policy.shellDeny.some((rule) => starts(argv, tokens(rule))))) deny('command matches a shell deny rule')
  if (parsed.statements.length === 0 || parsed.statements.some((argv) => !policy.shellAllow.some((rule) => starts(argv, tokens(rule))))) deny('command is outside the shell allowlist')
}
if (policy.guards.background_shell && ['Agent', 'Task'].includes(tool) && args.run_in_background === true) {
  deny('background subagent is denied')
}
if (policy.guards.write_scope && ['Write', 'Edit', 'NotebookEdit', 'apply_patch'].includes(tool)) {
  const paths = tool === 'apply_patch'
    ? patchPaths(command)
    : [args.file_path, args.path, args.notebook_path].filter(Boolean).map(String)
  if (paths.length === 0 || paths.some((path) => !policy.writableRoots.some((root) => inside(path, root)))) {
    deny('write is outside the writable roots')
  }
}
`
}

export function normalizedCapabilities(grants: RoleGrants, vendor: 'claude' | 'codex'): Record<string, Decision> {
  if (vendor === 'claude')
    return {
      shell: grants.tools.claude.Bash,
      write: grants.tools.claude.Write === 'allow' && grants.tools.claude.Edit === 'allow' ? 'allow' : 'deny',
      plan: grants.tools.claude.TodoWrite,
      view_image: grants.tools.claude.Read,
      web_fetch: grants.tools.claude.WebFetch,
      web_search: grants.tools.claude.WebSearch,
      spawn_agent: grants.tools.claude.Agent,
      send_input: grants.tools.claude.SendMessage,
      resume_agent: grants.tools.claude.Agent,
      wait_agent: grants.tools.claude.TaskOutput,
      close_agent: grants.tools.claude.TaskStop
    }
  return {
    shell: grants.tools.codex.exec_command,
    write: grants.tools.codex.apply_patch,
    plan: grants.tools.codex.update_plan,
    view_image: grants.tools.codex.view_image,
    web_fetch: grants.tools.codex.web_fetch,
    web_search: grants.tools.codex.web_search,
    spawn_agent: grants.tools.codex.spawn_agent,
    send_input: grants.tools.codex.send_input,
    resume_agent: grants.tools.codex.resume_agent,
    wait_agent: grants.tools.codex.wait_agent,
    close_agent: grants.tools.codex.close_agent
  }
}
