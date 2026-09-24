/**
 * `vinaya task run <tranche> <n> --agent <claude|codex|gemini> [--model <model>]` — argv
 * parsing around `runTask` (`lib/task-run.js`), plus `colourLoopLine`
 * (`lib/dispatch.js`) to role-colour its two summary lines the same way
 * `dev-review-loop`'s own equivalent lines already are — two lib calls,
 * exempt (see `apps/cli/specs/surface.md`'s Exemptions table), the same
 * `sharedCommandShell` retirement target `dev-review-loop`'s own command
 * already carries. One command, from a planned Issue to a reviewed pull
 * request, exactly one developer started.
 *
 * issue-711 O4: `runTask` composes the watching driver (`runDriverLoop`,
 * `lib/dev-review-loop.js`) — a pause never ends this process any more, it
 * keeps running and watches the pull request, continuing on its own once a
 * newer Principal ruling lands (or, for `'infrastructure'`/`'stale_driver'`,
 * after a bounded backoff). `1` (below) is reached only for the one pause
 * this run can never watch: the pre-first-push escalation, which has no
 * pull request yet — still resumed by hand with `vinaya task run <tranche>
 * <n>` (no `--resume` flag on this command; `runTask` composes the loop
 * fresh every call, it carries no resume state of its own). An
 * `--resume`/`--cancel` an operator issues directly against `dev-review-loop`
 * stays a one-shot debug/direct entry, unaffected by this.
 *
 * Exit codes (round 2 security review, HIGH): `0` publish OR a watched
 * pause's own genuine end (`'ended'` — merged, closed, or `--cancel`), `1`
 * the one un-watchable pause above, `2` a usage/argv error, `3` any other
 * failure (a refused preparation, an open-PR refusal, an internal contract
 * violation) — never sharing `1` with a genuine end, so an unattended host
 * tells "resume with the printed command" apart from "this run genuinely
 * failed" from the exit code alone. Cancellation (`SIGINT`) is Node's own
 * ambient default disposition (exit `130`) — no handler was added for it,
 * matching the boundary's exclusion of process-supervision/unattended-mode
 * work; a driver watching a pause instead ends on `--cancel`, an intentional
 * operator action rather than a signal.
 */

import { colourLoopLine } from '../lib/dispatch.js'
import { DISPATCH_AGENTS, type DispatchAgent } from '../lib/dispatch-task.js'
import { loadConfig } from '../lib/config.js'
import { runTask, type RunTaskResult } from '../lib/task-run.js'
import { startBackgroundRun } from '../lib/task-run-background.js'

/** Any failure other than a usage/argv error or a policy `pause` — see the module doc comment's exit-code table. */
const TASK_RUN_FAILURE_EXIT_CODE = 3

const KNOWN_FLAGS = ['--agent', '--issue', '--background', '--model']

type ParsedFlags = {
  agent: string | undefined
  agentFlagPresent: boolean
  issue: string | undefined
  background: boolean
  model: string | undefined
  unknown: string[]
}

/**
 * `unknown` collects any `--flag`-shaped or stray token this parser does
 * not recognize — round 2 security review, MEDIUM: this command was not
 * given the same treatment `dispatch.ts`'s own `parseArgs` was, found live
 * on that sibling command, where an unrecognized flag was silently dropped
 * while every other flag still took effect. Refusing here closes the same
 * gap rather than reintroducing it on a second command.
 *
 * `agentFlagPresent` distinguishes `--agent` never given at all (falls back
 * to `dispatch.agent` in config) from `--agent` given with no value (a
 * malformed flag, always refused — never silently rescued by the config
 * fallback): both otherwise parse `agent` as `undefined`, and collapsing
 * them would let a typo'd `--agent` at the end of argv quietly succeed off
 * the config default instead of failing loud.
 */
function parseFlags(rest: string[]): ParsedFlags {
  let agent: string | undefined
  let agentFlagPresent = false
  let issue: string | undefined
  let background = false
  let model: string | undefined
  const unknown: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--agent') {
      agentFlagPresent = true
      agent = rest[++i]
    } else if (a === '--issue') {
      issue = rest[++i]
    } else if (a === '--background') {
      background = true
    } else if (a === '--model') {
      model = rest[++i]
    } else if (a !== undefined) unknown.push(a)
  }
  return { agent, agentFlagPresent, issue, background, model, unknown }
}

