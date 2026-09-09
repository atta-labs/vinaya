/**
 * `vinaya dispatch <role> --agent claude|codex|gemini --prompt-file <path>`
 * (Issue #406). Thin argv-parsing shim over
 * `dispatchRole` (`../lib/dispatch.js`) — the real spawn/timeout/attribution
 * logic lives there. Calls `logFlushCommand` (`./log.js`) directly when
 * `--task`/`--pr` is given, per the Principal's ruling that this command's
 * three-vendor/spawn/signal shape is exempt from the one-lib-call rule
 * (`apps/cli/specs/surface.md`) — no shared `flushLog` extraction here,
 * that is `sharedCommandShell`'s own future task.
 *
 * `logFlushCommand` calls `process.exit()` directly for its own "nothing to
 * flush" (0) and refusal (2) paths — it never throws them. This command's
 * own result is therefore printed BEFORE the flush call, not after: anything
 * printed after `logFlushCommand` may never run. A flush failure does not
 * undo the dispatch's own effect (the child already ran, and its log lines
 * are already durably written to the local outbox for a later `vinaya log
 * flush` retry) — but when flush is the last step and it exits early, the
 * overall process's exit code reflects the flush step, not this command's
 * own `handle.failureReason`. Disclosed in this task's PR body as a known
 * edge case, not fixed here — `log.ts` is consumed unchanged.
 */

import { readFileSync } from 'node:fs'
import { ROLE_VALUES, type Role } from '@attalabs/aeg-core'
import { AGENT_VENDOR_NAMES, dispatchRole, isAgentVendor, type AgentVendor } from '../lib/dispatch.js'
import { loadConfig } from '../lib/config.js'
import { printJson } from '../lib/envelope.js'
import { logFlushCommand } from './log.js'

type ParsedArgs = {
  role: string | undefined
  agent: string | undefined
  model: string | undefined
  promptFile: string | undefined
  task: number | undefined
  pr: number | undefined
  round: number | undefined
  resume: string | undefined
  json: boolean
}

function parseArgs(args: string[]): ParsedArgs {
  const role = args[0]
  let agent: string | undefined
  let model: string | undefined
  let promptFile: string | undefined
  let task: number | undefined
  let pr: number | undefined
  let round: number | undefined
  let resume: string | undefined
  let json = false
  for (let i = 1; i < args.length; i++) {
    const a = args[i]
    if (a === '--agent') agent = args[++i]
    else if (a === '--model') model = args[++i]
    else if (a === '--prompt-file') promptFile = args[++i]
    else if (a === '--task') task = Number(args[++i])
    else if (a === '--pr') pr = Number(args[++i])
    else if (a === '--round') round = Number(args[++i])
    else if (a === '--resume') resume = args[++i]
    else if (a === '--json') json = true
  }
  return { role, agent, model, promptFile, task, pr, round, resume, json }
}

export async function dispatchCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args)

  if (!parsed.role || !(ROLE_VALUES as readonly string[]).includes(parsed.role)) {
    process.stderr.write(
      `vinaya dispatch: invalid role '${parsed.role ?? '(none)'}' — expected one of ${ROLE_VALUES.join(', ')}\n`
    )
    process.exit(1)
  }
  const role = parsed.role as Role

  const agentRaw = parsed.agent ?? loadConfig()?.dispatch?.agent
  if (!agentRaw) {
    process.stderr.write(
      'vinaya dispatch: --agent <claude|codex|gemini> is required (or set dispatch.agent in vinaya.config.json)\n'
    )
    process.exit(1)
  }
  if (!isAgentVendor(agentRaw)) {
    process.stderr.write(
      `vinaya dispatch: invalid vendor '${agentRaw}' — expected one of ${AGENT_VENDOR_NAMES.join(', ')}\n`
    )
    process.exit(1)
  }
  const agent: AgentVendor = agentRaw

  if (!parsed.promptFile) {
    process.stderr.write('vinaya dispatch: --prompt-file <path> is required\n')
    process.exit(1)
  }
  const promptFile = parsed.promptFile

  if (parsed.task !== undefined && parsed.pr !== undefined) {
    process.stderr.write(
      'vinaya dispatch: --task and --pr are mutually exclusive (ambiguous flush target) — pass exactly one\n'
    )
    process.exit(1)
  }

  let prompt: string
  try {
    prompt = readFileSync(promptFile, 'utf8')
  } catch (err) {
    process.stderr.write(
      `vinaya dispatch: could not read --prompt-file '${promptFile}': ${err instanceof Error ? err.message : String(err)}\n`
    )
    process.exit(1)
    return
  }

  const handle = await dispatchRole(role, agent, prompt, {
    task: parsed.task,
    pr: parsed.pr,
    round: parsed.round,
    resumeId: parsed.resume,
    model: parsed.model,
    promptFile
  })

  // Printed before the flush call — see module doc.
  if (parsed.json) {
    printJson({
      exitCode: handle.exitCode,
      durationMs: handle.durationMs,
      usage: handle.usage,
      resumeId: handle.resumeId,
      timedOut: handle.timedOut,
      failureReason: handle.failureReason ?? null
    })
  } else if (handle.failureReason) {
    process.stderr.write(`vinaya dispatch: ${role} via ${agent} failed (${handle.failureReason})\n`)
  } else {
    process.stdout.write(
      `vinaya dispatch: ${role} via ${agent} completed in ${handle.durationMs}ms (resumeId: ${handle.resumeId ?? 'none'})\n`
    )
  }

  if (parsed.task !== undefined) {
    await logFlushCommand(['--issue', String(parsed.task)])
  } else if (parsed.pr !== undefined) {
    await logFlushCommand(['--pr', String(parsed.pr)])
  }

  if (handle.failureReason) process.exit(1)
}
