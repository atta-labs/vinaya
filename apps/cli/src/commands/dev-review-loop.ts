/**
 * `vinaya dev-review-loop --task <n> --agent claude|codex|gemini`
 * (dev-review-loop-v1 task 5, `#415`). A thin argv-parsing shim over
 * `devReviewLoop` (`../lib/dev-review-loop.js`) — the real driver logic
 * lives there. Four lib calls (`loadConfig`, `isAgentVendor`, `devReviewLoop`,
 * `printJson`), the same argv-plumbing shape `dispatch`'s own command takes
 * (`apps/cli/specs/surface.md`) — exempt under the same `sharedCommandShell`
 * retirement target, not a fifth compliant one-lib-call command.
 */

import { isAgentVendor, type AgentVendor } from '../lib/dispatch.js'
import { loadConfig } from '../lib/config.js'
import { printJson } from '../lib/envelope.js'
import { devReviewLoop } from '../lib/dev-review-loop.js'

type ParsedArgs = { task: number | undefined; agent: string | undefined; json: boolean }

function parseArgs(args: string[]): ParsedArgs {
  let task: number | undefined
  let agent: string | undefined
  let json = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--task') task = Number(args[++i])
    else if (a === '--agent') agent = args[++i]
    else if (a === '--json') json = true
  }
  return { task, agent, json }
}

export async function devReviewLoopCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args)

  if (parsed.task === undefined || !Number.isInteger(parsed.task) || parsed.task <= 0) {
    process.stderr.write('vinaya dev-review-loop: --task <n> is required (a positive integer Issue number)\n')
    process.exit(1)
  }
  const task = parsed.task as number

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

  const result = await devReviewLoop({ task, agent })

  if (parsed.json) {
    printJson({ finalDecision: result.finalDecision, prNumber: result.prNumber })
  } else if (result.finalDecision.type === 'publish') {
    process.stdout.write(`vinaya dev-review-loop: task ${task}, PR #${result.prNumber} — publish\n`)
  } else if (result.finalDecision.type === 'pause') {
    process.stdout.write(
      `vinaya dev-review-loop: task ${task}, PR #${result.prNumber} — paused (${result.finalDecision.reason})\n`
    )
  }
}