const USAGE = [
  `Usage: vinaya task run <tranche> <n> --agent ${DISPATCH_AGENTS.join(' | ')} [--background] [--model <model>]`,
  `   or: vinaya task run --issue <n> --agent ${DISPATCH_AGENTS.join(' | ')} [--background] [--model <model>]`
].join('\n')

/** `--agent` falls back to `dispatch.agent` in `vinaya.config.json` when omitted entirely — see `parseFlags`'s own doc comment on `agentFlagPresent`. `null` when no valid agent could be resolved (message already printed). */
function resolveAgentOrReport(parsed: ParsedFlags): DispatchAgent | null {
  const agentRaw = parsed.agentFlagPresent ? parsed.agent : (parsed.agent ?? loadConfig()?.dispatch?.agent)
  if (!agentRaw || !(DISPATCH_AGENTS as readonly string[]).includes(agentRaw)) {
    console.error(
      `vinaya task run: --agent <${DISPATCH_AGENTS.join('|')}> is required (or set dispatch.agent in vinaya.config.json).`
    )
    return null
  }
  return agentRaw as DispatchAgent
}

/** The publish/pause summary — shared by the tranche-keyed and `--issue` invocations, which differ only in how `result` was obtained. */
function reportRunTaskResult(result: RunTaskResult, invocation: { agent: DispatchAgent; model?: string }): void {
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
  if (decision.type === 'ended') {
    // issue-711 O4: `runTask` now composes the watching driver
    // (`runDriverLoop`) — a pause it watched through to a genuine end (the
    // pull request merged, closed, or an operator's own `--cancel`) is a
    // normal, successful end to this process, exit `0`, same as `publish`;
    // never printed or exited as a `pause` (there is nothing left to
    // resume).
    process.stdout.write(
      `${colourLoopLine(`vinaya task run: task ${result.task}, ${prRef} — ended (${decision.reason})`, process.stdout)}\n`
    )
    return
  }
  if (decision.type !== 'pause') {
    // `runDriverLoop` only ever RETURNS on `publish`, `pause`, or `ended`
    // (its own doc comment) — every other `Decision` member is an
    // intermediate step the loop acts on internally and never hands back.
    // Reaching this branch would mean that contract broke, which is a
    // failure, never a pause — the same distinct failure exit the `catch`
    // above uses, not `1`.
    process.stderr.write(
      `Error: vinaya task run: devReviewLoop returned an unexpected final decision type \`${decision.type}\`.\n`
    )
    process.exit(TASK_RUN_FAILURE_EXIT_CODE)
  }

  // O2: a paused loop's exit and summary are distinct from a published run —
  // the exact resume command is printed here, never left to the reader to
  // reconstruct (the loop's own pause comment on the PR carries the same
  // command, but this is the command's OWN summary, per the brief).
  process.stdout.write(
    `${colourLoopLine(`vinaya task run: task ${result.task}, ${prRef} — paused (${decision.reason})`, process.stdout)}\n`
  )
  process.stdout.write(
    `Resume with: vinaya dev-review-loop --resume ${result.prNumber} --agent ${invocation.agent}${invocation.model ? ` --model ${invocation.model}` : ''}\n`
  )
  process.exit(1)
}

