/**
 * `vinaya task dispatch <tranche> <n> [--agent claude | codex | gemini]`
 * — argv parsing only, around `dispatchTask` (`lib/dispatch-task.ts`), the
 * one lib function this command calls. `@deprecated` in favor of
 * `vinaya task brief` (preparation only, below) and `vinaya task run` (the
 * future unattended loop) — kept for a documented compatibility window.
 *
 * `vinaya task brief <tranche> <n> [--supersede --reason <text>]`
 * — argv parsing only, around `prepareTask` (`lib/dispatch-task.ts`), the
 * one lib function it calls. Preparation only: it renders and freezes the
 * brief and starts no worker. `--supersede` (task 4, Issue
 * #483, O3) posts a new, higher-versioned frozen brief naming its
 * predecessor and `--reason`'s text, instead of refusing on the one that's
 * already there — always paired with `--reason`, never accepted alone.
 */

import { DISPATCH_AGENTS, type DispatchAgent, dispatchTask, prepareTaskOrIssue } from '../lib/dispatch-task.js'

export async function taskDispatchCommand(args: string[]): Promise<void> {
  const trancheSlug = args[0]
  const taskIdArg = args[1]
  if (!trancheSlug || !taskIdArg || trancheSlug.startsWith('--')) {
    console.error(
      `Usage: vinaya task dispatch <tranche> <n> [--agent ${DISPATCH_AGENTS.join(' | ')}] [--model <name>]\n` +
        'Deprecated: prefer `vinaya task brief` (preparation only) or `vinaya task run` (the full unattended loop).'
    )
    process.exit(2)
  }

  const n = Number.parseInt(taskIdArg, 10)
  if (!Number.isInteger(n) || String(n) !== taskIdArg) {
    console.error(`vinaya task dispatch: task id must be numeric — got "${taskIdArg}".`)
    process.exit(2)
  }

  const rest = args.slice(2)
  const agentIdx = rest.indexOf('--agent')
  let agent: DispatchAgent | undefined
  if (agentIdx !== -1) {
    const value = rest[agentIdx + 1]
    // Membership check inlined (never `isDispatchAgent(value)`): a second
    // direct call into `lib/dispatch-task.ts` would put this command over
    // the one-lib-function cap (`apps/cli/specs/surface.md` "The rule") —
    // `dispatchTask` is the one call this entry function makes.
    if (!value || !(DISPATCH_AGENTS as readonly string[]).includes(value)) {
      console.error(`--agent must be one of: ${DISPATCH_AGENTS.join(', ')}`)
      process.exit(2)
    }
    agent = value as DispatchAgent
  }

  const modelIdx = rest.indexOf('--model')
  let model: string | undefined
  if (modelIdx !== -1) {
    const value = rest[modelIdx + 1]
    if (!value) {
      console.error('--model requires a value')
      process.exit(2)
    }
    model = value
  }

  const result = await dispatchTask({ tranche: trancheSlug, n, agent, model })
  process.stdout.write(`${result.brief}\n`)
  if (result.commentUrl) process.stdout.write(`\nPosted: ${result.commentUrl}\n`)
}

/** Parses `--supersede`/`--reason` — shared by the `<tranche> <n>` and `--issue <n>` (task-run-v1 task 15, O1) forms of `task brief`. */
function parseSupersede(rest: string[], usage: string): { reason: string } | undefined {
  const hasSupersede = rest.includes('--supersede')
  const reasonIdx = rest.indexOf('--reason')
  const reason = reasonIdx !== -1 ? rest[reasonIdx + 1] : undefined

  if (hasSupersede && !reason) {
    console.error(`vinaya task brief: --supersede requires --reason <text>.\n${usage}`)
    process.exit(2)
  }
  if (!hasSupersede && reasonIdx !== -1) {
    console.error(`vinaya task brief: --reason is only meaningful with --supersede.\n${usage}`)
    process.exit(2)
  }
  return hasSupersede ? { reason: reason as string } : undefined
}

const TASK_BRIEF_USAGE = [
  'Usage: vinaya task brief <tranche> <n> [--supersede --reason <text>]',
  '   or: vinaya task brief --issue <n> [--supersede --reason <text>]'
].join('\n')

/**
 * `--issue <n>` (task-run-v1 task 15, O1) — renders and freezes a backlog
 * Issue's brief exactly as `<tranche> <n>` does for a tranche task. Mutually
 * exclusive with the `<tranche> <n>` positional form.
 */
export async function taskBriefCommand(args: string[]): Promise<void> {
  const issueIdx = args.indexOf('--issue')
  const firstLooksPositional = args[0] !== undefined && !args[0].startsWith('--')

  if (issueIdx !== -1 && firstLooksPositional) {
    console.error(`vinaya task brief: pass either <tranche> <n> or --issue <n>, never both.\n${TASK_BRIEF_USAGE}`)
    process.exit(2)
  }

  if (issueIdx !== -1) {
    const issueArg = args[issueIdx + 1]
    const issueN = issueArg !== undefined ? Number.parseInt(issueArg, 10) : Number.NaN
    if (!issueArg || !Number.isInteger(issueN) || String(issueN) !== issueArg) {
      console.error(`vinaya task brief: --issue must be numeric — got "${issueArg}".\n${TASK_BRIEF_USAGE}`)
      process.exit(2)
    }
    const rest = [...args.slice(0, issueIdx), ...args.slice(issueIdx + 2)]
    const supersede = parseSupersede(rest, TASK_BRIEF_USAGE)
    const result = await prepareTaskOrIssue({ issue: issueN, supersede })
    process.stdout.write(`${result.brief}\n`)
    process.stdout.write(`\nPosted (v${result.version}): ${result.commentUrl}\n`)
    return
  }

  const trancheSlug = args[0]
  const taskIdArg = args[1]
  if (!trancheSlug || !taskIdArg || trancheSlug.startsWith('--')) {
    console.error(TASK_BRIEF_USAGE)
    process.exit(2)
  }

  const n = Number.parseInt(taskIdArg, 10)
  if (!Number.isInteger(n) || String(n) !== taskIdArg) {
    console.error(`vinaya task brief: task id must be numeric — got "${taskIdArg}".`)
    process.exit(2)
  }

  const supersede = parseSupersede(args.slice(2), TASK_BRIEF_USAGE)
  const result = await prepareTaskOrIssue({ tranche: trancheSlug, n, supersede })
  process.stdout.write(`${result.brief}\n`)
  process.stdout.write(`\nPosted (v${result.version}): ${result.commentUrl}\n`)
}
