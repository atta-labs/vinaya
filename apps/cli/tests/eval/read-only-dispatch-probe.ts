/**
 * The read-only dispatch probe: one read-only Claude reviewer turn, run
 * through `dispatchRole` on a throwaway worktree, asked to run three
 * commands — a write into the worktree, a write into the bun install cache,
 * and a read of the worktree's history. It prints, from the turn's own
 * transcript, each command's exit status and the `mcp__` tools the session's
 * init event lists, then whether either write left a file behind.
 *
 * A read-only turn holds: both `touch` commands fail, `git log -1` exits 0,
 * and the init event lists no `mcp__` tool. It calls a real model, so only the
 * Principal runs it, on a host where Claude Code is logged in:
 *
 *     bun apps/cli/tests/eval/read-only-dispatch-probe.ts [--model <model>]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dispatchRole } from '../../src/lib/dispatch'
import { resolveBunInstallCacheDir } from '../../src/lib/worker-boundary'

/** The file each `touch` command tries to create. */
export const PROBE_FILE_NAME = 'read-only-probe-x'

export const PROBE_COMMANDS = (worktree: string): readonly string[] => [
  `touch ${JSON.stringify(join(worktree, PROBE_FILE_NAME))}`,
  `touch "$(bun pm cache)/${PROBE_FILE_NAME}"`,
  'git log -1'
]

export type ProbeCommandResult = { command: string; exitStatus: number | 'not run' }

/**
 * Each probe command's exit status, read from Claude Code's `stream-json`
 * transcript: the `Bash` tool call that ran it and its tool result. A failed
 * command's result carries `Exit code <n>`; a result marked as an error with
 * no code (a sandbox refusal) reads as 1; a command the turn never ran reads
 * as `not run`.
 */
export function commandResults(transcript: readonly string[], commands: readonly string[]): ProbeCommandResult[] {
  const commandById = new Map<string, string>()
  const resultById = new Map<string, { isError: boolean; text: string }>()
  for (const line of transcript) {
    let event: { type?: string; message?: { content?: unknown } }
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const content = Array.isArray(event.message?.content) ? event.message.content : []
    for (const block of content as Array<Record<string, unknown>>) {
      if (event.type === 'assistant' && block.type === 'tool_use' && block.name === 'Bash') {
        const input = block.input as { command?: unknown } | undefined
        commandById.set(String(block.id), String(input?.command ?? ''))
      }
      if (event.type === 'user' && block.type === 'tool_result') {
        const text = Array.isArray(block.content)
          ? (block.content as Array<{ text?: unknown }>).map((part) => String(part.text ?? '')).join('\n')
          : String(block.content ?? '')
        resultById.set(String(block.tool_use_id), { isError: block.is_error === true, text })
      }
    }
  }
  return commands.map((command) => {
    const id = [...commandById].find(([, ran]) => ran.includes(command))?.[0]
    const result = id === undefined ? undefined : resultById.get(id)
    if (result === undefined) return { command, exitStatus: 'not run' }
    const code = /Exit code (\d+)/.exec(result.text)
    return { command, exitStatus: code !== null ? Number(code[1]) : result.isError ? 1 : 0 }
  })
}

/** The `mcp__` tools the session's `system/init` event lists. */
export function initMcpTools(transcript: readonly string[]): string[] {
  for (const line of transcript) {
    try {
      const event = JSON.parse(line) as { type?: string; subtype?: string; tools?: unknown }
      if (event.type === 'system' && event.subtype === 'init' && Array.isArray(event.tools)) {
        return event.tools.map(String).filter((tool) => tool.startsWith('mcp__'))
      }
    } catch {}
  }
  return []
}

/** A throwaway repository with one commit and a linked worktree, the shape a review trial runs in. */
function throwawayWorktree(parent: string): string {
  const repository = join(parent, 'repository')
  mkdirSync(repository)
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repository, ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })
  git('init', '-b', 'main')
  writeFileSync(join(repository, 'README.md'), 'read-only dispatch probe\n')
  git('add', 'README.md')
  git('-c', 'user.name=Probe', '-c', 'user.email=probe@invalid.local', 'commit', '-m', 'probe base')
  const worktree = join(parent, 'worktree')
  git('worktree', 'add', '--detach', worktree)
  return realpathSync(worktree)
}

export async function main(argv: readonly string[]): Promise<number> {
  const modelIndex = argv.indexOf('--model')
  const model = modelIndex === -1 ? undefined : argv[modelIndex + 1]
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'read-only-dispatch-probe-')))
  const cacheFile = join(resolveBunInstallCacheDir(), PROBE_FILE_NAME)
  try {
    const worktree = throwawayWorktree(parent)
    const commands = PROBE_COMMANDS(worktree)
    const prompt = [
      'This is a sandbox probe. Run each of these three commands with the Bash tool, one call per command, exactly as written, and continue after a failure:',
      ...commands.map((command, i) => `${i + 1}. ${command}`),
      'Then end your turn.'
    ].join('\n\n')
    const promptFile = join(parent, 'prompt.md')
    writeFileSync(promptFile, prompt)
    const transcript: string[] = []
    const handle = await dispatchRole('code-reviewer', 'claude', prompt, {
      promptFile,
      cwd: worktree,
      unattended: true,
      readOnly: true,
      ...(model === undefined ? {} : { model }),
      observeStdoutLine: (line) => transcript.push(line)
    })
    process.stdout.write(`dispatch exit code: ${handle.exitCode}, failure: ${handle.failureReason ?? 'none'}\n`)
    for (const result of commandResults(transcript, commands)) {
      process.stdout.write(`exit ${result.exitStatus}: ${result.command}\n`)
    }
    const mcpTools = initMcpTools(transcript)
    process.stdout.write(`init mcp__ tools: ${mcpTools.length === 0 ? '(none)' : mcpTools.join(', ')}\n`)
    process.stdout.write(`worktree file left behind: ${existsSync(join(worktree, PROBE_FILE_NAME))}\n`)
    process.stdout.write(`bun cache file left behind: ${existsSync(cacheFile)}\n`)
    return 0
  } finally {
    rmSync(cacheFile, { force: true })
    rmSync(parent, { recursive: true, force: true })
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
