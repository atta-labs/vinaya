/**
 * `vinaya task dispatch <tranche> <n> [--agent claude | codex | gemini]`
 * — argv parsing only, around `dispatchTask` (`lib/dispatch-task.ts`), the
 * one lib function this command calls.
 */

import { DISPATCH_AGENTS, type DispatchAgent, dispatchTask } from '../lib/dispatch-task.js'

export async function taskDispatchCommand(args: string[]): Promise<void> {
  const trancheSlug = args[0]
  const taskIdArg = args[1]
  if (!trancheSlug || !taskIdArg || trancheSlug.startsWith('--')) {
    console.error(`Usage: vinaya task dispatch <tranche> <n> [--agent ${DISPATCH_AGENTS.join(' | ')}]`)
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

  const result = await dispatchTask({ tranche: trancheSlug, n, agent })
  process.stdout.write(`${result.brief}\n`)
  if (result.commentUrl) process.stdout.write(`\nPosted: ${result.commentUrl}\n`)
}