async function runAndReport(input: Parameters<typeof runTask>[0]): Promise<void> {
  let result: RunTaskResult
  try {
    result = await runTask(input)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${message}\n`)
    process.exit(TASK_RUN_FAILURE_EXIT_CODE)
  }
  reportRunTaskResult(result, { agent: input.agent, ...(input.model ? { model: input.model } : {}) })
}

/**
 * `--background`'s own report: prints the durable run handle and
 * returns at once, never awaiting the loop. `startBackgroundRun` itself
 * already refuses (before spawning anything) on an unsupported host or a
 * controller conflict — both surfaced here as the same
 * `TASK_RUN_FAILURE_EXIT_CODE` an ordinary preparation refusal gets, never
 * exit `1` (reserved for a policy `pause`, which a background start never
 * itself decides).
 */
async function runBackgroundAndReport(input: Parameters<typeof startBackgroundRun>[0]): Promise<void> {
  try {
    const handle = await startBackgroundRun(input)
    process.stdout.write(
      `${colourLoopLine(`vinaya task run: task ${handle.task} — background controller acknowledged (pid ${handle.pid}, run ${handle.runId})`, process.stdout)}\n`
    )
    process.stdout.write(`Follow with: vinaya task status --issue ${handle.task} --follow\n`)
    process.stdout.write(`Log: ${handle.logPath}\n`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${message}\n`)
    process.exit(TASK_RUN_FAILURE_EXIT_CODE)
  }
}

/**
 * `--issue <n>` — a backlog Issue that carries no
 * `vinaya/tranche:*` label runs the same unattended path as a tranche task:
 * one frozen brief, one developer on `task/issue-<n>`, the same loop and
 * gate. Mutually exclusive with the `<tranche> <n>` positional form.
 */
export async function taskRunCommand(args: string[]): Promise<void> {
  const usesIssueFlag = args.includes('--issue')
  const firstLooksPositional = args[0] !== undefined && !args[0].startsWith('--')

  if (usesIssueFlag && firstLooksPositional) {
    console.error(`vinaya task run: pass either <tranche> <n> or --issue <n>, never both.\n${USAGE}`)
    process.exit(2)
  }

  if (usesIssueFlag) {
    const parsed = parseFlags(args)
    if (parsed.unknown.length > 0) {
      console.error(
        `vinaya task run: unrecognized flag${parsed.unknown.length > 1 ? 's' : ''} ${parsed.unknown.map((f) => `'${f}'`).join(', ')} — expected one of ${KNOWN_FLAGS.join(', ')}`
      )
      process.exit(2)
    }
    if (!parsed.issue) {
      console.error(USAGE)
      process.exit(2)
    }
    const issueN = Number.parseInt(parsed.issue, 10)
    if (!Number.isInteger(issueN) || String(issueN) !== parsed.issue) {
      console.error(`vinaya task run: --issue must be numeric — got "${parsed.issue}".`)
      process.exit(2)
    }
    const agent = resolveAgentOrReport(parsed)
    if (!agent) process.exit(2)
    if (parsed.background) {
      await runBackgroundAndReport({ issue: issueN, agent, model: parsed.model })
      return
    }
    await runAndReport({ issue: issueN, agent, model: parsed.model })
    return
  }

  const trancheSlug = args[0]
  const taskIdArg = args[1]
  if (!trancheSlug || !taskIdArg || trancheSlug.startsWith('--')) {
    console.error(USAGE)
    process.exit(2)
  }

  const n = Number.parseInt(taskIdArg, 10)
  if (!Number.isInteger(n) || String(n) !== taskIdArg) {
    console.error(`vinaya task run: task id must be numeric — got "${taskIdArg}".`)
    process.exit(2)
  }

  const parsed = parseFlags(args.slice(2))
  if (parsed.unknown.length > 0) {
    console.error(
      `vinaya task run: unrecognized flag${parsed.unknown.length > 1 ? 's' : ''} ${parsed.unknown.map((f) => `'${f}'`).join(', ')} — expected one of ${KNOWN_FLAGS.join(', ')}`
    )
    process.exit(2)
  }
  const agent = resolveAgentOrReport(parsed)
  if (!agent) process.exit(2)
  if (parsed.background) {
    await runBackgroundAndReport({ tranche: trancheSlug, n, agent, model: parsed.model })
    return
  }
  await runAndReport({ tranche: trancheSlug, n, agent, model: parsed.model })
}

import type { SurfaceExemption } from '../lib/surface-exemption'

export const SURFACE_EXEMPTIONS: Record<string, SurfaceExemption> = {
  'task run': { date: '2026-09-15', callsToday: 4, retiresVia: 'sharedCommandShell' }
}
