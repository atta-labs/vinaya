/**
 * `vinaya task switch <tranche> <n> --agent <claude|codex> [--model <model>]` and
 * `vinaya task switch --issue <n> --agent <claude|codex> [--model <model>]` — argv parsing around `switchTask`
 * (`lib/task-switch.js`). The address and the `--agent`/`--model` flags are `task run`'s own; any other shape is a
 * usage error (exit `2`). Exit `0` when the task was switched or the standalone runner needs no switch, `3` when a
 * live driver refuses it.
 */

import { execFileSync } from 'node:child_process'
import { DISPATCH_AGENTS, type DispatchAgent } from '../lib/dispatch-task.js'
import { assembleAndRenderBrief } from '../lib/brief-assembly.js'
import { developerBranchFor, findOpenPrForBranch } from '../lib/dev-review-loop/developer-dispatch.js'
import { runtimeDir } from '../lib/dev-review-loop/reviewer-dispatch.js'
import { liveSwitchDeps, realHasPublishedWork, switchTask } from '../lib/task-switch.js'

const AGENTS = DISPATCH_AGENTS.join(' | ')

const USAGE = [
  `Usage: vinaya task switch <tranche> <n> --agent ${AGENTS} [--model <model>]`,
  `   or: vinaya task switch --issue <n> --agent ${AGENTS} [--model <model>]`
].join('\n')

type SwitchFlags = { agent?: string; model?: string; issue?: string; unknown: string[] }

export function parseSwitchFlags(rest: string[]): SwitchFlags {
  const flags: SwitchFlags = { unknown: [] }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--agent') {
      const value = rest[++i]
      if (value !== undefined) flags.agent = value
    } else if (a === '--model') {
      const value = rest[++i]
      if (value !== undefined) flags.model = value
    } else if (a === '--issue') {
      const value = rest[++i]
      if (value !== undefined) flags.issue = value
    } else if (a !== undefined) flags.unknown.push(a)
  }
  return flags
}

/** Commits the branch holds beyond the default branch, counted against the remote when the branch is there; 0 when git cannot say. */
function commitsBeyondMain(branch: string): number {
  for (const ref of [`origin/${branch}`, branch]) {
    try {
      const count = execFileSync('git', ['rev-list', '--count', `origin/main..${ref}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
      return Number.parseInt(count.trim(), 10) || 0
    } catch {
      // The ref is not there: try the next one.
    }
  }
  return 0
}

function fail(message: string): never {
  console.error(`vinaya task switch: ${message}\n${USAGE}`)
  process.exit(2)
}

export async function taskSwitchCommand(args: string[]): Promise<void> {
  const usesIssueFlag = args.includes('--issue')
  const firstLooksPositional = args[0] !== undefined && !args[0].startsWith('--')
  if (usesIssueFlag && firstLooksPositional) fail('pass either <tranche> <n> or --issue <n>, never both.')

  let rest = args
  let positional: { tranche: string; n: number } | null = null
  if (!usesIssueFlag) {
    const [tranche, taskId] = args
    if (!tranche || !taskId || tranche.startsWith('--')) fail('missing task address.')
    const n = Number.parseInt(taskId, 10)
    if (!Number.isInteger(n) || String(n) !== taskId) fail(`task id must be numeric — got "${taskId}".`)
    positional = { tranche, n }
    rest = args.slice(2)
  }
  const flags = parseSwitchFlags(rest)
  if (flags.unknown.length > 0) {
    fail(
      `unrecognized flag${flags.unknown.length > 1 ? 's' : ''} ${flags.unknown.map((f) => `'${f}'`).join(', ')} — expected one of --agent, --issue, --model.`
    )
  }
  if (!flags.agent || !(DISPATCH_AGENTS as readonly string[]).includes(flags.agent)) {
    fail(`--agent <${DISPATCH_AGENTS.join('|')}> is required.`)
  }
  if (flags.model !== undefined && (flags.model === '' || flags.model.startsWith('--')))
    fail('--model takes a model id.')

  let task: number
  if (positional === null) {
    task = Number.parseInt(flags.issue ?? '', 10)
    if (!Number.isInteger(task) || String(task) !== flags.issue) fail(`--issue must be numeric — got "${flags.issue}".`)
  } else {
    const rendered = await assembleAndRenderBrief(positional.tranche, String(positional.n))
    if (!rendered.ok) {
      console.error(
        `Error: vinaya task switch: could not resolve task ${positional.n} in tranche \`${positional.tranche}\`:\n${rendered.missing.map((m) => `  - ${m}`).join('\n')}`
      )
      process.exit(3)
    }
    task = rendered.issue
  }

  const deps = liveSwitchDeps(runtimeDir(), (issue) =>
    realHasPublishedWork(issue, { developerBranchFor, findOpenPrForBranch, commitsBeyondMain })
  )
  const result = await switchTask(
    { task, agent: flags.agent as DispatchAgent, ...(flags.model ? { model: flags.model } : {}) },
    deps
  )
  if (result.kind === 'refused') {
    console.error(result.message)
    process.exit(3)
  }
  console.log(result.message)
}
