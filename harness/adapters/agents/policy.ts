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
  return String.raw`#!/usr/bin/env node
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
const tokens = (rule) => rule.replace(/^Bash\(/, '').replace(/(?::\*|\*)\)$/, '').trim().split(/\s+/)

// One shell-aware pass over the whole command line. Words carry a dynamic flag
// when the shell would expand them (variables, globs, braces, tilde), so their
// real value is unknowable here. Anything that cannot be tokenized with
// certainty returns null and is denied.
const BACKTICK = String.fromCharCode(96)
const tokenize = (line) => {
  const statements = []
  let argv = []
  let word = ''
  let quote = null
  let started = false
  let dynamic = false
  let background = false
  const pushWord = () => {
    if (started) argv.push({ text: word, dynamic })
    word = ''
    started = false
    dynamic = false
  }
  const pushStatement = () => {
    pushWord()
    if (argv.length) statements.push(argv)
    argv = []
  }
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    const next = line[index + 1]
    if (quote === "'") {
      if (char === "'") quote = null
      else word += char
      continue
    }
    if (char === '\\') {
      if (next === undefined) return null
      index += 1
      if (next === '\n') continue
      if (quote === '"' && !'$"\\'.includes(next) && next !== BACKTICK) word += char
      word += next
      started = true
      continue
    }
    if (quote === '"') {
      if (char === '"') quote = null
      else if (char === BACKTICK || (char === '$' && next === '(')) return null
      else {
        if (char === '$') dynamic = true
        word += char
      }
      continue
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue }
    if (char === BACKTICK) return null
    if ((char === '<' || char === '>') && next === '(') return null
    if (char === '<' && next === '<') return null
    if (char === '$') {
      if (next === '(') return null
      dynamic = true
      word += char
      started = true
      continue
    }
    if (char === '\n') { pushStatement(); continue }
    if (/\s/.test(char)) { pushWord(); continue }
    if (char === ';' || char === '(' || char === ')') { pushStatement(); continue }
    if (char === '&') {
      if (next === '>' || word.endsWith('>') || word.endsWith('<')) { word += char; started = true; continue }
      pushStatement()
      if (next === '&') index += 1
      else background = true
      continue
    }
    if (char === '|') {
      pushStatement()
      if (next === '|' || next === '&') index += 1
      continue
    }
    if (/[*?\[\]{}]/.test(char) || (char === '~' && !started)) dynamic = true
    word += char
    started = true
  }
  if (quote) return null
  pushStatement()
  return { statements, background }
}

const RESERVED = new Set(['!', '{', '}', 'if', 'then', 'elif', 'else', 'fi', 'while', 'until', 'do', 'done', 'time', 'coproc'])
const WRAPPERS = new Set(['command', 'builtin', 'exec', 'nohup', 'setsid', 'nice', 'ionice', 'stdbuf', 'timeout', 'sudo', 'doas', 'env'])
const BACKGROUNDERS = new Set(['nohup', 'disown', 'setsid', 'coproc', 'at', 'batch', 'screen', 'tmux', 'systemd-run', 'daemonize'])
const UNTRACEABLE = new Set(['alias', 'eval', 'source', '.', 'xargs', 'parallel', 'watch', 'trap', 'function'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh'])
const INTERPRETERS = new Set(['python', 'python3', 'node', 'deno', 'perl', 'ruby', 'php', 'osascript'])
const HARMLESS_MENTIONS = new Set(['echo', 'printf', 'grep', 'rg', 'cat', 'ls', 'which', 'type', 'man'])
const BRANCH_CHANGERS = new Set(['checkout', 'switch', 'symbolic-ref', 'update-ref', 'reset', 'rebase'])
const COMMIT_LIKE = new Set(['commit', 'merge', 'cherry-pick', 'revert', 'am', 'push'])
const UNSAFE_CONFIG = /^(alias\.|core\.hookspath|include|core\.fsmonitor|core\.pager|core\.editor|core\.sshcommand|sequence\.editor)/i
const base = (word) => word.split('/').pop()
const starts = (argv, prefix) => prefix.every((word, index) => argv[index] === word)
const git = (dir, argv) => {
  try { return execFileSync('git', ['-C', dir, ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() || null }
  catch { return null }
}
const defaultBranches = (dir) => {
  const remote = git(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  return remote && remote.startsWith('origin/') ? [remote.slice('origin/'.length)] : ['main', 'master']
}

// Returns the set of violations: no_verify, force_push, default_branch,
// background, unsafe (cannot be proven safe, so denied).
const analyze = (parsed) => {
  const found = new Set()
  if (parsed.background) found.add('background')
  let dirs = [cwd]
  let dirUnknown = false
  let branchUnknown = false
  for (const words of parsed.statements) {
    let index = 0
    for (;;) {
      const text = words[index]?.text
      if (text === undefined) break
      if (RESERVED.has(text)) { index += 1; continue }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) {
        if (/^GIT_/i.test(text)) found.add('unsafe')
        index += 1
        continue
      }
      if (WRAPPERS.has(base(text))) {
        if (BACKGROUNDERS.has(base(text))) found.add('background')
        index += 1
        while (words[index]?.text.startsWith('-')) {
          if (/^(-S|--split-string)/.test(words[index].text)) found.add('unsafe')
          index += 1
        }
        continue
      }
      break
    }
    const rest = words.slice(index)
    if (rest.length === 0) continue
    const argv = rest.map((word) => word.text)
    const head = base(argv[0])
    if (rest[0].dynamic) found.add('unsafe')
    if (BACKGROUNDERS.has(head)) found.add('background')
    if (UNTRACEABLE.has(head)) found.add('unsafe')
    if (head === 'find' && argv.some((arg) => /^-(exec|execdir|ok|okdir)$/.test(arg))) found.add('unsafe')
    if (SHELLS.has(head) && (argv.length === 1 || argv.slice(1).some((arg) => /^-[A-Za-z]*[cs]$/.test(arg) || arg === '--command'))) found.add('unsafe')
    if (INTERPRETERS.has(head) && argv.slice(1).some((arg) => /^(-[A-Za-z]*[cepEr]|--eval|--print)$/.test(arg))) found.add('unsafe')
    if (head === 'bun' && /^(-e|-p|--eval|--print)$/.test(argv[1] ?? '')) found.add('unsafe')
    if (['export', 'declare', 'typeset', 'readonly', 'local'].includes(head) && argv.some((arg) => /^GIT_/i.test(arg))) found.add('unsafe')
    if (head === 'cd' || head === 'pushd' || head === 'popd') {
      const target = argv.filter((arg, at) => at > 0 && !arg.startsWith('-') || arg === '-')[0]
      if (head !== 'cd' || target === undefined || target === '-' || rest.some((word) => word.dynamic)) dirUnknown = true
      else dirs = [...dirs, ...dirs.map((dir) => resolve(dir, target))]
      continue
    }
    if (head !== 'git') {
      if (!HARMLESS_MENTIONS.has(head) && argv.slice(1).some((arg) => base(arg) === 'git')) found.add('unsafe')
      continue
    }
    if (rest.some((word) => word.dynamic)) found.add('unsafe')
    let at = 1
    let scoped = dirs
    while (at < argv.length && argv[at].startsWith('-')) {
      const option = argv[at]
      if (option === '-C') { scoped = scoped.map((dir) => resolve(dir, argv[at + 1] ?? '')); at += 2; continue }
      if (option === '-c') {
        if (UNSAFE_CONFIG.test(argv[at + 1] ?? '')) found.add('unsafe')
        at += 2
        continue
      }
      if (/^--(git-dir|work-tree|exec-path|config-env|namespace|super-prefix)/.test(option)) found.add('unsafe')
      at += 1
    }
    const sub = argv[at]
    if (sub === undefined) continue
    const options = argv.slice(at + 1)
    if (options.some((arg) => /^--no-v/.test(arg))) found.add('no_verify')
    if (sub === 'commit') {
      for (const arg of options) {
        if (!/^-[^-]/.test(arg)) continue
        for (const letter of arg.slice(1)) {
          if (letter === 'n') { found.add('no_verify'); break }
          if ('mFCctSu'.includes(letter)) break
        }
      }
    }
    if (sub === 'push') {
      for (const arg of options) {
        if (/^--for/.test(arg) || (arg.startsWith('+') && arg.length > 1)) found.add('force_push')
        if (!/^-[^-]/.test(arg)) continue
        for (const letter of arg.slice(1)) {
          if (letter === 'f') { found.add('force_push'); break }
          if (letter === 'o') break
        }
      }
    }
    if (sub === 'config' && options.some((arg) => UNSAFE_CONFIG.test(arg))) found.add('unsafe')
    if (!['commit', 'push', 'config', 'status', 'diff', 'log', 'show', 'add', 'fetch', 'branch', 'worktree', ...BRANCH_CHANGERS, ...COMMIT_LIKE].includes(sub)) {
      if (scoped.some((dir) => git(dir, ['config', '--get', 'alias.' + sub]) !== null)) found.add('unsafe')
    }
    if (sub === 'branch' && options.some((arg) => /^(-[A-Za-z]*[mMcC]|--move|--copy)/.test(arg))) branchUnknown = true
    if (COMMIT_LIKE.has(sub)) {
      if (dirUnknown || branchUnknown) found.add('unsafe')
      for (const dir of scoped) {
        const current = git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
        const defaults = defaultBranches(dir)
        if (current && defaults.includes(current)) found.add('default_branch')
        if (sub === 'push') {
          const targets = options.filter((arg) => !arg.startsWith('-')).slice(1)
          for (const target of targets) {
            const destination = target.replace(/^\+/, '').split(':').pop().replace(/^refs\/heads\//, '')
            if (defaults.includes(destination)) found.add('default_branch')
          }
        }
      }
    }
    if (BRANCH_CHANGERS.has(sub)) branchUnknown = true
  }
  return found
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
  for (const line of String(patch).split(/\r?\n/)) {
    const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line) || /^\*\*\* Move to: (.+)$/.exec(line)
    if (match) found.push(match[1])
  }
  return found
}

if (policy.tools[tool] === 'deny') deny(tool + ' is denied by the role manifest')
if (tool === 'Bash') {
  const parsed = tokenize(command)
  if (!parsed) deny('shell command cannot be parsed safely')
  const found = analyze(parsed)
  const gitGuards = policy.guards.force_push || policy.guards.no_verify || policy.guards.default_branch_commit
  if (policy.guards.background_shell && (args.run_in_background === true || found.has('background'))) deny('background shell is denied')
  if (policy.guards.force_push && found.has('force_push')) deny('force push is denied')
  if (policy.guards.no_verify && found.has('no_verify')) deny('verification bypass is denied')
  if (policy.guards.default_branch_commit && found.has('default_branch')) deny('commit or push on the default branch is denied')
  if (gitGuards && found.has('unsafe')) deny('shell command cannot be proven safe')
  const statements = parsed.statements.map((words) => words.map((word) => word.text))
  if (statements.some((argv) => policy.shellDeny.some((rule) => starts(argv, tokens(rule))))) deny('command matches a shell deny rule')
  if (statements.length === 0 || statements.some((argv) => !policy.shellAllow.some((rule) => starts(argv, tokens(rule))))) deny('command is outside the shell allowlist')
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
