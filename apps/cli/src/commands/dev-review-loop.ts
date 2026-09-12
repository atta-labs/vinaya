/**
 * `vinaya dev-review-loop --task <n> --agent claude|codex|gemini`, or
 * `vinaya dev-review-loop --resume <pr> --agent …` (`#415`, `#416` O2). A
 * thin argv-parsing shim over `devReviewLoop` (`../lib/dev-review-loop.js`)
 * — the real driver logic, including `--resume`'s held-state/ruling/head
 * checks, lives there; both flags build the SAME `LoopInput` union and make
 * the SAME one lib call, so this stays a one-lib-call command regardless of
 * which flag was given. Four lib calls (`loadConfig`, `isAgentVendor`,
 * `devReviewLoop`, `printJson`), the same argv-plumbing shape `dispatch`'s
 * own command takes (`apps/cli/specs/surface.md`) — exempt under the same
 * `sharedCommandShell` retirement target, not a fifth compliant
 * one-lib-call command.
 */

import { colourLoopLine, isAgentVendor, type AgentVendor } from '../lib/dispatch.js'
import { loadConfig } from '../lib/config.js'
import { printJson } from '../lib/envelope.js'
import { devReviewLoop, type LoopInput } from '../lib/dev-review-loop.js'

type ParsedArgs = { task: number | undefined; resumePr: number | undefined; agent: string | undefined; json: boolean }

function parseArgs(args: string[]): ParsedArgs {
  let task: number | undefined
  let resumePr: number | undefined
  let agent: string | undefined
  let json = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    // `--issue` is `--task`'s exact synonym (O1): the
    // loop's `task` field is already the Issue number, tranche or not, so a
    // backlog Issue needs no new input shape here — only the naming that
    // matches `task run --issue <n>` / `task brief --issue <n>`.
    if (a === '--task' || a === '--issue') task = Number(args[++i])
    else if (a === '--resume') resumePr = Number(args[++i])
    else if (a === '--agent') agent = args[++i]
    else if (a === '--json') json = true
  }
  return { task, resumePr, agent, json }
}

export async function devReviewLoopCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args)

  const agentRaw = parsed.agent ?? loadConfig()?.dispatch?.agent
  if (!agentRaw) {
    process.stderr.write(
      'vinaya dev-review-loop: --agent <claude|codex|gemini> is required (or set dispatch.agent in vinaya.config.json)\n'
    )
    process.exit(1)
  }
  if (!isAgentVendor(agentRaw)) {
    process.stderr.write(`vinaya dev-review-loop: invalid vendor '${agentRaw}' — expected claude, codex, or gemini\n`)
    process.exit(1)
  }
  const agent: AgentVendor = agentRaw

  let input: LoopInput
  if (parsed.resumePr !== undefined) {
    if (!Number.isInteger(parsed.resumePr) || parsed.resumePr <= 0) {
      process.stderr.write('vinaya dev-review-loop: --resume <pr> requires a positive integer PR number\n')
      process.exit(1)
    }
    input = { resumePr: parsed.resumePr, agent }
  } else {
    if (parsed.task === undefined || !Number.isInteger(parsed.task) || parsed.task <= 0) {
      process.stderr.write(
        'vinaya dev-review-loop: --task <n> is required (a positive integer Issue number) — --issue <n> is accepted as its exact synonym\n'
      )
      process.exit(1)
    }
    input = { task: parsed.task, agent }
  }

  const result = await devReviewLoop(input)

  if (parsed.json) {
    printJson({ finalDecision: result.finalDecision, prNumber: result.prNumber, task: result.task })
  } else if (result.finalDecision.type === 'publish') {
    process.stdout.write(
      `${colourLoopLine(`vinaya dev-review-loop: task ${result.task}, PR #${result.prNumber} — publish`, process.stdout)}\n`
    )
  } else if (result.finalDecision.type === 'pause') {
    process.stdout.write(
      `${colourLoopLine(
        `vinaya dev-review-loop: task ${result.task}, PR #${result.prNumber} — paused (${result.finalDecision.reason})`,
        process.stdout
      )}\n`
    )
  }

  // O2: a paused loop exits non-zero — the pause comment/state are already
  // durable (`devReviewLoop` wrote both before returning); this is the
  // process-level signal an unattended dispatcher watches for.
  if (result.finalDecision.type === 'pause') process.exit(1)
}
