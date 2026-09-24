/**
 * `vinaya dev-review-loop --task <n> --agent claude|codex|gemini`,
 * `vinaya dev-review-loop --resume <pr> --agent …`, or `vinaya
 * dev-review-loop --cancel <pr> --agent …`. A thin
 * argv-parsing shim over `devReviewLoop`/`cancelDevReviewLoop`
 * (`../lib/dev-review-loop.js`) — the real logic, including `--resume`'s and
 * `--cancel`'s held-state/ruling/escalation checks, lives there; `--task`
 * and `--resume` build the SAME `LoopInput` union into the SAME one
 * `devReviewLoop` call, and `--cancel` makes the SAME one
 * `cancelDevReviewLoop` call, so every invocation of this command still
 * makes exactly one lib call regardless of which flag was given. Five lib
 * calls in total (`loadConfig`, `isAgentVendor`, `devReviewLoop`,
 * `cancelDevReviewLoop`, `printJson`), the same argv-plumbing shape
 * `dispatch`'s own command takes (`apps/cli/specs/surface.md`) — exempt
 * under the same `sharedCommandShell` retirement target, not a compliant
 * one-lib-call command.
 *
 * issue-711 O4: this command — every flag, `--task` included — stays the
 * one-shot debug/direct entry it always was (`apps/cli/specs/loop.md`,
 * "The command": "`dev-review-loop` below is `task run`'s own debug/direct
 * entry"), never the watching driver (`runDriverLoop`). `vinaya task run`
 * (`commands/task-run.ts`) is the one "normal," unattended entry O4's
 * watching behaviour lands on.
 */

import { colourLoopLine, isAgentVendor, type AgentVendor } from '../lib/dispatch.js'
import { loadConfig } from '../lib/config.js'
import { printJson } from '../lib/envelope.js'
import { cancelDevReviewLoop, devReviewLoop, type LoopInput } from '../lib/dev-review-loop.js'

type ParsedArgs = {
  task: number | undefined
  resumePr: number | undefined
  cancelPr: number | undefined
  agent: string | undefined
  model: string | undefined
  json: boolean
}

function parseArgs(args: string[]): ParsedArgs {
  let task: number | undefined
  let resumePr: number | undefined
  let cancelPr: number | undefined
  let agent: string | undefined
  let model: string | undefined
  let json = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    // `--issue` is `--task`'s exact synonym: the
    // loop's `task` field is already the Issue number, tranche or not, so a
    // backlog Issue needs no new input shape here — only the naming that
    // matches `task run --issue <n>` / `task brief --issue <n>`.
    if (a === '--task' || a === '--issue') task = Number(args[++i])
    else if (a === '--resume') resumePr = Number(args[++i])
    // The mirror of `--resume <pr>` — cancels the SAME held
    // pause a `--resume` would otherwise continue, rather than dispatching
    // anything.
    else if (a === '--cancel') cancelPr = Number(args[++i])
    else if (a === '--agent') agent = args[++i]
    else if (a === '--model') model = args[++i]
    else if (a === '--json') json = true
  }
  return { task, resumePr, cancelPr, agent, model, json }
}

export async function devReviewLoopCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args)

  // A bare resume recovers the vendor/model from its durable pause state.
  // Fresh starts and cancellation still use the explicit/configured vendor.
  const agentRaw = parsed.agent ?? (parsed.resumePr === undefined ? loadConfig()?.dispatch?.agent : undefined)
  if (!agentRaw && parsed.resumePr === undefined) {
    process.stderr.write(
      'vinaya dev-review-loop: --agent <claude|codex|gemini> is required (or set dispatch.agent in vinaya.config.json)\n'
    )
    process.exit(1)
  }
  if (agentRaw !== undefined && !isAgentVendor(agentRaw)) {
    process.stderr.write(`vinaya dev-review-loop: invalid vendor '${agentRaw}' — expected claude, codex, or gemini\n`)
    process.exit(1)
  }
  const agent: AgentVendor | undefined = agentRaw

  // O3: `--cancel <pr>` is its own path, never a `LoopInput` variant — a
  // cancelled run never re-enters the round loop, it only authenticates,
  // consumes, terminates, and fences (`cancelDevReviewLoop`'s own doc
  // comment).
  if (parsed.cancelPr !== undefined) {
    if (agent === undefined) throw new Error('dev-review-loop cancellation requires an agent')
    if (!Number.isInteger(parsed.cancelPr) || parsed.cancelPr <= 0) {
      process.stderr.write('vinaya dev-review-loop: --cancel <pr> requires a positive integer PR number\n')
      process.exit(1)
    }
    const result = await cancelDevReviewLoop({ cancelPr: parsed.cancelPr, agent })
    if (parsed.json) {
      printJson(result)
    } else {
      process.stdout.write(
        `${colourLoopLine(`vinaya dev-review-loop: task ${result.task}, PR #${parsed.cancelPr} — cancelled`, process.stdout)}\n`
      )
    }
    return
  }

  let input: LoopInput
  if (parsed.resumePr !== undefined) {
    if (!Number.isInteger(parsed.resumePr) || parsed.resumePr <= 0) {
      process.stderr.write('vinaya dev-review-loop: --resume <pr> requires a positive integer PR number\n')
      process.exit(1)
    }
    input = {
      resumePr: parsed.resumePr,
      ...(agent ? { agent } : {}),
      ...(parsed.model ? { model: parsed.model } : {}),
      json: parsed.json
    }
  } else {
    if (parsed.task === undefined || !Number.isInteger(parsed.task) || parsed.task <= 0) {
      process.stderr.write(
        'vinaya dev-review-loop: --task <n> is required (a positive integer Issue number) — --issue <n> is accepted as its exact synonym\n'
      )
      process.exit(1)
    }
    if (agent === undefined) throw new Error('dev-review-loop start requires an agent')
    input = { task: parsed.task, agent, ...(parsed.model ? { model: parsed.model } : {}), json: parsed.json }
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

import type { SurfaceExemption } from '../lib/surface-exemption'

export const SURFACE_EXEMPTIONS: Record<string, SurfaceExemption> = {
  'dev-review-loop': { date: '2026-09-15', callsToday: 6, retiresVia: 'sharedCommandShell' }
}
