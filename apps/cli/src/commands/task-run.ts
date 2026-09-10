/**
 * `vinaya task run <tranche> <n> --agent <claude|codex|gemini>` — argv
 * parsing around `runTask` (`lib/task-run.js`), plus `colourLoopLine`
 * (`lib/dispatch.js`) to role-colour its two summary lines the same way
 * `dev-review-loop`'s own equivalent lines already are (task-run-v1 task 2
 * round 2 review, MINOR) — two lib calls, exempt (see
 * `apps/cli/specs/surface.md`'s Exemptions table), the same
 * `sharedCommandShell` retirement target `dev-review-loop`'s own command
 * already carries. One command, from a planned Issue to a reviewed pull
 * request, exactly one developer started.
 *
 * A paused run is resumed through the loop's OWN existing path —
 * `vinaya dev-review-loop --resume <pr>` — never a `--resume` flag on this
 * command (`runTask` composes `devReviewLoop` fresh every call, it does not
 * carry resume state of its own).
 */

import { colourLoopLine } from '../lib/dispatch.js'
import { DISPATCH_AGENTS, type DispatchAgent } from '../lib/dispatch-task.js'
import { runTask } from '../lib/task-run.js'

export async function taskRunCommand(args: string[]): Promise<void> {
  const trancheSlug = args[0]
  const taskIdArg = args[1]
  if (!trancheSlug || !taskIdArg || trancheSlug.startsWith('--')) {
    console.error(`Usage: vinaya task run <tranche> <n> --agent ${DISPATCH_AGENTS.join(' | ')}`)
    process.exit(2)
  }

  const n = Number.parseInt(taskIdArg, 10)
  if (!Number.isInteger(n) || String(n) !== taskIdArg) {
    console.error(`vinaya task run: task id must be numeric — got "${taskIdArg}".`)
    process.exit(2)
  }

  const rest = args.slice(2)
  const agentIdx = rest.indexOf('--agent')
  const agentValue = agentIdx === -1 ? undefined : rest[agentIdx + 1]
  if (!agentValue || !(DISPATCH_AGENTS as readonly string[]).includes(agentValue)) {
    console.error(`vinaya task run: --agent <${DISPATCH_AGENTS.join('|')}> is required.`)
    process.exit(2)
  }
  const agent = agentValue as DispatchAgent

  const result = await runTask({ tranche: trancheSlug, n, agent })

  // `prUrl` is `null` only when the repo genuinely could not be resolved
  // (`lib/task-run.ts`'s own `resolvePrUrl` doc comment) — falls back to the
  // bare `PR #<n>` form rather than printing a broken/missing URL.
  const prRef = result.prUrl ?? `PR #${result.prNumber}`

  const decision = result.finalDecision
  if (decision.type === 'publish') {
    process.stdout.write(
      `${colourLoopLine(`vinaya task run: task ${result.task}, ${prRef} — published`, process.stdout)}\n`
    )
    return
  }
  if (decision.type !== 'pause') {
    // `devReviewLoop` only ever RETURNS on `publish` or `pause` (its own doc
    // comment) — every other `Decision` member is an intermediate step the
    // loop acts on internally and never hands back. Reaching this branch
    // would mean that contract broke, which is a failure, not a pause.
    throw new Error(`vinaya task run: devReviewLoop returned an unexpected final decision type \`${decision.type}\`.`)
  }

  // O2: a paused loop's exit and summary are distinct from a published run —
  // the exact resume command is printed here, never left to the reader to
  // reconstruct (the loop's own pause comment on the PR carries the same
  // command, but this is the command's OWN summary, per the brief).
  process.stdout.write(
    `${colourLoopLine(`vinaya task run: task ${result.task}, ${prRef} — paused (${decision.reason})`, process.stdout)}\n`
  )
  process.stdout.write(`Resume with: vinaya dev-review-loop --resume ${result.prNumber}\n`)
  process.exit(1)
}
